import {
  createEncryptedCheckpointSaver,
  type CreateEncryptedCheckpointSaverOptions,
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

async function withOwnedTaskCheckpointSaver<Value>(
  input: Readonly<{
    cell: CheckpointCell;
    createDedicatedPool(): DedicatedPool;
    execute(saver: EncryptedCheckpointSaver): Promise<Value>;
  }>,
): Promise<Value> {
  const pool = input.createDedicatedPool();
  if (
    typeof pool !== "object" ||
    pool === null ||
    typeof pool.connect !== "function" ||
    typeof pool.end !== "function" ||
    ownedPools.has(pool)
  ) {
    throw new TypeError(
      "Protected Task checkpoint segment requires a fresh dedicated pool",
    );
  }
  ownedPools.add(pool);
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
