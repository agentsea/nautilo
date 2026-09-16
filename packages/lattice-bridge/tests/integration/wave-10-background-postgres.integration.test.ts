import { createHash, randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { count, eq, processorCryptoSignerAuthorizations, createPostgresJsBridgeConnection } from "@nautilo/db";
import {
  LatticeCrypto,
  ProcessorTransformRecipientRegistry,
  accessRevision,
  authorizationRevision,
  createInitialNamespaceKeyrings,
  createNamespaceBinding,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  encryptObjectPayload,
  humanId,
  namespaceGeneration,
  namespaceId,
  objectId,
  prepareObjectAccessManifestGenesis,
  sealNamespaceKeyring,
  unixTimestamp,
  wrapObjectDekForNamespace,
} from "@nautilo/lattice-crypto";
import { seededRng } from "@nautilo/lattice-crypto/testing";
import {
  createBackgroundAuthorizationResponseV2,
  destroyVerifiedProcessorSignerAuthorizationV2,
  encodeBackgroundWorkDescriptorV2,
  verifyBackgroundAuthorizationResponseV2,
  verifyHistoricalProcessorSignerAuthorizationV2,
  type BackgroundProcessorWorkDescriptorV2,
} from "@nautilo/lattice-crypto/background";
import {
  decodeBackgroundWorkDescriptorV1,
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
  serializeNamespaceBindingV2,
  serializeNamespaceKeyringEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";
import {
  attachPostgresForegroundJournalRepair,
  attachPostgresForegroundRecordRepair,
  createPostgresForegroundJournalSelectionPort,
  loadPostgresForegroundJournalRepairSources,
  loadPostgresForegroundRecordRepairSources,
  validatePostgresForegroundJournalRepairSource,
  validatePostgresForegroundRecordRepairSource,
  verifyConversationProductPostgresHandle,
  verifyCryptoPostgresHandle,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresConnection,
  type ConversationProductPostgresExecutor,
  type ConversationProductPostgresHandle,
  type ConversationProductPostgresIsolationLevel,
  type ConversationProductPostgresScalar,
  type CryptoPostgresConnection,
  type CryptoPostgresExecutor,
  type CryptoPostgresHandle,
} from "@nautilo/lattice-bridge/server";
import { encodeRecordPayloadV1 } from
  "../../../reflection-bridge/src/record-payload-v1.ts";
import type {
  BackgroundAuthorizationDeviceAuthority,
  VerifiedProcessorBackgroundAuthorizationDeviceResponse,
} from "@nautilo/lattice-bridge";
import {
  encodeMessagePayloadV2,
  fulfillProcessorBackgroundAuthorizationRequest,
  verifyCurrentBackgroundAuthorizationDeviceResponse,
} from "@nautilo/lattice-bridge";
import {
  createPostgresProcessorTransformObjectPort,
  PostgresProcessorTransformCommitVerifier,
  PostgresProtectedJournalProcessorObjectVerifier,
} from "@nautilo/lattice-bridge/server";

import {
  advanceBackgroundAuthorizationGeneration,
  attachBackgroundAuthorizationRecipient,
  claimBackgroundAuthorizationRequest,
  createBackgroundAuthorizationRequest,
  createBackgroundAuthorizationRequestV2,
} from "../../../runtime/src/protected-execution/background-authorization/lifecycle";
import {
  BackgroundAuthorizationProcessorCredentialClaimPort,
} from "../../../runtime/src/protected-execution/background-authorization/processor-credential-claim-port";
import {
  PostgresBackgroundAuthorizationRepository,
} from "../../../runtime/src/protected-execution/background-authorization/postgres-repository";
import {
  BACKGROUND_AUTHORIZATION_TERMINAL_RETENTION_MS,
  type BackgroundAuthorizationRecord,
  type BackgroundAuthorizationRecordV2,
  type BackgroundAuthorizationVerifiedProcessorResponseV2,
} from "../../../runtime/src/protected-execution/background-authorization/repository";
import {
  fingerprintProtectedStenographerCoveredRange,
} from "../../../runtime/src/stenographer/protected-batch-planner";
import {
  encodeProtectedJournalAttachmentPlanV1,
  type ProtectedJournalAttachmentPlanV1,
} from "../../../runtime/src/stenographer/protected-journal-output-planner";
import {
  PostgresProtectedJournalPublicationRepository,
  type ReserveProtectedJournalPublicationInput,
} from "../../../runtime/src/stenographer/protected-publication-repository";
import {
  fingerprintProtectedStenographerSourceBindings,
} from "../../../runtime/src/stenographer/protected-source-loader";
import {
  createProtectedStenographerExtractionPublicationAdapter,
} from "../../../runtime/src/stenographer/protected-stenographer-publication-adapter";
import {
  createPostgresProtectedStenographerPublicationReconciler,
  createProtectedStenographerBackgroundExecutionPort,
  createProtectedStenographerPublicationFence,
} from "../../../runtime/src/stenographer/protected-stenographer-publication-reconciliation";
import {
  PostgresProtectedStenographerWorkRecovery,
} from "../../../runtime/src/stenographer/postgres-protected-stenographer-work-recovery";
import {
  ProtectedStenographerBackgroundCoordinator,
} from "../../../runtime/src/stenographer/protected-stenographer-background-coordinator";
import {
  runProtectedStenographerExtraction,
} from "../../../runtime/src/stenographer/protected-stenographer-extraction";
import {
  createProtectedStenographerAuthorizationRecord,
  createProtectedStenographerDescriptorFactory,
  recoverProtectedStenographerExecutionWork,
  type ProtectedStenographerCryptoAuthority,
} from "../../../runtime/src/stenographer/protected-stenographer-work-composition";
import {
  PostgresProtectedStenographerWorkRepository,
} from "../../../runtime/src/stenographer/protected-stenographer-work-repository";
import {
  PostgresProtectedJournalRebuildRepository,
} from "../../../runtime/src/stenographer/protected-journal-rebuild-repository";

type SqlClient = postgres.Sql;
type SqlExecutor = Pick<SqlClient, "unsafe">;

const adminUrl = requiredEnvironment(
  "LATTICE_BRIDGE_TEST_ADMIN_DATABASE_URL",
);
const cryptoUrl = requiredEnvironment("LATTICE_BRIDGE_TEST_DATABASE_URL");
const appUrl = requiredEnvironment("LATTICE_BRIDGE_TEST_APP_DATABASE_URL");
const agentUrl = requiredEnvironment(
  "LATTICE_BRIDGE_TEST_AGENT_DATABASE_URL",
);

const START = Date.parse("2026-08-04T08:00:00.000Z");
const RECIPIENT_PUBLIC_KEY = new Uint8Array(65).fill(0x42);
const CONTENT_SENTINEL = "[protected:v1]";
const RECORD_COMMITMENT = Object.freeze({
  commit: () => new Uint8Array(32).fill(0x67),
});

let admin: SqlClient;
let cryptoClient: SqlClient;
let appClient: SqlClient;
let agentClient: SqlClient;
let cryptoHandle: CryptoPostgresHandle;
let productHandle: ConversationProductPostgresHandle;
let backgroundRepository: PostgresBackgroundAuthorizationRepository;
let publicationRepository: PostgresProtectedJournalPublicationRepository;
let rebuildRepository: PostgresProtectedJournalRebuildRepository;

const backgroundRequestIds = new Set<string>();
const productFixtures = new Set<ProductFixture>();
const cryptoObjectIds = new Set<string>();

type ProductFixture = Readonly<{
  userId: string;
  humanActorId: string;
  agentId: string;
  agentActorId: string;
  namespaceId: string;
  roomId: string;
  sessionId: string;
}>;

type SagaCryptoFixture = Readonly<{
  product: ProductFixture;
  crypto: LatticeCrypto;
  authority: BackgroundAuthorizationDeviceAuthority;
  domainId: string;
  humanId: string;
  deviceId: string;
  inputObjectId: string;
  messageId: number;
  sourceCreatedAt: Date;
}>;

const sagaCryptoFixtures = new Set<SagaCryptoFixture>();

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required for the Postgres integration suite`);
  }
  return value;
}

function sqlClient(url: string, maximumConnections = 8): SqlClient {
  return postgres(url, {
    max: maximumConnections,
    prepare: false,
    onnotice: () => undefined,
  });
}

function cryptoExecutor(client: SqlExecutor): CryptoPostgresExecutor {
  return {
    async query<Row>(
      statement: string,
      parameters: readonly unknown[] = [],
    ): Promise<readonly Row[]> {
      const rows = await client.unsafe(
        statement,
        [...parameters] as postgres.ParameterOrJSON<never>[],
      );
      return rows as unknown as readonly Row[];
    },
  };
}

function cryptoConnection(client: SqlClient): CryptoPostgresConnection {
  return {
    ...cryptoExecutor(client),
    transaction: (callback) =>
      client.begin((transaction) =>
        callback(cryptoExecutor(transaction))
      ) as Promise<Awaited<ReturnType<typeof callback>>>,
  };
}

function productExecutor(
  client: SqlExecutor,
): ConversationProductPostgresExecutor {
  return {
    async query<Row extends ConversationProductDatabaseRow =
      ConversationProductDatabaseRow>(
      statement: string,
      parameters: readonly ConversationProductPostgresScalar[] = [],
    ): Promise<readonly Row[]> {
      const rows = await client.unsafe(
        statement,
        [...parameters] as postgres.ParameterOrJSON<never>[],
      );
      return rows as unknown as readonly Row[];
    },
  };
}

function productConnection(
  client: SqlClient,
): ConversationProductPostgresConnection {
  return {
    ...productExecutor(client),
    transaction: <Result>(
      callback: (
        transaction: ConversationProductPostgresExecutor,
      ) => Promise<Result>,
      options: Readonly<{
        isolationLevel: ConversationProductPostgresIsolationLevel;
      }>,
    ): Promise<Result> =>
      client.begin(
        `isolation level ${options.isolationLevel}`,
        (transaction) => callback(productExecutor(transaction)),
      ) as unknown as Promise<Result>,
  };
}

function digest(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(bytes).digest());
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function portableSuffix(): string {
  return randomUUID().replaceAll("-", "");
}

function initialRecord(suffix = portableSuffix()): BackgroundAuthorizationRecord {
  const requestId = `m241-request-${suffix}`;
  backgroundRequestIds.add(requestId);
  return {
    snapshot: createBackgroundAuthorizationRequest({
      requestId,
      workId: `m241-work-${suffix}`,
      namespaceId: `m241-namespace-${suffix}`,
      credentialSubject: {
        kind: "processor",
        processorKind: "stenographer",
        processorVersion: 1,
        authorizationRevision: 2,
      },
      now: START,
    }),
    workIdentityHash: digest(new TextEncoder().encode(`work:${suffix}`)),
    idempotencyKey: `m241-idempotency-${suffix}`,
    workKind: "stenographer.extraction",
    purpose: "journal.extract",
    domainId: `m241-domain-${suffix}`,
    processorAuthorizationRevision: 2,
    expectedDomainEpoch: 3,
    expectedNamespaceAccessRevision: 4,
    expectedPolicyRevision: 5,
    descriptorBytes: null,
    acceptedMaterial: null,
    finishedAt: null,
  };
}

function initialV2Record(
  suffix = portableSuffix(),
): BackgroundAuthorizationRecordV2 {
  const requestId = `m244-request-${suffix}`;
  backgroundRequestIds.add(requestId);
  return {
    snapshot: createBackgroundAuthorizationRequestV2({
      requestId,
      workId: `m244-work-${suffix}`,
      namespaceId: `m244-namespace-a-${suffix}`,
      credentialSubject: {
        kind: "agent",
        agentId: `m244-agent-${suffix}`,
        runtimeGeneration: 2,
        authorizationRevision: 3,
      },
      now: START,
    }),
    workIdentityHash: digest(
      new TextEncoder().encode(`m244-work:${suffix}`),
    ),
    idempotencyKey: `m244-idempotency-${suffix}`,
    workKind: "memory.review",
    purpose: "memory.review",
    domainId: `m244-domain-a-${suffix}`,
    processorAuthorizationRevision: null,
    expectedDomainEpoch: 4,
    expectedNamespaceAccessRevision: 5,
    expectedPolicyRevision: 6,
    descriptorBytes: null,
    acceptedMaterial: null,
    finishedAt: null,
    authoritySet: {
      namespaceRequirements: [
        {
          ordinal: 0,
          namespaceId: `m244-namespace-a-${suffix}`,
          domainId: `m244-domain-a-${suffix}`,
          operations: ["decrypt"],
          expectedAccessRevision: 5,
          expectedPolicyRevision: 6,
        },
        {
          ordinal: 1,
          namespaceId: `m244-namespace-b-${suffix}`,
          domainId: `m244-domain-b-${suffix}`,
          operations: ["decrypt", "encrypt"],
          expectedAccessRevision: 7,
          expectedPolicyRevision: 8,
        },
      ],
      domainRequirements: [
        {
          ordinal: 0,
          domainId: `m244-domain-a-${suffix}`,
          expectedEpoch: 4,
          expectedAgentAuthorizationRevision: 9,
        },
        {
          ordinal: 1,
          domainId: `m244-domain-b-${suffix}`,
          expectedEpoch: 10,
          expectedAgentAuthorizationRevision: 11,
        },
      ],
    },
  };
}

async function currentV2Record(
  suffix = portableSuffix(),
  kind: "execution" | "reconciliation" = "execution",
): Promise<Readonly<{
  initial: BackgroundAuthorizationRecord;
  waiting: BackgroundAuthorizationRecord;
  response: BackgroundAuthorizationVerifiedProcessorResponseV2;
  responseBytes: Uint8Array;
  crypto: LatticeCrypto;
  issuerSigningPublicKey: Uint8Array;
}>> {
  const crypto = new LatticeCrypto();
  const recipient = await crypto.generateEncryptionKeyPair();
  const device = crypto.generateSigningKeyPair();
  const requestId = `m317-request-${suffix}`;
  const workId = `m317-work-${suffix}`;
  const namespaceId = `m317-namespace-${suffix}`;
  const domainId = `m317-domain-${suffix}`;
  const idempotencyId = `m317-idempotency-${suffix}`;
  backgroundRequestIds.add(requestId);
  const descriptor: BackgroundProcessorWorkDescriptorV2 = {
    formatVersion: 2,
    requestId,
    recipientGeneration: 0,
    workKind: kind === "execution" ? "stenographer.extraction" : "stenographer.publication_reconcile",
    workId,
    anchorNamespaceId: namespaceId,
    anchorDomainId: domainId,
    subject: {kind: "processor", processorKind: "stenographer", processorVersion: 1},
    operations: kind === "reconciliation" ? ["decrypt"] : ["decrypt", "encrypt"],
    purpose: kind === "execution" ? "journal.extract" : "journal.reconcile",
    authority: {
      serverId: `m317-server-scope-${suffix}`,
      roomId: `m317-room-${suffix}`,
      namespaceId,
      namespaceAccessRevision: 4,
      namespaceKeyGeneration: 2,
      namespaceHeadDigest: new Uint8Array(32).fill(0x11),
      domainId,
      domainKeyGeneration: 3,
      domainAuthorizationRevision: 5,
      domainHeadDigest: new Uint8Array(32).fill(0x12),
      bundleRevision: 6,
      bundleDigest: new Uint8Array(32).fill(0x13),
    },
    policyRevision: 7,
    source: {
      kind: "stenographer_work",
      startSequence: 1,
      endSequence: 2,
      rebuildGeneration: 0,
      fingerprint: new Uint8Array(32).fill(0x14),
    },
    inputBindings: [{objectId: `m317-input-${suffix}`, namespaceId}],
    outputSlots: kind === "reconciliation" ? [] : [{
      objectId: `m317-output-${suffix}`,
      objectType: "nautilo.reflection.record.v1",
      createdAt: START,
      namespaceIds: [namespaceId],
    }],
    maximumPlaintextBytes: 512 * 1_024,
    maximumCiphertextBytes: 1_024 * 1_024 + 40,
    recipientKeyId: `m317-recipient-${suffix}`,
    recipientPublicKey: recipient.publicKey,
    issuedAt: START + 1,
    notBefore: START + 1,
    expiresAt: START + 300_000,
    idempotencyId,
  };
  const descriptorBytes = encodeBackgroundWorkDescriptorV2(descriptor);
  const issuer = {
    humanId: `m317-human-${suffix}`,
    deviceId: `m317-device-${suffix}`,
    deviceGeneration: 2,
    serverInstanceId: randomUUID(),
    lineageGeneration: 3,
    epoch: 4,
    securityRevision: 5,
    headDigest: new Uint8Array(32).fill(0x21),
    signingPublicKeyHash: crypto.hash(device.publicKey),
  };
  const domainKey = crypto.randomBytes(32);
  const responseBytes = await createBackgroundAuthorizationResponseV2(
    crypto,
    {
      credentialId: `m317-credential-${suffix}`,
      descriptorBytes,
      issuer,
      issuerSigningPrivateKey: device.privateKey,
      domainKey,
    },
  );
  domainKey.fill(0);
  device.privateKey.fill(0);
  recipient.privateKey.fill(0);
  const verified = await verifyBackgroundAuthorizationResponseV2(crypto, {
    responseBytes,
    now: START + 2,
    resolveCurrentIssuer: () => device.publicKey,
  });
  const initial: BackgroundAuthorizationRecord = {
    snapshot: createBackgroundAuthorizationRequestV2({
      requestId,
      workId,
      namespaceId,
      credentialSubject: {
        kind: "processor",
        processorKind: "stenographer",
        processorVersion: 1,
      },
      now: START,
    }),
    workIdentityHash: digest(
      new TextEncoder().encode(`m317-work:${suffix}`),
    ),
    idempotencyKey: idempotencyId,
    workKind: descriptor.workKind,
    purpose: descriptor.purpose,
    domainId,
    processorAuthorizationRevision: null,
    expectedDomainEpoch: null,
    expectedNamespaceAccessRevision:
      descriptor.authority.namespaceAccessRevision,
    expectedPolicyRevision: descriptor.policyRevision,
    descriptorBytes: null,
    acceptedMaterial: null,
    finishedAt: null,
  };
  const waiting: BackgroundAuthorizationRecord = {
    ...initial,
    snapshot: attachBackgroundAuthorizationRecipient(initial.snapshot, {
      descriptorDigest: hex(crypto.hash(descriptorBytes)),
      recipientKeyId: descriptor.recipientKeyId,
      recipientPublicKey: Buffer.from(recipient.publicKey).toString(
        "base64url",
      ),
      expiresAt: descriptor.expiresAt,
      now: START + 1,
    }),
    descriptorBytes,
  };
  return Object.freeze({
    initial,
    waiting,
    response: Object.freeze({
      ...verified,
      formatVersion: 2 as const,
      kind: "processor" as const,
    }),
    responseBytes,
    crypto,
    issuerSigningPublicKey: device.publicKey,
  });
}

function withRecipient(
  record: BackgroundAuthorizationRecord,
): BackgroundAuthorizationRecord {
  const descriptorBytes = new TextEncoder().encode(
    `descriptor:${record.snapshot.requestId}`,
  );
  return {
    ...record,
    snapshot: attachBackgroundAuthorizationRecipient(record.snapshot, {
      descriptorDigest: hex(digest(descriptorBytes)),
      recipientKeyId: `recipient-${record.snapshot.requestId}`,
      recipientPublicKey: Buffer.from(RECIPIENT_PUBLIC_KEY).toString(
        "base64url",
      ),
      expiresAt: START + 300_000,
      now: START + 1,
    }),
    descriptorBytes,
  };
}

function verifiedResponse(
  record: BackgroundAuthorizationRecord,
  deviceSuffix: string,
): VerifiedProcessorBackgroundAuthorizationDeviceResponse {
  if (
    record.snapshot.recipient === null
    || record.snapshot.descriptorDigest === null
    || record.expectedDomainEpoch === null
  ) {
    throw new Error("response fixture requires a recipient");
  }
  const responseBytes = new TextEncoder().encode(
    `response:${record.snapshot.requestId}:${deviceSuffix}`,
  );
  const credentialHash = digest(
    new TextEncoder().encode(
      `credential:${record.snapshot.requestId}:${deviceSuffix}`,
    ),
  );
  return {
    kind: "processor",
    requestId: record.snapshot.requestId,
    recipientGeneration: record.snapshot.recipientGeneration,
    recipientKeyId: record.snapshot.recipient.recipientKeyId,
    recipientPublicKey: RECIPIENT_PUBLIC_KEY,
    descriptorHash: Uint8Array.from(
      Buffer.from(record.snapshot.descriptorDigest, "hex"),
    ),
    workId: record.snapshot.workId,
    workKind: record.workKind,
    purpose: record.purpose,
    subject: {
      kind: "processor",
      processorKind: "stenographer",
      processorVersion: 1,
      authorizationRevision: record.processorAuthorizationRevision!,
    },
    responseHash: digest(responseBytes),
    responseBytes,
    credentialId: `credential-${record.snapshot.requestId}-${deviceSuffix}`,
    credentialHash,
    issuingHumanId: `human-${deviceSuffix}`,
    issuingDeviceId: `device-${deviceSuffix}`,
    issuingDeviceAuthorizationRevision: 6,
    issuerSigningPublicKeyHash: digest(
      new TextEncoder().encode(`issuer:${deviceSuffix}`),
    ),
    namespaceId: record.snapshot.namespaceId,
    domainId: record.domainId,
    domainEpoch: record.expectedDomainEpoch,
    namespaceAccessRevision: record.expectedNamespaceAccessRevision,
    policyRevision: record.expectedPolicyRevision,
    issuedAt: START,
    notBefore: START,
    expiresAt: record.snapshot.recipient.expiresAt,
    signerAuthorization: {
      authorizationId:
        `authorization-${record.snapshot.requestId}-${deviceSuffix}`,
      processorKind: "stenographer",
      processorVersion: 1,
      workId: record.snapshot.workId,
      namespaceId: record.snapshot.namespaceId,
      domainId: record.domainId,
      domainEpoch: record.expectedDomainEpoch,
      namespaceAccessRevision: record.expectedNamespaceAccessRevision,
      policyRevision: record.expectedPolicyRevision,
      processorAuthorizationRevision: record.processorAuthorizationRevision!,
      issuingHumanId: `human-${deviceSuffix}`,
      issuingDeviceId: `device-${deviceSuffix}`,
      issuingDeviceAuthorizationRevision: 6,
      issuerSigningPublicKeyHash: digest(
        new TextEncoder().encode(`issuer:${deviceSuffix}`),
      ),
      signerKeyId: `signer-${record.snapshot.requestId}-${deviceSuffix}`,
      signerPublicKey: digest(
        new TextEncoder().encode(`signer-public:${deviceSuffix}`),
      ),
      authorizationHash: digest(
        new TextEncoder().encode(
          `authorization:${record.snapshot.requestId}:${deviceSuffix}`,
        ),
      ),
      credentialHash,
      authorizationBytes: new TextEncoder().encode(
        `authorization-wire:${deviceSuffix}`,
      ),
      issuedAt: START,
      expiresAt: record.snapshot.recipient.expiresAt,
    },
  };
}

async function createProductFixture(): Promise<ProductFixture> {
  const fixture = Object.freeze({
    userId: randomUUID(),
    humanActorId: randomUUID(),
    agentId: randomUUID(),
    agentActorId: randomUUID(),
    namespaceId: randomUUID(),
    roomId: randomUUID(),
    sessionId: randomUUID(),
  });
  productFixtures.add(fixture);
  await admin.begin(async (transaction) => {
    await transaction.unsafe(
      `INSERT INTO users (id, name) VALUES ($1, 'M241 Postgres fixture')`,
      [fixture.userId],
    );
    await transaction.unsafe(
      `INSERT INTO agents (id, handle) VALUES ($1, $2)`,
      [fixture.agentId, `m241-${fixture.agentId}`],
    );
    await transaction.unsafe(
      `INSERT INTO actors (
         id, owner_id, display_name, trust_state, kind, agent_id
       ) VALUES
         ($1, $2, 'M241 fixture Human', 'verified', 'user', NULL),
         ($3, $2, 'M241 fixture Agent', 'verified', 'agent', $4)`,
      [
        fixture.humanActorId,
        fixture.userId,
        fixture.agentActorId,
        fixture.agentId,
      ],
    );
    await transaction.unsafe(
      `INSERT INTO namespaces (id, scope, label)
       VALUES ($1, 'room', 'M241 Postgres fixture')`,
      [fixture.namespaceId],
    );
    await transaction.unsafe(
      `INSERT INTO rooms (
         id, owner_id, type, label, graph_thread_id, namespace_id,
         human_actor_ids, kind, created_by
       ) VALUES (
         $1, $2, 'private', 'M241 Postgres fixture', $3, $4,
         ARRAY[$5::uuid], 'private', $5
       )`,
      [
        fixture.roomId,
        fixture.userId,
        `m241:${fixture.roomId}`,
        fixture.namespaceId,
        fixture.humanActorId,
      ],
    );
    await transaction.unsafe(
      `INSERT INTO room_members (
         room_id, actor_id, room_role, joined_at
       ) VALUES
         ($1, $2, 'admin', $4),
         ($1, $3, 'member', $4)`,
      [
        fixture.roomId,
        fixture.humanActorId,
        fixture.agentActorId,
        new Date(START - 60_000),
      ],
    );
    await transaction.unsafe(
      `INSERT INTO sessions (
         id, thread_id, owner_id, persona_id, agent_id, room_id, channel
       ) VALUES ($1, $2, $3, 'owner', $4, $5, 'integration')`,
      [
        fixture.sessionId,
        `m241:${fixture.sessionId}`,
        fixture.userId,
        fixture.agentId,
        fixture.roomId,
      ],
    );
  });
  return fixture;
}

async function cleanupProductFixture(
  fixture: ProductFixture,
): Promise<void> {
  if (!productFixtures.delete(fixture)) return;
  await admin.begin(async (transaction) => {
    await transaction.unsafe(
      `DELETE FROM session_message_crypto_revisions WHERE session_id = $1`,
      [fixture.sessionId],
    );
    await transaction.unsafe(
      `DELETE FROM session_messages WHERE session_id = $1`,
      [fixture.sessionId],
    );
    await transaction.unsafe(
      `DELETE FROM sessions WHERE id = $1`,
      [fixture.sessionId],
    );
    await transaction.unsafe(
      `DELETE FROM room_event_rollups WHERE room_id = $1`,
      [fixture.roomId],
    );
    await transaction.unsafe(
      `DELETE FROM room_events WHERE room_id = $1`,
      [fixture.roomId],
    );
    await transaction.unsafe(
      `DELETE FROM room_journal_crypto_publications WHERE room_id = $1`,
      [fixture.roomId],
    );
    await transaction.unsafe(
      `DELETE FROM room_journal_batches WHERE room_id = $1`,
      [fixture.roomId],
    );
    await transaction.unsafe(
      `DELETE FROM room_journal_state WHERE room_id = $1`,
      [fixture.roomId],
    );
    await transaction.unsafe(
      `DELETE FROM room_members WHERE room_id = $1`,
      [fixture.roomId],
    );
    await transaction.unsafe(`DELETE FROM rooms WHERE id = $1`, [
      fixture.roomId,
    ]);
    await transaction.unsafe(`DELETE FROM namespaces WHERE id = $1`, [
      fixture.namespaceId,
    ]);
    await transaction.unsafe(`DELETE FROM actors WHERE id = $1`, [
      fixture.agentActorId,
    ]);
    await transaction.unsafe(`DELETE FROM agents WHERE id = $1`, [
      fixture.agentId,
    ]);
    await transaction.unsafe(`DELETE FROM actors WHERE id = $1`, [
      fixture.humanActorId,
    ]);
    await transaction.unsafe(`DELETE FROM users WHERE id = $1`, [
      fixture.userId,
    ]);
  });
}

async function createSagaCryptoFixture(
  product: ProductFixture,
): Promise<SagaCryptoFixture> {
  const suffix = portableSuffix();
  const crypto = new LatticeCrypto(
    seededRng(241_010),
    { now: () => START + 122_000 },
  );
  const signing = crypto.generateSigningKeyPair();
  const encryption = await crypto.generateEncryptionKeyPair();
  const exactHumanId = humanId(`human-m241-${suffix}`);
  const exactDeviceId = cryptoDeviceId(`device-m241-${suffix}`);
  const exactNamespaceId = namespaceId(product.namespaceId);
  const exactDomainId = cryptoDomainId(`domain-m241-${suffix}`);
  const inputObjectId = objectId(`journal/message/m241-${suffix}`);
  cryptoObjectIds.add(inputObjectId);
  const aiRoot = new Uint8Array(32).fill(0x72);
  const humanRoot = new Uint8Array(32).fill(0x71);
  const keyrings = createInitialNamespaceKeyrings(
    crypto,
    exactNamespaceId,
  );
  const humanEnvelope = sealNamespaceKeyring({
    crypto,
    domainRoot: humanRoot,
    keyring: keyrings.human,
    metadata: {
      domainId: exactDomainId,
      domainEpoch: domainEpoch(1),
      previousBindingHash: null,
      committerDeviceId: exactDeviceId,
    },
    committerSigningPrivateKey: signing.privateKey,
    resolveCurrentCommitter: () => signing.publicKey,
  });
  const aiEnvelope = sealNamespaceKeyring({
    crypto,
    domainRoot: aiRoot,
    keyring: keyrings.ai,
    metadata: {
      domainId: exactDomainId,
      domainEpoch: domainEpoch(1),
      previousBindingHash: null,
      committerDeviceId: exactDeviceId,
    },
    committerSigningPrivateKey: signing.privateKey,
    resolveCurrentCommitter: () => signing.publicKey,
  });
  const binding = createNamespaceBinding({
    crypto,
    humanEnvelope,
    aiEnvelope,
    committerSigningPrivateKey: signing.privateKey,
    resolveCurrentCommitter: () => signing.publicKey,
  });
  const bindingBytes = serializeNamespaceBindingV2(binding);
  const bindingHash = crypto.hash(bindingBytes);
  const sourceCreatedAt = new Date(START + 1_000);
  const plaintext = encodeMessagePayloadV2({
    role: "user",
    content: "M241 concrete PostgreSQL restart source",
  });
  const encrypted = encryptObjectPayload(crypto, {
    objectId: inputObjectId,
    keyClass: "ai",
    objectType: "room_message",
    createdAt: unixTimestamp(sourceCreatedAt.getTime()),
  }, plaintext);
  plaintext.fill(0);
  const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
  const aiGeneration = keyrings.ai.generations.find(
    (generation) => generation.generation === keyrings.ai.currentGeneration,
  );
  if (aiGeneration === undefined) {
    throw new Error("M241 saga Namespace AI generation is missing");
  }
  const namespaceEnvelope = wrapObjectDekForNamespace(
    crypto,
    aiGeneration.key,
    {
      objectId: inputObjectId,
      namespaceId: exactNamespaceId,
      keyClass: "ai",
      keyGeneration: namespaceGeneration(keyrings.ai.currentGeneration),
      bindingRevisionAtWrap: accessRevision(0),
    },
    encrypted.dek,
  );
  encrypted.dek.fill(0);
  const envelopeBytes = encodeNamespaceObjectEnvelopeV2(namespaceEnvelope);
  const preparedManifest = prepareObjectAccessManifestGenesis(crypto, {
    objectId: inputObjectId,
    payloadHash: crypto.hash(payloadBytes),
    envelopeBytes: [envelopeBytes],
    sourceAuthorized: true,
    targetAuthorized: true,
    committerDeviceId: exactDeviceId,
    hostAuthorizationRevision: authorizationRevision(9),
    signingPrivateKey: signing.privateKey,
  });

  const messageRows = await admin.begin(async (transaction) => {
    await transaction.unsafe(
      `INSERT INTO human_crypto_custodies (
         human_id, user_id, human_actor_id,
         initial_installation_lineage_digest, state, ever_initialized_at,
         first_device_id, current_recovery_generation,
         current_recovery_public_key_digest, revision, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, 'active', $5, $6, 1, $7, 1, $5, $5
       )`,
      [
        exactHumanId,
        product.userId,
        product.humanActorId,
        digest(new TextEncoder().encode(`lineage:${suffix}`)),
        sourceCreatedAt,
        exactDeviceId,
        digest(new TextEncoder().encode(`recovery:${suffix}`)),
      ],
    );
    await transaction.unsafe(
      `INSERT INTO human_crypto_devices (
         device_id, human_id, user_id, human_actor_id, client_kind,
         installation_lineage_digest, device_generation,
         signing_public_key, encryption_public_key, public_fingerprint,
         state, authorization_kind, recovery_generation,
         authorization_evidence_digest, key_package_generation,
         key_package_count, revision, created_at, activated_at
       ) VALUES (
         $1, $2, $3, $4, 'electron', $5, 1, $6, $7, $8,
         'active', 'first_bootstrap', 1, $9, 1, 0, 9, $10, $10
       )`,
      [
        exactDeviceId,
        exactHumanId,
        product.userId,
        product.humanActorId,
        digest(new TextEncoder().encode(`lineage:${suffix}`)),
        signing.publicKey,
        encryption.publicKey,
        crypto.hash(signing.publicKey),
        digest(new TextEncoder().encode(`evidence:${suffix}`)),
        sourceCreatedAt,
      ],
    );
    await transaction.unsafe(
      `INSERT INTO namespace_crypto_bindings (
         namespace_id, revision, binding_hash, previous_binding_hash,
         signed_binding_bytes, human_keyring_envelope_bytes,
         ai_keyring_envelope_bytes
       ) VALUES ($1, 0, $2, NULL, $3, $4, $5)`,
      [
        exactNamespaceId,
        bindingHash,
        bindingBytes,
        serializeNamespaceKeyringEnvelopeV2(humanEnvelope),
        serializeNamespaceKeyringEnvelopeV2(aiEnvelope),
      ],
    );
    await transaction.unsafe(
      `INSERT INTO namespace_crypto_heads (
         namespace_id, access_revision, binding_hash, domain_id, domain_epoch
       ) VALUES ($1, 0, $2, $3, 1)`,
      [exactNamespaceId, bindingHash, exactDomainId],
    );
    await transaction.unsafe(
      `INSERT INTO crypto_objects (object_id, payload_hash, payload_bytes)
       VALUES ($1, $2, $3)`,
      [inputObjectId, crypto.hash(payloadBytes), payloadBytes],
    );
    await transaction.unsafe(
      `INSERT INTO object_crypto_access_manifests (
         object_id, access_revision, manifest_hash, previous_manifest_hash,
         payload_hash, manifest_bytes
       ) VALUES ($1, 0, $2, NULL, $3, $4)`,
      [
        inputObjectId,
        preparedManifest.manifestHash,
        crypto.hash(payloadBytes),
        preparedManifest.manifestBytes,
      ],
    );
    await transaction.unsafe(
      `INSERT INTO object_crypto_namespace_envelopes (
         object_id, access_revision, namespace_id, ordinal,
         envelope_hash, envelope_bytes
       ) VALUES ($1, 0, $2, 0, $3, $4)`,
      [
        inputObjectId,
        exactNamespaceId,
        crypto.hash(envelopeBytes),
        envelopeBytes,
      ],
    );
    await transaction.unsafe(
      `INSERT INTO object_crypto_access_heads (
         object_id, access_revision, manifest_hash
       ) VALUES ($1, 0, $2)`,
      [inputObjectId, preparedManifest.manifestHash],
    );
    const rows = await transaction.unsafe<{ id: number }[]>(
      `INSERT INTO session_messages (
         session_id, role, content, fingerprint, crypto_object_id,
         created_at, edit_revision, transcript_origin
       ) VALUES ($1, 'user', $2, $3, $4, $5, 0, 'main')
       RETURNING id`,
      [
        product.sessionId,
        CONTENT_SENTINEL,
        `m241-fingerprint-${suffix}`,
        inputObjectId,
        sourceCreatedAt,
      ],
    );
    const messageId = rows[0]?.id;
    if (!Number.isSafeInteger(messageId) || messageId === undefined) {
      throw new Error("M241 saga source message was not inserted");
    }
    await transaction.unsafe(
      `INSERT INTO session_message_crypto_revisions (
         session_id, message_id, edit_revision, room_id,
         namespace_id_at_allocation, crypto_object_id, payload_version,
         key_class, author_role, append_idempotency_key,
         allocation_request_digest, completion, disposition,
         parity_status, attempt_count, next_attempt_at,
         crypto_completed_at, created_at, updated_at
       ) VALUES (
         $1, $2, 0, $3, $4, $5, 2, 'ai', 'user', $6, $7,
         'complete', 'active', 'client_verified', 0, $8, $8, $8, $8
       )`,
      [
        product.sessionId,
        messageId,
        product.roomId,
        exactNamespaceId,
        inputObjectId,
        `m241-append-${suffix}`,
        digest(new TextEncoder().encode(`allocation:${suffix}`)),
        sourceCreatedAt,
      ],
    );
    return rows;
  });
  const messageId = messageRows[0]!.id;
  const fixture = Object.freeze({
    product,
    crypto,
    authority: Object.freeze({
      humanId: exactHumanId,
      humanState: "active" as const,
      deviceId: exactDeviceId,
      deviceHumanId: exactHumanId,
      deviceState: "active" as const,
      deviceAuthorizationRevision: authorizationRevision(9),
      deviceSigningPublicKey: signing.publicKey,
      deviceSigningPrivateKey: signing.privateKey,
      namespaceId: exactNamespaceId,
      namespaceState: "active" as const,
      membershipHumanId: exactHumanId,
      membershipState: "active" as const,
      namespaceAccessRevision: accessRevision(0),
      policyRevision: authorizationRevision(1),
      domainId: exactDomainId,
      domainState: "active" as const,
      domainEpoch: domainEpoch(1),
      processorKind: "stenographer" as const,
      processorVersion: 1 as const,
      processorState: "active" as const,
      processorAuthorizationRevision: authorizationRevision(1),
      aiRoot,
    }),
    domainId: exactDomainId,
    humanId: exactHumanId,
    deviceId: exactDeviceId,
    inputObjectId,
    messageId,
    sourceCreatedAt,
  });
  sagaCryptoFixtures.add(fixture);
  return fixture;
}

async function cleanupBackgroundRequests(): Promise<void> {
  if (backgroundRequestIds.size === 0) return;
  const ids = [...backgroundRequestIds];
  await admin.unsafe(
    `DELETE FROM processor_crypto_signer_authorizations
      WHERE request_id = ANY($1::text[])`,
    [ids],
  );
  await admin.unsafe(
    `DELETE FROM background_crypto_authorization_requests
      WHERE request_id = ANY($1::text[])`,
    [ids],
  );
  backgroundRequestIds.clear();
}

async function cleanupCryptoObjects(): Promise<void> {
  if (cryptoObjectIds.size === 0) return;
  const ids = [...cryptoObjectIds];
  await admin.unsafe(
    `DELETE FROM object_crypto_access_heads
      WHERE object_id = ANY($1::text[])`,
    [ids],
  );
  await admin.unsafe(
    `DELETE FROM object_crypto_namespace_envelopes
      WHERE object_id = ANY($1::text[])`,
    [ids],
  );
  await admin.unsafe(
    `DELETE FROM object_crypto_access_manifests
      WHERE object_id = ANY($1::text[])`,
    [ids],
  );
  await admin.unsafe(
    `DELETE FROM crypto_objects WHERE object_id = ANY($1::text[])`,
    [ids],
  );
  cryptoObjectIds.clear();
}

async function cleanupSagaProductChildren(
  fixture: SagaCryptoFixture,
): Promise<void> {
  await admin.begin(async (transaction) => {
    await transaction.unsafe(
      `DELETE FROM room_event_rollups WHERE room_id = $1`,
      [fixture.product.roomId],
    );
    await transaction.unsafe(
      `DELETE FROM room_events WHERE room_id = $1`,
      [fixture.product.roomId],
    );
    await transaction.unsafe(
      `DELETE FROM room_journal_crypto_publications WHERE room_id = $1`,
      [fixture.product.roomId],
    );
    await transaction.unsafe(
      `DELETE FROM room_journal_batches WHERE room_id = $1`,
      [fixture.product.roomId],
    );
    await transaction.unsafe(
      `DELETE FROM room_journal_state WHERE room_id = $1`,
      [fixture.product.roomId],
    );
    await transaction.unsafe(
      `DELETE FROM session_message_crypto_revisions WHERE session_id = $1`,
      [fixture.product.sessionId],
    );
    await transaction.unsafe(
      `DELETE FROM session_messages WHERE session_id = $1`,
      [fixture.product.sessionId],
    );
  });
}

async function cleanupProductCryptoReferences(
  fixture: ProductFixture,
): Promise<void> {
  await admin.begin(async (transaction) => {
    await transaction.unsafe(
      `DELETE FROM room_event_rollups WHERE room_id = $1`,
      [fixture.roomId],
    );
    await transaction.unsafe(
      `DELETE FROM room_events WHERE room_id = $1`,
      [fixture.roomId],
    );
  });
}

async function cleanupSagaAuthorities(): Promise<void> {
  for (const fixture of sagaCryptoFixtures) {
    await admin.begin(async (transaction) => {
      await transaction.unsafe(
        `DELETE FROM namespace_crypto_heads WHERE namespace_id = $1`,
        [fixture.product.namespaceId],
      );
      await transaction.unsafe(
        `DELETE FROM namespace_crypto_bindings WHERE namespace_id = $1`,
        [fixture.product.namespaceId],
      );
      await transaction.unsafe(
        `DELETE FROM human_crypto_devices WHERE device_id = $1`,
        [fixture.deviceId],
      );
      await transaction.unsafe(
        `DELETE FROM human_crypto_custodies WHERE human_id = $1`,
        [fixture.humanId],
      );
    });
  }
}

async function expectInsufficientPrivilege(
  operation: Promise<unknown>,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect((error as { code?: unknown }).code).toBe("42501");
    return;
  }
  throw new Error("expected PostgreSQL insufficient_privilege");
}

function extractionPlan(input: Readonly<{
  fixture: ProductFixture;
  batchId: string;
  eventId: string;
  objectId: string;
  sequence: number;
  createdAt: Date;
}>): ProtectedJournalAttachmentPlanV1 {
  return {
    kind: "extraction",
    roomId: input.fixture.roomId,
    namespaceId: input.fixture.namespaceId,
    rebuildGeneration: 1,
    sourceBatchId: input.batchId,
    statusUpdates: [],
    events: [{
      eventId: input.eventId,
      objectId: input.objectId,
      sequence: input.sequence,
      kind: "decision",
      status: "active",
      supersedesEventId: null,
      resolvesEventId: null,
      sourceMessageIds: [input.sequence],
      sourceBatchId: input.batchId,
      batchLocalOrdinal: 0,
      extractorVersion: "m241-v1",
      createdAt: input.createdAt.toISOString(),
    }],
    foldedBatchLocalOrdinals: [],
    rollup: null,
  };
}

function reservation(
  suffix: string,
  plan: ProtectedJournalAttachmentPlanV1,
  now: Date,
): ReserveProtectedJournalPublicationInput {
  const bytes = encodeProtectedJournalAttachmentPlanV1(plan);
  return {
    publicationId: `m241-publication-${suffix}`,
    requestId: `m241-publication-request-${suffix}`,
    workId: `m241-publication-work-${suffix}`,
    workIdentityHash: digest(
      new TextEncoder().encode(`publication-work:${suffix}`),
    ),
    descriptorHash: digest(
      new TextEncoder().encode(`publication-descriptor:${suffix}`),
    ),
    attachmentPlanHash: digest(bytes),
    attachmentPlanBytes: bytes,
    now,
  };
}

async function insertJournalClaim(
  fixture: ProductFixture,
  input: Readonly<{
    batchId: string;
    sourceLease: string;
    now: Date;
    from: number;
    through: number;
  }>,
): Promise<void> {
  await admin.begin(async (transaction) => {
    await transaction.unsafe(
      `INSERT INTO room_journal_state (
         room_id, last_processed_message_id, lease_token, lease_expires_at,
         extractor_version, historical_backfill_status, rebuild_generation,
         created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'm241-v1', 'not_needed', 1, $5, $5)
       ON CONFLICT (room_id) DO UPDATE SET
         lease_token = EXCLUDED.lease_token,
         lease_expires_at = EXCLUDED.lease_expires_at,
         rebuild_generation = 1,
         rebuild_requested_at = NULL,
         updated_at = EXCLUDED.updated_at`,
      [
        fixture.roomId,
        input.from,
        input.sourceLease,
        new Date(input.now.getTime() + 120_000),
        input.now,
      ],
    );
    await transaction.unsafe(
      `INSERT INTO room_journal_batches (
         id, room_id, from_message_id_exclusive,
         through_message_id_inclusive, extractor_version, lane, status,
         attempt_count, started_at, created_at
       ) VALUES ($1, $2, $3, $4, 'm241-v1', 'live', 'running', 1, $5, $5)`,
      [
        input.batchId,
        fixture.roomId,
        input.from,
        input.through,
        input.now,
      ],
    );
  });
}

async function publishReceipt(input: Readonly<{
  suffix: string;
  plan: ProtectedJournalAttachmentPlanV1;
  sourceLease: string;
  now: Date;
}>): Promise<Readonly<{
  publicationId: string;
  leaseToken: string;
  attachmentStatus: string;
}>> {
  const receipt = reservation(input.suffix, input.plan, input.now);
  expect((await publicationRepository.reserve(receipt)).status).toBe(
    "created",
  );
  const leaseToken = randomUUID();
  expect((await publicationRepository.claim({
    publicationId: receipt.publicationId,
    leaseToken,
    now: new Date(input.now.getTime() + 1),
  })).status).toBe("claimed");
  const objectIds = input.plan.kind === "extraction"
    ? input.plan.events.map((event) => event.objectId)
    : [input.plan.rollup!.objectId];
  expect((await publicationRepository.markCryptoCommitted({
    publicationId: receipt.publicationId,
    leaseToken,
    descriptorHash: receipt.descriptorHash,
    attachmentPlanHash: receipt.attachmentPlanHash,
    outputObjectIds: objectIds,
    now: new Date(input.now.getTime() + 2),
  })).status).toBe("committed");
  const attached = await publicationRepository.attach({
    publicationId: receipt.publicationId,
    leaseToken,
    sourceLeaseToken: input.sourceLease,
    sourceBindingFingerprint:
      fingerprintProtectedStenographerSourceBindings([]),
    sourceBindings: [],
    source: {
      kind: "extraction",
      lane: "live",
      fromMessageIdExclusive:
        input.plan.events[0]!.sourceMessageIds[0]! - 1,
      throughMessageIdInclusive:
        input.plan.events[0]!.sourceMessageIds[0]!,
      extractorVersion: "m241-v1",
      coveredRangeFingerprint:
        fingerprintProtectedStenographerCoveredRange({
          fromMessageIdExclusive:
            input.plan.events[0]!.sourceMessageIds[0]! - 1,
          throughMessageIdInclusive:
            input.plan.events[0]!.sourceMessageIds[0]!,
          rows: [],
        }),
    },
    now: new Date(input.now.getTime() + 3),
  });
  return Object.freeze({
    publicationId: receipt.publicationId,
    leaseToken,
    attachmentStatus: attached.status,
  });
}

beforeAll(async () => {
  admin = sqlClient(adminUrl);
  cryptoClient = sqlClient(cryptoUrl);
  appClient = sqlClient(appUrl);
  agentClient = sqlClient(agentUrl);
  cryptoHandle = await verifyCryptoPostgresHandle(
    cryptoConnection(cryptoClient),
  );
  productHandle = await verifyConversationProductPostgresHandle(
    productConnection(appClient),
  );
  backgroundRepository = new PostgresBackgroundAuthorizationRepository(
    cryptoHandle,
  );
  publicationRepository =
    new PostgresProtectedJournalPublicationRepository(
      productHandle,
      RECORD_COMMITMENT,
    );
  rebuildRepository = new PostgresProtectedJournalRebuildRepository(
    productHandle,
  );
});

afterAll(async () => {
  for (const fixture of sagaCryptoFixtures) {
    await cleanupSagaProductChildren(fixture);
  }
  for (const fixture of productFixtures) {
    await cleanupProductCryptoReferences(fixture);
  }
  await cleanupBackgroundRequests();
  await cleanupCryptoObjects();
  await cleanupSagaAuthorities();
  for (const fixture of sagaCryptoFixtures) {
    fixture.authority.aiRoot.fill(0);
    fixture.authority.deviceSigningPrivateKey.fill(0);
  }
  sagaCryptoFixtures.clear();
  for (const fixture of [...productFixtures]) {
    await cleanupProductFixture(fixture);
  }
  await Promise.all([
    agentClient.end(),
    appClient.end(),
    cryptoClient.end(),
    admin.end(),
  ]);
});

describe("Wave 10 disposable PostgreSQL evidence", () => {
  test("generated migration preserves exact product/crypto authority boundaries", async () => {
    const rows = await admin.unsafe<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }[]>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class
        WHERE relname IN (
          'background_crypto_authorization_requests',
          'processor_crypto_signer_authorizations',
          'room_journal_crypto_publications'
        )
        ORDER BY relname`,
    );
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) =>
      row.relname !== "room_journal_crypto_publications"
    )).toEqual([
      {
        relname: "background_crypto_authorization_requests",
        relrowsecurity: true,
        relforcerowsecurity: true,
      },
      {
        relname: "processor_crypto_signer_authorizations",
        relrowsecurity: true,
        relforcerowsecurity: true,
      },
    ]);

    const privileges = await admin.unsafe<{
      crypto_background_select: boolean;
      crypto_signer_insert: boolean;
      crypto_signer_update: boolean;
      crypto_product_event_select: boolean;
      crypto_publication_select: boolean;
      app_background_select: boolean;
      app_publication_select: boolean;
      agent_background_select: boolean;
    }[]>(
      `SELECT
         has_table_privilege(
           'nautilo_crypto',
           'background_crypto_authorization_requests',
           'SELECT'
         ) AS crypto_background_select,
         has_table_privilege(
           'nautilo_crypto',
           'processor_crypto_signer_authorizations',
           'INSERT'
         ) AS crypto_signer_insert,
         has_table_privilege(
           'nautilo_crypto',
           'processor_crypto_signer_authorizations',
           'UPDATE'
         ) AS crypto_signer_update,
         has_table_privilege(
           'nautilo_crypto',
           'room_events',
           'SELECT'
         ) AS crypto_product_event_select,
         has_table_privilege(
           'nautilo_crypto',
           'room_journal_crypto_publications',
           'SELECT'
         ) AS crypto_publication_select,
         has_table_privilege(
           'nautilo',
           'background_crypto_authorization_requests',
           'SELECT'
         ) AS app_background_select,
         has_table_privilege(
           'nautilo',
           'room_journal_crypto_publications',
           'SELECT'
         ) AS app_publication_select,
         has_table_privilege(
           'nautilo_agent',
           'background_crypto_authorization_requests',
           'SELECT'
         ) AS agent_background_select`,
    );
    expect(privileges).toHaveLength(1);
    expect(privileges[0]).toEqual({
      crypto_background_select: true,
      crypto_signer_insert: true,
      crypto_signer_update: false,
      crypto_product_event_select: false,
      crypto_publication_select: false,
      app_background_select: false,
      app_publication_select: true,
      agent_background_select: false,
    });

    const hidden = initialRecord();
    expect((await backgroundRepository.create(hidden)).status).toBe("created");
    expect(await cryptoClient.unsafe(
      `SELECT request_id
         FROM background_crypto_authorization_requests
        WHERE request_id = $1`,
      [hidden.snapshot.requestId],
    )).toHaveLength(1);
    await expectInsufficientPrivilege(
      appClient.unsafe(
        `SELECT request_id
           FROM background_crypto_authorization_requests
          WHERE request_id = $1`,
        [hidden.snapshot.requestId],
      ),
    );

    await expectInsufficientPrivilege(
      cryptoClient.unsafe("SELECT id FROM room_events LIMIT 1"),
    );
    await expectInsufficientPrivilege(
      agentClient.unsafe(
        "SELECT request_id FROM background_crypto_authorization_requests LIMIT 1",
      ),
    );
  });

  test("Wave 11 authority sets survive restart with append-plus-prune crypto-only children", async () => {
    const record = initialV2Record();
    expect((await backgroundRepository.create(record)).status).toBe(
      "created",
    );

    const restartedRepository = new PostgresBackgroundAuthorizationRepository(
      await verifyCryptoPostgresHandle(cryptoConnection(cryptoClient)),
    );
    expect(await restartedRepository.get(record.snapshot.requestId)).toEqual(
      record,
    );

    const counts = await cryptoClient.unsafe<{
      domain_count: string;
      namespace_count: string;
    }[]>(
      `SELECT
         (SELECT count(*)::text
            FROM background_crypto_authorization_domain_requirements
           WHERE request_id = $1) AS domain_count,
         (SELECT count(*)::text
            FROM background_crypto_authorization_namespace_requirements
           WHERE request_id = $1) AS namespace_count`,
      [record.snapshot.requestId],
    );
    expect(counts).toHaveLength(1);
    expect(counts[0]).toMatchObject({
      domain_count: "2",
      namespace_count: "2",
    });

    const privileges = await admin.unsafe<{
      crypto_select: boolean;
      crypto_insert: boolean;
      crypto_update: boolean;
      crypto_delete: boolean;
      app_select: boolean;
      agent_select: boolean;
    }[]>(
      `SELECT
         has_table_privilege(
           'nautilo_crypto',
           'background_crypto_authorization_namespace_requirements',
           'SELECT'
         ) AS crypto_select,
         has_table_privilege(
           'nautilo_crypto',
           'background_crypto_authorization_namespace_requirements',
           'INSERT'
         ) AS crypto_insert,
         has_table_privilege(
           'nautilo_crypto',
           'background_crypto_authorization_namespace_requirements',
           'UPDATE'
         ) AS crypto_update,
         has_table_privilege(
           'nautilo_crypto',
           'background_crypto_authorization_namespace_requirements',
           'DELETE'
         ) AS crypto_delete,
         has_table_privilege(
           'nautilo',
           'background_crypto_authorization_namespace_requirements',
           'SELECT'
         ) AS app_select,
         has_table_privilege(
           'nautilo_agent',
           'background_crypto_authorization_namespace_requirements',
           'SELECT'
         ) AS agent_select`,
    );
    expect(privileges).toHaveLength(1);
    expect(privileges[0]).toMatchObject({
      crypto_select: true,
      crypto_insert: true,
      crypto_update: false,
      crypto_delete: true,
      app_select: false,
      agent_select: false,
    });

    await expectInsufficientPrivilege(appClient.unsafe(
      `SELECT request_id
         FROM background_crypto_authorization_namespace_requirements
        WHERE request_id = $1`,
      [record.snapshot.requestId],
    ));
    await expectInsufficientPrivilege(agentClient.unsafe(
      `SELECT request_id
         FROM background_crypto_authorization_domain_requirements
        WHERE request_id = $1`,
      [record.snapshot.requestId],
    ));

    await cryptoClient.unsafe(
      `UPDATE background_crypto_authorization_requests
          SET state = 'cancelled',
              terminal_reason = 'cancelled',
              finished_at = $2::timestamptz
        WHERE request_id = $1`,
      [record.snapshot.requestId, new Date(START).toISOString()],
    );
    expect(await restartedRepository.pruneTerminal({
      now: START + BACKGROUND_AUTHORIZATION_TERMINAL_RETENTION_MS + 1,
      limit: 1,
    })).toBe(1);
    expect(await restartedRepository.get(record.snapshot.requestId)).toBeNull();
    const prunedChildren = await cryptoClient.unsafe<{
      domain_count: string;
      namespace_count: string;
    }[]>(
      `SELECT
         (SELECT count(*)::text
            FROM background_crypto_authorization_domain_requirements
           WHERE request_id = $1) AS domain_count,
         (SELECT count(*)::text
            FROM background_crypto_authorization_namespace_requirements
           WHERE request_id = $1) AS namespace_count`,
      [record.snapshot.requestId],
    );
    expect(prunedChildren[0]).toMatchObject({
      domain_count: "0",
      namespace_count: "0",
    });
  });

  test("first valid device response and first worker claim win real CAS races", async () => {
    const initial = initialRecord();
    const awaitingDevice = withRecipient(initial);
    expect((await backgroundRepository.create(initial)).status).toBe(
      "created",
    );
    expect((await backgroundRepository.compareAndSwap({
      expectedRequestRevision: 0,
      next: awaitingDevice,
    })).status).toBe("updated");

    const responses = await Promise.all([
      backgroundRepository.acceptVerifiedResponse({
        response: verifiedResponse(awaitingDevice, "one"),
        acceptedAt: START + 2,
      }),
      backgroundRepository.acceptVerifiedResponse({
        response: verifiedResponse(awaitingDevice, "two"),
        acceptedAt: START + 2,
      }),
    ]);
    expect(responses.map((result) => result.status).sort()).toEqual([
      "accepted",
      "lost",
    ]);

    const ready = await backgroundRepository.get(
      initial.snapshot.requestId,
    );
    expect(ready?.snapshot.state).toBe("grant_ready");
    if (ready === null) throw new Error("accepted request disappeared");
    const claims = await Promise.all([
      backgroundRepository.compareAndSwap({
        expectedRequestRevision: ready.snapshot.requestRevision,
        next: {
          ...ready,
          snapshot: claimBackgroundAuthorizationRequest(
            ready.snapshot,
            `claim-one-${portableSuffix()}`,
            START + 3,
            START + 60_003,
          ),
        },
      }),
      backgroundRepository.compareAndSwap({
        expectedRequestRevision: ready.snapshot.requestRevision,
        next: {
          ...ready,
          snapshot: claimBackgroundAuthorizationRequest(
            ready.snapshot,
            `claim-two-${portableSuffix()}`,
            START + 3,
            START + 60_003,
          ),
        },
      }),
    ]);
    expect(claims.map((result) => result.status).sort()).toEqual([
      "stale",
      "updated",
    ]);
    expect((await backgroundRepository.get(initial.snapshot.requestId))
      ?.snapshot.state).toBe("claimed");

    const signerRows = await cryptoClient.unsafe<{ count: string }[]>(
      `SELECT count(*)::text AS count
         FROM processor_crypto_signer_authorizations
        WHERE request_id = $1`,
      [initial.snapshot.requestId],
    );
    expect(signerRows[0]?.count).toBe("1");
  });

  test("current V2: fresh reconciliation grant persists without execution output slots", async () => {
    const fixture = await currentV2Record(portableSuffix(), "reconciliation");
    expect((await backgroundRepository.create(fixture.initial)).status).toBe("created");
    expect((await backgroundRepository.compareAndSwap({expectedRequestRevision: 0, next: fixture.waiting})).status).toBe("updated");
    expect(await backgroundRepository.acceptVerifiedResponse({response: fixture.response, acceptedAt: START + 2}))
      .toMatchObject({status: "accepted"});
    const restarted = new PostgresBackgroundAuthorizationRepository(
      await verifyCryptoPostgresHandle(cryptoConnection(cryptoClient)),
    );
    const durable = await restarted.get(fixture.initial.snapshot.requestId);
    expect(durable).toMatchObject({workKind: "stenographer.publication_reconcile", purpose: "journal.reconcile",
      snapshot: {formatVersion: 2, state: "grant_ready"}});
    expect(durable?.acceptedMaterial?.responseBytes).toEqual(fixture.responseBytes);
    const descriptor = fixture.response.descriptor;
    expect(descriptor.outputSlots).toEqual([]);
    expect(descriptor.inputBindings).toHaveLength(1);
    const rows = await drizzle(cryptoClient).select({authorizationBytes: processorCryptoSignerAuthorizations.authorizationBytes})
      .from(processorCryptoSignerAuthorizations).where(eq(processorCryptoSignerAuthorizations.requestId, fixture.initial.snapshot.requestId));
    expect(rows).toHaveLength(1);
    const evidence = verifyHistoricalProcessorSignerAuthorizationV2(fixture.crypto, {
      authorizationBytes: rows[0]!.authorizationBytes, resolveHistoricalIssuer: () => fixture.issuerSigningPublicKey,
    });
    try {
      expect(evidence.certificate.descriptor.workKind).toBe("stenographer.publication_reconcile");
      expect(evidence.certificate.descriptor.outputSlots).toEqual([]);
    } finally {destroyVerifiedProcessorSignerAuthorizationV2(evidence);}
  });

  test("current V2: acceptance and unstarted fallback cancellation have one durable winner", async () => {
    const fixture = await currentV2Record();
    expect((await backgroundRepository.create(fixture.initial)).status).toBe(
      "created",
    );
    expect((await backgroundRepository.compareAndSwap({
      expectedRequestRevision: 0,
      next: fixture.waiting,
    })).status).toBe("updated");

    const acceptanceClient = sqlClient(cryptoUrl, 1);
    const cancellationClient = sqlClient(cryptoUrl, 1);
    try {
      const acceptanceRepository = new PostgresBackgroundAuthorizationRepository(
        await verifyCryptoPostgresHandle(
          cryptoConnection(acceptanceClient),
        ),
      );
      const cancellationRepository =
        new PostgresBackgroundAuthorizationRepository(
          await verifyCryptoPostgresHandle(
            cryptoConnection(cancellationClient),
          ),
        );
      const [accepted, cancelled] = await Promise.all([
        acceptanceRepository.acceptVerifiedResponse({
          response: fixture.response,
          acceptedAt: START + 2,
        }),
        cancellationRepository.cancelUnconsumedProcessorRequest({
          expected: fixture.waiting,
          now: START + 2,
        }),
      ]);
      expect([
        accepted.status === "accepted" && cancelled === false,
        accepted.status === "lost" && cancelled === true,
      ]).toContain(true);
      expect([
        accepted.status === "accepted" && cancelled === false,
        accepted.status === "lost" && cancelled === true,
      ].filter(Boolean)).toHaveLength(1);

      const durable = await backgroundRepository.get(
        fixture.initial.snapshot.requestId,
      );
      const signerRows = await drizzle(cryptoClient).select({count: count()})
        .from(processorCryptoSignerAuthorizations)
        .where(eq(processorCryptoSignerAuthorizations.requestId, fixture.initial.snapshot.requestId));
      if (accepted.status === "accepted") {
        expect(durable).toMatchObject({
          snapshot: { formatVersion: 2, state: "grant_ready" },
          processorAuthorizationRevision: null,
          expectedDomainEpoch: null,
        });
        expect(durable?.acceptedMaterial?.responseBytes).toEqual(
          fixture.responseBytes,
        );
        expect(signerRows[0]?.count).toBe(1);
        expect(await cancellationRepository.cancelUnconsumedProcessorRequest({
          expected: fixture.waiting,
          now: START + 3,
        })).toBe(false);
      } else {
        expect(durable).toMatchObject({
          snapshot: {
            formatVersion: 2,
            state: "cancelled",
            terminalReason: "cancelled",
          },
          acceptedMaterial: null,
        });
        expect(signerRows[0]?.count).toBe(0);
      }
    } finally {
      await Promise.all([
        acceptanceClient.end(),
        cancellationClient.end(),
      ]);
    }
  });

  test("current V2: cancelled handoff retries idempotently without reopening acceptance", async () => {
    const fixture = await currentV2Record();
    expect((await backgroundRepository.create(fixture.initial)).status).toBe(
      "created",
    );
    expect((await backgroundRepository.compareAndSwap({
      expectedRequestRevision: 0,
      next: fixture.waiting,
    })).status).toBe("updated");
    expect(await backgroundRepository.cancelUnconsumedProcessorRequest({
      expected: fixture.waiting,
      now: START + 2,
    })).toBe(true);

    const cancelled = await backgroundRepository.get(
      fixture.initial.snapshot.requestId,
    );
    if (cancelled === null) throw new Error("cancelled V2 handoff disappeared");
    expect(await backgroundRepository.cancelUnconsumedProcessorRequest({
      expected: fixture.waiting,
      now: START + 3,
    })).toBe(true);
    expect(await backgroundRepository.cancelUnconsumedProcessorRequest({
      expected: cancelled,
      now: START + 4,
    })).toBe(true);
    expect(await backgroundRepository.getByIdempotencyKey(
      fixture.initial.idempotencyKey,
    )).toEqual(cancelled);
    expect(await backgroundRepository.acceptVerifiedResponse({
      response: fixture.response,
      acceptedAt: START + 5,
    })).toMatchObject({ status: "lost" });
    expect(await backgroundRepository.get(
      fixture.initial.snapshot.requestId,
    )).toEqual(cancelled);
    expect((await drizzle(cryptoClient).select({count: count()})
      .from(processorCryptoSignerAuthorizations)
      .where(eq(processorCryptoSignerAuthorizations.requestId, fixture.initial.snapshot.requestId)))[0]?.count).toBe(0);
  });

  test("current V2: accepted response and public signer history survive restart immutably", async () => {
    const fixture = await currentV2Record();
    expect((await backgroundRepository.create(fixture.initial)).status).toBe(
      "created",
    );
    expect((await backgroundRepository.compareAndSwap({
      expectedRequestRevision: 0,
      next: fixture.waiting,
    })).status).toBe("updated");
    expect(await backgroundRepository.acceptVerifiedResponse({
      response: fixture.response,
      acceptedAt: START + 2,
    })).toMatchObject({ status: "accepted" });

    const restartedClient = sqlClient(cryptoUrl, 1);
    try {
      const restartedRepository = new PostgresBackgroundAuthorizationRepository(
        await verifyCryptoPostgresHandle(cryptoConnection(restartedClient)),
      );
      const durable = await restartedRepository.get(
        fixture.initial.snapshot.requestId,
      );
      expect(durable).toMatchObject({
        snapshot: { formatVersion: 2, state: "grant_ready" },
        processorAuthorizationRevision: null,
        expectedDomainEpoch: null,
      });
      expect(durable?.acceptedMaterial?.responseBytes).toEqual(
        fixture.responseBytes,
      );
      expect(await restartedRepository.cancelUnconsumedProcessorRequest({
        expected: fixture.waiting,
        now: START + 3,
      })).toBe(false);

      const historyRows = await drizzle(restartedClient).select({
        format_version: processorCryptoSignerAuthorizations.formatVersion,
        domain_epoch: processorCryptoSignerAuthorizations.domainEpoch,
        processor_authorization_revision: processorCryptoSignerAuthorizations.processorAuthorizationRevision,
        authorization_bytes: processorCryptoSignerAuthorizations.authorizationBytes,
      }).from(processorCryptoSignerAuthorizations)
        .where(eq(processorCryptoSignerAuthorizations.requestId, fixture.initial.snapshot.requestId));
      expect(historyRows).toHaveLength(1);
      expect(historyRows[0]).toMatchObject({
        format_version: 2,
        domain_epoch: null,
        processor_authorization_revision: null,
      });
      const retained = verifyHistoricalProcessorSignerAuthorizationV2(
        fixture.crypto,
        {
          authorizationBytes: Uint8Array.from(
            historyRows[0]!.authorization_bytes,
          ),
          resolveHistoricalIssuer: ({ issuer, descriptor }) => {
            expect(issuer).toEqual(fixture.response.issuer);
            expect(descriptor.requestId).toBe(
              fixture.initial.snapshot.requestId,
            );
            return fixture.issuerSigningPublicKey;
          },
        },
      );
      try {
        if (!("authority" in retained.certificate.descriptor)) {
          throw new Error("Expected retained Stenographer authority");
        }
        expect(retained.certificate.descriptor.requestId).toBe(
          fixture.initial.snapshot.requestId,
        );
        expect(retained.certificate.descriptor.authority.domainId).toBe(
          fixture.initial.domainId,
        );
      } finally {
        destroyVerifiedProcessorSignerAuthorizationV2(retained);
      }
      await expectInsufficientPrivilege(restartedClient.unsafe(
        `UPDATE processor_crypto_signer_authorizations
            SET policy_revision = policy_revision
          WHERE request_id = $1`,
        [fixture.initial.snapshot.requestId],
      ));
    } finally {
      await restartedClient.end();
    }
  });

  test("a new process sees durable work but not a private recipient and advances generation", async () => {
    const initial = initialRecord();
    const awaitingDevice = withRecipient(initial);
    expect((await backgroundRepository.create(initial)).status).toBe(
      "created",
    );
    expect((await backgroundRepository.compareAndSwap({
      expectedRequestRevision: 0,
      next: awaitingDevice,
    })).status).toBe("updated");

    const restartedClient = sqlClient(cryptoUrl);
    try {
      const restartedHandle = await verifyCryptoPostgresHandle(
        cryptoConnection(restartedClient),
      );
      const restartedRepository =
        new PostgresBackgroundAuthorizationRepository(restartedHandle);
      const persisted = await restartedRepository.get(
        initial.snapshot.requestId,
      );
      expect(persisted).toMatchObject({
        snapshot: {
          state: "awaiting_device",
          recipientGeneration: 0,
          recipient: {
            recipientKeyId: awaitingDevice.snapshot.recipient?.recipientKeyId,
          },
        },
      });
      if (persisted === null) throw new Error("restart lost durable request");
      const next = {
        ...persisted,
        snapshot: advanceBackgroundAuthorizationGeneration(
          persisted.snapshot,
          {
            reason: "recipient_lost",
            now: START + 2,
            nextAttemptAt: START + 2,
          },
        ),
        descriptorBytes: null,
        acceptedMaterial: null,
      };
      expect((await restartedRepository.compareAndSwap({
        expectedRequestRevision: persisted.snapshot.requestRevision,
        next,
      })).status).toBe("updated");
    } finally {
      await restartedClient.end();
    }

    const advanced = await backgroundRepository.get(
      initial.snapshot.requestId,
    );
    expect(advanced).toMatchObject({
      snapshot: {
        state: "awaiting_recipient",
        recipientGeneration: 1,
        recipient: null,
        lastRetryReason: "recipient_lost",
        retryCount: 0,
      },
      descriptorBytes: null,
      acceptedMaterial: null,
    });
    const privateColumns = await admin.unsafe<{ count: string }[]>(
      `SELECT count(*)::text AS count
         FROM information_schema.columns
        WHERE table_name = 'background_crypto_authorization_requests'
          AND column_name ~ '(private|secret|domain_root|object_dek)'`,
    );
    expect(privateColumns[0]?.count).toBe("0");
  });

  test("a restarted concrete PostgreSQL saga attaches a committed transform exactly once", async () => {
    const product = await createProductFixture();
    const saga = await createSagaCryptoFixture(product);
    const workAt = new Date(START + 122_000);
    await admin.unsafe(
      `INSERT INTO room_journal_state (
         room_id, last_processed_message_id, extractor_version,
         historical_backfill_status, rebuild_generation, created_at,
         updated_at
       ) VALUES ($1, $2, 'm241-v1', 'not_needed', 0, $3, $3)`,
      [product.roomId, saga.messageId - 1, workAt],
    );
    const workRepository =
      new PostgresProtectedStenographerWorkRepository(productHandle);
    const claimed = await workRepository.claimExtraction({
      roomId: product.roomId,
      lane: "live",
      now: workAt,
    });
    if (claimed.status !== "claimed") {
      throw new Error(
        `M241 concrete saga failed to claim extraction: ${
          JSON.stringify(claimed)
        }`,
      );
    }
    for (const output of claimed.claim.outputSlots) {
      cryptoObjectIds.add(output.objectId);
    }
    const currentAuthority: ProtectedStenographerCryptoAuthority =
      Object.freeze({
        domainId: saga.domainId,
        processorAuthorizationRevision: 1,
        expectedDomainEpoch: 1,
        expectedNamespaceAccessRevision: 0,
        expectedPolicyRevision: 1,
      });
    const requestId = `m241-saga-${portableSuffix()}`;
    backgroundRequestIds.add(requestId);
    const durableRecord = createProtectedStenographerAuthorizationRecord({
      requestId,
      idempotencyKey: `m241-saga-idempotency-${portableSuffix()}`,
      work: { claim: claimed.claim, compactionModelId: null },
      authority: currentAuthority,
      now: workAt.getTime(),
    });
    expect((await backgroundRepository.create(durableRecord)).status).toBe(
      "created",
    );

    let clock = workAt.getTime();
    const recovery = new PostgresProtectedStenographerWorkRecovery(
      productHandle,
      {
        resolveCompactionModelId: () => Promise.resolve(null),
      },
    );
    const recipients = new ProcessorTransformRecipientRegistry({
      crypto: saga.crypto,
      now: () => clock,
    });
    let fulfillment:
      Awaited<
        ReturnType<typeof fulfillProcessorBackgroundAuthorizationRequest>
      >
      | null = null;
    let modelCalls = 0;
    let credentialClaims = 0;
    const realClaimPort =
      new BackgroundAuthorizationProcessorCredentialClaimPort(
        backgroundRepository,
      );
    const objectPort = createPostgresProcessorTransformObjectPort({
      handle: cryptoHandle,
      crypto: saga.crypto,
    });
    const descriptorFactory = createProtectedStenographerDescriptorFactory({
      crypto: saga.crypto,
      recovery,
      resolveCurrentAuthority: () => Promise.resolve(currentAuthority),
      now: () => clock,
    });
    const initialCoordinator =
      new ProtectedStenographerBackgroundCoordinator({
        repository: backgroundRepository,
        recipients,
        descriptors: descriptorFactory,
        responses: {
          verify: ({ record, responseBytes, signerAuthorizationBytes, now }) =>
            verifyCurrentBackgroundAuthorizationDeviceResponse({
              crypto: saga.crypto,
              expected: {
                kind: "processor",
                requestId: record.snapshot.requestId,
                recipientGeneration: record.snapshot.recipientGeneration,
                descriptorHash: Uint8Array.from(
                  Buffer.from(record.snapshot.descriptorDigest!, "hex"),
                ),
                recipientKeyId: record.snapshot.recipient!.recipientKeyId,
                recipientPublicKey: Uint8Array.from(
                  Buffer.from(
                    record.snapshot.recipient!.recipientPublicKey,
                    "base64url",
                  ),
                ),
              },
              responseBytes,
              signerAuthorizationBytes,
              now,
              resolveCurrentIssuingDevicePublicKey: () =>
                saga.authority.deviceSigningPublicKey,
            }),
        },
        transformMaterial: {
          loadAccepted: () => {
            if (fulfillment === null) {
              throw new Error("M241 saga signer evidence is unavailable");
            }
            return Promise.resolve({
              status: "loaded" as const,
              material: {
                signerAuthorizationBytes:
                  fulfillment.signerAuthorizationBytes.slice(),
                resolveCurrentIssuerPublicKey: () =>
                  saga.authority.deviceSigningPublicKey,
                resolveHistoricalNamespaceCommitter: () =>
                  saga.authority.deviceSigningPublicKey,
                resolveCurrentSignerIssuingDevicePublicKey: () =>
                  saga.authority.deviceSigningPublicKey,
                claims: {
                  claimExactCredential: (input) => {
                    credentialClaims += 1;
                    return realClaimPort.claimExactCredential(input);
                  },
                },
                objects: objectPort,
              },
            });
          },
        },
        execution: {
          executeWork: async ({ record, capability, signal }) => {
            const recovered =
              await recoverProtectedStenographerExecutionWork({
                record,
                recovery,
                now: new Date(clock),
              });
            if (
              recovered.status !== "recovered"
              || recovered.claim.kind !== "extraction"
              || !("sourceBatchId" in recovered.work)
            ) {
              throw new Error("M241 saga work could not be recovered");
            }
            const exactPublication =
              createProtectedStenographerExtractionPublicationAdapter({
                repository: publicationRepository,
                work: recovered.claim,
                publicationLeaseToken: randomUUID(),
                now: () => new Date(clock),
              });
            return runProtectedStenographerExtraction({
              capability,
              signal,
              work: recovered.work,
              resolveParticipantDisplays: () =>
                Promise.resolve(
                  recovered.claim.bindings.flatMap((binding) =>
                    binding.kind === "message"
                      ? [{
                        participantId: binding.participantId,
                        displayLabel: "M241 participant",
                      }]
                      : []
                  ),
                ),
              invokeModel: () => {
                modelCalls += 1;
                return Promise.resolve(JSON.stringify({
                  operations: [{
                    op: "append",
                    kind: "fact",
                    statement: "The PostgreSQL restart marker is durable.",
                    sourceMessageIds: ["M1"],
                  }],
                }));
              },
              publication: {
                reserve: exactPublication.reserve,
                attach: exactPublication.attach,
                markCryptoCommitted: () => {
                  throw new Error(
                    "injected post-crypto pre-product restart",
                  );
                },
              },
            });
          },
          reconcilePublication: () =>
            Promise.reject(new Error("initial process must crash first")),
        },
        now: () => clock,
        recipientKeyId: (record) =>
          `recipient-${record.snapshot.requestId}`,
        claimId: (record) => `claim-${record.snapshot.requestId}`,
        nextAttemptAt: (_record, _reason, now) => now,
      });
    const prepared = await initialCoordinator.prepareRecipient(requestId);
    expect(prepared.status).toBe("device_authorization_required");
    if (prepared.status !== "device_authorization_required") {
      throw new Error("M241 saga recipient preparation failed");
    }
    const descriptor = decodeBackgroundWorkDescriptorV1(
      prepared.descriptorBytes,
    );
    fulfillment = await fulfillProcessorBackgroundAuthorizationRequest({
      crypto: saga.crypto,
      request: {
        formatVersion: 1,
        descriptorBytes: prepared.descriptorBytes,
        descriptorHash: prepared.descriptorHash,
      },
      resolveCurrentAuthority: () => Promise.resolve(saga.authority),
    });
    clock += 1;
    expect(await initialCoordinator.acceptDeviceResponse({
      requestId,
      responseBytes: fulfillment.responseBytes,
      signerAuthorizationBytes: fulfillment.signerAuthorizationBytes,
    })).toEqual({ status: "accepted" });
    let crash: unknown;
    try {
      await initialCoordinator.run(requestId);
    } catch (error) {
      crash = error;
    }
    expect(crash).toBeInstanceOf(Error);
    expect((crash as Error).message).toBe(
      "injected post-crypto pre-product restart",
    );
    expect(modelCalls).toBe(1);
    expect(credentialClaims).toBe(1);
    const interruptedPublication =
      await publicationRepository.get(requestId);
    expect(interruptedPublication?.state).toBe("reserved");
    if (
      interruptedPublication === null
      || interruptedPublication.leaseExpiresAt === null
    ) {
      throw new Error("M241 saga did not preserve its publication lease");
    }
    expect((await appClient.unsafe<{ count: string }[]>(
      `SELECT count(*)::text AS count
         FROM room_events
        WHERE room_id = $1`,
      [product.roomId],
    ))[0]?.count).toBe("0");
    const commitMarker = await cryptoClient.unsafe<{
      transform_commit_claim_id: string | null;
      transform_commit_output_count: number | null;
    }[]>(
      `SELECT transform_commit_claim_id, transform_commit_output_count
         FROM background_crypto_authorization_requests
        WHERE request_id = $1`,
      [requestId],
    );
    expect(commitMarker[0]).toEqual({
      transform_commit_claim_id: `claim-${requestId}`,
      transform_commit_output_count: 1,
    });
    const interrupted = await backgroundRepository.get(requestId);
    if (
      interrupted === null
      || interrupted.snapshot.claimExpiresAt === null
    ) {
      throw new Error("M241 saga did not preserve its running claim");
    }
    clock = Math.max(
      interrupted.snapshot.claimExpiresAt,
      claimed.claim.leaseExpiresAt.getTime(),
      interruptedPublication.leaseExpiresAt.getTime(),
    ) + 1;
    recipients.close();
    const restartedCryptoClient = sqlClient(cryptoUrl);
    const restartedAppClient = sqlClient(appUrl);
    const restartedRecipients = new ProcessorTransformRecipientRegistry({
      crypto: saga.crypto,
      now: () => clock,
    });
    try {
      const restartedCryptoHandle = await verifyCryptoPostgresHandle(
        cryptoConnection(restartedCryptoClient),
      );
      const restartedProductHandle =
        await verifyConversationProductPostgresHandle(
          productConnection(restartedAppClient),
        );
      const restartedBackground =
        new PostgresBackgroundAuthorizationRepository(
          restartedCryptoHandle,
        );
      const restartedPublications =
        new PostgresProtectedJournalPublicationRepository(
          restartedProductHandle,
          RECORD_COMMITMENT,
        );
      const restartedRecovery =
        new PostgresProtectedStenographerWorkRecovery(
          restartedProductHandle,
          {
            resolveCompactionModelId: () => Promise.resolve(null),
          },
        );
      const reconciliation =
        createPostgresProtectedStenographerPublicationReconciler({
          repository: restartedPublications,
          recovery: restartedRecovery,
          resolveCurrentAuthority: () =>
            Promise.resolve(currentAuthority),
          committedTransforms:
            new PostgresProcessorTransformCommitVerifier(
              restartedCryptoHandle,
              saga.crypto,
            ),
          publicationFence:
            createProtectedStenographerPublicationFence(
              restartedBackground,
            ),
          verifiedObjects:
            new PostgresProtectedJournalProcessorObjectVerifier(
              saga.crypto,
              restartedCryptoHandle,
            ),
          now: () => new Date(clock),
          leaseToken: () => randomUUID(),
        });
      let restartedExecutions = 0;
      const restartedCoordinator =
        new ProtectedStenographerBackgroundCoordinator({
          repository: restartedBackground,
          recipients: restartedRecipients,
          descriptors: descriptorFactory,
          responses: {
            verify: () =>
              Promise.reject(new Error(
                "restart must not verify another response",
              )),
          },
          transformMaterial: {
            loadAccepted: () =>
              Promise.reject(new Error(
                "restart must not reclaim a credential",
              )),
          },
          execution: createProtectedStenographerBackgroundExecutionPort({
            executeWork: () => {
              restartedExecutions += 1;
              return Promise.reject(new Error(
                "restart must not call the model",
              ));
            },
            reconciliation,
          }),
          now: () => clock,
          recipientKeyId: () => "unused-restart-recipient",
          claimId: () => "unused-restart-claim",
          nextAttemptAt: (_record, _reason, now) => now,
        });
      expect(await restartedCoordinator.run(requestId)).toEqual({
        status: "completed",
      });
      expect(await restartedCoordinator.run(requestId)).toEqual({
        status: "not_ready",
      });
      expect(restartedExecutions).toBe(0);
      expect(modelCalls).toBe(1);
      expect(credentialClaims).toBe(1);
      expect((await restartedPublications.get(requestId))?.state).toBe(
        "attached",
      );
      const attachedObjectId = descriptor.outputObjectIds[0];
      if (attachedObjectId === undefined) {
        throw new Error("M241 saga descriptor output is missing");
      }
      expect((await restartedAppClient.unsafe<{ count: string }[]>(
        `SELECT count(*)::text AS count
           FROM room_events AS event
           JOIN reflection_record_payload_representations AS representation
             ON representation.record_id = event.record_id
            AND representation.representation = 'protected'
          WHERE event.room_id = $1
            AND event.projection_kind = 'native'
            AND event.statement IS NULL
            AND event.crypto_object_id IS NULL
            AND representation.crypto_object_id = $2`,
        [product.roomId, attachedObjectId],
      ))[0]?.count).toBe("1");
    } finally {
      restartedRecipients.close();
      await Promise.all([
        restartedAppClient.end(),
        restartedCryptoClient.end(),
      ]);
    }
  });

  test.each(["raw", "drizzle"] as const)("foreground Journal and Reflection repairs attach and replay exact PostgreSQL selections (%s)", async (driver) => {
    const repairClient = sqlClient(appUrl);
    const productHandle = await verifyConversationProductPostgresHandle(
      driver === "drizzle"
        ? createPostgresJsBridgeConnection(drizzle(repairClient))
        : productConnection(repairClient),
    );
    const fixture = await createProductFixture();
    const now = new Date(START + 20_000);
    const batchId = randomUUID();
    const rollupId = randomUUID();
    const eventId = randomUUID();
    const recordId = randomUUID();
    const rollupObjectId = `foreground-rollup:${portableSuffix()}`;
    const eventObjectId = `foreground-event:${portableSuffix()}`;
    const recordObjectId = `foreground-record:${portableSuffix()}`;
    const eventStatement = "foreground event";
    const recordStatement = "foreground Reflection context";
    const eventPayload = encodeRecordPayloadV1({
      formatVersion: 1,
      posture: "derived",
      observedContentFingerprint: "foreground-event-fingerprint",
      sourceOwnedKind: null,
      observedLogicalObjectRef: null,
      observedRevision: null,
      statement: eventStatement,
      sourceDependencies: [],
      anchors: [{
        kind: "room",
        anchorRef: fixture.roomId,
        role: "context",
      }],
      childRecordIds: [],
      producer: {
        producerRef: fixture.agentId,
        policyVersion: "m311-integration",
      },
      terminalAuthorityLeafHandles: [],
    });
    const recordPayload = encodeRecordPayloadV1({
      formatVersion: 1,
      posture: "derived",
      observedContentFingerprint: "foreground-fingerprint",
      sourceOwnedKind: null,
      observedLogicalObjectRef: null,
      observedRevision: null,
      statement: recordStatement,
      sourceDependencies: [],
      anchors: [{
        kind: "room",
        anchorRef: fixture.roomId,
        role: "context",
      }],
      childRecordIds: [],
      producer: {
        producerRef: fixture.agentId,
        policyVersion: "m311-integration",
      },
      terminalAuthorityLeafHandles: [],
    });
    try {
      for (const objectIdValue of [
        rollupObjectId,
        eventObjectId,
        recordObjectId,
      ]) {
        cryptoObjectIds.add(objectIdValue);
        await cryptoClient.unsafe(
          `INSERT INTO crypto_objects (object_id, payload_hash, payload_bytes)
           VALUES ($1, $2, $3)`,
          [
            objectIdValue,
            digest(new TextEncoder().encode(objectIdValue)),
            new Uint8Array([1]),
          ],
        );
      }
      await admin.begin(async (transaction) => {
        await transaction.unsafe(
          `INSERT INTO room_journal_state (
             room_id, extractor_version, historical_backfill_status,
             rebuild_generation, created_at, updated_at
           ) VALUES ($1, 'm311-integration', 'not_needed', 1, $2, $2)`,
          [fixture.roomId, now],
        );
        await transaction.unsafe(
          `INSERT INTO room_journal_batches (
             id, room_id, from_message_id_exclusive,
             through_message_id_inclusive, extractor_version,
             observation_publication_version, lane, status, attempt_count,
             operation_count, started_at, completed_at, created_at
           ) VALUES (
             $1, $2, 0, 2, 'm311-integration', 1, 'live', 'completed', 1,
             1, $3, $3, $3
           )`,
          [batchId, fixture.roomId, now],
        );
        await transaction.unsafe(
          `INSERT INTO room_event_rollups (
             id, room_id, through_event_sequence, content,
             source_event_count, model_id, compactor_version, created_at
           ) VALUES ($1, $2, 1, 'foreground rollup', 1,
                     'm311-model', 'm311-integration', $3)`,
          [rollupId, fixture.roomId, now],
        );
        await transaction.unsafe(
          `INSERT INTO reflection_records (
             record_id, lifecycle, structural_height,
             producer_policy_version, processing_generation
           ) VALUES
             ($1, 'current', 0, 'm311-integration', 1),
             ($2, 'current', 0, 'm311-integration', 1)`,
          [eventId, recordId],
        );
        await transaction.unsafe(
          `INSERT INTO reflection_record_payload_representations (
             record_id, representation, representation_generation,
             plaintext_payload_bytes
           ) VALUES
             ($1, 'ordinary', 1, $2),
             ($3, 'ordinary', 1, $4)`,
          [eventId, eventPayload, recordId, recordPayload],
        );
        await transaction.unsafe(
          `INSERT INTO reflection_record_payload_representation_heads (
             record_id, representation, current_representation_generation
           ) VALUES
             ($1, 'ordinary', 1),
             ($2, 'ordinary', 1)`,
          [eventId, recordId],
        );
        await transaction.unsafe(
          `INSERT INTO reflection_record_publications (
             publication_id, record_id, representation,
             representation_generation, request_commitment,
             publication_binding_ref, state, product_attached_at,
             completed_at, created_at, updated_at
           ) VALUES
             ($1, $2, 'ordinary', 1, $3, $4, 'complete', $5, $5, $5, $5),
             ($6, $7, 'ordinary', 1, $8, $4, 'complete', $5, $5, $5, $5)`,
          [
            `foreground-origin:${eventId}`,
            eventId,
            new Uint8Array(32).fill(0x9e),
            `journal:namespace:${fixture.namespaceId}:ordinary:v1`,
            now,
            `foreground-origin:${recordId}`,
            recordId,
            new Uint8Array(32).fill(0x9f),
          ],
        );
        await transaction.unsafe(
          `INSERT INTO reflection_record_authority_projections (
             record_id, projection_generation, source_change_generation,
             processing_state, audience_set_commitment, current
           ) VALUES
             ($1, 1, 1, 'current', $2, true),
             ($3, 1, 1, 'current', $4, true)`,
          [
            eventId,
            new Uint8Array(32).fill(0xa0),
            recordId,
            new Uint8Array(32).fill(0xa1),
          ],
        );
        await transaction.unsafe(
          `INSERT INTO reflection_record_authority_alternatives (
             record_id, projection_generation, alternative_ordinal,
             access_namespace_id, alternative_commitment
           ) VALUES
             ($1, 1, 0, $2, $3),
             ($4, 1, 0, $2, $5)`,
          [
            eventId,
            fixture.namespaceId,
            new Uint8Array(32).fill(0xa2),
            recordId,
            new Uint8Array(32).fill(0xa3),
          ],
        );
        await transaction.unsafe(
          `SELECT set_config('nautilo.stenographer_writer_version', '2', true)`,
        );
        await transaction.unsafe(
          `INSERT INTO room_events (
             id, room_id, sequence, kind, statement, status,
             source_message_ids, source_batch_id, batch_local_ordinal,
             extractor_version, projection_kind, record_id,
             native_attached_at, created_at
           ) VALUES (
             $1::uuid, $2, 2, 'fact', NULL, 'active',
             ARRAY[2], $3, 0, 'm311-integration', 'native', ($1::uuid)::text,
             $4, $4
           )`,
          [eventId, fixture.roomId, batchId, now],
        );
      });

      const selection = await createPostgresForegroundJournalSelectionPort({
        product: productHandle,
      }).selectCurrent({
        roomId: fixture.roomId,
        namespaceId: fixture.namespaceId,
        maximumEvents: 8,
      });
      expect(selection).toMatchObject({
        roomId: fixture.roomId,
        namespaceId: fixture.namespaceId,
        rebuildGeneration: 1,
        rollup: { binding: { rollupId } },
        events: [{
          binding: { eventId },
          payload: { kind: "reflection_record", recordId: eventId },
        }],
      });
      if (selection === null) throw new Error("Journal selection missing");
      const journalSources = await loadPostgresForegroundJournalRepairSources({
        product: productHandle,
        snapshot: selection,
      });
      expect(journalSources.map((source) => source.logicalId)).toEqual([
        rollupId,
        eventId,
      ]);
      for (const source of journalSources) {
        const objectIdValue = source.kind === "rollup"
          ? rollupObjectId
          : eventObjectId;
        const attach = () => attachPostgresForegroundJournalRepair({
          product: productHandle,
          source,
          objectId: objectIdValue,
          publicationId: `foreground-journal:${source.logicalId}`,
          requestCommitment: new Uint8Array(32).fill(0xa4),
          publicationBindingRef: `foreground:journal:${source.logicalId}`,
        });
        expect(await attach()).toBe("attached");
        expect(await attach()).toBe(
          source.kind === "rollup" ? "replayed" : "attached",
        );
      }
      const currentSelection = await createPostgresForegroundJournalSelectionPort({
        product: productHandle,
      }).selectCurrent({
        roomId: fixture.roomId,
        namespaceId: fixture.namespaceId,
        maximumEvents: 8,
      });
      if (currentSelection === null) {
        throw new Error("Current Journal selection missing after attach");
      }
      const currentJournalSources =
        await loadPostgresForegroundJournalRepairSources({
          product: productHandle,
          snapshot: currentSelection,
        });
      expect(currentJournalSources.map((source) => source.existingObjectId))
        .toEqual([rollupObjectId, eventObjectId]);
      for (const source of currentJournalSources) {
        expect(await validatePostgresForegroundJournalRepairSource({
          product: productHandle,
          source,
          objectId: source.existingObjectId!,
        })).toBe(true);
      }

      const [recordSource] = await loadPostgresForegroundRecordRepairSources({
        product: productHandle,
        records: [{
          recordRef: recordId,
          lifecycle: "current",
          structuralHeight: 0,
          statement: recordStatement,
        }],
      });
      expect(recordSource).toMatchObject({
        recordRef: recordId,
        lifecycle: "current",
        structuralHeight: 0,
        existingObjectId: null,
        accessNamespaceIds: [fixture.namespaceId],
        ordinaryRepresentationGeneration: 1,
        representationGeneration: 1,
        authorityProjectionGeneration: 1,
      });
      const attachRecord = () => attachPostgresForegroundRecordRepair({
        product: productHandle,
        source: recordSource!,
        objectId: recordObjectId,
        publicationId: `foreground-record:${recordId}`,
        requestCommitment: new Uint8Array(32).fill(0xa5),
        publicationBindingRef:
          `foreground:record-authority:${recordId}:1:protected:v1`,
      });
      expect(await attachRecord()).toBe("attached");
      expect(await attachRecord()).toBe("attached");
      const [currentRecordSource] =
        await loadPostgresForegroundRecordRepairSources({
        product: productHandle,
        records: [{
          recordRef: recordId,
          lifecycle: "current",
          structuralHeight: 0,
          statement: recordStatement,
        }],
      });
      expect(currentRecordSource).toMatchObject({
        existingObjectId: recordObjectId,
      });
      expect(await validatePostgresForegroundRecordRepairSource({
        product: productHandle,
        source: currentRecordSource!,
        objectId: recordObjectId,
      })).toBe(true);

      const protectedSelection =
        await createPostgresForegroundJournalSelectionPort({
          product: productHandle,
        }).selectCurrent({
          roomId: fixture.roomId,
          namespaceId: fixture.namespaceId,
          maximumEvents: 8,
        });
      if (protectedSelection === null) {
        throw new Error("Protected Journal selection missing");
      }
      const protectedJournalSources =
        await loadPostgresForegroundJournalRepairSources({
          product: productHandle,
          snapshot: protectedSelection,
          representationMode: "protected-only",
        });
      expect(protectedJournalSources.map((source) => ({
        objectId: source.existingObjectId,
        plaintextBytes: source.plaintextBytes,
        ordinaryText: source.ordinaryText,
      }))).toEqual([
        { objectId: rollupObjectId, plaintextBytes: null, ordinaryText: null },
        { objectId: eventObjectId, plaintextBytes: null, ordinaryText: null },
      ]);
      const [protectedRecordSource] =
        await loadPostgresForegroundRecordRepairSources({
          product: productHandle,
          records: [{
            recordRef: recordId,
            lifecycle: "current",
            structuralHeight: 0,
          }],
          representationMode: "protected-only",
        });
      expect(protectedRecordSource).toMatchObject({
        recordRef: recordId,
        representationMode: "protected-only",
        existingObjectId: recordObjectId,
        expectedStatement: null,
        plaintextBytes: null,
      });

      await admin.unsafe(
        `UPDATE room_event_rollups SET content = 'changed after open' WHERE id = $1`,
        [rollupId],
      );
      expect(await validatePostgresForegroundJournalRepairSource({
        product: productHandle,
        source: currentJournalSources[0]!,
        objectId: rollupObjectId,
      })).toBe(false);
      await admin.unsafe(
        `UPDATE reflection_records
            SET lifecycle = 'stale',
                processing_generation = processing_generation + 1
          WHERE record_id = $1`,
        [recordId],
      );
      expect(await validatePostgresForegroundRecordRepairSource({
        product: productHandle,
        source: currentRecordSource!,
        objectId: recordObjectId,
      })).toBe(false);
    } finally {
      eventPayload.fill(0);
      recordPayload.fill(0);
      // Native Record generations and publication receipts are immutable.
      // This suite's disposable PostgreSQL container owns their teardown.
      productFixtures.delete(fixture);
      cryptoObjectIds.delete(rollupObjectId);
      cryptoObjectIds.delete(eventObjectId);
      cryptoObjectIds.delete(recordObjectId);
      await repairClient.end();
    }
  });

  test("exact publication attaches once, conflict quarantines, and rebuild cleanup is bounded", async () => {
    const fixture = await createProductFixture();
    const now = new Date(START + 10_000);
    const objectId = `journal/event/m241-${portableSuffix()}/slot-000`;
    cryptoObjectIds.add(objectId);
    await cryptoClient.unsafe(
      `INSERT INTO crypto_objects (object_id, payload_hash, payload_bytes)
       VALUES ($1, $2, $3)`,
      [objectId, digest(new Uint8Array([1])), new Uint8Array([1])],
    );

    const firstBatch = randomUUID();
    const firstSourceLease = randomUUID();
    await insertJournalClaim(fixture, {
      batchId: firstBatch,
      sourceLease: firstSourceLease,
      now,
      from: 0,
      through: 1,
    });
    const cutoverBefore = await appClient.unsafe<{
      first_native_record_id: string;
    }[]>(
      `SELECT first_native_record_id
         FROM room_journal_record_cutover
        WHERE singleton_key = 1`,
    );
    const firstEventId = randomUUID();
    const first = await publishReceipt({
      suffix: portableSuffix(),
      plan: extractionPlan({
        fixture,
        batchId: firstBatch,
        eventId: firstEventId,
        objectId,
        sequence: 1,
        createdAt: now,
      }),
      sourceLease: firstSourceLease,
      now,
    });
    expect(first.attachmentStatus).toBe("attached");
    const mapped = await appClient.unsafe<{
      id: string;
      record_id: string;
      projection_kind: string;
      statement: null;
      crypto_object_id: null;
      record_crypto_object_id: string;
    }[]>(
      `SELECT event.id::text AS id, event.record_id,
              event.projection_kind, event.statement,
              event.crypto_object_id,
              representation.crypto_object_id AS record_crypto_object_id
         FROM room_events AS event
         JOIN reflection_record_payload_representations AS representation
           ON representation.record_id = event.record_id
          AND representation.representation = 'protected'
        WHERE event.room_id = $1`,
      [fixture.roomId],
    );
    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toEqual({
      id: firstEventId,
      record_id: firstEventId,
      projection_kind: "native",
      statement: null,
      crypto_object_id: null,
      record_crypto_object_id: objectId,
    });
    const cutoverAfter = await appClient.unsafe<{
      first_native_record_id: string;
    }[]>(
      `SELECT first_native_record_id
         FROM room_journal_record_cutover
        WHERE singleton_key = 1`,
    );
    expect(cutoverAfter).toHaveLength(1);
    expect(cutoverAfter[0]?.first_native_record_id).toBe(
      cutoverBefore[0]?.first_native_record_id ?? firstEventId,
    );

    const secondNow = new Date(now.getTime() + 10_000);
    const secondBatch = randomUUID();
    const secondSourceLease = randomUUID();
    await insertJournalClaim(fixture, {
      batchId: secondBatch,
      sourceLease: secondSourceLease,
      now: secondNow,
      from: 1,
      through: 2,
    });
    const second = await publishReceipt({
      suffix: portableSuffix(),
      plan: extractionPlan({
        fixture,
        batchId: secondBatch,
        eventId: randomUUID(),
        objectId,
        sequence: 2,
        createdAt: secondNow,
      }),
      sourceLease: secondSourceLease,
      now: secondNow,
    });
    expect(second.attachmentStatus).toBe("quarantined");
    expect((await publicationRepository.get(second.publicationId)))
      .toMatchObject({
        state: "quarantined",
        failureCode: "mapping_conflict",
      });
    expect((await appClient.unsafe<{ count: string }[]>(
      `SELECT count(*)::text AS count
         FROM room_events
        WHERE room_id = $1`,
      [fixture.roomId],
    ))[0]?.count).toBe("1");

    const rebuildAt = new Date(secondNow.getTime() + 10_000);
    await appClient.unsafe(
      `UPDATE room_journal_state
          SET rebuild_generation = 2,
              rebuild_requested_at = $2,
              rebuild_target_message_id = 2,
              lease_token = NULL,
              lease_expires_at = NULL,
              updated_at = $2
        WHERE room_id = $1`,
      [fixture.roomId, rebuildAt],
    );
    const pending = await rebuildRepository.prepare({
      roomId: fixture.roomId,
      rebuildGeneration: 2,
      now: rebuildAt,
    });
    expect(pending.status).toBe("cleanup_pending");
    if (pending.status !== "cleanup_pending") {
      throw new Error("expected bounded tombstone work");
    }
    expect([...pending.publicationIdsNeedingTombstone].sort()).toEqual(
      [first.publicationId, second.publicationId].sort(),
    );
    expect(pending.hasMoreInvalidationWork).toBeFalse();

    for (const [index, publicationId] of
      pending.publicationIdsNeedingTombstone.entries()) {
      const tombstoneLease = randomUUID();
      expect((await publicationRepository.claim({
        publicationId,
        leaseToken: tombstoneLease,
        now: new Date(rebuildAt.getTime() + 1 + index),
      })).status).toBe("claimed");
      expect((await publicationRepository.markTombstoned({
        publicationId,
        leaseToken: tombstoneLease,
        now: new Date(rebuildAt.getTime() + 10 + index),
      })).status).toBe("tombstoned");
    }
    expect(await rebuildRepository.prepare({
      roomId: fixture.roomId,
      rebuildGeneration: 2,
      now: new Date(rebuildAt.getTime() + 20),
    })).toEqual({ status: "ready_to_finalize" });
    expect(await rebuildRepository.finalize({
      roomId: fixture.roomId,
      rebuildGeneration: 2,
      now: new Date(rebuildAt.getTime() + 30),
    })).toEqual({
      status: "completed",
      startCursor: 0,
      targetCursor: 0,
    });
    expect((await appClient.unsafe<{ count: string }[]>(
      `SELECT count(*)::text AS count
         FROM room_journal_crypto_publications
        WHERE room_id = $1`,
      [fixture.roomId],
    ))[0]?.count).toBe("0");
    expect((await appClient.unsafe<{
      lifecycle: string;
      crypto_object_id: string;
    }[]>(
      `SELECT record.lifecycle, representation.crypto_object_id
         FROM reflection_records AS record
         JOIN reflection_record_payload_representations AS representation
           ON representation.record_id = record.record_id
          AND representation.representation = 'protected'
        WHERE record.record_id = $1`,
      [firstEventId],
    ))[0]).toEqual({
      lifecycle: "sunset",
      crypto_object_id: objectId,
    });
    expect((await appClient.unsafe<{ count: string }[]>(
      `SELECT count(*)::text AS count
         FROM room_events
        WHERE room_id = $1`,
      [fixture.roomId],
    ))[0]?.count).toBe("0");
    expect((await cryptoClient.unsafe<{ count: string }[]>(
      `SELECT count(*)::text AS count
         FROM crypto_objects
        WHERE object_id = $1`,
      [objectId],
    ))[0]?.count).toBe("1");

    await cleanupProductFixture(fixture);
  });
});
