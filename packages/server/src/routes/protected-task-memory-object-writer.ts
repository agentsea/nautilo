import {
  eq,
  humanCryptoDevices,
} from "@nautilo/db";
import {
  deriveMemoryCryptoObjectIdV1,
  MEMORY_OBJECT_TYPE,
  type PreparedTaskRuntimeAgentObject,
} from "@nautilo/lattice-bridge";
import {
  cryptoTypedDb,
  executeTypedCryptoQuery,
  persistTaskRuntimeAgentObject,
  PostgresLatticeStorage,
} from "@nautilo/lattice-bridge/server";

import {
  requireHeldProtectedTaskMemoryWriterAuthority,
  taskMemoryAuthorityMatchesEvidence,
  withCurrentProtectedTaskMemoryAuthority,
  type HeldProtectedTaskMemoryAuthority,
  type ProtectedTaskMemoryAuthorityInput,
} from "./current-protected-task-memory-authority";

export type ProtectedTaskMemoryObjectWriterInput =
  ProtectedTaskMemoryAuthorityInput;

export type ProtectedTaskMemoryObjectWrite = Readonly<{
  memoryId: string;
  contentRevision: number;
  operationId: string;
  prepared: PreparedTaskRuntimeAgentObject;
}>;

export {
  taskMemoryAuthorityMatchesEvidence as taskMemoryWriteAuthorityMatchesEvidence,
};

function wipe(value: unknown): void {
  if (value instanceof Uint8Array) value.fill(0);
  else if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) wipe(nested);
  }
}

function objectIdFor(write: ProtectedTaskMemoryObjectWrite): string {
  const objectId = deriveMemoryCryptoObjectIdV1(write);
  if (write.prepared.objectId !== objectId
    || write.prepared.objectType !== MEMORY_OBJECT_TYPE
    || write.operationId.length === 0) {
    throw new TypeError("Task Memory object coordinate is not exact");
  }
  return objectId;
}

/**
 * Persist an already-prepared Task Memory object under one genuine held Task
 * authority. This path never opens another Task/request/Domain transaction.
 */
export async function persistProtectedTaskMemoryObjectUnderHeld(
  held: HeldProtectedTaskMemoryAuthority,
  write: ProtectedTaskMemoryObjectWrite,
): Promise<"created" | "duplicate" | "stale"> {
  const binding = requireHeldProtectedTaskMemoryWriterAuthority(held);
  const objectId = objectIdFor(write);
  await binding.assertCurrent();
  return persistTaskRuntimeAgentObject({
    crypto: binding.crypto,
    prepared: write.prepared,
    evidence: binding.evidence,
    withCurrentAuthorization: async (context, use) => {
      if (context.objectId !== objectId
        || context.operationId !== write.operationId) return null;
      await binding.assertCurrent();
      const storage = new PostgresLatticeStorage(binding.restrictedHandle);
      // Read immutable publication identity before taking the manager device
      // lock, then lock Runtime state and re-read publication.
      const publication = await storage.getAgentRuntimeSignerPublication(
        context.agentId,
        context.runtimeGeneration,
      );
      if (publication === null) return null;
      let state: Awaited<
        ReturnType<typeof storage.getAgentRuntimeAtomicState>
      > = null;
      let currentPublication: typeof publication | null = null;
      let managerKey: Uint8Array | null = null;
      try {
        const rows = await executeTypedCryptoQuery(
          binding.restricted,
          cryptoTypedDb.select({
            human_id: humanCryptoDevices.humanId,
            signing_public_key: humanCryptoDevices.signingPublicKey,
            state: humanCryptoDevices.state,
            revision: humanCryptoDevices.revision,
          }).from(humanCryptoDevices).where(eq(
            humanCryptoDevices.deviceId,
            publication.managerDeviceId,
          )).limit(2).for("share"),
        );
        const manager = rows[0];
        if (rows.length !== 1
          || manager === undefined
          || manager.human_id !== publication.managerHumanId
          || (manager.state !== "active" && manager.state !== "revoked")
          || manager.revision
            < publication.managerAuthorizationRevision) return null;
        managerKey = Uint8Array.from(manager.signing_public_key);
        state = await storage.getAgentRuntimeAtomicState(context.agentId);
        currentPublication = await storage.getAgentRuntimeSignerPublication(
          context.agentId,
          context.runtimeGeneration,
        );
        if (state === null
          || currentPublication === null
          || currentPublication.managerDeviceId
            !== publication.managerDeviceId
          || currentPublication.managerHumanId !== publication.managerHumanId
          || currentPublication.managerAuthorizationRevision
            !== publication.managerAuthorizationRevision) return null;
        const status = await use({
          storage,
          currentRuntime: state.runtime,
          signerPublication: currentPublication,
          currentManagerSigningPublicKey: managerKey,
        });
        await binding.assertCurrent();
        return status;
      } finally {
        wipe(publication);
        wipe(state);
        wipe(currentPublication);
        managerKey?.fill(0);
      }
    },
  });
}

/**
 * The sealed Task Memory crypto writer. Authority locks remain held through
 * payload and manifest CAS; semantic Memory mapping remains Agent-owned.
 */
export async function persistProtectedTaskMemoryObject(
  input: ProtectedTaskMemoryObjectWriterInput,
  write: ProtectedTaskMemoryObjectWrite,
): Promise<"created" | "duplicate" | "stale"> {
  objectIdFor(write);
  const result = await withCurrentProtectedTaskMemoryAuthority(
    input,
    held => persistProtectedTaskMemoryObjectUnderHeld(held, write),
  );
  return result ?? "stale";
}
