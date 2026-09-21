import { createHash } from "node:crypto";
import type {
  ProcessorTransformCapability,
  ProcessorTransformOutput,
} from "@nautilo/lattice-crypto";
import { isManagedGatewayOutcomeUnknownError } from "@nautilo/agent";
import { runStenographerExtraction } from "@nautilo/reflection";
import { mapStenographerProposal } from "./semantic-adapter";
import {
  planProtectedExtractionOutputs,
  type ProtectedJournalAttachmentPlanV1,
} from "./protected-journal-output-planner";
import {
  fingerprintProtectedStenographerSourceBindings,
  withProtectedStenographerSources,
  type ProtectedStenographerParticipantDisplay,
  type ProtectedStenographerSourceBinding,
} from "./protected-source-loader";

export interface ProtectedStenographerExtractionWork {
  readonly requestId: string;
  readonly workId: string;
  readonly workIdentityHash: Uint8Array;
  readonly descriptorHash: Uint8Array;
  readonly sourceBindingFingerprint: Uint8Array;
  /**
   * True when metadata-only planning treated at least one assistant row as a
   * possible conversational boundary. Protected execution must recheck the
   * opened body because an empty assistant row is not conversational.
   */
  readonly requiresContentRecheck: boolean;
  readonly roomId: string;
  readonly namespaceId: string;
  readonly sourceBatchId: string;
  readonly rebuildGeneration: number;
  readonly fromMessageIdExclusive: number;
  readonly throughMessageIdInclusive: number;
  readonly extractorVersion: string;
  readonly createdAt: string;
  readonly bindings: readonly ProtectedStenographerSourceBinding[];
  readonly outputSlots: readonly Readonly<{
    readonly eventId: string;
    readonly objectId: string;
  }>[];
}

export interface ProtectedStenographerExtractionReservation {
  readonly publicationId: string;
  readonly requestId: string;
  readonly workId: string;
  readonly workIdentityHash: Uint8Array;
  readonly descriptorHash: Uint8Array;
  readonly roomId: string;
  readonly namespaceId: string;
  readonly sourceBatchId: string;
  readonly rebuildGeneration: number;
  readonly attachmentPlanVersion: 1;
  readonly attachmentPlanHash: Uint8Array;
  readonly attachmentPlanBytes: Uint8Array;
  readonly outputObjectCount: number;
}

export interface ProtectedStenographerExtractionPublicationPort {
  readonly reserve: (
    reservation: ProtectedStenographerExtractionReservation,
  ) => Promise<"reserved" | "duplicate" | "conflict" | "stale">;
  readonly markCryptoCommitted: (commit: Readonly<{
    readonly publicationId: string;
    readonly requestId: string;
    readonly workId: string;
    readonly descriptorHash: Uint8Array;
    readonly attachmentPlanHash: Uint8Array;
    readonly outputObjectIds: readonly string[];
  }>) => Promise<"marked" | "duplicate" | "lost" | "conflict">;
  readonly attach: (attachment: Readonly<{
    readonly publicationId: string;
    readonly requestId: string;
    readonly workId: string;
    readonly roomId: string;
    readonly namespaceId: string;
    readonly sourceBatchId: string;
    readonly rebuildGeneration: number;
    readonly attachmentPlan: ProtectedJournalAttachmentPlanV1;
    readonly attachmentPlanHash: Uint8Array;
    readonly outputObjectIds: readonly string[];
  }>) => Promise<
    "attached" | "duplicate" | "reconcile" | "stale" | "conflict"
  >;
}

export type ProtectedStenographerExtractionResult =
  | Readonly<{
    readonly status: "completed";
    readonly outputCount: number;
  }>
  | Readonly<{
    readonly status: "reconciliation_pending";
    readonly outputCount: number;
  }>
  | Readonly<{
    readonly status: "rejected";
    readonly reason:
      | "input_too_large"
      | "invalid_output"
      | "provider_failure"
      | "provider_outcome_unknown"
      | "transition_rejected"
      | "receipt_conflict"
      | "stale_work";
  }>;

export interface RunProtectedStenographerExtractionInput {
  readonly capability: Pick<
    ProcessorTransformCapability,
    "openInputs" | "publishOutputs"
  >;
  readonly work: ProtectedStenographerExtractionWork;
  readonly signal: AbortSignal;
  readonly resolveParticipantDisplays: (
    participantIds: readonly string[],
    signal: AbortSignal,
  ) => Promise<readonly ProtectedStenographerParticipantDisplay[]>;
  readonly invokeModel: (
    prompt: string,
    signal: AbortSignal,
  ) => Promise<string>;
  readonly publication: ProtectedStenographerExtractionPublicationPort;
}

function sha256(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(bytes).digest());
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function wipeOutputs(outputs: readonly ProcessorTransformOutput[]): void {
  for (const output of outputs) output.plaintext.fill(0);
}

function assertActive(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("protected Stenographer extraction aborted");
}

async function rejectWithoutPublication(
  capability: Pick<ProcessorTransformCapability, "publishOutputs">,
  reason: Extract<
    ProtectedStenographerExtractionResult,
    Readonly<{ readonly status: "rejected" }>
  >["reason"],
): Promise<ProtectedStenographerExtractionResult> {
  await capability.publishOutputs(Object.freeze([]));
  return Object.freeze({ status: "rejected" as const, reason });
}

/**
 * Dormant, injected Wave-10 extraction vertical. The callback owns the only
 * plaintext lifetime; every durable port receives content-free coordinates.
 */
export async function runProtectedStenographerExtraction(
  input: RunProtectedStenographerExtractionInput,
): Promise<ProtectedStenographerExtractionResult> {
  assertActive(input.signal);
  const expectedContentRecheck = input.work.bindings.some((binding) =>
    binding.kind === "message"
    && binding.source === "current"
    && binding.role === "assistant"
    && binding.conversationalBoundary
  );
  if (
    typeof input.work.requiresContentRecheck !== "boolean"
    || input.work.requiresContentRecheck !== expectedContentRecheck
  ) {
    throw new Error(
      "protected Stenographer content recheck does not match its source bindings",
    );
  }
  const bindingFingerprint =
    fingerprintProtectedStenographerSourceBindings(input.work.bindings);
  if (
    !(input.work.sourceBindingFingerprint instanceof Uint8Array)
    || input.work.sourceBindingFingerprint.length !== 32
    || !bytesEqual(
      bindingFingerprint,
      input.work.sourceBindingFingerprint,
    )
  ) {
    throw new Error(
      "protected Stenographer source bindings do not match the approved descriptor",
    );
  }
  const openedInputs = await input.capability.openInputs();
  assertActive(input.signal);
  let result: ProtectedStenographerExtractionResult | undefined;
  await withProtectedStenographerSources({
    openedInputs,
    bindings: input.work.bindings,
    resolveParticipantDisplays: (participantIds) =>
      input.resolveParticipantDisplays(participantIds, input.signal),
    use: async (sources) => {
      assertActive(input.signal);
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
      const snapshot = {
        priorRows: sources.priorMessages.map((source) => ({
          createdAt: source.createdAt,
          role:
            source.role === "user"
              || source.role === "assistant"
              || source.role === "tool"
              ? source.role
              : "tool",
          displayLabel: source.displayLabel,
          text: source.payload.content,
        })),
        rows: sources.currentMessages.map((source) => ({
          createdAt: source.createdAt,
          role:
            source.role === "user"
              || source.role === "assistant"
              || source.role === "tool"
              ? source.role
              : "tool",
          displayLabel: source.displayLabel,
          text: source.payload.content,
          conversationalBoundary: source.conversationalBoundary,
        })),
        latestRollup: sources.latestRollup?.payload.content ?? null,
        visibleEvents: events.map((event) => ({
          localReference: `E${event.sequence}`,
          kind: event.kind,
          statement: event.statement,
          active: event.status === "active",
        })),
        hasConversationalContent: sources.currentMessages.some(
          (source) =>
            source.conversationalBoundary
            && (
              source.role === "user"
              || (
                source.role === "assistant"
                && source.payload.content.trim().length > 0
              )
            ),
        ),
      };
      const mappingContext = {
        roomId: input.work.roomId,
        fromMessageIdExclusive: input.work.fromMessageIdExclusive,
        throughMessageIdInclusive: input.work.throughMessageIdInclusive,
        visibleSourceReferences: sources.currentMessages.map(
          (source, index) => ({
            localReference: `M${index + 1}`,
            messageId: source.messageId,
            roomId: input.work.roomId,
          }),
        ),
        visibleEventReferences: events.map((event) => ({
          localReference: `E${event.sequence}`,
          eventSequence: event.sequence,
          roomId: input.work.roomId,
          active: event.status === "active",
        })),
      };
      let processed: Awaited<ReturnType<typeof runStenographerExtraction>>;
      try {
        processed = await runStenographerExtraction({
          snapshot,
          invoke: (prompt) => input.invokeModel(prompt, input.signal),
          signal: input.signal,
          validateProposal: (proposal) => {
            const mapped = mapStenographerProposal(proposal, mappingContext);
            return mapped.ok ? { ok: true } : mapped;
          },
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
      if (!processed.ok) {
        result = await rejectWithoutPublication(
          input.capability,
          processed.errorCode,
        );
        return;
      }
      const mapped = mapStenographerProposal(
        processed.proposal,
        mappingContext,
      );
      if (!mapped.ok) {
        result = await rejectWithoutPublication(
          input.capability,
          "invalid_output",
        );
        return;
      }
      const planned = planProtectedExtractionOutputs({
        roomId: input.work.roomId,
        namespaceId: input.work.namespaceId,
        sourceBatchId: input.work.sourceBatchId,
        rebuildGeneration: input.work.rebuildGeneration,
        extractorVersion: input.work.extractorVersion,
        createdAt: input.work.createdAt,
        existingEvents: events,
        operations: mapped.output.operations,
        outputSlots: input.work.outputSlots,
        messageBindings: sources.currentMessages.map((source) => ({
          messageId: source.messageId,
          editRevision: source.editRevision,
          observedContentFingerprint: `sha256:${Buffer.from(sha256(
            new TextEncoder().encode(JSON.stringify([
              "nautilo/stenographer/message-observation/v1",
              source.messageId,
              source.editRevision,
              source.payload.content,
            ])),
          )).toString("hex")}`,
        })),
      });
      if (planned.status !== "planned") {
        result = await rejectWithoutPublication(
          input.capability,
          "transition_rejected",
        );
        return;
      }
      const attachmentPlanHash = sha256(planned.attachmentPlanBytes);
      const reservation =
        await input.publication.reserve(Object.freeze({
          publicationId: input.work.requestId,
          requestId: input.work.requestId,
          workId: input.work.workId,
          workIdentityHash: input.work.workIdentityHash.slice(),
          descriptorHash: input.work.descriptorHash.slice(),
          roomId: input.work.roomId,
          namespaceId: input.work.namespaceId,
          sourceBatchId: input.work.sourceBatchId,
          rebuildGeneration: input.work.rebuildGeneration,
          attachmentPlanVersion: 1 as const,
          attachmentPlanHash: attachmentPlanHash.slice(),
          attachmentPlanBytes: planned.attachmentPlanBytes.slice(),
          outputObjectCount: planned.outputs.length,
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
      const outputObjectIds = Object.freeze(
        planned.outputs.map((output) => output.objectId),
      );
      try {
        await input.capability.publishOutputs(planned.outputs);
      } finally {
        wipeOutputs(planned.outputs);
      }
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
          outputCount: planned.outputs.length,
        });
        return;
      }
      const attachment = await input.publication.attach(Object.freeze({
        publicationId: input.work.requestId,
        requestId: input.work.requestId,
        workId: input.work.workId,
        roomId: input.work.roomId,
        namespaceId: input.work.namespaceId,
        sourceBatchId: input.work.sourceBatchId,
        rebuildGeneration: input.work.rebuildGeneration,
        attachmentPlan: planned.attachmentPlan,
        attachmentPlanHash: attachmentPlanHash.slice(),
        outputObjectIds,
      }));
      assertActive(input.signal);
      result = attachment === "attached" || attachment === "duplicate"
        ? Object.freeze({
          status: "completed",
          outputCount: planned.outputs.length,
        })
        : Object.freeze({
          status: "reconciliation_pending",
          outputCount: planned.outputs.length,
        });
    },
  });
  if (result === undefined) {
    throw new Error("protected Stenographer extraction did not complete");
  }
  return result;
}
