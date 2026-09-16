import { resolve } from "node:path";
import { config } from "dotenv";

// Load env: monorepo root first, then `packages/runtime/.env` (local overrides).
// Bun's CWD is the package dir; paths are anchored to this file's directory.
config({ path: resolve(import.meta.dirname, "../../../../.env") });
config({ path: resolve(import.meta.dirname, "../../.env") });

import {
  ensureDatabase,
  createDirectDb,
  eq,
  and,
  sql,
  users,
  jobs,
  sessions,
  sessionMessages,
  profiles,
  namespaces,
  rooms,
  actors,
  agents,
  roomMembers,
  tasks,
  type DirectDatabase,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import type { ServerEvent } from "@nautilo/types";
import type { Job } from "../../src/job";
import { eventBus } from "../../src/event-bus";
import { randomUUID } from "node:crypto";

export async function waitForRunningForegroundJob(
  jobManager: { getJob(id: string): Job | undefined },
  timeoutMs = 15_000,
): Promise<Job> {
  const jobId = await new Promise<string>((resolve, reject) => {
    const fail = setTimeout(
      () => reject(new Error(`Timeout ${timeoutMs}ms waiting for job.dispatched`)),
      timeoutMs,
    );
    const h = (e: ServerEvent) => {
      if (e.type === "job.dispatched") {
        clearTimeout(fail);
        eventBus.off(h);
        resolve(e.jobId);
      }
    };
    eventBus.on(h);
  });
  const job = jobManager.getJob(jobId);
  if (!job) throw new Error(`Job ${jobId} missing after job.dispatched`);
  return job;
}

export async function waitForDispatchedJobCount(
  jobManager: { getJob(id: string): Job | undefined },
  count: number,
  timeoutMs = 15_000,
): Promise<Job[]> {
  const ids: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const fail = setTimeout(
      () =>
        reject(
          new Error(
            `Timeout ${timeoutMs}ms waiting for ${count} job.dispatched event(s); saw ${ids.length}`,
          ),
        ),
      timeoutMs,
    );
    const h = (e: ServerEvent) => {
      if (e.type === "job.dispatched") {
        ids.push(e.jobId);
        if (ids.length >= count) {
          clearTimeout(fail);
          eventBus.off(h);
          resolve();
        }
      }
    };
    eventBus.on(h);
  });
  return ids.map((id) => {
    const j = jobManager.getJob(id);
    if (!j) throw new Error(`Job ${id} missing after job.dispatched`);
    return j;
  });
}

type TestDb = DirectDatabase & { end: () => Promise<void> };

let dbReady = false;
let _db: TestDb | null = null;

export function getDirectDb(): TestDb {
  if (!_db) {
    _db = createDirectDb(5);
  }
  return _db;
}

export async function closeDirectDb(): Promise<void> {
  if (_db) {
    await _db.end();
    _db = null;
  }
}

export async function setupTestDb(): Promise<void> {
  if (dbReady) return;
  // D266 Wave 1: route the scratch instance and refuse protected `(default)`
  // BEFORE `ensureDatabase()` / lazy `createDirectDb()` pool resolution. The
  // The canonical preload routes before imports; this call-site guard remains
  // the belt-and-suspenders check before fixture mutation.
  bootstrapTestDbInstance();
  await ensureDatabase();
  dbReady = true;
}

/** Test-only: reset the `setupTestDb` idempotency latch between unit cases. */
export function __resetSetupTestDbForTests(): void {
  dbReady = false;
}

/**
 * Guard for the task-engine integration suites. The `TaskObserver` claim loop
 * (`claimDueTasks`) is GLOBAL/multi-tenant: a tick claims and dispatches EVERY
 * due `pending` row, regardless of owner. Previously these suites ran an
 * unscoped `DELETE FROM tasks` / `DELETE FROM task_runs` at start to keep ticks
 * from claiming foreign/leftover rows — but that wipes real data when pointed at
 * a shared/populated instance (it once destroyed an operator's live scheduled
 * task mid-flight). Instead, fail CLOSED and read-only: refuse to run unless the
 * instance's task tables are empty, forcing these suites onto an isolated
 * scratch instance (set `NAUTILO_INSTANCE_ID`). Never deletes anything.
 */
export async function taskTablesCleanStatus(
  db: DirectDatabase,
): Promise<{ clean: true } | { clean: false; reason: string }> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(tasks);
  const n = row?.n ?? 0;
  if (n === 0) return { clean: true };
  return {
    clean: false,
    reason:
      `found ${n} pre-existing 'tasks' row(s); skipping global task-engine ` +
      `integration tests on this populated instance`,
  };
}

export async function createTestUser(
  name?: string,
): Promise<{ userId: string }> {
  const timestamp = Date.now();
  const testName = name ?? `test-user-${timestamp}`;
  const db = getDirectDb();

  const [user] = await db
    .insert(users)
    .values({ name: testName, email: `${testName}-${timestamp}@test.local` })
    .returning({ id: users.id });

  if (!user) throw new Error("Failed to create test user");
  return { userId: user.id };
}

/** Minimal room row for FK constraints on `jobs.room_id` (integration tests). */
export async function createTestRoom(ownerId: string): Promise<{ roomId: string }> {
  const db = getDirectDb();
  const [ns] = await db
    .insert(namespaces)
    .values({ scope: "private", label: "integration-test-room" })
    .returning({ id: namespaces.id });
  if (!ns) throw new Error("Failed to create namespace for test room");
  const pendingGraphId = `__pending_${randomUUID().replace(/-/g, "")}__`;
  const [room] = await db
    .insert(rooms)
    .values({
      ownerId,
      type: "private",
      label: "test",
      graphThreadId: pendingGraphId,
      namespaceId: ns.id,
      humanActorIds: [],
    })
    .returning({ id: rooms.id });
  if (!room) throw new Error("Failed to create test room");
  await db.update(rooms).set({ graphThreadId: `room:${room.id}` }).where(eq(rooms.id, room.id));
  // D168 RLS on `sessions`/`session_messages` requires the owner to be a room member via a
  // `kind='user'` actor. Seed both rows so transcript-persistence tests can INSERT under FORCE RLS.
  const [actor] = await db
    .insert(actors)
    .values({
      ownerId,
      kind: "user",
      displayName: "integration-test-actor",
      trustState: "verified",
    })
    .returning({ id: actors.id });
  if (!actor) throw new Error("Failed to create test actor");
  await db.insert(roomMembers).values({
    roomId: room.id,
    actorId: actor.id,
    roomRole: "admin",
  });
  return { roomId: room.id };
}

/**
 * Explicit cascading delete — FK constraints use ON DELETE NO ACTION,
 * so we must delete dependent rows in reverse order.
 */
type TestCleanupDb = Pick<DirectDatabase, "select" | "delete" | "execute">;

export async function cleanupTestUser(
  userId: string,
  db: TestCleanupDb = getDirectDb(),
): Promise<void> {

  const userSessions = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.ownerId, userId));

  for (const session of userSessions) {
    await db
      .delete(sessionMessages)
      .where(eq(sessionMessages.sessionId, session.id));
  }

  await db.delete(sessions).where(eq(sessions.ownerId, userId));
  await db.execute(sql`
    DELETE FROM memories m
    WHERE EXISTS (
      SELECT 1 FROM memory_namespaces mn
      INNER JOIN rooms r ON r.namespace_id = mn.namespace_id
      WHERE mn.memory_id = m.id AND r.owner_id = ${userId}::uuid
    )
  `);
  await db.delete(profiles).where(eq(profiles.userId, userId));
  await db.delete(jobs).where(eq(jobs.ownerId, userId));
  // D168 RLS chain: clean up the actor + room membership seeded by createTestRoom.
  const ownedRooms = await db
    .select({ id: rooms.id })
    .from(rooms)
    .where(eq(rooms.ownerId, userId));
  for (const { id: roomId } of ownedRooms) {
    await db.delete(roomMembers).where(eq(roomMembers.roomId, roomId));
  }
  await db
    .delete(actors)
    .where(and(eq(actors.ownerId, userId), eq(actors.kind, "user")));
  // M125: setupAgentTestEnv seeds an agent (+ agent-actor mirror owned by
  // the user). Remove the mirror actor AND its agent row before the user
  // delete, else actors.owner_id → users FK blocks it (and the agent row
  // would leak on the shared instance).
  const agentActors = await db
    .select({ agentId: actors.agentId })
    .from(actors)
    .where(and(eq(actors.ownerId, userId), eq(actors.kind, "agent")));
  await db
    .delete(actors)
    .where(and(eq(actors.ownerId, userId), eq(actors.kind, "agent")));
  for (const { agentId } of agentActors) {
    if (agentId) await db.delete(agents).where(eq(agents.id, agentId));
  }
  await db.delete(rooms).where(eq(rooms.ownerId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

/**
 * D374 — clean a fixture from the protected default database only in one
 * transaction-scoped test session. `set_config(..., true)` is equivalent to
 * `SET LOCAL`: it expires on commit/rollback and cannot weaken another test,
 * process, or future pooled connection.
 */
export async function cleanupTestUserWithDestructivePermission(userId: string): Promise<void> {
  const db = getDirectDb();
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('nautilo.allow_destructive', 'on', true)`);
    await cleanupTestUser(userId, tx);
  });
}

/**
 * Poll until the in-memory job status reaches a terminal state, then
 * wait briefly for the async DB write to flush. The settle delay is
 * needed because Job.setStatus() updates _status before awaiting
 * the DB call, and createForegroundJob fires execution without awaiting.
 */
export async function pollUntilComplete(
  job: { status: string; isTerminal(): boolean },
  timeoutMs = 15_000,
  intervalMs = 100,
  settleMs = 250,
): Promise<void> {
  const start = Date.now();
  while (!job.isTerminal()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Job did not complete within ${timeoutMs}ms. Last status: ${job.status}`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  await new Promise((r) => setTimeout(r, settleMs));
}

export function collectEvents(eventBus: {
  on(handler: (event: ServerEvent) => void): void;
  off(handler: (event: ServerEvent) => void): void;
}): { events: ServerEvent[]; cleanup: () => void } {
  const events: ServerEvent[] = [];
  const handler = (event: ServerEvent) => events.push(event);
  eventBus.on(handler);
  return {
    events,
    cleanup: () => eventBus.off(handler),
  };
}

export async function getJobFromDb(jobId: string) {
  const db = getDirectDb();
  const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  return row ?? null;
}

export async function* slowExecutor(
  _input: Record<string, unknown>,
  _jobId: string,
  laneKey: string | null,
  signal: AbortSignal,
): AsyncGenerator<ServerEvent> {
  for (let i = 1; i <= 20; i++) {
    if (signal.aborted) return;
    await new Promise((r) => setTimeout(r, 500));
    yield {
      type: "message.tokens",
      laneKey: laneKey ?? "default",
      content: `slow-${i} `,
      chunkSequence: i,
      done: i === 20,
    };
  }
}

export async function* failingExecutor(
  _input: Record<string, unknown>,
  _jobId: string,
  laneKey: string | null,
  _signal: AbortSignal,
): AsyncGenerator<ServerEvent> {
  yield {
    type: "message.tokens",
    laneKey: laneKey ?? "default",
    content: "about to fail",
    chunkSequence: 1,
    done: false,
  };
  await new Promise((r) => setTimeout(r, 0));
  throw new Error("intentional test failure");
}
