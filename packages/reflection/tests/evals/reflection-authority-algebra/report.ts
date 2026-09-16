import type { AuthorityAlgebraReport } from "./evaluator";

export function renderAuthorityAlgebraMachineReport(report: AuthorityAlgebraReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function renderAuthorityAlgebraHumanReport(report: AuthorityAlgebraReport): string {
  return [
    "# Reflection Wave 5 authority-algebra feasibility benchmark",
    "",
    "**Status:** GENERATED — deterministic offline authority corpus with measured local latency.",
    "",
    `**Corpus:** \`${report.corpusVersion}\``,
    "",
    `**Hard gates:** ${report.hardGatesPassed ? "PASS" : "FAIL"}`,
    "",
    "Scenario | Result | Leaves | Input choices | Peak | Final | Pruned | Operations | Resumptions | Checkpoint bytes | Observed / budget ms",
    "---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:",
    ...report.scenarios.map((scenario) =>
      `${scenario.id} | ${scenario.passed ? "PASS" : "FAIL"} | ${scenario.inputLeafCount} | ${scenario.inputAlternativeCount} | ${scenario.intermediatePeakAlternativeCount} | ${scenario.finalAlternativeCount} | ${scenario.dominancePrunedCount} | ${scenario.operations} | ${scenario.resumptions} | ${scenario.maxCheckpointBytes} | ${scenario.observedLatencyMs.toFixed(3)} / ${scenario.latencyBudgetMs}`
    ),
    "",
    "Latency is environment-specific evidence. Check mode re-runs its ceiling gate while comparing all deterministic fields to this reviewed artifact.",
    "",
    "```bash",
    "bun run --cwd packages/reflection eval:reflection-authority",
    "```",
    "",
  ].join("\n");
}
