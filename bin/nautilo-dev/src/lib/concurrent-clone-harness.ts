import {
  assertConcurrentCloneIsolationEvidence,
  assertPopulatedCloneSourceUnchanged,
  type ConcurrentCloneIsolationEvidence,
  type ConcurrentCloneTargetEvidence,
  type PopulatedCloneSourceFingerprint,
} from "./clone-isolation-evidence";

export type ConcurrentCloneHarnessFailureCode =
  | "target-collision"
  | "disk-pressure"
  | "refresh-race"
  | "lineage-divergence"
  | "import-failure"
  | "cleanup-failure"
  | "materialization-failure";

export class ConcurrentCloneHarnessScenarioError extends Error {
  constructor(readonly code: ConcurrentCloneHarnessFailureCode) {
    super(`Concurrent clone harness scenario failed: ${code}`);
    this.name = "ConcurrentCloneHarnessScenarioError";
  }
}

export interface ConcurrentCloneHarnessDependencies<Seed> {
  readonly targetIds: readonly [string, string];
  readonly captureSourceFingerprint: () => Promise<PopulatedCloneSourceFingerprint>;
  /** Must publish or reuse one verified immutable seed. Called exactly once. */
  readonly captureSeed: () => Promise<Seed>;
  /** Both calls are launched in one Promise.allSettled turn with the same seed. */
  readonly materializeTarget: (
    seed: Seed,
    targetId: string,
  ) => Promise<ConcurrentCloneTargetEvidence>;
  /** Stops/removes only the failed target's disposable state. */
  readonly cleanupFailedTarget: (targetId: string) => Promise<void>;
  /** Probe live PID/listener/log surfaces rather than trusting proposed evidence. */
  readonly verifyTargetRuntime: (target: ConcurrentCloneTargetEvidence) => Promise<void>;
}

export interface ConcurrentCloneHarnessResult<Seed> {
  readonly seed: Seed;
  readonly evidence: ConcurrentCloneIsolationEvidence;
}

function scenarioCode(error: unknown): ConcurrentCloneHarnessFailureCode {
  return error instanceof ConcurrentCloneHarnessScenarioError
    ? error.code
    : "materialization-failure";
}

/**
 * Executable Task-2.4 spine: fingerprint populated source, capture one seed,
 * launch two materializations concurrently, clean only rejected targets, and
 * prove aggregate source/topology/runtime isolation before returning success.
 */
export async function runConcurrentCloneHarness<Seed>(
  deps: ConcurrentCloneHarnessDependencies<Seed>,
): Promise<ConcurrentCloneHarnessResult<Seed>> {
  const before = await deps.captureSourceFingerprint();
  let seed: Seed;
  try {
    seed = await deps.captureSeed();
  } catch (error) {
    assertPopulatedCloneSourceUnchanged(before, await deps.captureSourceFingerprint());
    throw error;
  }

  const settled = await Promise.allSettled(
    deps.targetIds.map((targetId) => deps.materializeTarget(seed, targetId)),
  );
  const cleanupCodes: ConcurrentCloneHarnessFailureCode[] = [];
  await Promise.all(settled.map(async (result, index) => {
    if (result.status === "fulfilled") return;
    try {
      await deps.cleanupFailedTarget(deps.targetIds[index] as string);
    } catch {
      cleanupCodes.push("cleanup-failure");
    }
  }));

  const after = await deps.captureSourceFingerprint();
  assertPopulatedCloneSourceUnchanged(before, after);
  const failed = settled.flatMap((result) =>
    result.status === "rejected" ? [scenarioCode(result.reason)] : [],
  );
  const failureCode = cleanupCodes[0] ?? failed[0];
  if (failureCode !== undefined) throw new ConcurrentCloneHarnessScenarioError(failureCode);

  const targets = settled.map((result) => {
    if (result.status !== "fulfilled") throw new Error("unreachable rejected materialization");
    return result.value;
  }) as [ConcurrentCloneTargetEvidence, ConcurrentCloneTargetEvidence];
  const evidence = { sourceBefore: before, sourceAfter: after, targets };
  try {
    assertConcurrentCloneIsolationEvidence(evidence);
    await Promise.all(targets.map((target) => deps.verifyTargetRuntime(target)));
  } catch (error) {
    const cleanup = await Promise.allSettled(deps.targetIds.map((targetId) => deps.cleanupFailedTarget(targetId)));
    if (cleanup.some((result) => result.status === "rejected")) {
      throw new ConcurrentCloneHarnessScenarioError("cleanup-failure");
    }
    throw error;
  }
  return { seed, evidence };
}
