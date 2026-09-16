import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

import { afterAll, describe, expect, test } from "bun:test";
import {
  type DirectDatabase,
  type PostgresJsBridgeConnection,
  type PostgresJsBridgeExecutor,
  type PostgresJsBridgeRow,
  type PostgresJsBridgeScalar,
} from "@nautilo/db";
import {
  DeviceProviderStateVault,
  HumanDeviceOpenMlsGroup,
  LatticeCrypto,
  accessRevision,
  authorizationRevision,
  createCurrentCommonProcessorObjectAccessManifest,
  prepareHumanObjectAccessManifestGenesisSet,
  cryptoDeviceId,
  cryptoDomainId,
  decryptObjectThroughNamespace,
  domainNamespaceGenerationHeadDigest,
  domainNamespaceRetainedAuthoritySetDigest,
  encodeHumanDeviceGroupHead,
  encryptObjectPayload,
  generateDomainKey,
  humanId,
  namespaceGeneration,
  namespaceId,
  objectId,
  prepareDomainKeyAcknowledgement,
  prepareDomainKeyHead,
  prepareDomainKeyRecipientAuthorization,
  prepareDomainKeyRecipientEnvelope,
  prepareDomainNamespaceBundle,
  unixTimestamp,
  wrapObjectDekForNamespace,
} from "@nautilo/lattice-crypto";
import {
  createBackgroundAuthorizationResponseV2,
  decodeBackgroundWorkDescriptorV2,
  decodeBackgroundAuthorizationResponseV2,
  encodeBackgroundWorkDescriptorV2,
  inspectBackgroundAuthorizationResponseV2,
  verifyBackgroundAuthorizationResponseV2,
  withOpenedBackgroundAuthorizationV2,
  type BackgroundAuthorizationIssuerV2,
  type BackgroundNamespaceAuthorityV2,
  type BackgroundProcessorWorkDescriptorV2,
} from "@nautilo/lattice-crypto/background";
import {
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";
import {
  deriveMemoryCryptoObjectIdV1,
  encodeMemoryPayloadV1,
  fingerprintRequiredMemoryNamespaces,
  type ForegroundAgentEntityCryptoInvocation,
  type ForegroundAgentEntityNamespaceAuthority,
} from "@nautilo/lattice-bridge";
import {
  respondToCurrentDeviceAuthorizationV2,
} from "@nautilo/lattice-bridge/client/background";
import {
  PostgresDeviceAdmissionRepository,
  PostgresDomainKeyAuthorityRepository,
  PostgresHumanDeviceGroupRepository,
  PostgresNamespaceProductAuthority,
  createPostgresForegroundJournalSelectionPort,
  loadPostgresForegroundJournalRepairSources,
  loadPostgresForegroundRecordRepairSources,
  readVerifiedDeviceWrappedAgentObject,
  validatePostgresForegroundJournalRepairSource,
  validatePostgresForegroundRecordRepairSource,
  verifyConversationProductPostgresHandle,
  verifyCryptoPostgresHandle,
} from "@nautilo/lattice-bridge/server";
import { decodeRecordPayloadV1, encodeRecordPayloadV1 } from "@nautilo/reflection-bridge";
import type { DurableSleepClaim } from "@nautilo/reflection";
import {
  createHmacRecordSemanticCommitmentPort,
  PostgresAuthorityProjectionStore,
  PostgresCurrentRecordPublicationBinding,
  PostgresRecordProductStore,
  PostgresSemanticWorkStore,
  verifyRecordProductPostgresHandle,
} from "@nautilo/reflection-bridge/server";
import {
  PostgresBackgroundAuthorizationRepository,
  attachBackgroundAuthorizationRecipient,
  claimBackgroundAuthorizationRequest,
  completeBackgroundAuthorizationRequest,
  createBackgroundAuthorizationRequestV2,
  createForegroundRecordHistoryRepairer,
  createForegroundJournalHistoryRepairer,
  createProductionReflectionMemoryRuntime,
  markBackgroundAuthorizationRunning,
  REFLECTION_SEMANTIC_RUNTIME_POLICY_V1,
  type BackgroundAuthorizationRecord,
} from "@nautilo/runtime";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { createProductionReflectionAuthorityMaintenance } from
  "../../src/reflection/protected-authority-composition";
import { createProductionProtectedReflectionSearchComposition } from
  "../../src/reflection/protected-search-composition";
import { createProductionProtectedReflectionSemantics } from
  "../../src/reflection/protected-semantic-composition";

type SqlClient = postgres.Sql;
type SqlExecutor = Pick<SqlClient, "unsafe">;
type ResponderInput = Parameters<typeof respondToCurrentDeviceAuthorizationV2>[0];
type DomainKeyAuthorityClientV2 = ResponderInput["domainAuthority"];
type DomainNamespaceAuthorityClientV2 = ResponderInput["namespaceAuthority"];
type OpenedDomainKeyAuthorityV2 = Parameters<
  Parameters<DomainKeyAuthorityClientV2["withDomainKey"]>[1]
>[1];
type OpenedDomainNamespaceAuthorityV2 = Parameters<
  Parameters<DomainNamespaceAuthorityClientV2["withOpenedGenerations"]>[1]
>[1];

type FixtureTopology =
  | "shared-domain"
  | "distinct-domain"
  | "cross-room"
  | "cross-room-memory";

function isCrossRoomTopology(topology: FixtureTopology): boolean {
  return topology === "cross-room" || topology === "cross-room-memory";
}

const ADMIN_URL = requiredEnvironment("LATTICE_BRIDGE_TEST_ADMIN_DATABASE_URL");
const PRODUCT_URL = requiredEnvironment("LATTICE_BRIDGE_TEST_APP_DATABASE_URL");
const CRYPTO_URL = requiredEnvironment("LATTICE_BRIDGE_TEST_DATABASE_URL");
const SERVER_SCOPE = process.env["NAUTILO_PUBLIC_BASE_URL"]?.trim() || "http://localhost:3001";
const RESIDUE_PATH = "/tmp/m327-protected-reflection-composition-residue.json";
process.env["DB_DIRECT_CONNECTION"] = ADMIN_URL;

const admin = postgres(ADMIN_URL, { max: 2, prepare: false });
const product = postgres(PRODUCT_URL, { max: 2, prepare: false });
const restricted = postgres(CRYPTO_URL, { max: 2, prepare: false });
const db = drizzle(product) as unknown as DirectDatabase;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function detachedRows<Row extends PostgresJsBridgeRow>(rows: readonly Record<string, unknown>[]): readonly Row[] {
  return rows.map(row => Object.fromEntries(Object.entries(row).map(([name, value]) => [
    name,
    value instanceof Uint8Array ? value.slice() : value,
  ])) as Row);
}

function executor(client: SqlExecutor): PostgresJsBridgeExecutor {
  return Object.freeze({
    query: async <Row extends PostgresJsBridgeRow = PostgresJsBridgeRow>(
      statement: string,
      parameters: readonly PostgresJsBridgeScalar[] = [],
    ): Promise<readonly Row[]> => detachedRows<Row>(await client.unsafe(
      statement,
      parameters.map(value => value instanceof Date ? value.toISOString() : value) as never,
    )),
  });
}

function connection(client: SqlClient): PostgresJsBridgeConnection {
  const transact = <Result>(
    use: (transaction: PostgresJsBridgeExecutor) => Promise<Result>,
    options?: Readonly<{ isolationLevel: "serializable" | "read committed" }>,
  ): Promise<Result> => {
    const run = (transaction: SqlExecutor) => use(executor(transaction));
    return options === undefined
      ? client.begin(run) as unknown as Promise<Result>
      : client.begin(`isolation level ${options.isolationLevel}`, run) as unknown as Promise<Result>;
  };
  return Object.freeze({ ...executor(client), transaction: transact, transactionOnce: transact });
}

function digest(label: string): Uint8Array {
  return createHash("sha256").update(label).digest();
}

function workId(recordId: string): string {
  return `reflection-authority:${createHash("sha256").update(JSON.stringify([
    "reflection-authority/v2", recordId, 1, 1, 1, 2,
  ])).digest("hex")}`;
}

type NamespaceMaterial = Readonly<{
  roomId: string;
  namespaceId: string;
  generationKey: Uint8Array;
  authority: BackgroundNamespaceAuthorityV2;
  openedNamespace: OpenedDomainNamespaceAuthorityV2;
}>;

type Fixture = Readonly<{
  topology: FixtureTopology;
  runId: string;
  userId: string;
  extraUserId: string | null;
  authorityExtraUserId: string | null;
  humanActorId: string;
  extraHumanActorId: string | null;
  authorityExtraHumanActorId: string | null;
  sourceRoomId: string;
  sourceNamespaceId: string;
  authorityRoomId: string;
  authorityNamespaceId: string;
  accessRoomId: string;
  accessNamespaceId: string;
  recordId: string;
  batchId: string;
  deviceId: string;
  domainId: string;
  sourceObjectId: string;
  signing: Readonly<{ publicKey: Uint8Array; privateKey: Uint8Array }>;
  domainKey: Uint8Array;
  targetDomainKey: Uint8Array;
  namespaces: ReadonlyMap<string, NamespaceMaterial>;
  domainAuthority: OpenedDomainKeyAuthorityV2;
  targetDomainAuthority: OpenedDomainKeyAuthorityV2;
  domainMaterials: ReadonlyMap<string, Readonly<{
    key: Uint8Array;
    authority: OpenedDomainKeyAuthorityV2;
  }>>;
  provisionAccessNamespace(): Promise<void>;
  provisionNamespace(coordinate: Readonly<{
    roomId: string;
    namespaceId: string;
  }>): Promise<void>;
  policyRevision: number;
  policyMode: string;
  now: number;
}>;

async function currentPolicy(): Promise<{mode: string; revision: number}> {
  const [row] = await admin.unsafe<{ mode: string; revision: number }[]>(
    "SELECT mode, revision FROM encryption_transition_policy WHERE id = 'server'",
  );
  if (row === undefined || row.mode === "plaintext_only") {
    throw new Error("Owned M327 clone must have protected encryption enabled");
  }
  return {mode: row.mode, revision: Number(row.revision)};
}

async function establishFixture(
  crypto: LatticeCrypto,
  topology: FixtureTopology,
): Promise<Fixture> {
  const runId = randomUUID();
  const userId = randomUUID();
  const extraUserId = topology === "shared-domain" ? null : randomUUID();
  const authorityExtraUserId = isCrossRoomTopology(topology) ? randomUUID() : null;
  const humanActorId = randomUUID();
  const sourceRoomId = randomUUID();
  const sourceNamespaceId = randomUUID();
  const authorityRoomId = topology === "shared-domain" ? sourceRoomId : randomUUID();
  const authorityNamespaceId = topology === "shared-domain" ? sourceNamespaceId : randomUUID();
  const accessRoomId = randomUUID();
  const accessNamespaceId = randomUUID();
  const recordId = randomUUID();
  const batchId = randomUUID();
  const deviceId = `m327-device-${runId}`;
  const sourceObjectId = `m327-source-${runId}`;
  const extraHumanActorId = topology === "shared-domain" ? null : randomUUID();
  const authorityExtraHumanActorId = isCrossRoomTopology(topology) ? randomUUID() : null;
  const sourceHumanActorIds = extraHumanActorId === null
    ? [humanActorId]
    : [humanActorId, extraHumanActorId].sort();
  const authorityHumanActorIds = authorityExtraHumanActorId === null
    ? [humanActorId]
    : [humanActorId, authorityExtraHumanActorId].sort();
  const signing = crypto.generateSigningKeyPair();
  const encryption = await crypto.generateEncryptionKeyPair();
  const recovery = await crypto.generateEncryptionKeyPair();
  // Keep every injected retry time behind PostgreSQL's wall clock so this
  // deterministic test can advance the durable continuation without sleeps.
  const now = Date.now() - 120_000;
  const {revision: policyRevision, mode: policyMode} = await currentPolicy();
  const [identity] = await admin.unsafe<{ server_instance_id: string }[]>(
    "SELECT server_instance_id::text FROM nautilo_instance_identity WHERE id = 'self'",
  );
  if (identity === undefined) throw new Error("Owned clone instance identity is missing");

  await admin.begin(async tx => {
    await tx.unsafe("INSERT INTO users (id, name) VALUES ($1, 'M327 composition integration')", [userId]);
    if (extraUserId !== null) {
      await tx.unsafe("INSERT INTO users (id, name) VALUES ($1, 'M327 source-only participant')", [extraUserId]);
    }
    if (authorityExtraUserId !== null) {
      await tx.unsafe("INSERT INTO users (id, name) VALUES ($1, 'M327 authority-only participant')", [authorityExtraUserId]);
    }
    await tx.unsafe(
      `INSERT INTO actors (id, owner_id, display_name, trust_state, kind)
       VALUES ($1, $2, 'M327 composition Human', 'verified', 'user')`,
      [humanActorId, userId],
    );
    if (extraHumanActorId !== null) {
      await tx.unsafe(
        `INSERT INTO actors (id, owner_id, display_name, trust_state, kind)
         VALUES ($1, $2, 'M327 source-only Human', 'verified', 'user')`,
        [extraHumanActorId, extraUserId],
      );
    }
    if (authorityExtraHumanActorId !== null) {
      await tx.unsafe(
        `INSERT INTO actors (id, owner_id, display_name, trust_state, kind)
         VALUES ($1, $2, 'M327 authority-only Human', 'verified', 'user')`,
        [authorityExtraHumanActorId, authorityExtraUserId],
      );
    }
    await tx.unsafe(
      `INSERT INTO namespaces (id, scope, label) VALUES
         ($1, 'room', 'M327 source'), ($2, 'private', 'M327 access')
         ${topology !== "shared-domain" ? ", ($3, 'room', 'M327 authority')" : ""}`,
      topology !== "shared-domain"
        ? [sourceNamespaceId, accessNamespaceId, authorityNamespaceId]
        : [sourceNamespaceId, accessNamespaceId],
    );
    await tx.unsafe(
      `INSERT INTO rooms (id, owner_id, type, label, graph_thread_id, namespace_id, human_actor_ids, kind, created_by)
       VALUES
         ($1, $2, 'private', 'M327 source', $3, $4, ${extraHumanActorId === null ? "ARRAY[$5::uuid]" : "ARRAY[$9::uuid, $10::uuid]"}, 'private', $5),
         ($6, $2, 'private', 'M327 access', $7, $8, ARRAY[$5::uuid], 'access', $5)`,
      extraHumanActorId === null
        ? [sourceRoomId, userId, `m327:source:${runId}`, sourceNamespaceId, humanActorId,
          accessRoomId, `record-access:${humanActorId}`, accessNamespaceId]
        : [sourceRoomId, userId, `m327:source:${runId}`, sourceNamespaceId, humanActorId,
          accessRoomId, `record-access:${humanActorId}`, accessNamespaceId, ...sourceHumanActorIds],
    );
    if (topology !== "shared-domain") {
      await tx.unsafe(
        `INSERT INTO rooms (id, owner_id, type, label, graph_thread_id, namespace_id, human_actor_ids, kind, created_by)
         VALUES ($1, $2, 'private', 'M327 authority', $3, $4,
           ${authorityExtraHumanActorId === null ? "ARRAY[$5::uuid]" : "ARRAY[$5::uuid, $6::uuid]"},
           'private', ${authorityExtraHumanActorId === null ? "$5" : "$7"})`,
        authorityExtraHumanActorId === null
          ? [authorityRoomId, userId, `m327:authority:${runId}`, authorityNamespaceId, humanActorId]
          : [authorityRoomId, userId, `m327:authority:${runId}`, authorityNamespaceId,
            ...authorityHumanActorIds, humanActorId],
      );
    }
    await tx.unsafe(
      `INSERT INTO room_members (room_id, actor_id, room_role)
       VALUES ($1, $3, 'admin'), ($2, $3, 'admin')
         ${topology !== "shared-domain" ? ", ($4, $3, 'admin'), ($1, $5, 'member')" : ""}
         ${authorityExtraHumanActorId === null ? "" : ", ($4, $6, 'member')"}`,
      topology !== "shared-domain"
        ? [sourceRoomId, accessRoomId, humanActorId, authorityRoomId, extraHumanActorId,
          ...(authorityExtraHumanActorId === null ? [] : [authorityExtraHumanActorId])]
        : [sourceRoomId, accessRoomId, humanActorId],
    );
    await tx.unsafe(
      `INSERT INTO human_crypto_custodies (
         human_id, user_id, human_actor_id, initial_installation_lineage_digest,
         state, ever_initialized_at, first_device_id, current_recovery_generation,
         current_recovery_public_key_digest, revision, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'active', $5, $6, 1, $7, 1, $5, $5)`,
      [humanActorId, userId, humanActorId, digest(`lineage:${runId}`), new Date(now).toISOString(), deviceId,
        crypto.hash(recovery.publicKey)],
    );
    await tx.unsafe(
      `INSERT INTO human_crypto_devices (
         device_id, human_id, user_id, human_actor_id, client_kind,
         installation_lineage_digest, device_generation, signing_public_key,
         encryption_public_key, public_fingerprint, state, authorization_kind,
         recovery_generation, authorization_evidence_digest, key_package_generation,
         key_package_count, revision, created_at, activated_at
       ) VALUES ($1, $2, $3, $4, 'electron', $5, 1, $6, $7, $8,
         'active', 'first_bootstrap', 1, $9, 1, 0, 1, $10, $10)`,
      [deviceId, humanActorId, userId, humanActorId, digest(`lineage:${runId}`), signing.publicKey,
        encryption.publicKey, crypto.hash(signing.publicKey), digest(`evidence:${runId}`), new Date(now).toISOString()],
    );
    await tx.unsafe(
      `INSERT INTO human_crypto_recovery_keys (
         human_id, generation, recovery_key_id, format_version, public_key,
         public_key_digest, archive_hash, issuer_device_id, state, activated_at,
         retired_at, revision
       ) VALUES ($1, 1, $2, 1, $3, $4, $5, $6, 'current', $7, NULL, 1)`,
      [humanActorId, `m327-recovery-${runId}`, recovery.publicKey, crypto.hash(recovery.publicKey),
        digest(`archive:${runId}`), deviceId, new Date(now).toISOString()],
    );
  });

  const restrictedConnection = connection(restricted);
  const vault = DeviceProviderStateVault.fromKey(
    crypto,
    cryptoDeviceId(deviceId),
    digest(`provider-state:${runId}`),
  );
  const coordinates = {
    serverInstanceId: identity.server_instance_id,
    humanId: humanId(humanActorId),
    lineageGeneration: 1,
  };
  const group = new HumanDeviceOpenMlsGroup(crypto, vault, {
    coordinates,
    ownCredential: {
      formatVersion: 1,
      ...coordinates,
      deviceId: cryptoDeviceId(deviceId),
      installationLineageDigest: digest(`lineage:${runId}`),
      deviceKeyGeneration: 1,
    },
  });
  await group.initialize();
  const initial = await group.createInitialState();
  const cryptoHandle = await verifyCryptoPostgresHandle(restrictedConnection);
  expect(await new PostgresHumanDeviceGroupRepository(cryptoHandle, crypto).establishInitial({
    userId,
    humanId: humanActorId,
    deviceId,
    headBytes: encodeHumanDeviceGroupHead(initial.head),
    rosterBytes: initial.rosterBytes,
    now,
  })).toBe("created");

  const namespaceProduct = new PostgresNamespaceProductAuthority(connection(product));
  const domains = new PostgresDomainKeyAuthorityRepository(restrictedConnection, crypto, SERVER_SCOPE);
  const withAuthority = <Value>(roomId: string, exactNamespaceId: string,
    use: Parameters<PostgresNamespaceProductAuthority["withCurrentReadableNamespace"]>[0]["use"],
  ): Promise<Value | null> => namespaceProduct.withCurrentReadableNamespace({
    subjectUserId: userId,
    subjectHumanId: humanActorId,
    sourceRoomId: roomId,
    namespaceId: exactNamespaceId,
    keyClass: "ai",
    use,
  }) as Promise<Value | null>;
  const headPlan = await withAuthority<Awaited<ReturnType<typeof domains.planHead>>>(
    sourceRoomId,
    sourceNamespaceId,
    authority => domains.planHead({ authority, keyClass: "ai", clientDeviceId: deviceId, now }),
  );
  if (headPlan?.status !== "create_required") {
    throw new Error(`M327 Domain head was not creatable: ${headPlan?.status ?? "missing"}:${
      headPlan?.status === "unavailable" ? headPlan.reason : "unexpected"}`);
  }
  const domainKey = generateDomainKey(crypto);
  const head = prepareDomainKeyHead(crypto, {
    serverId: SERVER_SCOPE,
    cryptoDomainId: cryptoDomainId(headPlan.domainId),
    participantDigest: headPlan.participantDigest,
    participantCount: headPlan.participantCount,
    keyClass: headPlan.keyClass,
    domainKeyGeneration: headPlan.domainKeyGeneration,
    authorizationRevision: authorizationRevision(headPlan.authorizationRevision),
    previousHeadDigest: headPlan.previousHeadDigest,
    publicationOperationId: `m327-head-${runId}`,
    issuerHumanId: humanId(headPlan.issuerHumanId),
    issuerDeviceId: cryptoDeviceId(headPlan.issuerDeviceId),
    issuerDeviceSigningGeneration: headPlan.issuerDeviceSigningGeneration,
    issuedAt: headPlan.issuedAt,
    deadlineAt: headPlan.deadlineAt,
    issuerSigningPublicKey: signing.publicKey,
    issuerSigningPrivateKey: signing.privateKey.slice(),
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
    issuerSigningPrivateKey: signing.privateKey.slice(),
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
    issuerSigningPrivateKey: signing.privateKey.slice(),
  });
  const authorizationFor = (envelope: typeof deviceEnvelope) =>
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
      issuerSigningPrivateKey: signing.privateKey.slice(),
    });
  const deviceAuthorization = authorizationFor(deviceEnvelope);
  const recoveryAuthorization = authorizationFor(recoveryEnvelope);
  const published = await withAuthority<Awaited<ReturnType<typeof domains.publishHead>>>(
    sourceRoomId,
    sourceNamespaceId,
    authority => domains.publishHead({
      authority,
      keyClass: "ai",
      clientDeviceId: deviceId,
      operationId: head.head.publicationOperationId,
      idempotencyKey: `m327-head-request-${runId}`,
      headBytes: head.bytes,
      envelopeBytes: deviceEnvelope.bytes,
      authorizationBytes: deviceAuthorization.bytes,
      recoveryEnvelopeBytes: recoveryEnvelope.bytes,
      recoveryAuthorizationBytes: recoveryAuthorization.bytes,
      now: now + 1,
    }),
  );
  if (published?.status !== "published") throw new Error("M327 Domain head was not published");
  const [deviceRow] = await admin.unsafe<{ device_generation: number; revision: number }[]>(
    "SELECT device_generation, revision FROM human_crypto_devices WHERE device_id = $1",
    [deviceId],
  );
  if (deviceRow === undefined) throw new Error("M327 current device is missing");
  const acknowledgement = prepareDomainKeyAcknowledgement(crypto, {
    formatVersion: 2,
    purpose: "domain_key.acknowledgement",
    acknowledgementId: `m327-ack-${runId}`,
    serverId: SERVER_SCOPE,
    humanId: humanId(humanActorId),
    deviceId: cryptoDeviceId(deviceId),
    deviceSigningKeyGeneration: Number(deviceRow.device_generation),
    cryptoDomainId: cryptoDomainId(headPlan.domainId),
    participantDigest: headPlan.participantDigest,
    participantCount: headPlan.participantCount,
    keyClass: "ai",
    domainKeyGeneration: headPlan.domainKeyGeneration,
    authorizationRevision: authorizationRevision(headPlan.authorizationRevision),
    headDigest: head.digest,
    recipientKeyId: deviceId,
    recipientKeyGeneration: Number(deviceRow.device_generation),
    recipientPublicKeyDigest: headPlan.recipientPublicKeyDigest,
    requestDigest: null,
    envelopeDigest: deviceEnvelope.digest,
    processedDeviceRevision: Number(deviceRow.revision),
    issuedAt: unixTimestamp(now + 2),
    expiresAt: unixTimestamp(now + 30_002),
    signingPrivateKey: signing.privateKey.slice(),
  });
  const acknowledged = await withAuthority<Awaited<ReturnType<typeof domains.acknowledgeEnvelope>>>(
    sourceRoomId,
    sourceNamespaceId,
    authority => domains.acknowledgeEnvelope({
      authority,
      keyClass: "ai",
      clientDeviceId: deviceId,
      acknowledgementBytes: acknowledgement.bytes,
      now: now + 3,
    }),
  );
  if (acknowledged?.status !== "acknowledged") throw new Error("M327 Domain envelope was not acknowledged");

  let targetHeadPlan = headPlan;
  let targetDomainKey = domainKey;
  if (topology !== "shared-domain") {
    const plan = await withAuthority<Awaited<ReturnType<typeof domains.planHead>>>(
      authorityRoomId,
      authorityNamespaceId,
      authority => domains.planHead({ authority, keyClass: "ai", clientDeviceId: deviceId, now: now + 6 }),
    );
    if (plan?.status !== "create_required") {
      throw new Error(`M327 target Domain head was not creatable: ${
        plan?.status ?? "missing"
      }:${plan?.status === "unavailable" ? plan.reason : "unexpected"}`);
    }
    targetHeadPlan = plan;
    targetDomainKey = generateDomainKey(crypto);
    const targetHead = prepareDomainKeyHead(crypto, {
      serverId: SERVER_SCOPE,
      cryptoDomainId: cryptoDomainId(plan.domainId),
      participantDigest: plan.participantDigest,
      participantCount: plan.participantCount,
      keyClass: plan.keyClass,
      domainKeyGeneration: plan.domainKeyGeneration,
      authorizationRevision: authorizationRevision(plan.authorizationRevision),
      previousHeadDigest: plan.previousHeadDigest,
      publicationOperationId: `m327-target-head-${runId}`,
      issuerHumanId: humanId(plan.issuerHumanId),
      issuerDeviceId: cryptoDeviceId(plan.issuerDeviceId),
      issuerDeviceSigningGeneration: plan.issuerDeviceSigningGeneration,
      issuedAt: plan.issuedAt,
      deadlineAt: plan.deadlineAt,
      issuerSigningPublicKey: signing.publicKey,
      issuerSigningPrivateKey: signing.privateKey.slice(),
    });
    const targetDeviceEnvelope = await prepareDomainKeyRecipientEnvelope(crypto, {
      head: targetHead.head,
      headDigest: targetHead.digest,
      recipient: {
        recipientHumanId: humanId(plan.issuerHumanId),
        recipientKind: "device",
        recipientKeyId: plan.issuerDeviceId,
        recipientKeyGeneration: plan.issuerDeviceSigningGeneration,
        recipientPublicKey: plan.recipientEncryptionPublicKey,
        recipientPublicKeyDigest: plan.recipientPublicKeyDigest,
      },
      domainKey: targetDomainKey,
      issuerHumanId: humanId(plan.issuerHumanId),
      issuerDeviceId: cryptoDeviceId(plan.issuerDeviceId),
      issuerDeviceSigningGeneration: plan.issuerDeviceSigningGeneration,
      issuerSigningPublicKey: signing.publicKey,
      issuerSigningPrivateKey: signing.privateKey.slice(),
    });
    const targetRecoveryEnvelope = await prepareDomainKeyRecipientEnvelope(crypto, {
      head: targetHead.head,
      headDigest: targetHead.digest,
      recipient: {
        recipientHumanId: humanId(plan.issuerHumanId),
        recipientKind: "recovery",
        recipientKeyId: plan.recoveryKeyId,
        recipientKeyGeneration: plan.recoveryKeyGeneration,
        recipientPublicKey: plan.recoveryPublicKey,
        recipientPublicKeyDigest: plan.recoveryPublicKeyDigest,
      },
      domainKey: targetDomainKey,
      issuerHumanId: humanId(plan.issuerHumanId),
      issuerDeviceId: cryptoDeviceId(plan.issuerDeviceId),
      issuerDeviceSigningGeneration: plan.issuerDeviceSigningGeneration,
      issuerSigningPublicKey: signing.publicKey,
      issuerSigningPrivateKey: signing.privateKey.slice(),
    });
    const targetAuthorizationFor = (envelope: typeof targetDeviceEnvelope) =>
      prepareDomainKeyRecipientAuthorization(crypto, {
        authorizationOperationId: targetHead.head.publicationOperationId,
        reason: "head_establishment",
        requestDigest: null,
        envelopeBytes: envelope.bytes,
        envelopeDigest: envelope.digest,
        issuerHumanId: humanId(plan.issuerHumanId),
        issuerDeviceId: cryptoDeviceId(plan.issuerDeviceId),
        issuerDeviceSigningGeneration: plan.issuerDeviceSigningGeneration,
        issuedAt: plan.issuedAt,
        deadlineAt: plan.deadlineAt,
        issuerSigningPublicKey: signing.publicKey,
        issuerSigningPrivateKey: signing.privateKey.slice(),
      });
    const targetPublished = await withAuthority<Awaited<ReturnType<typeof domains.publishHead>>>(
      authorityRoomId,
      authorityNamespaceId,
      authority => domains.publishHead({
        authority,
        keyClass: "ai",
        clientDeviceId: deviceId,
        operationId: targetHead.head.publicationOperationId,
        idempotencyKey: `m327-target-head-request-${runId}`,
        headBytes: targetHead.bytes,
        envelopeBytes: targetDeviceEnvelope.bytes,
        authorizationBytes: targetAuthorizationFor(targetDeviceEnvelope).bytes,
        recoveryEnvelopeBytes: targetRecoveryEnvelope.bytes,
        recoveryAuthorizationBytes: targetAuthorizationFor(targetRecoveryEnvelope).bytes,
        now: now + 7,
      }),
    );
    if (targetPublished?.status !== "published") throw new Error("M327 target Domain head was not published");
    const targetAcknowledgement = prepareDomainKeyAcknowledgement(crypto, {
      formatVersion: 2,
      purpose: "domain_key.acknowledgement",
      acknowledgementId: `m327-target-ack-${runId}`,
      serverId: SERVER_SCOPE,
      humanId: humanId(humanActorId),
      deviceId: cryptoDeviceId(deviceId),
      deviceSigningKeyGeneration: Number(deviceRow.device_generation),
      cryptoDomainId: cryptoDomainId(plan.domainId),
      participantDigest: plan.participantDigest,
      participantCount: plan.participantCount,
      keyClass: "ai",
      domainKeyGeneration: plan.domainKeyGeneration,
      authorizationRevision: authorizationRevision(plan.authorizationRevision),
      headDigest: targetHead.digest,
      recipientKeyId: deviceId,
      recipientKeyGeneration: Number(deviceRow.device_generation),
      recipientPublicKeyDigest: plan.recipientPublicKeyDigest,
      requestDigest: null,
      envelopeDigest: targetDeviceEnvelope.digest,
      processedDeviceRevision: Number(deviceRow.revision),
      issuedAt: unixTimestamp(now + 8),
      expiresAt: unixTimestamp(now + 30_008),
      signingPrivateKey: signing.privateKey.slice(),
    });
    const targetAcknowledged = await withAuthority<Awaited<ReturnType<typeof domains.acknowledgeEnvelope>>>(
      authorityRoomId,
      authorityNamespaceId,
      authority => domains.acknowledgeEnvelope({
        authority,
        keyClass: "ai",
        clientDeviceId: deviceId,
        acknowledgementBytes: targetAcknowledgement.bytes,
        now: now + 9,
      }),
    );
    if (targetAcknowledged?.status !== "acknowledged") {
      throw new Error("M327 target Domain envelope was not acknowledged");
    }
  }

  const establishAdditionalDomain = async (
    roomId: string,
    exactNamespaceId: string,
    label: string,
    offset: number,
  ): Promise<Readonly<{ plan: typeof headPlan; key: Uint8Array }>> => {
    const planned = await withAuthority<Awaited<ReturnType<typeof domains.planHead>>>(
      roomId,
      exactNamespaceId,
      authority => domains.planHead({
        authority,
        keyClass: "ai",
        clientDeviceId: deviceId,
        now: now + offset,
      }),
    );
    if (planned?.status !== "create_required") {
      throw new Error(`M327 ${label} Domain head was not creatable`);
    }
    const key = generateDomainKey(crypto);
    const preparedHead = prepareDomainKeyHead(crypto, {
      serverId: SERVER_SCOPE,
      cryptoDomainId: cryptoDomainId(planned.domainId),
      participantDigest: planned.participantDigest,
      participantCount: planned.participantCount,
      keyClass: planned.keyClass,
      domainKeyGeneration: planned.domainKeyGeneration,
      authorizationRevision: authorizationRevision(planned.authorizationRevision),
      previousHeadDigest: planned.previousHeadDigest,
      publicationOperationId: `m327-${label}-head-${runId}`,
      issuerHumanId: humanId(planned.issuerHumanId),
      issuerDeviceId: cryptoDeviceId(planned.issuerDeviceId),
      issuerDeviceSigningGeneration: planned.issuerDeviceSigningGeneration,
      issuedAt: planned.issuedAt,
      deadlineAt: planned.deadlineAt,
      issuerSigningPublicKey: signing.publicKey,
      issuerSigningPrivateKey: signing.privateKey.slice(),
    });
    const prepareEnvelope = async (
      recipient: Parameters<typeof prepareDomainKeyRecipientEnvelope>[1]["recipient"],
    ) => prepareDomainKeyRecipientEnvelope(crypto, {
      head: preparedHead.head,
      headDigest: preparedHead.digest,
      recipient,
      domainKey: key,
      issuerHumanId: humanId(planned.issuerHumanId),
      issuerDeviceId: cryptoDeviceId(planned.issuerDeviceId),
      issuerDeviceSigningGeneration: planned.issuerDeviceSigningGeneration,
      issuerSigningPublicKey: signing.publicKey,
      issuerSigningPrivateKey: signing.privateKey.slice(),
    });
    const deviceEnvelopeForDomain = await prepareEnvelope({
      recipientHumanId: humanId(planned.issuerHumanId),
      recipientKind: "device",
      recipientKeyId: planned.issuerDeviceId,
      recipientKeyGeneration: planned.issuerDeviceSigningGeneration,
      recipientPublicKey: planned.recipientEncryptionPublicKey,
      recipientPublicKeyDigest: planned.recipientPublicKeyDigest,
    });
    const recoveryEnvelopeForDomain = await prepareEnvelope({
      recipientHumanId: humanId(planned.issuerHumanId),
      recipientKind: "recovery",
      recipientKeyId: planned.recoveryKeyId,
      recipientKeyGeneration: planned.recoveryKeyGeneration,
      recipientPublicKey: planned.recoveryPublicKey,
      recipientPublicKeyDigest: planned.recoveryPublicKeyDigest,
    });
    const authorizeEnvelope = (envelope: typeof deviceEnvelopeForDomain) =>
      prepareDomainKeyRecipientAuthorization(crypto, {
        authorizationOperationId: preparedHead.head.publicationOperationId,
        reason: "head_establishment",
        requestDigest: null,
        envelopeBytes: envelope.bytes,
        envelopeDigest: envelope.digest,
        issuerHumanId: humanId(planned.issuerHumanId),
        issuerDeviceId: cryptoDeviceId(planned.issuerDeviceId),
        issuerDeviceSigningGeneration: planned.issuerDeviceSigningGeneration,
        issuedAt: planned.issuedAt,
        deadlineAt: planned.deadlineAt,
        issuerSigningPublicKey: signing.publicKey,
        issuerSigningPrivateKey: signing.privateKey.slice(),
      });
    const publishedDomain = await withAuthority<Awaited<ReturnType<typeof domains.publishHead>>>(
      roomId,
      exactNamespaceId,
      authority => domains.publishHead({
        authority,
        keyClass: "ai",
        clientDeviceId: deviceId,
        operationId: preparedHead.head.publicationOperationId,
        idempotencyKey: `m327-${label}-head-request-${runId}`,
        headBytes: preparedHead.bytes,
        envelopeBytes: deviceEnvelopeForDomain.bytes,
        authorizationBytes: authorizeEnvelope(deviceEnvelopeForDomain).bytes,
        recoveryEnvelopeBytes: recoveryEnvelopeForDomain.bytes,
        recoveryAuthorizationBytes: authorizeEnvelope(recoveryEnvelopeForDomain).bytes,
        now: now + offset + 1,
      }),
    );
    if (publishedDomain?.status !== "published") {
      throw new Error(`M327 ${label} Domain head was not published`);
    }
    const acknowledgementForDomain = prepareDomainKeyAcknowledgement(crypto, {
      formatVersion: 2,
      purpose: "domain_key.acknowledgement",
      acknowledgementId: `m327-${label}-ack-${runId}`,
      serverId: SERVER_SCOPE,
      humanId: humanId(humanActorId),
      deviceId: cryptoDeviceId(deviceId),
      deviceSigningKeyGeneration: Number(deviceRow.device_generation),
      cryptoDomainId: cryptoDomainId(planned.domainId),
      participantDigest: planned.participantDigest,
      participantCount: planned.participantCount,
      keyClass: "ai",
      domainKeyGeneration: planned.domainKeyGeneration,
      authorizationRevision: authorizationRevision(planned.authorizationRevision),
      headDigest: preparedHead.digest,
      recipientKeyId: deviceId,
      recipientKeyGeneration: Number(deviceRow.device_generation),
      recipientPublicKeyDigest: planned.recipientPublicKeyDigest,
      requestDigest: null,
      envelopeDigest: deviceEnvelopeForDomain.digest,
      processedDeviceRevision: Number(deviceRow.revision),
      issuedAt: unixTimestamp(now + offset + 2),
      expiresAt: unixTimestamp(now + offset + 30_002),
      signingPrivateKey: signing.privateKey.slice(),
    });
    const acknowledgedDomain = await withAuthority<Awaited<ReturnType<typeof domains.acknowledgeEnvelope>>>(
      roomId,
      exactNamespaceId,
      authority => domains.acknowledgeEnvelope({
        authority,
        keyClass: "ai",
        clientDeviceId: deviceId,
        acknowledgementBytes: acknowledgementForDomain.bytes,
        now: now + offset + 3,
      }),
    );
    if (acknowledgedDomain?.status !== "acknowledged") {
      throw new Error(`M327 ${label} Domain envelope was not acknowledged`);
    }
    return {plan: planned, key};
  };

  const domainPlans = new Map<string, Readonly<{
    plan: typeof headPlan;
    key: Uint8Array;
  }>>([[sourceNamespaceId, {plan: headPlan, key: domainKey}]]);
  if (authorityNamespaceId !== sourceNamespaceId) {
    domainPlans.set(authorityNamespaceId, {plan: targetHeadPlan, key: targetDomainKey});
  }
  if (topology === "shared-domain") {
    domainPlans.set(accessNamespaceId, {plan: headPlan, key: domainKey});
  } else if (topology === "distinct-domain") {
    domainPlans.set(accessNamespaceId, {plan: targetHeadPlan, key: targetDomainKey});
  }
  const audienceDomainPlans = new Map<string, Readonly<{
    plan: typeof headPlan;
    key: Uint8Array;
  }>>([
    [sourceHumanActorIds.join(":"), {plan: headPlan, key: domainKey}],
    [authorityHumanActorIds.join(":"), {
      plan: targetHeadPlan,
      key: targetDomainKey,
    }],
  ]);

  const namespaceMaterials = new Map<string, NamespaceMaterial>();
  const publishNamespace = async (
    coordinate: Readonly<{ roomId: string; namespaceId: string }>,
  ): Promise<void> => {
    const plan = await withAuthority<Awaited<ReturnType<typeof domains.planNamespaceBundle>>>(
      coordinate.roomId,
      coordinate.namespaceId,
      authority => domains.planNamespaceBundle({ authority, keyClass: "ai", clientDeviceId: deviceId }),
    );
    if (plan?.status !== "create_required") throw new Error("M327 Namespace bundle was not creatable");
    const domain = domainPlans.get(coordinate.namespaceId);
    if (domain === undefined) throw new Error("M327 Namespace Domain material is missing");
    const coordinateHeadPlan = domain.plan;
    const coordinateDomainKey = domain.key;
    expect(plan.domainId).toBe(coordinateHeadPlan.domainId);
    const generationKey = digest(`namespace-generation:${coordinate.namespaceId}`);
    const generationHead = domainNamespaceGenerationHeadDigest(crypto, {
      serverId: SERVER_SCOPE,
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
      headDigest: generationHead,
      generationKey,
    })];
    const retainedDigest = domainNamespaceRetainedAuthoritySetDigest(crypto, retained);
    const bundle = prepareDomainNamespaceBundle(crypto, {
      operationId: `m327-bundle-${coordinate.namespaceId}`,
      bundle: {
        formatVersion: 2,
        purpose: "domain_key.namespace_bundle",
        serverId: SERVER_SCOPE,
        cryptoDomainId: cryptoDomainId(plan.domainId),
        participantDigest: plan.participantDigest,
        participantCount: plan.participantCount,
        keyClass: plan.keyClass,
        domainKeyGeneration: plan.domainKeyGeneration,
        domainAuthorizationRevision: authorizationRevision(plan.domainAuthorizationRevision),
        domainHeadDigest: plan.domainHeadDigest,
        namespaceId: namespaceId(plan.namespaceId),
        namespaceAccessRevision: accessRevision(plan.namespaceAccessRevision),
        namespaceCurrentGeneration: namespaceGeneration(0),
        bundleRevision: plan.bundleRevision,
        retainedGenerationCount: 1,
        retainedAuthoritySetDigest: retainedDigest,
        retainedGenerations: retained,
      },
      previousBindingDigest: plan.previousBindingDigest,
      issuerHumanId: humanId(plan.issuerHumanId),
      issuerDeviceId: cryptoDeviceId(plan.issuerDeviceId),
      issuerDeviceSigningGeneration: plan.issuerDeviceSigningGeneration,
      issuerSigningPrivateKey: signing.privateKey.slice(),
      issuerSigningPublicKey: signing.publicKey,
      domainKey: coordinateDomainKey,
      issuedAt: now + 4,
    });
    const result = await withAuthority<Awaited<ReturnType<typeof domains.publishNamespaceBundle>>>(
      coordinate.roomId,
      coordinate.namespaceId,
      authority => domains.publishNamespaceBundle({
        authority,
        keyClass: "ai",
        clientDeviceId: deviceId,
        operationId: bundle.binding.operationId,
        idempotencyKey: `m327-bundle-request-${coordinate.namespaceId}`,
        bindingBytes: bundle.bytes,
        now: now + 5,
      }),
    );
    if (result?.status !== "published") throw new Error("M327 Namespace bundle was not published");
    const inspected = await domains.inspectForegroundNamespaceAuthority({
      namespaceId: coordinate.namespaceId,
      keyClass: "ai",
    });
    if (inspected.status !== "ready") throw new Error("M327 Namespace authority was not current");
    namespaceMaterials.set(coordinate.namespaceId, {
      ...coordinate,
      generationKey,
      authority: {
        serverId: SERVER_SCOPE,
        roomId: coordinate.roomId,
        namespaceId: inspected.namespaceId,
        namespaceAccessRevision: inspected.namespaceAccessRevision,
        namespaceKeyGeneration: inspected.namespaceKeyGeneration,
        namespaceHeadDigest: inspected.namespaceHeadDigest,
        domainId: inspected.domainId,
        domainKeyGeneration: inspected.domainKeyGeneration,
        domainAuthorizationRevision: inspected.domainAuthorizationRevision,
        domainHeadDigest: inspected.domainHeadDigest,
        bundleRevision: inspected.bundleRevision,
        bundleDigest: inspected.bundleDigest,
      },
      openedNamespace: {
        sourceRoomId: coordinate.roomId,
        serverId: SERVER_SCOPE,
        namespaceId: inspected.namespaceId,
        keyClass: "ai",
        namespaceAccessRevision: inspected.namespaceAccessRevision,
        namespaceKeyGeneration: inspected.namespaceKeyGeneration,
        namespaceHeadDigest: inspected.namespaceHeadDigest,
        domainId: inspected.domainId,
        domainKeyGeneration: inspected.domainKeyGeneration,
        domainAuthorizationRevision: inspected.domainAuthorizationRevision,
        domainHeadDigest: inspected.domainHeadDigest,
        bundleRevision: inspected.bundleRevision,
        bundleDigest: inspected.bundleDigest,
      },
    });
  };
  for (const coordinate of [
    { roomId: sourceRoomId, namespaceId: sourceNamespaceId },
    ...(topology !== "shared-domain"
      ? [{ roomId: authorityRoomId, namespaceId: authorityNamespaceId }]
      : []),
    ...(topology === "shared-domain"
      ? [{ roomId: accessRoomId, namespaceId: accessNamespaceId }]
      : []),
  ]) {
    await publishNamespace(coordinate);
  }
  const source = namespaceMaterials.get(sourceNamespaceId)!;
  const domainAuthority: OpenedDomainKeyAuthorityV2 = {
    serverId: SERVER_SCOPE,
    domainId: source.authority.domainId,
    participantDigest: headPlan.participantDigest,
    participantCount: headPlan.participantCount,
    keyClass: "ai",
    domainKeyGeneration: source.authority.domainKeyGeneration,
    authorizationRevision: source.authority.domainAuthorizationRevision,
    headDigest: source.authority.domainHeadDigest,
    recipientDeviceSigningGeneration: Number(deviceRow.device_generation),
  };
  const target = namespaceMaterials.get(
    topology === "shared-domain" ? accessNamespaceId : authorityNamespaceId,
  )!;
  const targetDomainAuthority: OpenedDomainKeyAuthorityV2 = {
    serverId: SERVER_SCOPE,
    domainId: target.authority.domainId,
    participantDigest: targetHeadPlan.participantDigest,
    participantCount: targetHeadPlan.participantCount,
    keyClass: "ai",
    domainKeyGeneration: target.authority.domainKeyGeneration,
    authorizationRevision: target.authority.domainAuthorizationRevision,
    headDigest: target.authority.domainHeadDigest,
    recipientDeviceSigningGeneration: Number(deviceRow.device_generation),
  };
  const domainMaterials = new Map<string, Readonly<{
    key: Uint8Array;
    authority: OpenedDomainKeyAuthorityV2;
  }>>([
    [domainAuthority.domainId, {key: domainKey, authority: domainAuthority}],
    [targetDomainAuthority.domainId, {
      key: targetDomainKey,
      authority: targetDomainAuthority,
    }],
  ]);
  const registerOpenedDomain = (
    exactNamespaceId: string,
    domain: Readonly<{plan: typeof headPlan; key: Uint8Array}>,
  ): void => {
    const material = namespaceMaterials.get(exactNamespaceId);
    if (material === undefined) {
      throw new Error("M327 opened Namespace material is missing");
    }
    const authority: OpenedDomainKeyAuthorityV2 = {
      serverId: SERVER_SCOPE,
      domainId: material.authority.domainId,
      participantDigest: domain.plan.participantDigest,
      participantCount: domain.plan.participantCount,
      keyClass: "ai",
      domainKeyGeneration: material.authority.domainKeyGeneration,
      authorizationRevision: material.authority.domainAuthorizationRevision,
      headDigest: material.authority.domainHeadDigest,
      recipientDeviceSigningGeneration: Number(deviceRow.device_generation),
    };
    domainMaterials.set(authority.domainId, {key: domain.key, authority});
  };
  const provisionNamespace = async (coordinate: Readonly<{
    roomId: string;
    namespaceId: string;
  }>): Promise<void> => {
    if (namespaceMaterials.has(coordinate.namespaceId)) return;
    let domain = domainPlans.get(coordinate.namespaceId);
    if (domain === undefined) {
      const [room] = await product.unsafe<{human_actor_ids: string[]}[]>(
        "SELECT human_actor_ids FROM rooms WHERE id = $1 AND namespace_id = $2",
        [coordinate.roomId, coordinate.namespaceId],
      );
      if (room === undefined) {
        throw new Error("M327 requested access Room is missing");
      }
      const audienceKey = [...room.human_actor_ids].sort().join(":");
      domain = audienceDomainPlans.get(audienceKey);
      if (domain === undefined && audienceKey === humanActorId) {
        domain = await establishAdditionalDomain(
          coordinate.roomId,
          coordinate.namespaceId,
          "access",
          12,
        );
        audienceDomainPlans.set(audienceKey, domain);
      }
      if (domain === undefined) {
        throw new Error("M327 requested access audience has no Domain material");
      }
      domainPlans.set(coordinate.namespaceId, domain);
    }
    await publishNamespace(coordinate);
    registerOpenedDomain(coordinate.namespaceId, domain);
  };
  encryption.privateKey.fill(0);
  recovery.privateKey.fill(0);
  return Object.freeze({ topology, runId, userId, extraUserId, authorityExtraUserId,
    humanActorId, extraHumanActorId, authorityExtraHumanActorId, sourceRoomId, sourceNamespaceId,
    authorityRoomId, authorityNamespaceId,
    accessRoomId, accessNamespaceId, recordId, batchId, deviceId, domainId: headPlan.domainId,
    sourceObjectId, signing, domainKey, targetDomainKey, namespaces: namespaceMaterials,
    domainAuthority, targetDomainAuthority, domainMaterials,
    provisionAccessNamespace: () => provisionNamespace({
      roomId: accessRoomId,
      namespaceId: accessNamespaceId,
    }),
    provisionNamespace,
    policyRevision, policyMode, now });
}

async function persistNativeProtectedRecord(
  fixture: Fixture,
  crypto: LatticeCrypto,
  repository: PostgresBackgroundAuthorizationRepository,
  options: Readonly<{
    initializeRoomState?: boolean;
    journalSequence?: number;
    statement?: string;
    terminalAuthorityNamespaceId?: string;
  }> = {},
): Promise<Readonly<{ payload: Uint8Array; sourceRequestId: string }>> {
  const journalSequence = options.journalSequence ?? 1;
  const source = fixture.namespaces.get(fixture.sourceNamespaceId)!;
  const payload = encodeRecordPayloadV1({
    formatVersion: 1,
    posture: "derived",
    observedContentFingerprint: `m327-observation-${fixture.runId}`,
    sourceOwnedKind: "journal_event:fact",
    observedLogicalObjectRef: fixture.recordId,
    observedRevision: "1",
    statement: options.statement ?? "M327 protected Reflection foreground proof",
    sourceDependencies: fixture.topology === "shared-domain" ? [{
      sourceKind: "message",
      logicalObjectRef: `message:${journalSequence}`,
      observedRevision: "1",
      observedContentFingerprint: `m327-message-${journalSequence}-${fixture.runId}`,
      terminalAuthorityLeafHandle: fixture.sourceNamespaceId,
      authorityBearing: true,
    }] : [],
    anchors: [{ kind: "room", anchorRef: fixture.sourceRoomId, role: "origin" }],
    childRecordIds: [],
    producer: { producerRef: "stenographer", policyVersion: "m327-composition-v1" },
    terminalAuthorityLeafHandles: [
      options.terminalAuthorityNamespaceId ?? fixture.authorityNamespaceId,
    ],
  });
  const encrypted = encryptObjectPayload(crypto, {
    objectId: objectId(fixture.sourceObjectId),
    keyClass: "ai",
    objectType: "nautilo.reflection.record.v1",
    createdAt: unixTimestamp(fixture.now),
  }, payload);
  const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
  const envelope = wrapObjectDekForNamespace(crypto, source.generationKey, {
    objectId: objectId(fixture.sourceObjectId),
    namespaceId: namespaceId(fixture.sourceNamespaceId),
    keyClass: "ai",
    keyGeneration: namespaceGeneration(source.authority.namespaceKeyGeneration),
    bindingRevisionAtWrap: accessRevision(source.authority.namespaceAccessRevision),
  }, encrypted.dek);
  encrypted.dek.fill(0);
  const envelopeBytes = encodeNamespaceObjectEnvelopeV2(envelope);
  const recipient = await crypto.generateEncryptionKeyPair();
  const sourceRequestId = `m327-source-request-${fixture.runId}`;
  const sourceWorkId = `m327-source-work-${fixture.runId}`;
  const descriptor: BackgroundProcessorWorkDescriptorV2 = {
    formatVersion: 2,
    requestId: sourceRequestId,
    recipientGeneration: 0,
    workKind: "stenographer.output_repair",
    workId: sourceWorkId,
    anchorNamespaceId: fixture.sourceNamespaceId,
    anchorDomainId: fixture.domainId,
    subject: { kind: "processor", processorKind: "stenographer", processorVersion: 1 },
    operations: ["encrypt"],
    purpose: "journal.repair",
    authority: source.authority,
    policyRevision: fixture.policyRevision,
    source: {
      kind: "stenographer_work",
      startSequence: 1,
      endSequence: 1,
      rebuildGeneration: 1,
      fingerprint: digest(`source-fingerprint:${fixture.runId}`),
    },
    inputBindings: [],
    outputSlots: [{
      objectId: fixture.sourceObjectId,
      objectType: "nautilo.reflection.record.v1",
      createdAt: fixture.now,
      namespaceIds: [fixture.sourceNamespaceId],
    }],
    maximumPlaintextBytes: 64 * 1_024,
    maximumCiphertextBytes: 96 * 1_024,
    recipientKeyId: `m327-source-recipient-${fixture.runId}`,
    recipientPublicKey: recipient.publicKey,
    issuedAt: fixture.now,
    notBefore: fixture.now,
    expiresAt: fixture.now + 300_000,
    idempotencyId: `m327-source-idempotency-${fixture.runId}`,
  };
  const descriptorBytes = encodeBackgroundWorkDescriptorV2(descriptor);
  const device = await new PostgresDeviceAdmissionRepository(
    await verifyCryptoPostgresHandle(connection(restricted)),
    crypto,
  ).currentAuthorityForDelegation({
    userId: fixture.userId,
    humanActorId: fixture.humanActorId,
    deviceId: fixture.deviceId,
  });
  if (device === null) throw new Error("M327 current device authority is missing");
  const issuer: BackgroundAuthorizationIssuerV2 = {
    humanId: device.humanActorId,
    deviceId: device.deviceId,
    deviceGeneration: device.deviceGeneration,
    serverInstanceId: device.serverInstanceId,
    lineageGeneration: device.lineageGeneration,
    epoch: device.epoch,
    securityRevision: device.securityRevision,
    headDigest: device.headDigest,
    signingPublicKeyHash: crypto.hash(device.signingPublicKey),
  };
  const responseBytes = await createBackgroundAuthorizationResponseV2(crypto, {
    credentialId: `m327-source-credential-${fixture.runId}`,
    descriptorBytes,
    issuer,
    issuerSigningPrivateKey: fixture.signing.privateKey,
    domainKey: fixture.domainKey,
  });
  const { signerAuthorizationBytes } = decodeBackgroundAuthorizationResponseV2(responseBytes);
  const manifest = await withOpenedBackgroundAuthorizationV2(crypto, {
    responseBytes,
    recipientPrivateKey: recipient.privateKey,
    now: () => fixture.now + 1,
    resolveCurrentIssuer: () => fixture.signing.publicKey.slice(),
    use: ({ verified, signerPrivateKey }) => {
      const unsigned = {
        objectId: objectId(fixture.sourceObjectId),
        payloadHash: crypto.hash(payloadBytes),
        signer: verified.signer,
        signerAuthorizationHash: verified.signerAuthorizationHash,
        hostAuthorizationRevision: authorizationRevision(issuer.securityRevision),
      };
      const signingAuthority = {
        signerPrivateKey,
        signerAuthorizationBytes,
        issuerSigningPublicKey: fixture.signing.publicKey,
        now: fixture.now + 1,
      };
      const genesis = createCurrentCommonProcessorObjectAccessManifest(crypto, {
        ...unsigned,
        accessRevision: accessRevision(0),
        previousManifestHash: null,
        envelopeHashes: [crypto.hash(envelopeBytes)],
      }, signingAuthority);
      const tombstone = createCurrentCommonProcessorObjectAccessManifest(crypto, {
        ...unsigned,
        accessRevision: accessRevision(1),
        previousManifestHash: genesis.hash,
        envelopeHashes: [],
      }, signingAuthority);
      return { genesis, tombstone };
    },
  });
  const initial: BackgroundAuthorizationRecord = {
    snapshot: createBackgroundAuthorizationRequestV2({
      requestId: sourceRequestId,
      workId: sourceWorkId,
      namespaceId: fixture.sourceNamespaceId,
      credentialSubject: { kind: "processor", processorKind: "stenographer", processorVersion: 1 },
      now: fixture.now,
    }),
    workIdentityHash: digest(`source-work:${fixture.runId}`),
    idempotencyKey: descriptor.idempotencyId,
    workKind: descriptor.workKind,
    purpose: descriptor.purpose,
    domainId: fixture.domainId,
    processorAuthorizationRevision: null,
    expectedDomainEpoch: null,
    expectedNamespaceAccessRevision: source.authority.namespaceAccessRevision,
    expectedPolicyRevision: fixture.policyRevision,
    descriptorBytes: null,
    acceptedMaterial: null,
    finishedAt: null,
  };
  expect((await repository.create(initial)).status).toBe("created");
  const waiting: BackgroundAuthorizationRecord = {
    ...initial,
    snapshot: attachBackgroundAuthorizationRecipient(initial.snapshot, {
      descriptorDigest: Buffer.from(crypto.hash(descriptorBytes)).toString("hex"),
      recipientKeyId: descriptor.recipientKeyId,
      recipientPublicKey: Buffer.from(recipient.publicKey).toString("base64url"),
      expiresAt: descriptor.expiresAt,
      now: fixture.now + 1,
    }),
    descriptorBytes,
  };
  expect((await repository.compareAndSwap({
    expectedRequestRevision: 0,
    next: waiting,
  })).status).toBe("updated");
  const verified = await verifyBackgroundAuthorizationResponseV2(crypto, {
    responseBytes,
    now: fixture.now + 2,
    resolveCurrentIssuer: () => fixture.signing.publicKey.slice(),
  });
  expect((await repository.acceptVerifiedResponse({
    response: { ...verified, formatVersion: 2, kind: "processor" },
    acceptedAt: fixture.now + 2,
  })).status).toBe("accepted");
  await restricted.begin(async tx => {
    await tx.unsafe(
      "INSERT INTO crypto_objects (object_id, payload_hash, payload_bytes) VALUES ($1, $2, $3)",
      [fixture.sourceObjectId, crypto.hash(payloadBytes), payloadBytes],
    );
    await tx.unsafe(
      `INSERT INTO object_crypto_access_manifests (
         object_id, access_revision, manifest_hash, previous_manifest_hash, payload_hash, manifest_bytes
       ) VALUES
         ($1, 0, $2, NULL, $4, $5),
         ($1, 1, $3, $2, $4, $6)`,
      [fixture.sourceObjectId, manifest.genesis.hash, manifest.tombstone.hash,
        crypto.hash(payloadBytes), manifest.genesis.bytes, manifest.tombstone.bytes],
    );
    await tx.unsafe(
      `INSERT INTO object_crypto_namespace_envelopes (
         object_id, access_revision, namespace_id, ordinal, envelope_hash, envelope_bytes
       ) VALUES ($1, 0, $2, 0, $3, $4)`,
      [fixture.sourceObjectId, fixture.sourceNamespaceId, crypto.hash(envelopeBytes), envelopeBytes],
    );
    await tx.unsafe(
      "INSERT INTO object_crypto_access_heads (object_id, access_revision, manifest_hash) VALUES ($1, 0, $2)",
      [fixture.sourceObjectId, manifest.genesis.hash],
    );
  });
  await admin.begin(async tx => {
    if (options.initializeRoomState !== false) await tx.unsafe(
      `INSERT INTO room_journal_state (
         room_id, last_processed_message_id, extractor_version, historical_backfill_status,
         rebuild_generation, created_at, updated_at
       ) VALUES ($1, 1, 'm327-composition-v1', 'not_needed', 0, $2, $2)`,
      [fixture.sourceRoomId, new Date(fixture.now).toISOString()],
    );
    else await tx.unsafe(
      `UPDATE room_journal_state
          SET last_processed_message_id = greatest(last_processed_message_id, $2),
              updated_at = $3
        WHERE room_id = $1`,
      [fixture.sourceRoomId, journalSequence, new Date(fixture.now).toISOString()],
    );
    await tx.unsafe(
      `INSERT INTO room_journal_batches (
         id, room_id, from_message_id_exclusive, through_message_id_inclusive,
         extractor_version, observation_publication_version, lane, status,
         attempt_count, operation_count, started_at, completed_at, created_at
       ) VALUES ($1, $2, $3, $4, 'm327-composition-v1', 1, 'live', 'completed', 1, 1, $5, $5, $5)`,
      [fixture.batchId, fixture.sourceRoomId, journalSequence - 1, journalSequence,
        new Date(fixture.now).toISOString()],
    );
    await tx.unsafe(
      `INSERT INTO reflection_records (
         record_id, lifecycle, structural_height, producer_policy_version, processing_generation
       ) VALUES ($1, 'current', 0, 'm327-composition-v1', 1)`,
      [fixture.recordId],
    );
    await tx.unsafe(
      `INSERT INTO reflection_record_payload_representations (
         record_id, representation, representation_generation, payload_version,
         plaintext_payload_bytes, crypto_object_id, created_at
       ) VALUES
         ($1, 'ordinary', 1, 1, $2, NULL, $4),
         ($1, 'protected', 1, 1, NULL, $3, $4)`,
      [fixture.recordId, payload, fixture.sourceObjectId, new Date(fixture.now).toISOString()],
    );
    await tx.unsafe(
      `INSERT INTO reflection_record_payload_representation_heads (
         record_id, representation, current_representation_generation
       ) VALUES ($1, 'ordinary', 1), ($1, 'protected', 1)`,
      [fixture.recordId],
    );
    await tx.unsafe("SELECT set_config('nautilo.stenographer_writer_version', '2', true)");
    await tx.unsafe(
      `INSERT INTO room_events (
         id, room_id, sequence, kind, statement, status, source_message_ids,
         source_batch_id, batch_local_ordinal, extractor_version, projection_kind,
         record_id, native_attached_at, created_at
       ) VALUES ($1::uuid, $2, $3::integer, 'fact', NULL, 'active', ARRAY[$3::integer], $4, 0,
         'm327-composition-v1', 'native', ($1::uuid)::text, $5, $5)`,
      [fixture.recordId, fixture.sourceRoomId, journalSequence, fixture.batchId,
        new Date(fixture.now).toISOString()],
    );
    const publication = `journal:${fixture.batchId}:0`;
    await tx.unsafe(
      `INSERT INTO reflection_record_publications (
         publication_id, record_id, representation, representation_generation,
         crypto_object_id, request_commitment, publication_binding_ref, state,
         crypto_completed_at, product_attached_at, completed_at, created_at, updated_at
       ) VALUES
         ($1, $2, 'protected', 1, $3, $4, $5, 'complete', $7, $7, $7, $7, $7),
         ($6, $2, 'ordinary', 1, NULL, $8, $9, 'complete', NULL, $7, $7, $7, $7)`,
      [publication, fixture.recordId, fixture.sourceObjectId, digest(`protected:${fixture.runId}`),
        `journal:namespace:${fixture.sourceNamespaceId}:protected:v1`, `${publication}:ordinary`,
        new Date(fixture.now).toISOString(), digest(`ordinary:${fixture.runId}`),
        `journal:namespace:${fixture.sourceNamespaceId}:ordinary:v1`],
    );
  });
  const durableSource = await repository.get(sourceRequestId);
  if (durableSource === null || durableSource.snapshot.state !== "grant_ready") {
    throw new Error("M327 source certificate request was not accepted");
  }
  const claimedSource = {
    ...durableSource,
    snapshot: claimBackgroundAuthorizationRequest(
      durableSource.snapshot,
      `m327-source-claim-${fixture.runId}`,
      fixture.now + 3,
      fixture.now + 60_003,
    ),
  };
  if ((await repository.compareAndSwap({
    expectedRequestRevision: durableSource.snapshot.requestRevision,
    next: claimedSource,
  })).status !== "updated") throw new Error("M327 source certificate request was not claimed");
  const runningSource = {
    ...claimedSource,
    snapshot: markBackgroundAuthorizationRunning(claimedSource.snapshot, fixture.now + 4),
  };
  if ((await repository.compareAndSwap({
    expectedRequestRevision: claimedSource.snapshot.requestRevision,
    next: runningSource,
  })).status !== "updated") throw new Error("M327 source certificate request was not started");
  const completedSource = {
    ...runningSource,
    snapshot: completeBackgroundAuthorizationRequest(runningSource.snapshot, fixture.now + 5),
    finishedAt: fixture.now + 5,
  };
  if ((await repository.compareAndSwap({
    expectedRequestRevision: runningSource.snapshot.requestRevision,
    next: completedSource,
  })).status !== "updated") throw new Error("M327 source certificate request was not completed");
  recipient.privateKey.fill(0);
  responseBytes.fill(0);
  payloadBytes.fill(0);
  envelopeBytes.fill(0);
  return { payload, sourceRequestId };
}

async function persistAuthoredProtectedMemory(
  fixture: Fixture,
  crypto: LatticeCrypto,
  embedding: readonly number[],
  hostAuthorizationRevision: number,
): Promise<Readonly<{
  memoryId: string;
  logicalSourceRef: `memory:${string}`;
  objectId: string;
}>> {
  const memoryId = randomUUID();
  const cryptoObjectId = deriveMemoryCryptoObjectIdV1({
    memoryId,
    contentRevision: 1,
  });
  const namespace = fixture.namespaces.get(fixture.authorityNamespaceId);
  if (namespace === undefined) {
    throw new Error("M327 authored Memory Namespace material is missing");
  }
  const plaintext = encodeMemoryPayloadV1({
    formatVersion: 1,
    type: "preference",
    content: "M327 protected authored Memory candidate",
  });
  const encrypted = encryptObjectPayload(crypto, {
    objectId: objectId(cryptoObjectId),
    keyClass: "ai",
    objectType: "nautilo-memory-v1",
    createdAt: unixTimestamp(fixture.now),
  }, plaintext);
  const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
  const envelope = wrapObjectDekForNamespace(crypto, namespace.generationKey, {
    objectId: objectId(cryptoObjectId),
    namespaceId: namespaceId(fixture.authorityNamespaceId),
    keyClass: "ai",
    keyGeneration: namespaceGeneration(namespace.authority.namespaceKeyGeneration),
    bindingRevisionAtWrap: accessRevision(namespace.authority.namespaceAccessRevision),
  }, encrypted.dek);
  encrypted.dek.fill(0);
  const envelopeBytes = encodeNamespaceObjectEnvelopeV2(envelope);
  const payloadHash = crypto.hash(payloadBytes);
  const genesis = prepareHumanObjectAccessManifestGenesisSet(crypto, {
    objectId: cryptoObjectId,
    payloadHash,
    envelopeBytes: [envelopeBytes],
    sourceAuthorized: true,
    targetAuthorized: true,
    subjectHumanId: fixture.humanActorId,
    committerDeviceId: fixture.deviceId,
    hostAuthorizationRevision,
    committerSigningPublicKey: fixture.signing.publicKey,
    committerSigningPrivateKey: fixture.signing.privateKey,
  });
  const requiredNamespaceFingerprint = fingerprintRequiredMemoryNamespaces([
    fixture.authorityNamespaceId,
  ]);
  try {
    await restricted.begin(async tx => {
      await tx.unsafe(
        "INSERT INTO crypto_objects (object_id, payload_hash, payload_bytes) VALUES ($1, $2, $3)",
        [cryptoObjectId, payloadHash, payloadBytes],
      );
      await tx.unsafe(
        `INSERT INTO object_crypto_access_manifests (
           object_id, access_revision, manifest_hash, previous_manifest_hash,
           payload_hash, manifest_bytes
         ) VALUES ($1, 0, $2, NULL, $3, $4)`,
        [cryptoObjectId, genesis.manifestHash, payloadHash, genesis.manifestBytes],
      );
      await tx.unsafe(
        `INSERT INTO object_crypto_namespace_envelopes (
           object_id, access_revision, namespace_id, ordinal,
           envelope_hash, envelope_bytes
         ) VALUES ($1, 0, $2, 0, $3, $4)`,
        [cryptoObjectId, fixture.authorityNamespaceId,
          crypto.hash(envelopeBytes), envelopeBytes],
      );
      await tx.unsafe(
        "INSERT INTO object_crypto_access_heads (object_id, access_revision, manifest_hash) VALUES ($1, 0, $2)",
        [cryptoObjectId, genesis.manifestHash],
      );
    });
    await admin.begin(async tx => {
      await tx.unsafe(
        `INSERT INTO memories (
           id, tier, type, content, content_revision, embedding,
           crypto_object_id, crypto_access_revision,
           crypto_required_namespace_fingerprint, crypto_mapping_state,
           embedding_revision, embedding_provider, embedding_model,
           embedding_dimensions, embedding_contract_version, created_at, updated_at
         ) VALUES (
           $1, 1, NULL, NULL, 1, $2::vector(1536),
           $3, 0, $4, 'verified',
           1, 'openai', 'text-embedding-3-small', 1536, 1, $5, $5
         )`,
        [memoryId, `[${embedding.join(",")}]`, cryptoObjectId,
          requiredNamespaceFingerprint, new Date(fixture.now).toISOString()],
      );
      await tx.unsafe(
        "INSERT INTO memory_namespaces (memory_id, namespace_id) VALUES ($1, $2)",
        [memoryId, fixture.authorityNamespaceId],
      );
      await tx.unsafe(
        `INSERT INTO memory_crypto_revisions (
           memory_id, content_revision, anchor_namespace_id, crypto_object_id,
           allocation_request_digest, required_namespace_fingerprint,
           completion, disposition, next_attempt_at, crypto_completed_at
         ) VALUES ($1, 1, $2, $3, $4, $5, 'complete', 'mapped', NULL, $6)`,
        [memoryId, fixture.authorityNamespaceId, cryptoObjectId,
          digest(`memory-allocation:${fixture.runId}`),
          requiredNamespaceFingerprint, new Date(fixture.now).toISOString()],
      );
      // Attachment insertion marks the mapping stale. Publish verified mapping
      // only after its complete attachment set and crypto revision exist.
      await tx.unsafe(
        "UPDATE memories SET crypto_mapping_state = 'verified' WHERE id = $1",
        [memoryId],
      );
    });
  } finally {
    plaintext.fill(0);
    payloadBytes.fill(0);
    envelopeBytes.fill(0);
    payloadHash.fill(0);
    genesis.manifestBytes.fill(0);
    genesis.manifestHash.fill(0);
    requiredNamespaceFingerprint.fill(0);
  }
  return Object.freeze({
    memoryId,
    logicalSourceRef: `memory:${memoryId}`,
    objectId: cryptoObjectId,
  });
}

async function seedSupersededRequests(
  fixture: Fixture,
  repository: PostgresBackgroundAuthorizationRepository,
): Promise<readonly string[]> {
  const ids: string[] = [];
  const source = fixture.namespaces.get(fixture.sourceNamespaceId)!;
  for (let index = 0; index < 257; index += 1) {
    const requestId = `m327-prior-${fixture.runId}-${String(index).padStart(3, "0")}`;
    const record: BackgroundAuthorizationRecord = {
      snapshot: createBackgroundAuthorizationRequestV2({
        requestId,
        workId: workId(fixture.recordId),
        namespaceId: fixture.sourceNamespaceId,
        credentialSubject: { kind: "processor", processorKind: "reflection", processorVersion: 1 },
        now: fixture.now - 257 + index,
      }),
      workIdentityHash: digest(`prior-work:${fixture.runId}:${index}`),
      idempotencyKey: requestId,
      workKind: "reflection.authority_reproject",
      purpose: "record.reproject",
      domainId: fixture.domainId,
      processorAuthorizationRevision: null,
      expectedDomainEpoch: null,
      expectedNamespaceAccessRevision: source.authority.namespaceAccessRevision,
      expectedPolicyRevision: fixture.policyRevision,
      descriptorBytes: null,
      acceptedMaterial: null,
      finishedAt: null,
    };
    expect((await repository.create(record)).status).toBe("created");
    ids.push(requestId);
  }
  return ids;
}

function deviceClients(fixture: Fixture): Readonly<{
  domain: DomainKeyAuthorityClientV2;
  namespace: DomainNamespaceAuthorityClientV2;
}> {
  const namespace: DomainNamespaceAuthorityClientV2 = {
    ensure: async () => ({ status: "ready" }),
    servicePending: async () => 0,
    withOpenedGenerations: async (input, use) => {
      const material = fixture.namespaces.get(input.namespaceId);
      if (material === undefined || material.roomId !== input.sourceRoomId) {
        return { status: "unavailable", reason: "unknown_namespace" };
      }
      return {
        status: "opened",
        value: await use([{
          namespaceId: material.namespaceId,
          keyClass: "ai",
          accessRevision: material.authority.namespaceAccessRevision,
          generation: material.authority.namespaceKeyGeneration,
          headDigest: material.authority.namespaceHeadDigest,
          generationKey: material.generationKey,
        }], material.openedNamespace),
      };
    },
  };
  const domain: DomainKeyAuthorityClientV2 = {
    ensure: async () => ({ status: "ready" }),
    servicePending: async () => ({ status: "ready", fulfilled: 0 }),
    withDomainKey: async (input, use) => {
      const material = fixture.namespaces.get(input.namespaceId);
      if (material === undefined || material.roomId !== input.sourceRoomId) {
        return { status: "unavailable", reason: "unknown_namespace" };
      }
      const target = fixture.domainMaterials.get(material.authority.domainId);
      if (target === undefined) {
        return { status: "unavailable", reason: "unknown_domain" };
      }
      return { status: "opened", value: await use(target.key, target.authority) };
    },
  };
  return Object.freeze({ domain, namespace });
}

async function authorizeReflectionRequest(
  fixture: Fixture,
  crypto: LatticeCrypto,
  repository: PostgresBackgroundAuthorizationRepository,
  request: BackgroundAuthorizationRecord,
  now: number,
): Promise<void> {
  if (request.descriptorBytes === null) {
    throw new Error("M327 current device request has no descriptor");
  }
  const currentDevice = await new PostgresDeviceAdmissionRepository(
    await verifyCryptoPostgresHandle(connection(restricted)),
    crypto,
  ).currentAuthorityForDelegation({
    userId: fixture.userId,
    humanActorId: fixture.humanActorId,
    deviceId: fixture.deviceId,
  });
  if (currentDevice === null) throw new Error("M327 current signing device disappeared");
  const issuer: BackgroundAuthorizationIssuerV2 = {
    humanId: currentDevice.humanActorId,
    deviceId: currentDevice.deviceId,
    deviceGeneration: currentDevice.deviceGeneration,
    serverInstanceId: currentDevice.serverInstanceId,
    lineageGeneration: currentDevice.lineageGeneration,
    epoch: currentDevice.epoch,
    securityRevision: currentDevice.securityRevision,
    headDigest: currentDevice.headDigest,
    signingPublicKeyHash: crypto.hash(currentDevice.signingPublicKey),
  };
  const clients = deviceClients(fixture);
  const response = await respondToCurrentDeviceAuthorizationV2({
    descriptorBytes: request.descriptorBytes,
    domainAuthority: clients.domain,
    namespaceAuthority: clients.namespace,
    crypto,
    serverId: SERVER_SCOPE,
    now: () => now,
    createId: () => `m327-reflection-credential-${randomUUID()}`,
    withCurrentSigningAuthority: async use => use({
      issuer,
      signingPrivateKey: fixture.signing.privateKey,
      policyRevision: fixture.policyRevision,
    }),
  });
  expect(response.status).toBe("ready");
  if (response.status !== "ready") throw new Error(`M327 response was ${response.status}`);
  const inspected = inspectBackgroundAuthorizationResponseV2(response.responseBytes);
  expect(inspected.descriptorHash).toEqual(crypto.hash(request.descriptorBytes));
  const verified = await verifyBackgroundAuthorizationResponseV2(crypto, {
    responseBytes: response.responseBytes,
    now: now + 1,
    resolveCurrentIssuer: () => Uint8Array.from(currentDevice.signingPublicKey),
  });
  expect((await repository.acceptVerifiedResponse({
    response: { ...verified, formatVersion: 2, kind: "processor" },
    acceptedAt: now + 1,
  })).status).toBe("accepted");
  response.responseBytes.fill(0);
}

async function markFixturePurged(
  fixture: Fixture,
  priorRequestIds: readonly string[],
  repository: PostgresBackgroundAuthorizationRepository,
): Promise<void> {
  await admin.unsafe(
    "UPDATE reflection_records SET disposition = 'purged' WHERE record_id = $1",
    [fixture.recordId],
  ).catch(() => undefined);
  const unsettled = await restricted.unsafe<{ request_id: string }[]>(
    `SELECT request_id
       FROM background_crypto_authorization_requests
      WHERE work_id = $1
        AND processor_kind = 'reflection'
        AND state IN ('awaiting_recipient', 'awaiting_device', 'grant_ready')`,
    [workId(fixture.recordId)],
  ).catch(() => []);
  for (const row of unsettled) {
    const request = await repository.get(row.request_id);
    if (request !== null) {
      await repository.cancelUnconsumedProcessorRequest({
        expected: request,
        now: Date.now(),
        reason: "superseded",
      }).catch(() => false);
    }
  }
  await restricted.unsafe(
    `DELETE FROM processor_crypto_signer_authorizations WHERE request_id = ANY($1::text[])
       AND request_id LIKE 'm327-prior-%'`,
    [priorRequestIds],
  ).catch(() => undefined);
  await restricted.unsafe(
    `DELETE FROM background_crypto_authorization_requests WHERE request_id = ANY($1::text[])
       AND request_id LIKE 'm327-prior-%'`,
    [priorRequestIds],
  ).catch(() => undefined);
  await writeFile(RESIDUE_PATH, `${JSON.stringify({
    instance: process.env["NAUTILO_INSTANCE"] ?? null,
    runId: fixture.runId,
    userId: fixture.userId,
    recordId: fixture.recordId,
    roomIds: [...new Set([fixture.sourceRoomId, fixture.authorityRoomId, fixture.accessRoomId])],
    namespaceIds: [...new Set([
      fixture.sourceNamespaceId,
      fixture.authorityNamespaceId,
      fixture.accessNamespaceId,
    ])],
    cryptoObjectIds: [fixture.sourceObjectId, `${workId(fixture.recordId)}:record`],
    priorRequestIds,
  }, null, 2)}\n`);
}

afterAll(async () => {
  await Promise.all([admin.end(), product.end(), restricted.end()]);
});

describe.serial("M327 protected Reflection production composition", () => {
  for (const topology of [
    "shared-domain",
    "distinct-domain",
    "cross-room",
    "cross-room-memory",
  ] as const) {
  test(`${topology} publishes and foreground-opens a protected parent with exact input authority`, async () => {
    const crypto = new LatticeCrypto();
    const fixture = await establishFixture(crypto, topology);
    if (isCrossRoomTopology(topology)) {
      const audiences = await product.unsafe<{
        id: string;
        human_actor_ids: string[];
      }[]>(
        `SELECT id::text, human_actor_ids
           FROM rooms
          WHERE id = ANY($1::uuid[])
          ORDER BY id`,
        [[fixture.sourceRoomId, fixture.authorityRoomId]],
      );
      const byRoom = new Map(audiences.map(row => [row.id, row.human_actor_ids]));
      expect(new Set(byRoom.get(fixture.sourceRoomId))).toEqual(new Set([
        fixture.humanActorId,
        fixture.extraHumanActorId,
      ].filter((value): value is string => value !== undefined)));
      expect(new Set(byRoom.get(fixture.authorityRoomId))).toEqual(new Set([
        fixture.humanActorId,
        fixture.authorityExtraHumanActorId,
      ].filter((value): value is string => value !== undefined)));
    }
    const cryptoHandle = await verifyCryptoPostgresHandle(connection(restricted));
    const repository = new PostgresBackgroundAuthorizationRepository(cryptoHandle);
    const priorRequestIds = await seedSupersededRequests(fixture, repository);
    const { sourceRequestId } = await persistNativeProtectedRecord(
      fixture,
      crypto,
      repository,
      isCrossRoomTopology(topology)
        ? {terminalAuthorityNamespaceId: fixture.sourceNamespaceId}
        : {},
    );
    const candidateFixture = Object.freeze({
      ...fixture,
      runId: `${fixture.runId}-candidate`,
      recordId: randomUUID(),
      batchId: randomUUID(),
      sourceObjectId: `m327-source-${fixture.runId}-candidate`,
      ...(isCrossRoomTopology(topology) ? {
        sourceRoomId: fixture.authorityRoomId,
        sourceNamespaceId: fixture.authorityNamespaceId,
        domainId: fixture.targetDomainAuthority.domainId,
        domainKey: fixture.targetDomainKey,
        domainAuthority: fixture.targetDomainAuthority,
      } : {}),
    });
    const supportFixture = isCrossRoomTopology(topology) ? Object.freeze({
      ...fixture,
      runId: `${fixture.runId}-support`,
      recordId: randomUUID(),
      batchId: randomUUID(),
      sourceObjectId: `m327-source-${fixture.runId}-support`,
    }) : undefined;
    const citedSibling = supportFixture ?? candidateFixture;
    const recordProductHandle = await verifyRecordProductPostgresHandle(connection(product));
    if (fixture.topology !== "shared-domain") {
      const authorityStore = new PostgresAuthorityProjectionStore(recordProductHandle);
      expect(await authorityStore.installInitialClosure({
        recordRef: fixture.recordId,
        closureGeneration: 1,
        terminalAuthorityLeafHandles: [isCrossRoomTopology(topology)
          ? fixture.sourceNamespaceId
          : fixture.authorityNamespaceId],
      })).toBe("installed");
    }
    const embedding = Array.from({ length: 1_536 }, (_, index) => index === 0 ? 1 : 0);
    await admin.unsafe(
      `INSERT INTO reflection_record_search_projections (
         record_id, record_processing_generation, projection_version,
         projection_generation, embedding_provider, embedding_canonical_model,
         embedding_dimensions, embedding_contract_version, embedding
       ) VALUES ($1, 1, 1, 1, 'openai', 'text-embedding-3-small', 1536, 1, $2)`,
      [fixture.recordId, `[${embedding.join(",")}]`],
    );
    const requestedRecords: BackgroundAuthorizationRecord[] = [];
    const readinessCoordinates: Array<Readonly<{ roomId: string; namespaceId: string }>> = [];
    let clock = fixture.now + 10;
    const maintenance = await createProductionReflectionAuthorityMaintenance({
      db,
      restricted: connection(restricted),
      crypto,
      serverScope: SERVER_SCOPE,
      commitmentKey: digest(`commitment:${fixture.runId}`),
      authorizationRequested: async record => { requestedRecords.push(record); },
      namespaceReadinessRequested: async coordinate => {
        readinessCoordinates.push(coordinate);
        if (
          (topology === "distinct-domain" && readinessCoordinates.length === 2)
        ) {
          await fixture.provisionAccessNamespace();
        } else if (isCrossRoomTopology(topology)) {
          await fixture.provisionNamespace(coordinate);
        }
      },
      now: () => clock,
    });
    let createdParentRecordRef: string | undefined;
    let authoredMemoryId: string | undefined;
    try {
      const claim = {
        logicalObjectRef: fixture.recordId,
        generation: 1,
        recordRef: fixture.recordId,
        changeReason: "created" as const,
        stage: "authority_projection" as const,
        leaseToken: `m327-lease-${fixture.runId}`,
      };
      let first: Awaited<ReturnType<typeof maintenance.ensureAuthority>> | undefined;
      for (let attempt = 0; attempt < 8 && requestedRecords.length === 0; attempt += 1) {
        first = await maintenance.ensureAuthority(claim);
        clock += 15_001;
      }
      expect(first).toMatchObject({ status: "waiting" });
      if (topology === "distinct-domain") {
        expect(readinessCoordinates).toEqual([
          { roomId: fixture.accessRoomId, namespaceId: fixture.accessNamespaceId },
          { roomId: fixture.accessRoomId, namespaceId: fixture.accessNamespaceId },
        ]);
      } else if (isCrossRoomTopology(topology)) {
        expect(readinessCoordinates.length).toBeGreaterThan(0);
      } else {
        expect(readinessCoordinates).toEqual([]);
      }
      const currentRequest = requestedRecords.at(-1);
      if (currentRequest === undefined || currentRequest.descriptorBytes === null) {
        throw new Error("M327 current device request was not prepared");
      }
      const descriptorBytes = currentRequest.descriptorBytes;
      expect(currentRequest.snapshot.state).toBe("awaiting_device");
      const priorStates = await restricted.unsafe<{ state: string; count: string }[]>(
        `SELECT state, count(*)::text AS count
           FROM background_crypto_authorization_requests
          WHERE request_id = ANY($1::text[])
          GROUP BY state`,
        [priorRequestIds],
      );
      expect([...priorStates]).toEqual([{ state: "cancelled", count: "257" }]);
      expect((await repository.get(currentRequest.snapshot.requestId))?.snapshot.state)
        .toBe("awaiting_device");

      const currentDevice = await new PostgresDeviceAdmissionRepository(cryptoHandle, crypto)
        .currentAuthorityForDelegation({
          userId: fixture.userId,
          humanActorId: fixture.humanActorId,
          deviceId: fixture.deviceId,
        });
      if (currentDevice === null) throw new Error("M327 current signing device disappeared");
      const signingProbe = digest(`signing-probe:${fixture.runId}`);
      const signingProbeSignature = crypto.sign(fixture.signing.privateKey, signingProbe);
      expect(crypto.verify(currentDevice.signingPublicKey, signingProbe, signingProbeSignature)).toBe(true);
      signingProbe.fill(0);
      signingProbeSignature.fill(0);
      const issuer: BackgroundAuthorizationIssuerV2 = {
        humanId: currentDevice.humanActorId,
        deviceId: currentDevice.deviceId,
        deviceGeneration: currentDevice.deviceGeneration,
        serverInstanceId: currentDevice.serverInstanceId,
        lineageGeneration: currentDevice.lineageGeneration,
        epoch: currentDevice.epoch,
        securityRevision: currentDevice.securityRevision,
        headDigest: currentDevice.headDigest,
        signingPublicKeyHash: crypto.hash(currentDevice.signingPublicKey),
      };
      const clients = deviceClients(fixture);
      const response = await respondToCurrentDeviceAuthorizationV2({
        descriptorBytes,
        domainAuthority: clients.domain,
        namespaceAuthority: clients.namespace,
        crypto,
        serverId: SERVER_SCOPE,
        now: () => clock + 1,
        createId: () => `m327-reflection-credential-${fixture.runId}`,
        withCurrentSigningAuthority: async use => use({
          issuer,
          signingPrivateKey: fixture.signing.privateKey,
          policyRevision: fixture.policyRevision,
        }),
      });
      expect(response.status).toBe("ready");
      if (response.status !== "ready") throw new Error(`M327 response was ${response.status}`);
      const inspectedResponse = inspectBackgroundAuthorizationResponseV2(response.responseBytes);
      expect(inspectedResponse.descriptorHash).toEqual(crypto.hash(descriptorBytes));
      expect(inspectedResponse.issuer.signingPublicKeyHash).toEqual(crypto.hash(currentDevice.signingPublicKey));
      const verified = await verifyBackgroundAuthorizationResponseV2(crypto, {
        responseBytes: response.responseBytes, now: clock + 2,
        resolveCurrentIssuer: () => Uint8Array.from(currentDevice.signingPublicKey),
      });
      expect((await repository.acceptVerifiedResponse({
        response: { ...verified, formatVersion: 2, kind: "processor" },
        acceptedAt: clock + 2,
      })).status).toBe("accepted");
      response.responseBytes.fill(0);

      clock += 3;
      expect(await maintenance.ensureAuthority(claim)).toEqual({ status: "ready" });

      const targetObjectId = `${workId(fixture.recordId)}:record`;
      const [projection] = await admin.unsafe<{
        projection_generation: number;
        processing_state: string;
        current_representation_generation: number;
        crypto_object_id: string;
      }[]>(
        `SELECT projection.projection_generation, projection.processing_state,
                head.current_representation_generation, representation.crypto_object_id
           FROM reflection_record_authority_projections projection
           JOIN reflection_record_payload_representation_heads head
             ON head.record_id = projection.record_id AND head.representation = 'protected'
           JOIN reflection_record_payload_representations representation
             ON representation.record_id = head.record_id
            AND representation.representation = head.representation
            AND representation.representation_generation = head.current_representation_generation
          WHERE projection.record_id = $1 AND projection.current = true`,
        [fixture.recordId],
      );
      expect(projection).toEqual({
        projection_generation: 2,
        processing_state: "current",
        current_representation_generation: 2,
        crypto_object_id: targetObjectId,
      });
      expect((await repository.get(currentRequest.snapshot.requestId))?.snapshot.state).toBe("completed");
      expect((await repository.get(sourceRequestId))?.snapshot.state).toBe("completed");
      await maintenance.maintain({ limit: 256 });
      const [retirement] = await admin.unsafe<{ former_crypto_retired_at: Date | null }[]>(
        `SELECT former_crypto_retired_at
           FROM reflection_record_authority_reconciliations
          WHERE record_id = $1 AND source_change_generation = 1`,
        [fixture.recordId],
      );
      expect(retirement?.former_crypto_retired_at).toBeInstanceOf(Date);
      const [retiredObject] = await restricted.unsafe<{
        access_revision: string;
        envelope_count: string;
      }[]>(
        `SELECT head.access_revision,
                (SELECT count(*)::text FROM object_crypto_namespace_envelopes envelope
                  WHERE envelope.object_id = head.object_id
                    AND envelope.access_revision = head.access_revision) AS envelope_count
           FROM object_crypto_access_heads head
          WHERE head.object_id = $1`,
        [fixture.sourceObjectId],
      );
      expect(retiredObject).toEqual({ access_revision: "1", envelope_count: "0" });

      const prepareAdditionalRecord = async (
        additionalFixture: typeof fixture,
        journalSequence: number,
        terminalAuthorityNamespaceId: string,
      ) => {
        await persistNativeProtectedRecord(additionalFixture, crypto, repository, {
          initializeRoomState: false,
          journalSequence,
          terminalAuthorityNamespaceId,
          statement: "M327 protected Reflection sibling proof",
        });
        if (fixture.topology !== "shared-domain") {
          expect(await new PostgresAuthorityProjectionStore(recordProductHandle).installInitialClosure({
            recordRef: additionalFixture.recordId,
            closureGeneration: 1,
            terminalAuthorityLeafHandles: [terminalAuthorityNamespaceId],
          })).toBe("installed");
        }
        await admin.unsafe(
          `INSERT INTO reflection_record_search_projections (
             record_id, record_processing_generation, projection_version,
             projection_generation, embedding_provider, embedding_canonical_model,
             embedding_dimensions, embedding_contract_version, embedding
           ) VALUES ($1, 1, 1, 1, 'openai', 'text-embedding-3-small', 1536, 1, $2)`,
          [additionalFixture.recordId, `[${embedding.join(",")}]`],
        );
        const candidateAuthorityClaim = {
          logicalObjectRef: additionalFixture.recordId,
          generation: 1,
          recordRef: additionalFixture.recordId,
          changeReason: "created" as const,
          stage: "authority_projection" as const,
          leaseToken: `m327-lease-${additionalFixture.runId}`,
        };
        const candidateRequestOffset = requestedRecords.length;
        let candidateReadiness: Awaited<ReturnType<typeof maintenance.ensureAuthority>> | undefined;
        for (let attempt = 0; attempt < 8 && requestedRecords.length === candidateRequestOffset; attempt += 1) {
          candidateReadiness = await maintenance.ensureAuthority(candidateAuthorityClaim);
          clock += 15_001;
        }
        expect(candidateReadiness).toMatchObject({status: "waiting"});
        const candidateRequest = requestedRecords.at(candidateRequestOffset);
        if (candidateRequest === undefined) throw new Error("M327 candidate authority grant was not requested");
        await authorizeReflectionRequest(additionalFixture, crypto, repository, candidateRequest, clock + 1);
        clock += 3;
        expect(await maintenance.ensureAuthority(candidateAuthorityClaim)).toEqual({status: "ready"});
        expect(await new PostgresAuthorityProjectionStore(recordProductHandle)
          .readCurrent(additionalFixture.recordId)).toMatchObject({
            protectedAuthorityCurrent: true,
            processingState: "current",
            recordDisposition: "available",
          });
      };
      const authoredMemory = topology === "cross-room-memory"
        ? await persistAuthoredProtectedMemory(
            fixture,
            crypto,
            embedding,
            currentDevice.securityRevision,
          )
        : undefined;
      authoredMemoryId = authoredMemory?.memoryId;
      if (authoredMemory === undefined) {
        await prepareAdditionalRecord(candidateFixture, 2, fixture.authorityNamespaceId);
      }
      if (supportFixture !== undefined) {
        await prepareAdditionalRecord(supportFixture, 3, fixture.sourceNamespaceId);
      }

      if (topology === "shared-domain") {
        const candidateObjectId = `${workId(candidateFixture.recordId)}:record`;
        const reconciliations = await product.unsafe<{
          record_id: string;
          state: string;
          target_representation_generation: number;
          target_crypto_object_id: string;
          target_access_namespace_ids: string[];
        }[]>(
          `SELECT record_id, state, target_representation_generation,
                  target_crypto_object_id, target_access_namespace_ids
             FROM reflection_record_authority_reconciliations
            WHERE record_id = ANY($1::text[]) AND source_change_generation = 1
            ORDER BY record_id`,
          [[fixture.recordId, candidateFixture.recordId]],
        );
        expect(reconciliations).toHaveLength(2);
        expect(reconciliations.find(row => row.record_id === fixture.recordId)).toMatchObject({
          state: "complete",
          target_representation_generation: 2,
          target_crypto_object_id: targetObjectId,
          target_access_namespace_ids: [fixture.accessNamespaceId],
        });
        expect(reconciliations.find(row => row.record_id === candidateFixture.recordId)).toMatchObject({
          state: "complete",
          target_representation_generation: 2,
          target_crypto_object_id: candidateObjectId,
          target_access_namespace_ids: [fixture.accessNamespaceId],
        });
        const publications = await product.unsafe<{
          record_id: string;
          representation_generation: number;
          crypto_object_id: string;
        }[]>(
          `SELECT record_id, representation_generation, crypto_object_id
             FROM reflection_record_publications
            WHERE record_id = ANY($1::text[]) AND representation = 'protected'
            ORDER BY record_id, representation_generation`,
          [[fixture.recordId, candidateFixture.recordId]],
        );
        expect(publications).toHaveLength(2);
        expect(publications.find(row => row.record_id === fixture.recordId)).toEqual({
          record_id: fixture.recordId,
          representation_generation: 1,
          crypto_object_id: fixture.sourceObjectId,
        });
        expect(publications.find(row => row.record_id === candidateFixture.recordId)).toEqual({
          record_id: candidateFixture.recordId,
          representation_generation: 1,
          crypto_object_id: candidateFixture.sourceObjectId,
        });

        const conversationProduct = await verifyConversationProductPostgresHandle(connection(product));
        const journalSelectionPort = createPostgresForegroundJournalSelectionPort({
          product: conversationProduct,
        });
        const journalSelection = await journalSelectionPort.selectCurrent({
          roomId: fixture.sourceRoomId,
          namespaceId: fixture.sourceNamespaceId,
          maximumEvents: 8,
        });
        expect(journalSelection).toMatchObject({
          roomId: fixture.sourceRoomId,
          namespaceId: fixture.sourceNamespaceId,
          rebuildGeneration: 0,
          events: [{
            binding: {
              eventId: fixture.recordId,
              roomId: fixture.sourceRoomId,
              namespaceId: fixture.sourceNamespaceId,
            },
            payload: { protectedMapping: {
              status: "mapped",
              representationGeneration: 2,
              cryptoObjectId: targetObjectId,
            } },
          }, {
            binding: {
              eventId: candidateFixture.recordId,
              roomId: fixture.sourceRoomId,
              namespaceId: fixture.sourceNamespaceId,
            },
            payload: { protectedMapping: {
              status: "mapped",
              representationGeneration: 2,
              cryptoObjectId: candidateObjectId,
            } },
          }],
        });
        if (journalSelection === null) throw new Error("M327 native Journal selection is missing");
        const journalSources = await loadPostgresForegroundJournalRepairSources({
          product: conversationProduct,
          snapshot: journalSelection,
          representationMode: "protected-only",
        });
        expect(journalSources.map(source => ({
          logicalId: source.logicalId,
          existingObjectId: source.existingObjectId,
          representationGeneration: source.representationGeneration,
          accessNamespaceIds: source.accessNamespaceIds,
        }))).toEqual([{
          logicalId: fixture.recordId,
          existingObjectId: targetObjectId,
          representationGeneration: 2,
          accessNamespaceIds: [fixture.accessNamespaceId],
        }, {
          logicalId: candidateFixture.recordId,
          existingObjectId: candidateObjectId,
          representationGeneration: 2,
          accessNamespaceIds: [fixture.accessNamespaceId],
        }]);

        const journalEntities: Pick<ForegroundAgentEntityCryptoInvocation, "signal" | "use" | "useCurrentSet"> = {
          signal: new AbortController().signal,
          use: async input => {
            const material = fixture.namespaces.get(input.entity.namespaceId);
            if (material === undefined) {
              return { status: "unavailable" as const, reason: "content_unavailable" as const };
            }
            return { status: "executed" as const, value: await input.execute({
              namespaceKey: material.generationKey,
              authority: {
                namespaceId: material.authority.namespaceId,
                namespaceAccessRevision: material.authority.namespaceAccessRevision,
                namespaceKeyGeneration: material.authority.namespaceKeyGeneration,
                domainId: material.authority.domainId,
                domainKeyGeneration: material.authority.domainKeyGeneration,
                domainAuthorizationRevision: material.authority.domainAuthorizationRevision,
                domainHeadDigest: material.authority.domainHeadDigest,
                namespaceHeadDigest: material.authority.namespaceHeadDigest,
                namespacePublicationDigest: material.authority.namespaceHeadDigest,
                namespacePublicationSetDigest: material.authority.namespaceHeadDigest,
                namespaceAudienceFingerprint: material.authority.namespaceHeadDigest,
              },
            }) };
          },
          useCurrentSet: async () => {
            throw new Error("current native Journal must not republish");
          },
        };
        const journalRepairer = createForegroundJournalHistoryRepairer({
          crypto,
          entities: journalEntities,
          room: { roomId: fixture.sourceRoomId, namespaceId: fixture.sourceNamespaceId },
          sourceRepresentationMode: "protected-only",
          publication: {
            operationId: `unused-journal-${fixture.runId}`,
            grantId: `unused-journal-${fixture.runId}`,
            grantDigest: digest(`unused-journal-grant:${fixture.runId}`),
            recipientKeyId: `unused-journal-${fixture.runId}`,
            runtime: { agentId: "unused", keyClass: "runtime", generation: 1,
              key: digest("unused-journal-runtime") } as never,
            signerKeyId: `unused-journal-${fixture.runId}`,
            signerPublicKey: digest("unused-journal-signer"),
            agentAuthorizationRevision: 1,
          },
          selection: journalSelectionPort,
          loadSources: (snapshot, representationMode) =>
            loadPostgresForegroundJournalRepairSources({
              product: conversationProduct,
              snapshot,
              representationMode: representationMode ?? "protected-only",
            }),
          persist: async () => { throw new Error("current native Journal must not persist"); },
          read: request => readVerifiedDeviceWrappedAgentObject({
            handle: cryptoHandle,
            crypto,
            ...request,
            resolveHistoricalAgentSignerAuthority: () => null,
          }),
          validateExisting: request => validatePostgresForegroundJournalRepairSource({
            product: conversationProduct,
            ...request,
          }),
          attach: async () => { throw new Error("current native Journal must not attach"); },
        });
        expect(await journalRepairer.protect({ maximumEvents: 8 })).toEqual({
          status: "verified",
          journal: {
            rollup: null,
            events: [{
              id: fixture.recordId,
              roomId: fixture.sourceRoomId,
              sequence: 1,
              kind: "fact",
              statement: "M327 protected Reflection foreground proof",
              status: "active",
              supersedesEventId: null,
              resolvesEventId: null,
            }, {
              id: candidateFixture.recordId,
              roomId: fixture.sourceRoomId,
              sequence: 2,
              kind: "fact",
              statement: "M327 protected Reflection sibling proof",
              status: "active",
              supersedesEventId: null,
              resolvesEventId: null,
            }],
          },
          provenance: "existing",
          repairedCount: 0,
          includesReflectionRecord: true,
          verification: "authenticated",
          ordinaryRestoredCount: 0,
        });
      }

      const [preservedSearchProjection] = await admin.unsafe<{
        record_processing_generation: number;
        projection_generation: number;
      }[]>(
        `SELECT record_processing_generation, projection_generation
           FROM reflection_record_search_projections
          WHERE record_id = $1`,
        [fixture.recordId],
      );
      expect(preservedSearchProjection).toEqual({
        record_processing_generation: 1,
        projection_generation: 1,
      });

      const semanticCommitmentKey = digest(`semantic-commitment:${fixture.runId}`);
      clock = Date.now() + 60_000;
      const semanticWork = new PostgresSemanticWorkStore({
        handle: recordProductHandle,
        commitments: createHmacRecordSemanticCommitmentPort(semanticCommitmentKey),
        clock: () => new Date(clock),
      });
      await admin.unsafe(
        "DELETE FROM reflection_record_search_projections WHERE record_id = $1",
        [fixture.recordId],
      );
      await semanticWork.enqueue({
        logicalObjectRef: fixture.recordId,
        generation: 1,
        recordRef: fixture.recordId,
        changeReason: "created",
      });
      const claimStage = async (
        stage: DurableSleepClaim["stage"],
        recordRef = fixture.recordId,
      ): Promise<DurableSleepClaim> => {
        const leaseToken = randomUUID();
        const claimNow = Math.max(clock, Date.now());
        const [claimed] = await product.unsafe<{
          generation: number;
          change_reason: DurableSleepClaim["changeReason"];
        }[]>(
          `UPDATE reflection_record_semantic_work
              SET state = 'claimed', claim_generation = generation,
                  attempt_count = attempt_count + 1, lease_token = $3,
                  lease_expires_at = $4, next_attempt_at = NULL,
                  failure_code = NULL, started_at = coalesce(started_at, $2),
                  completed_at = NULL, updated_at = greatest(updated_at, $2)
            WHERE record_id = $1 AND stage = $5
              AND state IN ('due', 'checkpointed', 'deferred')
          RETURNING generation, change_reason, due_since, started_at`,
          [recordRef, new Date(claimNow).toISOString(), leaseToken,
            new Date(claimNow + 120_000).toISOString(), stage],
        );
        if (claimed === undefined) throw new Error(`M327 ${stage} work was not claimable`);
        return {
          logicalObjectRef: recordRef,
          generation: claimed.generation,
          recordRef,
          changeReason: claimed.change_reason,
          stage,
          leaseToken,
        };
      };
      const authorityClaim = await claimStage("authority_projection");
      const semanticAuthority = await new PostgresAuthorityProjectionStore(recordProductHandle).readCurrent(fixture.recordId);
      expect(semanticAuthority).toMatchObject({
        protectedAuthorityCurrent: true,
        processingState: "current",
        recordDisposition: "available",
      });
      expect(await maintenance.ensureAuthority(authorityClaim)).toEqual({ status: "ready" });
      expect(await semanticWork.checkpoint({claim: authorityClaim, completedStage: "authority_projection"}))
        .toMatchObject({status: "accepted"});

      let embeddingCalls = 0;
      const protectedSearch = await createProductionProtectedReflectionSearchComposition({
        db,
        commitmentKey: semanticCommitmentKey,
        runSemantic: maintenance.runSemantic,
        embedding: {embed: async () => {
          embeddingCalls += 1;
          return {status: "available", embedding: {provenance: {
            provider: "openai",
            canonicalModel: "text-embedding-3-small",
            dimensions: 1_536,
            contractVersion: 1,
          }, vector: embedding}};
        }},
        now: () => clock,
      });
      const searchClaim = await claimStage("search_projection");
      const searchRequestOffset = requestedRecords.length;
      expect(await protectedSearch.ensureSearchProjection(searchClaim)).toMatchObject({status: "waiting"});
      expect(embeddingCalls).toBe(0);
      const searchRequest = requestedRecords.at(searchRequestOffset);
      if (searchRequest === undefined) throw new Error("M327 protected search grant was not requested");
      await authorizeReflectionRequest(fixture, crypto, repository, searchRequest, clock + 1);
      clock += 3;
      expect(await protectedSearch.ensureSearchProjection(searchClaim)).toEqual({status: "ready"});
      expect(embeddingCalls).toBe(1);
      expect((await repository.get(searchRequest.snapshot.requestId))?.snapshot.state).toBe("completed");
      expect(await semanticWork.checkpoint({claim: searchClaim, completedStage: "search_projection"}))
        .toMatchObject({status: "accepted"});
      const [searchCoordinates] = await product.unsafe<{
        processing_generation: number;
        record_processing_generation: number;
      }[]>(
        `SELECT record.processing_generation, projection.record_processing_generation
           FROM reflection_records record
           JOIN reflection_record_search_projections projection
             ON projection.record_id = record.record_id
          WHERE record.record_id = $1`,
        [fixture.recordId],
      );
      expect(searchCoordinates).toEqual({processing_generation: 1, record_processing_generation: 1});

      let modelCalls = 0;
      const protectedSemantics = createProductionProtectedReflectionSemantics({
        db,
        productHandle: recordProductHandle,
        selection: {selectedRepresentation: "protected", migrationGeneration: 1},
        commitmentKey: semanticCommitmentKey,
        operation: maintenance,
        readiness: {ensureAuthority: maintenance.ensureAuthority, ensureSearchProjection: protectedSearch.ensureSearchProjection},
        model: {
          invoke: async () => {
            modelCalls += 1;
            return '{"operation":"create_parent","statement":"M327 protected sibling synthesis","childRecordRefs":["R1","C1"]}';
          },
          invokeBatch: async claims => {
            modelCalls += 1;
            return JSON.stringify({answers: claims.map((_, index) => ({question: `Q${index + 1}`, proposal: {operation: "no_change"}}))});
          },
        },
        resolveParentConflict: async () => ({status: "not_applicable"}),
        sourceInvalidation: {admit: async () => {}},
        nextRetryAt: () => clock + 15_000,
      });
      const firstOrganizationClaim = await claimStage("organization");
      const organizationRequestOffset = requestedRecords.length;
      let initialOrganizerView: Awaited<ReturnType<typeof protectedSemantics.loadOrganizerView>> | undefined;
      let firstAttempt: Awaited<ReturnType<NonNullable<typeof protectedSemantics.openOrganizationAttempt>>> | undefined;
      for (let attempt = 0; attempt < 8 && initialOrganizerView === undefined; attempt += 1) {
        firstAttempt = await protectedSemantics.openOrganizationAttempt!(firstOrganizationClaim);
        try {
          initialOrganizerView = await protectedSemantics.loadOrganizerView(firstOrganizationClaim);
        } catch (error) {
          if (!isCrossRoomTopology(topology) || !error || typeof error !== "object"
            || !("failureClass" in error) || error.failureClass !== "key_waiting") throw error;
          await firstAttempt.close("unavailable");
          firstAttempt = undefined;
          clock += 15_001;
        }
      }
      expect(initialOrganizerView).toMatchObject({status: "waiting"});
      expect(modelCalls).toBe(0);
      if (firstAttempt === undefined) throw new Error("M327 protected Organizer attempt was not prepared");
      await firstAttempt.close("unavailable");
      expect(await semanticWork.pause({claim: firstOrganizationClaim})).toMatchObject({status: "accepted"});
      const organizationRequest = requestedRecords.at(organizationRequestOffset);
      if (organizationRequest === undefined) throw new Error("M327 protected Organizer grant was not requested");
      if (isCrossRoomTopology(topology)) {
        if (organizationRequest.descriptorBytes === null) {
          throw new Error("M327 cross-Room Organizer descriptor was not prepared");
        }
        const descriptor = decodeBackgroundWorkDescriptorV2(
          organizationRequest.descriptorBytes,
        );
        expect(descriptor.subject).toMatchObject({
          kind: "processor",
          processorKind: "reflection",
        });
        const expectedInputObjectIds = [
          objectId(`${workId(fixture.recordId)}:record`),
          objectId(`${workId(supportFixture!.recordId)}:record`),
          objectId(authoredMemory?.objectId
            ?? `${workId(candidateFixture.recordId)}:record`),
        ];
        expect(new Set(descriptor.inputBindings.map(input => input.objectId)))
          .toEqual(new Set(expectedInputObjectIds));
        expect(descriptor.inputBindings).toHaveLength(3);
        const bindingReader = new PostgresCurrentRecordPublicationBinding(
          recordProductHandle,
          {selectedRepresentation: "protected", migrationGeneration: 1},
        );
        const currentInputBindings = await Promise.all([
          bindingReader.read(fixture.recordId),
          bindingReader.read(supportFixture!.recordId),
          ...(authoredMemory ? [] : [bindingReader.read(candidateFixture.recordId)]),
        ]);
        expect(new Set(descriptor.inputBindings.map(input => input.namespaceId)))
          .toEqual(new Set([
            ...currentInputBindings.flatMap(binding =>
              binding?.currentAccessBindingRefs.map(ref => namespaceId(
                ref.replace(/^journal:namespace:/u, "").replace(/:protected:v1$/u, ""),
              )) ?? []),
            ...(authoredMemory ? [namespaceId(fixture.authorityNamespaceId)] : []),
          ]));
        expect(descriptor.outputSlots).toEqual([
          expect.objectContaining({
            namespaceIds: [namespaceId(fixture.accessNamespaceId)],
          }),
        ]);
      }
      await authorizeReflectionRequest(fixture, crypto, repository, organizationRequest, clock + 1);
      clock += 3;

      const organizationClaim = await claimStage("organization");
      const organizationAttempt = await protectedSemantics.openOrganizationAttempt!(organizationClaim);
      let organizerView: Awaited<ReturnType<typeof protectedSemantics.loadOrganizerView>>;
      try {
        organizerView = await protectedSemantics.loadOrganizerView(organizationClaim);
      } catch (error) {
        throw new Error("M327 authorized Organizer view threw", {cause: error});
      }
      expect(organizerView).toMatchObject({status: "ready", view: {changed: {snapshot: {
        recordRef: fixture.recordId,
        statement: "M327 protected Reflection foreground proof",
      }}}});
      if (organizerView.status !== "ready") throw new Error("Organizer not ready");
      expect(new Set(organizerView.view.candidates.map(candidate => candidate.snapshot.recordRef)))
        .toEqual(new Set([
          authoredMemory?.logicalSourceRef ?? candidateFixture.recordId,
          ...(supportFixture ? [supportFixture.recordId] : []),
        ]));
      if (authoredMemory !== undefined) {
        expect(organizerView.view.candidates.find(candidate =>
          candidate.snapshot.recordRef === authoredMemory.logicalSourceRef))
          .toMatchObject({snapshot: {
            recordRef: authoredMemory.logicalSourceRef,
            statement: "M327 protected authored Memory candidate",
          }});
      }
      const modelResponse = await protectedSemantics.invokeOrganizer(
        organizationClaim,
        "M327 deterministic protected Organizer prompt",
      );
      expect(JSON.parse(modelResponse)).toEqual({
        operation: "create_parent",
        statement: "M327 protected sibling synthesis",
        childRecordRefs: ["R1", "C1"],
      });
      const application = await organizationAttempt.publish(() => protectedSemantics.applyProposal({
        claim: organizationClaim,
        proposal: {
          operation: "create_parent",
          statement: "M327 protected sibling synthesis",
          childRecordRefs: [fixture.recordId, citedSibling.recordId],
          sourceDependencies: [],
        },
        idempotencyKey: `sleep:${fixture.recordId}:${organizationClaim.generation}`,
        budget: REFLECTION_SEMANTIC_RUNTIME_POLICY_V1.budget.hierarchy,
      }));
      await organizationAttempt.close("completed");
      expect(application).toMatchObject({status: "applied", operation: "create_parent", changedRecord: {
        generation: 1,
      }});
      if (application.status !== "applied" || application.changedRecord === undefined) {
        throw new Error("M327 protected parent was not published");
      }
      const parentRecordRef = application.changedRecord.recordRef;
      createdParentRecordRef = parentRecordRef;
      if (isCrossRoomTopology(topology)) {
        const cited = await product.unsafe<{child_record_id: string}[]>(
          `SELECT child_record_id
             FROM reflection_record_dependencies
            WHERE parent_record_id = $1
            ORDER BY child_record_id`,
          [parentRecordRef],
        );
        expect([...cited]).toEqual([
          {child_record_id: fixture.recordId},
          {child_record_id: citedSibling.recordId},
        ].sort((left, right) => left.child_record_id.localeCompare(right.child_record_id)));
        const exposed = await product.unsafe<{dependency_record_id: string}[]>(
          `SELECT dependency_record_id
             FROM reflection_record_authority_dependencies
            WHERE record_id = $1
            ORDER BY dependency_record_id`,
          [parentRecordRef],
        );
        expect([...exposed]).toEqual([
          {dependency_record_id: fixture.recordId},
          ...(authoredMemory === undefined
            ? [{dependency_record_id: candidateFixture.recordId}]
            : []),
          {dependency_record_id: supportFixture!.recordId},
        ].sort((left, right) => left.dependency_record_id.localeCompare(right.dependency_record_id)));
      }
      const [sourceAcknowledgement] = await product.unsafe<{
        state: string;
        generation: number;
        completed_generation: number;
        ordinary_fallback_reason: string | null;
      }[]>(
        `SELECT state, generation, completed_generation, ordinary_fallback_reason
           FROM reflection_record_semantic_work
          WHERE record_id = $1`,
        [fixture.recordId],
      );
      expect(sourceAcknowledgement).toEqual({
        state: "complete",
        generation: organizationClaim.generation,
        completed_generation: organizationClaim.generation,
        ordinary_fallback_reason: null,
      });
      const parentRepresentations = await product.unsafe<{
        representation: "ordinary" | "protected";
        current_representation_generation: number;
        plaintext_bytes: number | null;
        crypto_object_id: string | null;
        publication_state: string;
        origin_publication_binding_ref: string | null;
      }[]>(
        `SELECT head.representation, head.current_representation_generation,
                octet_length(payload.plaintext_payload_bytes) AS plaintext_bytes,
                payload.crypto_object_id, publication.state AS publication_state,
                publication.origin_publication_binding_ref
           FROM reflection_record_payload_representation_heads head
           JOIN reflection_record_payload_representations payload
             ON payload.record_id = head.record_id
            AND payload.representation = head.representation
            AND payload.representation_generation = head.current_representation_generation
           JOIN reflection_record_publications publication
             ON publication.record_id = head.record_id
            AND publication.representation = head.representation
            AND publication.representation_generation = head.current_representation_generation
          WHERE head.record_id = $1
          ORDER BY head.representation`,
        [parentRecordRef],
      );
      const expectedOriginBinding =
        `journal:namespace:${fixture.sourceNamespaceId}:protected:v1`;
      const expectedCandidateOriginBinding = isCrossRoomTopology(topology)
        ? `journal:namespace:${fixture.authorityNamespaceId}:protected:v1`
        : expectedOriginBinding;
      const ordinaryParent = parentRepresentations.find(row => row.representation === "ordinary");
      const protectedParent = parentRepresentations.find(row => row.representation === "protected");
      if (fixture.policyMode === "encrypted_only") {
        expect(parentRepresentations).toHaveLength(1);
        expect(ordinaryParent).toBeUndefined();
      } else {
        expect(parentRepresentations).toHaveLength(2);
        expect(ordinaryParent).toMatchObject({
          representation: "ordinary",
          current_representation_generation: 1,
          crypto_object_id: null,
          publication_state: "complete",
          origin_publication_binding_ref: expectedOriginBinding,
        });
        expect(ordinaryParent?.plaintext_bytes).toBeGreaterThan(0);
      }
      expect(protectedParent).toMatchObject({
        representation: "protected",
        current_representation_generation: 1,
        plaintext_bytes: null,
        publication_state: "complete",
        origin_publication_binding_ref: expectedOriginBinding,
      });
      expect(protectedParent?.crypto_object_id).toBeString();
      const originReader = new PostgresCurrentRecordPublicationBinding(
        recordProductHandle,
        {selectedRepresentation: "protected", migrationGeneration: 1},
      );
      expect(await originReader.readOrigin(parentRecordRef)).toBe(expectedOriginBinding);
      if (authoredMemory === undefined) {
        expect(await originReader.readOrigin(candidateFixture.recordId)).toBe(
          expectedCandidateOriginBinding,
        );
      }
      if (isCrossRoomTopology(topology)) {
        expect(await originReader.read(parentRecordRef)).toMatchObject({
          currentAccessBindingRefs: [
            `journal:namespace:${fixture.accessNamespaceId}:protected:v1`,
          ],
        });
        const [accessAudience] = await product.unsafe<{
          human_actor_ids: string[];
        }[]>(
          "SELECT human_actor_ids FROM rooms WHERE id = $1",
          [fixture.accessRoomId],
        );
        expect(accessAudience?.human_actor_ids).toEqual([fixture.humanActorId]);
        const protectedObjectId = parentRepresentations.find(
          row => row.representation === "protected",
        )?.crypto_object_id;
        if (protectedObjectId === null || protectedObjectId === undefined) {
          throw new Error("M327 cross-Room protected parent object is missing");
        }
        let authenticated: Awaited<ReturnType<typeof readVerifiedDeviceWrappedAgentObject>>;
        try {
          authenticated = await readVerifiedDeviceWrappedAgentObject({
            handle: cryptoHandle,
            crypto,
            objectId: protectedObjectId,
            expectedObjectType: "nautilo.reflection.record.v1",
            expectedNamespaceIds: [fixture.accessNamespaceId],
            resolveHistoricalAgentSignerAuthority: () => null,
          });
        } catch (error) {
          throw new Error("M327 cross-Room parent authentication threw", {cause: error});
        }
        if (authenticated === null || authenticated.namespaceEnvelopes.length !== 1) {
          throw new Error("M327 cross-Room protected parent did not authenticate");
        }
        const plaintext = decryptObjectThroughNamespace(
          crypto,
          fixture.namespaces.get(fixture.accessNamespaceId)!.generationKey,
          decodeNamespaceObjectEnvelopeV2(authenticated.namespaceEnvelopes[0]!.envelopeBytes),
          decodeEncryptedPayloadV2(authenticated.payloadBytes),
        );
        if (plaintext === null) throw new Error("M327 cross-Room parent did not decrypt");
        try {
          const decoded = decodeRecordPayloadV1(plaintext);
          expect(decoded.childRecordIds).toEqual([
            fixture.recordId,
            citedSibling.recordId,
          ].sort());
          const exposure = decoded.modelExposureDependencies ?? [];
          expect(exposure).toHaveLength(3);
          expect(exposure.find(dependency => dependency.kind === "record"
            && dependency.recordId === fixture.recordId)).toMatchObject({
              kind: "record",
              observedProcessingGeneration: 1,
            });
          if (authoredMemory === undefined) {
            expect(exposure.find(dependency => dependency.kind === "record"
              && dependency.recordId === candidateFixture.recordId)).toMatchObject({
                kind: "record",
                observedProcessingGeneration: 1,
              });
          } else {
            expect(exposure.find(dependency => dependency.kind === "source"
              && dependency.sourceKind === "memory"
              && dependency.logicalObjectRef === authoredMemory.logicalSourceRef))
              .toMatchObject({
                kind: "source",
                sourceKind: "memory",
                logicalObjectRef: authoredMemory.logicalSourceRef,
                observedRevision: "1",
                terminalAuthorityLeafHandle: fixture.authorityNamespaceId,
              });
          }
        } finally {
          plaintext.fill(0);
        }
      }
      // Maintenance eligibility also uses PostgreSQL wall time. Keep its
      // injected retry clock behind that time; durable claims use claimNow above.
      clock = Date.now() - 120_000;
      const parentAuthorityClaim = await claimStage(
        "authority_projection",
        parentRecordRef,
      );
      const parentRequestOffset = requestedRecords.length;
      let parentRequestCursor = parentRequestOffset;
      let parentReadiness: Awaited<ReturnType<typeof maintenance.ensureAuthority>> = {status: "waiting", retryAt: clock};
      for (let attempt = 0; attempt < 8 && parentReadiness.status === "waiting"; attempt += 1) {
        parentReadiness = await maintenance.ensureAuthority(parentAuthorityClaim);
        const parentRequest = requestedRecords.at(parentRequestCursor);
        if (parentReadiness.status === "waiting" && parentRequest !== undefined) {
          await authorizeReflectionRequest(fixture, crypto, repository, parentRequest, clock + 1);
          parentRequestCursor += 1;
          clock += 3;
        } else if (parentReadiness.status === "waiting") clock += 15_001;
      }
      if (parentReadiness.status === "waiting") {
        parentReadiness = await maintenance.ensureAuthority(parentAuthorityClaim);
      }
      expect(parentReadiness).toEqual({status: "ready"});
      expect(await semanticWork.checkpoint({
        claim: parentAuthorityClaim,
        completedStage: "authority_projection",
      })).toMatchObject({status: "accepted"});
      if (isCrossRoomTopology(topology)) {
        const parentSearchClaim = await claimStage(
          "search_projection",
          parentRecordRef,
        );
        const requestOffset = requestedRecords.length;
        expect(await protectedSearch.ensureSearchProjection(parentSearchClaim))
          .toMatchObject({status: "waiting"});
        const parentSearchRequest = requestedRecords.at(requestOffset);
        if (parentSearchRequest === undefined) {
          throw new Error("M327 cross-Room parent search grant was not requested");
        }
        await authorizeReflectionRequest(
          fixture,
          crypto,
          repository,
          parentSearchRequest,
          clock + 1,
        );
        clock += 3;
        expect(await protectedSearch.ensureSearchProjection(parentSearchClaim))
          .toEqual({status: "ready"});
        expect(await semanticWork.checkpoint({
          claim: parentSearchClaim,
          completedStage: "search_projection",
        })).toMatchObject({status: "accepted"});
      }
      expect(modelCalls).toBe(1);
      expect((await repository.get(organizationRequest.snapshot.requestId))?.snapshot.state).toBe("completed");
      expect(await semanticWork.complete({claim: organizationClaim})).toMatchObject({status: "accepted"});
      const [durableSemantic] = await admin.unsafe<{
        state: string;
        completed_generation: number;
        ordinary_fallback_reason: string | null;
      }[]>(
        `SELECT state, completed_generation, ordinary_fallback_reason
           FROM reflection_record_semantic_work WHERE record_id = $1`,
        [fixture.recordId],
      );
      expect(durableSemantic).toEqual({
        state: "complete",
        completed_generation: organizationClaim.generation,
        ordinary_fallback_reason: null,
      });
      expect([...(await restricted.unsafe<{count: string}[]>(
        `SELECT count(*)::text AS count FROM background_crypto_authorization_requests
          WHERE request_id = ANY($1::text[]) AND state = 'completed'`,
        [[searchRequest.snapshot.requestId, organizationRequest.snapshot.requestId]],
      ))]).toEqual([{count: "2"}]);

      let localVectorizations = 0;
      const runtime = await createProductionReflectionMemoryRuntime({
        db,
        selection: { selectedRepresentation: "ordinary", migrationGeneration: 1 },
        commitmentKey: semanticCommitmentKey,
        maintenanceGate: { isAcceptingWork: async () => false },
        resolveModelId: () => "integration:no-provider-call",
        protectedRecordPublication: {
          publish: async () => { throw new Error("unexpected protected publish"); },
          verify: async () => { throw new Error("unexpected protected verify"); },
          open: async () => { throw new Error("unexpected protected open"); },
          retire: async () => { throw new Error("unexpected protected retire"); },
        },
        recordEmbedding: { embed: async () => {
          localVectorizations += 1;
          return { status: "available", embedding: { provenance: {
            provider: "openai",
            canonicalModel: "text-embedding-3-small",
            dimensions: 1_536,
            contractVersion: 1,
          }, vector: embedding } };
        } },
      });
      if (topology === "distinct-domain") {
        expect(await runtime.recallRecordsPortForState({ roomId: fixture.sourceRoomId } as never)!
          .searchStructural!({ query: "local deterministic vector", limit: 1 }))
          .toEqual({ status: "ok", records: [] });
      }
      if (isCrossRoomTopology(topology)) {
        const bobView = await runtime.recallRecordsPortForState({
          roomId: fixture.sourceRoomId,
        } as never)!.searchStructural!({
          query: "local deterministic vector",
          limit: 4,
        });
        const carolView = await runtime.recallRecordsPortForState({
          roomId: fixture.authorityRoomId,
        } as never)!.searchStructural!({
          query: "local deterministic vector",
          limit: 4,
        });
        expect(bobView).toMatchObject({status: "ok"});
        expect(carolView).toMatchObject({status: "ok"});
        if (bobView.status !== "ok" || carolView.status !== "ok") {
          throw new Error("M327 cross-Room participant search was unavailable");
        }
        expect(bobView.records.map(record => record.recordRef)).toContain(fixture.recordId);
        if (authoredMemory === undefined) {
          expect(carolView.records.map(record => record.recordRef)).toContain(candidateFixture.recordId);
        }
        expect(bobView.records.map(record => record.recordRef)).not.toContain(parentRecordRef);
        expect(carolView.records.map(record => record.recordRef)).not.toContain(parentRecordRef);
      }
      const searchRoomId = topology === "shared-domain" ? fixture.sourceRoomId : fixture.accessRoomId;
      const search = await runtime.recallRecordsPortForState({ roomId: searchRoomId } as never)!
        .searchStructural!({ query: "local deterministic vector", limit: isCrossRoomTopology(topology) ? 3 : 2 });
      expect(localVectorizations).toBe(topology === "shared-domain" ? 1 : isCrossRoomTopology(topology) ? 3 : 2);
      expect(search.status).toBe("ok");
      if (search.status !== "ok") {
        throw new Error("M327 structural projection was not selected");
      }
      if (fixture.policyMode === "encrypted_only" && isCrossRoomTopology(topology)) {
        // This structural-only fixture has no protected body opener, so it cannot
        // suppress descendants using the encrypted parent's body. Opening the
        // selected parent with exact foreground authority is verified below.
        const allowed = new Set([parentRecordRef, fixture.recordId, supportFixture!.recordId,
          ...(authoredMemory === undefined ? [candidateFixture.recordId] : [])]);
        expect(search.records.map(record => record.recordRef)).toContain(parentRecordRef);
        expect(search.records.every(record => allowed.has(record.recordRef))).toBe(true);
      } else {
        expect(new Set(search.records.map(record => record.recordRef))).toEqual(
          new Set(topology === "cross-room"
            ? [parentRecordRef, candidateFixture.recordId]
            : topology === "cross-room-memory"
              ? [parentRecordRef]
              : [fixture.recordId, candidateFixture.recordId]),
        );
      }
      const recalledRecordRef = isCrossRoomTopology(topology) ? parentRecordRef : fixture.recordId;
      const fixtureSelection = search.records.find(record => record.recordRef === recalledRecordRef);
      if (fixtureSelection === undefined) throw new Error("M327 changed Record projection was not selected");
      const productHandle = await verifyConversationProductPostgresHandle(connection(product));
      const entityAuthority = (material: NamespaceMaterial): ForegroundAgentEntityNamespaceAuthority => ({
        namespaceId: material.authority.namespaceId,
        namespaceAccessRevision: material.authority.namespaceAccessRevision,
        namespaceKeyGeneration: material.authority.namespaceKeyGeneration,
        domainId: material.authority.domainId,
        domainKeyGeneration: material.authority.domainKeyGeneration,
        domainAuthorizationRevision: material.authority.domainAuthorizationRevision,
        domainHeadDigest: material.authority.domainHeadDigest,
        namespaceHeadDigest: material.authority.namespaceHeadDigest,
        namespacePublicationDigest: material.authority.namespaceHeadDigest,
        namespacePublicationSetDigest: material.authority.namespaceHeadDigest,
        namespaceAudienceFingerprint: material.authority.namespaceHeadDigest,
      });
      const entities: Pick<ForegroundAgentEntityCryptoInvocation, "signal" | "use" | "useCurrentSet"> = {
        signal: new AbortController().signal,
        use: async input => {
          const material = fixture.namespaces.get(input.entity.namespaceId);
          if (material === undefined) return { status: "unavailable" as const, reason: "content_unavailable" as const };
          return { status: "executed" as const, value: await input.execute({
            namespaceKey: material.generationKey,
            authority: entityAuthority(material),
          }) };
        },
        useCurrentSet: async () => {
          throw new Error("existing foreground proof must not republish");
        },
      };
      const foreground = createForegroundRecordHistoryRepairer({
        crypto,
        entities,
        sourceRepresentationMode: "protected-only",
        publication: {
          operationId: `unused-${fixture.runId}`,
          grantId: `unused-${fixture.runId}`,
          grantDigest: digest(`unused-grant:${fixture.runId}`),
          recipientKeyId: `unused-${fixture.runId}`,
          runtime: { agentId: "unused", keyClass: "runtime", generation: 1, key: digest("unused-runtime") } as never,
          signerKeyId: `unused-${fixture.runId}`,
          signerPublicKey: digest("unused-signer"),
          agentAuthorizationRevision: 1,
        },
        loadSources: (records, representationMode) => loadPostgresForegroundRecordRepairSources({
          product: productHandle,
          records,
          ...(representationMode === undefined ? {} : { representationMode }),
        }),
        persist: async () => { throw new Error("existing foreground proof must not persist"); },
        read: request => readVerifiedDeviceWrappedAgentObject({
          handle: cryptoHandle,
          crypto,
          ...request,
          resolveHistoricalAgentSignerAuthority: () => null,
        }),
        validateExisting: request => validatePostgresForegroundRecordRepairSource({
          product: productHandle,
          ...request,
        }),
        attach: async () => { throw new Error("existing foreground proof must not attach"); },
      });
      const opened = await foreground.protect({ records: [fixtureSelection] });
      expect(opened).toEqual({
        status: "verified",
        records: [{
          recordRef: recalledRecordRef,
          statement: isCrossRoomTopology(topology) ? "M327 protected sibling synthesis" : "M327 protected Reflection foreground proof",
          lifecycle: "current",
          structuralHeight: isCrossRoomTopology(topology) ? 1 : 0,
        }],
        provenance: "existing",
        repairedCount: 0,
        verification: "authenticated",
        ordinaryRestoredCount: 0,
      });
      expect(await foreground.protect({records: [{
        representation: "structural",
        recordRef: parentRecordRef,
        structuralHeight: 1,
      }]})).toEqual({
        status: "verified",
        records: [{
          recordRef: parentRecordRef,
          statement: "M327 protected sibling synthesis",
          lifecycle: "current",
          structuralHeight: 1,
        }],
        provenance: "existing",
        repairedCount: 0,
        verification: "authenticated",
        ordinaryRestoredCount: 0,
      });
      if (isCrossRoomTopology(topology)) {
        if (authoredMemory === undefined) {
          const productStore = new PostgresRecordProductStore(
            recordProductHandle,
            semanticWork,
          );
          expect(await productStore.block({recordRef: candidateFixture.recordId}))
            .toEqual({
              status: "blocked",
              recordRef: candidateFixture.recordId,
              replayed: false,
            });
          // The populated clone can contain older repair pages; drain through the
          // canonical owner, then assert this fixture's durable admission below.
          while ((await semanticWork.repairRecordDependentsPage({limit: 16})).consumed > 0) {
            // Drain canonical repair pages, including earlier fixture notifications.
          }
        } else {
          await admin.unsafe("UPDATE memories SET tier = 3 WHERE id = $1", [authoredMemory.memoryId]);
          expect(await runtime.authoredMemoryChanges.admit({
            memoryId: authoredMemory.memoryId,
            changeKind: "archive",
            changeRef: `m327-memory-archive:${fixture.runId}`,
          })).toEqual({admitted: 1});
          while ((await runtime.semanticWork.repairSourceDependentsPage({limit: 16})).consumed > 0) {
            // Drain durable Memory-source repair through its canonical owner.
          }
        }
        const [rebuild] = await product.unsafe<{
          generation: number;
          change_reason: string;
          stage: string;
          state: string;
        }[]>(
          `SELECT generation, change_reason, stage, state
             FROM reflection_record_semantic_work
            WHERE record_id = $1`,
          [parentRecordRef],
        );
        expect(rebuild).toMatchObject({
          generation: 2,
          change_reason: "dependency_lost",
          stage: "authority_projection",
          state: "due",
        });
        // Revoke Alice from the AC source audience, then let the existing
        // authority owner dirty and rebuild every dependent projection.
        await product.unsafe("UPDATE rooms SET human_actor_ids = $2 WHERE id = $1", [
          fixture.authorityRoomId, [fixture.authorityExtraHumanActorId!],
        ]);
        const authorityStore = new PostgresAuthorityProjectionStore(recordProductHandle);
        expect(await authorityStore.admitSourceChange({
          changeRef: `m327-revoke:${fixture.runId}`,
          terminalAuthorityLeafHandle: fixture.authorityNamespaceId,
          sourceChangeGeneration: 2,
        })).toMatchObject({replayed: false});
        expect((await authorityStore.readCurrent(parentRecordRef))?.processingState).toBe("dirty");
        await maintenance.ensureAuthority({...parentAuthorityClaim, generation: 2});
        const searchAfterRevocation = () => runtime.recallRecordsPortForState({
          roomId: fixture.accessRoomId,
        } as never)!.searchStructural!({
          query: "local deterministic vector",
          limit: 4,
        });
        let afterRevocation: Awaited<ReturnType<typeof searchAfterRevocation>>;
        try {
          afterRevocation = await searchAfterRevocation();
        } catch (error) {
          throw new Error("M327 cross-Room revoked structural read threw", {cause: error});
        }
        expect(afterRevocation).toMatchObject({status: "ok"});
        if (afterRevocation.status !== "ok") {
          throw new Error("M327 revoked cross-Room projection search was unavailable");
        }
        // Structural search is content-free; the foreground owner must refuse
        // the stale body even if a candidate pointer was already returned.
        expect(await foreground.protect({records: [{
          representation: "structural", recordRef: parentRecordRef, structuralHeight: 1,
        }]})).toEqual({status: "waiting_for_authority", reason: "record_authority_converging"});
      }
    } finally {
      await maintenance.dispose();
      if (authoredMemoryId !== undefined) {
        await admin.unsafe("UPDATE memories SET tier = 3 WHERE id = $1", [authoredMemoryId]);
      }
      if (createdParentRecordRef !== undefined) {
        await admin.unsafe(
          "UPDATE reflection_records SET disposition = 'purged' WHERE record_id = $1",
          [createdParentRecordRef],
        ).catch(() => undefined);
      }
      await markFixturePurged(candidateFixture, [], repository);
      if (supportFixture) await markFixturePurged(supportFixture, [], repository);
      await markFixturePurged(fixture, priorRequestIds, repository);
      fixture.signing.privateKey.fill(0);
      for (const material of new Set(fixture.domainMaterials.values())) {
        material.key.fill(0);
      }
    }
  }, 120_000);
  }
});
