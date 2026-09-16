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
    baselineBody: "JOURNAL\n\nRECENT",
    maximumCharacters: 2_000,
    journalBlock: "JOURNAL",
    journalRollupPresent: true,
    journalStatements: ["Ship on Tuesday."],
    journalEventCount: 1,
    selection: available(),
    mandatoryTranscriptBlock: "RECENT",
    olderTranscriptCandidates: [],
    fallbackTranscriptBlock: null,
    recentMessageCount: 2,
    completeTurnCount: 1,
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
    expect(unavailable.body).toBe("JOURNAL\n\nRECENT");
    expect(empty.body).toBe("JOURNAL\n\nRECENT");
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
      mandatoryTranscriptBlock: "[Recent]\nWhy did we choose that?",
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

  test("preserves an indivisible mandatory suffix while it fits", () => {
    const mandatory = `RECENT ${"r".repeat(350)}`;
    const result = projection({
      maximumCharacters: 500,
      journalBlock: `JOURNAL ${"j".repeat(400)}`,
      mandatoryTranscriptBlock: mandatory,
      olderTranscriptCandidates: [`OLDER\n${mandatory}`],
    });
    expect(result.body!.length).toBeLessThanOrEqual(500);
    expect(result.body).toContain(mandatory);
    expect(result.body).not.toContain("OLDER");
  });

  test("retains the characterized clamp when the mandatory suffix alone is oversized", () => {
    const result = projection({
      maximumCharacters: 100,
      mandatoryTranscriptBlock: `RECENT ${"r".repeat(500)}`,
    });
    expect(result.body).toHaveLength(100);
    expect(result.body).toContain("context omitted");
    expect(result.body).not.toContain(FOREGROUND_RECORD_CONTEXT_HEADER.trim());
    expect(result.facts.mandatorySuffixExhaustedBudget).toBe(true);
    expect(result.facts.recordPackedCount).toBe(0);
  });

  test("admits older transcript only after bounded Journal and Records", () => {
    const result = projection({
      maximumCharacters: 1_000,
      journalBlock: "JOURNAL",
      mandatoryTranscriptBlock: "RECENT",
      olderTranscriptCandidates: ["OLDER TURN\nRECENT"],
    });
    expect(result.body).toContain("JOURNAL");
    expect(result.body).toContain(FOREGROUND_RECORD_CONTEXT_HEADER.trim());
    expect(result.body).toContain("OLDER TURN");
    expect(result.body!.length).toBeLessThanOrEqual(1_000);
  });

  test("packs coherent Record lines instead of splicing two bounded items", () => {
    const result = projection({
      baselineBody: null,
      maximumCharacters: 260,
      journalBlock: null,
      journalRollupPresent: false,
      mandatoryTranscriptBlock: null,
      completeTurnCount: 0,
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
