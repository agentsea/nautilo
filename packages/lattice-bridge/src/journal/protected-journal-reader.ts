import type {
  ProtectedAgentRuntimeForegroundEntrypointId,
} from "../invocation/protected-agent-runtime.ts";
import type {
  RoomEventPayloadBindingV1,
  RoomEventPayloadV1,
} from "./room-event-payload-v1.ts";
import type {
  RoomEventRollupPayloadBindingV1,
  RoomEventRollupPayloadV1,
} from "./room-event-rollup-payload-v1.ts";

export const PROTECTED_JOURNAL_MAX_EVENTS = 256 as const;
export const PROTECTED_JOURNAL_MAX_CONTEXT_BYTES = 64 * 1_024;

export type ProtectedJournalProductRecord =
  | Readonly<{
    readonly kind: "event";
    readonly cryptoObjectId: string;
    readonly rebuildGeneration: number;
    readonly status: "active" | "superseded" | "resolved";
    readonly binding: RoomEventPayloadBindingV1;
    /** Absent is the temporary legacy RoomEventPayloadV1 representation. */
    readonly payloadFormat?: "record_v1";
    readonly recordMetadata?: Readonly<{
      readonly lifecycle: "current" | "stale" | "superseded" | "resolved" | "sunset";
      readonly structuralHeight: number;
      readonly processingGeneration: number;
    }>;
  }>
  | Readonly<{
    readonly kind: "rollup";
    readonly cryptoObjectId: string;
    readonly rebuildGeneration: number;
    readonly binding: RoomEventRollupPayloadBindingV1;
  }>;

export interface ProtectedJournalProductReadBatch {
  readonly roomId: string;
  readonly namespaceId: string;
  readonly domainId: string;
  readonly rebuildGeneration: number;
  readonly expectedAccessRevision: number;
  readonly expectedPolicyRevision: number;
  readonly rollup: Extract<
    ProtectedJournalProductRecord,
    Readonly<{ readonly kind: "rollup" }>
  > | null;
  readonly events: readonly Extract<
    ProtectedJournalProductRecord,
    Readonly<{ readonly kind: "event" }>
  >[];
}

declare const protectedJournalProductReadAuthorizationBrand: unique symbol;

export type ProtectedJournalProductReadAuthorization = Readonly<{
  readonly [protectedJournalProductReadAuthorizationBrand]: true;
}>;

/**
 * Content-free product projection. Implementations must select only the
 * current rebuild generation and may not project `statement`, `content`,
 * ciphertext, manifest bytes, or key material.
 */
export interface ProtectedJournalProductReadPort {
  readonly readCurrent: (input: Readonly<{
    readonly authorization: ProtectedJournalProductReadAuthorization;
    readonly roomId: string;
    readonly namespaceId: string;
    readonly maximumEvents: number;
  }>) => Promise<ProtectedJournalProductReadBatch | null>;
}

export type ProtectedJournalOpenedRecord =
  | Readonly<{
    readonly kind: "event";
    readonly cryptoObjectId: string;
    readonly payload: RoomEventPayloadV1;
  }>
  | Readonly<{
    readonly kind: "event";
    readonly cryptoObjectId: string;
    readonly payloadFormat: "record_v1";
    readonly recordPayloadBytes: Uint8Array;
  }>
  | Readonly<{
    readonly kind: "rollup";
    readonly cryptoObjectId: string;
    readonly payload: RoomEventRollupPayloadV1;
  }>;

export interface ProtectedJournalAgentContentOpener {
  readonly openBatch: <Value>(input: Readonly<{
    readonly authorizationSession: unknown;
    readonly entrypointId: ProtectedAgentRuntimeForegroundEntrypointId;
    readonly namespaceId: string;
    readonly domainId: string;
    readonly rebuildGeneration: number;
    readonly expectedAccessRevision: number;
    readonly expectedPolicyRevision: number;
    readonly records: readonly ProtectedJournalProductRecord[];
    readonly signal?: AbortSignal;
    readonly execute: (
      records: readonly ProtectedJournalOpenedRecord[],
    ) => Value | PromiseLike<Value>;
  }>) => Promise<
    | Readonly<{ readonly status: "executed"; readonly value: Value }>
    | Readonly<{
      readonly status: "unavailable";
      readonly reason:
        | "authorization_unavailable"
        | "content_unavailable"
        | "content_invalid";
    }>
  >;
}
