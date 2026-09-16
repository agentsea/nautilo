import { describe, expect, test } from "bun:test";

import { fingerprintRequiredMemoryNamespaces } from "../../src/memory/memory-repository.ts";
import {
  PostgresHumanMemoryExactAccessProduct,
  assertHumanMemoryExactAccessReplayAdmission,
  fingerprintHumanMemoryExactAccessTarget,
  type HumanMemoryExactAccessCryptoReceipt,
} from "../../src/server/memory/postgres-human-memory-exact-access-product.ts";
import {
  bindConversationProductCanonicalTransactionRunner,
  verifyConversationProductPostgresHandle,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresConnection,
  type ConversationProductPostgresScalar,
} from "../../src/server/message/postgres-conversation-product-store.ts";
import type { CanonicalTranscriptTx } from "@nautilo/trust";

const USER = "11000000-0000-4000-8000-000000000001";
const MEMORY = "22000000-0000-4000-8000-000000000001";
const ALICE = "33000000-0000-4000-8000-000000000001";
const BOB = "33000000-0000-4000-8000-000000000002";
const CHARLIE = "33000000-0000-4000-8000-000000000003";
const OBJECT = "memory:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SIGNED_REQUEST_DIGEST = new Uint8Array(32).fill(0x44);

function publicationAuthority(input: Readonly<{
  operationId: string;
  expectedContentRevision: number;
  expectedAccessRevision: number;
  resultAccessRevision: number;
}>) {
  return {
    purpose: "persist-human-memory-native-access-update" as const,
    operationId: input.operationId, objectId: OBJECT,
    payloadHash: new Uint8Array(32),
    expectedContentRevision: input.expectedContentRevision,
    currentAccessRevision: input.expectedAccessRevision,
    currentManifestHash: new Uint8Array(32),
    nextAccessRevision: input.resultAccessRevision,
    nextManifestHash: new Uint8Array(32), currentEntries: [], targetEntries: [],
    currentAuthorityEntries: [], targetAuthorityEntries: [],
    subjectHumanId: "human-1",
    committerDeviceId: "device-alice", hostAuthorizationRevision: 1,
  };
}

type Operation = {
  operationId: string;
  anchorNamespaceId: string;
  digest: Uint8Array;
  expectedAccessRevision: number;
  targetFingerprint: Uint8Array;
  completion: "pending" | "complete" | "ordinary_fallback";
  disposition: "active" | "complete";
  ordinaryFallbackReason?: "encryption_pending" | "target_encryption_not_ready";
};

class ProductConnection implements ConversationProductPostgresConnection {
  namespaceIds = [ALICE, BOB];
  accessRevision = 2;
  mappingState: "verified" | "stale" | "unmapped" = "verified";
  fingerprint = fingerprintRequiredMemoryNamespaces(this.namespaceIds);
  operation: Operation | null = null;
  readonly calls: Array<Readonly<{
    statement: string;
    parameters: readonly ConversationProductPostgresScalar[];
  }>> = [];

  query<Row extends ConversationProductDatabaseRow = ConversationProductDatabaseRow>(
    statement: string,
  ): Promise<readonly Row[]> {
    if (statement.includes("current_user::text")) {
      return Promise.resolve([{ current_user: "nautilo", session_user: "nautilo" }] as unknown as Row[]);
    }
    throw new Error(`outside transaction: ${statement}`);
  }

  transaction<Result>(callback: (connection: this) => Promise<Result>): Promise<Result> {
    return callback(this);
  }

  async run<Row extends ConversationProductDatabaseRow = ConversationProductDatabaseRow>(
    statement: string,
    parameters: readonly ConversationProductPostgresScalar[] = [],
  ): Promise<readonly Row[]> {
    this.calls.push({ statement, parameters });
    const normalized = statement.toLowerCase();
    if (statement.includes("app_current_user_id")) {
      return [{ current_user_id: USER, current_agent_id: null }] as unknown as Row[];
    }
    if (
      statement.includes("exact-access:replay-lookup")
      || normalized.includes('from "memory_crypto_operations"')
        && !normalized.includes("for update")
    ) {
      if (this.operation === null) return [];
      return [{
        operation_id: this.operation.operationId,
        memory_id: MEMORY,
        operation_type: "access",
        anchor_namespace_id: this.operation.anchorNamespaceId,
        expected_content_revision: 4,
        result_access_revision: this.operation.expectedAccessRevision + 1,
        expected_access_revision: this.operation.expectedAccessRevision,
        target_required_namespace_fingerprint: this.operation.targetFingerprint,
        request_digest: this.operation.digest,
        completion: this.operation.completion,
        disposition: this.operation.disposition,
        ordinary_fallback_reason: this.operation.ordinaryFallbackReason ?? null,
      }] as unknown as Row[];
    }
    if (statement.includes("exact-access:operation")
      || statement.includes("exact-access:fallback-operation")) {
      if (this.operation === null) return [];
      return [{
        operation_id: this.operation.operationId,
        memory_id: MEMORY,
        anchor_namespace_id: this.operation.anchorNamespaceId,
        operation_type: "access",
        expected_content_revision: 4,
        result_content_revision: null,
        expected_access_revision: this.operation.expectedAccessRevision,
        result_access_revision: this.operation.expectedAccessRevision + 1,
        request_digest: this.operation.digest,
        target_required_namespace_fingerprint: this.operation.targetFingerprint,
        completion: this.operation.completion,
        disposition: this.operation.disposition,
        ordinary_fallback_reason: this.operation.ordinaryFallbackReason ?? null,
      }] as unknown as Row[];
    }
    if (statement.includes("exact-access:lock-product")) {
      return [{
        memory_id: MEMORY,
        content_revision: 4,
        crypto_access_revision: this.accessRevision,
        crypto_mapping_state: this.mappingState,
        crypto_object_id: OBJECT,
        crypto_required_namespace_fingerprint: this.fingerprint,
        namespace_ids: JSON.stringify(this.namespaceIds),
        scope_count: 0,
      }] as unknown as Row[];
    }
    if (
      statement.includes("exact-access:reserve")
      || normalized.startsWith('insert into "memory_crypto_operations"')
    ) {
      this.operation = {
        operationId: parameters[0] as string,
        anchorNamespaceId: parameters[2] as string,
        digest: (parameters[8] as Uint8Array).slice(),
        expectedAccessRevision: parameters[6] as number,
        targetFingerprint: (parameters[9] as Uint8Array).slice(),
        completion: "pending",
        disposition: "active",
      };
      return [];
    }
    if (
      normalized.startsWith('delete from "memories"')
    ) {
      this.namespaceIds = [];
      return [{ id: MEMORY }] as unknown as Row[];
    }
    if (
      statement.includes("exact-access:delete-edges")
      || normalized.startsWith('delete from "memory_namespaces"')
    ) {
      const removed = parameters[1] as string;
      this.namespaceIds = this.namespaceIds.filter((id) => id !== removed);
      this.mappingState = "stale";
      return [{ namespace_id: removed }] as unknown as Row[];
    }
    if (
      statement.includes("exact-access:add-edges")
      || normalized.startsWith('insert into "memory_namespaces"')
    ) {
      const added = parameters[1] as string;
      this.namespaceIds = [...this.namespaceIds, added].sort();
      this.mappingState = "stale";
      return [{ namespace_id: added }] as unknown as Row[];
    }
    if (
      statement.includes("exact-access:commit-product")
      || normalized.startsWith('update "memories"')
    ) {
      if (normalized.startsWith('update "memories"') && parameters.includes("unmapped")) {
        this.mappingState = "unmapped";
        this.fingerprint = new Uint8Array(32);
        return [{ id: MEMORY }] as unknown as Row[];
      }
      if (normalized.startsWith('update "memories"')) {
        if (this.mappingState !== "stale" || !parameters.includes("verified")) return [];
        this.mappingState = "verified";
        this.accessRevision = parameters.find((value) => typeof value === "number") as number;
        const fingerprint = parameters.find((value) => value instanceof Uint8Array);
        this.fingerprint = (fingerprint as Uint8Array).slice();
      } else {
        this.accessRevision = parameters[2] as number;
        this.fingerprint = (parameters[3] as Uint8Array).slice();
      }
      return [{ id: MEMORY }] as unknown as Row[];
    }
    if (
      statement.includes("exact-access:complete-operation")
      || normalized.startsWith('update "memory_crypto_operations"')
    ) {
      if (this.operation === null) return [];
      this.operation.completion = "complete";
      this.operation.disposition = "complete";
      if (parameters.includes("ordinary_fallback")) {
        this.operation.completion = "ordinary_fallback";
        this.operation.ordinaryFallbackReason = parameters.includes(
          "target_encryption_not_ready",
        ) ? "target_encryption_not_ready" : "encryption_pending";
      }
      return [{ operation_id: this.operation.operationId }] as unknown as Row[];
    }
    if (normalized.startsWith('update "memory_crypto_revisions"')) {
      return [{ sequence: 1 }] as unknown as Row[];
    }
    throw new Error(`Unexpected SQL: ${statement}`);
  }
}

function wireConnection(connection: ProductConnection): ConversationProductPostgresConnection {
  return {
    query: connection.query.bind(connection),
    transaction: (callback) => connection.transaction(async () => callback({
      query: connection.run.bind(connection),
    })),
  };
}

async function fixture() {
  const connection = new ProductConnection();
  const handle = await verifyConversationProductPostgresHandle(wireConnection(connection));
  const canonicalRunner = bindConversationProductCanonicalTransactionRunner(handle, {
    transaction: async (callback) => connection.transaction(async () => callback({
      execute: async () => [{ current_user: "nautilo", session_user: "nautilo" }],
    } as unknown as CanonicalTranscriptTx, { query: connection.run.bind(connection) })),
  });
  let targetReady = true;
  return {
    connection,
    setTargetReady(value: boolean) {
      targetReady = value;
    },
    product: new PostgresHumanMemoryExactAccessProduct(handle, {
      canonicalRunner,
      publication: {
        fence: async () => undefined,
        allowOrdinaryFallback: true,
        withLocks: async (_input, publish) => {
          if (!targetReady) throw new Error("Human Memory exact-access authority became stale");
          return publish(async () => undefined);
        },
      },
    }),
  };
}

async function rejectedError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new TypeError("Expected an Error rejection");
  }
  throw new Error("Expected a rejected promise");
}

const authority = {
  userId: USER,
  subjectHumanId: "human-1",
  actorId: "actor-1",
  agentId: null,
  readableNamespaceIds: [BOB],
  mutableNamespaceIds: [BOB],
  writableNamespaceIds: [BOB, CHARLIE],
} as const;

describe("Postgres exact Human Memory access product lifecycle", () => {
  test("uses the canonical active fingerprint and defines the empty target", () => {
    expect(fingerprintHumanMemoryExactAccessTarget([ALICE, BOB])).toEqual(
      fingerprintRequiredMemoryNamespaces([ALICE, BOB]),
    );
    expect(fingerprintHumanMemoryExactAccessTarget([])).toHaveLength(32);
  });

  test("unchanged exact target creates no operation receipt", async () => {
    const { connection, product } = await fixture();
    expect(await product.plan({
      authority,
      operationId: "access:no-op",
      memoryId: MEMORY,
      target: { kind: "replace_exact", namespaceIds: [BOB, ALICE] },
    })).toMatchObject({ status: "unchanged", cryptoAccessRevision: 2 });
    expect(connection.operation).toBeNull();
    expect(connection.calls.some(({ statement }) => statement.includes("exact-access:reserve"))).toBe(false);
  });

  test("authorized-view deletion preserves inaccessible Alice edge", async () => {
    const { product } = await fixture();
    const plan = await product.plan({
      authority,
      operationId: "access:bob-delete",
      memoryId: MEMORY,
      target: { kind: "delete_authorized_view" },
    });
    expect(plan).toMatchObject({
      status: "prepared",
      currentNamespaceIds: [ALICE, BOB],
      targetNamespaceIds: [ALICE],
      addedNamespaceIds: [],
      removedNamespaceIds: [BOB],
      anchorNamespaceId: BOB,
    });
  });

  test("does not apply the per-object wire bound to the Human authority inventory", async () => {
    const { product } = await fixture();
    const inventory = Array.from({ length: 300 }, (_, index) =>
      `44000000-0000-4000-8000-${index.toString().padStart(12, "0")}`);
    const plan = await product.plan({
      authority: { ...authority,
        readableNamespaceIds: [...inventory, BOB],
        mutableNamespaceIds: [...inventory, BOB],
        writableNamespaceIds: [...inventory, BOB, CHARLIE] },
      operationId: "access:large-authority",
      memoryId: MEMORY,
      target: { kind: "replace_exact", namespaceIds: [ALICE, BOB, CHARLIE] },
    });
    expect(plan).toMatchObject({ status: "prepared",
      targetNamespaceIds: [ALICE, BOB, CHARLIE] });
  });

  test("hard-deletes the product when authorized-view removal leaves no edge", async () => {
    const { connection, product } = await fixture();
    connection.namespaceIds = [BOB];
    connection.fingerprint = fingerprintHumanMemoryExactAccessTarget([BOB]);
    const plan = await product.plan({
      authority,
      operationId: "access:delete-last-view",
      memoryId: MEMORY,
      target: { kind: "delete_authorized_view" },
    });
    if (plan.status !== "prepared") throw new Error("expected prepared plan");
    expect(plan.targetNamespaceIds).toEqual([]);
    await product.reserve({ authority, plan, signedRequestDigest: SIGNED_REQUEST_DIGEST });
    expect(await product.commit({
      authority,
      plan,
      receipt: {
        operationId: plan.operationId,
        memoryId: plan.memoryId,
        objectId: plan.cryptoObjectId,
        expectedContentRevision: plan.expectedContentRevision,
        expectedAccessRevision: plan.expectedCryptoAccessRevision,
        resultAccessRevision: plan.nextCryptoAccessRevision,
        currentManifestHash: new Uint8Array(32).fill(4),
        resultManifestHash: new Uint8Array(32).fill(5),
        targetRequiredNamespaceFingerprint:
          plan.targetRequiredNamespaceFingerprint.slice(),
        requestDigest: SIGNED_REQUEST_DIGEST.slice(),
        currentNamespaceIds: plan.currentNamespaceIds,
        targetNamespaceIds: [],
        status: "applied",
        publicationAuthority: publicationAuthority({
          operationId: plan.operationId,
          expectedContentRevision: plan.expectedContentRevision,
          expectedAccessRevision: plan.expectedCryptoAccessRevision,
          resultAccessRevision: plan.nextCryptoAccessRevision,
        }),
      },
    })).toMatchObject({ status: "updated", requiredNamespaceIds: [] });
    expect(connection.namespaceIds).toEqual([]);
    expect(connection.calls.some(({ statement }) =>
      statement.toLowerCase().includes('delete from "memories"'))).toBe(true);
  });

  test("atomically terminalizes an admitted access request as ordinary fallback", async () => {
    const { connection, product } = await fixture();
    const plan = await product.plan({ authority, operationId: "access:fallback",
      memoryId: MEMORY,
      target: { kind: "replace_exact", namespaceIds: [ALICE, BOB, CHARLIE] } });
    if (plan.status !== "prepared") throw new Error("expected prepared plan");
    await product.reserve({ authority, plan, signedRequestDigest: SIGNED_REQUEST_DIGEST });
    const result = await product.commitOrdinaryFallback({ authority, plan,
      preparedAuthority: publicationAuthority({ operationId: plan.operationId,
        expectedContentRevision: plan.expectedContentRevision,
        expectedAccessRevision: plan.expectedCryptoAccessRevision,
        resultAccessRevision: plan.nextCryptoAccessRevision }),
      signedRequestDigest: SIGNED_REQUEST_DIGEST,
      reason: "encryption_pending" });
    expect(result).toEqual({ status: "ordinary_fallback",
      operationId: plan.operationId, memoryId: MEMORY,
      cryptoAccessRevision: plan.expectedCryptoAccessRevision,
      requiredNamespaceIds: [ALICE, BOB, CHARLIE],
      reason: "encryption_pending" });
    expect(connection.accessRevision).toBe(plan.expectedCryptoAccessRevision);
    expect(connection.calls.filter(({ statement }) =>
      statement.toLowerCase().startsWith('update "memory_crypto_operations"'))
      .every(({ statement }) => !statement.includes('"result_access_revision" =')))
      .toBe(true);
    expect(connection.namespaceIds).toEqual([ALICE, BOB, CHARLIE]);
    expect(connection.calls.some(({ statement, parameters }) =>
      statement.toLowerCase().includes("memory_crypto_operations")
      && parameters.includes("ordinary_fallback"))).toBe(true);
    expect(await product.commitOrdinaryFallback({ authority, plan,
      preparedAuthority: publicationAuthority({ operationId: plan.operationId,
        expectedContentRevision: plan.expectedContentRevision,
        expectedAccessRevision: plan.expectedCryptoAccessRevision,
        resultAccessRevision: plan.nextCryptoAccessRevision }),
      signedRequestDigest: SIGNED_REQUEST_DIGEST,
      reason: "target_encryption_not_ready" })).toEqual(result);
    expect(await product.lookupReplay({ authority, operationId: plan.operationId,
      memoryId: MEMORY, subjectHumanId: authority.subjectHumanId,
      signedRequestDigest: SIGNED_REQUEST_DIGEST })).toEqual({
      status: "ordinary_fallback", requestDigest: SIGNED_REQUEST_DIGEST,
      cryptoAccessRevision: plan.expectedCryptoAccessRevision,
      reason: "encryption_pending",
    });
  });

  test("plans native targets without consulting retired Namespace bindings", async () => {
    const { connection, product } = await fixture();
    expect(await product.plan({
      authority,
      operationId: "access:pending-target",
      memoryId: MEMORY,
      target: { kind: "replace_exact", namespaceIds: [ALICE, BOB, CHARLIE] },
    })).toMatchObject({ status: "prepared", targetNamespaceIds: [ALICE, BOB, CHARLIE] });
    expect(connection.operation).toBeNull();
    expect(connection.calls.some(({ statement }) => statement.includes("exact-access:reserve"))).toBe(false);
  });

  test("rejects arbitrary IDs outside the authenticated view and corrupted mapping", async () => {
    const outside = await fixture();
    expect(await rejectedError(Promise.resolve().then(() => outside.product.plan({
      authority,
      operationId: "a".repeat(129),
      memoryId: MEMORY,
      target: { kind: "replace_exact", namespaceIds: [ALICE, BOB, CHARLIE] },
    })))).toHaveProperty("message", expect.stringContaining("identifiers are invalid"));
    expect(await rejectedError(outside.product.plan({
      authority: { ...authority, readableNamespaceIds: [CHARLIE] },
      operationId: "access:outside-view",
      memoryId: MEMORY,
      target: { kind: "replace_exact", namespaceIds: [ALICE, BOB, CHARLIE] },
    }))).toHaveProperty("message", expect.stringContaining("read authority"));
    expect(outside.connection.operation).toBeNull();
    expect(outside.connection.calls.some(({ statement }) =>
      statement.includes("exact-access:reserve")
    )).toBe(false);

    const corrupt = await fixture();
    corrupt.connection.fingerprint = new Uint8Array(32).fill(0xff);
    expect(await rejectedError(corrupt.product.plan({
      authority,
      operationId: "access:corrupt-map",
      memoryId: MEMORY,
      target: { kind: "delete_authorized_view" },
    }))).toHaveProperty("message", expect.stringContaining("fingerprint is invalid"));
  });

  test("commits exact crypto receipt, edges, fingerprint and revision", async () => {
    const { connection, product, setTargetReady } = await fixture();
    const plan = await product.plan({
      authority: { ...authority, readableNamespaceIds: [ALICE, BOB], mutableNamespaceIds: [ALICE, BOB] },
      operationId: "access:grant-charlie",
      memoryId: MEMORY,
      target: { kind: "replace_exact", namespaceIds: [ALICE, BOB, CHARLIE] },
    });
    if (plan.status !== "prepared") throw new Error("expected prepared plan");
    expect(connection.operation).toBeNull();
    expect(await product.reserve({
      authority: { ...authority, readableNamespaceIds: [ALICE, BOB], mutableNamespaceIds: [ALICE, BOB] },
      plan,
      signedRequestDigest: SIGNED_REQUEST_DIGEST,
    })).toBe("reserved");
    const pendingReplay = await product.lookupReplay({
      authority: { ...authority, readableNamespaceIds: [ALICE, BOB] },
      operationId: plan.operationId,
      memoryId: plan.memoryId,
      subjectHumanId: authority.subjectHumanId,
      signedRequestDigest: SIGNED_REQUEST_DIGEST,
    });
    expect(pendingReplay).toMatchObject({ status: "pending" });
    if (pendingReplay.status !== "pending") throw new Error("expected pending replay");
    expect(() => assertHumanMemoryExactAccessReplayAdmission({
      admission: pendingReplay.replayAdmission,
      operationId: plan.operationId,
      memoryId: plan.memoryId,
      subjectHumanId: authority.subjectHumanId,
      requestDigest: SIGNED_REQUEST_DIGEST,
    })).not.toThrow();
    expect(() => assertHumanMemoryExactAccessReplayAdmission({
      admission: pendingReplay.replayAdmission,
      operationId: `${plan.operationId}:substituted`,
      memoryId: plan.memoryId,
      subjectHumanId: authority.subjectHumanId,
      requestDigest: SIGNED_REQUEST_DIGEST,
    })).toThrow("replay admission is invalid");
    const receipt: HumanMemoryExactAccessCryptoReceipt = {
      operationId: plan.operationId,
      memoryId: plan.memoryId,
      objectId: plan.cryptoObjectId,
      expectedContentRevision: plan.expectedContentRevision,
      expectedAccessRevision: plan.expectedCryptoAccessRevision,
      resultAccessRevision: plan.nextCryptoAccessRevision,
      currentManifestHash: new Uint8Array(32).fill(4),
      resultManifestHash: new Uint8Array(32).fill(5),
      targetRequiredNamespaceFingerprint: plan.targetRequiredNamespaceFingerprint.slice(),
      requestDigest: SIGNED_REQUEST_DIGEST.slice(),
      currentNamespaceIds: plan.currentNamespaceIds,
      targetNamespaceIds: plan.targetNamespaceIds,
      status: "applied",
      publicationAuthority: publicationAuthority({
        operationId: plan.operationId,
        expectedContentRevision: plan.expectedContentRevision,
        expectedAccessRevision: plan.expectedCryptoAccessRevision,
        resultAccessRevision: plan.nextCryptoAccessRevision,
      }),
    };
    setTargetReady(false);
    expect(await rejectedError(product.commit({
      authority: { ...authority, readableNamespaceIds: [ALICE, BOB], mutableNamespaceIds: [ALICE, BOB] },
      plan,
      receipt,
    }))).toHaveProperty("message", expect.stringContaining("authority became stale"));
    expect(connection.namespaceIds).toEqual([ALICE, BOB]);
    setTargetReady(true);
    expect(await product.commit({ authority: { ...authority, readableNamespaceIds: [ALICE, BOB], mutableNamespaceIds: [ALICE, BOB] }, plan, receipt }))
      .toMatchObject({ status: "updated", cryptoAccessRevision: 3, requiredNamespaceIds: [ALICE, BOB, CHARLIE] });
    expect(connection.namespaceIds).toEqual([ALICE, BOB, CHARLIE]);
    expect(connection.accessRevision).toBe(3);
    expect(connection.mappingState).toBe("verified");
    expect(connection.calls.some(({ statement, parameters }) =>
      statement.toLowerCase().startsWith('update "memories"')
      && statement.includes('"crypto_mapping_state" =')
      && statement.includes('"crypto_mapping_state" = $')
      && parameters.includes("verified")
      && parameters.includes("stale"))).toBe(true);
    expect(connection.operation).toMatchObject({ completion: "complete", disposition: "complete" });
    expect(await product.lookupReplay({
      authority: { ...authority, readableNamespaceIds: [ALICE, BOB] },
      operationId: plan.operationId,
      memoryId: plan.memoryId,
      subjectHumanId: authority.subjectHumanId,
      signedRequestDigest: SIGNED_REQUEST_DIGEST,
    })).toMatchObject({
      status: "completed",
      cryptoAccessRevision: 3,
      requiredNamespaceIds: [ALICE, BOB, CHARLIE],
    });
    expect(await product.lookupReplay({
      authority: { ...authority, readableNamespaceIds: [ALICE, BOB] },
      operationId: plan.operationId,
      memoryId: plan.memoryId,
      subjectHumanId: authority.subjectHumanId,
      signedRequestDigest: new Uint8Array(32).fill(0xff),
    })).toEqual({ status: "conflict" });
    connection.mappingState = "stale";
    expect(await rejectedError(product.commit({
      authority: { ...authority, readableNamespaceIds: [ALICE, BOB], mutableNamespaceIds: [ALICE, BOB] },
      plan,
      receipt: { ...receipt, status: "duplicate" },
    }))).toHaveProperty("message", expect.stringContaining("became stale"));
    connection.mappingState = "verified";
    expect(await product.commit({
      authority: { ...authority, readableNamespaceIds: [ALICE, BOB], mutableNamespaceIds: [ALICE, BOB] },
      plan,
      receipt: { ...receipt, status: "duplicate" },
    })).toMatchObject({
      status: "replayed",
      cryptoAccessRevision: 3,
      requiredNamespaceIds: [ALICE, BOB, CHARLIE],
    });
  });

  test("rejects operation collisions, stale products, and substituted crypto receipts", async () => {
    const collision = await fixture();
    const first = await collision.product.plan({
      authority: { ...authority, readableNamespaceIds: [ALICE, BOB], mutableNamespaceIds: [ALICE, BOB] },
      operationId: "access:collision",
      memoryId: MEMORY,
      target: { kind: "replace_exact", namespaceIds: [ALICE, BOB, CHARLIE] },
    });
    if (first.status !== "prepared") throw new Error("expected prepared plan");
    expect(await collision.product.reserve({
      authority: { ...authority, readableNamespaceIds: [ALICE, BOB], mutableNamespaceIds: [ALICE, BOB] },
      plan: first,
      signedRequestDigest: SIGNED_REQUEST_DIGEST,
    })).toBe("reserved");
    expect(await collision.product.reserve({
      authority: { ...authority, readableNamespaceIds: [ALICE, BOB], mutableNamespaceIds: [ALICE, BOB] },
      plan: first,
      signedRequestDigest: SIGNED_REQUEST_DIGEST,
    })).toBe("replayed");
    expect(await rejectedError(collision.product.reserve({
      authority: { ...authority, readableNamespaceIds: [ALICE, BOB], mutableNamespaceIds: [ALICE, BOB] },
      plan: first,
      signedRequestDigest: new Uint8Array(32).fill(0x45),
    }))).toHaveProperty("message", expect.stringContaining("replay conflicts"));

    const exactReceipt: HumanMemoryExactAccessCryptoReceipt = {
      operationId: first.operationId,
      memoryId: first.memoryId,
      objectId: first.cryptoObjectId,
      expectedContentRevision: first.expectedContentRevision,
      expectedAccessRevision: first.expectedCryptoAccessRevision,
      resultAccessRevision: first.nextCryptoAccessRevision,
      currentManifestHash: new Uint8Array(32).fill(6),
      resultManifestHash: new Uint8Array(32).fill(7),
      targetRequiredNamespaceFingerprint: first.targetRequiredNamespaceFingerprint.slice(),
      requestDigest: SIGNED_REQUEST_DIGEST.slice(),
      currentNamespaceIds: first.currentNamespaceIds,
      targetNamespaceIds: first.targetNamespaceIds,
      status: "applied",
      publicationAuthority: publicationAuthority({
        operationId: first.operationId,
        expectedContentRevision: first.expectedContentRevision,
        expectedAccessRevision: first.expectedCryptoAccessRevision,
        resultAccessRevision: first.nextCryptoAccessRevision,
      }),
    };
    expect(() => collision.product.commit({
      authority: { ...authority, readableNamespaceIds: [ALICE, BOB], mutableNamespaceIds: [ALICE, BOB] },
      plan: first,
      receipt: { ...exactReceipt, resultManifestHash: new Uint8Array(31) },
    })).toThrow("substituted");

    collision.connection.accessRevision = 9;
    expect(await rejectedError(collision.product.commit({
      authority: { ...authority, readableNamespaceIds: [ALICE, BOB], mutableNamespaceIds: [ALICE, BOB] },
      plan: first,
      receipt: exactReceipt,
    }))).toHaveProperty("message", expect.stringContaining("became stale"));
  });

  test("reconciles crypto response loss after restart without an in-memory plan", async () => {
    const { connection, product } = await fixture();
    const planningAuthority = {
      ...authority,
      readableNamespaceIds: [ALICE, BOB],
      mutableNamespaceIds: [ALICE, BOB],
    } as const;
    const plan = await product.plan({
      authority: planningAuthority,
      operationId: "access:restart",
      memoryId: MEMORY,
      target: { kind: "replace_exact", namespaceIds: [ALICE, BOB, CHARLIE] },
    });
    if (plan.status !== "prepared") throw new Error("expected prepared plan");
    await product.reserve({ authority: planningAuthority, plan, signedRequestDigest: SIGNED_REQUEST_DIGEST });
    expect(await product.reconcile({
      authority: planningAuthority,
      operationId: plan.operationId,
      memoryId: MEMORY,
      crypto: {
        status: "current",
        objectId: OBJECT,
        accessRevision: 2,
        manifestHash: new Uint8Array(32).fill(8),
        namespaceIds: [ALICE, BOB],
        namespaceEnvelopeCoordinates: [],
      },
    })).toEqual({ status: "pending", phase: "crypto" });

    expect(await product.reconcile({
      authority: planningAuthority,
      operationId: plan.operationId,
      memoryId: MEMORY,
      crypto: {
        status: "target",
        objectId: OBJECT,
        accessRevision: 3,
        manifestHash: new Uint8Array(32).fill(9),
        previousManifestHash: new Uint8Array(32).fill(8),
        namespaceIds: [ALICE, BOB, CHARLIE],
        namespaceEnvelopeCoordinates: [],
      },
    })).toEqual({ status: "pending", phase: "crypto" });
    expect(connection.namespaceIds).toEqual([ALICE, BOB]);
    expect(connection.accessRevision).toBe(2);

    expect(await product.reconcile({
      authority: planningAuthority,
      operationId: plan.operationId,
      memoryId: MEMORY,
      crypto: {
        status: "target",
        objectId: OBJECT,
        accessRevision: 3,
        manifestHash: new Uint8Array(32).fill(9),
        previousManifestHash: new Uint8Array(32).fill(8),
        namespaceIds: [ALICE, BOB, CHARLIE],
        namespaceEnvelopeCoordinates: [],
      },
    })).toEqual({ status: "pending", phase: "crypto" });
  });

  test("quarantines conflicting or substituted restricted observations", async () => {
    const { product } = await fixture();
    const planningAuthority = {
      ...authority,
      readableNamespaceIds: [ALICE, BOB],
      mutableNamespaceIds: [ALICE, BOB],
    } as const;
    const plan = await product.plan({
      authority: planningAuthority,
      operationId: "access:bad-observation",
      memoryId: MEMORY,
      target: { kind: "replace_exact", namespaceIds: [ALICE, BOB, CHARLIE] },
    });
    if (plan.status !== "prepared") throw new Error("expected prepared plan");
    await product.reserve({ authority: planningAuthority, plan, signedRequestDigest: SIGNED_REQUEST_DIGEST });
    expect(await product.reconcile({
      authority: planningAuthority,
      operationId: plan.operationId,
      memoryId: MEMORY,
      crypto: { status: "conflict" },
    })).toEqual({ status: "quarantined" });
    expect(await product.reconcile({
      authority: planningAuthority,
      operationId: plan.operationId,
      memoryId: MEMORY,
      crypto: {
        status: "target",
        objectId: OBJECT,
        accessRevision: 3,
        manifestHash: new Uint8Array(32).fill(9),
        previousManifestHash: new Uint8Array(32).fill(8),
        namespaceIds: [ALICE, CHARLIE],
        namespaceEnvelopeCoordinates: [],
      },
    })).toEqual({ status: "quarantined" });
  });
});
