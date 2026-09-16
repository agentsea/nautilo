import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { REFLECTION_CANDIDATE_CORPUS } from "./reflection-candidate-policy/corpus";
import { evaluateReflectionCandidatePolicies } from "./reflection-candidate-policy/evaluator";
import {
  renderReflectionDecisionMarkdown,
  renderReflectionMachineReport,
} from "./reflection-candidate-policy/report";

export const REFLECTION_EVAL_JSON_PATH = resolve(
  import.meta.dir,
  "reflection-candidate-policy/artifacts/decision.json",
);
export const REFLECTION_EVAL_MARKDOWN_PATH = resolve(
  import.meta.dir,
  "reflection-candidate-policy/artifacts/decision.md",
);

export type ReflectionEvalMode = "check" | "write" | "print";

export function parseReflectionEvalMode(argv: readonly string[]): ReflectionEvalMode {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "--check")) {
    return "check";
  }
  if (argv.length === 1 && argv[0] === "--write") return "write";
  if (argv.length === 1 && argv[0] === "--print-json") return "print";
  throw new Error("usage: reflection-candidate-policy.eval.ts [--check|--write|--print-json]");
}

async function assertArtifact(path: string, expected: string): Promise<void> {
  let actual: string;
  try {
    actual = await readFile(path, "utf8");
  } catch {
    throw new Error(`missing committed evaluation artifact: ${path}`);
  }
  if (actual !== expected) {
    throw new Error(
      `stale evaluation artifact: ${path}; review the change with --write`,
    );
  }
}

export async function runReflectionCandidateEvaluation(
  mode: ReflectionEvalMode,
): Promise<number> {
  const report = evaluateReflectionCandidatePolicies(REFLECTION_CANDIDATE_CORPUS);
  const json = renderReflectionMachineReport(report);
  const markdown = renderReflectionDecisionMarkdown(report);
  if (mode === "print") {
    process.stdout.write(json);
    return 0;
  }
  if (mode === "write") {
    await mkdir(dirname(REFLECTION_EVAL_JSON_PATH), { recursive: true });
    await Promise.all([
      writeFile(REFLECTION_EVAL_JSON_PATH, json, "utf8"),
      writeFile(REFLECTION_EVAL_MARKDOWN_PATH, markdown, "utf8"),
    ]);
  } else {
    await Promise.all([
      assertArtifact(REFLECTION_EVAL_JSON_PATH, json),
      assertArtifact(REFLECTION_EVAL_MARKDOWN_PATH, markdown),
    ]);
  }
  const summary = report.decisions
    .map((decision) =>
      `${decision.mode}=${decision.outcome === "selected" ? `${decision.policyId}@${decision.bound}` : "reject_all"}`
    )
    .join(" ");
  process.stdout.write(
    `[reflection-candidate-eval] ${mode} passed; corpus=${report.corpusVersion} ${summary}\n`,
  );
  return 0;
}

if (import.meta.main) {
  runReflectionCandidateEvaluation(parseReflectionEvalMode(process.argv.slice(2)))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      process.stderr.write(
        `[reflection-candidate-eval] ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    });
}
