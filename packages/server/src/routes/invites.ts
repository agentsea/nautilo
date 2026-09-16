import type { HumanMembershipEventProducer } from "../event-feed/membership-producer";
import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { warn } from "@nautilo/logger";
import {
  invites,
  inviteRedemptions,
  rooms,
  groups,
  groupRoles,
  hasClaimedOwner,
  roles,
  actors,
  roomMembers,
  users,
  eq,
  and,
  or,
  lt,
  desc,
  inArray,
  isNull,
  db,
} from "@nautilo/db";
import {
  getUserCapabilities,
  findPersonalAgentsForUser,
  findAllAgents,
  findUserById,
  SERVER_ROLE_TO_GROUP_TYPE,
  type ServerRoleSlug,
  getLogtoAdminClient,
  verifyLogtoAccessToken,
} from "@nautilo/trust";
import { HANDLE_RE } from "@nautilo/types";
import { refreshRoomSubscriptionsForUser } from "../realtime/ws-publisher";
import { writeSecurityAuditEvent } from "../lib/security-audit-log";
import type { SecurityAuditEvent } from "../lib/security-audit-log";
import {
  redeemInviteAtomically,
  completeInviteProfile,
  extractInviteTokenFromInput,
  type RedeemInput,
  type CompleteInviteProfileArgs,
} from "../lib/redeem-invite";
import {
  checkInviteIpLimit,
  isInviteTokenLockedOut,
  recordInviteRedeemFailure,
  resetInviteTokenFailures,
} from "../lib/invite-rate-limit";
import {
  requestAllowsLoopbackTrust,
  requestAllowsPrivilegedSetup,
} from "../lib/request-trust";
import {
  inviteAuthorityFromCapabilities,
  inviteRevocationAllowed,
  inviteRoleAllowed,
  inviteRoomAllowed,
  type InviteAuthority,
} from "../lib/invite-authority";

const INV_PREFIX = "inv_";
const TOKEN_BYTES = 24;
// Must match mintInviteToken(): 24 random bytes become 32 base64url chars.
const OWNER_CLAIM_RE = /^inv_[A-Za-z0-9_-]{32}$/;

const OwnerClaimRedeemBodySchema = z.object({
  schemaVersion: z.literal(1),
  claim: z.string().regex(OWNER_CLAIM_RE),
  handle: z.string(),
  displayName: z.string(),
  password: z.string(),
  pin: z.string(),
}).strict();

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function mintInviteToken(): string {
  return INV_PREFIX + randomBytes(TOKEN_BYTES).toString("base64url");
}

function audit(
  auditLogPath: string,
  request: FastifyRequest,
  event: SecurityAuditEvent,
): boolean {
  try {
    writeSecurityAuditEvent(auditLogPath, {
      ...event,
      ts: new Date().toISOString(),
      ip: request.ip,
      userAgent: request.headers["user-agent"],
    } as SecurityAuditEvent);
    return true;
  } catch (err) {
    warn(`[invites] audit write failed: ${String(err)}`);
    return false;
  }
}

const INVITE_LIST_DEFAULT_LIMIT = 50;
const INVITE_LIST_MAX_LIMIT = 100;
async function resolveInviteAuthority(userId: string): Promise<InviteAuthority> {
  return inviteAuthorityFromCapabilities(await getUserCapabilities(userId));
}
const inviteCursorSchema = z.object({
  version: z.literal(1),
  createdAt: z.string().datetime(),
  id: z.string().min(1).max(128),
}).strict();

function encodeInviteCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({
    version: 1,
    createdAt: row.createdAt.toISOString(),
    id: row.id,
  }), "utf8").toString("base64url");
}

function decodeInviteCursor(raw: string | undefined): { createdAt: Date; id: string } | null {
  if (raw === undefined) return null;
  if (raw.length < 1 || raw.length > 512) return null;
  try {
    const parsed = inviteCursorSchema.parse(
      JSON.parse(Buffer.from(raw, "base64url").toString("utf8")),
    );
    return { createdAt: new Date(parsed.createdAt), id: parsed.id };
  } catch {
    return null;
  }
}

function resolveLogtoAdmin(): ReturnType<typeof getLogtoAdminClient> | null {
  try {
    return getLogtoAdminClient();
  } catch {
    return null;
  }
}

type OwnerClaimLookup =
  | { readonly outcome: "active"; readonly token: string; readonly row: typeof invites.$inferSelect }
  | { readonly outcome: "missing" | "expired" | "used" };

/**
 * Hosted-owner claims are accepted only from protected request bodies. Keeping
 * this lookup separate from the legacy URL-token routes prevents a future
 * claim endpoint from accidentally accepting an ordinary server invite.
 */
async function lookupActiveOwnerClaim(
  raw: unknown,
  opts: { allowCompletedProfileRetry?: boolean } = {},
): Promise<OwnerClaimLookup> {
  if (typeof raw !== "string" || !OWNER_CLAIM_RE.test(raw)) {
    return { outcome: "missing" };
  }
  // A restored pre-D488 database can contain a historical active claim next
  // to an already-bound canonical owner. Owner truth always wins: such a row
  // is not a second-owner capability and must never re-enter setup.
  if (!opts.allowCompletedProfileRetry && await hasClaimedOwner(db)) {
    return { outcome: "used" };
  }
  const token = raw;
  const [row] = await db
    .select()
    .from(invites)
    .where(eq(invites.tokenHash, sha256Hex(token)))
    .limit(1);
  if (!row || row.kind !== "claim" || row.revokedAt) return { outcome: "missing" };
  if (
    !opts.allowCompletedProfileRetry &&
    row.expiresAt &&
    row.expiresAt.getTime() <= Date.now()
  ) {
    return { outcome: "expired" };
  }
  if (
    !opts.allowCompletedProfileRetry &&
    row.maxUses !== null &&
    row.usedCount >= row.maxUses
  ) {
    return { outcome: "used" };
  }
  return { outcome: "active", token, row };
}

function ownerClaimFailure(reply: { code: (status: number) => { send: (body: Record<string, string>) => unknown } }, outcome: Exclude<OwnerClaimLookup["outcome"], "active">): unknown {
  if (outcome === "missing") return reply.code(404).send({ error: "not_found" });
  return reply.code(410).send({ error: outcome === "expired" ? "expired" : "used_up" });
}

/**
 * A claim capability can disclose whether a prior bind reserved it, but it
 * does not identify the browser's future Logto subject. That remains the
 * bind route's transaction-time decision. Resolve the persisted handle only
 * for the resume preparation response, where it becomes the existing opaque
 * bind-state input rather than Human-supplied form data.
 */
async function resolveOwnerClaimContinuation(
  row: typeof invites.$inferSelect,
): Promise<
  | { readonly ok: true; readonly continuation: "new-owner" }
  | { readonly ok: true; readonly continuation: "resume-owner"; readonly handle: string }
  | { readonly ok: false }
> {
  const [binding] = await db
    .select({ userId: inviteRedemptions.userId })
    .from(inviteRedemptions)
    .where(
      and(
        eq(inviteRedemptions.inviteId, row.id),
        isNull(inviteRedemptions.completedAt),
      ),
    )
    .limit(1);
  if (!binding) {
    return { ok: true, continuation: "new-owner" };
  }
  const [reservedUser] = await db
    .select({ handle: users.handle })
    .from(users)
    .where(eq(users.id, binding.userId))
    .limit(1);
  // A reservation is written only after bind has persisted the normalized
  // handle. Do not manufacture a resume state if that durable invariant is
  // violated; the subsequent bind must never be allowed to guess a handle.
  if (!reservedUser?.handle || !HANDLE_RE.test(reservedUser.handle)) {
    return { ok: false };
  }
  return { ok: true, continuation: "resume-owner", handle: reservedUser.handle };
}

function normalizeOwnerClaimHandle(raw: unknown): string | null {
  const handle = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return HANDLE_RE.test(handle) ? handle : null;
}

/**
 * Opaque state round-tripped through the Logto-hosted sign-up page so
 * `/api/bind-logto-user` can recover the invite + user-chosen handle on
 * the OIDC callback.
 *
 * Shape (base64url-encoded UTF-8):
 *   `<inviteToken>:<handle>:<nonce>`
 *
 * Pre-M107 the shape was `<inviteToken>:<nonce>` (no handle field). The
 * unpacker tolerates both shapes for one release of back-compat — a
 * legacy 2-segment state still decodes and returns `handle: null`, in
 * which case the bind route falls back to using the Logto user's
 * `username` field as the handle (M107 deprecation — remove in M108).
 *
 * Integrity: the invite token is the bearer capability (knowledge of it
 * authorizes the bind), so the state needs no HMAC. The nonce defeats
 * URL-fingerprint collisions on retries from the same wizard session.
 */
function packPrepareState(
  inviteToken: string,
  opts: { handle: string },
): string {
  const nonce = randomBytes(16).toString("base64url");
  return Buffer.from(
    `${inviteToken}:${opts.handle}:${nonce}`,
    "utf8",
  ).toString("base64url");
}

export interface InvitesRoutesOpts {
  onHumanRoomJoined?: HumanMembershipEventProducer;
  ownerId: string;
  /** App-owned durable audit sink; tests supply an isolated temporary path. */
  securityAuditLogPath: string;
  /** Canonical base for minted `/redeem/...` URLs (no trailing slash). */
  publicInviteBaseUrl: string;
}

export function invitesRoutes(app: FastifyInstance, opts: InvitesRoutesOpts): void {
  const baseUrl = opts.publicInviteBaseUrl.replace(/\/$/, "");
  const auditEvent = (request: FastifyRequest, event: SecurityAuditEvent): boolean => {
    return audit(opts.securityAuditLogPath, request, event);
  };

  app.get("/api/invites/invitable-agents", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const authority = await resolveInviteAuthority(userId);
    if (!authority.canCreateOwn && !authority.canManageAll) {
      return reply.code(403).send({ error: "forbidden" });
    }
    // M128 unify follow-up — non-admin callers see their PERSONAL
    // Agents (the Genie linked via `actors.agent_id`), not the
    // admin-scoped manageable-agents list.
    const agents = authority.canManageAll
      ? await findAllAgents()
      : await findPersonalAgentsForUser(userId);
    return reply.send({ agents });
  });

  async function listInvitableRoomsForCaller(userId: string, canManageAnyRoom: boolean): Promise<
    Array<{ roomId: string; label: string; type: string }>
  > {
    const rows = canManageAnyRoom
      ? await db
          .select({
            roomId: rooms.id,
            label: rooms.label,
            type: rooms.type,
          })
          .from(rooms)
      : await db
          .select({
            roomId: rooms.id,
            label: rooms.label,
            type: rooms.type,
          })
          .from(rooms)
          .where(eq(rooms.ownerId, userId));
    return rows;
  }

  app.get("/api/invitable-rooms", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const authority = await resolveInviteAuthority(userId);
    if (!authority.canCreateOwn && !authority.canManageAll) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const roomRows = await listInvitableRoomsForCaller(userId, authority.canManageAnyRoom);
    return reply.send({ rooms: roomRows });
  });

  app.get<{ Params: { agentId: string } }>(
    "/api/invites/invitable-rooms/:agentId",
    async (request, reply) => {
      const userId = request.sessionUserId;
      if (!userId) {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      // Legacy path — agentId is ignored post-M128; kept for one release.
      const authority = await resolveInviteAuthority(userId);
      if (!authority.canCreateOwn && !authority.canManageAll) {
        return reply.code(403).send({ error: "forbidden" });
      }
      const roomRows = await listInvitableRoomsForCaller(userId, authority.canManageAnyRoom);
      return reply.send({ rooms: roomRows });
    },
  );

  // Hosted first-owner flow. These body-only endpoints intentionally coexist
  // with the ordinary `/api/invites/:token/*` compatibility routes below.
  app.post<{ Body: { claim?: unknown } }>(
    "/api/owner-claim/preview",
    async (request, reply) => {
      if (!checkInviteIpLimit(request.ip)) return reply.code(429).send({ error: "rate_limited" });
      const claim = await lookupActiveOwnerClaim(request.body?.claim);
      if (claim.outcome !== "active") return ownerClaimFailure(reply, claim.outcome);
      const continuation = await resolveOwnerClaimContinuation(claim.row);
      if (!continuation.ok) {
        return reply.code(500).send({ error: "claim_reservation_invariant", code: "claim_reservation_invariant" });
      }
      return reply.send({
        kind: "claim",
        inviterHandle: "Nautilo",
        expiresAt: claim.row.expiresAt,
        usesRemaining: claim.row.maxUses === null ? null : Math.max(0, claim.row.maxUses - claim.row.usedCount),
        continuation: continuation.continuation,
      });
    },
  );

  // D508 browser-only owner protocol. This is intentionally additive: it
  // leaves the older signup preparation endpoint and its wire shape intact
  // for rollout compatibility, while the new owner coordinator has one
  // unified preparation step for new registration and reserved-owner sign-in.
  app.post<{ Body: { claim?: unknown; handle?: unknown } }>(
    "/api/owner-claim/prepare-auth",
    async (request, reply) => {
      if (!checkInviteIpLimit(request.ip)) return reply.code(429).send({ error: "rate_limited" });
      const claim = await lookupActiveOwnerClaim(request.body?.claim);
      if (claim.outcome !== "active") return ownerClaimFailure(reply, claim.outcome);
      const continuation = await resolveOwnerClaimContinuation(claim.row);
      if (!continuation.ok) {
        return reply.code(500).send({ error: "claim_reservation_invariant", code: "claim_reservation_invariant" });
      }

      if (continuation.continuation === "resume-owner") {
        return reply.send({
          continuation: "resume-owner",
          state: packPrepareState(claim.token, { handle: continuation.handle }),
          handle: continuation.handle,
        });
      }

      const handle = normalizeOwnerClaimHandle(request.body?.handle);
      if (handle === null) {
        const supplied = typeof request.body?.handle === "string" && request.body.handle.trim().length > 0;
        return reply.code(400).send({
          error: supplied ? "invalid_handle" : "missing_identifier",
          code: supplied ? "invalid_handle" : "missing_identifier",
        });
      }
      return reply.send({
        continuation: "new-owner",
        state: packPrepareState(claim.token, { handle }),
        handle,
      });
    },
  );

  app.post<{ Body: { claim?: unknown; handle?: unknown } }>(
    "/api/owner-claim/prepare-logto-signup",
    async (request, reply) => {
      if (!checkInviteIpLimit(request.ip)) return reply.code(429).send({ error: "rate_limited" });
      const claim = await lookupActiveOwnerClaim(request.body?.claim);
      if (claim.outcome !== "active") return ownerClaimFailure(reply, claim.outcome);
      const handle = normalizeOwnerClaimHandle(request.body?.handle);
      if (handle === null) {
        const supplied = typeof request.body?.handle === "string" && request.body.handle.trim().length > 0;
        return reply.code(400).send({
          error: supplied ? "invalid_handle" : "missing_identifier",
          code: supplied ? "invalid_handle" : "missing_identifier",
        });
      }
      return reply.send({ state: packPrepareState(claim.token, { handle }), handle });
    },
  );

  app.post<{
    Body: { claim?: unknown; displayName?: unknown; pin?: unknown };
  }>(
    "/api/owner-claim/complete-profile",
    async (request, reply) => {
      if (!checkInviteIpLimit(request.ip)) return reply.code(429).send({ error: "rate_limited" });
      const authHeader = request.headers.authorization;
      const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
      if (!bearer) return reply.code(401).send({ error: "missing_bearer" });
      let payload;
      try {
        payload = await verifyLogtoAccessToken(bearer);
      } catch {
        return reply.code(401).send({ error: "invalid_token" });
      }
      // A completed profile request can be retried after a lost response. The
      // downstream split completion verifies the Logto subject is the exact
      // recorded redeemer before its idempotent success path (including after
      // the original short claim TTL). Preview and prepare remain closed once
      // an owner exists.
      const claim = await lookupActiveOwnerClaim(request.body?.claim, {
        allowCompletedProfileRetry: true,
      });
      if (claim.outcome !== "active") return ownerClaimFailure(reply, claim.outcome);
      const result = await completeInviteProfile(claim.token, payload.sub, {
        displayName: typeof request.body?.displayName === "string" ? request.body.displayName : "",
        pin: typeof request.body?.pin === "string" ? request.body.pin : "",
      }, { onHumanRoomJoined: opts.onHumanRoomJoined });
      if (!result.ok) {
        auditEvent(request, {
          kind: "invite_complete_profile_failed",
          actorId: null,
          tokenHash: sha256Hex(claim.token),
          reason: result.code,
        } as SecurityAuditEvent);
        return reply.code(result.httpStatus).send({ error: result.error, code: result.code });
      }
      auditEvent(request, {
        kind: "invite_redeemed",
        actorId: result.newActorId,
        tokenHash: sha256Hex(claim.token),
        inviteKind: "browser_mediated",
        landingRoomId: result.landingRoomId,
        newUserId: result.newUserId,
      } as SecurityAuditEvent);
      await refreshRoomSubscriptionsForUser(result.newUserId, result.newActorId);
      return reply.send({
        ok: true,
        recoveryCodes: result.recoveryCodes,
        landingRoomId: result.landingRoomId,
      });
    },
  );

  /**
   * Protected direct first-owner seed for non-browser operators. Privileged
   * setup authority and the active claim are jointly required. The claim
   * stays in the request body and never enters a route, URL, or audit field.
   */
  app.post("/api/setup/owner-claim/redeem", async (request, reply) => {
    if (!checkInviteIpLimit(request.ip)) {
      return reply.code(429).send({ schemaVersion: 1, error: "rate_limited" });
    }
    if (!requestAllowsPrivilegedSetup(request)) {
      return reply.code(403).send({
        schemaVersion: 1,
        error: "bootstrap_authority_retired_or_invalid",
      });
    }

    const parsed = OwnerClaimRedeemBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        schemaVersion: 1,
        error: "invalid_owner_claim_redeem_request",
      });
    }

    const hash = sha256Hex(parsed.data.claim);
    if (isInviteTokenLockedOut(hash)) {
      return reply.code(423).send({ schemaVersion: 1, error: "locked_out" });
    }

    const claim = await lookupActiveOwnerClaim(parsed.data.claim);
    if (claim.outcome !== "active") {
      recordInviteRedeemFailure(hash);
      return ownerClaimFailure(reply, claim.outcome);
    }

    const logto = resolveLogtoAdmin();
    if (!logto) {
      return reply.code(503).send({ schemaVersion: 1, error: "logto_unconfigured" });
    }

    const input: RedeemInput = {
      handle: parsed.data.handle,
      displayName: parsed.data.displayName,
      password: parsed.data.password,
      pin: parsed.data.pin,
      forcePasswordChange: false,
    };
    const result = await redeemInviteAtomically(claim.token, input, {
      onHumanRoomJoined: opts.onHumanRoomJoined,
      logto,
      syntheticEmailHost: process.env["NAUTILO_INVITE_EMAIL_DOMAIN"]?.trim(),
      // Direct claim seeding persists the owner and recovery codes only. It
      // does not mint an ambient browser session for a CLI transport.
      allowLogtoSessionMint: false,
      onLogtoCleanupFailed: (sub, reason) => {
        auditEvent(request, {
          kind: "invite_redeem_cleanup_failed",
          actorId: null,
          logtoSub: sub,
          reason,
        } as SecurityAuditEvent);
      },
      onLogtoTokenMintFailed: (sub) => {
        auditEvent(request, {
          kind: "logto_token_mint_failed",
          actorId: null,
          logtoSub: sub,
        } as SecurityAuditEvent);
      },
    });

    if (!result.ok) {
      recordInviteRedeemFailure(hash);
      auditEvent(request, {
        kind: "invite_redeem_failed",
        actorId: null,
        tokenHash: hash,
        reason: result.code ?? result.error,
      } as SecurityAuditEvent);
      return reply.code(result.httpStatus).send({
        schemaVersion: 1,
        error: result.error,
        code: result.code,
        ...(result.message ? { message: result.message } : {}),
      });
    }

    resetInviteTokenFailures(hash);
    auditEvent(request, {
      kind: "invite_redeemed",
      actorId: result.newActorId,
      tokenHash: hash,
      inviteKind: "claim",
      landingRoomId: result.landingRoomId,
      newUserId: result.newUserId,
    } as SecurityAuditEvent);
    try {
      await refreshRoomSubscriptionsForUser(result.newUserId, result.newActorId);
    } catch (error) {
      // Owner creation and its one-shot recovery codes are already committed.
      // Realtime refresh is nonessential and must never turn that success into
      // an ambiguous 500 that permanently loses the codes.
      warn(`[owner-claim] realtime subscription refresh failed after direct seed: ${error instanceof Error ? error.name : "unknown"}`);
    }

    return reply.send({
      schemaVersion: 1,
      state: "owner-bound",
      recoveryCodes: result.recoveryCodes,
    });
  });

  app.get("/api/invites/:token", async (request, reply) => {
    if (!checkInviteIpLimit(request.ip)) {
      return reply.code(429).send({ error: "rate_limited" });
    }
    const raw = (request.params as { token: string }).token;
    const token = extractInviteTokenFromInput(raw) ?? raw;
    if (!token.startsWith(INV_PREFIX)) {
      return reply.code(404).send({ error: "not_found" });
    }
    const hash = sha256Hex(token);
    const [row] = await db
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, hash))
      .limit(1);
    if (!row || row.revokedAt) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (row.maxUses !== null && row.usedCount >= row.maxUses) {
      return reply.code(404).send({ error: "not_found" });
    }

    let inviterHandle = "unknown";
    if (row.createdBy) {
      const u = await findUserById(row.createdBy);
      inviterHandle = u?.handle ?? "unknown";
    }

    // M128 — `targetAgentId` column is gone. Per-Agent invites
    // collapsed into server-wide canonical Groups (`kind='group'`).
    // The display fallback for legacy callers reading
    // `targetAgentDisplayName` is undefined.
    const targetAgentDisplayName: string | undefined = undefined;
    let targetRoomLabel: string | undefined;
    if (row.targetRoomId) {
      const [r] = await db
        .select({ label: rooms.label })
        .from(rooms)
        .where(eq(rooms.id, row.targetRoomId))
        .limit(1);
      targetRoomLabel = r?.label ?? undefined;
    }

    const usesRemaining =
      row.maxUses === null ? null : Math.max(0, row.maxUses - row.usedCount);

    let targetRoleSlug: string | undefined;
    let targetRoleLabel: string | undefined;
    if (row.targetGroupId) {
      // M131: invite-target display role via the `group_roles` junction.
      // A canonical target Group is seeded 1:1, so limit(1) yields its
      // single Role; a hypothetical multi-role Group surfaces one slug.
      const [gr] = await db
        .select({ slug: roles.slug, label: roles.label })
        .from(groups)
        .innerJoin(groupRoles, eq(groupRoles.groupId, groups.id))
        .innerJoin(roles, eq(groupRoles.roleId, roles.id))
        .where(eq(groups.id, row.targetGroupId))
        .limit(1);
      targetRoleSlug = gr?.slug;
      targetRoleLabel = gr?.label;
    }

    return reply.send({
      kind: row.kind,
      inviterHandle,
      targetAgentDisplayName,
      targetRoomLabel,
      targetRoleSlug,
      targetRoleLabel,
      expiresAt: row.expiresAt,
      usesRemaining,
    });
  });

  app.post<{ Params: { token: string }; Body: Record<string, unknown> }>(
    "/api/invites/:token/redeem",
    async (request, reply) => {
      if (!checkInviteIpLimit(request.ip)) {
        return reply.code(429).send({ error: "rate_limited" });
      }
      const raw = request.params.token;
      const token = extractInviteTokenFromInput(raw) ?? raw;
      const hash = sha256Hex(token);
      if (isInviteTokenLockedOut(hash)) {
        return reply.code(423).send({ error: "locked_out" });
      }
      if (!token.startsWith(INV_PREFIX)) {
        recordInviteRedeemFailure(hash);
        return reply.code(404).send({ error: "not_found" });
      }

      const body = request.body ?? {};
      const input: RedeemInput = {
        handle: typeof body["handle"] === "string" ? body["handle"] : "",
        displayName:
          typeof body["displayName"] === "string" ? body["displayName"] : "",
        password: typeof body["password"] === "string" ? body["password"] : "",
        pin: typeof body["pin"] === "string" ? body["pin"] : "",
        email: typeof body["email"] === "string" ? body["email"] : undefined,
        forcePasswordChange: body["forcePasswordChange"] === true,
      };

      const logto = resolveLogtoAdmin();
      if (!logto) {
        return reply.code(503).send({ error: "logto_unconfigured" });
      }

      const loopbackTrusted = requestAllowsLoopbackTrust(request);

      const result = await redeemInviteAtomically(token, input, {
        onHumanRoomJoined: opts.onHumanRoomJoined,
        logto,
        syntheticEmailHost: process.env["NAUTILO_INVITE_EMAIL_DOMAIN"]?.trim(),
        allowLogtoSessionMint: loopbackTrusted,
        onLogtoCleanupFailed: (sub, reason) => {
          auditEvent(request, {
            kind: "invite_redeem_cleanup_failed",
            actorId: null,
            logtoSub: sub,
            reason,
          } as SecurityAuditEvent);
        },
        onLogtoTokenMintFailed: (sub) => {
          auditEvent(request, {
            kind: "logto_token_mint_failed",
            actorId: null,
            logtoSub: sub,
          } as SecurityAuditEvent);
        },
      });

      if (!result.ok) {
        recordInviteRedeemFailure(hash);
        auditEvent(request, {
          kind: "invite_redeem_failed",
          actorId: null,
          tokenHash: hash,
          reason: result.code ?? result.error,
        } as SecurityAuditEvent);
        return reply.code(result.httpStatus).send({
          error: result.error,
          code: result.code,
          ...(result.message ? { message: result.message } : {}),
        });
      }

      resetInviteTokenFailures(hash);

      const [invRow] = await db
        .select({ kind: invites.kind })
        .from(invites)
        .where(eq(invites.tokenHash, hash))
        .limit(1);

      auditEvent(request, {
        kind: "invite_redeemed",
        actorId: result.newActorId,
        tokenHash: hash,
        inviteKind: invRow?.kind ?? "unknown",
        landingRoomId: result.landingRoomId,
        newUserId: result.newUserId,
      } as SecurityAuditEvent);

      await refreshRoomSubscriptionsForUser(result.newUserId, result.newActorId);

      const memberRows = await db
        .select({ userId: actors.ownerId, actorId: actors.id })
        .from(roomMembers)
        .innerJoin(actors, eq(roomMembers.actorId, actors.id))
        .where(and(eq(roomMembers.roomId, result.landingRoomId), eq(actors.kind, "user")));
      const seen = new Set<string>();
      for (const row of memberRows) {
        const k = `${row.userId}:${row.actorId}`;
        if (seen.has(k)) continue;
        seen.add(k);
        await refreshRoomSubscriptionsForUser(row.userId, row.actorId);
      }

      return reply.send({
        ok: true,
        recoveryCodes: result.recoveryCodes,
        landingRoomId: result.landingRoomId,
        logtoSub: result.logtoSub,
        ...(result.logtoSession !== undefined
          ? { logtoSession: result.logtoSession }
          : {}),
      });
    },
  );

  app.post<{ Params: { token: string } }>(
    "/api/invites/:token/prepare-logto-signup",
    async (request, reply) => {
      if (!checkInviteIpLimit(request.ip)) {
        return reply.code(429).send({ error: "rate_limited" });
      }
      const raw = request.params.token;
      const token = extractInviteTokenFromInput(raw) ?? raw;
      if (!token.startsWith(INV_PREFIX)) {
        return reply.code(404).send({ error: "not_found" });
      }
      const hash = sha256Hex(token);
      const [row] = await db
        .select()
        .from(invites)
        .where(eq(invites.tokenHash, hash))
        .limit(1);
      if (!row || row.revokedAt) {
        return reply.code(404).send({ error: "not_found" });
      }
      if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
        return reply.code(410).send({ error: "expired" });
      }
      if (row.maxUses !== null && row.usedCount >= row.maxUses) {
        return reply.code(410).send({ error: "used_up" });
      }

      // M107 Phase 2 — Logto admin client is no longer needed here.
      // The Phase 0 probe established that Logto OSS 1.x rejects
      // `{ username }` on `POST /api/one-time-tokens` and silently drops
      // it when `{ email, username }` is sent together; the only thing
      // the OTT could actually carry in username-mode was a synthetic
      // email no UI ever shows. We drop the OTT call entirely (Option C
      // of the M107 design decision; see playbook/logto-operations.md
      // "M107 Phase 0" addendum). The invite token is the bearer
      // capability for the bind step; the handle round-trips through
      // the opaque `state` instead of via OTT context.

      // Body: `{ handle }`. The wizard preview step validates against
      // the shared HANDLE_RE before posting, but we re-validate server-
      // side because the route is reachable independent of the SPA.
      //
      // M107 deprecation — remove in M108: accept `{ email }` for one
      // release. If both fields are present, prefer `handle`; if only
      // `email` is present, derive a handle from its local-part and
      // log a deprecation warning. The renderer never sends email
      // post-M107 so this branch is purely for stale clients that ship
      // before workbench is upgraded.
      const body = (request.body ?? {}) as Record<string, unknown>;
      const handleRaw =
        typeof body["handle"] === "string" ? body["handle"].trim().toLowerCase() : "";
      const emailFallback =
        typeof body["email"] === "string" ? body["email"].trim() : "";

      let handle: string;
      if (handleRaw.length > 0) {
        if (!HANDLE_RE.test(handleRaw)) {
          return reply.code(400).send({
            error: "invalid_handle",
            code: "invalid_handle",
          });
        }
        handle = handleRaw;
      } else if (emailFallback.length > 0) {
        // M107 deprecation — remove in M108.
        warn(
          "[invites/prepare-logto-signup] deprecation: prefer { handle } over { email }",
        );
        const derived = (emailFallback.split("@")[0] ?? "")
          .toLowerCase()
          .replace(/[^a-z0-9_]/g, "_");
        if (!HANDLE_RE.test(derived)) {
          return reply.code(400).send({
            error: "invalid_handle",
            code: "invalid_handle",
          });
        }
        handle = derived;
      } else {
        return reply.code(400).send({
          error: "missing_identifier",
          code: "missing_identifier",
        });
      }

      const state = packPrepareState(token, { handle });

      // Returns just the opaque state. The workbench wizard stores
      // `{ inviteToken, handle, state }` in `invite-redeem-session`
      // localStorage and drives Logto sign-up via the standard
      // `@logto/react` `signIn({ extraParams: { first_screen: "register" } })`.
      // After the OIDC callback, the workbench POSTs the state to
      // `/api/bind-logto-user`, which unpacks the handle + invite token.
      return reply.send({ state, handle });
    },
  );

  app.post<{
    Params: { token: string };
    Body: { handle?: unknown; displayName?: unknown; pin?: unknown };
  }>(
    "/api/invites/:token/complete-profile",
    async (request, reply) => {
      if (!checkInviteIpLimit(request.ip)) {
        return reply.code(429).send({ error: "rate_limited" });
      }
      const authHeader = request.headers.authorization;
      const bearer = authHeader?.startsWith("Bearer ")
        ? authHeader.slice(7)
        : null;
      if (!bearer) {
        return reply.code(401).send({ error: "missing_bearer" });
      }
      let payload;
      try {
        payload = await verifyLogtoAccessToken(bearer);
      } catch {
        return reply.code(401).send({ error: "invalid_token" });
      }

      const raw = request.params.token;
      const token = extractInviteTokenFromInput(raw) ?? raw;
      if (!token.startsWith(INV_PREFIX)) {
        return reply.code(404).send({ error: "not_found" });
      }

      const body = request.body ?? {};
      const args: CompleteInviteProfileArgs = {
        displayName: typeof body.displayName === "string" ? body.displayName : "",
        pin: typeof body.pin === "string" ? body.pin : "",
      };

      // M107 deprecation — remove in M108. The handle is now pinned at
      // bind time; complete-profile no longer requires it. We tolerate
      // a body that still carries the field for stale renderers, but
      // only when it matches what bind-logto-user persisted; otherwise
      // we fail loudly so the operator notices the drift.
      if (typeof body.handle === "string" && body.handle.trim().length > 0) {
        const claimedHandle = body.handle.trim().toLowerCase();
        if (!HANDLE_RE.test(claimedHandle)) {
          return reply.code(400).send({
            error: "invalid_handle",
            code: "invalid_handle",
          });
        }
        const [userRow] = await db
          .select({ handle: users.handle })
          .from(users)
          .where(eq(users.externalId, payload.sub))
          .limit(1);
        if (userRow && userRow.handle !== null && userRow.handle !== claimedHandle) {
          warn(
            `[invites/complete-profile] handle_mismatch sub=${payload.sub} ` +
              `persisted=${userRow.handle} body=${claimedHandle}`,
          );
          return reply.code(409).send({
            error: "handle_mismatch",
            code: "handle_mismatch",
          });
        }
        warn(
          "[invites/complete-profile] deprecation: { handle } no longer required in body",
        );
      }

      const result = await completeInviteProfile(token, payload.sub, args, { onHumanRoomJoined: opts.onHumanRoomJoined });

      if (!result.ok) {
        auditEvent(request, {
          kind: "invite_complete_profile_failed",
          actorId: null,
          tokenHash: sha256Hex(token),
          reason: result.code,
        } as SecurityAuditEvent);
        return reply.code(result.httpStatus).send({
          error: result.error,
          code: result.code,
        });
      }

      auditEvent(request, {
        kind: "invite_redeemed",
        actorId: result.newActorId,
        tokenHash: sha256Hex(token),
        inviteKind: "browser_mediated",
        landingRoomId: result.landingRoomId,
        newUserId: result.newUserId,
      } as SecurityAuditEvent);

      await refreshRoomSubscriptionsForUser(result.newUserId, result.newActorId);

      return reply.send({
        ok: true,
        recoveryCodes: result.recoveryCodes,
        landingRoomId: result.landingRoomId,
      });
    },
  );

  app.post<{ Body: Record<string, unknown> }>(
    "/api/invites",
    async (request, reply) => {
      const userId = request.sessionUserId;
      if (!userId) {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      const authority = await resolveInviteAuthority(userId);
      if (!authority.canCreateOwn && !authority.canManageAll) {
        return reply.code(403).send({ error: "forbidden" });
      }
      const body = request.body ?? {};
      // M128 unify (2026-05-28, migration 0063): the canonical post-M128
      // kind set is `{claim, server}` only. `claim` is bootstrap-only and
      // is minted by a separate code path (cannot be POSTed here).
      // `kind='group'`/`'room'`/`'agent'` are hard-rejected — older
      // clients that still emit them get a clear 400. Operators upgrade
      // by re-minting from a current UI.
      const kind = body["kind"];
      if (kind === "claim") {
        return reply.code(400).send({ error: "claim_not_mintable" });
      }
      if (kind !== "server") {
        return reply.code(400).send({ error: "invalid_kind" });
      }
      const normalizedKind: "server" = kind;

      const maxUses =
        body["maxUses"] === null || body["maxUses"] === undefined
          ? null
          : typeof body["maxUses"] === "number"
            ? body["maxUses"]
            : Number(body["maxUses"]);
      if (maxUses !== null && (Number.isNaN(maxUses) || maxUses < 1)) {
        return reply.code(400).send({ error: "invalid_max_uses" });
      }

      let expiresAt: Date | null = null;
      if (body["expiresAt"] !== null && body["expiresAt"] !== undefined) {
        if (typeof body["expiresAt"] === "string") {
          expiresAt = new Date(body["expiresAt"]);
          if (Number.isNaN(expiresAt.getTime())) {
            return reply.code(400).send({ error: "invalid_expires_at" });
          }
        } else {
          return reply.code(400).send({ error: "invalid_expires_at" });
        }
      }

      const displayName =
        typeof body["displayName"] === "string" ? body["displayName"] : null;

      let targetGroupId: string | null = null;
      let targetRoomId: string | null = null;

      // M128 unify (migration 0063) — every `kind='server'` invite carries
      // `targetGroupId` (the canonical Group the invitee joins) and
      // optionally `targetRoomId` (when the invitee should also be added
      // to a specific Room). The wire-level field is `targetGroupRoleSlug`
      // (one of the six ladder slugs), mapped to the canonical Group via
      // SERVER_ROLE_TO_GROUP_TYPE. `targetAgentId` is no longer accepted;
      // older clients that still emit it get an error.
      const roleSlug = body["targetGroupRoleSlug"] as
        | ServerRoleSlug
        | undefined;
      if (!roleSlug || !(roleSlug in SERVER_ROLE_TO_GROUP_TYPE)) {
        return reply.code(400).send({ error: "missing_or_invalid_role_slug" });
      }
      if (!inviteRoleAllowed(authority, roleSlug)) {
        return reply.code(403).send({ error: "target_role_forbidden" });
      }
      const targetGroupType = SERVER_ROLE_TO_GROUP_TYPE[roleSlug];
      const [canonicalGroup] = await db
        .select({ id: groups.id })
        .from(groups)
        .where(eq(groups.type, targetGroupType))
        .limit(1);
      if (!canonicalGroup) {
        return reply.code(500).send({ error: "canonical_group_missing" });
      }
      targetGroupId = canonicalGroup.id;

      // Optional Room association: pre-0063 this lived under
      // `kind='room'` with a required `targetAgentId` for room-list
      // scoping. Post-unify the invite just carries `targetRoomId`
      // when set; we still verify the inviter is allowed to invite into
      // that Room.
      const rid =
        typeof body["targetRoomId"] === "string" ? body["targetRoomId"] : "";
      if (rid) {
        const roomRows = await db
          .select({ id: rooms.id, archivedAt: rooms.archivedAt, ownerId: rooms.ownerId })
          .from(rooms)
          .where(eq(rooms.id, rid));
        const rm = roomRows.length === 1 ? roomRows[0] : undefined;
        if (!rm || rm.archivedAt) {
          return reply.code(400).send({ error: "room_not_found" });
        }
        if (!inviteRoomAllowed(authority, userId, rm.ownerId)) {
          return reply.code(403).send({ error: "target_room_forbidden" });
        }
        targetRoomId = rid;
      }

      const token = mintInviteToken();
      const tokenHash = sha256Hex(token);

      const [inserted] = await db
        .insert(invites)
        .values({
          tokenHash,
          kind: normalizedKind,
          targetGroupId,
          targetRoomId,
          maxUses,
          usedCount: 0,
          createdBy: userId,
          displayName,
          expiresAt,
          revokedAt: null,
        })
        .returning({ id: invites.id });

      if (!inserted) {
        return reply.code(500).send({ error: "insert_failed" });
      }

      const auditRecorded = auditEvent(request, {
        kind: "invite_minted",
        actorId: request.sessionActorId,
        inviteId: inserted.id,
        inviteKind: normalizedKind,
        targetRoomId,
      } as SecurityAuditEvent);

      const url = `${baseUrl}/redeem/${encodeURIComponent(token)}`;
      return reply.send({
        id: inserted.id,
        url,
        token,
        kind: normalizedKind,
        expiresAt,
        maxUses,
        mutation: {
          stateChanged: true,
          auditRecorded,
          retrySafe: false,
          receiptId: inserted.id,
          recovery: [{ kind: "revoke_invite", inviteId: inserted.id }],
        },
      });
    },
  );

  app.get<{ Querystring: { all?: string; cursor?: string; limit?: string } }>(
    "/api/invites",
    async (request, reply) => {
      const userId = request.sessionUserId;
      if (!userId) {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      const all = request.query.all === "true";
      const authority = await resolveInviteAuthority(userId);
      if (!authority.canCreateOwn && !authority.canManageAll) {
        return reply.code(403).send({ error: "forbidden" });
      }
      if (all && !authority.canManageAll) {
        return reply.code(403).send({ error: "forbidden" });
      }

      const rawLimit = request.query.limit;
      const limit = rawLimit === undefined ? INVITE_LIST_DEFAULT_LIMIT : Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > INVITE_LIST_MAX_LIMIT) {
        return reply.code(400).send({ error: "invalid_limit" });
      }
      const cursor = decodeInviteCursor(request.query.cursor);
      if (request.query.cursor !== undefined && cursor === null) {
        return reply.code(400).send({ error: "invalid_cursor" });
      }
      const cursorCondition = cursor === null
        ? undefined
        : or(
            lt(invites.createdAt, cursor.createdAt),
            and(eq(invites.createdAt, cursor.createdAt), lt(invites.id, cursor.id)),
          );
      const scopeCondition = all ? undefined : eq(invites.createdBy, userId);
      const whereCondition = scopeCondition && cursorCondition
        ? and(scopeCondition, cursorCondition)
        : (scopeCondition ?? cursorCondition);

      const fetchedRows = await db
        .select()
        .from(invites)
        .where(whereCondition)
        .orderBy(desc(invites.createdAt), desc(invites.id))
        .limit(limit + 1);
      const hasMore = fetchedRows.length > limit;
      const rows = hasMore ? fetchedRows.slice(0, limit) : fetchedRows;

      const roomIds = [
        ...new Set(rows.map((r) => r.targetRoomId).filter((x): x is string => x !== null)),
      ];
      const groupIds = [
        ...new Set(rows.map((r) => r.targetGroupId).filter((x): x is string => x !== null)),
      ];

      const roomRows =
        roomIds.length > 0
          ? await db
              .select({ id: rooms.id, label: rooms.label })
              .from(rooms)
              .where(inArray(rooms.id, roomIds))
          : [];
      const roomMap = new Map(roomRows.map((r) => [r.id, r]));

      const groupRows =
        groupIds.length > 0
          ? await db
              .select({ id: groups.id, slug: roles.slug })
              .from(groups)
              .innerJoin(groupRoles, eq(groupRoles.groupId, groups.id))
              .innerJoin(roles, eq(groupRoles.roleId, roles.id))
              .where(inArray(groups.id, groupIds))
          : [];
      const groupMap = new Map(groupRows.map((g) => [g.id, g]));

      return reply.send({
        invites: rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          maxUses: r.maxUses,
          usedCount: r.usedCount,
          expiresAt: r.expiresAt,
          revokedAt: r.revokedAt,
          createdAt: r.createdAt,
          displayName: r.displayName,
          targetRoomId: r.targetRoomId,
          targetRoomLabel: r.targetRoomId
            ? (roomMap.get(r.targetRoomId)?.label ?? null)
            : null,
          targetRoleSlug: r.targetGroupId
            ? (groupMap.get(r.targetGroupId)?.slug ?? null)
            : null,
        })),
        page: {
          returned: rows.length,
          complete: !hasMore,
          hasMore,
          nextCursor: hasMore && rows.length > 0
            ? encodeInviteCursor(rows[rows.length - 1]!)
            : null,
          continuationAvailable: true,
        },
      });
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/invites/:id",
    async (request, reply) => {
      const userId = request.sessionUserId;
      if (!userId) {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      const id = request.params.id;
      const authority = await resolveInviteAuthority(userId);
      if (!authority.canCreateOwn && !authority.canManageAll) {
        return reply.code(403).send({ error: "forbidden" });
      }
      const [row] = await db
        .select()
        .from(invites)
        .where(eq(invites.id, id))
        .limit(1);
      if (!row) {
        return reply.code(404).send({ error: "not_found" });
      }
      if (!inviteRevocationAllowed(authority, userId, row.createdBy)) {
        return reply.code(403).send({ error: "forbidden" });
      }
      const changed = await db
        .update(invites)
        .set({ revokedAt: new Date() })
        .where(and(eq(invites.id, id), isNull(invites.revokedAt)))
        .returning({ id: invites.id });

      const auditRecorded = auditEvent(request, {
        kind: "invite_revoked",
        actorId: request.sessionActorId,
        inviteId: id,
      } as SecurityAuditEvent);

      return reply.send({
        ok: true,
        mutation: {
          stateChanged: changed.length > 0,
          auditRecorded,
          retrySafe: true,
          receiptId: id,
          recovery: [],
        },
      });
    },
  );
}
