import {
  prepareStenographerExtractionEvidence,
  runStenographerCompaction,
  runStenographerExtraction,
  type StenographerCompactionModelExposure,
  type StenographerExtractionModelExposure,
  type StenographerExtractionSnapshot,
  type StenographerModelInvoker,
  type StenographerProposal,
} from "@nautilo/reflection";
import type { DurableModelExposureDependency } from "@nautilo/reflection/durable";
import { reflectionMessageSourceFingerprint } from "../reflection/canonical-room-sources";
import type { CompactionClaim, ExtractionClaim } from "./repository";
import type { StenographerOutput } from "./types";

export interface VisibleSourceReference {
  localReference: string;
  messageId: number;
  roomId: string;
}

export interface VisibleEventReference {
  localReference: string;
  eventSequence: number;
  roomId: string;
  active: boolean;
}

export interface ProposalMappingContext {
  roomId: string;
  fromMessageIdExclusive: number;
  throughMessageIdInclusive: number;
  visibleSourceReferences: readonly VisibleSourceReference[];
  visibleEventReferences: readonly VisibleEventReference[];
}

export type ProposalMappingResult =
  | { ok: true; output: StenographerOutput }
  | {
      ok: false;
      reason:
        | "duplicate_source"
        | "source_not_visible"
        | "source_out_of_batch"
        | "source_cross_room"
        | "event_not_visible"
        | "event_not_active"
        | "event_cross_room"
        | "event_reused";
    };

export function mapStenographerProposal(
  proposal: StenographerProposal,
  context: ProposalMappingContext,
): ProposalMappingResult {
  const sourceByReference = new Map(
    context.visibleSourceReferences.map((source) => [
      source.localReference,
      source,
    ]),
  );
  const eventByReference = new Map(
    context.visibleEventReferences.map((event) => [
      event.localReference,
      event,
    ]),
  );
  const transitionedEventReferences = new Set<string>();
  const operations: StenographerOutput["operations"] = [];

  for (const operation of proposal.operations) {
    const sourceMessageIds: number[] = [];
    for (const localReference of operation.sourceReferences) {
      const source = sourceByReference.get(localReference);
      if (!source) return { ok: false, reason: "source_not_visible" };
      if (source.roomId !== context.roomId) {
        return { ok: false, reason: "source_cross_room" };
      }
      if (
        source.messageId <= context.fromMessageIdExclusive
        || source.messageId > context.throughMessageIdInclusive
      ) {
        return { ok: false, reason: "source_out_of_batch" };
      }
      sourceMessageIds.push(source.messageId);
    }
    sourceMessageIds.sort((left, right) => left - right);
    if (new Set(sourceMessageIds).size !== sourceMessageIds.length) {
      return { ok: false, reason: "duplicate_source" };
    }

    if (operation.op === "append") {
      operations.push({
        op: "append",
        kind: operation.kind,
        statement: operation.statement,
        sourceMessageIds,
      });
      continue;
    }

    const target = eventByReference.get(operation.eventReference);
    if (!target) return { ok: false, reason: "event_not_visible" };
    if (target.roomId !== context.roomId) {
      return { ok: false, reason: "event_cross_room" };
    }
    if (!target.active) return { ok: false, reason: "event_not_active" };
    if (transitionedEventReferences.has(operation.eventReference)) {
      return { ok: false, reason: "event_reused" };
    }
    transitionedEventReferences.add(operation.eventReference);
    operations.push(
      operation.op === "supersede"
        ? {
            op: "supersede",
            eventSequence: target.eventSequence,
            kind: operation.kind,
            statement: operation.statement,
            sourceMessageIds,
          }
        : {
            op: "resolve",
            eventSequence: target.eventSequence,
            statement: operation.statement,
            sourceMessageIds,
          },
    );
  }
  return { ok: true, output: { operations } };
}

function normalizeRole(role: string): "user" | "assistant" | "tool" {
  return role === "user" || role === "assistant" || role === "tool"
    ? role
    : "tool";
}

function extractionInputs(claim: ExtractionClaim): {
  snapshot: StenographerExtractionSnapshot;
  mappingContext: ProposalMappingContext;
} {
  const planById = new Map(
    claim.plan.sourceRows.map((source) => [source.id, source]),
  );
  return {
    snapshot: {
      priorRows: claim.priorContextRows.map((row) => ({
        createdAt: row.createdAt,
        role: normalizeRole(row.role),
        displayLabel: row.displayLabel,
        text: row.text,
      })),
      rows: claim.sourceRows.map((row) => ({
        createdAt: row.createdAt,
        role: normalizeRole(row.role),
        displayLabel: row.displayLabel,
        text: row.text,
        conversationalBoundary:
          planById.get(row.id)?.conversationalBoundary === true,
      })),
      latestRollup: claim.latestRollup?.content ?? null,
      visibleEvents: claim.visibleEvents.map((event) => ({
        localReference: `E${event.sequence}`,
        kind: event.kind,
        statement: event.statement,
        active: event.status === "active",
      })),
      hasConversationalContent: true,
    },
    mappingContext: {
      roomId: claim.roomId,
      fromMessageIdExclusive: claim.plan.fromMessageIdExclusive,
      throughMessageIdInclusive: claim.plan.throughMessageIdInclusive,
      visibleSourceReferences: claim.sourceRows.map((row, index) => ({
        localReference: `M${index + 1}`,
        messageId: row.id,
        roomId: claim.roomId,
      })),
      visibleEventReferences: claim.visibleEvents.map((event) => ({
        localReference: `E${event.sequence}`,
        eventSequence: event.sequence,
        roomId: claim.roomId,
        active: event.status === "active",
      })),
    },
  };
}

export type ExtractionModelResult =
  | {
      ok: true;
      output: StenographerOutput;
      attempts: 1 | 2;
      inputCodePoints: number;
      modelExposureDependencies?: readonly DurableModelExposureDependency[];
    }
  | {
      ok: false;
      errorCode: "invalid_output" | "input_too_large";
      attempts: 0 | 2;
    };

export async function runExtractionModel(input: {
  claim: ExtractionClaim;
  invoke: StenographerModelInvoker;
}): Promise<ExtractionModelResult> {
  const prepared = extractionInputs(input.claim);
  const result = await runStenographerExtraction({
    snapshot: prepared.snapshot,
    invoke: input.invoke,
    validateProposal: (proposal) => {
      const mapped = mapStenographerProposal(proposal, prepared.mappingContext);
      return mapped.ok ? { ok: true } : mapped;
    },
  });
  if (!result.ok) return result;
  const mapped = mapStenographerProposal(
    result.proposal,
    prepared.mappingContext,
  );
  if (!mapped.ok) {
    return { ok: false, errorCode: "invalid_output", attempts: 2 };
  }
  const modelExposureDependencies = resolveExtractionModelExposure(
    input.claim,
    result.modelExposure,
  );
  return {
    ok: true,
    output: mapped.output,
    attempts: result.attempts,
    inputCodePoints: result.inputCodePoints,
    ...(modelExposureDependencies === undefined
      ? {}
      : { modelExposureDependencies }),
  };
}

function messageExposureDependency(
  row: ExtractionClaim["sourceRows"][number],
  namespaceId: string | undefined,
): DurableModelExposureDependency | undefined {
  if (namespaceId === undefined || row.editRevision === undefined) {
    return undefined;
  }
  return {
    kind: "source",
    sourceKind: "message",
    logicalSourceRef: `message:${row.id}`,
    observedRevision: String(row.editRevision),
    observedContentFingerprint: reflectionMessageSourceFingerprint({
      id: row.id,
      editRevision: row.editRevision,
      content: row.text,
    }),
    terminalAuthorityLeafHandle: namespaceId,
  };
}

function resolveExtractionModelExposure(
  claim: ExtractionClaim,
  exposure: StenographerExtractionModelExposure | null,
): readonly DurableModelExposureDependency[] | undefined {
  if (exposure === null) return undefined;
  const dependencies: Array<DurableModelExposureDependency | undefined> = [
    ...exposure.currentRowPositions.map((position) => {
      const row = claim.sourceRows[position];
      return row === undefined
        ? undefined
        : messageExposureDependency(row, claim.namespaceId);
    }),
    ...exposure.priorRowPositions.map((position) => {
      const row = claim.priorContextRows[position];
      return row === undefined
        ? undefined
        : messageExposureDependency(row, claim.namespaceId);
    }),
    ...(exposure.latestRollupIncluded
      ? [claim.latestRollup?.modelExposureDependency]
      : []),
    ...exposure.visibleEventReferences.map((reference) =>
      claim.visibleEvents.find(
        (event) => `E${event.sequence}` === reference,
      )?.modelExposureDependency
    ),
  ];
  return dependencies.length === 0
    || dependencies.some((dependency) => dependency === undefined)
    ? undefined
    : dependencies as DurableModelExposureDependency[];
}

function resolveCompactionModelExposure(
  claim: CompactionClaim,
  exposure: StenographerCompactionModelExposure | null,
): readonly DurableModelExposureDependency[] | undefined {
  if (exposure === null) return undefined;
  const eventBySequence = new Map([
    ...claim.plan.selectedEvents,
    ...claim.plan.protectedTail,
  ].map((event) => [event.sequence, event]));
  const dependencies: Array<DurableModelExposureDependency | undefined> = [
    ...(exposure.previousRollupThroughEventSequence === null
      ? []
      : claim.previousRollup?.throughEventSequence
          === exposure.previousRollupThroughEventSequence
        ? [claim.previousRollup.modelExposureDependency]
        : [undefined]),
    ...exposure.selectedEventSequences.map((sequence) =>
      eventBySequence.get(sequence)?.modelExposureDependency
    ),
    ...exposure.protectedTailEventSequences.map((sequence) =>
      eventBySequence.get(sequence)?.modelExposureDependency
    ),
  ];
  return dependencies.length === 0
    || dependencies.some((dependency) => dependency === undefined)
    ? undefined
    : dependencies as DurableModelExposureDependency[];
}

export async function runCompactionModel(input: {
  claim: CompactionClaim;
  invoke: StenographerModelInvoker;
}) {
  const result = await runStenographerCompaction({
    prompt: input.claim.plan.prompt,
    invoke: input.invoke,
    modelExposure: input.claim.plan.modelExposure,
  });
  if (!result.ok) return result;
  const modelExposureDependencies = resolveCompactionModelExposure(
    input.claim,
    result.modelExposure,
  );
  return {
    ...result,
    ...(modelExposureDependencies === undefined
      ? {}
      : { modelExposureDependencies }),
  };
}

/** Derive the same actual projection before the first paid dispatch. */
export function extractionModelExposureDependencies(claim: ExtractionClaim): readonly DurableModelExposureDependency[] | undefined {
  const { snapshot } = extractionInputs(claim);
  const projection = prepareStenographerExtractionEvidence(snapshot);
  if (!projection.ok || !snapshot.hasConversationalContent) return undefined;
  return resolveExtractionModelExposure(claim, { ...projection.modelExposure, latestRollupIncluded: snapshot.latestRollup !== null, visibleEventReferences: snapshot.visibleEvents.map(event => event.localReference) });
}
export function compactionModelExposureDependencies(claim: CompactionClaim): readonly DurableModelExposureDependency[] | undefined { return resolveCompactionModelExposure(claim, claim.plan.modelExposure); }
