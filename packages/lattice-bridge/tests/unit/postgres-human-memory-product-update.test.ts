import { describe, expect, test } from "bun:test";

import {
  deriveMemoryCryptoObjectIdV1,
  fingerprintRequiredMemoryNamespaces,
} from "../../src/memory/memory-repository.ts";
import type {
  PreparedHumanMemoryUpdate,
} from "../../src/server/memory/human-memory-prepared-update.ts";
import type { AuthenticatedHumanMemoryOrdinaryFallbackRequestV1 } from
  "../../src/memory/human-memory-ordinary-fallback-request.ts";
import {
  PostgresHumanMemoryProductUpdate,
  humanMemoryAllocationRequestDigest,
} from "../../src/server/memory/postgres-human-memory-product-update.ts";
import { HumanMemoryPreparedRouteError } from
  "../../src/server/memory/human-memory-prepared-route-error.ts";
import {
  bindConversationProductCanonicalTransactionRunner,
  verifyConversationProductPostgresHandle,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresConnection,
  type ConversationProductPostgresScalar,
  type ConversationProductPostgresTransaction,
  type ConversationProductPostgresHandle,
} from "../../src/server/message/postgres-conversation-product-store.ts";

const MEMORY_ID = "82000000-0000-4000-8000-000000000001";
const NAMESPACE_IDS = [
  "82000000-0000-4000-8000-000000000010",
  "82000000-0000-4000-8000-000000000020",
] as const;
const OPERATION_ID = "human-memory:update:1";
const SIGNED_PLAINTEXT = "must-never-be-a-product-sql-parameter";
const SIGNED_BYTES = "c2lnbmVkLXJlcXVlc3QtYnl0ZXM";

function normalizedSql(statement: string): string {
  return statement.replaceAll('"', "").replace(/\s+/g, " ").trim()
    .toUpperCase();
}

type OperationState = {
  requestDigest: Uint8Array;
  expectedAccessRevision: number;
  expectedContentRevision: number;
  resultContentRevision: number;
  disposition: "blocked" | "active" | "complete";
  createdAt: Date;
  completion: "pending" | "complete" | "ordinary_fallback";
  humanProductOutcome?: unknown;
  ordinaryFallbackReason?: "encryption_pending" | "target_encryption_not_ready";
  foregroundStableRequestDigest?: Uint8Array;
  foregroundMutationKind?: "save" | "replace";
  foregroundRequiredNamespaceIds?: readonly string[];
};

type AllocationState = {
  allocationDigest: Uint8Array;
  fingerprint: Uint8Array;
  objectId: string;
};

class ProductConnection implements ConversationProductPostgresConnection {
  timestampsAsStrings = false;

  timestamp(value: Date): Date | string {
    return this.timestampsAsStrings ? value.toISOString() : new Date(value);
  }

  exists = true;
  creationKey: string | null = null;
  contentRevision = 1;
  accessRevision = 0;
  objectId: string | null = deriveMemoryCryptoObjectIdV1({
    memoryId: MEMORY_ID,
    contentRevision: 1,
  });
  fingerprint: Uint8Array | null = fingerprintRequiredMemoryNamespaces(
    NAMESPACE_IDS,
  );
  embedding = new Array<number>(1536).fill(0.25);
  embeddingRevision = 1;
  embeddingProvider = "openai";
  embeddingModel = "old-model";
  priorRevisionSuperseded = false;
  operation: OperationState | null = null;
  allocation: AllocationState | null = null;
  namespaceIds: readonly string[] = NAMESPACE_IDS;
  scopeOrigins: readonly string[] = [];
  scopeOriginNamespaceId: string | null = null;
  scopeLifecycleState: "open" | "closing" = "open";
  createdAt = new Date("2026-08-10T00:00:00.000Z");
  readonly calls: Array<Readonly<{
    statement: string;
    parameters: readonly ConversationProductPostgresScalar[];
  }>> = [];

  query<Row extends ConversationProductDatabaseRow = ConversationProductDatabaseRow>(
    statement: string,
    _parameters: readonly ConversationProductPostgresScalar[] = [],
  ): Promise<readonly Row[]> {
    if (statement.includes("current_user::text")) {
      return Promise.resolve([{
        current_user: "nautilo",
        session_user: "nautilo",
      }] as unknown as Row[]);
    }
    throw new Error(`Product query outside transaction: ${statement}`);
  }

  async transaction<Result>(
    callback: (transaction: ConversationProductPostgresTransaction) => Promise<Result>,
  ): Promise<Result> {
    return callback({
      query: async <Row extends ConversationProductDatabaseRow = ConversationProductDatabaseRow>(
        statement: string,
        parameters: readonly ConversationProductPostgresScalar[] = [],
      ): Promise<readonly Row[]> => {
        this.calls.push({ statement, parameters: [...parameters] });
        const normalized = statement.replaceAll('"', "").replace(/\s+/g, " ")
          .trim().toUpperCase();
        const has = (text: string): boolean =>
          normalized.includes(text.toUpperCase());
        if (has("app_current_user_id")) {
          return [{
            current_user_id: authority.userId,
            current_agent_id: null,
          }] as unknown as Row[];
        }
        if (has("FROM memories m")) {
          if (!this.exists) return [];
          const row: ConversationProductDatabaseRow = {
            memory_id: MEMORY_ID,
            creation_key: this.creationKey,
            content_revision: this.contentRevision,
            crypto_access_revision: this.accessRevision,
            crypto_object_id: this.objectId,
            crypto_required_namespace_fingerprint: this.fingerprint,
            scope_origin_namespace_id: this.scopeOriginNamespaceId,
            importance: 0.5,
            tier: 1,
            created_at: this.timestamp(this.createdAt),
            updated_at: this.timestamp(new Date("2026-08-10T00:00:01.000Z")),
            embedding: JSON.stringify(this.embedding),
            embedding_revision: this.embeddingRevision,
            embedding_provider: this.embeddingProvider,
            embedding_model: this.embeddingModel,
            embedding_dimensions: 1536,
            embedding_contract_version: 1,
            namespace_ids: JSON.stringify(this.namespaceIds),
            scope_origins: JSON.stringify(this.scopeOrigins),
          };
          return [row] as Row[];
        }
        if (has("human-memory:protected-scope-mutation-admission")) {
          return [{
            lifecycle_state: this.scopeLifecycleState,
          }] as unknown as Row[];
        }
        if (has("SELECT id FROM memories")) {
          return (this.exists ? [{ id: MEMORY_ID }] : []) as unknown as Row[];
        }
        if (has("JOIN memory_crypto_revisions")) {
          if (this.operation === null || this.allocation === null) return [];
          const row: ConversationProductDatabaseRow = {
            request_digest: this.operation.requestDigest,
            operation_completion: this.operation.completion,
            operation_disposition: this.operation.disposition,
            expected_access_revision: this.operation.expectedAccessRevision,
            memory_id: MEMORY_ID,
            anchor_namespace_id: this.namespaceIds[0]
              ?? this.scopeOriginNamespaceId
              ?? NAMESPACE_IDS[0],
            created_at: this.timestamp(this.operation.createdAt),
            human_product_outcome: this.operation.humanProductOutcome === undefined
              ? null : JSON.stringify(this.operation.humanProductOutcome),
            ordinary_fallback_reason: this.operation.ordinaryFallbackReason ?? null,
            foreground_stable_request_digest:
              this.operation.foregroundStableRequestDigest ?? null,
            foreground_mutation_kind: this.operation.foregroundMutationKind ?? null,
            foreground_required_namespace_ids:
              this.operation.foregroundRequiredNamespaceIds ?? null,
            crypto_object_id: this.allocation.objectId,
            allocation_request_digest: this.allocation.allocationDigest,
            required_namespace_fingerprint: this.allocation.fingerprint,
          };
          return [row] as Row[];
        }
        if (has("FROM memory_crypto_operations")) {
          if (this.operation === null) return [];
          const row: ConversationProductDatabaseRow = has(
            "operation_type",
          ) || has("request_digest") ? {
            operation_id: this.creationKey ?? OPERATION_ID,
            memory_id: MEMORY_ID,
            operation_type: "update",
            expected_content_revision: this.operation.expectedContentRevision,
            result_content_revision: this.operation.resultContentRevision,
            expected_access_revision: this.operation.expectedAccessRevision,
            request_digest: this.operation.requestDigest,
            completion: this.operation.completion,
            disposition: this.operation.disposition,
            anchor_namespace_id: this.namespaceIds[0]
              ?? this.scopeOriginNamespaceId
              ?? NAMESPACE_IDS[0],
            created_at: this.timestamp(this.operation.createdAt),
            human_product_outcome: this.operation.humanProductOutcome === undefined
              ? null : JSON.stringify(this.operation.humanProductOutcome),
            ordinary_fallback_reason: this.operation.ordinaryFallbackReason ?? null,
            foreground_stable_request_digest:
              this.operation.foregroundStableRequestDigest ?? null,
            foreground_mutation_kind: this.operation.foregroundMutationKind ?? null,
            foreground_required_namespace_ids:
              this.operation.foregroundRequiredNamespaceIds ?? null,
          } : { operation_id: OPERATION_ID };
          return [row] as Row[];
        }
        if (has("FROM memory_crypto_revisions")) {
          if (this.allocation === null) return [];
          const row: ConversationProductDatabaseRow = {
            crypto_object_id: this.allocation.objectId,
            allocation_request_digest: this.allocation.allocationDigest,
            required_namespace_fingerprint: this.allocation.fingerprint,
            completion: this.operation?.completion ?? "pending",
          };
          return [row] as Row[];
        }
        if (has("UPDATE memories SET") && has("embedding =")) {
          const vector = parameters.find(
            (value): value is string =>
              typeof value === "string" && value.startsWith("["),
          );
          const providerIndex = parameters.findIndex((value) =>
            value === "openai" || value === "openrouter"
          );
          this.contentRevision += 1;
          this.objectId = null;
          this.fingerprint = null;
          this.embedding = JSON.parse(vector ?? "[]") as number[];
          this.embeddingRevision = this.contentRevision;
          this.embeddingProvider = parameters[providerIndex] as string;
          this.embeddingModel = parameters[providerIndex + 1] as string;
          return [{ id: MEMORY_ID }] as unknown as Row[];
        }
        if (has("INSERT INTO memories")) {
          const vector = parameters.find(
            (value): value is string =>
              typeof value === "string" && value.startsWith("["),
          );
          const providerIndex = parameters.findIndex((value) =>
            value === "openai" || value === "openrouter"
          );
          const operationKey = parameters.find(
            (value): value is string =>
              typeof value === "string" && value.startsWith("human-memory:"),
          );
          const dates = parameters.filter(
            (value): value is Date => value instanceof Date,
          );
          const uuids = parameters.filter(
            (value): value is string =>
              typeof value === "string"
              && /^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(value),
          );
          this.exists = true;
          this.contentRevision = 1;
          this.accessRevision = 0;
          this.objectId = null;
          this.fingerprint = null;
          this.embedding = JSON.parse(vector ?? "[]") as number[];
          this.embeddingRevision = 1;
          this.embeddingProvider = parameters[providerIndex] as string;
          this.embeddingModel = parameters[providerIndex + 1] as string;
          this.creationKey = operationKey ?? null;
          this.scopeOriginNamespaceId = uuids.find((value) =>
            value !== MEMORY_ID
          ) ?? null;
          this.createdAt = dates[0] === undefined
            ? new Date(parameters.at(-1) as number)
            : new Date(dates[0]);
          this.namespaceIds = [];
          return [];
        }
        if (has("INSERT INTO memory_namespaces")) {
          const namespaceId = parameters.find(
            (value): value is string =>
              typeof value === "string" && value !== MEMORY_ID,
          )!;
          this.namespaceIds = [...this.namespaceIds, namespaceId]
            .sort();
          return [];
        }
        if (has("INSERT INTO memory_scopes")) {
          this.scopeOrigins = ["scope"];
          return [];
        }
        if (has("SET content_revision = 1")) {
          if (this.contentRevision !== 0) return [];
          this.contentRevision = 1;
          this.embedding = JSON.parse(parameters[1] as string) as number[];
          this.embeddingRevision = 1;
          this.embeddingProvider = parameters[2] as string;
          this.embeddingModel = parameters[3] as string;
          return [{ id: MEMORY_ID }] as unknown as Row[];
        }
        if (has("INSERT INTO memory_crypto_operations")) {
          const reservation = parameters.includes("blocked");
          const numbers = parameters.filter(
            (value): value is number => typeof value === "number",
          );
          const digest = parameters.find(
            (value): value is Uint8Array => value instanceof Uint8Array,
          )!;
          const createdAt = parameters.find(
            (value): value is Date => value instanceof Date,
          );
          this.operation = {
            requestDigest: digest.slice(),
            expectedAccessRevision: reservation ? 0 : numbers[2]!,
            expectedContentRevision: reservation ? 0 : numbers[0]!,
            resultContentRevision: reservation ? 1 : numbers[1]!,
            disposition: reservation ? "blocked" : "active",
            createdAt: reservation
              ? new Date(createdAt ?? this.createdAt)
              : new Date(this.createdAt),
            completion: "pending",
            ...(parameters.includes("save") || parameters.includes("replace") ? {
              foregroundStableRequestDigest: digest.slice(),
              foregroundMutationKind: parameters.includes("save")
                ? "save" as const : "replace" as const,
              foregroundRequiredNamespaceIds: [...this.namespaceIds],
            } : {}),
          };
          return [];
        }
        if (has("disposition =") && parameters.includes("superseded")) {
          this.priorRevisionSuperseded = true;
          return [{ sequence: 1 }] as unknown as Row[];
        }
        if (has("INSERT INTO memory_crypto_revisions")) {
          const byteValues = parameters.filter(
            (value): value is Uint8Array => value instanceof Uint8Array,
          );
          const objectId = parameters.find(
            (value): value is string =>
              typeof value === "string"
              && !/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(value),
          )!;
          this.allocation = {
            objectId,
            allocationDigest: byteValues[0]!.slice(),
            fingerprint: byteValues[1]!.slice(),
          };
          return [];
        }
        if (has("UPDATE memory_crypto_revisions")
          && parameters.includes("mapped")) {
          return [{ sequence: 1 }] as unknown as Row[];
        }
        if (has("UPDATE memories") && has("crypto_object_id")) {
          this.objectId = parameters.find(
            (value): value is string =>
              typeof value === "string"
              && !/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(value),
          )!;
          this.fingerprint = parameters.find(
            (value): value is Uint8Array => value instanceof Uint8Array,
          )!.slice();
          return [{ id: MEMORY_ID }] as unknown as Row[];
        }
        if (has("UPDATE memory_crypto_operations")
          && (parameters.includes("complete")
            || parameters.includes("ordinary_fallback"))) {
          if (this.operation !== null) {
            this.operation.completion = parameters.includes("ordinary_fallback")
              ? "ordinary_fallback" : "complete";
            if (this.operation.completion === "ordinary_fallback") {
              this.operation.ordinaryFallbackReason = parameters.includes(
                "target_encryption_not_ready",
              ) ? "target_encryption_not_ready" : "encryption_pending";
            }
            this.operation.disposition = "complete";
            const outcome = parameters.find((value) =>
              value !== null && typeof value === "object"
              && !(value instanceof Uint8Array) && !(value instanceof Date));
            const encodedOutcome = parameters.find((value) =>
              typeof value === "string" && value.startsWith('{"formatVersion":1'));
            this.operation.humanProductOutcome = outcome
              ?? (typeof encodedOutcome === "string"
                ? JSON.parse(encodedOutcome) as unknown : {
                  formatVersion: 1,
                  memoryId: MEMORY_ID,
                  contentRevision: this.operation.resultContentRevision,
                  cryptoAccessRevision: 0,
                  importance: 0.5,
                  tier: 1,
                  createdAt: this.createdAt.toISOString(),
                  updatedAt: new Date("2026-08-10T00:00:01.000Z").toISOString(),
                  namespaceIds: [...this.namespaceIds],
                  requiredNamespaceIds: [...this.namespaceIds],
                  scopeOrigin: null,
                });
          }
          return [{ sequence: 1 }] as unknown as Row[];
        }
        if (has("UPDATE memory_crypto_operations")
          && parameters.includes("active")) {
          if (this.operation === null || this.operation.disposition !== "blocked") {
            return [];
          }
          this.operation.disposition = "active";
          const digest = parameters.find(
            (value): value is Uint8Array => value instanceof Uint8Array,
          );
          if (digest !== undefined) {
            this.operation.foregroundStableRequestDigest = digest.slice();
          }
          if (parameters.includes("save") || parameters.includes("replace")) {
            this.operation.foregroundMutationKind = parameters.includes("save")
              ? "save" : "replace";
            this.operation.foregroundRequiredNamespaceIds = [...this.namespaceIds];
          }
          return [{ sequence: 1 }] as unknown as Row[];
        }
        throw new Error(`Unexpected Human product SQL: ${statement}`);
      },
    });
  }
}

function prepared(): PreparedHumanMemoryUpdate {
  return Object.freeze({
    operationId: OPERATION_ID,
    expectedHumanId: "82000000-0000-4000-8000-000000000098",
    memoryId: MEMORY_ID,
    contentRevision: 2,
    expectedContentRevision: 1,
    nextContentRevision: 2,
    objectId: deriveMemoryCryptoObjectIdV1({
      memoryId: MEMORY_ID,
      contentRevision: 2,
    }),
    objectType: "nautilo-memory-v1",
    payloadVersion: 1,
    requiredNamespaceIds: [...NAMESPACE_IDS],
  });
}

function preparedCreate(operationId: string): PreparedHumanMemoryUpdate {
  return Object.freeze({
    operationId,
    expectedHumanId: "82000000-0000-4000-8000-000000000098",
    memoryId: MEMORY_ID,
    contentRevision: 1,
    expectedContentRevision: 0,
    nextContentRevision: 1,
    objectId: deriveMemoryCryptoObjectIdV1({
      memoryId: MEMORY_ID,
      contentRevision: 1,
    }),
    objectType: "nautilo-memory-v1",
    payloadVersion: 1,
    requiredNamespaceIds: [NAMESPACE_IDS[0]],
  });
}

const authority = Object.freeze({
  userId: "82000000-0000-4000-8000-000000000099",
  mutableNamespaceIds: [...NAMESPACE_IDS],
  writableNamespaceIds: [...NAMESPACE_IDS],
});
const embedding = Object.freeze({
  provider: "openai" as const,
  canonicalModel: "text-embedding-3-small",
  dimensions: 1536 as const,
  vector: Object.freeze(new Array<number>(1536).fill(0.75)),
  processorContractVersion: 1 as const,
});
const authored = Object.freeze({
  formatVersion: 1 as const,
  type: "preference",
  content: "kept client-side",
});
const preparedAuthority = Object.freeze({
  purpose: "authenticate-human-memory-prepared-update" as const,
  expectedHumanId: "human:1",
  operationId: OPERATION_ID,
  memoryId: MEMORY_ID,
  expectedContentRevision: 1,
  nextContentRevision: 2,
  objectId: deriveMemoryCryptoObjectIdV1({ memoryId: MEMORY_ID, contentRevision: 2 }),
  payloadHash: new Uint8Array(32),
  envelopes: Object.freeze([]),
  committerDeviceId: "human-device:1",
  hostAuthorizationRevision: 1,
});

function ordinaryUpdateAuthenticated(
  requestDigest = new Uint8Array(32).fill(0x61),
  policyRevision = 1,
  expectedContentRevision = 1,
): AuthenticatedHumanMemoryOrdinaryFallbackRequestV1 {
  return Object.freeze({ requestDigest, request: Object.freeze({
    formatVersion: 1 as const,
    purpose: "memory.ordinary_fallback.update" as const,
    reason: "target_encryption_not_ready" as const,
    operationId: "human-memory:ordinary:update:1", memoryId: MEMORY_ID,
    expectedContentRevision,
    nextContentRevision: expectedContentRevision + 1,
    expectedCryptoAccessRevision: 0,
    requiredNamespaceIds: [...NAMESPACE_IDS], type: "preference",
    content: "ordinary device-authored content", importance: 0.8,
    requestedProvider: "openai" as const,
    requestedModel: "text-embedding-3-small", dimensions: 1536 as const,
    processorContractVersion: 1 as const, policyRevision,
    subjectHumanId: "human:1", committerDeviceId: "human-device:1",
    committerDeviceSigningKeyGeneration: 1, hostAuthorizationRevision: 1,
    planIssuedAt: null, planDeadlineAt: null,
    issuedAt: 1, deadlineAt: 2, signature: new Uint8Array(64),
  }) });
}

function createProduct(
  connection: ProductConnection,
  handle: ConversationProductPostgresHandle,
  options: Readonly<{
    createMemoryId?: () => string;
    createOperationId?: () => string;
    createPlanTtlMs?: number;
    publicationEvents?: string[];
    policyRevision?: number;
    allowOrdinaryFallback?: boolean;
  }> = {},
) {
  const canonicalRunner = bindConversationProductCanonicalTransactionRunner(
    handle,
    {
      transaction: (callback) => connection.transaction((executor) =>
        callback({
          execute: () => Promise.resolve([{
            current_user: "nautilo", session_user: "nautilo",
          }]),
        } as never, executor)),
    },
  );
  return new PostgresHumanMemoryProductUpdate(handle, {
    ...options,
    canonicalRunner,
    publication: {
      representation: "ordinary_and_protected",
      allowOrdinaryFallback: options.allowOrdinaryFallback ?? true,
      policyRevision: options.policyRevision ?? 1,
      fence: async () => { options.publicationEvents?.push("product-fence"); },
      withOrdinaryLocks: async (_input, publish) => publish(async () => {
        options.publicationEvents?.push("device-authority-locked");
      }),
      withLocks: async (_input, publish) => {
        options.publicationEvents?.push("restricted-transaction-open");
        const result = await publish(async () => {
          options.publicationEvents?.push("crypto-authority-locked");
        });
        options.publicationEvents?.push("product-transaction-committed");
        return result;
      },
    },
  });
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("Expected product operation to reject");
}

async function preparedRejection(
  promise: Promise<unknown>,
  reason: HumanMemoryPreparedRouteError["reason"],
): Promise<HumanMemoryPreparedRouteError> {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(HumanMemoryPreparedRouteError);
  expect((error as HumanMemoryPreparedRouteError).reason).toBe(reason);
  return error as HumanMemoryPreparedRouteError;
}

describe("Postgres Human Memory product update", () => {
  test("publishes signed ordinary update without a crypto allocation and replays", async () => {
    const connection = new ProductConnection();
    const handle = await verifyConversationProductPostgresHandle(connection);
    const product = createProduct(connection, handle);
    const requestDigest = new Uint8Array(32).fill(0x61);
    const authenticated = Object.freeze({ requestDigest,
      request: Object.freeze({ formatVersion: 1 as const,
        purpose: "memory.ordinary_fallback.update" as const,
        reason: "target_encryption_not_ready" as const,
        operationId: "human-memory:ordinary:update:1", memoryId: MEMORY_ID,
        expectedContentRevision: 1, nextContentRevision: 2,
        expectedCryptoAccessRevision: 0,
        requiredNamespaceIds: [...NAMESPACE_IDS], type: "preference",
        content: "ordinary device-authored content", importance: 0.8,
        requestedProvider: "openai" as const,
        requestedModel: "text-embedding-3-small", dimensions: 1536 as const,
        processorContractVersion: 1 as const, policyRevision: 1,
        subjectHumanId: "human:1", committerDeviceId: "human-device:1",
        committerDeviceSigningKeyGeneration: 1, hostAuthorizationRevision: 1,
        planIssuedAt: null, planDeadlineAt: null,
        issuedAt: 1, deadlineAt: 2, signature: new Uint8Array(64),
      }) }) satisfies AuthenticatedHumanMemoryOrdinaryFallbackRequestV1;
    const mutationOnlyAuthority = { ...authority, writableNamespaceIds: [] };
    const admission = await product.admitOrdinaryFallback({
      authority: mutationOnlyAuthority,
      authenticated });
    expect(connection.allocation).toBeNull();
    const projection = await product.publishOrdinaryFallbackIntent({
      authority: mutationOnlyAuthority, admission, embedding,
    });
    expect(projection).toMatchObject({ memoryId: MEMORY_ID, contentRevision: 2,
      cryptoAccessRevision: 0 });
    expect(connection.allocation).toBeNull();
    const replay = await product.lookupOrdinaryFallback({
      authority: mutationOnlyAuthority,
      operationId: authenticated.request.operationId, memoryId: MEMORY_ID,
      requestDigest });
    expect(replay?.completed?.projection).toMatchObject({ memoryId: MEMORY_ID,
      contentRevision: 2, cryptoAccessRevision: 0 });
    delete connection.operation!.foregroundMutationKind;
    expect(await product.lookupOrdinaryFallback({
      authority: mutationOnlyAuthority,
      operationId: authenticated.request.operationId, memoryId: MEMORY_ID,
      requestDigest,
    })).toBeNull();
    expect(await preparedRejection(product.admitOrdinaryFallback({
      authority: { ...authority, mutableNamespaceIds: [] }, authenticated,
    }), "authorization_required")).toBeInstanceOf(HumanMemoryPreparedRouteError);
  });

  test("rejects stale ordinary publication and mismatched fallback policy", async () => {
    const policyConnection = new ProductConnection();
    const policyHandle = await verifyConversationProductPostgresHandle(
      policyConnection,
    );
    const policyProduct = createProduct(policyConnection, policyHandle);
    expect((await preparedRejection(policyProduct.admitOrdinaryFallback({
      authority, authenticated: ordinaryUpdateAuthenticated(undefined, 2),
    }), "authorization_required")).message).toContain("authority is incomplete");

    const staleConnection = new ProductConnection();
    const staleHandle = await verifyConversationProductPostgresHandle(
      staleConnection,
    );
    const staleProduct = createProduct(staleConnection, staleHandle);
    const authenticated = ordinaryUpdateAuthenticated();
    const admission = await staleProduct.admitOrdinaryFallback({ authority,
      authenticated });
    staleConnection.contentRevision = 2;
    expect((await preparedRejection(
      staleProduct.publishOrdinaryFallbackIntent({ authority, admission,
        embedding }), "stale_revision",
    )).message).toContain("publication is stale");
  });

  test("edits an existing revision-zero ordinary Memory instead of creating", async () => {
    const connection = new ProductConnection();
    connection.contentRevision = 0;
    connection.objectId = null;
    connection.fingerprint = null;
    const handle = await verifyConversationProductPostgresHandle(connection);
    const product = createProduct(connection, handle);
    const authenticated = ordinaryUpdateAuthenticated(undefined, 1, 0);
    const admission = await product.admitOrdinaryFallback({ authority,
      authenticated });
    connection.calls.length = 0;
    const projection = await product.publishOrdinaryFallbackIntent({ authority,
      admission, embedding });
    expect(projection).toMatchObject({ memoryId: MEMORY_ID, contentRevision: 1,
      cryptoAccessRevision: 0 });
    expect(connection.calls.some((call) =>
      normalizedSql(call.statement).includes("INSERT INTO MEMORIES")
    )).toBeFalse();
    expect(connection.calls.some((call) =>
      normalizedSql(call.statement).includes("UPDATE MEMORIES SET")
    )).toBeTrue();
    expect(connection.operation?.humanProductOutcome).toMatchObject({
      memoryId: MEMORY_ID, contentRevision: 1,
    });
  });

  test("does not admit an update replay through an older create allocation", async () => {
    const connection = new ProductConnection();
    const handle = await verifyConversationProductPostgresHandle(connection);
    const product = createProduct(connection, handle);
    const updateDigest = new Uint8Array(32).fill(0x22);
    const olderCreateDigest = new Uint8Array(32).fill(0x23);
    connection.operation = {
      requestDigest: updateDigest,
      expectedAccessRevision: 0,
      expectedContentRevision: 1,
      resultContentRevision: 2,
      disposition: "active",
      createdAt: connection.createdAt,
      completion: "pending",
    };
    connection.allocation = {
      allocationDigest: humanMemoryAllocationRequestDigest({
        operationRequestDigest: olderCreateDigest,
      }),
      fingerprint: fingerprintRequiredMemoryNamespaces(NAMESPACE_IDS),
      objectId: deriveMemoryCryptoObjectIdV1({
        memoryId: MEMORY_ID,
        contentRevision: 1,
      }),
    };
    const updateAuthorityWithCreateFields = {
      ...authority,
      memoryMode: "namespace" as const,
      scopeId: null,
      originWritableNamespaceId: null,
    };

    expect(await product.lookupReservation({
      authority: updateAuthorityWithCreateFields,
      operationId: OPERATION_ID,
      memoryId: MEMORY_ID,
      operationRequestDigest: olderCreateDigest,
    })).toBeNull();
  });

  test("atomically publishes the admitted ordinary fallback and replays its durable outcome", async () => {
    const connection = new ProductConnection();
    const handle = await verifyConversationProductPostgresHandle(connection);
    const product = createProduct(connection, handle);
    const requestDigest = new Uint8Array(32).fill(0x25);
    const certificate = await product.allocate({ authority, prepared: prepared(),
      operationRequestDigest: requestDigest });
    const result = await product.publishOrdinaryFallback({ authority, certificate,
      embedding, authored, preparedAuthority, reason: "encryption_pending" });
    expect(result).toMatchObject({ memoryId: MEMORY_ID, contentRevision: 2,
      cryptoAccessRevision: 0 });
    expect(connection.objectId).toBeNull();
    expect(connection.fingerprint).toBeNull();
    expect(connection.priorRevisionSuperseded).toBeTrue();
    expect(connection.operation).toMatchObject({ completion: "ordinary_fallback",
      disposition: "complete" });
    const replay = await product.lookupReservation({ authority,
      operationId: OPERATION_ID, memoryId: MEMORY_ID,
      operationRequestDigest: requestDigest });
    expect(replay?.completedProjection).toMatchObject({ memoryId: MEMORY_ID,
      contentRevision: 2, cryptoAccessRevision: 0 });
    expect(await product.inspect({ authority, prepared: prepared(),
      operationRequestDigest: requestDigest })).toMatchObject({
      kind: "replay", alreadyPublished: true,
      ordinaryFallbackReason: "encryption_pending",
    });
  });

  test("survives crypto failure/restart, validates exact replay, and publishes", async () => {
    const connection = new ProductConnection();
    const handle = await verifyConversationProductPostgresHandle(connection);
    const product = createProduct(connection, handle);
    const requestDigest = new Uint8Array(32).fill(0x24);
    expect(await product.inspect({
      authority,
      prepared: prepared(),
      operationRequestDigest: requestDigest,
    })).toEqual({ kind: "new", expectedAccessRevision: 0 });
    const certificate = await product.allocate({
      authority,
      prepared: prepared(),
      operationRequestDigest: requestDigest,
    });
    expect(connection.contentRevision).toBe(1);
    expect(connection.objectId).toBe(deriveMemoryCryptoObjectIdV1({
      memoryId: MEMORY_ID, contentRevision: 1,
    }));
    expect(connection.priorRevisionSuperseded).toBeFalse();
    expect(certificate.allocationRequestDigest).toEqual(
      humanMemoryAllocationRequestDigest({
        operationRequestDigest: requestDigest,
      }),
    );

    // Simulated crypto failure/response loss: a fresh adapter recovers the
    // durable allocation and actual provenance without another provider call.
    const publicationEvents: string[] = [];
    const restarted = createProduct(connection, handle, { publicationEvents });
    const replay = await restarted.inspect({
      authority,
      prepared: prepared(),
      operationRequestDigest: requestDigest,
    });
    expect(replay.kind).toBe("replay");
    expect(await restarted.authorizeCurrent(authority, certificate)).toBeTrue();
    expect((await restarted.publish({ authority, certificate, embedding,
      authored, preparedAuthority }))).toMatchObject({
      memoryId: MEMORY_ID,
      contentRevision: 2,
      requiredNamespaceIds: [...NAMESPACE_IDS],
    });
    expect(connection.operation?.completion).toBe("complete");
    expect(connection.objectId).toBe(certificate.objectId);
    expect(connection.priorRevisionSuperseded).toBeTrue();
    expect(publicationEvents).toEqual([
      "restricted-transaction-open",
      "product-fence",
      "crypto-authority-locked",
      "product-transaction-committed",
    ]);
    const replayInput = {
      authority,
      operationId: OPERATION_ID,
      memoryId: MEMORY_ID,
      operationRequestDigest: requestDigest,
    };
    const originalOutcome = (await restarted.lookupReservation(replayInput))
      ?.completedProjection;
    expect(originalOutcome).toMatchObject({
      memoryId: MEMORY_ID,
      contentRevision: 2,
      cryptoAccessRevision: 0,
      requiredNamespaceIds: [...NAMESPACE_IDS],
    });
    connection.contentRevision = 3;
    connection.accessRevision = 4;
    connection.namespaceIds = [NAMESPACE_IDS[0]];
    expect((await restarted.lookupReservation(replayInput))?.completedProjection)
      .toEqual(originalOutcome);
    connection.exists = false;
    expect((await restarted.lookupReservation(replayInput))?.completedProjection)
      .toEqual(originalOutcome);
    expect(await restarted.lookupReservation({
      ...replayInput,
      operationRequestDigest: new Uint8Array(32).fill(0x7f),
    })).toBeNull();
    expect(await restarted.lookupReservation({
      ...replayInput,
      authority: { ...authority, mutableNamespaceIds: [NAMESPACE_IDS[0]] },
    })).toBeNull();
    connection.exists = true;
    connection.contentRevision = 2;
    connection.accessRevision = 0;
    connection.namespaceIds = NAMESPACE_IDS;
    const superseded = connection.calls.find((call) =>
      normalizedSql(call.statement).includes("UPDATE MEMORY_CRYPTO_REVISIONS")
      && call.parameters.includes("superseded")
    );
    expect(superseded?.parameters).toContain(MEMORY_ID);
    expect(superseded?.parameters).toContain(1);
    expect(superseded?.parameters).toContain("complete");
    expect(superseded?.parameters).toContain("mapped");
    const stagedUpdate = connection.calls.find((call) =>
      normalizedSql(call.statement).includes("UPDATE MEMORIES")
      && normalizedSql(call.statement).includes("CONTENT_REVISION")
    );
    expect(stagedUpdate?.parameters).toContain("unmapped");
    expect(stagedUpdate?.statement).not.toContain("content =");
    expect(stagedUpdate?.statement).not.toContain("type =");
    const mappingUpdate = connection.calls.find((call) =>
      normalizedSql(call.statement).includes("UPDATE MEMORIES")
      && normalizedSql(call.statement).includes("CRYPTO_OBJECT_ID")
      && call.parameters.includes(certificate.objectId)
    );
    expect(mappingUpdate?.parameters).toContain("verified");
    const parameters = connection.calls.flatMap((call) => call.parameters)
      .filter((value): value is string => typeof value === "string");
    expect(parameters).not.toContain(SIGNED_PLAINTEXT);
    expect(parameters).not.toContain(SIGNED_BYTES);
  });

  test("rejects digest/provenance conflicts, concurrent operations, and stale authority", async () => {
    const connection = new ProductConnection();
    const handle = await verifyConversationProductPostgresHandle(connection);
    const product = createProduct(connection, handle);
    const requestDigest = new Uint8Array(32).fill(0x25);
    await product.allocate({
      authority,
      prepared: prepared(),
      operationRequestDigest: requestDigest,
    });
    expect((await preparedRejection(product.allocate({
      authority,
      prepared: prepared(),
      operationRequestDigest: requestDigest,
    }), "stale_revision")).message).toContain("raced a replay");
    expect((await preparedRejection(product.inspect({
      authority,
      prepared: prepared(),
      operationRequestDigest: new Uint8Array(32).fill(0x26),
    }), "integrity_failure")).message).toContain("replay conflicts");
    connection.embeddingModel = "substituted-model";
    expect((await product.inspect({
      authority,
      prepared: prepared(),
      operationRequestDigest: requestDigest,
    })).kind).toBe("replay");
    connection.embeddingModel = embedding.canonicalModel;
    connection.namespaceIds = [NAMESPACE_IDS[0]];
    expect(await rejection(product.inspect({
      authority,
      prepared: prepared(),
      operationRequestDigest: requestDigest,
    }))).toBeInstanceOf(Error);
    connection.namespaceIds = NAMESPACE_IDS;
    expect((await product.inspect({
      authority: { ...authority, writableNamespaceIds: [] },
      prepared: prepared(),
      operationRequestDigest: requestDigest,
    })).kind).toBe("replay");
    expect((await preparedRejection(product.inspect({
      authority: { ...authority, mutableNamespaceIds: [NAMESPACE_IDS[0]] },
      prepared: prepared(),
      operationRequestDigest: requestDigest,
    }), "authorization_required")).message).toContain("authority is incomplete");
    connection.scopeOrigins = ["scope"];
    connection.scopeOriginNamespaceId = null;
    expect((await rejection(product.inspect({
      authority,
      prepared: prepared(),
      operationRequestDigest: requestDigest,
    }))).message).toContain("missing its exact writable Namespace");
  });

  test("rejects stale source content, object, and allocated access coordinates", async () => {
    const staleContentConnection = new ProductConnection();
    staleContentConnection.contentRevision = 0;
    const staleContentHandle = await verifyConversationProductPostgresHandle(staleContentConnection);
    const staleContent = createProduct(staleContentConnection, staleContentHandle);
    expect((await preparedRejection(staleContent.inspect({
      authority,
      prepared: prepared(),
      operationRequestDigest: new Uint8Array(32).fill(0x31),
    }), "stale_revision")).message).toContain("product revision is stale");

    const staleObjectConnection = new ProductConnection();
    staleObjectConnection.objectId = "82000000-0000-4000-8000-000000000077";
    const staleObjectHandle = await verifyConversationProductPostgresHandle(staleObjectConnection);
    const staleObject = createProduct(staleObjectConnection, staleObjectHandle);
    expect((await rejection(staleObject.inspect({
      authority,
      prepared: prepared(),
      operationRequestDigest: new Uint8Array(32).fill(0x32),
    }))).message).toContain("product revision is stale");

    const staleAccessConnection = new ProductConnection();
    staleAccessConnection.accessRevision = 7;
    const staleAccessHandle = await verifyConversationProductPostgresHandle(staleAccessConnection);
    const staleAccess = createProduct(staleAccessConnection, staleAccessHandle);
    const requestDigest = new Uint8Array(32).fill(0x33);
    const certificate = await staleAccess.allocate({
      authority,
      prepared: prepared(),
      operationRequestDigest: requestDigest,
    });
    expect((await preparedRejection(staleAccess.publish({
      authority,
      certificate,
      embedding,
      authored: { ...authored, formatVersion: 2 } as never,
      preparedAuthority,
    }), "integrity_failure")).message).toContain("payload is invalid");
    expect(certificate.expectedAccessRevision).toBe(7);
    staleAccessConnection.accessRevision = 8;
    expect(await staleAccess.authorizeCurrent(authority, certificate)).toBeFalse();
    staleAccessConnection.accessRevision = 7;
    staleAccessConnection.operation!.disposition = "blocked";
    expect(await staleAccess.authorizeCurrent(authority, certificate)).toBeFalse();
    staleAccessConnection.operation!.disposition = "active";
    staleAccessConnection.operation!.expectedAccessRevision = 8;
    expect(await staleAccess.authorizeCurrent(authority, certificate)).toBeFalse();
  });
});

describe("Postgres Human Memory product create", () => {
  test("publishes an exact signed ordinary create without crypto allocation", async () => {
    const connection = new ProductConnection();
    connection.exists = false;
    const handle = await verifyConversationProductPostgresHandle(connection);
    const product = createProduct(connection, handle, {
      createMemoryId: () => MEMORY_ID,
      createOperationId: () => "human-memory:ordinary:create:1",
    });
    const createAuthority = { userId: authority.userId,
      memoryMode: "namespace" as const, scopeId: null,
      originWritableNamespaceId: null,
      mutableNamespaceIds: [NAMESPACE_IDS[0]],
      writableNamespaceIds: [NAMESPACE_IDS[0]] };
    expect(() => product.reserveCreatePlan({
      authority: { ...createAuthority, writableNamespaceIds: [] },
      now: Date.parse("2026-08-10T00:00:00.000Z"),
    })).toThrow("create authority is incomplete");
    const plan = await product.reserveCreatePlan({ authority: createAuthority,
      now: Date.parse("2026-08-10T00:00:00.000Z") });
    if (plan.issuedAt === undefined) throw new Error("Missing create plan issue time");
    const authenticated: AuthenticatedHumanMemoryOrdinaryFallbackRequestV1 =
      Object.freeze({ requestDigest: new Uint8Array(32).fill(0x62),
      request: Object.freeze({ formatVersion: 1 as const,
        purpose: "memory.ordinary_fallback.create" as const,
        reason: "target_encryption_not_ready" as const,
        operationId: plan.operationId, memoryId: plan.memoryId,
        expectedContentRevision: 0, nextContentRevision: 1,
        expectedCryptoAccessRevision: 0,
        requiredNamespaceIds: [...plan.requiredNamespaceIds], type: "fact",
        content: "created without ciphertext", requestedProvider: "openai" as const,
        requestedModel: "text-embedding-3-small", dimensions: 1536 as const,
        processorContractVersion: 1 as const, policyRevision: 1,
        subjectHumanId: "human:1", committerDeviceId: "human-device:1",
        committerDeviceSigningKeyGeneration: 1, hostAuthorizationRevision: 1,
        planIssuedAt: plan.issuedAt, planDeadlineAt: plan.deadlineAt,
        issuedAt: plan.issuedAt, deadlineAt: plan.deadlineAt,
        signature: new Uint8Array(64) }) });
    const admission = await product.admitOrdinaryFallback({
      authority: createAuthority, authenticated });
    connection.operation!.foregroundRequiredNamespaceIds = [NAMESPACE_IDS[0]];
    expect(connection.operation?.requestDigest).not.toEqual(
      authenticated.requestDigest,
    );
    expect(connection.allocation).toBeNull();
    expect(await product.publishOrdinaryFallbackIntent({
      authority: createAuthority, admission, embedding,
    })).toMatchObject({ memoryId: MEMORY_ID, contentRevision: 1,
      cryptoAccessRevision: 0 });
    expect(connection.allocation).toBeNull();
  });

  test("does not classify malformed stored timestamps as product integrity", async () => {
    const connection = new ProductConnection();
    connection.operation = {
      requestDigest: new Uint8Array(32),
      expectedAccessRevision: 0,
      expectedContentRevision: 0,
      resultContentRevision: 1,
      disposition: "blocked",
      createdAt: new Date(Number.NaN),
      completion: "pending",
    };
    const handle = await verifyConversationProductPostgresHandle(connection);
    const product = createProduct(connection, handle);
    const error = await rejection(product.inspectCreate({
      authority: {
        userId: authority.userId,
        memoryMode: "namespace",
        scopeId: null,
        originWritableNamespaceId: null,
        mutableNamespaceIds: [NAMESPACE_IDS[0]],
        writableNamespaceIds: [NAMESPACE_IDS[0]],
      },
      prepared: preparedCreate("human-memory:create:malformed-row"),
      operationRequestDigest: new Uint8Array(32),
      now: Date.parse("2026-08-10T00:00:01.000Z"),
    }));
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(HumanMemoryPreparedRouteError);
    expect(error.message).toContain("created_at must be a timestamp");
  });

  test.each([false, true])("reserves and publishes zero-to-one with string timestamps=%s", async (timestampsAsStrings) => {
    const connection = new ProductConnection();
    connection.timestampsAsStrings = timestampsAsStrings;
    connection.exists = false;
    const handle = await verifyConversationProductPostgresHandle(connection);
    const operationId = "human-memory:create:1";
    const product = createProduct(connection, handle, {
      createMemoryId: () => MEMORY_ID,
      createOperationId: () => operationId,
      createPlanTtlMs: 30_000,
    });
    const createAuthority = {
      userId: authority.userId,
      memoryMode: "namespace" as const,
      scopeId: null,
      originWritableNamespaceId: null,
      mutableNamespaceIds: [NAMESPACE_IDS[0]],
      writableNamespaceIds: [NAMESPACE_IDS[0]],
    };
    const plan = await product.reserveCreatePlan({
      authority: createAuthority,
      now: Date.parse("2026-08-10T00:00:00.000Z"),
    });
    expect(plan).toEqual({
      dtoVersion: 1,
      memoryId: MEMORY_ID,
      operationId,
      expectedContentRevision: 0,
      nextContentRevision: 1,
      productAuthority: { mode: "namespace" },
      requiredNamespaceIds: [NAMESPACE_IDS[0]],
      issuedAt: Date.parse("2026-08-10T00:00:00.000Z"),
      deadlineAt: Date.parse("2026-08-10T00:00:30.000Z"),
    });
    expect(connection.exists).toBeFalse();
    expect(connection.operation?.disposition).toBe("blocked");
    const reservation = connection.calls.find((call) =>
      normalizedSql(call.statement).includes(
        "INSERT INTO MEMORY_CRYPTO_OPERATIONS",
      )
    );
    expect(reservation?.parameters).toContain("pending");
    expect(reservation?.parameters).toContain("blocked");
    expect(reservation?.parameters).toContain(null);
    expect(connection.allocation).toBeNull();
    const immutablePlanDigest = connection.operation!.requestDigest.slice();
    expect(connection.calls.some((call) =>
      normalizedSql(call.statement).includes("INSERT INTO MEMORIES")
    )).toBeFalse();
    const requestDigest = new Uint8Array(32).fill(0x51);
    expect(await product.inspectCreate({
      authority: createAuthority,
      prepared: preparedCreate(operationId),
      operationRequestDigest: requestDigest,
      now: Date.parse("2026-08-10T00:00:01.000Z"),
    })).toEqual({
      kind: "new",
      expectedAccessRevision: 0,
      planIssuedAt: Date.parse("2026-08-10T00:00:00.000Z"),
      planDeadlineAt: Date.parse("2026-08-10T00:00:30.000Z"),
    });
    const certificate = await product.allocateCreate({
      authority: createAuthority,
      prepared: preparedCreate(operationId),
      operationRequestDigest: requestDigest,
      now: Date.parse("2026-08-10T00:00:01.000Z"),
    });
    expect(connection.operation?.requestDigest).toEqual(immutablePlanDigest);
    expect(connection.exists).toBeFalse();
    expect(await product.lookupReservation({ authority: createAuthority,
      operationId, memoryId: MEMORY_ID,
      operationRequestDigest: new Uint8Array(32).fill(0x52) })).toBeNull();
    expect(await product.lookupReservation({ authority: createAuthority,
      operationId, memoryId: MEMORY_ID,
      operationRequestDigest: requestDigest })).not.toBeNull();
    expect((await rejection(product.inspectCreate({
      authority: createAuthority,
      prepared: preparedCreate(operationId),
      operationRequestDigest: new Uint8Array(32).fill(0x52),
      now: Date.parse("2026-08-10T00:00:02.000Z"),
    }))).message).toContain("allocation conflicts");
    const replay = await product.inspectCreate({
      authority: createAuthority,
      prepared: preparedCreate(operationId),
      operationRequestDigest: requestDigest,
      now: Date.parse("2026-08-10T00:00:02.000Z"),
    });
    expect(replay.kind).toBe("replay");
    expect(await product.authorizeCurrent(createAuthority, certificate)).toBeTrue();
    expect(await product.publish({ authority: createAuthority, certificate,
      embedding, authored, preparedAuthority: { ...preparedAuthority,
        purpose: "authenticate-human-memory-prepared-create",
        operationId, expectedContentRevision: 0, nextContentRevision: 1,
        objectId: certificate.objectId } })).toMatchObject({
      memoryId: MEMORY_ID,
      contentRevision: 1,
      cryptoAccessRevision: 0,
      requiredNamespaceIds: [NAMESPACE_IDS[0]],
    });
    expect(connection.operation?.completion).toBe("complete");
    expect(connection.objectId).toBe(certificate.objectId);
    const textParameters = connection.calls.flatMap((call) => call.parameters)
      .filter((value): value is string => typeof value === "string");
    expect(textParameters).not.toContain(SIGNED_PLAINTEXT);
    expect(textParameters).not.toContain(SIGNED_BYTES);
  });

  test("binds scope plans to the exact inherited origin and rejects expired or widened authority", async () => {
    const connection = new ProductConnection();
    connection.exists = false;
    const scopeHandle = await verifyConversationProductPostgresHandle(connection);
    const product = createProduct(connection, scopeHandle, {
        createMemoryId: () => MEMORY_ID,
        createOperationId: () => "human-memory:create:scope",
        createPlanTtlMs: 30_000,
      });
    const scopeAuthority = {
      userId: authority.userId,
      memoryMode: "scope" as const,
      scopeId: "82000000-0000-4000-8000-000000000030",
      originWritableNamespaceId: NAMESPACE_IDS[0],
      mutableNamespaceIds: [] as string[],
      writableNamespaceIds: [] as string[],
    };
    const plan = await product.reserveCreatePlan({
      authority: scopeAuthority,
      now: Date.parse("2026-08-10T00:00:00.000Z"),
    });
    expect(plan.productAuthority).toEqual({
      mode: "scope",
      scopeId: scopeAuthority.scopeId,
      originWritableNamespaceId: NAMESPACE_IDS[0],
    });
    expect(plan.requiredNamespaceIds).toEqual([NAMESPACE_IDS[0]]);
    expect((await rejection(product.inspectCreate({
      authority: scopeAuthority,
      prepared: preparedCreate(plan.operationId),
      operationRequestDigest: new Uint8Array(32),
      now: Date.parse("2026-08-10T00:00:31.000Z"),
    }))).message).toContain("expired");
    expect((await rejection(product.inspectCreate({
      authority: {
        ...scopeAuthority,
        originWritableNamespaceId: NAMESPACE_IDS[1],
      },
      prepared: preparedCreate(plan.operationId),
      operationRequestDigest: new Uint8Array(32),
      now: Date.parse("2026-08-10T00:00:01.000Z"),
    }))).message).toContain("authority is invalid");

    const requestDigest = new Uint8Array(32).fill(0x61);
    const certificate = await product.allocateCreate({
      authority: scopeAuthority,
      prepared: preparedCreate(plan.operationId),
      operationRequestDigest: requestDigest,
      now: Date.parse("2026-08-10T00:00:01.000Z"),
    });
    expect(certificate.expectedAccessRevision).toBe(0);
    expect(connection.scopeOrigins).toEqual([]);
    expect(connection.exists).toBeFalse();

    const closingConnection = new ProductConnection();
    closingConnection.exists = false;
    closingConnection.scopeLifecycleState = "closing";
    const closingHandle = await verifyConversationProductPostgresHandle(closingConnection);
    const closing = createProduct(closingConnection, closingHandle, {
        createMemoryId: () => MEMORY_ID,
        createOperationId: () => "human-memory:create:scope-closing",
        createPlanTtlMs: 30_000,
      });
    const closingPlan = await closing.reserveCreatePlan({
      authority: scopeAuthority,
      now: Date.parse("2026-08-10T00:00:00.000Z"),
    });
    expect((await closing.allocateCreate({
      authority: scopeAuthority,
      prepared: preparedCreate(closingPlan.operationId),
      operationRequestDigest: requestDigest,
      now: Date.parse("2026-08-10T00:00:01.000Z"),
    }))).toMatchObject({ expectedContentRevision: 0, nextContentRevision: 1 });
    expect(closingConnection.exists).toBeFalse();
  });
});
