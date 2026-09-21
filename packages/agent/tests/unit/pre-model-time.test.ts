import { beforeAll, describe, expect, test } from "bun:test";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ToolCatalog, initToolCatalog } from "@nautilo/catalog";
import {
  buildInitiatingClientSurfaceGuidance,
  buildTimeContextBlock,
} from "../../src/prompts/templates";
import { preModelNode } from "../../src/nodes/pre-model";
import { registerAllTools } from "../../src/tools/register-all";
import type { NautiloState } from "../../src/agent/state";
import { MAX_SUBAGENT_DEPTH } from "../../src/agent/state";
import { runWithInitiatingClientSurface } from "../../src/runtime/initiating-client-surface-context";

beforeAll(() => {
  const catalog = new ToolCatalog();
  registerAllTools(catalog);
  initToolCatalog(catalog);
});

function makeState(overrides: Partial<NautiloState> = {}): NautiloState {
  return {
    messages: [new HumanMessage("hello")],
    threadId: 0,
    langgraphThreadId: "",
    model: null,
    userId: "owner-1",
    personaId: "owner",
    voiceMode: false,
    source: "tui",
    assistantName: "Genie",
    soulFile: "",
    memoryBrief: "",
    memoryDelta: "",
    currentThreadId: "",
    preparedMessages: [],
    toolNames: [],
    approvedToolCalls: [],
    pendingApproval: [],
    memoryAccessEnvelope: null,
    actorRole: "owner",
    agentId: "agent-genie",
    roomId: "",
    roomRoster: [],
    approvalDenied: false,
    turnId: "",
    explicitlySelected: false,
    currentFolder: "",
    currentFolderRelayId: "",
    workspacePath: "",
    activeMiniApp: null,
    artifactRefs: [],
    userTimezone: "UTC",
    previousUserMessageAt: null,
    securityAuditClientMeta: null,
    toolWhitelist: undefined,
    activatedToolNames: [],
    relayCapabilities: undefined,
    subagentDepth: 0,
    subagentMaxDepth: MAX_SUBAGENT_DEPTH,
    suppressToolLifecycleEvents: false,
    subagentRun: false,
    taskRun: false,
    skills: [],
    engagedSkillNames: [],
    awaitResponse: false,
    awaitRoomId: "",
    awaitFromUserIds: [],
    awaitTaskId: "",
    awaitTaskRunId: "",
    awaitOwnerId: "",
    ...overrides,
  };
}

function systemMessageOf(patch: Partial<NautiloState>): SystemMessage {
  const first = patch.preparedMessages?.[0];
  if (!(first instanceof SystemMessage)) {
    throw new Error(`expected a leading SystemMessage, got ${first?.constructor.name ?? "undefined"}`);
  }
  return first as unknown as SystemMessage;
}

describe("pre-model time block contract", () => {
  test("Asia/Tokyo state renders both the IANA name and UTC+09:00", () => {
    const block = buildTimeContextBlock({
      nowMs: Date.parse("2026-05-09T15:58:00Z"),
      userTimezone: "Asia/Tokyo",
      previousUserMessageAt: null,
    });
    expect(block).toContain("Asia/Tokyo");
    expect(block).toContain("UTC+09:00");
  });

  test("empty-string tz falls back to UTC at the call site (mirrors pre-model `state.userTimezone || 'UTC'`)", () => {
    const userTimezone = "";
    const tz = userTimezone || "UTC";
    const block = buildTimeContextBlock({
      nowMs: Date.parse("2026-05-09T15:58:00Z"),
      userTimezone: tz,
      previousUserMessageAt: null,
    });
    expect(block).toContain("(UTC, UTC+00:00)");
  });

  test("preserves UTC milliseconds and keeps the current elapsed bucket boundaries", () => {
    const nowMs = Date.parse("2026-05-09T15:58:00.123Z");
    const justNow = buildTimeContextBlock({
      nowMs,
      userTimezone: "UTC",
      previousUserMessageAt: new Date(nowMs - 59_999).toISOString(),
    });
    const oneMinute = buildTimeContextBlock({
      nowMs,
      userTimezone: "UTC",
      previousUserMessageAt: new Date(nowMs - 60_000).toISOString(),
    });

    expect(justNow).toContain("UTC: 2026-05-09T15:58:00.123Z");
    expect(justNow).toContain("Last user message in this room: just now ago");
    expect(oneMinute).toContain("Last user message in this room: 1 minutes ago");
  });

  test("assembled Anthropic prompt puts initiating-client guidance before the volatile time block", async () => {
    const fixedNowMs = Date.parse("2026-05-09T15:58:00.123Z");
    const originalDateNow = Date.now;
    Date.now = () => fixedNowMs;
    try {
      const patch = await runWithInitiatingClientSurface("mobile.web", () =>
        preModelNode(makeState({
          model: "anthropic:claude-sonnet-4-6",
          previousUserMessageAt: new Date(fixedNowMs - 60_000).toISOString(),
        })),
      );
      const system = systemMessageOf(patch);
      expect(Array.isArray(system.content)).toBe(true);
      if (!Array.isArray(system.content)) throw new Error("expected Anthropic system content blocks");

      const cachedStable = system.content[0];
      const volatileSuffix = system.content[1];
      expect(cachedStable).toMatchObject({ type: "text", cache_control: { type: "ephemeral" } });
      const cachedText = (cachedStable as { text?: unknown }).text;
      expect(typeof cachedText).toBe("string");
      // Tool descriptions may themselves refer to the `## Current time`
      // contract. The per-turn timestamp is the actual volatile byte.
      expect(cachedText).not.toContain("UTC: 2026-05-09T15:58:00.123Z");
      expect(cachedText).not.toContain("Current client: Mobile Web");
      expect(volatileSuffix).toMatchObject({
        type: "text",
        text: `${buildInitiatingClientSurfaceGuidance("mobile.web")}${buildTimeContextBlock({
          nowMs: fixedNowMs,
          userTimezone: "UTC",
          previousUserMessageAt: new Date(fixedNowMs - 60_000).toISOString(),
        })}`,
      });
    } finally {
      Date.now = originalDateNow;
    }
  });

  test("reuses one honest time reference through tool loops in the same identified turn", async () => {
    const firstNow = Date.parse("2026-05-09T15:58:00.123Z");
    const secondNow = firstNow + 45_000;
    const originalDateNow = Date.now;
    Date.now = () => firstNow;
    try {
      const first = await preModelNode(makeState({ turnId: "turn-1" }));
      Date.now = () => secondNow;
      if (!first.promptTimeReference) throw new Error("expected identified-turn time reference");
      const second = await preModelNode(makeState({
        turnId: "turn-1",
        promptTimeReference: first.promptTimeReference,
      }));

      expect(second.promptTimeReference).toEqual({ turnId: "turn-1", nowMs: firstNow });
      expect(systemMessageOf(second).content).toBe(systemMessageOf(first).content);
      expect(systemMessageOf(second).content).toContain(
        "Time reference: captured at the start of this turn; it does not advance during tool calls.",
      );
    } finally {
      Date.now = originalDateNow;
    }
  });

  test("refreshes the time reference for a new identified turn", async () => {
    const firstNow = Date.parse("2026-05-09T15:58:00.123Z");
    const secondNow = firstNow + 45_000;
    const originalDateNow = Date.now;
    Date.now = () => secondNow;
    try {
      const patch = await preModelNode(makeState({
        turnId: "turn-2",
        promptTimeReference: { turnId: "turn-1", nowMs: firstNow },
      }));
      expect(patch.promptTimeReference).toEqual({ turnId: "turn-2", nowMs: secondNow });
      expect(systemMessageOf(patch).content).toContain("UTC: 2026-05-09T15:58:45.123Z");
    } finally {
      Date.now = originalDateNow;
    }
  });

  test("an unidentified turn neither reuses nor retains a stale reference", async () => {
    const now = Date.parse("2026-05-09T15:58:45.123Z");
    const originalDateNow = Date.now;
    Date.now = () => now;
    try {
      const patch = await preModelNode(makeState({
        turnId: "",
        promptTimeReference: { turnId: "turn-1", nowMs: now - 45_000 },
      }));
      expect(patch.promptTimeReference).toBeNull();
      expect(systemMessageOf(patch).content).toContain("UTC: 2026-05-09T15:58:45.123Z");
      expect(systemMessageOf(patch).content).not.toContain("Time reference: captured at the start");
    } finally {
      Date.now = originalDateNow;
    }
  });

  test("guest prompts omit owner time context and retain no reference", async () => {
    const patch = await preModelNode(makeState({
      actorRole: "guest",
      turnId: "guest-turn",
      promptTimeReference: { turnId: "older", nowMs: 1 },
    }));
    expect(patch.promptTimeReference).toBeNull();
    expect(systemMessageOf(patch).content).not.toContain("UTC: ");
    expect(systemMessageOf(patch).content).not.toContain("Time reference: captured at the start");
  });
});
