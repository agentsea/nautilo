import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../.env") });

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  actors,
  agents,
  capabilities,
  channelIdentities,
  credentials,
  eq,
  getTaskById,
  getTaskRuns,
  groupMembers,
  groupRoles,
  groups,
  inArray,
  namespaces,
  profiles,
  roleCapabilities,
  roles,
  roomMembers,
  rooms,
  sessionMessages,
  sessions,
  taskRuns,
  tasks,
  users,
} from "@nautilo/db";
import {
  AgentInvocationDeniedError,
  PersonalPolicyResolver,
  assertCanInvokeAgent,
  assertCanUseServerProviderCredentials,
  createAcceptedInvocationAuthority,
} from "@nautilo/trust";
import {
  authorizeTaskApprovalResume,
  createHumanApiTaskCreationProvenance,
  createTask,
  dispatchTaskRun,
  getPlaintextTaskCreationAdmission,
  type TaskJobManager,
} from "@nautilo/runtime";
import {
  seatPeerUser,
  setupOwnerAppFixture,
  type AppFixture,
} from "./helpers/app-fixture";

const FUTURE_RUN_AT = new Date("2035-01-01T00:00:00.000Z");
const ACTIVE_ROLES = [
  { role: "owner", groupType: "owners" },
  { role: "admin", groupType: "admins" },
  { role: "superuser", groupType: "superusers" },
  { role: "member", groupType: "members" },
  { role: "contributor", groupType: "contributors" },
] as const;

type ActiveRole = (typeof ACTIVE_ROLES)[number]["role"];
type HumanFixture = {
  role: ActiveRole | "community";
  userId: string;
  actorId: string;
  agentId: string;
};

let fx: AppFixture;
let policyResolver: PersonalPolicyResolver;
const humans = new Map<HumanFixture["role"], HumanFixture>();
const createdTaskIds: string[] = [];
const createdRoomIds = new Set<string>();
const createdNamespaceIds = new Set<string>();
const paidDispatches: Array<{
  ownerId: string;
  requestorId: string;
  agentId: string;
}> = [];
let noFundingRoleId: string | undefined;
let noFundingGroupId: string | undefined;

const paidJobManager: TaskJobManager = {
  createForegroundJob: async (ownerId, requestorId, _laneKey, input) => {
    const agentId = input["agentId"];
    if (typeof agentId !== "string") {
      throw new Error("fake paid Task dispatch requires an exact Genie id");
    }
    paidDispatches.push({ ownerId, requestorId, agentId });
    const id = randomUUID();
    return { id, virtualJobId: id };
  },
};

function requireHuman(role: HumanFixture["role"]): HumanFixture {
  const human = humans.get(role);
  if (!human) throw new Error(`missing ${role} Human fixture`);
  return human;
}

async function createForeignTask(
  requestor: HumanFixture,
  foreignAgentId: string,
  prompt: string,
) {
  const result = await createTask(
    {
      db: fx.db,
      observer: { kick() {} },
      invocationAuthority: createAcceptedInvocationAuthority(requestor.userId),
      provenance: createHumanApiTaskCreationProvenance({
        ownerId: requestor.userId,
        requestedParentTaskId: null,
      }),
      admission: getPlaintextTaskCreationAdmission(),
    },
    {
      ownerId: requestor.userId,
      requestorId: requestor.userId,
      agentId: foreignAgentId,
      prompt,
      preset: "schedule",
      scheduleKind: "one_shot",
      runAt: FUTURE_RUN_AT,
      targetChat: "orphan",
      resultDelivery: "wake",
      useScope: false,
      toolsMode: "auto",
      awaitResponse: false,
      depth: 0,
    },
  );
  createdTaskIds.push(result.taskId);
  return result;
}

async function claimedTask(taskId: string) {
  const fireLockId = randomUUID();
  await fx.db
    .update(tasks)
    .set({
      nextFireAt: new Date(),
      fireLockId,
      fireLockedAt: new Date(),
    })
    .where(eq(tasks.id, taskId));
  const task = await getTaskById(fx.db, taskId);
  if (!task || task.fireLockId !== fireLockId) {
    throw new Error(`failed to claim Task ${taskId}`);
  }
  return task;
}

async function rememberTaskRoom(taskId: string): Promise<void> {
  const task = await getTaskById(fx.db, taskId);
  if (!task?.targetRoomId) return;
  createdRoomIds.add(task.targetRoomId);
  const [room] = await fx.db
    .select({ namespaceId: rooms.namespaceId })
    .from(rooms)
    .where(eq(rooms.id, task.targetRoomId))
    .limit(1);
  if (room?.namespaceId) createdNamespaceIds.add(room.namespaceId);
}

async function moveToCanonicalGroup(
  human: HumanFixture,
  groupType: string,
): Promise<void> {
  const [group] = await fx.db
    .select({ id: groups.id })
    .from(groups)
    .where(eq(groups.type, groupType))
    .limit(1);
  if (!group) throw new Error(`canonical ${groupType} Group missing`);
  await fx.db.delete(groupMembers).where(eq(groupMembers.userId, human.userId));
  await fx.db.insert(groupMembers).values({
    groupId: group.id,
    userId: human.userId,
    grantedBy: human.actorId,
  });
}

async function createNoFundingInvocationGroup(): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [role] = await fx.db
    .insert(roles)
    .values({
      slug: `task-invocation-only-${suffix}`,
      label: "Task invocation without server funding",
      isSystem: false,
    })
    .returning({ id: roles.id });
  if (!role) throw new Error("no-funding Role fixture insert failed");
  noFundingRoleId = role.id;

  const [group] = await fx.db
    .insert(groups)
    .values({
      ownerId: fx.ownerId,
      isSystem: false,
      type: `task-invocation-only-${suffix}`,
      label: "Task invocation without server funding",
    })
    .returning({ id: groups.id });
  if (!group) throw new Error("no-funding Group fixture insert failed");
  noFundingGroupId = group.id;

  const capabilityRows = await fx.db
    .select({ id: capabilities.id, slug: capabilities.slug })
    .from(capabilities)
    .where(inArray(capabilities.slug, ["invoke_agents", "invoke_other_agents"]));
  expect(capabilityRows.map((row) => row.slug).sort()).toEqual([
    "invoke_agents",
    "invoke_other_agents",
  ]);
  await fx.db.insert(roleCapabilities).values(
    capabilityRows.map((capability) => ({
      roleId: role.id,
      capabilityId: capability.id,
    })),
  );
  await fx.db.insert(groupRoles).values({ groupId: group.id, roleId: role.id });
  return group.id;
}

async function moveToGroup(human: HumanFixture, groupId: string): Promise<void> {
  await fx.db.delete(groupMembers).where(eq(groupMembers.userId, human.userId));
  await fx.db.insert(groupMembers).values({
    groupId,
    userId: human.userId,
    grantedBy: human.actorId,
  });
}

beforeAll(async () => {
  fx = await setupOwnerAppFixture({
    suiteName: "taskrolerecheck",
    withDefaultAgentGraph: true,
  });
  if (!fx.defaultAgentId) throw new Error("owner Genie fixture missing");
  policyResolver = new PersonalPolicyResolver(fx.ownerId);
  humans.set("owner", {
    role: "owner",
    userId: fx.ownerId,
    actorId: fx.ownerActorId,
    agentId: fx.defaultAgentId,
  });

  for (const entry of ACTIVE_ROLES.filter(({ role }) => role !== "owner")) {
    const peer = await seatPeerUser(fx.db, {
      suiteName: "taskroles",
      groupType: entry.groupType,
    });
    humans.set(entry.role, { role: entry.role, ...peer });
  }

  const community = await seatPeerUser(fx.db, {
    suiteName: "taskroles",
    groupType: "contributors",
  });
  const communityHuman: HumanFixture = { role: "community", ...community };
  await moveToCanonicalGroup(communityHuman, "communities");
  humans.set("community", communityHuman);
});

afterAll(async () => {
  if (!fx) return;

  if (createdTaskIds.length > 0) {
    for (const taskId of createdTaskIds) await rememberTaskRoom(taskId);
    await fx.db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
  }
  if (createdRoomIds.size > 0) {
    const roomIds = [...createdRoomIds];
    const roomSessions = await fx.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(inArray(sessions.roomId, roomIds));
    const sessionIds = roomSessions.map((session) => session.id);
    if (sessionIds.length > 0) {
      await fx.db
        .delete(sessionMessages)
        .where(inArray(sessionMessages.sessionId, sessionIds));
      await fx.db.delete(sessions).where(inArray(sessions.id, sessionIds));
    }
    await fx.db.delete(roomMembers).where(inArray(roomMembers.roomId, roomIds));
    await fx.db.delete(rooms).where(inArray(rooms.id, roomIds));
  }
  if (createdNamespaceIds.size > 0) {
    await fx.db
      .delete(namespaces)
      .where(inArray(namespaces.id, [...createdNamespaceIds]));
  }

  if (noFundingGroupId) {
    await fx.db.delete(groups).where(eq(groups.id, noFundingGroupId));
  }
  if (noFundingRoleId) {
    await fx.db.delete(roles).where(eq(roles.id, noFundingRoleId));
  }

  for (const [role, human] of humans) {
    if (role === "owner") continue;
    await fx.db.delete(groupMembers).where(eq(groupMembers.userId, human.userId));
    await fx.db.delete(profiles).where(eq(profiles.userId, human.userId));
    await fx.db.delete(actors).where(eq(actors.ownerId, human.userId));
    await fx.db.delete(agents).where(eq(agents.id, human.agentId));
    await fx.db
      .delete(channelIdentities)
      .where(eq(channelIdentities.userId, human.userId));
    await fx.db.delete(credentials).where(eq(credentials.userId, human.userId));
    await fx.db.delete(users).where(eq(users.id, human.userId));
  }
  await fx.cleanup();
});

describe.serial("durable Task invocation Role rechecks", () => {
  test("active Roles create and fire foreign-Genie Tasks; Community is rejected before funding", async () => {
    const owner = requireHuman("owner");
    const admin = requireHuman("admin");

    for (const { role } of ACTIVE_ROLES) {
      const human = requireHuman(role);
      const foreignAgentId = role === "owner" ? admin.agentId : owner.agentId;
      const created = await createForeignTask(
        human,
        foreignAgentId,
        `${role} queued foreign Genie Task`,
      );
      const dispatchesBefore = paidDispatches.length;
      const outcome = await dispatchTaskRun(await claimedTask(created.taskId), {
        db: fx.db,
        jobManager: paidJobManager,
        resolver: policyResolver,
      });
      expect(outcome.kind, role).toBe("dispatched");
      expect(paidDispatches, role).toHaveLength(dispatchesBefore + 1);
      expect(paidDispatches.at(-1), role).toEqual({
        ownerId: human.userId,
        requestorId: human.userId,
        agentId: foreignAgentId,
      });
      expect(await getTaskRuns(fx.db, created.taskId), role).toHaveLength(1);
      await rememberTaskRoom(created.taskId);
    }

    const community = requireHuman("community");
    let fundingChecks = 0;
    const tasksBefore = await fx.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.ownerId, community.userId));
    const denial = await createTask(
      {
        db: fx.db,
        observer: { kick() {} },
        invocationAuthority: createAcceptedInvocationAuthority(community.userId),
        provenance: createHumanApiTaskCreationProvenance({
          ownerId: community.userId,
          requestedParentTaskId: null,
        }),
        admission: getPlaintextTaskCreationAdmission(),
        assertInvocation: assertCanInvokeAgent,
        assertServerFunding: async (humanUserId, origin) => {
          fundingChecks += 1;
          await assertCanUseServerProviderCredentials(humanUserId, origin);
        },
      },
      {
        ownerId: community.userId,
        requestorId: community.userId,
        agentId: owner.agentId,
        prompt: "Community queued foreign Genie Task",
        preset: "schedule",
        scheduleKind: "one_shot",
        runAt: FUTURE_RUN_AT,
        targetChat: "orphan",
        resultDelivery: "wake",
        useScope: false,
        toolsMode: "auto",
        awaitResponse: false,
        depth: 0,
      },
    ).catch((error: unknown) => error);
    expect(denial).toBeInstanceOf(AgentInvocationDeniedError);
    expect((denial as AgentInvocationDeniedError).code).toBe(
      "invoke_other_agents_required",
    );
    expect(fundingChecks).toBe(0);
    const tasksAfter = await fx.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.ownerId, community.userId));
    expect(tasksAfter).toEqual(tasksBefore);
  });

  test("revoking foreign-Genie authority after queueing pauses fire before paid dispatch", async () => {
    const member = requireHuman("member");
    const owner = requireHuman("owner");
    const created = await createForeignTask(
      member,
      owner.agentId,
      "queued before invoke_other_agents revocation",
    );
    await moveToCanonicalGroup(member, "communities");

    let fundingChecks = 0;
    const dispatchesBefore = paidDispatches.length;
    const outcome = await dispatchTaskRun(await claimedTask(created.taskId), {
      db: fx.db,
      jobManager: paidJobManager,
      assertInvocation: assertCanInvokeAgent,
      assertServerFunding: async (humanUserId, origin) => {
        fundingChecks += 1;
        await assertCanUseServerProviderCredentials(humanUserId, origin);
      },
    });

    expect(outcome).toEqual({ kind: "authorization_paused" });
    expect(fundingChecks).toBe(0);
    expect(paidDispatches).toHaveLength(dispatchesBefore);
    expect(await getTaskRuns(fx.db, created.taskId)).toEqual([]);
    expect(await getTaskById(fx.db, created.taskId)).toMatchObject({
      status: "paused",
      fireLockId: null,
      fireLockedAt: null,
    });
  });

  test("revoking only server funding after queueing pauses approval resume before graph execution", async () => {
    const contributor = requireHuman("contributor");
    const owner = requireHuman("owner");
    const created = await createForeignTask(
      contributor,
      owner.agentId,
      "queued before server-funding revocation",
    );
    await fx.db
      .update(tasks)
      .set({ status: "awaiting", nextFireAt: null })
      .where(eq(tasks.id, created.taskId));
    const graphThreadId = `task-role-resume:${randomUUID()}`;
    const [run] = await fx.db
      .insert(taskRuns)
      .values({
        taskId: created.taskId,
        graphThreadId,
        status: "awaiting",
      })
      .returning({ id: taskRuns.id });
    if (!run) throw new Error("awaiting TaskRun fixture insert failed");

    const noFundingGroup = await createNoFundingInvocationGroup();
    await moveToGroup(contributor, noFundingGroup);
    const rechecks: string[] = [];
    const dispatchesBefore = paidDispatches.length;
    const auth = await authorizeTaskApprovalResume(
      {
        taskId: created.taskId,
        threadId: graphThreadId,
        sessionUserId: contributor.userId,
      },
      {
        db: fx.db,
        assertInvocation: async (input) => {
          rechecks.push("invocation");
          await assertCanInvokeAgent(input);
        },
        assertServerFunding: async (humanUserId, origin) => {
          rechecks.push("funding");
          await assertCanUseServerProviderCredentials(humanUserId, origin);
        },
      },
    );

    expect(auth).toEqual({
      ok: false,
      status: 403,
      error: "server_provider_credentials_required",
      code: "server_provider_credentials_required",
      capability: "use_server_provider_credentials",
    });
    expect(rechecks).toEqual(["invocation", "funding"]);
    expect(paidDispatches).toHaveLength(dispatchesBefore);
    expect(await getTaskById(fx.db, created.taskId)).toMatchObject({
      status: "paused",
    });
    const runs = await getTaskRuns(fx.db, created.taskId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(run.id);
    expect(runs[0]?.status).toBe("paused");
  });
});
