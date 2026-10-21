import {
  createDedicatedEncryptedCheckpointPool,
  readEncryptedCheckpointPhysicalManifest,
  type EncryptedCheckpointPhysicalManifest,
  type EncryptedCheckpointSaver,
} from "@nautilo/agent";

/** Drain one wake saver, then hash its exact encrypted physical rows. */
export async function sealProtectedTaskWakeCheckpointManifest(input: Readonly<{
  saver: EncryptedCheckpointSaver;
  checkpointThreadId: string;
}>): Promise<EncryptedCheckpointPhysicalManifest> {
  const quiescence = await input.saver.quiesce();
  if (quiescence.rejectedOperationCount !== 0
    || quiescence.pendingMaintenanceCount !== 0) {
    throw new Error("Protected Task wake checkpoint did not quiesce");
  }
  const pool = createDedicatedEncryptedCheckpointPool();
  let outcome:
    | Readonly<{ status: "fulfilled"; value: EncryptedCheckpointPhysicalManifest }>
    | Readonly<{ status: "rejected"; error: unknown }>;
  try {
    outcome = {
      status: "fulfilled",
      value: await readEncryptedCheckpointPhysicalManifest(pool, {
        logicalThreadId: input.checkpointThreadId,
        checkpointNamespace: "",
      }),
    };
  } catch (error) {
    outcome = { status: "rejected", error };
  }
  try {
    await pool.end();
  } catch (error) {
    if (outcome.status === "rejected") throw outcome.error;
    throw error;
  }
  if (outcome.status === "rejected") throw outcome.error;
  return outcome.value;
}
