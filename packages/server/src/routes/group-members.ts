import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { homedir } from "node:os";
import { join } from "node:path";
import { warn } from "@nautilo/logger";
import { db, eq, groups, groupRoles, roles } from "@nautilo/db";
import {
  applyDirectOperation,
  createProductionMutationEngineDeps,
  findCanonicalGroupByType,
  findUserById,
  listGroupMembers,
  MembershipOpError,
  userHasCapability,
  type AccessControlOperation,
  type ApplyResult,
  type RbacAuditEventInput,
} from "@nautilo/trust";
import { writeSecurityAuditEvent, type SecurityAuditEvent } from "../lib/security-audit-log";

/**
 * M128 — server-wide Group management (`/api/groups/...`). Replaces
 * the per-Agent `/api/agents/:id/members` route for the canonical
 * post-M128 path. The deprecated `agent-members.ts` route stays one
 * release as a thin alias.
 *
 * Endpoints:
 *   GET    /api/groups                  — list canonical Groups + role/label
 *   GET    /api/groups/:id/members      — list members of one Group
 *   PUT    /api/groups/:id/members/:userId — add user to Group
 *   DELETE /api/groups/:id/members/:userId — remove user from Group
 *
 * Authz (Stack 195 / W3.0.2): writes are routed through the shared
 * trust-layer anti-escalation resolver
 * (`resolveMembershipMutationAuthority`). A mutation requires the caller
 * to hold `manage_members` AND every Capability granted by the target
 * Group's complete current bundle, so an Admin cannot add to or remove
 * from the `owners` Group (whose `owner` Role bundles the Owner-only
 * `manage_server_settings` / `manage_server_security` Caps the Admin
 * lacks). Reduction is not an exemption: removing a member still requires
 * bundle authority. The last-Owner lifecycle rail is reimplemented inside
 * the shared command engine's execute (`MembershipOpError("last_owner")` →
 * 409); it is NO LONGER bypassable — a successful mutation may never leave
 * zero Owners, even with `bypass=true` (the flag is kept for legacy
 * compatibility but ignored for the sole-Owner case). Reads of
 * `/api/groups/:id/members` require `manage_members` (matching the UI
 * membership controls), not mere authentication, so a non-manager learns
 * neither the roster nor whether the Group exists. `GET /api/groups`
 * (the Group catalogue: IDs / types / labels / role slugs) likewise
 * requires at least one RBAC management cap
 * (`manage_members | manage_groups | manage_roles`), with 401 → 403
 * ordering, so an authenticated non-manager cannot enumerate the Group
 * set; the Access Control catalogue remains the canonical admin read.
 * Group CRUD (`manage_groups`) is not exposed here — Groups are the
 * canonical fixed set per `permission-model.md` §4.
 */

function auditPath(): string {
  return join(homedir(), ".nautilo", "logs", "security-audit.log");
}

/**
 * Build production engine deps with a request-scoped redacted audit writer
 * (attaches the ts/ip/userAgent envelope; throws on write failure so the
 * engine can surface `auditRecorded:false`). The legacy
 * `PUT/DELETE /api/groups/:id/members/:userId` route routes its writes
 * through the SAME shared command engine as the W3.2 preview/apply flow,
 * so direct API and legacy UI are equally protected.
 */
function makeEngineDeps(request: FastifyRequest): ReturnType<
  typeof createProductionMutationEngineDeps
> {
  return createProductionMutationEngineDeps({
    actorActorId: request.sessionActorId ?? null,
    appendAuditEvent: (payload: RbacAuditEventInput) => {
      writeSecurityAuditEvent(auditPath(), {
        ...payload,
        ts: new Date().toISOString(),
        ip: request.ip,
        userAgent: request.headers["user-agent"],
      } as SecurityAuditEvent);
    },
  });
}

/**
 * Map an engine denial to the stable 403 body the legacy route already
 * returns (`{ error, code, reason, missing }`). The `reason` is the first
 * failing check's code (e.g. `insufficient_authority` or
 * `missing_manage_members`); `missing` lists the Capabilities the actor
 * lacked. No secrets are disclosed — only Capability slugs the actor
 * already knows they lack.
 */
function authorizationDeniedBody(
  failures: readonly { code: string; missing?: readonly string[] | undefined }[],
) {
  const first = failures[0];
  return {
    error: "Forbidden",
    code: "authorization_denied",
    reason: first?.code ?? "authorization_denied",
    missing: first?.missing ?? [],
  };
}

function mapApplyResult(
  result: ApplyResult,
  reply: FastifyReply,
) {
  if (result.applied) {
    // Stack 195 follow-up — surface the audit-append outcome so a silent
    // audit failure is visible to the caller (and the operator). Warn so
    // the gap is observable even when the client ignores the field.
    if (!result.auditRecorded) {
      warn("[group-members] mutation applied but audit event was NOT recorded");
    }
    return reply.send({ ok: true, auditRecorded: result.auditRecorded });
  }
  if (result.code === "stale_preview") {
    return reply.code(409).send({ code: "stale_preview", reason: result.reason });
  }
  return reply.code(403).send(authorizationDeniedBody(result.failures));
}

/**
 * Resolve the target Group row once for both the authority resolver and
 * the audit payload. Returns `null` when the Group does not exist so the
 * route can 404 before consulting the resolver.
 */
async function resolveTargetGroup(
  groupId: string,
): Promise<{ id: string; type: string } | null> {
  const [groupRow] = await db
    .select({ id: groups.id, type: groups.type })
    .from(groups)
    .where(eq(groups.id, groupId))
    .limit(1);
  return groupRow ?? null;
}

export interface GroupMembersRoutesDeps {
  /** D538's target-membership classifier and post-success revoker for one Human. */
  readonly prepareMembershipRemoval?: (input: {
    readonly userId: string;
    readonly groupId: string;
    readonly actorId: string;
  }) => Promise<(() => unknown) | null>;
}

export function groupMembersRoutes(
  app: FastifyInstance,
  deps: GroupMembersRoutesDeps = {},
): void {
  app.get("/api/groups", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });
    // Stack 195 follow-up — the Group catalogue (IDs / types / labels / role
    // slugs) is a management surface, not a directory. Require at least one
    // RBAC management cap (manage_members | manage_groups | manage_roles)
    // before returning anything. Ordering is 401 → 403 so an authenticated
    // non-manager learns nothing about the canonical/custom Group set. The
    // Access Control catalogue remains the canonical admin read; this gate
    // only stops the unauthenticated-ish enumeration the bare route allowed.
    const holds =
      (await userHasCapability(userId, "manage_members")) ||
      (await userHasCapability(userId, "manage_groups")) ||
      (await userHasCapability(userId, "manage_roles"));
    if (!holds) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    // M131: a Group carries one or more Roles via `group_roles`. Aggregate
    // the Role slugs into `roleSlugs[]` per Group. LEFT JOIN so a Group
    // with no Roles still appears (with an empty array).
    const rows = await db
      .select({
        id: groups.id,
        type: groups.type,
        label: groups.label,
        roleSlug: roles.slug,
      })
      .from(groups)
      .leftJoin(groupRoles, eq(groupRoles.groupId, groups.id))
      .leftJoin(roles, eq(groupRoles.roleId, roles.id))
      .orderBy(groups.type);
    const byGroup = new Map<
      string,
      { id: string; type: string; label: string; roleSlugs: string[] }
    >();
    for (const r of rows) {
      let g = byGroup.get(r.id);
      if (!g) {
        g = { id: r.id, type: r.type, label: r.label, roleSlugs: [] };
        byGroup.set(r.id, g);
      }
      if (r.roleSlug && !g.roleSlugs.includes(r.roleSlug)) {
        g.roleSlugs.push(r.roleSlug);
      }
    }
    return reply.send({ groups: [...byGroup.values()] });
  });

  app.get<{ Params: { id: string } }>(
    "/api/groups/:id/members",
    async (request, reply) => {
      const userId = request.sessionUserId;
      if (!userId) return reply.code(401).send({ error: "Unauthorized" });
      // Stack 195 follow-up — the membership roster is a management surface
      // (it backs UI membership controls), so reads require `manage_members`,
      // not mere authentication. Ordering is 401 → 403 → 404 so a non-manager
      // learns neither the roster nor whether the Group exists (no leak).
      if (!(await userHasCapability(userId, "manage_members"))) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      const groupRow = await resolveTargetGroup(request.params.id);
      if (!groupRow) return reply.code(404).send({ error: "group_not_found" });
      const members = await listGroupMembers(request.params.id);
      return reply.send({ members });
    },
  );

  app.put<{ Params: { id: string; userId: string } }>(
    "/api/groups/:id/members/:userId",
    async (request, reply) => {
      const callerId = request.sessionUserId;
      if (!callerId) return reply.code(401).send({ error: "Unauthorized" });
      // Validate the group + target user exist (404) before consulting the
      // shared engine, preserving the legacy not-found semantics.
      const groupRow = await resolveTargetGroup(request.params.id);
      if (!groupRow) return reply.code(404).send({ error: "group_not_found" });
      const targetUser = await findUserById(request.params.userId);
      if (!targetUser) return reply.code(404).send({ error: "user_not_found" });
      // Stack 195 / W3.2 — route the write through the shared command engine
      // (the same engine the W3.2 preview/apply flow uses). The engine
      // enforces `manage_members` + bundle authority (reduction is not an
      // exemption), so an Admin cannot add to the `owners` Group. The audit
      // event is written by the engine's deps after the DB commit.
      const operation: AccessControlOperation = {
        kind: "membership.add",
        groupId: request.params.id,
        userId: request.params.userId,
      };
      let result: ApplyResult;
      try {
        result = await applyDirectOperation(makeEngineDeps(request), {
          actorUserId: callerId,
          actorActorId: request.sessionActorId ?? null,
          operation,
        });
      } catch (e) {
        if (e instanceof MembershipOpError && e.opCode === "last_owner") {
          return reply.code(409).send({ code: "last_owner" });
        }
        const msg = e instanceof Error ? e.message : String(e);
        warn(`[group-members] add failed: ${msg}`);
        return reply.code(500).send({ error: msg });
      }
      return mapApplyResult(result, reply);
    },
  );

  app.delete<{
    Params: { id: string; userId: string };
    Querystring: { bypass?: string };
  }>("/api/groups/:id/members/:userId", async (request, reply) => {
    const callerId = request.sessionUserId;
    if (!callerId) return reply.code(401).send({ error: "Unauthorized" });
    const groupRow = await resolveTargetGroup(request.params.id);
    if (!groupRow) return reply.code(404).send({ error: "group_not_found" });
    const targetUser = await findUserById(request.params.userId);
    if (!targetUser) return reply.code(404).send({ error: "user_not_found" });
    // Stack 195 / W3.2 — route the write through the shared command engine.
    // Reduction is not an exemption: removing a member still requires bundle
    // authority, so an Admin cannot remove an Owner even when multiple
    // Owners remain. The last-Owner lifecycle rail is reimplemented inside
    // the engine's execute: it throws `MembershipOpError("last_owner")` for a
    // sole-Owner removal. Stack 195 follow-up — that rail is NO LONGER
    // bypassable: a successful mutation may never leave zero Owners, so
    // `bypassLastOwner=true` is accepted for legacy compatibility but
    // ignored for the sole-Owner case (the removal is still rejected with
    // `last_owner`). The audit row therefore never carries
    // `bypassedRail:true` for a successful removal.
    const bypass = request.query.bypass === "true";
    const operation: AccessControlOperation = {
      kind: "membership.remove",
      groupId: request.params.id,
      userId: request.params.userId,
      bypassLastOwner: bypass,
    };
    const preparedRevoker = await deps.prepareMembershipRemoval?.({
      userId: operation.userId,
      groupId: operation.groupId,
      actorId: request.sessionActorId ?? callerId,
    }) ?? null;
    let result: ApplyResult;
    try {
      result = await applyDirectOperation(makeEngineDeps(request), {
        actorUserId: callerId,
        actorActorId: request.sessionActorId ?? null,
        operation,
      });
    } catch (e) {
      if (e instanceof MembershipOpError && e.opCode === "last_owner") {
        return reply.code(409).send({ code: "last_owner" });
      }
      const msg = e instanceof Error ? e.message : String(e);
      warn(`[group-members] remove failed: ${msg}`);
      return reply.code(500).send({ error: msg });
    }
    if (result.applied && preparedRevoker !== null) {
      try {
        await preparedRevoker();
      } catch (err) {
        // The DB mutation already committed; do not turn a successful removal
        // into a retryable 500. The next D538 dispatch still rechecks RBAC.
        warn(`[group-members] post-commit D538 revoke failed: ${String(err)}`);
      }
    }
    return mapApplyResult(result, reply);
  });

  // Re-export the type guard helper for tests.
  void findCanonicalGroupByType;
}
