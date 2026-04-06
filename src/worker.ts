import { spawn } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import {
  definePlugin,
  startWorkerRpcHost,
  type PluginContext,
  type PluginEvent,
  type PluginHealthDiagnostics,
  type Agent,
  type Issue,
} from "@paperclipai/plugin-sdk";
import {
  sendMessage,
  editMessage,
  answerCallbackQuery,
  setMyCommands,
  escapeMarkdownV2,
  isForum,
  GENERAL_TOPIC_THREAD_ID,
  sendChatAction,
} from "./telegram-api.js";
import {
  formatIssueCreated,
  formatIssueDone,
  formatApprovalCreated,
  formatAgentError,
  formatAgentRunStarted,
  formatAgentRunFinished,
  type IssueLinksOpts,
} from "./formatters.js";
import { handleCommand, getTopicForProject, BOT_COMMANDS } from "./commands.js";
import {
  routeMessageToAgent,
  handleHandoffToolCall,
  handleDiscussToolCall,
  handleHandoffApproval,
  handleHandoffRejection,
  setupAcpOutputListener,
  type ChatSession,
} from "./acp-bridge.js";
import { handleMediaMessage } from "./media-pipeline.js";
import { handleCommandsCommand, tryCustomCommand } from "./command-registry.js";
import { handleRegisterWatch, checkWatches } from "./watch-registry.js";
import { METRIC_NAMES, ACP_SPAWN_EVENT } from "./constants.js";
import { EscalationManager } from "./escalation.js";
import type { EscalationEvent } from "./escalation.js";

// ── Shared Telegram archive (CEO Chat plugin reads this) ──
const TELEGRAM_ARCHIVE_DIR = "/tmp/ceochat-telegram";
type TgMessage = { role: string; content: string; timestamp: string; source: string };
type TgArchivedSession = { id: string; startedAt: string; endedAt: string; messageCount: number; preview: string; messages: TgMessage[]; source: string };

function loadTelegramArchive(companyId: string): TgArchivedSession[] {
  const path = `${TELEGRAM_ARCHIVE_DIR}/${companyId}.json`;
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf-8")) as TgArchivedSession[];
  } catch { /* ok */ }
  return [];
}

function saveTelegramArchiveFile(companyId: string, sessions: TgArchivedSession[]): void {
  try {
    mkdirSync(TELEGRAM_ARCHIVE_DIR, { recursive: true });
    mkdirSync(TELEGRAM_ARCHIVE_DIR, { recursive: true });
    writeFileSync(`${TELEGRAM_ARCHIVE_DIR}/${companyId}.json`, JSON.stringify(sessions));
  } catch { /* ok */ }
}

function archiveTelegramSession(companyId: string, messages: TgMessage[]): void {
  if (messages.length === 0) return;
  const archive = loadTelegramArchive(companyId);
  const userMsgs = messages.filter(m => m.role === "user");
  archive.unshift({
    id: `tg-session-${Date.now()}`,
    startedAt: messages[0].timestamp,
    endedAt: messages[messages.length - 1].timestamp,
    messageCount: messages.length,
    preview: userMsgs[0]?.content?.slice(0, 100) ?? "Telegram chat",
    messages,
    source: "telegram",
  });
  if (archive.length > 50) archive.length = 50;
  saveTelegramArchiveFile(companyId, archive);
}

function saveTelegramArchive(companyId: string, currentHistory: TgMessage[]): void {
  // Auto-archive: check if oldest message is > 24h old, if so archive and start fresh
  if (currentHistory.length > 0) {
    const oldest = new Date(currentHistory[0].timestamp).getTime();
    const now = Date.now();
    if (now - oldest > 24 * 60 * 60 * 1000) {
      archiveTelegramSession(companyId, currentHistory);
      // History will be cleared by the caller on next session
    }
  }
  // Also write current session to file so CEO Chat can show it as "active"
  const path = `${TELEGRAM_ARCHIVE_DIR}/${companyId}-current.json`;
  try {
    mkdirSync(TELEGRAM_ARCHIVE_DIR, { recursive: true });
    mkdirSync(TELEGRAM_ARCHIVE_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify(currentHistory));
  } catch { /* ok */ }
}

type TelegramConfig = {
  telegramBotTokenRef: string;
  defaultChatId: string;
  approvalsChatId: string;
  errorsChatId: string;
  paperclipBaseUrl: string;
  paperclipPublicUrl: string;
  notifyOnIssueCreated: boolean;
  notifyOnIssueDone: boolean;
  notifyOnApprovalCreated: boolean;
  notifyOnAgentError: boolean;
  enableCommands: boolean;
  enableInbound: boolean;
  digestMode: "off" | "daily" | "bidaily" | "tridaily";
  dailyDigestTime: string;
  bidailySecondTime: string;
  tridailyTimes: string;
  topicRouting: boolean;
  escalationChatId: string;
  escalationTimeoutMs: number;
  escalationDefaultAction: "defer" | "auto_reply" | "close";
  escalationHoldMessage: string;
  // Phase 3: Media Pipeline
  briefAgentId: string;
  briefAgentChatIds: string[];
  transcriptionApiKeyRef: string;
  // Phase 5: Proactive Suggestions
  maxSuggestionsPerHourPerCompany: number;
  watchDeduplicationWindowMs: number;
};

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; username?: string; first_name?: string };
    chat: { id: number; type: string; title?: string };
    text?: string;
    message_thread_id?: number;
    reply_to_message?: {
      message_id: number;
      text?: string;
      from?: { is_bot?: boolean };
    };
    entities?: Array<{ type: string; offset: number; length: number }>;
    // Media fields (Phase 3)
    voice?: { file_id: string; duration: number; mime_type?: string };
    audio?: { file_id: string; duration: number; title?: string; mime_type?: string };
    video_note?: { file_id: string; duration: number };
    document?: { file_id: string; file_name?: string; mime_type?: string };
    photo?: Array<{ file_id: string; width: number; height: number }>;
    caption?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number; username?: string; first_name?: string };
    message?: {
      message_id: number;
      chat: { id: number };
      text?: string;
    };
    data?: string;
  };
};

const TELEGRAM_API = "https://api.telegram.org";

async function resolveChat(
  ctx: PluginContext,
  companyId: string,
  fallback: string,
): Promise<string | null> {
  const override = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: "telegram-chat",
  });
  return (override as string) ?? fallback ?? null;
}

async function resolveCompanyId(ctx: PluginContext, chatId: string): Promise<string> {
  const mapping = await ctx.state.get({
    scopeKind: "instance",
    stateKey: `chat_${chatId}`,
  }) as { companyId?: string; companyName?: string } | null;
  return mapping?.companyId ?? mapping?.companyName ?? chatId;
}

const plugin = definePlugin({
  async setup(ctx) {
    const rawConfig = await ctx.config.get();
    ctx.logger.info("Telegram plugin config loaded");
    const config = rawConfig as unknown as TelegramConfig;
    const baseUrl = config.paperclipBaseUrl || "http://localhost:3100";
    const publicUrl = config.paperclipPublicUrl || baseUrl;

    if (!config.telegramBotTokenRef) {
      ctx.logger.warn("No telegramBotTokenRef configured, plugin disabled");
      return;
    }

    const token = await ctx.secrets.resolve(config.telegramBotTokenRef);

    // --- Register bot commands with Telegram ---
    if (config.enableCommands) {
      const allCommands = [
        ...BOT_COMMANDS,
        { command: "commands", description: "Manage custom workflow commands" },
      ];
      const registered = await setMyCommands(ctx, token, allCommands);
      if (registered) {
        ctx.logger.info("Bot commands registered with Telegram");
      }
    }

    // --- Long polling for inbound messages ---
    let pollingActive = true;
    let lastUpdateId = 0;

    async function pollUpdates(): Promise<void> {
      while (pollingActive) {
        try {
          const res = await ctx.http.fetch(
            `${TELEGRAM_API}/bot${token}/getUpdates?offset=${lastUpdateId + 1}&timeout=10&allowed_updates=["message","callback_query"]`,
            { method: "GET" },
          );
          const data = (await res.json()) as {
            ok: boolean;
            result?: TelegramUpdate[];
          };

          if (data.ok && data.result) {
            for (const update of data.result) {
              lastUpdateId = Math.max(lastUpdateId, update.update_id);
              await handleUpdate(ctx, token, config, update, baseUrl, publicUrl);
            }
          }
        } catch (err) {
          ctx.logger.error("Telegram polling error", { error: String(err) });
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    }

    if (config.enableCommands || config.enableInbound) {
      pollUpdates().catch((err) =>
        ctx.logger.error("Polling loop crashed", { error: String(err) }),
      );
    }

    ctx.events.on("plugin.stopping", async () => {
      pollingActive = false;
    });

    // --- Phase 2: ACP output listener (cross-plugin events) ---
    setupAcpOutputListener(ctx, token);

    // --- Event subscriptions ---

    const issuePrefixCache = new Map<string, string>();

    async function resolveIssueLinksOpts(companyId: string): Promise<IssueLinksOpts> {
      let prefix = issuePrefixCache.get(companyId);
      if (!prefix) {
        const company = await ctx.companies.get(companyId);
        prefix = company?.issuePrefix ?? "";
        if (prefix) issuePrefixCache.set(companyId, prefix);
      }
      return { baseUrl: publicUrl, issuePrefix: prefix || undefined };
    }

    const notify = async (
      event: PluginEvent,
      formatter: (e: PluginEvent, opts?: IssueLinksOpts) => { text: string; options: import("./telegram-api.js").SendMessageOptions },
      overrideChatId?: string,
    ) => {
      const chatId = await resolveChat(
        ctx,
        event.companyId,
        overrideChatId || config.defaultChatId,
      );
      if (!chatId) return;
      const linksOpts = await resolveIssueLinksOpts(event.companyId);
      const msg = formatter(event, linksOpts);

      let messageThreadId: number | undefined;
      if (config.topicRouting) {
        const payload = event.payload as Record<string, unknown>;
        const projectName = payload.projectName ? String(payload.projectName) : undefined;
        messageThreadId = await getTopicForProject(ctx, chatId, projectName);
      }
      // For forum groups, fall back to General topic if no specific topic mapping
      if (!messageThreadId && await isForum(ctx, token, chatId)) {
        messageThreadId = GENERAL_TOPIC_THREAD_ID;
      }

      if (messageThreadId) {
        msg.options.messageThreadId = messageThreadId;
      }

      const messageId = await sendMessage(ctx, token, chatId, msg.text, msg.options);

      if (messageId) {
        await ctx.state.set(
          {
            scopeKind: "instance",
            stateKey: `msg_${chatId}_${messageId}`,
          },
          {
            entityId: event.entityId,
            entityType: event.entityType,
            companyId: event.companyId,
            eventType: event.eventType,
          },
        );

        await ctx.activity.log({
          companyId: event.companyId,
          message: `Forwarded ${event.eventType} to Telegram`,
          entityType: "plugin",
          entityId: event.entityId,
        });
      }
    };

    if (config.notifyOnIssueCreated) {
      ctx.events.on("issue.created", (event: PluginEvent) =>
        notify(event, formatIssueCreated),
      );
    }

    if (config.notifyOnIssueDone) {
      ctx.events.on("issue.updated", async (event: PluginEvent) => {
        const payload = event.payload as Record<string, unknown>;
        if (payload.status !== "done") return;
        // Enrich with title if missing (issue.updated events often omit it)
        if (!payload.title && event.entityId) {
          try {
            const issue = await ctx.issues.get(event.entityId, event.companyId);
            if (issue) payload.title = issue.title;
          } catch { /* best effort */ }
        }
        await notify(event, formatIssueDone);
      });
    }

    if (config.notifyOnApprovalCreated) {
      ctx.events.on("approval.created", async (event: PluginEvent) => {
        const payload = event.payload as Record<string, unknown>;
        // Enrich with linked issue details (event only has issueIds)
        const issueIds = Array.isArray(payload.issueIds) ? payload.issueIds as string[] : [];
        if (issueIds.length > 0 && !payload.linkedIssues) {
          try {
            const issues = await Promise.all(
              issueIds.slice(0, 5).map((id) => ctx.issues.get(id, event.companyId)),
            );
            payload.linkedIssues = issues
              .filter(Boolean)
              .map((i) => ({
                identifier: i!.identifier,
                title: i!.title,
                status: i!.status,
                priority: i!.priority,
              }));
            // Use first issue's title as the approval title if missing
            if (!payload.title && issues[0]) {
              payload.title = issues[0].identifier
                ? `${issues[0].identifier}: ${issues[0].title}`
                : issues[0].title;
            }
          } catch { /* best effort */ }
        }
        // Enrich agent name
        if (payload.agentId && !payload.agentName) {
          try {
            const agent = await ctx.agents.get(String(payload.agentId), event.companyId);
            if (agent) payload.agentName = agent.name;
          } catch { /* best effort */ }
        }
        // Build a meaningful title if still missing
        if (!payload.title || payload.title === "Approval Requested") {
          const approvalType = String(payload.type ?? "unknown").replace(/_/g, " ");
          const agentLabel = payload.agentName ? String(payload.agentName) : null;
          payload.title = agentLabel
            ? `${approvalType} — ${agentLabel}`
            : approvalType;
        }
        await notify(event, formatApprovalCreated, config.approvalsChatId);
      });
    }

    if (config.notifyOnAgentError) {
      ctx.events.on("agent.run.failed", (event: PluginEvent) =>
        notify(event, formatAgentError, config.errorsChatId),
      );
    }

    ctx.events.on("agent.run.started", (event: PluginEvent) =>
      notify(event, formatAgentRunStarted),
    );
    ctx.events.on("agent.run.finished", (event: PluginEvent) => {
      // Only notify for task runs (with an issueId), not idle heartbeats
      const payload = event.payload as Record<string, unknown>;
      if (!payload?.issueId) return;
      notify(event, formatAgentRunFinished);
    });

    // --- Per-company chat overrides ---

    ctx.data.register("chat-mapping", async (params) => {
      const companyId = String(params.companyId);
      const saved = await ctx.state.get({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: "telegram-chat",
      });
      return { chatId: saved ?? config.defaultChatId };
    });

    ctx.actions.register("set-chat", async (params) => {
      const companyId = String(params.companyId);
      const chatId = String(params.chatId);
      await ctx.state.set(
        { scopeKind: "company", scopeId: companyId, stateKey: "telegram-chat" },
        chatId,
      );
      ctx.logger.info("Updated Telegram chat mapping", { companyId, chatId });
      return { ok: true };
    });

    // --- Daily digest job ---

    // Support legacy dailyDigestEnabled boolean
    const effectiveDigestMode = (config as Record<string, unknown>).dailyDigestEnabled === true && config.digestMode === "off"
      ? "daily"
      : config.digestMode ?? "off";

    if (effectiveDigestMode !== "off") {
      ctx.jobs.register("telegram-daily-digest", async () => {
        // Check if current UTC hour matches a configured digest time
        const nowHour = new Date().getUTCHours();
        const nowMin = new Date().getUTCMinutes();
        if (nowMin >= 5) return; // only fire within first 5 min of the hour

        const parseHour = (t: string) => {
          const [h] = (t || "").split(":");
          return parseInt(h ?? "", 10);
        };
        const firstHour = parseHour(config.dailyDigestTime);
        const secondHour = parseHour(config.bidailySecondTime);
        const tridailyHours = (config.tridailyTimes || "07:00,13:00,19:00")
          .split(",")
          .map((t) => parseHour(t.trim()));

        let shouldSend = false;
        if (effectiveDigestMode === "daily") {
          shouldSend = nowHour === firstHour;
        } else if (effectiveDigestMode === "bidaily") {
          shouldSend = nowHour === firstHour || nowHour === secondHour;
        } else if (effectiveDigestMode === "tridaily") {
          shouldSend = tridailyHours.includes(nowHour);
        }
        if (!shouldSend) return;

        const companies = await ctx.companies.list();
        for (const company of companies) {
          const chatId = await resolveChat(ctx, company.id, config.defaultChatId);
          if (!chatId) continue;

          try {
            const agents = await ctx.agents.list({ companyId: company.id });
            const activeAgents = agents.filter((a: Agent) => a.status === "active");
            const issues = await ctx.issues.list({ companyId: company.id, limit: 50 });

            const now = Date.now();
            const oneDayMs = 24 * 60 * 60 * 1000;
            const completedToday = issues.filter((i: Issue) =>
              i.status === "done" && i.completedAt && (now - new Date(i.completedAt).getTime()) < oneDayMs
            );
            const createdToday = issues.filter((i: Issue) =>
              (now - new Date(i.createdAt).getTime()) < oneDayMs
            );

            const issuePrefix = company.issuePrefix;
            const inProgress = issues.filter((i: Issue) => i.status === "in_progress");
            const inReview = issues.filter((i: Issue) => i.status === "in_review");
            const blocked = issues.filter((i: Issue) => i.status === "blocked");

            const dateStr = new Date().toISOString().split("T")[0];
            const companyLabel = company.name ? ` \\- ${escapeMarkdownV2(company.name)}` : "";
            const digestLabel = effectiveDigestMode === "bidaily" ? "Digest" : "Daily Digest";
            const lines = [
              escapeMarkdownV2("\ud83d\udcca") + ` *${escapeMarkdownV2(digestLabel)}${companyLabel} \\- ${escapeMarkdownV2(dateStr!)}*`,
              "",
              `${escapeMarkdownV2("\u2705")} Tasks completed: *${completedToday.length}*`,
              `${escapeMarkdownV2("\ud83d\udccb")} Tasks created: *${createdToday.length}*`,
              `${escapeMarkdownV2("\ud83e\udd16")} Active agents: *${activeAgents.length}*/${escapeMarkdownV2(String(agents.length))}`,
            ];

            if (activeAgents.length > 0) {
              const topAgent = activeAgents[0]!.name;
              lines.push(`${escapeMarkdownV2("\u2b50")} Top performer: *${escapeMarkdownV2(topAgent)}*`);
            }

            const formatIssueItem = (i: Issue) => {
              const id = i.identifier ?? i.id;
              const idText = issuePrefix
                ? `[${escapeMarkdownV2(id)}](${publicUrl}/${issuePrefix}/issues/${id})`
                : escapeMarkdownV2(id);
              return `  ${idText} \\- ${escapeMarkdownV2(i.title)}`;
            };

            if (inProgress.length > 0) {
              lines.push("", `${escapeMarkdownV2("\ud83d\udd04")} *In Progress \\(${inProgress.length}\\)*`);
              for (const i of inProgress.slice(0, 10)) lines.push(formatIssueItem(i));
            }
            if (inReview.length > 0) {
              lines.push("", `${escapeMarkdownV2("\ud83d\udd0d")} *In Review \\(${inReview.length}\\)*`);
              for (const i of inReview.slice(0, 10)) lines.push(formatIssueItem(i));
            }
            if (blocked.length > 0) {
              lines.push("", `${escapeMarkdownV2("\ud83d\udeab")} *Blocked \\(${blocked.length}\\)*`);
              for (const i of blocked.slice(0, 10)) lines.push(formatIssueItem(i));
            }

            const digestThreadId = await isForum(ctx, token, chatId)
              ? GENERAL_TOPIC_THREAD_ID
              : undefined;

            await sendMessage(ctx, token, chatId, lines.join("\n"), {
              parseMode: "MarkdownV2",
              messageThreadId: digestThreadId,
            });
          } catch (err) {
            ctx.logger.error("Daily digest failed for company", { companyId: company.id, error: String(err) });
            const text = [
              escapeMarkdownV2("\ud83d\udcca") + " *Daily Digest*",
              "",
              escapeMarkdownV2("Could not generate digest. Check plugin logs for details."),
            ].join("\n");

            const errorThreadId = await isForum(ctx, token, chatId)
              ? GENERAL_TOPIC_THREAD_ID
              : undefined;

            await sendMessage(ctx, token, chatId, text, {
              parseMode: "MarkdownV2",
              messageThreadId: errorThreadId,
            });
          }
        }
      });
    }

    // --- Phase 1: Escalation support ---
    const escalationManager = new EscalationManager();

    // Register escalate_to_human tool - 3-arg signature with ToolRunContext
    ctx.tools.register("escalate_to_human", {
      displayName: "Escalate to Human",
      description: "Escalate a conversation to a human when you cannot handle it confidently",
      parametersSchema: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            enum: ["low_confidence", "explicit_request", "policy_violation", "unknown_intent"],
            description: "Why this conversation needs human attention",
          },
          conversationSummary: {
            type: "string",
            description: "Brief summary of the conversation context and what the user needs",
          },
          suggestedActions: {
            type: "array",
            items: { type: "string" },
            description: "Suggested actions the human responder could take",
          },
          suggestedReply: {
            type: "string",
            description: "A draft reply the human can send or modify",
          },
          confidenceScore: {
            type: "number",
            minimum: 0,
            maximum: 1,
            description: "How confident the agent is (0-1). Lower values indicate greater need for human help",
          },
          originChatId: { type: "string" },
          originThreadId: { type: "string" },
          originMessageId: { type: "string" },
          sessionId: { type: "string", description: "Session ID for routing reply back" },
          transport: { type: "string", enum: ["native", "acp"], description: "Transport type for reply routing" },
        },
        required: ["reason", "conversationSummary"],
      },
    }, async (params: unknown, runCtx) => {
      const p = params as Record<string, unknown>;
      const escalationId = crypto.randomUUID();
      const timeoutMs = config.escalationTimeoutMs || 900000;
      const defaultAction = config.escalationDefaultAction || "defer";

      const resolvedEscalationChatId = await resolveChat(
        ctx,
        runCtx.companyId,
        config.escalationChatId,
      );
      if (!resolvedEscalationChatId) {
        ctx.logger.warn("Escalation received but no escalationChatId configured");
        return { error: "No escalation channel configured" };
      }

      const escalationEvent: EscalationEvent = {
        escalationId,
        agentId: runCtx.agentId,
        companyId: runCtx.companyId,
        reason: p.reason as EscalationEvent["reason"],
        context: {
          conversationHistory: [],
          agentReasoning: String(p.conversationSummary ?? ""),
          suggestedActions: (p.suggestedActions as string[]) ?? [],
          suggestedReply: p.suggestedReply ? String(p.suggestedReply) : undefined,
          confidenceScore: typeof p.confidenceScore === "number" ? p.confidenceScore : undefined,
        },
        timeout: {
          durationMs: timeoutMs,
          defaultAction,
        },
        originChatId: p.originChatId ? String(p.originChatId) : undefined,
        originThreadId: p.originThreadId ? String(p.originThreadId) : undefined,
        originMessageId: p.originMessageId ? String(p.originMessageId) : undefined,
        transport: p.transport as "native" | "acp" | undefined,
        sessionId: p.sessionId ? String(p.sessionId) : undefined,
      };

      await escalationManager.create(ctx, token, escalationEvent, resolvedEscalationChatId);

      // Send hold message to the originating chat if configured
      if (config.escalationHoldMessage && escalationEvent.originChatId) {
        const holdText = escapeMarkdownV2(config.escalationHoldMessage);
        await sendMessage(ctx, token, escalationEvent.originChatId, holdText, {
          parseMode: "MarkdownV2",
          messageThreadId: escalationEvent.originThreadId ? Number(escalationEvent.originThreadId) : undefined,
          replyToMessageId: escalationEvent.originMessageId ? Number(escalationEvent.originMessageId) : undefined,
        });
      }

      return { content: JSON.stringify({ status: "escalated", escalationId }) };
    });

    // --- Phase 2: Register handoff_to_agent tool ---
    ctx.tools.register("handoff_to_agent", {
      displayName: "Handoff to Agent",
      description: "Hand off work to another agent in this thread",
      parametersSchema: {
        type: "object",
        properties: {
          targetAgent: { type: "string", description: "Name of agent to hand off to" },
          reason: { type: "string", description: "Why you're handing off" },
          contextSummary: { type: "string", description: "Summary for the target agent" },
          requiresApproval: { type: "boolean", default: true, description: "Wait for human approval before target starts" },
          chatId: { type: "string", description: "Telegram chat ID" },
          threadId: { type: "number", description: "Telegram thread ID" },
        },
        required: ["targetAgent", "reason", "contextSummary"],
      },
    }, async (params: unknown, runCtx) => {
      return handleHandoffToolCall(ctx, token, params as Record<string, unknown>, runCtx.companyId, runCtx.agentId);
    });

    // --- Phase 2: Register discuss_with_agent tool ---
    ctx.tools.register("discuss_with_agent", {
      displayName: "Discuss with Agent",
      description: "Start a back-and-forth conversation with another agent",
      parametersSchema: {
        type: "object",
        properties: {
          targetAgent: { type: "string", description: "Name of agent to discuss with" },
          topic: { type: "string", description: "Discussion topic" },
          initialMessage: { type: "string", description: "First message to send" },
          maxTurns: { type: "number", default: 10, description: "Maximum conversation turns" },
          humanCheckpointAt: { type: "number", description: "Pause for human approval at this turn" },
          chatId: { type: "string", description: "Telegram chat ID" },
          threadId: { type: "number", description: "Telegram thread ID" },
        },
        required: ["targetAgent", "topic", "initialMessage"],
      },
    }, async (params: unknown, runCtx) => {
      return handleDiscussToolCall(ctx, token, params as Record<string, unknown>, runCtx.companyId, runCtx.agentId);
    });

    // --- Phase 5: Register register_watch tool ---
    ctx.tools.register("register_watch", {
      displayName: "Register Watch",
      description: "Register a proactive watch that monitors entities and sends suggestions",
      parametersSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name of the watch" },
          description: { type: "string", description: "What this watch monitors" },
          entityType: { type: "string", enum: ["issue", "agent", "company", "custom"], description: "Type of entity to watch" },
          conditions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                field: { type: "string" },
                operator: { type: "string", enum: ["gt", "lt", "eq", "ne", "contains", "exists"] },
                value: {},
              },
              required: ["field", "operator", "value"],
            },
            description: "Conditions that trigger the watch",
          },
          template: { type: "string", description: "Message template with {{field}} placeholders" },
          builtinTemplate: { type: "string", enum: ["invoice-overdue", "lead-stale"], description: "Use a built-in template instead" },
          chatId: { type: "string", description: "Telegram chat ID for suggestions" },
          threadId: { type: "number", description: "Telegram thread ID for suggestions" },
        },
        required: ["chatId"],
      },
    }, async (params: unknown, runCtx) => {
      return handleRegisterWatch(ctx, params as Record<string, unknown>, runCtx.companyId);
    });

    // --- Phase 1: Escalation timeout checker job ---
    ctx.jobs.register("check-escalation-timeouts", async () => {
      try {
        await escalationManager.checkTimeouts(ctx, token);
      } catch (err) {
        ctx.logger.error("Escalation timeout check failed", { error: String(err) });
      }
    });

    // --- Phase 5: Watch checker job ---
    ctx.jobs.register("check-watches", async () => {
      try {
        await checkWatches(ctx, token, {
          maxSuggestionsPerHourPerCompany: config.maxSuggestionsPerHourPerCompany ?? 10,
          watchDeduplicationWindowMs: config.watchDeduplicationWindowMs ?? 86400000,
        });
      } catch (err) {
        ctx.logger.error("Watch check failed", { error: String(err) });
      }
    });

    ctx.logger.info("Telegram bot plugin started (Chat OS v2 - all 5 phases)");
  },

  async onValidateConfig(config) {
    if (!config.telegramBotTokenRef || typeof config.telegramBotTokenRef !== "string") {
      return { ok: false, errors: ["telegramBotTokenRef is required"] };
    }
    return { ok: true };
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    return { status: "ok" };
  },
});

async function handleUpdate(
  ctx: PluginContext,
  token: string,
  config: TelegramConfig,
  update: TelegramUpdate,
  baseUrl: string,
  publicUrl?: string,
): Promise<void> {
  if (update.callback_query) {
    await handleCallbackQuery(ctx, token, update.callback_query, baseUrl);
    return;
  }

  const msg = update.message;
  if (!msg) return;

  const chatId = String(msg.chat.id);
  const threadId = msg.message_thread_id;

  // Phase 3: Handle media messages
  const hasMedia = !!(msg.voice || msg.audio || msg.video_note || msg.document || msg.photo);
  if (hasMedia) {
    const companyId = await resolveCompanyId(ctx, chatId);
    const handled = await handleMediaMessage(ctx, token, msg as Parameters<typeof handleMediaMessage>[2], {
      briefAgentId: config.briefAgentId ?? "",
      briefAgentChatIds: config.briefAgentChatIds ?? [],
      transcriptionApiKeyRef: config.transcriptionApiKeyRef ?? "",
      publicUrl,
    }, companyId);
    if (handled) return;
  }

  if (!msg.text) return;

  const text = msg.text;

  // Route thread messages to agent sessions
  if (threadId) {
    const isCommand = text.startsWith("/");
    if (!isCommand) {
      const companyId = await resolveCompanyId(ctx, chatId);
      const replyToId = msg.reply_to_message?.message_id;
      const routed = await routeMessageToAgent(ctx, token, chatId, threadId, text, replyToId, companyId);
      if (routed) return;
    }
  }

  const botCommand = msg.entities?.find((e) => e.type === "bot_command" && e.offset === 0);
  if (botCommand && config.enableCommands) {
    const fullCommand = text.slice(botCommand.offset, botCommand.offset + botCommand.length);
    const command = fullCommand.replace(/^\//, "").replace(/@.*$/, "");
    const args = text.slice(botCommand.offset + botCommand.length).trim();
    const companyId = await resolveCompanyId(ctx, chatId);

    // Archive command — saves current DM chat and starts fresh
    if (command === "archive" && msg.chat.type === "private") {
      try {
        const histKey = { scopeKind: "instance" as const, stateKey: `ava_dm_history_${companyId}` };
        const dmHistory = ((await ctx.state.get(histKey)) ?? []) as TgMessage[];
        if (dmHistory.length > 0) {
          archiveTelegramSession(companyId, dmHistory);
          await ctx.state.set(histKey, []);
          // Clear CLI session too
          const cliKey = { scopeKind: "instance" as const, stateKey: `ava_cli_session_${companyId}` };
          await ctx.state.set(cliKey, "");
          await sendMessage(ctx, token, chatId, `Archived ${dmHistory.length} messages. Starting fresh session.`, {});
        } else {
          await sendMessage(ctx, token, chatId, "No messages to archive.", {});
        }
      } catch (err) {
        await sendMessage(ctx, token, chatId, `Archive failed: ${String(err).slice(0, 100)}`, {});
      }
      return;
    }

    // Phase 4: Check custom commands first
    if (command === "commands") {
      await handleCommandsCommand(ctx, token, chatId, args, threadId, companyId);
      return;
    }

    const handledCustom = await tryCustomCommand(ctx, token, chatId, command, args, threadId, companyId);
    if (handledCustom) return;

    // Built-in commands
    await handleCommand(ctx, token, chatId, command, args, threadId, baseUrl, publicUrl);
    return;
  }

  if (config.enableInbound && msg.reply_to_message?.from?.is_bot) {
    const replyToId = msg.reply_to_message.message_id;
    const mapping = await ctx.state.get({
      scopeKind: "instance",
      stateKey: `msg_${chatId}_${replyToId}`,
    }) as { entityId: string; entityType: string; companyId: string } | null;

    if (mapping && mapping.entityType === "escalation") {
      const escalationManager = new EscalationManager();
      const responderId = `telegram:${msg.from?.username ?? msg.from?.id ?? chatId}`;
      await escalationManager.respond(ctx, token, mapping.entityId, {
        escalationId: mapping.entityId,
        responderId,
        responseText: text,
        action: "reply_to_customer",
      });
      await ctx.metrics.write(METRIC_NAMES.inboundRouted, 1);
      ctx.logger.info("Routed Telegram reply to escalation", {
        escalationId: mapping.entityId,
        from: msg.from?.username,
      });
    } else if (mapping && mapping.entityType === "issue") {
      try {
        await ctx.http.fetch(
          `${baseUrl}/api/issues/${mapping.entityId}/comments`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              body: text,
              authorUserId: `telegram:${msg.from?.username ?? msg.from?.id ?? chatId}`,
            }),
          },
        );
        await ctx.metrics.write(METRIC_NAMES.inboundRouted, 1);
        ctx.logger.info("Routed Telegram reply to issue comment", {
          issueId: mapping.entityId,
          from: msg.from?.username,
        });
      } catch (err) {
        ctx.logger.error("Failed to route inbound message", { error: String(err) });
      }
    }
  }

  // ── DM routing: private chat messages go to Ava ──
  // Uses SAME state keys as CEO Chat plugin so history is shared across both UIs
  if (config.enableInbound && msg.chat.type === "private" && !msg.reply_to_message) {
    const companyId = await resolveCompanyId(ctx, chatId);

    await sendChatAction(ctx, token, chatId).catch(() => {});
    ctx.logger.info("Processing DM for Ava", { chatId, from: msg.from?.username });

    // ── Shared state keys (same as CEO Chat plugin) ──
    const CEO_CHAT_PLUGIN_ID = "104c2d88-520b-4215-bef5-9482e5664d48";
    const MEMOS_URL = "http://memos:8000";
    const AVA_AGENT_ID = "9fd584a0-9c31-4dc4-88d8-6a03c507403a";

    const historyScope = { scopeKind: "company" as const, scopeId: companyId, stateKey: "ceochat-history", pluginId: CEO_CHAT_PLUGIN_ID };
    const cliSessionScope = { scopeKind: "company" as const, scopeId: companyId, stateKey: "ceochat-clisid", pluginId: CEO_CHAT_PLUGIN_ID };
    const usageScope = { scopeKind: "company" as const, scopeId: companyId, stateKey: "ceochat-usage", pluginId: CEO_CHAT_PLUGIN_ID };

    void (async () => {
      try {
        const typingInterval = setInterval(() => sendChatAction(ctx, token, chatId).catch(() => {}), 4000);

        // ── Try direct issue creation before calling Claude ──
        const createPattern = /(?:create|make|open|raise|add)\s+(?:an?\s+)?(?:issue|task|ticket)\s+(?:for\s+)?(\w+)\s+to\s+(.+)/i;
        const createMatch = text.match(createPattern);
        if (createMatch) {
          const agentName = createMatch[1].trim();
          const taskDescription = createMatch[2].trim();
          try {
            const agents = await ctx.agents.list({ companyId });
            const agent = agents.find((a: { name?: string }) => a.name?.toLowerCase() === agentName.toLowerCase());
            const title = taskDescription.length > 80 ? taskDescription.substring(0, 77) + "..." : taskDescription;
            const issue = await ctx.issues.create({
              companyId, title, description: taskDescription,
              priority: "medium" as const,
              ...(agent ? { assigneeAgentId: agent.id } : {}),
            });
            const issueRaw = issue as unknown as Record<string, unknown>;
            const issueId = issueRaw.identifier ?? issueRaw.id;
            // Set status to todo so adaptive heartbeat picks it up
            if (issueRaw.id) {
              await ctx.issues.update(issueRaw.id as string, { status: "todo" }, companyId);
            }
            const response = `Done. Created ${issueId} — "${title}" assigned to ${agent?.name ?? agentName}.`;
            clearInterval(typingInterval);
            await sendMessage(ctx, token, chatId, response);
            // Save to shared history
            try {
              const hist = ((await ctx.state.get(historyScope)) ?? []) as Array<{ role: string; content: string; timestamp: string; source?: string }>;
              hist.push({ role: "user", content: text, timestamp: new Date().toISOString(), source: "telegram" });
              hist.push({ role: "assistant", content: response, timestamp: new Date().toISOString(), source: "telegram" });
              await ctx.state.set(historyScope, hist.slice(-200));
            } catch { /* ok */ }
            return;
          } catch (err) {
            clearInterval(typingInterval);
            await sendMessage(ctx, token, chatId, `Failed to create issue: ${String(err).substring(0, 200)}`);
            return;
          }
        }

        // ── Fetch org context ──
        const contextParts: string[] = [];
        try {
          const agents = await ctx.agents.list({ companyId });
          const byStatus: Record<string, string[]> = {};
          for (const a of agents) {
            const agent = a as unknown as Record<string, unknown>;
            const status = (agent.status as string) ?? "unknown";
            (byStatus[status] ??= []).push(agent.name as string);
          }
          const lines = [`Agents: ${agents.length} total`];
          for (const [status, names] of Object.entries(byStatus)) {
            lines.push(`  ${status}: ${names.join(", ")}`);
          }
          contextParts.push(lines.join("\n"));
        } catch { contextParts.push("Agents: unavailable"); }

        // Open issues (multiple status calls since SDK takes single status)
        try {
          const [todo, inProgress, blocked] = await Promise.all([
            ctx.issues.list({ companyId, status: "todo" as const }).catch(() => []),
            ctx.issues.list({ companyId, status: "in_progress" as const }).catch(() => []),
            ctx.issues.list({ companyId, status: "blocked" as const }).catch(() => []),
          ]);
          const openIssues = [...todo, ...inProgress, ...blocked];
          if (openIssues.length > 0) {
            const lines = openIssues.slice(0, 15).map((i) =>
              `- ${(i as any).identifier}: ${(i as any).title} [${(i as any).status}]${(i as any).projectName ? ` (${(i as any).projectName})` : ""}`);
            contextParts.push(`Open issues (${openIssues.length}):\n${lines.join("\n")}`);
          } else { contextParts.push("Open issues: none"); }
        } catch { contextParts.push("Issues: unavailable"); }

        // Skip completed issues — only show open work in DM context

        try {
          const projects = await ctx.projects.list({ companyId });
          if (projects.length > 0) {
            contextParts.push(`Projects: ${projects.map((p: any) => p.name).join(", ")}`);
          }
        } catch { /* ok */ }

        // ── MemOS search ──
        let memories: string[] = [];
        try {
          const res = await ctx.http.fetch(`${MEMOS_URL}/product/search`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: text, user_id: AVA_AGENT_ID, readable_cube_ids: [companyId], top_k: 8, mode: "fast" }),
          });
          if (res.ok) {
            const body = await res.json() as { data?: Record<string, unknown> };
            for (const [, entries] of Object.entries(body.data ?? {})) {
              if (typeof entries === "string" && entries.length > 5) { memories.push(entries); continue; }
              if (!Array.isArray(entries)) continue;
              for (const entry of entries as Array<{ memories?: Array<{ memory?: string }> }>) {
                for (const mem of entry.memories ?? []) {
                  if (mem.memory && mem.memory.length > 5) memories.push(mem.memory);
                }
              }
            }
          }
        } catch { /* ok */ }

        // ── Build enriched prompt ──
        let prompt = "[You are Ava, Animus Group board assistant. Stay in character. Use the org data below to answer.]\n\n";
        prompt += `--- LIVE ORG DATA ---\n${contextParts.join("\n\n")}\n\n`;
        if (memories.length > 0) prompt += `--- ORG MEMORIES ---\n${memories.slice(0, 8).map(m => `- ${m}`).join("\n")}\n\n`;
        prompt += `--- BOARD MESSAGE (via Telegram) ---\n${text}`;

        // ── Spawn Claude CLI with shared session ──
        const SYS_PROMPT = `You are Ava, board assistant for Animus Group. Direct, concise, strategic personality.
Never identify as Claude or mention Anthropic. You are Ava.

Org: CEO Ama (your principal), CTO Tony (eng, 13 reports), CFO Oro (finance, 11 reports), CMO Marcus (marketing, 18 reports), Hermes (email).
Each message contains LIVE ORG DATA and ORG MEMORIES. Use them to answer.
Never say you lack credentials, API access, or data — the data is in the message.
Keep responses concise for Telegram (short paragraphs, bullet points).

ISSUE CREATION: When the user asks to create a task, assign work, or delegate something, create a Paperclip issue. Format:
\`\`\`paperclip-action
action: create-issue
title: <clear title>
assignee: <agent name>
priority: <low|medium|high|urgent>
description: <what needs to be done>
\`\`\`
Route to the right agent: Tony's team for engineering, Oro's team for finance/tax, Marcus's team for marketing/SEO/content.`;

        const cliArgs = [
          "--print", "--output-format", "stream-json", "--verbose",
          "--model", "claude-sonnet-4-6",
          "--append-system-prompt", SYS_PROMPT,
          "--tools", "Read,Glob,Grep",
        ];

        // Use shared CLI session (same as CEO Chat plugin)
        // Note: we read from our own plugin state since cross-plugin state isn't accessible
        const ownCliSessionKey = { scopeKind: "instance" as const, stateKey: `ava_cli_session_${companyId}` };
        const resumeId = (await ctx.state.get(ownCliSessionKey) as string) || null;
        if (resumeId) cliArgs.push("--resume", resumeId);

        const result = await new Promise<{ text: string; sessionId: string | null }>((resolve, reject) => {
          const proc = spawn("claude", cliArgs, {
            env: { ...process.env as Record<string, string>, HOME: "/paperclip" },
            stdio: ["pipe", "pipe", "pipe"],
            timeout: 120_000,
          });
          let stdout = "";
          let stderr = "";
          proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
          proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
          proc.stdin.write(prompt);
          proc.stdin.end();
          proc.on("error", (err) => reject(err));
          proc.on("close", (code) => {
            if (code !== 0 && !stdout) { reject(new Error(`Claude exited ${code}: ${stderr.slice(0, 200)}`)); return; }
            let resultText = "";
            let sid: string | null = null;
            for (const line of stdout.split("\n")) {
              const t = line.trim();
              if (!t || !t.startsWith("{")) continue;
              try {
                const obj = JSON.parse(t);
                if (obj.type === "result" && typeof obj.result === "string") {
                  resultText = obj.result;
                  if (obj.session_id) sid = obj.session_id;
                }
              } catch { /* skip */ }
            }
            resolve({ text: resultText || "(no response)", sessionId: sid });
          });
        });

        clearInterval(typingInterval);

        // Save CLI session
        if (result.sessionId) await ctx.state.set(ownCliSessionKey, result.sessionId);

        // Execute paperclip-action blocks (issue creation etc.)
        let responseText = result.text;
        const actionMatch = result.text.match(/```paperclip-action\n([\s\S]*?)\n```/);
        if (actionMatch) {
          try {
            const action = JSON.parse(actionMatch[1]);
            if (action.action === "create_issue") {
              let assigneeId: string | undefined;
              if (action.assignee) {
                const agents = await ctx.agents.list({ companyId });
                const match = agents.find((a: any) => (a.name as string)?.toLowerCase() === action.assignee.toLowerCase());
                if (match) assigneeId = match.id;
              }
              const issue = await ctx.issues.create({
                companyId, title: action.title, description: action.description ?? "",
                priority: action.priority ?? "medium",
                ...(assigneeId ? { assigneeAgentId: assigneeId } : {}),
              });
              const issueId = (issue as any).identifier ?? (issue as any).id;
              responseText = responseText.replace(actionMatch[0], `\n[Created issue ${issueId}]`);
              ctx.logger.info("Created issue from Telegram DM", { issueId });
            }
          } catch (err) {
            responseText = responseText.replace(actionMatch[0], `\n[Action failed: ${String(err).slice(0, 100)}]`);
          }
        }

        // Send to Telegram
        await sendMessage(ctx, token, chatId, responseText, {});

        // ── Save to Telegram DM history (shared file for CEO Chat UI) ──
        try {
          const histKey = { scopeKind: "instance" as const, stateKey: `ava_dm_history_${companyId}` };
          const dmHistory = ((await ctx.state.get(histKey)) ?? []) as Array<{ role: string; content: string; timestamp: string; source: string }>;
          dmHistory.push({ role: "user", content: text, timestamp: new Date().toISOString(), source: "telegram" });
          dmHistory.push({ role: "assistant", content: result.text, timestamp: new Date().toISOString(), source: "telegram" });
          // Keep last 200
          const trimmed = dmHistory.length > 200 ? dmHistory.slice(-200) : dmHistory;
          await ctx.state.set(histKey, trimmed);

          // Write to shared file for CEO Chat plugin to read
          saveTelegramArchive(companyId, trimmed);
        } catch { /* ok */ }

        // ── Store in MemOS ──
        try {
          await ctx.http.fetch(`${MEMOS_URL}/product/add`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              user_id: AVA_AGENT_ID, writable_cube_ids: [companyId],
              messages: [{ role: "assistant", content: `Board asked (Telegram): "${text}"\nAva replied: "${result.text}"\n[source: telegram]\n[category: board-chat]` }],
              async_mode: "async",
            }),
          });
        } catch { /* ok */ }

        // ── Log to activity ──
        try {
          const preview = result.text.length > 100 ? result.text.slice(0, 100) + "..." : result.text;
          await ctx.activity.log({ companyId, message: `Board chat (Telegram) with Ava: "${preview}"`, entityType: "agent", entityId: AVA_AGENT_ID });
        } catch { /* ok */ }

        ctx.logger.info("Ava DM complete", { chatId, len: result.text.length });
      } catch (err) {
        ctx.logger.error("Ava DM failed", { error: String(err) });
        await sendMessage(ctx, token, chatId, `Ava error: ${String(err).slice(0, 200)}`, {});
      }
    })();

    await ctx.metrics.write(METRIC_NAMES.inboundRouted, 1);
    ctx.logger.info("Routed DM to Ava", { chatId, from: msg.from?.username });
  }
}

async function handleCallbackQuery(
  ctx: PluginContext,
  token: string,
  query: NonNullable<TelegramUpdate["callback_query"]>,
  baseUrl: string,
): Promise<void> {
  const data = query.data;
  if (!data) return;

  const actor = query.from.username ?? query.from.first_name ?? String(query.from.id);
  const chatId = query.message?.chat.id ? String(query.message.chat.id) : null;
  const messageId = query.message?.message_id;

  if (data.startsWith("approve_")) {
    const approvalId = data.replace("approve_", "");
    ctx.logger.info("Approval button clicked", { approvalId, actor });

    try {
      await ctx.http.fetch(
        `${baseUrl}/api/approvals/${approvalId}/approve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decidedByUserId: `telegram:${actor}` }),
        },
      );

      await answerCallbackQuery(ctx, token, query.id, "Approved");

      if (chatId && messageId) {
        await editMessage(
          ctx,
          token,
          chatId,
          messageId,
          `${escapeMarkdownV2("\u2705")} *Approved* by ${escapeMarkdownV2(actor)}`,
          { parseMode: "MarkdownV2" },
        );
      }
    } catch (err) {
      await answerCallbackQuery(ctx, token, query.id, `Failed: ${String(err)}`);
    }
    return;
  }

  if (data.startsWith("esc_")) {
    const parts = data.split("_");
    const action = parts[1] ?? "";
    const escalationId = parts.slice(2).join("_");
    const escalationManager = new EscalationManager();
    await escalationManager.handleCallback(
      ctx,
      token,
      action,
      escalationId,
      actor,
      query.id,
      chatId,
      messageId,
    );
    await answerCallbackQuery(ctx, token, query.id, `Escalation: ${action}`);
    return;
  }

  if (data.startsWith("reject_")) {
    const approvalId = data.replace("reject_", "");
    ctx.logger.info("Rejection button clicked", { approvalId, actor });

    try {
      await ctx.http.fetch(
        `${baseUrl}/api/approvals/${approvalId}/reject`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decidedByUserId: `telegram:${actor}` }),
        },
      );

      await answerCallbackQuery(ctx, token, query.id, "Rejected");

      if (chatId && messageId) {
        await editMessage(
          ctx,
          token,
          chatId,
          messageId,
          `${escapeMarkdownV2("\u274c")} *Rejected* by ${escapeMarkdownV2(actor)}`,
          { parseMode: "MarkdownV2" },
        );
      }
    } catch (err) {
      await answerCallbackQuery(ctx, token, query.id, `Failed: ${String(err)}`);
    }
    return;
  }

  if (data.startsWith("handoff_approve_")) {
    const handoffId = data.replace("handoff_approve_", "");
    await handleHandoffApproval(ctx, token, handoffId, actor, query.id, chatId, messageId);
    await answerCallbackQuery(ctx, token, query.id, "Handoff approved");
    return;
  }

  if (data.startsWith("handoff_reject_")) {
    const handoffId = data.replace("handoff_reject_", "");
    await handleHandoffRejection(ctx, token, handoffId, actor, query.id, chatId, messageId);
    await answerCallbackQuery(ctx, token, query.id, "Handoff rejected");
    return;
  }

  await answerCallbackQuery(ctx, token, query.id, "Unknown action");
}

export default plugin;
startWorkerRpcHost({ plugin });
