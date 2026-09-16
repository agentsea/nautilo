import { describe, expect, test } from "bun:test";
import { namespaceId } from "@nautilo/lattice-crypto";

import { fingerprintRequiredMemoryNamespaces } from "../../src/memory/memory-repository.ts";
import { PostgresAgentMemoryExactAccessProduct } from "../../src/server/memory/postgres-agent-memory-exact-access-product.ts";
import {
  verifyConversationProductPostgresHandle,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresConnection,
  type ConversationProductPostgresScalar,
} from "../../src/server/message/postgres-conversation-product-store.ts";

const USER = "11000000-0000-4000-8000-000000000001";
const AGENT = "12000000-0000-4000-8000-000000000001";
const MEMORY = "22000000-0000-4000-8000-000000000001";
const ALICE = "33000000-0000-4000-8000-000000000001";
const BOB = "33000000-0000-4000-8000-000000000002";
const OBJECT =
  "memory:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

class ProductConnection implements ConversationProductPostgresConnection {
  namespaceIds = [ALICE];
  accessRevision = 2;
  fingerprint = fingerprintRequiredMemoryNamespaces(this.namespaceIds);
  scopeOriginCount = 0;
  operation: Readonly<{
    operationId: string;
    requestDigest: Uint8Array;
    targetFingerprint: Uint8Array;
    expectedAccessRevision: number;
    resultAccessRevision: number;
    completion: "pending" | "complete";
    disposition: "active" | "complete" | "quarantined";
  }> | null = null;
  readonly calls: string[] = [];

  query<Row extends ConversationProductDatabaseRow = ConversationProductDatabaseRow>(
    statement: string,
  ): Promise<readonly Row[]> {
    if (statement.includes("current_user::text")) {
      return Promise.resolve([{
        current_user: "nautilo_agent",
        session_user: "nautilo_agent",
      }] as unknown as Row[]);
    }
    throw new Error(`outside transaction: ${statement}`);
  }

  transaction<Result>(
    callback: (connection: this) => Promise<Result>,
  ): Promise<Result> {
    return callback(this);
  }

  run<Row extends ConversationProductDatabaseRow = ConversationProductDatabaseRow>(
    statement: string,
    parameters: readonly ConversationProductPostgresScalar[] = [],
  ): Promise<readonly Row[]> {
    this.calls.push(statement);
    const normalized = statement.toLowerCase();
    if (statement.includes("app_current_user_id")) {
      return Promise.resolve([{
        current_user_id: USER,
        current_agent_id: AGENT,
      }] as unknown as Row[]);
    }
    if (
      statement.includes("agent-memory:exact-access:operation")
      || statement.includes("agent-memory:native-exact-access:operation")
      || normalized.includes('from "memory_crypto_operations"')
    ) {
      if (this.operation === null) return Promise.resolve([]);
      return Promise.resolve([{
        operation_id: this.operation.operationId,
        memory_id: MEMORY,
        operation_type: "access",
        anchor_namespace_id: ALICE,
        expected_content_revision: 4,
        result_content_revision: null,
        expected_access_revision: this.operation.expectedAccessRevision,
        result_access_revision: this.operation.resultAccessRevision,
        request_digest: this.operation.requestDigest,
        target_required_namespace_fingerprint:
          this.operation.targetFingerprint,
        completion: this.operation.completion,
        disposition: this.operation.disposition,
      }] as unknown as Row[]);
    }
    if (statement.includes("agent-memory:exact-access:lock-product")) {
      return Promise.resolve([{
        memory_id: MEMORY,
        content_revision: 4,
        crypto_access_revision: this.accessRevision,
        crypto_object_id: OBJECT,
        crypto_required_namespace_fingerprint: this.fingerprint,
        scope_origin_namespace_id: this.scopeOriginCount === 0
          ? null
          : ALICE,
        namespace_ids: JSON.stringify(this.namespaceIds),
        scope_origin_count: this.scopeOriginCount,
      }] as unknown as Row[]);
    }
    if (statement.includes("agent-memory:exact-access:scope-origin")) {
      return Promise.resolve([{
        scope_id: "44000000-0000-4000-8000-000000000001",
        origin: "scope",
      }] as unknown as Row[]);
    }
    if (
      statement.includes("agent-memory:exact-access:reserve")
      || normalized.startsWith('insert into "memory_crypto_operations"')
    ) {
      this.operation = Object.freeze({
        operationId: parameters[0] as string,
        requestDigest: (parameters[8] as Uint8Array).slice(),
        targetFingerprint: (parameters[9] as Uint8Array).slice(),
        expectedAccessRevision: parameters[6] as number,
        resultAccessRevision: parameters[7] as number,
        completion: "pending",
        disposition: "active",
      });
      return Promise.resolve([]);
    }
    if (
      statement.includes("INSERT INTO memory_namespaces")
      || normalized.startsWith('insert into "memory_namespaces"')
    ) {
      const namespaceId = parameters[1] as string;
      this.namespaceIds = [...this.namespaceIds, namespaceId].sort();
      return Promise.resolve([{ namespace_id: namespaceId }] as unknown as Row[]);
    }
    if (statement.includes("UPDATE memories")) {
      this.accessRevision = parameters[2] as number;
      this.fingerprint = (parameters[3] as Uint8Array).slice();
      return Promise.resolve([{ memory_id: MEMORY }] as unknown as Row[]);
    }
    if (
      statement.includes("UPDATE memory_crypto_operations")
      || normalized.startsWith('update "memory_crypto_operations"')
    ) {
      if (this.operation === null) return Promise.resolve([]);
      if (
        statement.includes("failure_code = 'crypto_absent'")
        || normalized.includes('"failure_code"')
      ) {
        this.operation = Object.freeze({
          ...this.operation,
          disposition: "quarantined",
        });
      } else {
        this.operation = Object.freeze({
          ...this.operation,
          completion: "complete",
          disposition: "complete",
        });
      }
      return Promise.resolve([{
        operation_id: this.operation.operationId,
      }] as unknown as Row[]);
    }
    throw new Error(`Unexpected SQL: ${statement}`);
  }
}

async function fixture(
  observe: () => Promise<
    | Readonly<{ status: "absent" }>
    | Readonly<{
        status: "active";
        objectId: string;
        accessRevision: number;
        manifestHash: Uint8Array;
        namespaceIds: readonly string[];
      }>
  > = () => Promise.resolve({ status: "absent" as const }),
  legacyAuthority = true,
) {
  const connection = new ProductConnection();
  const handle = await verifyConversationProductPostgresHandle({
    query: connection.query.bind(connection),
    transaction: (callback) => connection.transaction(async () => callback({
      query: connection.run.bind(connection),
    })),
  });
  return {
    connection,
    product: new PostgresAgentMemoryExactAccessProduct({
      handle,
      readableNamespaceIds: [ALICE, BOB],
      crypto: {
        observe,
        complete: () => {
          throw new Error("not reached by planning tests");
        },
      },
      resolveGrantUserNamespace: () => Promise.resolve(BOB),
      ...(legacyAuthority ? { resolveCryptoAuthority: async ({ currentNamespaceIds,
        targetNamespaceIds }: { currentNamespaceIds: readonly string[];
          targetNamespaceIds: readonly string[] }) => ({
        currentBindings: currentNamespaceIds.map((namespaceId) => ({
          namespaceId,
          domainId: "domain-a",
          expectedAccessRevision: 3,
          expectedPolicyRevision: 7,
          bindingHash: new Uint8Array(32).fill(0x31),
        })),
        targetBindings: targetNamespaceIds.map((namespaceId) => ({
          namespaceId,
          domainId: "domain-a",
          expectedAccessRevision: 3,
          expectedPolicyRevision: 7,
          bindingHash: new Uint8Array(32).fill(0x31),
        })),
      }) } : {}),
    }),
  };
}

const authority = Object.freeze({
  mode: "namespace" as const,
  subjectUserId: USER,
  agentId: AGENT,
  readableNamespaceIds: Object.freeze([ALICE, BOB]),
  mutableNamespaceIds: Object.freeze([ALICE, BOB]),
  writableNamespaceId: BOB,
});

describe("Postgres Agent Memory exact access product", () => {
  test("finishes only the original pending native receipt after its target head is authenticated", async () => {
    const { product, connection } = await fixture(undefined, false);
    const planned = await product.planNativeChange({ operationId: "fresh-request",
      authority, memoryId: MEMORY, action: { kind: "grant_user", userHandle: "bob" } });
    if (planned.status !== "success") throw new Error("plan unavailable");
    connection.operation = { operationId: "original-approved-request",
      requestDigest: new Uint8Array(32).fill(7),
      targetFingerprint: planned.value.plan.targetRequiredNamespaceFingerprint,
      expectedAccessRevision: 2, resultAccessRevision: 3,
      completion: "pending", disposition: "active" };
    const digest = new Uint8Array(32).fill(1);
    const head = { objectId: OBJECT, accessRevision: 3,
      manifestHash: digest, namespaceIds: [ALICE, BOB] };
    expect(await product.reconcileNativeCommitted({ authority,
      plan: planned.value.plan, head: { ...head, accessRevision: 2 },
    })).toBe(false);
    expect(connection.namespaceIds).toEqual([ALICE]);
    expect(await product.reconcileNativeCommitted({ authority,
      plan: planned.value.plan, head,
    })).toBe(true);
    expect(connection.namespaceIds).toEqual([ALICE, BOB]);
    expect(connection.accessRevision).toBe(3);
    expect(connection.operation).toMatchObject({ operationId: "original-approved-request",
      completion: "complete", disposition: "complete" });
    expect(connection.calls.some((sql) => /insert into "memory_crypto_operations"/i.test(sql))).toBe(false);
  });

  test("plans a native exact grant without legacy binding authority", async () => {
    const { product } = await fixture(undefined, false);
    const result = await product.planNativeChange({
      operationId: "memory.share.native-1",
      authority,
      memoryId: MEMORY,
      action: { kind: "grant_user", userHandle: "bob" },
    });
    expect(result).toMatchObject({ status: "success", value: {
      status: "prepared", plan: { currentNamespaceIds: [ALICE],
        targetNamespaceIds: [ALICE, BOB] },
    } });
    if (result.status === "success" && result.value.status === "prepared") {
      expect("currentBindings" in result.value.plan).toBe(false);
    }
  });

  test("reserves and commits the native publication without legacy facts", async () => {
    const { product, connection } = await fixture(undefined, false);
    const planned = await product.planNativeChange({
      operationId: "memory.share.native-commit",
      authority, memoryId: MEMORY,
      action: { kind: "grant_user", userHandle: "bob" },
    });
    if (planned.status !== "success" || planned.value.status !== "prepared") {
      throw new Error("native plan unavailable");
    }
    const digest = new Uint8Array(32).fill(1);
    let persisted = 0;
    const result = await product.commitNativePrepared({
      authority, plan: planned.value.plan,
      publication: {
        objectId: OBJECT, expectedAccessRevision: 2, nextAccessRevision: 3,
        payloadHash: digest.slice(), currentManifestHash: digest.slice(),
        nextManifestHash: digest.slice(), nextManifestBytes: digest.slice(),
        targetEnvelopeBytes: [digest.slice(), digest.slice()],
        currentEntries: [{ namespaceId: namespaceId(ALICE), keyGeneration: 0,
          namespaceAccessRevision: 1, headDigest: digest.slice(),
          publicationDigest: digest.slice(), publicationSetDigest: digest.slice(),
          audienceFingerprint: digest.slice(), envelopeHash: digest.slice() }],
        targetEntries: [ALICE, BOB].map((namespace) => ({
          namespaceId: namespaceId(namespace), keyGeneration: 0,
          namespaceAccessRevision: 1, headDigest: digest.slice(),
          publicationDigest: digest.slice(), publicationSetDigest: digest.slice(),
          audienceFingerprint: digest.slice(), envelopeHash: digest.slice(),
        })),
      },
      persist: async () => { persisted += 1; return "created"; },
    });
    expect(result).toMatchObject({ status: "success",
      value: { status: "updated", memoryId: MEMORY } });
    expect(persisted).toBe(1);
    expect(connection.namespaceIds).toEqual([ALICE, BOB]);
  });

  test("plans one exact grant_user addition without touching crypto", async () => {
    const { product } = await fixture();
    const result = await product.planChange({
      operationId: "memory.share.tool-1",
      authority,
      memoryId: MEMORY,
      action: { kind: "grant_user", userHandle: "bob" },
    });
    expect(result).toMatchObject({
      status: "success",
      value: {
        status: "prepared",
        sourceNamespaceId: ALICE,
        plan: {
          currentNamespaceIds: [ALICE],
          targetNamespaceIds: [ALICE, BOB],
          addedNamespaceIds: [BOB],
          removedNamespaceIds: [],
          expectedCryptoAccessRevision: 2,
          nextCryptoAccessRevision: 3,
        },
      },
    });
  });

  test("regrant is a read-only unchanged result", async () => {
    const { connection, product } = await fixture();
    connection.namespaceIds = [ALICE, BOB];
    connection.fingerprint = fingerprintRequiredMemoryNamespaces([ALICE, BOB]);
    expect(await product.planChange({
      operationId: "memory.share.tool-2",
      authority,
      memoryId: MEMORY,
      action: { kind: "grant_user", userHandle: "bob" },
    })).toEqual({
      status: "success",
      value: { status: "unchanged", memoryId: MEMORY },
    });
    expect(connection.calls.some((statement) =>
      statement.includes("memory_crypto_operations")
    )).toBeFalse();
  });

  test("scope-origin Memory fails closed before exact-set preparation", async () => {
    const { connection, product } = await fixture();
    connection.scopeOriginCount = 1;
    connection.namespaceIds = [];
    let message = "";
    try {
      await product.planChange({
        operationId: "memory.share.tool-3",
        authority,
        memoryId: MEMORY,
        action: { kind: "grant_user", userHandle: "bob" },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("Scope-origin Memory cannot be shared directly");
  });

  test("plans captured scope-origin promotion as an exact remove plus add", async () => {
    const { connection, product } = await fixture();
    connection.scopeOriginCount = 1;
    connection.namespaceIds = [];
    const result = await product.planScopePromotion({
      operationId: "scope-close:promote-1",
      authority,
      scopeId: "44000000-0000-4000-8000-000000000001",
      memoryId: MEMORY,
      cryptoObjectId: OBJECT,
      expectedContentRevision: 4,
      expectedAccessRevision: 2,
      expectedRequiredNamespaceFingerprint:
        fingerprintRequiredMemoryNamespaces([ALICE]),
      sourceOriginNamespaceId: ALICE,
      targetNamespaceId: BOB,
    });
    expect(result).toMatchObject({
      status: "success",
      value: {
        status: "prepared",
        sourceNamespaceId: ALICE,
        plan: {
          currentNamespaceIds: [ALICE],
          targetNamespaceIds: [BOB],
          removedNamespaceIds: [ALICE],
          addedNamespaceIds: [BOB],
          productMutation: {
            kind: "promote_scope_origin",
            sourceOriginNamespaceId: ALICE,
            targetNamespaceId: BOB,
          },
        },
      },
    });
  });

  test("restart finishes a crypto-first access commit without the lost prepared handle", async () => {
    const targetFingerprint = fingerprintRequiredMemoryNamespaces([ALICE, BOB]);
    const { connection, product } = await fixture(() => Promise.resolve({
      status: "active" as const,
      objectId: OBJECT,
      accessRevision: 3,
      manifestHash: new Uint8Array(32).fill(0x72),
      namespaceIds: [ALICE, BOB],
    }));
    connection.operation = Object.freeze({
      operationId: "memory.share.lost-response",
      requestDigest: new Uint8Array(32).fill(0x51),
      targetFingerprint,
      expectedAccessRevision: 2,
      resultAccessRevision: 3,
      completion: "pending",
      disposition: "active",
    });

    expect(await product.reconcileAfterProcessLoss({
      authority,
      operationId: "memory.share.lost-response",
      memoryId: MEMORY,
    })).toEqual({
      status: "completed",
      operationId: "memory.share.lost-response",
      memoryId: MEMORY,
      cryptoAccessRevision: 3,
      requiredNamespaceIds: [ALICE, BOB],
    });
    expect(connection.namespaceIds).toEqual([ALICE, BOB]);
    expect(connection.accessRevision).toBe(3);
    expect(connection.operation).toMatchObject({
      completion: "complete",
      disposition: "complete",
    });
  });

  test("restart quarantines an abandoned reservation before a fresh Grant retries", async () => {
    const { connection, product } = await fixture(() => Promise.resolve({
      status: "active" as const,
      objectId: OBJECT,
      accessRevision: 2,
      manifestHash: new Uint8Array(32).fill(0x71),
      namespaceIds: [ALICE],
    }));
    connection.operation = Object.freeze({
      operationId: "memory.share.abandoned",
      requestDigest: new Uint8Array(32).fill(0x52),
      targetFingerprint: fingerprintRequiredMemoryNamespaces([ALICE, BOB]),
      expectedAccessRevision: 2,
      resultAccessRevision: 3,
      completion: "pending",
      disposition: "active",
    });

    expect(await product.reconcileAfterProcessLoss({
      authority,
      operationId: "memory.share.abandoned",
      memoryId: MEMORY,
    })).toEqual({ status: "stale" });
    expect(connection.namespaceIds).toEqual([ALICE]);
    expect(connection.accessRevision).toBe(2);
    expect(connection.operation).toMatchObject({
      completion: "pending",
      disposition: "quarantined",
    });
  });

  test("restart treats a never-reserved operation as safe for a fresh Grant attempt", async () => {
    const { product } = await fixture(() => Promise.resolve({
      status: "active" as const,
      objectId: OBJECT,
      accessRevision: 2,
      manifestHash: new Uint8Array(32).fill(0x71),
      namespaceIds: [ALICE],
    }));

    expect(await product.reconcileAfterProcessLoss({
      authority,
      operationId: "memory.share.never-reserved",
      memoryId: MEMORY,
    })).toEqual({ status: "stale" });
  });
});
