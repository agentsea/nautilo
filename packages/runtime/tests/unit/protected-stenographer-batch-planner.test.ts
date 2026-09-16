import { describe, expect, test } from "bun:test";

import {
  fingerprintProtectedStenographerCoveredRange,
  planProtectedStenographerBatch,
  type ProtectedStenographerSourceMetadata,
} from "../../src/stenographer";

const NOW = new Date("2031-10-17T10:00:00.000Z");

function row(
  messageId: number,
  overrides: Partial<ProtectedStenographerSourceMetadata> = {},
): ProtectedStenographerSourceMetadata {
  return {
    messageId,
    editRevision: 0,
    createdAt: new Date(NOW.getTime() - 121_000),
    role: "user",
    fingerprint: null,
    transcriptOrigin: "main",
    originatedBy: null,
    excludedFromEvidence: false,
    keyClass: "ai",
    cryptoObjectId: `message-object-${messageId}`,
    cryptoCompletion: "complete",
    ...overrides,
  };
}

describe("protected Stenographer metadata-only batch planner", () => {
  test("plans an exact bounded authorization without receiving plaintext", () => {
    const rows = [1, 2, 3, 4, 5, 6].map((id) => row(id));
    const result = planProtectedStenographerBatch({
      cursorMessageId: 0,
      fixedUpperBoundMessageId: 6,
      rows,
      now: NOW,
    });

    expect(result).toMatchObject({
      status: "authorize",
      plan: {
        fromMessageIdExclusive: 0,
        throughMessageIdInclusive: 5,
        trigger: "count",
        coveredMessageIds: [1, 2, 3, 4, 5],
        inputObjectIds: [
          "message-object-1",
          "message-object-2",
          "message-object-3",
          "message-object-4",
          "message-object-5",
        ],
        potentialConversationalMessageCount: 5,
        requiresContentRecheck: false,
      },
    });
    if (result.status !== "authorize") {
      throw new Error("expected an authorization plan");
    }
    expect(result.plan.sourceFingerprint).toHaveLength(32);
    expect(JSON.stringify(result)).not.toContain("content");
    expect(JSON.stringify(result)).not.toContain("text");
    expect(JSON.stringify(result)).not.toContain("statement");
  });

  test("never authorizes human-only, deaf, task, supervision, or subagent sources", () => {
    const result = planProtectedStenographerBatch({
      cursorMessageId: 0,
      fixedUpperBoundMessageId: 5,
      rows: [
        row(1, { keyClass: "human" }),
        row(2, { excludedFromEvidence: true }),
        row(3, { originatedBy: "task" }),
        row(4, { transcriptOrigin: "subagent" }),
        row(5, { originatedBy: "connected_web_operation" }),
      ],
      now: NOW,
    });

    expect(result).toMatchObject({
      status: "skip_excluded",
      plan: {
        throughMessageIdInclusive: 5,
        inputObjectIds: [],
        sourceObjects: [],
      },
    });
  });

  test("blocks instead of reading plaintext or falling back when an AI source lacks a complete mapping", () => {
    for (const broken of [
      row(1, { cryptoObjectId: null }),
      row(1, { cryptoCompletion: "pending" }),
      row(1, { keyClass: null }),
    ]) {
      expect(planProtectedStenographerBatch({
        cursorMessageId: 0,
        fixedUpperBoundMessageId: 1,
        rows: [broken],
        now: NOW,
      })).toEqual({
        status: "blocked",
        reason: "protected_source_unavailable",
        messageIds: [1],
      });
    }
  });

  test("treats assistant content as unknown until the protected loader rechecks it", () => {
    const result = planProtectedStenographerBatch({
      cursorMessageId: 0,
      fixedUpperBoundMessageId: 5,
      rows: [1, 2, 3, 4, 5].map((id) =>
        row(id, { role: "assistant" })
      ),
      now: NOW,
    });

    expect(result).toMatchObject({
      status: "authorize",
      plan: {
        trigger: "count",
        potentialConversationalMessageCount: 5,
        requiresContentRecheck: true,
      },
    });
  });

  test("preserves count, silence, fingerprint, retry, and exact boundary behavior from metadata", () => {
    expect(planProtectedStenographerBatch({
      cursorMessageId: 10,
      fixedUpperBoundMessageId: 12,
      rows: [],
      now: NOW,
      retryFixedRange: true,
    })).toMatchObject({
      status: "skip_excluded",
      plan: { throughMessageIdInclusive: 12 },
    });

    expect(planProtectedStenographerBatch({
      cursorMessageId: 10,
      fixedUpperBoundMessageId: 12,
      rows: [row(11)],
      now: NOW,
      retryFixedRange: true,
    })).toMatchObject({
      status: "authorize",
      plan: {
        throughMessageIdInclusive: 12,
        coveredMessageIds: [11],
      },
    });

    expect(planProtectedStenographerBatch({
      cursorMessageId: 0,
      fixedUpperBoundMessageId: 1,
      rows: [
        row(1, { createdAt: new Date(NOW.getTime() - 119_999) }),
      ],
      now: NOW,
    })).toEqual({ status: "wait", reason: "not_due" });

    expect(planProtectedStenographerBatch({
      cursorMessageId: 0,
      fixedUpperBoundMessageId: 1,
      rows: [
        row(1, { createdAt: new Date(NOW.getTime() - 120_000) }),
      ],
      now: NOW,
    })).toMatchObject({
      status: "authorize",
      plan: { trigger: "silence" },
    });

    const deduplicated = planProtectedStenographerBatch({
      cursorMessageId: 10,
      fixedUpperBoundMessageId: 16,
      rows: [
        row(11, { fingerprint: "prior-human-turn" }),
        row(12),
        row(13),
        row(14),
        row(15),
        row(16),
      ],
      fingerprintsAtOrBeforeCursor: new Set(["prior-human-turn"]),
      now: NOW,
    });
    expect(deduplicated).toMatchObject({
      status: "authorize",
      plan: {
        throughMessageIdInclusive: 16,
        potentialConversationalMessageCount: 5,
      },
    });
  });

  test("rejects duplicate object identities and caps every authorization at 256 inputs", () => {
    expect(() =>
      planProtectedStenographerBatch({
        cursorMessageId: 0,
        fixedUpperBoundMessageId: 2,
        rows: [
          row(1, { cryptoObjectId: "same-object" }),
          row(2, { cryptoObjectId: "same-object" }),
        ],
        now: NOW,
      })
    ).toThrow("duplicate");

    const result = planProtectedStenographerBatch({
      cursorMessageId: 0,
      fixedUpperBoundMessageId: 300,
      rows: Array.from({ length: 300 }, (_, index) =>
        row(index + 1, {
          role: index === 0 ? "user" : "tool",
          createdAt: new Date(NOW.getTime() - 120_000),
        })
      ),
      now: NOW,
    });
    expect(result).toMatchObject({
      status: "authorize",
      plan: {
        throughMessageIdInclusive: 256,
        trigger: "silence",
      },
    });
    if (result.status !== "authorize") {
      throw new Error("expected an authorization plan");
    }
    expect(result.plan.inputObjectIds).toHaveLength(256);
  });

  test("binds edit revision and object replacement into the source fingerprint", () => {
    const plan = (source: ProtectedStenographerSourceMetadata) =>
      planProtectedStenographerBatch({
        cursorMessageId: 0,
        fixedUpperBoundMessageId: 1,
        rows: [source],
        now: NOW,
      });
    const original = plan(row(1));
    const edited = plan(row(1, {
      editRevision: 1,
      cryptoObjectId: "message-object-1-edit-1",
    }));
    if (
      original.status !== "authorize"
      || edited.status !== "authorize"
    ) {
      throw new Error("expected authorization plans");
    }
    expect(original.plan.sourceFingerprint)
      .not.toEqual(edited.plan.sourceFingerprint);
  });

  test("binds covered excluded and human-only rows without authorizing their objects", () => {
    const plan = (
      excluded: ProtectedStenographerSourceMetadata,
    ) =>
      planProtectedStenographerBatch({
        cursorMessageId: 0,
        fixedUpperBoundMessageId: 2,
        rows: [row(1), excluded],
        now: NOW,
      });
    const deaf = plan(row(2, {
      excludedFromEvidence: true,
      keyClass: "human",
      cryptoObjectId: "human-only-object",
    }));
    const cleared = plan(row(2, {
      excludedFromEvidence: false,
      keyClass: "human",
      cryptoObjectId: "human-only-object",
    }));
    if (deaf.status !== "authorize" || cleared.status !== "authorize") {
      throw new Error("expected mixed authorization plans");
    }
    expect(deaf.plan.inputObjectIds).toEqual(["message-object-1"]);
    expect(cleared.plan.inputObjectIds).toEqual(["message-object-1"]);
    expect(deaf.plan.sourceFingerprint)
      .not.toEqual(cleared.plan.sourceFingerprint);
  });

  test("rejects a noncanonical covered-range inventory before fingerprinting", () => {
    const fingerprint = (rows: readonly ProtectedStenographerSourceMetadata[]) =>
      fingerprintProtectedStenographerCoveredRange({
        fromMessageIdExclusive: 0,
        throughMessageIdInclusive: 2,
        rows,
      });

    expect(() => fingerprint([row(2), row(1)])).toThrow("ordered");
    expect(() => fingerprint([row(1), row(1)])).toThrow("unique");
    expect(() => fingerprint([row(1), row(3)])).toThrow("range");
    expect(() =>
      fingerprintProtectedStenographerCoveredRange({
        fromMessageIdExclusive: 3,
        throughMessageIdInclusive: 2,
        rows: [],
      })
    ).toThrow("range");
  });
});
