import { createDedicatedEncryptedCheckpointPool } from "@nautilo/agent";
import {
  listProtectedTaskActivationParkedIntegrityCandidates,
  readProtectedTaskTranscriptManifestInTx,
} from "@nautilo/db";
import {
  readProtectedTaskCheckpointPhysicalManifest,
} from "@nautilo/runtime";
import type { CanonicalTranscriptTx } from "@nautilo/trust";

type Dependencies = Readonly<{
  list: typeof listProtectedTaskActivationParkedIntegrityCandidates;
  readTranscript: typeof readProtectedTaskTranscriptManifestInTx;
  readPhysical: typeof readProtectedTaskCheckpointPhysicalManifest;
}>;

function sameBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right;
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

const productionDependencies: Dependencies = Object.freeze({
  list: listProtectedTaskActivationParkedIntegrityCandidates,
  readTranscript: readProtectedTaskTranscriptManifestInTx,
  readPhysical: readProtectedTaskCheckpointPhysicalManifest,
});

/** Verify every currently linked park against immutable product and physical proof. */
export function createProtectedTaskActivationParkedIntegrityInspector(
  input: Readonly<{
    createDedicatedPool?: Parameters<
      typeof readProtectedTaskCheckpointPhysicalManifest
    >[0]["createDedicatedPool"];
  }> = {},
  dependencies: Partial<Dependencies> = {},
) {
  const ports: Dependencies = Object.freeze({
    ...productionDependencies,
    ...dependencies,
  });
  const createDedicatedPool = input.createDedicatedPool
    ?? createDedicatedEncryptedCheckpointPool;
  return async (request: Readonly<{
    transaction: CanonicalTranscriptTx;
    policyRevision: number;
    expectedJobs: bigint;
    now: Date;
  }>): Promise<Readonly<{
    status: "verified" | "unavailable";
    verifiedJobs: bigint;
  }>> => {
    if (!Number.isSafeInteger(request.policyRevision)
      || request.policyRevision < 1
      || request.expectedJobs < 0n
      || !Number.isFinite(request.now.getTime())) {
      return Object.freeze({ status: "unavailable" as const, verifiedJobs: 0n });
    }
    let verifiedJobs = 0n;
    let afterJobId: string | undefined;
    try {
      do {
        const page = await ports.list(request.transaction, {
          ...(afterJobId === undefined ? {} : { afterJobId }),
        });
        for (const candidate of page.candidates) {
          if (candidate.acceptedPolicyRevision > request.policyRevision) {
            return Object.freeze({ status: "unavailable" as const, verifiedJobs });
          }
          if (candidate.kind === "execution") {
            const transcript = await ports.readTranscript(request.transaction, {
              taskId: candidate.taskId,
              taskRunId: candidate.taskRunId,
              graphThreadId: candidate.graphThreadId,
            });
            if (transcript.contract !== candidate.transcript.contract
              || transcript.expectedAssociationCount
                !== candidate.transcript.expectedAssociationCount
              || !sameBytes(
                transcript.orderedDigest,
                candidate.transcript.orderedDigest,
              )) {
              return Object.freeze({ status: "unavailable" as const, verifiedJobs });
            }
          }
          const physical = await ports.readPhysical({
            logicalThreadId: candidate.kind === "execution"
              ? candidate.graphThreadId
              : candidate.checkpointThreadId,
            createDedicatedPool,
          });
          const checkpoint = candidate.checkpoint;
          if (physical.contract !== checkpoint.contract
            || physical.expectedCheckpointCount
              !== checkpoint.expectedCheckpointCount
            || !sameBytes(
              physical.checkpointOrderedDigest,
              checkpoint.checkpointOrderedDigest,
            )
            || physical.expectedBlobCount !== checkpoint.expectedBlobCount
            || !sameBytes(physical.blobOrderedDigest, checkpoint.blobOrderedDigest)
            || physical.expectedPendingWriteCount
              !== checkpoint.expectedPendingWriteCount
            || !sameBytes(
              physical.pendingWriteOrderedDigest,
              checkpoint.pendingWriteOrderedDigest,
            )) {
            return Object.freeze({ status: "unavailable" as const, verifiedJobs });
          }
          verifiedJobs += 1n;
          if (verifiedJobs > request.expectedJobs) {
            return Object.freeze({ status: "unavailable" as const, verifiedJobs });
          }
        }
        afterJobId = page.nextCursor ?? undefined;
      } while (afterJobId !== undefined);
    } catch {
      return Object.freeze({ status: "unavailable" as const, verifiedJobs });
    }
    return Object.freeze({
      status: verifiedJobs === request.expectedJobs ? "verified" as const : "unavailable" as const,
      verifiedJobs,
    });
  };
}
