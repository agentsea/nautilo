import { createHash } from "node:crypto";
import type {
  MutationManifest,
  MutationScope,
} from "./mutation-governance.ts";
import {
  evaluateMutationRun,
  type MutationRunSummary,
} from "./mutation-policy.ts";

export interface ScopeExecution {
  readonly scope: MutationScope;
  readonly workerBudget: 4;
  readonly reportPath: string;
  readonly tempDirectory: string;
}

export interface MutationRevisionIdentity {
  readonly commit: string;
  readonly dirty: boolean;
}

export interface MutationEvidenceSummary extends MutationRunSummary {
  readonly revision: MutationRevisionIdentity;
  readonly completionRevision: MutationRevisionIdentity;
  readonly manifestFingerprint: string;
  readonly targetSourceFingerprint: string;
  readonly completionTargetSourceFingerprint: string;
  readonly targetInventory: readonly string[];
}

interface RunMutationScopesInput {
  readonly manifest: MutationManifest;
  readonly selectedScopes: readonly MutationScope[];
  readonly ledgerValue: unknown;
  readonly identity: MutationRevisionIdentity;
  readonly partial: boolean;
}

interface MutationRunnerDependencies {
  readonly executeScope: (execution: ScopeExecution) => Promise<number>;
  readonly readReport: (scope: MutationScope) => Promise<unknown>;
  readonly readSource: (path: string) => string;
  readonly fileExists: (path: string) => boolean;
  readonly readRevisionIdentity: () => Promise<MutationRevisionIdentity>;
}

function sha256(value: string): string {
  return `sha256:${
    createHash("sha256").update(value, "utf8").digest("hex")
  }`;
}

function exactScope(left: MutationScope, right: MutationScope): boolean {
  return left.name === right.name
    && left.tier === right.tier
    && left.command === right.command
    && left.mutate.length === right.mutate.length
    && left.mutate.every((target, index) => target === right.mutate[index]);
}

function assertSelectedScopes(
  manifest: MutationManifest,
  selectedScopes: readonly MutationScope[],
  partial: boolean,
): void {
  if (partial) {
    if (
      selectedScopes.length !== 1
      || !manifest.scopes.some((scope) =>
        exactScope(scope, selectedScopes[0]!)
      )
    ) {
      throw new Error("partial mutation run must select one exact scope");
    }
    return;
  }
  if (
    selectedScopes.length !== manifest.scopes.length
    || !selectedScopes.every((scope, index) =>
      exactScope(scope, manifest.scopes[index]!)
    )
  ) {
    throw new Error("full mutation run must select the exact manifest");
  }
}

function assertRevisionIdentity(identity: MutationRevisionIdentity): void {
  if (!/^[a-f0-9]{40,64}$/u.test(identity.commit)) {
    throw new TypeError("mutation revision commit must be a Git object id");
  }
  if (typeof identity.dirty !== "boolean") {
    throw new TypeError("mutation revision dirty marker must be boolean");
  }
}

export function mutationManifestFingerprint(
  manifest: MutationManifest,
): string {
  return sha256(`${JSON.stringify(manifest)}\n`);
}

export function mutationTargetSourceFingerprint(
  manifest: MutationManifest,
  readSource: (path: string) => string,
): string {
  const targets = manifest.scopes.flatMap((scope) => scope.mutate);
  const sourceIdentity = targets.map((target) => [
    target,
    sha256(readSource(target)),
  ]);
  return sha256(`${JSON.stringify(sourceIdentity)}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fatalPolicySummary(
  manifest: MutationManifest,
  completedScopes: readonly MutationRunSummary["scopes"][number][],
  failure: string,
): MutationRunSummary {
  const completedNames = completedScopes.map((scope) => scope.name);
  const expectedScopes = manifest.scopes.map((scope) => scope.name);
  return {
    formatVersion: 3,
    status: "failed",
    policyPassed: false,
    fullScopeComplete: false,
    minimumKilledPercentage: manifest.minimumKilledPercentage,
    perScopeWorkerBudget: manifest.perScopeWorkerBudget,
    hostedMaxParallelScopes: manifest.hostedMaxParallelScopes,
    maximumHostedWorkers:
      manifest.perScopeWorkerBudget * manifest.hostedMaxParallelScopes,
    completedScopes: completedNames,
    expectedScopes,
    missingScopes: expectedScopes.filter((scope) =>
      !completedNames.includes(scope)
    ),
    scopes: completedScopes,
    failures: [failure],
  };
}

function finishEvidence(
  input: RunMutationScopesInput,
  policy: MutationRunSummary,
  completionRevision: MutationRevisionIdentity,
  initialSourceFingerprint: string,
  completionSourceFingerprint: string,
): MutationEvidenceSummary {
  const failures = [...policy.failures];
  if (!input.partial && input.identity.dirty) {
    failures.push("full mutation run source tree is dirty");
  }
  if (
    input.identity.commit !== completionRevision.commit
    || input.identity.dirty !== completionRevision.dirty
  ) {
    failures.push("mutation revision identity changed during execution");
  }
  if (initialSourceFingerprint !== completionSourceFingerprint) {
    failures.push("mutation target source changed during execution");
  }
  const policyPassed = policy.policyPassed && failures.length === 0;
  return {
    ...policy,
    status: policy.status === "partial"
      ? "partial"
      : policyPassed
      ? "passed"
      : "failed",
    policyPassed,
    failures,
    revision: input.identity,
    completionRevision,
    manifestFingerprint: mutationManifestFingerprint(input.manifest),
    targetSourceFingerprint: initialSourceFingerprint,
    completionTargetSourceFingerprint: completionSourceFingerprint,
    targetInventory: input.manifest.scopes.flatMap((scope) => scope.mutate),
  };
}

export function mutationGateExitCode(
  summary: MutationRunSummary,
): 0 | 1 {
  return summary.policyPassed ? 0 : 1;
}

export async function runMutationScopes(
  input: RunMutationScopesInput,
  dependencies: MutationRunnerDependencies,
): Promise<MutationEvidenceSummary> {
  assertSelectedScopes(
    input.manifest,
    input.selectedScopes,
    input.partial,
  );
  assertRevisionIdentity(input.identity);
  const initialSourceFingerprint = mutationTargetSourceFingerprint(
    input.manifest,
    dependencies.readSource,
  );
  const reports: Record<string, unknown> = {};
  const completedScopeSummaries: MutationRunSummary["scopes"][number][] = [];
  let fatalFailure: string | undefined;
  for (const scope of input.selectedScopes) {
    const execution: ScopeExecution = {
      scope,
      workerBudget: input.manifest.perScopeWorkerBudget,
      reportPath: `reports/mutation/${scope.name}.json`,
      tempDirectory: `.stryker-tmp/${scope.name}`,
    };
    const exitCode = await dependencies.executeScope(execution);
    if (exitCode !== 0) {
      fatalFailure =
        `mutation scope ${scope.name} crashed with exit code ${exitCode}`;
      break;
    }
    let report: unknown;
    try {
      report = await dependencies.readReport(scope);
    } catch {
      fatalFailure =
        `mutation scope ${scope.name} report unavailable or unreadable`;
      break;
    }
    let scopePolicy: MutationRunSummary;
    try {
      scopePolicy = evaluateMutationRun(
        input.manifest,
        { [scope.name]: report },
        input.ledgerValue,
        {
          partial: true,
          readSource: dependencies.readSource,
          fileExists: dependencies.fileExists,
        },
      );
    } catch (error) {
      fatalFailure =
        `mutation scope ${scope.name} failed policy validation: ${
          errorMessage(error)
        }`;
      break;
    }
    completedScopeSummaries.push(scopePolicy.scopes[0]!);
    reports[scope.name] = report;
  }
  const policy = fatalFailure === undefined
    ? evaluateMutationRun(
      input.manifest,
      reports,
      input.ledgerValue,
      {
        partial: input.partial,
        readSource: dependencies.readSource,
        fileExists: dependencies.fileExists,
      },
    )
    : fatalPolicySummary(
      input.manifest,
      completedScopeSummaries,
      fatalFailure,
    );
  const completionRevision = await dependencies.readRevisionIdentity();
  assertRevisionIdentity(completionRevision);
  const completionSourceFingerprint = mutationTargetSourceFingerprint(
    input.manifest,
    dependencies.readSource,
  );
  return finishEvidence(
    input,
    policy,
    completionRevision,
    initialSourceFingerprint,
    completionSourceFingerprint,
  );
}
