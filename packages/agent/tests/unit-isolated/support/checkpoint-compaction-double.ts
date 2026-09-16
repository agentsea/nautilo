import {
  runCompaction,
  type CompactionClient,
} from "../../../src/checkpoints/checkpoint-compaction";

/**
 * Compatibility surface for unit-isolated checkpoint-saver module mocks.
 *
 * Bun retains `mock.module` replacements across files in one process. Keeping
 * the real compaction behavior here prevents those narrow graph-construction
 * mocks from disabling encrypted-saver tests that happen to run later.
 */
export async function triggerCheckpointCompactionDouble(
  saver: unknown,
  resultConfig: unknown,
): Promise<void> {
  const configurable = (
    resultConfig as {
      configurable?: Record<string, unknown>;
    } | null
  )?.configurable;
  const threadId = configurable?.["thread_id"];
  const checkpointNs = configurable?.["checkpoint_ns"] ?? "";
  const retainedCheckpointId = configurable?.["checkpoint_id"];
  if (
    typeof threadId !== "string"
    || typeof checkpointNs !== "string"
    || typeof retainedCheckpointId !== "string"
  ) {
    return;
  }
  const pool = (
    saver as {
      pool?: {
        connect?: () => Promise<
          CompactionClient & { release(): void }
        >;
      };
    }
  ).pool;
  if (typeof pool?.connect !== "function") return;
  const client = await pool.connect();
  try {
    await runCompaction(
      client,
      threadId,
      checkpointNs,
      retainedCheckpointId,
    );
  } finally {
    client.release();
  }
}
