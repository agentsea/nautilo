export interface MutationScope {
  readonly name: string;
  readonly tier: "critical" | "provider";
  readonly mutate: readonly string[];
  readonly command: string;
}

export interface ReviewedDuplicateTarget {
  readonly target: string;
  readonly scopes: readonly string[];
  readonly reason: string;
}

export interface ReviewedMutationExclusion {
  readonly target: string;
  readonly reason: string;
  readonly compensatingCommands: readonly string[];
  readonly compensatingTests: readonly string[];
}

export interface MutationManifest {
  readonly formatVersion: 3;
  readonly minimumKilledPercentage: 80;
  readonly perScopeWorkerBudget: 4;
  readonly hostedMaxParallelScopes: 4;
  readonly scopes: readonly MutationScope[];
  readonly reviewedDuplicateTargets: readonly ReviewedDuplicateTarget[];
  readonly reviewedExclusions: readonly ReviewedMutationExclusion[];
}

interface ParseManifestOptions {
  readonly fileExists: (path: string) => boolean;
}

interface SelectScopesOptions {
  readonly requestedScope: string | undefined;
  readonly ci: string | undefined;
}

interface SelectTargetOptions {
  readonly requestedTarget: string | undefined;
  readonly requestedRange: string | undefined;
  readonly ci: string | undefined;
}

export interface MutationTargetSelection {
  readonly scope: MutationScope;
  readonly target: string;
  readonly mutatePattern: string;
}

interface MutationSource {
  readonly path: string;
  readonly source: string;
}

const manifestFields = [
  "formatVersion",
  "minimumKilledPercentage",
  "perScopeWorkerBudget",
  "hostedMaxParallelScopes",
  "scopes",
  "reviewedDuplicateTargets",
  "reviewedExclusions",
] as const;
const scopeFields = ["name", "tier", "mutate", "command"] as const;
const duplicateFields = ["target", "scopes", "reason"] as const;
const exclusionFields = [
  "target",
  "reason",
  "compensatingCommands",
  "compensatingTests",
] as const;
const commandPrefix = [
  "bun",
  "test",
  "--bail=1",
  "--timeout",
  "60000",
] as const;
const mutationSuppressionPattern = /\bStryker\s+(?:disable|restore)\b/u;
const mutationRangePattern =
  /^[1-9]\d*(?::(?:0|[1-9]\d*))?-[1-9]\d*(?::(?:0|[1-9]\d*))?$/u;

export function assertNoMutationSuppression(
  sources: readonly MutationSource[],
): void {
  for (const { path, source } of sources) {
    const lineIndex = source.split("\n").findIndex((line) =>
      mutationSuppressionPattern.test(line)
    );
    if (lineIndex >= 0) {
      throw new Error(
        `inline Stryker suppression is forbidden: ${path}:${lineIndex + 1}`,
      );
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactFields(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const expectedSet = new Set(expected);
  for (const field of Object.keys(value)) {
    if (!expectedSet.has(field)) {
      throw new TypeError(`${label} has unexpected field: ${field}`);
    }
  }
  for (const field of expected) {
    if (!(field in value)) {
      throw new TypeError(`${label} is missing field: ${field}`);
    }
  }
}

function assertNonEmptyString(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty trimmed string`);
  }
}

function parseUniqueStrings(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string array`);
  }
  for (const [index, item] of value.entries()) {
    assertNonEmptyString(item, `${label}[${index}]`);
  }
  const strings = value as string[];
  if (new Set(strings).size !== strings.length) {
    throw new TypeError(`${label} must not contain duplicates`);
  }
  return strings;
}

function assertGovernedPath(
  path: string,
  prefix: "src/" | "tests/",
  suffix: ".ts" | ".test.ts",
  label: string,
  fileExists: (path: string) => boolean,
): void {
  if (
    !path.startsWith(prefix)
    || !path.endsWith(suffix)
    || path.includes("..")
    || path.includes("\\")
    || /[*?[\]:]/u.test(path)
  ) {
    throw new TypeError(`${label} is not a canonical ${prefix} path: ${path}`);
  }
  if (!fileExists(path)) {
    throw new TypeError(`${label} does not exist: ${path}`);
  }
}

function parseScope(
  value: unknown,
  index: number,
  fileExists: (path: string) => boolean,
): MutationScope {
  if (!isRecord(value)) {
    throw new TypeError(`scopes[${index}] must be an object`);
  }
  const label = `scopes[${index}]`;
  assertExactFields(value, scopeFields, label);
  assertNonEmptyString(value["name"], `${label}.name`);
  if (!/^[a-z0-9-]+$/u.test(value["name"])) {
    throw new TypeError(`${label}.name is invalid: ${value["name"]}`);
  }
  if (value["tier"] !== "critical" && value["tier"] !== "provider") {
    throw new TypeError(`${label}.tier must be critical or provider`);
  }
  const mutate = parseUniqueStrings(value["mutate"], `${label}.mutate`);
  for (const target of mutate) {
    assertGovernedPath(
      target,
      "src/",
      ".ts",
      `${label}.mutate target`,
      fileExists,
    );
  }
  assertNonEmptyString(value["command"], `${label}.command`);
  const commandParts = value["command"].split(" ");
  if (
    commandParts.length <= commandPrefix.length
    || !commandPrefix.every((part, commandIndex) =>
      commandParts[commandIndex] === part
    )
  ) {
    throw new TypeError(
      `${label}.command must be an exact bun test --bail=1 --timeout 60000 command`,
    );
  }
  const testPaths = commandParts.slice(commandPrefix.length);
  if (new Set(testPaths).size !== testPaths.length) {
    throw new TypeError(`${label}.command must not repeat test files`);
  }
  for (const testPath of testPaths) {
    assertGovernedPath(
      testPath,
      "tests/",
      ".test.ts",
      `${label}.command test`,
      fileExists,
    );
  }
  return {
    name: value["name"],
    tier: value["tier"],
    mutate,
    command: value["command"],
  };
}

function parseReviewedDuplicate(
  value: unknown,
  index: number,
  fileExists: (path: string) => boolean,
): ReviewedDuplicateTarget {
  if (!isRecord(value)) {
    throw new TypeError(`reviewedDuplicateTargets[${index}] must be an object`);
  }
  const label = `reviewedDuplicateTargets[${index}]`;
  assertExactFields(value, duplicateFields, label);
  assertNonEmptyString(value["target"], `${label}.target`);
  assertGovernedPath(
    value["target"],
    "src/",
    ".ts",
    `${label}.target`,
    fileExists,
  );
  const scopes = parseUniqueStrings(value["scopes"], `${label}.scopes`);
  if (scopes.length < 2) {
    throw new TypeError(`${label}.scopes must name at least two scopes`);
  }
  assertNonEmptyString(value["reason"], `${label}.reason`);
  return {
    target: value["target"],
    scopes,
    reason: value["reason"],
  };
}

function parseReviewedExclusion(
  value: unknown,
  index: number,
  fileExists: (path: string) => boolean,
): ReviewedMutationExclusion {
  if (!isRecord(value)) {
    throw new TypeError(`reviewedExclusions[${index}] must be an object`);
  }
  const label = `reviewedExclusions[${index}]`;
  assertExactFields(value, exclusionFields, label);
  assertNonEmptyString(value["target"], `${label}.target`);
  assertGovernedPath(
    value["target"],
    "src/",
    ".ts",
    `${label}.target`,
    fileExists,
  );
  assertNonEmptyString(value["reason"], `${label}.reason`);
  const compensatingCommands = parseUniqueStrings(
    value["compensatingCommands"],
    `${label}.compensatingCommands`,
  );
  const compensatingTests = parseUniqueStrings(
    value["compensatingTests"],
    `${label}.compensatingTests`,
  );
  for (const testPath of compensatingTests) {
    assertGovernedPath(
      testPath,
      "tests/",
      ".test.ts",
      `${label}.compensatingTests entry`,
      fileExists,
    );
  }
  return {
    target: value["target"],
    reason: value["reason"],
    compensatingCommands,
    compensatingTests,
  };
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function parseMutationManifest(
  value: unknown,
  options: ParseManifestOptions,
): MutationManifest {
  if (!isRecord(value)) {
    throw new TypeError("mutation manifest must be an object");
  }
  assertExactFields(value, manifestFields, "mutation manifest");
  if (value["formatVersion"] !== 3) {
    throw new TypeError("mutation manifest formatVersion must be 3");
  }
  if (value["minimumKilledPercentage"] !== 80) {
    throw new TypeError(
      "mutation manifest minimumKilledPercentage must be 80",
    );
  }
  if (value["perScopeWorkerBudget"] !== 4) {
    throw new TypeError("mutation manifest perScopeWorkerBudget must be 4");
  }
  if (value["hostedMaxParallelScopes"] !== 4) {
    throw new TypeError(
      "mutation manifest hostedMaxParallelScopes must be 4",
    );
  }
  if (!Array.isArray(value["scopes"]) || value["scopes"].length === 0) {
    throw new TypeError("mutation manifest scopes must be non-empty");
  }
  const scopes = value["scopes"].map((scope, index) =>
    parseScope(scope, index, options.fileExists)
  );
  const scopeNames = scopes.map((scope) => scope.name);
  if (new Set(scopeNames).size !== scopeNames.length) {
    throw new TypeError("mutation manifest scope names must be unique");
  }
  if (!Array.isArray(value["reviewedDuplicateTargets"])) {
    throw new TypeError("reviewedDuplicateTargets must be an array");
  }
  const reviewedDuplicateTargets = value["reviewedDuplicateTargets"].map(
    (item, index) =>
      parseReviewedDuplicate(item, index, options.fileExists),
  );
  const duplicatePolicyTargets = reviewedDuplicateTargets.map((item) =>
    item.target
  );
  if (new Set(duplicatePolicyTargets).size !== duplicatePolicyTargets.length) {
    throw new TypeError("reviewed duplicate policy targets must be unique");
  }
  if (!Array.isArray(value["reviewedExclusions"])) {
    throw new TypeError("reviewedExclusions must be an array");
  }
  const reviewedExclusions = value["reviewedExclusions"].map((item, index) =>
    parseReviewedExclusion(item, index, options.fileExists)
  );
  const exclusionTargets = reviewedExclusions.map((item) => item.target);
  if (new Set(exclusionTargets).size !== exclusionTargets.length) {
    throw new TypeError("reviewed exclusion targets must be unique");
  }

  const targetScopes = new Map<string, string[]>();
  for (const scope of scopes) {
    for (const target of scope.mutate) {
      targetScopes.set(target, [...(targetScopes.get(target) ?? []), scope.name]);
    }
  }
  const duplicates = [...targetScopes.entries()]
    .filter(([, owners]) => owners.length > 1);
  for (const [target, owners] of duplicates) {
    const policy = reviewedDuplicateTargets.find((item) =>
      item.target === target
    );
    if (policy === undefined || !sameStrings(policy.scopes, owners)) {
      throw new TypeError(
        `duplicate mutation target lacks exact reviewed policy: ${target}`,
      );
    }
  }
  for (const policy of reviewedDuplicateTargets) {
    const owners = targetScopes.get(policy.target);
    if (owners === undefined || !sameStrings(policy.scopes, owners)) {
      throw new TypeError(
        `reviewed duplicate policy does not match inventory: ${policy.target}`,
      );
    }
  }
  for (const exclusion of reviewedExclusions) {
    if (targetScopes.has(exclusion.target)) {
      throw new TypeError(
        `mutation target cannot also be a reviewed exclusion: ${exclusion.target}`,
      );
    }
  }

  return {
    formatVersion: 3,
    minimumKilledPercentage: 80,
    perScopeWorkerBudget: 4,
    hostedMaxParallelScopes: 4,
    scopes,
    reviewedDuplicateTargets,
    reviewedExclusions,
  };
}

export function assertCompleteMutationCoverage(
  manifest: MutationManifest,
  eligibleTargets: readonly string[],
): void {
  const eligible = new Set(eligibleTargets);
  if (eligible.size !== eligibleTargets.length) {
    throw new TypeError("eligible mutation targets must be unique");
  }
  const covered = new Set(manifest.scopes.flatMap((scope) => scope.mutate));
  const excluded = new Set(
    manifest.reviewedExclusions.map((item) => item.target),
  );
  const missing = eligibleTargets.filter((target) =>
    !covered.has(target) && !excluded.has(target)
  );
  if (missing.length > 0) {
    throw new Error(
      `eligible mutation targets are unclassified: ${missing.join(", ")}`,
    );
  }
  const unexpected = [...covered, ...excluded]
    .filter((target) => !eligible.has(target));
  if (unexpected.length > 0) {
    throw new Error(
      `mutation policy targets are not runtime-reachable: ${
        unexpected.join(", ")
      }`,
    );
  }
}

export function selectMutationScopes(
  manifest: MutationManifest,
  options: SelectScopesOptions,
): readonly MutationScope[] {
  if (options.ci === "true" && options.requestedScope !== undefined) {
    throw new Error("LATTICE_MUTATION_SCOPE_ONLY cannot be used when CI=true");
  }
  if (options.requestedScope === undefined) {
    return manifest.scopes;
  }
  const selected = manifest.scopes.filter((scope) =>
    scope.name === options.requestedScope
  );
  if (selected.length === 0) {
    throw new Error(
      `Unknown lattice mutation scope: ${options.requestedScope}`,
    );
  }
  return selected;
}

export function selectMutationTarget(
  manifest: MutationManifest,
  options: SelectTargetOptions,
): MutationTargetSelection {
  if (options.ci === "true") {
    throw new Error(
      "LATTICE_MUTATION_TARGET_ONLY cannot be used when CI=true",
    );
  }
  if (options.requestedTarget === undefined) {
    throw new Error("LATTICE_MUTATION_TARGET_ONLY is required");
  }
  const owners = manifest.scopes.filter((scope) =>
    scope.mutate.includes(options.requestedTarget!)
  );
  if (owners.length === 0) {
    throw new Error(
      `Unknown lattice mutation target: ${options.requestedTarget}`,
    );
  }
  if (owners.length > 1) {
    throw new Error(
      `Multiply-owned lattice mutation target requires a scope: ${
        options.requestedTarget
      }`,
    );
  }
  if (
    options.requestedRange !== undefined
    && !mutationRangePattern.test(options.requestedRange)
  ) {
    throw new Error(
      "LATTICE_MUTATION_RANGE_ONLY is invalid; expected "
        + "startLine[:startColumn]-endLine[:endColumn]",
    );
  }
  return {
    scope: owners[0]!,
    target: options.requestedTarget,
    mutatePattern: options.requestedRange === undefined
      ? options.requestedTarget
      : `${options.requestedTarget}:${options.requestedRange}`,
  };
}
