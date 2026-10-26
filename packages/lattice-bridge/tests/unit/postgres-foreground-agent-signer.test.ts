import { rejects } from "node:assert/strict";
import { captureForegroundTaskDefinitionAuthor, foregroundAgentAcceptedExecutionSigner } from "../../src/server/message/postgres-foreground-agent-signer.ts";
import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto, createAgentObjectAccessManifest, encryptObjectPayload, wrapObjectDekForNamespace, objectId,
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  createDomainForegroundAuthorizationPlan,
  cryptoDeviceId,
  deriveAgentRuntimeObjectSignerPublic,
  humanId,
  namespaceGeneration,
  namespaceId,
  unixTimestamp,
} from "@nautilo/lattice-crypto";
import {encodeEncryptedPayloadV2, encodeNamespaceObjectEnvelopeV2, encodeObjectAccessManifestV3, decodeObjectAccessManifestV3, destroyDomainForegroundAuthorizationPlanV2, encodeLiveShadowMessagePlanV4, parseDomainForegroundAuthorizationPlanV2, serializeDomainForegroundAuthorizationPlanV2 } from "@nautilo/lattice-crypto/wire";
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
const AUTHORITY_ROOM = "20000000-0000-4000-8000-000000000002";
const TASK_DOMAIN = "domain:task-definition-private";
const TASK_NAMESPACE = "30000000-0000-4000-8000-000000000003";
const ACCEPTED_GRANT_ISSUED_AT = 1_700_000_010_000;
const ACCEPTED_GRANT_DEADLINE_AT = 1_700_000_120_000;
const hash = (marker: number) => new Uint8Array(32).fill(marker);

class ScriptedConnection implements ConversationProductPostgresConnection {
  readonly queries: string[] = [];
  readonly parameterSets: Array<Parameters<ConversationProductPostgresConnection["query"]>[1]> = [];
  constructor(readonly batches: Array<readonly ConversationProductDatabaseRow[]>) {}
  query<Row extends ConversationProductDatabaseRow>(
    statement: string,
    parameters?: Parameters<ConversationProductPostgresConnection["query"]>[1],
  ) {
    this.queries.push(statement);
    this.parameterSets.push(parameters?.map(value => value instanceof Uint8Array ? value.slice() : value));
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

test.each(["shared", "legacy"] as const)("Task parent selection constrains the %s receipt before newest-record selection", async family => {
  const input = fixture();
  const parentOperationHash = input.crypto.hash(new TextEncoder().encode(
    `nautilo/task-definition-parent-operation/v1\n${input.plan.operationId}`,
  ));
  const connection = new ScriptedConnection([
    [{ current_user: "nautilo", session_user: "nautilo" }],
    ...(family === "shared" ? [[input.row]] : [[], [legacyPlanRow(input)]]),
  ]);
  const product = await verifyConversationProductPostgresHandle(connection);
  const evidence = await createPostgresForegroundAgentAcceptedExecutionEvidenceResolver({
    product, crypto: input.crypto, rejectInvalidSelectedEvidence: true,
  })(input.signer.principal, { parentOperationHash });
  expect(evidence?.signerPublicKey).toEqual(input.signer.publicKey);
  for (let index = 1; index < connection.queries.length; index += 1) {
    const query = connection.queries[index]!;
    expect(query).toContain("sha256(convert_to(");
    expect(query.indexOf("sha256(convert_to(")).toBeLessThan(query.indexOf("order by"));
    expect(connection.parameterSets[index]).toContain("nautilo/task-definition-parent-operation/v1\n");
    expect(connection.parameterSets[index]?.some(value => value instanceof Uint8Array
      && Buffer.from(value).equals(Buffer.from(parentOperationHash)))).toBe(true);
  }
  evidence?.signerPublicKey.fill(0);
  evidence?.planBytes.fill(0);
  evidence?.planDigest.fill(0);
  parentOperationHash.fill(0);
});

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
  const authorizationPlan = createDomainForegroundAuthorizationPlan(crypto, {
    authorizationId: "authorization-retained",
    policyRevision: plan.policyRevision,
    sessionId: "client-action-retained",
    roomId: AUTHORITY_ROOM,
    subjectHumanId: plan.subjectHumanId,
    committerDeviceId: plan.committerDeviceId,
    committerDeviceSigningGeneration:
      plan.committerDeviceSigningKeyGeneration,
    hostAuthorizationRevision: plan.hostAuthorizationRevision,
    recipientKind: "runtime",
    recipientPrincipalId: "nautilo_foreground_runtime",
    recipientAuthorizationRevision: authorizationRevision(0),
    recipientRuntimeGeneration: 0,
    recipientKeyId: "runtime-recipient-retained",
    operations: ["decrypt", "encrypt"],
    issuedAt: unixTimestamp(ACCEPTED_GRANT_ISSUED_AT),
    deadlineAt: unixTimestamp(ACCEPTED_GRANT_DEADLINE_AT),
    maximumSecretBytes: 4_096,
    domains: [{
      domainId: TASK_DOMAIN,
      sourceNamespaceId: namespaceId(TASK_NAMESPACE),
      participantDigest: hash(31),
      participantCount: 1,
      keyClass: "ai",
      domainKeyGeneration: 1,
      authorizationRevision: authorizationRevision(2),
      headDigest: hash(32),
      activeNamespaceBindingSetDigest: hash(33),
      activeNamespaceBindingCount: 1,
    }],
  });
  const authorizationPlanBytes =
    serializeDomainForegroundAuthorizationPlanV2(authorizationPlan);
  destroyDomainForegroundAuthorizationPlanV2(authorizationPlan);
  const authorizationPlanDigest = crypto.hash(authorizationPlanBytes);
  plan.authorization.sessionReference = "accepted-runtime-session";
  plan.authorization.authorizationDigest = Uint8Array.from(invocationDigest);
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
    invocation_authorization_plan_bytes: authorizationPlanBytes,
    invocation_authorization_plan_digest: authorizationPlanDigest,
    invocation_recipient_key_id: "runtime-recipient-retained",
    invocation_authorization_disposition: "establish",
    invocation_authorization_session_reference: "accepted-runtime-session",
    execution_authorization_plan_bytes: null,
    execution_authorization_plan_digest: null,
    execution_recipient_key_id: null,
    execution_authorization_disposition: null,
    execution_authorization_session_reference: null,
    source_room_id: plan.roomId,
    source_room_parent_id: AUTHORITY_ROOM,
    authorization_digest: null,
    grant_digest: descriptorDigest,
    human_request_digest: hash(19),
  };
  return { crypto, runtime, signer, row, plan, planBytes, planDigest,
    authorizationPlanBytes, authorizationPlanDigest };
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

async function resolveEvidence(
  input: ReturnType<typeof fixture>,
  row: ConversationProductDatabaseRow,
) {
  const connection = new ScriptedConnection([
    [{ current_user: "nautilo", session_user: "nautilo" }],
    [row],
  ]);
  const product = await verifyConversationProductPostgresHandle(connection);
  return createPostgresForegroundAgentAcceptedExecutionEvidenceResolver({
    product,
    crypto: input.crypto,
  })(input.signer.principal);
}

function authorizationRow(
  input: ReturnType<typeof fixture>,
  change: (plan: NonNullable<ReturnType<
    typeof parseDomainForegroundAuthorizationPlanV2
  >>) => NonNullable<ReturnType<
    typeof parseDomainForegroundAuthorizationPlanV2
  >>,
): ConversationProductDatabaseRow {
  const decoded = parseDomainForegroundAuthorizationPlanV2(
    input.authorizationPlanBytes,
  );
  if (decoded === null) throw new Error("Authorization fixture is malformed");
  const changed = change(decoded);
  const bytes = serializeDomainForegroundAuthorizationPlanV2(changed);
  const digest = input.crypto.hash(bytes);
  destroyDomainForegroundAuthorizationPlanV2(decoded);
  if (changed !== decoded) destroyDomainForegroundAuthorizationPlanV2(changed);
  return { ...input.row,
    invocation_authorization_plan_bytes: bytes,
    invocation_authorization_plan_digest: digest };
}

function legacyPlanRow(input: ReturnType<typeof fixture>): ConversationProductDatabaseRow {
  const planBytes = encodeLiveShadowMessagePlanV4({
    ...input.plan,
    authorization: {
      disposition: "authorization_reusable",
      sessionReference: "retained-session",
      authorizationDigest: input.row["grant_digest"] as Uint8Array,
    },
  });
  return {
    ...input.row,
    plan_bytes: planBytes,
    plan_digest: input.crypto.hash(planBytes),
  };
}

function legacyAuthorRow(input: ReturnType<typeof fixture>): ConversationProductDatabaseRow {
  const recipientKeyId = "agent-recipient-retained";
  const authorization = createDomainForegroundAuthorizationPlan(input.crypto, {
    authorizationId: "authorization-legacy-retained",
    policyRevision: input.plan.policyRevision,
    sessionId: input.plan.sessionId,
    roomId: input.plan.roomId,
    subjectHumanId: input.plan.subjectHumanId,
    committerDeviceId: input.plan.committerDeviceId,
    committerDeviceSigningGeneration:
      input.plan.committerDeviceSigningKeyGeneration,
    hostAuthorizationRevision: input.plan.hostAuthorizationRevision,
    recipientKind: "agent",
    recipientPrincipalId: input.runtime.agentId,
    recipientAuthorizationRevision: input.plan.agentAuthorizationRevision,
    recipientRuntimeGeneration: input.runtime.generation,
    recipientKeyId,
    operations: ["decrypt", "encrypt"],
    issuedAt: input.plan.issuedAt,
    deadlineAt: input.plan.deadlineAt,
    maximumSecretBytes: 4_096,
    domains: [{
      domainId: TASK_DOMAIN,
      sourceNamespaceId: namespaceId(TASK_NAMESPACE),
      participantDigest: hash(31),
      participantCount: 1,
      keyClass: "ai",
      domainKeyGeneration: 1,
      authorizationRevision: authorizationRevision(2),
      headDigest: hash(32),
      activeNamespaceBindingSetDigest: hash(33),
      activeNamespaceBindingCount: 1,
    }],
  });
  const bytes = serializeDomainForegroundAuthorizationPlanV2(authorization);
  destroyDomainForegroundAuthorizationPlanV2(authorization);
  return {
    ...legacyPlanRow(input),
    agent_grant_plan_bytes: bytes,
    agent_grant_plan_digest: input.crypto.hash(bytes),
    recipient_key_id: recipientKeyId,
  };
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

  test("projects the exact accepted grant lifetime even when it outlives the V4 descriptor", async () => {
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
    expect(input.plan.deadlineAt).toBeLessThan(ACCEPTED_GRANT_DEADLINE_AT);
    expect(evidence?.acceptedAuthority).toEqual({
      subjectHumanId: input.plan.subjectHumanId,
      authorizedNamespaces: [{ namespaceId: TASK_NAMESPACE, domainId: TASK_DOMAIN }],
      grantLifetime: {
        issuedAt: ACCEPTED_GRANT_ISSUED_AT,
        deadlineAt: ACCEPTED_GRANT_DEADLINE_AT,
      },
    });
  });

  for (const disposition of ["establish", "reuse"] as const) {
    test(`accepted ${disposition} execution binds the retained session and authorization digest`, async () => {
      const input = fixture();
      const row = { ...input.row,
        invocation_authorization_disposition: disposition };
      expect((await resolveEvidence(input, row))?.acceptedAuthority).toEqual({
        subjectHumanId: input.plan.subjectHumanId,
        authorizedNamespaces: [{ namespaceId: TASK_NAMESPACE, domainId: TASK_DOMAIN }],
        grantLifetime: {
          issuedAt: ACCEPTED_GRANT_ISSUED_AT,
          deadlineAt: ACCEPTED_GRANT_DEADLINE_AT,
        },
      });
      for (const invalid of [
        { ...row, invocation_authorization_session_reference: "another-session" },
        { ...row, invocation_authorization_digest: hash(95) },
      ]) {
        const evidence = await resolveEvidence(input, invalid);
        expect(evidence?.signerPublicKey).toEqual(input.signer.publicKey);
        expect(evidence?.acceptedAuthority).toBeUndefined();
        expect(evidence?.acceptedAuthority?.grantLifetime).toBeUndefined();
      }
    });
  }

  test("retained pending establishment descriptors still bind the exact V2 plan", async () => {
    const input = fixture();
    const planBytes = encodeLiveShadowMessagePlanV4({ ...input.plan,
      authorization: { disposition: "authorization_reusable",
        sessionReference: "pending:authorization-retained",
        authorizationDigest: input.authorizationPlanDigest } });
    const evidence = await resolveEvidence(input, { ...input.row,
      plan_bytes: planBytes, plan_digest: input.crypto.hash(planBytes) });
    expect(evidence?.acceptedAuthority).toEqual({
      subjectHumanId: input.plan.subjectHumanId,
      authorizedNamespaces: [{ namespaceId: TASK_NAMESPACE, domainId: TASK_DOMAIN }],
      grantLifetime: {
        issuedAt: ACCEPTED_GRANT_ISSUED_AT,
        deadlineAt: ACCEPTED_GRANT_DEADLINE_AT,
      },
    });
  });

  test("cross-Agent definition authority binds retained Human, Domain, session, room, recipient, and digest", async () => {
    const input = fixture();
    const malformedPlanBytes = new Uint8Array([0xff]);
    const changedPlans = [
      { ...input.plan.authorization, sessionReference: "pending:other" },
      { ...input.plan.authorization, authorizationDigest: hash(98) },
    ].map(authorization => {
      const planBytes = encodeLiveShadowMessagePlanV4({
        ...input.plan,
        authorization,
      });
      return { ...input.row, plan_bytes: planBytes,
        plan_digest: input.crypto.hash(planBytes) };
    });
    const invalidRows = [
      { ...input.row,
        client_action_session_id: "wrong-session",
        invocation_client_action_session_id: "wrong-session" },
      { ...input.row, source_room_parent_id: "wrong-room" },
      { ...input.row, invocation_recipient_key_id: "wrong-recipient" },
      { ...input.row, invocation_authorization_plan_digest: hash(99) },
      { ...input.row,
        invocation_authorization_plan_bytes: malformedPlanBytes,
        invocation_authorization_plan_digest:
          input.crypto.hash(malformedPlanBytes) },
      authorizationRow(input, plan => Object.freeze({
        ...plan,
        subjectHumanId: humanId("other-human"),
      })),
      ...changedPlans,
    ];
    for (const row of invalidRows) {
      const evidence = await resolveEvidence(input, row);
      expect(evidence?.signerPublicKey).toEqual(input.signer.publicKey);
      expect(evidence?.acceptedAuthority).toBeUndefined();
      expect(evidence?.acceptedAuthority?.grantLifetime).toBeUndefined();
    }
    const product = await verifyConversationProductPostgresHandle(
      new ScriptedConnection([
        [{ current_user: "nautilo", session_user: "nautilo" }],
        [input.row],
      ]),
    );
    const captured = captureForegroundTaskDefinitionAuthor({
      resolveEvidence:
        createPostgresForegroundAgentAcceptedExecutionEvidenceResolver({
          product,
          crypto: input.crypto,
        }),
      subjectHumanId: input.plan.subjectHumanId,
      namespaceId: "namespace:not-authorized",
      domainId: TASK_DOMAIN,
    });
    await captured.resolveEvidence(input.signer.principal);
    expect(captured.authorizes(input.signer.principal)).toBe(false);

    const taskAuthorization = captureForegroundTaskDefinitionAuthor({
      resolveEvidence: captured.resolveEvidence,
      resolveTaskDefinitionForegroundAuthorization: async (evidence) => {
        expect(evidence.principal).toEqual(input.signer.principal);
        expect(evidence.objectId).toBe("task-definition:v1:object");
        return input.signer.publicKey.slice();
      },
      subjectHumanId: input.plan.subjectHumanId,
      namespaceId: "namespace:not-authorized",
      domainId: TASK_DOMAIN,
    });
    expect(taskAuthorization.authorizes(input.signer.principal)).toBe(false);
    expect(await taskAuthorization
      .resolveTaskDefinitionForegroundAuthorization({
        principal: input.signer.principal,
        authorizationHash: hash(91),
        objectId: "task-definition:v1:object",
        authorizationBytes: new Uint8Array([1, 2, 3]),
      })).toEqual(input.signer.publicKey);
    expect(taskAuthorization.authorizes(input.signer.principal)).toBe(true);
  });

  test("same-Agent signer evidence survives missing historical Room and V2 facts", async () => {
    const input = fixture();
    const evidence = await resolveEvidence(input, {
      ...input.row,
      source_room_id: null,
      source_room_parent_id: null,
      invocation_authorization_plan_bytes: null,
      invocation_authorization_plan_digest: null,
      invocation_recipient_key_id: null,
    });
    expect(evidence?.signerPublicKey).toEqual(input.signer.publicKey);
    expect(evidence?.acceptedAuthority).toBeUndefined();
  });

  test("accepts invocation-backed turn evidence with independent grant digest and per-Agent session", async () => {
    const input = fixture();
    const descriptor = { ...input.plan, authorization: {
      disposition: "authorization_reusable" as const,
      sessionReference: "pending:authorization-retained",
      authorizationDigest: input.authorizationPlanDigest,
    } };
    const planBytes = encodeLiveShadowMessagePlanV4(descriptor);
    expect(input.row["invocation_authorization_digest"]).not.toEqual(
      descriptor.authorization.authorizationDigest,
    );
    expect(input.row["invocation_session_id"]).not.toBe(input.row["session_id"]);
    const result = await resolve(input, [[{ ...input.row,
      plan_bytes: planBytes, plan_digest: input.crypto.hash(planBytes) }]]);
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
      "invocation_authorization_plan_bytes",
      "invocation_authorization_plan_digest",
      "invocation_recipient_key_id",
      "execution_authorization_plan_bytes",
      "execution_authorization_plan_digest",
      "execution_recipient_key_id",
      "source_room_id",
      "source_room_parent_id",
    ]) expect(result.queries[0]).toContain(alias);
    expect(result.queries[0]).toContain('left join "rooms"');
    expect(result.queries[0]).not.toContain("coalesce");
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
    const legacy = legacyPlanRow(input);
    expect((await resolve(input, [[{
      ...legacy,
      invocation_id: null,
      joined_invocation_id: null,
      invocation_authorization_digest: null,
      authorization_digest: input.row["grant_digest"]!,
    }]])).key).toEqual(input.signer.publicKey);
    const single = await resolve(input, [[], [legacy]]);
    expect(single.key).toEqual(input.signer.publicKey);
    expect(single.queries[1]).toContain('"grant_digest" is not null');
    expect(single.queries[1]).toContain('"human_request_digest" is not null');
  });

  test("retains legacy single-turn author facts from Agent grant columns", async () => {
    const input = fixture();
    const row = legacyAuthorRow(input);
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo", session_user: "nautilo" }],
      [],
      [row],
    ]);
    const product = await verifyConversationProductPostgresHandle(connection);
    const evidence = await
    createPostgresForegroundAgentAcceptedExecutionEvidenceResolver({
      product,
      crypto: input.crypto,
    })(input.signer.principal);
    expect(evidence?.signerPublicKey).toEqual(input.signer.publicKey);
    expect(evidence?.acceptedAuthority).toEqual({
      subjectHumanId: input.plan.subjectHumanId,
      authorizedNamespaces: [{ namespaceId: TASK_NAMESPACE, domainId: TASK_DOMAIN }],
      grantLifetime: {
        issuedAt: input.plan.issuedAt,
        deadlineAt: input.plan.deadlineAt,
      },
    });
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


test("strict retained signer lookup rejects a selected invalid record without another-family fallback", async () => {
  const f = fixture();
  for (const shared of [true, false]) {
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo", session_user: "nautilo" }],
      ...(shared ? [] : [[]]),
      [{ ...f.row, plan_digest: hash(0) }],
    ]);
    const product = await verifyConversationProductPostgresHandle(connection);
    const resolve = createPostgresForegroundAgentAcceptedExecutionEvidenceResolver({ product, crypto: f.crypto,
      rejectInvalidSelectedEvidence: true });
    await rejects(Promise.resolve(resolve(f.signer.principal)), /Selected foreground Agent execution evidence is invalid/);
    expect(connection.batches).toHaveLength(0);
  }
});

test("Task signer adapter authenticates the entire retained plan and wipes evidence on every outcome", async () => {
  const f = fixture();
  for (const mode of ["valid", "digest", "principal", "key"] as const) {
    const evidence = { signerPublicKey: f.signer.publicKey.slice(), planBytes: f.planBytes.slice(),
      planDigest: mode === "digest" ? hash(0) : f.planDigest.slice() };
    if (mode === "key") evidence.signerPublicKey[0]! ^= 1;
    const resolve = foregroundAgentAcceptedExecutionSigner({ crypto: f.crypto, resolveEvidence: async () => evidence });
    const promise = Promise.resolve(resolve(mode === "principal"
      ? { ...f.signer.principal, agentId: "another-agent" } : f.signer.principal));
    if (mode === "valid") expect(await promise).toEqual(f.signer.publicKey);
    else await rejects(promise, /signer evidence was substituted/);
    expect(evidence.signerPublicKey.every(value => value === 0)).toBe(true);
    expect(evidence.planBytes.every(value => value === 0)).toBe(true);
    expect(evidence.planDigest.every(value => value === 0)).toBe(true);
  }
});
