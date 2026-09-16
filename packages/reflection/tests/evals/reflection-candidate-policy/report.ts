import type {
  AggregateEvaluationResult,
  CandidatePolicyId,
  PolicyDecision,
  ReflectionEvaluationReport,
} from "./types";

const POLICY_LABELS: Readonly<Record<CandidatePolicyId, string>> = Object.freeze({
  semantic_neighbors: "Semantic neighbors",
  existing_parent: "Existing-parent routing",
  temporal_room_anchor: "Temporal/Room-anchor local",
});

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function gateLabel(result: AggregateEvaluationResult): string {
  return result.aggregate.hardGatesPassed ? "PASS" : "REJECT";
}

function decisionLabel(decision: PolicyDecision): string {
  if (decision.outcome === "reject_all" || !decision.policyId) return "`reject_all`";
  return `${POLICY_LABELS[decision.policyId]} at bound ${decision.bound}`;
}

function resultRow(result: AggregateEvaluationResult): string {
  return [
    result.mode === "same_room" ? "Same Room" : "Cross Room",
    result.id,
    String(result.bound),
    gateLabel(result),
    percent(result.aggregate.meanRecall),
    percent(result.aggregate.meanContamination),
    String(result.aggregate.totalSelected),
    String(result.aggregate.totalCompared),
  ].join(" | ");
}

function selectedResult(
  report: ReflectionEvaluationReport,
  decision: PolicyDecision,
): AggregateEvaluationResult | undefined {
  return report.candidatePolicies.find((result) =>
    result.mode === decision.mode
    && result.id === decision.policyId
    && result.bound === decision.bound
  );
}

export function renderReflectionMachineReport(
  report: ReflectionEvaluationReport,
): string {
  const summarize = (result: AggregateEvaluationResult) => ({
    id: result.id,
    kind: result.kind,
    mode: result.mode,
    bound: result.bound,
    aggregate: result.aggregate,
    failedFixtures: result.fixtures
      .filter((fixture) => !fixture.gates.passed)
      .map((fixture) => ({
        fixtureId: fixture.fixtureId,
        failures: fixture.gates.failures,
      })),
  });
  const selectedEvidence = report.decisions.map((decision) => {
    const result = selectedResult(report, decision);
    return {
      mode: decision.mode,
      policyId: decision.policyId,
      bound: decision.bound,
      fixtures: result?.fixtures.map((fixture) => ({
        fixtureId: fixture.fixtureId,
        selectedIds: fixture.selectedIds,
        metrics: fixture.metrics,
        gates: fixture.gates,
      })) ?? [],
    };
  });
  return `${JSON.stringify({
    schema: report.schema,
    corpusVersion: report.corpusVersion,
    policyVersion: report.policyVersion,
    boundGrid: report.boundGrid,
    baselineBound: report.baselineBound,
    semanticMinimumScore: report.semanticMinimumScore,
    baselines: report.baselines.map(summarize),
    candidatePolicies: report.candidatePolicies.map(summarize),
    decisions: report.decisions,
    selectedEvidence,
  }, null, 2)}\n`;
}

export function renderReflectionDecisionMarkdown(
  report: ReflectionEvaluationReport,
): string {
  const lines: string[] = [
    "# Reflection Wave 1 candidate-policy decision",
    "",
    "**Status:** GENERATED — deterministic offline result; no production behavior.",
    "",
    `**Corpus:** \`${report.corpusVersion}\``,
    "",
    `**Policy:** \`${report.policyVersion}\``,
    "",
    `**Candidate bounds:** ${report.boundGrid.map((bound) => `\`${bound}\``).join(", ")}`,
    "",
    "## Decision",
    "",
    "| Mode | Outcome | Reason |",
    "|---|---|---|",
    ...report.decisions.map((decision) =>
      `| ${decision.mode === "same_room" ? "Same Room" : "Cross Room"} | ${decisionLabel(decision)} | ${decision.reason} |`
    ),
    "",
    "The selection rule is deterministic: reject every policy/bound with an",
    "authority, forbidden-exposure, required-reachability, or repeat-stability",
    "failure; among passing results, minimize contamination, then compared work,",
    "then bound, then implementation simplicity. No aggregate score can rescue a",
    "hard-gate failure.",
    "",
    "## Candidate-policy scorecard",
    "",
    "Mode | Policy | Bound | Gates | Mean recall | Mean contamination | Selected | Compared",
    "---|---|---:|---|---:|---:|---:|---:",
    ...report.candidatePolicies.map(resultRow),
    "",
    "## Current-behavior baselines",
    "",
    "These are characterization views, not candidate-policy contenders. Memory",
    "uses the current cosine-similarity ordering shape over eligible authored",
    "Memories; Journal/recent uses authorized Room-local chronological context;",
    "flat combined ranks authorized Memory and Journal items together.",
    "",
    "Mode | Baseline | Bound | Gates | Mean recall | Mean contamination | Selected | Compared",
    "---|---|---:|---|---:|---:|---:|---:",
    ...report.baselines.map(resultRow),
    "",
    "## Selected-policy fixture evidence",
    "",
  ];

  for (const decision of report.decisions) {
    lines.push(
      `### ${decision.mode === "same_room" ? "Same Room" : "Cross Room"}`,
      "",
    );
    const result = selectedResult(report, decision);
    if (!result) {
      lines.push("No policy passed every hard gate.", "");
      continue;
    }
    lines.push(
      "| Fixture | Selected candidates | Recall | Contamination | Gates |",
      "|---|---|---:|---:|---|",
      ...result.fixtures.map((fixture) =>
        `| ${fixture.fixtureId} | ${fixture.selectedIds.map((id) => `\`${id}\``).join(", ") || "—"} | ${percent(fixture.metrics.usefulNeighborRecall)} | ${percent(fixture.metrics.contaminationRate)} | ${fixture.gates.passed ? "PASS" : fixture.gates.failures.join(", ")} |`
      ),
      "",
    );
  }

  lines.push(
    "## Interpretation",
    "",
    "Semantic neighbors are the smallest tested policy that reliably bootstraps",
    "new clusters at every structural height and crosses Room anchors after exact",
    "invocation-Namespace filtering. Existing-parent routing is useful only after",
    "structure already exists. Temporal/anchor-local routing admits substantial",
    "same-Room noise at its only passing bound and cannot discover the deliberately",
    "unanchored cross-Room relationship.",
    "",
    "The selected bounds are experimental operating inputs, not permanent limits",
    "on parent count, graph fan-out, hierarchy depth, or accumulated knowledge.",
    "",
    "## Hard-gate evidence",
    "",
    "- Exact disjunctive authority-alternative eligibility, including the virtual",
    "  public-boundary marker, is resolved before a policy receives a semantic",
    "  candidate view or requests a recorded similarity.",
    "- Inaccessible and sunset Records contribute no selected ID, score, semantic",
    "  open, considered ID, or aggregate diagnostic count.",
    "- Every fixture-declared required relationship is present within the selected",
    "  bounded neighborhood.",
    "- Two independent executions serialize to the same result for every fixture.",
    "- Strict corpus validation rejects malformed, duplicate, cyclic, unknown, or",
    "  authority-inconsistent fixture structure before evaluation.",
    "",
    "## Limitations",
    "",
    "- The corpus is synthetic and the semantic similarities are committed outputs",
    "  of a deterministic fake embedding port. They establish policy shape and",
    "  authority ordering, not production retrieval quality.",
    "- This wave evaluates candidate generation only. It does not evaluate model",
    "  parent synthesis, Organizer judgment, Sleep, lifecycle publication, or full",
    "  graph correctness.",
    "- Compared-item counts are deterministic work estimates. Wall-clock timing is",
    "  intentionally not a portable hard gate.",
    "- Cross-Room fixtures reproduce exact alternative and public-boundary",
    "  semantics without running a database, cryptographic grant lifecycle,",
    "  server, or production worker.",
    "- The decision must be revisited with new benchmark evidence if real Organizer",
    "  evaluation shows recurring information loss, excessive embedding cost, or",
    "  structural redundancy.",
    "",
    "## Reproduction",
    "",
    "```bash",
    "bun run --cwd packages/reflection eval:reflection-candidates",
    "```",
    "",
    "The command validates the corpus, recomputes both artifacts, and fails if the",
    "committed JSON or Markdown differs. Use the explicitly non-default `--write`",
    "maintenance mode only when intentionally reviewing a corpus or policy change.",
  );
  return `${lines.join("\n")}\n`;
}
