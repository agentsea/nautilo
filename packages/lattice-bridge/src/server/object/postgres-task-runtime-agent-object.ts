import {
  persistPreparedTaskRuntimeAgentObjectAccessManifestGenesisSet,
  type CurrentTaskRuntimeAgentObjectAccessGenesisSetAuthorization,
  type LatticeCrypto,
  type LatticeStorage,
  type TaskRuntimeAgentObjectAccessGenesisSetAuthorityContext,
  type TaskRuntimeExecutionEvidence,
} from "@nautilo/lattice-crypto";

import {
  readPreparedTaskRuntimeAgentObjectSnapshot,
  type PreparedTaskRuntimeAgentObject,
} from "../../object/task-runtime-agent-object-crypto.ts";

type CasStatus = "applied" | "duplicate" | "stale";

export type TaskRuntimeAgentObjectPersistenceAuthority =
  Omit<CurrentTaskRuntimeAgentObjectAccessGenesisSetAuthorization, "storage">
  & Readonly<{
    storage: CurrentTaskRuntimeAgentObjectAccessGenesisSetAuthorization["storage"]
      & Pick<LatticeStorage, "putObject">;
  }>;

export type WithTaskRuntimeAgentObjectPersistenceAuthority = (
  context: TaskRuntimeAgentObjectAccessGenesisSetAuthorityContext,
  use: (authority: TaskRuntimeAgentObjectPersistenceAuthority) => Promise<CasStatus>,
) => Promise<CasStatus | null>;

class TaskRuntimeAgentObjectAuthorizationStale extends Error {}

/**
 * Publish payload and access rows only inside the caller's held authority
 * transaction. The owner must roll back when use throws and must lend storage
 * bound to that exact transaction; this helper never opens another connection.
 */
export async function persistTaskRuntimeAgentObject(input: Readonly<{
  crypto: LatticeCrypto;
  prepared: PreparedTaskRuntimeAgentObject;
  evidence: TaskRuntimeExecutionEvidence;
  withCurrentAuthorization: WithTaskRuntimeAgentObjectPersistenceAuthority;
}>): Promise<"created" | "duplicate" | "stale"> {
  const snapshot = readPreparedTaskRuntimeAgentObjectSnapshot(
    input.prepared,
    input.evidence,
  );
  try {
    const result = await persistPreparedTaskRuntimeAgentObjectAccessManifestGenesisSet({
      crypto: input.crypto,
      prepared: snapshot.access,
      evidence: input.evidence,
      withCurrentAuthorization: (context, use) => input.withCurrentAuthorization(
        context,
        async authority => {
          await authority.storage.putObject(snapshot.object);
          const status = await use(authority);
          if (status === "stale") {
            // Do not commit an orphan payload on a known rejected write.
            throw new TaskRuntimeAgentObjectAuthorizationStale();
          }
          return status;
        },
      ),
    });
    return result === "applied" ? "created" : result;
  } catch (error) {
    if (error instanceof TaskRuntimeAgentObjectAuthorizationStale) return "stale";
    throw error;
  }
}
