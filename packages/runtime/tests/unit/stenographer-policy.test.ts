import { describe, expect, test } from "bun:test";
import { countCodePoints, elideCodePoints } from "@nautilo/reflection";
import {
  canPublishJournalLease,
  classifyJournalEligibility,
  planJournalMembershipTransition,
  planJournalMembershipTransitions,
  planStenographerBatch,
  type StenographerSourceRow,
} from "../../src/stenographer";

const NOW = new Date("2026-07-27T12:00:00.000Z");

function row(
  id: number,
  overrides: Partial<StenographerSourceRow> = {},
): StenographerSourceRow {
  return {
    id,
    createdAt: new Date(NOW.getTime() - 121_000),
    role: "user",
    text: `message ${id}`,
    fingerprint: null,
    ...overrides,
  };
}

describe("code-point policy", () => {
  test("counts non-BMP text as one code point", () => {
    expect(countCodePoints("a😀b")).toBe(3);
  });

  test("head/tail elision includes its marker inside the exact limit", () => {
    const value = `head-${"😀".repeat(100)}-tail`;
    const projected = elideCodePoints(value, 40);
    expect(countCodePoints(projected)).toBe(40);
    expect(projected.startsWith("head-")).toBe(true);
    expect(projected.endsWith("-tail")).toBe(true);
    expect(projected).toContain("[... evidence elided ...]");
  });
});

describe("journal eligibility and membership transitions", () => {
  test.each(["task", "access"])("%s Rooms are ineligible", (roomKind) => {
    expect(
      classifyJournalEligibility({
        roomKind,
        agentMemberCount: 1,
        hasTranscriptRowsAfterCursor: true,
      }),
    ).toEqual({ eligible: false, reason: "non_conversational_room" });
  });

  test("Human-only Rooms and caught-up Rooms are ineligible", () => {
    expect(
      classifyJournalEligibility({
        roomKind: "room",
        agentMemberCount: 0,
        hasTranscriptRowsAfterCursor: true,
      }),
    ).toEqual({ eligible: false, reason: "no_agent_member" });
    expect(
      classifyJournalEligibility({
        roomKind: "subthread",
        agentMemberCount: 2,
        hasTranscriptRowsAfterCursor: false,
      }),
    ).toEqual({ eligible: false, reason: "no_pending_transcript" });
  });

  test.each(["active", "mention_only", "observe"])(
    "response mode %s does not affect eligibility",
    (mode) => {
      expect(
        classifyJournalEligibility({
          roomKind: "subthread",
          agentMemberCount: 1,
          hasTranscriptRowsAfterCursor: true,
          agentResponseModes: [mode],
        }),
      ).toEqual({ eligible: true });
    },
  );

  test("first join resumes at head and last leave suspends at head", () => {
    expect(
      planJournalMembershipTransition({
        roomId: "parent",
        agentCountBefore: 0,
        agentCountAfter: 1,
        committedTranscriptHead: 42,
      }),
    ).toEqual({
      roomId: "parent",
      action: "resume",
      cursorMessageId: 42,
      clearSuspended: true,
      invalidateExtractionLease: false,
    });
    expect(
      planJournalMembershipTransition({
        roomId: "parent",
        agentCountBefore: 1,
        agentCountAfter: 0,
        committedTranscriptHead: 50,
      }),
    ).toEqual({
      roomId: "parent",
      action: "suspend",
      cursorMessageId: 50,
      clearSuspended: false,
      invalidateExtractionLease: true,
    });
  });

  test("non-first join and non-last leave are no-ops", () => {
    expect(
      planJournalMembershipTransition({
        roomId: "room",
        agentCountBefore: 1,
        agentCountAfter: 2,
        committedTranscriptHead: 1,
      }).action,
    ).toBe("none");
    expect(
      planJournalMembershipTransition({
        roomId: "room",
        agentCountBefore: 2,
        agentCountAfter: 1,
        committedTranscriptHead: 1,
      }).action,
    ).toBe("none");
  });

  test("propagated parent and child transitions are all planned", () => {
    const transitions = planJournalMembershipTransitions([
        {
          roomId: "parent",
          agentCountBefore: 1,
          agentCountAfter: 0,
          committedTranscriptHead: 8,
        },
        {
          roomId: "child",
          agentCountBefore: 1,
          agentCountAfter: 0,
          committedTranscriptHead: 13,
        },
      ]);
    expect(transitions.map(({ roomId, action }) => ({ roomId, action }))).toEqual(
      [
        { roomId: "parent", action: "suspend" },
        { roomId: "child", action: "suspend" },
      ],
    );
  });

  test("an invalidated or stale lease cannot publish", () => {
    expect(
      canPublishJournalLease({
        presentedLeaseToken: "old",
        currentLeaseToken: null,
        suspended: true,
        hasAgentMember: false,
      }),
    ).toBe(false);
    expect(
      canPublishJournalLease({
        presentedLeaseToken: "old",
        currentLeaseToken: "new",
        suspended: false,
        hasAgentMember: true,
      }),
    ).toBe(false);
    expect(
      canPublishJournalLease({
        presentedLeaseToken: "current",
        currentLeaseToken: "current",
        suspended: false,
        hasAgentMember: true,
      }),
    ).toBe(true);
  });
});

describe("planStenographerBatch", () => {
  const plan = (
    rows: StenographerSourceRow[],
    overrides: Partial<Parameters<typeof planStenographerBatch>[0]> = {},
  ) =>
    planStenographerBatch({
      cursorMessageId: 0,
      fixedUpperBoundMessageId: 999,
      rows,
      now: NOW,
      ...overrides,
    });

  test("no rows means no claim", () => {
    expect(plan([])).toBeNull();
  });

  test("one through four recent messages do not claim", () => {
    for (let count = 1; count <= 4; count += 1) {
      expect(
        plan(
          Array.from({ length: count }, (_, index) =>
            row(index + 1, {
              createdAt: new Date(NOW.getTime() - 119_999),
            }),
          ),
        ),
      ).toBeNull();
    }
  });

  test("exactly five claims by count; six stops at the fifth boundary", () => {
    expect(plan([1, 2, 3, 4, 5].map((id) => row(id)))).toMatchObject({
      trigger: "count",
      throughMessageIdInclusive: 5,
      conversationalMessageCount: 5,
    });
    const six = plan([1, 2, 3, 4, 5, 6].map((id) => row(id)));
    expect(six?.throughMessageIdInclusive).toBe(5);
    expect(six?.coveredMessageIds).toEqual([1, 2, 3, 4, 5]);
  });

  test("silence fires at exactly two minutes, but not one millisecond newer", () => {
    expect(
      plan([
        row(1, { createdAt: new Date(NOW.getTime() - 120_000) }),
      ])?.trigger,
    ).toBe("silence");
    expect(
      plan([
        row(1, { createdAt: new Date(NOW.getTime() - 119_999) }),
      ]),
    ).toBeNull();
  });

  test("a newer tool row resets silence without incrementing count", () => {
    const rows = [
      row(1, { createdAt: new Date(NOW.getTime() - 180_000) }),
      row(2, {
        role: "tool",
        text: "result",
        createdAt: new Date(NOW.getTime() - 30_000),
      }),
    ];
    expect(plan(rows)).toBeNull();
    const claimed = plan([
      ...rows.slice(0, 1),
      { ...rows[1]!, createdAt: new Date(NOW.getTime() - 120_000) },
    ]);
    expect(claimed).toMatchObject({
      trigger: "silence",
      conversationalMessageCount: 1,
      throughMessageIdInclusive: 2,
    });
    expect(claimed?.sourceRows.map((source) => source.id)).toEqual([1, 2]);
  });

  test("silence uses newest timestamp even when message IDs are not timestamp ordered", () => {
    expect(
      plan([
        row(2, { createdAt: new Date(NOW.getTime() - 120_000) }),
        row(1, {
          role: "tool",
          text: "newer tool result",
          createdAt: new Date(NOW.getTime() - 30_000),
        }),
      ]),
    ).toBeNull();
  });

  test("failed fixed-range retry treats deleted rows as tombstones", () => {
    expect(
      plan([], {
        cursorMessageId: 10,
        fixedUpperBoundMessageId: 12,
        retryFixedRange: true,
      }),
    ).toMatchObject({
      throughMessageIdInclusive: 12,
      trigger: "skip_excluded",
      sourceRows: [],
      coveredMessageIds: [],
    });

    expect(
      plan([row(11)], {
        cursorMessageId: 10,
        fixedUpperBoundMessageId: 12,
        retryFixedRange: true,
      }),
    ).toMatchObject({
      throughMessageIdInclusive: 12,
      trigger: "silence",
      coveredMessageIds: [11],
    });
  });

  test("empty assistant scaffolding and tool rows do not count", () => {
    const claimed = plan([
      row(1),
      row(2, { role: "assistant", text: " \n " }),
      row(3, { role: "tool", text: "tool" }),
      row(4),
      row(5),
      row(6),
      row(7),
    ]);
    expect(claimed?.trigger).toBe("count");
    expect(claimed?.throughMessageIdInclusive).toBe(7);
    expect(claimed?.conversationalMessageCount).toBe(5);
  });

  test("non-null Human fingerprints deduplicate non-adjacent fan-out copies", () => {
    const claimed = plan([
      row(1, { fingerprint: "same" }),
      row(2, { fingerprint: null }),
      row(3, { fingerprint: "same" }),
      row(4, { fingerprint: null }),
      row(5, { fingerprint: null }),
      row(6, { fingerprint: null }),
    ]);
    expect(claimed?.trigger).toBe("count");
    expect(claimed?.throughMessageIdInclusive).toBe(6);
    expect(
      claimed?.sourceRows.find((source) => source.id === 3)
        ?.conversationalBoundary,
    ).toBe(false);
  });

  test("a fingerprint represented before the cursor is covered but not counted", () => {
    const claimed = plan(
      [
        row(11, { fingerprint: "old" }),
        row(12),
        row(13),
        row(14),
        row(15),
        row(16),
      ],
      {
        cursorMessageId: 10,
        fingerprintsAtOrBeforeCursor: new Set(["old"]),
      },
    );
    expect(claimed?.throughMessageIdInclusive).toBe(16);
    expect(claimed?.coveredMessageIds).toContain(11);
    expect(
      claimed?.sourceRows.find((source) => source.id === 11)
        ?.conversationalBoundary,
    ).toBe(false);
  });

  test("input order is irrelevant and equal timestamps render by ID", () => {
    const timestamp = new Date(NOW.getTime() - 121_000);
    const claimed = plan(
      [5, 1, 4, 2, 3].map((id) => row(id, { createdAt: timestamp })),
    );
    expect(claimed?.sourceRows.map((source) => source.id)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  test("fixed upper bound excludes newly arriving rows", () => {
    expect(
      plan(
        [1, 2, 3, 4, 5, 6].map((id) =>
          row(id, { createdAt: new Date(NOW.getTime() - 1) }),
        ),
        {
        fixedUpperBoundMessageId: 4,
        },
      ),
    ).toBeNull();
  });

  test("deaf conversational evidence is skipped and covered without model input", () => {
    const claimed = plan([
      row(1, { excludedFromEvidence: true }),
      row(2, { excludedFromEvidence: true }),
    ]);
    expect(claimed).toMatchObject({
      trigger: "skip_excluded",
      throughMessageIdInclusive: 2,
      sourceRows: [],
      coveredMessageIds: [1, 2],
    });
  });

  test("never returns an empty or inverted range", () => {
    const claimed = plan([row(11)], { cursorMessageId: 10 });
    expect(claimed).not.toBeNull();
    expect(claimed!.throughMessageIdInclusive).toBeGreaterThan(
      claimed!.fromMessageIdExclusive,
    );
  });
});
