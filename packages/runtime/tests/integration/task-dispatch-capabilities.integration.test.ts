/**
 * M146 regression — task dispatch resolves the REQUESTOR'S capabilities, not
 * the guest policy.
 *
 * `dispatchTaskRun` built the run's memory envelope via
 * `resolver.buildEnvelope(task.requestorId, …)`, but `buildEnvelope` resolves
 * the capability subject with `findActorById(actorId)` — it needs the user
 * ACTOR id, not the `users.id` that `tasks.requestor_id` stores. Passing the
 * user id made `findActorById` miss, `getUserCapabilities` get skipped, and the
 * envelope fall back to the GUEST `toolPolicy` — so any capability-gated tool in
 * a `whitelist` (e.g. `search_memory`) was rejected at dispatch with
 * "Tool(s) unavailable in this context". The existing suites missed this
 * because they inject a permissive STUB policy resolver; this test uses the
 * real `PersonalPolicyResolver`.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createTask as dbCreateTask,
  getTaskById,
  groups,
  groupMembers,
  actors,
  rooms,
  roomMembers,
  namespaces,
  eq,
  and,
  inArray,
  type DirectDatabase,
} from "@nautilo/db";
import { PersonalPolicyResolver, initPolicyResolver } from "@nautilo/trust";
import { dispatchTaskRun } from "../../src/tasks/dispatch-task-run";
import {
  setupTestDb,
  getDirectDb,
  closeDirectDb,
  cleanupTestUser,
} from "./helpers";
import { setupAgentTestEnv, closeAgentDb } from "./agent-helpers";

let db: DirectDatabase;
let userId: string;
let agentId: string;
let ownerGroupId: string | null = null;
const createdRoomIds: string[] = [];
const createdNamespaceIds: string[] = [];

const stubJobManager = {
  createForegroundJob: async () =>
    ({ id: "stub-job-1", coalesced: false }) as unknown as Awaited<
      ReturnType<
        import("../../src/job-manager").JobManager["createForegroundJob"]
      >
    >,
};

beforeAll(async () => {
  await setupTestDb();
  const env = await setupAgentTestEnv("m146-caps");
  userId = env.userId;
  agentId = env.agentId;
  db = getDirectDb();

  // Seed the owner's own user actor (setupAgentTestEnv only seeds the agent
  // actor) + canonical owners-Group membership so getUserCapabilities resolves
  // the full owner capability union.
  await db.insert(actors).values({
    ownerId: userId,
    kind: "user",
    displayName: "m146-caps-owner",
    trustState: "verified",
  });
  const [ownersGroup] = await db
    .select({ id: groups.id })
    .from(groups)
    .where(eq(groups.type, "owners"))
    .limit(1);
  if (!ownersGroup) throw new Error("canonical owners group missing on instance");
  ownerGroupId = ownersGroup.id;
  const [ownerActor] = await db
    .select({ id: actors.id })
    .from(actors)
    .where(eq(actors.ownerId, userId))
    .limit(1);
  await db
    .insert(groupMembers)
    .values({ groupId: ownersGroup.id, userId, grantedBy: ownerActor!.id })
    .onConflictDoNothing({ target: [groupMembers.groupId, groupMembers.userId] });

  // Use the REAL resolver (not the integration stub) — that's the whole point.
  initPolicyResolver(new PersonalPolicyResolver(userId));
});

afterAll(async () => {
  if (createdRoomIds.length > 0) {
    await db.delete(roomMembers).where(inArray(roomMembers.roomId, createdRoomIds));
    await db.delete(rooms).where(inArray(rooms.id, createdRoomIds));
  }
  if (createdNamespaceIds.length > 0) {
    await db.delete(namespaces).where(inArray(namespaces.id, createdNamespaceIds));
  }
  if (ownerGroupId) {
    await db
      .delete(groupMembers)
      .where(and(eq(groupMembers.groupId, ownerGroupId), eq(groupMembers.userId, userId)));
  }
  await cleanupTestUser(userId);
  await closeAgentDb();
  await closeDirectDb();
});

describe("M146 — dispatchTaskRun resolves requestor capabilities (not guest)", () => {
  test("a `search_memory` whitelist is accepted (no guest-policy rejection)", async () => {
    const task = await dbCreateTask(db, {
      ownerId: userId,
      requestorId: userId,
      agentId,
      prompt: "search my memory and report back",
      targetChat: "orphan",
      scheduleKind: "now",
      toolsMode: "whitelist",
      toolsWhitelist: ["search_memory"],
      nextFireAt: new Date(),
      status: "pending",
    });

    const result = await dispatchTaskRun(task, { db, jobManager: stubJobManager });
    expect(result.jobId).toBe("stub-job-1");

    // The orphan room was created + memoized; capture for cleanup.
    const persisted = await getTaskById(db, task.id);
    if (persisted?.targetRoomId) {
      createdRoomIds.push(persisted.targetRoomId);
      const [room] = await db
        .select({ namespaceId: rooms.namespaceId })
        .from(rooms)
        .where(eq(rooms.id, persisted.targetRoomId))
        .limit(1);
      if (room?.namespaceId) createdNamespaceIds.push(room.namespaceId);
    }
  });
});
