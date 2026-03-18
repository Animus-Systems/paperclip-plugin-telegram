import type { PluginContext } from "@paperclipai/plugin-sdk";
import { sendMessage, escapeMarkdownV2, sendChatAction } from "./telegram-api.js";

type AcpBinding = {
  sessionId: string;
  agentName: string;
  boundAt: string;
};

type AcpOutputEvent = {
  sessionId: string;
  chatId: string;
  threadId: number;
  text: string;
  done?: boolean;
};

export async function handleAcpCommand(
  ctx: PluginContext,
  token: string,
  chatId: string,
  args: string,
  messageThreadId?: number,
): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const subcommand = parts[0]?.toLowerCase() ?? "";

  switch (subcommand) {
    case "spawn":
      await handleAcpSpawn(ctx, token, chatId, parts.slice(1).join(" "), messageThreadId);
      break;
    case "status":
      await handleAcpStatus(ctx, token, chatId, messageThreadId);
      break;
    case "cancel":
      await handleAcpCancel(ctx, token, chatId, messageThreadId);
      break;
    case "close":
      await handleAcpClose(ctx, token, chatId, messageThreadId);
      break;
    default:
      await sendMessage(
        ctx,
        token,
        chatId,
        [
          escapeMarkdownV2("🔌") + " *ACP Commands*",
          "",
          `/acp spawn <agent\\-name> \\- ${escapeMarkdownV2("Start a coding agent session in this thread")}`,
          `/acp status \\- ${escapeMarkdownV2("Show current ACP session status")}`,
          `/acp cancel \\- ${escapeMarkdownV2("Cancel the running agent task")}`,
          `/acp close \\- ${escapeMarkdownV2("End the ACP session and unbind this thread")}`,
        ].join("\n"),
        { parseMode: "MarkdownV2", messageThreadId },
      );
  }
}

async function handleAcpSpawn(
  ctx: PluginContext,
  token: string,
  chatId: string,
  agentName: string,
  messageThreadId?: number,
): Promise<void> {
  if (!agentName.trim()) {
    await sendMessage(ctx, token, chatId, "Usage: /acp spawn <agent-name>", {
      messageThreadId,
    });
    return;
  }

  if (!messageThreadId) {
    await sendMessage(
      ctx,
      token,
      chatId,
      "ACP sessions must be started inside a topic thread.",
      { messageThreadId },
    );
    return;
  }

  const existingBinding = await getAcpBinding(ctx, chatId, messageThreadId);
  if (existingBinding) {
    await sendMessage(
      ctx,
      token,
      chatId,
      `This thread already has an ACP session: \`${escapeMarkdownV2(existingBinding.sessionId)}\``,
      { parseMode: "MarkdownV2", messageThreadId },
    );
    return;
  }

  await sendChatAction(ctx, token, chatId);

  const sessionId = `acp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  await ctx.state.set(
    { scopeKind: "instance", stateKey: `acp_${chatId}_${messageThreadId}` },
    { sessionId, agentName: agentName.trim(), boundAt: new Date().toISOString() } satisfies AcpBinding,
  );

  ctx.events.emit("acp:message", {
    type: "spawn",
    sessionId,
    agentName: agentName.trim(),
    chatId,
    threadId: messageThreadId,
  });

  await sendMessage(
    ctx,
    token,
    chatId,
    [
      escapeMarkdownV2("🔌") + " *ACP Session Started*",
      "",
      `Agent: *${escapeMarkdownV2(agentName.trim())}*`,
      `Session: \`${escapeMarkdownV2(sessionId)}\``,
      "",
      escapeMarkdownV2("Send messages in this thread to interact with the agent."),
    ].join("\n"),
    { parseMode: "MarkdownV2", messageThreadId },
  );

  ctx.logger.info("ACP session spawned", { sessionId, agentName: agentName.trim(), chatId, threadId: messageThreadId });
}

async function handleAcpStatus(
  ctx: PluginContext,
  token: string,
  chatId: string,
  messageThreadId?: number,
): Promise<void> {
  if (!messageThreadId) {
    await sendMessage(ctx, token, chatId, "Run /acp status inside a thread with an active session.", {
      messageThreadId,
    });
    return;
  }

  const binding = await getAcpBinding(ctx, chatId, messageThreadId);
  if (!binding) {
    await sendMessage(ctx, token, chatId, "No ACP session bound to this thread.", {
      messageThreadId,
    });
    return;
  }

  await sendMessage(
    ctx,
    token,
    chatId,
    [
      escapeMarkdownV2("🔌") + " *ACP Session*",
      "",
      `Agent: *${escapeMarkdownV2(binding.agentName)}*`,
      `Session: \`${escapeMarkdownV2(binding.sessionId)}\``,
      `Started: ${escapeMarkdownV2(binding.boundAt)}`,
    ].join("\n"),
    { parseMode: "MarkdownV2", messageThreadId },
  );
}

async function handleAcpCancel(
  ctx: PluginContext,
  token: string,
  chatId: string,
  messageThreadId?: number,
): Promise<void> {
  if (!messageThreadId) {
    await sendMessage(ctx, token, chatId, "Run /acp cancel inside a thread with an active session.", {
      messageThreadId,
    });
    return;
  }

  const binding = await getAcpBinding(ctx, chatId, messageThreadId);
  if (!binding) {
    await sendMessage(ctx, token, chatId, "No ACP session bound to this thread.", {
      messageThreadId,
    });
    return;
  }

  ctx.events.emit("acp:message", {
    type: "cancel",
    sessionId: binding.sessionId,
    chatId,
    threadId: messageThreadId,
  });

  await sendMessage(
    ctx,
    token,
    chatId,
    `${escapeMarkdownV2("⏹")} Cancellation requested for session \`${escapeMarkdownV2(binding.sessionId)}\``,
    { parseMode: "MarkdownV2", messageThreadId },
  );

  ctx.logger.info("ACP cancel requested", { sessionId: binding.sessionId, chatId, threadId: messageThreadId });
}

async function handleAcpClose(
  ctx: PluginContext,
  token: string,
  chatId: string,
  messageThreadId?: number,
): Promise<void> {
  if (!messageThreadId) {
    await sendMessage(ctx, token, chatId, "Run /acp close inside a thread with an active session.", {
      messageThreadId,
    });
    return;
  }

  const binding = await getAcpBinding(ctx, chatId, messageThreadId);
  if (!binding) {
    await sendMessage(ctx, token, chatId, "No ACP session bound to this thread.", {
      messageThreadId,
    });
    return;
  }

  ctx.events.emit("acp:message", {
    type: "close",
    sessionId: binding.sessionId,
    chatId,
    threadId: messageThreadId,
  });

  await ctx.state.set(
    { scopeKind: "instance", stateKey: `acp_${chatId}_${messageThreadId}` },
    null,
  );

  await sendMessage(
    ctx,
    token,
    chatId,
    `${escapeMarkdownV2("🔌")} ACP session \`${escapeMarkdownV2(binding.sessionId)}\` closed\\.`,
    { parseMode: "MarkdownV2", messageThreadId },
  );

  ctx.logger.info("ACP session closed", { sessionId: binding.sessionId, chatId, threadId: messageThreadId });
}

export async function routeMessageToAcp(
  ctx: PluginContext,
  chatId: string,
  threadId: number,
  text: string,
): Promise<boolean> {
  const binding = await getAcpBinding(ctx, chatId, threadId);
  if (!binding) return false;

  ctx.events.emit("acp:message", {
    type: "message",
    sessionId: binding.sessionId,
    chatId,
    threadId,
    text,
  });

  ctx.logger.info("Routed message to ACP session", { sessionId: binding.sessionId, chatId, threadId });
  return true;
}

export async function handleAcpOutput(
  ctx: PluginContext,
  token: string,
  event: AcpOutputEvent,
): Promise<void> {
  const { chatId, threadId, text, done } = event;

  const prefix = done
    ? escapeMarkdownV2("✅")
    : escapeMarkdownV2("🤖");

  const formatted = `${prefix} ${escapeMarkdownV2(text)}`;

  await sendMessage(ctx, token, chatId, formatted, {
    parseMode: "MarkdownV2",
    messageThreadId: threadId,
  });
}

async function getAcpBinding(
  ctx: PluginContext,
  chatId: string,
  threadId: number,
): Promise<AcpBinding | null> {
  const binding = await ctx.state.get({
    scopeKind: "instance",
    stateKey: `acp_${chatId}_${threadId}`,
  }) as AcpBinding | null;
  return binding;
}
