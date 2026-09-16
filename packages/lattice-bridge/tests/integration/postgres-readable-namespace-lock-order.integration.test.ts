import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, asc, eq, inArray } from "drizzle-orm";
import * as schema from "@nautilo/db/schema";
import type {
  PostgresJsBridgeConnection,
  PostgresJsBridgeExecutor,
  PostgresJsBridgeRow,
  PostgresJsBridgeScalar,
} from "@nautilo/db";
import {
  acquireRoomWriteLock,
  actors,
  agents,
  compareAndSwapEncryptionTransitionPolicy,
  createPostgresJsCanonicalBridgeConnection,
  getEncryptionTransitionPolicy,
  namespaces,
  roomMembers,
  rooms,
  sessions,
  sessionMessages,
  users,
} from "@nautilo/db";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import type {
  BackgroundAuthorizationIssuerV2,
  BackgroundProcessorWorkDescriptorV2,
} from "@nautilo/lattice-crypto/background";
import type { CanonicalTranscriptTx } from "@nautilo/trust";
import {
  bindConversationProductCanonicalTransactionRunner,
  verifyConversationProductPostgresHandle,
  withCurrentStenographerAuthority,
  type ConversationProductCanonicalTransactionConnection,
  type ConversationProductPostgresExecutor,
  type ConversationProductPostgresIsolationLevel,
} from "../../src/server/index.ts";
import { PostgresNamespaceProductAuthority } from
  "../../src/server/delivery/postgres-namespace-product-authority";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function within<Value>(promise: Promise<Value>): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("lock-order test timed out")), 5_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const admin = postgres(required("LATTICE_BRIDGE_TEST_ADMIN_DATABASE_URL"), {
  max: 1, prepare: false,
});
const singleClient = postgres(required("LATTICE_BRIDGE_TEST_APP_DATABASE_URL"), {
  max: 1, prepare: false,
});
const setClient = postgres(required("LATTICE_BRIDGE_TEST_APP_DATABASE_URL"), {
  max: 1, prepare: false,
});
const subthreadAuthorityClient = postgres(required("LATTICE_BRIDGE_TEST_APP_DATABASE_URL"), {
  max: 1, prepare: false,
});
const membershipClient = postgres(required("LATTICE_BRIDGE_TEST_APP_DATABASE_URL"), {
  max: 1, prepare: false,
});
const stenographerClient = postgres(required("LATTICE_BRIDGE_TEST_APP_DATABASE_URL"), {
  max: 1, prepare: false,
});
const adminDb = drizzle(admin, { schema });
let restorePlaintextPolicy = false;

beforeAll(async () => {
  const policyDb = adminDb as Parameters<typeof compareAndSwapEncryptionTransitionPolicy>[0];
  const policy = await getEncryptionTransitionPolicy(policyDb);
  if (policy.mode !== "plaintext_only") return;
  await compareAndSwapEncryptionTransitionPolicy(policyDb, {
    expectedRevision: policy.revision,
    targetMode: "shadow_encryption",
    targetShadowBehavior: "fallback",
  });
  restorePlaintextPolicy = true;
});

afterAll(async () => {
  try {
    if (restorePlaintextPolicy) {
      const policyDb = adminDb as Parameters<typeof compareAndSwapEncryptionTransitionPolicy>[0];
      const policy = await getEncryptionTransitionPolicy(policyDb);
      await compareAndSwapEncryptionTransitionPolicy(policyDb, {
        expectedRevision: policy.revision,
        targetMode: "plaintext_only",
        targetShadowBehavior: "fallback",
      });
    }
  } finally {
    await Promise.all([
      admin.end(), singleClient.end(), setClient.end(),
      subthreadAuthorityClient.end(), membershipClient.end(),
      stenographerClient.end(),
    ]);
  }
});

async function backendPid(client: postgres.Sql): Promise<number> {
  const [row] = await client<{ pid: number }[]>`
    SELECT pg_backend_pid()::integer AS pid
  `;
  if (row === undefined || !Number.isSafeInteger(row.pid)) {
    throw new Error("lock-order test could not resolve backend PID");
  }
  return row.pid;
}

async function waitForBackendLock(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [activity] = await admin<{
      state: string | null;
      waitEventType: string | null;
    }[]>`
      SELECT state, wait_event_type AS "waitEventType"
        FROM pg_stat_activity
       WHERE pid = ${pid}
    `;
    if (activity?.state === "active" && activity.waitEventType === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("authority backend did not reach a database lock wait");
}

function postgresErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function connection(
  client: postgres.Sql,
  beforeQuery?: (statement: string) => Promise<void>,
  afterQuery?: (statement: string) => void,
): PostgresJsBridgeConnection {
  const executor = (tx: Pick<postgres.Sql, "unsafe">): PostgresJsBridgeExecutor => ({
    query: async <Row extends PostgresJsBridgeRow>(
      statement: string,
      parameters: readonly PostgresJsBridgeScalar[] = [],
    ) => {
      await beforeQuery?.(statement);
      const rows = await tx.unsafe(
        statement,
        parameters as postgres.ParameterOrJSON<never>[],
      ) as unknown as readonly Row[];
      afterQuery?.(statement);
      return rows;
    },
  });
  const transaction = <Value>(
    use: (tx: PostgresJsBridgeExecutor) => Promise<Value>,
    options?: Readonly<{ isolationLevel: "serializable" | "read committed" }>,
  ) => options === undefined
    ? client.begin((tx) => use(executor(tx))) as unknown as Promise<Value>
    : client.begin(`isolation level ${options.isolationLevel}`,
      (tx) => use(executor(tx))) as unknown as Promise<Value>;
  return { ...executor(client), transaction, transactionOnce: transaction };
}

function canonicalConnection(
  client: postgres.Sql,
  beforeQuery: (statement: string) => Promise<void>,
): ConversationProductCanonicalTransactionConnection {
  const database = createPostgresJsCanonicalBridgeConnection(
    drizzle(client, { schema }),
  );
  return {
    transaction: <Result>(
      callback: (
        transaction: CanonicalTranscriptTx,
        executor: ConversationProductPostgresExecutor,
      ) => Promise<Result>,
      options: Readonly<{ isolationLevel: ConversationProductPostgresIsolationLevel }>,
    ): Promise<Result> => database.transaction(
      (transaction, executor) => callback(transaction, {
        query: async (statement, parameters = []) => {
          await beforeQuery(statement);
          return executor.query(statement, parameters);
        },
      }),
      options,
    ),
  };
}

function unavailableRestrictedConnection(): PostgresJsBridgeConnection {
  const restricted: PostgresJsBridgeConnection = {
    query: async () => [],
    transaction: use => use(restricted),
    transactionOnce: use => use(restricted),
  };
  return restricted;
}

describe("readable Namespace product lock order", () => {
  test("Human-AI reads follow the Memory Room-before-actor lock order", async () => {
    const userId = randomUUID();
    const humanId = randomUUID();
    const agentId = randomUUID();
    const agentActorId = randomUUID();
    const roomId = randomUUID();
    const namespaceId = randomUUID();
    let releaseNamespaceRoomAttempt!: () => void;
    const namespaceRoomAttempted = new Promise<void>((resolve) => {
      releaseNamespaceRoomAttempt = resolve;
    });
    let releaseMemoryRoomLocked!: () => void;
    const memoryRoomLocked = new Promise<void>((resolve) => {
      releaseMemoryRoomLocked = resolve;
    });
    let memoryPromise: Promise<void> | undefined;
    let humanAiPromise: Promise<string | null> | undefined;
    try {
      await adminDb.transaction(async (tx) => {
        await tx.insert(users).values({ id: userId, name: "M320 lock-order user" });
        await tx.insert(agents).values({ id: agentId, handle: `m320-lock-${agentId}` });
        await tx.insert(actors).values([
          { id: humanId, ownerId: userId, displayName: "M320 Human",
            trustState: "verified", kind: "user" },
          { id: agentActorId, ownerId: userId, displayName: "M320 Agent",
            trustState: "verified", kind: "agent", agentId },
        ]);
        await tx.insert(namespaces).values({ id: namespaceId, scope: "room", label: "room" });
        await tx.insert(rooms).values({
          id: roomId, ownerId: userId, type: "private", label: "room",
          graphThreadId: `m320:${roomId}`, namespaceId,
          humanActorIds: [humanId], kind: "private", createdBy: humanId,
        });
        await tx.insert(roomMembers).values([
          { roomId, actorId: humanId, roomRole: "admin" },
          { roomId, actorId: agentActorId, roomRole: "member",
            agentResponseMode: "active" },
        ]);
      });

      memoryPromise = drizzle(singleClient).transaction(async (memoryDb) => {
        await acquireRoomWriteLock(memoryDb, roomId);
        releaseMemoryRoomLocked();
        await within(namespaceRoomAttempted);
        await memoryDb.select({ actorId: actors.id })
          .from(roomMembers)
          .innerJoin(actors, eq(roomMembers.actorId, actors.id))
          .where(eq(roomMembers.roomId, roomId))
          .orderBy(asc(actors.id))
          .for("share", { of: [actors, roomMembers] });
      });
      await within(memoryRoomLocked);
      const humanAiAuthority = new PostgresNamespaceProductAuthority(connection(
        setClient,
        async (statement) => {
          if (statement.includes('order by "rooms"."parent_room_id" nulls first')) {
            releaseNamespaceRoomAttempt();
          }
        },
      ));
      const common = { subjectUserId: userId, subjectHumanId: humanId };
      humanAiPromise = humanAiAuthority.withCurrentHumanAiReadableRoom({
        ...common, roomId, namespaceId, use: async () => "human-ai",
      });
      expect(await within(Promise.all([memoryPromise, humanAiPromise])))
        .toEqual([undefined, "human-ai"]);
    } finally {
      releaseNamespaceRoomAttempt();
      await Promise.allSettled([
        memoryPromise ?? Promise.resolve(),
        humanAiPromise ?? Promise.resolve(null),
      ]);
      await adminDb.delete(rooms).where(eq(rooms.id, roomId));
      await adminDb.delete(namespaces).where(eq(namespaces.id, namespaceId));
      await adminDb.delete(actors).where(inArray(actors.id, [humanId, agentActorId]));
      await adminDb.delete(agents).where(eq(agents.id, agentId));
      await adminDb.delete(users).where(eq(users.id, userId));
    }
  });

  test("Stenographer authority does not lock its Human before the Room", async () => {
    const userId = randomUUID();
    const humanId = randomUUID();
    const agentId = randomUUID();
    const agentActorId = randomUUID();
    const roomId = randomUUID();
    const namespaceId = randomUUID();
    let releaseStenographerRoomAttempt!: () => void;
    const stenographerRoomAttempted = new Promise<void>((resolve) => {
      releaseStenographerRoomAttempt = resolve;
    });
    let releaseCanonicalRoomLocked!: () => void;
    const canonicalRoomLocked = new Promise<void>((resolve) => {
      releaseCanonicalRoomLocked = resolve;
    });
    let canonicalPromise: Promise<string | null> | undefined;
    let stenographerPromise: Promise<string | null> | undefined;
    let recipientPrivateKey: Uint8Array | undefined;
    try {
      await adminDb.transaction(async (tx) => {
        await tx.insert(users).values({ id: userId, name: "M317 lock-order user" });
        await tx.insert(agents).values({ id: agentId, handle: `m317-lock-${agentId}` });
        await tx.insert(actors).values([
          { id: humanId, ownerId: userId, displayName: "M317 Human",
            trustState: "verified", kind: "user" },
          { id: agentActorId, ownerId: userId, displayName: "M317 Agent",
            trustState: "verified", kind: "agent", agentId },
        ]);
        await tx.insert(namespaces).values({ id: namespaceId, scope: "room", label: "room" });
        await tx.insert(rooms).values({
          id: roomId, ownerId: userId, type: "private", label: "room",
          graphThreadId: `m317:${roomId}`, namespaceId,
          humanActorIds: [humanId], kind: "private", createdBy: humanId,
        });
        await tx.insert(roomMembers).values([
          { roomId, actorId: humanId, roomRole: "admin" },
          { roomId, actorId: agentActorId, roomRole: "member",
            agentResponseMode: "active" },
        ]);
      });

      const canonicalAuthority = new PostgresNamespaceProductAuthority(connection(
        singleClient,
        async (statement) => {
          if (statement.includes("m290_namespace_key_readable_actor")) {
            await within(stenographerRoomAttempted);
          }
        },
        (statement) => {
          if (statement.includes('order by "rooms"."parent_room_id" nulls first')) {
            releaseCanonicalRoomLocked();
          }
        },
      ));
      canonicalPromise = canonicalAuthority.withCurrentReadableNamespace({
        subjectUserId: userId,
        subjectHumanId: humanId,
        sourceRoomId: roomId,
        namespaceId,
        keyClass: "ai",
        use: async () => "canonical",
      });
      await within(canonicalRoomLocked);

      const handle = await verifyConversationProductPostgresHandle(
        connection(stenographerClient),
      );
      const runner = bindConversationProductCanonicalTransactionRunner(
        handle,
        canonicalConnection(stenographerClient, async (statement) => {
          if (statement.includes('order by "rooms"."parent_room_id" nulls first')) {
            releaseStenographerRoomAttempt();
          }
        }),
      );
      const policyDb = adminDb as Parameters<typeof compareAndSwapEncryptionTransitionPolicy>[0];
      const policy = await getEncryptionTransitionPolicy(policyDb);
      const now = Date.now();
      const crypto = new LatticeCrypto();
      const recipient = await crypto.generateEncryptionKeyPair();
      recipientPrivateKey = recipient.privateKey;
      const domainId = randomUUID();
      const descriptor: BackgroundProcessorWorkDescriptorV2 = {
        formatVersion: 2,
        requestId: `m317-request-${randomUUID()}`,
        recipientGeneration: 1,
        workKind: "stenographer.extraction",
        workId: `m317-work-${randomUUID()}`,
        anchorNamespaceId: namespaceId,
        anchorDomainId: domainId,
        subject: {kind: "processor", processorKind: "stenographer", processorVersion: 1},
        operations: ["decrypt", "encrypt"],
        purpose: "journal.extract",
        authority: {
          serverId: "m317-lock-order-server",
          roomId,
          namespaceId,
          namespaceAccessRevision: 0,
          namespaceKeyGeneration: 1,
          namespaceHeadDigest: new Uint8Array(32).fill(0x11),
          domainId,
          domainKeyGeneration: 1,
          domainAuthorizationRevision: 1,
          domainHeadDigest: new Uint8Array(32).fill(0x12),
          bundleRevision: 1,
          bundleDigest: new Uint8Array(32).fill(0x13),
        },
        policyRevision: policy.revision,
        source: {
          kind: "stenographer_work",
          startSequence: 1,
          endSequence: 1,
          rebuildGeneration: 0,
          fingerprint: new Uint8Array(32).fill(0x14),
        },
        inputBindings: [{objectId: `m317-input-${randomUUID()}`, namespaceId}],
        outputSlots: [{
          objectId: `m317-output-${randomUUID()}`,
          objectType: "nautilo.reflection.record.v1",
          createdAt: now,
          namespaceIds: [namespaceId],
        }],
        maximumPlaintextBytes: 1024,
        maximumCiphertextBytes: 2048,
        recipientKeyId: `m317-recipient-${randomUUID()}`,
        recipientPublicKey: recipient.publicKey,
        issuedAt: now,
        notBefore: now,
        expiresAt: now + 60_000,
        idempotencyId: `m317-idempotency-${randomUUID()}`,
      };
      const issuer: BackgroundAuthorizationIssuerV2 = {
        humanId,
        deviceId: `m317-device-${randomUUID()}`,
        deviceGeneration: 1,
        serverInstanceId: randomUUID(),
        lineageGeneration: 1,
        epoch: 1,
        securityRevision: 1,
        headDigest: new Uint8Array(32).fill(0x21),
        signingPublicKeyHash: new Uint8Array(32).fill(0x22),
      };
      stenographerPromise = withCurrentStenographerAuthority({
        runner,
        restricted: unavailableRestrictedConnection(),
        crypto,
        serverScope: descriptor.authority.serverId,
        descriptor,
        issuer,
        now: () => now,
        use: async () => "stenographer",
      });

      expect(await within(Promise.all([canonicalPromise, stenographerPromise])))
        .toEqual(["canonical", null]);
    } finally {
      releaseStenographerRoomAttempt();
      recipientPrivateKey?.fill(0);
      await Promise.allSettled([
        canonicalPromise ?? Promise.resolve(null),
        stenographerPromise ?? Promise.resolve(null),
      ]);
      await adminDb.delete(rooms).where(eq(rooms.id, roomId));
      await adminDb.delete(namespaces).where(eq(namespaces.id, namespaceId));
      await adminDb.delete(actors).where(inArray(actors.id, [humanId, agentActorId]));
      await adminDb.delete(agents).where(eq(agents.id, agentId));
      await adminDb.delete(users).where(eq(users.id, userId));
    }
  });

  test("single and set reads lock opposite source/target Rooms in the same order", async () => {
    const userId = randomUUID();
    const humanId = randomUUID();
    const agentId = randomUUID();
    const agentActorId = randomUUID();
    const sourceRoomId = randomUUID();
    const targetRoomId = randomUUID();
    const sourceNamespaceId = randomUUID();
    const targetNamespaceId = randomUUID();
    let releaseSetRoomAttempt!: () => void;
    const setRoomAttempted = new Promise<void>((resolve) => {
      releaseSetRoomAttempt = resolve;
    });
    let releaseSingleRoomsLocked!: () => void;
    const singleRoomsLocked = new Promise<void>((resolve) => {
      releaseSingleRoomsLocked = resolve;
    });
    let singlePromise: Promise<string | null> | undefined;
    let setPromise: Promise<string | null> | undefined;
    try {
      await adminDb.transaction(async (tx) => {
        await tx.insert(users).values({ id: userId, name: "M318 lock-order user" });
        await tx.insert(agents).values({ id: agentId, handle: `m318-lock-${agentId}` });
        await tx.insert(actors).values([
          { id: humanId, ownerId: userId, displayName: "M318 Human",
            trustState: "verified", kind: "user" },
          { id: agentActorId, ownerId: userId, displayName: "M318 Agent",
            trustState: "verified", kind: "agent", agentId },
        ]);
        await tx.insert(namespaces).values([
          { id: sourceNamespaceId, scope: "room", label: "source" },
          { id: targetNamespaceId, scope: "room", label: "target" },
        ]);
        await tx.insert(rooms).values([
          { id: sourceRoomId, ownerId: userId, type: "private", label: "source",
            graphThreadId: `m318:${sourceRoomId}`, namespaceId: sourceNamespaceId,
            humanActorIds: [humanId], kind: "private", createdBy: humanId },
          { id: targetRoomId, ownerId: userId, type: "private", label: "target",
            graphThreadId: `m318:${targetRoomId}`, namespaceId: targetNamespaceId,
            humanActorIds: [humanId], kind: "private", createdBy: humanId },
        ]);
        await tx.insert(roomMembers).values([
          { roomId: sourceRoomId, actorId: humanId, roomRole: "admin" },
          { roomId: sourceRoomId, actorId: agentActorId, roomRole: "member",
            agentResponseMode: "active" },
          { roomId: targetRoomId, actorId: humanId, roomRole: "admin" },
          { roomId: targetRoomId, actorId: agentActorId, roomRole: "member",
            agentResponseMode: "active" },
        ]);
      });

      let singleRoomsAcquired = false;
      let singleFinished = false;
      const setAuthority = new PostgresNamespaceProductAuthority(connection(
        setClient,
        async (statement) => {
          if (statement.includes('order by "rooms"."parent_room_id" nulls first')) {
            releaseSetRoomAttempt();
          }
        },
      ));
      const singleAuthority = new PostgresNamespaceProductAuthority(connection(
        singleClient,
        async (statement) => {
          if (statement.includes("m290_namespace_key_readable_rooms")) {
            await within(setRoomAttempted);
          }
        },
        (statement) => {
          if (statement.includes('order by "rooms"."parent_room_id" nulls first')) {
            singleRoomsAcquired = true;
            releaseSingleRoomsLocked();
          }
        },
      ));
      const common = { subjectUserId: userId, subjectHumanId: humanId };
      singlePromise = singleAuthority.withCurrentReadableNamespace({
        ...common, sourceRoomId,
          namespaceId: targetNamespaceId, keyClass: "ai", use: async () => {
            singleFinished = true;
            return "single";
          } });
      await within(singleRoomsLocked);
      setPromise = setAuthority.withCurrentReadableNamespaceSet({ ...common,
        sourceRoomId: targetRoomId, namespaceIds: [sourceNamespaceId],
        use: async () => {
          expect(singleFinished).toBe(true);
          return "set";
        } });
      const [singleResult, setResult] = await within(Promise.all([
        singlePromise, setPromise,
      ]));
      expect(singleRoomsAcquired).toBe(true);
      expect([singleResult, setResult]).toEqual(["single", "set"]);

      await adminDb.delete(roomMembers).where(and(
        eq(roomMembers.roomId, targetRoomId),
        eq(roomMembers.actorId, agentActorId),
      ));
      await adminDb.update(rooms).set({ kind: "open" })
        .where(eq(rooms.id, targetRoomId));
      expect(await singleAuthority.withCurrentReadableNamespace({ ...common,
        sourceRoomId: targetRoomId, namespaceId: targetNamespaceId,
        keyClass: "ai", use: async () => "same-room-ai" })).toBe("same-room-ai");
      expect(await singleAuthority.withCurrentReadableNamespace({ ...common,
        sourceRoomId: targetRoomId, namespaceId: sourceNamespaceId,
        keyClass: "ai", use: async () => "cross-room-ai" })).toBeNull();
      expect(await singleAuthority.withCurrentReadableNamespace({ ...common,
        subjectHumanId: randomUUID(), sourceRoomId: targetRoomId,
        namespaceId: targetNamespaceId, keyClass: "ai",
        use: async () => "foreign" })).toBeNull();

      await adminDb.update(rooms).set({ kind: "access" })
        .where(eq(rooms.id, targetRoomId));
      expect(await singleAuthority.withCurrentReadableNamespace({ ...common,
        sourceRoomId: targetRoomId, namespaceId: targetNamespaceId,
        keyClass: "ai", use: async () => "access-same-room" }))
        .toBe("access-same-room");
      expect(await singleAuthority.withCurrentReadableNamespace({ ...common,
        sourceRoomId: targetRoomId, namespaceId: sourceNamespaceId,
        keyClass: "ai", use: async () => "access-cross-room" })).toBeNull();
      expect(await singleAuthority.withCurrentHumanNamespaceRoom({ ...common,
        roomId: targetRoomId, namespaceId: targetNamespaceId,
        use: async () => "access-memory" })).toBe("access-memory");
      expect(await singleAuthority.withCurrentHumanAiReadableRoom({ ...common,
        roomId: targetRoomId, namespaceId: targetNamespaceId,
        use: async () => "access-foreground" })).toBeNull();
    } finally {
      releaseSetRoomAttempt();
      await Promise.allSettled([
        singlePromise ?? Promise.resolve(null),
        setPromise ?? Promise.resolve(null),
      ]);
      await adminDb.delete(rooms).where(inArray(rooms.id, [sourceRoomId, targetRoomId]));
      await adminDb.delete(namespaces).where(inArray(namespaces.id,
        [sourceNamespaceId, targetNamespaceId]));
      await adminDb.delete(actors).where(inArray(actors.id, [humanId, agentActorId]));
      await adminDb.delete(agents).where(inArray(agents.id, [agentId]));
      await adminDb.delete(users).where(inArray(users.id, [userId]));
    }
  });

  test("non-public Agent Rooms may read a Human-superset access Namespace while public sources or targets missing a source Human cannot", async () => {
    const subjectUserId = randomUUID();
    const peerUserId = randomUUID();
    const sourceOnlyUserId = randomUUID();
    const subjectHumanId = randomUUID();
    const peerHumanId = randomUUID();
    const sourceOnlyHumanId = randomUUID();
    const agentId = randomUUID();
    const agentActorId = randomUUID();
    const sourceRoomId = randomUUID();
    const targetRoomId = randomUUID();
    const sourceNamespaceId = randomUUID();
    const targetNamespaceId = randomUUID();
    try {
      await adminDb.transaction(async (tx) => {
        await tx.insert(users).values([
          { id: subjectUserId, name: "M322 access source subject" },
          { id: peerUserId, name: "M322 access target peer" },
          { id: sourceOnlyUserId, name: "M322 access source-only peer" },
        ]);
        await tx.insert(agents).values({
          id: agentId,
          handle: `m322-access-${agentId}`,
        });
        await tx.insert(actors).values([
          { id: subjectHumanId, ownerId: subjectUserId,
            displayName: "M322 access source Human", trustState: "verified", kind: "user" },
          { id: peerHumanId, ownerId: peerUserId,
            displayName: "M322 access target peer", trustState: "verified", kind: "user" },
          { id: sourceOnlyHumanId, ownerId: sourceOnlyUserId,
            displayName: "M322 access source-only peer",
            trustState: "verified", kind: "user" },
          { id: agentActorId, ownerId: subjectUserId,
            displayName: "M322 access source Agent", trustState: "verified",
            kind: "agent", agentId },
        ]);
        await tx.insert(namespaces).values([
          { id: sourceNamespaceId, scope: "room", label: "M322 source" },
          { id: targetNamespaceId, scope: "room", label: "M322 access target" },
        ]);
        await tx.insert(rooms).values([
          { id: sourceRoomId, ownerId: subjectUserId, type: "private", label: "source",
            graphThreadId: `m322-source:${sourceRoomId}`, namespaceId: sourceNamespaceId,
            humanActorIds: [subjectHumanId], kind: "private", createdBy: subjectHumanId },
          { id: targetRoomId, ownerId: subjectUserId, type: "shared", label: "access",
            graphThreadId: `m322-access:${targetRoomId}`, namespaceId: targetNamespaceId,
            humanActorIds: [subjectHumanId, peerHumanId].sort(), kind: "access",
            createdBy: subjectHumanId },
        ]);
        await tx.insert(roomMembers).values([
          { roomId: sourceRoomId, actorId: subjectHumanId, roomRole: "admin" },
          { roomId: sourceRoomId, actorId: agentActorId, roomRole: "member",
            agentResponseMode: "active" },
          { roomId: targetRoomId, actorId: subjectHumanId, roomRole: "admin" },
          { roomId: targetRoomId, actorId: peerHumanId, roomRole: "member" },
        ]);
      });

      const authority = new PostgresNamespaceProductAuthority(connection(singleClient));
      const readSingle = () => authority.withCurrentReadableNamespace({
        subjectUserId,
        subjectHumanId,
        sourceRoomId,
        namespaceId: targetNamespaceId,
        keyClass: "ai",
        use: async () => "access-readable",
      });
      const readSet = () => authority.withCurrentReadableNamespaceSet({
        subjectUserId,
        subjectHumanId,
        sourceRoomId,
        namespaceIds: [targetNamespaceId],
        use: async () => "access-set-readable",
      });
      const expectReadable = async (allowed: boolean) => {
        expect(await readSingle()).toBe(allowed ? "access-readable" : null);
        expect(await readSet()).toBe(allowed ? "access-set-readable" : null);
      };

      await expectReadable(true);
      await adminDb.update(rooms).set({ kind: "group" })
        .where(eq(rooms.id, sourceRoomId));
      await expectReadable(true);

      await adminDb.update(rooms).set({ kind: "open" })
        .where(eq(rooms.id, sourceRoomId));
      await expectReadable(false);

      await adminDb.update(rooms).set({
        kind: "group",
        humanActorIds: [subjectHumanId, sourceOnlyHumanId].sort(),
      })
        .where(eq(rooms.id, sourceRoomId));
      await adminDb.insert(roomMembers).values({
        roomId: sourceRoomId,
        actorId: sourceOnlyHumanId,
        roomRole: "member",
      });
      await expectReadable(false);
    } finally {
      await adminDb.delete(rooms).where(inArray(rooms.id, [sourceRoomId, targetRoomId]));
      await adminDb.delete(namespaces).where(inArray(namespaces.id,
        [sourceNamespaceId, targetNamespaceId]));
      await adminDb.delete(actors).where(inArray(actors.id,
        [subjectHumanId, peerHumanId, sourceOnlyHumanId, agentActorId]));
      await adminDb.delete(agents).where(eq(agents.id, agentId));
      await adminDb.delete(users).where(inArray(users.id,
        [subjectUserId, peerUserId, sourceOnlyUserId]));
    }
  });

  for (const scenario of [
    {
      name: "Message repair/history authority",
      expected: "repair:human",
      run: (
        authority: PostgresNamespaceProductAuthority,
        input: Readonly<{
          subjectUserId: string;
          subjectHumanId: string;
          childRoomId: string;
          namespaceId: string;
        }>,
      ) => authority.withCurrentMessageRepairRoom({
        subjectUserId: input.subjectUserId,
        subjectHumanId: input.subjectHumanId,
        roomId: input.childRoomId,
        namespaceId: input.namespaceId,
        use: async (_snapshot, keyClass) => `repair:${keyClass}`,
      }),
    },
    {
      name: "single readable Namespace authority",
      expected: "readable",
      run: (
        authority: PostgresNamespaceProductAuthority,
        input: Readonly<{
          subjectUserId: string;
          subjectHumanId: string;
          childRoomId: string;
          namespaceId: string;
        }>,
      ) => authority.withCurrentReadableNamespace({
        subjectUserId: input.subjectUserId,
        subjectHumanId: input.subjectHumanId,
        sourceRoomId: input.childRoomId,
        namespaceId: input.namespaceId,
        keyClass: "human",
        use: async () => "readable",
      }),
    },
    {
      name: "readable Namespace set rejection",
      expected: null,
      run: (
        authority: PostgresNamespaceProductAuthority,
        input: Readonly<{
          subjectUserId: string;
          subjectHumanId: string;
          childRoomId: string;
          namespaceId: string;
        }>,
      ) => authority.withCurrentReadableNamespaceSet({
        subjectUserId: input.subjectUserId,
        subjectHumanId: input.subjectHumanId,
        sourceRoomId: input.childRoomId,
        namespaceIds: [input.namespaceId],
        use: async () => "set",
      }),
    },
  ] as const) {
    test(`${scenario.name} follows parent-before-Subthread membership propagation`, async () => {
      const subjectUserId = randomUUID();
      const peerUserId = randomUUID();
      const subjectHumanId = randomUUID();
      const peerHumanId = randomUUID();
      const [childRoomId, parentRoomId] = [randomUUID(), randomUUID()].sort() as [string, string];
      const namespaceId = randomUUID();
      const sessionId = randomUUID();
      let releaseMembership!: () => void;
      const authorityBlocked = new Promise<void>((resolve) => {
        releaseMembership = resolve;
      });
      let releaseParentLocked!: () => void;
      const parentLocked = new Promise<void>((resolve) => {
        releaseParentLocked = resolve;
      });
      let releaseAuthorityLockAttempt!: () => void;
      const authorityLockAttempted = new Promise<void>((resolve) => {
        releaseAuthorityLockAttempt = resolve;
      });
      let sawParentFirstOrder = false;
      let membershipPromise: Promise<void> | undefined;
      let authorityPromise: Promise<string | null> | undefined;
      try {
        expect(childRoomId < parentRoomId).toBe(true);
        await adminDb.transaction(async (tx) => {
          await tx.insert(users).values([
            { id: subjectUserId, name: "M314 lock-order subject" },
            { id: peerUserId, name: "M314 lock-order peer" },
          ]);
          await tx.insert(actors).values([
            { id: subjectHumanId, ownerId: subjectUserId,
              displayName: "M314 lock-order subject", trustState: "verified", kind: "user" },
            { id: peerHumanId, ownerId: peerUserId,
              displayName: "M314 lock-order peer", trustState: "verified", kind: "user" },
          ]);
          await tx.insert(namespaces).values({ id: namespaceId, scope: "room", label: "room" });
          await tx.insert(rooms).values({
            id: parentRoomId, ownerId: subjectUserId, type: "shared", label: "parent",
            graphThreadId: `m314-parent:${parentRoomId}`, namespaceId,
            humanActorIds: [subjectHumanId], kind: "open", createdBy: subjectHumanId,
          });
          await tx.insert(sessions).values({ id: sessionId, roomId: parentRoomId,
            ownerId: subjectUserId, threadId: `m314-parent:${parentRoomId}` });
          const [rootMessage] = await tx.insert(sessionMessages).values({
            sessionId, role: "user", content: "M314 Subthread lock-order anchor",
            humanTurnId: randomUUID(),
          }).returning({ id: sessionMessages.id });
          if (rootMessage === undefined) throw new Error("Missing Subthread root");
          await tx.insert(rooms).values({
            id: childRoomId, ownerId: subjectUserId, type: "shared", label: "child",
            graphThreadId: `m314-child:${childRoomId}`, namespaceId,
            humanActorIds: [subjectHumanId], kind: "subthread",
            parentRoomId, threadRootMessageId: rootMessage.id, createdBy: subjectHumanId,
          });
          await tx.insert(roomMembers).values([
            { roomId: parentRoomId, actorId: subjectHumanId, roomRole: "admin" },
            { roomId: childRoomId, actorId: subjectHumanId, roomRole: "admin" },
          ]);
        });

        const authorityBackendPid = await backendPid(subthreadAuthorityClient);
        membershipPromise = drizzle(membershipClient).transaction(async (membershipDb) => {
          // This is the canonical join/repair order: mutate the parent while its
          // lock is held, then lock the inherited child before propagating the row.
          await acquireRoomWriteLock(membershipDb, parentRoomId);
          releaseParentLocked();
          await authorityBlocked;
          await membershipDb.insert(roomMembers).values({
            roomId: parentRoomId,
            actorId: peerHumanId,
            roomRole: "member",
          });
          await membershipDb.update(rooms).set({
            humanActorIds: [subjectHumanId, peerHumanId].sort(),
          }).where(eq(rooms.id, parentRoomId));
          await acquireRoomWriteLock(membershipDb, childRoomId);
          await membershipDb.insert(roomMembers).values({
            roomId: childRoomId,
            actorId: peerHumanId,
            roomRole: "member",
          });
          await membershipDb.update(rooms).set({
            humanActorIds: [subjectHumanId, peerHumanId].sort(),
          }).where(eq(rooms.id, childRoomId));
        }) as unknown as Promise<void>;
        await within(parentLocked);

        const authority = new PostgresNamespaceProductAuthority(connection(
          subthreadAuthorityClient,
          async (statement) => {
            const normalized = statement.toLowerCase();
            if (/for update of\s+(?:"rooms"|room)/u.test(normalized)) {
              sawParentFirstOrder ||= normalized.includes(
                'order by "rooms"."parent_room_id" nulls first',
              );
              releaseAuthorityLockAttempt();
            }
          },
        ));
        const input = { subjectUserId, subjectHumanId, childRoomId, namespaceId };
        authorityPromise = scenario.run(authority, input);
        await within(authorityLockAttempted);
        await within(waitForBackendLock(authorityBackendPid));
        releaseMembership();

        const [membershipResult, authorityResult] = await within(Promise.allSettled([
          membershipPromise,
          authorityPromise,
        ]));
        expect(membershipResult.status).toBe("fulfilled");
        if (authorityResult.status === "rejected") {
          // A concurrent parent membership commit can invalidate the authority's
          // SERIALIZABLE snapshot. It must never be PostgreSQL's deadlock victim.
          expect(postgresErrorCode(authorityResult.reason)).toBe("40001");
        }
        expect(sawParentFirstOrder).toBe(true);
        expect(await scenario.run(authority, input)).toBe(scenario.expected);

        const [parent, child] = await adminDb.select({
          id: rooms.id,
          humanActorIds: rooms.humanActorIds,
        }).from(rooms).where(inArray(rooms.id, [parentRoomId, childRoomId]))
          .orderBy(asc(rooms.id));
        expect([parent?.id, child?.id]).toEqual([childRoomId, parentRoomId]);
        expect(parent?.humanActorIds).toEqual([subjectHumanId, peerHumanId].sort());
        expect(child?.humanActorIds).toEqual([subjectHumanId, peerHumanId].sort());
      } finally {
        releaseMembership();
        releaseParentLocked();
        releaseAuthorityLockAttempt();
        await Promise.allSettled([
          membershipPromise ?? Promise.resolve(),
          authorityPromise ?? Promise.resolve(null),
        ]);
        await adminDb.delete(rooms).where(eq(rooms.id, childRoomId));
        await adminDb.delete(sessionMessages).where(eq(sessionMessages.sessionId, sessionId));
        await adminDb.delete(sessions).where(eq(sessions.id, sessionId));
        await adminDb.delete(rooms).where(eq(rooms.id, parentRoomId));
        await adminDb.delete(namespaces).where(eq(namespaces.id, namespaceId));
        await adminDb.delete(actors).where(inArray(actors.id, [subjectHumanId, peerHumanId]));
        await adminDb.delete(users).where(inArray(users.id, [subjectUserId, peerUserId]));
      }
    });
  }
});
