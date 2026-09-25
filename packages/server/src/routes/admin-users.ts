import { Buffer } from "node:buffer";
import { normalizeAdminDirectoryLimit as normalizeLimit } from "../lib/admin-directory-pagination";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { log, warn } from "@nautilo/logger";
import {
  and,
  db,
  desc,
  eq,
  groupMembers,
  groups,
  credentials,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  nautiloInstanceIdentity,
  markPasswordChangeRequired,
  markPasswordChangeCompleted,
  or,
  PASSWORD_CHANGE_REASON,
  type SQL,
  users,
  setTrustContextOnTx,
} from "@nautilo/db";
import type { GroupChip } from "@nautilo/types";
import { HANDLE_RE } from "@nautilo/types";
import {
  findCanonicalGroupByType,
  findUserById,
  getLogtoAdminClient,
  hashPin,
  getUserMemberships,
  SERVER_ROLE_RANK,
  SERVER_ROLE_TO_GROUP_TYPE,
  type ServerRoleSlug,
  userHasCapability,
} from "@nautilo/trust";
import {
  isPolicyCompliantProvisioningPassword,
  provisionMember,
} from "../lib/provision-member";
import {
  acknowledgeRolloutCredentials,
  createOrLoadRollout,
  getRolloutByIdempotency,
  getRolloutStatus,
  processRollout,
  type RolloutOperationMember,
} from "../lib/rollout-operation";
import {
  buildRolloutPlan,
  type RolloutManifestMember,
  type RolloutPlanResult,
} from "../lib/rollout-plan";
import { writeSecurityAuditEvent, type SecurityAuditEvent } from "../lib/security-audit-log";
import {
  assessAccountDeletion,
  AccountDeletionIneligibleError,
  deleteLocalUserAccount,
} from "../lib/user-account-deletion";

type AdminUserRow = {
  id: string;
  handle: string | null;
  displayName: string;
  groups: GroupChip[];
  server: string | null;
  lastSeenAt: Date | null;
  createdAt: Date;
  disabledAt: Date | null;
  disabledBy: string | null;
  disabledReason: string | null;
};

type Cursor = { createdAt: Date; id: string };

function auditPath(): string {
  return join(homedir(), ".nautilo", "logs", "security-audit.log");
}

function audit(request: FastifyRequest, event: Record<string, unknown>): boolean {
  try {
    writeSecurityAuditEvent(auditPath(), {
      ...event,
      ts: new Date().toISOString(),
      ip: request.ip,
      userAgent: request.headers["user-agent"],
    } as SecurityAuditEvent);
    return true;
  } catch (err) {
    warn(`[admin-users] audit write failed: ${String(err)}`);
    return false;
  }
}

async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<string | null> {
  const userId = request.sessionUserId;
  if (!userId) {
    reply.code(401).send({ error: "Unauthorized" });
    return null;
  }
  if (!(await userHasCapability(userId, "manage_members"))) {
    reply.code(403).send({ error: "Forbidden" });
    return null;
  }
  return userId;
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, "utf8").toString("base64url");
}

function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const sep = decoded.lastIndexOf("|");
    if (sep <= 0) return null;
    const createdAt = new Date(decoded.slice(0, sep));
    const id = decoded.slice(sep + 1);
    if (Number.isNaN(createdAt.getTime()) || id.length === 0) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

function literalSearchPattern(value: string): string {
  return `%${value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

async function toAdminUserRow(row: {
  id: string;
  handle: string | null;
  name: string;
  server: string | null;
  lastSeenAt: Date | null;
  createdAt: Date;
  disabledAt: Date | null;
  disabledBy: string | null;
  disabledReason: string | null;
}): Promise<AdminUserRow> {
  const memberships = await getUserMemberships(row.id);
  return {
    id: row.id,
    handle: row.handle,
    displayName: row.name,
    groups: memberships.map((m) => ({
      id: m.groupId,
      type: m.groupType,
      label: m.groupLabel,
      roleSlug: m.roleSlugs[0] ?? "",
    })),
    server: row.server,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
    disabledAt: row.disabledAt,
    disabledBy: row.disabledBy,
    disabledReason: row.disabledReason,
  };
}

async function selectAdminUserRow(userId: string): Promise<AdminUserRow | null> {
  const [row] = await db
    .select({
      id: users.id,
      handle: users.handle,
      name: users.name,
      server: users.server,
      lastSeenAt: users.lastSeenAt,
      createdAt: users.createdAt,
      disabledAt: users.disabledAt,
      disabledBy: users.disabledBy,
      disabledReason: users.disabledReason,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row ? toAdminUserRow(row) : null;
}

async function targetIsLastOwner(targetUserId: string): Promise<boolean> {
  const ownersGroup = await findCanonicalGroupByType("owners");
  if (!ownersGroup) return false;
  const rows = await db
    .select({ userId: groupMembers.userId })
    .from(groupMembers)
    .where(eq(groupMembers.groupId, ownersGroup.id));
  const targetIsOwner = rows.some((r) => r.userId === targetUserId);
  if (!targetIsOwner) return false;
  return rows.every((r) => r.userId === targetUserId);
}

function publicBaseUrl(): string {
  const raw = process.env["NAUTILO_PUBLIC_BASE_URL"]?.trim();
  return raw && raw.length > 0 ? raw.replace(/\/$/, "") : "http://localhost:3001";
}

const ROLLOUT_ROLES = ["admin", "superuser", "member", "contributor", "guest"] as const;

async function planMemberRollout(manifest: unknown, callerUserId: string): Promise<
  | { ok: true; plan: Extract<RolloutPlanResult, { ok: true }>; groupIdByRole: Map<string, string> }
  | { ok: false; status: number; code: string; index?: number | undefined }
> {
  const memberships = await getUserMemberships(callerUserId);
  const ranks = memberships
    .flatMap((membership) => membership.roleSlugs)
    .filter((slug): slug is ServerRoleSlug => Object.hasOwn(SERVER_ROLE_RANK, slug))
    .map((slug) => SERVER_ROLE_RANK[slug]);
  const callerRank = ranks.length > 0 ? Math.min(...ranks) : Number.POSITIVE_INFINITY;
  const [identity] = await db
    .select({ serverInstanceId: nautiloInstanceIdentity.serverInstanceId })
    .from(nautiloInstanceIdentity)
    .where(eq(nautiloInstanceIdentity.id, "self"))
    .limit(1);
  if (!identity) return { ok: false, status: 503, code: "instance_identity_unavailable" };
  const rolloutGroupTypes = ROLLOUT_ROLES.map((role) => SERVER_ROLE_TO_GROUP_TYPE[role]);
  const rolloutGroups = await db
    .select({ id: groups.id, type: groups.type })
    .from(groups)
    .where(inArray(groups.type, rolloutGroupTypes));
  if (rolloutGroups.length !== rolloutGroupTypes.length) {
    return { ok: false, status: 503, code: "canonical_group_missing" };
  }
  const groupIdByType = new Map(rolloutGroups.map((group) => [group.type, group.id]));
  const groupIdByRole = new Map(ROLLOUT_ROLES.map((role) => [
    role,
    groupIdByType.get(SERVER_ROLE_TO_GROUP_TYPE[role]) ?? "",
  ]));
  const policyRevision = JSON.stringify({
    callerRank,
    roles: ROLLOUT_ROLES.map((role) => ({
      role,
      groupType: SERVER_ROLE_TO_GROUP_TYPE[role],
      groupId: groupIdByRole.get(role),
    })),
  });
  const localUsers = await db
    .select({ handle: users.handle })
    .from(users)
    .where(isNull(users.server));
  const existingHandleKeys = new Set(
    localUsers
      .map((row) => row.handle)
      .filter((handle): handle is string => handle !== null)
      .map((handle) => handle.normalize("NFKC").toLocaleLowerCase("en-US")),
  );
  const logto = getLogtoAdminClient();
  const plan = await buildRolloutPlan({
    manifest,
    serverInstanceId: identity.serverInstanceId,
    policyRevision,
    callerRank,
    existingHandleKeys,
    identityCollision: async (member) =>
      (await logto.findUserByEmailOrUsername(member.email, member.handle)) !== null,
  });
  if (!plan.ok) return plan;
  return { ok: true, plan, groupIdByRole };
}

function rolloutStatusPayload(status: NonNullable<Awaited<ReturnType<typeof getRolloutStatus>>>) {
  return {
    ok: true as const,
    rolloutId: status.rollout.id,
    fingerprint: status.rollout.fingerprint,
    status: status.rollout.status,
    createdAt: status.rollout.createdAt.toISOString(),
    updatedAt: status.rollout.updatedAt.toISOString(),
    items: status.items.map((item) => ({
      sequence: item.sequence,
      handle: item.handle,
      roleSlug: item.roleSlug,
      state: item.state,
      receiptId: item.receiptId,
      memberId: item.memberId,
      errorCode: item.errorCode,
      credentialDisposition: item.credentialDisposition,
      updatedAt: item.updatedAt.toISOString(),
    })),
  };
}

/**
 * D219 — admin user directory, soft-delete, and password reset.
 * Promotion/demotion is intentionally NOT here; use M128's
 * PUT/DELETE /api/groups/:id/members/:userId routes.
 */
export function adminUsersRoutes(app: FastifyInstance): void {
  app.post<{ Body: unknown }>("/api/admin/users/rollout/plan", async (request, reply) => {
    const callerUserId = await requireAdmin(request, reply);
    if (!callerUserId) return;
    const result = await planMemberRollout(request.body, callerUserId);
    if (!result.ok) {
      return reply.code(result.status).send({
        code: result.code,
        ...(result.index !== undefined ? { index: result.index } : {}),
      });
    }
    return reply.send(result.plan);
  });

  app.post<{ Body: { manifest?: unknown; fingerprint?: unknown } }>(
    "/api/admin/users/rollout/apply",
    async (request, reply) => {
      const callerUserId = await requireAdmin(request, reply);
      if (!callerUserId) return;
      const idempotencyHeader = request.headers["idempotency-key"];
      const idempotencyKey = typeof idempotencyHeader === "string" ? idempotencyHeader.trim() : "";
      const fingerprint = typeof request.body?.fingerprint === "string"
        ? request.body.fingerprint.trim()
        : "";
      if (!/^[a-f0-9]{64}$/u.test(fingerprint)) {
        return reply.code(400).send({ code: "invalid_rollout_fingerprint" });
      }
      const [identity] = await db.select({ serverInstanceId: nautiloInstanceIdentity.serverInstanceId })
        .from(nautiloInstanceIdentity).where(eq(nautiloInstanceIdentity.id, "self")).limit(1);
      if (!identity) return reply.code(503).send({ code: "instance_identity_unavailable" });
      const existing = await getRolloutByIdempotency(identity.serverInstanceId, idempotencyKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          return reply.code(409).send({ code: "idempotency_conflict" });
        }
        if (existing.createdBy !== callerUserId) {
          return reply.code(403).send({ code: "rollout_owner_mismatch" });
        }
        const status = await getRolloutStatus(existing.id);
        if (!status) return reply.code(409).send({ code: "rollout_outcome_unknown" });
        return reply.send({ ...rolloutStatusPayload(status), idempotent: true, credentials: [] });
      }
      const planned = await planMemberRollout(request.body?.manifest, callerUserId);
      if (!planned.ok) {
        return reply.code(planned.status).send({
          code: planned.code,
          ...(planned.index !== undefined ? { index: planned.index } : {}),
        });
      }
      if (planned.plan.fingerprint !== fingerprint) {
        return reply.code(409).send({ code: "rollout_plan_stale" });
      }
      const operations: RolloutOperationMember[] = planned.plan.operations.map((operation) => ({
        ...operation,
        targetGroupId: planned.groupIdByRole.get(operation.roleSlug) ?? "",
      }));
      if (operations.some((operation) => operation.targetGroupId.length === 0)) {
        return reply.code(503).send({ code: "canonical_group_missing" });
      }
      const canonicalManifest = {
        schemaVersion: 1 as const,
        members: operations.map(({ index: _index, idempotencyKey: _key, targetGroupId: _group, ...member }) => member),
      };
      const operation = await createOrLoadRollout({
        serverInstanceId: planned.plan.serverInstanceId,
        fingerprint,
        idempotencyKey,
        manifest: canonicalManifest,
        callerUserId,
        operations,
      });
      if (!operation.ok) return reply.code(operation.status).send({ code: operation.code });
      if (!operation.created) {
        const status = await getRolloutStatus(operation.rolloutId);
        if (!status) return reply.code(409).send({ code: "rollout_outcome_unknown" });
        return reply.send({ ...rolloutStatusPayload(status), idempotent: true, credentials: [] });
      }
      const credentials = await processRollout({
        rolloutId: operation.rolloutId,
        callerUserId,
        callerActorId: request.sessionActorId ?? null,
        operations,
      });
      const status = await getRolloutStatus(operation.rolloutId);
      if (!status) return reply.code(409).send({ code: "rollout_outcome_unknown" });
      audit(request, {
        kind: "member_rollout_applied",
        actorId: request.sessionActorId,
        rolloutId: operation.rolloutId,
        fingerprint,
        requestedMembers: operations.length,
      });
      return reply.send({ ...rolloutStatusPayload(status), idempotent: false, credentials });
    },
  );

  app.get<{ Params: { rolloutId: string } }>(
    "/api/admin/users/rollout/:rolloutId",
    async (request, reply) => {
      const callerUserId = await requireAdmin(request, reply);
      if (!callerUserId) return;
      const status = await getRolloutStatus(request.params.rolloutId);
      if (!status) return reply.code(404).send({ code: "rollout_not_found" });
      return reply.send(rolloutStatusPayload(status));
    },
  );

  app.post<{ Params: { rolloutId: string }; Body: { sequences?: unknown } }>(
    "/api/admin/users/rollout/:rolloutId/acknowledge",
    async (request, reply) => {
      const callerUserId = await requireAdmin(request, reply);
      if (!callerUserId) return;
      const status = await getRolloutStatus(request.params.rolloutId);
      if (!status) return reply.code(404).send({ code: "rollout_not_found" });
      if (status.rollout.createdBy !== callerUserId) {
        return reply.code(403).send({ code: "rollout_owner_mismatch" });
      }
      const raw = request.body?.sequences;
      if (!Array.isArray(raw) || raw.length > 100 || raw.some((value) => !Number.isInteger(value))) {
        return reply.code(400).send({ code: "invalid_rollout_acknowledgement" });
      }
      const sequences = raw as number[];
      await acknowledgeRolloutCredentials(status.rollout.id, sequences);
      const updated = await getRolloutStatus(status.rollout.id);
      if (!updated) return reply.code(409).send({ code: "rollout_outcome_unknown" });
      return reply.send(rolloutStatusPayload(updated));
    },
  );

  app.post<{ Params: { rolloutId: string } }>(
    "/api/admin/users/rollout/:rolloutId/resume",
    async (request, reply) => {
      const callerUserId = await requireAdmin(request, reply);
      if (!callerUserId) return;
      const status = await getRolloutStatus(request.params.rolloutId);
      if (!status) return reply.code(404).send({ code: "rollout_not_found" });
      if (status.rollout.createdBy !== callerUserId) {
        return reply.code(403).send({ code: "rollout_owner_mismatch" });
      }
      const [identity] = await db.select({ serverInstanceId: nautiloInstanceIdentity.serverInstanceId })
        .from(nautiloInstanceIdentity).where(eq(nautiloInstanceIdentity.id, "self")).limit(1);
      if (!identity || identity.serverInstanceId !== status.rollout.serverInstanceId) {
        return reply.code(409).send({ code: "rollout_target_mismatch" });
      }
      const rawManifest = status.rollout.manifest;
      if (
        rawManifest === null
        || typeof rawManifest !== "object"
        || Array.isArray(rawManifest)
        || (rawManifest as Record<string, unknown>)["schemaVersion"] !== 1
        || !Array.isArray((rawManifest as Record<string, unknown>)["members"])
      ) return reply.code(409).send({ code: "rollout_repair_required" });
      const members = (rawManifest as { members: RolloutManifestMember[] }).members;
      if (members.length !== status.items.length) {
        return reply.code(409).send({ code: "rollout_repair_required" });
      }
      const memberships = await getUserMemberships(callerUserId);
      const ranks = memberships.flatMap((membership) => membership.roleSlugs)
        .filter((slug): slug is ServerRoleSlug => Object.hasOwn(SERVER_ROLE_RANK, slug))
        .map((slug) => SERVER_ROLE_RANK[slug]);
      const callerRank = ranks.length > 0 ? Math.min(...ranks) : Number.POSITIVE_INFINITY;
      if (members.some((member) => SERVER_ROLE_RANK[member.roleSlug] < callerRank)) {
        return reply.code(403).send({ code: "delegation_ceiling" });
      }
      const currentGroups = await db.select({ id: groups.id, type: groups.type }).from(groups)
        .where(inArray(groups.type, ROLLOUT_ROLES.map((role) => SERVER_ROLE_TO_GROUP_TYPE[role])));
      const currentGroupIdByType = new Map(currentGroups.map((group) => [group.type, group.id]));
      const operations: RolloutOperationMember[] = members.map((member, index) => ({
        ...member,
        index,
        idempotencyKey: `rollout:${status.rollout.fingerprint}:${index}`,
        targetGroupId: status.items[index]?.targetGroupId ?? "",
      }));
      if (operations.some((operation) =>
        operation.targetGroupId.length === 0
        || currentGroupIdByType.get(SERVER_ROLE_TO_GROUP_TYPE[operation.roleSlug]) !== operation.targetGroupId
      )) return reply.code(409).send({ code: "rollout_policy_changed" });
      const unfinished = status.items.filter((item) =>
        item.state === "planned" || item.state === "failed_before_change"
      );
      if (unfinished.length > 0) {
        const unfinishedHandles = new Set(unfinished.map((item) => item.handle));
        const localCollisions = await db.select({ handle: users.handle }).from(users).where(and(
          isNull(users.server),
          inArray(users.handle, [...unfinishedHandles]),
        ));
        if (localCollisions.length > 0) {
          return reply.code(409).send({ code: "rollout_directory_changed" });
        }
        const logto = getLogtoAdminClient();
        for (const operation of operations.filter((candidate) => unfinishedHandles.has(candidate.handle))) {
          if (await logto.findUserByEmailOrUsername(operation.email, operation.handle)) {
            return reply.code(409).send({ code: "rollout_directory_changed" });
          }
        }
      }
      const credentials = await processRollout({
        rolloutId: status.rollout.id,
        callerUserId,
        callerActorId: request.sessionActorId ?? null,
        operations,
      });
      const updated = await getRolloutStatus(status.rollout.id);
      if (!updated) return reply.code(409).send({ code: "rollout_outcome_unknown" });
      return reply.send({ ...rolloutStatusPayload(updated), credentials });
    },
  );

  app.post<{
    Body: {
      handle?: unknown;
      displayName?: unknown;
      email?: unknown;
      roleSlug?: unknown;
      permanentCredential?: unknown;
      [key: string]: unknown;
    };
  }>("/api/admin/users/provision", async (request, reply) => {
    const callerUserId = await requireAdmin(request, reply);
    if (!callerUserId) return;
    const idempotencyHeader = request.headers["idempotency-key"];
    const idempotencyKey =
      typeof idempotencyHeader === "string" ? idempotencyHeader.trim() : "";
    const body = request.body ?? {};
    const allowedKeys = new Set(["handle", "displayName", "email", "roleSlug", "permanentCredential"]);
    if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
      return reply.code(400).send({ code: "invalid_provision_intent" });
    }
    const handle = typeof body.handle === "string" ? body.handle.trim().toLowerCase() : "";
    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim() : undefined;
    const roleSlug = typeof body.roleSlug === "string" ? body.roleSlug : "";
    const permanentCredential = body.permanentCredential;
    const parsedPermanentCredential =
      permanentCredential !== undefined
      && typeof permanentCredential === "object"
      && permanentCredential !== null
      && Object.keys(permanentCredential).every((key) => new Set(["password", "pin"]).has(key))
      && typeof (permanentCredential as Record<string, unknown>)["password"] === "string"
      && typeof (permanentCredential as Record<string, unknown>)["pin"] === "string"
        ? {
            password: (permanentCredential as Record<string, string>)["password"]!,
            pin: (permanentCredential as Record<string, string>)["pin"]!,
          }
        : undefined;
    if (
      !HANDLE_RE.test(handle)
      || displayName.length < 1
      || displayName.length > 200
      || (email !== undefined
        && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)))
      || roleSlug === "owner"
      || roleSlug === "community"
      || !Object.hasOwn(SERVER_ROLE_RANK, roleSlug)
      || (permanentCredential !== undefined && parsedPermanentCredential === undefined)
    ) {
      return reply.code(400).send({ code: "invalid_provision_intent" });
    }

    const requestedRole = roleSlug as ServerRoleSlug;
    const callerMemberships = await getUserMemberships(callerUserId);
    if (
      parsedPermanentCredential
      && !callerMemberships.some((membership) => membership.groupType === "owners")
    ) {
      return reply.code(403).send({ code: "owner_required" });
    }
    const callerRanks = callerMemberships
      .flatMap((membership) => membership.roleSlugs)
      .filter((slug): slug is ServerRoleSlug => Object.hasOwn(SERVER_ROLE_RANK, slug))
      .map((slug) => SERVER_ROLE_RANK[slug]);
    const callerRank = callerRanks.length > 0 ? Math.min(...callerRanks) : Number.POSITIVE_INFINITY;
    if (SERVER_ROLE_RANK[requestedRole] < callerRank) {
      return reply.code(403).send({ code: "delegation_ceiling" });
    }

    const targetGroupType = SERVER_ROLE_TO_GROUP_TYPE[requestedRole];
    const [targetGroup] = await db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.type, targetGroupType))
      .limit(1);
    if (!targetGroup) {
      return reply.code(500).send({ code: "canonical_group_missing" });
    }

    const result = await provisionMember({
      callerUserId,
      callerActorId: request.sessionActorId ?? null,
      idempotencyKey,
      handle,
      displayName,
      ...(email !== undefined ? { email } : {}),
      roleSlug: requestedRole,
      targetGroupId: targetGroup.id,
      ...(parsedPermanentCredential ? { permanentCredential: parsedPermanentCredential } : {}),
    });
    if (!result.ok) {
      return reply.code(result.status).send({
        code: result.code,
        retrySafe: result.retrySafe,
      });
    }
    const auditRecorded = audit(request, {
      kind: "member_provisioned",
      actorId: request.sessionActorId,
      targetUserId: result.userId,
      targetRoleSlug: requestedRole,
      receiptId: result.receiptId,
      idempotent: result.idempotent,
    });
    return reply.send({
      ok: true,
      receiptId: result.receiptId,
      memberId: result.userId,
      actorId: result.actorId,
      landingRoomId: result.landingRoomId,
      roleSlug: requestedRole,
      idempotent: result.idempotent,
      auditRecorded,
      credential: result.credential,
    });
  });

  app.put<{
    Params: { id: string };
    Body: { password?: unknown; pin?: unknown; [key: string]: unknown };
  }>("/api/admin/users/:id/permanent-credentials", async (request, reply) => {
    const callerUserId = await requireAdmin(request, reply);
    if (!callerUserId) return;
    const callerMemberships = await getUserMemberships(callerUserId);
    if (!callerMemberships.some((membership) => membership.groupType === "owners")) {
      return reply.code(403).send({ code: "owner_required" });
    }
    const body = request.body ?? {};
    if (
      Object.keys(body).some((key) => !new Set(["password", "pin"]).has(key))
      || typeof body.password !== "string"
      || typeof body.pin !== "string"
      || !/^\d{6}$/u.test(body.pin)
    ) {
      return reply.code(400).send({ code: "invalid_permanent_credential" });
    }
    const [target] = await db.select({
      id: users.id,
      handle: users.handle,
      name: users.name,
      email: users.email,
      externalId: users.externalId,
      server: users.server,
    }).from(users).where(eq(users.id, request.params.id)).limit(1);
    if (!target) return reply.code(404).send({ code: "member_not_found" });
    if (target.server !== null || !target.externalId || !target.handle) {
      return reply.code(422).send({ code: "local_logto_member_required" });
    }
    const logto = getLogtoAdminClient();
    if (!(await isPolicyCompliantProvisioningPassword(logto, {
      handle: target.handle,
      displayName: target.name,
      ...(target.email ? { email: target.email } : {}),
    }, body.password))) {
      return reply.code(400).send({ code: "invalid_permanent_credential" });
    }
    await logto.setUserPassword(target.externalId, body.password);
    const hashedPin = await hashPin(body.pin);
    await db.transaction(async (tx) => {
      await setTrustContextOnTx(tx, { userId: target.id });
      const updated = await tx.update(credentials).set({
        value: hashedPin,
        updatedAt: new Date(),
      }).where(and(eq(credentials.userId, target.id), eq(credentials.type, "pin"))).returning({ id: credentials.id });
      if (updated.length === 0) {
        await tx.insert(credentials).values({ userId: target.id, type: "pin", value: hashedPin });
      }
      await markPasswordChangeCompleted(tx, target.id);
    });
    const auditRecorded = audit(request, {
      kind: "member_permanent_credentials_restored",
      actorId: request.sessionActorId,
      targetUserId: target.id,
    });
    return reply.send({ ok: true, memberId: target.id, auditRecorded });
  });

  app.get<{
    Querystring: { cursor?: string; limit?: number | string; include_federated?: string; search?: string };
  }>("/api/admin/users", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;

    const limit = normalizeLimit(request.query.limit);
    if (limit === null) return reply.code(400).send({ error: "invalid_limit" });
    const cursor = decodeCursor(request.query.cursor);
    if (request.query.cursor !== undefined && cursor === null) {
      return reply.code(400).send({ error: "invalid_cursor" });
    }
    const includeFederated = request.query.include_federated === "true";
    const predicates: SQL[] = [];
    if (!includeFederated) predicates.push(isNull(users.server));
    if (request.query.search !== undefined) {
      const search = request.query.search.trim();
      if (search.length < 1 || search.length > 200) {
        return reply.code(400).send({ error: "invalid_search" });
      }
      const pattern = literalSearchPattern(search);
      const searchPredicate = or(ilike(users.handle, pattern), ilike(users.name, pattern));
      if (searchPredicate) predicates.push(searchPredicate);
    }
    if (cursor) {
      const cursorPredicate = or(
        lt(users.createdAt, cursor.createdAt),
        and(eq(users.createdAt, cursor.createdAt), lt(users.id, cursor.id)),
      );
      if (cursorPredicate) predicates.push(cursorPredicate);
    }
    const where = predicates.length === 0 ? undefined : and(...predicates);
    const rows = await db
      .select({
        id: users.id,
        handle: users.handle,
        name: users.name,
        server: users.server,
        lastSeenAt: users.lastSeenAt,
        createdAt: users.createdAt,
        disabledAt: users.disabledAt,
        disabledBy: users.disabledBy,
        disabledReason: users.disabledReason,
      })
      .from(users)
      .where(where)
      .orderBy(desc(users.createdAt), desc(users.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const out = await Promise.all(pageRows.map((row) => toAdminUserRow(row)));
    const last = pageRows[pageRows.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;
    return reply.send({
      users: out,
      nextCursor,
      page: {
        returned: out.length,
        complete: !hasMore,
        hasMore,
        nextCursor,
        continuationAvailable: true,
      },
    });
  });

  app.get<{ Params: { id: string } }>("/api/admin/users/:id", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const row = await selectAdminUserRow(request.params.id);
    if (!row) return reply.code(404).send({ error: "user_not_found" });
    return reply.send(row);
  });

  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    "/api/admin/users/:id/disable",
    async (request, reply) => {
      const callerUserId = await requireAdmin(request, reply);
      if (!callerUserId) return;
      const target = await findUserById(request.params.id);
      if (!target) return reply.code(404).send({ error: "user_not_found" });
      if (target.server !== null) {
        return reply.code(422).send({ error: "federated_user", code: "federated_user" });
      }
      if (await targetIsLastOwner(request.params.id)) {
        return reply.code(409).send({ code: "last_owner" });
      }
      if (request.params.id === callerUserId) {
        return reply.code(409).send({ code: "self_target" });
      }
      const reason =
        typeof request.body?.reason === "string" && request.body.reason.length > 0
          ? request.body.reason
          : undefined;
      const changed = await db
        .update(users)
        .set({
          disabledAt: new Date(),
          disabledBy: callerUserId,
          disabledReason: reason ?? null,
        })
        .where(and(eq(users.id, request.params.id), isNull(users.disabledAt)))
        .returning({ id: users.id });
      const auditRecorded = changed.length > 0
        ? audit(request, {
            kind: "user_disabled",
            actorId: request.sessionActorId,
            targetUserId: request.params.id,
            ...(reason !== undefined ? { reason } : {}),
          })
        : false;
      return reply.send({
        ok: true,
        mutation: {
          stateChanged: changed.length > 0,
          auditRecorded,
          retrySafe: true,
          receiptId: request.params.id,
          recovery: [{ kind: "enable_member", userId: request.params.id }],
        },
      });
    },
  );

  app.post<{ Params: { id: string } }>("/api/admin/users/:id/enable", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const target = await findUserById(request.params.id);
    if (!target) return reply.code(404).send({ error: "user_not_found" });
    if (target.server !== null) {
      return reply.code(422).send({ error: "federated_user", code: "federated_user" });
    }
    const changed = await db
      .update(users)
      .set({ disabledAt: null, disabledBy: null, disabledReason: null })
      .where(and(eq(users.id, request.params.id), isNotNull(users.disabledAt)))
      .returning({ id: users.id });
    const auditRecorded = changed.length > 0
      ? audit(request, {
          kind: "user_enabled",
          actorId: request.sessionActorId,
          targetUserId: request.params.id,
        })
      : false;
    return reply.send({
      ok: true,
      mutation: {
        stateChanged: changed.length > 0,
        auditRecorded,
        retrySafe: true,
        receiptId: request.params.id,
        recovery: [],
      },
    });
  });

  app.post<{ Params: { id: string } }>(
    "/api/admin/users/:id/reset-password",
    async (request, reply) => {
      if (!(await requireAdmin(request, reply))) return;
      const target = await findUserById(request.params.id);
      if (!target) return reply.code(404).send({ error: "user_not_found" });
      if (target.server !== null) {
        return reply.code(422).send({ error: "federated_user", code: "federated_user" });
      }
      const [emailRow] = await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, request.params.id))
        .limit(1);
      const email = emailRow?.email?.trim() ?? "";
      const logto = getLogtoAdminClient();
      let delivery:
        | { delivery: "one_time_url"; url: string; token: string }
        | { delivery: "temporary_password"; temporaryPassword: string; mustChangePassword: true };
      let retrySafe = false;
      let recovery: Array<{ kind: string; userId: string }> = [
        { kind: "reset_password", userId: request.params.id },
      ];
      if (email.length > 0) {
        try {
          const ott = await logto.createOneTimeToken({ email });
          delivery = {
            delivery: "one_time_url",
            url: `${publicBaseUrl()}/reset?token=${encodeURIComponent(ott.token)}`,
            token: ott.token,
          };
        } catch {
          return reply.code(503).send({ error: "logto_unavailable" });
        }
      } else {
        if (!target.externalId) {
          return reply.code(422).send({ error: "no_logto_identity", code: "no_logto_identity" });
        }
        const temporaryPassword = `N!${randomBytes(32).toString("base64url")}`;
        try {
          await logto.setUserPassword(target.externalId, temporaryPassword);
        } catch {
          return reply.code(503).send({ error: "logto_unavailable" });
        }
        try {
          await markPasswordChangeRequired(db, {
            userId: request.params.id,
            reason: PASSWORD_CHANGE_REASON.OPERATOR_RESET,
            lastOperatorActorId: request.sessionActorId ?? null,
          });
        } catch (error) {
          warn(`[admin-users] password-change marker failed after Logto rotation: ${String(error)}`);
          return reply.code(500).send({
            error: "password_change_marker_failed",
            code: "password_change_marker_failed",
          });
        }
        delivery = {
          delivery: "temporary_password",
          temporaryPassword,
          mustChangePassword: true,
        };
        retrySafe = true;
        recovery = [{ kind: "issue_new_temporary_password", userId: request.params.id }];
      }
      const auditRecorded = audit(request, {
        kind: "admin_password_reset_issued",
        actorId: request.sessionActorId,
        targetUserId: request.params.id,
      });
      return reply.send({
        ok: true,
        ...delivery,
        mutation: {
          stateChanged: true,
          auditRecorded,
          retrySafe,
          receiptId: request.params.id,
          recovery,
        },
      });
    },
  );

  // Stack 66 (D220) — HARD delete a user account. Irreversible; distinct from
  // /disable (soft-delete). Removes the user, the agents they own, and their
  // rooms/sessions, then revokes the Logto identity. Cascade ordering mirrors
  // `bin/nautilo-dev cleanup-test-cruft` (the proven teardown): NO-ACTION FK
  // dependents (sessions/jobs/profiles/standing_approvals/approval_challenges)
  // are deleted explicitly before the `users` row; the `onDelete:"cascade"`
  // FKs (credentials, recovery_codes, group_members, rooms, invites, …) clean
  // themselves. Guarded by the same last-owner rail as /disable.
  app.delete<{ Params: { id: string } }>(
    "/api/admin/users/:id",
    async (request, reply) => {
      const callerUserId = await requireAdmin(request, reply);
      if (!callerUserId) return;
      const targetUserId = request.params.id;
      const eligibility = await assessAccountDeletion(targetUserId);
      if (!eligibility.eligible) {
        if (eligibility.code === "user_not_found") {
          return reply.code(404).send({ error: eligibility.code });
        }
        if (eligibility.code === "federated_user") {
          return reply.code(422).send({ error: eligibility.code, code: eligibility.code });
        }
        return reply.code(409).send(eligibility);
      }

      let deletion;
      try {
        deletion = await deleteLocalUserAccount(targetUserId);
      } catch (error) {
        if (error instanceof AccountDeletionIneligibleError) {
          const raced = error.eligibility;
          if (raced.code === "user_not_found") {
            return reply.code(404).send({ error: raced.code });
          }
          if (raced.code === "federated_user") {
            return reply.code(422).send({ error: raced.code, code: raced.code });
          }
          return reply.code(409).send(raced);
        }
        throw error;
      }
      const { logtoRevoked } = deletion;

      const auditRecorded = audit(request, {
        kind: "user_deleted",
        actorId: request.sessionActorId,
        targetUserId,
        logtoRevoked,
      });
      log(
        `[admin-users] hard-deleted user ${targetUserId} by ${callerUserId} ` +
          `(agents=${deletion.deletedAgents}, rooms=${deletion.deletedRooms}, ` +
          `sessions=${deletion.deletedSessions}, logtoRevoked=${logtoRevoked})`,
      );
      return reply.send({
        ok: true,
        logtoRevoked,
        mutation: {
          stateChanged: true,
          auditRecorded,
          retrySafe: false,
          receiptId: targetUserId,
          recovery: logtoRevoked
            ? []
            : [{ kind: "reconcile_logto_user", userId: targetUserId }],
        },
      });
    },
  );
}
