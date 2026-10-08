import {
  createEncryptedCheckpointSaver,
  readEncryptedCheckpointPhysicalManifest,
  type CreateEncryptedCheckpointSaverOptions,
  type EncryptedCheckpointPhysicalManifest,
  type EncryptedCheckpointSaver,
} from "@nautilo/agent";
import { createTaskRuntimeCheckpointCellCrypto } from "@nautilo/lattice-bridge";
import {
  createNativeTaskRuntimeCheckpointCellCrypto,
  type NativeTaskRuntimeCheckpointCellCryptoInput,
} from "@nautilo/lattice-bridge/server";

type DedicatedPool = CreateEncryptedCheckpointSaverOptions["dedicatedPool"];
type TaskCellInput = Parameters<
  typeof createTaskRuntimeCheckpointCellCrypto
>[0];
type CheckpointCell = ReturnType<typeof createTaskRuntimeCheckpointCellCrypto>;
const ownedPools = new WeakSet<object>();

function freshOwnedPool(createDedicatedPool: () => DedicatedPool): DedicatedPool {
  const pool = createDedicatedPool();
  if (
    typeof pool !== "object"
    || pool === null
    || typeof pool.connect !== "function"
    || typeof pool.end !== "function"
    || ownedPools.has(pool)
  ) {
    throw new TypeError(
      "Protected Task checkpoint segment requires a fresh dedicated pool",
    );
  }
  ownedPools.add(pool);
  return pool;
}

function copyPhysicalManifest(
  manifest: EncryptedCheckpointPhysicalManifest,
): EncryptedCheckpointPhysicalManifest {
  return Object.freeze({
    contract: manifest.contract,
    expectedCheckpointCount: manifest.expectedCheckpointCount,
    checkpointOrderedDigest: manifest.checkpointOrderedDigest.slice(),
    expectedBlobCount: manifest.expectedBlobCount,
    blobOrderedDigest: manifest.blobOrderedDigest.slice(),
    expectedPendingWriteCount: manifest.expectedPendingWriteCount,
    pendingWriteOrderedDigest: manifest.pendingWriteOrderedDigest.slice(),
  });
}

async function withOwnedTaskCheckpointSaver<Value>(
  input: Readonly<{
    cell: CheckpointCell;
    createDedicatedPool(): DedicatedPool;
    execute(saver: EncryptedCheckpointSaver): Promise<Value>;
  }>,
): Promise<Value> {
  const pool = freshOwnedPool(() => input.createDedicatedPool());
  let saver: EncryptedCheckpointSaver;
  try {
    saver = createEncryptedCheckpointSaver({
      dedicatedPool: pool,
      crypto: input.cell.crypto,
      scope: input.cell.scope,
    });
  } catch (error) {
    await pool.end();
    throw error;
  }
  let outcome:
    | Readonly<{ status: "fulfilled"; value: Value }>
    | Readonly<{ status: "rejected"; error: unknown }>;
  try {
    outcome = { status: "fulfilled", value: await input.execute(saver) };
  } catch (error) {
    outcome = { status: "rejected", error };
  }
  const close = await saver.end();
  if (outcome.status === "rejected") throw outcome.error;
  if (close.status !== "closed") throw close.error;
  return outcome.value;
}

/**
 * One Task-run graph segment owns one saver and physical checkpoint pool. The
 * callback cannot retain authority after this function closes the saver.
 */
export async function withProtectedTaskCheckpointSaver<Value>(
  input: Readonly<
    TaskCellInput & {
      createDedicatedPool(): DedicatedPool;
      execute(saver: EncryptedCheckpointSaver): Promise<Value>;
    }
  >,
): Promise<Value> {
  return withOwnedTaskCheckpointSaver({
    cell: createTaskRuntimeCheckpointCellCrypto(input),
    createDedicatedPool: input.createDedicatedPool,
    execute: input.execute,
  });
}

/** Native Domain-bundle Task checkpoint cells, under the same one-run pool owner. */
export async function withNativeProtectedTaskCheckpointSaver<Value>(
  input: Readonly<
    NativeTaskRuntimeCheckpointCellCryptoInput & {
      createDedicatedPool(): DedicatedPool;
      execute(saver: EncryptedCheckpointSaver): Promise<Value>;
    }
  >,
): Promise<Value> {
  return withOwnedTaskCheckpointSaver({
    cell: createNativeTaskRuntimeCheckpointCellCrypto(input),
    createDedicatedPool: input.createDedicatedPool,
    execute: input.execute,
  });
}

export type NativeProtectedTaskCheckpointManifestResult<Value> = Readonly<{
  value: Value;
  manifest: EncryptedCheckpointPhysicalManifest;
}>;

/**
 * Native Task segment owner that closes saver admissions, drains every
 * accepted operation, hashes the exact encrypted physical rows, then closes
 * the dedicated pool. Existing foreground/compatibility owners retain the
 * original value-only close contract above.
 */
export async function withNativeProtectedTaskCheckpointManifest<Value>(
  input: Readonly<
    NativeTaskRuntimeCheckpointCellCryptoInput & {
      createDedicatedPool(): DedicatedPool;
      execute(saver: EncryptedCheckpointSaver): Promise<Value>;
    }
  >,
): Promise<NativeProtectedTaskCheckpointManifestResult<Value>> {
  const createDedicatedPool = input.createDedicatedPool;
  const execute = input.execute;
  const assertCurrentTaskAuthority = input.assertCurrentTaskAuthority;
  const logicalThreadId = input.identity.graphThreadId;
  const signal = input.signal;
  const pool = freshOwnedPool(createDedicatedPool);
  let saver: EncryptedCheckpointSaver;
  try {
    const cell = createNativeTaskRuntimeCheckpointCellCrypto(input);
    saver = createEncryptedCheckpointSaver({
      dedicatedPool: pool,
      crypto: cell.crypto,
      scope: cell.scope,
    });
  } catch (error) {
    await pool.end();
    throw error;
  }

  let outcome:
    | Readonly<{
        status: "fulfilled";
        value: NativeProtectedTaskCheckpointManifestResult<Value>;
      }>
    | Readonly<{ status: "rejected"; error: unknown }>;
  try {
    const value = await execute(saver);
    const quiescence = await saver.quiesce();
    if (quiescence.rejectedOperationCount !== 0) {
      throw new Error(
        "Protected Task checkpoint segment has rejected operations",
      );
    }
    if (quiescence.pendingMaintenanceCount !== 0) {
      throw new Error(
        "Protected Task checkpoint segment has pending maintenance",
      );
    }
    signal.throwIfAborted();
    await assertCurrentTaskAuthority();
    signal.throwIfAborted();
    const manifest = await readEncryptedCheckpointPhysicalManifest(pool, {
      logicalThreadId,
      checkpointNamespace: "",
    });
    signal.throwIfAborted();
    await assertCurrentTaskAuthority();
    signal.throwIfAborted();
    outcome = {
      status: "fulfilled",
      value: Object.freeze({ value, manifest }),
    };
  } catch (error) {
    outcome = { status: "rejected", error };
  }
  const close = await saver.end();
  if (outcome.status === "rejected") throw outcome.error;
  if (close.status !== "closed") throw close.error;
  return outcome.value;
}

/**
 * Read one parked Task's encrypted checkpoint manifest without constructing a
 * saver or opening checkpoint crypto. The fresh physical pool is always closed
 * before the detached manifest becomes observable to the caller.
 */
export async function readProtectedTaskCheckpointPhysicalManifest(
  input: Readonly<{
    logicalThreadId: string;
    createDedicatedPool(): DedicatedPool;
  }>,
): Promise<EncryptedCheckpointPhysicalManifest> {
  const pool = freshOwnedPool(() => input.createDedicatedPool());
  let outcome:
    | Readonly<{
        status: "fulfilled";
        manifest: EncryptedCheckpointPhysicalManifest;
      }>
    | Readonly<{ status: "rejected"; error: unknown }>;
  try {
    outcome = {
      status: "fulfilled",
      manifest: copyPhysicalManifest(
        await readEncryptedCheckpointPhysicalManifest(pool, {
          logicalThreadId: input.logicalThreadId,
          checkpointNamespace: "",
        }),
      ),
    };
  } catch (error) {
    outcome = { status: "rejected", error };
  }
  try {
    await pool.end();
  } catch (error) {
    if (outcome.status === "rejected") throw outcome.error;
    throw error instanceof Error
      ? error
      : new Error("Protected Task checkpoint pool could not close", {
        cause: error,
      });
  }
  if (outcome.status === "rejected") throw outcome.error;
  return outcome.manifest;
}
