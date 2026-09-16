import { describe, expect, test } from "bun:test";
import type { RelayCodexEventMessage } from "@nautilo/relay";
import { HARNESS_MAX_TEXT_BYTES } from "@nautilo/runtime";
import { CodexTurnProjector } from "../../src/codex/turn-projector";

const scope = {
  relayId: "relay", relaySessionId: "relay-session", desktopSessionId: "desktop",
  pairingGenerationRef: "pairing", selectedProtocolVersion: 8, capabilityRevision: 1,
  profileHandle: "profile", profileGeneration: 2, accountGeneration: 3,
  runtimeGeneration: 4, childGeneration: 5,
  bindingId: "binding", bindingGeneration: 6, taskId: "task", jobId: "job",
  threadId: "thread",
  workspace: {
    workspaceRef: "workspace", revision: 1, fingerprint: "fingerprint",
    issuedAt: "2026-07-29T00:00:00.000Z", expiresAt: "2026-07-29T01:00:00.000Z",
  },
  turnId: "turn", eventId: "event",
} as const;

function projector() {
  return new CodexTurnProjector({
    bindingId: "binding", bindingGeneration: "6", taskId: "task", roomId: "room",
  });
}

function event(
  input: RelayCodexEventMessage["event"],
  overrides: Record<string, unknown> = {},
  eventSequence = 1,
): RelayCodexEventMessage {
  return {
    type: "relay:codex-event",
    scope: { ...scope, ...overrides },
    eventSequence,
    event: input,
  } as RelayCodexEventMessage;
}

describe("CodexTurnProjector", () => {
  test("preserves upstream queued and started lifecycle as semantic progress", () => {
    const subject = projector();
    expect(subject.project(event({ kind: "turn_status", state: "queued" }))).toMatchObject([{
      kind: "progress",
      message: "Codex turn queued",
    }]);
    expect(subject.project(event({ kind: "turn_status", state: "running" }, {}, 2))).toMatchObject([{
      kind: "progress",
      message: "Codex turn started",
    }]);
    expect(subject.project(event({ kind: "turn_status", state: "completed" }, {}, 3))).toEqual([]);
  });

  test("keeps deltas ephemeral and lets the authoritative final item win", () => {
    const subject = projector();
    expect(subject.project(event({
      kind: "message_delta", text: "draft", sequence: 1,
    }, { itemId: "final" }))).toMatchObject([{
      kind: "output_delta", text: "draft", attribution: { vendorItemId: "final" },
    }]);
    expect(subject.project(event({
      kind: "assistant_item_completed", text: "corrected draft", phase: "final_answer", sequence: 2,
    }, { itemId: "final" }, 2))).toEqual([]);

    expect(subject.project(event({
      kind: "turn_completed",
      status: "completed",
      itemsView: "full",
      assistantItems: [
        { itemId: "commentary", text: "I inspected it.", phase: "commentary" },
        { itemId: "final", text: "The authoritative answer.", phase: "final_answer" },
      ],
    }, {}, 3))).toMatchObject([
      {
        kind: "assistant_completed",
        text: "The authoritative answer.",
        attribution: { vendorItemId: "final", vendorTurnId: "turn" },
      },
      { kind: "terminal", status: "completed" },
    ]);
  });

  test("falls back to the last non-empty assistant item and never fabricates failed output", () => {
    const fallback = projector();
    expect(fallback.project(event({
      kind: "turn_completed",
      status: "completed",
      itemsView: "full",
      assistantItems: [
        { itemId: "one", text: "first", phase: "commentary" },
        { itemId: "two", text: "last", phase: null },
      ],
    }))).toMatchObject([
      { kind: "assistant_completed", text: "last", attribution: { vendorItemId: "two" } },
      { kind: "terminal", status: "completed" },
    ]);

    const failed = projector();
    expect(failed.project(event({
      kind: "turn_completed", status: "failed", code: "CODEX_UPSTREAM_FAILURE",
      itemsView: "full",
      assistantItems: [{ itemId: "final", text: "must not persist", phase: "final_answer" }],
    }))).toEqual([expect.objectContaining({
      kind: "terminal", status: "failed", code: "upstream_failure",
    })]);
  });

  test("preserves item/completed output when turn/completed items are not loaded", () => {
    const subject = projector();
    expect(subject.project(event({
      kind: "assistant_item_completed",
      text: "BYTE-MAP-ITEMS-VIEW",
      phase: "final_answer",
      sequence: 1,
    }, { itemId: "final" }))).toEqual([]);

    expect(subject.project(event({
      kind: "turn_completed",
      status: "completed",
      itemsView: "notLoaded",
      assistantItems: [],
    }, {}, 2))).toMatchObject([
      {
        kind: "assistant_completed",
        text: "BYTE-MAP-ITEMS-VIEW",
        attribution: { vendorItemId: "final" },
      },
      { kind: "terminal", status: "completed" },
    ]);
  });

  test("deduplicates terminal completion and suppresses late mutation", () => {
    const subject = projector();
    const completed = event({
      kind: "turn_completed", status: "completed",
      itemsView: "full",
      assistantItems: [{ itemId: "final", text: "answer", phase: "final_answer" }],
    });
    expect(subject.project(completed)).toHaveLength(2);
    expect(subject.project(completed)).toEqual([]);
    expect(subject.project(event({
      kind: "message_delta", text: "late", sequence: 2,
    }, { itemId: "final" }, 2))).toEqual([]);
  });

  test("rejects a foreign binding without mutating projector state", () => {
    const subject = projector();
    expect(subject.project(event({
      kind: "turn_completed", status: "completed",
      itemsView: "full",
      assistantItems: [{ itemId: "foreign", text: "no", phase: "final_answer" }],
    }, { bindingId: "other" }))).toEqual([]);
    expect(subject.project(event({
      kind: "turn_completed", status: "failed", code: "CODEX_UPSTREAM_FAILURE",
      itemsView: "full",
      assistantItems: [],
    }))).toEqual([expect.objectContaining({ kind: "terminal", status: "failed" })]);
  });

  test("drops duplicate and regressing frames before they can mutate output", () => {
    const subject = projector();
    const delta = event({
      kind: "message_delta", text: "once", sequence: 10,
    }, { itemId: "final" }, 10);
    expect(subject.project(delta)).toMatchObject([{ kind: "output_delta", text: "once" }]);
    expect(subject.project(delta)).toEqual([]);

    expect(subject.project(event({
      kind: "assistant_item_completed",
      text: "stale",
      phase: "final_answer",
      sequence: 9,
    }, { itemId: "final" }, 9))).toEqual([]);

    expect(subject.project(event({
      kind: "assistant_item_completed",
      text: "authoritative",
      phase: "final_answer",
      sequence: 11,
    }, { itemId: "final" }, 11))).toEqual([]);
    expect(subject.project(event({
      kind: "turn_completed",
      status: "completed",
      itemsView: "notLoaded",
      assistantItems: [],
    }, {}, 12))).toMatchObject([
      { kind: "assistant_completed", text: "authoritative" },
      { kind: "terminal", status: "completed" },
    ]);
  });

  test("emits no durable assistant output for interrupted or empty completed turns", () => {
    const interrupted = projector();
    expect(interrupted.project(event({
      kind: "assistant_item_completed",
      text: "partial answer",
      phase: "final_answer",
      sequence: 1,
    }, { itemId: "partial" }, 1))).toEqual([]);
    expect(interrupted.project(event({
      kind: "turn_completed",
      status: "interrupted",
      itemsView: "notLoaded",
      assistantItems: [],
    }, {}, 2))).toEqual([expect.objectContaining({
      kind: "terminal", status: "interrupted", code: "user_stop",
    })]);

    const empty = projector();
    expect(empty.project(event({
      kind: "turn_completed",
      status: "completed",
      itemsView: "full",
      assistantItems: [],
    }))).toEqual([expect.objectContaining({ kind: "terminal", status: "completed" })]);
  });

  test("bounds UTF-8 without splitting a Unicode code point", () => {
    const subject = projector();
    const oversized = `${"a".repeat(HARNESS_MAX_TEXT_BYTES - 4)}💥💥`;
    const [projected] = subject.project(event({
      kind: "message_delta", text: oversized, sequence: 1,
    }, { itemId: "final" }));
    expect(projected?.kind).toBe("output_delta");
    if (projected?.kind !== "output_delta") throw new Error("expected output delta");
    expect(Buffer.byteLength(projected.text, "utf8")).toBeLessThanOrEqual(HARNESS_MAX_TEXT_BYTES);
    expect(projected.text.endsWith("...")).toBe(true);
    expect(projected.text.includes("\uFFFD")).toBe(false);
    expect(projected.text).not.toMatch(/[\uD800-\uDFFF]\.\.\.$/);
  });

  test("reconstructs a complete response beyond every single-frame text limit", () => {
    const subject = projector();
    const first = "a".repeat(48 * 1024);
    const second = `${"b".repeat(48 * 1024)} complete-tail`;

    subject.project(event({
      kind: "message_delta", text: first, sequence: 1,
    }, { itemId: "final", selectedProtocolVersion: 17 }, 1));
    subject.project(event({
      kind: "message_delta", text: second, sequence: 2,
    }, { itemId: "final", selectedProtocolVersion: 17 }, 2));
    subject.project(event({
      kind: "assistant_item_completed", text: null, phase: "final_answer", sequence: 3,
    }, { itemId: "final", selectedProtocolVersion: 17 }, 3));

    const completed = subject.project(event({
      kind: "turn_completed",
      status: "completed",
      itemsView: "full",
      assistantItems: [{ itemId: "final", text: null, phase: "final_answer" }],
    }, { selectedProtocolVersion: 17 }, 4));
    expect(completed[0]).toMatchObject({
      kind: "assistant_completed",
      text: `${first}${second}`,
    });
    expect(Buffer.byteLength((completed[0] as { text: string }).text, "utf8"))
      .toBeGreaterThan(HARNESS_MAX_TEXT_BYTES);
  });
});
