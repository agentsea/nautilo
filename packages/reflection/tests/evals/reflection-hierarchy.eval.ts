import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { evaluateReflectionHierarchy } from "./reflection-hierarchy/evaluator";
import {
  renderHierarchyHumanReport,
  renderHierarchyMachineReport,
} from "./reflection-hierarchy/report";

const jsonPath = resolve(import.meta.dir, "reflection-hierarchy/artifacts/decision.json");
const markdownPath = resolve(import.meta.dir, "reflection-hierarchy/artifacts/decision.md");
type Mode = "check" | "write" | "print";

export function parseHierarchyEvalMode(argv: readonly string[]): Mode {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "--check")) return "check";
  if (argv.length === 1 && argv[0] === "--write") return "write";
  if (argv.length === 1 && argv[0] === "--print-json") return "print";
  throw new Error("usage: reflection-hierarchy.eval.ts [--check|--write|--print-json]");
}

async function requireArtifact(path: string, expected: string): Promise<void> {
  const actual = await readFile(path, "utf8").catch(() => "");
  if (actual !== expected) {
    throw new Error(`stale hierarchy artifact: ${path}; review the change with --write`);
  }
}

export async function runReflectionHierarchyEvaluation(mode: Mode): Promise<number> {
  const report = await evaluateReflectionHierarchy();
  const json = renderHierarchyMachineReport(report);
  const markdown = renderHierarchyHumanReport(report);
  if (mode === "print") {
    process.stdout.write(json);
    return 0;
  }
  if (mode === "write") {
    await mkdir(dirname(jsonPath), { recursive: true });
    await Promise.all([
      writeFile(jsonPath, json, "utf8"),
      writeFile(markdownPath, markdown, "utf8"),
    ]);
  } else {
    await Promise.all([
      requireArtifact(jsonPath, json),
      requireArtifact(markdownPath, markdown),
    ]);
  }
  process.stdout.write(
    `[reflection-hierarchy-eval] ${mode} passed; corpus=${report.corpusVersion} scenarios=${report.scenarios.length}\n`,
  );
  return 0;
}

if (import.meta.main) {
  runReflectionHierarchyEvaluation(parseHierarchyEvalMode(process.argv.slice(2)))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      process.stderr.write(
        `[reflection-hierarchy-eval] ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    });
}
