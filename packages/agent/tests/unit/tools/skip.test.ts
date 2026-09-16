import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { StructuredTool } from "@langchain/core/tools";
import { ToolCatalog } from "@nautilo/catalog";
import type { RoomParticipant } from "@nautilo/trust";
import {
  createSkipTool,
  skipToolSchema,
  SKIP_TOOL_DESCRIPTION,
  MAX_REDIRECT_TARGET_HANDLE_LENGTH,
  normalizeRedirectTargetHandle,
  resolveSourceHandle,
  recordRedirectRequest,
  type SkipToolResult,
} from "../../../src/tools/skip";
import {
  _resetAgentTurnContextsForTests,
  clearAgentTurnContext,
  consumeAgentRedirectRequest,
  consumeAgentRedirectRequestByKey,
  getAgentTurnContext,
  getAgentTurnContextByKey,
  getOrCreateAgentTurnContext,
  getOrCreateAgentTurnContextByKey,
  peekAgentRedirectRequest,
  peekAgentRedirectRequestByKey,
  seedAgentRedirectDepth,
  seedAgentRedirectDepthByKey,
  tryRecordAgentRedirect,
  turnContextKey,
  type AgentTurnContext,
} from "../../../src/runtime/turn-context";
import {
  shouldEmitFallbackAssistantText,
  shouldSuppressFallbackEmission,
} from "../../../src/runtime/post-turn-hook";
import {
  buildSystemPrompt,
  SKIP_TOOL_MULTI_HUMAN_PROMPT,
} from "../../../src/prompts/templates";
import { registerAllTools } from "../../../src/tools/register-all";

afterEach(() => {
  _resetAgentTurnContextsForTests();
});

describe("skip tool schema", () => {
  test("accepts optional reason", () => {
    expect(skipToolSchema.parse({ reason: "not for me" })).toEqual({
      reason: "not for me",
    });
  });

  test("accepts empty object", () => {
    expect(skipToolSchema.parse({})).toEqual({});
  });
});

describe("skip tool invocation", () => {
  test("sets ctx.skipFlag and returns skipped payload with reason", async () => {
    const turnContext: AgentTurnContext = {};
    const tool = createSkipTool({
      turnId: "turn-a",
      turnContext,
    });

    const raw: unknown = await tool.invoke({ reason: "human banter" });
    const parsed: SkipToolResult = JSON.parse(String(raw)) as SkipToolResult;
    expect(parsed).toEqual({
      skipped: true,
      reason: "human banter",
    });
    expect(turnContext.skipFlag).toBe(true);
    expect(getAgentTurnContext("turn-a")?.skipFlag).toBe(true);
  });

  test("returns reason null when reason omitted", async () => {
    const turnContext: { skipFlag?: boolean } = {};
    const tool = createSkipTool({ turnId: "turn-b", turnContext });

    const raw: unknown = await tool.invoke({});
    const parsed: SkipToolResult = JSON.parse(String(raw)) as SkipToolResult;
    expect(parsed).toEqual({
      skipped: true,
      reason: null,
    });
    expect(turnContext.skipFlag).toBe(true);
  });

  test("uses exact D128 description string", () => {
    const tool = createSkipTool();
    expect(tool.description).toBe(SKIP_TOOL_DESCRIPTION);
  });
});

describe("post-turn fallback suppression", () => {
  test("skipFlag true suppresses fallback emission", () => {
    expect(shouldSuppressFallbackEmission({ skipFlag: true })).toBe(true);
    expect(shouldEmitFallbackAssistantText({ skipFlag: true })).toBe(false);
  });

  test("skipFlag false or undefined allows fallback emission", () => {
    expect(shouldSuppressFallbackEmission({ skipFlag: false })).toBe(false);
    expect(shouldSuppressFallbackEmission({})).toBe(false);
    expect(shouldEmitFallbackAssistantText({})).toBe(true);
  });

  test("skipFlag true with replyAlreadySent still suppresses fallback only", () => {
    expect(
      shouldSuppressFallbackEmission({
        skipFlag: true,
        replyAlreadySent: true,
      }),
    ).toBe(true);
    expect(
      shouldEmitFallbackAssistantText({
        skipFlag: true,
        replyAlreadySent: true,
      }),
    ).toBe(false);
  });

  test("replyAlreadySent without skip does not suppress fallback", () => {
    expect(
      shouldSuppressFallbackEmission({
        replyAlreadySent: true,
      }),
    ).toBe(false);
    expect(
      shouldEmitFallbackAssistantText({
        replyAlreadySent: true,
      }),
    ).toBe(true);
  });
});

const SOURCE_AGENT_ID = "agent-genie";
const PEER_AGENT_ID = "agent-alepo";
const SOURCE_HANDLE = "genie";
const PEER_HANDLE = "alepo";

function roster(...extras: RoomParticipant[]): RoomParticipant[] {
  return [
    { actorId: "actor-owner", kind: "user", displayName: "Owner", roomRole: "admin" },
    { actorId: "actor-genie", kind: "agent", displayName: "Genie", handle: SOURCE_HANDLE, agentId: SOURCE_AGENT_ID, roomRole: "member" },
    { actorId: "actor-alepo", kind: "agent", displayName: "Alepo", handle: PEER_HANDLE, agentId: PEER_AGENT_ID, roomRole: "member" },
    ...extras,
  ];
}

function eligibleCtx(turnId: string) {
  return { turnId, agentId: SOURCE_AGENT_ID, roomRoster: roster() };
}

function keyFor(turnId: string): string {
  return turnContextKey(turnId, SOURCE_AGENT_ID);
}

describe("skip tool unified yield surface", () => {
  test("skip is the only model-facing yield tool (no redirect_to_agent registered)", () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog, { officeCliAvailable: () => false });
    expect(catalog.get("skip")).toBeDefined();
    expect(catalog.get("redirect_to_agent")).toBeUndefined();
    const names = catalog.getFiltered().entries.map((e) => e.name);
    expect(names).not.toContain("redirect_to_agent");
    expect(names).toContain("skip");
  });

  test("description covers both targetless and target-bearing forms", () => {
    expect(SKIP_TOOL_DESCRIPTION).toContain("target_handle");
    expect(SKIP_TOOL_DESCRIPTION).toContain("ordinary silence");
    expect(SKIP_TOOL_DESCRIPTION).toContain("hand-off");
    expect(SKIP_TOOL_DESCRIPTION).toContain("server validates the target");
  });

  test("schema accepts target_handle + optional reason", () => {
    expect(skipToolSchema.parse({ target_handle: "alepo" })).toEqual({ target_handle: "alepo" });
    expect(skipToolSchema.parse({ target_handle: "alepo", reason: "not me" })).toEqual({ target_handle: "alepo", reason: "not me" });
  });

  test("schema enforces the target_handle length without capping reason", () => {
    const longHandle = "a".repeat(MAX_REDIRECT_TARGET_HANDLE_LENGTH + 1);
    expect(() => skipToolSchema.parse({ target_handle: longHandle })).toThrow();
    const longReason = "r".repeat(281);
    expect(skipToolSchema.parse({ target_handle: "alepo", reason: longReason })).toEqual({
      target_handle: "alepo",
      reason: longReason,
    });
  });

  test("max handle length is the Phase 0 contract bound (64)", () => {
    expect(MAX_REDIRECT_TARGET_HANDLE_LENGTH).toBe(64);
  });
});

describe("normalizeRedirectTargetHandle", () => {
  test("trims leading/trailing whitespace and accepts bare slug", () => {
    expect(normalizeRedirectTargetHandle("  alepo  ")).toEqual({ ok: true, handle: "alepo" });
  });
  test("rejects empty after trim", () => {
    expect(normalizeRedirectTargetHandle("   ")).toEqual({ ok: false });
    expect(normalizeRedirectTargetHandle("")).toEqual({ ok: false });
  });
  test("rejects @ prefix", () => {
    expect(normalizeRedirectTargetHandle("@alepo")).toEqual({ ok: false });
  });
  test("rejects UUID", () => {
    expect(normalizeRedirectTargetHandle("550e8400-e29b-41d4-a716-446655440000")).toEqual({ ok: false });
  });
  test("rejects display-name-like internal whitespace", () => {
    expect(normalizeRedirectTargetHandle("Genie Bot")).toEqual({ ok: false });
    expect(normalizeRedirectTargetHandle("ale po")).toEqual({ ok: false });
  });
  test("rejects over-length handle", () => {
    expect(normalizeRedirectTargetHandle("a".repeat(MAX_REDIRECT_TARGET_HANDLE_LENGTH + 1))).toEqual({ ok: false });
  });
  test("accepts max-length handle", () => {
    const handle = "a".repeat(MAX_REDIRECT_TARGET_HANDLE_LENGTH);
    expect(normalizeRedirectTargetHandle(handle)).toEqual({ ok: true, handle });
  });
  test("is case-sensitive (no lowercasing)", () => {
    expect(normalizeRedirectTargetHandle("Alepo")).toEqual({ ok: true, handle: "Alepo" });
  });
  test("rejects non-string", () => {
    expect(normalizeRedirectTargetHandle(undefined)).toEqual({ ok: false });
    expect(normalizeRedirectTargetHandle(123)).toEqual({ ok: false });
  });
});

describe("resolveSourceHandle", () => {
  test("resolves the source handle from agentId + roomRoster", () => {
    expect(resolveSourceHandle(eligibleCtx("x"))).toBe(SOURCE_HANDLE);
  });
  test("returns undefined when agentId is missing", () => {
    expect(resolveSourceHandle({ turnId: "x", roomRoster: roster() })).toBeUndefined();
  });
  test("returns undefined when roster is empty", () => {
    expect(resolveSourceHandle({ turnId: "x", agentId: SOURCE_AGENT_ID, roomRoster: [] })).toBeUndefined();
  });
  test("returns undefined when source agent not in roster", () => {
    expect(resolveSourceHandle({ turnId: "x", agentId: "agent-unknown", roomRoster: roster() })).toBeUndefined();
  });
});

describe("skip with target_handle — one-hop redirect recorder", () => {
  test("records a request and returns structured JSON without echoing the reason", async () => {
    const tool = createSkipTool(eligibleCtx("turn-tool-1"));
    const raw: unknown = await tool.invoke({ target_handle: "alepo", reason: "internal note" });
    const parsed = JSON.parse(String(raw)) as { recorded: boolean; target_handle?: string };
    expect(parsed).toEqual({ recorded: true, target_handle: "alepo" });
    expect(JSON.stringify(parsed)).not.toContain("internal note");
    expect(getAgentTurnContextByKey(keyFor("turn-tool-1"))?.skipFlag).toBe(true);
    expect(getAgentTurnContextByKey(keyFor("turn-tool-1"))?.redirectRequest?.targetHandle).toBe("alepo");
  });

  test("preserves a redirect reason longer than 280 characters in the recorded request", async () => {
    const longReason = `handoff rationale: ${"r".repeat(300)} END-OF-REASON`;
    const tool = createSkipTool(eligibleCtx("turn-long-reason"));

    await tool.invoke({ target_handle: "alepo", reason: longReason });

    expect(getAgentTurnContextByKey(keyFor("turn-long-reason"))?.redirectRequest).toMatchObject({
      targetHandle: "alepo",
      reason: longReason,
    });
  });

  test("target-bearing skip sets skipFlag via the recorder on acceptance", async () => {
    const tool = createSkipTool({ turnId: "turn-skipflag", agentId: SOURCE_AGENT_ID, roomRoster: roster() });
    await tool.invoke({ target_handle: PEER_HANDLE });
    expect(getAgentTurnContextByKey(keyFor("turn-skipflag"))?.skipFlag).toBe(true);
    expect(getAgentTurnContextByKey(keyFor("turn-skipflag"))?.redirectRequest?.targetHandle).toBe(PEER_HANDLE);
  });

  test("rejects self-target via roster prevalidation and does not set skipFlag", async () => {
    const tool = createSkipTool(eligibleCtx("turn-self-tool"));
    const raw: unknown = await tool.invoke({ target_handle: SOURCE_HANDLE });
    const parsed = JSON.parse(String(raw)) as { recorded: boolean; reason?: string };
    expect(parsed).toEqual({ recorded: false, reason: "self_target" });
    expect(getAgentTurnContextByKey(keyFor("turn-self-tool"))?.redirectRequest).toBeUndefined();
    expect(getAgentTurnContextByKey(keyFor("turn-self-tool"))?.skipFlag).toBeUndefined();
  });

  test("rejects invalid target shape (@-prefixed)", async () => {
    const tool = createSkipTool(eligibleCtx("turn-at-tool"));
    const raw: unknown = await tool.invoke({ target_handle: "@alepo" });
    expect(JSON.parse(String(raw))).toEqual({ recorded: false, reason: "invalid_target" });
  });

  test("rejects invalid target shape (UUID)", async () => {
    const tool = createSkipTool(eligibleCtx("turn-uuid-tool"));
    const raw: unknown = await tool.invoke({ target_handle: "550e8400-e29b-41d4-a716-446655440000" });
    expect(JSON.parse(String(raw))).toEqual({ recorded: false, reason: "invalid_target" });
  });

  test("rejects duplicate without replacing the first request", async () => {
    const tool = createSkipTool(eligibleCtx("turn-dup-tool"));
    await tool.invoke({ target_handle: "alepo" });
    const raw: unknown = await tool.invoke({ target_handle: "other" });
    expect(JSON.parse(String(raw))).toEqual({ recorded: false, reason: "duplicate" });
    expect(getAgentTurnContextByKey(keyFor("turn-dup-tool"))?.redirectRequest?.targetHandle).toBe("alepo");
  });

  test("rejects after visible output", async () => {
    const tool = createSkipTool(eligibleCtx("turn-vo-tool"));
    getOrCreateAgentTurnContextByKey(keyFor("turn-vo-tool")).assistantVisibleOutput = true;
    const raw: unknown = await tool.invoke({ target_handle: "alepo" });
    expect(JSON.parse(String(raw))).toEqual({ recorded: false, reason: "visible_output" });
  });

  test("recordRedirectRequest returns invalid_target when turnId is missing", () => {
    const r = recordRedirectRequest(
      { target_handle: "alepo" },
      { agentId: SOURCE_AGENT_ID, roomRoster: roster() },
    );
    expect(r).toEqual({ recorded: false, reason: "invalid_target" });
  });

  test("targetless skip does not touch redirect state", async () => {
    const tool = createSkipTool(eligibleCtx("turn-targetless"));
    const raw: unknown = await tool.invoke({ reason: "banter" });
    const parsed = JSON.parse(String(raw)) as SkipToolResult;
    expect(parsed).toEqual({ skipped: true, reason: "banter" });
    expect(getAgentTurnContextByKey(keyFor("turn-targetless"))?.redirectRequest).toBeUndefined();
    expect(getAgentTurnContextByKey(keyFor("turn-targetless"))?.skipFlag).toBe(true);
  });
});

describe("D421 Phase 4.2 — per-agent execution context isolation", () => {
  const HUMAN_TURN = "turn-group-1";
  const GENIE_KEY = turnContextKey(HUMAN_TURN, SOURCE_AGENT_ID);
  const ALEPO_KEY = turnContextKey(HUMAN_TURN, PEER_AGENT_ID);

  test("two agents sharing one human turn get isolated skip slots", async () => {
    const skipGenie = createSkipTool({
      turnId: HUMAN_TURN,
      agentId: SOURCE_AGENT_ID,
      turnContext: getOrCreateAgentTurnContextByKey(GENIE_KEY),
    });
    await skipGenie.invoke({ reason: "not me" });
    expect(getAgentTurnContextByKey(GENIE_KEY)?.skipFlag).toBe(true);
    expect(getAgentTurnContextByKey(ALEPO_KEY)?.skipFlag).toBeUndefined();
  });

  test("two agents sharing one human turn get isolated redirect slots", async () => {
    const genieTool = createSkipTool({ turnId: HUMAN_TURN, agentId: SOURCE_AGENT_ID, roomRoster: roster() });
    const alepoTool = createSkipTool({ turnId: HUMAN_TURN, agentId: PEER_AGENT_ID, roomRoster: roster() });
    const gRaw: unknown = await genieTool.invoke({ target_handle: PEER_HANDLE });
    const aRaw: unknown = await alepoTool.invoke({ target_handle: SOURCE_HANDLE });
    expect(JSON.parse(String(gRaw))).toEqual({ recorded: true, target_handle: PEER_HANDLE });
    expect(JSON.parse(String(aRaw))).toEqual({ recorded: true, target_handle: SOURCE_HANDLE });
    expect(getAgentTurnContextByKey(GENIE_KEY)?.redirectRequest?.targetHandle).toBe(PEER_HANDLE);
    expect(getAgentTurnContextByKey(ALEPO_KEY)?.redirectRequest?.targetHandle).toBe(SOURCE_HANDLE);
  });

  test("visible output on one agent's slot does not block redirect on the other", async () => {
    getOrCreateAgentTurnContextByKey(GENIE_KEY).assistantVisibleOutput = true;
    const genieTool = createSkipTool({ turnId: HUMAN_TURN, agentId: SOURCE_AGENT_ID, roomRoster: roster() });
    const alepoTool = createSkipTool({ turnId: HUMAN_TURN, agentId: PEER_AGENT_ID, roomRoster: roster() });
    const gRaw: unknown = await genieTool.invoke({ target_handle: PEER_HANDLE });
    const aRaw: unknown = await alepoTool.invoke({ target_handle: SOURCE_HANDLE });
    expect(JSON.parse(String(gRaw))).toEqual({ recorded: false, reason: "visible_output" });
    expect(JSON.parse(String(aRaw))).toEqual({ recorded: true, target_handle: SOURCE_HANDLE });
  });

  test("consume-once is per-agent", async () => {
    const genieTool = createSkipTool({ turnId: HUMAN_TURN, agentId: SOURCE_AGENT_ID, roomRoster: roster() });
    const alepoTool = createSkipTool({ turnId: HUMAN_TURN, agentId: PEER_AGENT_ID, roomRoster: roster() });
    await genieTool.invoke({ target_handle: PEER_HANDLE });
    await alepoTool.invoke({ target_handle: SOURCE_HANDLE });
    const genieReq = consumeAgentRedirectRequestByKey(GENIE_KEY);
    expect(genieReq?.targetHandle).toBe(PEER_HANDLE);
    expect(peekAgentRedirectRequestByKey(ALEPO_KEY)?.targetHandle).toBe(SOURCE_HANDLE);
    expect(consumeAgentRedirectRequestByKey(GENIE_KEY)).toBeUndefined();
  });

  test("depth seeding is per-agent", () => {
    seedAgentRedirectDepthByKey(GENIE_KEY);
    expect(getAgentTurnContextByKey(GENIE_KEY)?.redirectDepth).toBe(1);
    expect(getAgentTurnContextByKey(ALEPO_KEY)?.redirectDepth).toBeUndefined();
  });
});

describe("tryRecordAgentRedirect — CAS gate (recorder unchanged)", () => {
  test("first request is accepted at depth 1 and sets skipFlag", () => {
    const r = tryRecordAgentRedirect("turn-1", { targetHandle: "alepo" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.request.targetHandle).toBe("alepo");
      expect(r.request.depth).toBe(1);
    }
    const ctx = getAgentTurnContext("turn-1");
    expect(ctx?.redirectDepth).toBe(1);
    expect(ctx?.skipFlag).toBe(true);
  });
  test("accepted request is immutable (frozen)", () => {
    const r = tryRecordAgentRedirect("turn-imm", { targetHandle: "alepo", reason: "x" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.isFrozen(r.request)).toBe(true);
  });
  test("duplicate cannot replace the first request", () => {
    tryRecordAgentRedirect("turn-2", { targetHandle: "alepo" });
    expect(tryRecordAgentRedirect("turn-2", { targetHandle: "other" })).toEqual({ ok: false, reason: "duplicate" });
  });
  test("visible-output rejection", () => {
    getOrCreateAgentTurnContext("turn-vo").assistantVisibleOutput = true;
    expect(tryRecordAgentRedirect("turn-vo", { targetHandle: "alepo" })).toEqual({ ok: false, reason: "visible_output" });
  });
  test("depth-1 rejection after seeding", () => {
    seedAgentRedirectDepth("turn-target");
    expect(tryRecordAgentRedirect("turn-target", { targetHandle: "alepo" })).toEqual({ ok: false, reason: "duplicate" });
  });
  test("self-target rejection when source handle is supplied", () => {
    expect(tryRecordAgentRedirect("turn-self", { targetHandle: SOURCE_HANDLE }, { sourceHandle: SOURCE_HANDLE })).toEqual({ ok: false, reason: "self_target" });
  });
  test("peek returns a defensive copy without consuming", () => {
    tryRecordAgentRedirect("turn-peek", { targetHandle: "alepo", reason: "why" });
    const a = peekAgentRedirectRequest("turn-peek");
    const b = peekAgentRedirectRequest("turn-peek");
    expect(a).toEqual({ targetHandle: "alepo", reason: "why", depth: 1 });
    expect(b).toEqual(a);
  });
  test("consume returns a defensive copy and cannot be consumed twice", () => {
    tryRecordAgentRedirect("turn-consume", { targetHandle: "alepo" });
    expect(consumeAgentRedirectRequest("turn-consume")).toEqual({ targetHandle: "alepo", depth: 1 });
    expect(consumeAgentRedirectRequest("turn-consume")).toBeUndefined();
  });
  test("clearAgentTurnContext clears all redirect state", () => {
    tryRecordAgentRedirect("turn-clear", { targetHandle: "alepo" });
    clearAgentTurnContext("turn-clear");
    expect(getAgentTurnContext("turn-clear")).toBeUndefined();
    expect(consumeAgentRedirectRequest("turn-clear")).toBeUndefined();
  });
});

describe("skip prompt guidance", () => {
  test("merged skip prompt requires target-bearing skip for one intended peer", () => {
    expect(SKIP_TOOL_MULTI_HUMAN_PROMPT).toContain("target_handle");
    expect(SKIP_TOOL_MULTI_HUMAN_PROMPT).toContain("REQUIRED when exactly one eligible peer is clearly intended");
    expect(SKIP_TOOL_MULTI_HUMAN_PROMPT).toContain("only when there is no intended peer");
    expect(SKIP_TOOL_MULTI_HUMAN_PROMPT).toContain("bare slug");
    expect(SKIP_TOOL_MULTI_HUMAN_PROMPT).toContain("server validates the target");
  });

  test("buildSystemPrompt injects skip guidance and no redirect_to_agent guidance", () => {
    const tool = createSkipTool(eligibleCtx("turn-prompt"));
    const prompt = buildSystemPrompt({
      assistantName: "Genie",
      isGuest: false,
      tools: [tool as StructuredTool],
    });
    expect(prompt).toContain(SKIP_TOOL_MULTI_HUMAN_PROMPT.trim());
    expect(prompt).not.toContain("redirect_to_agent");
    expect(prompt).not.toContain("REDIRECT_TO_AGENT_PROMPT");
  });
});

describe("skip source guard — no forbidden imports / no redirect_to_agent alias", () => {
  const sourcePath = resolve(import.meta.dir, "../../../src/tools/skip.ts");

  test("source file is readable", () => {
    expect(() => readFileSync(sourcePath, "utf8")).not.toThrow();
  });

  test("imports no DB / runtime / server / focus / bus modules", () => {
    const src = readFileSync(sourcePath, "utf8");
    const importSources = src
      .split("\n")
      .filter((l) => l.match(/^\s*import\b/) || l.startsWith("import "))
      .map((l) => l.match(/from\s+"([^"]+)"/)?.[1] ?? "")
      .filter(Boolean);
    const forbiddenModuleSubstrings = [
      "@nautilo/db",
      "@nautilo/runtime",
      "@nautilo/server",
      "@nautilo/trust/focus",
      "focus/writer",
      "focus/read",
      "runtime-hooks",
      "job-manager",
      "job",
      "dispatch",
    ];
    for (const mod of importSources) {
      for (const forbidden of forbiddenModuleSubstrings) {
        expect(mod).not.toContain(forbidden);
      }
    }
  });

  test("body emits no events / focus writes / job creation", () => {
    const src = readFileSync(sourcePath, "utf8");
    const body = src.replace(/\/\*\*[\s\S]*?\*\//g, "");
    const forbiddenCalls = [
      "emitAgentEvent",
      "emit(",
      "createForegroundJob",
      "openOrExtendFocus",
      "clearFocus",
      "loadRoomRoster",
      "setJobManager",
      "setBackgroundJobCreator",
    ];
    for (const token of forbiddenCalls) {
      expect(body).not.toContain(token);
    }
  });

  test("imports only the allowed modules", () => {
    const src = readFileSync(sourcePath, "utf8");
    const importSources = src
      .split("\n")
      .filter((l) => l.startsWith("import ") || l.match(/^\s*import /))
      .map((l) => l.match(/from\s+"([^"]+)"/)?.[1] ?? "")
      .filter(Boolean);
    for (const srcMod of importSources) {
      expect(
        [
          "@langchain/core/tools",
          "zod",
          "@nautilo/catalog",
          "@nautilo/trust",
          "../runtime/turn-context",
        ].includes(srcMod),
      ).toBe(true);
    }
  });

  test("does not export a redirect_to_agent tool or alias", () => {
    const src = readFileSync(sourcePath, "utf8");
    expect(src).not.toContain("redirect_to_agent");
    expect(src).not.toContain("createRedirectToAgentTool");
    expect(src).not.toContain("REDIRECT_TO_AGENT_TOOL_DESCRIPTION");
  });
});

describe("skip catalog metadata", () => {
  test("skip is registered as low-impact core exposure", () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog, { officeCliAvailable: () => false });
    const entry = catalog.get("skip");
    expect(entry).toBeDefined();
    expect(entry!.impact).toBe("low");
    expect(entry!.exposure).toBe("core");
    expect(entry!.tags).toContain("redirect");
    expect(entry!.tags).toContain("handoff");
  });
});
