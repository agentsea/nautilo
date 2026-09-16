import { buildEventFeedReaderRoleSql } from "../../src/utils/event-feed-role";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import {
  __resetSharedDirectDbForTests,
  actors,
  createDatabase,
  createDirectDb,
  createEventFeedStorage,
  listArtifactFeedRecipientUserIds,
  ensureDatabase,
  eq,
  feedEvents,
  resolveAppDatabaseConnectionString,
  resolveCryptoDatabaseConnectionString,
  resolveDirectAgentDatabaseConnectionString,
  sql,
  users,
  type Database,
} from "@nautilo/db";
import {
  EventFeedQueryError,
  type EventFeedErrorCode,
  type EventFeedRecordInput,
} from "@nautilo/types";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

const FIXTURE_PREFIX = "m323-event-feed-integration";

type AdminDb = ReturnType<typeof createDirectDb>;
type Storage = ReturnType<typeof createEventFeedStorage>;

interface Person {
  userId: string;
  actorId: string;
}

let adminDb: AdminDb;
let productDb: Database;
let storage: Storage;
let productSql: ReturnType<typeof postgres>;
let agentSql: ReturnType<typeof postgres>;
let cryptoSql: ReturnType<typeof postgres>;

function occurrenceKey(label: string): string {
  return `${FIXTURE_PREFIX}:${label}:${randomUUID()}`;
}

async function createPerson(label: string): Promise<Person> {
  const suffix = randomUUID();
  const [user] = await adminDb
    .insert(users)
    .values({ name: `${FIXTURE_PREFIX}:${label}:${suffix}` })
    .returning({ id: users.id });
  if (!user) throw new Error("event-feed fixture user was not created");

  const [actor] = await adminDb
    .insert(actors)
    .values({
      ownerId: user.id,
      displayName: `${FIXTURE_PREFIX}:${label}:${suffix}`,
      kind: "user",
    })
    .returning({ id: actors.id });
  if (!actor) throw new Error("event-feed fixture actor was not created");
  return { userId: user.id, actorId: actor.id };
}

function joinedInput(
  actor: Person,
  recipients: readonly string[],
  key = occurrenceKey("joined"),
): Extract<EventFeedRecordInput, { type: "room.member_joined" }> {
  return {
    key,
    type: "room.member_joined",
    actorKind: "human",
    actorId: actor.actorId,
    recipientUserIds: [...recipients],
    data: { roomId: randomUUID(), userId: randomUUID() },
  };
}

async function cleanupFixtures(): Promise<void> {
  if (!adminDb) return;
  await adminDb.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.event_feed_writer', 'on', true)`);
    await tx.delete(feedEvents).where(
      sql`${feedEvents.occurrenceKey} like ${`${FIXTURE_PREFIX}:%`}`,
    );
  });
  await adminDb.delete(users).where(
    sql`${users.name} like ${`${FIXTURE_PREFIX}:%`}`,
  );
}

function expectQueryCode(error: unknown, code: EventFeedErrorCode): void {
  expect(error).toBeInstanceOf(EventFeedQueryError);
  expect((error as EventFeedQueryError).code).toBe(code);
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  adminDb = createDirectDb(2);
  productDb = createDatabase();
  storage = createEventFeedStorage(productDb);
  productSql = postgres(resolveAppDatabaseConnectionString(), {
    max: 1,
    prepare: false,
  });
  agentSql = postgres(resolveDirectAgentDatabaseConnectionString(), {
    max: 1,
    prepare: false,
  });
  cryptoSql = postgres(resolveCryptoDatabaseConnectionString(), {
    max: 1,
    prepare: false,
  });
}, 120_000);

afterAll(async () => {
  await cleanupFixtures();
  await Promise.all([
    productSql?.end({ timeout: 1 }),
    agentSql?.end({ timeout: 1 }),
    cryptoSql?.end({ timeout: 1 }),
    adminDb?.end({ timeout: 1 }),
    __resetSharedDirectDbForTests(),
  ]);
});

describe("M323 persistent event feed PostgreSQL storage", () => {
  test("resource invalidation reaches historical recipients by exact Artifact, without changing read state", async () => {
    const actor = await createPerson("artifact-author");
    const recipient = await createPerson("artifact-recipient");
    const unrelated = await createPerson("unrelated-recipient");
    const artifactId = randomUUID();
    const input: EventFeedRecordInput = {
      key: occurrenceKey("artifact"), type: "artifact.shared", actorKind: "human", actorId: actor.actorId,
      recipientUserIds: [recipient.userId], data: { artifactId, destination: { kind: "person", userId: recipient.userId } },
    };
    const recorded = await storage.record(input);
    if (recorded.status !== "stored") throw new Error("expected new event");
    await storage.setRead(recipient.userId, recorded.eventId, true);
    await storage.record({ ...input, key: occurrenceKey("other-artifact"), recipientUserIds: [unrelated.userId],
      data: { artifactId: randomUUID(), destination: { kind: "person", userId: unrelated.userId } } });
    expect(await listArtifactFeedRecipientUserIds(productDb, artifactId)).toEqual([recipient.userId]);
    expect(await storage.countUnread(recipient.userId)).toBe(0);
  });
  test("rolls back the event and every recipient when one recipient FK fails", async () => {
    const actor = await createPerson("atomic-actor");
    const recipient = await createPerson("atomic-recipient");
    const input = joinedInput(actor, [recipient.userId, randomUUID()], occurrenceKey("atomic"));

    let recordError: unknown;
    try {
      await storage.record(input);
    } catch (error) {
      recordError = error;
    }
    expect(recordError).toBeTruthy();

    const rows = await adminDb.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.event_feed_writer', 'on', true)`);
      return tx
        .select({ id: feedEvents.id })
        .from(feedEvents)
        .where(eq(feedEvents.occurrenceKey, input.key));
    });
    expect(rows).toEqual([]);
  });

  test("reads recorded history through a newly constructed storage adapter", async () => {
    const actor = await createPerson("persistence-actor");
    const recipient = await createPerson("persistence-recipient");
    const stored = await storage.record(joinedInput(
      actor,
      [recipient.userId],
      occurrenceKey("persistence"),
    ));
    if (stored.status !== "stored") throw new Error("expected stored persistence fixture");

    const reloadedStorage = createEventFeedStorage(productDb);
    const page = await reloadedStorage.list(recipient.userId);
    expect(page.events).toHaveLength(1);
    expect(page.events[0]?.id).toBe(stored.eventId);
    expect(await reloadedStorage.countUnread(recipient.userId)).toBe(1);
  });

  test("deduplicates recipients, preserves read state and audience on replay, and rejects conflicting keys", async () => {
    const actor = await createPerson("dedupe-actor");
    const recipientA = await createPerson("dedupe-a");
    const recipientB = await createPerson("dedupe-b");
    const input = joinedInput(
      actor,
      [recipientA.userId, recipientA.userId, recipientB.userId],
      occurrenceKey("dedupe"),
    );

    const stored = await storage.record(input);
    expect(stored.status).toBe("stored");
    if (stored.status !== "stored") throw new Error("expected stored feed event");
    expect((await storage.setRead(recipientA.userId, stored.eventId, true)).changed).toBe(true);

    const replay = await storage.record({
      ...input,
      recipientUserIds: [recipientA.userId],
    });
    expect(replay).toEqual({ status: "duplicate", eventId: stored.eventId });
    expect(await storage.countUnread(recipientA.userId)).toBe(0);
    expect(await storage.countUnread(recipientB.userId)).toBe(1);
    expect((await storage.list(recipientA.userId)).events).toHaveLength(1);
    expect((await storage.list(recipientB.userId)).events).toHaveLength(1);

    const conflict = await storage.record({
      ...input,
      data: { ...input.data, roomId: randomUUID() },
      recipientUserIds: [recipientB.userId],
    });
    expect(conflict).toEqual({ status: "conflict" });
    expect((await storage.list(recipientA.userId)).events[0]?.data).toEqual(input.data);
  });

  test("serializes concurrent same-key recording into one stored event and one complete duplicate", async () => {
    const actor = await createPerson("concurrent-dedupe-actor");
    const recipientA = await createPerson("concurrent-dedupe-a");
    const recipientB = await createPerson("concurrent-dedupe-b");
    const input = joinedInput(
      actor,
      [recipientA.userId, recipientB.userId],
      occurrenceKey("concurrent-dedupe"),
    );

    const outcomes = await Promise.all([
      storage.record(input),
      storage.record(input),
    ]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
      "duplicate",
      "stored",
    ]);
    const eventIds = outcomes.flatMap((outcome) =>
      outcome.status === "conflict" ? [] : [outcome.eventId]
    );
    expect(new Set(eventIds).size).toBe(1);
    const eventId = eventIds[0];
    if (!eventId) throw new Error("concurrent recording returned no event ID");
    expect((await storage.list(recipientA.userId)).events.map((event) => event.id))
      .toEqual([eventId]);
    expect((await storage.list(recipientB.userId)).events.map((event) => event.id))
      .toEqual([eventId]);
  });

  test("lists, counts, pages, filters, and changes read state only for the owning Human", async () => {
    const actor = await createPerson("read-actor");
    const owner = await createPerson("read-owner");
    const other = await createPerson("read-other");
    const first = await storage.record(joinedInput(actor, [owner.userId], occurrenceKey("read-first")));
    const second = await storage.record({
      key: occurrenceKey("read-second"),
      type: "artifact.added",
      actorKind: "human",
      actorId: actor.actorId,
      recipientUserIds: [owner.userId],
      data: { artifactId: randomUUID(), roomId: randomUUID() },
    });
    const privateToOther = await storage.record(joinedInput(actor, [other.userId], occurrenceKey("read-other")));
    if (first.status !== "stored" || second.status !== "stored" || privateToOther.status !== "stored") {
      throw new Error("expected stored read-state fixtures");
    }

    expect(await storage.countUnread(owner.userId)).toBe(2);
    expect(await storage.countUnread(other.userId)).toBe(1);
    const firstPage = await storage.list(owner.userId, { limit: 1 });
    expect(firstPage.events).toHaveLength(1);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await storage.list(owner.userId, {
      cursor: firstPage.nextCursor!,
      limit: 1,
    });
    expect(secondPage.events).toHaveLength(1);
    expect(secondPage.events[0]?.id).not.toBe(firstPage.events[0]?.id);
    expect(secondPage.nextCursor).toBeNull();
    const artifactEvents = (await storage.list(owner.userId, {
      types: ["artifact.added"],
    })).events;
    expect(artifactEvents).toHaveLength(1);
    expect(artifactEvents[0]?.id).toBe(second.eventId);
    expect(artifactEvents[0]?.type).toBe("artifact.added");

    const firstRead = await storage.setRead(owner.userId, first.eventId, true);
    expect(firstRead.changed).toBe(true);
    expect(firstRead.readAt).not.toBeNull();
    expect((await storage.setRead(owner.userId, first.eventId, true)).changed).toBe(false);
    expect((await storage.list(owner.userId, { unreadOnly: true })).events.map((event) => event.id))
      .toEqual([second.eventId]);
    expect((await storage.setRead(owner.userId, first.eventId, false)).changed).toBe(true);

    let nonOwnerError: unknown;
    try {
      await storage.setRead(owner.userId, privateToOther.eventId, true);
    } catch (error) {
      nonOwnerError = error;
    }
    expectQueryCode(nonOwnerError, "not_found");
    expect(await storage.countUnread(other.userId)).toBe(1);

    let missingError: unknown;
    try {
      await storage.setRead(owner.userId, randomUUID(), true);
    } catch (error) {
      missingError = error;
    }
    expectQueryCode(missingError, "not_found");
  });

  test("mark-all uses its statement snapshot while an overlapping later event remains unread", async () => {
    const actor = await createPerson("mark-all-actor");
    const owner = await createPerson("mark-all-owner");
    await storage.record(joinedInput(actor, [owner.userId], occurrenceKey("mark-all-before")));
    await storage.record({
      key: occurrenceKey("mark-all-artifact"),
      type: "artifact.added",
      actorKind: "human",
      actorId: actor.actorId,
      recipientUserIds: [owner.userId],
      data: { artifactId: randomUUID(), roomId: randomUUID() },
    });

    const lateEventId = randomUUID();
    const lateKey = occurrenceKey("mark-all-late");
    const lateRoomId = randomUUID();
    const lateSubjectId = randomUUID();
    let signalInserted!: () => void;
    let signalInsertFailure!: (error: unknown) => void;
    const inserted = new Promise<void>((resolve, reject) => {
      signalInserted = resolve;
      signalInsertFailure = reject;
    });
    let releaseCommit!: () => void;
    const commitReleased = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    let heldTransactionError: unknown;
    const heldTransaction = productSql.begin(async (tx) => {
      await tx`select set_config('app.event_feed_writer', 'on', true)`;
      await tx`
        insert into feed_events (
          id, occurrence_key, type, actor_kind, actor_id, data
        ) values (
          ${lateEventId}, ${lateKey}, 'room.member_joined', 'human',
          ${actor.actorId},
          ${tx.json({ roomId: lateRoomId, userId: lateSubjectId })}
        )
      `;
      await tx`
        insert into feed_recipients (event_id, user_id)
        values (${lateEventId}, ${owner.userId})
      `;
      signalInserted();
      await commitReleased;
    }).catch((error: unknown) => {
      heldTransactionError = error;
      signalInsertFailure(error);
    });

    let overlapError: unknown;
    try {
      await inserted;
      expect(await storage.markAllRead(owner.userId)).toEqual({ updatedCount: 2 });
      expect(await storage.countUnread(owner.userId)).toBe(0);
    } catch (error) {
      overlapError = error;
    } finally {
      releaseCommit();
    }
    await heldTransaction;
    if (heldTransactionError) {
      throw heldTransactionError instanceof Error
        ? heldTransactionError
        : new Error("held event transaction failed with a non-Error value");
    }
    if (overlapError) {
      throw overlapError instanceof Error
        ? overlapError
        : new Error("mark-all overlap assertion failed with a non-Error value");
    }

    expect(await storage.countUnread(owner.userId)).toBe(1);
    expect((await storage.list(owner.userId, { unreadOnly: true })).events.map((event) => event.id))
      .toEqual([lateEventId]);
  });

  test("retains history after actor deletion and removes only the deleted Human recipient", async () => {
    const actor = await createPerson("deletion-actor");
    const deletedRecipient = await createPerson("deletion-recipient");
    const survivingRecipient = await createPerson("deletion-survivor");
    const stored = await storage.record(joinedInput(
      actor,
      [deletedRecipient.userId, survivingRecipient.userId],
      occurrenceKey("deletion"),
    ));
    if (stored.status !== "stored") throw new Error("expected stored deletion fixture");

    await adminDb.delete(actors).where(eq(actors.id, actor.actorId));
    await adminDb.delete(users).where(eq(users.id, deletedRecipient.userId));

    expect(await storage.countUnread(deletedRecipient.userId)).toBe(0);
    const survivorPage = await storage.list(survivingRecipient.userId);
    expect(survivorPage.events).toHaveLength(1);
    expect(survivorPage.events[0]?.id).toBe(stored.eventId);
    expect(survivorPage.events[0]?.actorId).toBeNull();
  });

  test("application migrations can verify an admin-provisioned reader without role administration", async () => {
    const [membership] = await productSql<{ admin_option: boolean }[]>`
      select admin_option from pg_auth_members
      where roleid = (select oid from pg_roles where rolname = 'nautilo_feed_reader')
        and member = (select oid from pg_roles where rolname = current_user)
    `;
    expect(membership?.admin_option).toBe(false);
    await productSql.unsafe(buildEventFeedReaderRoleSql());
    await productSql.unsafe(buildEventFeedReaderRoleSql());
  });

  test("denies the Agent role completely and enforces product-role own-recipient RLS", async () => {
    const actor = await createPerson("rls-actor");
    const ownerA = await createPerson("rls-a");
    const ownerB = await createPerson("rls-b");
    const eventA = await storage.record(joinedInput(actor, [ownerA.userId], occurrenceKey("rls-event-a")));
    const eventB = await storage.record(joinedInput(actor, [ownerB.userId], occurrenceKey("rls-event-b")));
    if (eventA.status !== "stored" || eventB.status !== "stored") {
      throw new Error("expected stored RLS fixtures");
    }

    const [productIdentity] = await productSql<{
      role_name: string;
      events_force_rls: boolean;
      recipients_force_rls: boolean;
    }[]>`
      select current_user as role_name,
             (select relforcerowsecurity from pg_class where oid = 'public.feed_events'::regclass)
               as events_force_rls,
             (select relforcerowsecurity from pg_class where oid = 'public.feed_recipients'::regclass)
               as recipients_force_rls
    `;
    expect(productIdentity).toEqual({
      role_name: "nautilo",
      events_force_rls: true,
      recipients_force_rls: true,
    });

    const privileges = await agentSql<{
      table_name: string;
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
    }[]>`
      select table_name,
             has_table_privilege('nautilo_agent', format('public.%I', table_name), 'SELECT') as can_select,
             has_table_privilege('nautilo_agent', format('public.%I', table_name), 'INSERT') as can_insert,
             has_table_privilege('nautilo_agent', format('public.%I', table_name), 'UPDATE') as can_update,
             has_table_privilege('nautilo_agent', format('public.%I', table_name), 'DELETE') as can_delete
        from (values ('feed_events'), ('feed_recipients')) as tables(table_name)
       order by table_name
    `;
    expect([...privileges]).toEqual([
      { table_name: "feed_events", can_select: false, can_insert: false, can_update: false, can_delete: false },
      { table_name: "feed_recipients", can_select: false, can_insert: false, can_update: false, can_delete: false },
    ]);
    let agentReadError: unknown;
    try {
      await agentSql.begin(async (tx) => {
        await tx`select set_config('app.current_user_id', ${ownerA.userId}, true)`;
        await tx`select event_id from feed_recipients`;
      });
    } catch (error) {
      agentReadError = error;
    }
    expect(String((agentReadError as { message?: string } | undefined)?.message))
      .toMatch(/permission denied/u);

    await productSql.begin(async (tx) => {
      await tx`set local role nautilo_feed_reader`;
      const [readerIdentity] = await tx<{
        role_name: string;
        bypasses_rls: boolean;
        can_login: boolean;
      }[]>`
        select current_user as role_name,
               reader.rolbypassrls as bypasses_rls,
               reader.rolcanlogin as can_login
          from pg_roles reader
         where reader.rolname = current_user
      `;
      expect(readerIdentity).toEqual({
        role_name: "nautilo_feed_reader",
        bypasses_rls: false,
        can_login: false,
      });
      await tx`select set_config('app.current_user_id', ${ownerA.userId}, true)`;
      const recipients = await tx<{ event_id: string }[]>`
        select event_id from feed_recipients order by event_id
      `;
      expect([...recipients]).toEqual([{ event_id: eventA.eventId }]);
      const events = await tx<{ id: string }[]>`select id from feed_events order by id`;
      expect([...events]).toEqual([{ id: eventA.eventId }]);
      const crossUserUpdate = await tx`
        update feed_recipients set read_at = statement_timestamp()
         where event_id = ${eventB.eventId}
      `;
      expect(crossUserUpdate.count).toBe(0);

      await tx`select set_config('app.event_feed_writer', 'on', true)`;
      expect([
        ...await tx<{ id: string }[]>`select id from feed_events order by id`,
      ]).toEqual([{ id: eventA.eventId }]);
    });

    await productSql.begin(async (tx) => {
      await tx`set local role nautilo_feed_reader`;
      expect(await tx`select id from feed_events`).toHaveLength(0);
      expect(await tx`select event_id from feed_recipients`).toHaveLength(0);
    });

    for (const restricted of [agentSql, cryptoSql]) {
      let assumeReaderError: unknown;
      try {
        await restricted.begin(async (tx) => {
          await tx`set local role nautilo_feed_reader`;
        });
      } catch (error) {
        assumeReaderError = error;
      }
      expect(String(
        (assumeReaderError as { message?: string } | undefined)?.message,
      )).toMatch(/permission denied to set role/u);
    }
  });
});
