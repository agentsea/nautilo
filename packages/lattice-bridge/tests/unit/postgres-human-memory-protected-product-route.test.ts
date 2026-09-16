import { describe, expect, test } from "bun:test";
import { sha256 } from "@noble/hashes/sha2.js";
import { encodeMemoryPayloadV1 } from "../../src/memory/memory-payload-v1.ts";
import { decodeMemoryListCursor, encodeMemoryListCursor } from "@nautilo/types";
import {
  LatticeCrypto, accessRevision, namespaceGeneration, namespaceId, objectId,
  wrapObjectDekForNamespace,
} from "@nautilo/lattice-crypto";
import { encodeNamespaceObjectEnvelopeV2 } from "@nautilo/lattice-crypto/wire";

import {
  deriveMemoryCryptoObjectIdV1,
  fingerprintRequiredMemoryNamespaces,
} from "../../src/memory/memory-repository.ts";
import { createPostgresHumanMemoryProtectedProductRoutePort } from "../../src/server/memory/postgres-human-memory-protected-product-route.ts";
import type { PostgresHumanMemoryCryptoCompletion } from "../../src/server/memory/postgres-human-memory-crypto-completion.ts";
import {
  bindConversationProductCanonicalTransactionRunner,
  verifyConversationProductPostgresHandle,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresConnection,
  type ConversationProductPostgresScalar,
  type ConversationProductPostgresTransaction,
} from "../../src/server/message/postgres-conversation-product-store.ts";

const MEMORY = "91000000-0000-4000-8000-000000000001";
const A = "91000000-0000-4000-8000-000000000010";
const B = "91000000-0000-4000-8000-000000000020";
const SCOPE = "91000000-0000-4000-8000-000000000030";
const OBJECT = deriveMemoryCryptoObjectIdV1({ memoryId: MEMORY, contentRevision: 1 });
const ROOM = "91000000-0000-4000-8000-000000000040";
const authorityFor = async ({ namespaceId }: { namespaceId: string }) => ({
  sourceRoomId: ROOM, namespaceId, currentGeneration: 0,
  retainedGenerations: [{ generation: 0,
    accessRevision: 4, headDigestBase64url: "AA", publicationDigestBase64url: "AA",
    publicationSetDigestBase64url: "AA", audienceFingerprintBase64url: "AA" }],
});

const namespaceAuthority = Object.freeze({
  userId: "user:1", actorId: "actor:1", agentId: null,
  memoryMode: "namespace" as const,
  readableNamespaceIds: [A], mutableNamespaceIds: [A],
  writableNamespaceIds: [A], scopeId: null, originWritableNamespaceId: null,
  sourceRoomId: null,
});
const scopeAuthority = Object.freeze({
  ...namespaceAuthority, memoryMode: "scope" as const,
  readableNamespaceIds: [], mutableNamespaceIds: [], writableNamespaceIds: [],
  scopeId: SCOPE, originWritableNamespaceId: A,
});

type TierOperation = Readonly<{
  operationId: string;
  anchorNamespaceId: string;
  expectedContentRevision: number;
  expectedAccessRevision: number;
  digest: Uint8Array;
}>;

class ProductConnection implements ConversationProductPostgresConnection {
  namespaceIds: string[] = [A, B];
  scopeEdges: Array<Readonly<{ scopeId: string; origin: "seed" | "scope" }>> = [];
  accessRevision = 4;
  tier: 1 | 2 | 3 = 1;
  fingerprintOverride: Uint8Array | null = null;
  operation: TierOperation | null = null;
  corruptReplay = false;
  fenceFails = false;
  ordinaryOnly = false;
  ordinaryBodyMissing = false;
  ordinaryReadStale = false;
  wireDates = false;
  listCopies = 1;
  readonly publicationEvents: string[] = [];
  readonly calls: Array<Readonly<{ statement: string;
    parameters: readonly ConversationProductPostgresScalar[] }>> = [];

  query<Row extends ConversationProductDatabaseRow = ConversationProductDatabaseRow>(
    statement: string,
  ): Promise<readonly Row[]> {
    if (statement.includes("current_user::text")) {
      return Promise.resolve([{ current_user: "nautilo",
        session_user: "nautilo" }] as unknown as Row[]);
    }
    throw new Error(`unexpected outer query: ${statement}`);
  }

  transaction<Result>(
    callback: (transaction: ConversationProductPostgresTransaction) => Promise<Result>,
  ): Promise<Result> {
    return callback({ query: (statement, parameters = []) =>
      this.run(statement, parameters) });
  }

  private async run<Row extends ConversationProductDatabaseRow>(
    statement: string,
    parameters: readonly ConversationProductPostgresScalar[],
  ): Promise<readonly Row[]> {
    this.calls.push({ statement, parameters: [...parameters] });
    const normalized = statement.replaceAll('"', "").toLowerCase();
    if (normalized.startsWith("select type, content from memories m")) {
      this.publicationEvents.push("ordinary-body-read");
      if (this.ordinaryReadStale) return [];
      return [{ type: "fact", content: "ordinary sibling" }] as unknown as Row[];
    }
    if (statement.includes("human-protected-memory:tier-replay")) {
      this.publicationEvents.push("receipt-lock");
    }
    if (statement.includes("app_current_user_id")) {
      return [{ current_user_id: "user:1", current_agent_id: null }] as unknown as Row[];
    }
    if (statement.includes("human-protected-memory:tier-replay")) {
      if (this.operation === null) return [];
      return [{ operation_id: this.operation.operationId, memory_id: MEMORY,
        anchor_namespace_id: this.operation.anchorNamespaceId,
        operation_type: "metadata",
        expected_content_revision: this.operation.expectedContentRevision,
        expected_access_revision: this.operation.expectedAccessRevision,
        request_digest: this.corruptReplay ? new Uint8Array(32).fill(9)
          : this.operation.digest.slice(), completion: "complete",
        disposition: "complete" }] as unknown as Row[];
    }
    if (normalized.includes("from memories m") && normalized.includes("namespace_ids")
      && normalized.includes("order by m.created_at desc")) {
      return Array.from({ length: this.listCopies }, (_, index) => ({
        ...this.row(), memory_id: index === 0 ? MEMORY
          : `91000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      })) as unknown as Row[];
    }
    if (
      statement.includes("human-protected-memory:lock-tier")
      || statement.includes("human-protected-memory:snapshot")
      || statement.includes("human-protected-memory:list")
      || (normalized.includes("from memories m")
        && normalized.includes("namespace_ids"))
    ) return [this.row()] as unknown as Row[];
    if (normalized.includes("update memories set")) {
      const [, contentRevision, accessRevision, , , expectedTier] = parameters.slice(-6);
      if (
        contentRevision !== 1 || accessRevision !== this.accessRevision
        || expectedTier !== this.tier
      ) return [];
      this.tier = parameters[0] as 1 | 2 | 3;
      return [{ memory_id: MEMORY }] as unknown as Row[];
    }
    if (normalized.includes("insert into memory_crypto_operations")) {
      this.operation = Object.freeze({ operationId: parameters[0] as string,
        anchorNamespaceId: parameters[2] as string,
        expectedContentRevision: parameters[4] as number,
        expectedAccessRevision: parameters[6] as number,
        digest: (parameters[8] as Uint8Array).slice() });
      return [];
    }
    throw new Error(`unexpected product query: ${statement}`);
  }

  private row(): ConversationProductDatabaseRow {
    const required = this.namespaceIds.length === 0 ? [A] : this.namespaceIds;
    return {
      memory_id: MEMORY, content_revision: this.ordinaryOnly ? 0 : 1,
      crypto_access_revision: this.accessRevision, crypto_object_id: this.ordinaryOnly ? null : OBJECT,
      crypto_mapping_state: this.ordinaryOnly ? "unmapped" : "verified",
      ordinary_body_missing: this.ordinaryBodyMissing,
      crypto_required_namespace_fingerprint:
        this.ordinaryOnly ? null : this.fingerprintOverride?.slice()
          ?? fingerprintRequiredMemoryNamespaces(required),
      importance: 0.75, tier: this.tier,
      created_at: this.wireDates ? "2026-08-10T00:00:00.000Z" : new Date("2026-08-10T00:00:00.000Z"),
      updated_at: this.wireDates ? "2026-08-10T00:00:01.000Z" : new Date("2026-08-10T00:00:01.000Z"),
      demoted_at: null, demoted_from: null,
      namespace_ids: JSON.stringify(this.namespaceIds),
      scope_edges: JSON.stringify(this.scopeEdges), score: 0.875,
    };
  }
}

function cryptoCompletion(connection: ProductConnection): PostgresHumanMemoryCryptoCompletion {
  return {
    complete: async () => "duplicate",
    verify: async () => null,
    read: async (reference) => {
      if (connection.accessRevision > 256) return null;
      const required = connection.namespaceIds.length === 0 ? [A] : connection.namespaceIds;
      return {
        memoryId: reference.memoryId, contentRevision: reference.contentRevision,
        objectId: reference.objectId, accessRevision: connection.accessRevision,
        requiredNamespaceIds: required,
        payloadBytes: new Uint8Array([1]), accessManifestBytes: new Uint8Array([2]),
        accessManifestProofBytes: [],
        accessSignerEvidence: [{ kind: "processor_authorization",
          evidenceBytes: new Uint8Array([9]) }, {
          kind: "human_device", subjectHumanId: "92000000-0000-4000-8000-000000000001",
          committerDeviceId: "device:peer", hostAuthorizationRevision: 7,
          signingPublicKey: new Uint8Array(32).fill(0x2a),
        }, {
          kind: "evidence_issuer_human_device",
          subjectHumanId: "93000000-0000-4000-8000-000000000001",
          deviceId: "device:issuer", hostAuthorizationRevision: 4,
          signingPublicKey: new Uint8Array(32).fill(0x2b),
        }],
        namespaceEnvelopes: required.map((id) => ({ namespaceId: id,
          envelopeBytes: encodeNamespaceObjectEnvelopeV2(
            wrapObjectDekForNamespace(new LatticeCrypto({ bytes: (length) =>
              new Uint8Array(length).fill(7) }), new Uint8Array(32).fill(8), {
                objectId: objectId(OBJECT), namespaceId: namespaceId(id),
                keyClass: "human", keyGeneration: namespaceGeneration(0),
                bindingRevisionAtWrap: accessRevision(connection.accessRevision),
              }, new Uint8Array(32).fill(9)),
          ) })),
      };
    },
  };
}

async function fixture(representation: "protected_only" | "ordinary_and_protected" = "ordinary_and_protected",
  issueReadObservation?: Parameters<typeof createPostgresHumanMemoryProtectedProductRoutePort>[0]["issueReadObservation"],
  allowOrdinaryFallback = false) {
  const connection = new ProductConnection();
  const handle = await verifyConversationProductPostgresHandle(connection);
  const canonicalRunner = bindConversationProductCanonicalTransactionRunner(handle, {
    transaction: (callback) => connection.transaction((executor) => callback({
      execute: () => Promise.resolve([{ current_user: "nautilo", session_user: "nautilo" }]),
    } as never, executor)),
  });
  return { connection, port: createPostgresHumanMemoryProtectedProductRoutePort({
    handle, canonicalRunner,
    publication: { representation, allowOrdinaryFallback, policyRevision: 7, fence: async () => {
      connection.publicationEvents.push("current-policy-and-human-authority");
      if (connection.fenceFails) throw new Error("Current authority changed");
    } },
    cryptoCompletion: cryptoCompletion(connection),
    resolveHumanId: async () => "human:1",
    resolveNamespaceAuthority: authorityFor,
    ...(issueReadObservation === undefined ? {} : { issueReadObservation }),
  }) };
}

describe("Postgres Human protected Memory product route", () => {
  test("read observation admission is bound to exact ciphertext and absent for ordinary rows", async () => {
    const issued: unknown[] = [];
    const admission = { tokenBase64url: "A".repeat(43), policyRevision: 1, issuedAt: 10, expiresAt: 20 };
    const { connection, port } = await fixture("protected_only", async (request) => {
      issued.push(request);
      return admission;
    });
    const request = { subjectHumanId: "human:1", authority: namespaceAuthority,
      memoryId: MEMORY, canManageMemories: true };
    expect(await port.detail(request)).toMatchObject({ memory: { readObservationAdmission: admission } });
    expect(issued).toEqual([{ authority: namespaceAuthority, memoryId: MEMORY, cryptoObjectId: OBJECT,
      contentRevision: 1, cryptoAccessRevision: connection.accessRevision }]);
    connection.ordinaryOnly = true;
    await port.detail(request);
    expect(issued).toHaveLength(1);
  });

  test("Strict Shadow emits only a current sibling digest; Full never selects the ordinary body", async () => {
    for (const representation of ["ordinary_and_protected", "protected_only"] as const) {
      const { connection, port } = await fixture(representation);
      const result = await port.detail({ subjectHumanId: "human:1", authority: namespaceAuthority,
        memoryId: MEMORY, canManageMemories: true });
      if ("status" in result) throw new Error("Expected readable Memory");
      const comparisons = connection.calls.filter(({ statement }) => statement.startsWith('select "type", "content"'));
      if (representation === "protected_only") {
        expect(comparisons).toHaveLength(0);
        expect(result.memory.shadowComparison).toBeUndefined();
      } else {
        expect(comparisons).toHaveLength(1);
        expect(result.memory.shadowComparison).toEqual({ algorithm: "sha256-memory-payload-v1",
          digestBase64url: Buffer.from(sha256(encodeMemoryPayloadV1({ formatVersion: 1,
            type: "fact", content: "ordinary sibling" }))).toString("base64url") });
        expect(JSON.stringify(result.memory)).not.toContain("ordinary sibling");
        expect(connection.publicationEvents).toContain("current-policy-and-human-authority");
      }
    }
  });

  test("Fallback Shadow includes a fenced ordinary sibling for protected and unmapped rows", async () => {
    const { connection, port } = await fixture("ordinary_and_protected", undefined, true);
    const request = { subjectHumanId: "human:1", authority: namespaceAuthority,
      memoryId: MEMORY, canManageMemories: true };
    for (const ordinaryOnly of [false, true]) {
      connection.ordinaryOnly = ordinaryOnly;
      connection.publicationEvents.length = 0;
      const result = await port.detail(request);
      if ("status" in result) throw new Error("Expected fallback-capable Memory");
      expect(result.memory.ordinaryFallback).toEqual({ policyRevision: 7,
        payload: { formatVersion: 1, type: "fact", content: "ordinary sibling" } });
      expect(result.memory.protectedPayload.status).toBe(ordinaryOnly ? "pending" : "encrypted");
      if (ordinaryOnly) {
        expect(result.memory.shadowComparison).toBeUndefined();
        expect(result.memory.readObservationAdmission).toBeUndefined();
      }
      expect(connection.publicationEvents).toEqual([
        "current-policy-and-human-authority", "ordinary-body-read",
      ]);
    }
    const query = connection.calls.filter(({ statement }) => statement.startsWith('select "type", "content"')).at(-1)!;
    expect(query.statement).toContain('"m"."crypto_object_id" is null');
    expect(query.statement).toContain('"m"."content_revision" =');
    expect(query.statement).toContain('"m"."crypto_access_revision" =');
    expect(query.statement).toContain('"m"."crypto_mapping_state" =');
    expect(query.statement).toContain("exists");
    expect(query.parameters).toContain("unmapped");
  });

  test("fallback never returns a stale sibling or reads ordinary content after a failed policy fence", async () => {
    const { connection, port } = await fixture("ordinary_and_protected", undefined, true);
    connection.ordinaryOnly = true;
    connection.ordinaryReadStale = true;
    const request = { subjectHumanId: "human:1", authority: namespaceAuthority,
      memoryId: MEMORY, canManageMemories: true };
    expect(await port.detail(request)).toMatchObject({ status: "unavailable", reason: "stale_revision" });
    connection.ordinaryReadStale = false;
    connection.fenceFails = true;
    connection.publicationEvents.length = 0;
    const failure: unknown = await port.detail(request).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Current authority changed");
    expect(connection.publicationEvents).toEqual(["current-policy-and-human-authority"]);
  });

  test("Full cannot expose ordinary siblings even with an inconsistent fallback flag", async () => {
    const { connection, port } = await fixture("protected_only", undefined, true);
    connection.ordinaryOnly = true;
    const result = await port.detail({ subjectHumanId: "human:1", authority: namespaceAuthority,
      memoryId: MEMORY, canManageMemories: true });
    expect(JSON.stringify(result)).not.toContain("ordinary sibling");
    expect(connection.publicationEvents).not.toContain("ordinary-body-read");
  });

  test("a missing Shadow sibling requests reverse repair without a comparison digest", async () => {
    const { connection, port } = await fixture();
    connection.ordinaryBodyMissing = true;
    const result = await port.detail({ subjectHumanId: "human:1", authority: namespaceAuthority,
      memoryId: MEMORY, canManageMemories: true });
    expect(result).toMatchObject({ memory: { projection: { representationRepair: "protected_to_ordinary" } } });
    if ("status" in result) throw new Error("Expected readable ciphertext");
    expect(result.memory.shadowComparison).toBeUndefined();
    expect(connection.calls.some(({ statement }) => statement.startsWith('select "type", "content"'))).toBe(false);
  });

  test("lists ordinary historical rows without loading their confidential siblings", async () => {
    const { connection, port } = await fixture();
    connection.ordinaryOnly = true;
    connection.wireDates = true;
    const result = await port.list({ subjectHumanId: "human:1",
      authority: namespaceAuthority, namespaceIds: [A], includeArchive: false });
    expect(result).toMatchObject({ items: [{
      projection: { memoryId: MEMORY, contentRevision: 0, readAuthorities: [] },
      protectedPayload: { status: "pending", reason: "backfill_pending" },
    }] });
    const query = connection.calls.find(({ statement }) => statement.includes('from "memories" "m"'));
    const presenceOnly = '("m"."type" is null or "m"."content" is null) as "ordinary_body_missing"';
    expect(query?.statement).toContain(presenceOnly);
    expect(query?.statement.replace(presenceOnly, "")).not.toMatch(/"m"\."(?:content|type)"/u);
  });

  test("continues a mixed library page with product filters rather than silently truncating", async () => {
    const { connection, port } = await fixture();
    connection.ordinaryOnly = true;
    connection.listCopies = 3;
    const result = await port.list({ subjectHumanId: "human:1", authority: namespaceAuthority,
      namespaceIds: [A], excludeNamespaceIds: [B], includeArchive: false, limit: 2 });
    if ("status" in result) throw new Error("Expected page");
    expect(result.items).toHaveLength(2);
    expect(decodeMemoryListCursor(result.nextCursor!)).toEqual({
      createdAt: new Date("2026-08-10T00:00:00.000Z"),
      id: "91000000-0000-4000-8000-000000000002",
    });
    await port.list({ subjectHumanId: "human:1", authority: namespaceAuthority,
      namespaceIds: [A], includeArchive: false, limit: 2,
      cursor: encodeMemoryListCursor(new Date("2026-08-10T00:00:00.000Z"), MEMORY) });
    const queries = connection.calls.filter(({ statement }) => statement.includes('order by "m"."created_at" desc'));
    expect(queries[0]?.statement).toContain("not exists");
    expect(queries[0]?.parameters).toContain(B);
    expect(queries[0]?.parameters.at(-1)).toBe(3);
    expect(queries[1]?.statement).toContain('"m"."created_at" <');
    expect(queries[1]?.parameters).toContain(MEMORY);
  });

  test("Full historical rows report missing protection without promising automatic repair", async () => {
    const { connection, port } = await fixture("protected_only");
    connection.ordinaryOnly = true;
    expect(await port.list({ subjectHumanId: "human:1", authority: namespaceAuthority,
      namespaceIds: [A], includeArchive: false })).toMatchObject({ items: [{
      protectedPayload: { status: "unavailable", reason: "protected_representation_missing" },
    }] });
  });

  test("an unopenable row remains visible with its failure instead of rejecting the entire page", async () => {
    const { connection, port } = await fixture();
    connection.accessRevision = 257;
    expect(await port.list({ subjectHumanId: "human:1", authority: namespaceAuthority,
      namespaceIds: [A], includeArchive: false })).toMatchObject({ items: [{
      projection: { memoryId: MEMORY },
      protectedPayload: { status: "unavailable", reason: "integrity_failure" },
    }] });
  });

  test("reads exact M:N ciphertext and transports detached signer evidence", async () => {
    const { port } = await fixture();
    const result = await port.list({ subjectHumanId: "human:1",
      authority: namespaceAuthority, namespaceIds: [A], includeArchive: false });
    expect(result).toMatchObject({ memoryMode: "namespace", items: [{
      projection: { namespaceIds: [A, B], requiredNamespaceIds: [A, B] },
      protectedPayload: { accessSignerEvidence: [{
        kind: "processor_authorization", evidenceBytesBase64url: "CQ" }, {
        kind: "human_device", subjectHumanId: "92000000-0000-4000-8000-000000000001",
        committerDeviceId: "device:peer", hostAuthorizationRevision: 7,
        signingPublicKeyBase64url:
          "KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio",
      }, {
        kind: "evidence_issuer_human_device",
        subjectHumanId: "93000000-0000-4000-8000-000000000001",
        deviceId: "device:issuer", hostAuthorizationRevision: 4,
        signingPublicKeyBase64url:
          "KysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKys",
      }] },
    }] });
  });

  test("returns typed unavailable when a fresh client would exceed the proof cap", async () => {
    const { connection, port } = await fixture();
    connection.accessRevision = 257;
    expect(await port.detail({ subjectHumanId: "human:1",
      authority: namespaceAuthority, memoryId: MEMORY,
      canManageMemories: true })).toEqual({ dtoVersion: 1,
      status: "unavailable", reason: "integrity_failure" });
  });

  test("applies and exactly replays a tier CAS without narrowing M:N audience", async () => {
    const { connection, port } = await fixture();
    const request = { subjectHumanId: "human:1", authority: namespaceAuthority,
      operationId: "tier:1", memoryId: MEMORY, action: "archive" as const,
      expectedContentRevision: 1, expectedCryptoAccessRevision: 4,
      expectedTier: 1 as const, nextTier: 3 as const };
    expect(await port.transitionTier(request)).toMatchObject({
      operation: "archive", response: { status: "archived", nextTier: 3 },
    });
    expect(connection.namespaceIds).toEqual([A, B]);
    expect(connection.publicationEvents.slice(0, 2)).toEqual([
      "current-policy-and-human-authority", "receipt-lock",
    ]);
    const receiptInsert = connection.calls.find(({ statement }) =>
      statement.includes('insert into "memory_crypto_operations"'))!;
    expect(receiptInsert.statement).toContain('"semantic_change_kind"');
    expect(receiptInsert.parameters).toContain("archive");
    expect(await port.transitionTier(request)).toMatchObject({
      operation: "archive", response: { status: "replayed" },
    });
    connection.corruptReplay = true;
    expect(await port.transitionTier(request)).toEqual({ dtoVersion: 1,
      status: "unavailable", reason: "integrity_failure" });
  });

  test("rechecks publication authority before metadata writes and replay", async () => {
    const { connection, port } = await fixture();
    const request = { subjectHumanId: "human:1", authority: namespaceAuthority,
      operationId: "tier:fenced", memoryId: MEMORY, action: "archive" as const,
      expectedContentRevision: 1, expectedCryptoAccessRevision: 4,
      expectedTier: 1 as const, nextTier: 3 as const };
    connection.fenceFails = true;
    expect(await port.transitionTier(request).catch((error: unknown) => error))
      .toMatchObject({ message: "Current authority changed" });
    expect(connection.operation).toBeNull();
    expect(connection.tier).toBe(1);
    connection.fenceFails = false;
    await port.transitionTier(request);
    connection.fenceFails = true;
    const receiptLocks = connection.publicationEvents.filter((event) => event === "receipt-lock").length;
    expect(await port.transitionTier(request).catch((error: unknown) => error))
      .toMatchObject({ message: "Current authority changed" });
    expect(connection.publicationEvents.filter((event) => event === "receipt-lock")).toHaveLength(receiptLocks);
  });

  test("supports a canonical scope-owned tier mutation with origin anchor", async () => {
    const { connection, port } = await fixture();
    connection.namespaceIds = [];
    connection.scopeEdges = [{ scopeId: SCOPE, origin: "scope" }];
    expect(await port.transitionTier({ subjectHumanId: "human:1",
      authority: scopeAuthority, operationId: "tier:scope", memoryId: MEMORY,
      action: "demote", expectedContentRevision: 1,
      expectedCryptoAccessRevision: 4, expectedTier: 1, nextTier: 2,
    })).toMatchObject({ operation: "tier_transition",
      response: { status: "demoted" } });
    expect(connection.operation?.anchorNamespaceId).toBe(A);
  });

  test("rejects stale revision and read-only audience before operation insert", async () => {
    const stale = await fixture();
    expect(await stale.port.transitionTier({ subjectHumanId: "human:1",
      authority: namespaceAuthority, operationId: "tier:stale", memoryId: MEMORY,
      action: "archive", expectedContentRevision: 1,
      expectedCryptoAccessRevision: 3, expectedTier: 1, nextTier: 3,
    })).toEqual({ dtoVersion: 1, status: "unavailable", reason: "stale_revision" });
    const denied = await fixture();
    expect(await denied.port.transitionTier({ subjectHumanId: "human:1",
      authority: { ...namespaceAuthority, mutableNamespaceIds: [] },
      operationId: "tier:denied", memoryId: MEMORY, action: "archive",
      expectedContentRevision: 1, expectedCryptoAccessRevision: 4,
      expectedTier: 1, nextTier: 3,
    })).toEqual({ dtoVersion: 1, status: "unavailable",
      reason: "authorization_required" });
    expect(denied.connection.operation).toBeNull();

    const corrupted = await fixture();
    corrupted.connection.fingerprintOverride = new Uint8Array(32).fill(0xee);
    expect(await corrupted.port.transitionTier({ subjectHumanId: "human:1",
      authority: namespaceAuthority, operationId: "tier:corrupt", memoryId: MEMORY,
      action: "archive", expectedContentRevision: 1,
      expectedCryptoAccessRevision: 4, expectedTier: 1, nextTier: 3,
    })).toEqual({ dtoVersion: 1, status: "unavailable",
      reason: "integrity_failure" });
    expect(corrupted.connection.operation).toBeNull();
  });
});
