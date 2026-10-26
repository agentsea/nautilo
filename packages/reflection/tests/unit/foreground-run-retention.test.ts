import { describe, expect, test } from "bun:test";

import {
  FOREGROUND_RECORD_CONTEXT_HEADER,
  buildForegroundContextProjectionV1,
  type ForegroundNarrativeTranscriptV1,
  type ForegroundRecordSelectionResult,
} from "@nautilo/reflection/foreground";

function availableRecord(statement: string): ForegroundRecordSelectionResult {
  return {
    status: "available",
    representation: "ordinary",
    queryEmbeddingStatus: "available",
    candidateCount: 1,
    records: [{
      recordRef: "record:retained",
      statement,
      lifecycle: "current",
      structuralHeight: 1,
    }],
  };
}

function projection(input: Readonly<{
  maximumCharacters: number;
  maximumHistoricalCharacters?: number;
  journalBlock?: string | null;
  recordStatement?: string;
  narrative: ForegroundNarrativeTranscriptV1;
}>) {
  return buildForegroundContextProjectionV1({
    maximumCharacters: input.maximumCharacters,
    ...(input.maximumHistoricalCharacters === undefined
      ? {}
      : { maximumHistoricalCharacters: input.maximumHistoricalCharacters }),
    journalBlock: input.journalBlock ?? null,
    journalRollupPresent: input.journalBlock != null,
    journalStatements: [],
    journalEventCount: 0,
    ...(input.recordStatement === undefined
      ? {}
      : { selection: availableRecord(input.recordStatement) }),
    recentMessageCount: input.narrative.turns.reduce(
      (count, turn) => count + turn.entries.length,
      0,
    ),
    completeTurnCount: input.narrative.turns.filter(
      (turn) => turn.completeness === "complete",
    ).length,
    narrative: input.narrative,
  });
}

function narrative(
  turns: ForegroundNarrativeTranscriptV1["turns"],
): ForegroundNarrativeTranscriptV1 {
  return {
    baselineBlock: null,
    header: "[Recent]",
    turns,
    minimumCompleteTurns: 0,
    earlierEntriesOmitted: false,
  };
}

describe("foreground current-run retention", () => {
  test("reserves Journal and Records outside the optional prior-history allowance", () => {
    const journalBlock = `[Journal]\nDURABLE_JOURNAL ${"j".repeat(170)}`;
    const recordStatement = `DURABLE_RECORD ${"r".repeat(150)}`;
    const result = projection({
      maximumCharacters: 900,
      maximumHistoricalCharacters: 110,
      journalBlock,
      recordStatement,
      narrative: narrative([
        {
          completeness: "complete",
          provenance: "prior",
          entries: [`PRIOR_HISTORY ${"p".repeat(300)}`],
        },
        {
          completeness: "partial",
          provenance: "active_turn",
          entries: ["ACTIVE_PROGRESS retained after refresh"],
        },
      ]),
    });

    expect(journalBlock.length).toBeGreaterThan(110);
    expect(result.body).toContain(journalBlock);
    expect(result.body).toContain(recordStatement);
    expect(result.body).toContain("ACTIVE_PROGRESS retained after refresh");
    expect(result.body).not.toContain("PRIOR_HISTORY");
    expect(result.facts.journalCharacters).toBe(journalBlock.length);
    expect(result.facts.recordPackedCount).toBe(1);
    expect(result.facts.totalCharacters).toBeLessThanOrEqual(900);
  });

  test("keeps completed own progress ahead of oversized newer surrounding activity", () => {
    const result = projection({
      maximumCharacters: 1_000,
      maximumHistoricalCharacters: 0,
      journalBlock: "JOURNAL continuity",
      narrative: narrative([
        {
          completeness: "partial",
          provenance: "active_turn",
          entries: ["Assistant: OWN_COMPLETED tiny answer"],
        },
        {
          completeness: "complete",
          provenance: "surrounding",
          entries: [`Tool: FOREIGN_OVERSIZED ${"x".repeat(3_000)}`],
        },
      ]),
    });

    expect(result.body).toContain("JOURNAL continuity");
    expect(result.body).toContain("OWN_COMPLETED tiny answer");
    expect(result.body).not.toContain("FOREIGN_OVERSIZED");
    expect(result.body).toContain("narrative entries omitted");
    expect(result.facts.totalCharacters).toBeLessThanOrEqual(1_000);
  });

  test("selects active progress, then surrounding activity, then allowed prior history and renders chronologically", () => {
    const result = projection({
      maximumCharacters: 850,
      maximumHistoricalCharacters: 180,
      journalBlock: "JOURNAL",
      narrative: narrative([
        {
          completeness: "complete",
          provenance: "prior",
          entries: ["PRIOR_FITTING"],
        },
        {
          completeness: "partial",
          provenance: "active_turn",
          entries: ["OWN_OLDER", "OWN_NEWER"],
        },
        {
          completeness: "complete",
          provenance: "surrounding",
          entries: [`FOREIGN_TOO_LARGE ${"f".repeat(900)}`],
        },
        {
          completeness: "complete",
          provenance: "surrounding",
          entries: ["FOREIGN_FITTING"],
        },
      ]),
    });
    const body = result.body!;

    expect(body).toContain("PRIOR_FITTING");
    expect(body).toContain("OWN_OLDER");
    expect(body).toContain("OWN_NEWER");
    expect(body).toContain("FOREIGN_FITTING");
    expect(body).not.toContain("FOREIGN_TOO_LARGE");
    expect(body.indexOf("PRIOR_FITTING")).toBeLessThan(body.indexOf("OWN_OLDER"));
    expect(body.indexOf("OWN_OLDER")).toBeLessThan(body.indexOf("OWN_NEWER"));
    expect(body.indexOf("OWN_NEWER")).toBeLessThan(body.indexOf("FOREIGN_FITTING"));
    expect(body).toContain("narrative entries omitted");
  });

  test("preserves the full active run when it fits despite newer surrounding output", () => {
    const activeEntries = [
      "OWN_STEP_1 accepted the task",
      "OWN_STEP_2 completed the lookup",
      "OWN_STEP_3 produced the answer",
    ];
    const result = projection({
      maximumCharacters: 700,
      maximumHistoricalCharacters: 0,
      journalBlock: "JOURNAL",
      narrative: narrative([
        {
          completeness: "partial",
          provenance: "active_turn",
          entries: activeEntries,
        },
        {
          completeness: "complete",
          provenance: "surrounding",
          entries: [`FOREIGN_NEWER ${"f".repeat(1_500)}`],
        },
      ]),
    });

    for (const entry of activeEntries) expect(result.body).toContain(entry);
    expect(result.body).not.toContain("FOREIGN_NEWER");
  });

  test("keeps newest own entries and drops the oldest own entry first under pressure", () => {
    const result = projection({
      maximumCharacters: 440,
      maximumHistoricalCharacters: 0,
      narrative: narrative([{
        completeness: "partial",
        provenance: "active_turn",
        entries: [
          `OWN_OLDEST ${"o".repeat(260)}`,
          `OWN_MIDDLE ${"m".repeat(80)}`,
          "OWN_NEWEST final answer",
        ],
      }]),
    });

    expect(result.body).not.toContain("OWN_OLDEST");
    expect(result.body).toContain("OWN_MIDDLE");
    expect(result.body).toContain("OWN_NEWEST final answer");
    expect(result.body).toContain("earlier narrative entries omitted");
  });

  test("does not backfill older own progress past an oversized newer own entry", () => {
    const result = projection({
      maximumCharacters: 300,
      maximumHistoricalCharacters: 0,
      narrative: narrative([{
        completeness: "partial",
        provenance: "active_turn",
        entries: [
          "OWN_OLDER_SMALL should not backfill",
          `OWN_NEWER_OVERSIZED ${"n".repeat(1_000)}`,
        ],
      }]),
    });

    expect(result.body).not.toContain("OWN_OLDER_SMALL");
    expect(result.body).toContain("Excerpt from one oversized narrative entry");
    expect(result.body).toContain("Completed progress in the current logical turn");
  });

  test("keeps own entries across an omitted foreign entry in source order", () => {
    const acceptedMarker = "<accepted-human-slot>";
    const result = projection({
      maximumCharacters: 600,
      maximumHistoricalCharacters: 0,
      journalBlock: "JOURNAL",
      narrative: {
        ...narrative([
          {
            completeness: "partial",
            provenance: "active_turn",
            entries: ["OWN_BEFORE_FOREIGN"],
          },
          {
            completeness: "complete",
            provenance: "surrounding",
            entries: [`FOREIGN_BETWEEN ${"f".repeat(1_000)}`],
          },
          {
            completeness: "complete",
            provenance: "surrounding",
            entries: [`Human: ${acceptedMarker}`],
          },
          {
            completeness: "partial",
            provenance: "active_turn",
            entries: ["OWN_AFTER_FOREIGN"],
          },
        ]),
        pinnedEntries: [acceptedMarker],
      },
    });
    const body = result.body!;

    expect(body).toContain("OWN_BEFORE_FOREIGN");
    expect(body).toContain("OWN_AFTER_FOREIGN");
    expect(body).toContain(acceptedMarker);
    expect(body).not.toContain("FOREIGN_BETWEEN");
    expect(body.indexOf("OWN_BEFORE_FOREIGN")).toBeLessThan(
      body.indexOf(acceptedMarker),
    );
    expect(body.indexOf(acceptedMarker)).toBeLessThan(body.indexOf("OWN_AFTER_FOREIGN"));
    expect(body.slice(body.indexOf(acceptedMarker), body.indexOf("OWN_AFTER_FOREIGN")))
      .toContain("[Recent]");
    expect(body).toContain("narrative entries omitted");
  });

  test("keeps fresh-turn bounded packing behavior", () => {
    const fullJournal = `[Journal]\n${"large journal ".repeat(20)}`;
    const result = projection({
      maximumCharacters: 240,
      journalBlock: fullJournal,
      recordStatement: `LARGE_RECORD ${"record ".repeat(20)}`,
      narrative: narrative([{
        completeness: "complete",
        entries: [`RECENT_OVERSIZED ${"z".repeat(500)}`],
      }]),
    });

    expect(result.body).not.toBeNull();
    expect(result.body).not.toContain(fullJournal);
    expect(result.body).toStartWith("[Journal");
    expect(result.body).toContain("context omitted");
    expect(result.body).toContain("Excerpt from one oversized narrative entry");
    expect(result.facts.totalCharacters).toBeLessThanOrEqual(240);
    expect(result.body).not.toContain(FOREGROUND_RECORD_CONTEXT_HEADER.trim());
  });
});
