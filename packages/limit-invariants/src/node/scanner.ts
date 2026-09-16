import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import ts from "typescript";
import type {
  ExtractionConfidence,
  LimitEffect,
  LimitObservation,
  LimitDetectorCoverage,
  LimitInvestigationLink,
  LimitReachability,
  LimitScanEvidence,
  LimitSourceKind,
  LimitLane,
  MechanicalPriority,
} from "../model";

const DEFAULT_SOURCE_ROOTS = [
  ".github",
  "apps",
  "bin",
  "deploy",
  "dev",
  "infra",
  "native",
  "ops",
  "packages",
  "packaging",
  "scripts",
] as const;

const CODE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".stryker-tmp",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "release",
]);
const EXCLUDED_PREFIXES = [
  // app-builder emits source-hashed bundles here; authored app source remains
  // in the inventory. Re-scanning these local copies is duplicate build output.
  "packages/first-party-apps/.cache/",
  "packages/limit-invariants/",
  "packages/query-invariants/baseline/",
  "packages/encryption-invariants/baseline/",
  // This exact prefix is the generated Wafflebase engine closure. Its pinned
  // upstream source and built files are hash-verified separately; all authored
  // spreadsheet siblings remain in the limit inventory. Like dist directories,
  // scanning the generated copy would qualify build output rather than policy.
  "packages/first-party-apps/spreadsheet/engine/",
  "packages/first-party-apps/presentation/engine/",
  "packages/first-party-apps/board/engine/",
];
const EXPLICIT_BOUNDARY_NAME = /(?:^|_)(?:cap|ceiling|cutoff|limit|max(?:imum)?|timeout|ttl|retention|expiry|expiration|truncate)(?:_|$)/u;
const SIZED_BOUNDARY_NAME = /(?:^|_)(?:batch|body|buffer|chunk|content|file|frame|inline|items?|output|page|payload|response|result|text)(?:_)?(?:bytes?|chars?|characters?|items?|size|tokens?)(?:_|$)/u;
const REASON_LENGTH_NAME = /(?:^|_)reason(?:_|.*_)length(?:_|$)/u;
const COUNTED_BOUNDARY_NAME = /(?:^|_)(?:retries|sample_count)(?:_|$)/u;
const TIMED_BOUNDARY_NAME = /(?:^|_)(?:duration|idle|lease|poll)(?:_)?(?:hours?|hrs?|milliseconds?|millis|minutes?|mins?|ms|seconds?|secs?)(?:_|$)/u;
const UNIT_NAME_PATTERNS: readonly [RegExp, string][] = [
  [/(?:^|[_-])(?:ms|millis|milliseconds?)(?:$|[_-])/iu, "milliseconds"],
  [/(?:^|[_-])(?:seconds?|secs?)(?:$|[_-])/iu, "seconds"],
  [/(?:^|[_-])(?:minutes?|mins?)(?:$|[_-])/iu, "minutes"],
  [/(?:^|[_-])(?:hours?|hrs?)(?:$|[_-])/iu, "hours"],
  [/(?:^|[_-])days?(?:$|[_-])/iu, "days"],
  [/(?:^|[_-])bytes?(?:$|[_-])/iu, "bytes"],
  [/(?:^|[_-])(?:chars?|characters?)(?:$|[_-])/iu, "characters"],
  [/(?:^|[_-])(?:attempts?|retries)(?:$|[_-])/iu, "attempts"],
];

type ResolvedValue = {
  readonly display: string;
  readonly numeric?: number;
};

type Candidate = {
  readonly path: string;
  readonly line: number;
  readonly symbol: string;
  readonly owner: string;
  readonly sourceKind: LimitSourceKind;
  readonly detector: string;
  readonly effect: LimitEffect;
  readonly value: string;
  readonly unit: string;
  readonly reachability: LimitReachability;
  readonly extractionConfidence: ExtractionConfidence;
  readonly mechanicalPriority: MechanicalPriority;
  readonly reasonCode: string;
  readonly normalizedExpression: string;
  readonly anchor: string;
  readonly lane: LimitLane;
};

export type ScanOptions = {
  readonly sourceRoots?: readonly string[];
  readonly lanes?: readonly LimitLane[];
};

export const LIMIT_DETECTOR_COVERAGE: LimitDetectorCoverage = {
  recordType: "coverage",
  supportedSourceKinds: ["typescript", "json", "yaml", "shell", "toml"],
  supportedSyntax: [
    "TypeScript/JavaScript named numeric declarations and properties",
    "TypeScript/JavaScript direct numeric returns and yields from boundary-named helpers",
    "TypeScript/JavaScript reduction, timeout, pagination, schema, retry, chunk, clamp, comparison, and concurrency sinks",
    "JSON numeric boundary keys and embedded timeout command arguments",
    "YAML, shell, and TOML numeric boundary assignments plus shell timeout commands",
    "String.raw numeric boundary interpolation links in generated TypeScript/JavaScript programs",
    "relative TypeScript/JavaScript imports, callers, continuation-shaped symbols, and exact mechanical policy-family references",
  ],
  unsupportedSyntax: [
    "semantic legitimacy, authority, acceptable loss, approval, and remediation decisions",
    "runtime-only values that cannot be resolved from repository source",
    "type-resolved re-export chains and non-relative package export maps",
    "generated programs whose boundary is assembled without a host numeric interpolation",
    "languages and binary formats outside the listed source kinds",
  ],
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isSuspiciousName(value: string): boolean {
  const normalized = value.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").replace(/-/gu, "_").toLowerCase();
  return EXPLICIT_BOUNDARY_NAME.test(normalized)
    || SIZED_BOUNDARY_NAME.test(normalized)
    || REASON_LENGTH_NAME.test(normalized)
    || COUNTED_BOUNDARY_NAME.test(normalized)
    || TIMED_BOUNDARY_NAME.test(normalized);
}

function portablePath(value: string): string {
  return value.split(sep).join("/");
}

function ownerFor(path: string): string {
  const parts = path.split("/");
  if (parts[0] === ".github") return ".github";
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0] ?? "repository";
}

function reachabilityFor(path: string): LimitReachability {
  if (/(?:^|\/)(?:generated|dist|build)(?:\/|$)/iu.test(path)) return "generated";
  if (/(?:^|\/)(?:vendor|vendored|third_party)(?:\/|$)/iu.test(path)) return "vendor";
  if (/(?:^|\/)(?:migrations?|drizzle)(?:\/|$)/iu.test(path)) return "migration_history";
  if (/(?:^|\/)(?:tests?|__tests__|fixtures?|harnesses)(?:\/|$)|[.](?:spec|test)[.]/iu.test(path)) return "test";
  if (/^(?:[.]github|bin|deploy|dev|infra|ops|packaging|scripts)\//u.test(path)) return "operator_ci";
  if (/(?:external|third-party|provider)/iu.test(path)) return "external";
  return "live";
}

function sourceKindFor(path: string): LimitSourceKind | undefined {
  const extension = extname(path).toLowerCase();
  if (CODE_EXTENSIONS.has(extension)) return "typescript";
  if (extension === ".json") return "json";
  if (extension === ".yaml" || extension === ".yml") return "yaml";
  if (extension === ".sh" || extension === ".bash") return "shell";
  if (extension === ".toml") return "toml";
  return undefined;
}

function shouldScan(path: string): boolean {
  return sourceKindFor(path) !== undefined
    && !EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix))
    && path !== "bun.lock"
    && path !== "package-lock.json";
}

async function sourceFiles(repositoryRoot: string, sourceRoots: readonly string[]): Promise<string[]> {
  const results: string[] = [];
  const pending = sourceRoots.map((root) => resolve(repositoryRoot, root));
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) break;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) pending.push(absolute);
        continue;
      }
      const path = portablePath(relative(repositoryRoot, absolute));
      if (entry.isFile() && shouldScan(path)) results.push(path);
    }
  }
  return [...new Set(results)].sort(compareText);
}

function normalizeExpression(value: string): string {
  return value.replace(/\/\*[\s\S]*?\*\//gu, " ").replace(/\/\/[^\n\r]*/gu, " ").replace(/\s+/gu, " ").trim();
}

function locatorShape(item: Candidate): string {
  if (item.detector.startsWith("named:") || item.detector.startsWith("json:")) return item.detector;
  return item.normalizedExpression.replace(/\b(?:0[xob])?[\d][\d_.]*\b/giu, "#");
}

function lineFor(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function namedSymbol(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
  if (
    (ts.isFunctionDeclaration(node)
      || ts.isMethodDeclaration(node)
      || ts.isGetAccessorDeclaration(node)
      || ts.isSetAccessorDeclaration(node))
    && node.name
  ) return node.name.getText(sourceFile);
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
    && ts.isVariableDeclaration(node.parent)
    && ts.isIdentifier(node.parent.name)
  ) return node.parent.name.text;
  return undefined;
}

function enclosingSymbol(node: ts.Node, sourceFile: ts.SourceFile): string {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    const name = namedSymbol(current, sourceFile);
    if (name) return name;
  }
  return "<module>";
}

function aliasesFor(sourceFile: ts.SourceFile): ReadonlyMap<string, ts.Expression> {
  const aliases = new Map<string, ts.Expression>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      aliases.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return aliases;
}

function aliasSymbolsFor(sourceFile: ts.SourceFile): ReadonlyMap<string, string> {
  const symbols = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      symbols.set(node.name.text, enclosingSymbol(node, sourceFile));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return symbols;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current)
    || ts.isParenthesizedExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isTypeAssertionExpression(current)
  ) current = current.expression;
  return current;
}

function resolveValue(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  aliases: ReadonlyMap<string, ts.Expression>,
  visited: ReadonlySet<string> = new Set(),
): ResolvedValue {
  const target = unwrap(expression);
  if (ts.isNumericLiteral(target)) return { display: target.text, numeric: Number(target.text.replaceAll("_", "")) };
  if (ts.isStringLiteralLike(target)) {
    const numeric = Number(target.text.replaceAll("_", ""));
    return Number.isFinite(numeric) ? { display: JSON.stringify(target.text), numeric } : { display: JSON.stringify(target.text) };
  }
  if (target.kind === ts.SyntaxKind.TrueKeyword || target.kind === ts.SyntaxKind.FalseKeyword) {
    return { display: target.kind === ts.SyntaxKind.TrueKeyword ? "true" : "false" };
  }
  if (ts.isPrefixUnaryExpression(target)) {
    const inner = resolveValue(target.operand, sourceFile, aliases, visited);
    if (inner.numeric !== undefined) {
      const numeric = target.operator === ts.SyntaxKind.MinusToken ? -inner.numeric : inner.numeric;
      return { display: String(numeric), numeric };
    }
  }
  if (ts.isIdentifier(target)) {
    if (visited.has(target.text)) return { display: `unresolved:${target.text}` };
    const alias = aliases.get(target.text);
    if (alias) return resolveValue(alias, sourceFile, aliases, new Set([...visited, target.text]));
    return { display: `unresolved:${target.text}` };
  }
  if (ts.isBinaryExpression(target)) {
    const left = resolveValue(target.left, sourceFile, aliases, visited);
    const right = resolveValue(target.right, sourceFile, aliases, visited);
    if (left.numeric !== undefined && right.numeric !== undefined) {
      const operators = new Map<ts.SyntaxKind, (a: number, b: number) => number>([
        [ts.SyntaxKind.PlusToken, (a, b) => a + b],
        [ts.SyntaxKind.MinusToken, (a, b) => a - b],
        [ts.SyntaxKind.AsteriskToken, (a, b) => a * b],
        [ts.SyntaxKind.SlashToken, (a, b) => a / b],
      ]);
      const operation = operators.get(target.operatorToken.kind);
      if (operation) {
        const numeric = operation(left.numeric, right.numeric);
        if (Number.isFinite(numeric)) return { display: String(numeric), numeric };
      }
    }
  }
  return { display: `unresolved:${normalizeExpression(target.getText(sourceFile))}` };
}

function isNumericArithmeticLiteral(expression: ts.Expression): boolean {
  const target = unwrap(expression);
  if (ts.isNumericLiteral(target)) return true;
  if (ts.isPrefixUnaryExpression(target)) return isNumericArithmeticLiteral(target.operand);
  return ts.isBinaryExpression(target)
    && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken]
      .includes(target.operatorToken.kind)
    && isNumericArithmeticLiteral(target.left)
    && isNumericArithmeticLiteral(target.right);
}

function unitFor(name: string): string {
  const normalized = name.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").replace(/-/gu, "_").toLowerCase();
  if (REASON_LENGTH_NAME.test(normalized)) return "characters";
  if (/(?:^|_)inline(?:_.*)?_?bytes?(?:_|$)/u.test(normalized)) return "bytes";
  for (const [pattern, unit] of UNIT_NAME_PATTERNS) if (pattern.test(name)) return unit;
  if (/(?:payload|file|body|frame|buffer)/iu.test(name)) return "bytes";
  if (/(?:timeout|interval|duration|idle|lease|poll)/iu.test(name)) return "milliseconds";
  if (/(?:retry|retries|attempt)/iu.test(name)) return "attempts";
  return "count";
}

function effectForName(name: string): LimitEffect {
  const lower = name.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").replace(/-/gu, "_").toLowerCase();
  if (/(?:reason|message|text|label|name|description).*length|length.*(?:reason|message|text|label|name|description)/u.test(lower)) return "bound";
  if (/(?:timeout|interval|duration|idle|lease|poll)/u.test(lower)) return "terminate";
  if (/(?:retry|retries|attempt)/u.test(lower)) return "retry";
  if (/(?:retention|ttl|expiry|expiration|evict)/u.test(lower)) return "evict";
  if (/(?:page)/u.test(lower)) return "paginate";
  if (/(?:batch|chunk)/u.test(lower)) return "chunk";
  if (/(?:concurrenc|parallel|pool)/u.test(lower)) return "concurrency";
  if (/(?:payload|file|body|frame|buffer)/u.test(lower)) return "payload";
  if (/(?:truncate|cutoff|summary|preview)/u.test(lower)) return "truncate";
  return "bound";
}

function mechanicalPriority(effect: LimitEffect, reachability: LimitReachability): MechanicalPriority {
  if (reachability === "test" || reachability === "generated" || reachability === "vendor") return "low";
  if (["truncate", "omit", "terminate", "evict", "retry", "reject"].includes(effect)) return "high";
  if (["payload", "schema_max", "concurrency", "clamp", "summarize"].includes(effect)) return "medium";
  return reachability === "live" ? "medium" : "low";
}

function callName(expression: ts.LeftHandSideExpression): string {
  const target = unwrap(expression);
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  return target.getText();
}

function expressionLooksLikeBoundary(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  aliases: ReadonlyMap<string, ts.Expression>,
): boolean {
  const resolved = resolveValue(expression, sourceFile, aliases);
  if (resolved.numeric !== undefined && Math.abs(resolved.numeric) >= 64) return true;
  return isSuspiciousName(expression.getText(sourceFile));
}

function boundaryArgument(
  args: ts.NodeArray<ts.Expression>,
  sourceFile: ts.SourceFile,
  aliases: ReadonlyMap<string, ts.Expression>,
): ts.Expression | undefined {
  return args.find((argument) => expressionLooksLikeBoundary(argument, sourceFile, aliases));
}

function callBoundary(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  aliases: ReadonlyMap<string, ts.Expression>,
): { effect: LimitEffect; argument: ts.Expression; reason: string } | undefined {
  const name = callName(call.expression).toLowerCase();
  const args = call.arguments;
  if (["slice", "substring", "substr"].includes(name) && args.length > 0) {
    const argument = args.length >= 2 ? args[1] : args[0];
    if (argument && expressionLooksLikeBoundary(argument, sourceFile, aliases)) {
      return { effect: "truncate", argument, reason: "sequence_reduction_sink" };
    }
  }
  if (["settimeout", "setinterval"].includes(name) && args[1]) {
    return { effect: "terminate", argument: args[1], reason: "timer_sink" };
  }
  if (name === "timeout" && args[0]) return { effect: "terminate", argument: args[0], reason: "timeout_sink" };
  if (["limit", "take", "pagesize"].includes(name) && args[0]) {
    return { effect: "paginate", argument: args[0], reason: "pagination_sink" };
  }
  if (["max", "maxlength", "maxitems", "maxbytes"].includes(name) && args[0]) {
    const expression = unwrap(call.expression);
    const receiver = ts.isPropertyAccessExpression(expression)
      ? expression.expression.getText(sourceFile)
      : "";
    if (name !== "max" || /(?:^|[.])(?:z|string|array|number|object)|schema/iu.test(receiver)) {
      return { effect: "schema_max", argument: args[0], reason: "schema_maximum_sink" };
    }
  }
  if (name === "min" && args.length >= 2) {
    const expression = unwrap(call.expression);
    const receiver = ts.isPropertyAccessExpression(expression) ? expression.expression.getText(sourceFile) : "";
    const argument = boundaryArgument(args, sourceFile, aliases);
    if (receiver === "Math" && argument) return { effect: "clamp", argument, reason: "minimum_sink" };
  }
  if (/^(?:executewithretry|retry|retrywithbackoff|withretry)$/u.test(name)) {
    const argument = boundaryArgument(args, sourceFile, aliases);
    if (argument) return { effect: "retry", argument, reason: "retry_sink" };
  }
  if (/^(?:batch|batchitems|chunk|chunkarray|chunktext)$/u.test(name)) {
    const argument = boundaryArgument(args, sourceFile, aliases);
    if (argument) return { effect: "chunk", argument, reason: "chunk_sink" };
  }
  if (/^(?:bounded|boundedsummary|boundedutf8|clip|crop|sample|summarize|truncate)(?:content|output|result|text|utf8)?$/u.test(name)) {
    const argument = boundaryArgument(args, sourceFile, aliases);
    if (!argument) return undefined;
    const effect: LimitEffect = name.includes("summar") ? "summarize" : name.includes("sample") ? "sample" : "truncate";
    return { effect, argument, reason: "semantic_reduction_sink" };
  }
  if (/^(?:plimit|setconcurrency|withconcurrency)$/u.test(name) && args[0]) {
    return { effect: "concurrency", argument: args[0], reason: "concurrency_sink" };
  }
  return undefined;
}

function timerLane(call: ts.CallExpression, sourceFile: ts.SourceFile): LimitLane | undefined {
  const name = callName(call.expression).toLowerCase();
  if (name === "setinterval") return "scout";
  if (name !== "settimeout") return undefined;
  const callback = call.arguments[0]?.getText(sourceFile) ?? "";
  const context = `${enclosingSymbol(call, sourceFile)} ${callback}`;
  return /(?:abort|cancel|close|destroy|expire|fail|kill|reject|terminate|timeout)/iu.test(context)
    ? undefined
    : "scout";
}

function comparisonBoundary(
  expression: ts.BinaryExpression,
  sourceFile: ts.SourceFile,
  aliases: ReadonlyMap<string, ts.Expression>,
): { argument: ts.Expression; unit: string } | undefined {
  if (![
    ts.SyntaxKind.GreaterThanToken,
    ts.SyntaxKind.GreaterThanEqualsToken,
    ts.SyntaxKind.LessThanToken,
    ts.SyntaxKind.LessThanEqualsToken,
  ].includes(expression.operatorToken.kind)) return undefined;
  const leftText = expression.left.getText(sourceFile);
  const rightText = expression.right.getText(sourceFile);
  const measurement = /(?:byteLength|byte_length|[.]length|[.]size|[.]count)/u;
  const leftMeasured = measurement.test(leftText);
  const rightMeasured = measurement.test(rightText);
  if (leftMeasured === rightMeasured) return undefined;
  const argument = leftMeasured ? expression.right : expression.left;
  const resolved = resolveValue(argument, sourceFile, aliases);
  if (resolved.numeric !== undefined && Math.abs(resolved.numeric) <= 1) return undefined;
  if (resolved.numeric === undefined && !isSuspiciousName(argument.getText(sourceFile))) return undefined;
  const measuredText = leftMeasured ? leftText : rightText;
  const contextualUnit = unitFor(`${measuredText}_${argument.getText(sourceFile)}`);
  return {
    argument,
    unit: /(?:byteLength|byte_length)/u.test(measuredText)
      ? "bytes"
      : contextualUnit === "characters" ? "characters" : "items",
  };
}

function candidate(
  input: Omit<Candidate, "mechanicalPriority" | "anchor" | "lane"> & {
    readonly anchor?: string;
    readonly lane?: LimitLane;
  },
): Candidate {
  const lane: LimitLane = input.lane
    ?? (["test", "migration_history", "generated", "vendor"].includes(input.reachability)
      ? "evidence"
      : input.reasonCode === "measured_boundary_comparison" || input.detector === "call:setInterval"
        ? "scout"
        : "primary");
  const defaultAnchor = input.detector.startsWith("named:")
    ? `binding:${input.symbol}:${input.detector.slice("named:".length)}`
    : input.detector.startsWith("json:")
      ? `config:${input.symbol}:${input.detector}`
      : `${input.symbol}:${input.detector}:${createHash("sha256").update(locatorShape({ ...input, anchor: "", lane, mechanicalPriority: "low" })).digest("hex").slice(0, 12)}`;
  return {
    ...input,
    anchor: input.anchor ?? defaultAnchor,
    lane,
    mechanicalPriority: mechanicalPriority(input.effect, input.reachability),
  };
}

function scanTypeScript(path: string, content: string): Candidate[] {
  const sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  const aliases = aliasesFor(sourceFile);
  const aliasSymbols = aliasSymbolsFor(sourceFile);
  const reachability = reachabilityFor(path);
  const owner = ownerFor(path);
  const results: Candidate[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isSuspiciousName(node.name.text)) {
      const resolved = resolveValue(node.initializer, sourceFile, aliases);
      if (resolved.numeric === undefined) {
        ts.forEachChild(node, visit);
        return;
      }
      const effect = effectForName(node.name.text);
      results.push(candidate({
        path,
        line: lineFor(sourceFile, node),
        symbol: enclosingSymbol(node, sourceFile),
        owner,
        sourceKind: "typescript",
        detector: `named:${node.name.text}`,
        effect,
        value: resolved.display,
        unit: unitFor(node.name.text),
        reachability,
        extractionConfidence: resolved.numeric === undefined ? "medium" : "high",
        reasonCode: "named_boundary_declaration",
        normalizedExpression: normalizeExpression(node.initializer.getText(sourceFile)),
        anchor: `binding:${enclosingSymbol(node, sourceFile)}:${node.name.text}`,
      }));
    }
    if (ts.isPropertyAssignment(node)) {
      const name = node.name.getText(sourceFile).replace(/^['"]|['"]$/gu, "");
      if (isSuspiciousName(name)) {
        const resolved = resolveValue(node.initializer, sourceFile, aliases);
        if (resolved.numeric === undefined) {
          ts.forEachChild(node, visit);
          return;
        }
        const effect = effectForName(name);
        results.push(candidate({
          path,
          line: lineFor(sourceFile, node),
          symbol: enclosingSymbol(node, sourceFile),
          owner,
          sourceKind: "typescript",
          detector: `property:${name}`,
          effect,
          value: resolved.display,
          unit: unitFor(name),
          reachability,
          extractionConfidence: resolved.numeric === undefined ? "medium" : "high",
          reasonCode: "named_boundary_property",
          normalizedExpression: normalizeExpression(node.initializer.getText(sourceFile)),
          anchor: `property:${enclosingSymbol(node, sourceFile)}:${name}`,
        }));
      }
    }
    if ((ts.isReturnStatement(node) || ts.isYieldExpression(node)) && node.expression) {
      const symbol = enclosingSymbol(node, sourceFile);
      const resolved = resolveValue(node.expression, sourceFile, aliases);
      if (symbol !== "<module>" && isSuspiciousName(symbol) && isNumericArithmeticLiteral(node.expression) && resolved.numeric !== undefined) {
        const yielded = ts.isYieldExpression(node);
        results.push(candidate({
          path,
          line: lineFor(sourceFile, node),
          symbol,
          owner,
          sourceKind: "typescript",
          detector: `${yielded ? "yield" : "return"}:${symbol}`,
          effect: effectForName(symbol),
          value: resolved.display,
          unit: unitFor(symbol),
          reachability,
          extractionConfidence: "high",
          reasonCode: yielded ? "yielded_boundary_expression" : "returned_boundary_expression",
          normalizedExpression: normalizeExpression(node.getText(sourceFile)),
          anchor: `${yielded ? "yield" : "return"}:${symbol}`,
        }));
      }
    }
    if (ts.isCallExpression(node)) {
      const boundary = callBoundary(node, sourceFile, aliases);
      if (boundary) {
        const resolved = resolveValue(boundary.argument, sourceFile, aliases);
        const name = callName(node.expression);
        const observedTimerLane = timerLane(node, sourceFile);
        results.push(candidate({
          path,
          line: lineFor(sourceFile, node),
          symbol: enclosingSymbol(node, sourceFile),
          owner,
          sourceKind: "typescript",
          detector: `call:${name}`,
          effect: boundary.effect,
          value: resolved.display,
          unit: unitFor(/^(?:setinterval|settimeout|timeout)$/iu.test(name) ? name : boundary.argument.getText(sourceFile)),
          reachability,
          extractionConfidence: resolved.numeric === undefined ? "medium" : "high",
          reasonCode: boundary.reason,
          normalizedExpression: normalizeExpression(node.getText(sourceFile)),
          ...(observedTimerLane ? { lane: observedTimerLane } : {}),
          ...(ts.isIdentifier(unwrap(boundary.argument))
            ? { anchor: `binding:${aliasSymbols.get(unwrap(boundary.argument).getText(sourceFile)) ?? enclosingSymbol(node, sourceFile)}:${unwrap(boundary.argument).getText(sourceFile)}` }
            : {}),
        }));
      }
    }
    if (ts.isBinaryExpression(node)) {
      const boundary = comparisonBoundary(node, sourceFile, aliases);
      if (boundary) {
        const resolved = resolveValue(boundary.argument, sourceFile, aliases);
        results.push(candidate({
          path,
          line: lineFor(sourceFile, node),
          symbol: enclosingSymbol(node, sourceFile),
          owner,
          sourceKind: "typescript",
          detector: `comparison:${node.operatorToken.getText(sourceFile)}`,
          effect: "reject",
          value: resolved.display,
          unit: boundary.unit,
          reachability,
          extractionConfidence: resolved.numeric === undefined ? "medium" : "high",
          reasonCode: "measured_boundary_comparison",
          normalizedExpression: normalizeExpression(node.getText(sourceFile)),
        }));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return results;
}

function primitiveValue(value: unknown): ResolvedValue | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return { display: String(value), numeric: value };
  if (typeof value === "string") {
    const numeric = Number(value.replaceAll("_", ""));
    return Number.isFinite(numeric) ? { display: JSON.stringify(value), numeric } : { display: JSON.stringify(value) };
  }
  return undefined;
}

function scanJson(path: string, content: string): Candidate[] {
  const reachability = reachabilityFor(path);
  let document: unknown;
  try {
    document = JSON.parse(content) as unknown;
  } catch (error) {
    if (["test", "migration_history", "generated", "vendor"].includes(reachability)) return [];
    throw new Error(`Cannot inventory malformed JSON ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const owner = ownerFor(path);
  const results: Candidate[] = [];
  const walk = (value: unknown, keys: readonly string[]): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        const identity = item && typeof item === "object" && !Array.isArray(item)
          && typeof (item as Record<string, unknown>)["id"] === "string"
          ? `id=${String((item as Record<string, unknown>)["id"])}`
          : String(index);
        walk(item, [...keys, identity]);
      });
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        const resolved = primitiveValue(child);
        if (isSuspiciousName(key) && resolved?.numeric !== undefined) {
          const effect = effectForName(key);
          results.push(candidate({
            path,
            line: 1,
            symbol: keys.length === 0 ? "<root>" : keys.join("."),
            owner,
            sourceKind: "json",
            detector: `json:${key}`,
            effect,
            value: resolved.display,
            unit: unitFor(key),
            reachability,
            extractionConfidence: "high",
            reasonCode: "structured_boundary_key",
            normalizedExpression: JSON.stringify(child),
          }));
        }
        if (typeof child === "string") {
          for (const match of child.matchAll(/(?:--timeout|\btimeout)\s*[= ]\s*(\d[\d_]*)/giu)) {
            results.push(candidate({
              path,
              line: 1,
              symbol: [...keys, key].join("."),
              owner,
              sourceKind: "json",
              detector: "json-command:timeout",
              effect: "terminate",
              value: match[1]?.replaceAll("_", "") ?? "unresolved",
              unit: "milliseconds",
              reachability,
              extractionConfidence: "medium",
              reasonCode: "embedded_timeout_command",
              normalizedExpression: normalizeExpression(match[0]),
            }));
          }
        }
        walk(child, [...keys, key]);
      }
    }
  };
  walk(document, []);
  return results;
}

function scanStructuredLines(path: string, content: string, sourceKind: "yaml" | "shell" | "toml"): Candidate[] {
  const reachability = reachabilityFor(path);
  const owner = ownerFor(path);
  const results: Candidate[] = [];
  const lines = content.split(/\r?\n/u);
  lines.forEach((line, index) => {
    const assignment = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*(?::|=)\s*["']?(-?\d[\d_.]*)/u.exec(line);
    if (assignment?.[1] && assignment[2] && isSuspiciousName(assignment[1])) {
      const name = assignment[1];
      const effect = effectForName(name);
      results.push(candidate({
        path,
        line: index + 1,
        symbol: "<document>",
        owner,
        sourceKind,
        detector: `${sourceKind}:${name}`,
        effect,
        value: assignment[2].replaceAll("_", ""),
        unit: unitFor(name),
        reachability,
        extractionConfidence: "high",
        reasonCode: "structured_boundary_key",
        normalizedExpression: normalizeExpression(line),
      }));
    }
    const timeout = /(?:^|[;&|\s])timeout\s+(\d[\d_.]*)([smhd]?)(?:\s|$)/iu.exec(line);
    if (timeout?.[1]) {
      const units: Record<string, string> = { "": "seconds", s: "seconds", m: "minutes", h: "hours", d: "days" };
      results.push(candidate({
        path,
        line: index + 1,
        symbol: "<document>",
        owner,
        sourceKind,
        detector: `${sourceKind}:timeout-command`,
        effect: "terminate",
        value: timeout[1].replaceAll("_", ""),
        unit: units[timeout[2]?.toLowerCase() ?? ""] ?? "seconds",
        reachability,
        extractionConfidence: "high",
        reasonCode: "timeout_command",
        normalizedExpression: normalizeExpression(line),
      }));
    }
  });
  return results;
}

const EFFECT_ORDER: readonly LimitEffect[] = [
  "truncate", "omit", "summarize", "sample", "terminate", "evict", "retry", "reject",
  "payload", "schema_max", "concurrency", "clamp", "paginate", "chunk", "bound", "retain", "warn",
];

function observationFromCandidates(items: readonly Candidate[], occurrence: number): LimitObservation {
  const ordered = [...items].sort((left, right) => left.line - right.line
    || compareText(left.detector, right.detector)
    || compareText(left.normalizedExpression, right.normalizedExpression));
  const first = ordered[0]!;
  const effects = [...new Set(ordered.map((item) => item.effect))]
    .sort((left, right) => EFFECT_ORDER.indexOf(left) - EFFECT_ORDER.indexOf(right));
  const reasonCodes = [...new Set(ordered.map((item) => item.reasonCode))].sort(compareText);
  const locator = `${first.path}#${first.anchor}:${occurrence}`;
  const fingerprint = createHash("sha256").update(JSON.stringify({
    path: first.path,
    anchor: first.anchor,
    value: first.value,
    unit: first.unit,
    sites: ordered.map((item) => ({
      symbol: item.symbol,
      detector: item.detector,
      effect: item.effect,
      expression: item.normalizedExpression,
    })),
  })).digest("hex");
  return {
    locator,
    fingerprint,
    path: first.path,
    line: first.line,
    symbol: first.symbol,
    owner: first.owner,
    sourceKind: first.sourceKind,
    detector: first.detector,
    effect: effects[0] ?? first.effect,
    value: first.value,
    unit: first.unit,
    reachability: first.reachability,
    extractionConfidence: ordered.every((item) => item.extractionConfidence === "high") ? "high" : "medium",
    mechanicalPriority: ordered.some((item) => item.mechanicalPriority === "high")
      ? "high"
      : ordered.some((item) => item.mechanicalPriority === "medium") ? "medium" : "low",
    reasonCode: reasonCodes[0] ?? first.reasonCode,
    effects,
    reasonCodes,
    lane: first.lane,
    siteCount: ordered.length,
    sites: ordered.map((item) => ({
      path: item.path,
      line: item.line,
      symbol: item.symbol,
      detector: item.detector,
      expression: item.normalizedExpression,
      reasonCode: item.reasonCode,
    })),
  };
}

export async function scanRepository(repositoryRoot: string, options: ScanOptions = {}): Promise<LimitObservation[]> {
  const files = await sourceFiles(repositoryRoot, options.sourceRoots ?? DEFAULT_SOURCE_ROOTS);
  const candidates: Candidate[] = [];
  for (const path of files) {
    const content = await readFile(resolve(repositoryRoot, path), "utf8");
    const kind = sourceKindFor(path);
    if (kind === "typescript") candidates.push(...scanTypeScript(path, content));
    else if (kind === "json") candidates.push(...scanJson(path, content));
    else if (kind === "yaml" || kind === "shell" || kind === "toml") {
      candidates.push(...scanStructuredLines(path, content, kind));
    }
  }
  const lanes = new Set(options.lanes ?? ["primary", "scout", "evidence"]);
  const included = candidates.filter((item) => lanes.has(item.lane));
  included.sort((left, right) => left.path.localeCompare(right.path)
    || left.line - right.line
    || left.symbol.localeCompare(right.symbol)
    || left.detector.localeCompare(right.detector)
    || left.normalizedExpression.localeCompare(right.normalizedExpression));
  const groups = new Map<string, Candidate[]>();
  for (const item of included) {
    const key = `${item.path}\0${item.anchor}\0${item.value}\0${item.unit}\0${item.lane}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  const orderedGroups = [...groups.values()].sort((left, right) =>
    compareText(left[0]!.path, right[0]!.path)
    || left[0]!.line - right[0]!.line
    || compareText(left[0]!.anchor, right[0]!.anchor));
  const occurrences = new Map<string, number>();
  return orderedGroups.map((items) => {
    const first = items[0]!;
    const key = `${first.path}\0${first.anchor}\0${first.lane}`;
    const occurrence = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, occurrence);
    return observationFromCandidates(items, occurrence);
  });
}

function boundaryName(observation: LimitObservation): string | undefined {
  if (observation.detector.startsWith("named:")) return observation.detector.slice("named:".length);
  if (observation.detector.startsWith("return:")) return observation.detector.slice("return:".length);
  if (observation.detector.startsWith("yield:")) return observation.detector.slice("yield:".length);
  return undefined;
}

function significantNameTokens(name: string): Set<string> {
  const ignored = new Set(["ABSOLUTE", "DEFAULT", "HARD", "LIMIT", "MAX", "MAXIMUM", "MIN", "MINIMUM", "MS", "SOFT", "TIMEOUT"]);
  return new Set(name.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toUpperCase().split(/[^A-Z0-9]+/u)
    .filter((token) => token.length > 1 && !ignored.has(token)));
}

function sharedTokenCount(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const token of left) if (right.has(token)) count += 1;
  return count;
}

function addLink(
  links: Map<string, LimitInvestigationLink[]>,
  locator: string,
  link: LimitInvestigationLink,
): void {
  const values = links.get(locator) ?? [];
  const key = `${link.kind}\0${link.path}\0${link.line}\0${link.symbol}\0${link.reasonCode}\0${link.relatedLocator ?? ""}`;
  if (!values.some((value) => `${value.kind}\0${value.path}\0${value.line}\0${value.symbol}\0${value.reasonCode}\0${value.relatedLocator ?? ""}` === key)) {
    values.push(link);
    links.set(locator, values);
  }
}

function relativeImportTarget(
  repositoryRoot: string,
  importingPath: string,
  specifier: string,
  sourcePaths: ReadonlySet<string>,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = portablePath(relative(repositoryRoot, resolve(repositoryRoot, dirname(importingPath), specifier)));
  const candidates = [
    base,
    ...[...CODE_EXTENSIONS].map((extension) => `${base}${extension}`),
    ...[...CODE_EXTENSIONS].map((extension) => `${base}/index${extension}`),
  ];
  return candidates.find((candidate) => sourcePaths.has(candidate));
}

function regexpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function sourceLineStarts(content: string): number[] {
  const starts = [0];
  for (let index = content.indexOf("\n"); index >= 0; index = content.indexOf("\n", index + 1)) starts.push(index + 1);
  return starts;
}

function sourceLineAt(starts: readonly number[], offset: number): number {
  let lower = 0;
  let upper = starts.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if ((starts[middle] ?? 0) <= offset) lower = middle + 1;
    else upper = middle;
  }
  return Math.max(1, lower);
}

function lineDetail(content: string, offset: number): string {
  const start = content.lastIndexOf("\n", offset) + 1;
  const end = content.indexOf("\n", offset);
  return normalizeExpression(content.slice(start, end < 0 ? content.length : end));
}

function containsIdentifier(content: string, identifier: string): boolean {
  for (let index = content.indexOf(identifier); index >= 0; index = content.indexOf(identifier, index + identifier.length)) {
    const before = index === 0 ? "" : content[index - 1] ?? "";
    const after = content[index + identifier.length] ?? "";
    if (!/[A-Za-z0-9_$]/u.test(before) && !/[A-Za-z0-9_$]/u.test(after)) return true;
  }
  return false;
}

function lexicalSymbolBody(content: string, symbol: string): { start: number; end: number } | undefined {
  const name = regexpLiteral(symbol);
  const declaration = new RegExp(`(?:function\\s+${name}\\b|(?:const|let|var)\\s+${name}\\b|\\b${name}\\s*\\([^)]*\\)\\s*\\{)`, "gu").exec(content);
  if (!declaration) return undefined;
  const start = content.indexOf("{", declaration.index + declaration[0].length - 1);
  if (start < 0) return undefined;
  let depth = 0;
  for (let index = start; index < content.length; index += 1) {
    if (content[index] === "{") depth += 1;
    else if (content[index] === "}" && --depth === 0) return { start, end: index + 1 };
  }
  return undefined;
}

async function investigationLinks(
  repositoryRoot: string,
  observations: readonly LimitObservation[],
  paths: readonly string[],
): Promise<ReadonlyMap<string, readonly LimitInvestigationLink[]>> {
  const links = new Map<string, LimitInvestigationLink[]>();
  const observationsByPath = new Map<string, LimitObservation[]>();
  for (const observation of observations) {
    const values = observationsByPath.get(observation.path) ?? [];
    values.push(observation);
    observationsByPath.set(observation.path, values);
    for (const site of observation.sites) {
      const kind: LimitInvestigationLink["kind"] = site.reasonCode === "named_boundary_declaration"
        || site.reasonCode === "returned_boundary_expression"
        || site.reasonCode === "yielded_boundary_expression"
        ? "definition"
        : "consumer";
      addLink(links, observation.locator, {
        kind,
        path: site.path,
        line: site.line,
        symbol: site.symbol,
        reasonCode: site.reasonCode,
        detail: site.expression,
      });
    }
  }

  const sourcePaths = new Set(paths);
  for (const path of paths) {
    if (sourceKindFor(path) !== "typescript") continue;
    const content = await readFile(resolve(repositoryRoot, path), "utf8");
    const starts = sourceLineStarts(content);
    const imported = new Map<string, { importedName: string; targetPath: string }>();
    const importPattern = /import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/gu;
    for (const match of content.matchAll(importPattern)) {
      const targetPath = relativeImportTarget(repositoryRoot, path, match[2] ?? "", sourcePaths);
      if (!targetPath) continue;
      for (const rawBinding of (match[1] ?? "").split(",")) {
        const binding = /^\s*([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?/u.exec(rawBinding);
        if (!binding?.[1]) continue;
        const importedName = binding[1];
        const localName = binding[2] ?? importedName;
        imported.set(localName, { importedName, targetPath });
        for (const observation of observationsByPath.get(targetPath) ?? []) {
          if (boundaryName(observation) !== importedName && observation.symbol !== importedName) continue;
          addLink(links, observation.locator, {
            kind: "import",
            path,
            line: sourceLineAt(starts, match.index ?? 0),
            symbol: localName,
            reasonCode: "relative_import_of_observed_symbol",
            detail: `${importedName} imported from ${match[2]}`,
          });
        }
      }
    }

    const localObservations = observationsByPath.get(path) ?? [];
    const boundaries = new Map<string, LimitObservation[]>();
    const helpers = new Map<string, LimitObservation[]>();
    for (const observation of localObservations) {
      const name = boundaryName(observation);
      if (name) boundaries.set(name, [...boundaries.get(name) ?? [], observation]);
      if (observation.symbol !== "<module>") helpers.set(observation.symbol, [...helpers.get(observation.symbol) ?? [], observation]);
      if (observation.symbol !== "<module>") {
        if (observation.effects.some((effect) => ["omit", "sample", "summarize", "truncate"].includes(effect))) {
          const body = lexicalSymbolBody(content, observation.symbol);
          if (body) {
            const continuationPattern = /\b(after|before|continuation|cursor|hasMore|nextCursor|offset|reference|remainder|remaining|truncated|uninspected)[A-Za-z0-9_$]*\b/giu;
            for (const match of content.slice(body.start, body.end).matchAll(continuationPattern)) {
              const offset = body.start + (match.index ?? 0);
              addLink(links, observation.locator, {
                kind: "continuation",
                path,
                line: sourceLineAt(starts, offset),
                symbol: observation.symbol,
                reasonCode: "continuation_shaped_symbol_near_observation",
                detail: match[0],
              });
            }
          }
        }
      }
    }

    const comparisonLine = /^(?=.*(?:[.]length|[.]size|[.]count|byteLength|byte_length))(?=.*(?:<=|>=|<|>)).*$/gmu;
    for (const match of content.matchAll(comparisonLine)) {
      for (const [name, matchingObservations] of boundaries) {
        if (!containsIdentifier(match[0], name)) continue;
        for (const observation of matchingObservations) addLink(links, observation.locator, {
          kind: "consumer",
          path,
          line: sourceLineAt(starts, match.index ?? 0),
          symbol: observation.symbol,
          reasonCode: "measured_boundary_comparison",
          detail: normalizeExpression(match[0]),
        });
      }
    }

    const callPattern = /\b([A-Za-z_$][\w$]*)\s*\(/gu;
    for (const match of content.matchAll(callPattern)) {
      const calledName = match[1]!;
      const offset = match.index ?? 0;
      const prefix = content.slice(Math.max(0, offset - 24), offset);
      const detail = lineDetail(content, offset);
      if (/function\s*$/u.test(prefix) || /^(?:\/[*]|[*]|\/\/)/u.test(detail)) continue;
      for (const observation of helpers.get(calledName) ?? []) addLink(links, observation.locator, {
        kind: "caller",
        path,
        line: sourceLineAt(starts, offset),
        symbol: calledName,
        reasonCode: "same_file_call_of_observed_helper",
        detail,
      });
      const target = imported.get(calledName);
      if (target) {
        for (const observation of observationsByPath.get(target.targetPath) ?? []) {
          if (observation.symbol !== target.importedName) continue;
          addLink(links, observation.locator, {
            kind: "caller",
            path,
            line: sourceLineAt(starts, offset),
            symbol: calledName,
            reasonCode: "relative_import_call_of_observed_helper",
            detail,
          });
        }
      }
    }

    if (content.includes("String.raw")) {
      const generatedPattern = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\$\{\s*([A-Za-z_$][\w$]*)\s*\}/gu;
      for (const match of content.matchAll(generatedPattern)) {
        const generatedName = match[1]!;
        const hostName = match[2]!;
        for (const observation of localObservations) {
          if (boundaryName(observation) !== hostName) continue;
          addLink(links, observation.locator, {
            kind: "generated_consumer",
            path,
            line: sourceLineAt(starts, match.index ?? 0),
            symbol: generatedName,
            reasonCode: "generated_source_interpolation",
            detail: `const ${generatedName} = \${${hostName}}`,
          });
        }
      }
    }

  }

  const families = new Map<string, LimitObservation[]>();
  for (const observation of observations) {
    const name = boundaryName(observation);
    if (!name || observation.reachability !== "live") continue;
    const key = `${observation.value}\0${observation.unit}`;
    const values = families.get(key) ?? [];
    values.push(observation);
    families.set(key, values);
  }
  for (const values of families.values()) {
    for (let leftIndex = 0; leftIndex < values.length; leftIndex += 1) {
      const left = values[leftIndex]!;
      for (let rightIndex = leftIndex + 1; rightIndex < values.length; rightIndex += 1) {
        const right = values[rightIndex]!;
        if (left.path === right.path) continue;
        const leftName = boundaryName(left)!;
        const rightName = boundaryName(right)!;
        const related = leftName === rightName
          || sharedTokenCount(significantNameTokens(leftName), significantNameTokens(rightName)) >= 2;
        const policyBearing = [left, right].some((item) => item.mechanicalPriority === "high"
          || item.effects.some((effect) => ["evict", "omit", "retry", "sample", "summarize", "terminate", "truncate"].includes(effect)));
        if (!related || !policyBearing) continue;
        const reasonCode = leftName === rightName ? "exact_name_value_unit_policy_family" : "shared_name_tokens_value_unit_policy_family";
        addLink(links, left.locator, {
          kind: "policy_family",
          path: right.path,
          line: right.line,
          symbol: right.symbol,
          reasonCode,
          detail: `${rightName} = ${right.value} ${right.unit}`,
          relatedLocator: right.locator,
        });
        addLink(links, right.locator, {
          kind: "policy_family",
          path: left.path,
          line: left.line,
          symbol: left.symbol,
          reasonCode,
          detail: `${leftName} = ${left.value} ${left.unit}`,
          relatedLocator: left.locator,
        });
      }
    }
  }

  const kindOrder = ["definition", "consumer", "generated_consumer", "import", "caller", "continuation", "policy_family"];
  for (const values of links.values()) values.sort((left, right) => kindOrder.indexOf(left.kind) - kindOrder.indexOf(right.kind)
    || compareText(left.path, right.path) || left.line - right.line || compareText(left.detail, right.detail));
  return links;
}

export async function scanRepositoryWithEvidence(
  repositoryRoot: string,
  options: ScanOptions = {},
): Promise<LimitScanEvidence> {
  const observations = await scanRepository(repositoryRoot, options);
  Bun.gc(true);
  return scanEvidenceForObservations(repositoryRoot, observations, options.sourceRoots);
}

async function scanEvidenceForObservations(
  repositoryRoot: string,
  observations: readonly LimitObservation[],
  sourceRoots: readonly string[] = DEFAULT_SOURCE_ROOTS,
): Promise<LimitScanEvidence> {
  const roots = sourceRoots;
  const paths = await sourceFiles(repositoryRoot, roots);
  return {
    observations,
    coverage: LIMIT_DETECTOR_COVERAGE,
    linksByLocator: await investigationLinks(repositoryRoot, observations, paths),
  };
}
