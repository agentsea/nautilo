import { describe, expect, test } from "bun:test";
import {
  CLAUDE_RELAY_MAX_FRAME_BYTES,
  CLAUDE_RELAY_PROTOCOL_VERSION,
  parseRelayClaudeFactMessage,
} from "../../src/index";

describe("D452 Claude Agent SDK relay facts", () => {
  test("accepts the exact closed account, catalog, and degradation facts", () => {
    const account = {
      type: "relay:claude-fact",
      version: CLAUDE_RELAY_PROTOCOL_VERSION,
      eventSequence: 1,
      fact: { kind: "account", account: { state: "connected", apiProvider: "firstParty", email: "writer@example.test", subscriptionType: "max" } },
    } as const;
    expect(parseRelayClaudeFactMessage(account).ok).toBe(true);
    expect(parseRelayClaudeFactMessage({
      type: "relay:claude-fact",
      version: CLAUDE_RELAY_PROTOCOL_VERSION,
      eventSequence: 2,
      fact: { kind: "model_catalog", complete: true, models: [{ id: "claude-fable-5", displayName: "Fable 5", description: "Frontier", supportsEffort: true }] },
    }).ok).toBe(true);
    expect(parseRelayClaudeFactMessage({
      type: "relay:claude-fact",
      version: CLAUDE_RELAY_PROTOCOL_VERSION,
      eventSequence: 3,
      fact: { kind: "model_degraded", originalModel: "claude-fable-5", servingModel: "claude-sonnet-5", scope: "subagent", outcome: "fallback" },
    }).ok).toBe(true);
    expect(parseRelayClaudeFactMessage({
      type: "relay:claude-fact",
      version: CLAUDE_RELAY_PROTOCOL_VERSION,
      eventSequence: 4,
      fact: { kind: "runtime", state: "ready", version: "2.1.39", executionQualified: false },
    }).ok).toBe(true);
  });

  test("rejects provider/session/raw-content smuggling and incomplete fallback facts", () => {
    const frame = {
      type: "relay:claude-fact",
      version: CLAUDE_RELAY_PROTOCOL_VERSION,
      eventSequence: 1,
      fact: { kind: "terminal", outcome: "completed" },
    } as const;
    expect(parseRelayClaudeFactMessage({ ...frame, sessionId: "private-session" }).ok).toBe(false);
    expect(parseRelayClaudeFactMessage({
      ...frame,
      fact: { kind: "tool_activity", state: "requested", toolName: "Bash", scope: "root", input: "private command" },
    }).ok).toBe(false);
    expect(parseRelayClaudeFactMessage({
      ...frame,
      fact: { kind: "model_degraded", originalModel: "claude-fable-5", scope: "root", outcome: "fallback" },
    }).ok).toBe(false);
    expect(parseRelayClaudeFactMessage({ ...frame, fact: { kind: "account", account: { state: "connected", apiProvider: "not-a-provider" } } }).ok).toBe(false);
    expect(parseRelayClaudeFactMessage({ ...frame, fact: { kind: "runtime", state: "ready", version: "2.1.39" } }).ok).toBe(false);
  });

  test("enforces the frame bound before accepting JSON-shaped data", () => {
    const oversized = {
      type: "relay:claude-fact",
      version: CLAUDE_RELAY_PROTOCOL_VERSION,
      eventSequence: 1,
      fact: { kind: "model_catalog", complete: true, models: [{ id: "claude-fable-5", displayName: "Fable 5", description: "x".repeat(CLAUDE_RELAY_MAX_FRAME_BYTES) }] },
    };
    expect(parseRelayClaudeFactMessage(oversized)).toEqual({ ok: false, error: "CLAUDE_FRAME_TOO_LARGE" });
  });
});
