/**
 * ISSUE-M230 — Human message editing against live Postgres.
 *
 * Run against an already-migrated named instance:
 *   NAUTILO_INSTANCE_ID=<disposable-clone> bun test --timeout 60000 \
 *     packages/trust/tests/integration/m230-human-message-edit.integration.test.ts
 *
 * The fixture guard refuses the protected default instance. This suite never
 * runs migrations; the disposable clone must already be migrated.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  actors,
  createDirectDb,
  compareAndSwapEncryptionTransitionPolicy,
  EncryptionPublicationPolicyError,
  getEncryptionTransitionPolicy,
  eq,
  namespaces,
  roomJournalState,
  roomMembers,
  rooms,
  sessionMessages,
  sessions,
  sql,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  editHumanRoomMessage,
  MessageEditError,
} from "../../src/message-edit";

let db: ReturnType<typeof createDirectDb>;
const liveFixtures = new Set<Fixture>();

interface Fixture {
  ownerUserId: string;
  ownerActorId: string;
  peerUserId: string;
  peerActorId: string;
  outsiderUserId: string;
  outsiderActorId: string;
  namespaceId: string;
  roomId: string;
  ownerSessionIds: string[];
  peerSessionId: string;
}

beforeAll(() => {
  bootstrapTestDbInstance();
  db = createDirectDb(4);
});

afterAll(async () => {
  for (const fixture of [...liveFixtures]) {
    await cleanupFixture(fixture);
  }
  await db.end();
});

async function createUserAndActor(label: string): Promise<{
  userId: string;
  actorId: string;
}> {
  const unique = randomUUID();
  const [user] = await db
    .insert(users)
    .values({
      name: `M230 ${label}`,
      email: `m230-${label}-${unique}@integration.test`,
      handle: `m230_${label}_${unique.replaceAll("-", "").slice(0, 12)}`,
    })
    .returning({ id: users.id });
  if (!user) throw new Error(`failed to create ${label} user`);
  const [actor] = await db
    .insert(actors)
    .values({
      ownerId: user.id,
      displayName: `M230 ${label}`,
      kind: "user",
    })
    .returning({ id: actors.id });
  if (!actor) throw new Error(`failed to create ${label} actor`);
  return { userId: user.id, actorId: actor.id };
}

async function createSession(
  roomId: string,
  ownerId: string,
  suffix: string,
): Promise<string> {
  const [session] = await db
    .insert(sessions)
    .values({
      threadId: `m230:${roomId}:${suffix}:${randomUUID()}`,
      ownerId,
      personaId: "owner",
      roomId,
      channel: "electron",
    })
    .returning({ id: sessions.id });
  if (!session) throw new Error("failed to create session");
  return session.id;
}

async function makeFixture(label: string): Promise<Fixture> {
  const owner = await createUserAndActor(`${label}-owner`);
  const peer = await createUserAndActor(`${label}-peer`);
  const outsider = await createUserAndActor(`${label}-outsider`);
  const [namespace] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `m230-${label}-${randomUUID()}` })
    .returning({ id: namespaces.id });
  if (!namespace) throw new Error("failed to create namespace");
  const roomId = randomUUID();
  await db.insert(rooms).values({
    id: roomId,
    ownerId: owner.userId,
    type: "private",
    label: `M230 ${label}`,
    graphThreadId: `room:${roomId}`,
    namespaceId: namespace.id,
    humanActorIds: [owner.actorId, peer.actorId],
    createdBy: owner.actorId,
  });
  await db.insert(roomMembers).values([
    { roomId, actorId: owner.actorId, roomRole: "admin" },
    { roomId, actorId: peer.actorId, roomRole: "admin" },
  ]);
  const fixture: Fixture = {
    ownerUserId: owner.userId,
    ownerActorId: owner.actorId,
    peerUserId: peer.userId,
    peerActorId: peer.actorId,
    outsiderUserId: outsider.userId,
    outsiderActorId: outsider.actorId,
    namespaceId: namespace.id,
    roomId,
    ownerSessionIds: [
      await createSession(roomId, owner.userId, "owner-a"),
      await createSession(roomId, owner.userId, "owner-b"),
    ],
    peerSessionId: await createSession(roomId, peer.userId, "peer"),
  };
  liveFixtures.add(fixture);
  return fixture;
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  if (!liveFixtures.delete(fixture)) return;
  const sessionIds = [...fixture.ownerSessionIds, fixture.peerSessionId];
  for (const sessionId of sessionIds) {
    await db.delete(sessionMessages).where(eq(sessionMessages.sessionId, sessionId));
  }
  for (const sessionId of sessionIds) {
    await db.delete(sessions).where(eq(sessions.id, sessionId));
  }
  await db.delete(roomMembers).where(eq(roomMembers.roomId, fixture.roomId));
  await db.delete(rooms).where(eq(rooms.id, fixture.roomId));
  await db.delete(namespaces).where(eq(namespaces.id, fixture.namespaceId));
  await db.delete(actors).where(eq(actors.id, fixture.outsiderActorId));
  await db.delete(actors).where(eq(actors.id, fixture.peerActorId));
  await db.delete(actors).where(eq(actors.id, fixture.ownerActorId));
  await db.delete(users).where(eq(users.id, fixture.outsiderUserId));
  await db.delete(users).where(eq(users.id, fixture.peerUserId));
  await db.delete(users).where(eq(users.id, fixture.ownerUserId));
}

async function insertMessage(input: {
  sessionId: string;
  content: string;
  fingerprint?: string | null;
  role?: "user" | "assistant";
  createdAt?: Date;
  editRevision?: number;
}): Promise<number> {
  const [message] = await db
    .insert(sessionMessages)
    .values({
      sessionId: input.sessionId,
      role: input.role ?? "user",
      content: input.content,
      ...(input.fingerprint !== undefined
        ? { fingerprint: input.fingerprint }
        : {}),
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      ...(input.editRevision !== undefined
        ? { editRevision: input.editRevision }
        : {}),
    })
    .returning({ id: sessionMessages.id });
  if (!message) throw new Error("failed to create message");
  return message.id;
}

async function readMessages(ids: readonly number[]) {
  return db.execute<{
    id: number;
    content: string;
    fingerprint: string | null;
    created_at: Date | string;
    edited_at: Date | string | null;
    edit_revision: number;
  }>(sql`
    SELECT id, content, fingerprint, created_at, edited_at, edit_revision
    FROM session_messages
    WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
    ORDER BY id
  `);
}

function expectEditError(
  error: unknown,
  reason: MessageEditError["reason"],
): asserts error is MessageEditError {
  expect(error).toBeInstanceOf(MessageEditError);
  expect((error as MessageEditError).reason).toBe(reason);
}

describe("M230 editHumanRoomMessage (live Postgres)", () => {
  test("Full refuses the legacy ordinary edit without changing body, revision or journal", async () => {
    const fixture = await makeFixture("full-denial");
    const initialPolicy = await getEncryptionTransitionPolicy(db);
    try {
      const messageId = await insertMessage({
        sessionId: fixture.ownerSessionIds[0]!, content: "retained ordinary body",
      });
      await compareAndSwapEncryptionTransitionPolicy(db, {
        expectedRevision: initialPolicy.revision,
        targetMode: "encrypted_only", targetShadowBehavior: "strict",
      });
      let failure: unknown;
      try {
        await editHumanRoomMessage({
          roomId: fixture.roomId, messageId,
          callerUserId: fixture.ownerUserId, callerActorId: fixture.ownerActorId,
          content: "must never publish", expectedRevision: 0,
        });
      } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(EncryptionPublicationPolicyError);
      expect((failure as EncryptionPublicationPolicyError).reason).toBe("ordinary_forbidden");
      const rows = await db.select({ content: sessionMessages.content,
        revision: sessionMessages.editRevision, editedAt: sessionMessages.editedAt,
        cryptoObjectId: sessionMessages.cryptoObjectId,
      }).from(sessionMessages).where(eq(sessionMessages.id, messageId));
      expect(rows).toEqual([{ content: "retained ordinary body", revision: 0,
        editedAt: null, cryptoObjectId: null }]);
      expect(await db.select({ roomId: roomJournalState.roomId })
        .from(roomJournalState).where(eq(roomJournalState.roomId, fixture.roomId))).toHaveLength(0);
    } finally {
      const current = await getEncryptionTransitionPolicy(db);
      await compareAndSwapEncryptionTransitionPolicy(db, {
        expectedRevision: current.revision,
        targetMode: initialPolicy.mode, targetShadowBehavior: initialPolicy.shadowBehavior,
      });
      await cleanupFixture(fixture);
    }
  });
  test("updates every same-owner fingerprint sibling, preserves identity, refreshes FTS, and dirties the journal", async () => {
    const fixture = await makeFixture("converge");
    try {
      const fingerprint = `fp:v1:human:${randomUUID()}`;
      const createdAt = new Date("2026-07-31T10:00:00.000Z");
      const ownerA = await insertMessage({
        sessionId: fixture.ownerSessionIds[0]!,
        content: "zephyrlegacytoken original text",
        fingerprint,
        createdAt,
      });
      const ownerB = await insertMessage({
        sessionId: fixture.ownerSessionIds[1]!,
        content: "zephyrlegacytoken original text",
        fingerprint,
        createdAt,
      });
      const peerCopy = await insertMessage({
        sessionId: fixture.peerSessionId,
        content: "zephyrlegacytoken peer-owned text",
        fingerprint,
        createdAt,
      });
      const editedAt = new Date("2026-08-01T10:00:00.000Z");

      const result = await editHumanRoomMessage({
        roomId: fixture.roomId,
        messageId: ownerA,
        callerUserId: fixture.ownerUserId,
        callerActorId: fixture.ownerActorId,
        content: "  quartznewtoken corrected text  ",
        expectedRevision: 0,
        now: editedAt,
      });

      expect(result).toEqual({
        id: String(ownerA),
        logicalMessageKey: `turn:${fingerprint}`,
        content: "quartznewtoken corrected text",
        editedAt: editedAt.toISOString(),
        editRevision: 1,
      });
      const rows = await readMessages([ownerA, ownerB, peerCopy]);
      expect(rows).toHaveLength(3);
      for (const row of rows.filter((row) => row.id !== peerCopy)) {
        expect(row.content).toBe("quartznewtoken corrected text");
        expect(row.fingerprint).toBe(fingerprint);
        expect(new Date(row.created_at).toISOString()).toBe(createdAt.toISOString());
        expect(
          row.edited_at === null
            ? null
            : new Date(row.edited_at).toISOString(),
        ).toBe(editedAt.toISOString());
        expect(row.edit_revision).toBe(1);
      }
      const peer = rows.find((row) => row.id === peerCopy);
      expect(peer).toMatchObject({
        content: "zephyrlegacytoken peer-owned text",
        fingerprint,
        edited_at: null,
        edit_revision: 0,
      });

      const search = await db.execute<{
        id: number;
        old_match: boolean;
        new_match: boolean;
      }>(sql`
        SELECT
          id,
          content_search @@ plainto_tsquery('english', 'zephyrlegacytoken') AS old_match,
          content_search @@ plainto_tsquery('english', 'quartznewtoken') AS new_match
        FROM session_messages
        WHERE id IN (${ownerA}, ${ownerB})
        ORDER BY id
      `);
      expect(search).toHaveLength(2);
      expect(search.every((row) => row.old_match === false)).toBe(true);
      expect(search.every((row) => row.new_match === true)).toBe(true);

      const [journal] = await db
        .select()
        .from(roomJournalState)
        .where(eq(roomJournalState.roomId, fixture.roomId));
      expect(journal).toMatchObject({
        roomId: fixture.roomId,
        rebuildGeneration: 1,
        rebuildTargetMessageId: null,
      });
      expect(journal?.rebuildRequestedAt?.toISOString()).toBe(
        editedAt.toISOString(),
      );
    } finally {
      await cleanupFixture(fixture);
    }
  });

  test("serializes concurrent CAS requests: one succeeds and one returns the current revision", async () => {
    const fixture = await makeFixture("concurrent");
    try {
      const fingerprint = `fp:v1:human:${randomUUID()}`;
      const target = await insertMessage({
        sessionId: fixture.ownerSessionIds[0]!,
        content: "before",
        fingerprint,
      });
      const sibling = await insertMessage({
        sessionId: fixture.ownerSessionIds[1]!,
        content: "before",
        fingerprint,
      });
      const attempts = await Promise.allSettled([
        editHumanRoomMessage({
          roomId: fixture.roomId,
          messageId: target,
          callerUserId: fixture.ownerUserId,
          callerActorId: fixture.ownerActorId,
          content: "first contender",
          expectedRevision: 0,
        }),
        editHumanRoomMessage({
          roomId: fixture.roomId,
          messageId: target,
          callerUserId: fixture.ownerUserId,
          callerActorId: fixture.ownerActorId,
          content: "second contender",
          expectedRevision: 0,
        }),
      ]);

      const successes = attempts.filter(
        (attempt): attempt is PromiseFulfilledResult<
          Awaited<ReturnType<typeof editHumanRoomMessage>>
        > => attempt.status === "fulfilled",
      );
      const failures = attempts.filter(
        (attempt): attempt is PromiseRejectedResult =>
          attempt.status === "rejected",
      );
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      const failure: unknown = failures[0]!.reason;
      expectEditError(failure, "message_edit_conflict");
      expect(failure.current?.editRevision).toBe(1);

      const rows = await readMessages([target, sibling]);
      expect(rows.map((row) => row.edit_revision)).toEqual([1, 1]);
      expect(new Set(rows.map((row) => row.content))).toEqual(
        new Set([successes[0]!.value.content]),
      );
      const [journal] = await db
        .select({ generation: roomJournalState.rebuildGeneration })
        .from(roomJournalState)
        .where(eq(roomJournalState.roomId, fixture.roomId));
      expect(journal?.generation).toBe(1);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  test("rolls back every sibling and journal mutation if the sibling revision set is inconsistent", async () => {
    const fixture = await makeFixture("rollback");
    try {
      const fingerprint = `fp:v1:human:${randomUUID()}`;
      const target = await insertMessage({
        sessionId: fixture.ownerSessionIds[0]!,
        content: "target before",
        fingerprint,
      });
      const sibling = await insertMessage({
        sessionId: fixture.ownerSessionIds[1]!,
        content: "sibling before",
        fingerprint,
        editRevision: 1,
      });

      let error: unknown;
      try {
        await editHumanRoomMessage({
          roomId: fixture.roomId,
          messageId: target,
          callerUserId: fixture.ownerUserId,
          callerActorId: fixture.ownerActorId,
          content: "must roll back",
          expectedRevision: 0,
        });
      } catch (cause) {
        error = cause;
      }
      expectEditError(error, "message_edit_conflict");

      const rows = await readMessages([target, sibling]);
      expect(rows.map((row) => ({
        content: row.content,
        revision: row.edit_revision,
      }))).toEqual([
        { content: "target before", revision: 0 },
        { content: "sibling before", revision: 1 },
      ]);
      const journal = await db
        .select({ roomId: roomJournalState.roomId })
        .from(roomJournalState)
        .where(eq(roomJournalState.roomId, fixture.roomId));
      expect(journal).toHaveLength(0);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  test("enforces author, membership, archived-room, role, and null-fingerprint boundaries", async () => {
    const fixture = await makeFixture("boundaries");
    try {
      const target = await insertMessage({
        sessionId: fixture.ownerSessionIds[0]!,
        content: "editable",
        fingerprint: null,
      });
      const unrelatedNullFingerprint = await insertMessage({
        sessionId: fixture.ownerSessionIds[1]!,
        content: "leave alone",
        fingerprint: null,
      });
      const assistant = await insertMessage({
        sessionId: fixture.ownerSessionIds[0]!,
        content: "assistant text",
        role: "assistant",
      });

      for (const [callerUserId, callerActorId, reason] of [
        [fixture.peerUserId, fixture.peerActorId, "forbidden"],
        [fixture.outsiderUserId, fixture.outsiderActorId, "not_found"],
      ] as const) {
        let error: unknown;
        try {
          await editHumanRoomMessage({
            roomId: fixture.roomId,
            messageId: target,
            callerUserId,
            callerActorId,
            content: "unauthorized",
            expectedRevision: 0,
          });
        } catch (cause) {
          error = cause;
        }
        expectEditError(error, reason);
      }

      let roleError: unknown;
      try {
        await editHumanRoomMessage({
          roomId: fixture.roomId,
          messageId: assistant,
          callerUserId: fixture.ownerUserId,
          callerActorId: fixture.ownerActorId,
          content: "not allowed",
          expectedRevision: 0,
        });
      } catch (cause) {
        roleError = cause;
      }
      expectEditError(roleError, "ineligible");

      await db
        .update(rooms)
        .set({ archivedAt: new Date() })
        .where(eq(rooms.id, fixture.roomId));
      let archivedError: unknown;
      try {
        await editHumanRoomMessage({
          roomId: fixture.roomId,
          messageId: target,
          callerUserId: fixture.ownerUserId,
          callerActorId: fixture.ownerActorId,
          content: "not while archived",
          expectedRevision: 0,
        });
      } catch (cause) {
        archivedError = cause;
      }
      expectEditError(archivedError, "room_archived");
      await db
        .update(rooms)
        .set({ archivedAt: null })
        .where(eq(rooms.id, fixture.roomId));

      await editHumanRoomMessage({
        roomId: fixture.roomId,
        messageId: target,
        callerUserId: fixture.ownerUserId,
        callerActorId: fixture.ownerActorId,
        content: "only this row",
        expectedRevision: 0,
      });
      const rows = await readMessages([target, unrelatedNullFingerprint]);
      expect(rows.map((row) => ({
        content: row.content,
        revision: row.edit_revision,
      }))).toEqual([
        { content: "only this row", revision: 1 },
        { content: "leave alone", revision: 0 },
      ]);
    } finally {
      await cleanupFixture(fixture);
    }
  });
});
