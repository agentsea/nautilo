import {
  runStenographerCompaction,
  runStenographerExtraction,
  type StenographerExtractionSnapshot,
  type StenographerModelInvoker,
  type StenographerProposal,
} from "@nautilo/reflection";
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
  return {
    ok: true,
    output: mapped.output,
    attempts: result.attempts,
    inputCodePoints: result.inputCodePoints,
  };
}

export function runCompactionModel(input: {
  claim: CompactionClaim;
  invoke: StenographerModelInvoker;
}) {
  return runStenographerCompaction({
    prompt: input.claim.plan.prompt,
    invoke: input.invoke,
  });
}
