import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";
import {
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDomainId,
  domainEpoch,
  humanId,
  namespaceId,
  objectId,
} from "@nautilo/lattice-crypto";
import {
  encodeBackgroundWorkDescriptorV2,
  type BackgroundAgentWorkDescriptorV2,
} from "@nautilo/lattice-crypto/wire";

import { deriveMemoryCryptoObjectIdV1 } from "../../src/memory/memory-repository.ts";
import { backgroundMemoryTierRequestDigest } from "../../src/server/memory/background-memory-product-digest.ts";
import { PostgresAgentBackgroundMemoryPublicationReconciler } from "../../src/server/memory/postgres-agent-background-memory-publication-reconciler.ts";
import {
  verifyConversationProductPostgresHandle,
  type ConversationProductPostgresConnection,
  type ConversationProductPostgresIsolationLevel,
} from "../../src/server/message/postgres-conversation-product-store.ts";

const USER = "10000000-0000-4000-8000-000000000001";
const AGENT = "10000000-0000-4000-8000-000000000002";
const MEMORY = "20000000-0000-4000-8000-000000000001";
const NAMESPACE = "30000000-0000-4000-8000-000000000001";
const DOMAIN = "domain-background-reconcile";
const OBJECT = deriveMemoryCryptoObjectIdV1({ memoryId: MEMORY, contentRevision: 1 });
const OPERATION = "background-tier-reconcile";

class ScriptedConnection implements ConversationProductPostgresConnection {
  readonly isolationLevels: ConversationProductPostgresIsolationLevel[] = [];
  constructor(private readonly results: unknown[][]) {}
  query<Row>(): Promise<readonly Row[]> {
    const result = this.results.shift();
    if (result === undefined) throw new Error("Unexpected query");
    return Promise.resolve(result as Row[]);
  }
  transaction<Result>(
    callback: (transaction: this) => Promise<Result>,
    options: Readonly<{ isolationLevel: ConversationProductPostgresIsolationLevel }>,
  ): Promise<Result> {
    this.isolationLevels.push(options.isolationLevel);
    return callback(this);
  }
}

function descriptor(): BackgroundAgentWorkDescriptorV2 {
  return {
    formatVersion: 2,
    requestId: "background-reconcile-request",
    recipientGeneration: 1,
    workKind: "memory.review",
    workId: "background-reconcile-work",
    anchorNamespaceId: namespaceId(NAMESPACE),
    anchorDomainId: cryptoDomainId(DOMAIN),
    subject: {
      kind: "agent",
      agentId: agentId(AGENT),
      runtimeGeneration: agentRuntimeGeneration(0),
      authorizationRevision: authorizationRevision(7),
    },
    purpose: "memory.review",
    operations: ["decrypt", "encrypt"],
    source: {
      kind: "protected_memory_work",
      sourceVersion: 1,
      productAuthority: { mode: "namespace" },
      inputRevisions: [{
        productKind: "memory",
        productId: MEMORY,
        productRevision: 1,
        cryptoAccessRevision: 0,
        accessKind: "namespace",
        objectId: objectId(OBJECT),
      }],
      outputRevisions: [],
      tierMutations: [{
        operationIdempotencyId: OPERATION,
        memoryId: MEMORY,
        contentRevision: 1,
        cryptoAccessRevision: 0,
        objectId: objectId(OBJECT),
        action: "promote",
        expectedTier: 2,
        nextTier: 1,
        requiredNamespaceIds: [namespaceId(NAMESPACE)],
      }],
    },
    grantScope: [humanId(USER)],
    inputBindings: [{ objectId: objectId(OBJECT), namespaceId: namespaceId(NAMESPACE) }],
    outputSlots: [],
    namespaceRequirements: [{
      namespaceId: namespaceId(NAMESPACE),
      domainId: cryptoDomainId(DOMAIN),
      operations: ["decrypt", "encrypt"],
      expectedAccessRevision: accessRevision(0),
      expectedPolicyRevision: authorizationRevision(8),
    }],
    domainRequirements: [{
      domainId: cryptoDomainId(DOMAIN),
      expectedEpoch: domainEpoch(1),
      expectedAgentAuthorizationRevision: authorizationRevision(7),
    }],
    maximumInputObjectCount: 1,
    maximumOutputObjectCount: 0,
    maximumPlaintextBytes: 1024,
    maximumCiphertextBytes: 2048,
    recipientKeyId: "background-reconcile-recipient",
    recipientPublicKey: new Uint8Array(65).fill(4),
    issuedAt: 10_000,
    notBefore: 10_000,
    expiresAt: 20_000,
    idempotencyId: "background-reconcile-attempt",
  };
}

function operationRow(
  descriptorBytes: Uint8Array,
  overrides: Record<string, unknown> = {},
) {
  const value = descriptor();
  const mutation = value.source.kind === "protected_memory_work"
    ? value.source.tierMutations[0]!
    : null;
  if (mutation === null) throw new Error("Expected protected descriptor");
  const requestDigest = backgroundMemoryTierRequestDigest({
    ...mutation,
    cryptoObjectId: mutation.objectId,
    descriptorHash: createHash("sha256").update(descriptorBytes).digest(),
    authority: {
      mode: "namespace",
      subjectUserId: USER,
      agentId: AGENT,
      readableNamespaceIds: [NAMESPACE],
      mutableNamespaceIds: [NAMESPACE],
      writableNamespaceId: null,
    },
  });
  return {
    operation_id: OPERATION,
    memory_id: MEMORY,
    operation_type: "metadata",
    expected_content_revision: 1,
    result_content_revision: null,
    expected_access_revision: 0,
    request_digest: requestDigest,
    completion: "complete",
    disposition: "complete",
    created_at: new Date(10_000),
    ...overrides,
  };
}

async function reconcile(results: unknown[][]) {
  const connection = new ScriptedConnection([
    [{ current_user: "nautilo_agent", session_user: "nautilo_agent" }],
    ...results,
  ]);
  const handle = await verifyConversationProductPostgresHandle(connection);
  const reconciler = new PostgresAgentBackgroundMemoryPublicationReconciler(handle);
  const descriptorBytes = encodeBackgroundWorkDescriptorV2(descriptor());
  const outcome = await reconciler.reconcilePublication({
    descriptorBytes,
    snapshot: { acceptedResponse: { issuingHumanId: USER } },
  });
  return { outcome, descriptorBytes, connection };
}

describe("Postgres Agent background Memory publication reconciler", () => {
  test("returns not_started when no signed output operation was planned", async () => {
    const result = await reconcile([
      [{ current_user_id: USER, current_agent_id: AGENT }],
      [],
    ]);
    expect(result.outcome).toBe("not_started");
    expect(result.connection.isolationLevels).toEqual(["serializable"]);
  });

  test("accepts only an exact completed descriptor-bound receipt", async () => {
    const bytes = encodeBackgroundWorkDescriptorV2(descriptor());
    const result = await reconcile([
      [{ current_user_id: USER, current_agent_id: AGENT }],
      [operationRow(bytes)],
    ]);
    expect(result.outcome).toBe("completed");
  });

  test("keeps pending receipts pending and rejects digest or authority drift", async () => {
    const bytes = encodeBackgroundWorkDescriptorV2(descriptor());
    expect((await reconcile([
      [{ current_user_id: USER, current_agent_id: AGENT }],
      [operationRow(bytes, { completion: "pending", disposition: "active" })],
    ])).outcome).toBe("pending");
    expect((await reconcile([
      [{ current_user_id: USER, current_agent_id: AGENT }],
      [operationRow(bytes, { request_digest: new Uint8Array(32).fill(9) })],
    ])).outcome).toBe("stale");
    expect((await reconcile([
      [{ current_user_id: USER, current_agent_id: "wrong-agent" }],
    ])).outcome).toBe("stale");
  });
});
