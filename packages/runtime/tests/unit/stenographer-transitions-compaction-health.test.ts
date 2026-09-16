import { describe, expect, test } from "bun:test";
import {
  classifyCompactionTrigger,
  countCodePoints,
  EVENT_COMPACTION_INPUT_MAX_CHARS,
  EVENT_ROLLUP_MAX_CHARS,
  planJournalCompaction,
  validateCompactionOutput,
} from "@nautilo/reflection";
import {
  aggregateCompactionRoomHealth,
  aggregateExtractionRoomHealth,
  classifyCompactionRoomHealth,
  classifyExtractionRoomHealth,
  classifyStenographerHealth,
  normalizedEventKey,
  planEventTransitions,
  projectJournalPrompt,
  type EffectiveRoomEvent,
  type StenographerOperation,
} from "../../src/stenographer";

function event(
  sequence: number,
  overrides: Partial<EffectiveRoomEvent> = {},
): EffectiveRoomEvent {
  return {
    id: `event-${sequence}`,
    roomId: "room-a",
    sequence,
    kind: "fact",
    statement: `fact ${sequence}`,
    status: "active",
    supersedesEventId: null,
    resolvesEventId: null,
    ...overrides,
  };
}

describe("planEventTransitions", () => {
  test("append allocates the next sequence and deterministic batch ordinal", () => {
    const result = planEventTransitions({
      roomId: "room-a",
      events: [event(4)],
      operations: [
        {
          op: "append",
          kind: "decision",
          statement: "Proceed",
          sourceMessageIds: [2],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.inserts[0]).toMatchObject({
      batchLocalOrdinal: 0,
      sequence: 5,
      kind: "decision",
    });
    expect(result.plan.nextSequence).toBe(6);
  });

  test("the locked normalized key folds lexical duplicates", () => {
    expect(normalizedEventKey("fact", " Café  IS   OPEN ")).toBe(
      normalizedEventKey("fact", "cafe\u0301 is open"),
    );
    const result = planEventTransitions({
      roomId: "room-a",
      events: [event(1, { statement: " Café  IS   OPEN " })],
      operations: [
        {
          op: "append",
          kind: "fact",
          statement: "cafe\u0301 is open",
          sourceMessageIds: [1],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.inserts).toEqual([]);
    expect(result.plan.foldedBatchLocalOrdinals).toEqual([0]);
  });

  test("semantic similarity without lexical identity is not folded", () => {
    const result = planEventTransitions({
      roomId: "room-a",
      events: [event(1, { statement: "The office opens at nine" })],
      operations: [
        {
          op: "append",
          kind: "fact",
          statement: "Opening time is 09:00",
          sourceMessageIds: [1],
        },
      ],
    });
    expect(result.ok && result.plan.inserts).toHaveLength(1);
  });

  test("supersede terminalizes one target and links an active replacement", () => {
    const result = planEventTransitions({
      roomId: "room-a",
      events: [event(7, { kind: "decision" })],
      operations: [
        {
          op: "supersede",
          eventSequence: 7,
          kind: "decision",
          statement: "Use the revised plan",
          sourceMessageIds: [20],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.statusUpdates).toEqual([
      {
        eventId: "event-7",
        fromStatus: "active",
        toStatus: "superseded",
      },
    ]);
    expect(result.plan.inserts[0]).toMatchObject({
      sequence: 8,
      status: "active",
      supersedesEventId: "event-7",
      resolvesEventId: null,
    });
  });

  test("resolve inherits the target kind and creates a visible resolution record", () => {
    const result = planEventTransitions({
      roomId: "room-a",
      events: [event(2, { kind: "open_question" })],
      operations: [
        {
          op: "resolve",
          eventSequence: 2,
          statement: "The launch is Tuesday",
          sourceMessageIds: [11],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.statusUpdates[0]?.toStatus).toBe("resolved");
    expect(result.plan.inserts[0]).toMatchObject({
      kind: "open_question",
      resolvesEventId: "event-2",
    });
  });

  test("terminal, cross-Room, and cyclic targets fail with no partial plan", () => {
    expect(
      planEventTransitions({
        roomId: "room-a",
        events: [event(1, { status: "resolved" })],
        operations: [
          {
            op: "resolve",
            eventSequence: 1,
            statement: "again",
            sourceMessageIds: [1],
          },
        ],
      }),
    ).toEqual({ ok: false, reason: "target_not_active" });

    expect(
      planEventTransitions({
        roomId: "room-a",
        events: [event(1, { roomId: "room-b" })],
        operations: [
          {
            op: "resolve",
            eventSequence: 1,
            statement: "wrong room",
            sourceMessageIds: [1],
          },
        ],
      }),
    ).toEqual({ ok: false, reason: "target_cross_room" });

    expect(
      planEventTransitions({
        roomId: "room-a",
        events: [
          event(1, { id: "one", supersedesEventId: "two" }),
          event(2, { id: "two", supersedesEventId: "one" }),
        ],
        operations: [],
      }),
    ).toEqual({ ok: false, reason: "invalid_existing_graph" });
  });

  test("multiple operations are deterministic and any invalid tail returns no plan", () => {
    const operations: StenographerOperation[] = [
      {
        op: "append",
        kind: "goal",
        statement: "Ship",
        sourceMessageIds: [1],
      },
      {
        op: "append",
        kind: "risk",
        statement: "Delay",
        sourceMessageIds: [2],
      },
    ];
    const first = planEventTransitions({
      roomId: "room-a",
      events: [event(3)],
      operations,
    });
    const replay = planEventTransitions({
      roomId: "room-a",
      events: [event(3)],
      operations,
    });
    expect(replay).toEqual(first);
    expect(
      first.ok && first.plan.inserts.map((insert) => [
        insert.batchLocalOrdinal,
        insert.sequence,
      ]),
    ).toEqual([
      [0, 4],
      [1, 5],
    ]);

    const invalid = planEventTransitions({
      roomId: "room-a",
      events: [event(3)],
      operations: [
        operations[0]!,
        {
          op: "resolve",
          eventSequence: 99,
          statement: "missing",
          sourceMessageIds: [2],
        },
      ],
    });
    expect(invalid).toEqual({ ok: false, reason: "target_not_found" });
    expect("plan" in invalid).toBe(false);
  });
});

function manyEvents(
  count: number,
  statement: (index: number) => string = (index) => `event ${index}`,
): EffectiveRoomEvent[] {
  return Array.from({ length: count }, (_, index) =>
    event(index + 1, { statement: statement(index + 1) }),
  );
}

describe("journal compaction policy", () => {
  test("thresholds report count and code-point reasons independently", () => {
    expect(
      classifyCompactionTrigger(
        manyEvents(199, () => "x".repeat(200)).slice(0, 199),
      ),
    ).toMatchObject({
      due: false,
      byCount: false,
      byCodePoints: false,
      effectiveEventCount: 199,
      statementCodePoints: 39_800,
    });
    expect(classifyCompactionTrigger(manyEvents(200))).toMatchObject({
      due: true,
      byCount: true,
      byCodePoints: false,
    });
    expect(
      classifyCompactionTrigger(manyEvents(80, () => "x".repeat(500))),
    ).toMatchObject({
      due: true,
      byCount: false,
      byCodePoints: true,
      statementCodePoints: 40_000,
    });
  });

  test("exactly 39,999 code points does not trigger", () => {
    const events = [
      ...manyEvents(79, () => "x".repeat(500)),
      event(80, { statement: "x".repeat(499) }),
    ];
    expect(classifyCompactionTrigger(events).due).toBe(false);
  });

  test("protected metadata may conservatively force a bounded compaction without reading statement lengths", () => {
    const result = planJournalCompaction({
      events: manyEvents(80),
      forceDue: true,
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.plan).not.toBeNull();
    if (!result.ok || !result.plan) return;
    expect(result.plan.trigger).toMatchObject({
      due: true,
      byCount: false,
      byCodePoints: false,
    });
    expect(result.plan.selectedEvents).toHaveLength(30);
    expect(result.plan.protectedTail).toHaveLength(50);
  });

  test("newest 50 effective events are protected with exact boundaries", () => {
    const result = planJournalCompaction({ events: manyEvents(200) });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.plan) return;
    expect(result.plan.selectedEvents[0]?.sequence).toBe(1);
    expect(result.plan.selectedEvents.at(-1)?.sequence).toBe(150);
    expect(result.plan.protectedTail[0]?.sequence).toBe(151);
    expect(result.plan.protectedTail.at(-1)?.sequence).toBe(200);
    expect(result.plan.throughEventSequence).toBe(150);
    expect(result.plan.prompt).toContain(
      "Protected newer effective-event tail",
    );
    expect(result.plan.prompt).toContain("E151");
    expect(result.plan.prompt).toContain("E200");
  });

  test("terminal rows are not effective tail members", () => {
    const events = [
      ...manyEvents(200),
      event(201, { status: "superseded" }),
      event(202, { status: "resolved" }),
    ];
    const result = planJournalCompaction({ events });
    expect(result.ok && result.plan?.protectedTail.at(-1)?.sequence).toBe(200);
  });

  test("previous rollup plus selected prefix yields one cumulative cursor", () => {
    const result = planJournalCompaction({
      rollups: [
        { throughEventSequence: 10, content: "old rollup" },
        { throughEventSequence: 20, content: "latest rollup" },
      ],
      events: manyEvents(220),
    });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.plan) return;
    expect(result.plan.previousRollup).toEqual({
      throughEventSequence: 20,
      content: "latest rollup",
    });
    expect(result.plan.selectedEvents[0]?.sequence).toBe(21);
    expect(result.plan.prompt).toContain("latest rollup");
    expect(result.plan.prompt).not.toContain("old rollup");
  });

  test("oversized backlog selects the largest oldest contiguous prefix", () => {
    const result = planJournalCompaction({
      events: manyEvents(300, () => "x".repeat(500)),
      inputMaxCodePoints: EVENT_COMPACTION_INPUT_MAX_CHARS,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.plan) return;
    expect(result.plan.inputCodePoints).toBeLessThanOrEqual(
      EVENT_COMPACTION_INPUT_MAX_CHARS,
    );
    expect(result.plan.hasMoreEligiblePrefix).toBe(true);
    expect(result.plan.scheduleAnotherPassAfterPublish).toBe(true);
    expect(
      result.plan.selectedEvents.every(
        (selected, index) => selected.sequence === index + 1,
      ),
    ).toBe(true);
    expect(result.plan.throughEventSequence).toBe(
      result.plan.selectedEvents.length,
    );
  });

  test("an irreducibly oversized first prefix returns input_too_large", () => {
    const result = planJournalCompaction({
      events: manyEvents(200),
      inputMaxCodePoints: 10,
    });
    expect(result).toMatchObject({
      ok: false,
      errorCode: "input_too_large",
    });
  });

  test("latest rollup plus active later events is the only prompt projection", () => {
    const projected = projectJournalPrompt({
      rollups: [
        { throughEventSequence: 5, content: "one" },
        { throughEventSequence: 10, content: "two" },
        { throughEventSequence: 20, content: "three" },
      ],
      events: [
        event(19),
        event(21),
        event(22, { status: "resolved" }),
        event(23),
      ],
    });
    expect(projected.rollup).toEqual({
      throughEventSequence: 20,
      content: "three",
    });
    expect(projected.events.map((item) => item.sequence)).toEqual([21, 23]);
  });

  test("invalid or oversized compactor output is rejected without changing input", () => {
    const prior = { throughEventSequence: 12, content: "still active" };
    expect(validateCompactionOutput("   ")).toMatchObject({
      ok: false,
      reason: "empty",
    });
    expect(
      validateCompactionOutput("😀".repeat(EVENT_ROLLUP_MAX_CHARS + 1)),
    ).toMatchObject({ ok: false, reason: "too_large" });
    expect(prior).toEqual({
      throughEventSequence: 12,
      content: "still active",
    });
  });

  test("rollup plus worst-case protected statements stays at 37,000 body points", () => {
    const projected = projectJournalPrompt({
      rollups: [
        {
          throughEventSequence: 150,
          content: "r".repeat(EVENT_ROLLUP_MAX_CHARS),
        },
      ],
      events: manyEvents(200, () => "e".repeat(500)),
    });
    expect(projected.events).toHaveLength(50);
    expect(projected.projectedBodyCodePoints).toBe(37_000);
    expect(countCodePoints(projected.rollup!.content)).toBe(12_000);
  });
});

const HEALTH_NOW = new Date("2026-07-27T12:00:00.000Z");

function extraction(
  overrides: Partial<Parameters<typeof classifyExtractionRoomHealth>[0]> = {},
) {
  return classifyExtractionRoomHealth({
    now: HEALTH_NOW,
    leaseExpiresAt: null,
    retryAfter: null,
    failureCount: 0,
    hasEligibleSourceRows: false,
    dueAt: null,
    ...overrides,
  });
}

function compaction(
  overrides: Partial<Parameters<typeof classifyCompactionRoomHealth>[0]> = {},
) {
  return classifyCompactionRoomHealth({
    now: HEALTH_NOW,
    leaseExpiresAt: null,
    retryAfter: null,
    failureCount: 0,
    dueAt: null,
    ...overrides,
  });
}

describe("stenographer health policy", () => {
  test("quiet caught-up Rooms are healthy regardless of completion age", () => {
    const room = extraction();
    const counts = aggregateExtractionRoomHealth([room]);
    expect(room.category).toBe("caught_up");
    expect(counts.oldestUnprotectedOverdueMs).toBe(0);
    expect(
      classifyStenographerHealth({
        extraction: counts,
        compaction: aggregateCompactionRoomHealth([]),
      }),
    ).toBe("healthy");
  });

  test("overdue grace and degradation boundaries are exact", () => {
    const health = (overdueMs: number) => {
      const counts = aggregateExtractionRoomHealth([
        extraction({
          hasEligibleSourceRows: true,
          dueAt: new Date(HEALTH_NOW.getTime() - overdueMs),
        }),
      ]);
      return classifyStenographerHealth({
        extraction: counts,
        compaction: aggregateCompactionRoomHealth([]),
      });
    };
    expect(health(59_999)).toBe("healthy");
    expect(health(60_000)).toBe("delayed");
    expect(health(299_999)).toBe("delayed");
    expect(health(300_000)).toBe("degraded");
  });

  test("a live lease is processing and suppresses overdue escalation", () => {
    const room = extraction({
      hasEligibleSourceRows: true,
      dueAt: new Date(HEALTH_NOW.getTime() - 1_000_000),
      leaseExpiresAt: new Date(HEALTH_NOW.getTime() + 1),
    });
    expect(room).toMatchObject({
      category: "processing",
      staleLease: false,
      unprotectedOverdueMs: 0,
    });
  });

  test("an expired lease is stale and degrades aggregate health", () => {
    const counts = aggregateExtractionRoomHealth([
      extraction({
        hasEligibleSourceRows: true,
        dueAt: new Date(HEALTH_NOW.getTime() - 1),
        leaseExpiresAt: new Date(HEALTH_NOW.getTime()),
      }),
    ]);
    expect(counts.staleLeases).toBe(1);
    expect(
      classifyStenographerHealth({
        extraction: counts,
        compaction: aggregateCompactionRoomHealth([]),
      }),
    ).toBe("degraded");
  });

  test("one/two retry failures delay; three degrade for both stages", () => {
    for (const failureCount of [1, 2]) {
      const extractionCounts = aggregateExtractionRoomHealth([
        extraction({
          failureCount,
          retryAfter: new Date(HEALTH_NOW.getTime() + 1_000),
        }),
      ]);
      expect(
        classifyStenographerHealth({
          extraction: extractionCounts,
          compaction: aggregateCompactionRoomHealth([]),
        }),
      ).toBe("delayed");
    }

    const compactionCounts = aggregateCompactionRoomHealth([
      compaction({
        failureCount: 3,
        retryAfter: new Date(HEALTH_NOW.getTime() + 1_000),
      }),
    ]);
    expect(
      classifyStenographerHealth({
        extraction: aggregateExtractionRoomHealth([]),
        compaction: compactionCounts,
      }),
    ).toBe("degraded");
  });

  test("extraction categories are mutually exclusive and sum to eligible Rooms", () => {
    const rooms = [
      extraction(),
      extraction({
        hasEligibleSourceRows: true,
        dueAt: new Date(HEALTH_NOW.getTime() + 1_000),
      }),
      extraction({
        hasEligibleSourceRows: true,
        dueAt: new Date(HEALTH_NOW.getTime() - 1),
      }),
      extraction({
        hasEligibleSourceRows: true,
        dueAt: new Date(HEALTH_NOW.getTime() - 1),
        leaseExpiresAt: new Date(HEALTH_NOW.getTime() + 1_000),
      }),
      extraction({
        hasEligibleSourceRows: true,
        dueAt: new Date(HEALTH_NOW.getTime() - 1),
        failureCount: 1,
        retryAfter: new Date(HEALTH_NOW.getTime() + 1_000),
      }),
    ];
    const counts = aggregateExtractionRoomHealth(rooms);
    expect(
      counts.caughtUpRooms +
        counts.accumulatingRooms +
        counts.dueRooms +
        counts.processingRooms +
        counts.retryingRooms,
    ).toBe(counts.eligibleRooms);
    expect(counts).toMatchObject({
      eligibleRooms: 5,
      caughtUpRooms: 1,
      accumulatingRooms: 1,
      dueRooms: 1,
      processingRooms: 1,
      retryingRooms: 1,
    });
  });

  test("compaction categories use the same lease/retry priority", () => {
    const counts = aggregateCompactionRoomHealth([
      compaction(),
      compaction({ dueAt: new Date(HEALTH_NOW.getTime() - 5_000) }),
      compaction({
        dueAt: new Date(HEALTH_NOW.getTime() - 5_000),
        leaseExpiresAt: new Date(HEALTH_NOW.getTime() + 1_000),
      }),
      compaction({
        dueAt: new Date(HEALTH_NOW.getTime() - 5_000),
        failureCount: 1,
        retryAfter: new Date(HEALTH_NOW.getTime() + 1_000),
      }),
    ]);
    expect(counts).toMatchObject({
      awaitingRooms: 1,
      processingRooms: 1,
      retryingRooms: 1,
      staleLeases: 0,
      oldestUnprotectedOverdueMs: 5_000,
    });
  });
});
