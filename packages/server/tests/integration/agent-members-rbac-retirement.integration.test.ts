/**
 * Stack 195 follow-up — integration coverage for the RETIRED
 * `/api/agents/:id/members` mutation verbs.
 *
 * Acceptance map:
 *   - POST /api/agents/:id/members (the legacy role-add shim) returns a
 *     stable 410 Gone with replacement guidance — it no longer mutates a
 *     server-wide canonical Group.
 *   - DELETE /api/agents/:id/members/:userId (the legacy role-remove shim)
 *     returns 410 Gone likewise.
 *   - An Admin (or any `manage_agents` holder) CANNOT promote/remove an
 *     Owner through the agent-members route: the owners Group membership
 *     is byte-for-byte unchanged after the refused calls, and the sole
 *     Owner is never removed even with `?bypass=true`.
 *   - The read-only GET routes are ALSO retired: an authenticated user
 *     (ordinary member OR admin/owner) gets 410 Gone for both
 *     `GET /api/agents/:id/members` and `GET /api/agents/:id/addable-users`
 *     — the server-wide roster / addable-user directory is no longer
 *     enumerable through the personal-Agent auth path. Anonymous gets 401
 *     (401 precedes 410). `GET /api/agents` (listing) stays 200.
 */
import { describe, expect, test } from "bun:test";
import {
  actors,
  agents,
  channelIdentities,
  eq,
  groupMembers,
  groups,
  profiles,
  users,
} from "@nautilo/db";
import { setupOwnerAppFixture, seatPeerUser, type AppFixture } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

async function findGroupId(fx: AppFixture, type: string): Promise<string> {
  const [row] = await fx.db
    .select({ id: groups.id })
    .from(groups)
    .where(eq(groups.type, type))
    .limit(1);
  if (!row) throw new Error(`canonical ${type} group missing`);
  return row.id;
}

async function cleanupPeer(fx: AppFixture, userId: string): Promise<void> {
  await fx.db.delete(profiles).where(eq(profiles.userId, userId));
  await fx.db.delete(channelIdentities).where(eq(channelIdentities.userId, userId));
  await fx.db.delete(groupMembers).where(eq(groupMembers.userId, userId));
  const peerAgentActors = await fx.db
    .select({ agentId: actors.agentId })
    .from(actors)
    .where(eq(actors.ownerId, userId));
  await fx.db.delete(actors).where(eq(actors.ownerId, userId));
  for (const a of peerAgentActors) {
    if (a.agentId) await fx.db.delete(agents).where(eq(agents.id, a.agentId));
  }
  await fx.db.delete(users).where(eq(users.id, userId));
}

const RETIRED_AGENT_ID = "00000000-0000-0000-0000-000000000000";

describe("Stack 195 follow-up — agent-members RBAC retirement (raw API)", () => {
  test(
    "retired POST/DELETE verbs return 410 Gone and cannot mutate the owners Group",
    async () => {
      const fx = await setupOwnerAppFixture({ suiteName: "s195ret" });
      const ownerBearer = await fx.mintOwnerBearer();
      const ownersGroupId = await findGroupId(fx, "owners");

      const admin = await seatPeerUser(fx.db, {
        suiteName: "s195ret",
        groupType: "admins",
      });

      try {
        // Snapshot the owners Group membership BEFORE the refused calls.
        const ownersBefore = await fx.db
          .select({ userId: groupMembers.userId })
          .from(groupMembers)
          .where(eq(groupMembers.groupId, ownersGroupId));

        // W3.0.2c-follow-up — POST (legacy role-add) returns 410 Gone.
        const adminPromoteOwner = await authedInject(fx.app, {
          method: "POST",
          url: `/api/agents/${RETIRED_AGENT_ID}/members`,
          bearer: admin.bearer,
          payload: { userId: admin.userId, roleSlug: "owner" },
        });
        expect(adminPromoteOwner.statusCode).toBe(410);
        const addBody = JSON.parse(adminPromoteOwner.body) as {
          code: string;
          reason: string;
          replacement: string;
        };
        expect(addBody.code).toBe("gone");
        expect(addBody.reason).toBe("agent_role_mutation_retired");
        expect(addBody.replacement).toContain("/api/groups/");

        // DELETE (legacy role-remove) returns 410 Gone even with bypass=true.
        const adminRemoveOwner = await authedInject(fx.app, {
          method: "DELETE",
          url: `/api/agents/${RETIRED_AGENT_ID}/members/${fx.ownerId}?role=owner&bypass=true`,
          bearer: admin.bearer,
        });
        expect(adminRemoveOwner.statusCode).toBe(410);
        const removeBody = JSON.parse(adminRemoveOwner.body) as {
          code: string;
          reason: string;
        };
        expect(removeBody.code).toBe("gone");
        expect(removeBody.reason).toBe("agent_role_mutation_retired");

        // The owners Group membership is byte-for-byte unchanged — the Admin
        // neither promoted themselves nor removed the sole Owner.
        const ownersAfter = await fx.db
          .select({ userId: groupMembers.userId })
          .from(groupMembers)
          .where(eq(groupMembers.groupId, ownersGroupId));
        expect(ownersAfter.map((r) => r.userId).sort()).toEqual(
          ownersBefore.map((r) => r.userId).sort(),
        );
        expect(ownersAfter.some((r) => r.userId === admin.userId)).toBe(false);
        expect(ownersAfter.some((r) => r.userId === fx.ownerId)).toBe(true);

        // An Owner calling the retired verbs also gets 410 (no privileged
        // bypass of the retirement).
        const ownerPromote = await authedInject(fx.app, {
          method: "POST",
          url: `/api/agents/${RETIRED_AGENT_ID}/members`,
          bearer: ownerBearer,
          payload: { userId: admin.userId, roleSlug: "owner" },
        });
        expect(ownerPromote.statusCode).toBe(410);

        // The read-only GET still requires a session (401 anonymous).
        const anonGet = await fx.app.inject({
          method: "GET",
          url: `/api/agents/${RETIRED_AGENT_ID}/members`,
        });
        expect(anonGet.statusCode).toBe(401);
      } finally {
        await cleanupPeer(fx, admin.userId);
        await fx.cleanup();
      }
    },
    120000,
  );
});

describe("Stack 195 follow-up — agent-members READ retirement (raw API)", () => {
  test(
    "GET /api/agents/:id/members + /addable-users return 410 Gone for any authenticated user; listing stays 200",
    async () => {
      const fx = await setupOwnerAppFixture({ suiteName: "s195getret" });
      const ownerBearer = await fx.mintOwnerBearer();

      // An ordinary authenticated member (no management caps).
      const member = await seatPeerUser(fx.db, {
        suiteName: "s195getret",
        groupType: "members",
      });
      // An admin (holds manage_agents + manage_members).
      const admin = await seatPeerUser(fx.db, {
        suiteName: "s195getret",
        groupType: "admins",
      });

      try {
        // An ordinary authenticated member CANNOT enumerate the roster
        // through the agent path — 410 Gone (not 200 + roster).
        const memberGetMembers = await authedInject(fx.app, {
          method: "GET",
          url: `/api/agents/${RETIRED_AGENT_ID}/members`,
          bearer: member.bearer,
        });
        expect(memberGetMembers.statusCode).toBe(410);
        const membersBody = JSON.parse(memberGetMembers.body) as {
          code: string;
          reason: string;
          replacement: string;
        };
        expect(membersBody.code).toBe("gone");
        expect(membersBody.reason).toBe("agent_roster_read_retired");
        expect(membersBody.replacement).toContain("/api/groups/");

        // An ordinary authenticated member CANNOT enumerate the addable
        // user directory through the agent path — 410 Gone likewise.
        const memberGetAddable = await authedInject(fx.app, {
          method: "GET",
          url: `/api/agents/${RETIRED_AGENT_ID}/addable-users`,
          bearer: member.bearer,
        });
        expect(memberGetAddable.statusCode).toBe(410);
        const addableBody = JSON.parse(memberGetAddable.body) as {
          code: string;
          reason: string;
        };
        expect(addableBody.code).toBe("gone");
        expect(addableBody.reason).toBe("agent_addable_users_read_retired");

        // The retirement is unconditional — even an Owner (full bundle) and
        // an Admin (manage_agents) get 410, not a roster. The per-Agent
        // model is false; Access Control is canonical.
        const ownerGetMembers = await authedInject(fx.app, {
          method: "GET",
          url: `/api/agents/${RETIRED_AGENT_ID}/members`,
          bearer: ownerBearer,
        });
        expect(ownerGetMembers.statusCode).toBe(410);
        const adminGetAddable = await authedInject(fx.app, {
          method: "GET",
          url: `/api/agents/${RETIRED_AGENT_ID}/addable-users`,
          bearer: admin.bearer,
        });
        expect(adminGetAddable.statusCode).toBe(410);

        // 401 precedes 410 — an anonymous probe learns nothing beyond
        // "sign in" (no retirement-surface leak either).
        const anonGetMembers = await fx.app.inject({
          method: "GET",
          url: `/api/agents/${RETIRED_AGENT_ID}/members`,
        });
        expect(anonGetMembers.statusCode).toBe(401);
        const anonGetAddable = await fx.app.inject({
          method: "GET",
          url: `/api/agents/${RETIRED_AGENT_ID}/addable-users`,
        });
        expect(anonGetAddable.statusCode).toBe(401);

        // The listing `GET /api/agents` is preserved — an authenticated
        // ordinary member still gets 200 (their personal Agents).
        const memberList = await authedInject(fx.app, {
          method: "GET",
          url: "/api/agents",
          bearer: member.bearer,
        });
        expect(memberList.statusCode).toBe(200);
        const listBody = JSON.parse(memberList.body) as { agents: unknown[] };
        expect(Array.isArray(listBody.agents)).toBe(true);
      } finally {
        await cleanupPeer(fx, member.userId);
        await cleanupPeer(fx, admin.userId);
        await fx.cleanup();
      }
    },
    120000,
  );
});
