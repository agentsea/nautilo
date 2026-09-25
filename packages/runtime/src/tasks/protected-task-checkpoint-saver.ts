import {
  createEncryptedCheckpointSaver,
  type CreateEncryptedCheckpointSaverOptions,
  type EncryptedCheckpointSaver,
} from "@nautilo/agent";
import {
  createTaskRuntimeCheckpointCellCrypto,
} from "@nautilo/lattice-bridge";

type DedicatedPool = CreateEncryptedCheckpointSaverOptions["dedicatedPool"];
type TaskCellInput = Parameters<typeof createTaskRuntimeCheckpointCellCrypto>[0];
const ownedPools = new WeakSet<object>();

/**
 * One Task-run graph segment owns one saver and physical checkpoint pool. The
 * callback cannot retain authority after this function closes the saver.
 */
export async function withProtectedTaskCheckpointSaver<Value>(input: Readonly<
  TaskCellInput & {
    createDedicatedPool(): DedicatedPool;
    execute(saver: EncryptedCheckpointSaver): Promise<Value>;
  }
>): Promise<Value> {
  const cell = createTaskRuntimeCheckpointCellCrypto(input);
  const pool = input.createDedicatedPool();
  if (typeof pool !== "object" || pool === null
    || typeof pool.connect !== "function"
    || typeof pool.end !== "function"
    || ownedPools.has(pool)) {
    throw new TypeError("Protected Task checkpoint segment requires a fresh dedicated pool");
  }
  ownedPools.add(pool);
  let saver: EncryptedCheckpointSaver;
  try {
    saver = createEncryptedCheckpointSaver({
      dedicatedPool: pool,
      crypto: cell.crypto,
      scope: cell.scope,
    });
  } catch (error) {
    await pool.end();
    throw error;
  }
  let outcome: Readonly<{ status: "fulfilled"; value: Value }>
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
