/**
 * D563 5.3.4 — model-attempt timer ownership invariant.
 *
 * This is intentionally a structural rule, not a second limit policy. The
 * limit scanner/ledger records new facts; this test protects one architectural
 * fact that a reviewed ledger row cannot express: Agent and Runtime must not
 * grow a second local model-attempt clock.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const REPOSITORY_ROOT = join(import.meta.dir, "../../..");
const CANONICAL_OWNER = "packages/agent/src/utils/model-attempt-policy.ts";
const PROTECTED_FILES = [
  "packages/agent/src/utils/chat-model-invocation.ts",
  "packages/runtime/src/executors/langgraph-executor.ts",
] as const;
const LEGACY_DECLARATIONS = [
  "MODEL_STREAM_FIRST_TOKEN_TIMEOUT_MS",
  "MODEL_STREAM_FIRST_TOKEN_TIMEOUT_REASONING_MS",
  "FOREGROUND_PROVIDER_TIMEOUT_MS",
  "FIRST_PROGRESS_WATCH_POLL_MS",
  "FIRST_TOKEN_WATCH_POLL_MS",
  "MODEL_STREAM_IDLE_TIMEOUT_MS",
  "MODEL_STREAM_IDLE_TIMEOUT_REASONING_MS",
  "MODEL_STREAM_OVERALL_TIMEOUT_MS",
  "ModelStreamTimeoutState",
] as const;

type SourceMap = ReadonlyMap<string, string>;

type SourceFacts = {
  readonly timerCalls: readonly { name: string; line: number }[];
  readonly legacyDeclarations: readonly { name: string; line: number }[];
  readonly supervisorClasses: number;
};

function sourceFacts(path: string, content: string): SourceFacts {
  const sourceFile = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const timerCalls: { name: string; line: number }[] = [];
  const legacyDeclarations: { name: string; line: number }[] = [];
  let supervisorClasses = 0;
  const legacyNames = new Set<string>(LEGACY_DECLARATIONS);

  const line = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (ts.isIdentifier(expression) && (expression.text === "setTimeout" || expression.text === "setInterval")) {
        timerCalls.push({ name: expression.text, line: line(node) });
      } else if (
        ts.isPropertyAccessExpression(expression)
        && ts.isIdentifier(expression.expression)
        && expression.expression.text === "AbortSignal"
        && expression.name.text === "timeout"
      ) {
        timerCalls.push({ name: "AbortSignal.timeout", line: line(node) });
      }
    }
    if (ts.isClassDeclaration(node) && node.name?.text === "ModelAttemptSupervisor") {
      supervisorClasses += 1;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && legacyNames.has(node.name.text)) {
      legacyDeclarations.push({ name: node.name.text, line: line(node) });
    }
    if (ts.isClassDeclaration(node) && node.name && legacyNames.has(node.name.text)) {
      legacyDeclarations.push({ name: node.name.text, line: line(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { timerCalls, legacyDeclarations, supervisorClasses };
}

function ownershipViolations(sources: SourceMap): string[] {
  const errors: string[] = [];
  const canonical = sources.get(CANONICAL_OWNER);
  if (canonical === undefined) {
    errors.push(`missing canonical owner: ${CANONICAL_OWNER}`);
  } else {
    const facts = sourceFacts(CANONICAL_OWNER, canonical);
    if (facts.supervisorClasses !== 1) {
      errors.push(`${CANONICAL_OWNER} must contain exactly one ModelAttemptSupervisor class`);
    }
    if (facts.timerCalls.length === 0) {
      errors.push(`${CANONICAL_OWNER} must contain the model-attempt timer implementation`);
    }
  }

  for (const path of PROTECTED_FILES) {
    const content = sources.get(path);
    if (content === undefined) {
      errors.push(`missing protected source: ${path}`);
      continue;
    }
    const facts = sourceFacts(path, content);
    for (const timer of facts.timerCalls) {
      errors.push(`${path}:${timer.line} directly calls ${timer.name}; model-attempt clocks belong only to ${CANONICAL_OWNER}`);
    }
    for (const declaration of facts.legacyDeclarations) {
      errors.push(`${path}:${declaration.line} redeclares legacy model-attempt timer ${declaration.name}`);
    }
  }
  return errors;
}

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return entry.isFile() && entry.name.endsWith(".ts") ? [absolute] : [];
  });
}

function checkedSources(): Map<string, string> {
  const paths = [CANONICAL_OWNER, ...PROTECTED_FILES];
  return new Map(paths.map((path) => [path, readFileSync(join(REPOSITORY_ROOT, path), "utf8")]));
}

describe("D563 model-attempt timer ownership", () => {
  test("keeps the canonical supervisor as the sole implementation owner", () => {
    const owners = sourceFiles(join(REPOSITORY_ROOT, "packages/agent/src/utils"))
      .filter((absolute) => sourceFacts(relative(REPOSITORY_ROOT, absolute), readFileSync(absolute, "utf8")).supervisorClasses > 0)
      .map((absolute) => relative(REPOSITORY_ROOT, absolute));
    expect(owners).toEqual([CANONICAL_OWNER]);
    expect(ownershipViolations(checkedSources())).toEqual([]);
  });

  test("rejects a direct Agent model clock", () => {
    const sources = new Map<string, string>([
      [CANONICAL_OWNER, "export class ModelAttemptSupervisor { start() { setTimeout(() => {}, 1000); } }"],
      [PROTECTED_FILES[0], "export function invoke() { setInterval(() => {}, 1000); }"],
      [PROTECTED_FILES[1], "export function execute() { return true; }"],
    ]);
    expect(ownershipViolations(sources).join("\n")).toContain(`${PROTECTED_FILES[0]}:1 directly calls setInterval`);
  });

  test("rejects a direct Runtime model clock and legacy declaration", () => {
    const sources = new Map<string, string>([
      [CANONICAL_OWNER, "export class ModelAttemptSupervisor { start() { AbortSignal.timeout(1000); } }"],
      [PROTECTED_FILES[0], "export function invoke() { return true; }"],
      [PROTECTED_FILES[1], "const MODEL_STREAM_OVERALL_TIMEOUT_MS = 600000; export function execute() { setTimeout(() => {}, MODEL_STREAM_OVERALL_TIMEOUT_MS); }"],
    ]);
    const errors = ownershipViolations(sources).join("\n");
    expect(errors).toContain(`${PROTECTED_FILES[1]}:1 directly calls setTimeout`);
    expect(errors).toContain(`${PROTECTED_FILES[1]}:1 redeclares legacy model-attempt timer MODEL_STREAM_OVERALL_TIMEOUT_MS`);
  });

  test("does not inspect unrelated timers outside the protected files", () => {
    const sources = new Map<string, string>([
      [CANONICAL_OWNER, "export class ModelAttemptSupervisor { start() { setTimeout(() => {}, 1000); } }"],
      [PROTECTED_FILES[0], "export function invoke() { return true; }"],
      [PROTECTED_FILES[1], "export function execute() { return true; }"],
      ["packages/agent/src/utils/other-lifecycle.ts", "export function sweep() { setInterval(() => {}, 1000); }"],
    ]);
    expect(ownershipViolations(sources)).toEqual([]);
  });
});
