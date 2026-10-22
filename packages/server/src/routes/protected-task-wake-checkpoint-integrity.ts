import { createDedicatedEncryptedCheckpointPool } from "@nautilo/agent";
import type { ProtectedTaskWakeContinuationReceipt } from "@nautilo/db";
import { readProtectedTaskCheckpointPhysicalManifest } from "@nautilo/runtime";

/** Read ciphertext metadata only; never open a checkpoint or borrow a grant. */
export async function verifyProtectedTaskWakeCheckpointIntegrity(
  receipt: ProtectedTaskWakeContinuationReceipt,
  read: typeof readProtectedTaskCheckpointPhysicalManifest =
    readProtectedTaskCheckpointPhysicalManifest,
): Promise<boolean> {
  if (receipt.checkpointThreadId !== `protected-task-wake:${receipt.wakeJobId}`) return false;
  const actual = await read({ logicalThreadId: receipt.checkpointThreadId,
    createDedicatedPool: createDedicatedEncryptedCheckpointPool });
  return actual.contract === receipt.checkpointContract
    && actual.expectedCheckpointCount === receipt.expectedCheckpointCount
    && actual.expectedBlobCount === receipt.expectedBlobCount
    && actual.expectedPendingWriteCount === receipt.expectedPendingWriteCount
    && Buffer.from(actual.checkpointOrderedDigest).equals(Buffer.from(receipt.checkpointOrderedDigest))
    && Buffer.from(actual.blobOrderedDigest).equals(Buffer.from(receipt.blobOrderedDigest))
    && Buffer.from(actual.pendingWriteOrderedDigest).equals(Buffer.from(receipt.pendingWriteOrderedDigest));
}
