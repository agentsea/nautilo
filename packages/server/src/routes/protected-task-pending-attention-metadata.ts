import {
  listProtectedTaskPendingAttentionCandidates,
  readProtectedTaskPendingAttentionCandidate,
  type DirectDatabase,
  type ProtectedTaskPendingAttentionCandidate,
  type ProtectedTaskPendingAttentionCursor,
  type ProtectedTaskPendingAttentionViewer,
} from "@nautilo/db";
import {
  readProtectedTaskCheckpointPhysicalManifest,
} from "@nautilo/runtime";

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type Dependencies = Readonly<{
  list: typeof listProtectedTaskPendingAttentionCandidates;
  read: typeof readProtectedTaskPendingAttentionCandidate;
  readManifest: typeof readProtectedTaskCheckpointPhysicalManifest;
}>;

function sameBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function sameInterrupts(
  left: ProtectedTaskPendingAttentionCandidate["priorJob"]["interrupts"],
  right: ProtectedTaskPendingAttentionCandidate["priorJob"]["interrupts"],
): boolean {
  return left.length === right.length && left.every((interrupt, index) => {
    const candidate = right[index];
    return candidate !== undefined
      && interrupt.id === candidate.id
      && interrupt.kind === candidate.kind
      && interrupt.requestId === candidate.requestId
      && (interrupt.allowedVerbs === undefined
        ? candidate.allowedVerbs === undefined
        : candidate.allowedVerbs !== undefined
          && interrupt.allowedVerbs.length === candidate.allowedVerbs.length
          && interrupt.allowedVerbs.every((verb, verbIndex) =>
            verb === candidate.allowedVerbs![verbIndex]));
  });
}

/** Exact detached-candidate equality used when a signed challenge is redeemed. */
export function sameProtectedTaskPendingAttentionCandidate(
  left: ProtectedTaskPendingAttentionCandidate,
  right: ProtectedTaskPendingAttentionCandidate,
): boolean {
  const leftTask = left.occurrence.task;
  const rightTask = right.occurrence.task;
  const leftRun = left.occurrence.run;
  const rightRun = right.occurrence.run;
  const leftJob = left.priorJob;
  const rightJob = right.priorJob;
  const leftReference = leftJob.reference;
  const rightReference = rightJob.reference;
  const leftManifest = left.checkpointManifest;
  const rightManifest = right.checkpointManifest;
  return leftTask.id === rightTask.id
    && leftTask.ownerId === rightTask.ownerId
    && leftTask.requestorId === rightTask.requestorId
    && leftTask.agentId === rightTask.agentId
    && leftTask.callingRoomId === rightTask.callingRoomId
    && leftTask.scheduleKind === rightTask.scheduleKind
    && leftTask.status === rightTask.status
    && leftTask.targetRoomId === rightTask.targetRoomId
    && leftTask.contentNamespaceId === rightTask.contentNamespaceId
    && leftTask.contentRevision === rightTask.contentRevision
    && leftTask.contentRepresentation === rightTask.contentRepresentation
    && leftTask.cryptoObjectId === rightTask.cryptoObjectId
    && leftTask.cryptoAccessRevision === rightTask.cryptoAccessRevision
    && sameBytes(
      leftTask.cryptoRequiredNamespaceFingerprint,
      rightTask.cryptoRequiredNamespaceFingerprint,
    )
    && leftTask.cryptoMappingState === rightTask.cryptoMappingState
    && leftRun.id === rightRun.id
    && leftRun.taskId === rightRun.taskId
    && leftRun.jobId === rightRun.jobId
    && leftRun.graphThreadId === rightRun.graphThreadId
    && leftRun.status === rightRun.status
    && leftRun.startedAt.getTime() === rightRun.startedAt.getTime()
    && leftJob.id === rightJob.id
    && leftJob.generation === rightJob.generation
    && leftJob.parkedAt.getTime() === rightJob.parkedAt.getTime()
    && sameInterrupts(leftJob.interrupts, rightJob.interrupts)
    && leftReference.kind === rightReference.kind
    && leftReference.taskId === rightReference.taskId
    && leftReference.taskRunId === rightReference.taskRunId
    && leftReference.inputObjectId === rightReference.inputObjectId
    && leftReference.resultObjectId === rightReference.resultObjectId
    && leftReference.authorizationRequestId
      === rightReference.authorizationRequestId
    && leftReference.policyRevision === rightReference.policyRevision
    && leftReference.executionSegment === rightReference.executionSegment
    && leftReference.resumeAcceptanceId === rightReference.resumeAcceptanceId
    && leftReference.resumeContinuationFingerprint
      === rightReference.resumeContinuationFingerprint
    && sameBytes(left.stableRoutingDigest, right.stableRoutingDigest)
    && sameInterrupts(
      left.pendingAttentionInterrupts,
      right.pendingAttentionInterrupts,
    )
    && leftManifest.contract === rightManifest.contract
    && leftManifest.expectedCheckpointCount
      === rightManifest.expectedCheckpointCount
    && sameBytes(
      leftManifest.checkpointOrderedDigest,
      rightManifest.checkpointOrderedDigest,
    )
    && leftManifest.expectedBlobCount === rightManifest.expectedBlobCount
    && sameBytes(
      leftManifest.blobOrderedDigest,
      rightManifest.blobOrderedDigest,
    )
    && leftManifest.expectedPendingWriteCount
      === rightManifest.expectedPendingWriteCount
    && sameBytes(
      leftManifest.pendingWriteOrderedDigest,
      rightManifest.pendingWriteOrderedDigest,
    );
}

/** Canonical opaque paging coordinate for protected Task attention discovery. */
export function encodeProtectedTaskPendingAttentionCursor(
  cursor: ProtectedTaskPendingAttentionCursor,
): string {
  return Buffer.from(JSON.stringify({
    version: 1,
    startedAt: cursor.startedAt.toISOString(),
    taskRunId: cursor.taskRunId,
  })).toString("base64url");
}

export function decodeProtectedTaskPendingAttentionCursor(
  encoded: string,
): ProtectedTaskPendingAttentionCursor | null {
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.length === 0 || bytes.toString("base64url") !== encoded) {
      return null;
    }
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join(",")
        !== "startedAt,taskRunId,version"
      || record["version"] !== 1
      || typeof record["startedAt"] !== "string"
      || typeof record["taskRunId"] !== "string"
      || !CANONICAL_UUID.test(record["taskRunId"])) return null;
    const startedAt = new Date(record["startedAt"]);
    if (!Number.isFinite(startedAt.getTime())
      || startedAt.toISOString() !== record["startedAt"]) return null;
    return Object.freeze({
      startedAt,
      taskRunId: record["taskRunId"],
    });
  } catch {
    return null;
  }
}

function matchesPhysicalManifest(
  candidate: ProtectedTaskPendingAttentionCandidate,
  manifest: Awaited<ReturnType<typeof readProtectedTaskCheckpointPhysicalManifest>>,
): boolean {
  const receipt = candidate.checkpointManifest;
  return manifest.contract === receipt.contract
    && manifest.expectedCheckpointCount === receipt.expectedCheckpointCount
    && sameBytes(
      manifest.checkpointOrderedDigest,
      receipt.checkpointOrderedDigest,
    )
    && manifest.expectedBlobCount === receipt.expectedBlobCount
    && sameBytes(manifest.blobOrderedDigest, receipt.blobOrderedDigest)
    && manifest.expectedPendingWriteCount === receipt.expectedPendingWriteCount
    && sameBytes(
      manifest.pendingWriteOrderedDigest,
      receipt.pendingWriteOrderedDigest,
    );
}

export function createProtectedTaskPendingAttentionMetadata(input: Readonly<{
  db: DirectDatabase;
  createDedicatedPool:
    Parameters<typeof readProtectedTaskCheckpointPhysicalManifest>[0]["createDedicatedPool"];
}>, overrides: Partial<Dependencies> = {}) {
  const list = overrides.list ?? listProtectedTaskPendingAttentionCandidates;
  const read = overrides.read ?? readProtectedTaskPendingAttentionCandidate;
  const readManifest = overrides.readManifest
    ?? readProtectedTaskCheckpointPhysicalManifest;

  const verifyCurrent = async (
    candidate: ProtectedTaskPendingAttentionCandidate,
  ): Promise<ProtectedTaskPendingAttentionCandidate | null> => {
    try {
      const manifest = await readManifest({
        logicalThreadId: candidate.occurrence.run.graphThreadId,
        createDedicatedPool: input.createDedicatedPool,
      });
      return matchesPhysicalManifest(candidate, manifest)
        ? candidate
        : null;
    } catch {
      return null;
    }
  };

  return Object.freeze({
    async list(options: Readonly<{
      viewer: ProtectedTaskPendingAttentionViewer;
      limit: number;
      cursor?: string;
    }>): Promise<Readonly<{
      candidates: readonly ProtectedTaskPendingAttentionCandidate[];
      nextCursor: string | null;
    }>> {
      const after = options.cursor === undefined
        ? undefined
        : decodeProtectedTaskPendingAttentionCursor(options.cursor);
      if (options.cursor !== undefined && after === null) {
        throw new TypeError("Protected Task pending-attention cursor is malformed");
      }
      const page = await list(input.db, {
        viewer: options.viewer,
        limit: options.limit,
        ...(after === undefined || after === null ? {} : { after }),
      });
      const verified = await Promise.all(
        page.candidates.map(verifyCurrent),
      );
      return Object.freeze({
        candidates: Object.freeze(verified.filter(
          (candidate): candidate is ProtectedTaskPendingAttentionCandidate =>
            candidate !== null,
        )),
        nextCursor: page.nextCursor === null
          ? null
          : encodeProtectedTaskPendingAttentionCursor(page.nextCursor),
      });
    },

    async readCurrent(options: Readonly<{
      viewer: ProtectedTaskPendingAttentionViewer;
      taskId: string;
      taskRunId: string;
      expected?: ProtectedTaskPendingAttentionCandidate;
    }>): Promise<ProtectedTaskPendingAttentionCandidate | null> {
      const current = await read(input.db, {
        viewer: options.viewer,
        taskId: options.taskId,
        taskRunId: options.taskRunId,
      });
      if (current === null
        || options.expected !== undefined
          && !sameProtectedTaskPendingAttentionCandidate(
            options.expected,
            current,
          )) return null;
      return await verifyCurrent(current);
    },
  });
}
