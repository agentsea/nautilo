import { getMemoryById, memoryReviewFingerprint, type MemoryReviewOptions } from "@nautilo/agent";
import { findReflectionMemorySourceWith, type DirectDatabase } from "@nautilo/db";
import type { DurableModelExposureDependency } from "@nautilo/reflection/durable";
import type { MemoryReviewClaim, OrdinarySourceFingerprintPort } from "@nautilo/runtime";
import { envelopeReadableNamespaces, getPolicyResolver, resolveSpeakerUserId } from "@nautilo/trust";

type Snapshot = Parameters<NonNullable<MemoryReviewOptions["onModelExposure"]>>[0][number];
/** Reopen actual retrieved rows under the same live review authority. */
export function createReviewMemoryExposureResolver(input: {
  db: DirectDatabase;
  fingerprints: OrdinarySourceFingerprintPort;
}) {
  return async (claim: MemoryReviewClaim, snapshots: readonly Snapshot[]): Promise<readonly DurableModelExposureDependency[] | undefined> => {
    if (claim.scopeId) return undefined;
    const resolver = getPolicyResolver();
    if (!resolver) throw new Error("Memory review authority is unavailable");
    const envelope = await resolver.buildEnvelope(claim.actorId, `room:${claim.roomId}`, claim.agentId, claim.roomId);
    if (envelope.externalContext || envelope.ownerId !== claim.ownerId || envelope.agentId !== claim.agentId) throw new Error("Memory review authority changed");
    const speakerUserId = await resolveSpeakerUserId(envelope);
    if (!speakerUserId) throw new Error("Memory review authority changed");
    const dependencies: DurableModelExposureDependency[] = [];
    for (const snapshot of snapshots) {
      const row = await getMemoryById(snapshot.memoryId, envelopeReadableNamespaces(envelope), { userId: speakerUserId, agentId: claim.agentId });
      if (row === null || row === "forbidden" || memoryReviewFingerprint(row) !== snapshot.fingerprint) throw new Error("Memory review exposed input changed");
      for (const namespaceId of row.namespaceIds) {
        const exact = await findReflectionMemorySourceWith(input.db, row.id, namespaceId);
        if (exact === null || exact.content === null || exact.type === null) throw new Error("Memory review exposed input changed");
        if (exact.contentRevision < 1) return undefined;
        dependencies.push({ kind: "source", sourceKind: "memory", logicalSourceRef: `memory:${row.id}`,
          observedRevision: String(exact.contentRevision), observedContentFingerprint: input.fingerprints.memory({ ...exact, content: exact.content, type: exact.type }),
          terminalAuthorityLeafHandle: namespaceId });
      }
    }
    return dependencies;
  };
}
