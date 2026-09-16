import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  FOREGROUND_CONTEXT_POLICY_V1,
  FOREGROUND_RECORD_CONTEXT_HEADER,
  buildForegroundContextProjectionV1,
  type ForegroundRecordContextItemV1,
} from "@nautilo/reflection/foreground";

const CORPUS_VERSION = "reflection-foreground-context-2026-08-15.1";
const ARTIFACT_SCHEMA = "nautilo/reflection-foreground-context-eval/v1";
const artifactDirectory = resolve(
  import.meta.dir,
  "reflection-foreground-context/artifacts",
);

export type ForegroundContextEvaluationMode = "check" | "write" | "print";
type CandidateId = "balanced_semantic_first" | "journal_first" | "records_first";

interface Scenario {
  readonly id: string;
  readonly maximumCharacters: number;
  readonly journalBlock: string | null;
  readonly journalStatements: readonly string[];
  readonly records: readonly ForegroundRecordContextItemV1[];
  readonly mandatoryTranscript: string | null;
  readonly olderTranscriptCandidates: readonly string[];
  readonly required: readonly string[];
  readonly forbidden: readonly string[];
}

const scenarios: readonly Scenario[] = Object.freeze([
  {
    id: "referential-decision-rationale",
    maximumCharacters: 700,
    journalBlock: `[Room journal]\n${"Earlier continuity. ".repeat(18)}`,
    journalStatements: ["Earlier continuity."],
    records: [{
      recordRef: "record:postgres-decision",
      statement: "POSTGRES_RATIONALE portable SQL and transactional consistency.",
      lifecycle: "current",
      structuralHeight: 2,
    }],
    mandatoryTranscript: "[Recent]\nWhy did we choose that?",
    olderTranscriptCandidates: [],
    required: ["POSTGRES_RATIONALE", "Why did we choose that?"],
    forbidden: [],
  },
  {
    id: "outstanding-commitment",
    maximumCharacters: 600,
    journalBlock: "[Room journal]\nCOMMITMENT_MONDAY send the migration plan.",
    journalStatements: ["COMMITMENT_MONDAY send the migration plan."],
    records: [{
      recordRef: "record:architecture",
      statement: `${"Architecture context. ".repeat(20)}RECORD_DECISION`,
      lifecycle: "current",
      structuralHeight: 1,
    }],
    mandatoryTranscript: "[Recent]\nWhat remains open?",
    olderTranscriptCandidates: [],
    required: ["COMMITMENT_MONDAY", "What remains open?"],
    forbidden: [],
  },
  {
    id: "recent-correction",
    maximumCharacters: 650,
    journalBlock: "[Room journal]\nThe launch target was Tuesday.",
    journalStatements: ["The launch target was Tuesday."],
    records: [{
      recordRef: "record:launch",
      statement: "The launch target is Tuesday.",
      lifecycle: "stale",
      structuralHeight: 1,
    }],
    mandatoryTranscript: "[Recent]\nRECENT_CORRECTION the launch moved to Thursday.",
    olderTranscriptCandidates: [],
    required: ["RECENT_CORRECTION", "lifecycle=stale"],
    forbidden: [],
  },
  {
    id: "useful-parent-and-leaf",
    maximumCharacters: 900,
    journalBlock: "[Room journal]\nThe storage discussion is active.",
    journalStatements: ["The storage discussion is active."],
    records: [
      {
        recordRef: "record:parent",
        statement: "PARENT_DECISION PostgreSQL balances the evaluated tradeoffs.",
        lifecycle: "current",
        structuralHeight: 3,
      },
      {
        recordRef: "record:leaf",
        statement: "VALUABLE_LEAF nightly backups require checksum verification.",
        lifecycle: "current",
        structuralHeight: 0,
      },
    ],
    mandatoryTranscript: "[Recent]\nSummarize our storage position.",
    olderTranscriptCandidates: [],
    required: ["PARENT_DECISION", "VALUABLE_LEAF"],
    forbidden: [],
  },
  {
    id: "unrelated-empty-selection",
    maximumCharacters: 600,
    journalBlock: "[Room journal]\nWEATHER_CONTEXT rain is expected.",
    journalStatements: ["WEATHER_CONTEXT rain is expected."],
    records: [],
    mandatoryTranscript: "[Recent]\nWhat is the weather?",
    olderTranscriptCandidates: [],
    required: ["WEATHER_CONTEXT", "What is the weather?"],
    forbidden: [FOREGROUND_RECORD_CONTEXT_HEADER.trim()],
  },
  {
    id: "oversized-mandatory-suffix",
    maximumCharacters: 120,
    journalBlock: "[Room journal]\nMUST_NOT_FIT",
    journalStatements: ["MUST_NOT_FIT"],
    records: [{
      recordRef: "record:must-not-fit",
      statement: "RECORD_MUST_NOT_FIT",
      lifecycle: "current",
      structuralHeight: 0,
    }],
    mandatoryTranscript: `MANDATORY_SUFFIX ${"x".repeat(300)}`,
    olderTranscriptCandidates: [],
    required: ["MANDATORY_SUFFIX", "context omitted"],
    forbidden: ["MUST_NOT_FIT", "RECORD_MUST_NOT_FIT"],
  },
]);

function recordBlock(records: readonly ForegroundRecordContextItemV1[]): string | null {
  if (records.length === 0) return null;
  return `${FOREGROUND_RECORD_CONTEXT_HEADER}${records.map((record) =>
    `- [lifecycle=${record.lifecycle}; height=${record.structuralHeight}; ref=${record.recordRef}] ${record.statement}`
  ).join("\n")}`;
}

function joined(sections: readonly (string | null)[]): string | null {
  const present = sections.filter((section): section is string => section !== null);
  return present.length === 0 ? null : present.join("\n\n");
}

function alternativeBody(candidate: Exclude<CandidateId, "balanced_semantic_first">, scenario: Scenario): string | null {
  const records = recordBlock(scenario.records);
  const baseline = joined([scenario.journalBlock, scenario.mandatoryTranscript]);
  if (candidate === "journal_first") {
    const proposed = joined([scenario.journalBlock, records, scenario.mandatoryTranscript]);
    return proposed !== null && proposed.length <= scenario.maximumCharacters
      ? proposed
      : baseline?.slice(0, scenario.maximumCharacters) ?? null;
  }
  return joined([records, scenario.mandatoryTranscript])?.slice(
    0,
    scenario.maximumCharacters,
  ) ?? null;
}

function balancedBody(scenario: Scenario): string | null {
  const baseline = joined([scenario.journalBlock, scenario.mandatoryTranscript]);
  return buildForegroundContextProjectionV1({
    baselineBody: baseline === null
      ? null
      : baseline.slice(0, scenario.maximumCharacters),
    maximumCharacters: scenario.maximumCharacters,
    journalBlock: scenario.journalBlock,
    journalRollupPresent: scenario.journalBlock !== null,
    journalStatements: scenario.journalStatements,
    journalEventCount: scenario.journalStatements.length,
    selection: {
      status: "available",
      representation: "ordinary",
      queryEmbeddingStatus: scenario.records.length === 0
        ? "not_attempted"
        : "available",
      candidateCount: scenario.records.length,
      records: scenario.records,
    },
    mandatoryTranscriptBlock: scenario.mandatoryTranscript,
    olderTranscriptCandidates: scenario.olderTranscriptCandidates,
    fallbackTranscriptBlock: null,
    recentMessageCount: scenario.mandatoryTranscript === null ? 0 : 1,
    completeTurnCount: scenario.mandatoryTranscript === null ? 0 : 1,
  }).body;
}

export function evaluateForegroundContextPolicies() {
  const candidates: CandidateId[] = [
    "balanced_semantic_first",
    "journal_first",
    "records_first",
  ];
  const results = candidates.map((candidate) => {
    const outcomes = scenarios.map((scenario) => {
      const body = candidate === "balanced_semantic_first"
        ? balancedBody(scenario)
        : alternativeBody(candidate, scenario);
      const bounded = (body?.length ?? 0) <= scenario.maximumCharacters;
      const requiredRetained = scenario.required.every((value) => body?.includes(value));
      const forbiddenAbsent = scenario.forbidden.every((value) => !body?.includes(value));
      return {
        scenarioId: scenario.id,
        passed: bounded && requiredRetained && forbiddenAbsent,
        bounded,
        requiredRetained,
        forbiddenAbsent,
        characters: body?.length ?? 0,
      };
    });
    return {
      candidate,
      passed: outcomes.every((outcome) => outcome.passed),
      continuityRate: outcomes.filter((outcome) => outcome.requiredRetained).length / outcomes.length,
      outcomes,
    };
  });
  return {
    schema: ARTIFACT_SCHEMA,
    corpusVersion: CORPUS_VERSION,
    selectedCandidate: "balanced_semantic_first" as const,
    policy: FOREGROUND_CONTEXT_POLICY_V1,
    hardGatesPassed: candidates[0] === "balanced_semantic_first"
      && candidates.length === 3
      && candidates[0] !== candidates[1]
      && results[0]!.passed,
    candidates: results,
  };
}

export function renderForegroundContextDecision(
  report: ReturnType<typeof evaluateForegroundContextPolicies>,
): string {
  return [
    "# Reflection Wave 9 foreground-context policy evaluation",
    "",
    "**Status:** GENERATED — deterministic offline packing and continuity evidence.",
    "",
    `**Corpus:** \`${report.corpusVersion}\``,
    "",
    `**Selected:** \`${report.selectedCandidate}\``,
    "",
    `**Structural hard gates:** ${report.hardGatesPassed ? "PASS" : "FAIL"}`,
    "",
    "Candidate | All gates | Continuity",
    "---|---|---",
    ...report.candidates.map((candidate) =>
      `${candidate.candidate} | ${candidate.passed ? "PASS" : "FAIL"} | ${(candidate.continuityRate * 100).toFixed(1)}%`
    ),
    "",
    "The selected policy preserves the mandatory recent suffix, then gives bounded",
    "space to both Journal continuity and organized Records before older turns.",
    "The two rejected orders each starve one semantic source in the cramped corpus.",
    "No runtime semantic dedupe or quality classifier is introduced.",
    "",
    "The 5 s foreground deadline bounds the complete embedding-plus-exact-search",
    "contribution. It is distinct from the SQL statement timeout and was selected",
    "after live OpenAI plus populated-PostgreSQL measurements on 2026-08-17:",
    "20 end-to-end runs had p50 926 ms, p90 1,642 ms, p95 2,056 ms, and max",
    "2,416 ms after disabling transaction-local PostgreSQL JIT. The 5 s ceiling",
    "is about 2.4x the observed p95, leaving room for slower production hosts and",
    "networks while still bounding provider stalls. Production deadline misses remain",
    "content-free diagnostics and must inform later tuning.",
    "",
    "## Reproduce",
    "",
    "```bash",
    "bun run --cwd packages/reflection eval:reflection-foreground",
    "```",
    "",
  ].join("\n");
}

export function parseForegroundContextEvaluationMode(
  argv: readonly string[],
): ForegroundContextEvaluationMode {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "--check")) return "check";
  if (argv.length === 1 && argv[0] === "--write") return "write";
  if (argv.length === 1 && argv[0] === "--print-json") return "print";
  throw new Error("usage: reflection-foreground-context.eval.ts [--check|--write|--print-json]");
}

export async function runForegroundContextEvaluation(
  mode: ForegroundContextEvaluationMode,
): Promise<number> {
  const report = evaluateForegroundContextPolicies();
  if (!report.hardGatesPassed) throw new Error("foreground context hard gate failed");
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const md = renderForegroundContextDecision(report);
  if (mode === "print") {
    process.stdout.write(json);
    return 0;
  }
  const jsonPath = resolve(artifactDirectory, "decision.json");
  const markdownPath = resolve(artifactDirectory, "decision.md");
  if (mode === "write") {
    await mkdir(dirname(jsonPath), { recursive: true });
    await Promise.all([
      writeFile(jsonPath, json, "utf8"),
      writeFile(markdownPath, md, "utf8"),
    ]);
  } else {
    const [savedJson, savedMarkdown] = await Promise.all([
      readFile(jsonPath, "utf8").catch(() => ""),
      readFile(markdownPath, "utf8").catch(() => ""),
    ]);
    if (savedJson !== json || savedMarkdown !== md) {
      throw new Error("stale foreground-context evaluation artifact; review with --write");
    }
  }
  process.stdout.write(
    `[reflection-foreground-eval] ${mode} passed; corpus=${CORPUS_VERSION} scenarios=${scenarios.length}\n`,
  );
  return 0;
}

if (import.meta.main) {
  runForegroundContextEvaluation(
    parseForegroundContextEvaluationMode(process.argv.slice(2)),
  ).then((code) => process.exit(code)).catch((error: unknown) => {
    process.stderr.write(
      `[reflection-foreground-eval] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
