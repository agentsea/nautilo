/**
 * Stack 195 / W3.2 — preview/apply mutation endpoints for general RBAC
 * administration.
 *
 *   POST /api/admin/access-control/changes/preview
 *     Read-only dry-run. Returns structured checks/failures, current/
 *     proposed/effective authority deltas, deletion consequences when
 *     relevant, a redacted audit preview, and an opaque state fingerprint.
 *     Always 200 — failures are surfaced in the body so the UI can show
 *     what would block the change.
 *
 *   POST /api/admin/access-control/changes/apply
 *     Receives the exact normalized operation + fingerprint, re-resolves
 *     authorization inside a single direct-Postgres transaction, and
 *     returns `409 stale_preview` when the fingerprint drifted. On success
 *     returns `{ applied:true, auditRecorded, fingerprint }`; an audit
 *     append failure is surfaced as `applied:true, auditRecorded:false`
 *     and never rolls back or invites a blind retry.
 *
 * Both endpoints require at least one of `manage_members | manage_groups |
 * manage_roles` (the same gate as the catalogue read); the engine then
 * enforces the operation-specific management cap, anti-escalation, the
 * nondelegable Owner-only ceiling, protected-definition, and reserved
 * slug/type rules identically for preview and apply.
 *
 * See `wave-3-stack-195-tasks.md` W3.2.1–W3.2.5 + W3.0.1 and
 * `general-rbac-administration-followup.md` §2.1 + ASCII review flow.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { warn } from "@nautilo/logger";
import {
  applyOperation,
  createProductionMutationEngineDeps,
  previewOperation,
  userHasCapability,
  MembershipOpError,
  type AccessControlOperation,
  type ApplyResult,
  type PreviewResponse,
  type RbacAuditEventInput,
} from "@nautilo/trust";
import {
  writeSecurityAuditEvent,
  type SecurityAuditEvent,
} from "../lib/security-audit-log";

const MANAGEMENT_CAPABILITIES = [
  "manage_members",
  "manage_groups",
  "manage_roles",
] as const;

function auditPath(): string {
  return join(homedir(), ".nautilo", "logs", "security-audit.log");
}

/**
 * Authorize: the caller must hold at least one RBAC management capability.
 * Returns the caller's userId on success, or sends 401/403 and returns null.
 * This is the coarse endpoint gate; the engine enforces the operation-
 * specific management cap + bundle authority inside preview/apply.
 */
async function authorizeManagement(
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

// ---------------------------------------------------------------------------
// Request body schemas (mirrors the api-client contract; the server does NOT
// import the browser-safe api-client schemas — it validates independently).
// ---------------------------------------------------------------------------

const stringList = z.array(z.string());

const operationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("role.create"),
    slug: z.string().min(1),
    label: z.string().min(1),
    capabilities: stringList,
  }),
  z.object({
    kind: z.literal("role.rename"),
    roleId: z.string().min(1),
    label: z.string().min(1),
  }),
  z.object({
    kind: z.literal("role.set_capabilities"),
    roleId: z.string().min(1),
    capabilities: stringList,
  }),
  z.object({
    kind: z.literal("role.delete"),
    roleId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("group.create"),
    groupType: z.string().min(1),
    label: z.string().min(1),
    ownerUserId: z.string().min(1),
    roleSlugs: stringList,
  }),
  z.object({
    kind: z.literal("group.rename"),
    groupId: z.string().min(1),
    label: z.string().min(1),
  }),
  z.object({
    kind: z.literal("group.set_roles"),
    groupId: z.string().min(1),
    roleSlugs: stringList,
  }),
  z.object({
    kind: z.literal("group.transfer_owner"),
    groupId: z.string().min(1),
    newOwnerUserId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("group.delete"),
    groupId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("membership.add"),
    groupId: z.string().min(1),
    userId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("membership.remove"),
    groupId: z.string().min(1),
    userId: z.string().min(1),
    bypassLastOwner: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("shared_access.create"),
    role: z.object({
      slug: z.string().min(1),
      label: z.string().min(1),
      capabilities: stringList,
    }),
    group: z.object({
      groupType: z.string().min(1),
      label: z.string().min(1),
      ownerUserId: z.string().min(1),
    }),
    memberUserIds: stringList.min(1),
  }),
  z.object({
    kind: z.literal("shared_access.assign_existing"),
    roleSlug: z.string().min(1),
    group: z.object({
      groupType: z.string().min(1),
      label: z.string().min(1),
      ownerUserId: z.string().min(1),
    }),
    memberUserIds: stringList.min(1),
  }),
]);

const previewBodySchema = z.object({ operation: operationSchema });
const applyBodySchema = z.object({
  operation: operationSchema,
  fingerprint: z.string().min(1),
});

/**
 * Build the production engine deps with a request-scoped audit writer.
 * The writer attaches the envelope (ts/ip/userAgent) and throws on write
 * failure so the engine can surface `auditRecorded:false`.
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

function mapApplyResult(result: ApplyResult, reply: FastifyReply) {
  if (result.applied) {
    return reply.send({
      applied: true,
      auditRecorded: result.auditRecorded,
      fingerprint: result.fingerprint,
    });
  }
  if (result.code === "stale_preview") {
    return reply.code(409).send({
      code: "stale_preview",
      reason: result.reason ?? "state drifted since preview",
      failures: result.failures,
    });
  }
  // authorization_denied (not_found is absorbed by the stale check).
  return reply.code(403).send({
    code: "authorization_denied",
    failures: result.failures,
  });
}

export interface AccessControlMutationRoutesDeps {
  /**
   * D538's event-stable seam for one named Human. Before the mutation, the
   * controller classifies the exact target membership; after an applied
   * result, the prepared closure revokes whichever activation is then current.
   * The generic mutation engine remains unaware of session authority.
   */
  readonly prepareMembershipRemoval?: (input: {
    readonly userId: string;
    readonly groupId: string;
    readonly actorId: string;
  }) => Promise<(() => unknown) | null>;
}

export function accessControlMutationRoutes(
  app: FastifyInstance,
  deps: AccessControlMutationRoutesDeps = {},
): void {
  app.post("/api/admin/access-control/changes/preview", async (request, reply) => {
    const callerUserId = await authorizeManagement(request, reply);
    if (!callerUserId) return;
    const parsed = previewBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "bad_request", issues: parsed.error.issues });
    }
    const operation = parsed.data.operation as AccessControlOperation;
    const engineDeps = makeEngineDeps(request);
    let preview: PreviewResponse;
    try {
      preview = await previewOperation(engineDeps, {
        actorUserId: callerUserId,
        actorActorId: request.sessionActorId ?? null,
        operation,
      });
    } catch (err) {
      warn(`[access-control-mutations] preview failed: ${String(err)}`);
      return reply.code(500).send({ error: "preview_failed" });
    }
    return reply.send(preview);
  });

  app.post("/api/admin/access-control/changes/apply", async (request, reply) => {
    const callerUserId = await authorizeManagement(request, reply);
    if (!callerUserId) return;
    const parsed = applyBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "bad_request", issues: parsed.error.issues });
    }
    const operation = parsed.data.operation as AccessControlOperation;
    const preparedRevoker = operation.kind === "membership.remove"
      ? await deps.prepareMembershipRemoval?.({
        userId: operation.userId,
        groupId: operation.groupId,
        actorId: request.sessionActorId ?? callerUserId,
      }) ?? null
      : null;
    const engineDeps = makeEngineDeps(request);
    let result: ApplyResult;
    try {
      result = await applyOperation(engineDeps, {
        actorUserId: callerUserId,
        actorActorId: request.sessionActorId ?? null,
        operation,
        fingerprint: parsed.data.fingerprint,
      });
    } catch (err) {
      if (err instanceof MembershipOpError) {
        return reply.code(409).send({ code: "last_owner", reason: err.message });
      }
      warn(`[access-control-mutations] apply failed: ${String(err)}`);
      return reply.code(500).send({ error: "apply_failed" });
    }
    if (result.applied && preparedRevoker !== null) {
      try {
        await preparedRevoker();
      } catch (err) {
        // The DB mutation already committed. Preserve its successful result;
        // the next dispatch still rechecks RBAC fail-closed.
        warn(`[access-control-mutations] post-commit D538 revoke failed: ${String(err)}`);
      }
    }
    return mapApplyResult(result, reply);
  });
}
