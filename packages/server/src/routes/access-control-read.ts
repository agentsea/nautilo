/**
 * Stack 195 / W3.1.3 — read-only access-control read endpoints.
 *
 *   GET /api/access-control/me/effective-access
 *     Authenticated self: returns the caller's effective access + full
 *     provenance. Authentication only (no management capability required).
 *
 *   GET /api/admin/access-control/users/:userId/effective-access
 *     Authorized target user: returns the target's effective access +
 *     provenance. Requires at least one of
 *     `manage_members | manage_groups | manage_roles`. Unknown target →
 *     404; unauthorized caller → 403 (target data is never disclosed to a
 *     caller lacking the management capability).
 *
 *   GET /api/admin/access-control/catalogue
 *     Authorized catalogue: canonical capabilities, system/custom Role
 *     summaries (bundles + group counts), and system/custom Group
 *     summaries (role attachments, member counts, system discriminator,
 *     Group ownerId). Same management-capability gate as the target read.
 *
 *   GET /api/admin/access-control/users
 *     Authorized human directory: the minimal server-wide local Human rows
 *     (`{ userId, displayName, handle }`, stable-sorted) needed for custom
 *     Group owner/transfer and membership selection in the Workbench. Same
 *     coarse management-capability gate as the other Access Control reads
 *     (any of `manage_members | manage_groups | manage_roles`), so a
 *     `manage_groups`-only or `manage_roles`-only custom manager is not
 *     forced onto the `manage_members`-only `/api/admin/users` directory.
 *     Exposes only the three selection fields — never email, external IDs,
 *     capability bundles, disabled/offboard metadata, tokens, or secrets.
 *     Does NOT weaken `/api/admin/users` (which stays `manage_members`-only
 *     and returns the full admin directory shape); this is a distinct,
 *     narrower read.
 *
 * Bearer resolution depth: these routes rely on the default `policy`
 * depth (the preHandler populates `request.sessionUserId`), so no edit to
 * `auth/bearer-resolution-depth.ts` is required. The full-fidelity
 * provenance query is run in the handler (M213 `rbacProjection` collapses
 * each Group to one Role and is not reused as detailed provenance).
 *
 * See `wave-3-stack-195-tasks.md` W3.1.1–W3.1.3 / W3.1.7 and
 * `general-rbac-administration-followup.md` §2.1 / §3–4.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { asc, getSharedDirectDb, isNull, users } from "@nautilo/db";
import {
  getAccessControlCatalogue,
  getEffectiveAccessForUser,
  userHasCapability,
  type AccessControlCatalogue,
  type EffectiveAccessResponse,
} from "@nautilo/trust";

const MANAGEMENT_CAPABILITIES = [
  "manage_members",
  "manage_groups",
  "manage_roles",
] as const;

/**
 * Authorize an admin read: the caller must hold at least one of the three
 * RBAC management capabilities. Returns the caller's userId on success,
 * or sends 401/403 and returns null. A caller lacking all three caps gets
 * 403 so target user data is never disclosed to them.
 */
async function authorizeAdminRead(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<string | null> {
  const callerUserId = request.sessionUserId;
  if (!callerUserId) {
    reply.code(401).send({ error: "Unauthorized" });
    return null;
  }
  const held = await Promise.all(
    MANAGEMENT_CAPABILITIES.map((slug) => userHasCapability(callerUserId, slug)),
  );
  if (!held.some((h) => h)) {
    reply.code(403).send({ error: "Forbidden" });
    return null;
  }
  return callerUserId;
}

/**
 * Stack 195 / W3.2 — minimal Human directory row for Access Control
 * owner/member selection. Deliberately narrow: only the three fields the
 * Workbench needs to populate a custom Group owner/transfer picker and a
 * membership picker. No email, external IDs, capability bundles,
 * disabled/offboard metadata, tokens, or secrets — those stay on the
 * `manage_members`-gated `/api/admin/users` directory.
 */
interface AccessControlHumanRow {
  readonly userId: string;
  readonly displayName: string;
  readonly handle: string | null;
}

export function accessControlReadRoutes(app: FastifyInstance): void {
  // Self: authentication only.
  app.get("/api/access-control/me/effective-access", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const result = await getEffectiveAccessForUser(userId);
    if (!result) {
      // Authenticated caller with no resolvable user row — fail closed.
      return reply.code(401).send({ error: "Unauthorized" });
    }
    return reply.send(result satisfies EffectiveAccessResponse);
  });

  // Admin: target user effective access.
  app.get<{ Params: { userId: string } }>(
    "/api/admin/access-control/users/:userId/effective-access",
    async (request, reply) => {
      if (!(await authorizeAdminRead(request, reply))) return;
      const result = await getEffectiveAccessForUser(request.params.userId);
      if (!result) {
        return reply.code(404).send({ error: "user_not_found" });
      }
      return reply.send(result satisfies EffectiveAccessResponse);
    },
  );

  // Admin: catalogue.
  app.get("/api/admin/access-control/catalogue", async (request, reply) => {
    if (!(await authorizeAdminRead(request, reply))) return;
    const catalogue = await getAccessControlCatalogue();
    return reply.send(catalogue satisfies AccessControlCatalogue);
  });

  // Admin: minimal Human directory for owner/member selection.
  app.get("/api/admin/access-control/users", async (request, reply) => {
    if (!(await authorizeAdminRead(request, reply))) return;
    const db = getSharedDirectDb();
    // Local Humans only (server IS NULL): foreign-origin stub rows are not
    // candidates for ownership/membership on this Server. Stable sort by
    // displayName then userId so the picker order is deterministic across
    // calls. Selects only the three safe columns — nothing sensitive can
    // leak into the response.
    const rows = await db
      .select({
        id: users.id,
        name: users.name,
        handle: users.handle,
      })
      .from(users)
      .where(isNull(users.server))
      .orderBy(asc(users.name), asc(users.id));
    const out: AccessControlHumanRow[] = rows.map((r) => ({
      userId: r.id,
      displayName: r.name,
      handle: r.handle,
    }));
    return reply.send(out satisfies AccessControlHumanRow[]);
  });
}
