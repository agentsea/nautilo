/**
 * M146 (Phase 5) — HTTP API for the Task primitive: create/list/get/patch.
 *
 * Real Postgres + Fastify `inject`. Boots the production app via
 * `setupOwnerAppFixture` (which wires the real runtime `createTask` + observer
 * + `setTaskToolRuntime`). To stay deterministic against the live observer,
 * every created task is FUTURE-dated `one_shot`/`cron` (or seeded terminal), so
 * the observer never claims it mid-test. Live now-task dispatch is covered by
 * the M142/M143 runtime integration suites.
 *
 * Covers the blast-radius S4 (route owner-only 404 on GET/PATCH + list omits),
 * S1 row half (POST → row + shape), PATCH recompute, R3 rejects (HTTP), and the
 * orphan run transcript on GET :id (R7).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  tasks,
  taskRuns,
  sessions,
  sessionMessages,
  actors,
  agents,
  profiles,
  groupMembers,
  channelIdentities,
  credentials,
  users,
  eq,
  listAwaitingTaskRunsForOwner,
} from "@nautilo/db";
import {
  setupOwnerAppFixture,
  seatPeerUser,
  type AppFixture,
} from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";
import { TASK_SUMMARY_HIERARCHY_FIXTURES } from "../../../../dev/fixtures/task-summary-hierarchy";
import { createInBackgroundTool } from "../../../agent/src/tools/tasks/shortcuts/in-background";
import { dispatchTaskCommand } from "../../../agent/src/tools/tasks/dispatch";
import { runWithTaskCreationAmbientContext } from "../../../agent/src/runtime/task-creation-live-mini-app-context";
import {
  registerTaskLiveMiniAppBinding,
  removeTaskReturnBinding,
} from "@nautilo/runtime";

let fx: AppFixture;
let ownerAgentId: string;
let peer: { userId: string; actorId: string; agentId: string; bearer: string };
let guest: { userId: string; actorId: string; agentId: string; bearer: string };

const FUTURE_RUN_AT = "2035-01-01T00:00:00.000Z";

beforeAll(async () => {
  fx = await setupOwnerAppFixture({
    suiteName: "tasksapi",
    withDefaultAgentGraph: true,
  });
  ownerAgentId = fx.defaultAgentId!;
  peer = await seatPeerUser(fx.db, {
    suiteName: "tasksapi",
    groupType: "members",
  });
  guest = await seatPeerUser(fx.db, {
    suiteName: "tasksapi",
    groupType: "guests",
  });
});

afterAll(async () => {
  if (!fx) return;
  // Owner tasks/task_runs cascade off the owner-user delete in fx.cleanup();
  // sessions are deleted by ownerId there too. Clean the peer's rows manually
  // BEFORE fx.cleanup() (which ends the shared pool last).
  for (const user of [peer, guest]) {
    if (!user) continue;
    await fx.db.delete(tasks).where(eq(tasks.ownerId, user.userId));
    await fx.db.delete(profiles).where(eq(profiles.userId, user.userId));
    await fx.db.delete(actors).where(eq(actors.ownerId, user.userId));
    await fx.db.delete(agents).where(eq(agents.id, user.agentId));
    await fx.db.delete(groupMembers).where(eq(groupMembers.userId, user.userId));
    await fx.db
      .delete(channelIdentities)
      .where(eq(channelIdentities.userId, user.userId));
    await fx.db.delete(credentials).where(eq(credentials.userId, user.userId));
    await fx.db.delete(users).where(eq(users.id, user.userId));
  }
  await fx.cleanup();
});

describe("tasks HTTP API (M146)", () => {
  test("D569 — both Task creation surfaces reject recursion from a live-bound Task", async () => {
    const [parent] = await fx.db.insert(tasks).values({
      ownerId: fx.ownerId,
      requestorId: fx.ownerId,
      agentId: ownerAgentId,
      prompt: "Correct the open Writer document",
      status: "running",
      depth: 0,
    }).returning({ id: tasks.id });
    if (!parent) throw new Error("D569 parent Task seed failed");
    const [parentRun] = await fx.db.insert(taskRuns).values({
      taskId: parent.id,
      graphThreadId: `d569-parent-${randomUUID()}`,
      status: "running",
    }).returning({ id: taskRuns.id });
    if (!parentRun) throw new Error("D569 parent TaskRun seed failed");

    const liveSession = {
      appId: "nautilo-writer",
      sessionToken: `d569-token-${randomUUID()}`,
      sessionId: `d569-session-${randomUUID()}`,
      documentVersion: { kind: "artifact_revision" as const, revision: 12 },
      instructions: "Use the live Writer review tools.",
    };
    expect(registerTaskLiveMiniAppBinding(
      parent.id,
      {
        ownerId: fx.ownerId,
        activeMiniApp: { appId: "nautilo-writer", updatedAt: Date.now() },
        liveMiniAppSession: liveSession,
      },
      () => liveSession,
    )).toBe(true);

    const provenance = {
      ownerId: fx.ownerId,
      taskId: parent.id,
      taskRunId: parentRun.id,
    };
    const context = {
      ownerId: fx.ownerId,
      agentId: ownerAgentId,
      roomId: fx.defaultRoomId!,
      currentTaskId: parent.id,
      currentTaskRunId: parentRun.id,
    };

    try {
      let basicSurfaceError: unknown = null;
      try {
        await runWithTaskCreationAmbientContext(
          null,
          provenance,
          () => createInBackgroundTool(context).invoke({ brief: "Delegate the correction again" }),
        );
      } catch (error) {
        basicSurfaceError = error;
      }
      expect(basicSurfaceError).toBeInstanceOf(Error);
      expect((basicSurfaceError as Error).message)
        .toContain("already-running Task owns the active live-app session");

      const advanced = await runWithTaskCreationAmbientContext(
        null,
        provenance,
        () => dispatchTaskCommand(
          { command: "create", prompt: "Delegate the correction again" },
          context,
        ),
      );
      expect(advanced).toContain("already-running Task owns the active live-app session");

      const children = await fx.db.select({ id: tasks.id }).from(tasks)
        .where(eq(tasks.parentTaskId, parent.id));
      expect(children).toEqual([]);
    } finally {
      removeTaskReturnBinding(parent.id);
      await fx.db.delete(tasks).where(eq(tasks.id, parent.id));
    }
  });

  test("D547 — pending Task attention is authenticated, private, and owner-scoped", async () => {
    const [ownerTask] = await fx.db.insert(tasks).values({
      ownerId: fx.ownerId,
      requestorId: fx.ownerId,
      agentId: ownerAgentId,
      prompt: "owner parked approval",
      status: "awaiting",
    }).returning({ id: tasks.id });
    const [peerTask] = await fx.db.insert(tasks).values({
      ownerId: peer.userId,
      requestorId: peer.userId,
      agentId: peer.agentId,
      prompt: "peer parked approval",
      status: "awaiting",
    }).returning({ id: tasks.id });
    if (!ownerTask || !peerTask) throw new Error("pending attention Task seed failed");

    const [ownerRun] = await fx.db.insert(taskRuns).values({
      taskId: ownerTask.id,
      graphThreadId: `pending-attention-owner-${randomUUID()}`,
      status: "awaiting",
    }).returning({ id: taskRuns.id });
    await fx.db.insert(taskRuns).values({
      taskId: peerTask.id,
      graphThreadId: `pending-attention-peer-${randomUUID()}`,
      status: "awaiting",
    });
    if (!ownerRun) throw new Error("pending attention TaskRun seed failed");

    try {
      const ownerRows = await listAwaitingTaskRunsForOwner(fx.db, fx.ownerId);
      expect(ownerRows.map((row) => row.task.id)).toContain(ownerTask.id);
      expect(ownerRows.map((row) => row.task.id)).not.toContain(peerTask.id);
      expect(ownerRows.find((row) => row.task.id === ownerTask.id)?.run.id).toBe(ownerRun.id);

      const unauthenticated = await fx.app.inject({
        method: "GET",
        url: "/api/tasks/pending-attention",
      });
      expect(unauthenticated.statusCode).toBe(401);
      expect(unauthenticated.headers["cache-control"]).toBe("private, no-store");
      expect(unauthenticated.headers.vary).toBe("Authorization");

      const ownerToken = await fx.mintOwnerBearer();
      const ownerResponse = await authedInject(fx.app, {
        method: "GET",
        url: "/api/tasks/pending-attention",
        bearer: ownerToken,
      });
      expect(ownerResponse.statusCode).toBe(200);
      expect(ownerResponse.headers["cache-control"]).toBe("private, no-store");
      expect(ownerResponse.headers.vary).toBe("Authorization");
      expect(JSON.parse(ownerResponse.body)).toEqual([]);

      const peerResponse = await authedInject(fx.app, {
        method: "GET",
        url: "/api/tasks/pending-attention",
        bearer: peer.bearer,
      });
      expect(peerResponse.statusCode).toBe(200);
      expect(peerResponse.headers["cache-control"]).toBe("private, no-store");
      expect(peerResponse.headers.vary).toBe("Authorization");
      expect(JSON.parse(peerResponse.body)).toEqual([]);
    } finally {
      await fx.db.delete(tasks).where(eq(tasks.id, ownerTask.id));
      await fx.db.delete(tasks).where(eq(tasks.id, peerTask.id));
    }
  });

  test("D547 — task avatar resolves the exact owned Agent, with shell fallbacks and private cache headers", async () => {
    const [ownerProfile] = await fx.db
      .select({ avatarRef: profiles.avatarRef })
      .from(profiles)
      .where(eq(profiles.agentId, ownerAgentId))
      .limit(1);
    if (!ownerProfile) throw new Error("owner Task avatar profile seed missing");

    const secondHandle = `tasksapi-avatar-${randomUUID().slice(0, 8)}`;
    const [secondAgent] = await fx.db
      .insert(agents)
      .values({ handle: secondHandle })
      .returning({ id: agents.id });
    if (!secondAgent) throw new Error("second Task avatar agent seed failed");

    const orphanHandle = `tasksapi-avatar-orphan-${randomUUID().slice(0, 8)}`;
    const [orphanAgent] = await fx.db
      .insert(agents)
      .values({ handle: orphanHandle })
      .returning({ id: agents.id });
    if (!orphanAgent) throw new Error("orphan Task avatar agent seed failed");

    let secondTaskId: string | undefined;
    let orphanTaskId: string | undefined;
    try {
      // The owner's default profile is deliberately different. The Task must
      // resolve its own agent, never whichever owned profile happens to be
      // returned first by the database.
      await fx.db
        .update(profiles)
        .set({ avatarRef: { kind: "preset", id: "avatar-01" } })
        .where(eq(profiles.agentId, ownerAgentId));
      await fx.db.insert(profiles).values({
        userId: fx.ownerId,
        agentId: secondAgent.id,
        name: "Second task Genie",
        avatarRef: { kind: "preset", id: "avatar-02" },
      });

      const [secondTask] = await fx.db
        .insert(tasks)
        .values({
          ownerId: fx.ownerId,
          requestorId: fx.ownerId,
          agentId: secondAgent.id,
          prompt: "exact second Genie avatar",
          scheduleKind: "one_shot",
          runAt: new Date(FUTURE_RUN_AT),
          nextFireAt: new Date(FUTURE_RUN_AT),
        })
        .returning({ id: tasks.id });
      if (!secondTask) throw new Error("second Task avatar seed failed");
      secondTaskId = secondTask.id;

      const token = await fx.mintOwnerBearer();
      const avatarRes = await authedInject(fx.app, {
        method: "GET",
        url: `/api/tasks/${secondTask.id}/agent/avatar`,
        bearer: token,
      });
      expect(avatarRes.statusCode).toBe(200);
      expect(avatarRes.headers["content-type"]).toContain("image/webp");
      expect(avatarRes.headers["cache-control"]).toBe("private, no-cache");
      expect(avatarRes.headers.vary).toBe("Authorization");
      const expectedAvatar = readFileSync(
        resolve(import.meta.dirname, "../../src/onboarding/images/avatars/avatar-02.webp"),
      );
      expect(Buffer.from(avatarRes.rawPayload).equals(expectedAvatar)).toBe(true);

      // A stale profile reference is still an intentional Genie shell, not a
      // substitute avatar from the owner's other Agent.
      await fx.db
        .update(profiles)
        .set({ avatarRef: { kind: "uploaded", blobId: `missing-${randomUUID()}` } })
        .where(eq(profiles.agentId, secondAgent.id));
      const missingBlobRes = await authedInject(fx.app, {
        method: "GET",
        url: `/api/tasks/${secondTask.id}/agent/avatar`,
        bearer: token,
      });
      expect(missingBlobRes.statusCode).toBe(200);
      expect(missingBlobRes.headers["content-type"]).toContain("image/svg+xml");
      expect(missingBlobRes.body).toContain("Genie shell avatar");
      expect(missingBlobRes.headers["cache-control"]).toBe("private, no-cache");
      expect(missingBlobRes.headers.vary).toBe("Authorization");

      await fx.db
        .update(profiles)
        .set({ avatarRef: null })
        .where(eq(profiles.agentId, secondAgent.id));
      const nullAvatarRes = await authedInject(fx.app, {
        method: "GET",
        url: `/api/tasks/${secondTask.id}/agent/avatar`,
        bearer: token,
      });
      expect(nullAvatarRes.statusCode).toBe(200);
      expect(nullAvatarRes.headers["content-type"]).toContain("image/svg+xml");
      expect(nullAvatarRes.body).toContain("Genie shell avatar");

      // `profiles.userId` is a defensive owner match in addition to the
      // globally unique Agent ID. A malformed cross-owner profile link must
      // shell rather than expose that profile's bytes through this Task.
      await fx.db
        .update(profiles)
        .set({ userId: peer.userId, avatarRef: { kind: "preset", id: "avatar-02" } })
        .where(eq(profiles.agentId, secondAgent.id));
      const mismatchedProfileRes = await authedInject(fx.app, {
        method: "GET",
        url: `/api/tasks/${secondTask.id}/agent/avatar`,
        bearer: token,
      });
      expect(mismatchedProfileRes.statusCode).toBe(200);
      expect(mismatchedProfileRes.headers["content-type"]).toContain("image/svg+xml");
      expect(mismatchedProfileRes.body).toContain("Genie shell avatar");

      // The exact JSON reader shares the same owner+agent boundary. A corrupt
      // profile row cannot leak its name while the avatar correctly shells.
      const mismatchedDetailRes = await authedInject(fx.app, {
        method: "GET",
        url: `/api/tasks/${secondTask.id}`,
        bearer: token,
      });
      expect(mismatchedDetailRes.statusCode).toBe(200);
      expect((JSON.parse(mismatchedDetailRes.body) as { task: { agentName: string | null } }).task.agentName).toBeNull();

      const [orphanTask] = await fx.db
        .insert(tasks)
        .values({
          ownerId: fx.ownerId,
          requestorId: fx.ownerId,
          agentId: orphanAgent.id,
          prompt: "profileless Task Genie",
          scheduleKind: "one_shot",
          runAt: new Date(FUTURE_RUN_AT),
          nextFireAt: new Date(FUTURE_RUN_AT),
        })
        .returning({ id: tasks.id });
      if (!orphanTask) throw new Error("orphan Task avatar seed failed");
      orphanTaskId = orphanTask.id;
      const missingProfileRes = await authedInject(fx.app, {
        method: "GET",
        url: `/api/tasks/${orphanTask.id}/agent/avatar`,
        bearer: token,
      });
      expect(missingProfileRes.statusCode).toBe(200);
      expect(missingProfileRes.headers["content-type"]).toContain("image/svg+xml");
      expect(missingProfileRes.body).toContain("Genie shell avatar");
    } finally {
      if (secondTaskId) await fx.db.delete(tasks).where(eq(tasks.id, secondTaskId));
      if (orphanTaskId) await fx.db.delete(tasks).where(eq(tasks.id, orphanTaskId));
      await fx.db.delete(profiles).where(eq(profiles.agentId, secondAgent.id));
      await fx.db.delete(agents).where(eq(agents.id, secondAgent.id));
      await fx.db.delete(agents).where(eq(agents.id, orphanAgent.id));
      await fx.db
        .update(profiles)
        .set({ avatarRef: ownerProfile.avatarRef })
        .where(eq(profiles.agentId, ownerAgentId));
    }
  });

  test("D547 — task avatar fails closed for another owner, unknown Task, and unauthenticated lookup", async () => {
    const [peerTask] = await fx.db
      .insert(tasks)
      .values({
        ownerId: peer.userId,
        requestorId: peer.userId,
        agentId: peer.agentId,
        prompt: "peer Task avatar must stay private",
        scheduleKind: "one_shot",
        runAt: new Date(FUTURE_RUN_AT),
        nextFireAt: new Date(FUTURE_RUN_AT),
      })
      .returning({ id: tasks.id });
    if (!peerTask) throw new Error("peer Task avatar seed failed");

    try {
      const token = await fx.mintOwnerBearer();
      const crossOwner = await authedInject(fx.app, {
        method: "GET",
        url: `/api/tasks/${peerTask.id}/agent/avatar`,
        bearer: token,
      });
      expect(crossOwner.statusCode).toBe(404);
      expect(crossOwner.headers["cache-control"]).toBe("private, no-cache");
      expect(crossOwner.headers.vary).toBe("Authorization");

      const missing = await authedInject(fx.app, {
        method: "GET",
        url: `/api/tasks/${randomUUID()}/agent/avatar`,
        bearer: token,
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.body).toBe(crossOwner.body);
      expect(missing.headers["cache-control"]).toBe("private, no-cache");
      expect(missing.headers.vary).toBe("Authorization");

      const malformed = await authedInject(fx.app, {
        method: "GET",
        url: "/api/tasks/not-a-task-id/agent/avatar",
        bearer: token,
      });
      expect(malformed.statusCode).toBe(404);
      expect(malformed.headers["cache-control"]).toBe("private, no-cache");
      expect(malformed.headers.vary).toBe("Authorization");

      const unauthenticated = await fx.app.inject({
        method: "GET",
        url: `/api/tasks/${peerTask.id}/agent/avatar`,
      });
      expect(unauthenticated.statusCode).toBe(401);
      expect(unauthenticated.headers["cache-control"]).toBe("private, no-cache");
      expect(unauthenticated.headers.vary).toBe("Authorization");
    } finally {
      await fx.db.delete(tasks).where(eq(tasks.id, peerTask.id));
    }
  });

  test("POST creates a task; GET lists it; GET :id reads its shape", async () => {
    const token = await fx.mintOwnerBearer();
    const createRes = await authedInject(fx.app, {
      method: "POST",
      url: "/api/tasks",
      bearer: token,
      payload: {
        prompt: "Summarize the inbox",
        scheduleKind: "one_shot",
        runAt: FUTURE_RUN_AT,
        targetChat: "orphan",
        tools: ["run_shell"],
        expectedOutput: "a tidy summary",
        resultDelivery: "raw_and_wake",
      },
    });
    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.body) as {
      taskId: string;
      status: string;
      nextFireAt: string | null;
    };
    expect(created.status).toBe("pending");
    expect(created.nextFireAt).toBe(FUTURE_RUN_AT);

    const listRes = await authedInject(fx.app, {
      method: "GET",
      url: "/api/tasks",
      bearer: token,
    });
    expect(listRes.statusCode).toBe(200);
    const list = JSON.parse(listRes.body) as Array<{
      id: string;
      parentTaskId: string | null;
      depth: number;
      status: string;
      scheduleKind: string;
    }>;
    const row = list.find((t) => t.id === created.taskId);
    expect(row).toBeDefined();
    expect(row?.scheduleKind).toBe("one_shot");
    expect(row?.parentTaskId).toBeNull();
    expect(row?.depth).toBe(0);

    const getRes = await authedInject(fx.app, {
      method: "GET",
      url: `/api/tasks/${created.taskId}`,
      bearer: token,
    });
    expect(getRes.statusCode).toBe(200);
    const detail = JSON.parse(getRes.body) as {
      task: {
        id: string;
        parentTaskId: string | null;
        depth: number;
        targetChat: string;
        toolsMode: string;
        toolsWhitelist: string[];
        expectedOutput: string | null;
        resultDelivery: string;
        runAt: string | null;
        agentId: string | null;
        agentName: string | null;
        targetRoomId: string | null;
        requestedModelId: string | null;
        lastModelId: string | null;
      };
      runs: unknown[];
    };
    expect(detail.task.id).toBe(created.taskId);
    expect(detail.task.parentTaskId).toBeNull();
    expect(detail.task.depth).toBe(0);
    expect(detail.task.targetChat).toBe("orphan");
    expect(detail.task.toolsMode).toBe("whitelist");
    expect(detail.task.toolsWhitelist).toEqual(["run_shell"]);
    expect(detail.task.expectedOutput).toBe("a tidy summary");
    expect(detail.task.resultDelivery).toBe("raw_and_wake");
    expect(detail.task.runAt).toBe(FUTURE_RUN_AT);
    expect(detail.task.agentId).toBe(ownerAgentId);
    expect(detail.task.agentName).not.toBeNull();
    expect(detail.task.targetRoomId).toBeNull();
    expect(detail.task.requestedModelId).toBeNull();
    expect(detail.task.lastModelId).toBeNull();
    expect(detail.runs).toEqual([]);

    await fx.db.delete(tasks).where(eq(tasks.id, created.taskId));
  });

  test("list and detail agree for root, nested, and orphaned hierarchy rows", async () => {
    const fixture = TASK_SUMMARY_HIERARCHY_FIXTURES;
    const [root] = await fx.db
      .insert(tasks)
      .values({
        ownerId: fx.ownerId,
        requestorId: fx.ownerId,
        agentId: ownerAgentId,
        prompt: fixture.root.prompt,
        scheduleKind: "one_shot",
        runAt: new Date(FUTURE_RUN_AT),
        nextFireAt: new Date(FUTURE_RUN_AT),
        depth: fixture.root.expectedDepth,
      })
      .returning({ id: tasks.id });
    if (!root) throw new Error("seed root hierarchy task failed");

    const [nested] = await fx.db
      .insert(tasks)
      .values({
        ownerId: fx.ownerId,
        requestorId: fx.ownerId,
        agentId: ownerAgentId,
        prompt: fixture.nested.prompt,
        scheduleKind: "one_shot",
        runAt: new Date(FUTURE_RUN_AT),
        nextFireAt: new Date(FUTURE_RUN_AT),
        parentTaskId: root.id,
        depth: fixture.nested.expectedDepth,
      })
      .returning({ id: tasks.id });
    if (!nested) throw new Error("seed nested hierarchy task failed");

    const [deletedParent] = await fx.db
      .insert(tasks)
      .values({
        ownerId: fx.ownerId,
        requestorId: fx.ownerId,
        agentId: ownerAgentId,
        prompt: "Parent deleted by fixture",
        scheduleKind: "one_shot",
        runAt: new Date(FUTURE_RUN_AT),
        nextFireAt: new Date(FUTURE_RUN_AT),
      })
      .returning({ id: tasks.id });
    if (!deletedParent) throw new Error("seed deleted parent task failed");

    const [orphanedLineage] = await fx.db
      .insert(tasks)
      .values({
        ownerId: fx.ownerId,
        requestorId: fx.ownerId,
        agentId: ownerAgentId,
        prompt: fixture.orphanedLineage.prompt,
        scheduleKind: "one_shot",
        runAt: new Date(FUTURE_RUN_AT),
        nextFireAt: new Date(FUTURE_RUN_AT),
        parentTaskId: deletedParent.id,
        depth: fixture.orphanedLineage.expectedDepth,
      })
      .returning({ id: tasks.id });
    if (!orphanedLineage) throw new Error("seed orphaned hierarchy task failed");
    await fx.db.delete(tasks).where(eq(tasks.id, deletedParent.id));

    const [peerRoot] = await fx.db
      .insert(tasks)
      .values({
        ownerId: peer.userId,
        requestorId: peer.userId,
        agentId: peer.agentId,
        prompt: "Peer hierarchy root",
        scheduleKind: "one_shot",
        runAt: new Date(FUTURE_RUN_AT),
        nextFireAt: new Date(FUTURE_RUN_AT),
      })
      .returning({ id: tasks.id });
    if (!peerRoot) throw new Error("seed peer hierarchy task failed");

    const token = await fx.mintOwnerBearer();
    const listRes = await authedInject(fx.app, {
      method: "GET",
      url: "/api/tasks",
      bearer: token,
    });
    expect(listRes.statusCode).toBe(200);
    const rows = JSON.parse(listRes.body) as Array<{
      id: string;
      parentTaskId: string | null;
      depth: number;
    }>;
    expect(rows.some((row) => row.id === peerRoot.id)).toBe(false);

    const expected = new Map([
      [root.id, { parentTaskId: null, depth: fixture.root.expectedDepth }],
      [nested.id, { parentTaskId: root.id, depth: fixture.nested.expectedDepth }],
      [
        orphanedLineage.id,
        { parentTaskId: null, depth: fixture.orphanedLineage.expectedDepth },
      ],
    ]);
    for (const [taskId, hierarchy] of expected) {
      const row = rows.find((candidate) => candidate.id === taskId);
      expect(row).toMatchObject(hierarchy);

      const detailRes = await authedInject(fx.app, {
        method: "GET",
        url: `/api/tasks/${taskId}`,
        bearer: token,
      });
      expect(detailRes.statusCode).toBe(200);
      const detail = JSON.parse(detailRes.body) as {
        task: { parentTaskId: string | null; depth: number };
      };
      expect(detail.task).toMatchObject(hierarchy);
    }

    const peerRead = await authedInject(fx.app, {
      method: "GET",
      url: `/api/tasks/${nested.id}`,
      bearer: peer.bearer,
    });
    expect(peerRead.statusCode).toBe(404);

    await fx.db.delete(tasks).where(eq(tasks.id, nested.id));
    await fx.db.delete(tasks).where(eq(tasks.id, orphanedLineage.id));
    await fx.db.delete(tasks).where(eq(tasks.id, root.id));
    await fx.db.delete(tasks).where(eq(tasks.id, peerRoot.id));
  });

  test("Guest without invoke_agents cannot create a Task and receives the canonical denial", async () => {
    const before = await fx.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.ownerId, guest.userId));

    const res = await authedInject(fx.app, {
      method: "POST",
      url: "/api/tasks",
      bearer: guest.bearer,
      payload: {
        prompt: "This must not be accepted",
        scheduleKind: "one_shot",
        runAt: FUTURE_RUN_AT,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({
      error: "invoke_agents_required",
      code: "invoke_agents_required",
      capability: "invoke_agents",
    });
    const after = await fx.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.ownerId, guest.userId));
    expect(after).toEqual(before);
  });

  test("Guest without invoke_agents cannot patch or unpause an owned Task", async () => {
    const [seeded] = await fx.db
      .insert(tasks)
      .values({
        ownerId: guest.userId,
        requestorId: guest.userId,
        agentId: guest.agentId,
        prompt: "unchanged guest task",
        status: "paused",
        scheduleKind: "one_shot",
        runAt: new Date(FUTURE_RUN_AT),
        nextFireAt: new Date(FUTURE_RUN_AT),
      })
      .returning({ id: tasks.id });
    if (!seeded) throw new Error("seed guest task failed");

    const patchRes = await authedInject(fx.app, {
      method: "PATCH",
      url: `/api/tasks/${seeded.id}`,
      bearer: guest.bearer,
      payload: { prompt: "mutated" },
    });
    expect(patchRes.statusCode).toBe(403);
    expect(JSON.parse(patchRes.body)).toEqual({
      error: "invoke_agents_required",
      code: "invoke_agents_required",
      capability: "invoke_agents",
    });

    const unpauseRes = await authedInject(fx.app, {
      method: "POST",
      url: `/api/tasks/${seeded.id}/unpause`,
      bearer: guest.bearer,
    });
    expect(unpauseRes.statusCode).toBe(403);
    expect(JSON.parse(unpauseRes.body)).toEqual({
      error: "invoke_agents_required",
      code: "invoke_agents_required",
      capability: "invoke_agents",
    });

    const [after] = await fx.db
      .select({ prompt: tasks.prompt, status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, seeded.id));
    expect(after).toEqual({ prompt: "unchanged guest task", status: "paused" });

    await fx.db.delete(tasks).where(eq(tasks.id, seeded.id));
  });

  test("PATCH on a pending cron task recomputes next_fire_at (UTC)", async () => {
    const token = await fx.mintOwnerBearer();
    const createRes = await authedInject(fx.app, {
      method: "POST",
      url: "/api/tasks",
      bearer: token,
      payload: {
        prompt: "Morning standup nudge",
        scheduleKind: "cron",
        cron: "0 9 * * *",
        timezone: "UTC",
        targetChat: "orphan",
      },
    });
    expect(createRes.statusCode).toBe(201);
    const { taskId } = JSON.parse(createRes.body) as { taskId: string };

    const patchRes = await authedInject(fx.app, {
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      bearer: token,
      payload: { cron: "0 17 * * *" },
    });
    expect(patchRes.statusCode).toBe(200);
    const patched = JSON.parse(patchRes.body) as { nextFireAt: string | null };
    expect(patched.nextFireAt).not.toBeNull();
    expect(new Date(patched.nextFireAt!).getUTCHours()).toBe(17);

    await fx.db.delete(tasks).where(eq(tasks.id, taskId));
  });

  test("GET ?status=completed returns terminal tasks (not [])", async () => {
    // Regression: a status query must NOT be silently excluded by the store's
    // default terminal-hiding. Seed a completed task and confirm it lists.
    const [done] = await fx.db
      .insert(tasks)
      .values({
        ownerId: fx.ownerId,
        requestorId: fx.ownerId,
        agentId: ownerAgentId,
        prompt: "finished task",
        status: "completed",
        scheduleKind: "now",
        nextFireAt: new Date(),
      })
      .returning({ id: tasks.id });
    if (!done) throw new Error("seed completed task failed");

    const token = await fx.mintOwnerBearer();
    const res = await authedInject(fx.app, {
      method: "GET",
      url: "/api/tasks?status=completed&includeTerminal=true",
      bearer: token,
    });
    expect(res.statusCode).toBe(200);
    const list = JSON.parse(res.body) as Array<{ id: string; status: string }>;
    const row = list.find((t) => t.id === done.id);
    expect(row).toBeDefined();
    expect(row?.status).toBe("completed");
    // And the default (no status) list must hide it.
    const defaultRes = await authedInject(fx.app, {
      method: "GET",
      url: "/api/tasks",
      bearer: token,
    });
    const defaultList = JSON.parse(defaultRes.body) as Array<{ id: string }>;
    expect(defaultList.some((t) => t.id === done.id)).toBe(false);

    await fx.db.delete(tasks).where(eq(tasks.id, done.id));
  });

  test("GET terminal history is owner-scoped, bounded, and newest-first while active work stays complete", async () => {
    const prefix = `d547-recent-${randomUUID()}`;
    const active = await fx.db
      .insert(tasks)
      .values({
        ownerId: fx.ownerId,
        requestorId: fx.ownerId,
        agentId: ownerAgentId,
        prompt: `${prefix}-active`,
        status: "awaiting",
        scheduleKind: "now",
        nextFireAt: new Date("2050-01-01T00:00:00.000Z"),
        createdAt: new Date("2050-01-01T00:00:00.000Z"),
        updatedAt: new Date("2050-01-01T00:00:00.000Z"),
      })
      .returning({ id: tasks.id });
    const terminalSeeds = await fx.db
      .insert(tasks)
      .values([
        {
          ownerId: fx.ownerId,
          requestorId: fx.ownerId,
          agentId: ownerAgentId,
          prompt: `${prefix}-completed-old`,
          status: "completed",
          scheduleKind: "now",
          updatedAt: new Date("2050-02-01T00:00:00.000Z"),
        },
        {
          ownerId: fx.ownerId,
          requestorId: fx.ownerId,
          agentId: ownerAgentId,
          prompt: `${prefix}-cancelled`,
          status: "cancelled",
          scheduleKind: "now",
          updatedAt: new Date("2050-02-02T00:00:00.000Z"),
        },
        {
          ownerId: fx.ownerId,
          requestorId: fx.ownerId,
          agentId: ownerAgentId,
          prompt: `${prefix}-errored`,
          status: "errored",
          scheduleKind: "now",
          updatedAt: new Date("2050-02-03T00:00:00.000Z"),
        },
        {
          ownerId: fx.ownerId,
          requestorId: fx.ownerId,
          agentId: ownerAgentId,
          prompt: `${prefix}-completed-new`,
          status: "completed",
          scheduleKind: "now",
          updatedAt: new Date("2050-02-04T00:00:00.000Z"),
        },
      ])
      .returning({ id: tasks.id });
    const [peerTerminal] = await fx.db
      .insert(tasks)
      .values({
        ownerId: peer.userId,
        requestorId: peer.userId,
        agentId: peer.agentId,
        prompt: `${prefix}-peer-private`,
        status: "completed",
        scheduleKind: "now",
        updatedAt: new Date("2050-02-05T00:00:00.000Z"),
      })
      .returning({ id: tasks.id });
    if (!active[0] || terminalSeeds.length !== 4 || !peerTerminal) {
      throw new Error("recent terminal history seed failed");
    }

    const token = await fx.mintOwnerBearer();
    const historyRes = await authedInject(fx.app, {
      method: "GET",
      url: "/api/tasks?includeTerminal=true&recentTerminalLimit=2",
      bearer: token,
    });
    expect(historyRes.statusCode).toBe(200);
    const history = JSON.parse(historyRes.body) as Array<{
      id: string;
      prompt: string;
      updatedAt?: string;
    }>;
    const ownRows = history.filter((task) => task.prompt.startsWith(prefix));
    expect(ownRows.map((task) => task.id)).toEqual([
      active[0].id,
      terminalSeeds[3]!.id,
      terminalSeeds[2]!.id,
    ]);
    expect(new Set(history.map((task) => task.id)).size).toBe(history.length);
    expect(ownRows[1]?.updatedAt).toBe("2050-02-04T00:00:00.000Z");
    expect(ownRows[2]?.updatedAt).toBe("2050-02-03T00:00:00.000Z");

    const exactRes = await authedInject(fx.app, {
      method: "GET",
      url: "/api/tasks?status=completed&recentTerminalLimit=1",
      bearer: token,
    });
    expect(exactRes.statusCode).toBe(200);
    const exactRows = (JSON.parse(exactRes.body) as Array<{ id: string; prompt: string }>)
      .filter((task) => task.prompt.startsWith(prefix));
    expect(exactRows.map((task) => task.id)).toEqual([terminalSeeds[3]!.id]);

    const capSeeds = await fx.db
      .insert(tasks)
      .values(Array.from({ length: 51 }, (_, index) => ({
        ownerId: fx.ownerId,
        requestorId: fx.ownerId,
        agentId: ownerAgentId,
        prompt: `${prefix}-cap-${index}`,
        status: "completed" as const,
        scheduleKind: "now" as const,
        updatedAt: new Date(new Date("2051-01-01T00:00:00.000Z").getTime() + index * 1_000),
      })))
      .returning({ id: tasks.id });
    expect(capSeeds).toHaveLength(51);

    const capRowsFor = async (url: string) => {
      const response = await authedInject(fx.app, { method: "GET", url, bearer: token });
      expect(response.statusCode).toBe(200);
      return (JSON.parse(response.body) as Array<{ id: string; prompt: string }>)
        .filter((task) => task.prompt.startsWith(`${prefix}-cap-`));
    };
    // Omitted and non-numeric limits use the small server default. Zero and
    // negative values clamp to the minimum, fractional values truncate, and a
    // huge request clamps to the hard maximum rather than materializing an
    // unbounded archive.
    expect(await capRowsFor("/api/tasks?status=completed")).toHaveLength(5);
    expect(await capRowsFor("/api/tasks?includeTerminal=true")).toHaveLength(5);
    expect(await capRowsFor("/api/tasks?status=completed&recentTerminalLimit=not-a-number"))
      .toHaveLength(5);
    expect(await capRowsFor("/api/tasks?includeTerminal=true&recentTerminalLimit=0"))
      .toHaveLength(1);
    expect(await capRowsFor("/api/tasks?includeTerminal=true&recentTerminalLimit=-2"))
      .toHaveLength(1);
    expect(await capRowsFor("/api/tasks?includeTerminal=true&recentTerminalLimit=2.9"))
      .toHaveLength(2);
    const overMaxRows = await capRowsFor(
      "/api/tasks?includeTerminal=true&recentTerminalLimit=10000",
    );
    expect(overMaxRows).toHaveLength(50);
    expect(overMaxRows[0]?.id).toBe(capSeeds[50]?.id);
    expect(overMaxRows.at(-1)?.id).toBe(capSeeds[1]?.id);

    const peerRes = await authedInject(fx.app, {
      method: "GET",
      url: "/api/tasks?includeTerminal=true",
      bearer: peer.bearer,
    });
    expect(peerRes.statusCode).toBe(200);
    const peerRows = JSON.parse(peerRes.body) as Array<{ prompt: string }>;
    expect(peerRows.some((task) => task.prompt === `${prefix}-completed-new`)).toBe(false);

    const emptyRes = await authedInject(fx.app, {
      method: "GET",
      url: "/api/tasks?status=not-a-real-status",
      bearer: token,
    });
    expect(emptyRes.statusCode).toBe(200);
    expect(JSON.parse(emptyRes.body)).toEqual([]);

    await fx.db.delete(tasks).where(eq(tasks.id, active[0].id));
    await fx.db.delete(tasks).where(eq(tasks.id, peerTerminal.id));
    for (const task of terminalSeeds) {
      await fx.db.delete(tasks).where(eq(tasks.id, task.id));
    }
    for (const task of capSeeds) {
      await fx.db.delete(tasks).where(eq(tasks.id, task.id));
    }
  });

  test("PATCH a running task → 409 (status guard)", async () => {
    const [seeded] = await fx.db
      .insert(tasks)
      .values({
        ownerId: fx.ownerId,
        requestorId: fx.ownerId,
        agentId: ownerAgentId,
        prompt: "already running",
        status: "running",
        scheduleKind: "now",
        nextFireAt: new Date(),
      })
      .returning({ id: tasks.id });
    if (!seeded) throw new Error("seed task failed");

    const token = await fx.mintOwnerBearer();
    const patchRes = await authedInject(fx.app, {
      method: "PATCH",
      url: `/api/tasks/${seeded.id}`,
      bearer: token,
      payload: { prompt: "nope" },
    });
    expect(patchRes.statusCode).toBe(409);

    await fx.db.delete(tasks).where(eq(tasks.id, seeded.id));
  });

  test("owner-only: peer cannot GET/PATCH owner task; list omits it (404)", async () => {
    const token = await fx.mintOwnerBearer();
    const createRes = await authedInject(fx.app, {
      method: "POST",
      url: "/api/tasks",
      bearer: token,
      payload: {
        prompt: "owner private task",
        scheduleKind: "one_shot",
        runAt: FUTURE_RUN_AT,
      },
    });
    const { taskId } = JSON.parse(createRes.body) as { taskId: string };

    const getRes = await authedInject(fx.app, {
      method: "GET",
      url: `/api/tasks/${taskId}`,
      bearer: peer.bearer,
    });
    expect(getRes.statusCode).toBe(404);
    const missingRes = await authedInject(fx.app, {
      method: "GET",
      url: `/api/tasks/${randomUUID()}`,
      bearer: token,
    });
    const malformedRes = await authedInject(fx.app, {
      method: "GET",
      url: "/api/tasks/not-a-task-id",
      bearer: token,
    });
    expect(missingRes.statusCode).toBe(404);
    expect(malformedRes.statusCode).toBe(404);
    expect(missingRes.body).toBe(getRes.body);
    expect(malformedRes.body).toBe(getRes.body);

    const patchRes = await authedInject(fx.app, {
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      bearer: peer.bearer,
      payload: { prompt: "hijack" },
    });
    expect(patchRes.statusCode).toBe(404);

    const peerList = await authedInject(fx.app, {
      method: "GET",
      url: "/api/tasks",
      bearer: peer.bearer,
    });
    expect(peerList.statusCode).toBe(200);
    const list = JSON.parse(peerList.body) as Array<{ id: string }>;
    expect(list.some((t) => t.id === taskId)).toBe(false);

    await fx.db.delete(tasks).where(eq(tasks.id, taskId));
  });

  test("R3: not-yet-wired params are rejected with 400", async () => {
    const token = await fx.mintOwnerBearer();
    const dmRes = await authedInject(fx.app, {
      method: "POST",
      url: "/api/tasks",
      bearer: token,
      payload: { prompt: "p", targetChat: "new_dm" },
    });
    expect(dmRes.statusCode).toBe(400);
    expect((JSON.parse(dmRes.body) as { error: string }).error).toMatch(
      /lands in Phase 7/,
    );
  });

  // D429 Phase 3 — exact requestedModelId round-trip on the HTTP surface.
  describe("D429 Phase 3 — requestedModelId", () => {
    const SEL_KEYS = [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GOOGLE_API_KEY",
      "GEMINI_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "FIREWORKS_API_KEY",
      "OPENROUTER_API_KEY",
      "VENICE_API_KEY",
    ];
    const savedSel: Record<string, string | undefined> = {};
    function pinKeys(present: string[]) {
      for (const k of SEL_KEYS) {
        savedSel[k] = process.env[k];
        if (present.includes(k)) process.env[k] = "x";
        else delete process.env[k];
      }
    }
    function restoreKeys() {
      for (const [k, v] of Object.entries(savedSel)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }

    test("POST with a valid curated requestedModelId → 201; GET :id + list surface it separately from the run model", async () => {
      pinKeys(["ANTHROPIC_API_KEY"]);
      try {
        const token = await fx.mintOwnerBearer();
        const createRes = await authedInject(fx.app, {
          method: "POST",
          url: "/api/tasks",
          bearer: token,
          payload: {
            prompt: "pin the model",
            scheduleKind: "one_shot",
            runAt: FUTURE_RUN_AT,
            requestedModelId: "anthropic:claude-sonnet-4-6",
          },
        });
        expect(createRes.statusCode).toBe(201);
        const { taskId } = JSON.parse(createRes.body) as { taskId: string };

        const getRes = await authedInject(fx.app, {
          method: "GET",
          url: `/api/tasks/${taskId}`,
          bearer: token,
        });
        expect(getRes.statusCode).toBe(200);
        const detail = JSON.parse(getRes.body) as {
          task: { requestedModelId: string | null };
          runs: unknown[];
        };
        expect(detail.task.requestedModelId).toBe("anthropic:claude-sonnet-4-6");
        // No run yet → the actual run model is absent / null.
        expect(detail.runs).toEqual([]);

        const listRes = await authedInject(fx.app, {
          method: "GET",
          url: "/api/tasks",
          bearer: token,
        });
        const list = JSON.parse(listRes.body) as Array<{
          id: string;
          requestedModelId?: string | null;
          lastModelId?: string | null;
        }>;
        const row = list.find((t) => t.id === taskId);
        expect(row?.requestedModelId).toBe("anthropic:claude-sonnet-4-6");
        // requested (pin) is distinct from actual run model (no run yet).
        expect(row?.lastModelId).toBeNull();

        await fx.db.delete(tasks).where(eq(tasks.id, taskId));
      } finally {
        restoreKeys();
      }
    });

    test("POST with requestedModelId + selectionProfile → 422 conflict; nothing created", async () => {
      pinKeys(["ANTHROPIC_API_KEY"]);
      try {
        const token = await fx.mintOwnerBearer();
        const res = await authedInject(fx.app, {
          method: "POST",
          url: "/api/tasks",
          bearer: token,
          payload: {
            prompt: "p",
            requestedModelId: "anthropic:claude-sonnet-4-6",
            selectionProfile: "cheapest",
          },
        });
        expect(res.statusCode).toBe(422);
        const body = JSON.parse(res.body) as { error: string };
        expect(body.error).toContain("combine");
      } finally {
        restoreKeys();
      }
    });

    test("POST with a dynamic openrouter: requestedModelId → 422 unknown_model (v1: curated ids only)", async () => {
      pinKeys(["OPENROUTER_API_KEY"]);
      try {
        const token = await fx.mintOwnerBearer();
        const res = await authedInject(fx.app, {
          method: "POST",
          url: "/api/tasks",
          bearer: token,
          payload: {
            prompt: "p",
            requestedModelId: "openrouter:somevendor/unknown-model-v1",
          },
        });
        expect(res.statusCode).toBe(422);
        const body = JSON.parse(res.body) as { error: string };
        expect(body.error).toContain("curated");
      } finally {
        restoreKeys();
      }
    });

    test("PATCH sets requestedModelId; PATCH null clears it; omission preserves it", async () => {
      pinKeys(["ANTHROPIC_API_KEY"]);
      try {
        const [seed] = await fx.db
          .insert(tasks)
          .values({
            ownerId: fx.ownerId,
            requestorId: fx.ownerId,
            agentId: ownerAgentId,
            prompt: "patch target",
            status: "pending",
            scheduleKind: "one_shot",
            runAt: new Date(FUTURE_RUN_AT),
            targetChat: "orphan",
            nextFireAt: new Date(FUTURE_RUN_AT),
          })
          .returning({ id: tasks.id });
        if (!seed) throw new Error("seed task failed");

        const token = await fx.mintOwnerBearer();

        const setRes = await authedInject(fx.app, {
          method: "PATCH",
          url: `/api/tasks/${seed.id}`,
          bearer: token,
          payload: { requestedModelId: "anthropic:claude-sonnet-4-6" },
        });
        expect(setRes.statusCode).toBe(200);
        let row = await fx.db
          .select({ m: tasks.requestedModelId })
          .from(tasks)
          .where(eq(tasks.id, seed.id));
        expect(row[0]?.m).toBe("anthropic:claude-sonnet-4-6");

        // Omission preserves the pin (prompt-only patch does NOT clear).
        const noopRes = await authedInject(fx.app, {
          method: "PATCH",
          url: `/api/tasks/${seed.id}`,
          bearer: token,
          payload: { prompt: "changed prompt only" },
        });
        expect(noopRes.statusCode).toBe(200);
        row = await fx.db
          .select({ m: tasks.requestedModelId })
          .from(tasks)
          .where(eq(tasks.id, seed.id));
        expect(row[0]?.m).toBe("anthropic:claude-sonnet-4-6");

        // Explicit null clears the pin.
        const clearRes = await authedInject(fx.app, {
          method: "PATCH",
          url: `/api/tasks/${seed.id}`,
          bearer: token,
          payload: { requestedModelId: null },
        });
        expect(clearRes.statusCode).toBe(200);
        row = await fx.db
          .select({ m: tasks.requestedModelId })
          .from(tasks)
          .where(eq(tasks.id, seed.id));
        expect(row[0]?.m).toBeNull();

        await fx.db.delete(tasks).where(eq(tasks.id, seed.id));
      } finally {
        restoreKeys();
      }
    });

    test("PATCH tools-only change revalidates an existing exact pin and rejects newly enabled tools", async () => {
      pinKeys(["GOOGLE_API_KEY"]);
      try {
        const [seed] = await fx.db
          .insert(tasks)
          .values({
            ownerId: fx.ownerId,
            requestorId: fx.ownerId,
            agentId: ownerAgentId,
            prompt: "tool-free exact pin",
            status: "pending",
            scheduleKind: "one_shot",
            runAt: new Date(FUTURE_RUN_AT),
            targetChat: "orphan",
            nextFireAt: new Date(FUTURE_RUN_AT),
            requestedModelId: "google:gemini-2.5-pro",
            toolsMode: "none",
            toolsWhitelist: [],
          })
          .returning({ id: tasks.id });
        if (!seed) throw new Error("seed task failed");

        const token = await fx.mintOwnerBearer();
        const res = await authedInject(fx.app, {
          method: "PATCH",
          url: `/api/tasks/${seed.id}`,
          bearer: token,
          // Only tools change: none → non-empty whitelist.
          payload: { tools: ["search_memory"] },
        });
        expect(res.statusCode).toBe(422);
        expect((JSON.parse(res.body) as { error: string }).error).toContain(
          "tool",
        );

        // Rejection happens before updateTask: the persisted tools remain none.
        const row = await fx.db
          .select({
            mode: tasks.toolsMode,
            whitelist: tasks.toolsWhitelist,
            model: tasks.requestedModelId,
          })
          .from(tasks)
          .where(eq(tasks.id, seed.id));
        expect(row[0]).toEqual({
          mode: "none",
          whitelist: [],
          model: "google:gemini-2.5-pro",
        });

        await fx.db.delete(tasks).where(eq(tasks.id, seed.id));
      } finally {
        restoreKeys();
      }
    });
  });

  // M152 — multi-axis model selection on the HTTP surface. Provider-key env is
  // pinned per-test so the eligible pool is deterministic regardless of .env.
  describe("M152 model selection", () => {
    const SEL_KEYS = [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GOOGLE_API_KEY",
      "GEMINI_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "FIREWORKS_API_KEY",
      "OPENROUTER_API_KEY",
      "VENICE_API_KEY",
    ];
    const savedSel: Record<string, string | undefined> = {};
    function pinKeys(present: string[]) {
      for (const k of SEL_KEYS) {
        savedSel[k] = process.env[k];
        if (present.includes(k)) process.env[k] = "x";
        else delete process.env[k];
      }
    }
    function restoreKeys() {
      for (const [k, v] of Object.entries(savedSel)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }

    test("POST with an unsatisfiable private_cheap profile → 422 with actionable message; nothing created", async () => {
      pinKeys(["ANTHROPIC_API_KEY"]); // grade-1 only; no private (>=4) model
      try {
        const token = await fx.mintOwnerBearer();
        const res = await authedInject(fx.app, {
          method: "POST",
          url: "/api/tasks",
          bearer: token,
          payload: {
            prompt: "do this privately and cheaply",
            selectionProfile: "private_cheap",
          },
        });
        expect(res.statusCode).toBe(422);
        const body = JSON.parse(res.body) as { error: string; detail: { message: string } };
        expect(body.error).toContain("privacy grade");
        expect(body.detail.message).toContain("privacy grade");
      } finally {
        restoreKeys();
      }
    });

    test("POST with a satisfiable cheapest profile → 201; GET :id surfaces selectionProfile", async () => {
      pinKeys(["ANTHROPIC_API_KEY", "FIREWORKS_API_KEY"]);
      try {
        const token = await fx.mintOwnerBearer();
        const res = await authedInject(fx.app, {
          method: "POST",
          url: "/api/tasks",
          bearer: token,
          payload: {
            prompt: "do this cheaply",
            scheduleKind: "one_shot",
            runAt: FUTURE_RUN_AT,
            selectionProfile: "cheapest",
          },
        });
        expect(res.statusCode).toBe(201);
        const { taskId } = JSON.parse(res.body) as { taskId: string };

        const getRes = await authedInject(fx.app, {
          method: "GET",
          url: `/api/tasks/${taskId}`,
          bearer: token,
        });
        expect(getRes.statusCode).toBe(200);
        const detail = JSON.parse(getRes.body) as {
          task: { selectionProfile: string; selectionSpec: unknown };
        };
        expect(detail.task.selectionProfile).toBe("cheapest");
        expect(detail.task.selectionSpec).toBeNull();

        await fx.db.delete(tasks).where(eq(tasks.id, taskId));
      } finally {
        restoreKeys();
      }
    });

    test("PATCH to an unsatisfiable private profile → 422; satisfiable profile persists", async () => {
      // Seed a future-dated pending task to patch.
      const [seed] = await fx.db
        .insert(tasks)
        .values({
          ownerId: fx.ownerId,
          requestorId: fx.ownerId,
          agentId: ownerAgentId,
          prompt: "patch target",
          status: "pending",
          scheduleKind: "one_shot",
          runAt: new Date(FUTURE_RUN_AT),
          targetChat: "orphan",
          nextFireAt: new Date(FUTURE_RUN_AT),
        })
        .returning({ id: tasks.id });
      if (!seed) throw new Error("seed task failed");

      const token = await fx.mintOwnerBearer();
      pinKeys(["ANTHROPIC_API_KEY"]);
      try {
        const bad = await authedInject(fx.app, {
          method: "PATCH",
          url: `/api/tasks/${seed.id}`,
          bearer: token,
          payload: { selectionProfile: "private_smart" },
        });
        expect(bad.statusCode).toBe(422);

        const good = await authedInject(fx.app, {
          method: "PATCH",
          url: `/api/tasks/${seed.id}`,
          bearer: token,
          payload: { selectionProfile: "smartest" },
        });
        expect(good.statusCode).toBe(200);

        const row = await fx.db
          .select({ p: tasks.selectionProfile })
          .from(tasks)
          .where(eq(tasks.id, seed.id));
        expect(row[0]?.p).toBe("smartest");
      } finally {
        restoreKeys();
        await fx.db.delete(tasks).where(eq(tasks.id, seed.id));
      }
    });
  });

  test("GET :id surfaces the orphan run transcript (R7)", async () => {
    const [task] = await fx.db
      .insert(tasks)
      .values({
        ownerId: fx.ownerId,
        requestorId: fx.ownerId,
        agentId: ownerAgentId,
        prompt: "orphan helper",
        status: "completed",
        scheduleKind: "now",
        targetChat: "orphan",
        nextFireAt: new Date(),
      })
      .returning({ id: tasks.id });
    if (!task) throw new Error("seed task failed");

    const threadId = `subagent:task:${task.id}:${randomUUID()}`;
    const [run] = await fx.db
      .insert(taskRuns)
      .values({
        taskId: task.id,
        graphThreadId: threadId,
        status: "completed",
        modelId: "fireworks:accounts/fireworks/models/kimi-k2p6",
        resultText: "done",
      })
      .returning({ id: taskRuns.id });
    if (!run) throw new Error("seed run failed");

    const [session] = await fx.db
      .insert(sessions)
      .values({
        ownerId: fx.ownerId,
        threadId,
        personaId: "owner",
        agentId: ownerAgentId,
      })
      .returning({ id: sessions.id });
    if (!session) throw new Error("seed session failed");

    await fx.db.insert(sessionMessages).values([
      { sessionId: session.id, role: "user", content: "do the orphan thing" },
      { sessionId: session.id, role: "assistant", content: "I did the orphan thing" },
    ]);

    const token = await fx.mintOwnerBearer();
    const getRes = await authedInject(fx.app, {
      method: "GET",
      url: `/api/tasks/${task.id}`,
      bearer: token,
    });
    expect(getRes.statusCode).toBe(200);
    const detail = JSON.parse(getRes.body) as {
      runs: Array<{
        id: string;
        modelId: string | null;
        transcript?: Array<{ role: string; content: string }>;
      }>;
    };
    expect(detail.runs).toHaveLength(1);
    // M152 — GET :id surfaces the model the run actually used.
    expect(detail.runs[0]?.modelId).toBe(
      "fireworks:accounts/fireworks/models/kimi-k2p6",
    );
    // M163 — the transcript is now agent-authored only: the seeded `user` brief
    // row is filtered out, leaving the `assistant` row.
    expect(detail.runs[0]?.transcript).toBeDefined();
    expect(detail.runs[0]?.transcript?.map((m) => m.role)).toEqual([
      "assistant",
    ]);
    expect(detail.runs[0]?.transcript?.[0]?.content).toBe(
      "I did the orphan thing",
    );

    // M152 — list surfaces the most-recent run's model as `lastModelId`.
    const listRes = await authedInject(fx.app, {
      method: "GET",
      url: "/api/tasks?includeTerminal=true",
      bearer: token,
    });
    expect(listRes.statusCode).toBe(200);
    const list = JSON.parse(listRes.body) as Array<{
      id: string;
      lastModelId?: string | null;
    }>;
    expect(list.find((t) => t.id === task.id)?.lastModelId).toBe(
      "fireworks:accounts/fireworks/models/kimi-k2p6",
    );

    await fx.db
      .delete(sessionMessages)
      .where(eq(sessionMessages.sessionId, session.id));
    await fx.db.delete(sessions).where(eq(sessions.id, session.id));
    await fx.db.delete(taskRuns).where(eq(taskRuns.id, run.id));
    await fx.db.delete(tasks).where(eq(tasks.id, task.id));
  });

  test("M163 — GET :id surfaces a named-target run transcript (assistant+tool only, with toolCalls)", async () => {
    const [task] = await fx.db
      .insert(tasks)
      .values({
        ownerId: fx.ownerId,
        requestorId: fx.ownerId,
        agentId: ownerAgentId,
        prompt: "named-target helper",
        status: "completed",
        scheduleKind: "now",
        targetChat: "new_in_namespace",
        nextFireAt: new Date(),
      })
      .returning({ id: tasks.id });
    if (!task) throw new Error("seed task failed");

    // Named targets run on the agent's per-(room, agent) bot thread (NOT a
    // `subagent:`-prefixed thread). The thread is shared with normal chat.
    const roomId = randomUUID();
    const threadId = `room:${roomId}:bot:${ownerAgentId}`;
    const [run] = await fx.db
      .insert(taskRuns)
      .values({
        taskId: task.id,
        graphThreadId: threadId,
        status: "completed",
        modelId: "fireworks:accounts/fireworks/models/kimi-k2p6",
        resultText: "done",
      })
      .returning({ id: taskRuns.id });
    if (!run) throw new Error("seed run failed");

    const [session] = await fx.db
      .insert(sessions)
      .values({
        ownerId: fx.ownerId,
        threadId,
        personaId: "owner",
        agentId: ownerAgentId,
      })
      .returning({ id: sessions.id });
    if (!session) throw new Error("seed session failed");

    const toolCalls = JSON.stringify([
      { name: "search", args: { q: "x" }, id: "call_1" },
    ]);
    await fx.db.insert(sessionMessages).values([
      { sessionId: session.id, role: "system", content: "internal prompt" },
      { sessionId: session.id, role: "user", content: "synthetic brief" },
      { sessionId: session.id, role: "assistant", content: "", toolCalls },
      { sessionId: session.id, role: "tool", content: "Search was blocked before execution", toolName: "search",
        metadata: { nautilo_tool_result: { toolCallId: "call_1", toolStatus: "error" }, privateSidecar: "must-not-surface" } },
      { sessionId: session.id, role: "user", content: "PEER REPLY (must not appear)" },
    ]);

    const token = await fx.mintOwnerBearer();
    const getRes = await authedInject(fx.app, {
      method: "GET",
      url: `/api/tasks/${task.id}`,
      bearer: token,
    });
    expect(getRes.statusCode).toBe(200);
    const detail = JSON.parse(getRes.body) as {
      runs: Array<{
        transcript?: Array<{
          role: string;
          content: string;
          toolName: string | null;
          toolCalls: Array<{ name: string; args: unknown; id: string | null }> | null;
        }>;
      }>;
    };
    const transcript = detail.runs[0]?.transcript ?? [];
    expect(transcript.map((m) => m.role)).toEqual(["assistant", "tool"]);
    const contents = transcript.map((m) => m.content);
    expect(contents).not.toContain("internal prompt");
    expect(contents).not.toContain("synthetic brief");
    expect(contents).not.toContain("PEER REPLY (must not appear)");
    expect(transcript[0]?.toolCalls).toEqual([
      { name: "search", args: { q: "x" }, id: "call_1" },
    ]);
    expect(transcript[1]?.toolCalls).toBeNull();
    expect(transcript[1]).toMatchObject({ toolCallId: "call_1", toolStatus: "error", content: "Search was blocked before execution" });
    expect(JSON.stringify(transcript)).not.toContain("must-not-surface");

    await fx.db
      .delete(sessionMessages)
      .where(eq(sessionMessages.sessionId, session.id));
    await fx.db.delete(sessions).where(eq(sessions.id, session.id));
    await fx.db.delete(taskRuns).where(eq(taskRuns.id, run.id));
    await fx.db.delete(tasks).where(eq(tasks.id, task.id));
  });
});
