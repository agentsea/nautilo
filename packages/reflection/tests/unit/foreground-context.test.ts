import { describe, expect, test } from "bun:test";

import {
  FOREGROUND_CONTEXT_POLICY_V1,
  FOREGROUND_RECORD_CONTEXT_HEADER,
  buildForegroundContextProjectionV1,
  buildForegroundRecordQueryV1,
  type ForegroundRecordSelectionResult,
} from "@nautilo/reflection/foreground";

const encoder = new TextEncoder();

function available(
  statements: readonly string[] = ["Postgres was selected for transactional consistency."],
): ForegroundRecordSelectionResult {
  return {
    status: "available",
    representation: "ordinary",
    queryEmbeddingStatus: "available",
    candidateCount: statements.length,
    records: statements.map((statement, index) => ({
      recordRef: `record-${index + 1}`,
      statement,
      lifecycle: index === 0 ? "current" : "stale",
      structuralHeight: index + 1,
    })),
  };
}

function projection(overrides: Partial<Parameters<
  typeof buildForegroundContextProjectionV1
>[0]> = {}) {
  return buildForegroundContextProjectionV1({
    maximumCharacters: 2_000,
    journalBlock: "JOURNAL",
    journalRollupPresent: true,
    journalStatements: ["Ship on Tuesday."],
    journalEventCount: 1,
    selection: available(),
    recentMessageCount: 2,
    completeTurnCount: 1,
    narrative: {
      baselineBlock: "[Recent]\nRECENT",
      header: "[Recent]",
      turns: [{ completeness: "complete", entries: ["RECENT"] }],
      minimumCompleteTurns: 1,
      earlierEntriesOmitted: false,
    },
    ...overrides,
  });
}

describe("Wave 9 foreground Record query", () => {
  test("keeps current Human text first and admits only the prior Human request", () => {
    const query = buildForegroundRecordQueryV1({
      currentHumanText: "Why did we choose that?",
      priorTurn: [
        { role: "user", text: "Should we use Postgres or SQLite?" },
        { role: "assistant", text: "Postgres fits concurrent writers." },
      ],
    });
    expect(query).toBe(
      "Why did we choose that?\n\n[Immediately preceding Human request]\n"
      + "user: Should we use Postgres or SQLite?",
    );
  });

  test("does not let prior assistant or tool payloads become the search topic", () => {
    const query = buildForegroundRecordQueryV1({
      currentHumanText: "What books do I like?",
      priorTurn: [
        { role: "user", text: "Check again" },
        { role: "tool", text: "task schema ".repeat(1_000) },
        { role: "assistant", text: "The shell and task tools are available." },
      ],
    });
    expect(query).toBe(
      "What books do I like?\n\n[Immediately preceding Human request]\n"
      + "user: Check again",
    );
    expect(query).not.toContain("task schema");
    expect(query).not.toContain("shell");
  });

  test("is UTF-8 bounded without splitting a code point or crowding out current text", () => {
    const query = buildForegroundRecordQueryV1({
      currentHumanText: "💭".repeat(2_000),
      priorTurn: [{ role: "assistant", text: "must not fit" }],
    });
    expect(query).not.toBeNull();
    expect(encoder.encode(query!).length).toBe(
      FOREGROUND_CONTEXT_POLICY_V1.queryMaximumUtf8Bytes,
    );
    expect(query).not.toContain("must not fit");
    expect(query!.endsWith("💭")).toBe(true);
  });

  test("does not search an empty textual turn", () => {
    expect(buildForegroundRecordQueryV1({
      currentHumanText: "  \n ",
      priorTurn: [{ role: "user", text: "old request" }],
    })).toBeNull();
  });
});

describe("Wave 9 foreground hybrid projection", () => {
  test("keeps unavailable and empty Record paths byte-identical to the baseline", () => {
    const unavailable = projection({
      selection: {
        status: "unavailable",
        representation: "ordinary",
        queryEmbeddingStatus: "available",
        reason: "exact_scan_timeout",
      },
    });
    const empty = projection({ selection: available([]) });
    expect(unavailable.body).toBe("JOURNAL\n\n[Recent]\nRECENT");
    expect(empty.body).toBe("JOURNAL\n\n[Recent]\nRECENT");
    expect(unavailable.facts.selectionStatus).toBe("unavailable");
    expect(empty.facts.selectionStatus).toBe("empty");
  });

  test("labels Journal, Records, and recent transcript without runtime dedupe", () => {
    const result = projection({
      journalBlock: "[Journal]\nShip on Tuesday.",
      journalStatements: ["Ship on Tuesday."],
      selection: available([
        "Ship on Tuesday.",
        "Postgres was selected for transactional consistency.",
      ]),
      narrative: {
        baselineBlock: "[Recent]\nWhy did we choose that?",
        header: "[Recent]",
        turns: [{ completeness: "complete", entries: ["Why did we choose that?"] }],
        minimumCompleteTurns: 1,
        earlierEntriesOmitted: false,
      },
    });
    expect(result.body).toContain("[Journal]");
    expect(result.body).toContain(FOREGROUND_RECORD_CONTEXT_HEADER.trim());
    expect(result.body).toContain("lifecycle=current; height=1; ref=record-1");
    expect(result.body).toContain("lifecycle=stale; height=2; ref=record-2");
    expect(result.body).toContain("[Recent]");
    expect(result.body!.match(/Ship on Tuesday\./g)).toHaveLength(2);
    expect(result.facts.normalizedExactCrossSectionMatchCount).toBe(1);
    expect(result.facts.recordPackedCount).toBe(2);
  });

  test("ignores an unavailable legacy Journal statement instead of failing the turn", () => {
    const result = projection({
      journalStatements: [null, "Ship on Tuesday."] as unknown as readonly string[],
      selection: available(["Ship on Tuesday."]),
    });
    expect(result.facts.normalizedExactCrossSectionMatchCount).toBe(1);
    expect(result.facts.selectionStatus).toBe("available");
  });

  test("preserves a complete recent turn while it fits", () => {
    const mandatory = `RECENT ${"r".repeat(350)}`;
    const result = projection({
      maximumCharacters: 500,
      journalBlock: "JOURNAL",
      selection: available([]),
      narrative: {
        baselineBlock: `[Recent]\n${mandatory}`,
        header: "[Recent]",
        turns: [{ completeness: "complete", entries: [mandatory] }],
        minimumCompleteTurns: 1,
        earlierEntriesOmitted: true,
      },
    });
    expect(result.body!.length).toBeLessThanOrEqual(500);
    expect(result.body).toContain(mandatory);
    expect(result.body).not.toContain("OLDER");
  });

  test("labels and bounds an excerpt when one narrative entry is oversized", () => {
    const result = projection({
      maximumCharacters: 220,
      journalBlock: null,
      journalRollupPresent: false,
      selection: available([]),
      narrative: {
        baselineBlock: `[Recent]\nRECENT ${"r".repeat(500)}`,
        header: "[Recent]",
        turns: [{ completeness: "complete", entries: [`RECENT ${"r".repeat(500)}`] }],
        minimumCompleteTurns: 1,
        earlierEntriesOmitted: false,
      },
    });
    expect(result.body!.length).toBeLessThanOrEqual(220);
    expect(result.body).toContain("context omitted");
    expect(result.body).toContain("Excerpt from one oversized narrative entry");
    expect(result.body).not.toContain(FOREGROUND_RECORD_CONTEXT_HEADER.trim());
    expect(result.facts.recordPackedCount).toBe(0);
  });

  test("retains current-turn provenance when active progress is excerpted", () => {
    const result = projection({
      maximumCharacters: 300,
      journalBlock: null,
      journalRollupPresent: false,
      selection: available([]),
      narrative: {
        baselineBlock: `[Recent]\nCOMPLETED ${"r".repeat(500)}`,
        header: "[Recent]",
        turns: [{
          completeness: "partial",
          provenance: "active_turn",
          entries: [`COMPLETED ${"r".repeat(500)}`],
        }],
        minimumCompleteTurns: 0,
        earlierEntriesOmitted: false,
      },
    });
    expect(result.body!.length).toBeLessThanOrEqual(300);
    expect(result.body).toContain("Completed progress in the current logical turn");
    expect(result.body).toContain("after the accepted Human request");
    expect(result.body).toContain("Excerpt from one oversized narrative entry");
  });

  test("keeps semantic continuity and all fitting current-turn progress before prior turns", () => {
    const activeEntries = Array.from(
      { length: 12 },
      (_, index) => `ACTIVE_STEP_${index.toString().padStart(2, "0")} ${"a".repeat(28)}`,
    );
    const result = projection({
      maximumCharacters: 1_800,
      maximumHistoricalCharacters: 500,
      journalBlock: "[Journal]\nDURABLE_DECISION",
      journalStatements: ["DURABLE_DECISION"],
      selection: available([]),
      narrative: {
        baselineBlock: [
          "[Recent]",
          `PRIOR_HISTORY ${"p".repeat(700)}`,
          ...activeEntries,
        ].join("\n"),
        header: "[Recent]",
        turns: [
          {
            completeness: "complete",
            provenance: "prior",
            entries: [`PRIOR_HISTORY ${"p".repeat(700)}`],
          },
          {
            completeness: "partial",
            provenance: "active_turn",
            entries: activeEntries,
          },
        ],
        minimumCompleteTurns: 1,
        earlierEntriesOmitted: false,
      },
    });

    expect(result.body!.length).toBeLessThanOrEqual(1_800);
    for (const entry of activeEntries) expect(result.body).toContain(entry);
    expect(result.body).toContain("DURABLE_DECISION");
    expect(result.body).not.toContain("PRIOR_HISTORY");
  });

  test("packs semantic continuity before the newest active tail when both cannot fit", () => {
    const result = projection({
      maximumCharacters: 700,
      maximumHistoricalCharacters: 350,
      journalBlock: "[Journal]\nDURABLE_DECISION",
      journalStatements: ["DURABLE_DECISION"],
      selection: available(["ORGANIZED_CONTINUITY"]),
      narrative: {
        baselineBlock: null,
        header: "[Recent]",
        turns: [{
          completeness: "partial",
          provenance: "active_turn",
          entries: [
            `ACTIVE_OLDEST ${"o".repeat(500)}`,
            `ACTIVE_NEWEST ${"n".repeat(260)}`,
          ],
        }],
        minimumCompleteTurns: 0,
        earlierEntriesOmitted: false,
      },
    });

    expect(result.body).toContain("DURABLE_DECISION");
    expect(result.body).toContain("ORGANIZED_CONTINUITY");
    expect(result.body).toContain("ACTIVE_NEWEST");
    expect(result.body).not.toContain("ACTIVE_OLDEST");
  });

  test("keeps the newest current-turn tail before pre-trigger history when the turn cannot fit", () => {
    const result = projection({
      maximumCharacters: 420,
      journalBlock: null,
      journalRollupPresent: false,
      selection: available([]),
      narrative: {
        baselineBlock: null,
        header: "[Recent]",
        turns: [
          {
            completeness: "complete",
            provenance: "prior",
            entries: [`PRIOR_HISTORY ${"p".repeat(300)}`],
          },
          {
            completeness: "partial",
            provenance: "active_turn",
            entries: [
              `ACTIVE_OLD ${"o".repeat(260)}`,
              "ACTIVE_NEWEST must survive",
            ],
          },
        ],
        minimumCompleteTurns: 1,
        earlierEntriesOmitted: false,
      },
    });

    expect(result.body).toContain("ACTIVE_NEWEST must survive");
    expect(result.body).not.toContain("PRIOR_HISTORY");
    expect(result.body).toContain("Completed progress in the current logical turn");
  });

  test("switches provenance labels around surrounding Room activity", () => {
    const result = projection({
      maximumCharacters: 1_000,
      maximumHistoricalCharacters: 200,
      journalBlock: null,
      journalRollupPresent: false,
      selection: available([]),
      narrative: {
        baselineBlock: null,
        header: "[Recent]",
        turns: [
          {
            completeness: "partial",
            provenance: "active_turn",
            entries: ["OWNED_ONE"],
          },
          {
            completeness: "complete",
            provenance: "surrounding",
            entries: ["OTHER_HUMAN", "OTHER_EXECUTION"],
          },
          {
            completeness: "partial",
            provenance: "active_turn",
            entries: ["OWNED_TWO"],
          },
        ],
        minimumCompleteTurns: 0,
        earlierEntriesOmitted: false,
      },
    });
    const body = result.body!;
    const activeLabel = "Completed progress in the current logical turn";
    const surroundingLabel = "Surrounding Room activity during the current logical turn";

    expect(body.match(new RegExp(activeLabel, "g"))).toHaveLength(2);
    expect(body.match(new RegExp(surroundingLabel, "g"))).toHaveLength(1);
    expect(body.indexOf("OWNED_ONE")).toBeLessThan(body.indexOf(surroundingLabel));
    expect(body.indexOf("OTHER_EXECUTION")).toBeLessThan(body.lastIndexOf(activeLabel));
    expect(body.lastIndexOf(activeLabel)).toBeLessThan(body.indexOf("OWNED_TWO"));
  });

  test("applies an explicit historical allowance when only prior history exists", () => {
    const result = projection({
      maximumCharacters: 1_000,
      maximumHistoricalCharacters: 100,
      journalBlock: null,
      journalRollupPresent: false,
      selection: available([]),
      narrative: {
        baselineBlock: `[Recent]\nPRIOR_ONLY ${"p".repeat(500)}`,
        header: "[Recent]",
        turns: [{
          completeness: "complete",
          provenance: "prior",
          entries: [`PRIOR_ONLY ${"p".repeat(500)}`],
        }],
        minimumCompleteTurns: 1,
        earlierEntriesOmitted: false,
      },
    });

    expect(result.body?.length ?? 0).toBeLessThanOrEqual(100);
    expect(result.body ?? "").not.toContain(`PRIOR_ONLY ${"p".repeat(500)}`);
    expect(result.facts.totalCharacters).toBeLessThanOrEqual(100);
  });

  test("admits older complete turns when the whole bounded body fits", () => {
    const result = projection({
      maximumCharacters: 1_000,
      journalBlock: "JOURNAL",
      narrative: {
        baselineBlock: "[Recent]\nOLDER TURN\nRECENT",
        header: "[Recent]",
        turns: [
          { completeness: "complete", entries: ["OLDER TURN"] },
          { completeness: "complete", entries: ["RECENT"] },
        ],
        minimumCompleteTurns: 1,
        earlierEntriesOmitted: false,
      },
    });
    expect(result.body).toContain("JOURNAL");
    expect(result.body).toContain(FOREGROUND_RECORD_CONTEXT_HEADER.trim());
    expect(result.body).toContain("OLDER TURN");
    expect(result.body!.length).toBeLessThanOrEqual(1_000);
  });

  test("packs coherent Record lines instead of splicing two bounded items", () => {
    const result = projection({
      maximumCharacters: 260,
      journalBlock: null,
      journalRollupPresent: false,
      completeTurnCount: 0,
      narrative: {
        baselineBlock: null,
        header: "[Recent]",
        turns: [],
        minimumCompleteTurns: 0,
        earlierEntriesOmitted: false,
      },
      selection: available([
        `FIRST_RECORD ${"a".repeat(300)}`,
        "SECOND_RECORD must not be joined to the first",
      ]),
    });
    expect(result.body).toContain("ref=record-1");
    expect(result.body).toContain("FIRST_RECORD");
    expect(result.body).not.toContain("ref=record-2");
    expect(result.body).not.toContain("SECOND_RECORD");
    expect(result.facts.recordPackedCount).toBe(1);
    expect(result.body!.length).toBeLessThanOrEqual(260);
  });
});
