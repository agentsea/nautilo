import type {
  MutationManifest,
  MutationScope,
} from "./mutation-governance.ts";
import { evaluateMutationRun } from "./mutation-policy.ts";
import {
  mutationManifestFingerprint,
  mutationTargetSourceFingerprint,
  type MutationEvidenceSummary,
  type MutationRevisionIdentity,
} from "./mutation-runner.ts";

export interface HostedMutationMatrix {
  readonly scope: readonly string[];
  readonly maxParallelScopes: number;
  readonly perScopeWorkers: number;
  readonly maximumHostedWorkers: number;
}

interface HostedScopeSelectionOptions {
  readonly requestedScope: string | undefined;
  readonly ci: string | undefined;
  readonly githubActions: string | undefined;
  readonly githubSha: string | undefined;
  readonly identity: MutationRevisionIdentity;
}

export interface HostedMutationArtifact {
  readonly scopeName: string;
  readonly report: unknown;
  readonly evidence: unknown;
}

export interface HostedMutationArtifactCollection {
  readonly artifacts: readonly HostedMutationArtifact[];
  readonly failures: readonly string[];
}

interface AggregateHostedMutationInput {
  readonly manifest: MutationManifest;
  readonly ledgerValue: unknown;
  readonly identity: MutationRevisionIdentity;
  readonly artifacts: readonly HostedMutationArtifact[];
}

interface AggregateAvailableHostedMutationInput
  extends AggregateHostedMutationInput {
  readonly failures: readonly string[];
}

interface AggregateHostedMutationDependencies {
  readonly readSource: (path: string) => string;
  readonly fileExists: (path: string) => boolean;
}

interface HostedMutationFailureInput {
  readonly manifest: MutationManifest;
  readonly identity: MutationRevisionIdentity;
  readonly completedScopes: readonly string[];
  readonly failure: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameStrings(
  left: unknown,
  right: readonly string[],
): boolean {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameRevision(
  value: unknown,
  expected: MutationRevisionIdentity,
): boolean {
  return isRecord(value)
    && value["commit"] === expected.commit
    && value["dirty"] === expected.dirty;
}

function assertCleanRevision(identity: MutationRevisionIdentity): void {
  if (!/^[a-f0-9]{40,64}$/u.test(identity.commit)) {
    throw new TypeError("hosted mutation revision must be a Git object id");
  }
  if (identity.dirty) {
    throw new Error("hosted mutation revision must be clean");
  }
}

function artifactReadFailure(
  scopeName: string,
  kind: "report" | "evidence",
  error: unknown,
): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${scopeName} ${kind} is unavailable or unreadable: ${detail}`;
}

export async function collectHostedMutationArtifacts(
  manifest: MutationManifest,
  readArtifact: (fileName: string) => Promise<unknown>,
): Promise<HostedMutationArtifactCollection> {
  const artifacts: HostedMutationArtifact[] = [];
  const failures: string[] = [];
  for (const scope of manifest.scopes) {
    let report: unknown;
    let evidence: unknown;
    let complete = true;
    try {
      report = await readArtifact(`${scope.name}.json`);
    } catch (error) {
      failures.push(artifactReadFailure(scope.name, "report", error));
      complete = false;
    }
    try {
      evidence = await readArtifact(`${scope.name}.evidence.json`);
    } catch (error) {
      failures.push(artifactReadFailure(scope.name, "evidence", error));
      complete = false;
    }
    if (complete) {
      artifacts.push({ scopeName: scope.name, report, evidence });
    }
  }
  return { artifacts, failures };
}

export function createHostedMutationMatrix(
  manifest: MutationManifest,
): HostedMutationMatrix {
  return {
    scope: manifest.scopes.map((scope) => scope.name),
    maxParallelScopes: manifest.hostedMaxParallelScopes,
    perScopeWorkers: manifest.perScopeWorkerBudget,
    maximumHostedWorkers:
      manifest.hostedMaxParallelScopes * manifest.perScopeWorkerBudget,
  };
}

export function selectHostedMutationScope(
  manifest: MutationManifest,
  options: HostedScopeSelectionOptions,
): MutationScope {
  assertCleanRevision(options.identity);
  if (options.ci !== "true" || options.githubActions !== "true") {
    throw new Error(
      "hosted mutation scope selection requires GitHub Actions CI",
    );
  }
  if (options.githubSha !== options.identity.commit) {
    throw new Error(
      "hosted mutation scope revision does not match GITHUB_SHA",
    );
  }
  const scope = manifest.scopes.find((candidate) =>
    candidate.name === options.requestedScope
  );
  if (scope === undefined) {
    throw new Error(
      `Unknown hosted lattice mutation scope: ${options.requestedScope ?? ""}`,
    );
  }
  return scope;
}

function assertScopeEvidence(
  scope: MutationScope,
  evidence: unknown,
  manifest: MutationManifest,
  identity: MutationRevisionIdentity,
  manifestFingerprint: string,
  sourceFingerprint: string,
): asserts evidence is MutationEvidenceSummary {
  if (!isRecord(evidence)) {
    throw new TypeError(
      `hosted mutation ${scope.name} evidence is not an object`,
    );
  }
  if (
    !sameRevision(evidence["revision"], identity)
    || !sameRevision(evidence["completionRevision"], identity)
  ) {
    throw new Error(
      `hosted mutation ${scope.name} evidence does not match the aggregate revision`,
    );
  }
  if (evidence["manifestFingerprint"] !== manifestFingerprint) {
    throw new Error(
      `hosted mutation ${scope.name} manifest fingerprint is stale`,
    );
  }
  if (
    evidence["targetSourceFingerprint"] !== sourceFingerprint
    || evidence["completionTargetSourceFingerprint"] !== sourceFingerprint
  ) {
    throw new Error(
      `hosted mutation ${scope.name} target source fingerprint is stale`,
    );
  }
  const expectedScopes = manifest.scopes.map((item) => item.name);
  const targetInventory = manifest.scopes.flatMap((item) => item.mutate);
  if (
    !sameStrings(evidence["completedScopes"], [scope.name])
    || !sameStrings(evidence["expectedScopes"], expectedScopes)
    || !sameStrings(evidence["targetInventory"], targetInventory)
    || evidence["fullScopeComplete"] !== false
    || evidence["status"] !== "partial"
  ) {
    throw new Error(
      `hosted mutation ${scope.name} evidence is not an exact partial scope result`,
    );
  }
}

export function aggregateHostedMutationEvidence(
  input: AggregateHostedMutationInput,
  dependencies: AggregateHostedMutationDependencies,
): MutationEvidenceSummary {
  assertCleanRevision(input.identity);
  const expectedNames = input.manifest.scopes.map((scope) => scope.name);
  const artifactsByScope = new Map<string, HostedMutationArtifact>();
  for (const artifact of input.artifacts) {
    if (!expectedNames.includes(artifact.scopeName)) {
      throw new Error(
        `unknown hosted mutation evidence: ${artifact.scopeName}`,
      );
    }
    if (artifactsByScope.has(artifact.scopeName)) {
      throw new Error(
        `duplicate hosted mutation evidence: ${artifact.scopeName}`,
      );
    }
    artifactsByScope.set(artifact.scopeName, artifact);
  }
  const missing = expectedNames.filter((name) => !artifactsByScope.has(name));
  if (missing.length > 0) {
    throw new Error(`missing hosted mutation evidence: ${missing.join(", ")}`);
  }

  const manifestFingerprint = mutationManifestFingerprint(input.manifest);
  const sourceFingerprint = mutationTargetSourceFingerprint(
    input.manifest,
    dependencies.readSource,
  );
  const reports: Record<string, unknown> = {};
  for (const scope of input.manifest.scopes) {
    const artifact = artifactsByScope.get(scope.name)!;
    assertScopeEvidence(
      scope,
      artifact.evidence,
      input.manifest,
      input.identity,
      manifestFingerprint,
      sourceFingerprint,
    );
    reports[scope.name] = artifact.report;
  }

  const policy = evaluateMutationRun(
    input.manifest,
    reports,
    input.ledgerValue,
    {
      partial: false,
      readSource: dependencies.readSource,
      fileExists: dependencies.fileExists,
    },
  );
  return {
    ...policy,
    revision: input.identity,
    completionRevision: input.identity,
    manifestFingerprint,
    targetSourceFingerprint: sourceFingerprint,
    completionTargetSourceFingerprint: sourceFingerprint,
    targetInventory: input.manifest.scopes.flatMap((scope) => scope.mutate),
  };
}

export function aggregateAvailableHostedMutationEvidence(
  input: AggregateAvailableHostedMutationInput,
  dependencies: AggregateHostedMutationDependencies,
): MutationEvidenceSummary {
  assertCleanRevision(input.identity);
  const expectedNames = input.manifest.scopes.map((scope) => scope.name);
  const artifactsByScope = new Map<string, HostedMutationArtifact>();
  for (const artifact of input.artifacts) {
    if (!expectedNames.includes(artifact.scopeName)) {
      throw new Error(
        `unknown hosted mutation evidence: ${artifact.scopeName}`,
      );
    }
    if (artifactsByScope.has(artifact.scopeName)) {
      throw new Error(
        `duplicate hosted mutation evidence: ${artifact.scopeName}`,
      );
    }
    artifactsByScope.set(artifact.scopeName, artifact);
  }

  const manifestFingerprint = mutationManifestFingerprint(input.manifest);
  const sourceFingerprint = mutationTargetSourceFingerprint(
    input.manifest,
    dependencies.readSource,
  );
  const scopeSummaries = input.manifest.scopes.flatMap((scope) => {
    const artifact = artifactsByScope.get(scope.name);
    if (artifact === undefined) return [];
    assertScopeEvidence(
      scope,
      artifact.evidence,
      input.manifest,
      input.identity,
      manifestFingerprint,
      sourceFingerprint,
    );
    return evaluateMutationRun(
      input.manifest,
      { [scope.name]: artifact.report },
      input.ledgerValue,
      {
        partial: true,
        readSource: dependencies.readSource,
        fileExists: dependencies.fileExists,
      },
    ).scopes;
  });
  const completedScopes = scopeSummaries.map((scope) => scope.name);
  const scopeFailures = scopeSummaries.flatMap((scope) =>
    scope.failures.map((failure) => `${scope.name}: ${failure}`)
  );
  return {
    formatVersion: 3,
    status: "failed",
    policyPassed: false,
    fullScopeComplete: false,
    minimumKilledPercentage: input.manifest.minimumKilledPercentage,
    perScopeWorkerBudget: input.manifest.perScopeWorkerBudget,
    hostedMaxParallelScopes: input.manifest.hostedMaxParallelScopes,
    maximumHostedWorkers:
      input.manifest.perScopeWorkerBudget
      * input.manifest.hostedMaxParallelScopes,
    completedScopes,
    expectedScopes: expectedNames,
    missingScopes: expectedNames.filter((scope) =>
      !completedScopes.includes(scope)
    ),
    scopes: scopeSummaries,
    failures: [...input.failures, ...scopeFailures],
    revision: input.identity,
    completionRevision: input.identity,
    manifestFingerprint,
    targetSourceFingerprint: sourceFingerprint,
    completionTargetSourceFingerprint: sourceFingerprint,
    targetInventory: input.manifest.scopes.flatMap((scope) => scope.mutate),
  };
}

export function createHostedMutationFailureEvidence(
  input: HostedMutationFailureInput,
  dependencies: Pick<AggregateHostedMutationDependencies, "readSource">,
): MutationEvidenceSummary {
  assertCleanRevision(input.identity);
  const expectedScopes = input.manifest.scopes.map((scope) => scope.name);
  const completedScopes = expectedScopes.filter((scope) =>
    input.completedScopes.includes(scope)
  );
  const sourceFingerprint = mutationTargetSourceFingerprint(
    input.manifest,
    dependencies.readSource,
  );
  return {
    formatVersion: 3,
    status: "failed",
    policyPassed: false,
    fullScopeComplete: false,
    minimumKilledPercentage: input.manifest.minimumKilledPercentage,
    perScopeWorkerBudget: input.manifest.perScopeWorkerBudget,
    hostedMaxParallelScopes: input.manifest.hostedMaxParallelScopes,
    maximumHostedWorkers:
      input.manifest.perScopeWorkerBudget
      * input.manifest.hostedMaxParallelScopes,
    completedScopes,
    expectedScopes,
    missingScopes: expectedScopes.filter((scope) =>
      !completedScopes.includes(scope)
    ),
    scopes: [],
    failures: [input.failure],
    revision: input.identity,
    completionRevision: input.identity,
    manifestFingerprint: mutationManifestFingerprint(input.manifest),
    targetSourceFingerprint: sourceFingerprint,
    completionTargetSourceFingerprint: sourceFingerprint,
    targetInventory: input.manifest.scopes.flatMap((scope) => scope.mutate),
  };
}
