import { z } from "zod";
import {
  countCodePoints,
  EVENT_SOURCE_MESSAGE_MAX,
  EVENT_STATEMENT_MAX_CHARS,
} from "./constants";
import {
  ROOM_EVENT_KINDS,
  type StenographerProposal,
} from "./types";

const messageReferenceSchema = z.string().regex(/^M[1-9]\d*$/);
const eventReferenceSchema = z.string().regex(/^E[1-9]\d*$/);
const kindSchema = z.enum(ROOM_EVENT_KINDS);

export const ModelStenographerOutputSchema = z.strictObject({
  operations: z.array(
    z.discriminatedUnion("op", [
      z.strictObject({
        op: z.literal("append"),
        kind: kindSchema,
        statement: z.string(),
        sourceMessageIds: z
          .array(messageReferenceSchema)
          .min(1)
          .max(EVENT_SOURCE_MESSAGE_MAX),
      }),
      z.strictObject({
        op: z.literal("supersede"),
        eventSequence: eventReferenceSchema,
        kind: kindSchema,
        statement: z.string(),
        sourceMessageIds: z
          .array(messageReferenceSchema)
          .min(1)
          .max(EVENT_SOURCE_MESSAGE_MAX),
      }),
      z.strictObject({
        op: z.literal("resolve"),
        eventSequence: eventReferenceSchema,
        statement: z.string(),
        sourceMessageIds: z
          .array(messageReferenceSchema)
          .min(1)
          .max(EVENT_SOURCE_MESSAGE_MAX),
      }),
    ]),
  ).max(5),
});

export type ModelStenographerOutput = z.infer<
  typeof ModelStenographerOutputSchema
>;

export interface StenographerValidationContext {
  visibleSourceReferences: readonly string[];
  /** Contains only individually rendered raw events, never rollup-only events. */
  visibleEventReferences: readonly Readonly<{
    localReference: string;
    active: boolean;
  }>[];
}

export type StenographerOutputValidation =
  | {
      ok: true;
      proposal: StenographerProposal;
    }
  | {
      ok: false;
      errorCode: "invalid_output";
      reason:
        | "invalid_json"
        | "schema"
        | "statement"
        | "duplicate_source"
        | "source_not_visible"
        | "event_not_visible"
        | "event_not_active"
        | "event_reused";
    };

function parseUnknownResponse(response: unknown): unknown {
  if (typeof response !== "string") return response;
  try {
    return JSON.parse(response) as unknown;
  } catch {
    return undefined;
  }
}

export function validateStenographerOutput(
  response: unknown,
  context: StenographerValidationContext,
): StenographerOutputValidation {
  const parsedResponse = parseUnknownResponse(response);
  if (parsedResponse === undefined) {
    return { ok: false, errorCode: "invalid_output", reason: "invalid_json" };
  }
  const parsed = ModelStenographerOutputSchema.safeParse(parsedResponse);
  if (!parsed.success) {
    return { ok: false, errorCode: "invalid_output", reason: "schema" };
  }

  const visibleSources = new Set(context.visibleSourceReferences);
  const eventByReference = new Map(
    context.visibleEventReferences.map((event) => [
      event.localReference,
      event,
    ]),
  );
  const transitionedEventReferences = new Set<string>();
  const operations: StenographerProposal["operations"] = [];

  for (const operation of parsed.data.operations) {
    const statement = operation.statement.trim();
    if (
      statement.length === 0 ||
      countCodePoints(statement) > EVENT_STATEMENT_MAX_CHARS
    ) {
      return {
        ok: false,
        errorCode: "invalid_output",
        reason: "statement",
      };
    }

    if (
      new Set(operation.sourceMessageIds).size !==
      operation.sourceMessageIds.length
    ) {
      return {
        ok: false,
        errorCode: "invalid_output",
        reason: "duplicate_source",
      };
    }
    for (const sourceReference of operation.sourceMessageIds) {
      if (!visibleSources.has(sourceReference)) {
        return {
          ok: false,
          errorCode: "invalid_output",
          reason: "source_not_visible",
        };
      }
    }

    const sourceReferences = [...operation.sourceMessageIds];
    if (operation.op === "append") {
      operations.push({
        op: "append",
        kind: operation.kind,
        statement,
        sourceReferences,
      });
      continue;
    }

    const target = eventByReference.get(operation.eventSequence);
    if (!target) {
      return {
        ok: false,
        errorCode: "invalid_output",
        reason: "event_not_visible",
      };
    }
    if (!target.active) {
      return {
        ok: false,
        errorCode: "invalid_output",
        reason: "event_not_active",
      };
    }
    if (transitionedEventReferences.has(operation.eventSequence)) {
      return {
        ok: false,
        errorCode: "invalid_output",
        reason: "event_reused",
      };
    }
    transitionedEventReferences.add(operation.eventSequence);

    if (operation.op === "supersede") {
      operations.push({
        op: "supersede",
        eventReference: operation.eventSequence,
        kind: operation.kind,
        statement,
        sourceReferences,
      });
    } else {
      operations.push({
        op: "resolve",
        eventReference: operation.eventSequence,
        statement,
        sourceReferences,
      });
    }
  }

  return { ok: true, proposal: { operations } };
}

export async function validateStenographerOutputWithRepair(input: {
  initialResponse: unknown;
  context: StenographerValidationContext;
  validateProposal?: (
    proposal: StenographerProposal,
  ) => { ok: true } | { ok: false; reason: string };
  repair: (
    invalidResponse: unknown,
    failure: { readonly reason: string },
  ) => Promise<unknown>;
}): Promise<
  | { ok: true; proposal: StenographerProposal; attempts: 1 | 2 }
  | {
      ok: false;
      errorCode: "invalid_output";
      reason: string;
      attempts: 2;
    }
> {
  const check = (
    response: unknown,
  ):
    | { ok: true; proposal: StenographerProposal }
    | { ok: false; errorCode: "invalid_output"; reason: string } => {
    const semantic = validateStenographerOutput(response, input.context);
    if (!semantic.ok) return semantic;
    const accepted = input.validateProposal?.(semantic.proposal) ?? { ok: true };
    return accepted.ok
      ? semantic
      : { ok: false, errorCode: "invalid_output", reason: accepted.reason };
  };

  const initial = check(input.initialResponse);
  if (initial.ok) return { ...initial, attempts: 1 };

  const repairedResponse = await input.repair(input.initialResponse, initial);
  const repaired = check(repairedResponse);
  return { ...repaired, attempts: 2 };
}
