import {
  finalizeProtectedTaskCheckpointPause,
  getEncryptionTransitionPolicy,
  listProtectedTaskCheckpointPauseRecoveryCandidates,
  type DirectDatabase,
  type ProtectedTaskCheckpointPauseRecoveryCursor,
} from "@nautilo/db";

type Dependencies = Readonly<{
  readPolicy: typeof getEncryptionTransitionPolicy;
  list: typeof listProtectedTaskCheckpointPauseRecoveryCandidates;
  finalize: typeof finalizeProtectedTaskCheckpointPause;
}>;

const productionDependencies: Dependencies = Object.freeze({
  readPolicy: getEncryptionTransitionPolicy,
  list: listProtectedTaskCheckpointPauseRecoveryCandidates,
  finalize: finalizeProtectedTaskCheckpointPause,
});

export type ProtectedTaskCheckpointPauseRecoveryPageResult = Readonly<{
  status: "ready" | "inactive";
  attempted: number;
  paused: number;
  pending: number;
  inactiveIntents: number;
  failures: number;
  next: ProtectedTaskCheckpointPauseRecoveryCursor | null;
}>;

function emptyInactive(): ProtectedTaskCheckpointPauseRecoveryPageResult {
  return Object.freeze({
    status: "inactive",
    attempted: 0,
    paused: 0,
    pending: 0,
    inactiveIntents: 0,
    failures: 0,
    next: null,
  });
}

/**
 * Re-check durable checkpoint receipts after restart. Discovery supplies only
 * Task/request coordinates; the database finalizer remains the sole authority
 * that may acknowledge a protected Task as paused.
 */
export function createProtectedTaskCheckpointPauseRecovery(
  input: Readonly<{ db: DirectDatabase }>,
  overrides: Partial<Dependencies> = {},
) {
  const dependencies: Dependencies = Object.freeze({
    ...productionDependencies,
    ...overrides,
  });
  return Object.freeze({
    async recoverPage(options: Readonly<{
      limit: number;
      after?: ProtectedTaskCheckpointPauseRecoveryCursor;
    }>): Promise<ProtectedTaskCheckpointPauseRecoveryPageResult> {
      if ((await dependencies.readPolicy(input.db)).mode === "plaintext_only") {
        return emptyInactive();
      }
      const page = await dependencies.list(input.db, options);
      let paused = 0;
      let pending = 0;
      let inactiveIntents = 0;
      let failures = 0;
      for (const candidate of page.candidates) {
        try {
          const result = await dependencies.finalize(input.db, candidate);
          if (result === "paused" || result === "exact_replay") paused += 1;
          else if (result === "pending") pending += 1;
          else inactiveIntents += 1;
        } catch {
          failures += 1;
        }
      }
      return Object.freeze({
        status: "ready",
        attempted: page.candidates.length,
        paused,
        pending,
        inactiveIntents,
        failures,
        next: page.next,
      });
    },
  });
}
