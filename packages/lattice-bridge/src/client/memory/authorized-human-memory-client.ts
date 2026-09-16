import type {
  NautiloApiClient,
  ProtectedMemoryArchiveRequestV1,
  ProtectedMemoryCreatePlanResponseV1,
  ProtectedMemoryOrdinaryFallbackCreatePlanV1,
  ProtectedMemoryDtoV1,
  ProtectedMemoryPreparedCreateRequestV1,
  ProtectedMemoryPreparedUpdateRequestV1,
  ProtectedMemoryOrdinaryFallbackCreateRequestV1,
  ProtectedMemoryOrdinaryFallbackUpdateRequestV1,
  ProtectedMemoryProjectionV1,
  ProtectedMemoryUnavailableResponseV1,
  ProtectedMemoryAccessOperationV1,
  ProtectedMemoryAccessPlanResponseV1,
  ProtectedMemoryPreparedAccessRequestV1,
  ProtectedMemoryRepairPlanV1,
  ProtectedMemoryPreparedRepairRequestV1,
  ProtectedMemoryRepairResponseV1,
} from "@nautilo/api-client/browser";

import {
  decodeMemoryPayloadV1,
  encodeMemoryPayloadV1,
  type MemoryPayloadV1,
} from "../../memory/memory-payload-v1.ts";
import {
  PreparedMutationJournalBackpressureError,
  type PreparedHumanMemoryMutation,
  type PreparedMutationJournalIndex,
  type PreparedMutationRetryCandidate,
} from "./prepared-mutation-journal.ts";
import { decodeHumanMemoryRepairAttestationV1 } from "../../memory/human-memory-repair-attestation.ts";
import {
  bindEncryptionDataOperationOwner,
  type DataOperationFailureClass,
  type EncryptionDataOperationOwner,
} from "../../transition/encryption-data-operation-owner.ts";

type ProtectedMemoryApiBase = Pick<
  NautiloApiClient,
  | "listProtectedMemories"
  | "getProtectedMemory"
  | "getProtectedMemoryBrief"
  | "planProtectedMemoryCreate"
  | "archiveProtectedMemory"
  | "transitionProtectedMemoryTier"
  | "restoreProtectedMemory"
  | "planProtectedMemoryAccess"
  | "commitProtectedMemoryAccess"
>;

export type ProtectedMemoryApi = ProtectedMemoryApiBase &
  Partial<
    Pick<
      NautiloApiClient,
      "planProtectedMemoryRepair" | "commitProtectedMemoryRepair"
    >
  > &
  Readonly<{
    searchProtectedMemories(
      options: Readonly<{
        q: string;
        mode: "text" | "semantic";
        limit?: number;
        includeArchive?: boolean;
      }>,
    ): ReturnType<NautiloApiClient["searchProtectedMemories"]>;
    createProtectedMemory(
      prepared: Parameters<NautiloApiClient["createProtectedMemory"]>[0],
    ): ReturnType<NautiloApiClient["createProtectedMemory"]>;
    updateProtectedMemory(
      memoryId: string,
      prepared: Parameters<NautiloApiClient["updateProtectedMemory"]>[1],
    ): ReturnType<NautiloApiClient["updateProtectedMemory"]>;
  }>;

export type AuthorizedHumanMemoryUnavailableReason =
  | ProtectedMemoryUnavailableResponseV1["reason"]
  | "shadow_pending"
  | "backfill_pending"
  | "unsupported_version"
  | "corrupt"
  | "lost_key_material";

export class AuthorizedHumanMemoryUnavailableError extends Error {
  override readonly name = "AuthorizedHumanMemoryUnavailableError";

  constructor(readonly reason: AuthorizedHumanMemoryUnavailableReason) {
    super(`Protected Human Memory is unavailable (${reason})`);
  }
}

/**
 * Plaintext write intent. It is accepted only by the injected local content
 * port and is never stored by this composition, the API client, or a UI state
 * container.
 */
export type AuthorizedHumanMemoryWriteIntentV1 = Readonly<{
  payload: MemoryPayloadV1;
  importance?: number;
  requestedProvider: "openai" | "openrouter" | "venice";
  requestedModel: string;
}>;

export type AuthorizedHumanMemoryOpenedV1 = Readonly<{
  projection: ProtectedMemoryProjectionV1;
  payload: MemoryPayloadV1;
}>;

export type AuthorizedHumanMemoryReadResultV1 =
  | Readonly<AuthorizedHumanMemoryOpenedV1 & { representation: "protected" }>
  | Readonly<
      AuthorizedHumanMemoryOpenedV1 & {
        representation: "ordinary_fallback";
        policyRevision: number;
      }
    >;

type OrdinaryFallbackCompletion = Readonly<{
  status: "ordinary_fallback";
  memoryId: string;
  reason: "encryption_pending" | "target_encryption_not_ready";
  followUpPending?: true;
}>;

type ContentCompletion =
  | Readonly<{
      status: "published" | "replayed";
      memoryId: string;
      followUpPending?: true;
    }>
  | OrdinaryFallbackCompletion;

type AccessCompletion =
  | Readonly<{
      status: "unchanged" | "updated" | "replayed";
      memoryId: string;
      followUpPending?: true;
    }>
  | OrdinaryFallbackCompletion;

/**
 * Trusted device-local crypto boundary. Implementations must authenticate the
 * exact DTO and open it through one of its exact Namespace envelopes. Returning
 * the canonical MemoryPayloadV1 bytes transfers ownership to this composition;
 * the port must not retain or reuse that buffer because it is always wiped
 * after callback-local decoding.
 *
 * Preparation owns local payload encryption, exact Namespace envelopes,
 * Human-device signing, and the bounded signed content-embedding request. It
 * returns only the canonical wire DTO; no private key or DEK crosses this port.
 */
export interface AuthorizedHumanMemoryDeviceContentPort {
  prepareRepair?(
    plan: ProtectedMemoryRepairPlanV1,
  ): Promise<ProtectedMemoryPreparedRepairRequestV1>;
  openExact(dto: ProtectedMemoryDtoV1): Promise<Uint8Array>;
  prepareCreate(
    input: Readonly<{
      plan: Exclude<ProtectedMemoryCreatePlanResponseV1, { status: string }>;
      intent: AuthorizedHumanMemoryWriteIntentV1;
    }>,
  ): Promise<ProtectedMemoryPreparedCreateRequestV1>;
  prepareUpdate(
    input: Readonly<{
      current: ProtectedMemoryDtoV1;
      intent: AuthorizedHumanMemoryWriteIntentV1;
    }>,
  ): Promise<ProtectedMemoryPreparedUpdateRequestV1>;
  prepareOrdinaryFallbackCreate?(
    input: Readonly<{
      plan:
        | ProtectedMemoryOrdinaryFallbackCreatePlanV1
        | Exclude<ProtectedMemoryCreatePlanResponseV1, { status: string }>;
      intent: AuthorizedHumanMemoryWriteIntentV1;
    }>,
  ): Promise<ProtectedMemoryOrdinaryFallbackCreateRequestV1>;
  prepareOrdinaryFallbackUpdate?(
    input: Readonly<{
      current: ProtectedMemoryDtoV1;
      policyRevision: number;
      intent: AuthorizedHumanMemoryWriteIntentV1;
    }>,
  ): Promise<ProtectedMemoryOrdinaryFallbackUpdateRequestV1>;
  prepareAccess(
    input: Readonly<{
      current: ProtectedMemoryDtoV1;
      plan: Extract<ProtectedMemoryAccessPlanResponseV1, { status: "planned" }>;
    }>,
  ): Promise<ProtectedMemoryPreparedAccessRequestV1>;
  prepareAccessReadiness(
    input: Readonly<{
      current: ProtectedMemoryDtoV1;
      sourceRoomId: string;
      requiredNamespaceIds: readonly string[];
    }>,
  ): Promise<void>;
}

export interface AuthorizedHumanMemoryObservationScope {
  content: AuthorizedHumanMemoryDeviceContentPort;
  verified(dto: ProtectedMemoryDtoV1): void;
  failed(dto: ProtectedMemoryDtoV1): void;
  settle(): Promise<void>;
}

export interface ObservedAuthorizedHumanMemoryDeviceContentPort extends AuthorizedHumanMemoryDeviceContentPort {
  beginObservationScope(): AuthorizedHumanMemoryObservationScope;
}

export type HumanMemoryObservationDeliveryResult = Readonly<{
  observationDelivery?: Promise<void>;
}>;

/**
 * Device-local durable custody for already-signed create, content-update, and
 * exact access-update
 * requests. The request contains no private key material and stays sealed at
 * rest. Implementations must survive client restart and return detached index
 * values from `listDue()`.
 */
export interface AuthorizedHumanMemoryPreparedMutationJournal {
  capacity(): Promise<Readonly<{ full: boolean }>>;
  putBeforeSend(mutation: PreparedHumanMemoryMutation): Promise<
    Readonly<{
      status: "inserted" | "duplicate";
      index: PreparedMutationJournalIndex;
    }>
  >;
  listDue(now?: number): Promise<readonly PreparedMutationRetryCandidate[]>;
  withPrepared<Result>(
    operationId: string,
    use: (mutation: PreparedHumanMemoryMutation) => Promise<Result> | Result,
  ): Promise<Result>;
  recordOutcome(
    input: Readonly<{
      operationId: string;
      authenticatedRequestDigestBase64url: string;
      outcome:
        | "completed"
        | "retryable"
        | "stale"
        | "denied"
        | "integrity"
        | "expired"
        | "collision";
    }>,
  ): Promise<void>;
}

export interface AuthorizedHumanMemoryClient {
  withList(
    options: Parameters<ProtectedMemoryApi["listProtectedMemories"]>[0],
    use: (opened: AuthorizedHumanMemoryReadResultV1) => void | Promise<void>,
    onUnavailable?: (
      input: Readonly<{
        projection: ProtectedMemoryProjectionV1;
        reason: AuthorizedHumanMemoryUnavailableReason;
      }>,
    ) => void | Promise<void>,
  ): Promise<
    Readonly<{
      nextCursor: string | null;
      memoryMode: "namespace" | "scope";
      total?: number;
    }> &
      HumanMemoryObservationDeliveryResult
  >;
  withDetail(
    memoryId: string,
    use: (opened: AuthorizedHumanMemoryReadResultV1) => void | Promise<void>,
  ): Promise<
    Readonly<{
      memoryMode: "namespace" | "scope";
      actionAuthority: Readonly<{
        canEdit: boolean;
        canArchive: boolean;
        canManageAccess: boolean;
      }>;
    }> &
      HumanMemoryObservationDeliveryResult
  >;
  withSearch(
    options: Parameters<ProtectedMemoryApi["searchProtectedMemories"]>[0],
    use: (
      opened: AuthorizedHumanMemoryReadResultV1,
      score: number,
    ) => void | Promise<void>,
    onUnavailable?: (
      input: Readonly<{
        projection: ProtectedMemoryProjectionV1;
        score: number;
        reason: AuthorizedHumanMemoryUnavailableReason;
      }>,
    ) => void | Promise<void>,
  ): Promise<
    Readonly<{
      memoryMode: "namespace" | "scope";
      queryDisclosure: "embedding_provider";
    }> &
      HumanMemoryObservationDeliveryResult
  >;
  withBrief(
    options: Parameters<ProtectedMemoryApi["getProtectedMemoryBrief"]>[0],
    use: (opened: AuthorizedHumanMemoryReadResultV1) => void | Promise<void>,
    onUnavailable?: (
      input: Readonly<{
        projection: ProtectedMemoryProjectionV1;
        reason: AuthorizedHumanMemoryUnavailableReason;
      }>,
    ) => void | Promise<void>,
  ): Promise<
    Readonly<{ memoryMode: "namespace" | "scope" }> &
      HumanMemoryObservationDeliveryResult
  >;
  create(
    intent: AuthorizedHumanMemoryWriteIntentV1,
    use: (opened: AuthorizedHumanMemoryOpenedV1) => void | Promise<void>,
  ): Promise<ContentCompletion>;
  update(
    memoryId: string,
    intent: AuthorizedHumanMemoryWriteIntentV1,
    use: (opened: AuthorizedHumanMemoryOpenedV1) => void | Promise<void>,
  ): Promise<ContentCompletion>;
  archive(memoryId: string): Promise<
    Readonly<{
      status: "archived" | "replayed";
      memoryId: string;
      tier: 3;
    }>
  >;
  transitionTier(
    memoryId: string,
    action: "promote" | "demote",
  ): Promise<
    Readonly<{
      status: "promoted" | "demoted" | "replayed";
      memoryId: string;
      previousTier: 1 | 2;
      nextTier: 1 | 2 | 3;
    }>
  >;
  restore(memoryId: string): Promise<
    Readonly<{
      status: "restored" | "replayed";
      memoryId: string;
      previousTier: 3;
      nextTier: 1 | 2;
    }>
  >;
  deleteAuthorizedView(memoryId: string): Promise<AccessCompletion>;
  grantRoom(memoryId: string, roomId: string): Promise<AccessCompletion>;
  grantUser(memoryId: string, userHandle: string): Promise<AccessCompletion>;
  revokeUser(memoryId: string, userHandle: string): Promise<AccessCompletion>;
  makePrivate(memoryId: string): Promise<AccessCompletion>;
  retryPendingMutations(): Promise<number>;
}

declare const AUTHORIZED_HUMAN_MEMORY_TEST_AUTHORITY: unique symbol;
export type AuthorizedHumanMemoryTestAuthority = Readonly<{
  [AUTHORIZED_HUMAN_MEMORY_TEST_AUTHORITY]: true;
}>;

const testAuthorities = new WeakSet<object>();

function unavailable(
  value: unknown,
): value is ProtectedMemoryUnavailableResponseV1 {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    value.status === "unavailable"
  );
}

function ordinaryFallbackEligible(error: unknown): boolean {
  return (
    error instanceof AuthorizedHumanMemoryUnavailableError &&
    (error.reason === "encryption_pending" ||
      error.reason === "target_encryption_not_ready" ||
      error.reason === "lost_key_material" ||
      error.reason === "shadow_pending" ||
      error.reason === "backfill_pending")
  );
}

function classifyHumanMemoryFailure(error: unknown): DataOperationFailureClass {
  if (!(error instanceof AuthorizedHumanMemoryUnavailableError))
    return "unknown";
  if (error.reason === "authorization_required") return "authority";
  if (
    error.reason === "integrity_failure" ||
    error.reason === "incomplete_access_set" ||
    error.reason === "corrupt" ||
    error.reason === "unsupported_version"
  )
    return "integrity";
  if (error.reason === "lost_key_material") return "key_waiting";
  if (ordinaryFallbackEligible(error)) return "recoverable_availability";
  if (
    error.reason === "missing_mapping" ||
    error.reason === "legacy_plaintext" ||
    error.reason === "protected_representation_missing"
  ) {
    return "recoverable_availability";
  }
  if (error.reason === "stale_revision" || error.reason === "deleted")
    return "stale";
  return "unsupported";
}

function followUpPending(
  value: object,
): Readonly<{ followUpPending: true }> | object {
  return "followUpPending" in value && value.followUpPending === true
    ? Object.freeze({ followUpPending: true as const })
    : Object.freeze({});
}

function exactStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function normalizeWriteIntent(
  value: AuthorizedHumanMemoryWriteIntentV1,
): AuthorizedHumanMemoryWriteIntentV1 {
  const fields = Object.keys(value).sort();
  const expected =
    value.importance === undefined
      ? ["payload", "requestedModel", "requestedProvider"]
      : ["importance", "payload", "requestedModel", "requestedProvider"];
  if (
    fields.length !== expected.length ||
    fields.some((field, index) => field !== expected[index])
  )
    throw new TypeError("Protected Human Memory write intent is invalid");
  if (
    value.requestedProvider !== "openai" &&
    value.requestedProvider !== "openrouter" && value.requestedProvider !== "venice"
  )
    throw new TypeError("Protected Human Memory provider is invalid");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u.test(value.requestedModel))
    throw new TypeError("Protected Human Memory model is invalid");
  if (
    value.importance !== undefined &&
    (!Number.isFinite(value.importance) ||
      value.importance < 0 ||
      value.importance > 1)
  )
    throw new TypeError("Protected Human Memory importance is invalid");
  const payloadBytes = encodeMemoryPayloadV1(value.payload);
  try {
    return Object.freeze({
      payload: decodeMemoryPayloadV1(payloadBytes),
      ...(value.importance === undefined
        ? {}
        : { importance: value.importance }),
      requestedProvider: value.requestedProvider,
      requestedModel: value.requestedModel,
    });
  } finally {
    payloadBytes.fill(0);
  }
}

function publicationMatches(
  dto: ProtectedMemoryDtoV1,
  expected: Readonly<{
    memoryId: string;
    contentRevision: number;
    cryptoObjectId: string;
    requiredNamespaceIds: readonly string[];
  }>,
): boolean {
  return (
    dto.projection.memoryId === expected.memoryId &&
    dto.projection.contentRevision === expected.contentRevision &&
    dto.projection.cryptoAccessRevision === 0 &&
    exactStrings(
      dto.projection.requiredNamespaceIds,
      expected.requiredNamespaceIds,
    ) &&
    dto.protectedPayload.status === "encrypted" &&
    dto.protectedPayload.cryptoObjectId === expected.cryptoObjectId
  );
}

type EncryptedProtectedMemoryDto = ProtectedMemoryDtoV1 &
  Readonly<{
    protectedPayload: Extract<
      ProtectedMemoryDtoV1["protectedPayload"],
      {
        status: "encrypted";
      }
    >;
  }>;

function requireEncrypted(
  dto: ProtectedMemoryDtoV1,
): EncryptedProtectedMemoryDto {
  if (dto.protectedPayload.status === "encrypted") {
    return dto as EncryptedProtectedMemoryDto;
  }
  throw new AuthorizedHumanMemoryUnavailableError(dto.protectedPayload.reason);
}

function unavailableOutcome(
  reason: ProtectedMemoryUnavailableResponseV1["reason"],
): "retryable" | "stale" | "denied" | "integrity" {
  switch (reason) {
    case "authorization_required":
      return "denied";
    case "integrity_failure":
    case "incomplete_access_set":
      return "integrity";
    case "missing_mapping":
    case "protected_representation_missing":
    case "legacy_plaintext":
    case "stale_revision":
    case "deleted":
      return "stale";
    case "encryption_pending":
    case "target_encryption_not_ready":
    case "embedding_unavailable":
    case "text_search_unsupported":
      return "retryable";
  }
}

function assertJournalCapacity(capacity: Readonly<{ full: boolean }>): void {
  if (capacity.full) {
    throw new PreparedMutationJournalBackpressureError(
      "Prepared mutation journal is full",
    );
  }
}

async function withOpened(
  owner: EncryptionDataOperationOwner,
  content: AuthorizedHumanMemoryDeviceContentPort,
  rawDto: ProtectedMemoryDtoV1,
  use: (opened: AuthorizedHumanMemoryReadResultV1) => void | Promise<void>,
  onUnavailable?: (
    input: Readonly<{
      projection: ProtectedMemoryProjectionV1;
      reason: AuthorizedHumanMemoryUnavailableReason;
    }>,
  ) => void | Promise<void>,
  observation?: AuthorizedHumanMemoryObservationScope,
  repair?: () => Promise<ProtectedMemoryDtoV1>,
): Promise<void> {
  let protectedFailure: unknown;
  try {
    const open = async (raw: ProtectedMemoryDtoV1) => {
      const dto = requireEncrypted(raw);
      const plaintext = await content.openExact(dto);
      if (!(plaintext instanceof Uint8Array)) {
        throw new TypeError(
          "Protected Human Memory opener returned invalid bytes",
        );
      }
      try {
        const payload = decodeMemoryPayloadV1(plaintext);
        observation?.verified(dto);
        return Object.freeze({
          representation: "protected" as const,
          projection: dto.projection,
          payload,
        });
      } catch {
        observation?.failed(dto);
        throw new AuthorizedHumanMemoryUnavailableError("corrupt");
      } finally {
        plaintext.fill(0);
      }
    };
    const opened = await owner.read<
      AuthorizedHumanMemoryReadResultV1,
      AuthorizedHumanMemoryReadResultV1,
      AuthorizedHumanMemoryReadResultV1
    >({
      protected: async () => {
        try {
          return await open(rawDto);
        } catch (error) {
          protectedFailure = error;
          throw error;
        }
      },
      ordinary: () => {
        if (rawDto.ordinaryFallback === undefined) {
          if (
            protectedFailure instanceof AuthorizedHumanMemoryUnavailableError
          ) {
            throw protectedFailure;
          }
          throw new AuthorizedHumanMemoryUnavailableError(
            "protected_representation_missing",
          );
        }
        return Promise.resolve(
          Object.freeze({
            representation: "ordinary_fallback" as const,
            projection: rawDto.projection,
            payload: Object.freeze({ ...rawDto.ordinaryFallback.payload }),
            policyRevision: rawDto.ordinaryFallback.policyRevision,
          }),
        );
      },
      consumeOrdinary: (value) => value,
      consumeProtected: (value) => value,
      classifyFailure: classifyHumanMemoryFailure,
      ...(repair === undefined ? {} : { repair: {
        ...(rawDto.protectedPayload.status === "encrypted" ? {} : {
          forward: async () => open(await repair()),
        }),
        ...(rawDto.projection.representationRepair === "protected_to_ordinary"
          ? { reverse: async () => { await repair(); } } : {}),
      } }),
    });
    await use(opened.value);
    return;
  } catch (error) {
    const reason =
      error instanceof AuthorizedHumanMemoryUnavailableError
        ? error.reason
        : null;
    if (reason === null || onUnavailable === undefined) throw error;
    await onUnavailable(
      Object.freeze({ projection: rawDto.projection, reason }),
    );
  }
}

function beginObservationScope(
  content: AuthorizedHumanMemoryDeviceContentPort,
): AuthorizedHumanMemoryObservationScope {
  if (
    "beginObservationScope" in content &&
    typeof content.beginObservationScope === "function"
  ) {
    return (
      content as ObservedAuthorizedHumanMemoryDeviceContentPort
    ).beginObservationScope();
  }
  return Object.freeze({
    content,
    verified() {},
    failed() {},
    settle: () => Promise.resolve(),
  });
}

function withObservationDelivery<Result extends object>(
  result: Result,
  delivery: Promise<void>,
): Readonly<Result> {
  Object.defineProperty(result, "observationDelivery", {
    configurable: false,
    enumerable: false,
    value: delivery,
    writable: false,
  });
  return Object.freeze(result);
}

export function createAuthorizedHumanMemoryClient(
  input: Readonly<{
    authority: AuthorizedHumanMemoryTestAuthority;
    api: ProtectedMemoryApi;
    content: AuthorizedHumanMemoryDeviceContentPort;
    journal: AuthorizedHumanMemoryPreparedMutationJournal;
    createOperationId(
      input: Readonly<{
        kind: "archive" | "tier" | "restore";
        memoryId: string;
      }>,
    ): string;
  }>,
): AuthorizedHumanMemoryClient {
  if (!testAuthorities.has(input.authority)) {
    throw new TypeError("Protected Human Memory test authority is invalid");
  }
  return createAuthorizedHumanMemoryClientFromTrustedPorts({
    ...input,
    owner: bindEncryptionDataOperationOwner({
      policy: {
        resolve: () =>
          Promise.resolve({
            policy: { mode: "shadow_encryption", shadowBehavior: "fallback" },
            revalidationToken: 0,
          }),
        revalidate: () => Promise.resolve(),
      },
    }),
  });
}

/** Internal production assembly seam. Callers must own authenticated API,
 * admitted device custody, and durable local journal construction. */
export function createAuthorizedHumanMemoryClientFromTrustedPorts(
  input: Readonly<{
    owner: EncryptionDataOperationOwner;
    api: ProtectedMemoryApi;
    content: AuthorizedHumanMemoryDeviceContentPort;
    journal: AuthorizedHumanMemoryPreparedMutationJournal;
    createOperationId(
      input: Readonly<{
        kind: "archive" | "tier" | "restore";
        memoryId: string;
      }>,
    ): string;
  }>,
): AuthorizedHumanMemoryClient {
  const { api, content, journal, owner } = input;

  async function publishPrepared(
    mutation: PreparedHumanMemoryMutation,
    index: Pick<
      PreparedMutationJournalIndex,
      "operationId" | "authenticatedRequestDigestBase64url"
    >,
  ): Promise<
    | Awaited<ReturnType<ProtectedMemoryApi["createProtectedMemory"]>>
    | Awaited<ReturnType<ProtectedMemoryApi["commitProtectedMemoryAccess"]>>
    | ProtectedMemoryRepairResponseV1
  > {
    let outcomeRecorded = false;
    try {
      const response =
        mutation.kind === "create"
          ? await api.createProtectedMemory(mutation.request)
          : mutation.kind === "update"
            ? await api.updateProtectedMemory(
                mutation.memoryId,
                mutation.request,
              )
            : mutation.kind === "repair"
              ? api.commitProtectedMemoryRepair === undefined
                ? (() => {
                    throw new AuthorizedHumanMemoryUnavailableError(
                      "encryption_pending",
                    );
                  })()
                : await api.commitProtectedMemoryRepair(
                    mutation.memoryId,
                    mutation.request,
                  )
              : await api.commitProtectedMemoryAccess(
                  mutation.memoryId,
                  mutation.request,
                );
      if (unavailable(response)) {
        await journal.recordOutcome({
          operationId: index.operationId,
          authenticatedRequestDigestBase64url:
            index.authenticatedRequestDigestBase64url,
          outcome: unavailableOutcome(response.reason),
        });
        outcomeRecorded = true;
        throw new AuthorizedHumanMemoryUnavailableError(response.reason);
      }
      if (response.status === "ordinary_fallback") {
        if (
          mutation.kind === "repair" ||
          response.operationId !== mutation.request.operationId ||
          response.memoryId !== mutation.memoryId ||
          (mutation.kind === "access"
            ? !("requiredNamespaceIds" in response) ||
              response.cryptoAccessRevision !==
                mutation.request.expectedCryptoAccessRevision ||
              !exactStrings(
                response.requiredNamespaceIds,
                mutation.request.targetNamespaceIds,
              )
            : !("contentRevision" in response) ||
              response.contentRevision !==
                mutation.request.nextContentRevision ||
              ("publicationKind" in mutation.request &&
                response.cryptoAccessRevision !==
                  mutation.request.expectedCryptoAccessRevision) ||
              (mutation.kind === "create" &&
                response.cryptoAccessRevision !== 0))
        ) {
          throw new TypeError(
            "Human Memory ordinary fallback receipt was substituted",
          );
        }
      } else if (mutation.kind === "repair") {
        const signed = Uint8Array.from(
          atob(
            mutation.request.signedRepairAttestationBytesBase64url
              .replaceAll("-", "+")
              .replaceAll("_", "/"),
          ),
          (char) => char.charCodeAt(0),
        );
        try {
          const expected = decodeHumanMemoryRepairAttestationV1(signed);
          if (
            !("direction" in response) ||
            response.memoryId !== mutation.memoryId ||
            response.operationId !== mutation.request.operationId ||
            response.direction !== expected.direction ||
            response.contentRevision !== expected.targetContentRevision ||
            response.cryptoAccessRevision !==
              expected.expectedCryptoAccessRevision ||
            (response.status !== "repaired" && response.status !== "replayed")
          ) {
            throw new TypeError(
              "Protected Human Memory repair receipt was substituted",
            );
          }
        } finally {
          signed.fill(0);
        }
      } else if (mutation.kind === "access") {
        if (
          !("memoryId" in response) ||
          !("cryptoAccessRevision" in response) ||
          !("requiredNamespaceIds" in response) ||
          response.memoryId !== mutation.memoryId ||
          response.operationId !== mutation.request.operationId ||
          response.cryptoAccessRevision !==
            mutation.request.nextCryptoAccessRevision ||
          !exactStrings(
            response.requiredNamespaceIds,
            mutation.request.targetNamespaceIds,
          ) ||
          (response.status !== "updated" && response.status !== "replayed")
        )
          throw new TypeError(
            "Protected Human Memory access receipt was substituted",
          );
      } else if (
        !("memory" in response) ||
        "publicationKind" in mutation.request ||
        !publicationMatches(response.memory, {
          memoryId: mutation.memoryId,
          contentRevision: mutation.request.nextContentRevision,
          cryptoObjectId: mutation.request.cryptoObjectId,
          requiredNamespaceIds: mutation.request.requiredNamespaceIds,
        })
      )
        throw new TypeError(
          "Protected Human Memory publication was substituted",
        );
      await journal.recordOutcome({
        operationId: index.operationId,
        authenticatedRequestDigestBase64url:
          index.authenticatedRequestDigestBase64url,
        outcome: "completed",
      });
      outcomeRecorded = true;
      return response;
    } catch (error) {
      if (!outcomeRecorded) {
        await journal.recordOutcome({
          operationId: index.operationId,
          authenticatedRequestDigestBase64url:
            index.authenticatedRequestDigestBase64url,
          outcome:
            error instanceof TypeError ||
            (error instanceof Error && error.name === "ZodError")
              ? "integrity"
              : "retryable",
        });
      }
      throw error;
    }
  }

  async function repairForRead(
    dto: ProtectedMemoryDtoV1,
  ): Promise<ProtectedMemoryDtoV1> {
    const needsRepair =
      (dto.protectedPayload.status === "pending" &&
        dto.protectedPayload.reason === "backfill_pending") ||
      (dto.protectedPayload.status === "unavailable" &&
        (dto.protectedPayload.reason === "missing_mapping" ||
          dto.protectedPayload.reason === "legacy_plaintext" ||
          dto.protectedPayload.reason === "protected_representation_missing")) ||
      dto.projection.representationRepair === "protected_to_ordinary";
    if (
      !needsRepair ||
      api.planProtectedMemoryRepair === undefined ||
      content.prepareRepair === undefined
    )
      return dto;
    const plan = await api.planProtectedMemoryRepair(dto.projection.memoryId);
    if (unavailable(plan))
      throw new AuthorizedHumanMemoryUnavailableError(plan.reason);
    if (plan.memoryId !== dto.projection.memoryId)
      throw new TypeError("Memory repair plan was substituted");
    if (plan.status === "planned") {
      if (
        plan.expectedContentRevision !== dto.projection.contentRevision ||
        plan.expectedCryptoAccessRevision !==
          dto.projection.cryptoAccessRevision ||
        !exactStrings(
          plan.requiredNamespaceIds,
          dto.projection.requiredNamespaceIds,
        )
      ) {
        throw new AuthorizedHumanMemoryUnavailableError("stale_revision");
      }
      assertJournalCapacity(await journal.capacity());
      const request = await content.prepareRepair(plan);
      if (
        request.memoryId !== plan.memoryId ||
        request.operationId !== plan.operationId ||
        request.direction !== plan.direction
      )
        throw new TypeError("Prepared Memory repair was substituted");
      const mutation = {
        kind: "repair" as const,
        memoryId: plan.memoryId,
        request,
      };
      const custody = await journal.putBeforeSend(mutation);
      await publishPrepared(mutation, custody.index);
    }
    // Never display repair input. A successful repair must pass the same
    // current protected read and device verification as any other Memory.
    const response = await api.getProtectedMemory(dto.projection.memoryId);
    if (unavailable(response))
      throw new AuthorizedHumanMemoryUnavailableError(response.reason);
    if (response.memory.projection.memoryId !== dto.projection.memoryId)
      throw new TypeError("Repaired Memory read was substituted");
    return response.memory;
  }

  async function withRepairedOpened(
    dto: ProtectedMemoryDtoV1,
    use: Parameters<typeof withOpened>[3],
    onUnavailable: Parameters<typeof withOpened>[4],
    observation: AuthorizedHumanMemoryObservationScope,
  ): Promise<void> {
    await withOpened(
      owner,
      observation.content,
      dto,
      use,
      onUnavailable,
      observation,
      () => repairForRead(dto),
    );
  }

  async function currentMetadata(
    memoryId: string,
    requiredAction: "edit" | "archive",
  ): Promise<ProtectedMemoryDtoV1> {
    const response = await api.getProtectedMemory(memoryId);
    if (unavailable(response)) {
      throw new AuthorizedHumanMemoryUnavailableError(response.reason);
    }
    if (response.memory.projection.memoryId !== memoryId) {
      throw new TypeError(
        "Protected Human Memory metadata source was substituted",
      );
    }
    if (
      (requiredAction === "edit" && !response.actionAuthority.canEdit) ||
      (requiredAction === "archive" && !response.actionAuthority.canArchive)
    ) {
      throw new AuthorizedHumanMemoryUnavailableError("authorization_required");
    }
    // Tier/archive operations mutate only server-authorized structural
    // metadata. Body custody and representation repair are unrelated to their
    // product CAS and must not make those operations unavailable.
    return response.memory;
  }

  function operationId(
    kind: "archive" | "tier" | "restore",
    memoryId: string,
  ): string {
    const value = input.createOperationId(Object.freeze({ kind, memoryId }));
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u.test(value)) {
      throw new TypeError("Protected Human Memory operation ID is invalid");
    }
    return value;
  }

  async function changeAccess(
    memoryId: string,
    operation: ProtectedMemoryAccessOperationV1,
  ): Promise<AccessCompletion> {
    const currentResponse = await api.getProtectedMemory(memoryId);
    if (unavailable(currentResponse)) {
      throw new AuthorizedHumanMemoryUnavailableError(currentResponse.reason);
    }
    if (
      currentResponse.memory.projection.memoryId !== memoryId ||
      !currentResponse.actionAuthority.canManageAccess
    )
      throw new AuthorizedHumanMemoryUnavailableError("authorization_required");
    const current = requireEncrypted(
      await repairForRead(currentResponse.memory),
    );
    let plan = await api.planProtectedMemoryAccess(memoryId, operation);
    if (plan.status === "readiness_required") {
      const readiness = plan;
      const authenticatedSource = current.projection.readAuthorities.some(
        (entry) => entry.sourceRoomId === readiness.sourceRoomId,
      );
      const currentNamespaces = new Set(
        current.projection.requiredNamespaceIds,
      );
      if (
        readiness.memoryId !== memoryId ||
        !authenticatedSource ||
        readiness.requiredNamespaceIds.some((namespaceId) =>
          currentNamespaces.has(namespaceId),
        )
      )
        throw new TypeError(
          "Protected Human Memory readiness target was substituted",
        );
      await content.prepareAccessReadiness({
        current,
        sourceRoomId: readiness.sourceRoomId,
        requiredNamespaceIds: readiness.requiredNamespaceIds,
      });
      plan = await api.planProtectedMemoryAccess(memoryId, operation);
    }
    if (unavailable(plan)) {
      throw new AuthorizedHumanMemoryUnavailableError(plan.reason);
    }
    if (plan.status === "readiness_required") {
      throw new AuthorizedHumanMemoryUnavailableError(plan.reason);
    }
    if (plan.memoryId !== memoryId) {
      throw new TypeError("Protected Human Memory access plan was substituted");
    }
    if (plan.status === "unchanged") {
      if (
        plan.cryptoAccessRevision !== current.projection.cryptoAccessRevision ||
        !exactStrings(
          plan.requiredNamespaceIds,
          [...current.projection.requiredNamespaceIds].sort(),
        )
      )
        throw new TypeError(
          "Protected Human Memory no-op plan was substituted",
        );
      return Object.freeze({ status: "unchanged", memoryId });
    }
    if (
      plan.expectedContentRevision !== current.projection.contentRevision ||
      plan.expectedCryptoAccessRevision !==
        current.projection.cryptoAccessRevision ||
      plan.cryptoObjectId !== current.protectedPayload.cryptoObjectId ||
      !exactStrings(
        plan.currentNamespaceIds,
        [...current.projection.requiredNamespaceIds].sort(),
      ) ||
      !exactStrings(
        plan.addedNamespaceIds,
        plan.targetNamespaceIds.filter(
          (namespaceId) => !plan.currentNamespaceIds.includes(namespaceId),
        ),
      ) ||
      !exactStrings(
        plan.removedNamespaceIds,
        plan.currentNamespaceIds.filter(
          (namespaceId) => !plan.targetNamespaceIds.includes(namespaceId),
        ),
      )
    )
      throw new TypeError(
        "Protected Human Memory access plan is stale or substituted",
      );
    assertJournalCapacity(await journal.capacity());
    const prepared = await content.prepareAccess({ current, plan });
    if (
      prepared.memoryId !== memoryId ||
      prepared.operationId !== plan.operationId ||
      prepared.expectedContentRevision !== plan.expectedContentRevision ||
      prepared.expectedCryptoAccessRevision !==
        plan.expectedCryptoAccessRevision ||
      prepared.nextCryptoAccessRevision !==
        plan.expectedCryptoAccessRevision + 1 ||
      prepared.cryptoObjectId !== plan.cryptoObjectId ||
      !exactStrings(prepared.currentNamespaceIds, plan.currentNamespaceIds) ||
      !exactStrings(prepared.targetNamespaceIds, plan.targetNamespaceIds)
    )
      throw new TypeError(
        "Prepared Human Memory access update disagrees with its plan",
      );
    const mutation = Object.freeze({
      kind: "access" as const,
      memoryId,
      request: prepared,
    });
    const custody = await journal.putBeforeSend(mutation);
    const response = await publishPrepared(mutation, custody.index);
    if (response.status === "ordinary_fallback")
      return Object.freeze({
        status: response.status,
        memoryId,
        reason: response.reason,
        ...followUpPending(response),
      });
    if (!("memoryId" in response)) {
      throw new TypeError("Protected Human Memory access response is invalid");
    }
    if (response.status !== "updated" && response.status !== "replayed") {
      throw new TypeError("Protected Human Memory access response is invalid");
    }
    return Object.freeze({ status: response.status, memoryId });
  }

  const client: AuthorizedHumanMemoryClient = {
    async withList(options, use, onUnavailable) {
      const response = await api.listProtectedMemories(options);
      if (unavailable(response)) {
        throw new AuthorizedHumanMemoryUnavailableError(response.reason);
      }
      const observation = beginObservationScope(content);
      try {
        for (const dto of response.items) {
          await withRepairedOpened(dto, use, onUnavailable, observation);
        }
      } catch (error) {
        await observation.settle();
        throw error;
      }
      return withObservationDelivery(
        {
          nextCursor: response.nextCursor,
          memoryMode: response.memoryMode,
          ...(response.total === undefined ? {} : { total: response.total }),
        },
        observation.settle(),
      );
    },
    async withDetail(memoryId, use) {
      const response = await api.getProtectedMemory(memoryId);
      if (unavailable(response)) {
        throw new AuthorizedHumanMemoryUnavailableError(response.reason);
      }
      if (response.memory.projection.memoryId !== memoryId) {
        throw new TypeError("Protected Human Memory detail was substituted");
      }
      const observation = beginObservationScope(content);
      try {
        await withOpened(
          owner,
          observation.content,
          response.memory,
          use,
          undefined,
          observation,
          () => repairForRead(response.memory),
        );
      } catch (error) {
        await observation.settle();
        throw error;
      }
      return withObservationDelivery(
        {
          memoryMode: response.memoryMode,
          actionAuthority: Object.freeze({ ...response.actionAuthority }),
        },
        observation.settle(),
      );
    },
    async withSearch(options, use, onUnavailable) {
      const response = await api.searchProtectedMemories(options);
      if (unavailable(response)) {
        throw new AuthorizedHumanMemoryUnavailableError(response.reason);
      }
      const observation = beginObservationScope(content);
      try {
        for (const result of response.items) {
          await withRepairedOpened(
            result.memory,
            (opened) => use(opened, result.score),
            onUnavailable === undefined
              ? undefined
              : (unavailable) =>
                  onUnavailable({
                    ...unavailable,
                    score: result.score,
                  }),
            observation,
          );
        }
      } catch (error) {
        await observation.settle();
        throw error;
      }
      return withObservationDelivery(
        {
          memoryMode: response.memoryMode,
          queryDisclosure: response.queryDisclosure,
        },
        observation.settle(),
      );
    },
    async withBrief(options, use, onUnavailable) {
      const response = await api.getProtectedMemoryBrief(options);
      if (unavailable(response)) {
        throw new AuthorizedHumanMemoryUnavailableError(response.reason);
      }
      const observation = beginObservationScope(content);
      try {
        for (const dto of response.items) {
          await withRepairedOpened(dto, use, onUnavailable, observation);
        }
      } catch (error) {
        await observation.settle();
        throw error;
      }
      return withObservationDelivery(
        { memoryMode: response.memoryMode },
        observation.settle(),
      );
    },
    async create(intent, use) {
      assertJournalCapacity(await journal.capacity());
      const normalizedIntent = normalizeWriteIntent(intent);
      let selectedPlan: ProtectedMemoryCreatePlanResponseV1 | undefined;
      const resolvePlan =
        async (): Promise<ProtectedMemoryCreatePlanResponseV1> => {
          if (selectedPlan !== undefined) return selectedPlan;
          const candidate = await api.planProtectedMemoryCreate();
          if (unavailable(candidate)) {
            throw new AuthorizedHumanMemoryUnavailableError(candidate.reason);
          }
          selectedPlan = candidate;
          return selectedPlan;
        };
      const prepareProtected = async () => {
        const plan = await resolvePlan();
        if ("status" in plan)
          throw new AuthorizedHumanMemoryUnavailableError(plan.reason);
        return content.prepareCreate({ plan, intent: normalizedIntent });
      };
      type PreparedCreate =
        | ProtectedMemoryPreparedCreateRequestV1
        | ProtectedMemoryOrdinaryFallbackCreateRequestV1;
      type CreateResponse = Awaited<
        ReturnType<ProtectedMemoryApi["createProtectedMemory"]>
      >;
      const response = await owner.mutate<PreparedCreate, CreateResponse>({
        protected: prepareProtected,
        dual: prepareProtected,
        ordinary: async () => {
          const plan = await resolvePlan();
          if (
            content.prepareOrdinaryFallbackCreate === undefined ||
            (!("status" in plan) &&
              plan.ordinaryFallbackAuthorization === undefined)
          ) {
            throw new AuthorizedHumanMemoryUnavailableError(
              "encryption_pending",
            );
          }
          return content.prepareOrdinaryFallbackCreate({
            plan,
            intent: normalizedIntent,
          });
        },
        classifyFailure: classifyHumanMemoryFailure,
        publish: async (prepared) => {
          const plan = await resolvePlan();
          if (
            prepared.memoryId !== plan.memoryId ||
            prepared.operationId !== plan.operationId ||
            prepared.expectedContentRevision !== plan.expectedContentRevision ||
            prepared.nextContentRevision !== plan.nextContentRevision ||
            !exactStrings(
              prepared.requiredNamespaceIds,
              plan.requiredNamespaceIds,
            )
          ) {
            throw new TypeError(
              "Prepared Human Memory create does not match its plan",
            );
          }
          const mutation = Object.freeze({
            kind: "create" as const,
            memoryId: plan.memoryId,
            request: prepared,
          });
          const custody = await journal.putBeforeSend(mutation);
          return (await publishPrepared(
            mutation,
            custody.index,
          )) as CreateResponse;
        },
      });
      if (response.status === "ordinary_fallback")
        return Object.freeze({
          status: response.status,
          memoryId: response.memoryId,
          reason: response.reason,
          ...followUpPending(response),
        });
      if (!("memory" in response)) {
        throw new TypeError(
          "Protected Human Memory create response is invalid",
        );
      }
      await withOpened(owner, content, response.memory, use);
      return Object.freeze({
        status: response.status,
        memoryId: response.memory.projection.memoryId,
      });
    },
    async update(memoryId, intent, use) {
      assertJournalCapacity(await journal.capacity());
      const normalizedIntent = normalizeWriteIntent(intent);
      const currentResponse = await api.getProtectedMemory(memoryId);
      if (unavailable(currentResponse)) {
        throw new AuthorizedHumanMemoryUnavailableError(currentResponse.reason);
      }
      if (currentResponse.memory.projection.memoryId !== memoryId) {
        throw new TypeError(
          "Protected Human Memory update source was substituted",
        );
      }
      if (!currentResponse.actionAuthority.canEdit) {
        throw new AuthorizedHumanMemoryUnavailableError(
          "authorization_required",
        );
      }
      let current = currentResponse.memory;
      const prepareProtected = async () => {
        current = requireEncrypted(await repairForRead(current));
        return content.prepareUpdate({ current, intent: normalizedIntent });
      };
      type PreparedUpdate =
        | ProtectedMemoryPreparedUpdateRequestV1
        | ProtectedMemoryOrdinaryFallbackUpdateRequestV1;
      type UpdateResponse = Awaited<
        ReturnType<ProtectedMemoryApi["updateProtectedMemory"]>
      >;
      const response = await owner.mutate<PreparedUpdate, UpdateResponse>({
        protected: prepareProtected,
        dual: prepareProtected,
        ordinary: async () => {
          if (
            currentResponse.ordinaryFallbackAuthorization === undefined ||
            content.prepareOrdinaryFallbackUpdate === undefined
          ) {
            throw new AuthorizedHumanMemoryUnavailableError(
              "encryption_pending",
            );
          }
          return content.prepareOrdinaryFallbackUpdate({
            current,
            policyRevision:
              currentResponse.ordinaryFallbackAuthorization.policyRevision,
            intent: normalizedIntent,
          });
        },
        classifyFailure: classifyHumanMemoryFailure,
        publish: async (prepared) => {
          if (
            prepared.operationId.length === 0 ||
            prepared.expectedContentRevision !==
              current.projection.contentRevision ||
            prepared.nextContentRevision !==
              current.projection.contentRevision + 1 ||
            !exactStrings(
              prepared.requiredNamespaceIds,
              [...current.projection.requiredNamespaceIds].sort(),
            )
          ) {
            throw new TypeError(
              "Prepared Human Memory update does not match its source",
            );
          }
          const mutation = Object.freeze({
            kind: "update" as const,
            memoryId,
            request: prepared,
          });
          const custody = await journal.putBeforeSend(mutation);
          return (await publishPrepared(
            mutation,
            custody.index,
          )) as UpdateResponse;
        },
      });
      if (response.status === "ordinary_fallback")
        return Object.freeze({
          status: response.status,
          memoryId,
          reason: response.reason,
          ...followUpPending(response),
        });
      if (!("memory" in response)) {
        throw new TypeError(
          "Protected Human Memory update response is invalid",
        );
      }
      await withOpened(owner, content, response.memory, use);
      return Object.freeze({
        status: response.status,
        memoryId: response.memory.projection.memoryId,
        ...followUpPending(response),
      });
    },
    async archive(memoryId) {
      const current = await currentMetadata(memoryId, "archive");
      if (current.projection.tier !== 1 && current.projection.tier !== 2) {
        throw new AuthorizedHumanMemoryUnavailableError("stale_revision");
      }
      const request: ProtectedMemoryArchiveRequestV1 = Object.freeze({
        requestVersion: 1,
        operationId: operationId("archive", memoryId),
        expectedContentRevision: current.projection.contentRevision,
        expectedCryptoAccessRevision: current.projection.cryptoAccessRevision,
        expectedTier: current.projection.tier,
      });
      const response = await api.archiveProtectedMemory(memoryId, request);
      if (unavailable(response)) {
        throw new AuthorizedHumanMemoryUnavailableError(response.reason);
      }
      if (
        response.operationId !== request.operationId ||
        response.memoryId !== memoryId ||
        response.contentRevision !== current.projection.contentRevision ||
        response.cryptoAccessRevision !==
          current.projection.cryptoAccessRevision ||
        response.tier !== 3
      )
        throw new TypeError("Protected Human Memory archive was substituted");
      return Object.freeze({
        status: response.status,
        memoryId,
        tier: 3 as const,
        ...followUpPending(response),
      });
    },
    async transitionTier(memoryId, action) {
      const current = await currentMetadata(memoryId, "edit");
      const expectedTier = current.projection.tier;
      const nextTier =
        action === "promote"
          ? expectedTier === 2
            ? 1
            : null
          : expectedTier === 1
            ? 2
            : expectedTier === 2
              ? 3
              : null;
      if (nextTier === null || (expectedTier !== 1 && expectedTier !== 2)) {
        throw new AuthorizedHumanMemoryUnavailableError("stale_revision");
      }
      const request = Object.freeze({
        requestVersion: 1 as const,
        operationId: operationId("tier", memoryId),
        expectedContentRevision: current.projection.contentRevision,
        expectedCryptoAccessRevision: current.projection.cryptoAccessRevision,
        action,
        expectedTier,
        nextTier,
      });
      const response = await api.transitionProtectedMemoryTier(
        memoryId,
        request,
      );
      if (unavailable(response)) {
        throw new AuthorizedHumanMemoryUnavailableError(response.reason);
      }
      if (
        response.operationId !== request.operationId ||
        response.memoryId !== memoryId ||
        response.contentRevision !== current.projection.contentRevision ||
        response.cryptoAccessRevision !==
          current.projection.cryptoAccessRevision ||
        response.previousTier !== expectedTier ||
        response.nextTier !== nextTier
      )
        throw new TypeError(
          "Protected Human Memory tier change was substituted",
        );
      return Object.freeze({
        status: response.status,
        memoryId,
        previousTier: expectedTier,
        nextTier,
        ...followUpPending(response),
      });
    },
    async restore(memoryId) {
      const current = await currentMetadata(memoryId, "archive");
      const nextTier = current.projection.demotedFrom;
      if (current.projection.tier !== 3 || (nextTier !== 1 && nextTier !== 2))
        throw new AuthorizedHumanMemoryUnavailableError("stale_revision");
      const request = Object.freeze({
        requestVersion: 1 as const,
        operationId: operationId("restore", memoryId),
        expectedContentRevision: current.projection.contentRevision,
        expectedCryptoAccessRevision: current.projection.cryptoAccessRevision,
        expectedTier: 3 as const,
        nextTier,
      });
      const response = await api.restoreProtectedMemory(memoryId, request);
      if (unavailable(response)) {
        throw new AuthorizedHumanMemoryUnavailableError(response.reason);
      }
      if (
        response.operationId !== request.operationId ||
        response.memoryId !== memoryId ||
        response.contentRevision !== current.projection.contentRevision ||
        response.cryptoAccessRevision !==
          current.projection.cryptoAccessRevision ||
        response.previousTier !== 3 ||
        response.nextTier !== nextTier
      )
        throw new TypeError("Protected Human Memory restore was substituted");
      return Object.freeze({
        status: response.status,
        memoryId,
        previousTier: 3 as const,
        nextTier,
        ...followUpPending(response),
      });
    },
    deleteAuthorizedView: (memoryId) =>
      changeAccess(memoryId, Object.freeze({ kind: "delete_authorized_view" })),
    grantRoom: (memoryId, roomId) =>
      changeAccess(memoryId, Object.freeze({ kind: "grant_room", roomId })),
    grantUser: (memoryId, userHandle) =>
      changeAccess(memoryId, Object.freeze({ kind: "grant_user", userHandle })),
    revokeUser: (memoryId, userHandle) =>
      changeAccess(
        memoryId,
        Object.freeze({ kind: "revoke_user", userHandle }),
      ),
    makePrivate: (memoryId) =>
      changeAccess(memoryId, Object.freeze({ kind: "make_private" })),
    async retryPendingMutations() {
      const pending = await journal.listDue();
      let completed = 0;
      for (const candidate of pending) {
        try {
          await journal.withPrepared(
            candidate.operationId,
            async (mutation) => {
              await publishPrepared(mutation, candidate);
              completed += 1;
            },
          );
        } catch {
          // The journal records the typed retry/terminal outcome. Continue the
          // bounded batch so one unavailable mutation cannot starve later work.
        }
      }
      return completed;
    },
  };
  return Object.freeze(client);
}

/** Test/developer-only authority. No production activation path calls this. */
export function __mintAuthorizedHumanMemoryTestAuthorityForTesting(): AuthorizedHumanMemoryTestAuthority {
  const authority = Object.freeze({}) as AuthorizedHumanMemoryTestAuthority;
  testAuthorities.add(authority);
  return authority;
}
