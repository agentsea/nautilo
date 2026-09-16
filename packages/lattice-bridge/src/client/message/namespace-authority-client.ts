import {
  accessRevision,
  namespaceGeneration,
  namespaceId,
  type NamespaceAgentGrantAuthorityEntry,
  type NamespaceAgentGrantSecretEntry,
} from "@nautilo/lattice-crypto";

export type NamespaceAuthorityResult =
  | Readonly<{ status: "ready" }>
  | Readonly<{ status: "unavailable"; reason: string }>;

/** Durable coordinates for every retained generation needed by one consumer. */
export type NamespaceGenerationAuthority = Readonly<{
  namespaceId: string;
  retainedGenerations: readonly Readonly<{
    generation: number;
    accessRevision: number;
    headDigest: Uint8Array;
    publicationDigest: Uint8Array;
    publicationSetDigest: Uint8Array;
    audienceFingerprint: Uint8Array;
  }>[];
}>;

/** Callback-borrowed Namespace secret. Callers must not retain its raw key. */
export type OpenedNamespaceGeneration = Readonly<{
  namespaceId: ReturnType<typeof namespaceId>;
  keyClass: "ai" | "human";
  accessRevision: ReturnType<typeof accessRevision>;
  generation: ReturnType<typeof namespaceGeneration>;
  generationKey: Uint8Array;
  audienceFingerprint: Uint8Array;
  headDigest: Uint8Array;
}>;

/**
 * Scheme-neutral foreground Namespace authority consumed by Message clients.
 * Production implementations are backed exclusively by Domain Key V2.
 */
export interface NamespaceAuthorityClient {
  ensure(input: Readonly<{
    sourceRoomId: string;
    namespaceId: string;
    operationId: string;
    idempotencyKey: string;
    /** Select only the authority needed by this consumer; omitted means both. */
    keyClass?: "human" | "ai";
    signal?: AbortSignal;
  }>): Promise<NamespaceAuthorityResult>;
  synchronizeRecipients(input: Readonly<{
    sourceRoomId: string;
    namespaceId: string;
    targetDeviceId?: string;
    maximumPages?: number;
    keyClass?: "human" | "ai";
  }>): Promise<NamespaceAuthorityResult>;
  withOpenedAiGenerations<Value>(input: Readonly<{
    sourceRoomId: string;
    subjectHumanId: string;
    deviceSigningKeyGeneration: number;
    authority: readonly NamespaceAgentGrantAuthorityEntry[];
  }>, use: (
    entries: readonly NamespaceAgentGrantSecretEntry[],
  ) => Promise<Value> | Value): Promise<
    | Readonly<{ status: "opened"; value: Value }>
    | Readonly<{ status: "unavailable"; reason: string }>
  >;
  withOpenedGenerations?<Value>(input: Readonly<{
    sourceRoomId: string;
    subjectHumanId: string;
    deviceSigningKeyGeneration: number;
    keyClass: "ai" | "human";
    authority: readonly NamespaceGenerationAuthority[];
    signal?: AbortSignal;
  }>, use: (
    entries: readonly OpenedNamespaceGeneration[],
  ) => Promise<Value> | Value): Promise<
    | Readonly<{ status: "opened"; value: Value }>
    | Readonly<{ status: "unavailable"; reason: string }>
  >;
}

/** Durable authority needed to reopen every retained AI generation in a Room. */
export interface RetainedRoomReadPlan {
  readonly subjectHumanId: string;
  readonly readerDeviceSigningKeyGeneration: number;
  readonly namespaceId: string;
  readonly namespaceAccessRevision: number;
  readonly namespaceAudienceFingerprint: Uint8Array;
}

export interface OpenedRetainedRoomAuthority {
  /** Callback-borrowed entries. Callers must not retain their raw keys. */
  readonly retainedGenerations: readonly RetainedRoomNamespaceGeneration[];
}

export interface RetainedRoomNamespaceGeneration {
  readonly generation: ReturnType<typeof namespaceGeneration>;
  readonly accessRevision: ReturnType<typeof accessRevision>;
  readonly headDigest: Uint8Array;
  readonly publicationDigest: Uint8Array;
  readonly publicationSetDigest: Uint8Array;
  readonly audienceFingerprint: Uint8Array;
  readonly generationKey: Uint8Array;
}

export interface RetainedRoomAuthorityClient {
  withOpenedRetainedRoomAuthority<Value>(input: Readonly<{
    sourceRoomId: string;
    plan: RetainedRoomReadPlan;
  }>, use: (
    authority: OpenedRetainedRoomAuthority,
  ) => Promise<Value> | Value): Promise<
    | Readonly<{ status: "opened"; value: Value }>
    | Readonly<{ status: "unavailable"; reason: string }>
  >;
}
