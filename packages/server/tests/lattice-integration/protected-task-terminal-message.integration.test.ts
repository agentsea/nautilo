import { createHash, randomUUID } from "node:crypto";

import { beforeEach, describe, expect, test } from "bun:test";
import {
  BACKGROUND_AUTHORIZATION_COLLECTION_LIMITS,
  agentCryptoRuntimeSigners,
  agentCryptoRuntimeStates,
  backgroundCryptoAuthorizationRequests,
  createDirectDb,
  createPostgresJsBridgeConnection,
  cryptoObjects,
  encryptionTransitionPolicy,
  eq,
  getEncryptionTransitionPolicy,
  getSharedDirectCryptoDb,
  objectCryptoAccessHeads,
  objectCryptoAccessManifests,
  objectCryptoNamespaceEnvelopes,
  resolveAppDatabaseConnectionString,
  taskTerminalMessageCryptoStagingReceipts,
  type PostgresJsBridgeConnection,
  type PostgresJsBridgeExecutor,
} from "@nautilo/db";
import { assertFixtureDbMutationAllowed } from "@nautilo/db/testing";
import {
  deriveMessageCryptoObjectIdV2,
  encodeMessagePayloadV2,
} from "@nautilo/lattice-bridge";
import {
  inspectStagedTaskTerminalMessagePublication,
  stageNativeTaskTerminalMessagePublication,
  verifyCryptoPostgresHandle,
  type NativeTaskTerminalMessageCurrentAuthority,
  type NativeTaskTerminalMessageIntent,
} from "@nautilo/lattice-bridge/server";
import {
  LatticeCrypto,
  TaskRuntimeRecipientRegistry,
  accessRevision,
  agentId,
  authorizationRevision,
  createDomainForegroundAuthorizationPlan,
  cryptoDeviceId,
  cryptoDomainId,
  domainNamespaceRetainedAuthoritySetDigest,
  humanId,
  mintDomainForegroundAuthorization,
  namespaceGeneration,
  namespaceId,
  prepareAgentRuntimeInitialization,
  prepareDomainNamespaceBundle,
  type DomainForegroundSecretEntry,
} from "@nautilo/lattice-crypto";
import {
  createTaskRuntimeBackgroundAuthorizationRequestV1,
  encodeTaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import {
  DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2,
  DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2,
  encodeAgentRuntimeSignerPublicationV1,
  parseDomainForegroundAuthorizationPlanV2,
  serializeDomainForegroundAuthorizationV2,
} from "@nautilo/lattice-crypto/wire";
import {
  attachBackgroundAuthorizationRecipient,
  claimTaskRuntimeBackgroundAuthorizationRequest,
  createBackgroundAuthorizationTaskRuntimeRequestV3,
  markBackgroundAuthorizationGrantReady,
  markBackgroundAuthorizationRunning,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
} from "@nautilo/runtime";
import { createProtectedTaskTerminalMessageComposition } from
  "../../src/routes/protected-task-terminal-message-composition";

const ENABLE_ENV = "NAUTILO_PROTECTED_TASK_TERMINAL_MESSAGE_INTEGRATION";
const EXPECTED_INSTANCE_ENV = "NAUTILO_PROTECTED_TASK_QA_INSTANCE";
const EXPECTED_POSTGRES_PORT_ENV = "NAUTILO_PROTECTED_TASK_QA_POSTGRES_PORT";
const SERVER_SCOPE = "https://task-terminal-message.integration.test";

function assertExactTarget(): void {
  if (process.env[ENABLE_ENV] !== "1") return;
  const expectedInstanceId = process.env[EXPECTED_INSTANCE_ENV];
  const expectedPostgresPort = process.env[EXPECTED_POSTGRES_PORT_ENV];
  if (!expectedInstanceId || !/^qa-[a-z0-9-]+$/u.test(expectedInstanceId)
    || process.env["NAUTILO_INSTANCE_ID"] !== expectedInstanceId
    || !expectedPostgresPort) {
    throw new Error(
      `${ENABLE_ENV}=1 requires an explicitly bound disposable QA instance and PostgreSQL port`,
    );
  }
  assertFixtureDbMutationAllowed();
  const product = new URL(resolveAppDatabaseConnectionString());
  const cryptoRaw = process.env["DB_CRYPTO_CONNECTION_STRING"];
  if (!cryptoRaw) throw new Error("DB_CRYPTO_CONNECTION_STRING is required");
  const crypto = new URL(cryptoRaw);
  for (const [url, user] of [[product, "nautilo"], [crypto, "nautilo_crypto"]] as const) {
    if (!['postgres:', 'postgresql:'].includes(url.protocol)
      || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)
      || url.port !== expectedPostgresPort || url.username !== user
      || url.password.length === 0 || url.pathname !== "/nautilo") {
      throw new Error(
        "Protected Task terminal Message integration requires the exact local QA product and crypto roles",
      );
    }
  }
}

assertExactTarget();
const describePostgres = process.env[ENABLE_ENV] === "1"
  ? describe.serial
  : describe.skip;

let now = Date.now();
beforeEach(() => { now = Date.now(); });

const bytes = (value: number): Uint8Array => new Uint8Array(32).fill(value);

function borrowedConnection(
  executor: PostgresJsBridgeExecutor,
): PostgresJsBridgeConnection {
  const transaction: PostgresJsBridgeConnection["transaction"] = use =>
    use(executor);
  const transactionOnce: PostgresJsBridgeConnection["transactionOnce"] =
    use => use(executor);
  return Object.freeze({
    query: executor.query.bind(executor),
    transaction,
    transactionOnce,
  });
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function createFixture() {
  const admin = createDirectDb(2);
  const restricted = createPostgresJsBridgeConnection(getSharedDirectCryptoDb());
  const handle = await verifyCryptoPostgresHandle(restricted);
  const crypto = new LatticeCrypto(undefined, { now: () => now });
  const taskId = randomUUID();
  const taskRunId = randomUUID();
  const requesterHumanId = randomUUID();
  const destinationRoomId = randomUUID();
  const destinationNamespaceId = randomUUID();
  const domainId = randomUUID();
  const signerAgentId = randomUUID();
  const sessionId = randomUUID();
  const deviceId = `terminal-message-device:${randomUUID()}`;
  const requestId = `task-run-delivery-message-authorization:${taskRunId}`;
  const claimId = `terminal-message-claim:${taskRunId}`;
  const deadline = now + 5 * 60_000;
  const issuer = crypto.generateSigningKeyPair();
  const manager = crypto.generateSigningKeyPair();
  const domainKey = bytes(0x41);
  const generationKey = bytes(0x42);
  const retained = Object.freeze([Object.freeze({
    generation: namespaceGeneration(0),
    accessRevision: accessRevision(0),
    headDigest: bytes(0x43),
    generationKey,
  })]);
  const retainedAuthoritySetDigest = domainNamespaceRetainedAuthoritySetDigest(
    crypto, retained,
  );
  const domain = Object.freeze({
    domainId,
    sourceNamespaceId: destinationNamespaceId,
    participantDigest: crypto.hash(new TextEncoder().encode(requesterHumanId)),
    participantCount: 1,
    keyClass: "ai" as const,
    domainKeyGeneration: 4,
    authorizationRevision: authorizationRevision(9),
    headDigest: crypto.hash(new TextEncoder().encode(domainId)),
    activeNamespaceBindingSetDigest: bytes(0x63),
    activeNamespaceBindingCount: 1,
  });
  const domainSecret: DomainForegroundSecretEntry = Object.freeze({
    ...domain,
    domainKey,
  });
  const namespaceCurrent = Object.freeze({
    serverId: SERVER_SCOPE,
    cryptoDomainId: cryptoDomainId(domainId),
    participantDigest: domain.participantDigest,
    participantCount: 1,
    keyClass: "ai" as const,
    domainKeyGeneration: 4,
    domainAuthorizationRevision: authorizationRevision(9),
    domainHeadDigest: domain.headDigest,
    namespaceId: namespaceId(destinationNamespaceId),
    namespaceAccessRevision: accessRevision(0),
    namespaceCurrentGeneration: namespaceGeneration(0),
    bundleRevision: 1,
    retainedAuthoritySetDigest,
  });
  const native = prepareDomainNamespaceBundle(crypto, {
    operationId: `terminal-message-binding:${taskRunId}`,
    previousBindingDigest: null,
    bundle: {
      ...namespaceCurrent,
      formatVersion: DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2,
      purpose: DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2,
      retainedGenerationCount: 1,
      retainedGenerations: retained,
    },
    issuerHumanId: humanId(requesterHumanId),
    issuerDeviceId: cryptoDeviceId(deviceId),
    issuerDeviceSigningGeneration: 1,
    issuerSigningPrivateKey: issuer.privateKey,
    issuerSigningPublicKey: issuer.publicKey,
    domainKey,
    issuedAt: now,
  });
  const initialized = await prepareAgentRuntimeInitialization({
    crypto,
    operationId: `terminal-message-runtime:${taskRunId}`,
    agentId: agentId(signerAgentId),
    authorizationRevision: authorizationRevision(7),
    configObjects: [{
      objectId: `terminal-message-agent-config:${taskRunId}`,
      configRevision: authorizationRevision(1),
      plaintextDek: bytes(0x21),
    }],
    domains: [],
    resolveCurrentDomainCommitterAuthority: () => null,
    manager: {
      managerHumanId: humanId(requesterHumanId),
      managerAuthorizationRevision: authorizationRevision(2),
      managerDeviceId: cryptoDeviceId(deviceId),
    },
    managerSigningPrivateKey: manager.privateKey,
    resolveCurrentManagerAuthority: () => manager.publicKey,
  });

  const coordinate = Object.freeze({ sessionId, messageId: 17, revision: 0 });
  const objectId = deriveMessageCryptoObjectIdV2(coordinate);
  const payloadBytes = encodeMessagePayloadV2({
    role: "assistant",
    content: "The background task was cancelled. Nothing from this Task is still running.",
  });
  const payloadDigest = crypto.hash(payloadBytes);
  payloadBytes.fill(0);
  const message = Object.freeze({
    taskId,
    taskRunId,
    bindingId: `task-run-output:${taskRunId}`,
    messageOperationId: `task-run-delivery-message:${taskRunId}`,
    ...coordinate,
    objectId,
    roomId: destinationRoomId,
    namespaceId: destinationNamespaceId,
    domainId,
    mode: "encrypted_only" as const,
    acceptedPolicyRevision: 6,
    publicationPolicyRevision: 7,
    signerAgentId,
    payloadDigest,
  });
  const namespaceRequirements = Object.freeze([Object.freeze({
    ordinal: 0,
    namespaceId: destinationNamespaceId,
    domainId,
    operations: Object.freeze(["encrypt"] as const),
    expectedAccessRevision: 0,
    expectedPolicyRevision: 7,
  })]);
  const authorizationPlan = createDomainForegroundAuthorizationPlan(crypto, {
    authorizationId: requestId,
    policyRevision: 7,
    sessionId: `task-terminal-message:${taskRunId}`,
    roomId: destinationRoomId,
    subjectHumanId: humanId(requesterHumanId),
    committerDeviceId: cryptoDeviceId(deviceId),
    committerDeviceSigningGeneration: 1,
    hostAuthorizationRevision: authorizationRevision(5),
    recipientKind: "runtime",
    recipientPrincipalId: "nautilo_task_runtime",
    recipientAuthorizationRevision: authorizationRevision(0),
    recipientRuntimeGeneration: 0,
    recipientKeyId: `terminal-message-recipient:${taskRunId}`,
    operations: ["encrypt"],
    issuedAt: now,
    deadlineAt: deadline,
    maximumSecretBytes: 4_096,
    domains: [domain],
  });
  const recipients = new TaskRuntimeRecipientRegistry(crypto, { now: () => now });
  const attempt = await recipients.createAttempt({
    requestId,
    workId: taskRunId,
    recipientGeneration: 0,
    recipientKeyId: authorizationPlan.recipientKeyId,
    expiresAt: deadline,
  });
  if (attempt.status !== "created") throw new Error("Terminal Message recipient unavailable");
  const exactRequest = createTaskRuntimeBackgroundAuthorizationRequestV1({
    requestId,
    workId: taskRunId,
    workKind: "task.deliver_message",
    workPurpose: "task.deliver_message",
    recipientGeneration: 0,
    episodeId: authorizationPlan.sessionId,
    sourceRoomId: destinationRoomId,
    recipientKeyId: attempt.attempt.recipientKeyId,
    recipientPublicKey: attempt.attempt.recipientPublicKey,
    authorizationPlan,
    issuedAt: now,
    deadlineAt: deadline,
  });
  const parsedPlan = parseDomainForegroundAuthorizationPlanV2(
    exactRequest.authorizationPlanBytes,
  );
  if (parsedPlan === null) throw new Error("Terminal Message authorization plan is invalid");
  const authorization = await mintDomainForegroundAuthorization(crypto, {
    plan: parsedPlan,
    domains: [domainSecret],
    committerDeviceSigningPrivateKey: issuer.privateKey,
    recipientEncryptionPublicKey: attempt.attempt.recipientPublicKey,
  });
  const authorizationBytes = serializeDomainForegroundAuthorizationV2(authorization);
  const descriptorBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV1(exactRequest);
  const descriptorDigest = Buffer.from(crypto.hash(descriptorBytes)).toString("hex");
  const responseDigest = Buffer.from(crypto.hash(authorizationBytes)).toString("hex");
  const initialRecord: BackgroundAuthorizationTaskRuntimeRecordV3 = {
    snapshot: createBackgroundAuthorizationTaskRuntimeRequestV3({
      requestId,
      workId: taskRunId,
      namespaceId: destinationNamespaceId,
      now,
    }),
    workIdentityHash: crypto.hash(new TextEncoder().encode(`terminal:${taskRunId}`)),
    idempotencyKey: `task-delivery-message:${createHash("sha256").update(taskRunId).digest("hex")}`,
    workKind: "task.deliver_message",
    purpose: "task.deliver_message",
    domainId,
    processorAuthorizationRevision: null,
    expectedDomainEpoch: 4,
    expectedNamespaceAccessRevision: 0,
    expectedPolicyRevision: 7,
    descriptorBytes: null,
    acceptedMaterial: null,
    finishedAt: null,
    authoritySet: {
      namespaceRequirements,
      domainRequirements: [{
        ordinal: 0,
        domainId,
        expectedEpoch: 4,
        expectedAuthorizationRevision: 9,
      }],
    },
  };
  const recipient = {
    recipientKeyId: attempt.attempt.recipientKeyId,
    recipientPublicKey: Buffer.from(attempt.attempt.recipientPublicKey).toString("base64url"),
    expiresAt: deadline,
  };
  const awaiting = attachBackgroundAuthorizationRecipient(initialRecord.snapshot, {
    ...recipient,
    descriptorDigest,
    recipientGeneration: 0,
    now,
  });
  const ready = markBackgroundAuthorizationGrantReady(awaiting, {
    ...recipient,
    kind: "runtime",
    requestId,
    descriptorDigest,
    responseDigest,
    credentialDigest: responseDigest,
    issuingHumanId: requesterHumanId,
    issuingDeviceId: deviceId,
    recipientGeneration: 0,
    now,
  });
  const claimed = claimTaskRuntimeBackgroundAuthorizationRequest(ready, {
    claimId,
    now,
    requestDeadlineAt: deadline,
    authorizationExpiresAt: deadline,
  });
  const snapshot = markBackgroundAuthorizationRunning(claimed, now);
  const record: BackgroundAuthorizationTaskRuntimeRecordV3 = {
    ...initialRecord,
    descriptorBytes,
    snapshot: snapshot as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
    acceptedMaterial: {
      credentialId: requestId,
      responseBytes: authorizationBytes,
      authorizationExpiresAt: deadline,
      issuingDeviceAuthorizationRevision: 5,
      issuerSigningPublicKeyHash: crypto.hash(issuer.publicKey),
    },
  };
  await admin.insert(agentCryptoRuntimeStates).values({
    agentId: signerAgentId,
    authorizationRevision: 7,
    runtimeGeneration: 0,
    configObjectCount: 1,
    configInventoryDigest: bytes(0x77),
  });
  await admin.insert(agentCryptoRuntimeSigners).values({
    ...initialized.signerPublication,
    publicationBytes: encodeAgentRuntimeSignerPublicationV1(
      initialized.signerPublication,
    ),
  });
  await admin.insert(backgroundCryptoAuthorizationRequests).values({
    requestId,
    workId: taskRunId,
    workKind: "task.deliver_message",
    purpose: "task.deliver_message",
    formatVersion: 3,
    credentialSubjectKind: "runtime",
    runtimeKind: "task",
    runtimeVersion: 1,
    workIdentityHash: record.workIdentityHash,
    idempotencyKey: record.idempotencyKey,
    namespaceId: destinationNamespaceId,
    domainId,
    expectedDomainEpoch: 4,
    expectedNamespaceAccessRevision: 0,
    expectedPolicyRevision: 7,
    recipientGeneration: 0,
    descriptorHash: crypto.hash(descriptorBytes),
    descriptorBytes,
    recipientKeyId: attempt.attempt.recipientKeyId,
    recipientPublicKey: attempt.attempt.recipientPublicKey,
    recipientExpiresAt: new Date(deadline),
    acceptedResponseKind: "runtime",
    acceptedResponseHash: crypto.hash(authorizationBytes),
    acceptedResponseBytes: authorizationBytes,
    credentialId: requestId,
    credentialHash: crypto.hash(authorizationBytes),
    issuingHumanId: requesterHumanId,
    issuingDeviceId: deviceId,
    issuingDeviceAuthorizationRevision: 5,
    issuerSigningPublicKeyHash: crypto.hash(issuer.publicKey),
    acceptedAt: new Date(now),
    authorizationExpiresAt: new Date(deadline),
    requestRevision: snapshot.requestRevision,
    state: "running",
    claimId,
    claimExpiresAt: new Date(deadline),
    retryCount: 0,
    maximumAttempts: BACKGROUND_AUTHORIZATION_COLLECTION_LIMITS.maximumAttempts,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  });

  const currentAuthority = (
    currentPolicyRevision = 7,
  ): NativeTaskTerminalMessageCurrentAuthority => Object.freeze({
    taskId,
    taskRunId,
    bindingId: message.bindingId,
    messageOperationId: message.messageOperationId,
    sessionId,
    messageId: coordinate.messageId,
    revision: 0,
    objectId,
    roomId: destinationRoomId,
    namespaceId: destinationNamespaceId,
    domainId,
    mode: "encrypted_only",
    acceptedPolicyRevision: 6,
    currentPolicyRevision,
    namespaceAccessRevision: 0,
  });

  const intent = (publicationPolicyRevision = 7): NativeTaskTerminalMessageIntent =>
    Object.freeze({
      taskId,
      taskRunId,
      bindingId: message.bindingId,
      messageOperationId: message.messageOperationId,
      sessionId,
      messageId: coordinate.messageId,
      revision: 0,
      objectId,
      roomId: destinationRoomId,
      namespaceId: destinationNamespaceId,
      domainId,
      mode: "encrypted_only",
      acceptedPolicyRevision: 6,
      publicationPolicyRevision,
      signerAgentId,
      payloadDigest: Array.from(payloadDigest, value =>
        value.toString(16).padStart(2, "0")).join(""),
      role: "assistant",
      createdAt: now,
      requestId,
    });

  const history = (context: Parameters<
    typeof inspectStagedTaskTerminalMessagePublication
  >[0]["resolveHistoricalAgentSignerAuthority"] extends (
    context: infer Context,
  ) => unknown ? Context : never) => Object.freeze({
    ...context,
    managerSigningPublicKey: manager.publicKey.slice(),
  });

  const cleanup = async (): Promise<void> => {
    await admin.delete(backgroundCryptoAuthorizationRequests).where(eq(
      backgroundCryptoAuthorizationRequests.requestId, requestId,
    ));
    await admin.delete(agentCryptoRuntimeSigners).where(eq(
      agentCryptoRuntimeSigners.agentId, signerAgentId,
    ));
    await admin.delete(agentCryptoRuntimeStates).where(eq(
      agentCryptoRuntimeStates.agentId, signerAgentId,
    ));
    await admin.delete(objectCryptoAccessHeads).where(eq(
      objectCryptoAccessHeads.objectId, objectId,
    ));
    await admin.delete(objectCryptoNamespaceEnvelopes).where(eq(
      objectCryptoNamespaceEnvelopes.objectId, objectId,
    ));
    await admin.delete(objectCryptoAccessManifests).where(eq(
      objectCryptoAccessManifests.objectId, objectId,
    ));
    await admin.delete(cryptoObjects).where(eq(cryptoObjects.objectId, objectId));
    recipients.close();
    authorizationBytes.fill(0);
    descriptorBytes.fill(0);
    domainKey.fill(0);
    generationKey.fill(0);
    initialized.runtime.key.fill(0);
    issuer.privateKey.fill(0);
    manager.privateKey.fill(0);
    await admin.end();
  };

  return {
    admin,
    restricted,
    handle,
    crypto,
    recipients,
    authorizationBytes,
    parsedPlan,
    attempt,
    record,
    message,
    namespaceRequirements,
    domain,
    domainSecret,
    namespaceCurrent,
    native,
    initialized,
    issuer,
    managerPublicKey: manager.publicKey,
    history,
    currentAuthority,
    intent,
    requestId,
    taskRunId,
    objectId,
    destinationNamespaceId,
    destinationRoomId,
    cleanup,
  };
}

async function withOpenedPublication<Value>(fixture: Fixture, operation: (
  evidence: Parameters<typeof stageNativeTaskTerminalMessagePublication>[0]["preparation"]["evidence"],
  signal: AbortSignal,
  domains: readonly DomainForegroundSecretEntry[],
) => Promise<Value>): Promise<Value> {
  const opened = await fixture.recipients.withOpenedTerminalMessageGrant({
    requestId: fixture.requestId,
    workId: fixture.taskRunId,
    recipientGeneration: 0,
    recipientKeyId: fixture.attempt.attempt.recipientKeyId,
    claimId: fixture.record.snapshot.claimId!,
    claimExpiresAt: fixture.record.snapshot.claimExpiresAt!,
    authorizationBytes: fixture.authorizationBytes,
    current: {
      authorizationId: fixture.parsedPlan.authorizationId,
      policyRevision: 7,
      sessionId: fixture.parsedPlan.sessionId,
      roomId: fixture.destinationRoomId,
      subjectHumanId: fixture.parsedPlan.subjectHumanId,
      committerDeviceId: fixture.parsedPlan.committerDeviceId,
      committerDeviceSigningGeneration: 1,
      committerDeviceSigningPublicKey: fixture.issuer.publicKey,
      committerDeviceActive: true,
      hostAuthorizationRevision: fixture.parsedPlan.hostAuthorizationRevision,
      recipientKind: "runtime",
      recipientPrincipalId: "nautilo_task_runtime",
      recipientAuthorizationRevision: authorizationRevision(0),
      recipientRuntimeGeneration: 0,
      recipientKeyId: fixture.attempt.attempt.recipientKeyId,
      recipientAuthorized: true,
      domains: [fixture.domain],
    },
    currentNamespaceRequirements: fixture.namespaceRequirements,
    message: fixture.message,
    operation: (domains, signal, evidence) => operation(evidence, signal, domains),
  });
  if (opened.status !== "opened") throw new Error(`Terminal Message grant ${opened.status}`);
  return opened.value;
}

describePostgres("protected Task terminal Message publication", () => {
  test("staging is atomic, replay-stable and accepts only the current child audience", async () => {
    const fixture = await createFixture();
    try {
      await withOpenedPublication(fixture, async (evidence, signal) => {
        const stage = (connection: PostgresJsBridgeConnection) =>
          stageNativeTaskTerminalMessagePublication({
            restricted: connection,
            preparation: {
              crypto: fixture.crypto,
              payload: {
                role: "assistant",
                content: "The background task was cancelled. Nothing from this Task is still running.",
              },
              createdAt: now,
              namespace: {
                current: fixture.namespaceCurrent,
                bindingBytes: fixture.native.bytes,
                expectedBindingDigest: fixture.native.bindingDigest,
                issuerSigningPublicKey: fixture.issuer.publicKey,
                domainKey: fixture.domainSecret.domainKey,
              },
              runtime: fixture.initialized.runtime,
              signerPublication: fixture.initialized.signerPublication,
              agentAuthorizationRevision: 7,
              resolveHistoricalSignerPublicationManager: () =>
                fixture.managerPublicKey,
              signal,
              evidence,
              resolveCurrentAuthority: authority => Promise.resolve({ ...authority }),
            },
            resolveHistoricalAgentSignerAuthority: fixture.history,
            assertCurrentClaim: () => undefined,
            resolveCurrentDeliveryAuthority: () => Promise.resolve(
              fixture.currentAuthority(),
            ),
          });

        const rollback = await fixture.restricted.transactionOnce(async tx => {
          await stage(borrowedConnection(tx));
          throw new Error("simulated terminal staging rollback");
        }).then(() => null, (error: unknown) => error);
        expect(rollback).toBeInstanceOf(Error);
        expect((rollback as Error).message).toBe("simulated terminal staging rollback");
        expect(await fixture.admin.select().from(taskTerminalMessageCryptoStagingReceipts)
          .where(eq(taskTerminalMessageCryptoStagingReceipts.requestId, fixture.requestId)))
          .toHaveLength(0);
        expect(await fixture.admin.select().from(cryptoObjects)
          .where(eq(cryptoObjects.objectId, fixture.objectId))).toHaveLength(0);

        expect(await stage(fixture.restricted)).toBe("staged");
        const first = await inspectStagedTaskTerminalMessagePublication({
          handle: fixture.handle,
          crypto: fixture.crypto,
          intent: fixture.intent(),
          currentAuthority: fixture.currentAuthority(),
          resolveHistoricalAgentSignerAuthority: fixture.history,
        });
        expect(first).not.toBeNull();
        expect(await stage(fixture.restricted)).toBe("already_staged");
        const replay = await inspectStagedTaskTerminalMessagePublication({
          handle: fixture.handle,
          crypto: fixture.crypto,
          intent: fixture.intent(),
          currentAuthority: fixture.currentAuthority(8),
          resolveHistoricalAgentSignerAuthority: fixture.history,
        });
        expect(replay?.genesisManifestHash).toEqual(first?.genesisManifestHash);
        expect(replay?.authorityFingerprint).toEqual(first?.authorityFingerprint);

        await Promise.resolve(expect(inspectStagedTaskTerminalMessagePublication({
          handle: fixture.handle,
          crypto: fixture.crypto,
          intent: fixture.intent(),
          currentAuthority: {
            ...fixture.currentAuthority(8),
            namespaceId: randomUUID(),
          },
          resolveHistoricalAgentSignerAuthority: fixture.history,
        })).rejects.toThrow("current authority is incompatible"));
        await Promise.resolve(expect(inspectStagedTaskTerminalMessagePublication({
          handle: fixture.handle,
          crypto: fixture.crypto,
          intent: fixture.intent(),
          currentAuthority: {
            ...fixture.currentAuthority(8),
            roomId: randomUUID(),
          },
          resolveHistoricalAgentSignerAuthority: fixture.history,
        })).rejects.toThrow("current authority is incompatible"));
      });
    } finally {
      await fixture.cleanup();
    }
  });

  test("Plain observation remains inactive before candidate or grant work", async () => {
    const admin = createDirectDb(1);
    const restricted = createPostgresJsBridgeConnection(getSharedDirectCryptoDb());
    const originalPolicy = await getEncryptionTransitionPolicy(admin);
    const recipients = new TaskRuntimeRecipientRegistry(new LatticeCrypto());
    let listCalls = 0;
    try {
      await admin.update(encryptionTransitionPolicy).set({
        mode: "plaintext_only",
        shadowBehavior: originalPolicy.shadowBehavior,
        revision: originalPolicy.revision + 1,
        shadowEncryptionStartedAt: null,
        updatedAt: new Date(),
      }).where(eq(encryptionTransitionPolicy.id, "server"));
      const composition = createProtectedTaskTerminalMessageComposition({
        db: admin,
        restricted,
        crypto: new LatticeCrypto(),
        owner: { runMutation: () => {
          throw new Error("Plain terminal observation reached mutation owner");
        } } as never,
        serverScope: SERVER_SCOPE,
        recipients,
        recipientTtlMs: 60_000,
      }, {
        list: async () => {
          listCalls += 1;
          throw new Error("Plain terminal observation listed protected output");
        },
      });
      expect(await composition.recoverPage({ limit: 1 })).toEqual({
        attempted: 0,
        published: 0,
        wakesScheduled: 0,
        pending: 0,
        failures: 0,
      });
      expect(listCalls).toBe(0);
    } finally {
      await admin.update(encryptionTransitionPolicy).set({
        mode: originalPolicy.mode,
        shadowBehavior: originalPolicy.shadowBehavior,
        revision: originalPolicy.revision,
        shadowEncryptionStartedAt: originalPolicy.shadowEncryptionStartedAt,
        updatedAt: originalPolicy.updatedAt,
      }).where(eq(encryptionTransitionPolicy.id, "server"));
      recipients.close();
      await admin.end();
    }
  });
});
