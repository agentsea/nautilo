import type {
  DurableRecordEnvelope,
  DurableRecordPredecessor,
} from "../persistence/repository";
import type { RoomEventKind } from "./types";

export const STENOGRAPHER_RECORD_POLICY_VERSION_V1 =
  "stenographer-record-v1" as const;
export const STENOGRAPHER_OBSERVATION_STATEMENT_MAX_CODE_POINTS = 500;
export const STENOGRAPHER_OBSERVATION_SOURCE_MAX = 16;

export interface StenographerObservationSource {
  readonly logicalMessageRef: string;
  readonly observedRevision: string;
  readonly observedContentFingerprint: string;
  readonly terminalAuthorityLeafHandle: string;
}

export type StenographerObservationTransition =
  | Readonly<{ operation: "append" }>
  | Readonly<{
      operation: "supersede" | "resolve";
      predecessorRecordRef: string;
    }>;

export interface StenographerObservationPublicationInput {
  readonly recordRef: string;
  readonly kind: RoomEventKind;
  readonly statement: string;
  readonly roomAnchorRef: string;
  readonly terminalAuthorityLeafHandle: string;
  readonly sources: readonly StenographerObservationSource[];
  readonly observedContentFingerprint: string;
  readonly producerRef: string;
  readonly producerPolicyVersion: string;
  readonly processingGeneration: number;
  readonly transition: StenographerObservationTransition;
}

/**
 * Pure semantic draft. The bridge adds the publication idempotency key and the
 * opaque, current authority binding; Reflection never selects persistence
 * representation or resolves Room/Message identities.
 */
export interface StenographerObservationPublicationPlan {
  readonly record: DurableRecordEnvelope;
  readonly predecessor?: DurableRecordPredecessor;
}

function nonempty(label: string, value: string): string {
  if (value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${label} must be non-empty and trimmed`);
  }
  return value;
}

export function planStenographerObservationPublication(
  input: StenographerObservationPublicationInput,
): StenographerObservationPublicationPlan {
  nonempty("Record ref", input.recordRef);
  nonempty("Room anchor", input.roomAnchorRef);
  nonempty("terminal authority leaf", input.terminalAuthorityLeafHandle);
  nonempty("observed content fingerprint", input.observedContentFingerprint);
  nonempty("producer ref", input.producerRef);
  nonempty("producer policy version", input.producerPolicyVersion);
  if (
    !Number.isSafeInteger(input.processingGeneration)
    || input.processingGeneration < 1
  ) {
    throw new RangeError("processing generation must be a positive integer");
  }
  if (
    input.statement.length === 0
    || input.statement.trim() !== input.statement
    || Array.from(input.statement).length
      > STENOGRAPHER_OBSERVATION_STATEMENT_MAX_CODE_POINTS
  ) {
    throw new RangeError("Stenographer observation statement is invalid");
  }
  if (
    input.sources.length < 1
    || input.sources.length > STENOGRAPHER_OBSERVATION_SOURCE_MAX
  ) {
    throw new RangeError("Stenographer observation source count is invalid");
  }
  const sourceRefs = new Set<string>();
  for (const source of input.sources) {
    nonempty("Message ref", source.logicalMessageRef);
    nonempty("Message revision", source.observedRevision);
    nonempty("Message content fingerprint", source.observedContentFingerprint);
    nonempty("Message terminal authority leaf", source.terminalAuthorityLeafHandle);
    if (source.terminalAuthorityLeafHandle !== input.terminalAuthorityLeafHandle) {
      throw new TypeError("Stenographer observation source authority must match the Room Namespace");
    }
    if (sourceRefs.has(source.logicalMessageRef)) {
      throw new TypeError("Stenographer observation sources must be unique");
    }
    sourceRefs.add(source.logicalMessageRef);
  }

  const predecessor = input.transition.operation === "append"
    ? undefined
    : {
        recordRef: nonempty(
          "predecessor Record ref",
          input.transition.predecessorRecordRef,
        ),
        relation: input.transition.operation === "resolve"
          ? "resolves" as const
          : "supersedes" as const,
      };

  return {
    record: {
      recordRef: input.recordRef,
      lifecycle: "current",
      structuralHeight: 0,
      processingGeneration: input.processingGeneration,
      semantic: {
        posture: "derived",
        observedContentFingerprint: input.observedContentFingerprint,
        sourceOwnedKind: `journal_event:${input.kind}`,
        observedLogicalObjectRef: input.recordRef,
        observedRevision: String(input.processingGeneration),
        statement: input.statement,
        sourceDependencies: input.sources.map((source) => ({
          sourceKind: "message",
          logicalSourceRef: source.logicalMessageRef,
          observedRevision: source.observedRevision,
          observedContentFingerprint: source.observedContentFingerprint,
          terminalAuthorityLeafHandle: source.terminalAuthorityLeafHandle,
          authorityBearing: true,
        })),
        anchors: [{
          kind: "room",
          anchorRef: input.roomAnchorRef,
          role: "origin",
        }],
        childRecordRefs: [],
        producer: {
          producerRef: input.producerRef,
          policyVersion: input.producerPolicyVersion,
        },
        terminalAuthorityLeafHandles: [input.terminalAuthorityLeafHandle],
      },
    },
    ...(predecessor === undefined ? {} : { predecessor }),
  };
}
