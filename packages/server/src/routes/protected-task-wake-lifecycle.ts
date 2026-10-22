import { isDeepStrictEqual } from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  claimProtectedTaskWakeJob, readProtectedTaskWakeScheduling, settleProtectedTaskWakeJob,
  parkProtectedTaskWakeContinuation,
  type DirectDatabase, type PostgresJsBridgeConnection, type ProtectedTaskWakeScheduling,
} from "@nautilo/db";
import { ClassifiedDataOperationError } from "@nautilo/lattice-bridge";
import type { NativeProtectedTaskRunResultOccurrenceV1, TaskWakeLiveShadowCurrentWriter } from "@nautilo/lattice-bridge/server";
import { assertAuthenticTaskRuntimeRunResultReadEvidence,
  assertAuthenticTaskRuntimeWakeForegroundEvidence } from "@nautilo/lattice-crypto";
import type { CanonicalTranscriptTx } from "@nautilo/trust";
import type { ProtectedTaskOutputReadAuthorityPort,
  ProtectedTaskOutputReadCurrentAuthority } from "./protected-task-output-read-authority";
import {
  withCommittedProtectedTaskWakeSettlement,
  withCommittedProtectedTaskWakePark,
  type ProtectedTaskWakeCommittedPark,
  type ProtectedTaskWakeCommittedSettlement,
  type ProtectedTaskOutputReadProductProofLoader,
} from "./protected-task-output-read-product";
import type { ProtectedTaskWakeForegroundFactsOwner } from "./protected-task-wake-foreground-context";
import type { ProtectedTaskWakePublication,
  ProtectedTaskWakePublicationLifecycle } from "./protected-task-wake-foreground-publication";
import { acceptedTaskRuntimeRecord, destroyAcceptedTaskRuntimeRecord } from "./task-runtime-current-authority";
import { verifyProtectedTaskWakeCheckpointIntegrity } from "./protected-task-wake-checkpoint-integrity";

function unavailable(): never {
  throw new ClassifiedDataOperationError("authority", "Protected Task wake lifecycle changed");
}

export type ProtectedTaskWakeLifecycle = ProtectedTaskWakePublicationLifecycle & Readonly<{
  withCurrentFacts: ProtectedTaskWakeForegroundFactsOwner;
  dispose(): void;
}>;

/** Retains only one callback-live grant and canonical queued/running/terminal progression. */
export async function createProtectedTaskWakeLifecycle(input: Readonly<{
  authority: ProtectedTaskOutputReadAuthorityPort;
  restricted: PostgresJsBridgeConnection;
  publication: ProtectedTaskWakePublication;
}>): Promise<ProtectedTaskWakeLifecycle | null> {
  const { authority, publication, restricted } = input;
  const original = publication.plan.intent;
  if (original.invocation.kind !== "wake" || original.initialState !== "wake_queued"
    || authority.withWakeWriter === undefined) return null;
  const accepted = acceptedTaskRuntimeRecord(publication.record);
  if (accepted === null) return null;
  const subject = Object.freeze({ userId: original.requesterUserId,
    humanActorId: accepted.issuingHumanId, deviceId: accepted.issuingDeviceId });
  const coordinates = Object.freeze({ taskId: original.result.taskId,
    taskRunId: original.result.taskRunId, jobId: original.invocation.jobId });
  let phase: "wake_queued" | "wake_running" = "wake_queued";
  let terminalReceipt: ProtectedTaskWakeCommittedSettlement | null = null;
  let parkedReceipt: ProtectedTaskWakeCommittedPark | null = null;
  let closed = false;
  let transition: Promise<unknown> | null = null;
  const writerScope = new AsyncLocalStorage<{
    writer: TaskWakeLiveShadowCurrentWriter;
    occurrence: NativeProtectedTaskRunResultOccurrenceV1 | undefined;
    active: boolean;
  }>();
  const assertGrant = async () => {
    if (closed) unavailable();
    publication.signal.throwIfAborted();
    assertAuthenticTaskRuntimeWakeForegroundEvidence(publication.wakeEvidence);
    assertAuthenticTaskRuntimeRunResultReadEvidence(publication.evidence);
    await publication.assertCurrentClaim();
    publication.signal.throwIfAborted();
    if (closed) unavailable();
  };
  const intent = () => Object.freeze({ ...original, initialState: phase });
  const withCurrent = async <Value>(use: (current: ProtectedTaskOutputReadCurrentAuthority,
    transaction: CanonicalTranscriptTx) => Promise<Value>,
  settlementCapture?: (loader: ProtectedTaskOutputReadProductProofLoader) => void,
  parkCapture?: (loader: ProtectedTaskOutputReadProductProofLoader) => void): Promise<Value | null> => {
    await assertGrant();
    const value = await authority.withAccepted({ intent: intent(), subject, accepted, restricted,
      signal: publication.signal, validateBeforeCommit: assertGrant,
      ...(terminalReceipt === null ? {} : { settledReceipt: terminalReceipt }),
      ...(parkedReceipt === null ? {} : { parkedReceipt }),
      ...(settlementCapture === undefined ? {} : { settlementCapture }),
      ...(parkCapture === undefined ? {} : { parkCapture }),
      use: async (current, _product, _restricted, transaction) => {
        await assertGrant();
        return use(current, transaction);
      } });
    await assertGrant();
    return value;
  };
  const dispose = () => {
    if (closed) return;
    closed = true;
    destroyAcceptedTaskRuntimeRecord(accepted);
  };
  let initial: ProtectedTaskWakeScheduling | null;
  try {
    initial = await withCurrent(async (_current, transaction) =>
      readProtectedTaskWakeScheduling(transaction, coordinates));
    if (initial === null || initial.jobState !== "queued"
      || initial.roomId !== original.invocation.roomId
      || initial.sessionId !== original.invocation.sessionId
      || initial.requestorId !== original.requesterUserId
      || initial.agentId !== original.agentId
      || !isDeepStrictEqual(initial.reference, original.invocation.reference)) {
      dispose(); return null;
    }
  } catch (error) { dispose(); throw error; }
  const scheduling = initial;
  const sameScheduling = (current: ProtectedTaskWakeScheduling) =>
    isDeepStrictEqual({ ...current, jobState: scheduling.jobState }, scheduling);
  const assertCurrent = async () => {
    const borrowed = writerScope.getStore();
    if (borrowed !== undefined) {
      if (!borrowed.active) unavailable();
      await assertGrant();
      await borrowed.writer.assertCurrent();
      const current = await readProtectedTaskWakeScheduling(borrowed.writer.transaction, coordinates);
      if (!borrowed.active || phase !== "wake_running" || terminalReceipt !== null || parkedReceipt !== null
        || current === null || !sameScheduling(current) || current.jobState !== "running") unavailable();
      return;
    }
    if (transition !== null) await transition;
    if (await withCurrent(async (_current, transaction) => {
      const current = await readProtectedTaskWakeScheduling(transaction, coordinates);
      return current !== null && sameScheduling(current)
        && (parkedReceipt !== null ? current.jobState === "queued" : terminalReceipt !== null
          ? current.jobState === "completed" || current.jobState === "failed"
          : current.jobState === (phase === "wake_queued" ? "queued" : "running"));
    }) !== true) unavailable();
  };
  const exclusive = async <Value>(work: () => Promise<Value>): Promise<Value | null> => {
    if (transition !== null) return null;
    const operation = work(); transition = operation;
    try { return await operation; }
    finally { if (transition === operation) transition = null; }
  };
  const lifecycle: ProtectedTaskWakeLifecycle = { scheduling, assertCurrent, dispose,
    loadCurrentResult: async () => {
      const borrowed = writerScope.getStore();
      if (borrowed !== undefined) {
        await assertCurrent();
        if (borrowed.occurrence === undefined) unavailable();
        return borrowed.occurrence;
      }
      if (transition !== null) await transition;
      return withCurrent(current => Promise.resolve(current.occurrence));
    },
    start: async jobId => {
      if (jobId !== scheduling.jobId || phase !== "wake_queued" || terminalReceipt !== null || parkedReceipt !== null) return { status: "stale" };
      const result = await exclusive(async () => {
        const started = await withCurrent(async (_current, transaction) => {
          if (original.continuation !== undefined
            && !await verifyProtectedTaskWakeCheckpointIntegrity(original.continuation)) return false;
          const borrowed: Pick<DirectDatabase, "transaction"> = { transaction: use => use(transaction) };
          return claimProtectedTaskWakeJob(borrowed, coordinates, async (tx, current) => {
            await assertGrant();
            return tx === transaction && sameScheduling(current) && current.jobState === "queued";
          });
        });
        if (started === false || started?.status !== "started") return false;
        phase = "wake_running";
        return true;
      });
      return { status: result === true ? "started" : "stale" };
    },
    settle: async (jobId, requestedStatus) => {
      if (jobId !== scheduling.jobId || phase !== "wake_running" || parkedReceipt !== null) return { kind: "rejected" };
      const result = await exclusive(async () => {
        if (terminalReceipt !== null) {
          return withCurrent(async (_current, transaction) => {
            const borrowed: Pick<DirectDatabase, "transaction"> = { transaction: use => use(transaction) };
            const replay = await settleProtectedTaskWakeJob(borrowed, { ...coordinates, requestedStatus },
              async (tx, current) => {
                await assertGrant();
                return tx === transaction && sameScheduling(current) && current.jobState === requestedStatus;
              });
            return replay.status === "exact_replay" ? replay : null;
          });
        }
        let captured = false;
        const committed = await withCommittedProtectedTaskWakeSettlement(async capture =>
          withCurrent(async (_current, transaction) => {
            const borrowed: Pick<DirectDatabase, "transaction"> = { transaction: use => use(transaction) };
            const result = await settleProtectedTaskWakeJob(borrowed, { ...coordinates, requestedStatus },
              async (tx, current) => {
                await assertGrant();
                return tx === transaction && sameScheduling(current)
                  && (current.jobState === "running" || terminalReceipt !== null && current.jobState === requestedStatus);
              });
            captured = result.status !== "rejected";
            return result;
          }, loader => { if (captured) capture(loader); }));
        const value = committed.value;
        if (value === null || value.status === "rejected" || committed.receipt === null) return null;
        terminalReceipt = committed.receipt;
        return value;
      });
      if (result === null) return { kind: "rejected" };
      return { kind: result.status === "settled" ? "transitioned" : "existing_terminal", status: result.jobStatus };
    },
    withCurrentWriter: async request => {
      if (transition !== null) await transition;
      if (phase !== "wake_running" || terminalReceipt !== null || parkedReceipt !== null) return null;
      await assertGrant();
      const value = await authority.withWakeWriter!({ intent: intent(), subject, accepted, restricted,
        signal: publication.signal, evidence: publication.wakeEvidence,
        signer: request.signer, resolveHistoricalSignerPublicationManager: request.resolveHistoricalSignerPublicationManager,
        ...(request.projectionDestination === undefined ? {} : { projectionDestination: request.projectionDestination }),
        validateBeforeCommit: assertGrant, use: async (writer, current) => {
          const borrowed = { writer, occurrence: current?.occurrence, active: true };
          try {
            return await writerScope.run(borrowed, () => request.use(writer));
          } finally { borrowed.active = false; }
        } });
      await assertGrant();
      return value;
    },
    withCurrentFacts: async request => {
      if (request.publication !== publication || request.signal !== publication.signal
        || !isDeepStrictEqual(request.scheduling, scheduling)) return null;
      if (transition !== null) await transition;
      return withCurrent((_current, transaction) => request.use(transaction, assertCurrent));
    },
    withProjectionDestination: async request => {
      if (transition !== null) await transition;
      if (phase !== "wake_running" || terminalReceipt !== null || parkedReceipt !== null
        || authority.withWakeProjectionDestination === undefined
        || request.targetAuthority.mode !== "namespace"
        || request.targetAuthority.subjectUserId !== original.requesterUserId
        || request.targetAuthority.agentId !== original.agentId
        || request.targetAuthority.writableNamespaceId !== request.destination.namespaceId
        || request.targetAuthority.readableNamespaceIds.length !== 1
        || request.targetAuthority.readableNamespaceIds[0] !== request.destination.namespaceId
        || request.targetAuthority.mutableNamespaceIds.length !== 1
        || request.targetAuthority.mutableNamespaceIds[0] !== request.destination.namespaceId) return null;
      await assertGrant();
      const value = await authority.withWakeProjectionDestination({
        intent: intent(), subject, signal: publication.signal,
        destination: request.destination,
        use: current => Promise.resolve(Object.freeze({
          destinationAuthorityDigest: Uint8Array.from(current.destinationAuthorityDigest),
        })),
      });
      await assertGrant();
      return value;
    },
    park: async ({ request, destination }) => {
      if (phase !== "wake_running" || terminalReceipt !== null || parkedReceipt !== null
        || original.invocation.kind !== "wake") return { status: "stale" };
      const result = await exclusive(async () => {
        let captured = false;
        const committed = await withCommittedProtectedTaskWakePark(capture =>
          withCurrent(async (_current, transaction) => {
            const value = await parkProtectedTaskWakeContinuation(transaction, {
              wakeJobId: scheduling.jobId,
              taskId: scheduling.taskId, taskRunId: scheduling.taskRunId,
              bindingId: scheduling.reference.bindingId,
              wakeOperationId: scheduling.reference.wakeOperationId,
              wakeAuthorizationRequestId: publication.record.snapshot.requestId,
              priorRecipientGeneration: publication.record.snapshot.recipientGeneration,
              additionalAuthorizationRequestId: request.additionalAuthorizationRequestId,
              interruptId: request.interruptId, operationId: request.operationId,
              requestDigest: request.requestDigest,
              requiredAuthorityDigest: request.requiredAuthorityDigest,
              semanticAuthorityRequirements: request.semanticAuthorityRequirements,
              ...request.checkpointBinding,
              destinationRoomId: destination.destinationRoomId,
              destinationNamespaceId: destination.namespaceId,
              destinationAuthorityDigest: destination.destinationAuthorityDigest,
              checkpointThreadId: request.checkpointThreadId,
              checkpoint: request.checkpoint,
              sealedAt: new Date(),
            });
            captured = value.status !== "stale";
            return value;
          }, undefined, loader => { if (captured) capture(loader); }));
        if (committed.value === null || committed.value.status === "stale"
          || committed.receipt === null) return null;
        parkedReceipt = committed.receipt;
        return Object.freeze({ status: committed.value.status, receipt: committed.receipt });
      });
      return result ?? { status: "stale" };
    },
  };
  return Object.freeze(lifecycle);
}
