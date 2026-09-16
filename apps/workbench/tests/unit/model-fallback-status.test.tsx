/**
 * D264 Phase 1 — `model.fallback` must not contaminate assistant prose.
 */
import { describe, expect, test } from "bun:test";
import {
  formatModelFallbackStatusLine,
  modelFallbackAssistantStreamEffects,
  modelFallbackStatusFromEvent,
} from "../../src/adapters/nautilo-runtime";

const SAMPLE_EVENT = {
  from: "anthropic:claude-sonnet-4-6",
  to: "anthropic:claude-opus-4-7",
  reason: "timeout" as const,
  turnId: "turn-abc",
};

describe("model.fallback status (D264)", () => {
  test("formatModelFallbackStatusLine uses catalog IDs and plain text (no markdown italics)", () => {
    const line = formatModelFallbackStatusLine(
      SAMPLE_EVENT.from,
      SAMPLE_EVENT.to,
      SAMPLE_EVENT.reason,
    );
    expect(line).toBe(
      "anthropic:claude-sonnet-4-6 timed out — trying anthropic:claude-opus-4-7",
    );
    expect(line).not.toMatch(/^_|_$/);
    expect(line).not.toContain("\n\n");
  });

  test("modelFallbackAssistantStreamEffects does not mutate stream map or assistant bubbles", () => {
    const streams = new Map<string, { bubbleId: string; acc: string }>([
      ["turn:t|a", { bubbleId: "asst-stream-1", acc: "On it..." }],
    ]);
    const result = modelFallbackAssistantStreamEffects({
      streams,
      event: SAMPLE_EVENT,
    });

    expect(result.streams).toBe(streams);
    expect(result.streams.get("turn:t|a")?.acc).toBe("On it...");
    expect(result.createsAssistantMessage).toBe(false);
    expect(result.updatesLastAssistant).toBe(false);
    expect(result.status.line).toBe(formatModelFallbackStatusLine(
      SAMPLE_EVENT.from,
      SAMPLE_EVENT.to,
      SAMPLE_EVENT.reason,
    ));
    expect(result.status.line).not.toContain("On it...");
  });

  test("mid-stream acc is unchanged when only status is derived from the event", () => {
    const streams = new Map<string, { bubbleId: string; acc: string }>([
      ["k", { bubbleId: "asst-2", acc: "Partial answer before hop." }],
    ]);
    const { streams: out, status } = modelFallbackAssistantStreamEffects({
      streams,
      event: { ...SAMPLE_EVENT, reason: "provider_unavailable" },
    });
    expect(out.get("k")?.acc).toBe("Partial answer before hop.");
    expect(status.reason).toBe("provider_unavailable");
    expect(out.get("k")?.acc).not.toContain(status.line);
  });

  test("modelFallbackStatusFromEvent carries turnId for correlation without assistant content", () => {
    const status = modelFallbackStatusFromEvent(SAMPLE_EVENT);
    expect(status.turnId).toBe("turn-abc");
    expect(status.from).toBe(SAMPLE_EVENT.from);
    expect(status.to).toBe(SAMPLE_EVENT.to);
  });
});
