import type { HierarchyEvaluationReport } from "./types";

export function renderHierarchyMachineReport(report: HierarchyEvaluationReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function renderHierarchyHumanReport(report: HierarchyEvaluationReport): string {
  return [
    "# Reflection Wave 3 synthetic hierarchy evaluation",
    "",
    "**Status:** GENERATED — deterministic, offline, dormant fixture evidence.",
    "",
    `**Corpus:** \`${report.corpusVersion}\``,
    "",
    `**Candidate policy:** \`${report.policyVersion}\``,
    "",
    `**Organizer prompt:** \`${report.promptVersion}\``,
    "",
    `**Structural hard gates:** ${report.structuralHardGatesPassed ? "PASS" : "FAIL"}`,
    "",
    "## Scenario gates",
    "",
    "Scenario | Result | Purpose",
    "---|---|---",
    ...report.scenarios.map((scenario) =>
      `${scenario.id} | ${scenario.passed ? "PASS" : "FAIL"} | ${scenario.description}`
    ),
    "",
    "## Semantic diagnostics",
    "",
    "These diagnostics describe this small corpus. They are not product thresholds.",
    "",
    "```json",
    JSON.stringify(report.semanticDiagnostics, null, 2),
    "```",
    "",
    "## Reproduce",
    "",
    "```bash",
    "bun run --cwd packages/reflection eval:reflection-hierarchy",
    "```",
    "",
  ].join("\n");
}
