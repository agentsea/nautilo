import type { FastifyInstance } from "fastify";
import {
  findPersonalAgentsForUser,
  findAllAgents,
  userHasCapability,
} from "@nautilo/trust";

/**
 * Stack 195 follow-up — the legacy `/api/agents/:id/members` verbs are
 * RETIRED. The MUTATION verbs (POST/DELETE) were an M128 one-release
 * compatibility shim that mutated server-wide canonical Groups through
 * `addUserToAgentRole`/`removeUserFromAgentRole` with only agent-management
 * auth, which let an Admin (or any `manage_agents` holder) promote/remove an
 * Owner — a global role mutation pretending to be agent-scoped.
 *
 * The READ verbs (`GET /api/agents/:id/members` + `GET .../addable-users`)
 * are ALSO retired now: `listAgentMembers` / `listAddableUsersForAgent`
 * ignored `agentId` and returned the server-wide roster / user directory to
 * any caller who passed the personal-Agent auth (`assertCallerCanManageAgent`
 * accepts the owner of ANY personal Agent). That exposed the full roster /
 * addable-user directory through a personal-Agent auth path — the per-Agent
 * model is false (post-M128 Agents are Resources without per-Agent
 * permission semantics) and the Access Control catalogue is canonical.
 *
 * Every retired verb now returns a stable `410 Gone` with machine-readable
 * `code:"gone"` + replacement guidance pointing at the canonical surfaces:
 *   - roster / membership → `/api/groups/:id/members` (shared RBAC engine,
 *     gated on `manage_members`) and the Workbench Access Control catalogue.
 *   - role mutations → `PUT/DELETE /api/groups/:id/members/:userId`.
 *
 * The one preserved verb is the listing:
 *   GET /api/agents — list manageable (admin) / personal (non-admin) Agents.
 * No roster / addable-user enumeration is reachable through this module
 * anymore; no global role mutation reaches a canonical Group through it.
 */

export function agentMembersRoutes(app: FastifyInstance): void {
  app.get("/api/agents", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const admin = await userHasCapability(userId, "manage_agents");
    // M128 unify follow-up — non-admin Humans see their personal
    // Agents (post-D201 every Human has one Genie via `actors.agent_id`),
    // not the empty admin-scoped manageable list.
    const agents = admin
      ? await findAllAgents()
      : await findPersonalAgentsForUser(userId);
    return reply.send({ agents });
  });

  // Stack 195 follow-up — RETIRED read verb. Returned the server-wide roster
  // through a personal-Agent auth path (`listAgentMembers` ignored agentId).
  // 401 (no session) precedes 410 so an anonymous probe learns nothing about
  // the retirement surface beyond "sign in"; an authenticated ordinary user
  // gets 410 (not 200 + roster). Use `/api/groups/:id/members` (manage_members)
  // or the Access Control catalogue instead.
  app.get<{ Params: { id: string } }>("/api/agents/:id/members", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    return reply.code(410).send({
      code: "gone",
      error: "This endpoint is retired.",
      reason: "agent_roster_read_retired",
      replacement:
        "Use GET /api/groups/:id/members (manage_members) or the Access Control catalogue.",
    });
  });

  // Stack 195 follow-up — RETIRED read verb. `listAddableUsersForAgent`
  // ignored agentId and returned the server-wide user directory through a
  // personal-Agent auth path. 401 precedes 410 (same ordering as above).
  app.get<{ Params: { id: string } }>("/api/agents/:id/addable-users", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    return reply.code(410).send({
      code: "gone",
      error: "This endpoint is retired.",
      reason: "agent_addable_users_read_retired",
      replacement:
        "Use GET /api/groups/:id/members (manage_members) or the Access Control catalogue.",
    });
  });

  // Stack 195 follow-up — RETIRED mutation verb. Returns a stable 410 Gone
  // with machine-readable `code:"gone"` + replacement guidance so an
  // external old client can migrate. No global role mutation is reachable
  // through this agent-scoped route anymore; use
  // `PUT /api/groups/:id/members/:userId` (shared RBAC engine) instead.
  app.post<{
    Params: { id: string };
    Body: { userId?: string; roleSlug?: string; bypass?: boolean };
  }>("/api/agents/:id/members", async (_request, reply) => {
    return reply.code(410).send({
      code: "gone",
      error: "This endpoint is retired.",
      reason: "agent_role_mutation_retired",
      replacement: "Use PUT /api/groups/:id/members/:userId (shared RBAC engine).",
    });
  });

  // Stack 195 follow-up — RETIRED mutation verb. Returns a stable 410 Gone
  // with replacement guidance. Removing a server-wide Role through an
  // agent-scoped route is no longer permitted; use
  // `DELETE /api/groups/:id/members/:userId` instead.
  app.delete<{ Params: { id: string; userId: string }; Querystring: { role?: string; bypass?: string } }>(
    "/api/agents/:id/members/:userId",
    async (_request, reply) => {
      return reply.code(410).send({
        code: "gone",
        error: "This endpoint is retired.",
        reason: "agent_role_mutation_retired",
        replacement: "Use DELETE /api/groups/:id/members/:userId (shared RBAC engine).",
      });
    },
  );
}
