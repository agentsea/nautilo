import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  evaluateAuthorityAlgebra,
  stableAuthorityAlgebraEvidence,
} from "./reflection-authority-algebra/evaluator";
import {
  renderAuthorityAlgebraHumanReport,
  renderAuthorityAlgebraMachineReport,
} from "./reflection-authority-algebra/report";

const jsonPath = resolve(import.meta.dir, "reflection-authority-algebra/artifacts/decision.json");
const markdownPath = resolve(import.meta.dir, "reflection-authority-algebra/artifacts/decision.md");
type Mode = "check" | "write" | "print";

export function parseAuthorityAlgebraEvalMode(argv: readonly string[]): Mode {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "--check")) return "check";
  if (argv.length === 1 && argv[0] === "--write") return "write";
  if (argv.length === 1 && argv[0] === "--print-json") return "print";
  throw new Error("usage: reflection-authority-algebra.eval.ts [--check|--write|--print-json]");
}

export async function runAuthorityAlgebraEvaluation(mode: Mode): Promise<number> {
  const report = evaluateAuthorityAlgebra();
  if (!report.hardGatesPassed) throw new Error("authority algebra feasibility gate failed");
  if (mode === "print") {
    process.stdout.write(renderAuthorityAlgebraMachineReport(report));
    return 0;
  }
  if (mode === "write") {
    await mkdir(dirname(jsonPath), { recursive: true });
    await Promise.all([
      writeFile(jsonPath, renderAuthorityAlgebraMachineReport(report), "utf8"),
      writeFile(markdownPath, renderAuthorityAlgebraHumanReport(report), "utf8"),
    ]);
  } else {
    const reviewed = JSON.parse(await readFile(jsonPath, "utf8")) as unknown;
    if (
      JSON.stringify(stableAuthorityAlgebraEvidence(report))
      !== JSON.stringify(stableAuthorityAlgebraEvidence(reviewed as typeof report))
    ) {
      throw new Error("stale authority-algebra artifact; review the change with --write");
    }
    await readFile(markdownPath, "utf8");
  }
  const latency = Math.max(...report.scenarios.map((scenario) => scenario.observedLatencyMs));
  process.stdout.write(
    `[reflection-authority-eval] ${mode} passed; corpus=${report.corpusVersion} scenarios=${report.scenarios.length} maxLatencyMs=${latency.toFixed(3)}\n`,
  );
  return 0;
}

if (import.meta.main) {
  runAuthorityAlgebraEvaluation(parseAuthorityAlgebraEvalMode(process.argv.slice(2)))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      process.stderr.write(
        `[reflection-authority-eval] ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    });
}
