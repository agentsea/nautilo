import { describe, expect, test } from "bun:test";
import { eq, profiles, users } from "@nautilo/db";
import { setupOwnerAppFixture, seatPeerUser } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

describe("admin capability gates (D219 S2)", () => {
  test("distinct server capabilities widen access while lower tiers stay limited or denied", async () => {
    const fx = await setupOwnerAppFixture({
      suiteName: "d219caps",
      withDefaultAgentGraph: true,
    });
    const cleanupUserIds: string[] = [];
    try {
      const admin = await seatPeerUser(fx.db, { suiteName: "d219caps", groupType: "admins" });
      const superuser = await seatPeerUser(fx.db, {
        suiteName: "d219caps",
        groupType: "superusers",
      });
      const member = await seatPeerUser(fx.db, { suiteName: "d219caps", groupType: "members" });
      cleanupUserIds.push(admin.userId, superuser.userId, member.userId);

      const adminInvites = await authedInject(fx.app, {
        method: "GET",
        url: "/api/invites?all=true",
        bearer: admin.bearer,
      });
      expect(adminInvites.statusCode).toBe(200);
      const memberInvites = await authedInject(fx.app, {
        method: "GET",
        url: "/api/invites?all=true",
        bearer: member.bearer,
      });
      expect(memberInvites.statusCode).toBe(403);

      const roomsForSuperuser = await authedInject(fx.app, {
        method: "GET",
        url: "/api/rooms/manageable",
        bearer: superuser.bearer,
      });
      expect(roomsForSuperuser.statusCode).toBe(200);
      const superuserRoomsBody = JSON.parse(roomsForSuperuser.body) as {
        rooms: Array<{ id: string }>;
      };
      expect(superuserRoomsBody.rooms.some((r) => r.id === fx.defaultRoomId)).toBe(true);

      const roomsForMember = await authedInject(fx.app, {
        method: "GET",
        url: "/api/rooms/manageable",
        bearer: member.bearer,
      });
    expect(roomsForMember.statusCode).toBe(200);
    const memberRoomsBody = JSON.parse(roomsForMember.body) as { rooms: Array<{ id: string }> };
    // The canonical `member` Role bundle INCLUDES `manage_rooms` (only
    // `manage_agents`, the meta-admin caps, and approvals are stripped at
    // member/superuser tiers — see seed-trust-personal.ts MEMBER_REMOVES).
    // So a member legitimately sees manageable rooms; room visibility is
    // NOT a tier differentiator here. The real ladder gates that DO differ
    // are `/api/invites` (member 403 above) and `/api/agents` (member can't
    // see the agent below — `manage_agents` IS stripped at this tier).
    expect(memberRoomsBody.rooms.some((r) => r.id === fx.defaultRoomId)).toBe(true);

      // `/api/agents` returns ALL agents only to callers with the
      // `manage_agents` capability; everyone else sees only their OWN
      // agents (route: agent-members.ts → findAllAgents vs
      // findPersonalAgentsForUser). `manage_agents` is stripped at the
      // superuser tier and below (seed-trust-personal.ts SUPERUSER_REMOVES),
      // so only owner/admin can see the owner's default agent. Use the
      // ADMIN tier for the positive case — superuser would only ever see
      // its own personal agent, never the owner's.
      const agentsForAdmin = await authedInject(fx.app, {
        method: "GET",
        url: "/api/agents",
        bearer: admin.bearer,
      });
      expect(agentsForAdmin.statusCode).toBe(200);
      const adminAgentsBody = JSON.parse(agentsForAdmin.body) as {
        agents: Array<{ agentId: string }>;
      };
      expect(adminAgentsBody.agents.some((a) => a.agentId === fx.defaultAgentId)).toBe(true);

      const agentsForMember = await authedInject(fx.app, {
        method: "GET",
        url: "/api/agents",
        bearer: member.bearer,
      });
      expect(agentsForMember.statusCode).toBe(200);
      const memberAgentsBody = JSON.parse(agentsForMember.body) as {
        agents: Array<{ agentId: string }>;
      };
      expect(memberAgentsBody.agents.some((a) => a.agentId === fx.defaultAgentId)).toBe(false);
    } finally {
      for (const userId of cleanupUserIds) {
        await fx.db.delete(profiles).where(eq(profiles.userId, userId));
        await fx.db.delete(users).where(eq(users.id, userId));
      }
      await fx.cleanup();
    }
  });
});
