import { createHash } from "node:crypto";
import type {
  ProcessorTransformCapability,
  ProcessorTransformOutput,
} from "@nautilo/lattice-crypto";
import { isManagedGatewayOutcomeUnknownError } from "@nautilo/agent";
import {
  planJournalCompaction,
  runStenographerCompaction,
} from "@nautilo/reflection";
import {
  planProtectedRollupOutput,
  type ProtectedJournalAttachmentPlanV1,
} from "./protected-journal-output-planner";
import {
  fingerprintProtectedStenographerSourceBindings,
  withProtectedStenographerSources,
  type ProtectedStenographerSourceBinding,
} from "./protected-source-loader";

export interface ProtectedStenographerCompactionWork {
  readonly requestId: string;
  readonly workId: string;
  readonly workIdentityHash: Uint8Array;
  readonly descriptorHash: Uint8Array;
  readonly sourceBindingFingerprint: Uint8Array;
  readonly roomId: string;
  readonly namespaceId: string;
  readonly rebuildGeneration: number;
  readonly bindings: readonly ProtectedStenographerSourceBinding[];
  readonly rollupId: string;
  readonly outputObjectId: string;
  readonly modelId: string;
  readonly compactorVersion: string;
  readonly createdAt: string;
}

export interface ProtectedStenographerCompactionPublicationPort {
  readonly reserve: (reservation: Readonly<{
    readonly publicationId: string;
    readonly requestId: string;
    readonly workId: string;
    readonly workIdentityHash: Uint8Array;
    readonly descriptorHash: Uint8Array;
    readonly roomId: string;
    readonly namespaceId: string;
    readonly sourceBatchId: null;
    readonly rebuildGeneration: number;
    readonly attachmentPlanVersion: 1;
    readonly attachmentPlanHash: Uint8Array;
    readonly attachmentPlanBytes: Uint8Array;
    readonly outputObjectCount: 1;
  }>) => Promise<"reserved" | "duplicate" | "conflict" | "stale">;
  readonly markCryptoCommitted: (commit: Readonly<{
    readonly publicationId: string;
    readonly requestId: string;
    readonly workId: string;
    readonly descriptorHash: Uint8Array;
    readonly attachmentPlanHash: Uint8Array;
    readonly outputObjectIds: readonly [string];
  }>) => Promise<"marked" | "duplicate" | "lost" | "conflict">;
  readonly attach: (attachment: Readonly<{
    readonly publicationId: string;
    readonly requestId: string;
    readonly workId: string;
    readonly roomId: string;
    readonly namespaceId: string;
    readonly rebuildGeneration: number;
    readonly attachmentPlan: ProtectedJournalAttachmentPlanV1;
    readonly attachmentPlanHash: Uint8Array;
    readonly outputObjectIds: readonly [string];
  }>) => Promise<
    "attached" | "duplicate" | "reconcile" | "stale" | "conflict"
  >;
}

export type ProtectedStenographerCompactionResult =
  | Readonly<{ readonly status: "completed"; readonly outputCount: 1 }>
  | Readonly<{
    readonly status: "reconciliation_pending";
    readonly outputCount: 1;
  }>
  | Readonly<{
    readonly status: "rejected";
    readonly reason:
      | "input_not_compactable"
      | "input_too_large"
      | "invalid_output"
      | "provider_failure"
      | "provider_outcome_unknown"
      | "receipt_conflict"
      | "stale_work";
  }>;

export interface RunProtectedStenographerCompactionInput {
  readonly capability: Pick<
    ProcessorTransformCapability,
    "openInputs" | "publishOutputs"
  >;
  readonly work: ProtectedStenographerCompactionWork;
  readonly signal: AbortSignal;
  readonly invokeModel: (
    prompt: string,
    signal: AbortSignal,
  ) => Promise<string>;
  readonly publication: ProtectedStenographerCompactionPublicationPort;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function hash(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(bytes).digest());
}

function wipeOutputs(outputs: readonly ProcessorTransformOutput[]): void {
  for (const output of outputs) output.plaintext.fill(0);
}

function assertActive(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("protected Stenographer compaction aborted");
}

async function rejectWithoutPublication(
  capability: Pick<ProcessorTransformCapability, "publishOutputs">,
  reason: Extract<
    ProtectedStenographerCompactionResult,
    Readonly<{ readonly status: "rejected" }>
  >["reason"],
): Promise<ProtectedStenographerCompactionResult> {
  await capability.publishOutputs(Object.freeze([]));
  return Object.freeze({ status: "rejected" as const, reason });
}

/** Dormant one-run compaction vertical over exact encrypted journal inputs. */
export async function runProtectedStenographerCompaction(
  input: RunProtectedStenographerCompactionInput,
): Promise<ProtectedStenographerCompactionResult> {
  assertActive(input.signal);
  const fingerprint =
    fingerprintProtectedStenographerSourceBindings(input.work.bindings);
  if (
    !(input.work.sourceBindingFingerprint instanceof Uint8Array)
    || input.work.sourceBindingFingerprint.length !== 32
    || !equalBytes(fingerprint, input.work.sourceBindingFingerprint)
  ) {
    throw new Error(
      "protected Stenographer compaction bindings do not match the approved descriptor",
    );
  }
  const openedInputs = await input.capability.openInputs();
  assertActive(input.signal);
  let result: ProtectedStenographerCompactionResult | undefined;
  await withProtectedStenographerSources({
    openedInputs,
    bindings: input.work.bindings,
    resolveParticipantDisplays: (participantIds) => {
      if (participantIds.length !== 0) {
        throw new Error(
          "protected Stenographer compaction cannot receive messages",
        );
      }
      return Promise.resolve([]);
    },
    use: async (sources) => {
      assertActive(input.signal);
      if (
        sources.currentMessages.length !== 0
        || sources.priorMessages.length !== 0
        || sources.events.length === 0
      ) {
        result = await rejectWithoutPublication(
          input.capability,
          "input_not_compactable",
        );
        return;
      }
      const events = sources.events.map((source) => Object.freeze({
        id: source.payload.eventId,
        roomId: source.payload.roomId,
        sequence: source.payload.sequence,
        kind: source.payload.kind,
        statement: source.payload.statement,
        status: source.status,
        supersedesEventId: source.payload.supersedesEventId,
        resolvesEventId: source.payload.resolvesEventId,
      }));
      const rollups = sources.latestRollup === null
        ? []
        : [Object.freeze({
          throughEventSequence:
            sources.latestRollup.payload.throughEventSequence,
          content: sources.latestRollup.payload.content,
          sourceEventCount: sources.latestRollup.payload.sourceEventCount,
        })];
      const compactable = planJournalCompaction({
        events,
        rollups,
        forceDue: true,
      });
      if (!compactable.ok) {
        result = await rejectWithoutPublication(
          input.capability,
          "input_too_large",
        );
        return;
      }
      if (compactable.plan === null) {
        result = await rejectWithoutPublication(
          input.capability,
          "input_not_compactable",
        );
        return;
      }
      let compacted: Awaited<ReturnType<typeof runStenographerCompaction>>;
      try {
        compacted = await runStenographerCompaction({
          prompt: compactable.plan.prompt,
          invoke: (prompt) => input.invokeModel(prompt, input.signal),
          signal: input.signal,
        });
        assertActive(input.signal);
      } catch (error) {
        assertActive(input.signal);
        result = await rejectWithoutPublication(
          input.capability,
          isManagedGatewayOutcomeUnknownError(error)
            ? "provider_outcome_unknown"
            : "provider_failure",
        );
        return;
      }
      if (!compacted.ok) {
        result = await rejectWithoutPublication(
          input.capability,
          "invalid_output",
        );
        return;
      }
      const planned = planProtectedRollupOutput({
        roomId: input.work.roomId,
        namespaceId: input.work.namespaceId,
        rebuildGeneration: input.work.rebuildGeneration,
        rollupId: input.work.rollupId,
        outputObjectId: input.work.outputObjectId,
        throughEventSequence: compactable.plan.throughEventSequence,
        content: compacted.content,
        sourceEventCount:
          (compactable.plan.previousRollup?.sourceEventCount ?? 0)
          + compactable.plan.selectedEvents.length,
        modelId: input.work.modelId,
        compactorVersion: input.work.compactorVersion,
        createdAt: input.work.createdAt,
      });
      const attachmentPlanHash = hash(planned.attachmentPlanBytes);
      const reservation = await input.publication.reserve(Object.freeze({
        publicationId: input.work.requestId,
        requestId: input.work.requestId,
        workId: input.work.workId,
        workIdentityHash: input.work.workIdentityHash.slice(),
        descriptorHash: input.work.descriptorHash.slice(),
        roomId: input.work.roomId,
        namespaceId: input.work.namespaceId,
        sourceBatchId: null,
        rebuildGeneration: input.work.rebuildGeneration,
        attachmentPlanVersion: 1 as const,
        attachmentPlanHash: attachmentPlanHash.slice(),
        attachmentPlanBytes: planned.attachmentPlanBytes.slice(),
        outputObjectCount: 1 as const,
      }));
      assertActive(input.signal);
      if (reservation === "conflict") {
        result = await rejectWithoutPublication(
          input.capability,
          "receipt_conflict",
        );
        return;
      }
      if (reservation === "stale") {
        result = await rejectWithoutPublication(
          input.capability,
          "stale_work",
        );
        return;
      }
      try {
        await input.capability.publishOutputs(planned.outputs);
      } finally {
        wipeOutputs(planned.outputs);
      }
      const outputObjectIds: readonly [string] =
        Object.freeze([input.work.outputObjectId]);
      const marked = await input.publication.markCryptoCommitted(
        Object.freeze({
          publicationId: input.work.requestId,
          requestId: input.work.requestId,
          workId: input.work.workId,
          descriptorHash: input.work.descriptorHash.slice(),
          attachmentPlanHash: attachmentPlanHash.slice(),
          outputObjectIds,
        }),
      );
      assertActive(input.signal);
      if (marked === "lost" || marked === "conflict") {
        result = Object.freeze({
          status: "reconciliation_pending",
          outputCount: 1,
        });
        return;
      }
      const attached = await input.publication.attach(Object.freeze({
        publicationId: input.work.requestId,
        requestId: input.work.requestId,
        workId: input.work.workId,
        roomId: input.work.roomId,
        namespaceId: input.work.namespaceId,
        rebuildGeneration: input.work.rebuildGeneration,
        attachmentPlan: planned.attachmentPlan,
        attachmentPlanHash: attachmentPlanHash.slice(),
        outputObjectIds,
      }));
      assertActive(input.signal);
      result = attached === "attached" || attached === "duplicate"
        ? Object.freeze({ status: "completed", outputCount: 1 as const })
        : Object.freeze({
          status: "reconciliation_pending",
          outputCount: 1 as const,
        });
    },
  });
  if (result === undefined) {
    throw new Error("protected Stenographer compaction did not complete");
  }
  return result;
}
