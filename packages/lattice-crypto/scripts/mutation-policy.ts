import { createHash } from "node:crypto";
import type {
  MutationManifest,
  MutationScope,
} from "./mutation-governance.ts";

const rawStatuses = [
  "Killed",
  "Survived",
  "NoCoverage",
  "CompileError",
  "RuntimeError",
  "Timeout",
  "Ignored",
  "Pending",
] as const;
type RawMutationStatus = typeof rawStatuses[number];

const residualRawStatuses = [
  "Survived",
  "NoCoverage",
  "Timeout",
] as const;
type ResidualRawStatus = typeof residualRawStatuses[number];

const residualDispositions = [
  "equivalent",
  "unreachable",
  "deterministic_timeout",
] as const;
type ResidualDisposition = typeof residualDispositions[number];

interface Position {
  readonly line: number;
  readonly column: number;
}

interface Location {
  readonly start: Position;
  readonly end: Position;
}

interface ParsedMutant {
  readonly id: string;
  readonly mutatorName: string;
  readonly replacement: string;
  readonly static: boolean;
  readonly status: RawMutationStatus;
  readonly location: Location;
}

interface ParsedMutationFile {
  readonly target: string;
  readonly source: string;
  readonly mutants: readonly ParsedMutant[];
}

interface ParsedScopeReport {
  readonly scope: MutationScope;
  readonly files: readonly ParsedMutationFile[];
}

export interface MutationResidual {
  readonly scope: string;
  readonly target: string;
  readonly mutantFingerprint: string;
  readonly rawStatus: ResidualRawStatus;
  readonly disposition: ResidualDisposition;
  readonly reason: string;
  readonly evidenceTests: readonly string[];
  readonly reproduction: {
    readonly kind: "mutation_scope";
    readonly scope: string;
    readonly mutantFingerprint: string;
  };
}

export interface MutationResidualLedger {
  readonly formatVersion: 1;
  readonly entries: readonly MutationResidual[];
}

export interface MutationScopeSummary {
  readonly name: string;
  readonly tier: "critical" | "provider";
  readonly zeroMutantTargets: readonly string[];
  readonly generated: number;
  readonly killed: number;
  readonly killedPercentage: number;
  readonly accounted: number;
  readonly equivalent: number;
  readonly unreachable: number;
  readonly deterministicTimeout: number;
  readonly rawStatuses: Readonly<Record<RawMutationStatus, number>>;
  readonly policyPassed: boolean;
  readonly residuals: readonly {
    readonly mutantFingerprint: string;
    readonly disposition: ResidualDisposition;
  }[];
  readonly failures: readonly string[];
}

export interface MutationRunSummary {
  readonly formatVersion: 3;
  readonly status: "passed" | "failed" | "partial";
  readonly policyPassed: boolean;
  readonly fullScopeComplete: boolean;
  readonly minimumKilledPercentage: 80;
  readonly perScopeWorkerBudget: number;
  readonly hostedMaxParallelScopes: number;
  readonly maximumHostedWorkers: number;
  readonly completedScopes: readonly string[];
  readonly expectedScopes: readonly string[];
  readonly missingScopes: readonly string[];
  readonly scopes: readonly MutationScopeSummary[];
  readonly failures: readonly string[];
}

interface ParseLedgerOptions {
  readonly manifest: MutationManifest;
  readonly fileExists: (path: string) => boolean;
}

interface EvaluateOptions {
  readonly partial: boolean;
  readonly readSource: (path: string) => string;
  readonly fileExists: (path: string) => boolean;
}

interface MutationFingerprintInput {
  readonly scope: string;
  readonly target: string;
  readonly source: string;
  readonly mutant: unknown;
}

const ledgerFields = ["formatVersion", "entries"] as const;
const residualFields = [
  "scope",
  "target",
  "mutantFingerprint",
  "rawStatus",
  "disposition",
  "reason",
  "evidenceTests",
  "reproduction",
] as const;
const reproductionFields = [
  "kind",
  "scope",
  "mutantFingerprint",
] as const;
const fingerprintPattern = /^m1:[a-f0-9]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): void {
  const expected = new Set(fields);
  for (const field of Object.keys(value)) {
    if (!expected.has(field)) {
      throw new TypeError(`${label} has unexpected field: ${field}`);
    }
  }
  for (const field of fields) {
    if (!(field in value)) {
      throw new TypeError(`${label} is missing field: ${field}`);
    }
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || [...value].some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    throw new TypeError(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function exactStringArray(
  value: unknown,
  label: string,
): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string array`);
  }
  const values = value.map((item, index) =>
    nonEmptyString(item, `${label}[${index}]`)
  );
  if (new Set(values).size !== values.length) {
    throw new TypeError(`${label} must not contain duplicates`);
  }
  return values;
}

function canonicalPackagePath(
  value: unknown,
  prefix: "src/" | "tests/",
  suffix: ".ts" | ".test.ts",
  label: string,
): string {
  const path = nonEmptyString(value, label);
  if (
    !path.startsWith(prefix)
    || !path.endsWith(suffix)
    || path.startsWith("/")
    || path.includes("\\")
    || path.split("/").some((segment) =>
      segment.length === 0 || segment === "." || segment === ".."
    )
    || /[\u2028\u2029]/u.test(path)
  ) {
    throw new TypeError(`${label} is not a canonical package path: ${path}`);
  }
  return path;
}

function parsePosition(value: unknown, label: string): Position {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  assertExactFields(value, ["line", "column"], label);
  if (
    !Number.isSafeInteger(value["line"])
    || Number(value["line"]) < 1
    || !Number.isSafeInteger(value["column"])
    || Number(value["column"]) < 1
  ) {
    throw new TypeError(`${label} must contain positive integer coordinates`);
  }
  return {
    line: Number(value["line"]),
    column: Number(value["column"]),
  };
}

function comparePosition(left: Position, right: Position): number {
  return left.line === right.line
    ? left.column - right.column
    : left.line - right.line;
}

function assertPositionInSource(
  position: Position,
  source: string,
  label: string,
): void {
  const lines = source.split("\n");
  const line = lines[position.line - 1];
  if (line === undefined || position.column > line.length + 1) {
    throw new TypeError(`${label} is outside the report source`);
  }
}

function parseLocation(
  value: unknown,
  source: string,
  label: string,
): Location {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  assertExactFields(value, ["start", "end"], label);
  const start = parsePosition(value["start"], `${label}.start`);
  const end = parsePosition(value["end"], `${label}.end`);
  assertPositionInSource(start, source, `${label}.start`);
  assertPositionInSource(end, source, `${label}.end`);
  if (comparePosition(start, end) >= 0) {
    throw new TypeError(`${label} must be a non-empty ordered range`);
  }
  return { start, end };
}

function parseRawMutant(
  value: unknown,
  source: string,
  label: string,
): ParsedMutant {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const id = nonEmptyString(value["id"], `${label}.id`);
  const mutatorName = nonEmptyString(
    value["mutatorName"],
    `${label}.mutatorName`,
  );
  if (typeof value["replacement"] !== "string") {
    throw new TypeError(`${label}.replacement must be a string`);
  }
  if (
    value["static"] !== undefined
    && typeof value["static"] !== "boolean"
  ) {
    throw new TypeError(`${label}.static must be a boolean when present`);
  }
  if (
    typeof value["status"] !== "string"
    || !rawStatuses.includes(value["status"] as RawMutationStatus)
  ) {
    throw new TypeError(`${label}.status is unsupported`);
  }
  return {
    id,
    mutatorName,
    replacement: value["replacement"],
    static: value["static"] === true,
    status: value["status"] as RawMutationStatus,
    location: parseLocation(value["location"], source, `${label}.location`),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fingerprintParsedMutant(
  scope: string,
  target: string,
  source: string,
  mutant: ParsedMutant,
): string {
  const identity = [
    "lattice-mutant-v1",
    scope,
    target,
    sha256(source),
    mutant.location.start.line,
    mutant.location.start.column,
    mutant.location.end.line,
    mutant.location.end.column,
    mutant.mutatorName,
    mutant.replacement,
    mutant.static,
  ];
  return `m1:${sha256(JSON.stringify(identity))}`;
}

export function mutationFingerprint(
  input: MutationFingerprintInput,
): string {
  const scope = nonEmptyString(input.scope, "mutation fingerprint scope");
  const target = canonicalPackagePath(
    input.target,
    "src/",
    ".ts",
    "mutation fingerprint target",
  );
  if (typeof input.source !== "string") {
    throw new TypeError("mutation fingerprint source must be a string");
  }
  const mutant = parseRawMutant(
    input.mutant,
    input.source,
    "mutation fingerprint mutant",
  );
  return fingerprintParsedMutant(scope, target, input.source, mutant);
}

function expectedDisposition(
  rawStatus: ResidualRawStatus,
  disposition: ResidualDisposition,
): boolean {
  if (rawStatus === "Survived") {
    return disposition === "equivalent" || disposition === "unreachable";
  }
  if (rawStatus === "NoCoverage") return disposition === "unreachable";
  return disposition === "deterministic_timeout";
}

function dispositionFailure(rawStatus: ResidualRawStatus): string {
  if (rawStatus === "Survived") {
    return "Survived residual must be equivalent or unreachable";
  }
  if (rawStatus === "NoCoverage") {
    return "NoCoverage residual must be unreachable";
  }
  return "Timeout residual must be deterministic_timeout";
}

function parseResidual(
  value: unknown,
  index: number,
  options: ParseLedgerOptions,
): MutationResidual {
  if (!isRecord(value)) {
    throw new TypeError(`residual entries[${index}] must be an object`);
  }
  const label = `residual entries[${index}]`;
  assertExactFields(value, residualFields, label);
  const scopeName = nonEmptyString(value["scope"], `${label}.scope`);
  const scope = options.manifest.scopes.find((item) =>
    item.name === scopeName
  );
  if (scope === undefined) {
    throw new TypeError(`${label}.scope is not declared: ${scopeName}`);
  }
  const target = canonicalPackagePath(
    value["target"],
    "src/",
    ".ts",
    `${label}.target`,
  );
  if (!scope.mutate.includes(target)) {
    throw new TypeError(
      `${label}.target is not owned by scope ${scopeName}: ${target}`,
    );
  }
  const mutantFingerprint = nonEmptyString(
    value["mutantFingerprint"],
    `${label}.mutantFingerprint`,
  );
  if (!fingerprintPattern.test(mutantFingerprint)) {
    throw new TypeError(`${label}.mutantFingerprint is invalid`);
  }
  if (
    typeof value["rawStatus"] !== "string"
    || !residualRawStatuses.includes(value["rawStatus"] as ResidualRawStatus)
  ) {
    throw new TypeError(`${label}.rawStatus is invalid`);
  }
  const rawStatus = value["rawStatus"] as ResidualRawStatus;
  if (
    typeof value["disposition"] !== "string"
    || !residualDispositions.includes(
      value["disposition"] as ResidualDisposition,
    )
  ) {
    throw new TypeError(`${label}.disposition is invalid`);
  }
  const disposition = value["disposition"] as ResidualDisposition;
  if (!expectedDisposition(rawStatus, disposition)) {
    throw new TypeError(dispositionFailure(rawStatus));
  }
  const reason = nonEmptyString(value["reason"], `${label}.reason`);
  const evidenceTests = exactStringArray(
    value["evidenceTests"],
    `${label}.evidenceTests`,
  ).map((path, evidenceIndex) =>
    canonicalPackagePath(
      path,
      "tests/",
      ".test.ts",
      `${label}.evidenceTests[${evidenceIndex}]`,
    )
  );
  const scopeTestPaths = new Set(scope.command.split(" ").slice(4));
  for (const evidencePath of evidenceTests) {
    if (!options.fileExists(evidencePath)) {
      throw new TypeError(`${label} evidence test does not exist: ${evidencePath}`);
    }
    if (!scopeTestPaths.has(evidencePath)) {
      throw new TypeError(
        `${label} evidence test is not executed by scope ${scopeName}: `
          + evidencePath,
      );
    }
  }
  if (!isRecord(value["reproduction"])) {
    throw new TypeError(`${label}.reproduction must be an object`);
  }
  assertExactFields(
    value["reproduction"],
    reproductionFields,
    `${label}.reproduction`,
  );
  if (value["reproduction"]["kind"] !== "mutation_scope") {
    throw new TypeError(`${label}.reproduction.kind must be mutation_scope`);
  }
  if (value["reproduction"]["scope"] !== scopeName) {
    throw new TypeError(`${label}.reproduction.scope must match scope`);
  }
  if (
    value["reproduction"]["mutantFingerprint"] !== mutantFingerprint
  ) {
    throw new TypeError(
      `${label}.reproduction.mutantFingerprint must match entry`,
    );
  }
  return {
    scope: scopeName,
    target,
    mutantFingerprint,
    rawStatus,
    disposition,
    reason,
    evidenceTests,
    reproduction: {
      kind: "mutation_scope",
      scope: scopeName,
      mutantFingerprint,
    },
  };
}

export function parseMutationResidualLedger(
  value: unknown,
  options: ParseLedgerOptions,
): MutationResidualLedger {
  if (!isRecord(value)) {
    throw new TypeError("mutation residual ledger must be an object");
  }
  assertExactFields(value, ledgerFields, "mutation residual ledger");
  if (value["formatVersion"] !== 1) {
    throw new TypeError("mutation residual ledger formatVersion must be 1");
  }
  if (!Array.isArray(value["entries"])) {
    throw new TypeError("mutation residual ledger entries must be an array");
  }
  const entries = value["entries"].map((entry, index) =>
    parseResidual(entry, index, options)
  );
  const fingerprints = entries.map((entry) => entry.mutantFingerprint);
  if (new Set(fingerprints).size !== fingerprints.length) {
    throw new TypeError("duplicate residual mutant fingerprint");
  }
  return {
    formatVersion: 1,
    entries,
  };
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function assertReportThresholds(value: unknown, label: string): void {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  if (
    value["high"] !== 80
    || value["low"] !== 80
    || value["break"] !== null
  ) {
    throw new TypeError(`${label} must be high=80, low=80, break=null`);
  }
}

function parseScopeReport(
  value: unknown,
  scope: MutationScope,
  manifest: MutationManifest,
  readSource: (path: string) => string,
): ParsedScopeReport {
  if (!isRecord(value)) {
    throw new TypeError(`mutation report for ${scope.name} must be an object`);
  }
  if (value["schemaVersion"] !== "1.0") {
    throw new TypeError(
      `mutation report for ${scope.name} schemaVersion must be 1.0`,
    );
  }
  if (
    !isRecord(value["framework"])
    || value["framework"]["name"] !== "StrykerJS"
    || value["framework"]["version"] !== "9.6.1"
  ) {
    throw new TypeError(
      `mutation report for ${scope.name} must come from StrykerJS 9.6.1`,
    );
  }
  assertReportThresholds(
    value["thresholds"],
    `mutation report for ${scope.name} thresholds`,
  );
  if (!isRecord(value["config"])) {
    throw new TypeError(`mutation report for ${scope.name} config is required`);
  }
  const config = value["config"];
  if (
    config["testRunner"] !== "command"
    || !isRecord(config["commandRunner"])
    || config["commandRunner"]["command"] !== scope.command
    || config["coverageAnalysis"] !== "off"
  ) {
    throw new TypeError(
      `mutation report for ${scope.name} runner config does not match scope`,
    );
  }
  if (
    config["ignoreStatic"] !== false
    || config["incremental"] !== false
    || !Array.isArray(config["ignorers"])
    || config["ignorers"].length !== 0
    || !isRecord(config["mutator"])
    || !Array.isArray(config["mutator"]["excludedMutations"])
    || config["mutator"]["excludedMutations"].length !== 0
  ) {
    throw new TypeError(
      `mutation report for ${scope.name} contains a mutation escape hatch`,
    );
  }
  const configuredTargets = config["mutate"];
  if (
    !Array.isArray(configuredTargets)
    || !configuredTargets.every((target) => typeof target === "string")
    || !sameStrings(configuredTargets, scope.mutate)
  ) {
    throw new TypeError(
      `mutation report for ${scope.name} targets do not match scope`,
    );
  }
  if (config["concurrency"] !== manifest.perScopeWorkerBudget) {
    throw new TypeError(
      `mutation report for ${scope.name} concurrency does not match budget`,
    );
  }
  if (config["timeoutMS"] !== 30_000 || config["timeoutFactor"] !== 2) {
    throw new TypeError(
      `mutation report for ${scope.name} timeout policy does not match`,
    );
  }
  if (
    config["tempDirName"] !== `.stryker-tmp/${scope.name}`
    || config["cleanTempDir"] !== "always"
  ) {
    throw new TypeError(
      `mutation report for ${scope.name} temp directory is not isolated`,
    );
  }
  assertReportThresholds(
    config["thresholds"],
    `mutation report for ${scope.name} config thresholds`,
  );
  if (!isRecord(config["jsonReporter"])) {
    throw new TypeError(
      `mutation report for ${scope.name} jsonReporter is required`,
    );
  }
  const expectedReportPath = `reports/mutation/${scope.name}.json`;
  if (config["jsonReporter"]["fileName"] !== expectedReportPath) {
    throw new TypeError(
      `mutation report for ${scope.name} path does not match scope`,
    );
  }
  const reportFiles = value["files"];
  if (!isRecord(reportFiles)) {
    throw new TypeError(`mutation report for ${scope.name} files is required`);
  }
  const reportTargets = Object.keys(reportFiles);
  if (reportTargets.some((target) => !scope.mutate.includes(target))) {
    throw new TypeError(
      `mutation report for ${scope.name} contains an undeclared target`,
    );
  }
  const seenIds = new Set<string>();
  const seenFingerprints = new Set<string>();
  const files = scope.mutate
    .filter((target) => reportTargets.includes(target))
    .map((target) => {
    const fileValue = reportFiles[target];
    if (!isRecord(fileValue)) {
      throw new TypeError(
        `mutation report for ${scope.name} file ${target} is invalid`,
      );
    }
    if (fileValue["language"] !== "typescript") {
      throw new TypeError(
        `mutation report for ${scope.name} file ${target} is not TypeScript`,
      );
    }
    if (typeof fileValue["source"] !== "string") {
      throw new TypeError(
        `mutation report for ${scope.name} file ${target} source is invalid`,
      );
    }
    const source = fileValue["source"];
    if (source !== readSource(target)) {
      throw new TypeError(
        `mutation report source does not match current target: ${target}`,
      );
    }
    if (
      !Array.isArray(fileValue["mutants"])
      || fileValue["mutants"].length === 0
    ) {
      throw new TypeError(
        `mutation report for ${scope.name} file ${target} has no mutants`,
      );
    }
    const mutants = fileValue["mutants"].map((mutant, index) => {
      const parsed = parseRawMutant(
        mutant,
        source,
        `mutation report ${scope.name}/${target} mutant[${index}]`,
      );
      if (seenIds.has(parsed.id)) {
        throw new TypeError(
          `mutation report for ${scope.name} has duplicate mutant id: `
            + parsed.id,
        );
      }
      seenIds.add(parsed.id);
      const fingerprint = fingerprintParsedMutant(
        scope.name,
        target,
        source,
        parsed,
      );
      if (seenFingerprints.has(fingerprint)) {
        throw new TypeError(
          `mutation report for ${scope.name} has duplicate mutant fingerprint: `
            + fingerprint,
        );
      }
      seenFingerprints.add(fingerprint);
      return parsed;
    });
    return { target, source, mutants };
  });
  return { scope, files };
}

function emptyStatusCounts(): Record<RawMutationStatus, number> {
  return {
    Killed: 0,
    Survived: 0,
    NoCoverage: 0,
    CompileError: 0,
    RuntimeError: 0,
    Timeout: 0,
    Ignored: 0,
    Pending: 0,
  };
}

function evaluateScope(
  report: ParsedScopeReport,
  manifest: MutationManifest,
  ledger: MutationResidualLedger,
): MutationScopeSummary {
  const failures: string[] = [];
  const residuals: Array<{
    mutantFingerprint: string;
    disposition: ResidualDisposition;
  }> = [];
  const statusCounts = emptyStatusCounts();
  const reportedTargets = new Set(report.files.map((file) => file.target));
  const zeroMutantTargets = report.scope.mutate.filter((target) =>
    !reportedTargets.has(target)
  );
  const scopeEntries = ledger.entries.filter((entry) =>
    entry.scope === report.scope.name
  );
  const entryByFingerprint = new Map(
    scopeEntries.map((entry) => [entry.mutantFingerprint, entry]),
  );
  const seenEntries = new Set<string>();
  let accounted = 0;
  let equivalent = 0;
  let unreachable = 0;
  let deterministicTimeout = 0;

  for (const file of report.files) {
    for (const mutant of file.mutants) {
      statusCounts[mutant.status] += 1;
      const fingerprint = fingerprintParsedMutant(
        report.scope.name,
        file.target,
        file.source,
        mutant,
      );
      const entry = entryByFingerprint.get(fingerprint);
      if (mutant.status === "Killed") {
        accounted += 1;
        if (entry !== undefined) {
          seenEntries.add(fingerprint);
          failures.push(
            `residual disposition targets killed mutant ${fingerprint}`,
          );
        }
        continue;
      }
      if (
        mutant.status === "Survived"
        || mutant.status === "NoCoverage"
        || mutant.status === "Timeout"
      ) {
        if (entry === undefined) {
          failures.push(
            `unaccounted ${mutant.status} mutant ${fingerprint}`,
          );
          continue;
        }
        seenEntries.add(fingerprint);
        if (
          entry.target !== file.target
          || entry.rawStatus !== mutant.status
          || !expectedDisposition(entry.rawStatus, entry.disposition)
        ) {
          failures.push(
            `stale residual disposition for ${fingerprint}`,
          );
          continue;
        }
        accounted += 1;
        if (entry.disposition === "equivalent") equivalent += 1;
        if (entry.disposition === "unreachable") unreachable += 1;
        if (entry.disposition === "deterministic_timeout") {
          deterministicTimeout += 1;
        }
        residuals.push({
          mutantFingerprint: fingerprint,
          disposition: entry.disposition,
        });
        continue;
      }
      failures.push(`invalid ${mutant.status} mutant ${fingerprint}`);
    }
  }
  for (const entry of scopeEntries) {
    if (!seenEntries.has(entry.mutantFingerprint)) {
      failures.push(
        `unknown or stale residual disposition ${entry.mutantFingerprint}`,
      );
    }
  }
  const generated = Object.values(statusCounts)
    .reduce((total, count) => total + count, 0);
  const killed = statusCounts.Killed;
  const killedPercentage = generated === 0 ? 0 : killed / generated * 100;
  if (generated === 0) {
    failures.push("scope generated no mutants");
  }
  if (
    killed * 100
      < generated * manifest.minimumKilledPercentage
  ) {
    failures.push(
      `killed percentage ${killedPercentage} is below required `
        + manifest.minimumKilledPercentage,
    );
  }
  residuals.sort((left, right) =>
    left.mutantFingerprint.localeCompare(right.mutantFingerprint)
  );
  return {
    name: report.scope.name,
    tier: report.scope.tier,
    zeroMutantTargets,
    generated,
    killed,
    killedPercentage,
    accounted,
    equivalent,
    unreachable,
    deterministicTimeout,
    rawStatuses: statusCounts,
    policyPassed: failures.length === 0,
    residuals,
    failures,
  };
}

export function evaluateMutationRun(
  manifest: MutationManifest,
  reportValues: Readonly<Record<string, unknown>>,
  ledgerValue: unknown,
  options: EvaluateOptions,
): MutationRunSummary {
  const reportNames = Object.keys(reportValues);
  const expectedScopes = manifest.scopes.map((scope) => scope.name);
  if (reportNames.some((name) => !expectedScopes.includes(name))) {
    throw new TypeError("mutation run contains an unknown scope report");
  }
  if (
    options.partial
      ? reportNames.length !== 1
      : !sameStrings(reportNames, expectedScopes)
  ) {
    if (!options.partial) {
      throw new Error("full mutation run did not complete the exact manifest");
    }
    throw new Error("partial mutation run must contain one exact scope");
  }
  const ledger = parseMutationResidualLedger(ledgerValue, {
    manifest,
    fileExists: options.fileExists,
  });
  const selectedScopes = manifest.scopes.filter((scope) =>
    reportNames.includes(scope.name)
  );
  const parsedReports = selectedScopes.map((scope) =>
    parseScopeReport(
      reportValues[scope.name],
      scope,
      manifest,
      options.readSource,
    )
  );
  const scopes = parsedReports.map((report) =>
    evaluateScope(report, manifest, ledger)
  );
  const policyPassed = scopes.every((scope) => scope.policyPassed);
  const failures = scopes.flatMap((scope) =>
    scope.failures.map((failure) => `${scope.name}: ${failure}`)
  );
  const completedScopes = selectedScopes.map((scope) => scope.name);
  const missingScopes = expectedScopes.filter((scope) =>
    !completedScopes.includes(scope)
  );
  const fullScopeComplete = !options.partial && missingScopes.length === 0;
  return {
    formatVersion: 3,
    status: options.partial
      ? "partial"
      : policyPassed
      ? "passed"
      : "failed",
    policyPassed,
    fullScopeComplete,
    minimumKilledPercentage: 80,
    perScopeWorkerBudget: manifest.perScopeWorkerBudget,
    hostedMaxParallelScopes: manifest.hostedMaxParallelScopes,
    maximumHostedWorkers:
      manifest.perScopeWorkerBudget * manifest.hostedMaxParallelScopes,
    completedScopes,
    expectedScopes,
    missingScopes,
    scopes,
    failures,
  };
}
