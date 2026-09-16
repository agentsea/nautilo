import { randomUUID } from "node:crypto";

import { expect } from "bun:test";
import {
  type PostgresJsBridgeConnection,
  type PostgresJsBridgeExecutor,
  type PostgresJsBridgeRow,
  type PostgresJsBridgeScalar,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  createDomainForegroundAuthorizationPlan,
  DeviceProviderStateVault,
  domainNamespaceGenerationHeadDigest,
  domainNamespaceRetainedAuthoritySetDigest,
  encodeHumanDeviceGroupHead,
  generateDomainKey,
  humanId,
  humanAiReadableLiveShadowExecutionInputSetDigest,
  HumanDeviceOpenMlsGroup,
  LatticeCrypto,
  mintDomainForegroundAuthorization,
  namespaceGeneration,
  namespaceId,
  prepareDomainKeyAcknowledgement,
  prepareDomainKeyHead,
  prepareDomainKeyRecipientAuthorization,
  prepareDomainKeyRecipientEnvelope,
  prepareDomainNamespaceBundle,
  unixTimestamp,
  withOpenedDomainForegroundAuthorization,
  type DomainForegroundAuthorityEntry,
  type DomainForegroundAuthorizationCurrentAuthority,
} from "@nautilo/lattice-crypto";
import {
  decodeHumanAiReadableLiveShadowMessagePlanV1,
  decodeLiveShadowMessagePlanV4,
  destroyDomainForegroundAuthorizationPlanV2,
  destroyDomainForegroundAuthorizationV2,
  destroyDomainKeyHeadV2,
  destroyDomainKeyRecipientAuthorizationV2,
  destroyDomainKeyRecipientEnvelopeV2,
  parseDomainForegroundAuthorizationPlanV2,
  serializeDomainForegroundAuthorizationPlanV2,
  serializeDomainForegroundAuthorizationV2,
} from "@nautilo/lattice-crypto/wire";
import {
  createPostgresDomainKeyV2LiveShadowCurrentAuthority,
  LiveShadowRecipientRegistry,
  PostgresDomainKeyAuthorityRepository,
  PostgresHumanDeviceGroupRepository,
  PostgresLiveShadowTurnPlanner,
  PostgresNamespaceProductAuthority,
  PostgresSharedAgentLiveShadowPlanner,
  verifyCryptoPostgresHandle,
  type LiveShadowReusableForegroundAuthorization,
} from "@nautilo/lattice-bridge/server";
import postgres from "postgres";

bootstrapTestDbInstance();

type SqlClient = postgres.Sql;
type SqlExecutor = Pick<SqlClient, "unsafe">;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required for the Postgres integration suite`);
  }
  return value;
}

function assertSameClone(...connections: readonly string[]): void {
  const [first, ...rest] = connections.map((value) => new URL(value));
  if (
    first === undefined
    || rest.some((value) =>
      value.hostname !== first.hostname
      || value.port !== first.port
      || value.pathname !== first.pathname
    )
  ) throw new Error("Integration database URLs do not identify one clone");
}

const adminUrl = requiredEnvironment("LATTICE_BRIDGE_TEST_ADMIN_DATABASE_URL");
const productUrl = requiredEnvironment("LATTICE_BRIDGE_TEST_APP_DATABASE_URL");
const cryptoUrl = requiredEnvironment("LATTICE_BRIDGE_TEST_DATABASE_URL");
assertSameClone(adminUrl, productUrl, cryptoUrl);

const admin = postgres(adminUrl, { max: 1, prepare: false });
const product = postgres(productUrl, { max: 2, prepare: false });
const restricted = postgres(cryptoUrl, { max: 2, prepare: false });

export async function closeVisibilityGrantFixtureConnections(): Promise<void> {
  await Promise.all([admin.end(), product.end(), restricted.end()]);
}

function detachRows<Row extends PostgresJsBridgeRow>(
  rows: readonly Record<string, unknown>[],
): readonly Row[] {
  return rows.map((row) => Object.fromEntries(
    Object.entries(row).map(([name, value]) => [
      name,
      value instanceof Uint8Array ? value.slice() : value,
    ]),
  ) as Row);
}

function executor(client: SqlExecutor): PostgresJsBridgeExecutor {
  return Object.freeze({
    query: async <Row extends PostgresJsBridgeRow = PostgresJsBridgeRow>(
      statement: string,
      parameters: readonly PostgresJsBridgeScalar[] = [],
    ): Promise<readonly Row[]> => detachRows<Row>(await client.unsafe(
      statement,
      parameters.map((value) => value instanceof Date
        ? value.toISOString()
        : value) as unknown as postgres.ParameterOrJSON<never>[],
    )),
  });
}

function connection(client: SqlClient): PostgresJsBridgeConnection {
  const transaction = <Result>(
    callback: (value: PostgresJsBridgeExecutor) => Promise<Result>,
    options?: Readonly<{ isolationLevel: "serializable" | "read committed" }>,
  ): Promise<Result> => options === undefined
    ? client.begin((value) => callback(executor(value))) as unknown as Promise<Result>
    : client.begin(
      `isolation level ${options.isolationLevel}`,
      (value) => callback(executor(value)),
    ) as unknown as Promise<Result>;
  return Object.freeze({
    ...executor(client),
    transaction,
    transactionOnce: transaction,
  });
}

function digest(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function orderedNamespaceIds(): readonly [string, string] {
  const suffix = randomUUID().replaceAll("-", "").slice(-12);
  return [
    `10000000-0000-4000-8000-${suffix}`,
    `20000000-0000-4000-8000-${suffix}`,
  ];
}

export type PublicRoomGrantVisibilityFixture = Readonly<{
  crypto: LatticeCrypto;
  repository: PostgresDomainKeyAuthorityRepository;
  namespaceProduct: PostgresNamespaceProductAuthority;
  userId: string;
  peerUserId: string;
  humanId: string;
  peerHumanId: string;
  agentId: string;
  roomId: string;
  targetRoomId: string;
  namespaceId: string;
  targetNamespaceId: string;
  deviceId: string;
  sessionId: string;
  policyRevision: number;
  hostAuthorizationRevision: number;
  serverId: string;
  now: number;
  signing: Readonly<{ publicKey: Uint8Array; privateKey: Uint8Array }>;
  domainKey: Uint8Array;
  domainId: string;
  membershipVault: DeviceProviderStateVault;
  originalPolicy: Readonly<{
    mode: string;
    shadowBehavior: string;
    shadowEncryptionStartedAt: Date | null;
  }>;
}>;

async function publishNamespaceBundle(
  fixture: Omit<PublicRoomGrantVisibilityFixture, "domainId">,
  targetNamespaceId: string,
  generationFill: number,
): Promise<void> {
  const plan = await fixture.namespaceProduct.withCurrentReadableNamespace({
    subjectUserId: fixture.userId,
    subjectHumanId: fixture.humanId,
    sourceRoomId: fixture.roomId,
    namespaceId: targetNamespaceId,
    keyClass: "ai",
    use: (authority) => fixture.repository.planNamespaceBundle({
      authority,
      keyClass: "ai",
      clientDeviceId: fixture.deviceId,
    }),
  });
  expect(plan?.status).toBe("create_required");
  if (plan?.status !== "create_required") {
    throw new Error("M314 Namespace bundle plan missing");
  }
  const generationKey = new Uint8Array(32).fill(generationFill);
  const headDigest = domainNamespaceGenerationHeadDigest(fixture.crypto, {
    serverId: fixture.serverId,
    namespaceId: namespaceId(plan.namespaceId),
    keyClass: plan.keyClass,
    accessRevision: accessRevision(plan.namespaceAccessRevision),
    generation: namespaceGeneration(0),
    previousHeadDigest: null,
    generationKey,
  });
  const retained = [Object.freeze({
    generation: namespaceGeneration(0),
    accessRevision: accessRevision(plan.namespaceAccessRevision),
    headDigest,
    generationKey,
  })];
  const retainedDigest = domainNamespaceRetainedAuthoritySetDigest(
    fixture.crypto,
    retained,
  );
  const bundle = prepareDomainNamespaceBundle(fixture.crypto, {
    operationId: `m314-visibility-bundle:${randomUUID()}`,
    bundle: {
      formatVersion: 2,
      purpose: "domain_key.namespace_bundle",
      serverId: fixture.serverId,
      cryptoDomainId: cryptoDomainId(plan.domainId),
      participantDigest: plan.participantDigest,
      participantCount: plan.participantCount,
      keyClass: plan.keyClass,
      domainKeyGeneration: plan.domainKeyGeneration,
      domainAuthorizationRevision: authorizationRevision(
        plan.domainAuthorizationRevision,
      ),
      domainHeadDigest: plan.domainHeadDigest,
      namespaceId: namespaceId(plan.namespaceId),
      namespaceAccessRevision: accessRevision(plan.namespaceAccessRevision),
      namespaceCurrentGeneration: namespaceGeneration(
        plan.namespaceCurrentGeneration,
      ),
      bundleRevision: plan.bundleRevision,
      retainedGenerationCount: retained.length,
      retainedAuthoritySetDigest: retainedDigest,
      retainedGenerations: retained,
    },
    previousBindingDigest: plan.previousBindingDigest,
    issuerHumanId: humanId(plan.issuerHumanId),
    issuerDeviceId: cryptoDeviceId(plan.issuerDeviceId),
    issuerDeviceSigningGeneration: plan.issuerDeviceSigningGeneration,
    issuerSigningPrivateKey: fixture.signing.privateKey,
    issuerSigningPublicKey: fixture.signing.publicKey,
    domainKey: fixture.domainKey,
    issuedAt: fixture.now + 10,
  });
  try {
    expect((await fixture.namespaceProduct.withCurrentReadableNamespace({
      subjectUserId: fixture.userId,
      subjectHumanId: fixture.humanId,
      sourceRoomId: fixture.roomId,
      namespaceId: targetNamespaceId,
      keyClass: "ai",
      use: (authority) => fixture.repository.publishNamespaceBundle({
        authority,
        keyClass: "ai",
        clientDeviceId: fixture.deviceId,
        operationId: bundle.binding.operationId,
        idempotencyKey: `m314-visibility-bundle-request:${randomUUID()}`,
        bindingBytes: bundle.bytes,
        now: fixture.now + 11,
      }),
    }))?.status).toBe("published");
  } finally {
    generationKey.fill(0);
    headDigest.fill(0);
    retainedDigest.fill(0);
    bundle.bytes.fill(0);
  }
}

export async function createVisibilityGrantFixture(): Promise<PublicRoomGrantVisibilityFixture> {
  const crypto = new LatticeCrypto();
  const userId = randomUUID();
  const peerUserId = randomUUID();
  const humanActorId = randomUUID();
  const peerHumanId = randomUUID();
  const agentActorId = randomUUID();
  const agentId = randomUUID();
  const roomId = randomUUID();
  const targetRoomId = randomUUID();
  const [namespaceValue, targetNamespaceId] = orderedNamespaceIds();
  const sessionId = randomUUID();
  const deviceId = `electron-${randomUUID()}`;
  const now = Date.now();
  const signing = crypto.generateSigningKeyPair();
  const encryption = await crypto.generateEncryptionKeyPair();
  const recovery = await crypto.generateEncryptionKeyPair();
  const original = await admin.unsafe<{
    mode: string;
    shadow_behavior: string;
    shadow_encryption_started_at: Date | null;
  }[]>(`SELECT mode, shadow_behavior, shadow_encryption_started_at
          FROM encryption_transition_policy WHERE id = 'server'`);
  if (original[0] === undefined) throw new Error("Missing encryption policy");

  await admin.begin(async (tx) => {
    await tx.unsafe("INSERT INTO users (id, name) VALUES ($1, 'M314 Grant Human'), ($2, 'M314 Grant Peer')", [userId, peerUserId]);
    await tx.unsafe("INSERT INTO agents (id, handle) VALUES ($1, $2)", [agentId, `m314-grant-${agentId}`]);
    await tx.unsafe(
      `INSERT INTO actors (id, owner_id, display_name, trust_state, kind, agent_id)
       VALUES ($1, $2, 'M314 Grant Human', 'verified', 'user', NULL),
              ($3, $4, 'M314 Grant Peer', 'verified', 'user', NULL),
              ($5, $2, 'M314 Grant Agent', 'verified', 'agent', $6)`,
      [humanActorId, userId, peerHumanId, peerUserId, agentActorId, agentId],
    );
    await tx.unsafe(
      `INSERT INTO namespaces (id, scope, label)
       VALUES ($1, 'room', 'M314 visibility source'),
              ($2, 'room', 'M314 visibility target')`,
      [namespaceValue, targetNamespaceId],
    );
    const humans = [humanActorId, peerHumanId].sort();
    await tx.unsafe(
      `INSERT INTO rooms (
         id, owner_id, type, label, graph_thread_id, namespace_id,
         namespace_access_revision, human_actor_ids, kind, created_by
       ) VALUES
         ($1, $2, 'shared', 'M314 visibility source', $3, $4, 7,
          $5::uuid[], 'group', $6),
         ($7, $2, 'private', 'M314 visibility target', $8, $9, 7,
          $5::uuid[], 'private', $6)`,
      [roomId, userId, `m314-grant:${roomId}`, namespaceValue, humans,
        humanActorId, targetRoomId, `m314-grant:${targetRoomId}`,
        targetNamespaceId],
    );
    await tx.unsafe(
      `INSERT INTO room_members (room_id, actor_id, room_role, agent_response_mode)
       VALUES ($1, $2, 'admin', NULL), ($1, $3, 'member', NULL),
              ($1, $4, 'member', 'active'), ($5, $2, 'admin', NULL),
              ($5, $3, 'member', NULL)`,
      [roomId, humanActorId, peerHumanId, agentActorId, targetRoomId],
    );
    await tx.unsafe(
      `INSERT INTO sessions (id, thread_id, owner_id, agent_id, room_id, channel)
       VALUES ($1, $2, $3, $4, $5, 'browser')`,
      [sessionId, `m314-grant:${roomId}`, userId, agentId, roomId],
    );
    await tx.unsafe(
      `UPDATE encryption_transition_policy
          SET mode = 'shadow_encryption', revision = revision + 1,
              shadow_encryption_started_at = $1, updated_at = $1
        WHERE id = 'server'`,
      [new Date(now).toISOString()],
    );
    await tx.unsafe(
      `INSERT INTO human_crypto_custodies (
         human_id, user_id, human_actor_id, initial_installation_lineage_digest,
         state, ever_initialized_at, first_device_id,
         current_recovery_generation, current_recovery_public_key_digest,
         revision, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'active', $5, $6, 1, $7, 1, $5, $5)`,
      [humanActorId, userId, humanActorId, digest(0x11),
        new Date(now).toISOString(), deviceId,
        crypto.hash(recovery.publicKey)],
    );
    await tx.unsafe(
      `INSERT INTO human_crypto_devices (
         device_id, human_id, user_id, human_actor_id, client_kind,
         installation_lineage_digest, device_generation, signing_public_key,
         encryption_public_key, public_fingerprint, state, authorization_kind,
         recovery_generation, authorization_evidence_digest,
         key_package_generation, key_package_count, revision, created_at,
         activated_at
       ) VALUES ($1, $2, $3, $4, 'electron', $5, 1, $6, $7, $8,
         'active', 'first_bootstrap', 1, $9, 1, 0, 1, $10, $10)`,
      [deviceId, humanActorId, userId, humanActorId, digest(0x12),
        signing.publicKey, encryption.publicKey,
        crypto.hash(signing.publicKey), digest(0x13),
        new Date(now).toISOString()],
    );
    await tx.unsafe(
      `INSERT INTO human_crypto_recovery_keys (
         human_id, generation, recovery_key_id, format_version, public_key,
         public_key_digest, archive_hash, issuer_device_id, state,
         activated_at, retired_at, revision
       ) VALUES ($1, 1, $2, 1, $3, $4, $5, $6, 'current', $7, NULL, 1)`,
      [humanActorId, `recovery-${randomUUID()}`, recovery.publicKey,
        crypto.hash(recovery.publicKey), digest(0x14), deviceId,
        new Date(now).toISOString()],
    );
  });

  const [instance] = await admin.unsafe<{ server_instance_id: string }[]>(
    `SELECT server_instance_id::text FROM nautilo_instance_identity
      WHERE id = 'self'`,
  );
  if (instance === undefined) throw new Error("Missing instance identity");
  const membershipVault = DeviceProviderStateVault.fromKey(
    crypto,
    cryptoDeviceId(deviceId),
    new Uint8Array(32).fill(0x15),
  );
  const membership = new HumanDeviceOpenMlsGroup(crypto, membershipVault, {
    coordinates: {
      serverInstanceId: instance.server_instance_id,
      humanId: humanId(humanActorId),
      lineageGeneration: 1,
    },
    ownCredential: {
      formatVersion: 1,
      serverInstanceId: instance.server_instance_id,
      humanId: humanId(humanActorId),
      lineageGeneration: 1,
      deviceId: cryptoDeviceId(deviceId),
      installationLineageDigest: digest(0x12),
      deviceKeyGeneration: 1,
    },
  });
  await membership.initialize();
  const initialMembership = await membership.createInitialState();
  const productConnection = connection(product);
  const restrictedConnection = connection(restricted);
  const membershipRepository = new PostgresHumanDeviceGroupRepository(
    await verifyCryptoPostgresHandle(restrictedConnection),
    crypto,
  );
  expect(await membershipRepository.establishInitial({
    userId,
    humanId: humanActorId,
    deviceId,
    headBytes: encodeHumanDeviceGroupHead(initialMembership.head),
    rosterBytes: initialMembership.rosterBytes,
    now,
  })).toBe("created");
  const [deviceAuthority] = await admin.unsafe<{ revision: number }[]>(
    "SELECT revision FROM human_crypto_devices WHERE device_id = $1",
    [deviceId],
  );
  if (deviceAuthority === undefined) throw new Error("Missing device authority");

  const namespaceProduct = new PostgresNamespaceProductAuthority(productConnection);
  const serverId = "https://m314-grant-visibility.integration.test";
  const repository = new PostgresDomainKeyAuthorityRepository(
    restrictedConnection,
    crypto,
    serverId,
  );
  const headPlan = await namespaceProduct.withCurrentReadableNamespace({
    subjectUserId: userId,
    subjectHumanId: humanActorId,
    sourceRoomId: roomId,
    namespaceId: namespaceValue,
    keyClass: "ai",
    use: (authority) => repository.planHead({
      authority,
      keyClass: "ai",
      clientDeviceId: deviceId,
      now: now + 1,
    }),
  });
  expect(headPlan?.status).toBe("create_required");
  if (headPlan?.status !== "create_required") {
    throw new Error("M314 Domain head plan missing");
  }
  const domainKey = generateDomainKey(crypto);
  const head = prepareDomainKeyHead(crypto, {
    serverId,
    cryptoDomainId: cryptoDomainId(headPlan.domainId),
    participantDigest: headPlan.participantDigest,
    participantCount: headPlan.participantCount,
    keyClass: headPlan.keyClass,
    domainKeyGeneration: headPlan.domainKeyGeneration,
    authorizationRevision: authorizationRevision(headPlan.authorizationRevision),
    previousHeadDigest: headPlan.previousHeadDigest,
    publicationOperationId: `m314-visibility-head:${randomUUID()}`,
    issuerHumanId: humanId(headPlan.issuerHumanId),
    issuerDeviceId: cryptoDeviceId(headPlan.issuerDeviceId),
    issuerDeviceSigningGeneration: headPlan.issuerDeviceSigningGeneration,
    issuedAt: headPlan.issuedAt,
    deadlineAt: headPlan.deadlineAt,
    issuerSigningPublicKey: signing.publicKey,
    issuerSigningPrivateKey: signing.privateKey,
  });
  const deviceEnvelope = await prepareDomainKeyRecipientEnvelope(crypto, {
    head: head.head,
    headDigest: head.digest,
    recipient: {
      recipientHumanId: humanId(headPlan.issuerHumanId),
      recipientKind: "device",
      recipientKeyId: headPlan.issuerDeviceId,
      recipientKeyGeneration: headPlan.issuerDeviceSigningGeneration,
      recipientPublicKey: headPlan.recipientEncryptionPublicKey,
      recipientPublicKeyDigest: headPlan.recipientPublicKeyDigest,
    },
    domainKey,
    issuerHumanId: humanId(headPlan.issuerHumanId),
    issuerDeviceId: cryptoDeviceId(headPlan.issuerDeviceId),
    issuerDeviceSigningGeneration: headPlan.issuerDeviceSigningGeneration,
    issuerSigningPublicKey: signing.publicKey,
    issuerSigningPrivateKey: signing.privateKey,
  });
  const recoveryEnvelope = await prepareDomainKeyRecipientEnvelope(crypto, {
    head: head.head,
    headDigest: head.digest,
    recipient: {
      recipientHumanId: humanId(headPlan.issuerHumanId),
      recipientKind: "recovery",
      recipientKeyId: headPlan.recoveryKeyId,
      recipientKeyGeneration: headPlan.recoveryKeyGeneration,
      recipientPublicKey: headPlan.recoveryPublicKey,
      recipientPublicKeyDigest: headPlan.recoveryPublicKeyDigest,
    },
    domainKey,
    issuerHumanId: humanId(headPlan.issuerHumanId),
    issuerDeviceId: cryptoDeviceId(headPlan.issuerDeviceId),
    issuerDeviceSigningGeneration: headPlan.issuerDeviceSigningGeneration,
    issuerSigningPublicKey: signing.publicKey,
    issuerSigningPrivateKey: signing.privateKey,
  });
  const authorize = (envelope: typeof deviceEnvelope) =>
    prepareDomainKeyRecipientAuthorization(crypto, {
      authorizationOperationId: head.head.publicationOperationId,
      reason: "head_establishment",
      requestDigest: null,
      envelopeBytes: envelope.bytes,
      envelopeDigest: envelope.digest,
      issuerHumanId: humanId(headPlan.issuerHumanId),
      issuerDeviceId: cryptoDeviceId(headPlan.issuerDeviceId),
      issuerDeviceSigningGeneration: headPlan.issuerDeviceSigningGeneration,
      issuedAt: headPlan.issuedAt,
      deadlineAt: headPlan.deadlineAt,
      issuerSigningPublicKey: signing.publicKey,
      issuerSigningPrivateKey: signing.privateKey,
    });
  const deviceAuthorization = authorize(deviceEnvelope);
  const recoveryAuthorization = authorize(recoveryEnvelope);
  expect((await namespaceProduct.withCurrentReadableNamespace({
    subjectUserId: userId,
    subjectHumanId: humanActorId,
    sourceRoomId: roomId,
    namespaceId: namespaceValue,
    keyClass: "ai",
    use: (authority) => repository.publishHead({
      authority,
      keyClass: "ai",
      clientDeviceId: deviceId,
      operationId: head.head.publicationOperationId,
      idempotencyKey: `m314-visibility-head-request:${randomUUID()}`,
      headBytes: head.bytes,
      envelopeBytes: deviceEnvelope.bytes,
      authorizationBytes: deviceAuthorization.bytes,
      recoveryEnvelopeBytes: recoveryEnvelope.bytes,
      recoveryAuthorizationBytes: recoveryAuthorization.bytes,
      now: now + 2,
    }),
  }))?.status).toBe("published");

  const acknowledgement = prepareDomainKeyAcknowledgement(crypto, {
    formatVersion: 2,
    purpose: "domain_key.acknowledgement",
    acknowledgementId: `m314-visibility-ack:${randomUUID()}`,
    serverId,
    humanId: humanId(humanActorId),
    deviceId: cryptoDeviceId(deviceId),
    deviceSigningKeyGeneration: 1,
    cryptoDomainId: cryptoDomainId(headPlan.domainId),
    participantDigest: headPlan.participantDigest,
    participantCount: headPlan.participantCount,
    keyClass: "ai",
    domainKeyGeneration: headPlan.domainKeyGeneration,
    authorizationRevision: authorizationRevision(headPlan.authorizationRevision),
    headDigest: head.digest,
    recipientKeyId: deviceId,
    recipientKeyGeneration: 1,
    recipientPublicKeyDigest: headPlan.recipientPublicKeyDigest,
    requestDigest: null,
    envelopeDigest: deviceEnvelope.digest,
    processedDeviceRevision: Number(deviceAuthority.revision),
    issuedAt: unixTimestamp(now + 3),
    expiresAt: unixTimestamp(now + 30_000),
    signingPrivateKey: signing.privateKey,
  });
  expect((await namespaceProduct.withCurrentReadableNamespace({
    subjectUserId: userId,
    subjectHumanId: humanActorId,
    sourceRoomId: roomId,
    namespaceId: namespaceValue,
    keyClass: "ai",
    use: (authority) => repository.acknowledgeEnvelope({
      authority,
      keyClass: "ai",
      clientDeviceId: deviceId,
      acknowledgementBytes: acknowledgement.bytes,
      now: now + 4,
    }),
  }))?.status).toBe("acknowledged");

  const [policy] = await admin.unsafe<{ revision: number }[]>(
    "SELECT revision FROM encryption_transition_policy WHERE id = 'server'",
  );
  if (policy === undefined) throw new Error("Missing updated encryption policy");
  const fixtureWithoutDomain = Object.freeze({
    crypto,
    repository,
    namespaceProduct,
    userId,
    peerUserId,
    humanId: humanActorId,
    peerHumanId,
    agentId,
    roomId,
    targetRoomId,
    namespaceId: namespaceValue,
    targetNamespaceId,
    deviceId,
    sessionId,
    policyRevision: Number(policy.revision),
    hostAuthorizationRevision: Number(deviceAuthority.revision),
    serverId,
    now,
    signing,
    domainKey,
    membershipVault,
    originalPolicy: Object.freeze({
      mode: original[0].mode,
      shadowBehavior: original[0].shadow_behavior,
      shadowEncryptionStartedAt: original[0].shadow_encryption_started_at,
    }),
  });
  await publishNamespaceBundle(fixtureWithoutDomain, namespaceValue, 0x31);
  await publishNamespaceBundle(fixtureWithoutDomain, targetNamespaceId, 0x32);

  destroyDomainKeyRecipientAuthorizationV2(recoveryAuthorization.authorization);
  destroyDomainKeyRecipientAuthorizationV2(deviceAuthorization.authorization);
  destroyDomainKeyRecipientEnvelopeV2(recoveryEnvelope.envelope);
  destroyDomainKeyRecipientEnvelopeV2(deviceEnvelope.envelope);
  destroyDomainKeyHeadV2(head.head);
  acknowledgement.bytes.fill(0);
  acknowledgement.digest.fill(0);
  recoveryAuthorization.bytes.fill(0);
  recoveryAuthorization.digest.fill(0);
  deviceAuthorization.bytes.fill(0);
  deviceAuthorization.digest.fill(0);
  recoveryEnvelope.bytes.fill(0);
  recoveryEnvelope.digest.fill(0);
  deviceEnvelope.bytes.fill(0);
  deviceEnvelope.digest.fill(0);
  head.bytes.fill(0);
  head.digest.fill(0);
  encryption.privateKey.fill(0);
  recovery.privateKey.fill(0);

  return Object.freeze({
    ...fixtureWithoutDomain,
    domainId: headPlan.domainId,
  });
}

export async function destroyVisibilityGrantFixture(fixture: PublicRoomGrantVisibilityFixture): Promise<void> {
  fixture.signing.privateKey.fill(0);
  fixture.domainKey.fill(0);
  fixture.membershipVault.destroy();
  await admin.begin(async (tx) => {
    await tx.unsafe("DELETE FROM conversation_shadow_turn_operations WHERE room_id = $1", [fixture.roomId]);
    await tx.unsafe("DELETE FROM conversation_shadow_turn_plan_attempts WHERE room_id = $1", [fixture.roomId]);
    await tx.unsafe("DELETE FROM conversation_shared_agent_shadow_executions WHERE room_id = $1", [fixture.roomId]);
    await tx.unsafe("DELETE FROM conversation_shared_agent_shadow_invocations WHERE room_id = $1", [fixture.roomId]);
    await tx.unsafe("DELETE FROM conversation_shared_agent_shadow_operations WHERE room_id = $1", [fixture.roomId]);
    await tx.unsafe("DELETE FROM session_messages WHERE session_id = $1", [fixture.sessionId]);
    await tx.unsafe("DELETE FROM namespace_domain_key_heads WHERE namespace_id = ANY($1::uuid[])", [[fixture.namespaceId, fixture.targetNamespaceId]]);
    await tx.unsafe("DELETE FROM namespace_domain_key_bindings WHERE namespace_id = ANY($1::uuid[])", [[fixture.namespaceId, fixture.targetNamespaceId]]);
    await tx.unsafe("DELETE FROM domain_key_envelope_acknowledgements WHERE recipient_device_id = $1", [fixture.deviceId]);
    await tx.unsafe("DELETE FROM domain_key_recipient_envelopes WHERE issuer_human_id = $1", [fixture.humanId]);
    await tx.unsafe("DELETE FROM domain_key_heads WHERE issuer_human_id = $1", [fixture.humanId]);
    await tx.unsafe("DELETE FROM domain_key_publication_operations WHERE issuer_human_id = $1", [fixture.humanId]);
    await tx.unsafe("DELETE FROM human_crypto_device_group_acknowledgements WHERE human_id = $1", [fixture.humanId]);
    await tx.unsafe("DELETE FROM human_crypto_device_group_welcomes WHERE human_id = $1", [fixture.humanId]);
    await tx.unsafe("DELETE FROM human_crypto_device_group_commits WHERE human_id = $1", [fixture.humanId]);
    await tx.unsafe("DELETE FROM human_crypto_device_group_join_requests WHERE human_id = $1", [fixture.humanId]);
    await tx.unsafe("DELETE FROM human_crypto_device_group_heads WHERE human_id = $1", [fixture.humanId]);
    await tx.unsafe("DELETE FROM human_crypto_device_key_packages WHERE device_id = $1", [fixture.deviceId]);
    await tx.unsafe("DELETE FROM human_crypto_recovery_keys WHERE human_id = $1", [fixture.humanId]);
    await tx.unsafe("DELETE FROM human_crypto_devices WHERE human_id = $1", [fixture.humanId]);
    await tx.unsafe("DELETE FROM human_crypto_custodies WHERE human_id = $1", [fixture.humanId]);
    await tx.unsafe("DELETE FROM crypto_domains WHERE id = $1", [fixture.domainId]);
    await tx.unsafe("DELETE FROM room_members WHERE room_id = ANY($1::uuid[])", [[fixture.roomId, fixture.targetRoomId]]);
    await tx.unsafe("DELETE FROM sessions WHERE room_id = $1", [fixture.roomId]);
    await tx.unsafe("DELETE FROM rooms WHERE id = ANY($1::uuid[])", [[fixture.roomId, fixture.targetRoomId]]);
    await tx.unsafe("DELETE FROM namespaces WHERE id = ANY($1::uuid[])", [[fixture.namespaceId, fixture.targetNamespaceId]]);
    await tx.unsafe("DELETE FROM actors WHERE id = ANY($1::uuid[])", [[fixture.humanId, fixture.peerHumanId]]);
    await tx.unsafe("DELETE FROM actors WHERE agent_id = $1", [fixture.agentId]);
    await tx.unsafe("DELETE FROM agents WHERE id = $1", [fixture.agentId]);
    await tx.unsafe("DELETE FROM users WHERE id = ANY($1::uuid[])", [[fixture.userId, fixture.peerUserId]]);
    await tx.unsafe(
      `UPDATE encryption_transition_policy
          SET mode = $1, shadow_behavior = $2,
              shadow_encryption_started_at = $3,
              revision = revision + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = 'server'`,
      [fixture.originalPolicy.mode, fixture.originalPolicy.shadowBehavior,
        fixture.originalPolicy.shadowEncryptionStartedAt],
    );
  });
}

function copyDomains(
  domains: readonly DomainForegroundAuthorityEntry[],
): readonly DomainForegroundAuthorityEntry[] {
  return Object.freeze(domains.map((value) => Object.freeze({
    ...value,
    participantDigest: value.participantDigest.slice(),
    headDigest: value.headDigest.slice(),
    activeNamespaceBindingSetDigest:
      value.activeNamespaceBindingSetDigest.slice(),
  })));
}

export async function inspectVisibilityGrantDomains(
  fixture: PublicRoomGrantVisibilityFixture,
  readableNamespaceIds: readonly string[],
): Promise<readonly DomainForegroundAuthorityEntry[]> {
  const result = await fixture.namespaceProduct.withCurrentReadableNamespaceSet({
    subjectUserId: fixture.userId,
    subjectHumanId: fixture.humanId,
    sourceRoomId: fixture.roomId,
    namespaceIds: readableNamespaceIds,
    use: () => fixture.repository.inspectForegroundAuthority({
      namespaceIds: readableNamespaceIds,
      keyClass: "ai",
      subjectHumanId: fixture.humanId,
      deviceId: fixture.deviceId,
    }),
  });
  expect(result?.status).toBe("ready");
  if (result?.status !== "ready") throw new Error("Foreground authority missing");
  return copyDomains(result.domains);
}

export async function mintReusableVisibilityGrant(
  fixture: PublicRoomGrantVisibilityFixture,
  domains: readonly DomainForegroundAuthorityEntry[],
  suffix: string,
): Promise<Readonly<{
  reusable: LiveShadowReusableForegroundAuthorization;
  authorizationBytes: Uint8Array;
  recipientPrivateKey: Uint8Array;
  clientActionSessionId: string;
}>> {
  const recipient = await fixture.crypto.generateEncryptionKeyPair();
  const clientActionSessionId = `m314-visibility-action-${suffix}:${randomUUID()}`;
  const authorizationPlan = createDomainForegroundAuthorizationPlan(
    fixture.crypto,
    {
      authorizationId: `m314-visibility-${suffix}:${randomUUID()}`,
      policyRevision: fixture.policyRevision,
      sessionId: clientActionSessionId,
      roomId: fixture.roomId,
      subjectHumanId: humanId(fixture.humanId),
      committerDeviceId: cryptoDeviceId(fixture.deviceId),
      committerDeviceSigningGeneration: 1,
      hostAuthorizationRevision: authorizationRevision(
        fixture.hostAuthorizationRevision,
      ),
      recipientKind: "runtime",
      recipientPrincipalId: "nautilo_foreground_runtime",
      recipientAuthorizationRevision: authorizationRevision(0),
      recipientRuntimeGeneration: 0,
      recipientKeyId: `m314-visibility-key-${suffix}:${randomUUID()}`,
      operations: ["decrypt", "encrypt"],
      issuedAt: fixture.now + 20,
      deadlineAt: fixture.now + 5 * 60_000,
      maximumSecretBytes: 256 * 1024,
      domains,
    },
  );
  const recipientKeyId = authorizationPlan.recipientKeyId;
  const planBytes = serializeDomainForegroundAuthorizationPlanV2(
    authorizationPlan,
  );
  const minted = await mintDomainForegroundAuthorization(fixture.crypto, {
    plan: authorizationPlan,
    domains: domains.map((value) => Object.freeze({
      domainId: value.domainId,
      sourceNamespaceId: value.sourceNamespaceId,
      participantDigest: value.participantDigest,
      participantCount: value.participantCount,
      keyClass: value.keyClass,
      domainKeyGeneration: value.domainKeyGeneration,
      authorizationRevision: value.authorizationRevision,
      headDigest: value.headDigest,
      domainKey: fixture.domainKey,
    })),
    committerDeviceSigningPrivateKey: fixture.signing.privateKey,
    recipientEncryptionPublicKey: recipient.publicKey,
  });
  const authorizationBytes = serializeDomainForegroundAuthorizationV2(minted);
  destroyDomainForegroundAuthorizationV2(minted);
  destroyDomainForegroundAuthorizationPlanV2(authorizationPlan);
  return Object.freeze({
    reusable: Object.freeze({
      sessionReference: `m314-visibility-session-${suffix}`,
      authorizationDigest: fixture.crypto.hash(authorizationBytes),
      authorizationPlanBytes: planBytes,
      authorizationPlanDigest: fixture.crypto.hash(planBytes),
      recipientId: `m314-visibility-recipient-${suffix}`,
      recipientKeyId,
      recipientPublicKey: recipient.publicKey,
    }),
    authorizationBytes,
    recipientPrivateKey: recipient.privateKey,
    clientActionSessionId,
  });
}

function cloneReusable(
  value: LiveShadowReusableForegroundAuthorization,
): LiveShadowReusableForegroundAuthorization {
  return Object.freeze({
    ...value,
    authorizationDigest: value.authorizationDigest.slice(),
    authorizationPlanBytes: value.authorizationPlanBytes.slice(),
    authorizationPlanDigest: value.authorizationPlanDigest.slice(),
    recipientPublicKey: value.recipientPublicKey.slice(),
  });
}

export async function planWithReusableVisibilityGrant(
  fixture: PublicRoomGrantVisibilityFixture,
  readableNamespaceIds: readonly string[],
  grant: Awaited<ReturnType<typeof mintReusableVisibilityGrant>>,
  suffix: string,
) {
  const sharedPlanner = new PostgresSharedAgentLiveShadowPlanner(
    connection(product),
    connection(restricted),
    fixture.crypto,
    () => Promise.resolve(readableNamespaceIds),
    { serverId: fixture.serverId },
  );
  const humanResult = await sharedPlanner.plan({
    authority: { userId: fixture.userId, humanActorId: fixture.humanId },
    roomId: fixture.roomId,
    clientDeviceId: fixture.deviceId,
    idempotencyKey: `m314-visibility-human-${suffix}:${randomUUID()}`,
    now: fixture.now + 20,
  });
  expect(humanResult.status).toBe("planned");
  if (humanResult.status !== "planned") {
    throw new Error("Shared Human input was not planned");
  }
  const humanPlan = decodeHumanAiReadableLiveShadowMessagePlanV1(
    humanResult.planBytes,
  );
  const inputSetDigest = humanAiReadableLiveShadowExecutionInputSetDigest(
    fixture.crypto,
    [{ operationId: humanPlan.operationId, messageId: humanPlan.humanMessageId }],
  );
  const invocationId = randomUUID();
  const executionId = randomUUID();
  const humanRequestBytes = Uint8Array.of(1);
  const publishedAt = new Date(Date.now() + 1_000);
  const executionNow = publishedAt.getTime() + 1;
  await admin.begin(async (tx) => {
    await tx.unsafe(
      `INSERT INTO session_messages (id, session_id, role, content, created_at)
       VALUES ($1, $2::uuid, 'user', $3, $4)`,
      [humanPlan.humanMessageId, humanPlan.sessionId,
        `M314 visibility ${suffix}`, new Date(humanPlan.createdAt)],
    );
    await tx.unsafe(
      `UPDATE conversation_shared_agent_shadow_operations
          SET human_request_digest = $2, human_request_bytes = $3,
              state = 'human_verified', human_verified_at = $4,
              updated_at = $4
        WHERE operation_id = $1`,
      [humanPlan.operationId, fixture.crypto.hash(humanRequestBytes),
        humanRequestBytes, publishedAt],
    );
    await tx.unsafe(
      `UPDATE conversation_shared_agent_shadow_operations
          SET state = 'published', protected_message_digest = $2,
              final_event_digest = $3, conductor_state = 'selected',
              conductor_reason = 'agent_selected',
              conductor_resolved_at = $4, terminal_at = $4, updated_at = $4
        WHERE operation_id = $1`,
      [humanPlan.operationId, digest(0x61), digest(0x62), publishedAt],
    );
    await tx.unsafe(
      `INSERT INTO conversation_shared_agent_shadow_invocations (
         invocation_id, policy_revision, session_id, room_id,
         invoking_human_id, invoking_device_id, authorization_device_id,
         client_action_session_id, input_count, input_set_digest, state,
         deadline_at, created_at, updated_at
       ) VALUES ($1, $2, $3::uuid, $4::uuid, $5, $6, $6, $7, 1, $8,
                 'awaiting_authorization', $9, $10, $10)`,
      [invocationId, humanPlan.policyRevision, humanPlan.sessionId,
        fixture.roomId, fixture.humanId, fixture.deviceId,
        grant.clientActionSessionId, inputSetDigest,
        new Date(executionNow + 30_000), publishedAt],
    );
    await tx.unsafe(
      `INSERT INTO conversation_shared_agent_shadow_executions (
         execution_id, invocation_id, policy_revision, session_id, room_id, agent_id,
         invoking_human_id, invoking_device_id, authorization_device_id,
         client_action_session_id, execution_kind, input_count,
         input_set_digest, state, deadline_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4::uuid, $5::uuid, $6::uuid, $7, $8, $8,
                 $9, 'turn', 1, $10, 'awaiting_authorization', $11, $12, $12)`,
      [executionId, invocationId, humanPlan.policyRevision, humanPlan.sessionId,
        fixture.roomId, fixture.agentId, fixture.humanId, fixture.deviceId,
        grant.clientActionSessionId, inputSetDigest,
        new Date(executionNow + 30_000), publishedAt],
    );
    await tx.unsafe(
      `INSERT INTO conversation_shared_agent_shadow_execution_inputs (
         execution_id, input_ordinal, human_operation_id, message_id
       ) VALUES ($1, 1, $2, $3)`,
      [executionId, humanPlan.operationId, humanPlan.humanMessageId],
    );
  });
  const retainedPlan = parseDomainForegroundAuthorizationPlanV2(
    grant.reusable.authorizationPlanBytes,
  );
  if (retainedPlan === null) throw new Error("Reusable Grant plan invalid");
  let inspected = false;
  const planner = new PostgresLiveShadowTurnPlanner(
    connection(product),
    connection(restricted),
    fixture.crypto,
    new LiveShadowRecipientRegistry(() => executionNow),
    {
      serverId: fixture.serverId,
      resolveReadableNamespaces: () => Promise.resolve(readableNamespaceIds),
      foregroundAuthorizations: {
        inspectReusable: (scope) => {
          inspected = true;
          expect(scope).toMatchObject({
            subjectHumanId: fixture.humanId,
            issuingDeviceId: fixture.deviceId,
            recipientKind: "nautilo_foreground_runtime",
            browserSessionId: grant.clientActionSessionId,
            topLevelRoomId: fixture.roomId,
            namespaceIds: readableNamespaceIds,
          });
          expect(scope.domainAuthoritySetDigest).toEqual(
            retainedPlan.domainAuthoritySetDigest,
          );
          return cloneReusable(grant.reusable);
        },
      },
    },
  );
  try {
    const result = await planner.planSharedAgentExecution({
      authority: { userId: fixture.userId, humanActorId: fixture.humanId },
      executionId,
      roomId: fixture.roomId,
      agentId: fixture.agentId,
      clientActionSessionId: grant.clientActionSessionId,
      clientDeviceId: fixture.deviceId,
      now: executionNow,
    });
    expect(result.status).toBe("authorized");
    expect(inspected).toBe(true);
    if (result.status !== "authorized") {
      throw new Error("Shared foreground execution was not authorized");
    }
    return decodeLiveShadowMessagePlanV4(result.planBytes);
  } finally {
    destroyDomainForegroundAuthorizationPlanV2(retainedPlan);
    inputSetDigest.fill(0);
    humanRequestBytes.fill(0);
  }
}

export async function createVisibilityGrantCurrentAuthority(
  fixture: PublicRoomGrantVisibilityFixture,
  plan: ReturnType<typeof decodeLiveShadowMessagePlanV4>,
  resolveReadableNamespaces: () => readonly string[],
) {
  return createPostgresDomainKeyV2LiveShadowCurrentAuthority({
    product: connection(product),
    restricted: connection(restricted),
    crypto: fixture.crypto,
    serverId: fixture.serverId,
    plan,
    representationMode: "shadow_encryption",
    source: "shared_execution",
    resolveReadableNamespaces: () => Promise.resolve(
      resolveReadableNamespaces(),
    ),
    now: () => fixture.now + 25,
  });
}

export async function openVisibilityGrant(
  fixture: PublicRoomGrantVisibilityFixture,
  authority: NonNullable<Awaited<ReturnType<typeof createVisibilityGrantCurrentAuthority>>>,
  grant: Awaited<ReturnType<typeof mintReusableVisibilityGrant>>,
) {
  const current = await authority.resolveCurrentForegroundAuthorization();
  if (current === null) return null;
  return openVisibilityGrantAgainstCurrent(fixture, current, grant);
}

export async function openVisibilityGrantAgainstCurrent(
  fixture: PublicRoomGrantVisibilityFixture,
  current: Omit<
    DomainForegroundAuthorizationCurrentAuthority,
    "recipientEncryptionPrivateKey"
  >,
  grant: Awaited<ReturnType<typeof mintReusableVisibilityGrant>>,
) {
  return withOpenedDomainForegroundAuthorization(fixture.crypto, {
    authorizationBytes: grant.authorizationBytes,
    now: fixture.now + 25,
    current: Object.freeze({
      ...current,
      recipientEncryptionPrivateKey: grant.recipientPrivateKey,
    }),
    operation: (domains) => domains.map((value) => Object.freeze({
      domainId: value.domainId,
      participantCount: value.participantCount,
      headDigest: value.headDigest.slice(),
    })),
  });
}

export function destroyVisibilityGrant(
  grant: Awaited<ReturnType<typeof mintReusableVisibilityGrant>>,
): void {
  grant.reusable.authorizationDigest.fill(0);
  grant.reusable.authorizationPlanBytes.fill(0);
  grant.reusable.authorizationPlanDigest.fill(0);
  grant.reusable.recipientPublicKey.fill(0);
  grant.authorizationBytes.fill(0);
  grant.recipientPrivateKey.fill(0);
}


export type PublicRoomVisibilitySnapshot = Readonly<{
  namespace_id: string;
  namespace_access_revision: number;
  human_actor_ids: string[];
  kind: string;
}>;

export async function readVisibilitySourceRoom(
  fixture: PublicRoomGrantVisibilityFixture,
): Promise<PublicRoomVisibilitySnapshot> {
  const rows = await admin.unsafe<PublicRoomVisibilitySnapshot[]>(
    `SELECT namespace_id::text, namespace_access_revision,
            human_actor_ids::text[], kind
       FROM rooms WHERE id = $1`,
    [fixture.roomId],
  );
  if (rows[0] === undefined) throw new Error("Visibility source Room missing");
  return Object.freeze(rows[0]);
}

export async function makeVisibilitySourcePublic(
  fixture: PublicRoomGrantVisibilityFixture,
): Promise<void> {
  await admin.unsafe("UPDATE rooms SET kind = 'open' WHERE id = $1", [
    fixture.roomId,
  ]);
}
