import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../.env") });

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  actors,
  agents,
  and,
  channelIdentities,
  credentials,
  eq,
  groupMembers,
  groups,
  namespaces,
  profiles,
  roomMembers,
  rooms,
  sessionMessageRecipientState,
  sessionMessages,
  sessions,
  users,
  inArray,
} from "@nautilo/db";
import { assertCanUseServerProviderCredentials } from "@nautilo/trust";
import {
  seatPeerUser,
  setupOwnerAppFixture,
  type AppFixture,
} from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

const ROLE_MATRIX = [
  { role: "owner", groupType: "owners" },
  { role: "admin", groupType: "admins" },
  { role: "superuser", groupType: "superusers" },
  { role: "member", groupType: "members" },
  { role: "contributor", groupType: "contributors" },
  { role: "community", groupType: "communities" },
  { role: "guest", groupType: "guests" },
] as const;

type CanonicalRole = (typeof ROLE_MATRIX)[number]["role"];
type SeatGroupType = Exclude<
  (typeof ROLE_MATRIX)[number]["groupType"],
  "communities"
>;

type SeatedHuman = {
  role: CanonicalRole;
  userId: string;
  actorId: string;
  agentId: string;
  bearer: string;
};

type DirectRoom = {
  roomId: string;
  namespaceId: string;
  targetAgentId: string;
  targetAgentHandle: string;
  explicitlyForeign: boolean;
};

let fx: AppFixture;
const humans = new Map<CanonicalRole, SeatedHuman>();
const ownedRooms = new Map<CanonicalRole, DirectRoom>();
const foreignRooms = new Map<CanonicalRole, DirectRoom>();
const paidDispatches: Array<{
  requestorId: string;
  agentId: string;
  roomId: string;
}> = [];
const fundingChecks: string[] = [];
let fundingMode: "allow-test-provider" | "production-server" =
  "allow-test-provider";

async function requireHuman(role: CanonicalRole): Promise<SeatedHuman> {
  const human = humans.get(role);
  if (!human) throw new Error(`missing ${role} Human fixture`);
  return human;
}

async function findAgentFixture(agentId: string): Promise<{
  actorId: string;
  ownerUserId: string;
  ownerActorId: string;
  handle: string;
}> {
  const [actor] = await fx.db
    .select({
      id: actors.id,
      ownerUserId: actors.ownerId,
      handle: agents.handle,
    })
    .from(actors)
    .innerJoin(agents, eq(agents.id, actors.agentId))
    .where(eq(actors.agentId, agentId))
    .limit(1);
  if (!actor) throw new Error(`missing Actor for Genie ${agentId}`);
  const [ownerActor] = await fx.db
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.ownerId, actor.ownerUserId), eq(actors.kind, "user")))
    .limit(1);
  if (!ownerActor) throw new Error(`missing Human owner Actor for Genie ${agentId}`);
  return {
    actorId: actor.id,
    ownerUserId: actor.ownerUserId,
    ownerActorId: ownerActor.id,
    handle: actor.handle,
  };
}

async function createDirectRoom(
  human: SeatedHuman,
  targetAgentId: string,
  label: string,
): Promise<DirectRoom> {
  const target = await findAgentFixture(targetAgentId);
  const explicitlyForeign = target.ownerUserId !== human.userId;
  const callerAgent = explicitlyForeign
    ? await findAgentFixture(human.agentId)
    : null;
  const humanActorIds = explicitlyForeign
    ? [human.actorId, target.ownerActorId]
    : [human.actorId];
  const [namespace] = await fx.db
    .insert(namespaces)
    .values({ scope: "private", label: `${label} namespace` })
    .returning({ id: namespaces.id });
  if (!namespace) throw new Error("namespace fixture insert failed");

  const [room] = await fx.db
    .insert(rooms)
    .values({
      ownerId: human.userId,
      type: "private",
      label,
      graphThreadId: `role-matrix:${randomUUID()}`,
      namespaceId: namespace.id,
      humanActorIds,
      createdBy: human.actorId,
    })
    .returning({ id: rooms.id });
  if (!room) throw new Error("Room fixture insert failed");

  await fx.db.insert(roomMembers).values([
    { roomId: room.id, actorId: human.actorId, roomRole: "admin" },
    ...(explicitlyForeign
      ? [{ roomId: room.id, actorId: target.ownerActorId, roomRole: "member" as const }]
      : []),
    ...(callerAgent
      ? [{ roomId: room.id, actorId: callerAgent.actorId, roomRole: "member" as const }]
      : []),
    { roomId: room.id, actorId: target.actorId, roomRole: "member" },
  ]);

  return {
    roomId: room.id,
    namespaceId: namespace.id,
    targetAgentId,
    targetAgentHandle: target.handle,
    explicitlyForeign,
  };
}

async function sendDirectMessage(human: SeatedHuman, room: DirectRoom) {
  return authedInject(fx.app, {
    method: "POST",
    url: "/api/chat",
    bearer: human.bearer,
    payload: {
      message: room.explicitlyForeign
        ? `@${room.targetAgentHandle} role matrix ${human.role} foreign Genie`
        : `role matrix ${human.role} own Genie`,
      roomId: room.roomId,
    },
  });
}

async function waitForPaidDispatchCount(expected: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (paidDispatches.length < expected && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  expect(paidDispatches).toHaveLength(expected);
}

beforeAll(async () => {
  fx = await setupOwnerAppFixture({
    suiteName: "invokeroles",
    withDefaultAgentGraph: true,
    createAppExtras: {
      chatRoutesDeps: {
        assertServerFunding: async (humanUserId, origin) => {
          fundingChecks.push(humanUserId);
          if (fundingMode === "production-server") {
            await assertCanUseServerProviderCredentials(humanUserId, origin);
          }
        },
        createForegroundJob: async (_ownerId, requestorId, _laneKey, input) => {
          const agentId = input["agentId"];
          const roomId = input["roomId"];
          if (typeof agentId !== "string" || typeof roomId !== "string") {
            throw new Error("fake paid dispatch requires exact Genie and Room ids");
          }
          paidDispatches.push({ requestorId, agentId, roomId });
          const id = randomUUID();
          return { id, virtualJobId: id };
        },
      },
    },
  });

  if (!fx.defaultAgentId) throw new Error("owner Genie fixture missing");
  humans.set("owner", {
    role: "owner",
    userId: fx.ownerId,
    actorId: fx.ownerActorId,
    agentId: fx.defaultAgentId,
    bearer: await fx.mintOwnerBearer(),
  });

  for (const entry of ROLE_MATRIX.filter(
    (candidate) => candidate.role !== "owner" && candidate.role !== "community",
  )) {
    const peer = await seatPeerUser(fx.db, {
      suiteName: "invokeroles",
      groupType: entry.groupType as SeatGroupType,
    });
    humans.set(entry.role, { role: entry.role, ...peer });
  }

  const communityPeer = await seatPeerUser(fx.db, {
    suiteName: "invokeroles",
    groupType: "contributors",
  });
  const [communityGroup] = await fx.db
    .select({ id: groups.id })
    .from(groups)
    .where(eq(groups.type, "communities"))
    .limit(1);
  if (!communityGroup) throw new Error("canonical Communities Group missing");
  await fx.db
    .delete(groupMembers)
    .where(eq(groupMembers.userId, communityPeer.userId));
  await fx.db.insert(groupMembers).values({
    groupId: communityGroup.id,
    userId: communityPeer.userId,
    grantedBy: communityPeer.actorId,
  });
  humans.set("community", { role: "community", ...communityPeer });

  const owner = await requireHuman("owner");
  const admin = await requireHuman("admin");
  for (const { role } of ROLE_MATRIX) {
    const human = await requireHuman(role);
    ownedRooms.set(
      role,
      await createDirectRoom(human, human.agentId, `${role} own Genie`),
    );
    foreignRooms.set(
      role,
      await createDirectRoom(
        human,
        role === "owner" ? admin.agentId : owner.agentId,
        `${role} foreign Genie`,
      ),
    );
  }
});

afterAll(async () => {
  if (!fx) return;

  const directRooms = [...ownedRooms.values(), ...foreignRooms.values()];
  for (const room of directRooms) {
    const roomSessions = await fx.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.roomId, room.roomId));
    for (const session of roomSessions) {
      const messages = await fx.db
        .select({ id: sessionMessages.id })
        .from(sessionMessages)
        .where(eq(sessionMessages.sessionId, session.id));
      if (messages.length > 0) {
        await fx.db
          .delete(sessionMessageRecipientState)
          .where(inArray(sessionMessageRecipientState.messageId, messages.map((row) => row.id)));
      }
      await fx.db
        .delete(sessionMessages)
        .where(eq(sessionMessages.sessionId, session.id));
      await fx.db.delete(sessions).where(eq(sessions.id, session.id));
    }
    await fx.db.delete(roomMembers).where(eq(roomMembers.roomId, room.roomId));
    await fx.db.delete(rooms).where(eq(rooms.id, room.roomId));
    await fx.db.delete(namespaces).where(eq(namespaces.id, room.namespaceId));
  }

  for (const { role } of ROLE_MATRIX) {
    if (role === "owner") continue;
    const human = humans.get(role);
    if (!human) continue;
    await fx.db.delete(profiles).where(eq(profiles.userId, human.userId));
    await fx.db.delete(actors).where(eq(actors.ownerId, human.userId));
    await fx.db.delete(agents).where(eq(agents.id, human.agentId));
    await fx.db
      .delete(groupMembers)
      .where(eq(groupMembers.userId, human.userId));
    await fx.db
      .delete(channelIdentities)
      .where(eq(channelIdentities.userId, human.userId));
    await fx.db.delete(credentials).where(eq(credentials.userId, human.userId));
    await fx.db.delete(users).where(eq(users.id, human.userId));
  }
  await fx.cleanup();
});

describe.serial("exact Genie invocation role matrix", () => {
  test("real HTTP admission distinguishes each canonical Role's own and foreign Genie authority", async () => {
    fundingMode = "allow-test-provider";

    for (const { role } of ROLE_MATRIX) {
      const human = await requireHuman(role);
      const ownRoom = ownedRooms.get(role);
      const foreignRoom = foreignRooms.get(role);
      if (!ownRoom || !foreignRoom) throw new Error(`missing ${role} Rooms`);

      const ownDispatchesBefore = paidDispatches.length;
      const ownResponse = await sendDirectMessage(human, ownRoom);
      if (role === "guest") {
        expect(ownResponse.statusCode, `${role} own Genie`).toBe(403);
        expect(JSON.parse(ownResponse.body)).toEqual({
          error: "invoke_agents_required",
          code: "invoke_agents_required",
          capability: "invoke_agents",
        });
        expect(paidDispatches).toHaveLength(ownDispatchesBefore);
      } else {
        expect(ownResponse.statusCode, `${role} own Genie`).toBe(202);
        expect(paidDispatches).toHaveLength(ownDispatchesBefore + 1);
        expect(paidDispatches.at(-1)).toEqual({
          requestorId: human.userId,
          agentId: ownRoom.targetAgentId,
          roomId: ownRoom.roomId,
        });
      }

      const foreignDispatchesBefore = paidDispatches.length;
      const foreignResponse = await sendDirectMessage(human, foreignRoom);
      if (role === "community") {
        expect(foreignResponse.statusCode, `${role} foreign Genie`).toBe(403);
        expect(JSON.parse(foreignResponse.body)).toEqual({
          error: "invoke_other_agents_required",
          code: "invoke_other_agents_required",
          capability: "invoke_other_agents",
        });
        expect(paidDispatches).toHaveLength(foreignDispatchesBefore);
      } else if (role === "guest") {
        expect(foreignResponse.statusCode, `${role} foreign Genie`).toBe(403);
        expect(JSON.parse(foreignResponse.body)).toEqual({
          error: "invoke_agents_required",
          code: "invoke_agents_required",
          capability: "invoke_agents",
        });
        expect(paidDispatches).toHaveLength(foreignDispatchesBefore);
      } else {
        expect(foreignResponse.statusCode, `${role} foreign Genie`).toBe(202);
        await waitForPaidDispatchCount(foreignDispatchesBefore + 1);
        expect(paidDispatches.at(-1)).toEqual({
          requestorId: human.userId,
          agentId: foreignRoom.targetAgentId,
          roomId: foreignRoom.roomId,
        });
      }
    }
  });

  test("production server funding preserves five active Roles and stops Community and Guest before paid dispatch", async () => {
    fundingMode = "production-server";

    for (const { role } of ROLE_MATRIX) {
      const human = await requireHuman(role);
      const ownRoom = ownedRooms.get(role);
      if (!ownRoom) throw new Error(`missing ${role} own Room`);
      const dispatchesBefore = paidDispatches.length;
      const fundingChecksBefore = fundingChecks.length;

      const response = await sendDirectMessage(human, ownRoom);
      if (role === "community") {
        expect(response.statusCode, role).toBe(403);
        expect(JSON.parse(response.body)).toEqual({
          error: "server_provider_credentials_required",
          code: "server_provider_credentials_required",
          capability: "use_server_provider_credentials",
        });
        expect(fundingChecks).toHaveLength(fundingChecksBefore + 1);
        expect(paidDispatches).toHaveLength(dispatchesBefore);
      } else if (role === "guest") {
        expect(response.statusCode, role).toBe(403);
        expect(JSON.parse(response.body)).toEqual({
          error: "invoke_agents_required",
          code: "invoke_agents_required",
          capability: "invoke_agents",
        });
        expect(fundingChecks).toHaveLength(fundingChecksBefore);
        expect(paidDispatches).toHaveLength(dispatchesBefore);
      } else {
        expect(response.statusCode, role).toBe(202);
        expect(fundingChecks).toHaveLength(fundingChecksBefore + 1);
        expect(paidDispatches).toHaveLength(dispatchesBefore + 1);
      }
    }
  });
});
