import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto, createAgentObjectAccessManifest, encryptObjectPayload, wrapObjectDekForNamespace, objectId,
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  deriveAgentRuntimeObjectSignerPublic,
  humanId,
  namespaceGeneration,
  namespaceId,
  unixTimestamp,
} from "@nautilo/lattice-crypto";
import {encodeEncryptedPayloadV2, encodeNamespaceObjectEnvelopeV2, encodeObjectAccessManifestV3, decodeObjectAccessManifestV3, encodeLiveShadowMessagePlanV4 } from "@nautilo/lattice-crypto/wire";
import { seededRng } from "@nautilo/lattice-crypto/testing";
import {
  createPostgresProcessorTransformObjectPort, verifyCryptoPostgresHandle, type CryptoPostgresConnection, type CryptoPostgresExecutor,
  createPostgresForegroundAgentAcceptedExecutionEvidenceResolver,
  createPostgresForegroundAgentSignerResolver,
  verifyConversationProductPostgresHandle,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresConnection,
  type ConversationProductPostgresIsolationLevel,
} from "@nautilo/lattice-bridge/server";

const UUID = "10000000-0000-4000-8000-000000000001";
const hash = (marker: number) => new Uint8Array(32).fill(marker);

class ScriptedConnection implements ConversationProductPostgresConnection {
  readonly queries: string[] = [];
  constructor(readonly batches: Array<readonly ConversationProductDatabaseRow[]>) {}
  query<Row extends ConversationProductDatabaseRow>(statement: string) {
    this.queries.push(statement);
    const batch = this.batches.shift();
    if (batch === undefined) throw new Error("Unexpected signer query");
    return Promise.resolve(batch as readonly Row[]);
  }
  transaction<Result>(
    callback: (transaction: this) => Promise<Result>,
    _options: Readonly<{ isolationLevel: ConversationProductPostgresIsolationLevel }>,
  ) {
    return callback(this);
  }
}

function fixture() {
  const crypto = new LatticeCrypto(seededRng(3_110_001));
  const runtime = {
    agentId: agentId(UUID),
    keyClass: "runtime" as const,
    generation: agentRuntimeGeneration(2),
    key: hash(3),
  };
  const signer = deriveAgentRuntimeObjectSignerPublic(crypto, runtime);
  const descriptorDigest = hash(7);
  const invocationDigest = hash(8);
  const inputSetDigest = hash(9);
  const plan = {
    formatVersion: 4 as const,
    purpose: "message.live_shadow_plan" as const,
    operationId: "shared_agent_execution_retained",
    policyRevision: 4,
    sessionId: UUID,
    roomId: UUID,
    humanMessageId: 12,
    revision: 0 as const,
    createdAt: unixTimestamp(1_700_000_000_000),
    subjectHumanId: humanId("human-retained"),
    committerDeviceId: cryptoDeviceId("device-retained"),
    committerDeviceSigningKeyGeneration: 1,
    hostAuthorizationRevision: authorizationRevision(7),
    recipientAgentId: runtime.agentId,
    agentAuthorizationRevision: authorizationRevision(0),
    agentRuntimeGeneration: runtime.generation,
    agentSignerKeyId: signer.principal.signerKeyId,
    agentSignerPublicKey: signer.publicKey,
    namespaceId: namespaceId(UUID),
    namespaceAccessRevision: accessRevision(2),
    namespaceKeyGeneration: namespaceGeneration(3),
    namespaceHeadDigest: hash(11),
    namespacePublicationDigest: hash(12),
    namespacePublicationSetDigest: hash(13),
    namespaceAudienceFingerprint: hash(14),
    grantDomainId: "grant_domain_retained",
    grantDomainParticipantDigest: hash(15),
    grantDomainKeyGeneration: 1,
    grantDomainHeadDigest: hash(16),
    grantDomainPublicationDigest: hash(17),
    grantDomainAuthorizationRevision: authorizationRevision(3),
    namespaceBundleGrantDomainAuthorizationRevision: authorizationRevision(3),
    namespaceBundleRevision: 1,
    namespaceBundleDigest: hash(18),
    authorization: {
      disposition: "authorization_reusable" as const,
      sessionReference: "retained-session",
      authorizationDigest: descriptorDigest,
    },
    attemptCoordinate: "retained-attempt",
    issuedAt: unixTimestamp(1_700_000_000_000),
    deadlineAt: unixTimestamp(1_700_000_030_000),
  };
  const planBytes = encodeLiveShadowMessagePlanV4(plan);
  const planDigest = crypto.hash(planBytes);
  const row: ConversationProductDatabaseRow = {
    execution_id: plan.operationId,
    operation_id: plan.operationId,
    session_id: plan.sessionId,
    room_id: plan.roomId,
    agent_id: runtime.agentId,
    agent_runtime_generation: runtime.generation,
    agent_signer_key_id: signer.principal.signerKeyId,
    agent_signer_public_key: signer.publicKey,
    plan_bytes: planBytes,
    plan_digest: planDigest,
    authorized_at: "2023-11-14T22:13:20.000Z",
    invocation_id: "invocation-retained",
    execution_kind: "turn",
    policy_revision: plan.policyRevision,
    invoking_human_id: plan.subjectHumanId,
    invoking_device_id: "source-device-retained",
    authorization_device_id: plan.committerDeviceId,
    client_action_session_id: "client-action-retained",
    input_count: 1,
    input_set_digest: inputSetDigest,
    joined_invocation_id: "invocation-retained",
    invocation_session_id: "20000000-0000-4000-8000-000000000002",
    invocation_room_id: plan.roomId,
    invocation_invoking_human_id: plan.subjectHumanId,
    invocation_invoking_device_id: "source-device-retained",
    invocation_authorization_device_id: plan.committerDeviceId,
    invocation_client_action_session_id: "client-action-retained",
    invocation_policy_revision: plan.policyRevision,
    invocation_input_count: 1,
    invocation_input_set_digest: inputSetDigest,
    invocation_authorized_at: "2023-11-14T22:13:20.000Z",
    invocation_authorization_digest: invocationDigest,
    authorization_digest: null,
    grant_digest: descriptorDigest,
    human_request_digest: hash(19),
  };
  return { crypto, runtime, signer, row, plan, planBytes, planDigest };
}

async function resolve(
  input: ReturnType<typeof fixture>,
  batches: Array<readonly ConversationProductDatabaseRow[]>,
) {
  const connection = new ScriptedConnection([
    [{ current_user: "nautilo", session_user: "nautilo" }], ...batches,
  ]);
  const product = await verifyConversationProductPostgresHandle(connection);
  const resolver = createPostgresForegroundAgentSignerResolver({
    product, crypto: input.crypto,
  });
  const key = await resolver(input.signer.principal);
  return { key, queries: connection.queries.slice(1) };
}

describe("retained foreground Agent signer", () => {
  test.each(["accepted", "missing", "substituted-plan", "substituted-principal", "bad-signature"] as const)(
    "background Agent V2 input reuses exact retained foreground evidence: %s", async mode => {
      const f = fixture();
      const encrypted = encryptObjectPayload(f.crypto, {objectId: objectId("foreground-input"), keyClass: "ai",
        objectType: "agent-message", createdAt: f.plan.createdAt}, new TextEncoder().encode("accepted foreground result"));
      const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
      const envelopeBytes = encodeNamespaceObjectEnvelopeV2(wrapObjectDekForNamespace(f.crypto, hash(20), {
        objectId: objectId("foreground-input"), namespaceId: f.plan.namespaceId, keyClass: "ai",
        keyGeneration: namespaceGeneration(0), bindingRevisionAtWrap: accessRevision(0)}, encrypted.dek));
      encrypted.dek.fill(0);
      const signed = createAgentObjectAccessManifest(f.crypto, {objectId: objectId("foreground-input"),
        payloadHash: f.crypto.hash(payloadBytes), accessRevision: accessRevision(0), previousManifestHash: null,
        envelopeHashes: [f.crypto.hash(envelopeBytes)], signer: f.signer.principal,
        hostAuthorizationRevision: authorizationRevision(0)}, f.runtime);
      let manifestBytes = signed.bytes;
      if (mode === "bad-signature") {
        const decoded = decodeObjectAccessManifestV3(manifestBytes); decoded.signature[0]! ^= 1;
        manifestBytes = encodeObjectAccessManifestV3(decoded);
      }
      const acceptedRow = {...f.row,
        ...(mode === "substituted-plan" ? {plan_digest: hash(99)} : {}),
        ...(mode === "substituted-principal" ? {agent_signer_key_id: "other"} : {})};
      const product = await verifyConversationProductPostgresHandle(new ScriptedConnection([
        [{current_user: "nautilo", session_user: "nautilo"}], ...(mode === "missing" ? [[], []] : [[acceptedRow]]),
      ]));
      const resolver = createPostgresForegroundAgentSignerResolver({product, crypto: f.crypto});
      let historyReads = 0;
      const query: CryptoPostgresExecutor["query"] = <Row>(statement: string) => {
        const sql = statement.replaceAll('"', "").toLowerCase();
        let rows: unknown[];
        if (sql.includes("current_user")) rows = [{current_user: "nautilo_crypto", session_user: "nautilo_crypto"}];
        else if (sql.includes("from crypto_objects")) rows = [{object_id: "foreground-input", payload_hash: f.crypto.hash(payloadBytes), payload_bytes: payloadBytes}];
        else if (sql.includes("from object_crypto_access_heads")) rows = [{object_id: "foreground-input", access_revision: 0,
          manifest_hash: f.crypto.hash(manifestBytes), previous_manifest_hash: null, payload_hash: f.crypto.hash(payloadBytes), manifest_bytes: manifestBytes}];
        else if (sql.includes("from object_crypto_namespace_envelopes")) rows = [{namespace_id: f.plan.namespaceId, ordinal: 0,
          envelope_hash: f.crypto.hash(envelopeBytes), envelope_bytes: envelopeBytes}];
        else if (sql.includes("from agent_crypto_runtime_signers")) {historyReads++; rows = [];}
        else throw new Error(`Unexpected input query: ${statement}`);
        return Promise.resolve(rows as Row[]);
      };
      const connection: CryptoPostgresConnection = {query, transaction: use => use({query})};
      const handle = await verifyCryptoPostgresHandle(connection);
      const port = createPostgresProcessorTransformObjectPort({handle, crypto: f.crypto, resolveLiveShadowAgentSigner: resolver});
      const result = port.openInput({objectId: "foreground-input", signal: new AbortController().signal});
      if (mode === "accepted") {
        expect((await result).payload.context.objectId).toBe(objectId("foreground-input"));
        expect(historyReads).toBe(0);
      } else {
        const error: unknown = await result.then(() => null, (cause: unknown) => cause);
        expect(error).toBeInstanceOf(Error);
        expect(historyReads).toBe(mode === "bad-signature" ? 0 : 1);
      }
    });
  test("detaches postgres-js Buffer evidence before cleanup and repeated reads", async () => {
    const input = fixture();
    const row = {
      ...input.row,
      agent_signer_public_key: Buffer.from(input.signer.publicKey),
      plan_bytes: Buffer.from(input.planBytes),
      plan_digest: Buffer.from(input.planDigest),
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await resolve(input, [[row]]);
      expect(result.key).toEqual(input.signer.publicKey);
      expect(Uint8Array.from(row.agent_signer_public_key)).toEqual(Uint8Array.from(input.signer.publicKey));
      expect(Uint8Array.from(row.plan_bytes)).toEqual(Uint8Array.from(input.planBytes));
      expect(Uint8Array.from(row.plan_digest)).toEqual(Uint8Array.from(input.planDigest));
    }
  });

  test("returns exact accepted plan evidence for portable Memory verification", async () => {
    const input = fixture();
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo", session_user: "nautilo" }],
      [input.row],
    ]);
    const product = await verifyConversationProductPostgresHandle(connection);
    const resolveEvidence =
      createPostgresForegroundAgentAcceptedExecutionEvidenceResolver({
        product, crypto: input.crypto,
      });
    const evidence = await resolveEvidence(input.signer.principal);
    expect(evidence?.signerPublicKey).toEqual(input.signer.publicKey);
    expect(evidence?.planBytes).toEqual(input.planBytes);
    expect(evidence?.planDigest).toEqual(input.planDigest);
  });

  test("accepts invocation-backed turn evidence with independent grant digest and per-Agent session", async () => {
    const input = fixture();
    expect(input.row["invocation_authorization_digest"]).not.toEqual(
      input.plan.authorization.disposition === "authorization_reusable"
        ? input.plan.authorization.authorizationDigest
        : null,
    );
    expect(input.row["invocation_session_id"]).not.toBe(input.row["session_id"]);
    const result = await resolve(input, [[input.row]]);
    expect(result.key).toEqual(input.signer.publicKey);
    for (const alias of [
      "joined_invocation_id",
      "invocation_session_id",
      "invocation_room_id",
      "invocation_invoking_human_id",
      "invocation_invoking_device_id",
      "invocation_authorization_device_id",
      "invocation_client_action_session_id",
      "invocation_policy_revision",
      "invocation_input_count",
      "invocation_input_set_digest",
      "invocation_authorized_at",
      "invocation_authorization_digest",
    ]) expect(result.queries[0]).toContain(alias);
  });

  test("accepts invocation-backed resume only when execution and invocation sessions agree", async () => {
    const input = fixture();
    expect((await resolve(input, [[{
      ...input.row,
      execution_kind: "resume",
      invocation_session_id: input.plan.sessionId,
    }]])).key).toEqual(input.signer.publicKey);
    expect((await resolve(input, [[{
      ...input.row,
      execution_kind: "resume",
    }]])).key).toBeNull();
  });
  for (const state of ["running", "completed", "failed"] as const) {
    test(`resolves accepted ${state} execution after plan expiry/restart`, async () => {
      const input = fixture();
      const result = await resolve(input, [[{ ...input.row, state }]]);
      expect(result.key).toEqual(input.signer.publicKey);
      expect(result.queries).toHaveLength(1);
      expect(result.queries[0]).toContain('"authorized_at" is not null');
      expect(result.queries[0]).not.toContain('"state"');
      expect(result.queries[0]).toContain('order by "conversation_shared_agent_shadow_executions"."sequence" desc limit');
    });
  }

  test("resolves legacy per-execution acceptance and earlier single turn", async () => {
    const input = fixture();
    expect((await resolve(input, [[{
      ...input.row,
      invocation_id: null,
      joined_invocation_id: null,
      invocation_authorization_digest: null,
      authorization_digest: input.row["grant_digest"]!,
    }]])).key).toEqual(input.signer.publicKey);
    const single = await resolve(input, [[], [input.row]]);
    expect(single.key).toEqual(input.signer.publicKey);
    expect(single.queries[1]).toContain('"grant_digest" is not null');
    expect(single.queries[1]).toContain('"human_request_digest" is not null');
  });

  test("legacy shared evidence still rejects a reusable descriptor digest mismatch", async () => {
    const input = fixture();
    expect((await resolve(input, [[{
      ...input.row,
      invocation_id: null,
      joined_invocation_id: null,
      invocation_authorization_digest: null,
      authorization_digest: hash(99),
    }]])).key).toBeNull();
  });

  for (const [field, value] of [
    ["invocation_id", ""],
    ["joined_invocation_id", null],
    ["joined_invocation_id", ""],
    ["joined_invocation_id", "cross-invocation"],
    ["invocation_authorized_at", null],
    ["invocation_authorization_digest", null],
    ["invocation_authorization_digest", new Uint8Array(31)],
    ["execution_kind", "invalid"],
    ["policy_revision", 5],
    ["invocation_policy_revision", 5],
    ["invocation_session_id", null],
    ["invocation_session_id", ""],
    ["invocation_room_id", "cross-room"],
    ["invoking_human_id", "cross-human"],
    ["authorization_device_id", "cross-device"],
    ["invocation_invoking_human_id", "cross-human"],
    ["invocation_invoking_device_id", "cross-source-device"],
    ["invocation_authorization_device_id", "cross-device"],
    ["invocation_client_action_session_id", "cross-client-action"],
    ["input_count", 0],
    ["input_count", 1.5],
    ["invocation_input_count", 2],
    ["input_set_digest", new Uint8Array(31)],
    ["invocation_input_set_digest", new Uint8Array(31)],
    ["invocation_input_set_digest", hash(99)],
  ] as const) {
    test(`rejects inconsistent invocation-backed record: ${field}=${String(value)}`, async () => {
      const input = fixture();
      expect((await resolve(input, [[{
        ...input.row,
        [field]: value,
      }]])).key).toBeNull();
    });
  }

  test("missing principal has no legacy Runtime-registry fallback", async () => {
    const result = await resolve(fixture(), [[], []]);
    expect(result.key).toBeNull();
    expect(result.queries).toHaveLength(2);
    expect(result.queries.join(" ")).not.toContain("agent_crypto_runtime_signers");
  });

  for (const [field, value] of [
    ["authorized_at", null],
    ["invocation_authorization_digest", null],
    ["plan_digest", hash(99)],
    ["plan_bytes", new Uint8Array([1, 2])],
    ["execution_id", "substituted-execution"],
    ["agent_id", "substituted-agent"],
    ["agent_runtime_generation", 99],
    ["agent_signer_key_id", "substituted-signer"],
    ["agent_signer_public_key", hash(99)],
  ] as const) {
    test(`rejects inconsistent accepted record: ${field}`, async () => {
      const input = fixture();
      expect((await resolve(input, [[{
        ...input.row, [field]: value,
      }]])).key).toBeNull();
    });
  }

  test("rejects a validly encoded substituted principal and recomputed digest", async () => {
    const input = fixture();
    const bytes = encodeLiveShadowMessagePlanV4({
      ...input.plan,
      recipientAgentId: agentId("different-agent"),
    });
    expect((await resolve(input, [[{
      ...input.row, plan_bytes: bytes, plan_digest: input.crypto.hash(bytes),
    }]])).key).toBeNull();
  });
});
