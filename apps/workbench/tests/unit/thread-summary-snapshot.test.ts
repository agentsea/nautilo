import { describe, expect, test } from "bun:test";
import type { ThreadMessageLike } from "@assistant-ui/react";
import type { ThreadSummaryChangedEvent } from "@nautilo/types";
import { applyThreadSummarySnapshot } from "../../src/adapters/thread-summary-snapshot";

function event(overrides: Partial<ThreadSummaryChangedEvent> = {}): ThreadSummaryChangedEvent {
  return {
    type: "thread.summary.changed",
    laneKey: "room:parent-room",
    anchorMessageId: 42,
    replyCount: 3,
    lastReplyAt: "2026-07-22T12:00:00.000Z",
    summaryRevision: 2,
    ...overrides,
  };
}

function message(
  id: string,
  metadata?: Record<string, unknown>,
): ThreadMessageLike {
  return {
    id,
    role: "user",
    content: [{ type: "text", text: id }],
    ...(metadata ? { metadata } : {}),
  };
}

describe("applyThreadSummarySnapshot (D426)", () => {
  test("applies the first snapshot when the anchor has no revision yet", () => {
    const messages = [message("42", { custom: { sourceUserId: "human-1" } })];

    const result = applyThreadSummarySnapshot(messages, event({ summaryRevision: 0 }));

    expect(result).not.toBe(messages);
    expect(result[0]!.metadata).toEqual({
      custom: {
        sourceUserId: "human-1",
        replyCount: 3,
        lastReplyAt: "2026-07-22T12:00:00.000Z",
        summaryRevision: 0,
      },
    });
  });

  test("applies a newer snapshot while preserving non-anchor identities", () => {
    const before = message("before");
    const anchor = message("42", {
      custom: { sourceUserId: "human-1" },
      replyCount: 1,
      lastReplyAt: "2026-07-22T11:00:00.000Z",
      summaryRevision: 1,
    });
    const after = message("after");
    const messages = [before, anchor, after];

    const result = applyThreadSummarySnapshot(messages, event());

    expect(result).not.toBe(messages);
    expect(result[0]).toBe(before);
    expect(result[2]).toBe(after);
    expect(result[1]).not.toBe(anchor);
    expect(result[1]!.metadata).toEqual({
      custom: {
        sourceUserId: "human-1",
        replyCount: 3,
        lastReplyAt: "2026-07-22T12:00:00.000Z",
        summaryRevision: 2,
      },
    });
  });

  test("ignores stale and replayed snapshots", () => {
    const messages = [message("42", { custom: { summaryRevision: 2, replyCount: 3 } })];

    expect(applyThreadSummarySnapshot(messages, event({ summaryRevision: 2 }))).toBe(messages);
    expect(applyThreadSummarySnapshot(messages, event({ summaryRevision: 1 }))).toBe(messages);
  });

  test("applies a final delete snapshot with zero replies and null last reply", () => {
    const messages = [message("42", {
      custom: {
        reactions: [{ emoji: "👍", count: 1 }],
        replyCount: 1,
        lastReplyAt: "2026-07-22T11:00:00.000Z",
        summaryRevision: 4,
      },
    })];

    const result = applyThreadSummarySnapshot(messages, event({
      replyCount: 0,
      lastReplyAt: null,
      summaryRevision: 5,
    }));

    expect(result[0]!.metadata).toEqual({
      custom: {
        reactions: [{ emoji: "👍", count: 1 }],
        replyCount: 0,
        lastReplyAt: null,
        summaryRevision: 5,
      },
    });
  });

  test("returns the original list when the anchor is absent", () => {
    const messages = [message("41", { custom: { kept: true } })];

    expect(applyThreadSummarySnapshot(messages, event())).toBe(messages);
  });
});
