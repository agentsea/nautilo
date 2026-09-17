import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, test } from "bun:test";
import type {
  PostgresJsBridgeConnection,
  PostgresJsBridgeExecutor,
  PostgresJsBridgeRow,
  PostgresJsBridgeScalar,
} from "@nautilo/db";
import { createPostgresJsCanonicalBridgeConnection } from "@nautilo/db";
import {
  cryptoDomainProviderHeads,
  cryptoDomains,
  cryptoObjects,
  encryptionTransitionPolicy,
  namespaceDomainKeyBindings,
  namespaceDomainKeyHeads,
  objectCryptoAccessHeads,
  objectCryptoAccessManifests,
  objectCryptoNamespaceEnvelopes,
  sessionMessages,
  sessionMessageCryptoRevisions,
  roomMembers,
  rooms,
  actors,
  users,
  sessions,
  conversationSharedAgentShadowInvocations,
  conversationSharedAgentShadowExecutions,
  conversationSharedAgentShadowExecutionInputs,
  conversationSharedAgentShadowOperations,
  roomEventRollups,
  roomJournalState,
  reflectionRecords,
  reflectionRecordPayloadRepresentations,
  reflectionRecordPayloadRepresentationHeads,
  reflectionRecordPublications,
  reflectionRecordAuthorityProjections,
  reflectionRecordAuthorityAlternatives,
} from "@nautilo/db";
import {
  accessRevision,
  agentId as cryptoAgentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  DeviceProviderStateVault,
  deriveAgentRuntimeObjectSignerPublic,
  domainNamespaceGenerationHeadDigest,
  domainNamespaceRetainedAuthoritySetDigest,
  encodeHumanDeviceGroupHead,
  encryptedObjectWriteRecord,
  generateDomainKey,
  humanId,
  humanAiReadableLiveShadowExecutionInputSetDigest,
  HumanDeviceOpenMlsGroup,
  LATTICE_LIMITS,
  LatticeCrypto,
  namespaceGeneration,
  namespaceId,
  objectId,
  persistPreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesis,
  prepareDeviceWrappedLiveShadowAgentObjectAccessManifestGenesis,
  prepareDomainKeyAccessRequest,
  prepareDomainKeyAcknowledgement,
  prepareDomainKeyHead,
  prepareDomainKeyRecipientAuthorization,
  prepareDomainKeyRecipientEnvelope,
  prepareDomainNamespaceBundle,
  unixTimestamp,
  wrapObjectDekForNamespace,
} from "@nautilo/lattice-crypto";
import {
  decodeHumanAiReadableLiveShadowMessagePlanV1,
  decodeLiveShadowMessagePlanV4,
  destroyDomainKeyAccessRequestV2,
  destroyDomainKeyHeadV2,
  destroyDomainKeyRecipientAuthorizationV2,
  destroyDomainKeyRecipientEnvelopeV2,
  encodeEncryptedPayloadV2,
  encodeLiveShadowMessagePlanV4,
  encodeNamespaceObjectEnvelopeV2,
  parseDomainForegroundAuthorizationPlanV2,
  decodeHumanAiReadableLiveShadowMessagePlanV2,
} from "@nautilo/lattice-crypto/wire";
import {
  createPostgresDomainKeyV2LiveShadowCurrentAuthority,
  createPostgresConversationCryptoCompletion,
  bindConversationProductCanonicalTransactionRunner,
  PostgresConversationProductStore,
  LiveShadowRecipientRegistry,
  PostgresDomainKeyAuthorityRepository,
  PostgresHumanDeviceGroupRepository,
  PostgresHumanPeerLiveShadowPlanner,
  PostgresLiveShadowTurnPlanner,
  PostgresLatticeStorage,
  PostgresNamespaceProductAuthority,
  PostgresSharedAgentLiveShadowPlanner,
  createPostgresForegroundAgentSignerResolver,
  restorePostgresForegroundJournalOrdinary,
  restorePostgresForegroundRecordOrdinary,
  verifyCryptoPostgresHandle,
} from "@nautilo/lattice-bridge/server";
import { and, eq, like, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@nautilo/db/schema";
import postgres from "postgres";
import { sharedHistoryExecution } from "../fixtures/room-history-shared-execution.ts";
import { destroyProtectedInvocationRecipient, encodeMessagePayloadV2,
  conversationExistingRepresentationRepairIdentityDigest,
  createDormantConversationShadowRepository } from "@nautilo/lattice-bridge";
import { createForegroundExistingMessageWriteAuthorization } from
  "../../src/server/message/foreground-message-history-repair.ts";
import { prepareForegroundRuntimeExistingMessageCryptoRevision } from
  "../../src/message/agent-conversation-crypto.ts";
import { readPreparedConversationCryptoRevisionSnapshot } from
  "../../src/message/conversation-prepared-revision.ts";
import { verifyConversationProductPostgresHandle } from
  "../../src/server/message/postgres-conversation-product-store.ts";
import {
  createCurrentDomainKeyRoomHistoryAuthorityResolver,
  createPostgresRoomHistoryShadowProjection,
} from "../../src/server/message/postgres-room-history-shadow-projection.ts";

type SqlClient = postgres.Sql;
type SqlExecutor = Pick<SqlClient, "unsafe">;

const adminUrl = requiredEnvironment("LATTICE_BRIDGE_TEST_ADMIN_DATABASE_URL");
const productUrl = requiredEnvironment("LATTICE_BRIDGE_TEST_APP_DATABASE_URL");
const cryptoUrl = requiredEnvironment("LATTICE_BRIDGE_TEST_DATABASE_URL");

const admin = postgres(adminUrl, { max: 1, prepare: false });
const adminCleanup = postgres(adminUrl, { max: 1, prepare: false });
const product = postgres(productUrl, { max: 2, prepare: false });
const restricted = postgres(cryptoUrl, { max: 2, prepare: false });
const agentProduct = postgres(requiredEnvironment("LATTICE_BRIDGE_TEST_AGENT_DATABASE_URL"), { max: 1, prepare: false });
const adminCleanupDatabase = drizzle(adminCleanup);
const adminDatabase = drizzle(admin);

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required for the Postgres integration suite`);
  }
  return value;
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
    ): Promise<readonly Row[]> =>
      detachRows<Row>(await client.unsafe(
        statement,
        parameters.map((value) =>
          value instanceof Date ? value.toISOString() : value
        ) as unknown as postgres.ParameterOrJSON<never>[],
      )),
  });
}

function connection(client: SqlClient, context?: { userId: string; agentId: string }): PostgresJsBridgeConnection {
  const transact = <Result>(
    callback: (transaction: PostgresJsBridgeExecutor) => Promise<Result>,
    options?: Readonly<{ isolationLevel: "serializable" | "read committed" }>,
  ): Promise<Result> => {
    const run = async (transaction: SqlExecutor) => {
      if (context !== undefined) await transaction.unsafe(
        `SELECT set_config('app.current_user_id', $1, true), set_config('app.current_agent_id', $2, true)`,
        [context.userId, context.agentId],
      );
      return callback(executor(transaction));
    };
    return options === undefined
      ? client.begin(run) as unknown as Promise<Result>
      : client.begin(
        `isolation level ${options.isolationLevel}`,
        run,
      ) as unknown as Promise<Result>;
  };
  return Object.freeze({
    ...executor(client),
    transaction: transact,
    transactionOnce: transact,
  });
}

function digest(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

async function expectM315CapacityConstraints(): Promise<void> {
  const rows = await admin.unsafe<{
    constraint_name: string;
    definition: string;
  }[]>(
    `SELECT
       c.conname AS constraint_name,
       pg_catalog.pg_get_constraintdef(c.oid, true) AS definition
     FROM pg_catalog.pg_constraint c
     WHERE c.conname IN (
       'conversation_shadow_turn_operations_digest_shape',
       'agent_crypto_runtime_challenges_ordinal_range',
       'agent_crypto_runtime_domain_envelopes_ordinal_range',
       'background_crypto_authorization_requests_response_coherent',
       'crypto_grants_bytes_size'
     )`,
  );
  const definitions = new Map(
    rows.map((row) => [row.constraint_name, row.definition]),
  );
  expect([...definitions.keys()].sort()).toEqual([
    "agent_crypto_runtime_challenges_ordinal_range",
    "agent_crypto_runtime_domain_envelopes_ordinal_range",
    "background_crypto_authorization_requests_response_coherent",
    "conversation_shadow_turn_operations_digest_shape",
    "crypto_grants_bytes_size",
  ]);
  expect(definitions.get(
    "conversation_shadow_turn_operations_digest_shape",
  )).toContain("8388608");
  expect(definitions.get(
    "conversation_shadow_turn_operations_digest_shape",
  )).toContain("18874368");
  expect(definitions.get(
    "agent_crypto_runtime_challenges_ordinal_range",
  )).toContain("16383");
  expect(definitions.get(
    "agent_crypto_runtime_domain_envelopes_ordinal_range",
  )).toContain("16383");
  expect(definitions.get(
    "background_crypto_authorization_requests_response_coherent",
  )).toContain("16912384");
  expect(definitions.get("crypto_grants_bytes_size")).toContain("16777216");
}

afterAll(async () => {
  await Promise.all([
    admin.end(),
    adminCleanup.end(),
    product.end(),
    restricted.end(),
    agentProduct.end(),
  ]);
});
describe("M306 native V2 authority on disposable PostgreSQL", () => {
  test("Domain roster validation retains canonical ID and ordering guards at public scale", async () => {
    const [result] = await restricted.unsafe<Record<string, boolean>[]>(`
      SELECT
        public.crypto_participants_are_canonical(ARRAY['human:a','human:b']) AS valid,
        public.crypto_participants_are_canonical(ARRAY[]::text[]) AS empty,
        public.crypto_participants_are_canonical(ARRAY['human:a','human:a']) AS duplicate,
        public.crypto_participants_are_canonical(ARRAY['human:b','human:a']) AS unordered,
        public.crypto_participants_are_canonical(ARRAY['not portable']) AS invalid,
        public.crypto_participants_are_canonical(ARRAY[repeat('a',129)]) AS oversized_id
    `);
    expect(result).toEqual({valid: true, empty: false, duplicate: false,
      unordered: false, invalid: false, oversized_id: false});
  });

  test.each(["closed", "public"] as const)(
    "publishes current Domain and Namespace authority and plans %s foreground turns", async (topology) => {
    await expectM315CapacityConstraints();
    const crypto = new LatticeCrypto();
    const userId = randomUUID();
    const humanActorId = randomUUID();
    const agentActorId = randomUUID();
    const agentId = randomUUID();
    const namespaceValue = randomUUID();
    const roomId = randomUUID();
    const deviceId = `electron-${randomUUID()}`;
    const secondDeviceId = `browser-${randomUUID()}`;
    const agentObjectId = `m305-agent-${randomUUID()}`;
    let repairObjectId = `message:v2:existing-repair-${randomUUID()}`;
    let repairMessageId: number | null = null;
    let reverseRecordId: string | null = null;
    let reverseRollupId: string | null = null;
    let primaryFailure: unknown;
    const capacityPrefix = randomUUID();
    const capacityDomainPrefix = `m315-capacity:${capacityPrefix}:`;
    const now = Date.now();
    const signing = crypto.generateSigningKeyPair();
    const encryption = await crypto.generateEncryptionKeyPair();
    const secondSigning = crypto.generateSigningKeyPair();
    const secondEncryption = await crypto.generateEncryptionKeyPair();
    const recovery = await crypto.generateEncryptionKeyPair();
    let membershipVault: DeviceProviderStateVault | undefined;
    const [originalPolicy] = await adminCleanupDatabase.select()
      .from(encryptionTransitionPolicy)
      .where(eq(encryptionTransitionPolicy.id, "server"));
    if (originalPolicy === undefined) throw new Error("Missing test server policy");

    try {
      await admin.begin(async (tx) => {
        await tx.unsafe(
          "INSERT INTO users (id, name) VALUES ($1, 'M306 integration user')",
          [userId],
        );
        await tx.unsafe(
          `INSERT INTO agents (id, handle) VALUES ($1, $2)`,
          [agentId, `m306-${agentId}`],
        );
        await tx.unsafe(
          `INSERT INTO actors (
             id, owner_id, display_name, trust_state, kind, agent_id
           ) VALUES
             ($1, $2, 'M306 Human', 'verified', 'user', NULL),
             ($3, $2, 'M306 Agent', 'verified', 'agent', $4)`,
          [humanActorId, userId, agentActorId, agentId],
        );
        await tx.unsafe(
          `INSERT INTO namespaces (id, scope, label)
           VALUES ($1, 'room', 'M306 private Room Namespace')`,
          [namespaceValue],
        );
        await tx.unsafe(
          `INSERT INTO rooms (
             id, owner_id, type, label, graph_thread_id, namespace_id,
             human_actor_ids, kind, created_by
           ) VALUES (
             $1, $2, 'private', 'M306 private Room', $3, $4,
             ARRAY[$5::uuid], 'private', $5
           )`,
          [roomId, userId, `m306:${roomId}`, namespaceValue, humanActorId],
        );
        await tx.unsafe(
          `INSERT INTO room_members (
             room_id, actor_id, room_role, agent_response_mode
           ) VALUES
             ($1, $2, 'admin', NULL),
             ($1, $3, 'member', 'active')`,
          [roomId, humanActorId, agentActorId],
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
             human_id, user_id, human_actor_id,
             initial_installation_lineage_digest, state, ever_initialized_at,
             first_device_id, current_recovery_generation,
             current_recovery_public_key_digest, revision, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, 'active', $5, $6, 1, $7, 1, $5, $5)`,
          [humanActorId, userId, humanActorId, digest(0x41), new Date(now).toISOString(),
            deviceId, digest(0x42)],
        );
        await tx.unsafe(
          `INSERT INTO human_crypto_devices (
             device_id, human_id, user_id, human_actor_id, client_kind,
             installation_lineage_digest, device_generation,
             signing_public_key, encryption_public_key, public_fingerprint,
             state, authorization_kind, recovery_generation,
             authorization_evidence_digest, key_package_generation,
             key_package_count, revision, created_at, activated_at
           ) VALUES ($1, $2, $3, $4, 'electron', $5, 1, $6, $7, $8,
             'active', 'first_bootstrap', 1, $9, 1, 0, 1, $10, $10)`,
          [deviceId, humanActorId, userId, humanActorId, digest(0x43),
            signing.publicKey, encryption.publicKey, crypto.hash(signing.publicKey),
            digest(0x44), new Date(now).toISOString()],
        );
        await tx.unsafe(
          `INSERT INTO human_crypto_recovery_keys (
             human_id, generation, recovery_key_id, format_version,
             public_key, public_key_digest, archive_hash, issuer_device_id,
             state, activated_at, retired_at, revision
           ) VALUES ($1, 1, $2, 1, $3, $4, $5, $6,
                     'current', $7, NULL, 1)`,
          [humanActorId, `recovery-${randomUUID()}`, recovery.publicKey,
            crypto.hash(recovery.publicKey), digest(0x45), deviceId,
            new Date(now).toISOString()],
        );
      });

      const productConnection = connection(product);
      const restrictedConnection = connection(restricted);
      await admin.unsafe(
        `INSERT INTO nautilo_instance_identity (
           id, instance_id, server_instance_id, server_binding_generation
         ) VALUES ('self', 'm304-live-shadow-test', $1, 1)
         ON CONFLICT (id) DO NOTHING`,
        [randomUUID()],
      );
      const [instanceIdentity] = await admin.unsafe<{
        server_instance_id: string;
      }[]>(`
        SELECT server_instance_id::text
          FROM nautilo_instance_identity
         WHERE id = 'self'
      `);
      if (instanceIdentity === undefined) {
        throw new Error("M304 Server identity missing from integration DB");
      }
      const membershipCoordinates = Object.freeze({
        serverInstanceId: instanceIdentity.server_instance_id,
        humanId: humanId(humanActorId),
        lineageGeneration: 1,
      });
      membershipVault = DeviceProviderStateVault.fromKey(
        crypto,
        cryptoDeviceId(deviceId),
        new Uint8Array(32).fill(0x46),
      );
      const membershipGroup = new HumanDeviceOpenMlsGroup(
        crypto,
        membershipVault,
        {
          coordinates: membershipCoordinates,
          ownCredential: {
            formatVersion: 1,
            ...membershipCoordinates,
            deviceId: cryptoDeviceId(deviceId),
            installationLineageDigest: digest(0x43),
            deviceKeyGeneration: 1,
          },
        },
      );
      await membershipGroup.initialize();
      const initialMembership = await membershipGroup.createInitialState();
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
      const namespaceProduct = new PostgresNamespaceProductAuthority(
        productConnection,
      );

      const recipients = new LiveShadowRecipientRegistry(() => now);
      const input = Object.freeze({
        authority: Object.freeze({ userId, humanActorId }),
        roomId,
        clientActionSessionId: `electron-action-${randomUUID()}`,
        clientDeviceId: deviceId,
        idempotencyKey: `send-${randomUUID()}`,
        now,
      });
      const v2ServerId = "https://m301.integration.test";
      const v2Repository = new PostgresDomainKeyAuthorityRepository(
        restrictedConnection,
        crypto,
        v2ServerId,
      );
      if (topology === "public") {
        await adminCleanupDatabase.update(rooms).set({ kind: "open" }).where(eq(rooms.id, roomId));
      }
      // A fresh Human-only Room can service either recipient key class for its
      // own Namespace without obtaining cross-Room Agent grant authority.
      await adminCleanupDatabase.delete(roomMembers).where(and(
        eq(roomMembers.roomId, roomId),
        eq(roomMembers.actorId, agentActorId),
      ));
      try {
        const humanOnlyCoordinates = {
          subjectUserId: userId,
          subjectHumanId: humanActorId,
          sourceRoomId: roomId,
          namespaceId: namespaceValue,
        };
        const humanOnlyPlan = await namespaceProduct.withCurrentReadableNamespace({
          ...humanOnlyCoordinates,
          keyClass: "human",
          use: (authority) => v2Repository.planHead({
            authority,
            keyClass: "human",
            clientDeviceId: deviceId,
            now: now + 6,
          }),
        });
        expect(humanOnlyPlan?.status).toBe("create_required");
        expect(await namespaceProduct.withCurrentReadableNamespace({
          ...humanOnlyCoordinates,
          keyClass: "ai",
          use: async () => "same-room AI recipient authority",
        })).toBe("same-room AI recipient authority");
        expect(await namespaceProduct.withCurrentReadableNamespaceSet({
          subjectUserId: userId,
          subjectHumanId: humanActorId,
          sourceRoomId: roomId,
          namespaceIds: [namespaceValue],
          use: async () => "Agent grant must remain unavailable",
        })).toBeNull();
        if (topology === "public") {
          const creatorPlanner = new PostgresHumanPeerLiveShadowPlanner(
            productConnection, restrictedConnection, crypto, v2ServerId,
          );
          expect(await creatorPlanner.plan({
            authority: input.authority, roomId, clientDeviceId: deviceId,
            idempotencyKey: `public-creator:${randomUUID()}`, now: now + 6,
          })).toEqual({ status: "unavailable", authorizationScheme: "human_peer_v1",
            reason: "namespace_unavailable", requiredNamespaceIds: [namespaceValue] });
        }
        const peerUserId = randomUUID();
        const peerActorId = randomUUID();
        let peerSessionId: string = randomUUID();
        try {
          await adminCleanupDatabase.insert(users).values({ id: peerUserId, name: "Human peer fixture" });
          await adminCleanupDatabase.insert(actors).values({
            id: peerActorId, ownerId: peerUserId, displayName: "Human peer fixture", kind: "user",
          });
          await adminCleanupDatabase.insert(roomMembers).values({
            roomId, actorId: peerActorId, roomRole: "member",
          });
          await adminCleanupDatabase.update(rooms).set({
            humanActorIds: [humanActorId, peerActorId].sort(),
          }).where(eq(rooms.id, roomId));
          // A routing/default Agent hint is not an Agent member of the Room.
          const [peerSession] = await adminCleanupDatabase.insert(sessions).values({
            id: peerSessionId, roomId, ownerId: userId,
            threadId: `m306:${roomId}`, agentId, channel: "browser",
          }).onConflictDoUpdate({ target: [sessions.ownerId, sessions.threadId], set: { agentId } })
            .returning({ id: sessions.id });
          if (peerSession === undefined) throw new Error("Missing Human peer Session");
          peerSessionId = peerSession.id;
          const peerPlanner = new PostgresHumanPeerLiveShadowPlanner(
            productConnection, restrictedConnection, crypto, v2ServerId,
          );
          const peerInput = {
            authority: input.authority, roomId, clientDeviceId: deviceId,
            idempotencyKey: `peer-session-hint:${randomUUID()}`, now: now + 6,
          };
          expect(await peerPlanner.plan(peerInput)).toEqual({
            status: "unavailable", authorizationScheme: "human_peer_v1",
            reason: "namespace_unavailable", requiredNamespaceIds: [namespaceValue],
          });
          await adminCleanupDatabase.insert(roomMembers).values({
            roomId, actorId: agentActorId, roomRole: "member", agentResponseMode: "active",
          });
          expect(await peerPlanner.plan(peerInput)).toEqual({
            status: "ineligible", reason: "room_topology_unsupported",
          });
        } finally {
          await adminCleanupDatabase.delete(sessions).where(eq(sessions.id, peerSessionId));
          await adminCleanupDatabase.delete(roomMembers).where(and(
            eq(roomMembers.roomId, roomId), eq(roomMembers.actorId, peerActorId),
          ));
          await adminCleanupDatabase.update(rooms).set({
            humanActorIds: [humanActorId],
          }).where(eq(rooms.id, roomId));
          await adminCleanupDatabase.delete(actors).where(eq(actors.id, peerActorId));
          await adminCleanupDatabase.delete(users).where(eq(users.id, peerUserId));
        }
      } finally {
        await adminCleanupDatabase.insert(roomMembers).values({
          roomId,
          actorId: agentActorId,
          roomRole: "member",
          agentResponseMode: "active",
        }).onConflictDoNothing();
      }
      // The legacy exact-private fixture below remains independently qualified.
      await adminCleanupDatabase.update(rooms).set({ kind: "private" }).where(eq(rooms.id, roomId));
      const [v2Privileges] = await admin.unsafe<{
        publication_select: boolean;
        publication_insert: boolean;
        publication_update: boolean;
        head_select: boolean;
        head_insert: boolean;
      }[]>(
        `SELECT has_table_privilege(
                  'nautilo_crypto', 'domain_key_publication_operations', 'SELECT'
                ) AS publication_select,
                has_table_privilege(
                  'nautilo_crypto', 'domain_key_publication_operations', 'INSERT'
                ) AS publication_insert,
                has_table_privilege(
                  'nautilo_crypto', 'domain_key_publication_operations', 'UPDATE'
                ) AS publication_update,
                has_table_privilege(
                  'nautilo_crypto', 'domain_key_heads', 'SELECT'
                ) AS head_select,
                has_table_privilege(
                  'nautilo_crypto', 'domain_key_heads', 'INSERT'
                ) AS head_insert`,
      );
      expect(v2Privileges).toEqual({
        publication_select: true,
        publication_insert: true,
        publication_update: true,
        head_select: true,
        head_insert: true,
      });
      await restricted.unsafe(
        `SELECT operation_id
           FROM domain_key_publication_operations
          WHERE false
          FOR KEY SHARE`,
      );
      const v2HeadPlan = await namespaceProduct.withCurrentPrivateRoom({
        subjectUserId: userId,
        subjectHumanId: humanActorId,
        roomId,
        namespaceId: namespaceValue,
        use: (authority) => v2Repository.planHead({
          authority,
          keyClass: "ai",
          clientDeviceId: deviceId,
          now: now + 6,
        }),
      });
      expect(v2HeadPlan?.status).toBe("create_required");
      if (v2HeadPlan?.status !== "create_required") {
        throw new Error("M301 V2 Domain head plan missing");
      }
      const v2DomainId = v2HeadPlan.domainId;
      const [createdV2Domain] = await adminCleanupDatabase
        .select({
          rosterBytes: cryptoDomains.rosterBytes,
          participantDigest: cryptoDomains.participantDigest,
          participants: cryptoDomains.participants,
        })
        .from(cryptoDomains)
        .where(eq(cryptoDomains.id, v2DomainId))
        .limit(1);
      const createdV2Providers = await adminCleanupDatabase
        .select({ domainId: cryptoDomainProviderHeads.domainId })
        .from(cryptoDomainProviderHeads)
        .where(eq(cryptoDomainProviderHeads.domainId, v2DomainId))
        .limit(1);
      expect(createdV2Providers).toHaveLength(0);
      expect(createdV2Domain?.rosterBytes).toEqual(Uint8Array.of(2));
      expect(createdV2Domain?.participantDigest).toEqual(
        v2HeadPlan.participantDigest,
      );
      expect(createdV2Domain?.participants).toHaveLength(
        v2HeadPlan.participantCount,
      );
      const v2DomainKey = generateDomainKey(crypto);
      const v2Head = prepareDomainKeyHead(crypto, {
        serverId: v2ServerId,
        cryptoDomainId: cryptoDomainId(v2HeadPlan.domainId),
        participantDigest: v2HeadPlan.participantDigest,
        participantCount: v2HeadPlan.participantCount,
        keyClass: v2HeadPlan.keyClass,
        domainKeyGeneration: v2HeadPlan.domainKeyGeneration,
        authorizationRevision: authorizationRevision(
          v2HeadPlan.authorizationRevision,
        ),
        previousHeadDigest: v2HeadPlan.previousHeadDigest,
        publicationOperationId: `domain-head:${randomUUID()}`,
        issuerHumanId: humanId(v2HeadPlan.issuerHumanId),
        issuerDeviceId: cryptoDeviceId(v2HeadPlan.issuerDeviceId),
        issuerDeviceSigningGeneration:
          v2HeadPlan.issuerDeviceSigningGeneration,
        issuedAt: v2HeadPlan.issuedAt,
        deadlineAt: v2HeadPlan.deadlineAt,
        issuerSigningPublicKey: signing.publicKey,
        issuerSigningPrivateKey: signing.privateKey,
      });
      const v2Envelope = await prepareDomainKeyRecipientEnvelope(crypto, {
        head: v2Head.head,
        headDigest: v2Head.digest,
        recipient: {
          recipientHumanId: humanId(v2HeadPlan.issuerHumanId),
          recipientKind: "device",
          recipientKeyId: v2HeadPlan.issuerDeviceId,
          recipientKeyGeneration:
            v2HeadPlan.issuerDeviceSigningGeneration,
          recipientPublicKey: v2HeadPlan.recipientEncryptionPublicKey,
          recipientPublicKeyDigest: v2HeadPlan.recipientPublicKeyDigest,
        },
        domainKey: v2DomainKey,
        issuerHumanId: humanId(v2HeadPlan.issuerHumanId),
        issuerDeviceId: cryptoDeviceId(v2HeadPlan.issuerDeviceId),
        issuerDeviceSigningGeneration:
          v2HeadPlan.issuerDeviceSigningGeneration,
        issuerSigningPublicKey: signing.publicKey,
        issuerSigningPrivateKey: signing.privateKey,
      });
      const v2RecoveryEnvelope = await prepareDomainKeyRecipientEnvelope(
        crypto,
        {
          head: v2Head.head,
          headDigest: v2Head.digest,
          recipient: {
            recipientHumanId: humanId(v2HeadPlan.issuerHumanId),
            recipientKind: "recovery",
            recipientKeyId: v2HeadPlan.recoveryKeyId,
            recipientKeyGeneration: v2HeadPlan.recoveryKeyGeneration,
            recipientPublicKey: v2HeadPlan.recoveryPublicKey,
            recipientPublicKeyDigest: v2HeadPlan.recoveryPublicKeyDigest,
          },
          domainKey: v2DomainKey,
          issuerHumanId: humanId(v2HeadPlan.issuerHumanId),
          issuerDeviceId: cryptoDeviceId(v2HeadPlan.issuerDeviceId),
          issuerDeviceSigningGeneration:
            v2HeadPlan.issuerDeviceSigningGeneration,
          issuerSigningPublicKey: signing.publicKey,
          issuerSigningPrivateKey: signing.privateKey,
        },
      );
      const v2Authorization = prepareDomainKeyRecipientAuthorization(
        crypto,
        {
          authorizationOperationId: v2Head.head.publicationOperationId,
          reason: "head_establishment",
          requestDigest: null,
          envelopeBytes: v2Envelope.bytes,
          envelopeDigest: v2Envelope.digest,
          issuerHumanId: humanId(v2HeadPlan.issuerHumanId),
          issuerDeviceId: cryptoDeviceId(v2HeadPlan.issuerDeviceId),
          issuerDeviceSigningGeneration:
            v2HeadPlan.issuerDeviceSigningGeneration,
          issuedAt: v2HeadPlan.issuedAt,
          deadlineAt: v2HeadPlan.deadlineAt,
          issuerSigningPublicKey: signing.publicKey,
          issuerSigningPrivateKey: signing.privateKey,
        },
      );
      const v2RecoveryAuthorization =
        prepareDomainKeyRecipientAuthorization(
          crypto,
          {
            authorizationOperationId: v2Head.head.publicationOperationId,
            reason: "head_establishment",
            requestDigest: null,
            envelopeBytes: v2RecoveryEnvelope.bytes,
            envelopeDigest: v2RecoveryEnvelope.digest,
            issuerHumanId: humanId(v2HeadPlan.issuerHumanId),
            issuerDeviceId: cryptoDeviceId(v2HeadPlan.issuerDeviceId),
            issuerDeviceSigningGeneration:
              v2HeadPlan.issuerDeviceSigningGeneration,
            issuedAt: v2HeadPlan.issuedAt,
            deadlineAt: v2HeadPlan.deadlineAt,
            issuerSigningPublicKey: signing.publicKey,
            issuerSigningPrivateKey: signing.privateKey,
          },
        );
      expect((await namespaceProduct.withCurrentPrivateRoom({
        subjectUserId: userId,
        subjectHumanId: humanActorId,
        roomId,
        namespaceId: namespaceValue,
        use: (authority) => v2Repository.publishHead({
          authority,
          keyClass: "ai",
          clientDeviceId: deviceId,
          operationId: v2Head.head.publicationOperationId,
          idempotencyKey: `domain-head-request:${randomUUID()}`,
          headBytes: v2Head.bytes,
          envelopeBytes: v2Envelope.bytes,
          authorizationBytes: v2Authorization.bytes,
          recoveryEnvelopeBytes: v2RecoveryEnvelope.bytes,
          recoveryAuthorizationBytes: v2RecoveryAuthorization.bytes,
          now: now + 7,
        }),
      }))?.status).toBe("published");
      const recipientRows = await admin.unsafe<{ recipient_kind: string }[]>(
        `SELECT recipient_kind
           FROM domain_key_recipient_envelopes
          WHERE domain_id = $1 AND key_class = 'ai'
          ORDER BY recipient_kind`,
        [v2DomainId],
      );
      expect([...recipientRows]).toEqual([
        { recipient_kind: "device" },
        { recipient_kind: "recovery" },
      ]);
      const [acknowledgingDevice] = await adminDatabase.select({
        deviceGeneration: schema.humanCryptoDevices.deviceGeneration,
        revision: schema.humanCryptoDevices.revision,
      }).from(schema.humanCryptoDevices).where(eq(
        schema.humanCryptoDevices.deviceId,
        deviceId,
      )).limit(1);
      if (acknowledgingDevice === undefined) {
        throw new Error("M301 acknowledging device missing");
      }
      const acknowledgement = (acknowledgementId: string, issuedAt: number) =>
        prepareDomainKeyAcknowledgement(crypto, {
          formatVersion: 2,
          purpose: "domain_key.acknowledgement",
          acknowledgementId,
          serverId: v2ServerId,
          humanId: humanId(humanActorId),
          deviceId: cryptoDeviceId(deviceId),
          deviceSigningKeyGeneration: acknowledgingDevice.deviceGeneration,
          cryptoDomainId: cryptoDomainId(v2DomainId),
          participantDigest: v2HeadPlan.participantDigest,
          participantCount: v2HeadPlan.participantCount,
          keyClass: "ai",
          domainKeyGeneration: v2HeadPlan.domainKeyGeneration,
          authorizationRevision: authorizationRevision(
            v2HeadPlan.authorizationRevision,
          ),
          headDigest: v2Head.digest,
          recipientKeyId: deviceId,
          recipientKeyGeneration: acknowledgingDevice.deviceGeneration,
          recipientPublicKeyDigest: v2HeadPlan.recipientPublicKeyDigest,
          requestDigest: null,
          envelopeDigest: v2Envelope.digest,
          processedDeviceRevision: acknowledgingDevice.revision,
          issuedAt: unixTimestamp(issuedAt),
          expiresAt: unixTimestamp(issuedAt + 30_000),
          signingPrivateKey: signing.privateKey,
        });
      const acknowledgements = [
        acknowledgement(`domain-ack:${randomUUID()}`, now + 8),
        acknowledgement(`domain-ack:${randomUUID()}`, now + 8),
      ];
      const acknowledge = (bytes: Uint8Array) =>
        namespaceProduct.withCurrentPrivateRoom({
          subjectUserId: userId, subjectHumanId: humanActorId,
          roomId, namespaceId: namespaceValue,
          use: (authority) => v2Repository.acknowledgeEnvelope({
            authority, keyClass: "ai", clientDeviceId: deviceId,
            acknowledgementBytes: bytes, now: now + 9,
          }),
        });
      const concurrentAcknowledgements = await Promise.all(
        acknowledgements.map(({ bytes }) => acknowledge(bytes)),
      );
      expect(concurrentAcknowledgements.map((result) => result?.status).sort())
        .toEqual(["acknowledged", "replayed"]);
      expect(concurrentAcknowledgements.find((result) =>
        result?.status === "replayed")?.acknowledgementDigest)
        .toEqual(concurrentAcknowledgements.find((result) =>
          result?.status === "acknowledged")?.acknowledgementDigest);
      const winningAcknowledgement = concurrentAcknowledgements.findIndex(
        (result) => result?.status === "acknowledged",
      );
      // Scheduling can let either acknowledgement win. Conflict means changed
      // bytes under the persisted winner's ID, not the unpersisted loser's ID.
      const conflicting = acknowledgement(
        acknowledgements[winningAcknowledgement]!.value.acknowledgementId,
        now + 9,
      );
      expect(await acknowledge(conflicting.bytes)).toBeNull();
      acknowledgements.forEach(({ bytes, digest }) => {
        bytes.fill(0); digest.fill(0);
      });
      conflicting.bytes.fill(0);
      conflicting.digest.fill(0);

      const v2BundlePlan = await namespaceProduct.withCurrentPrivateRoom({
        subjectUserId: userId,
        subjectHumanId: humanActorId,
        roomId,
        namespaceId: namespaceValue,
        use: (authority) => v2Repository.planNamespaceBundle({
          authority,
          keyClass: "ai",
          clientDeviceId: deviceId,
        }),
      });
      expect(v2BundlePlan?.status).toBe("create_required");
      if (v2BundlePlan?.status !== "create_required") {
        throw new Error("M301 V2 Namespace bundle plan missing");
      }
      const v2GenerationKey = new Uint8Array(32).fill(0x51);
      const v2GenerationHead = domainNamespaceGenerationHeadDigest(crypto, {
        serverId: v2ServerId,
        namespaceId: namespaceId(v2BundlePlan.namespaceId),
        keyClass: v2BundlePlan.keyClass,
        accessRevision: accessRevision(v2BundlePlan.namespaceAccessRevision),
        generation: namespaceGeneration(0),
        previousHeadDigest: null,
        generationKey: v2GenerationKey,
      });
      const v2Retained = [Object.freeze({
        generation: namespaceGeneration(0),
        accessRevision: accessRevision(v2BundlePlan.namespaceAccessRevision),
        headDigest: v2GenerationHead,
        generationKey: v2GenerationKey,
      })];
      const v2RetainedDigest = domainNamespaceRetainedAuthoritySetDigest(
        crypto,
        v2Retained,
      );
      const v2Bundle = prepareDomainNamespaceBundle(crypto, {
        operationId: `domain-bundle:${randomUUID()}`,
        bundle: {
          formatVersion: 2,
          purpose: "domain_key.namespace_bundle",
          serverId: v2ServerId,
          cryptoDomainId: cryptoDomainId(v2BundlePlan.domainId),
          participantDigest: v2BundlePlan.participantDigest,
          participantCount: v2BundlePlan.participantCount,
          keyClass: v2BundlePlan.keyClass,
          domainKeyGeneration: v2BundlePlan.domainKeyGeneration,
          domainAuthorizationRevision: authorizationRevision(
            v2BundlePlan.domainAuthorizationRevision,
          ),
          domainHeadDigest: v2BundlePlan.domainHeadDigest,
          namespaceId: namespaceId(v2BundlePlan.namespaceId),
          namespaceAccessRevision: accessRevision(
            v2BundlePlan.namespaceAccessRevision,
          ),
          namespaceCurrentGeneration: namespaceGeneration(
            v2BundlePlan.namespaceCurrentGeneration,
          ),
          bundleRevision: v2BundlePlan.bundleRevision,
          retainedGenerationCount: v2Retained.length,
          retainedAuthoritySetDigest: v2RetainedDigest,
          retainedGenerations: v2Retained,
        },
        previousBindingDigest: v2BundlePlan.previousBindingDigest,
        issuerHumanId: humanId(v2BundlePlan.issuerHumanId),
        issuerDeviceId: cryptoDeviceId(v2BundlePlan.issuerDeviceId),
        issuerDeviceSigningGeneration:
          v2BundlePlan.issuerDeviceSigningGeneration,
        issuerSigningPrivateKey: signing.privateKey,
        issuerSigningPublicKey: signing.publicKey,
        domainKey: v2DomainKey,
        issuedAt: now + 8,
      });
      expect((await namespaceProduct.withCurrentPrivateRoom({
        subjectUserId: userId,
        subjectHumanId: humanActorId,
        roomId,
        namespaceId: namespaceValue,
        use: (authority) => v2Repository.publishNamespaceBundle({
          authority,
          keyClass: "ai",
          clientDeviceId: deviceId,
          operationId: v2Bundle.binding.operationId,
          idempotencyKey: `domain-bundle-request:${randomUUID()}`,
          bindingBytes: v2Bundle.bytes,
          now: now + 9,
        }),
      }))?.status).toBe("published");
      const v2Planner = new PostgresLiveShadowTurnPlanner(
        productConnection,
        restrictedConnection,
        crypto,
        recipients,
        {
          serverId: v2ServerId,
          resolveReadableNamespaces: async () => [namespaceValue],
          foregroundAuthorizations: { inspectReusable: () => null },
        },
      );
      const v2ClientActionSessionId = `electron-v2-action-${randomUUID()}`;
      const v2Turn = await v2Planner.plan({
        ...input,
        clientActionSessionId: v2ClientActionSessionId,
        idempotencyKey: `send-domain-v2-${randomUUID()}`,
        now: now + 9,
      });
      expect(v2Turn.status).toBe("planned");
      if (v2Turn.status !== "planned") {
        throw new Error("M301 V2 live Shadow turn plan missing");
      }
      const v2TurnPlan = decodeLiveShadowMessagePlanV4(v2Turn.planBytes);
      expect(v2TurnPlan.grantDomainId).toBe(v2DomainId);
      // M305 A1/A2/A3 regression: the exact retained-set commitment emitted
      // by a clean native V2 Electron-first bootstrap is also the authority
      // coordinate consumed by Browser/Desktop Agent-output keyring opening.
      expect(v2TurnPlan.namespaceHeadDigest).toEqual(v2RetainedDigest);
      expect(v2TurnPlan.namespacePublicationDigest).toEqual(v2RetainedDigest);
      expect(v2TurnPlan.namespacePublicationSetDigest).toEqual(
        v2RetainedDigest,
      );
      expect(v2TurnPlan.namespaceAudienceFingerprint).toEqual(
        v2RetainedDigest,
      );
      const agentRuntime = Object.freeze({
        agentId: cryptoAgentId(agentId),
        keyClass: "runtime" as const,
        generation: agentRuntimeGeneration(1),
        key: new Uint8Array(32).fill(0x71),
      });
      const agentSigner = deriveAgentRuntimeObjectSignerPublic(
        crypto,
        agentRuntime,
      );
      const agentPayloadBytes = encodeEncryptedPayloadV2({
        formatVersion: 2,
        context: {
          objectId: objectId(agentObjectId),
          keyClass: "ai",
          objectType: "nautilo-message-v2",
          createdAt: unixTimestamp(now + 9),
        },
        ciphertext: new Uint8Array(64).fill(0x72),
      });
      const agentEnvelopeBytes = encodeNamespaceObjectEnvelopeV2(
        wrapObjectDekForNamespace(
          crypto,
          v2GenerationKey,
          {
            objectId: objectId(agentObjectId),
            namespaceId: namespaceId(namespaceValue),
            keyClass: "ai",
            keyGeneration: namespaceGeneration(0),
            bindingRevisionAtWrap: accessRevision(
              v2BundlePlan.namespaceAccessRevision,
            ),
          },
          new Uint8Array(32).fill(0x73),
        ),
      );
      const agentPrepared =
        prepareDeviceWrappedLiveShadowAgentObjectAccessManifestGenesis(
          crypto,
          {
            objectId: agentObjectId,
            payloadHash: crypto.hash(agentPayloadBytes),
            envelopeBytes: [agentEnvelopeBytes],
            operationId: `m305-agent-operation-${randomUUID()}`,
            grant: {
              grantId: `m305-agent-grant-${randomUUID()}`,
              grantHash: digest(0x74),
              recipientKeyId: `m305-agent-recipient-${randomUUID()}`,
            },
            namespace: {
              namespaceId: namespaceValue,
              accessRevision: v2BundlePlan.namespaceAccessRevision,
              keyGeneration: 0,
              headDigest: v2RetainedDigest,
              publicationDigest: v2RetainedDigest,
              publicationSetDigest: v2RetainedDigest,
              audienceFingerprint: v2RetainedDigest,
            },
            agentAuthorizationRevision: 1,
            runtime: agentRuntime,
            signerKeyId: agentSigner.principal.signerKeyId,
            signerPublicKey: agentSigner.publicKey,
          },
        );
      const agentStorage = new PostgresLatticeStorage(
        await verifyCryptoPostgresHandle(restrictedConnection),
      );
      await agentStorage.putObject(
        encryptedObjectWriteRecord(agentPayloadBytes),
      );
      const resolveAgentWrite = (context: typeof agentPrepared.authority) =>
        Object.freeze({
          context,
          grantAuthorized: true as const,
          namespaceAuthorized: true as const,
          agentAuthorized: true as const,
          hostAllowsOperation: true as const,
          currentRuntime: Object.freeze({
            agentId: agentRuntime.agentId,
            authorizationRevision: authorizationRevision(1),
            runtimeGeneration: agentRuntime.generation,
          }),
          signerPublicKey: agentSigner.publicKey.slice(),
        });
      // Foreground Grant/runtime admission is ephemeral; the storage CAS
      // rechecks the current native Namespace head, not legacy registry rows.
      expect(
        await persistPreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesis({
          crypto,
          storage: agentStorage,
          prepared: agentPrepared,
          resolveCurrentAuthorization: resolveAgentWrite,
        }),
      ).toBe("applied");
      expect(
        await persistPreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesis({
          crypto,
          storage: agentStorage,
          prepared: agentPrepared,
          resolveCurrentAuthorization: resolveAgentWrite,
        }),
      ).toBe("duplicate");
      agentRuntime.key.fill(0);
      agentSigner.publicKey.fill(0);
      agentPayloadBytes.fill(0);
      agentEnvelopeBytes.fill(0);
      expect(v2TurnPlan.authorization.disposition).toBe(
        "authorization_required",
      );
      if (v2TurnPlan.authorization.disposition !== "authorization_required") {
        throw new Error("M301 V2 foreground authorization plan missing");
      }
      const v2ForegroundPlan = parseDomainForegroundAuthorizationPlanV2(
        v2TurnPlan.authorization.authorizationPlanBytes,
      );
      expect(v2ForegroundPlan?.domains).toHaveLength(1);
      expect(v2ForegroundPlan?.domains[0]?.domainId).toBe(v2DomainId);
      const v2CurrentAuthority =
        await createPostgresDomainKeyV2LiveShadowCurrentAuthority({
          product: productConnection,
          restricted: restrictedConnection,
          crypto,
          serverId: v2ServerId,
          plan: v2TurnPlan,
          representationMode: "shadow_encryption",
          resolveReadableNamespaces: async () => [namespaceValue],
        });
      expect(v2CurrentAuthority).not.toBeNull();
      expect(await v2CurrentAuthority?.verifyCurrentPlan()).toBe(true);
      // The accepted signed/sealed grant and its public plan are different
      // byte contracts. Repair admission must compare the former's digest.
      const acceptedGrantDigest = digest(0xb1);
      const entityContext = {
        ...agentPrepared.authority,
        purpose: "persist-device-wrapped-live-shadow-agent-object-access-genesis-set" as const,
        operationId: v2TurnPlan.operationId,
        grantId: v2ForegroundPlan!.authorizationId,
        grantHash: acceptedGrantDigest,
        recipientKeyId: v2ForegroundPlan!.recipientKeyId,
        agentId: v2TurnPlan.recipientAgentId,
        agentAuthorizationRevision: v2TurnPlan.agentAuthorizationRevision,
        runtimeGeneration: v2TurnPlan.agentRuntimeGeneration,
        signerKeyId: v2TurnPlan.agentSignerKeyId,
        namespaces: [{
          namespaceId: namespaceValue,
          accessRevision: v2TurnPlan.namespaceAccessRevision,
          keyGeneration: v2TurnPlan.namespaceKeyGeneration,
          domainId: v2TurnPlan.grantDomainId,
          domainKeyGeneration: v2TurnPlan.grantDomainKeyGeneration,
          domainAuthorizationRevision:
            v2TurnPlan.grantDomainAuthorizationRevision,
          domainHeadDigest: v2TurnPlan.grantDomainHeadDigest,
          headDigest: v2TurnPlan.namespaceHeadDigest,
          publicationDigest: v2TurnPlan.namespacePublicationDigest,
          publicationSetDigest: v2TurnPlan.namespacePublicationSetDigest,
          audienceFingerprint: v2TurnPlan.namespaceAudienceFingerprint,
        }],
        envelopes: [agentPrepared.authority.envelope],
      };
      expect(await v2CurrentAuthority?.resolveCurrentForegroundEntityObjectWrite(
        entityContext,
      )).toBeNull();
      await admin.unsafe(
        `UPDATE conversation_shadow_turn_operations
            SET human_request_digest = $2, human_request_bytes = $3,
                grant_digest = $4, plan_bytes = $5
          WHERE operation_id = $1`,
        [v2TurnPlan.operationId, digest(0xb2), new Uint8Array([1]), acceptedGrantDigest, v2Turn.planBytes],
      );
      expect(await v2CurrentAuthority?.resolveCurrentForegroundEntityObjectWrite(
        entityContext,
      )).not.toBeNull();
      expect(await v2CurrentAuthority?.resolveCurrentForegroundEntityObjectWrite({
        ...entityContext,
        grantHash: v2TurnPlan.authorization.authorizationPlanDigest,
      })).toBeNull();
      expect(await v2CurrentAuthority?.resolveCurrentForegroundEntityObjectWrite({
        ...entityContext,
        grantHash: digest(0xb3),
      })).toBeNull();

      // Existing Message siblings are not new live-append rows. Their v3
      // publication must use the same native entity authority as other repairs.
      const recipient = recipients.take({
        operationId: v2TurnPlan.operationId,
        clientActionSessionId: v2ClientActionSessionId,
        actorId: humanActorId,
      });
      expect(recipient).not.toBeNull();
      if (recipient === null || v2CurrentAuthority === null) throw new Error("repair runtime absent");
      destroyProtectedInvocationRecipient(recipient.recipient);
      recipient.publicKey.fill(0);
      const repairRuntime = recipients.takeAgentRuntime(v2TurnPlan.operationId);
      expect(repairRuntime).not.toBeNull();
      if (repairRuntime === null) throw new Error("repair signer absent");
      const repairProductHandle = await verifyConversationProductPostgresHandle(
        connection(agentProduct, { userId, agentId }),
      );
      const repairCanonicalConnection = createPostgresJsCanonicalBridgeConnection(
        drizzle(agentProduct, { schema }),
      );
      const repairCanonical = bindConversationProductCanonicalTransactionRunner(repairProductHandle, {
        transaction: (callback, options) => repairCanonicalConnection.transaction(async (transaction, executor) => {
          await transaction.execute(sql`SELECT set_config('app.current_user_id', ${userId}, true), set_config('app.current_agent_id', ${agentId}, true)`);
          return callback(transaction, executor);
        }, options),
      });
      const recordRepairProductHandle =
        await verifyConversationProductPostgresHandle(productConnection);
      const recordRepairCanonicalConnection =
        createPostgresJsCanonicalBridgeConnection(
          drizzle(product, { schema }),
        );
      const recordRepairCanonical =
        bindConversationProductCanonicalTransactionRunner(
          recordRepairProductHandle,
          {
            transaction: (callback, options) =>
              recordRepairCanonicalConnection.transaction(
                async (transaction, executor) => {
                  await transaction.execute(sql`
                    SELECT set_config(
                      'app.current_user_id', ${userId}, true
                    ), set_config(
                      'app.current_agent_id', ${agentId}, true
                    )
                  `);
                  return callback(transaction, executor);
                },
                options,
              ),
          },
        );
      const repairProduct = new PostgresConversationProductStore(
        repairProductHandle,
        repairCanonical,
      );
      const [ordinaryMessage] = await admin.unsafe<{ id: number }[]>(
        `INSERT INTO session_messages (session_id, role, content, created_at)
         VALUES ($1, 'user', 'Synthetic existing history', $2) RETURNING id`,
        [v2TurnPlan.sessionId, new Date(now).toISOString()],
      );
      if (ordinaryMessage === undefined) throw new Error("repair source absent");
      repairMessageId = ordinaryMessage.id;
      const ordinaryPayload = { role: "user" as const, content: "Synthetic existing history" };
      const repairAllocation = await repairProduct.allocateExistingRepresentation({
        publisher: { kind: "foreground_runtime", agentId },
        sessionId: v2TurnPlan.sessionId,
        messageId: ordinaryMessage.id,
        revision: 0,
        operationId: `integration-repair:${ordinaryMessage.id}`,
        expectedNamespaceId: namespaceValue,
        expectedAuthorRole: "user",
        expectedAuthorHumanTurnId: null,
        expectedSessionAgentId: agentId,
        requestDigest: crypto.hash(encodeMessagePayloadV2(ordinaryPayload)),
        repairIdentityDigest: conversationExistingRepresentationRepairIdentityDigest({
          sessionId: v2TurnPlan.sessionId, messageId: ordinaryMessage.id, revision: 0,
          namespaceId: namespaceValue, authorRole: "user",
          authorityFingerprint: v2TurnPlan.namespacePublicationSetDigest,
          policyRevision: v2TurnPlan.policyRevision,
        }),
      });
      expect(repairAllocation.status).toBe("allocated");
      if (repairAllocation.status !== "allocated") throw new Error("repair receipt absent");
      repairObjectId = repairAllocation.lifecycle.cryptoObjectId;
      const repairAuthority = {
        namespaceId: namespaceValue,
        namespaceAccessRevision: v2TurnPlan.namespaceAccessRevision,
        namespaceKeyGeneration: v2TurnPlan.namespaceKeyGeneration,
        domainId: v2TurnPlan.grantDomainId,
        domainKeyGeneration: v2TurnPlan.grantDomainKeyGeneration,
        domainAuthorizationRevision: v2TurnPlan.grantDomainAuthorizationRevision,
        domainHeadDigest: v2TurnPlan.grantDomainHeadDigest,
        namespaceHeadDigest: v2TurnPlan.namespaceHeadDigest,
        namespacePublicationDigest: v2TurnPlan.namespacePublicationDigest,
        namespacePublicationSetDigest: v2TurnPlan.namespacePublicationSetDigest,
        namespaceAudienceFingerprint: v2TurnPlan.namespaceAudienceFingerprint,
      };
      const resolveRepairWrite = createForegroundExistingMessageWriteAuthorization({
        authority: repairAuthority,
        resolveCurrentAuthorization: v2CurrentAuthority.resolveCurrentForegroundEntityObjectWrite,
      });
      const repairDek = crypto.randomBytes(32);
      const repairPrepared = prepareForegroundRuntimeExistingMessageCryptoRevision({
        crypto,
        objectId: repairObjectId,
        payload: ordinaryPayload,
        createdAt: now,
        objectDek: repairDek,
        namespace: {
          ...entityContext.namespaces[0]!,
          aiKey: v2GenerationKey,
        },
        operationId: v2TurnPlan.operationId,
        grant: {
          grantId: entityContext.grantId,
          grantHash: acceptedGrantDigest,
          recipientKeyId: entityContext.recipientKeyId,
        },
        runtime: repairRuntime,
        signerKeyId: v2TurnPlan.agentSignerKeyId,
        signerPublicKey: v2TurnPlan.agentSignerPublicKey,
        agentAuthorizationRevision: v2TurnPlan.agentAuthorizationRevision,
        resolveCurrentAuthorization: resolveRepairWrite,
      });
      repairDek.fill(0);
      const repairSnapshot = readPreparedConversationCryptoRevisionSnapshot(repairPrepared);
      if (repairSnapshot.kind !== "agent-v3-device-wrapped-live-shadow") throw new Error("expected repair v3");
      expect(await v2CurrentAuthority.resolveCurrentAgentObjectWrite(repairSnapshot.value.access.authority)).toBeNull();
      expect(await resolveRepairWrite({
        ...repairSnapshot.value.access.authority, grantHash: digest(0xb4),
      })).toBeNull();
      expect(await createForegroundExistingMessageWriteAuthorization({
        authority: { ...repairAuthority, domainHeadDigest: digest(0xb5) },
        resolveCurrentAuthorization: v2CurrentAuthority.resolveCurrentForegroundEntityObjectWrite,
      })(repairSnapshot.value.access.authority)).toBeNull();
      const repairConversation = createDormantConversationShadowRepository({
        product: repairProduct,
        crypto: createPostgresConversationCryptoCompletion({
          handle: await verifyCryptoPostgresHandle(restrictedConnection),
          crypto,
          resolveCurrentWriteAuthorization: () => null,
          resolveHistoricalSigner: () => null,
          resolveLiveShadowAgentSigner: (principal) =>
            principal.agentId === v2TurnPlan.recipientAgentId
                && principal.runtimeGeneration === v2TurnPlan.agentRuntimeGeneration
                && principal.signerKeyId === v2TurnPlan.agentSignerKeyId
              ? v2TurnPlan.agentSignerPublicKey.slice() : null,
        }),
      });
      expect(await repairConversation.completeRevision({
        messageId: ordinaryMessage.id,
        expectedRevision: 0,
        parityStatus: "server_verified",
        prepared: repairPrepared,
        publicationPolicy: {
          expectedRevision: originalPolicy.revision + 1,
          representation: "ordinary_and_protected",
        },
        repairPublication: {
          publisherKind: "foreground_runtime",
          publisherId: v2TurnPlan.agentSignerKeyId,
          attestationDigest: crypto.hash(repairSnapshot.value.access.manifestBytes),
        },
      })).toMatchObject({ status: "mapped", cryptoObjectId: repairObjectId });
      expect((await repairProduct.getRevision(ordinaryMessage.id, 0))?.lifecycle)
        .toMatchObject({ disposition: "mapped", completion: "complete", authorRole: "user" });
      reverseRollupId = randomUUID();
      const reverseRollupCreatedAt = new Date(now + 10);
      const reverseRollupText = "Authenticated protected rollup body";
      await adminDatabase.insert(roomEventRollups).values({ id: reverseRollupId,
        roomId, throughEventSequence: 1, content: null, sourceEventCount: 1,
        modelId: "integration-model", compactorVersion: "m318-reverse-v1",
        cryptoObjectId: repairObjectId, createdAt: reverseRollupCreatedAt });
      const [reversePolicy] = await adminDatabase.select({ revision: encryptionTransitionPolicy.revision })
        .from(encryptionTransitionPolicy).where(eq(encryptionTransitionPolicy.id, "server"));
      if (reversePolicy === undefined) throw new Error("reverse policy absent");
      const reverseRollupSource = Object.freeze({
        representationMode: "ordinary-and-protected" as const,
        kind: "rollup" as const,
        logicalId: reverseRollupId,
        objectType: "room_event_rollup",
        existingObjectId: repairObjectId,
        createdAt: reverseRollupCreatedAt.getTime(),
        plaintextBytes: null,
        accessNamespaceIds: Object.freeze([namespaceValue]),
        representationGeneration: 1,
        ordinaryRepresentationGeneration: null,
        authorityProjectionGeneration: null,
        ordinaryText: null,
        selection: Object.freeze({
          kind: "rollup" as const,
          rebuildGeneration: 1,
          binding: Object.freeze({
            rollupId: reverseRollupId,
            roomId,
            namespaceId: namespaceValue,
            throughEventSequence: 1,
            sourceEventCount: 1,
            modelId: "integration-model",
            compactorVersion: "m318-reverse-v1",
            createdAt: reverseRollupCreatedAt.toISOString(),
          }),
          protectedMapping: Object.freeze({
            status: "mapped" as const,
            cryptoObjectId: repairObjectId,
          }),
        }),
      });
      const restoreRollup = (ordinaryText: string) =>
        restorePostgresForegroundJournalOrdinary({
          canonical: repairCanonical,
          source: reverseRollupSource,
          objectId: repairObjectId,
          ordinaryText,
          expectedPolicyRevision: reversePolicy.revision,
        });
      // Reverse restoration needs the current Journal generation, not just a
      // rollup row. A missing authority fixture must still fail closed.
      expect(await restoreRollup(reverseRollupText)).toBe("conflict");
      await adminDatabase.insert(roomJournalState).values({
        roomId,
        extractorVersion: "integration-journal",
        rebuildGeneration: reverseRollupSource.selection.rebuildGeneration,
        historicalBackfillStatus: "not_needed",
      });
      expect(await restoreRollup(reverseRollupText)).toBe("restored");
      expect(await restoreRollup(reverseRollupText)).toBe("replayed");
      expect(await restoreRollup("conflicting rollup body")).toBe("conflict");
      const [restoredRollup] = await adminDatabase.select({ content: roomEventRollups.content,
        createdAt: roomEventRollups.createdAt,
        throughEventSequence: roomEventRollups.throughEventSequence,
      }).from(roomEventRollups).where(eq(roomEventRollups.id, reverseRollupId));
      expect(restoredRollup).toEqual({ content: reverseRollupText,
        createdAt: reverseRollupCreatedAt, throughEventSequence: 1 });
      reverseRecordId = `m318-record-${randomUUID()}`;
      const reverseRecordBytes = new TextEncoder().encode(
        '{"payloadKind":"reflection_record","payloadVersion":1}',
      );
      await adminDatabase.transaction(async (txDb) => {
        await txDb.insert(reflectionRecords).values({ recordId: reverseRecordId!, lifecycle: "current",
          structuralHeight: 2, producerPolicyVersion: "m318-integration", processingGeneration: 1,
          createdAt: reverseRollupCreatedAt, updatedAt: reverseRollupCreatedAt });
        await txDb.insert(reflectionRecordPayloadRepresentations).values({ recordId: reverseRecordId!,
          representation: "protected", representationGeneration: 1, payloadVersion: 1,
          plaintextPayloadBytes: null, cryptoObjectId: repairObjectId, createdAt: reverseRollupCreatedAt });
        await txDb.insert(reflectionRecordPayloadRepresentationHeads).values({ recordId: reverseRecordId!,
          representation: "protected", currentRepresentationGeneration: 1, updatedAt: reverseRollupCreatedAt });
        await txDb.insert(reflectionRecordPublications).values({ publicationId: `m318-publication-${randomUUID()}`,
          recordId: reverseRecordId!, representation: "protected", representationGeneration: 1,
          payloadVersion: 1, requestCommitment: digest(0xc1), publicationBindingRef: `m318-binding-${randomUUID()}`,
          cryptoObjectId: repairObjectId, state: "complete", attemptCount: 0,
          cryptoCompletedAt: reverseRollupCreatedAt, productAttachedAt: reverseRollupCreatedAt,
          completedAt: reverseRollupCreatedAt, createdAt: reverseRollupCreatedAt, updatedAt: reverseRollupCreatedAt });
        await txDb.insert(reflectionRecordAuthorityProjections).values({ recordId: reverseRecordId!,
          projectionGeneration: 1, sourceChangeGeneration: 1, processingState: "current",
          audienceSetCommitment: digest(0xc2), current: true,
          computedAt: reverseRollupCreatedAt, updatedAt: reverseRollupCreatedAt });
        await txDb.insert(reflectionRecordAuthorityAlternatives).values({ recordId: reverseRecordId!,
          projectionGeneration: 1, alternativeOrdinal: 0, accessNamespaceId: namespaceValue,
          includesPublicBoundary: false, alternativeCommitment: digest(0xc3) });
      });
      const reverseRecordSource = Object.freeze({
        recordRef: reverseRecordId, expectedStatement: null,
        representationMode: "ordinary-and-protected" as const,
        lifecycle: "current" as const, structuralHeight: 2,
        processingGeneration: 1, existingObjectId: repairObjectId,
        accessNamespaceIds: Object.freeze([namespaceValue]),
        ordinaryRepresentationGeneration: 1, representationGeneration: 1,
        authorityProjectionGeneration: 1,
        createdAt: reverseRollupCreatedAt.getTime(), plaintextBytes: null,
      });
      const restoreRecord = (payloadBytes: Uint8Array) =>
        restorePostgresForegroundRecordOrdinary({
          canonical: recordRepairCanonical,
          source: reverseRecordSource, objectId: repairObjectId, payloadBytes,
          expectedPolicyRevision: reversePolicy.revision });
      expect(await restoreRecord(reverseRecordBytes)).toBe("restored");
      expect(await restoreRecord(reverseRecordBytes)).toBe("replayed");
      expect(await restoreRecord(new Uint8Array([9]))).toBe("conflict");
      expect(await restorePostgresForegroundRecordOrdinary({
        canonical: recordRepairCanonical,
        source: { ...reverseRecordSource, authorityProjectionGeneration: 2 },
        objectId: repairObjectId, payloadBytes: reverseRecordBytes,
        expectedPolicyRevision: reversePolicy.revision })).toBe("conflict");
      const [restoredRecord] = await adminDatabase.select({
        plaintextPayloadBytes: reflectionRecordPayloadRepresentations.plaintextPayloadBytes,
        createdAt: reflectionRecordPayloadRepresentations.createdAt,
      }).from(reflectionRecordPayloadRepresentations).where(and(
        eq(reflectionRecordPayloadRepresentations.recordId, reverseRecordId),
        eq(reflectionRecordPayloadRepresentations.representation, "ordinary"),
      ));
      expect(restoredRecord?.plaintextPayloadBytes).toEqual(reverseRecordBytes);
      expect(restoredRecord?.createdAt).toEqual(reverseRollupCreatedAt);
      const repairHistoryProduct = await verifyConversationProductPostgresHandle(productConnection);
      const repairedHistory = createPostgresRoomHistoryShadowProjection({
        product: repairHistoryProduct, crypto: agentStorage,
        resolveForegroundAgentSigner: createPostgresForegroundAgentSignerResolver({
          product: repairHistoryProduct, crypto,
        }),
        resolveAuthority: createCurrentDomainKeyRoomHistoryAuthorityResolver({
          product: productConnection,
          productAuthority: new PostgresNamespaceProductAuthority(productConnection),
          domainKeys: v2Repository,
        }),
      });
      expect(await repairedHistory({
        subjectUserId: userId, subjectHumanId: humanActorId, readerDeviceId: deviceId,
        roomId, selectedCoordinates: [{
          sessionId: v2TurnPlan.sessionId, messageId: ordinaryMessage.id,
          editRevision: 0, role: "user", logicalMessageKey: `row:${ordinaryMessage.id}`,
        }],
      })).toMatchObject({
        status: "ready", selectedCount: 1, eligibleCount: 1,
        records: [{ kind: "existing_representation",
          protectedMessage: {
            projection: { role: "user", sourceUserId: userId },
            protectedPayload: { status: "encrypted", cryptoObjectId: repairObjectId },
          },
          repair: {
            publisherSignerKeyId: v2TurnPlan.agentSignerKeyId,
            publisherSigningPublicKeyBase64url: Buffer.from(v2TurnPlan.agentSignerPublicKey).toString("base64url"),
            attestationDigestBase64url: Buffer.from(crypto.hash(repairSnapshot.value.access.manifestBytes)).toString("base64url"),
          } }],
      });
      repairRuntime.key.fill(0);
      v2CurrentAuthority?.destroy();
      expect(
        await createPostgresDomainKeyV2LiveShadowCurrentAuthority({
          product: productConnection,
          restricted: restrictedConnection,
          crypto,
          serverId: v2ServerId,
          plan: v2TurnPlan,
          representationMode: "shadow_encryption",
          resolveReadableNamespaces: async () => [namespaceValue],
          now: () => v2ForegroundPlan!.deadlineAt,
        }),
      ).toBeNull();

      const additionalCapacityDomains = LATTICE_LIMITS.agentGrantDomains - 1;
      const recipientPublicKeyDigest = crypto.hash(encryption.publicKey);
      const capacityNamespaceRows = await admin.begin(async (tx) => {
        await tx.unsafe(
          `INSERT INTO crypto_domains (
             id, participant_digest, participants, epoch,
             authorization_revision, roster_bytes, writes_paused,
             pause_operation_id
           )
           SELECT
             'm315-capacity:' || $1 || ':' || ordinal::text,
             decode(
               md5($1 || ':participant-a:' || ordinal::text)
               || md5($1 || ':participant-b:' || ordinal::text),
               'hex'
             ),
             ARRAY(
               SELECT value
                 FROM unnest(ARRAY[
                   $2::text,
                   'm315-participant:' || $1 || ':' || ordinal::text
                 ]) AS participant(value)
                ORDER BY value
             ),
             0, 0, decode('02', 'hex'), false, NULL
           FROM generate_series(1, $3::integer) AS ordinal`,
          [
            capacityPrefix,
            humanActorId,
            additionalCapacityDomains,
          ],
        );
        await tx.unsafe(
          `INSERT INTO domain_key_publication_operations (
             operation_id, idempotency_key, domain_id, key_class,
             participant_digest, participant_count, domain_key_generation,
             authorization_revision, expected_previous_head_digest,
             head_digest, head_bytes, issuer_human_id, issuer_device_id,
             issuer_device_signing_generation, state, failure_code,
             created_at, updated_at, deadline_at, activated_at, terminal_at
           )
           SELECT
             'm315-capacity-head:' || $1 || ':' || ordinal::text,
             'm315-capacity-head-request:' || $1 || ':' || ordinal::text,
             'm315-capacity:' || $1 || ':' || ordinal::text,
             'ai',
             decode(
               md5($1 || ':participant-a:' || ordinal::text)
               || md5($1 || ':participant-b:' || ordinal::text),
               'hex'
             ),
             2, 1, 1, NULL,
             decode(
               md5($1 || ':head-a:' || ordinal::text)
               || md5($1 || ':head-b:' || ordinal::text),
               'hex'
             ),
             decode('01', 'hex'), $2, $3, 1, 'active', NULL,
             $4, $4, $5, $4, NULL
           FROM generate_series(1, $6::integer) AS ordinal`,
          [
            capacityPrefix,
            humanActorId,
            deviceId,
            new Date(now).toISOString(),
            new Date(now + 60_000).toISOString(),
            additionalCapacityDomains,
          ],
        );
        await tx.unsafe(
          `INSERT INTO domain_key_heads (
             domain_id, key_class, participant_digest, participant_count,
             domain_key_generation, authorization_revision, head_digest,
             previous_head_digest, head_bytes, publication_operation_id,
             issuer_human_id, issuer_device_id,
             issuer_device_signing_generation, activated_at
           )
           SELECT
             'm315-capacity:' || $1 || ':' || ordinal::text,
             'ai',
             decode(
               md5($1 || ':participant-a:' || ordinal::text)
               || md5($1 || ':participant-b:' || ordinal::text),
               'hex'
             ),
             2, 1, 1,
             decode(
               md5($1 || ':head-a:' || ordinal::text)
               || md5($1 || ':head-b:' || ordinal::text),
               'hex'
             ),
             NULL, decode('01', 'hex'),
             'm315-capacity-head:' || $1 || ':' || ordinal::text,
             $2, $3, 1, $4
           FROM generate_series(1, $5::integer) AS ordinal`,
          [
            capacityPrefix,
            humanActorId,
            deviceId,
            new Date(now).toISOString(),
            additionalCapacityDomains,
          ],
        );
        await tx.unsafe(
          `INSERT INTO namespace_domain_key_bindings (
             operation_id, idempotency_key, namespace_id, domain_id,
             key_class, domain_key_generation,
             domain_authorization_revision, domain_head_digest,
             namespace_access_revision, namespace_current_generation,
             bundle_revision, retained_generation_count,
             retained_authority_set_digest, previous_binding_digest,
             binding_digest, plaintext_digest, ciphertext_digest,
             binding_bytes, issuer_human_id, issuer_device_id,
             issuer_device_signing_generation, state, failure_code,
             created_at, updated_at, deadline_at, activated_at, terminal_at
           )
           SELECT
             'm315-capacity-binding:' || $1 || ':' || ordinal::text,
             'm315-capacity-binding-request:' || $1 || ':' || ordinal::text,
             md5($1 || ':namespace:' || ordinal::text)::uuid,
             'm315-capacity:' || $1 || ':' || ordinal::text,
             'ai', 1, 1,
             decode(
               md5($1 || ':head-a:' || ordinal::text)
               || md5($1 || ':head-b:' || ordinal::text),
               'hex'
             ),
             1, 0, 1, 1,
             decode(
               md5($1 || ':retained-a:' || ordinal::text)
               || md5($1 || ':retained-b:' || ordinal::text),
               'hex'
             ),
             NULL,
             decode(
               md5($1 || ':binding-a:' || ordinal::text)
               || md5($1 || ':binding-b:' || ordinal::text),
               'hex'
             ),
             decode(
               md5($1 || ':plaintext-a:' || ordinal::text)
               || md5($1 || ':plaintext-b:' || ordinal::text),
               'hex'
             ),
             decode(
               md5($1 || ':ciphertext-a:' || ordinal::text)
               || md5($1 || ':ciphertext-b:' || ordinal::text),
               'hex'
             ),
             decode('01', 'hex'), $2, $3, 1, 'active', NULL,
             $4, $4, $5, $4, NULL
           FROM generate_series(1, $6::integer) AS ordinal`,
          [
            capacityPrefix,
            humanActorId,
            deviceId,
            new Date(now).toISOString(),
            new Date(now + 60_000).toISOString(),
            additionalCapacityDomains,
          ],
        );
        const namespaceRows = await tx.unsafe<{
          namespace_id: string;
        }[]>(
          `INSERT INTO namespace_domain_key_heads (
           namespace_id, key_class, domain_id, domain_key_generation,
           domain_authorization_revision, domain_head_digest,
           namespace_access_revision, namespace_current_generation,
           bundle_revision, retained_generation_count,
           retained_authority_set_digest, binding_digest,
           binding_operation_id, activated_at
         )
         SELECT
           md5($1 || ':namespace:' || ordinal::text)::uuid,
           'ai', 'm315-capacity:' || $1 || ':' || ordinal::text, 1, 1,
           decode(
             md5($1 || ':head-a:' || ordinal::text)
             || md5($1 || ':head-b:' || ordinal::text),
             'hex'
           ),
           1, 0, 1, 1,
           decode(
             md5($1 || ':retained-a:' || ordinal::text)
             || md5($1 || ':retained-b:' || ordinal::text),
             'hex'
           ),
           decode(
             md5($1 || ':binding-a:' || ordinal::text)
             || md5($1 || ':binding-b:' || ordinal::text),
             'hex'
           ),
           'm315-capacity-binding:' || $1 || ':' || ordinal::text,
           $2
         FROM generate_series(1, $3::integer) AS ordinal
         RETURNING namespace_id::text AS namespace_id`,
          [capacityPrefix, new Date(now).toISOString(), additionalCapacityDomains],
        );
        // This artificial same-transaction load changes cardinality by 16K.
        // Refresh planner statistics before the deferred validators run: stale
        // tiny-table estimates otherwise choose the nonselective active-state
        // index for every exact publication check, making fixture COMMIT quadratic.
        await tx.unsafe(`ANALYZE crypto_domains, domain_key_publication_operations,
          domain_key_heads, namespace_domain_key_bindings`);
        return namespaceRows;
      });
      await admin.unsafe(
        `INSERT INTO domain_key_recipient_envelopes (
           domain_id, key_class, domain_key_generation,
           authorization_revision, head_digest, recipient_human_id,
           recipient_kind, recipient_key_id, recipient_key_generation,
           recipient_public_key_digest, envelope_digest, envelope_bytes,
           authorization_digest, authorization_bytes, source_request_id,
           issuer_human_id, issuer_device_id,
           issuer_device_signing_generation, created_at
         )
         SELECT
           'm315-capacity:' || $1 || ':' || ordinal::text,
           'ai', 1, 1,
           decode(
             md5($1 || ':head-a:' || ordinal::text)
             || md5($1 || ':head-b:' || ordinal::text),
             'hex'
           ),
           $2, 'device', $3, 1, $4,
           decode(
             md5($1 || ':envelope-a:' || ordinal::text)
             || md5($1 || ':envelope-b:' || ordinal::text),
             'hex'
           ),
           decode('01', 'hex'),
           decode(
             md5($1 || ':authorization-a:' || ordinal::text)
             || md5($1 || ':authorization-b:' || ordinal::text),
             'hex'
           ),
           decode('01', 'hex'), NULL, $2, $3, 1, $5
         FROM generate_series(1, $6::integer) AS ordinal`,
        [
          capacityPrefix,
          humanActorId,
          deviceId,
          recipientPublicKeyDigest,
          new Date(now).toISOString(),
          additionalCapacityDomains,
        ],
      );
      recipientPublicKeyDigest.fill(0);
      const exactCapacityAuthority =
        await v2Repository.inspectForegroundAuthority({
          namespaceIds: [
            namespaceValue,
            ...capacityNamespaceRows.map((row) => row.namespace_id),
          ],
          keyClass: "ai",
          subjectHumanId: humanActorId,
          deviceId,
        });
      expect(exactCapacityAuthority.status).toBe("ready");
      if (exactCapacityAuthority.status !== "ready") {
        throw new Error("M315 exact-capacity authority inspection failed");
      }
      expect(exactCapacityAuthority.domains).toHaveLength(
        LATTICE_LIMITS.agentGrantDomains,
      );
      expect(exactCapacityAuthority.domains.some((entry) =>
        entry.domainId === v2DomainId
      )).toBeTrue();
      exactCapacityAuthority.domains.forEach((entry) => {
        entry.participantDigest.fill(0);
        entry.headDigest.fill(0);
        entry.activeNamespaceBindingSetDigest.fill(0);
      });
      const [v2TurnRow] = await admin.unsafe<{
        namespace_authority_scheme: string;
      }[]>(
        `SELECT namespace_authority_scheme
           FROM conversation_shadow_turn_operations
          WHERE operation_id = $1`,
        [v2TurnPlan.operationId],
      );
      expect(v2TurnRow?.namespace_authority_scheme).toBe("domain_key_v2");
      if (topology === "public") {
        await adminCleanupDatabase.update(rooms).set({ kind: "open" }).where(eq(rooms.id, roomId));
        expect(await namespaceProduct.withCurrentPrivateRoom({
          subjectUserId: userId, subjectHumanId: humanActorId, roomId, namespaceId: namespaceValue,
          use: async () => "legacy must stay private",
        })).toBeNull();
      }
      const v2SharedPlanner = new PostgresSharedAgentLiveShadowPlanner(
        productConnection,
        restrictedConnection,
        crypto,
        async () => [namespaceValue],
        {
          serverId: v2ServerId,
        },
      );
      const v2SharedTurn = await v2SharedPlanner.plan({
        authority: input.authority,
        roomId,
        clientDeviceId: deviceId,
        idempotencyKey: `shared-send-domain-v2-${randomUUID()}`,
        now: now + 10,
      });
      expect(v2SharedTurn.status).toBe("planned");
      if (v2SharedTurn.status !== "planned") {
        throw new Error("M301 V2 Shared-Agent plan missing");
      }
      const v2SharedPlan = decodeHumanAiReadableLiveShadowMessagePlanV1(
        v2SharedTurn.planBytes,
      );
      expect(v2SharedPlan).toMatchObject({
        roomId,
        subjectHumanId: humanActorId,
        committerDeviceId: deviceId,
        namespaceId: namespaceValue,
        namespaceKeyGeneration: 0,
      });
      const modernPlanInput = {
        requestVersion: 2 as const, authority: input.authority, roomId,
        clientDeviceId: deviceId, idempotencyKey: `modern-human-v2-${randomUUID()}`,
        now: now + 10,
      };
      const modernPlan = await v2SharedPlanner.plan(modernPlanInput);
      expect(modernPlan.status).toBe("planned");
      if (modernPlan.status !== "planned") throw new Error("Missing modern Human plan");
      expect(modernPlan.authorizationScheme).toBe("human_ai_readable_v2");
      const modernDecoded = decodeHumanAiReadableLiveShadowMessagePlanV2(modernPlan.planBytes);
      expect(modernDecoded.deadlineAt - modernDecoded.issuedAt).toBe(300_000);
      const modernReplay = await v2SharedPlanner.plan({ ...modernPlanInput, now: now + 11 });
      expect(modernReplay).toEqual(modernPlan);
      expect(await v2SharedPlanner.plan({ ...modernPlanInput, requestVersion: 1, now: now + 11 }))
        .toMatchObject({ status: "unavailable", reason: "reservation_unavailable" });
      expect(await v2SharedPlanner.plan({
        ...modernPlanInput, idempotencyKey: v2SharedPlan.clientIdempotencyKey,
      })).toMatchObject({ status: "unavailable", reason: "reservation_unavailable" });
      modernDecoded.namespaceHeadDigest.fill(0);
      modernDecoded.namespacePublicationDigest.fill(0);
      modernDecoded.namespacePublicationSetDigest.fill(0);
      modernDecoded.namespaceAudienceFingerprint.fill(0);
      modernPlan.planBytes.fill(0);
      if (modernReplay.status === "planned") modernReplay.planBytes.fill(0);
      // Exercise the production Drizzle joins and provenance fields against
      // real PostgreSQL. This pending allocation needs no plaintext or crypto
      // replacement; signed/decrypted Human and Agent/tool round trips are
      // independently covered by the hermetic history reader tests.
      await adminCleanupDatabase.insert(sessionMessages).values({
        id: v2SharedPlan.humanMessageId, sessionId: v2SharedPlan.sessionId,
        role: "user", content: "history query-shape fixture",
        fingerprint: v2SharedPlan.operationId, editRevision: 0,
        createdAt: new Date(v2SharedPlan.createdAt),
      });
      try {
        const [sharedOperation] = await admin.unsafe<{ crypto_object_id: string }[]>(
          "SELECT crypto_object_id FROM conversation_shared_agent_shadow_operations WHERE operation_id = $1",
          [v2SharedPlan.operationId],
        );
        if (sharedOperation === undefined) throw new Error("Missing shared history operation");
        await adminCleanupDatabase.insert(sessionMessageCryptoRevisions).values({
          sessionId: v2SharedPlan.sessionId, messageId: v2SharedPlan.humanMessageId,
          editRevision: 0, roomId, namespaceIdAtAllocation: namespaceValue,
          cryptoObjectId: sharedOperation.crypto_object_id, objectIdScheme: "live_shadow_v1",
          sharedAgentShadowOperationId: v2SharedPlan.operationId,
          shadowTranscriptOrdinal: v2SharedPlan.transcriptOrdinal,
          shadowReservedCreatedAt: new Date(v2SharedPlan.createdAt),
          keyClass: "ai", authorRole: "user", allocationRequestDigest: digest(0x73),
          appendIdempotencyKey: `history:${v2SharedPlan.operationId}`,
        });
        const history = createPostgresRoomHistoryShadowProjection({
          product: await verifyConversationProductPostgresHandle(productConnection),
          resolveAuthority: createCurrentDomainKeyRoomHistoryAuthorityResolver({
            product: productConnection,
            productAuthority: new PostgresNamespaceProductAuthority(productConnection),
            domainKeys: v2Repository,
          }),
          crypto: {
            getObject: () => Promise.reject(new Error("Pending history must not fetch ciphertext")),
            getObjectAccessState: () => Promise.reject(new Error("Pending history must not fetch access")),
          },
        });
        const projected = await history({
          subjectUserId: userId, subjectHumanId: humanActorId, readerDeviceId: deviceId,
          roomId, selectedCoordinates: [{
            sessionId: v2SharedPlan.sessionId, messageId: v2SharedPlan.humanMessageId,
            editRevision: 0, role: "user", logicalMessageKey: `turn:${v2SharedPlan.operationId}`,
          }],
        });
        expect(projected).toMatchObject({
          status: "ready", selectedCount: 1, eligibleCount: 1,
          records: [{ shadowOperationFamily: "shared_human",
            shadowOperationId: v2SharedPlan.operationId,
            protectedMessage: { protectedPayload: { status: "pending" } } }],
        });
        const retainedExecution = sharedHistoryExecution(crypto, {
          operationId: `history-execution:${randomUUID()}`,
          sessionId: v2TurnPlan.sessionId, roomId, namespaceId: namespaceValue,
          humanId: humanActorId, deviceId, agentId,
          createdAt: now, generation: v2SharedPlan.namespaceKeyGeneration,
          accessRevision: v2SharedPlan.namespaceAccessRevision,
          headDigest: v2SharedPlan.namespaceHeadDigest,
          publicationDigest: v2SharedPlan.namespacePublicationDigest,
          publicationSetDigest: v2SharedPlan.namespacePublicationSetDigest,
          audienceFingerprint: v2SharedPlan.namespaceAudienceFingerprint,
        });
        const retainedPlan = {
          ...retainedExecution.plan,
          policyRevision: v2SharedPlan.policyRevision,
        };
        const retainedPlanBytes = encodeLiveShadowMessagePlanV4(retainedPlan);
        const retainedPlanDigest = crypto.hash(retainedPlanBytes);
        const invocationId = `history-invocation:${randomUUID()}`;
        const secondInput = await v2SharedPlanner.plan({
          authority: input.authority, roomId, clientDeviceId: deviceId,
          idempotencyKey: `history-second-input:${randomUUID()}`, now: now + 11,
        });
        if (secondInput.status !== "planned") throw new Error("Missing second history input plan");
        const secondInputPlan = decodeHumanAiReadableLiveShadowMessagePlanV1(secondInput.planBytes);
        const retainedInputs = [v2SharedPlan, secondInputPlan].map((plan) => ({
          operationId: plan.operationId, messageId: plan.humanMessageId,
        }));
        // Input ordinals identify the exact ordered Human set independently of
        // the Agent output ordinal space, which always begins at 2.
        const inputSetDigest = humanAiReadableLiveShadowExecutionInputSetDigest(crypto, retainedInputs);
        // Invocation authorization is independently accepted Runtime evidence;
        // the execution's V4 plan may retain a different cached grant digest.
        const invocationAuthorizationDigest = digest(0x7d);
        for (const plan of [v2SharedPlan, secondInputPlan]) {
          const publishedAt = new Date(Date.now() + 1_000);
          await adminCleanupDatabase.update(conversationSharedAgentShadowOperations).set({
            state: "human_verified", humanRequestBytes: new Uint8Array([1]),
            humanRequestDigest: crypto.hash(new Uint8Array([1])),
            humanVerifiedAt: publishedAt,
            updatedAt: publishedAt,
          }).where(eq(conversationSharedAgentShadowOperations.operationId, plan.operationId));
          await adminCleanupDatabase.update(conversationSharedAgentShadowOperations).set({
            state: "published", protectedMessageDigest: digest(0x76),
            finalEventDigest: digest(0x77), terminalAt: publishedAt,
          }).where(eq(conversationSharedAgentShadowOperations.operationId, plan.operationId));
        }
        const retainedCommon = {
          policyRevision: v2SharedPlan.policyRevision, sessionId: v2TurnPlan.sessionId,
          roomId, invokingHumanId: humanActorId, invokingDeviceId: deviceId,
          authorizationDeviceId: deviceId, clientActionSessionId: "history-action",
          inputCount: retainedInputs.length, inputSetDigest, state: "authorized" as const,
          authorizedAt: new Date(now), createdAt: new Date(now), updatedAt: new Date(now),
          deadlineAt: new Date(now + 30_000),
        };
        try {
          await adminCleanupDatabase.insert(conversationSharedAgentShadowInvocations).values({
            ...retainedCommon, invocationId, authorizationDisposition: "reuse",
            authorizationDigest: invocationAuthorizationDigest,
            authorizationSessionReference: "history-foreground-session",
          });
          await adminCleanupDatabase.insert(conversationSharedAgentShadowExecutions).values({
            ...retainedCommon, invocationId, executionId: retainedPlan.operationId,
            agentId, planBytes: retainedPlanBytes,
            planDigest: retainedPlanDigest, agentRuntimeGeneration: retainedExecution.runtime.generation,
            agentSignerKeyId: retainedPlan.agentSignerKeyId,
            agentSignerPublicKey: retainedPlan.agentSignerPublicKey,
          });
          const retainedSigner = createPostgresForegroundAgentSignerResolver({
            product: repairHistoryProduct,
            crypto,
          });
          const resolvedRetainedSigner = await retainedSigner({
            agentId: retainedPlan.recipientAgentId,
            runtimeGeneration: retainedPlan.agentRuntimeGeneration,
            signerKeyId: retainedPlan.agentSignerKeyId,
          });
          expect(resolvedRetainedSigner).toEqual(
            retainedPlan.agentSignerPublicKey,
          );
          resolvedRetainedSigner?.fill(0);
          await adminCleanupDatabase.insert(conversationSharedAgentShadowExecutionInputs).values(
            retainedInputs.map((entry, index) => ({
              executionId: retainedExecution.plan.operationId, inputOrdinal: index + 1,
              humanOperationId: entry.operationId, messageId: entry.messageId,
            })),
          );
          const selected = [];
          for (const [index, role] of (["assistant", "tool"] as const).entries()) {
            const [message] = await adminCleanupDatabase.insert(sessionMessages).values({
              sessionId: v2TurnPlan.sessionId, role, content: "shared output fixture",
              ...(role === "assistant" ? { toolCalls: JSON.stringify([{
                id: "history-tool", name: "lookup", args: {},
              }]) } : { toolName: "lookup" }),
            }).returning({ id: sessionMessages.id });
            if (message === undefined) throw new Error("Missing history output fixture");
            selected.push({ sessionId: v2TurnPlan.sessionId, messageId: message.id,
              editRevision: 0, role, logicalMessageKey: `row:${message.id}` });
            await adminCleanupDatabase.insert(sessionMessageCryptoRevisions).values({
              sessionId: v2TurnPlan.sessionId, messageId: message.id, editRevision: 0,
              roomId, namespaceIdAtAllocation: namespaceValue,
              cryptoObjectId: `history-output:${message.id}`, objectIdScheme: "live_shadow_v1",
              sharedAgentShadowExecutionId: retainedExecution.plan.operationId,
              shadowTranscriptOrdinal: index + 2, shadowReservedCreatedAt: new Date(now),
              keyClass: "ai", authorRole: role, allocationRequestDigest: digest(0x75),
              appendIdempotencyKey: `history-output:${message.id}`,
            });
          }
          expect(await history({
            subjectUserId: userId, subjectHumanId: humanActorId, readerDeviceId: deviceId,
            roomId, selectedCoordinates: selected,
          })).toMatchObject({
            status: "ready", selectedCount: 2, eligibleCount: 2,
            records: [
              { shadowOperationFamily: "shared_execution", protectedMessage: { projection: { role: "assistant", authorAgentId: agentId } } },
              { shadowOperationFamily: "shared_execution", protectedMessage: { projection: { role: "tool", authorAgentId: agentId } } },
            ],
            signerEvidence: [{ kind: "shared_agent_execution_plan_v4", operationId: retainedExecution.plan.operationId }],
          });
        } finally {
          const outputRows = await adminCleanupDatabase.delete(sessionMessageCryptoRevisions)
            .where(eq(sessionMessageCryptoRevisions.sharedAgentShadowExecutionId, retainedExecution.plan.operationId))
            .returning({ messageId: sessionMessageCryptoRevisions.messageId });
          for (const row of outputRows) await adminCleanupDatabase.delete(sessionMessages)
            .where(eq(sessionMessages.id, row.messageId));
          await adminCleanupDatabase.delete(conversationSharedAgentShadowInvocations)
            .where(eq(conversationSharedAgentShadowInvocations.invocationId, invocationId));
        }
      } finally {
        await adminCleanupDatabase.delete(sessionMessageCryptoRevisions)
          .where(eq(sessionMessageCryptoRevisions.sharedAgentShadowOperationId, v2SharedPlan.operationId));
        await adminCleanupDatabase.delete(sessionMessages)
          .where(eq(sessionMessages.id, v2SharedPlan.humanMessageId));
      }
      if (topology === "public") {
        const subthreadRoomId = randomUUID();
        const successfulInvocationId = `m314-subthread-invocation:${randomUUID()}`;
        const rejectedInvocationId = `m314-subthread-rejected:${randomUUID()}`;
        const [threadRoot] = await adminCleanupDatabase.insert(sessionMessages).values({
          sessionId: v2TurnPlan.sessionId,
          role: "user",
          content: "M314 public Subthread execution anchor",
          humanTurnId: `turn-${randomUUID()}`,
        }).returning({ id: sessionMessages.id });
        if (threadRoot === undefined) {
          throw new Error("Missing M314 public Subthread execution anchor");
        }
        try {
          await adminCleanupDatabase.insert(rooms).values({
            id: subthreadRoomId,
            ownerId: userId,
            type: "shared",
            label: "M314 public Subthread execution",
            graphThreadId: `m314-subthread-execution:${subthreadRoomId}`,
            namespaceId: namespaceValue,
            humanActorIds: [humanActorId],
            kind: "subthread",
            parentRoomId: roomId,
            threadRootMessageId: threadRoot.id,
            createdBy: humanActorId,
          });
          await adminCleanupDatabase.insert(roomMembers).values([
            { roomId: subthreadRoomId, actorId: humanActorId, roomRole: "admin" },
            { roomId: subthreadRoomId, actorId: agentActorId, roomRole: "member",
              agentResponseMode: "active" },
          ]);
          const [sourceShape] = await adminCleanupDatabase.select({
            sourceNamespaceId: rooms.namespaceId,
            parentRoomId: rooms.parentRoomId,
          }).from(rooms).where(eq(rooms.id, subthreadRoomId));
          const [parentShape] = await adminCleanupDatabase.select({
            namespaceId: rooms.namespaceId,
            kind: rooms.kind,
          }).from(rooms).where(eq(rooms.id, roomId));
          if (parentShape === undefined) {
            throw new Error("Missing M314 public Subthread parent");
          }
          expect(sourceShape).toEqual({
            sourceNamespaceId: parentShape.namespaceId,
            parentRoomId: roomId,
          });
          expect(parentShape.kind).toBe("open");

          const subthreadTurn = await v2SharedPlanner.plan({
            authority: input.authority,
            roomId: subthreadRoomId,
            clientDeviceId: deviceId,
            idempotencyKey: `m314-subthread-send:${randomUUID()}`,
            now: now + 12,
          });
          expect(subthreadTurn.status).toBe("planned");
          if (subthreadTurn.status !== "planned") {
            throw new Error("M314 public Subthread plan missing");
          }
          const subthreadPlan = decodeHumanAiReadableLiveShadowMessagePlanV1(
            subthreadTurn.planBytes,
          );
          expect(subthreadPlan.roomId).toBe(subthreadRoomId);
          expect(subthreadPlan.namespaceId).toBe(namespaceId(namespaceValue));
          // The planner's SQL insert owns database wall-clock timestamps. Use
          // a fresh later timestamp for the monotonic operation transition.
          const publishedAt = new Date(Date.now() + 1_000);
          await adminCleanupDatabase.update(conversationSharedAgentShadowOperations).set({
            state: "human_verified",
            humanRequestBytes: new Uint8Array([1]),
            humanRequestDigest: crypto.hash(new Uint8Array([1])),
            humanVerifiedAt: publishedAt,
            updatedAt: publishedAt,
          }).where(eq(
            conversationSharedAgentShadowOperations.operationId,
            subthreadPlan.operationId,
          ));
          await adminCleanupDatabase.update(conversationSharedAgentShadowOperations).set({
            state: "published",
            protectedMessageDigest: digest(0x78),
            finalEventDigest: digest(0x79),
            terminalAt: publishedAt,
          }).where(eq(
            conversationSharedAgentShadowOperations.operationId,
            subthreadPlan.operationId,
          ));
          const subthreadInputs = [{
            operationId: subthreadPlan.operationId,
            messageId: subthreadPlan.humanMessageId,
          }];
          const subthreadInputSetDigest =
            humanAiReadableLiveShadowExecutionInputSetDigest(
              crypto,
              subthreadInputs,
            );
          const executionCommon = {
            policyRevision: subthreadPlan.policyRevision,
            sessionId: subthreadPlan.sessionId,
            roomId: subthreadRoomId,
            invokingHumanId: humanActorId,
            invokingDeviceId: deviceId,
            authorizationDeviceId: deviceId,
            clientActionSessionId: "m314-subthread-runtime",
            inputCount: subthreadInputs.length,
            inputSetDigest: subthreadInputSetDigest,
            state: "authorized" as const,
            authorizedAt: new Date(now + 13),
            createdAt: new Date(now + 13),
            updatedAt: new Date(now + 13),
            deadlineAt: new Date(now + 30_000),
          };
          const successfulExecution = sharedHistoryExecution(crypto, {
            operationId: `m314-subthread-execution:${randomUUID()}`,
            sessionId: subthreadPlan.sessionId,
            roomId: subthreadRoomId,
            namespaceId: namespaceValue,
            humanId: humanActorId,
            deviceId,
            agentId,
            createdAt: now + 13,
            generation: subthreadPlan.namespaceKeyGeneration,
            accessRevision: subthreadPlan.namespaceAccessRevision,
            headDigest: subthreadPlan.namespaceHeadDigest,
            publicationDigest: subthreadPlan.namespacePublicationDigest,
            publicationSetDigest: subthreadPlan.namespacePublicationSetDigest,
            audienceFingerprint: subthreadPlan.namespaceAudienceFingerprint,
          });
          await adminCleanupDatabase.insert(conversationSharedAgentShadowInvocations).values({
            ...executionCommon,
            invocationId: successfulInvocationId,
            authorizationDisposition: "reuse",
            authorizationDigest: successfulExecution.row.execution_authorization_digest,
            authorizationSessionReference: "m314-subthread-runtime-session",
          });
          const [storedExecution] = await adminCleanupDatabase
            .insert(conversationSharedAgentShadowExecutions).values({
              ...executionCommon,
              invocationId: successfulInvocationId,
              executionId: successfulExecution.plan.operationId,
              agentId,
              planBytes: successfulExecution.planBytes,
              planDigest: successfulExecution.planDigest,
              agentRuntimeGeneration: successfulExecution.runtime.generation,
              agentSignerKeyId: successfulExecution.plan.agentSignerKeyId,
              agentSignerPublicKey: successfulExecution.plan.agentSignerPublicKey,
            }).returning({
              executionId: conversationSharedAgentShadowExecutions.executionId,
            });
          expect(storedExecution?.executionId).toBe(
            successfulExecution.plan.operationId,
          );
          await adminCleanupDatabase.insert(
            conversationSharedAgentShadowExecutionInputs,
          ).values({
            executionId: successfulExecution.plan.operationId,
            inputOrdinal: 1,
            humanOperationId: subthreadPlan.operationId,
            messageId: subthreadPlan.humanMessageId,
          });

          const rejectedExecution = sharedHistoryExecution(crypto, {
            operationId: `m314-subthread-rejected:${randomUUID()}`,
            sessionId: subthreadPlan.sessionId,
            roomId: subthreadRoomId,
            namespaceId: namespaceValue,
            humanId: humanActorId,
            deviceId,
            agentId,
            createdAt: now + 14,
            generation: subthreadPlan.namespaceKeyGeneration,
            accessRevision: subthreadPlan.namespaceAccessRevision,
            headDigest: subthreadPlan.namespaceHeadDigest,
            publicationDigest: subthreadPlan.namespacePublicationDigest,
            publicationSetDigest: subthreadPlan.namespacePublicationSetDigest,
            audienceFingerprint: subthreadPlan.namespaceAudienceFingerprint,
          });
          await adminCleanupDatabase.insert(conversationSharedAgentShadowInvocations).values({
            ...executionCommon,
            invocationId: rejectedInvocationId,
            authorizationDisposition: "reuse",
            authorizationDigest: rejectedExecution.row.execution_authorization_digest,
            authorizationSessionReference: "m314-subthread-rejected-session",
          });
          await adminCleanupDatabase.update(rooms).set({ kind: "access" })
            .where(eq(rooms.id, roomId));
          try {
            const rejectedInsert = adminCleanupDatabase
              .insert(conversationSharedAgentShadowExecutions).values({
                ...executionCommon,
                invocationId: rejectedInvocationId,
                executionId: rejectedExecution.plan.operationId,
                agentId,
                planBytes: rejectedExecution.planBytes,
                planDigest: rejectedExecution.planDigest,
                agentRuntimeGeneration: rejectedExecution.runtime.generation,
                agentSignerKeyId: rejectedExecution.plan.agentSignerKeyId,
                agentSignerPublicKey: rejectedExecution.plan.agentSignerPublicKey,
              }).execute();
            let rejection: unknown;
            try {
              await rejectedInsert;
            } catch (error) {
              rejection = error;
            }
            expect(rejection).toBeInstanceOf(Error);
            const databaseError = (rejection as Error).cause;
            expect(databaseError).toBeInstanceOf(Error);
            expect((databaseError as Error & {code?: string}).code).toBe("23503");
            expect((databaseError as Error).message).toBe(
              "Shared-Agent execution Session/Room/Agent mismatch",
            );
          } finally {
            await adminCleanupDatabase.update(rooms).set({ kind: "open" })
              .where(eq(rooms.id, roomId));
          }
        } finally {
          await adminCleanupDatabase.delete(conversationSharedAgentShadowInvocations)
            .where(eq(conversationSharedAgentShadowInvocations.roomId, subthreadRoomId));
          await adminCleanupDatabase.delete(conversationSharedAgentShadowOperations)
            .where(eq(conversationSharedAgentShadowOperations.roomId, subthreadRoomId));
          await adminCleanupDatabase.delete(sessions)
            .where(eq(sessions.roomId, subthreadRoomId));
          await adminCleanupDatabase.delete(roomMembers)
            .where(eq(roomMembers.roomId, subthreadRoomId));
          await adminCleanupDatabase.delete(rooms)
            .where(eq(rooms.id, subthreadRoomId));
          await adminCleanupDatabase.delete(sessionMessages)
            .where(eq(sessionMessages.id, threadRoot.id));
        }
      }
      await admin.unsafe(
        `INSERT INTO human_crypto_devices (
           device_id, human_id, user_id, human_actor_id, client_kind,
           installation_lineage_digest, device_generation,
           signing_public_key, encryption_public_key, public_fingerprint,
           state, authorization_kind, approval_generation,
           recovery_generation, authorization_evidence_digest,
           membership_state, membership_server_instance_id,
           membership_lineage_generation, membership_epoch,
           membership_security_revision, membership_leaf_index,
           membership_head_digest, membership_acknowledged_sequence,
           key_package_generation, key_package_count,
           delivery_sequence_high_watermark, delivery_acknowledged_sequence,
           revision, created_at, activated_at
         )
         SELECT $1, human_id, user_id, human_actor_id, 'browser', $2, 1,
                $3, $4, $5, 'active', 'device_approval', 1, NULL, $6,
                membership_state, membership_server_instance_id,
                membership_lineage_generation, membership_epoch,
                membership_security_revision, membership_leaf_index,
                membership_head_digest, membership_acknowledged_sequence,
                1, 0, 0, 0, revision + 1, $7, $7
           FROM human_crypto_devices
          WHERE device_id = $8`,
        [secondDeviceId, digest(0x61), secondSigning.publicKey,
          secondEncryption.publicKey, crypto.hash(secondSigning.publicKey),
          digest(0x62), new Date(now + 11).toISOString(), deviceId],
      );
      const missingSecondDeviceAuthority =
        await v2Repository.inspectForegroundAuthority({
          namespaceIds: [namespaceValue],
          keyClass: "ai",
          subjectHumanId: humanActorId,
          deviceId: secondDeviceId,
        });
      expect(missingSecondDeviceAuthority).toEqual({
        status: "unavailable",
        reason: "recipient_sync_required",
        requiredNamespaceIds: [namespaceValue],
      });
      const secondDevicePublicKeyDigest = crypto.hash(
        secondEncryption.publicKey,
      );
      const accessRequest = prepareDomainKeyAccessRequest(crypto, {
        formatVersion: 2,
        purpose: "domain_key.access_request",
        requestId: `m305-source-backlog:${randomUUID()}`,
        serverId: v2ServerId,
        humanId: humanId(humanActorId),
        deviceId: cryptoDeviceId(secondDeviceId),
        deviceSigningKeyGeneration: 1,
        cryptoDomainId: cryptoDomainId(v2DomainId),
        participantDigest: v2HeadPlan.participantDigest,
        participantCount: v2HeadPlan.participantCount,
        keyClass: "ai",
        domainKeyGeneration: 1,
        authorizationRevision: authorizationRevision(1),
        headDigest: v2Head.digest,
        recipientKeyId: secondDeviceId,
        recipientKeyGeneration: 1,
        recipientPublicKeyDigest: secondDevicePublicKeyDigest,
        issuedAt: unixTimestamp(now + 12),
        expiresAt: unixTimestamp(now + 12 + 30_000),
        signingPrivateKey: secondSigning.privateKey,
      });
      await adminCleanupDatabase.update(rooms).set({ kind: "private" }).where(eq(rooms.id, roomId));
      const requested = await namespaceProduct.withCurrentPrivateRoom({
        subjectUserId: userId,
        subjectHumanId: humanActorId,
        roomId,
        namespaceId: namespaceValue,
        use: (authority) => v2Repository.requestRecipient({
          authority,
          keyClass: "ai",
          clientDeviceId: secondDeviceId,
          requestId: accessRequest.value.requestId,
          idempotencyKey: `m305-source-backlog:${randomUUID()}`,
          requestBytes: accessRequest.bytes,
          now: now + 12,
        }),
      });
      expect(requested?.status).toBe("requested");
      expect(await v2Repository.listPendingSourceCoordinates({
        product: productConnection,
        humanId: humanActorId,
        clientDeviceId: deviceId,
        now: now + 13,
      })).toEqual([{ namespaceId: namespaceValue, keyClass: "ai" }]);
      expect(await v2Repository.listPendingSourceCoordinates({
        product: productConnection,
        humanId: humanActorId,
        clientDeviceId: secondDeviceId,
        now: now + 13,
      })).toEqual([]);
      // A public Room membership/access transition between product captures
      // must request a retry rather than acknowledge an empty source backlog.
      const [beforeSourceRace] = await adminCleanupDatabase.select({
        revision: rooms.namespaceAccessRevision,
      }).from(rooms).where(eq(rooms.id, roomId));
      expect(beforeSourceRace).toBeDefined();
      await adminCleanupDatabase.update(rooms).set({ kind: "open" })
        .where(eq(rooms.id, roomId));
      let sourceCaptures = 0;
      const racedProduct: PostgresJsBridgeConnection = {
        ...productConnection,
        async transactionOnce(callback, options) {
          const result = await productConnection.transactionOnce(callback, options);
          if (++sourceCaptures === 1) {
            await adminCleanupDatabase.update(rooms).set({
              namespaceAccessRevision: beforeSourceRace!.revision + 1,
            }).where(eq(rooms.id, roomId));
          }
          return result;
        },
      };
      try {
        expect(await v2Repository.listPendingSourceCoordinates({
          product: racedProduct,
          humanId: humanActorId,
          clientDeviceId: deviceId,
          now: now + 13,
        })).toBeNull();
        expect(sourceCaptures).toBe(2);
        expect(await v2Repository.listPendingSourceCoordinates({
          product: productConnection,
          humanId: humanActorId,
          clientDeviceId: deviceId,
          now: now + 13,
        })).toContainEqual({ namespaceId: namespaceValue, keyClass: "ai" });
      } finally {
        await adminCleanupDatabase.update(rooms).set({
          kind: "private",
          namespaceAccessRevision: beforeSourceRace!.revision,
        }).where(eq(rooms.id, roomId));
      }

      await adminCleanup.unsafe(
        `UPDATE domain_key_recipient_requests
            SET state = 'stale', failure_code = 'authority_changed',
                terminal_at = $2, updated_at = $2
          WHERE request_id = $1`,
        [accessRequest.value.requestId, new Date(now + 14).toISOString()],
      );

      // A membership transition changes the current Room Domain while the
      // Namespace bundle still names the old Domain. Recovery must wake an old
      // source that retains the exact old envelope even when no request exists,
      // and current-Domain delivery must remain discoverable independently of
      // that stale binding.
      const transitionUserId = randomUUID();
      const transitionHumanId = randomUUID();
      const transitionDomainId = `domain-v2:${randomUUID()}`;
      const transitionPublicationId = `m320-head:${randomUUID()}`;
      const transitionRequestId = `m320-current-request:${randomUUID()}`;
      const transitionHeadDigest = digest(0x81);
      const transitionParticipantDigest = digest(0x82);
      const transitionEnvelopeDigest = digest(0x83);
      const transitionAuthorizationDigest = digest(0x84);
      const transitionRecipientDigest = crypto.hash(secondEncryption.publicKey);
      const transitionParticipants = [humanActorId, transitionHumanId].sort();
      const [beforeTransitionRoom] = await adminCleanupDatabase.select({
        humanActorIds: rooms.humanActorIds,
        namespaceAccessRevision: rooms.namespaceAccessRevision,
      }).from(rooms).where(eq(rooms.id, roomId));
      if (beforeTransitionRoom === undefined) throw new Error("Missing transition Room");
      try {
        await adminCleanup.unsafe(
          `INSERT INTO users (id, name) VALUES ($1, 'M320 transition user')`,
          [transitionUserId],
        );
        await adminCleanup.unsafe(
          `INSERT INTO actors (
             id, owner_id, display_name, trust_state, kind, agent_id
           ) VALUES ($1, $2, 'M320 transition Human', 'verified', 'user', NULL)`,
          [transitionHumanId, transitionUserId],
        );
        await adminCleanup.unsafe(
          `INSERT INTO room_members (
             room_id, actor_id, room_role, agent_response_mode
           ) VALUES ($1, $2, 'member', NULL)`,
          [roomId, transitionHumanId],
        );
        await adminCleanup.unsafe(
          `UPDATE rooms
              SET human_actor_ids = $2::uuid[], namespace_access_revision = 2
            WHERE id = $1`,
          [roomId, transitionParticipants],
        );
        await adminCleanup.unsafe(
          `INSERT INTO crypto_domains (
             id, participant_digest, participants, epoch,
             authorization_revision, roster_bytes, writes_paused
           ) VALUES ($1, $2, $3::text[], 1, 1, $4, false)`,
          [transitionDomainId, transitionParticipantDigest,
            transitionParticipants, Uint8Array.of(2)],
        );
        await adminCleanup.unsafe(
          `INSERT INTO domain_key_publication_operations (
             operation_id, idempotency_key, domain_id, key_class,
             participant_digest, participant_count, domain_key_generation,
             authorization_revision, expected_previous_head_digest,
             head_digest, head_bytes, issuer_human_id, issuer_device_id,
             issuer_device_signing_generation, state, created_at, updated_at,
             deadline_at, activated_at
           ) VALUES ($1, $1, $2, 'ai', $3, 2, 1, 1, NULL,
                     $4, $5, $6, $7, 1, 'active', $8, $8, $9, $8)`,
          [transitionPublicationId, transitionDomainId, transitionParticipantDigest,
            transitionHeadDigest, Uint8Array.of(2), humanActorId, deviceId,
            new Date(now + 14).toISOString(), new Date(now + 30_000).toISOString()],
        );
        await adminCleanup.unsafe(
          `INSERT INTO domain_key_heads (
             domain_id, key_class, participant_digest, participant_count,
             domain_key_generation, authorization_revision, head_digest,
             previous_head_digest, head_bytes, publication_operation_id,
             issuer_human_id, issuer_device_id,
             issuer_device_signing_generation, activated_at
           ) VALUES ($1, 'ai', $2, 2, 1, 1, $3, NULL, $4, $5,
                     $6, $7, 1, $8)`,
          [transitionDomainId, transitionParticipantDigest,
            transitionHeadDigest, Uint8Array.of(2),
            transitionPublicationId, humanActorId, deviceId,
            new Date(now + 14).toISOString()],
        );
        await adminCleanup.unsafe(
          `INSERT INTO domain_key_recipient_envelopes (
             domain_id, key_class, domain_key_generation,
             authorization_revision, head_digest, recipient_human_id,
             recipient_kind, recipient_key_id, recipient_key_generation,
             recipient_public_key_digest, envelope_digest, envelope_bytes,
             authorization_digest, authorization_bytes, source_request_id,
             issuer_human_id, issuer_device_id,
             issuer_device_signing_generation, created_at
           ) VALUES ($1, 'ai', 1, 1, $2, $3, 'device', $4, 1,
                     $5, $6, $7, $8, $9, NULL, $3, $10, 1, $11)`,
          [transitionDomainId, transitionHeadDigest, humanActorId,
            secondDeviceId, transitionRecipientDigest,
            transitionEnvelopeDigest, Uint8Array.of(2),
            transitionAuthorizationDigest, Uint8Array.of(2), deviceId,
            new Date(now + 14).toISOString()],
        );

        expect(await v2Repository.listPendingSourceCoordinates({
          product: productConnection,
          humanId: humanActorId,
          clientDeviceId: deviceId,
          now: now + 15,
        })).toEqual([{ namespaceId: namespaceValue, keyClass: "ai" }]);
        expect(await v2Repository.listPendingSourceCoordinates({
          product: productConnection,
          humanId: humanActorId,
          clientDeviceId: secondDeviceId,
          now: now + 15,
        })).toEqual([]);

        await adminCleanup.unsafe(
          `INSERT INTO domain_key_recipient_requests (
             request_id, idempotency_key, domain_id, key_class,
             domain_key_generation, authorization_revision, head_digest,
             recipient_human_id, recipient_kind, recipient_key_id,
             recipient_key_generation, recipient_public_key_digest,
             request_digest, request_bytes, state, created_at, updated_at,
             deadline_at
           ) VALUES ($1, $2, $3, 'ai', 1, 1, $4, $5, 'device', $6, 1,
                     $7, $8, $9, 'pending', $10, $10, $11)`,
          [transitionRequestId, `m320-current-request:${randomUUID()}`,
            transitionDomainId, transitionHeadDigest, transitionHumanId,
            `m320-transition-device:${randomUUID()}`, digest(0x85),
            digest(0x86), Uint8Array.of(2),
            new Date(now + 15).toISOString(),
            new Date(now + 30_000).toISOString()],
        );
        expect(await v2Repository.listPendingSourceCoordinates({
          product: productConnection,
          humanId: humanActorId,
          clientDeviceId: secondDeviceId,
          now: now + 16,
        })).toEqual([{ namespaceId: namespaceValue, keyClass: "ai" }]);

        // Keep the denormalized audience deliberately unchanged: the
        // authoritative membership edge alone must deny the removed source.
        await adminCleanupDatabase.delete(roomMembers).where(and(
          eq(roomMembers.roomId, roomId),
          eq(roomMembers.actorId, humanActorId),
        ));
        expect(await v2Repository.listPendingSourceCoordinates({
          product: productConnection,
          humanId: humanActorId,
          clientDeviceId: deviceId,
          now: now + 17,
        })).toEqual([]);
      } finally {
        await adminCleanup.unsafe(
          `DELETE FROM domain_key_recipient_requests WHERE request_id = $1`,
          [transitionRequestId],
        );
        await adminCleanup.unsafe(
          `DELETE FROM domain_key_recipient_envelopes WHERE domain_id = $1`,
          [transitionDomainId],
        );
        await adminCleanup.unsafe(
          `DELETE FROM domain_key_heads WHERE domain_id = $1`,
          [transitionDomainId],
        );
        await adminCleanup.unsafe(
          `DELETE FROM domain_key_publication_operations WHERE operation_id = $1`,
          [transitionPublicationId],
        );
        await adminCleanup.unsafe(
          `DELETE FROM crypto_domains WHERE id = $1`,
          [transitionDomainId],
        );
        await adminCleanupDatabase.insert(roomMembers).values({
          roomId, actorId: humanActorId, roomRole: "admin",
          agentResponseMode: null,
        }).onConflictDoNothing();
        await adminCleanupDatabase.delete(roomMembers).where(and(
          eq(roomMembers.roomId, roomId),
          eq(roomMembers.actorId, transitionHumanId),
        ));
        await adminCleanupDatabase.update(rooms).set({
          humanActorIds: beforeTransitionRoom.humanActorIds,
          namespaceAccessRevision: beforeTransitionRoom.namespaceAccessRevision,
        }).where(eq(rooms.id, roomId));
        await adminCleanupDatabase.delete(actors)
          .where(eq(actors.id, transitionHumanId));
        await adminCleanupDatabase.delete(users)
          .where(eq(users.id, transitionUserId));
        transitionHeadDigest.fill(0);
        transitionParticipantDigest.fill(0);
        transitionEnvelopeDigest.fill(0);
        transitionAuthorizationDigest.fill(0);
        transitionRecipientDigest.fill(0);
      }
      destroyDomainKeyAccessRequestV2(accessRequest.value);
      accessRequest.bytes.fill(0);
      accessRequest.digest.fill(0);
      secondDevicePublicKeyDigest.fill(0);
      const missingSecondDevicePlan = await v2SharedPlanner.plan({
        authority: input.authority,
        roomId,
        clientDeviceId: secondDeviceId,
        idempotencyKey: `shared-send-missing-recipient-${randomUUID()}`,
        now: now + 12,
      });
      expect(missingSecondDevicePlan).toEqual({
        status: "unavailable",
        authorizationScheme: "human_ai_readable_v1",
        reason: "recipient_sync_required",
        requiredNamespaceIds: [namespaceValue],
      });
      const [humanPeerSession] = await admin.unsafe<{ id: string }[]>(
        "SELECT id::text AS id FROM sessions WHERE room_id = $1 LIMIT 1",
        [roomId],
      );
      if (humanPeerSession === undefined) {
        throw new Error("M305 lifecycle fixture Session missing");
      }
      const expiredPlanned = `m305-expired-planned:${randomUUID()}`;
      const expiredVerified = `m305-expired-verified:${randomUUID()}`;
      const lifecycleDigest = digest(0x71);
      await admin.unsafe(
        `INSERT INTO conversation_human_peer_shadow_operations (
           operation_id, client_idempotency_key, policy_revision, session_id,
           room_id, human_message_id, human_message_created_at,
           transcript_ordinal, subject_human_id, committer_device_id,
           committer_device_signing_key_generation, host_authorization_revision,
           namespace_id, namespace_access_revision, namespace_key_generation,
           namespace_head_digest, namespace_publication_digest,
           namespace_publication_set_digest, namespace_audience_fingerprint,
           crypto_object_id, attempt_coordinate, plan_digest, plan_bytes,
           human_request_digest, human_request_bytes, state,
           human_verified_at, deadline_at, created_at, updated_at
         ) VALUES
           ($1, $2, 1, $3::uuid, $4::uuid, 910001, $5, 910001, $6, $7,
            1, 1, $8::uuid, 1, 1, $9, $9, $9, $9, $10, $11, $9, $12,
            NULL, NULL, 'planned', NULL, $13, $5, $5),
           ($14, $15, 1, $3::uuid, $4::uuid, 910002, $5, 910002, $6, $7,
            1, 1, $8::uuid, 1, 1, $9, $9, $9, $9, $16, $17, $9, $12,
            $9, $12, 'human_verified', $5, $13, $5, $5)`,
        [
          expiredPlanned,
          `m305-client:${randomUUID()}`,
          humanPeerSession.id,
          roomId,
          new Date(now).toISOString(),
          humanActorId,
          deviceId,
          namespaceValue,
          lifecycleDigest,
          `m305-object:${randomUUID()}`,
          `m305-attempt:${randomUUID()}`,
          Uint8Array.of(1),
          new Date(now + 20).toISOString(),
          expiredVerified,
          `m305-client:${randomUUID()}`,
          `m305-object:${randomUUID()}`,
          `m305-attempt:${randomUUID()}`,
        ],
      );
      const lifecyclePlannerA = new PostgresHumanPeerLiveShadowPlanner(
        productConnection,
        restrictedConnection,
        crypto,
        v2ServerId,
      );
      const lifecyclePlannerB = new PostgresHumanPeerLiveShadowPlanner(
        productConnection,
        restrictedConnection,
        crypto,
        v2ServerId,
      );
      const reconciled = await Promise.all([
        lifecyclePlannerA.reconcileExpired(now + 60_000, 1),
        lifecyclePlannerB.reconcileExpired(now + 60_000, 1),
      ]);
      expect(reconciled.reduce((sum, count) => sum + count, 0)).toBe(2);
      const lifecycleRows = await admin.unsafe<{
        operation_id: string;
        state: string;
        terminal_stage: string;
        terminal_reason: string;
        reconciliation_attempt_count: number;
      }[]>(
        `SELECT operation_id, state, terminal_stage, terminal_reason,
                reconciliation_attempt_count
           FROM conversation_human_peer_shadow_operations
          WHERE operation_id = ANY($1::text[])
          ORDER BY operation_id`,
        [[expiredPlanned, expiredVerified]],
      );
      expect([...lifecycleRows]).toEqual([
        {
          operation_id: expiredPlanned,
          state: "failed",
          terminal_stage: "human_admission",
          terminal_reason: "deadline_expired",
          reconciliation_attempt_count: 1,
        },
        {
          operation_id: expiredVerified,
          state: "failed",
          terminal_stage: "protected_completion",
          terminal_reason: "deadline_expired",
          reconciliation_attempt_count: 1,
        },
      ].sort((left, right) => left.operation_id.localeCompare(right.operation_id)));
      const [fullPolicy] = await adminDatabase.update(encryptionTransitionPolicy).set({
        mode: "encrypted_only", revision: sql`${encryptionTransitionPolicy.revision} + 1`,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      }).where(eq(encryptionTransitionPolicy.id, "server"))
        .returning({ revision: encryptionTransitionPolicy.revision });
      if (fullPolicy === undefined) throw new Error("Full policy missing");
      const fullTurnInput = { ...input,
        clientActionSessionId: `full-action-${randomUUID()}`,
        idempotencyKey: `full-turn-${randomUUID()}`, now: now + 14 };
      const fullTurn = await v2Planner.plan(fullTurnInput);
      expect(fullTurn.status).toBe("planned");
      if (fullTurn.status !== "planned") throw new Error("Full turn plan missing");
      expect(fullTurn.representationMode).toBe("full_encryption");
      const decodedFullTurn = decodeLiveShadowMessagePlanV4(fullTurn.planBytes);
      expect(decodedFullTurn.policyRevision).toBe(fullPolicy.revision);

      const fullSharedInput = { authority: input.authority, roomId,
        clientDeviceId: deviceId,
        idempotencyKey: `full-shared-${randomUUID()}`, now: now + 14 };
      const fullShared = await v2SharedPlanner.plan(fullSharedInput);
      expect(fullShared).toMatchObject({ status: "planned" });
      if (fullShared.status !== "planned") throw new Error("Full shared plan missing");
      expect(fullShared.representationMode).toBe("full_encryption");
      expect(decodeHumanAiReadableLiveShadowMessagePlanV1(fullShared.planBytes)
        .policyRevision).toBe(fullPolicy.revision);

      const fullPeerUserId = randomUUID();
      const fullPeerActorId = randomUUID();
      try {
        await adminCleanupDatabase.insert(users).values({ id: fullPeerUserId,
          name: "M318 Full peer" });
        await adminCleanupDatabase.insert(actors).values({ id: fullPeerActorId,
          ownerId: fullPeerUserId, displayName: "M318 Full peer", kind: "user" });
        await adminCleanupDatabase.delete(roomMembers).where(and(
          eq(roomMembers.roomId, roomId), eq(roomMembers.actorId, agentActorId)));
        await adminCleanupDatabase.insert(roomMembers).values({ roomId,
          actorId: fullPeerActorId, roomRole: "member" });
        await adminCleanupDatabase.update(rooms).set({
          humanActorIds: [humanActorId, fullPeerActorId].sort(),
        }).where(eq(rooms.id, roomId));
        const fullPeerPlanner = new PostgresHumanPeerLiveShadowPlanner(
          productConnection, restrictedConnection, crypto, v2ServerId);
        const fullPeer = await fullPeerPlanner.plan({ authority: input.authority,
          roomId, clientDeviceId: deviceId,
          idempotencyKey: `full-peer-${randomUUID()}`, now: now + 14 });
        // This fixture published only AI keys for the original audience, not
        // Human keys for this new two-person Domain. Full mode must fail closed.
        expect(fullPeer).toMatchObject({ status: "unavailable", reason: "namespace_unavailable" });
      } finally {
        await adminCleanupDatabase.delete(roomMembers).where(and(
          eq(roomMembers.roomId, roomId), eq(roomMembers.actorId, fullPeerActorId)));
        await adminCleanupDatabase.update(rooms).set({ humanActorIds: [humanActorId] })
          .where(eq(rooms.id, roomId));
        await adminCleanupDatabase.insert(roomMembers).values({ roomId,
          actorId: agentActorId, roomRole: "member", agentResponseMode: "active" })
          .onConflictDoNothing();
        await adminCleanupDatabase.update(rooms).set({
          namespaceAccessRevision: beforeTransitionRoom.namespaceAccessRevision,
        }).where(eq(rooms.id, roomId));
        await adminCleanupDatabase.delete(actors).where(eq(actors.id, fullPeerActorId));
        await adminCleanupDatabase.delete(users).where(eq(users.id, fullPeerUserId));
      }

      await adminDatabase.update(encryptionTransitionPolicy).set({ mode: "shadow_encryption",
        revision: sql`${encryptionTransitionPolicy.revision} + 1`, updatedAt: sql`CURRENT_TIMESTAMP`,
      }).where(eq(encryptionTransitionPolicy.id, "server"));
      expect(await v2Planner.plan(fullTurnInput)).toEqual({
        status: "unavailable", reason: "reservation_unavailable",
      });
      expect(await v2SharedPlanner.plan(fullSharedInput)).toEqual({
        status: "unavailable", authorizationScheme: "human_ai_readable_v1",
        reason: "reservation_unavailable",
      });
      if (topology === "public") {
        const scaleUserIds = Array.from({ length: 4_096 }, () => randomUUID());
        const scaleHumanIds = Array.from({ length: 4_096 }, () => randomUUID()).sort();
        const scaleParticipants = [humanActorId, ...scaleHumanIds].sort();
        const targetUserId = scaleUserIds[0]!;
        const targetHumanId = scaleHumanIds[0]!;
        const targetDeviceId = `m314-scale-target:${randomUUID()}`;
        const targetSigning = crypto.generateSigningKeyPair();
        const targetEncryption = await crypto.generateEncryptionKeyPair();
        const targetRecovery = await crypto.generateEncryptionKeyPair();
        const scaleChunkSize = 500;
        let targetMembershipVault: DeviceProviderStateVault | undefined;
        let scaleDomainId: string | null = null;
        try {
          await adminCleanupDatabase.transaction(async (database) => {
            for (let offset = 0; offset < scaleUserIds.length;
              offset += scaleChunkSize) {
              await database.insert(users).values(
                scaleUserIds.slice(offset, offset + scaleChunkSize).map(
                  (id, index) => ({
                    id,
                    name: `M314 scale Human ${offset + index}`,
                  }),
                ),
              );
              await database.insert(actors).values(
                scaleHumanIds.slice(offset, offset + scaleChunkSize).map(
                  (id, index) => ({
                    id,
                    ownerId: scaleUserIds[offset + index]!,
                    displayName: `M314 scale Human ${offset + index}`,
                    trustState: "verified" as const,
                    kind: "user" as const,
                  }),
                ),
              );
            }
            for (let offset = 0; offset < scaleHumanIds.length;
              offset += scaleChunkSize) {
              await database.insert(roomMembers).values(
                scaleHumanIds.slice(offset, offset + scaleChunkSize).map(
                  (actorId) => ({
                    roomId,
                    actorId,
                    roomRole: "member" as const,
                  }),
                ),
              );
            }
            await database.update(rooms).set({
              kind: "open",
              humanActorIds: scaleParticipants,
            }).where(eq(rooms.id, roomId));
            await database.insert(schema.humanCryptoCustodies).values({
              humanId: targetHumanId,
              userId: targetUserId,
              humanActorId: targetHumanId,
              initialInstallationLineageDigest: digest(0x91),
              state: "active",
              everInitializedAt: new Date(now + 20),
              firstDeviceId: targetDeviceId,
              currentRecoveryGeneration: 1,
              currentRecoveryPublicKeyDigest: crypto.hash(targetRecovery.publicKey),
              revision: 1,
              createdAt: new Date(now + 20),
              updatedAt: new Date(now + 20),
            });
            await database.insert(schema.humanCryptoDevices).values({
              deviceId: targetDeviceId,
              humanId: targetHumanId,
              userId: targetUserId,
              humanActorId: targetHumanId,
              clientKind: "browser",
              installationLineageDigest: digest(0x92),
              deviceGeneration: 1,
              signingPublicKey: targetSigning.publicKey,
              encryptionPublicKey: targetEncryption.publicKey,
              publicFingerprint: crypto.hash(targetSigning.publicKey),
              state: "active",
              authorizationKind: "first_bootstrap",
              recoveryGeneration: 1,
              authorizationEvidenceDigest: digest(0x93),
              keyPackageGeneration: 1,
              keyPackageCount: 0,
              revision: 1,
              createdAt: new Date(now + 20),
              activatedAt: new Date(now + 20),
            });
            await database.insert(schema.humanCryptoRecoveryKeys).values({
              humanId: targetHumanId,
              generation: 1,
              recoveryKeyId: `m314-scale-recovery:${randomUUID()}`,
              formatVersion: 1,
              publicKey: targetRecovery.publicKey,
              publicKeyDigest: crypto.hash(targetRecovery.publicKey),
              archiveHash: digest(0x94),
              issuerDeviceId: targetDeviceId,
              state: "current",
              activatedAt: new Date(now + 20),
              revision: 1,
            });
          });
          const targetMembershipCoordinates = Object.freeze({
            serverInstanceId: instanceIdentity.server_instance_id,
            humanId: humanId(targetHumanId),
            lineageGeneration: 1,
          });
          targetMembershipVault = DeviceProviderStateVault.fromKey(
            crypto,
            cryptoDeviceId(targetDeviceId),
            new Uint8Array(32).fill(0x95),
          );
          const targetMembershipGroup = new HumanDeviceOpenMlsGroup(
            crypto,
            targetMembershipVault,
            {
              coordinates: targetMembershipCoordinates,
              ownCredential: {
                formatVersion: 1,
                ...targetMembershipCoordinates,
                deviceId: cryptoDeviceId(targetDeviceId),
                installationLineageDigest: digest(0x92),
                deviceKeyGeneration: 1,
              },
            },
          );
          await targetMembershipGroup.initialize();
          const targetInitialMembership =
            await targetMembershipGroup.createInitialState();
          expect(await membershipRepository.establishInitial({
            userId: targetUserId,
            humanId: targetHumanId,
            deviceId: targetDeviceId,
            headBytes: encodeHumanDeviceGroupHead(targetInitialMembership.head),
            rosterBytes: targetInitialMembership.rosterBytes,
            now: now + 20,
          })).toBe("created");

          const [enrolledScaleHumans] = await admin.unsafe<{
            count: number;
          }[]>(
            `SELECT count(*)::integer AS count
               FROM human_crypto_devices
              WHERE human_id = ANY($1::text[])`,
            [scaleHumanIds],
          );
          expect(enrolledScaleHumans?.count).toBe(1);
          const scaleHeadPlan = await namespaceProduct
            .withCurrentHumanAiReadableRoom({
              subjectUserId: userId,
              subjectHumanId: humanActorId,
              roomId,
              namespaceId: namespaceValue,
              use: (authority) => v2Repository.planHead({
                authority,
                keyClass: "ai",
                clientDeviceId: deviceId,
                now: now + 21,
              }),
            });
          expect(scaleHeadPlan?.status).toBe("create_required");
          if (scaleHeadPlan?.status !== "create_required") {
            throw new Error("M314 4,097-participant Domain head plan missing");
          }
          expect(scaleHeadPlan.participantCount).toBe(4_097);
          scaleDomainId = scaleHeadPlan.domainId;
          const scaleDomainKey = generateDomainKey(crypto);
          const scaleHead = prepareDomainKeyHead(crypto, {
            serverId: v2ServerId,
            cryptoDomainId: cryptoDomainId(scaleHeadPlan.domainId),
            participantDigest: scaleHeadPlan.participantDigest,
            participantCount: scaleHeadPlan.participantCount,
            keyClass: scaleHeadPlan.keyClass,
            domainKeyGeneration: scaleHeadPlan.domainKeyGeneration,
            authorizationRevision: authorizationRevision(
              scaleHeadPlan.authorizationRevision,
            ),
            previousHeadDigest: scaleHeadPlan.previousHeadDigest,
            publicationOperationId: `m314-scale-head:${randomUUID()}`,
            issuerHumanId: humanId(scaleHeadPlan.issuerHumanId),
            issuerDeviceId: cryptoDeviceId(scaleHeadPlan.issuerDeviceId),
            issuerDeviceSigningGeneration:
              scaleHeadPlan.issuerDeviceSigningGeneration,
            issuedAt: scaleHeadPlan.issuedAt,
            deadlineAt: scaleHeadPlan.deadlineAt,
            issuerSigningPublicKey: signing.publicKey,
            issuerSigningPrivateKey: signing.privateKey,
          });
          const scaleSourceEnvelope = await prepareDomainKeyRecipientEnvelope(
            crypto,
            {
              head: scaleHead.head,
              headDigest: scaleHead.digest,
              recipient: {
                recipientHumanId: humanId(scaleHeadPlan.issuerHumanId),
                recipientKind: "device",
                recipientKeyId: scaleHeadPlan.issuerDeviceId,
                recipientKeyGeneration:
                  scaleHeadPlan.issuerDeviceSigningGeneration,
                recipientPublicKey: scaleHeadPlan.recipientEncryptionPublicKey,
                recipientPublicKeyDigest: scaleHeadPlan.recipientPublicKeyDigest,
              },
              domainKey: scaleDomainKey,
              issuerHumanId: humanId(scaleHeadPlan.issuerHumanId),
              issuerDeviceId: cryptoDeviceId(scaleHeadPlan.issuerDeviceId),
              issuerDeviceSigningGeneration:
                scaleHeadPlan.issuerDeviceSigningGeneration,
              issuerSigningPublicKey: signing.publicKey,
              issuerSigningPrivateKey: signing.privateKey,
            },
          );
          const scaleRecoveryEnvelope = await prepareDomainKeyRecipientEnvelope(
            crypto,
            {
              head: scaleHead.head,
              headDigest: scaleHead.digest,
              recipient: {
                recipientHumanId: humanId(scaleHeadPlan.issuerHumanId),
                recipientKind: "recovery",
                recipientKeyId: scaleHeadPlan.recoveryKeyId,
                recipientKeyGeneration: scaleHeadPlan.recoveryKeyGeneration,
                recipientPublicKey: scaleHeadPlan.recoveryPublicKey,
                recipientPublicKeyDigest: scaleHeadPlan.recoveryPublicKeyDigest,
              },
              domainKey: scaleDomainKey,
              issuerHumanId: humanId(scaleHeadPlan.issuerHumanId),
              issuerDeviceId: cryptoDeviceId(scaleHeadPlan.issuerDeviceId),
              issuerDeviceSigningGeneration:
                scaleHeadPlan.issuerDeviceSigningGeneration,
              issuerSigningPublicKey: signing.publicKey,
              issuerSigningPrivateKey: signing.privateKey,
            },
          );
          const scaleSourceAuthorization =
            prepareDomainKeyRecipientAuthorization(crypto, {
              authorizationOperationId: scaleHead.head.publicationOperationId,
              reason: "head_establishment",
              requestDigest: null,
              envelopeBytes: scaleSourceEnvelope.bytes,
              envelopeDigest: scaleSourceEnvelope.digest,
              issuerHumanId: humanId(scaleHeadPlan.issuerHumanId),
              issuerDeviceId: cryptoDeviceId(scaleHeadPlan.issuerDeviceId),
              issuerDeviceSigningGeneration:
                scaleHeadPlan.issuerDeviceSigningGeneration,
              issuedAt: scaleHeadPlan.issuedAt,
              deadlineAt: scaleHeadPlan.deadlineAt,
              issuerSigningPublicKey: signing.publicKey,
              issuerSigningPrivateKey: signing.privateKey,
            });
          const scaleRecoveryAuthorization =
            prepareDomainKeyRecipientAuthorization(crypto, {
              authorizationOperationId: scaleHead.head.publicationOperationId,
              reason: "head_establishment",
              requestDigest: null,
              envelopeBytes: scaleRecoveryEnvelope.bytes,
              envelopeDigest: scaleRecoveryEnvelope.digest,
              issuerHumanId: humanId(scaleHeadPlan.issuerHumanId),
              issuerDeviceId: cryptoDeviceId(scaleHeadPlan.issuerDeviceId),
              issuerDeviceSigningGeneration:
                scaleHeadPlan.issuerDeviceSigningGeneration,
              issuedAt: scaleHeadPlan.issuedAt,
              deadlineAt: scaleHeadPlan.deadlineAt,
              issuerSigningPublicKey: signing.publicKey,
              issuerSigningPrivateKey: signing.privateKey,
            });
          try {
            expect((await namespaceProduct.withCurrentHumanAiReadableRoom({
              subjectUserId: userId,
              subjectHumanId: humanActorId,
              roomId,
              namespaceId: namespaceValue,
              use: (authority) => v2Repository.publishHead({
                authority,
                keyClass: "ai",
                clientDeviceId: deviceId,
                operationId: scaleHead.head.publicationOperationId,
                idempotencyKey: `m314-scale-head:${randomUUID()}`,
                headBytes: scaleHead.bytes,
                envelopeBytes: scaleSourceEnvelope.bytes,
                authorizationBytes: scaleSourceAuthorization.bytes,
                recoveryEnvelopeBytes: scaleRecoveryEnvelope.bytes,
                recoveryAuthorizationBytes: scaleRecoveryAuthorization.bytes,
                now: now + 22,
              }),
            }))?.status).toBe("published");

            const scaleBundlePlan = await namespaceProduct
              .withCurrentHumanAiReadableRoom({
                subjectUserId: userId,
                subjectHumanId: humanActorId,
                roomId,
                namespaceId: namespaceValue,
                use: (authority) => v2Repository.planNamespaceBundle({
                  authority,
                  keyClass: "ai",
                  clientDeviceId: deviceId,
                }),
              });
            expect(scaleBundlePlan?.status).toBe("replace_required");
            if (scaleBundlePlan?.status !== "replace_required") {
              throw new Error("M314 retained Namespace replacement plan missing");
            }
            expect(scaleBundlePlan).toMatchObject({
              participantCount: 4_097,
              advanceGeneration: true,
              retainedGenerationCount: 2,
            });
            const scaleGenerationKey = new Uint8Array(32).fill(0x96);
            const scaleGenerationHead = domainNamespaceGenerationHeadDigest(
              crypto,
              {
                serverId: v2ServerId,
                namespaceId: namespaceId(namespaceValue),
                keyClass: "ai",
                accessRevision: accessRevision(
                  scaleBundlePlan.namespaceAccessRevision,
                ),
                generation: namespaceGeneration(
                  scaleBundlePlan.namespaceCurrentGeneration,
                ),
                previousHeadDigest: v2GenerationHead,
                generationKey: scaleGenerationKey,
              },
            );
            const scaleRetained = [
              v2Retained[0]!,
              Object.freeze({
                generation: namespaceGeneration(
                  scaleBundlePlan.namespaceCurrentGeneration,
                ),
                accessRevision: accessRevision(
                  scaleBundlePlan.namespaceAccessRevision,
                ),
                headDigest: scaleGenerationHead,
                generationKey: scaleGenerationKey,
              }),
            ];
            const scaleRetainedDigest =
              domainNamespaceRetainedAuthoritySetDigest(crypto, scaleRetained);
            const scaleBundle = prepareDomainNamespaceBundle(crypto, {
              operationId: `m314-scale-bundle:${randomUUID()}`,
              bundle: {
                formatVersion: 2,
                purpose: "domain_key.namespace_bundle",
                serverId: v2ServerId,
                cryptoDomainId: cryptoDomainId(scaleBundlePlan.domainId),
                participantDigest: scaleBundlePlan.participantDigest,
                participantCount: scaleBundlePlan.participantCount,
                keyClass: scaleBundlePlan.keyClass,
                domainKeyGeneration: scaleBundlePlan.domainKeyGeneration,
                domainAuthorizationRevision: authorizationRevision(
                  scaleBundlePlan.domainAuthorizationRevision,
                ),
                domainHeadDigest: scaleBundlePlan.domainHeadDigest,
                namespaceId: namespaceId(scaleBundlePlan.namespaceId),
                namespaceAccessRevision: accessRevision(
                  scaleBundlePlan.namespaceAccessRevision,
                ),
                namespaceCurrentGeneration: namespaceGeneration(
                  scaleBundlePlan.namespaceCurrentGeneration,
                ),
                bundleRevision: scaleBundlePlan.bundleRevision,
                retainedGenerationCount: scaleRetained.length,
                retainedAuthoritySetDigest: scaleRetainedDigest,
                retainedGenerations: scaleRetained,
              },
              previousBindingDigest: scaleBundlePlan.previousBindingDigest,
              issuerHumanId: humanId(scaleBundlePlan.issuerHumanId),
              issuerDeviceId: cryptoDeviceId(scaleBundlePlan.issuerDeviceId),
              issuerDeviceSigningGeneration:
                scaleBundlePlan.issuerDeviceSigningGeneration,
              issuerSigningPrivateKey: signing.privateKey,
              issuerSigningPublicKey: signing.publicKey,
              domainKey: scaleDomainKey,
              issuedAt: now + 23,
            });
            try {
              expect((await namespaceProduct.withCurrentHumanAiReadableRoom({
                subjectUserId: userId,
                subjectHumanId: humanActorId,
                roomId,
                namespaceId: namespaceValue,
                use: (authority) => v2Repository.publishNamespaceBundle({
                  authority,
                  keyClass: "ai",
                  clientDeviceId: deviceId,
                  operationId: scaleBundle.binding.operationId,
                  idempotencyKey: `m314-scale-bundle:${randomUUID()}`,
                  bindingBytes: scaleBundle.bytes,
                  now: now + 24,
                }),
              }))?.status).toBe("published");
              expect((await namespaceProduct.withCurrentHumanAiReadableRoom({
                subjectUserId: userId,
                subjectHumanId: humanActorId,
                roomId,
                namespaceId: namespaceValue,
                use: (authority) => v2Repository.planNamespaceBundle({
                  authority,
                  keyClass: "ai",
                  clientDeviceId: deviceId,
                }),
              }))?.status).toBe("ready");

              expect(await v2Repository.inspectForegroundAuthority({
                namespaceIds: [namespaceValue],
                keyClass: "ai",
                subjectHumanId: targetHumanId,
                deviceId: targetDeviceId,
              })).toEqual({
                status: "unavailable",
                reason: "recipient_sync_required",
                requiredNamespaceIds: [namespaceValue],
              });
              const targetPublicKeyDigest = crypto.hash(
                targetEncryption.publicKey,
              );
              const targetRequest = prepareDomainKeyAccessRequest(crypto, {
                formatVersion: 2,
                purpose: "domain_key.access_request",
                requestId: `m314-scale-request:${randomUUID()}`,
                serverId: v2ServerId,
                humanId: humanId(targetHumanId),
                deviceId: cryptoDeviceId(targetDeviceId),
                deviceSigningKeyGeneration: 1,
                cryptoDomainId: cryptoDomainId(scaleHeadPlan.domainId),
                participantDigest: scaleHeadPlan.participantDigest,
                participantCount: scaleHeadPlan.participantCount,
                keyClass: "ai",
                domainKeyGeneration: scaleHeadPlan.domainKeyGeneration,
                authorizationRevision: authorizationRevision(
                  scaleHeadPlan.authorizationRevision,
                ),
                headDigest: scaleHead.digest,
                recipientKeyId: targetDeviceId,
                recipientKeyGeneration: 1,
                recipientPublicKeyDigest: targetPublicKeyDigest,
                issuedAt: unixTimestamp(now + 25),
                expiresAt: unixTimestamp(now + 25 + 30_000),
                signingPrivateKey: targetSigning.privateKey,
              });
              try {
                expect((await namespaceProduct.withCurrentHumanAiReadableRoom({
                  subjectUserId: targetUserId,
                  subjectHumanId: targetHumanId,
                  roomId,
                  namespaceId: namespaceValue,
                  use: (authority) => v2Repository.requestRecipient({
                    authority,
                    keyClass: "ai",
                    clientDeviceId: targetDeviceId,
                    requestId: targetRequest.value.requestId,
                    idempotencyKey: `m314-scale-request:${randomUUID()}`,
                    requestBytes: targetRequest.bytes,
                    now: now + 25,
                  }),
                }))?.status).toBe("requested");
                const pendingScaleRequests = await namespaceProduct
                  .withCurrentHumanAiReadableRoom({
                    subjectUserId: userId,
                    subjectHumanId: humanActorId,
                    roomId,
                    namespaceId: namespaceValue,
                    use: (authority) => v2Repository.listPendingRequests({
                      authority,
                      keyClass: "ai",
                      clientDeviceId: deviceId,
                      now: now + 26,
                    }),
                  });
                expect(pendingScaleRequests).toHaveLength(1);
                const pendingScaleRequest = pendingScaleRequests?.[0];
                if (pendingScaleRequest === undefined) {
                  throw new Error("M314 incremental recipient request missing");
                }
                expect(pendingScaleRequest).toMatchObject({
                  requestId: targetRequest.value.requestId,
                  recipientHumanId: targetHumanId,
                  recipientDeviceId: targetDeviceId,
                });
                const targetEnvelope = await prepareDomainKeyRecipientEnvelope(
                  crypto,
                  {
                    head: scaleHead.head,
                    headDigest: scaleHead.digest,
                    recipient: {
                      recipientHumanId: humanId(
                        pendingScaleRequest.recipientHumanId,
                      ),
                      recipientKind: "device",
                      recipientKeyId: pendingScaleRequest.recipientDeviceId,
                      recipientKeyGeneration:
                        pendingScaleRequest.recipientDeviceGeneration,
                      recipientPublicKey:
                        pendingScaleRequest.recipientEncryptionPublicKey,
                      recipientPublicKeyDigest:
                        pendingScaleRequest.recipientPublicKeyDigest,
                    },
                    domainKey: scaleDomainKey,
                    issuerHumanId: humanId(humanActorId),
                    issuerDeviceId: cryptoDeviceId(deviceId),
                    issuerDeviceSigningGeneration: 1,
                    issuerSigningPublicKey: signing.publicKey,
                    issuerSigningPrivateKey: signing.privateKey,
                  },
                );
                const targetAuthorization =
                  prepareDomainKeyRecipientAuthorization(crypto, {
                    authorizationOperationId:
                      pendingScaleRequest.requestId,
                    reason: "catch_up",
                    requestDigest: pendingScaleRequest.requestDigest,
                    envelopeBytes: targetEnvelope.bytes,
                    envelopeDigest: targetEnvelope.digest,
                    issuerHumanId: humanId(humanActorId),
                    issuerDeviceId: cryptoDeviceId(deviceId),
                    issuerDeviceSigningGeneration: 1,
                    issuedAt: now + 26,
                    deadlineAt: now + 26 + 30_000,
                    issuerSigningPublicKey: signing.publicKey,
                    issuerSigningPrivateKey: signing.privateKey,
                  });
                try {
                  expect((await namespaceProduct
                    .withCurrentHumanAiReadableRoom({
                      subjectUserId: userId,
                      subjectHumanId: humanActorId,
                      roomId,
                      namespaceId: namespaceValue,
                      use: (authority) =>
                        v2Repository.fulfilRecipientRequest({
                          authority,
                          keyClass: "ai",
                          clientDeviceId: deviceId,
                          requestId: pendingScaleRequest.requestId,
                          authorizationBytes: targetAuthorization.bytes,
                          now: now + 27,
                        }),
                    }))?.status).toBe("fulfilled");
                  const fetchedTargetEnvelope = await namespaceProduct
                    .withCurrentHumanAiReadableRoom({
                      subjectUserId: targetUserId,
                      subjectHumanId: targetHumanId,
                      roomId,
                      namespaceId: namespaceValue,
                      use: (authority) => v2Repository.fetchEnvelope({
                        authority,
                        keyClass: "ai",
                        clientDeviceId: targetDeviceId,
                        now: now + 28,
                      }),
                    });
                  expect(fetchedTargetEnvelope?.status).toBe("ready");
                  if (fetchedTargetEnvelope?.status !== "ready") {
                    throw new Error("M314 incremental target envelope missing");
                  }
                  const [targetDevice] = await adminDatabase.select({
                    deviceGeneration:
                      schema.humanCryptoDevices.deviceGeneration,
                    revision: schema.humanCryptoDevices.revision,
                  }).from(schema.humanCryptoDevices).where(eq(
                    schema.humanCryptoDevices.deviceId,
                    targetDeviceId,
                  )).limit(1);
                  if (targetDevice === undefined) {
                    throw new Error("M314 target device missing after enrollment");
                  }
                  const targetAcknowledgement =
                    prepareDomainKeyAcknowledgement(crypto, {
                      formatVersion: 2,
                      purpose: "domain_key.acknowledgement",
                      acknowledgementId: `m314-scale-ack:${randomUUID()}`,
                      serverId: v2ServerId,
                      humanId: humanId(targetHumanId),
                      deviceId: cryptoDeviceId(targetDeviceId),
                      deviceSigningKeyGeneration:
                        targetDevice.deviceGeneration,
                      cryptoDomainId: cryptoDomainId(scaleHeadPlan.domainId),
                      participantDigest: scaleHeadPlan.participantDigest,
                      participantCount: scaleHeadPlan.participantCount,
                      keyClass: "ai",
                      domainKeyGeneration: scaleHeadPlan.domainKeyGeneration,
                      authorizationRevision: authorizationRevision(
                        scaleHeadPlan.authorizationRevision,
                      ),
                      headDigest: scaleHead.digest,
                      recipientKeyId: targetDeviceId,
                      recipientKeyGeneration: targetDevice.deviceGeneration,
                      recipientPublicKeyDigest: targetPublicKeyDigest,
                      requestDigest: fetchedTargetEnvelope.requestDigest,
                      envelopeDigest: fetchedTargetEnvelope.envelopeDigest,
                      processedDeviceRevision: targetDevice.revision,
                      issuedAt: unixTimestamp(now + 29),
                      expiresAt: unixTimestamp(now + 29 + 30_000),
                      signingPrivateKey: targetSigning.privateKey,
                    });
                  try {
                    expect((await namespaceProduct
                      .withCurrentHumanAiReadableRoom({
                        subjectUserId: targetUserId,
                        subjectHumanId: targetHumanId,
                        roomId,
                        namespaceId: namespaceValue,
                        use: (authority) => v2Repository.acknowledgeEnvelope({
                          authority,
                          keyClass: "ai",
                          clientDeviceId: targetDeviceId,
                          acknowledgementBytes: targetAcknowledgement.bytes,
                          now: now + 29,
                        }),
                      }))?.status).toBe("acknowledged");
                    const targetAuthority =
                      await v2Repository.inspectForegroundAuthority({
                        namespaceIds: [namespaceValue],
                        keyClass: "ai",
                        subjectHumanId: targetHumanId,
                        deviceId: targetDeviceId,
                      });
                    expect(targetAuthority.status).toBe("ready");
                    if (targetAuthority.status !== "ready") {
                      throw new Error("M314 target authority did not converge");
                    }
                    expect(targetAuthority.domains).toHaveLength(1);
                    expect(targetAuthority.domains[0]).toMatchObject({
                      domainId: scaleHeadPlan.domainId,
                      participantCount: 4_097,
                    });
                    targetAuthority.domains.forEach((domain) => {
                      domain.participantDigest.fill(0);
                      domain.headDigest.fill(0);
                      domain.activeNamespaceBindingSetDigest.fill(0);
                    });
                    const [scaleEnvelopeCount] = await admin.unsafe<{
                      count: number;
                    }[]>(
                      `SELECT count(*)::integer AS count
                         FROM domain_key_recipient_envelopes
                        WHERE domain_id = $1 AND key_class = 'ai'`,
                      [scaleHeadPlan.domainId],
                    );
                    expect(scaleEnvelopeCount?.count).toBe(3);
                  } finally {
                    targetAcknowledgement.bytes.fill(0);
                    targetAcknowledgement.digest.fill(0);
                  }
                } finally {
                  destroyDomainKeyRecipientAuthorizationV2(
                    targetAuthorization.authorization,
                  );
                  destroyDomainKeyRecipientEnvelopeV2(targetEnvelope.envelope);
                  targetAuthorization.bytes.fill(0);
                  targetAuthorization.digest.fill(0);
                  targetEnvelope.bytes.fill(0);
                  targetEnvelope.digest.fill(0);
                }
              } finally {
                destroyDomainKeyAccessRequestV2(targetRequest.value);
                targetRequest.bytes.fill(0);
                targetRequest.digest.fill(0);
                targetPublicKeyDigest.fill(0);
              }
            } finally {
              scaleGenerationKey.fill(0);
              scaleGenerationHead.fill(0);
              scaleRetainedDigest.fill(0);
              scaleBundle.bytes.fill(0);
            }
          } finally {
            destroyDomainKeyRecipientAuthorizationV2(
              scaleRecoveryAuthorization.authorization,
            );
            destroyDomainKeyRecipientAuthorizationV2(
              scaleSourceAuthorization.authorization,
            );
            destroyDomainKeyRecipientEnvelopeV2(scaleRecoveryEnvelope.envelope);
            destroyDomainKeyRecipientEnvelopeV2(scaleSourceEnvelope.envelope);
            destroyDomainKeyHeadV2(scaleHead.head);
            scaleRecoveryAuthorization.bytes.fill(0);
            scaleRecoveryAuthorization.digest.fill(0);
            scaleSourceAuthorization.bytes.fill(0);
            scaleSourceAuthorization.digest.fill(0);
            scaleRecoveryEnvelope.bytes.fill(0);
            scaleRecoveryEnvelope.digest.fill(0);
            scaleSourceEnvelope.bytes.fill(0);
            scaleSourceEnvelope.digest.fill(0);
            scaleHead.bytes.fill(0);
            scaleHead.digest.fill(0);
            scaleDomainKey.fill(0);
          }
        } finally {
          targetMembershipVault?.destroy();
          targetSigning.privateKey.fill(0);
          targetEncryption.privateKey.fill(0);
          targetRecovery.privateKey.fill(0);
          if (scaleDomainId !== null) {
            await adminCleanupDatabase.delete(namespaceDomainKeyHeads)
              .where(eq(namespaceDomainKeyHeads.domainId, scaleDomainId));
            await adminCleanupDatabase.delete(namespaceDomainKeyBindings)
              .where(eq(namespaceDomainKeyBindings.domainId, scaleDomainId));
            await adminCleanup.unsafe(
              `DELETE FROM domain_key_envelope_acknowledgements
                WHERE domain_id = $1`,
              [scaleDomainId],
            );
            await adminCleanup.unsafe(
              `DELETE FROM domain_key_recipient_envelopes WHERE domain_id = $1`,
              [scaleDomainId],
            );
            await adminCleanup.unsafe(
              `DELETE FROM domain_key_recipient_requests WHERE domain_id = $1`,
              [scaleDomainId],
            );
            await adminCleanup.unsafe(
              `DELETE FROM domain_key_heads WHERE domain_id = $1`,
              [scaleDomainId],
            );
            await adminCleanup.unsafe(
              `DELETE FROM domain_key_publication_operations WHERE domain_id = $1`,
              [scaleDomainId],
            );
            await adminCleanupDatabase.delete(cryptoDomains)
              .where(eq(cryptoDomains.id, scaleDomainId));
          }
          await adminCleanup.unsafe(
            `DELETE FROM human_crypto_device_group_acknowledgements
              WHERE human_id = $1`,
            [targetHumanId],
          );
          await adminCleanup.unsafe(
            `DELETE FROM human_crypto_device_group_welcomes WHERE human_id = $1`,
            [targetHumanId],
          );
          await adminCleanup.unsafe(
            `DELETE FROM human_crypto_device_group_commits WHERE human_id = $1`,
            [targetHumanId],
          );
          await adminCleanup.unsafe(
            `DELETE FROM human_crypto_device_group_join_requests
              WHERE human_id = $1`,
            [targetHumanId],
          );
          await adminCleanup.unsafe(
            `DELETE FROM human_crypto_device_group_heads WHERE human_id = $1`,
            [targetHumanId],
          );
          await adminCleanup.unsafe(
            `DELETE FROM human_crypto_device_key_packages WHERE device_id = $1`,
            [targetDeviceId],
          );
          await adminCleanup.unsafe(
            `DELETE FROM human_crypto_recovery_keys WHERE human_id = $1`,
            [targetHumanId],
          );
          await adminCleanup.unsafe(
            `DELETE FROM human_crypto_devices WHERE human_id = $1`,
            [targetHumanId],
          );
          await adminCleanup.unsafe(
            `DELETE FROM human_crypto_custodies WHERE human_id = $1`,
            [targetHumanId],
          );
          for (let offset = 0; offset < scaleHumanIds.length;
            offset += scaleChunkSize) {
            const humanChunk = scaleHumanIds.slice(
              offset,
              offset + scaleChunkSize,
            );
            await adminCleanup.unsafe(
              `DELETE FROM room_members
                WHERE room_id = $1 AND actor_id = ANY($2::uuid[])`,
              [roomId, humanChunk],
            );
            await adminCleanup.unsafe(
              `DELETE FROM actors WHERE id = ANY($1::uuid[])`,
              [humanChunk],
            );
            await adminCleanup.unsafe(
              `DELETE FROM users WHERE id = ANY($1::uuid[])`,
              [scaleUserIds.slice(offset, offset + scaleChunkSize)],
            );
          }
          await adminCleanupDatabase.update(rooms).set({
            kind: "private",
            humanActorIds: [humanActorId],
            namespaceAccessRevision: beforeTransitionRoom.namespaceAccessRevision,
          }).where(eq(rooms.id, roomId));
        }
      }
      await adminDatabase.update(encryptionTransitionPolicy).set({ mode: "plaintext_only",
        shadowBehavior: "fallback",
        shadowEncryptionStartedAt: null,
        revision: sql`${encryptionTransitionPolicy.revision} + 1`, updatedAt: sql`CURRENT_TIMESTAMP`,
      }).where(eq(encryptionTransitionPolicy.id, "server"));
      let plaintextKeyCallbacks = 0;
      const plaintextPlanner = new PostgresLiveShadowTurnPlanner(
        productConnection,
        Object.freeze({ ...restrictedConnection,
          query: async () => { throw new Error("Plaintext queried crypto"); } }),
        crypto,
        recipients,
        { serverId: v2ServerId,
          resolveReadableNamespaces: async () => {
            plaintextKeyCallbacks += 1;
            return [namespaceValue];
          },
          foregroundAuthorizations: { inspectReusable: () => null } },
      );
      expect(await plaintextPlanner.plan({ ...fullTurnInput,
        idempotencyKey: `plaintext-${randomUUID()}` })).toEqual({
          status: "disabled", mode: "plaintext_only",
        });
      expect(plaintextKeyCallbacks).toBe(0);
      lifecycleDigest.fill(0);
      v2DomainKey.fill(0);
      v2RetainedDigest.fill(0);
      v2Retained.forEach((entry) => entry.generationKey.fill(0));

      destroyDomainKeyRecipientAuthorizationV2(
        v2RecoveryAuthorization.authorization,
      );
      destroyDomainKeyRecipientAuthorizationV2(v2Authorization.authorization);
      destroyDomainKeyRecipientEnvelopeV2(v2RecoveryEnvelope.envelope);
      destroyDomainKeyRecipientEnvelopeV2(v2Envelope.envelope);
      destroyDomainKeyHeadV2(v2Head.head);
      v2RecoveryAuthorization.bytes.fill(0);
      v2RecoveryAuthorization.digest.fill(0);
      v2Authorization.bytes.fill(0);
      v2Authorization.digest.fill(0);
      v2RecoveryEnvelope.bytes.fill(0);
      v2RecoveryEnvelope.digest.fill(0);
      v2Envelope.bytes.fill(0);
      v2Envelope.digest.fill(0);
      v2Head.bytes.fill(0);
      v2Head.digest.fill(0);
    } catch (error) {
      primaryFailure = error;
      throw error;
    } finally {
      try {
      signing.privateKey.fill(0);
      encryption.privateKey.fill(0);
      secondSigning.privateKey.fill(0);
      secondEncryption.privateKey.fill(0);
      recovery.privateKey.fill(0);
      membershipVault?.destroy();
      if (repairMessageId !== null) {
        await adminCleanupDatabase.delete(sessionMessageCryptoRevisions)
          .where(eq(sessionMessageCryptoRevisions.messageId, repairMessageId));
        await adminCleanupDatabase.delete(sessionMessages)
          .where(eq(sessionMessages.id, repairMessageId));
      }
      if (reverseRecordId !== null) {
        await adminCleanupDatabase.update(reflectionRecords).set({
          disposition: "purged", updatedAt: new Date(),
        }).where(eq(reflectionRecords.recordId, reverseRecordId));
        // Reflection publications are immutable receipts. Canonical purge
        // preserves the Record and its receipt/dependency graph; a disposable
        // integration database owns their eventual physical teardown.
      }
      if (reverseRollupId !== null) {
        await adminCleanupDatabase.delete(roomEventRollups)
          .where(eq(roomEventRollups.id, reverseRollupId));
      }
      await adminCleanupDatabase.delete(objectCryptoAccessHeads)
        .where(eq(objectCryptoAccessHeads.objectId, repairObjectId));
      await adminCleanupDatabase.delete(objectCryptoNamespaceEnvelopes)
        .where(eq(objectCryptoNamespaceEnvelopes.objectId, repairObjectId));
      await adminCleanupDatabase.delete(objectCryptoAccessManifests)
        .where(eq(objectCryptoAccessManifests.objectId, repairObjectId));
      await adminCleanupDatabase.delete(cryptoObjects)
        .where(eq(cryptoObjects.objectId, repairObjectId));
      await adminCleanupDatabase
        .delete(objectCryptoAccessHeads)
        .where(eq(objectCryptoAccessHeads.objectId, agentObjectId));
      await adminCleanupDatabase
        .delete(objectCryptoNamespaceEnvelopes)
        .where(eq(objectCryptoNamespaceEnvelopes.objectId, agentObjectId));
      await adminCleanupDatabase
        .delete(objectCryptoAccessManifests)
        .where(eq(objectCryptoAccessManifests.objectId, agentObjectId));
      await adminCleanupDatabase
        .delete(cryptoObjects)
        .where(eq(cryptoObjects.objectId, agentObjectId));
      await adminCleanupDatabase
        .delete(namespaceDomainKeyHeads)
        .where(
          like(namespaceDomainKeyHeads.domainId, `${capacityDomainPrefix}%`),
        );
      await adminCleanupDatabase
        .delete(namespaceDomainKeyBindings)
        .where(
          like(namespaceDomainKeyBindings.domainId, `${capacityDomainPrefix}%`),
        );
      await admin.begin(async (tx) => {
        await tx.unsafe(
          `DELETE FROM conversation_shadow_turn_operations
            WHERE room_id = $1`,
          [roomId],
        );
        await tx.unsafe(
          `DELETE FROM conversation_shadow_turn_plan_attempts
            WHERE room_id = $1`,
          [roomId],
        );
        await tx.unsafe(
          `DELETE FROM conversation_shared_agent_shadow_operations
            WHERE room_id = $1`,
          [roomId],
        );
        await tx.unsafe(
          `DELETE FROM conversation_shared_agent_shadow_plan_attempts
            WHERE room_id = $1`,
          [roomId],
        );
        await tx.unsafe(
          `DELETE FROM namespace_domain_key_heads
            WHERE namespace_id = $1`,
          [namespaceValue],
        );
        await tx.unsafe(
          `DELETE FROM namespace_domain_key_bindings
            WHERE namespace_id = $1`,
          [namespaceValue],
        );
        await tx.unsafe(
          `DELETE FROM domain_key_envelope_acknowledgements
            WHERE recipient_device_id = $1`,
          [deviceId],
        );
        await tx.unsafe(
          `DELETE FROM domain_key_recipient_envelopes
            WHERE issuer_human_id = $1 OR recipient_human_id = $1`,
          [humanActorId],
        );
        await tx.unsafe(
          `DELETE FROM domain_key_recipient_requests
            WHERE recipient_human_id = $1`,
          [humanActorId],
        );
        await tx.unsafe(
          `DELETE FROM domain_key_heads
            WHERE issuer_human_id = $1`,
          [humanActorId],
        );
        await tx.unsafe(
          `DELETE FROM domain_key_publication_operations
            WHERE issuer_human_id = $1`,
          [humanActorId],
        );
        await tx.unsafe(
          `DELETE FROM human_crypto_device_group_acknowledgements
            WHERE human_id = $1`,
          [humanActorId],
        );
        await tx.unsafe(
          `DELETE FROM human_crypto_device_group_welcomes
            WHERE human_id = $1`,
          [humanActorId],
        );
        await tx.unsafe(
          `DELETE FROM human_crypto_device_group_commits
            WHERE human_id = $1`,
          [humanActorId],
        );
        await tx.unsafe(
          `DELETE FROM human_crypto_device_group_join_requests
            WHERE human_id = $1`,
          [humanActorId],
        );
        await tx.unsafe(
          `DELETE FROM human_crypto_device_group_heads
            WHERE human_id = $1`,
          [humanActorId],
        );
        await tx.unsafe(
          `DELETE FROM human_crypto_device_key_packages
            WHERE device_id = $1`,
          [deviceId],
        );
        await tx.unsafe(
          `DELETE FROM human_crypto_recovery_keys
            WHERE human_id = $1`,
          [humanActorId],
        );
        await tx.unsafe(
          `DELETE FROM human_crypto_devices
            WHERE human_id = $1`,
          [humanActorId],
        );
        await tx.unsafe(
          `DELETE FROM human_crypto_custodies
            WHERE human_id = $1`,
          [humanActorId],
        );
        await tx.unsafe(`DELETE FROM room_members WHERE room_id = $1`, [roomId]);
        await tx.unsafe(`DELETE FROM sessions WHERE room_id = $1`, [roomId]);
        await tx.unsafe(`DELETE FROM rooms WHERE id = $1`, [roomId]);
        await tx.unsafe(`DELETE FROM namespaces WHERE id = $1`, [namespaceValue]);
        await tx.unsafe(`DELETE FROM actors WHERE owner_id = $1`, [userId]);
        await tx.unsafe(`DELETE FROM agents WHERE id = $1`, [agentId]);
        await tx.unsafe(`DELETE FROM users WHERE id = $1`, [userId]);
      });
      await adminCleanupDatabase
        .delete(cryptoDomains)
        .where(like(cryptoDomains.id, `${capacityDomainPrefix}%`));
      } catch (cleanupError) {
        // Preserve the assertion or protocol error that initiated cleanup.
        // Cleanup errors remain actionable when the test body itself passed.
        // eslint-disable-next-line no-unsafe-finally -- deliberate error precedence
        if (primaryFailure === undefined) throw cleanupError;
      } finally {
        await adminCleanupDatabase.update(encryptionTransitionPolicy).set({
          mode: originalPolicy.mode,
          shadowBehavior: originalPolicy.shadowBehavior,
          shadowEncryptionStartedAt: originalPolicy.shadowEncryptionStartedAt,
          revision: sql`${encryptionTransitionPolicy.revision} + 1`,
          updatedAt: new Date(),
        }).where(eq(encryptionTransitionPolicy.id, "server"));
      }
    }
  });
});
