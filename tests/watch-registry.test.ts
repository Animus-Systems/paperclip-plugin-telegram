import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleRegisterWatch, checkWatches } from "../src/watch-registry.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";

let sentMessages: Array<{ chatId: string; text: string; options?: Record<string, unknown> }> = [];
let stateStore: Record<string, unknown> = {};

vi.mock("../src/telegram-api.js", async () => {
  const actual = await vi.importActual("../src/telegram-api.js") as Record<string, unknown>;
  return {
    ...actual,
    sendMessage: vi.fn(async (_ctx: unknown, _token: string, chatId: string, text: string, options?: Record<string, unknown>) => {
      sentMessages.push({ chatId, text, options });
      return 1;
    }),
  };
});

function mockCtx(overrides: Record<string, unknown> = {}): PluginContext {
  return {
    http: { fetch: vi.fn() },
    metrics: { write: vi.fn() },
    state: {
      get: vi.fn(async (key: { stateKey: string }) => stateStore[key.stateKey] ?? null),
      set: vi.fn(async (key: { stateKey: string }, value: unknown) => {
        stateStore[key.stateKey] = value;
      }),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    companies: {
      list: vi.fn().mockResolvedValue([{ id: "co-1" }]),
    },
    issues: {
      list: vi.fn().mockResolvedValue([]),
    },
    agents: {
      list: vi.fn().mockResolvedValue([]),
    },
    ...overrides,
  } as unknown as PluginContext;
}

beforeEach(() => {
  sentMessages = [];
  stateStore = {};
});

describe("handleRegisterWatch - storage and retrieval", () => {
  it("registers a custom watch and stores it", async () => {
    const ctx = mockCtx();
    const result = await handleRegisterWatch(ctx, {
      name: "Invoice Alert",
      description: "Alert on overdue invoices",
      entityType: "custom",
      conditions: [{ field: "status", operator: "eq", value: "overdue" }],
      template: "Invoice {{entityId}} is overdue",
      chatId: "chat-1",
    }, "co-1");

    expect(result.content).toBeDefined();
    const parsed = JSON.parse(result.content!);
    expect(parsed.status).toBe("registered");
    expect(parsed.watchId).toBeDefined();
    expect(parsed.name).toBe("Invoice Alert");

    // Check it was stored
    const watches = stateStore["watches_co-1"] as Array<{ name: string }>;
    expect(watches).toHaveLength(1);
    expect(watches[0].name).toBe("Invoice Alert");
  });

  it("registers a watch using built-in template", async () => {
    const ctx = mockCtx();
    const result = await handleRegisterWatch(ctx, {
      builtinTemplate: "invoice-overdue",
      chatId: "chat-1",
    }, "co-1");

    expect(result.content).toBeDefined();
    const parsed = JSON.parse(result.content!);
    expect(parsed.status).toBe("registered");
    expect(parsed.name).toBe("Invoice Overdue");
  });

  it("returns error when no name or builtinTemplate", async () => {
    const ctx = mockCtx();
    const result = await handleRegisterWatch(ctx, {
      chatId: "chat-1",
    }, "co-1");

    expect(result.error).toContain("Either 'name' or 'builtinTemplate' is required");
  });

  it("returns error when chatId is missing", async () => {
    const ctx = mockCtx();
    const result = await handleRegisterWatch(ctx, {
      name: "test",
      template: "test",
    }, "co-1");

    expect(result.error).toContain("chatId");
  });

  it("returns error when custom watch has no template", async () => {
    const ctx = mockCtx();
    const result = await handleRegisterWatch(ctx, {
      name: "test",
      chatId: "chat-1",
    }, "co-1");

    expect(result.error).toContain("template");
  });

  it("appends to existing watch registry", async () => {
    stateStore["watches_co-1"] = [{
      watchId: "w1",
      name: "Existing",
      description: "",
      entityType: "custom",
      conditions: [],
      template: "t",
      chatId: "c",
      companyId: "co-1",
      createdBy: "test",
      createdAt: "2026-01-01",
    }];
    const ctx = mockCtx();
    await handleRegisterWatch(ctx, {
      name: "New Watch",
      template: "new template",
      chatId: "chat-1",
    }, "co-1");

    const watches = stateStore["watches_co-1"] as unknown[];
    expect(watches).toHaveLength(2);
  });
});

describe("checkWatches - rate limiting", () => {
  it("suppresses when hourly count exceeds max", async () => {
    const hourKey = `suggestion_hourly_co-1_${new Date().toISOString().slice(0, 13)}`;
    stateStore[hourKey] = 11; // over limit of 10

    stateStore["watches_co-1"] = [{
      watchId: "w1",
      name: "Test",
      description: "",
      entityType: "issue",
      conditions: [],
      template: "Alert: {{id}}",
      chatId: "chat-1",
      companyId: "co-1",
      createdBy: "agent",
      createdAt: "2026-01-01",
    }];

    const ctx = mockCtx({
      issues: { list: vi.fn().mockResolvedValue([{ id: "i1", title: "Test", status: "open" }]) },
    });

    await checkWatches(ctx, "token", {
      maxSuggestionsPerHourPerCompany: 10,
      watchDeduplicationWindowMs: 86400000,
    });

    // Rate limited, so no messages sent
    expect(sentMessages.length).toBe(0);
  });

  it("sends suggestion when under rate limit", async () => {
    stateStore["watches_co-1"] = [{
      watchId: "w1",
      name: "Active Issues",
      description: "",
      entityType: "issue",
      conditions: [{ field: "status", operator: "eq", value: "open" }],
      template: "Issue {{id}} needs attention",
      chatId: "chat-1",
      companyId: "co-1",
      createdBy: "agent",
      createdAt: "2026-01-01",
    }];

    const ctx = mockCtx({
      issues: { list: vi.fn().mockResolvedValue([{ id: "i1", title: "Test", status: "open" }]) },
    });

    await checkWatches(ctx, "token", {
      maxSuggestionsPerHourPerCompany: 10,
      watchDeduplicationWindowMs: 86400000,
    });

    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].text).toContain("needs attention");
  });
});

describe("checkWatches - deduplication", () => {
  it("suppresses same watch+entity within dedup window", async () => {
    stateStore["watches_co-1"] = [{
      watchId: "w1",
      name: "Active Issues",
      description: "",
      entityType: "issue",
      conditions: [{ field: "status", operator: "eq", value: "open" }],
      template: "Issue {{id}} needs attention",
      chatId: "chat-1",
      companyId: "co-1",
      createdBy: "agent",
      createdAt: "2026-01-01",
    }];

    // Mark as already sent within the window
    stateStore["suggestion_log_w1_i1"] = {
      watchId: "w1",
      entityId: "i1",
      sentAt: new Date().toISOString(), // just now
    };

    const ctx = mockCtx({
      issues: { list: vi.fn().mockResolvedValue([{ id: "i1", title: "Test", status: "open" }]) },
    });

    await checkWatches(ctx, "token", {
      maxSuggestionsPerHourPerCompany: 10,
      watchDeduplicationWindowMs: 86400000, // 24h
    });

    expect(sentMessages.length).toBe(0);
  });

  it("allows same watch+entity after dedup window expires", async () => {
    stateStore["watches_co-1"] = [{
      watchId: "w1",
      name: "Active Issues",
      description: "",
      entityType: "issue",
      conditions: [{ field: "status", operator: "eq", value: "open" }],
      template: "Issue {{id}} needs attention",
      chatId: "chat-1",
      companyId: "co-1",
      createdBy: "agent",
      createdAt: "2026-01-01",
    }];

    // Sent 25 hours ago - outside 24h window
    stateStore["suggestion_log_w1_i1"] = {
      watchId: "w1",
      entityId: "i1",
      sentAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    };

    const ctx = mockCtx({
      issues: { list: vi.fn().mockResolvedValue([{ id: "i1", title: "Test", status: "open" }]) },
    });

    await checkWatches(ctx, "token", {
      maxSuggestionsPerHourPerCompany: 10,
      watchDeduplicationWindowMs: 86400000,
    });

    expect(sentMessages.length).toBe(1);
  });
});

describe("Built-in template loading", () => {
  it("loads invoice-overdue template with correct conditions", async () => {
    const ctx = mockCtx();
    const result = await handleRegisterWatch(ctx, {
      builtinTemplate: "invoice-overdue",
      chatId: "chat-1",
    }, "co-1");

    const watches = stateStore["watches_co-1"] as Array<{
      name: string;
      conditions: Array<{ field: string; operator: string }>;
    }>;
    expect(watches[0].name).toBe("Invoice Overdue");
    expect(watches[0].conditions.length).toBe(2);
    expect(watches[0].conditions[0].field).toBe("dueDate");
    expect(watches[0].conditions[1].field).toBe("status");
  });

  it("loads lead-stale template with correct conditions", async () => {
    const ctx = mockCtx();
    const result = await handleRegisterWatch(ctx, {
      builtinTemplate: "lead-stale",
      chatId: "chat-1",
    }, "co-1");

    const watches = stateStore["watches_co-1"] as Array<{
      name: string;
      conditions: Array<{ field: string; operator: string }>;
    }>;
    expect(watches[0].name).toBe("Stale Lead");
    expect(watches[0].conditions.length).toBe(2);
    expect(watches[0].conditions[0].field).toBe("lastActivityAt");
    expect(watches[0].conditions[1].field).toBe("status");
  });

  it("returns error for unknown built-in template (falls through to custom)", async () => {
    const ctx = mockCtx();
    const result = await handleRegisterWatch(ctx, {
      builtinTemplate: "nonexistent-template",
      chatId: "chat-1",
    }, "co-1");

    // Will fail because no name and no valid builtin
    expect(result.error).toContain("template");
  });
});

describe("Watch condition matching", () => {
  it("matches issues with eq condition", async () => {
    stateStore["watches_co-1"] = [{
      watchId: "w1",
      name: "Open Issues",
      description: "",
      entityType: "issue",
      conditions: [{ field: "status", operator: "eq", value: "open" }],
      template: "Issue {{id}} is open",
      chatId: "chat-1",
      companyId: "co-1",
      createdBy: "agent",
      createdAt: "2026-01-01",
    }];

    const ctx = mockCtx({
      issues: { list: vi.fn().mockResolvedValue([
        { id: "i1", status: "open" },
        { id: "i2", status: "closed" },
      ]) },
    });

    await checkWatches(ctx, "token", {
      maxSuggestionsPerHourPerCompany: 10,
      watchDeduplicationWindowMs: 86400000,
    });

    // Only i1 should match
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].text).toContain("i1");
  });

  it("matches issues with ne condition", async () => {
    stateStore["watches_co-1"] = [{
      watchId: "w1",
      name: "Non-closed Issues",
      description: "",
      entityType: "issue",
      conditions: [{ field: "status", operator: "ne", value: "closed" }],
      template: "Issue {{id}} is not closed",
      chatId: "chat-1",
      companyId: "co-1",
      createdBy: "agent",
      createdAt: "2026-01-01",
    }];

    const ctx = mockCtx({
      issues: { list: vi.fn().mockResolvedValue([
        { id: "i1", status: "open" },
        { id: "i2", status: "closed" },
      ]) },
    });

    await checkWatches(ctx, "token", {
      maxSuggestionsPerHourPerCompany: 10,
      watchDeduplicationWindowMs: 86400000,
    });

    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].text).toContain("i1");
  });

  it("matches issues with contains condition", async () => {
    stateStore["watches_co-1"] = [{
      watchId: "w1",
      name: "Bug Issues",
      description: "",
      entityType: "issue",
      conditions: [{ field: "title", operator: "contains", value: "bug" }],
      template: "Bug: {{id}}",
      chatId: "chat-1",
      companyId: "co-1",
      createdBy: "agent",
      createdAt: "2026-01-01",
    }];

    const ctx = mockCtx({
      issues: { list: vi.fn().mockResolvedValue([
        { id: "i1", title: "Fix bug in login" },
        { id: "i2", title: "Add feature" },
      ]) },
    });

    await checkWatches(ctx, "token", {
      maxSuggestionsPerHourPerCompany: 10,
      watchDeduplicationWindowMs: 86400000,
    });

    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].text).toContain("i1");
  });
});
