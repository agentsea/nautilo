import { homedir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  createForegroundMemoryProcessorRecipient,
  MEMORY_QUERY_EMBEDDING_MAX_BYTES,
} from "@nautilo/lattice-bridge";
import {
  memoryProcessorSealedRequestV1Schema,
  protectedMemoryBriefResponseV1Schema,
  protectedMemoryDetailResponseV1Schema,
  protectedMemoryListResponseV1Schema,
  protectedMemoryCreatePlanSlotResponseV1Schema,
  protectedMemoryOrdinaryFallbackCreatePlanV1Schema,
  protectedMemorySubmittedCreateRequestV1Schema,
  protectedMemorySubmittedUpdateRequestV1Schema,
  protectedMemoryPreparedUpdateResponseV1Schema,
  protectedMemorySearchResponseV1Schema,
  protectedMemoryUnavailableResponseV1Schema,
} from "@nautilo/api-client";
import { warn } from "@nautilo/logger";
import {
  attachMemoryToNamespace,
  archiveMemory,
  archiveScopeMemory,
  countMemories,
  decodeMemoryListCursor,
  detachMemoryFromNamespace,
  getMemoryById,
  getMemoryNamespaces,
  getPromptBrief,
  getPromptBriefReadOnly,
  hardDeleteMemory,
  listMemories,
  searchMemory,
  setMemoryAuditSink,
  shareMemoryToUser,
  updateMemory,
  getScopeMemoryById,
  hardDeleteScopeMemory,
  listScopeMemories,
  searchScopeMemory,
  updateScopeMemory,
} from "@nautilo/agent";
import {
  envelopeMutableNamespaces,
  envelopeReadableNamespaces,
  envelopeWritableNamespaces,
  findActorByHandle,
  findActorById,
  findActorByOwnerId,
  findAgentOwnerPrivateRoom,
  findOrCreateAccessNamespace,
  findReadableNamespacesForSubset,
  findRoomByNamespaceId,
  findRoomsByNamespaceIds,
  getRoomWithAccess,
  getRoomDetailForMember,
  isScopeMemoryEnvelope,
  memoryModeOf,
  resolveActorsDisplay,
  resolveActorsDisplayMap,
  resolveSpeakerUserId,
  userHasCapability,
  isUuidString,
  type ContentAccessAdmission,
  type ContentAccessReceipt,
  type LegacyHumanContentAccessResult,
  type createContentAccessCoordinator,
} from "@nautilo/trust";
import {
  writeSecurityAuditEvent,
  type MemoryDeleteAuditEvent,
  type MemoryEditAuditEvent,
} from "../lib/security-audit-log";
import {
  resolveCurrentProtectedMemoryRoutePorts,
  type ProtectedMemoryCompositionSource,
} from "./protected-memory-composition";
import { protectedMemoryRoutes } from "./protected-memory-routes";
import {
  enforceRegisteredStrictShadowBoundary,
  currentStrictShadowPolicy,
  strictShadowHttpBody,
  strictShadowHttpStatus,
} from "../lib/strict-shadow-policy";

const protectedMemoryBriefRouteResponseSchema =
  protectedMemoryBriefResponseV1Schema.or(
    protectedMemoryUnavailableResponseV1Schema,
  );
const protectedMemoryDetailRouteResponseSchema =
  protectedMemoryDetailResponseV1Schema.or(
    protectedMemoryUnavailableResponseV1Schema,
  );
const protectedMemoryListRouteResponseSchema =
  protectedMemoryListResponseV1Schema.or(
    protectedMemoryUnavailableResponseV1Schema,
  );
const protectedMemorySearchRouteResponseSchema =
  protectedMemorySearchResponseV1Schema.or(
    protectedMemoryUnavailableResponseV1Schema,
  );
const protectedMemoryUpdateRouteResponseSchema =
  protectedMemoryPreparedUpdateResponseV1Schema.or(
    protectedMemoryUnavailableResponseV1Schema,
  );
const protectedMemoryCreatePlanRouteResponseSchema =
  protectedMemoryCreatePlanSlotResponseV1Schema.or(protectedMemoryOrdinaryFallbackCreatePlanV1Schema).or(
    protectedMemoryUnavailableResponseV1Schema,
  );
const protectedMemoryCreatePlanRequestSchema = z.object({}).strict();
const protectedMemorySearchRequestSchema = z.object({
  sealedQuery: memoryProcessorSealedRequestV1Schema,
  mode: z.enum(["text", "semantic"]),
  limit: z.number().int().min(1).max(256).optional(),
  includeArchive: z.boolean().optional(),
}).strict();
function assertProtectedMemoryMode(
  response: { readonly memoryMode: "namespace" | "scope" },
  expected: "namespace" | "scope",
): void {
  if (response.memoryMode !== expected) {
    throw new TypeError("Protected Memory response mode does not match its request authority");
  }
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value) => right.includes(value));
}

function sessionUserId(request: FastifyRequest): string {
  return request.sessionUserId ?? request.memoryEnvelope?.ownerId ?? "";
}

function trustFromRequest(request: FastifyRequest): {
  userId: string;
  agentId?: string | undefined;
  auditActorId: string | null;
  auditIp: string;
  auditUserAgent?: string | undefined;
} {
  const userId = sessionUserId(request);
  const agentId = request.memoryEnvelope?.agentId;
  return {
    userId,
    ...(agentId !== undefined ? { agentId } : {}),
    auditActorId: (request.memoryEnvelope?.actorId ?? userId) || null,
    auditIp: request.ip,
    ...(typeof request.headers["user-agent"] === "string"
      ? { auditUserAgent: request.headers["user-agent"] }
      : {}),
  };
}

async function resolveProtectedMemoryRequest(
  request: FastifyRequest,
  userId: string,
  composition: ProtectedMemoryCompositionSource | undefined,
) {
  return resolveCurrentProtectedMemoryRoutePorts({
    ...(composition === undefined ? {} : { composition }),
    envelope: request.memoryEnvelope,
    authority: protectedMemoryRequestTarget(request, userId),
  });
}

function protectedMemoryRequestTarget(request: FastifyRequest, userId: string) {
  const envelope = request.memoryEnvelope;
  return {
      userId,
      actorId: envelope?.actorId ?? null,
      // These HTTP routes are Human Memory-library operations. The envelope's
      // Agent identifies surrounding product context, not the acting crypto
      // principal; prepared Human ports deliberately reject Agent authority.
      agentId: null,
      memoryMode: memoryModeOf(envelope),
      readableNamespaceIds: envelopeReadableNamespaces(envelope),
      mutableNamespaceIds: envelopeMutableNamespaces(envelope),
      writableNamespaceIds: envelopeWritableNamespaces(envelope),
      scopeId: isScopeMemoryEnvelope(envelope) ? envelope.scopeId : null,
      originWritableNamespaceId: isScopeMemoryEnvelope(envelope)
          && "originWritableNamespaceId" in envelope
          && typeof envelope.originWritableNamespaceId === "string"
        ? envelope.originWritableNamespaceId
        : null,
      sourceRoomId: envelope?.roomId ?? null,
  };
}

async function rejectUnprotectedMemoryInStrictShadow(
  reply: FastifyReply,
  protectedRequest: Awaited<ReturnType<typeof resolveProtectedMemoryRequest>>,
  enforceBoundary: typeof enforceRegisteredStrictShadowBoundary,
): Promise<boolean> {
  if (protectedRequest !== null) return false;
  const enforcement = await enforceBoundary({
    boundaryId: "memory.api.server",
    state: "unsupported",
    reason: "unsupported_operation",
    retryable: false,
  });
  if (
    enforcement.result.disposition !== "withhold"
    && enforcement.result.disposition !== "reject"
  ) return false;
  reply.code(strictShadowHttpStatus(enforcement.result)).send(
    strictShadowHttpBody(enforcement.result),
  );
  return true;
}

const MEMORY_AUDIT_LOG_PATH = join(homedir(), ".nautilo", "logs", "security-audit.log");

/**
 * M173 — emit a `memory.edit` audit row for the access operations
 * (`grant` / `revoke` / `make_private`). These do not flow through the
 * memory-store mutation sink (they manipulate the `memory_namespaces` junction
 * directly), so they write the row here. `MemoryEditAuditEvent.action` is a
 * free-form string, so the new action names pass through without a type change.
 */
function emitMemoryEditAudit(
  trust: ReturnType<typeof trustFromRequest>,
  memoryId: string,
  action: string,
): void {
  try {
    const row: MemoryEditAuditEvent = {
      kind: "memory.edit",
      action,
      ts: new Date().toISOString(),
      actorId: trust.auditActorId,
      ip: trust.auditIp.length > 0 ? trust.auditIp : "unknown",
      userAgent: trust.auditUserAgent,
      memoryId,
      outcome: "success",
    };
    writeSecurityAuditEvent(MEMORY_AUDIT_LOG_PATH, row);
  } catch (err) {
    warn(
      `[memory-audit] write failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * M173 §5.3 — compute a memory's people-only access list. Walks the FULL
 * (unfiltered) `memory_namespaces` attachment set → each namespace's 1:1 room →
 * that room's human members, unioned + deduped across rooms. Deliberately
 * unfiltered: the whole point is to show every room that grants access.
 */
async function computeAccessList(
  memoryId: string,
  trust: ReturnType<typeof trustFromRequest>,
): Promise<Array<{ userHandle: string; displayName: string }>> {
  const nsIds = await getMemoryNamespaces(memoryId, trust);
  const actorIds = new Set<string>();
  for (const nsId of nsIds) {
    const room = await findRoomByNamespaceId(nsId);
    if (!room) continue;
    for (const actorId of room.humanActorIds) actorIds.add(actorId);
  }
  if (actorIds.size === 0) return [];
  return resolveActorsDisplay([...actorIds]);
}

/**
 * D328 §"Follow-up ask" — attach a people-only `accessList` to each LIST row,
 * computed **once per page** (2 queries total, independent of row count) to
 * avoid the per-row N+1 that looping {@link computeAccessList} would cause.
 * Same semantics as detail's `computeAccessList` (namespace → room humans,
 * deduped), just batched: rows already carry `namespaceIds`, so no per-row
 * `getMemoryNamespaces`. Additive — callers that ignore `accessList` are
 * unaffected.
 */
async function attachListAccessLists<T extends { namespaceIds: string[] }>(
  items: T[],
): Promise<Array<T & { accessList: Array<{ userHandle: string; displayName: string }> }>> {
  const nsUnion = [...new Set(items.flatMap((i) => i.namespaceIds))];
  const roomMap = await findRoomsByNamespaceIds(nsUnion);
  const actorUnion = [
    ...new Set([...roomMap.values()].flatMap((r) => r.humanActorIds)),
  ];
  const displayMap = await resolveActorsDisplayMap(actorUnion);
  return items.map((item) => {
    const actorSet = new Set<string>();
    for (const ns of item.namespaceIds) {
      const room = roomMap.get(ns);
      if (!room) continue;
      for (const actorId of room.humanActorIds) actorSet.add(actorId);
    }
    const accessList = [...actorSet]
      .map((actorId) => displayMap.get(actorId))
      .filter(
        (d): d is { userHandle: string; displayName: string } => d !== undefined,
      );
    return { ...item, accessList };
  });
}

async function attachProtectedAccessLists<
  T extends { projection: { namespaceIds: string[] } },
>(items: T[]): Promise<T[]> {
  const indexed = await attachListAccessLists(items.map((item, index) => ({
    index,
    namespaceIds: [...item.projection.namespaceIds],
  })));
  return items.map((item, index) => ({
    ...item,
    projection: {
      ...item.projection,
      accessList: indexed[index]?.accessList ?? [],
    },
  }));
}

function wireMemoryAuditSink(): void {
  const auditLogPath = MEMORY_AUDIT_LOG_PATH;
  setMemoryAuditSink((evt) => {
    const common = {
      ts: new Date().toISOString(),
      actorId: evt.actorId,
      ip: evt.ip.length > 0 ? evt.ip : "unknown",
      userAgent: evt.userAgent,
      memoryId: evt.memoryId,
      ...(evt.operationId ? { operationId: evt.operationId } : {}),
      outcome: evt.outcome,
      ...(evt.errorKind !== undefined ? { errorKind: evt.errorKind } : {}),
      ...(evt.namespaceId !== undefined ? { namespaceId: evt.namespaceId } : {}),
      ...(evt.scopeId !== undefined ? { scopeId: evt.scopeId } : {}),
    };
    try {
      if (evt.kind === "memory.edit") {
        const row = {
          kind: "memory.edit" as const,
          action: evt.action ?? "unknown",
          ...common,
        } satisfies MemoryEditAuditEvent;
        writeSecurityAuditEvent(auditLogPath, row);
      } else {
        const row = {
          kind: "memory.delete" as const,
          mode: evt.mode ?? "archive",
          ...common,
        } satisfies MemoryDeleteAuditEvent;
        writeSecurityAuditEvent(auditLogPath, row);
      }
    } catch (err) {
      // Durable receipt recovery must not acknowledge an audit that was not written.
      if (evt.operationId) throw err;
      warn(
        `[memory-audit] write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}

async function requireReadMemories(userId: string): Promise<boolean> {
  return userHasCapability(userId, "read_memories");
}

async function requireManageMemories(userId: string): Promise<boolean> {
  return userHasCapability(userId, "manage_memories");
}

function parseListQuery(request: FastifyRequest): {
  limit?: number;
  cursor?: { createdAt: Date; id: string };
  cursorRaw?: string;
  includeArchive: boolean;
} {
  const q = request.query as { limit?: string; cursor?: string; includeArchive?: string };
  const limit = q.limit ? Number.parseInt(q.limit, 10) : undefined;
  const includeArchive = q.includeArchive === "true" || q.includeArchive === "1";
  const cursorRaw = q.cursor?.trim();
  const cursor = cursorRaw ? decodeMemoryListCursor(cursorRaw) : undefined;
  return {
    includeArchive,
    ...(limit !== undefined && !Number.isNaN(limit) ? { limit } : {}),
    ...(cursor ? { cursor } : {}),
    ...(cursorRaw ? { cursorRaw } : {}),
  };
}

type MemoryActionAuthority = {
  canEdit: boolean;
  canArchive: boolean;
  canHardDelete: boolean;
  canManageAccess: boolean;
};

type LegacyHumanContentAccessPort = Pick<
  ReturnType<typeof createContentAccessCoordinator>,
  "executeLegacyHuman"
>;

export interface MemoryContentAccessDependencies {
  ordinaryAccess?: LegacyHumanContentAccessPort;
  loadEncryptionPolicy?: typeof currentStrictShadowPolicy;
}

const LEGACY_HUMAN_MEMORY_ACCESS_APPROVAL_CONTEXT =
  "nautilo/content-access/legacy-human-memory/v1";

function legacyMemoryAdmission(input: {
  userId: string;
  actorId: string;
  roomId: string;
  agentId?: string;
  personalGrant: boolean;
}): ContentAccessAdmission {
  return {
    principal: {
      kind: "human",
      userId: input.userId,
      actorId: input.actorId,
      sourceRoomId: input.roomId,
      ...(input.agentId ? { agentId: input.agentId } : {}),
    },
    audienceContract: input.personalGrant ? "legacy_personal_grant" : "invoking_room",
    approvalContext: LEGACY_HUMAN_MEMORY_ACCESS_APPROVAL_CONTEXT,
  };
}

function isSuccessfulReceipt(
  receipt: ContentAccessReceipt,
  allowPartial: boolean,
): boolean {
  return receipt.outcome === "applied" || receipt.outcome === "already_applied"
    || (allowPartial && receipt.outcome === "partial");
}

function unavailableMemoryAccess(reply: FastifyReply, stateChanged: false | "unknown") {
  return reply.code(503).send({
    error: stateChanged === false
      ? "Memory access is temporarily unavailable"
      : "Memory access result is unavailable",
    outcome: "failed",
    stateChanged,
  });
}

function failedMemoryAccess(
  reply: FastifyReply,
  result: Exclude<LegacyHumanContentAccessResult, { kind: string }>,
) {
  const status = result.outcome === "denied" ? 403 : result.outcome === "stale" ? 409 : 503;
  return reply.code(status).send({
    error: result.outcome === "denied"
      ? "Memory access denied"
      : result.outcome === "stale"
        ? "Memory access changed. Refresh and try again."
        : "Memory access is temporarily unavailable",
    outcome: result.outcome,
    stateChanged: result.stateChanged,
    receiptPersisted: result.receiptPersisted,
    recovery: result.recovery,
  });
}

function nonSuccessMemoryReceipt(reply: FastifyReply, receipt: ContentAccessReceipt) {
  if (receipt.outcome === "applied" || receipt.outcome === "already_applied") {
    return unavailableMemoryAccess(reply, "unknown");
  }
  const status = receipt.outcome === "denied" ? 403
    : receipt.outcome === "failed" ? 503 : 409;
  return reply.code(status).send({
    error: receipt.outcome === "partial"
      ? "Memory access only partially completed"
      : receipt.outcome === "denied"
        ? "Memory access denied"
        : receipt.outcome === "stale"
          ? "Memory access changed. Refresh and try again."
          : "Memory access is temporarily unavailable",
    outcome: receipt.outcome,
    stateChanged: receipt.stateChanged,
    receiptPersisted: true,
  });
}

function legacySkipped(
  result: Extract<LegacyHumanContentAccessResult, { kind: "completed" }>,
): string[] {
  return [...new Set([
    ...result.details.accounting.skippedNamespaceIds,
    ...result.details.accounting.residualDynamicNamespaceIds,
    ...result.details.accounting.residualAccessNamespaceIds,
  ])];
}

function attachedWritableNamespace(
  namespaceIds: string[],
  writableNamespaces: string[],
): string | null {
  return namespaceIds.find((id) => writableNamespaces.includes(id)) ?? null;
}

/**
 * Projects the same envelope/attachment facts that the mutation routes use.
 * It is deliberately advisory: a later request can still be rejected if the
 * envelope or the memory's attachments change before the user acts.
 */
function projectMemoryActionAuthority(options: {
  canManageMemories: boolean;
  memoryMode: "namespace" | "scope";
  namespaceIds: string[];
  envelope: FastifyRequest["memoryEnvelope"];
}): MemoryActionAuthority {
  const none: MemoryActionAuthority = {
    canEdit: false,
    canArchive: false,
    canHardDelete: false,
    canManageAccess: false,
  };
  if (!options.canManageMemories) return none;

  if (options.memoryMode === "scope") {
    // getScopeMemoryById only returns scope-origin rows; seed rows are not
    // mutable detail resources in this route.
    return { ...none, canEdit: true, canArchive: true, canHardDelete: true };
  }

  const mutable = envelopeMutableNamespaces(options.envelope);
  const writable = envelopeWritableNamespaces(options.envelope);
  const hasMutableAttachment = options.namespaceIds.some((id) => mutable.includes(id));
  const hasWritableAttachment = attachedWritableNamespace(options.namespaceIds, writable) !== null;
  return {
    canEdit: hasMutableAttachment,
    canArchive: hasMutableAttachment,
    // hardDeleteMemory must detach the current writable namespace as well as
    // pass the mutable-attachment overlap gate.
    canHardDelete: hasMutableAttachment && hasWritableAttachment,
    // Access operations can only change attachments the current envelope can
    // mutate. Partial outcomes are still reported by their mutation routes.
    canManageAccess: hasMutableAttachment,
  };
}

export function memoryRoutes(
  app: FastifyInstance,
  protectedComposition?: ProtectedMemoryCompositionSource,
  enforceStrictBoundary: typeof enforceRegisteredStrictShadowBoundary =
    enforceRegisteredStrictShadowBoundary,
  contentAccess: MemoryContentAccessDependencies = {},
) {
  wireMemoryAuditSink();
  if (protectedComposition !== undefined) {
    protectedMemoryRoutes(app, {
      composition: protectedComposition,
      resolveAuthorizedRequest: async (request) => {
        const userId = sessionUserId(request);
        if (userId === null || !await requireManageMemories(userId)) return null;
        return protectedMemoryRequestTarget(request, userId);
      },
    });
  }
  let processor: ReturnType<typeof createForegroundMemoryProcessorRecipient> | undefined;
  const recipient = () => processor ??= createForegroundMemoryProcessorRecipient();
  app.addHook("onClose", async () => { (await processor)?.dispose(); });

  const openPreparedEmbedding = async (body: unknown, subjectId: string) => {
    if (typeof body !== "object" || body === null || Array.isArray(body)
      || "signedContentEmbeddingRequestBytesBase64url" in body
      || "signedOrdinaryFallbackRequestBytesBase64url" in body
      || !("sealedContentEmbeddingRequest" in body)) return null;
    const { sealedContentEmbeddingRequest, ...prepared } = body;
    const ordinary = "publicationKind" in prepared
      && prepared.publicationKind === "ordinary_fallback";
    const signed = await (await recipient()).open(sealedContentEmbeddingRequest, {
      purpose: ordinary ? "memory.ordinary_fallback" : "memory.content_embedding", subjectId,
    });
    return signed === null ? null : {
      ...prepared,
      ...(ordinary ? { signedOrdinaryFallbackRequestBytesBase64url: signed }
        : { signedContentEmbeddingRequestBytesBase64url: signed }),
    };
  };

  app.get("/api/memory/processor-recipient", async (request, reply) => {
    const userId = sessionUserId(request);
    if (!userId) return reply.code(401).send({ error: "Authentication required" });
    if (!(await requireReadMemories(userId))) {
      return reply.code(403).send({ error: "read_memories capability required" });
    }
    const resolved = await resolveProtectedMemoryRequest(request, userId, protectedComposition);
    if (resolved === null) {
      return reply.code(404).send({ error: "Protected Memory processor is unavailable" });
    }
    reply.header("Cache-Control", "no-store");
    return reply.send({ ...(await recipient()).descriptor,
      ...(resolved.ports.embeddingConfiguration === undefined ? {}
        : { embedding: resolved.ports.embeddingConfiguration }),
    });
  });

  app.get("/api/memory/brief", async (request, reply) => {
    const userId = sessionUserId(request);
    if (!userId) {
      return reply.code(401).send({ error: "Authentication required" });
    }

    const namespaces = envelopeReadableNamespaces(request.memoryEnvelope);
    const protectedRequest = await resolveProtectedMemoryRequest(
      request,
      userId,
      protectedComposition,
    );
    if (await rejectUnprotectedMemoryInStrictShadow(reply, protectedRequest, enforceStrictBoundary)) return;
    if (protectedRequest !== null) {
      const result = await protectedRequest.ports.brief({
        authority: protectedRequest.authority,
        namespaceIds: namespaces,
        readonly: false,
      });
      const response = protectedMemoryBriefRouteResponseSchema.parse(result);
      if ("memoryMode" in response) {
        assertProtectedMemoryMode(
          response,
          protectedRequest.authority.memoryMode,
        );
        response.items = await attachProtectedAccessLists(response.items);
      }
      return reply.send(response);
    }
    const agentId = request.memoryEnvelope?.agentId || undefined;
    const brief =
      namespaces.length > 0 ? await getPromptBrief(namespaces, agentId, userId) : "";
    return reply.send({ brief });
  });

  app.get("/api/memory/brief/readonly", async (request, reply) => {
    const userId = sessionUserId(request);
    if (!userId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    if (!(await requireReadMemories(userId))) {
      return reply.code(403).send({ error: "read_memories capability required" });
    }

    const namespaces = envelopeReadableNamespaces(request.memoryEnvelope);
    const protectedRequest = await resolveProtectedMemoryRequest(
      request,
      userId,
      protectedComposition,
    );
    if (await rejectUnprotectedMemoryInStrictShadow(reply, protectedRequest, enforceStrictBoundary)) return;
    if (protectedRequest !== null) {
      const result = await protectedRequest.ports.brief({
        authority: protectedRequest.authority,
        namespaceIds: namespaces,
        readonly: true,
      });
      const response = protectedMemoryBriefRouteResponseSchema.parse(result);
      if ("memoryMode" in response) {
        assertProtectedMemoryMode(
          response,
          protectedRequest.authority.memoryMode,
        );
        response.items = await attachProtectedAccessLists(response.items);
      }
      return reply.send(response);
    }
    const agentId = request.memoryEnvelope?.agentId || undefined;
    const brief =
      namespaces.length > 0
        ? await getPromptBriefReadOnly(namespaces, agentId, userId)
        : "";
    return reply.send({ brief });
  });

  app.get("/api/memory", async (request, reply) => {
    const userId = sessionUserId(request);
    if (!userId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    if (!(await requireReadMemories(userId))) {
      return reply.code(403).send({ error: "read_memories capability required" });
    }

    const envelope = request.memoryEnvelope;
    const mode = memoryModeOf(envelope);
    const { limit, cursor, cursorRaw, includeArchive } = parseListQuery(request);
    const protectedRequest = await resolveProtectedMemoryRequest(
      request,
      userId,
      protectedComposition,
    );
    if (await rejectUnprotectedMemoryInStrictShadow(reply, protectedRequest, enforceStrictBoundary)) return;

    // M173 — optional access filters (namespace-mode only; §5.1 / §5.2).
    // D328 — `audience=private` filter ("Just me").
    const filterQuery = request.query as {
      room?: string;
      person?: string;
      audience?: string;
    };
    const roomFilter = typeof filterQuery.room === "string" ? filterQuery.room.trim() : "";
    const personFilter =
      typeof filterQuery.person === "string" ? filterQuery.person.trim() : "";
    const privateFilter =
      typeof filterQuery.audience === "string" && filterQuery.audience.trim() === "private";

    switch (mode) {
      case "namespace": {
        let namespaceIds: string[];
        // D328 — when "Just me" is active, list only memories whose visible
        // audience is just the requester: those in a private namespace (room
        // with a single human = you), excluding any also attached to a shared
        // namespace. `excludeNamespaceIds` enforces the "only" half.
        let excludeNamespaceIds: string[] | undefined;
        if (privateFilter) {
          if (roomFilter || personFilter) {
            return reply
              .code(400)
              .send({ error: "audience=private cannot combine with room/person" });
          }
          const readable = envelopeReadableNamespaces(envelope);
          const roomMap = await findRoomsByNamespaceIds(readable);
          const privateNs = readable.filter(
            (ns) => roomMap.get(ns)?.humanActorIds.length === 1,
          );
          namespaceIds = privateNs;
          excludeNamespaceIds = readable.filter((ns) => !privateNs.includes(ns));
        } else if (roomFilter) {
          // §5.2 — "memories visible from this room." Membership-gate first;
          // never reveal a room the requester is not in (404, not 403).
          if (!isUuidString(roomFilter)) {
            return reply.code(400).send({ error: "Invalid room id" });
          }
          const room = await getRoomWithAccess(roomFilter);
          if (!room) {
            return reply.code(404).send({ error: "Room not found" });
          }
          const requesterActor = await findActorByOwnerId(userId);
          if (!requesterActor || !room.humanActorIds.includes(requesterActor.id)) {
            return reply.code(404).send({ error: "Room not found" });
          }
          namespaceIds = await findReadableNamespacesForSubset(room.humanActorIds, {
            isPublicNamespaceBoundary: room.isPublicNamespaceBoundary,
          });
        } else if (personFilter) {
          // §5.1 — DECIDED intersection: what this person can see ∩ what the
          // requester can see. Honestly answers "what of my shared stuff can
          // they read" without leaking anything the requester can't see.
          const normalized = personFilter.replace(/^@/, "").toLowerCase();
          const targetHit = await findActorByHandle(normalized);
          if (!targetHit) {
            return reply.code(404).send({ error: "User not found" });
          }
          if (targetHit.kind !== "user") {
            return reply.code(400).send({ error: "handle is not a person" });
          }
          const personReadable = await findReadableNamespacesForSubset([
            targetHit.actorId,
          ]);
          const requesterReadable = new Set(envelopeReadableNamespaces(envelope));
          namespaceIds = personReadable.filter((ns) => requesterReadable.has(ns));
        } else {
          namespaceIds = envelopeReadableNamespaces(envelope);
        }

        if (protectedRequest !== null) {
          const result = await protectedRequest.ports.list({
            authority: protectedRequest.authority,
            namespaceIds,
            ...(excludeNamespaceIds === undefined
              ? {}
              : { excludeNamespaceIds }),
            ...(cursorRaw === undefined ? {} : { cursor: cursorRaw }),
            ...(limit === undefined ? {} : { limit }),
            includeArchive,
          });
          const response = protectedMemoryListRouteResponseSchema.parse(result);
          if ("memoryMode" in response) {
            assertProtectedMemoryMode(response, mode);
            response.items = await attachProtectedAccessLists(response.items);
          }
          return reply.send(response);
        }
        if (namespaceIds.length === 0) {
          return reply.send({ items: [], nextCursor: null, memoryMode: mode, total: 0 });
        }
        const agentOpt = envelope?.agentId ? { agentId: envelope.agentId } : {};
        const excludeOpt = excludeNamespaceIds ? { excludeNamespaceIds } : {};
        const result = await listMemories({
          namespaceIds,
          userId,
          ...agentOpt,
          ...excludeOpt,
          ...(limit !== undefined ? { limit } : {}),
          ...(cursor ? { cursor } : {}),
          includeArchive,
        });
        // D328 — true total for the active filter (independent of pagination),
        // so the UI banners reflect the real count, not "loaded so far".
        const total = await countMemories({
          namespaceIds,
          userId,
          ...agentOpt,
          ...excludeOpt,
          includeArchive,
        });
        const items = await attachListAccessLists(result.items);
        return reply.send({ items, nextCursor: result.nextCursor, memoryMode: mode, total });
      }
      case "scope": {
        // §5.1 / §5.2 — access filters are namespace-mode only. Scope memories
        // are an agent-private bag with no human access list.
        if (roomFilter || personFilter) {
          return reply.code(400).send({ error: "namespace mode required" });
        }
        if (!isScopeMemoryEnvelope(envelope)) {
          return reply.code(403).send({ error: "Invalid scope memory envelope" });
        }
        const speakerUserId = await resolveSpeakerUserId(envelope);
        if (!speakerUserId) {
          return reply.code(403).send({ error: "Speaker identity missing" });
        }
        if (protectedRequest !== null) {
          const result = await protectedRequest.ports.list({
            authority: protectedRequest.authority,
            namespaceIds: [],
            ...(cursorRaw === undefined ? {} : { cursor: cursorRaw }),
            ...(limit === undefined ? {} : { limit }),
            includeArchive,
          });
          const response = protectedMemoryListRouteResponseSchema.parse(result);
          if ("memoryMode" in response) {
            assertProtectedMemoryMode(response, mode);
            response.items = await attachProtectedAccessLists(response.items);
          }
          return reply.send(response);
        }
        const result = await listScopeMemories({
          speakerUserId,
          agentId: envelope.agentId,
          scopeId: envelope.scopeId,
          ...(limit !== undefined ? { limit } : {}),
          ...(cursor ? { cursor } : {}),
          includeArchive,
        });
        return reply.send({ ...result, memoryMode: mode });
      }
      default: {
        const _exhaustive: never = mode;
        return reply.code(500).send({ error: `Unknown memory mode: ${String(_exhaustive)}` });
      }
    }
  });

  app.post("/api/memory/search", async (request, reply) => {
    const userId = sessionUserId(request);
    if (!userId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    if (!(await requireReadMemories(userId))) {
      return reply.code(403).send({ error: "read_memories capability required" });
    }
    const body = protectedMemorySearchRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        error: "Bounded protected Memory search body required",
      });
    }
    const protectedRequest = await resolveProtectedMemoryRequest(
      request,
      userId,
      protectedComposition,
    );
    if (protectedRequest === null) {
      return reply.code(404).send({
        error: "Protected Memory search is unavailable",
      });
    }
    if (body.data.mode === "text") {
      return reply.send(protectedMemoryUnavailableResponseV1Schema.parse({
        dtoVersion: 1,
        status: "unavailable",
        reason: "text_search_unsupported",
      }));
    }
    const query = await (await recipient()).open(body.data.sealedQuery, {
      purpose: "memory.query_embedding", subjectId: userId,
    });
    if (query === null || query.trim().length === 0
      || new TextEncoder().encode(query).length > MEMORY_QUERY_EMBEDDING_MAX_BYTES) {
      return reply.code(400).send({ error: "Valid protected Memory query carrier required" });
    }
    const memoryMode = protectedRequest.authority.memoryMode;
    const namespaceIds = memoryMode === "namespace"
      ? envelopeReadableNamespaces(request.memoryEnvelope)
      : [];
    const result = await protectedRequest.ports.search({
      authority: protectedRequest.authority,
      namespaceIds,
      query: query.trim(),
      ...(body.data.limit === undefined ? {} : { limit: body.data.limit }),
      includeArchive: body.data.includeArchive ?? false,
    });
    const response = protectedMemorySearchRouteResponseSchema.parse(result);
    if ("memoryMode" in response) {
      assertProtectedMemoryMode(response, memoryMode);
      const memories = await attachProtectedAccessLists(
        response.items.map((item) => item.memory),
      );
      response.items = response.items.map((item, index) => ({
        ...item,
        memory: memories[index]!,
      }));
    }
    return reply.send(response);
  });

  app.get("/api/memory/search", async (request, reply) => {
    const userId = sessionUserId(request);
    if (!userId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    if (!(await requireReadMemories(userId))) {
      return reply.code(403).send({ error: "read_memories capability required" });
    }

    const q = request.query as { q?: string; mode?: string; limit?: string; includeArchive?: string };
    const query = q.q?.trim() ?? "";
    if (!query) {
      return reply.code(400).send({ error: "Query parameter q is required" });
    }
    const searchMode = q.mode === "vector" ? "vector" : q.mode === "text" ? "text" : "text";
    const limit = q.limit ? Number.parseInt(q.limit, 10) : undefined;
    const includeArchive = q.includeArchive === "true" || q.includeArchive === "1";

    const envelope = request.memoryEnvelope;
    const memoryMode = memoryModeOf(envelope);
    const protectedRequest = await resolveProtectedMemoryRequest(
      request,
      userId,
      protectedComposition,
    );

    if (await rejectUnprotectedMemoryInStrictShadow(reply, protectedRequest, enforceStrictBoundary)) return;
    if (protectedRequest !== null) {
      return reply.code(405).send({
        error: "Protected Memory search requires POST",
      });
    }

    switch (memoryMode) {
      case "namespace": {
        const namespaces = envelopeReadableNamespaces(envelope);
        if (namespaces.length === 0) {
          return reply.send({ results: [], memoryMode });
        }
        const results = await searchMemory({
          query,
          namespaceIds: namespaces,
          userId,
          ...(envelope?.agentId ? { agentId: envelope.agentId } : {}),
          mode: searchMode,
          ...(limit !== undefined ? { limit } : {}),
          includeArchive,
        });
        return reply.send({ results, memoryMode });
      }
      case "scope": {
        if (!isScopeMemoryEnvelope(envelope)) {
          return reply.code(403).send({ error: "Invalid scope memory envelope" });
        }
        const speakerUserId = await resolveSpeakerUserId(envelope);
        if (!speakerUserId) {
          return reply.code(403).send({ error: "Speaker identity missing" });
        }
        const results = await searchScopeMemory({
          speakerUserId,
          agentId: envelope.agentId,
          scopeId: envelope.scopeId,
          query,
          mode: searchMode,
          ...(limit !== undefined ? { limit } : {}),
          includeArchive,
        });
        return reply.send({ results, memoryMode });
      }
      default: {
        const _exhaustive: never = memoryMode;
        return reply.code(500).send({ error: `Unknown memory mode: ${String(_exhaustive)}` });
      }
    }
  });

  app.get("/api/memory/:id", async (request, reply) => {
    const userId = sessionUserId(request);
    if (!userId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    if (!(await requireReadMemories(userId))) {
      return reply.code(403).send({ error: "read_memories capability required" });
    }
    const canManageMemories = await requireManageMemories(userId);

    const { id } = request.params as { id: string };
    if (!isUuidString(id)) {
      return reply.code(400).send({ error: "Invalid memory id" });
    }

    const envelope = request.memoryEnvelope;
    const memoryMode = memoryModeOf(envelope);
    const trust = trustFromRequest(request);
    const protectedRequest = await resolveProtectedMemoryRequest(
      request,
      userId,
      protectedComposition,
    );
    if (await rejectUnprotectedMemoryInStrictShadow(reply, protectedRequest, enforceStrictBoundary)) return;
    if (protectedRequest !== null) {
      const result = await protectedRequest.ports.detail({
        authority: protectedRequest.authority,
        memoryId: id,
        canManageMemories,
      });
      const response = protectedMemoryDetailRouteResponseSchema.parse(result);
      if ("memoryMode" in response) {
        assertProtectedMemoryMode(
          response,
          protectedRequest.authority.memoryMode,
        );
        if (response.memory.projection.memoryId !== id) {
          throw new TypeError(
            "Protected Memory detail does not match the requested Memory id",
          );
        }
        response.memory = {
          ...response.memory,
          projection: {
            ...response.memory.projection,
            accessList: await computeAccessList(id, trust),
          },
        };
      }
      return reply.send(response);
    }

    switch (memoryMode) {
      case "namespace": {
        const readable = envelopeReadableNamespaces(envelope);
        const detail = await getMemoryById(id, readable, trust);
        if (detail === "forbidden") {
          return reply.code(403).send({ error: "Memory not readable in this context" });
        }
        if (!detail) {
          return reply.code(404).send({ error: "Memory not found" });
        }
        // M173 §5.3 — accessList: the people who can see this memory. Walk the
        // FULL (unfiltered) attachment set → each namespace's room → its humans,
        // unioned + deduped. This intentionally shows every room that grants
        // access, including ones the requester is not a member of.
        const accessList = await computeAccessList(id, trust);
        // The library read is admitted in its own envelope, independently of
        // whichever conversation the browser last visited. Project that exact
        // context; never choose one from the Memory's attachments or a default.
        let accessContext: { roomId: string; label: string } | undefined;
        if (request.sessionUserId && envelope && !isScopeMemoryEnvelope(envelope)
          && envelope.ownerId === request.sessionUserId && envelope.actorId
          && envelope.roomId && isUuidString(envelope.roomId)) {
          try {
            const policy = await (contentAccess.loadEncryptionPolicy ?? currentStrictShadowPolicy)();
            if (policy.mode === "plaintext_only") {
              const source = await getRoomDetailForMember(envelope.roomId, envelope.actorId);
              if (source && source.id === envelope.roomId && source.kind !== "access") {
                accessContext = { roomId: source.id, label: source.label };
              }
            }
          } catch {
            // Context discovery is advisory. Preserve the authorized read but
            // offer no access mutation when its context cannot be established.
          }
        }
        return reply.send({
          memory: { ...detail, accessList },
          memoryMode,
          ...(accessContext ? { accessContext } : {}),
          actionAuthority: projectMemoryActionAuthority({
            canManageMemories,
            memoryMode,
            namespaceIds: detail.namespaceIds,
            envelope,
          }),
        });
      }
      case "scope": {
        if (!isScopeMemoryEnvelope(envelope)) {
          return reply.code(403).send({ error: "Invalid scope memory envelope" });
        }
        const speakerUserId = await resolveSpeakerUserId(envelope);
        if (!speakerUserId) {
          return reply.code(403).send({ error: "Speaker identity missing" });
        }
        const detail = await getScopeMemoryById({
          speakerUserId,
          agentId: envelope.agentId,
          scopeId: envelope.scopeId,
          memoryId: id,
        });
        if (!detail) {
          return reply.code(404).send({ error: "Memory not found" });
        }
        return reply.send({
          memory: detail,
          memoryMode,
          actionAuthority: projectMemoryActionAuthority({
            canManageMemories,
            memoryMode,
            namespaceIds: detail.namespaceIds,
            envelope,
          }),
        });
      }
      default: {
        const _exhaustive: never = memoryMode;
        return reply.code(500).send({ error: `Unknown memory mode: ${String(_exhaustive)}` });
      }
    }
  });

  app.post("/api/memory/protected-create-plan", async (request, reply) => {
    const userId = sessionUserId(request);
    if (!userId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    if (!(await requireManageMemories(userId))) {
      return reply.code(403).send({ error: "manage_memories capability required" });
    }
    if (!protectedMemoryCreatePlanRequestSchema.safeParse(request.body).success) {
      return reply.code(400).send({ error: "Content-free Memory create plan required" });
    }
    const protectedRequest = await resolveProtectedMemoryRequest(
      request,
      userId,
      protectedComposition,
    );
    if (protectedRequest === null) {
      return reply.code(404).send({ error: "Protected Memory create is unavailable" });
    }
    const result = await protectedRequest.ports.planCreate({
      authority: protectedRequest.authority,
    });
    const response = protectedMemoryCreatePlanRouteResponseSchema.parse(result);
    if (!("status" in response) || response.status === "ordinary_fallback_ready") {
      const authority = protectedRequest.authority;
      const exact = authority.memoryMode === "scope"
        ? response.productAuthority.mode === "scope"
          && response.productAuthority.scopeId === authority.scopeId
          && response.productAuthority.originWritableNamespaceId
            === authority.originWritableNamespaceId
          && authority.originWritableNamespaceId !== null
          && response.requiredNamespaceIds.length === 1
          && response.requiredNamespaceIds[0]
            === authority.originWritableNamespaceId
        : response.productAuthority.mode === "namespace"
          && authority.originWritableNamespaceId === null
          && sameStringSet(
            response.requiredNamespaceIds,
            authority.writableNamespaceIds,
          );
      if (!exact) {
        throw new TypeError(
          "Protected Memory create plan does not match request authority",
        );
      }
    }
    return reply.send(response);
  });

  app.post("/api/memory/protected-create", async (request, reply) => {
    const userId = sessionUserId(request);
    if (!userId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    if (!(await requireManageMemories(userId))) {
      return reply.code(403).send({ error: "manage_memories capability required" });
    }
    const protectedRequest = await resolveProtectedMemoryRequest(
      request,
      userId,
      protectedComposition,
    );
    if (protectedRequest === null) {
      return reply.code(404).send({ error: "Protected Memory create is unavailable" });
    }
    const prepared = protectedMemorySubmittedCreateRequestV1Schema.safeParse(
      await openPreparedEmbedding(request.body, userId),
    );
    if (!prepared.success) {
      return reply.code(400).send({
        error: "Prepared encrypted Memory create required",
      });
    }
    const result = await protectedRequest.ports.createPrepared({
      authority: protectedRequest.authority,
      prepared: prepared.data,
    });
    const response = protectedMemoryUpdateRouteResponseSchema.parse(result);
    if (response.status === "ordinary_fallback"
      && (response.operationId !== prepared.data.operationId
        || response.memoryId !== prepared.data.memoryId
        || response.contentRevision !== prepared.data.nextContentRevision
        || response.cryptoAccessRevision !== 0)) {
      throw new TypeError("Memory fallback create response does not match its signed request");
    }
    if ("memory" in response) {
      const { projection, protectedPayload } = response.memory;
      if (
        "publicationKind" in prepared.data
        || projection.memoryId !== prepared.data.memoryId
        || projection.contentRevision !== 1
        || !sameStringSet(
          projection.requiredNamespaceIds,
          prepared.data.requiredNamespaceIds,
        )
        || protectedPayload.status !== "encrypted"
        || protectedPayload.cryptoObjectId !== prepared.data.cryptoObjectId
      ) throw new TypeError(
        "Protected Memory create response does not match its prepared publication",
      );
    }
    return reply.send(response);
  });

  app.patch("/api/memory/:id", async (request, reply) => {
    const userId = sessionUserId(request);
    if (!userId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    if (!(await requireManageMemories(userId))) {
      return reply.code(403).send({ error: "manage_memories capability required" });
    }

    const { id } = request.params as { id: string };
    if (!isUuidString(id)) {
      return reply.code(400).send({ error: "Invalid memory id" });
    }

    const body = request.body as {
      content?: string;
      importance?: number;
      namespaceId?: string;
    };
    const envelope = request.memoryEnvelope;
    const memoryMode = memoryModeOf(envelope);
    const trust = trustFromRequest(request);
    const protectedRequest = await resolveProtectedMemoryRequest(
      request,
      userId,
      protectedComposition,
    );
    if (await rejectUnprotectedMemoryInStrictShadow(reply, protectedRequest, enforceStrictBoundary)) return;
    if (protectedRequest !== null) {
      const prepared = protectedMemorySubmittedUpdateRequestV1Schema.safeParse(
        await openPreparedEmbedding(request.body, userId),
      );
      if (!prepared.success) {
        return reply.code(400).send({
          error: "Prepared encrypted Memory update required",
        });
      }
      const result = await protectedRequest.ports.updatePrepared({
        authority: protectedRequest.authority,
        memoryId: id,
        prepared: prepared.data,
      });
      const response = protectedMemoryUpdateRouteResponseSchema.parse(result);
      if (response.status === "ordinary_fallback"
        && (response.operationId !== prepared.data.operationId
          || response.memoryId !== id
          || response.contentRevision !== prepared.data.nextContentRevision
          || ("publicationKind" in prepared.data
            && response.cryptoAccessRevision !== prepared.data.expectedCryptoAccessRevision))) {
        throw new TypeError("Memory fallback update response does not match its signed request");
      }
      if ("memory" in response) {
        const { projection, protectedPayload } = response.memory;
        if (
          "publicationKind" in prepared.data
          || projection.memoryId !== id
          || projection.contentRevision !== prepared.data.nextContentRevision
          || !sameStringSet(
            projection.requiredNamespaceIds,
            prepared.data.requiredNamespaceIds,
          )
          || protectedPayload.status !== "encrypted"
          || protectedPayload.cryptoObjectId !== prepared.data.cryptoObjectId
        ) {
          throw new TypeError(
            "Protected Memory update response does not match its prepared publication",
          );
        }
      }
      return reply.send(response);
    }

    switch (memoryMode) {
      case "namespace": {
        const mutable = envelopeMutableNamespaces(envelope);
        try {
          await updateMemory(
            id,
            {
              ...(body.content !== undefined ? { content: body.content } : {}),
              ...(body.importance !== undefined ? { importance: body.importance } : {}),
              ...(body.namespaceId !== undefined ? { namespaceId: body.namespaceId } : {}),
            },
            mutable,
            trust,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("cannot write")) {
            return reply.code(403).send({ error: msg });
          }
          if (msg.includes("not found")) {
            return reply.code(404).send({ error: msg });
          }
          throw err;
        }
        const readable = envelopeReadableNamespaces(envelope);
        const memory = await getMemoryById(id, readable, trust);
        if (!memory || memory === "forbidden") {
          return reply.code(404).send({ error: "Memory not found after update" });
        }
        return reply.send({
          memory,
          memoryMode,
          actionAuthority: projectMemoryActionAuthority({
            canManageMemories: true,
            memoryMode,
            namespaceIds: memory.namespaceIds,
            envelope,
          }),
        });
      }
      case "scope": {
        if (!isScopeMemoryEnvelope(envelope)) {
          return reply.code(403).send({ error: "Invalid scope memory envelope" });
        }
        const speakerUserId = await resolveSpeakerUserId(envelope);
        if (!speakerUserId) {
          return reply.code(403).send({ error: "Speaker identity missing" });
        }
        try {
          await updateScopeMemory({
            speakerUserId,
            agentId: envelope.agentId,
            scopeId: envelope.scopeId,
            memoryId: id,
            ...(body.content !== undefined ? { content: body.content } : {}),
            ...(body.importance !== undefined ? { importance: body.importance } : {}),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("cannot be modified") || msg.includes("not found in this scope")) {
            return reply.code(403).send({ error: msg });
          }
          if (msg.includes("not found")) {
            return reply.code(404).send({ error: msg });
          }
          throw err;
        }
        const memory = await getScopeMemoryById({
          speakerUserId,
          agentId: envelope.agentId,
          scopeId: envelope.scopeId,
          memoryId: id,
        });
        if (!memory) {
          return reply.code(404).send({ error: "Memory not found after update" });
        }
        return reply.send({
          memory,
          memoryMode,
          actionAuthority: projectMemoryActionAuthority({
            canManageMemories: true,
            memoryMode,
            namespaceIds: memory.namespaceIds,
            envelope,
          }),
        });
      }
      default: {
        const _exhaustive: never = memoryMode;
        return reply.code(500).send({ error: `Unknown memory mode: ${String(_exhaustive)}` });
      }
    }
  });

  app.delete("/api/memory/:id", async (request, reply) => {
    const userId = sessionUserId(request);
    if (!userId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    if (!(await requireManageMemories(userId))) {
      return reply.code(403).send({ error: "manage_memories capability required" });
    }

    const { id } = request.params as { id: string };
    if (!isUuidString(id)) {
      return reply.code(400).send({ error: "Invalid memory id" });
    }

    const q = request.query as { mode?: string; confirmShared?: string };
    const mode = q.mode === "hard" ? "hard" : "archive";
    const confirmShared = q.confirmShared === "true" || q.confirmShared === "1";
    const envelope = request.memoryEnvelope;
    const memoryMode = memoryModeOf(envelope);
    const trust = trustFromRequest(request);
    const protectedRequest = await resolveProtectedMemoryRequest(
      request,
      userId,
      protectedComposition,
    );
    if (await rejectUnprotectedMemoryInStrictShadow(reply, protectedRequest, enforceStrictBoundary)) return;
    if (protectedRequest) {
      return reply.code(404).send({
        error: mode === "archive"
          ? "Protected Memory archive requires exact revision planning"
          : "Protected Memory deletion requires exact access planning",
      });
    }

    switch (memoryMode) {
      case "namespace": {
        const mutable = envelopeMutableNamespaces(envelope);
        const writable = envelopeWritableNamespaces(envelope);
        if (writable.length === 0) {
          return reply.code(403).send({ error: "No writable namespace in envelope" });
        }
        if (mode === "archive") {
          try {
            await archiveMemory(id, mutable, trust);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("cannot write")) {
              return reply.code(403).send({ error: msg });
            }
            if (msg.includes("not found")) {
              return reply.code(404).send({ error: msg });
            }
            throw err;
          }
          return reply.send({ status: "archived", memoryMode });
        }
        const attached = await getMemoryNamespaces(id, trust);
        const detachNamespaceId = attachedWritableNamespace(attached, writable);
        if (!detachNamespaceId) {
          return reply.code(403).send({ error: "No writable namespace attached to this memory" });
        }
        try {
          const result = await hardDeleteMemory(
            id,
            detachNamespaceId,
            mutable,
            trust,
            { confirmShared },
          );
          if (result.status === "blocked") {
            return reply.code(409).send({
              error: "Memory is shared across multiple namespaces",
              namespaceCount: result.namespaceCount,
              namespaceIds: result.namespaceIds,
              hint: "Deleting removes it from your writable namespace. Others may keep access.",
            });
          }
          return reply.send({ status: result.status, memoryMode });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("cannot write") || msg.includes("not writable")) {
            return reply.code(403).send({ error: msg });
          }
          if (msg.includes("not found") || msg.includes("not attached")) {
            return reply.code(404).send({ error: msg });
          }
          throw err;
        }
      }
      case "scope": {
        if (!isScopeMemoryEnvelope(envelope)) {
          return reply.code(403).send({ error: "Invalid scope memory envelope" });
        }
        const speakerUserId = await resolveSpeakerUserId(envelope);
        if (!speakerUserId) {
          return reply.code(403).send({ error: "Speaker identity missing" });
        }
        if (mode === "archive") {
          try {
            await archiveScopeMemory({
              speakerUserId,
              agentId: envelope.agentId,
              scopeId: envelope.scopeId,
              memoryId: id,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("cannot be modified") || msg.includes("not found in this scope")) {
              return reply.code(403).send({ error: msg });
            }
            if (msg.includes("not found")) {
              return reply.code(404).send({ error: msg });
            }
            throw err;
          }
          return reply.send({ status: "archived", memoryMode });
        }
        try {
          const result = await hardDeleteScopeMemory({
            speakerUserId,
            agentId: envelope.agentId,
            scopeId: envelope.scopeId,
            memoryId: id,
          });
          if (result.status === "blocked") {
            return reply.code(409).send({
              error: "Memory is attached to shared namespaces and cannot be hard-deleted from scope",
              namespaceCount: result.namespaceCount,
              namespaceIds: result.namespaceIds,
            });
          }
          return reply.send({ status: result.status, memoryMode });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("cannot be modified") || msg.includes("not found in this scope")) {
            return reply.code(403).send({ error: msg });
          }
          if (msg.includes("not found")) {
            return reply.code(404).send({ error: msg });
          }
          throw err;
        }
      }
      default: {
        const _exhaustive: never = memoryMode;
        return reply.code(500).send({ error: `Unknown memory mode: ${String(_exhaustive)}` });
      }
    }
  });

  // M173 §5.5 — grant access: `{ room_id }` (everyone in the room) XOR
  // `{ user_handle }` (this one person, via an exact-set access room).
  app.post("/api/memory/:id/grant", async (request, reply) => {
    const userId = request.sessionUserId ?? "";
    if (!userId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    if (!(await requireManageMemories(userId))) {
      return reply.code(403).send({ error: "manage_memories capability required" });
    }
    const { id } = request.params as { id: string };
    if (!isUuidString(id)) {
      return reply.code(400).send({ error: "Invalid memory id" });
    }
    const envelope = request.memoryEnvelope;
    if (memoryModeOf(envelope) !== "namespace") {
      return reply.code(400).send({ error: "namespace mode required" });
    }
    const protectedRequest = await resolveProtectedMemoryRequest(
      request,
      userId,
      protectedComposition,
    );
    if (await rejectUnprotectedMemoryInStrictShadow(reply, protectedRequest, enforceStrictBoundary)) return;
    if (protectedRequest) {
      return reply.code(404).send({
        error: "Protected Memory access requires exact access planning",
      });
    }

    const trust = trustFromRequest(request);
    const readable = envelopeReadableNamespaces(envelope);

    // Read gate — can't grant what you can't see.
    const detail = await getMemoryById(id, readable, trust);
    if (detail === "forbidden") {
      return reply.code(403).send({ error: "Memory not readable in this context" });
    }
    if (!detail) {
      return reply.code(404).send({ error: "Memory not found" });
    }

    const body = (request.body ?? {}) as { room_id?: string; user_handle?: string };
    const hasRoom = typeof body.room_id === "string" && body.room_id.trim().length > 0;
    const hasHandle =
      typeof body.user_handle === "string" && body.user_handle.trim().length > 0;
    if (hasRoom === hasHandle) {
      return reply
        .code(400)
        .send({ error: "Provide exactly one of room_id or user_handle" });
    }

    if (hasRoom) {
      const roomId = body.room_id!.trim();
      if (!isUuidString(roomId)) {
        return reply.code(400).send({ error: "Invalid room id" });
      }
      const room = await getRoomWithAccess(roomId);
      if (!room) {
        return reply.code(404).send({ error: "Room not found" });
      }
      const requesterActor = await findActorByOwnerId(userId);
      if (!requesterActor || !room.humanActorIds.includes(requesterActor.id)) {
        return reply.code(403).send({ error: "Not a member of that room" });
      }
      const mutable = envelopeMutableNamespaces(envelope);
      if (!mutable.includes(room.namespaceId)) {
        return reply.code(403).send({ error: "Cannot write to that room's namespace" });
      }
      let policy: Awaited<ReturnType<typeof currentStrictShadowPolicy>>;
      try {
        policy = await (contentAccess.loadEncryptionPolicy ?? currentStrictShadowPolicy)();
      } catch {
        return unavailableMemoryAccess(reply, false);
      }
      if (policy.mode === "plaintext_only") {
        if (!envelope?.roomId || envelope.actorId !== requesterActor.id) {
          return reply.code(403).send({ error: "Human Room context required" });
        }
        if (!contentAccess.ordinaryAccess) return unavailableMemoryAccess(reply, false);
        let result: LegacyHumanContentAccessResult;
        try {
          result = await contentAccess.ordinaryAccess.executeLegacyHuman(
            legacyMemoryAdmission({
              userId: request.sessionUserId!,
              actorId: requesterActor.id,
              roomId: envelope.roomId,
              ...(envelope.agentId ? { agentId: envelope.agentId } : {}),
              personalGrant: false,
            }),
            {
              object: { kind: "memory", id },
              change: { kind: "grant_room", targetRoomId: roomId },
            },
          );
        } catch {
          return unavailableMemoryAccess(reply, "unknown");
        }
        if (!("kind" in result)) return failedMemoryAccess(reply, result);
        if (result.kind !== "completed") return nonSuccessMemoryReceipt(reply, result.receipt);
        if (!isSuccessfulReceipt(result.receipt, false)) {
          return nonSuccessMemoryReceipt(reply, result.receipt);
        }
        const destination = result.details.destinations.find(
          (item) => item.roomId === roomId && item.namespaceId === room.namespaceId,
        );
        if (!destination) return unavailableMemoryAccess(reply, "unknown");
        emitMemoryEditAudit(trust, id, "grant");
        return reply.send({ status: "granted", namespaceId: destination.namespaceId });
      }
      await attachMemoryToNamespace(id, room.namespaceId, trust);
      emitMemoryEditAudit(trust, id, "grant");
      return reply.send({ status: "granted", namespaceId: room.namespaceId });
    }

    // user_handle path — exact-set {requester, target}; reuses any room of
    // exactly that pair, else mints an invisible kind='access' room.
    const agentId = envelope?.agentId ?? "";
    if (!agentId) {
      return reply.code(400).send({ error: "agent context required" });
    }
    let policy: Awaited<ReturnType<typeof currentStrictShadowPolicy>>;
    try {
      policy = await (contentAccess.loadEncryptionPolicy ?? currentStrictShadowPolicy)();
    } catch {
      return unavailableMemoryAccess(reply, false);
    }
    if (policy.mode === "plaintext_only") {
      const normalizedHandle = body.user_handle!.trim().replace(/^@/, "");
      const target = await findActorByHandle(normalizedHandle);
      if (!target || target.kind !== "user") {
        return reply.code(400).send({ error: `No local user @${normalizedHandle} on this server.` });
      }
      const requesterActor = await findActorByOwnerId(userId);
      if (!requesterActor) {
        return reply.code(400).send({ error: "Cannot share memory: requester actor not found." });
      }
      if (target.actorId === requesterActor.id) {
        return reply.code(400).send({ error: "Cannot share a memory with yourself." });
      }
      if (!envelope?.roomId || envelope.actorId !== requesterActor.id) {
        return reply.code(403).send({ error: "Human Room context required" });
      }
      if (!contentAccess.ordinaryAccess) return unavailableMemoryAccess(reply, false);
      let result: LegacyHumanContentAccessResult;
      try {
        result = await contentAccess.ordinaryAccess.executeLegacyHuman(
          legacyMemoryAdmission({
            userId: request.sessionUserId!,
            actorId: requesterActor.id,
            roomId: envelope.roomId,
            agentId,
            personalGrant: true,
          }),
          {
            object: { kind: "memory", id },
            change: { kind: "grant_people", selectedActorIds: [target.actorId] },
          },
        );
      } catch {
        return unavailableMemoryAccess(reply, "unknown");
      }
      if (!("kind" in result)) return failedMemoryAccess(reply, result);
      if (result.kind !== "completed") return nonSuccessMemoryReceipt(reply, result.receipt);
      if (!isSuccessfulReceipt(result.receipt, false)) {
        return nonSuccessMemoryReceipt(reply, result.receipt);
      }
      const destination = result.details.destinations.length === 1
        ? result.details.destinations[0]
        : undefined;
      if (!destination) return unavailableMemoryAccess(reply, "unknown");
      emitMemoryEditAudit(trust, id, "grant");
      return reply.send({
        status: "granted",
        roomLabel: destination.label,
        minted: destination.minted,
      });
    }
    const outcome = await shareMemoryToUser({
      memoryId: id,
      requesterUserId: userId,
      agentId,
      targetHandle: body.user_handle!,
      readableNamespaces: readable,
      mintKind: "access",
    });
    if (!outcome.ok) {
      return reply.code(400).send({ error: outcome.reason });
    }
    emitMemoryEditAudit(trust, id, "grant");
    return reply.send({
      status: "granted",
      roomLabel: outcome.roomLabel,
      minted: outcome.minted,
    });
  });

  // M173 §5.4 — revoke one person's access by re-homing the memory into a
  // namespace whose room is everyone-who-had-access MINUS the target, so the
  // others keep access. You cannot revoke yourself (use make_private).
  app.post("/api/memory/:id/revoke", async (request, reply) => {
    const userId = request.sessionUserId ?? "";
    if (!userId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    if (!(await requireManageMemories(userId))) {
      return reply.code(403).send({ error: "manage_memories capability required" });
    }
    const { id } = request.params as { id: string };
    if (!isUuidString(id)) {
      return reply.code(400).send({ error: "Invalid memory id" });
    }
    const envelope = request.memoryEnvelope;
    if (memoryModeOf(envelope) !== "namespace") {
      return reply.code(400).send({ error: "namespace mode required" });
    }
    const protectedRequest = await resolveProtectedMemoryRequest(
      request,
      userId,
      protectedComposition,
    );
    if (await rejectUnprotectedMemoryInStrictShadow(reply, protectedRequest, enforceStrictBoundary)) return;
    if (protectedRequest) {
      return reply.code(404).send({
        error: "Protected Memory access requires exact access planning",
      });
    }

    const trust = trustFromRequest(request);
    const readable = envelopeReadableNamespaces(envelope);

    const detail = await getMemoryById(id, readable, trust);
    if (detail === "forbidden") {
      return reply.code(403).send({ error: "Memory not readable in this context" });
    }
    if (!detail) {
      return reply.code(404).send({ error: "Memory not found" });
    }

    const body = (request.body ?? {}) as { user_handle?: string };
    const rawHandle = typeof body.user_handle === "string" ? body.user_handle.trim() : "";
    if (!rawHandle) {
      return reply.code(400).send({ error: "user_handle required" });
    }

    const normalized = rawHandle.replace(/^@/, "");
    const targetHit = await findActorByHandle(normalized);
    if (!targetHit) {
      return reply.code(404).send({ error: "User not found" });
    }
    if (targetHit.kind !== "user") {
      return reply.code(400).send({ error: "handle is not a person" });
    }
    const targetActorId = targetHit.actorId;
    const targetActorRow = await findActorById(targetActorId);
    const targetUserId = targetActorRow?.ownerId;
    if (!targetUserId) {
      return reply.code(404).send({ error: "User not found" });
    }
    if (targetUserId === userId) {
      return reply
        .code(400)
        .send({ error: "use make_private to remove your own access" });
    }

    const requesterActor = await findActorByOwnerId(userId);
    if (!requesterActor) {
      return reply.code(409).send({ error: "requester actor not found" });
    }
    const requesterActorId = requesterActor.id;
    const agentId = envelope?.agentId ?? "";

    let policy: Awaited<ReturnType<typeof currentStrictShadowPolicy>>;
    try {
      policy = await (contentAccess.loadEncryptionPolicy ?? currentStrictShadowPolicy)();
    } catch {
      return unavailableMemoryAccess(reply, false);
    }
    if (policy.mode === "plaintext_only") {
      if (!envelope?.roomId || envelope.actorId !== requesterActorId) {
        return reply.code(403).send({ error: "Human Room context required" });
      }
      if (!contentAccess.ordinaryAccess) return unavailableMemoryAccess(reply, false);
      let result: LegacyHumanContentAccessResult;
      try {
        result = await contentAccess.ordinaryAccess.executeLegacyHuman(
          legacyMemoryAdmission({
            userId: request.sessionUserId!,
            actorId: requesterActorId,
            roomId: envelope.roomId,
            ...(agentId ? { agentId } : {}),
            personalGrant: false,
          }),
          {
            object: { kind: "memory", id },
            change: { kind: "remove_person", actorId: targetActorId },
          },
        );
      } catch {
        return unavailableMemoryAccess(reply, "unknown");
      }
      if (!("kind" in result)) return failedMemoryAccess(reply, result);
      if (result.kind !== "completed") return nonSuccessMemoryReceipt(reply, result.receipt);
      if (!isSuccessfulReceipt(result.receipt, true)) {
        return nonSuccessMemoryReceipt(reply, result.receipt);
      }
      emitMemoryEditAudit(trust, id, "revoke");
      return reply.send({
        status: "revoked",
        reHomed: result.details.accounting.removedAttachmentCount,
        skipped: legacySkipped(result),
      });
    }

    const attached = await getMemoryNamespaces(id, trust);
    const mutable = envelopeMutableNamespaces(envelope);
    const toAdd: string[] = [];
    const toRemove: string[] = [];
    const skipped: string[] = [];

    for (const ns of attached) {
      const room = await findRoomByNamespaceId(ns);
      if (!room) continue;
      if (!room.humanActorIds.includes(targetActorId)) continue; // target absent
      if (!mutable.includes(ns)) {
        skipped.push(ns); // target has access via a ns the requester can't write
        continue;
      }
      // requester is ALWAYS in `remaining` (can't revoke self; only writes
      // namespaces of rooms they're in), so `remaining` is never empty.
      const remaining = room.humanActorIds.filter((a) => a !== targetActorId);
      let dest: string;
      if (remaining.length === 1 && remaining[0] === requesterActorId) {
        const priv = await findAgentOwnerPrivateRoom(userId, agentId);
        if (!priv) {
          return reply
            .code(409)
            .send({ error: "No private namespace to re-home into" });
        }
        dest = priv.namespaceId;
      } else {
        const resolved = await findOrCreateAccessNamespace(remaining, {
          requesterUserId: userId,
          requesterActorId,
        });
        dest = resolved.namespaceId;
      }
      if (dest !== ns) {
        toAdd.push(dest);
        toRemove.push(ns);
      }
    }

    // Attach all destinations FIRST (idempotent) so the row never hits zero
    // attachments and gets auto-deleted, THEN detach the originals.
    for (const ns of toAdd) {
      await attachMemoryToNamespace(id, ns, trust);
    }
    for (const ns of toRemove) {
      await detachMemoryFromNamespace(id, ns, trust);
    }
    emitMemoryEditAudit(trust, id, "revoke");
    return reply.send({ status: "revoked", reHomed: toAdd.length, skipped });
  });

  // M173 §5.6 — strip all access except the requester's own private namespace.
  app.post("/api/memory/:id/make_private", async (request, reply) => {
    const userId = request.sessionUserId ?? "";
    if (!userId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    if (!(await requireManageMemories(userId))) {
      return reply.code(403).send({ error: "manage_memories capability required" });
    }
    const { id } = request.params as { id: string };
    if (!isUuidString(id)) {
      return reply.code(400).send({ error: "Invalid memory id" });
    }
    const envelope = request.memoryEnvelope;
    if (memoryModeOf(envelope) !== "namespace") {
      return reply.code(400).send({ error: "namespace mode required" });
    }
    const protectedRequest = await resolveProtectedMemoryRequest(
      request,
      userId,
      protectedComposition,
    );
    if (await rejectUnprotectedMemoryInStrictShadow(reply, protectedRequest, enforceStrictBoundary)) return;
    if (protectedRequest) {
      return reply.code(404).send({
        error: "Protected Memory access requires exact access planning",
      });
    }
    const trust = trustFromRequest(request);
    const readable = envelopeReadableNamespaces(envelope);

    const detail = await getMemoryById(id, readable, trust);
    if (detail === "forbidden") {
      return reply.code(403).send({ error: "Memory not readable in this context" });
    }
    if (!detail) {
      return reply.code(404).send({ error: "Memory not found" });
    }

    const agentId = envelope?.agentId ?? "";
    let policy: Awaited<ReturnType<typeof currentStrictShadowPolicy>>;
    try {
      policy = await (contentAccess.loadEncryptionPolicy ?? currentStrictShadowPolicy)();
    } catch {
      return unavailableMemoryAccess(reply, false);
    }
    if (policy.mode === "plaintext_only") {
      const requesterActor = await findActorByOwnerId(request.sessionUserId!);
      if (!requesterActor || !envelope?.roomId || envelope.actorId !== requesterActor.id) {
        return reply.code(403).send({ error: "Human Room context required" });
      }
      if (!contentAccess.ordinaryAccess) return unavailableMemoryAccess(reply, false);
      let result: LegacyHumanContentAccessResult;
      try {
        result = await contentAccess.ordinaryAccess.executeLegacyHuman(
          legacyMemoryAdmission({
            userId: request.sessionUserId!,
            actorId: requesterActor.id,
            roomId: envelope.roomId,
            ...(agentId ? { agentId } : {}),
            personalGrant: false,
          }),
          { object: { kind: "memory", id }, change: { kind: "make_private" } },
        );
      } catch {
        return unavailableMemoryAccess(reply, "unknown");
      }
      if (!("kind" in result)) return failedMemoryAccess(reply, result);
      if (result.kind !== "completed") return nonSuccessMemoryReceipt(reply, result.receipt);
      if (!isSuccessfulReceipt(result.receipt, true)) {
        return nonSuccessMemoryReceipt(reply, result.receipt);
      }
      emitMemoryEditAudit(trust, id, "make_private");
      return reply.send({ status: "private", skipped: legacySkipped(result) });
    }

    const priv = await findAgentOwnerPrivateRoom(userId, agentId);
    if (!priv) {
      return reply.code(409).send({ error: "No private namespace found" });
    }

    const attached = await getMemoryNamespaces(id, trust);
    const mutable = envelopeMutableNamespaces(envelope);

    // Attach the private namespace FIRST so the memory always keeps ≥1
    // attachment (never auto-deleted), THEN detach everything else writable.
    await attachMemoryToNamespace(id, priv.namespaceId, trust);
    const skipped: string[] = [];
    for (const ns of attached) {
      if (ns === priv.namespaceId) continue;
      if (mutable.includes(ns)) {
        await detachMemoryFromNamespace(id, ns, trust);
      } else {
        skipped.push(ns);
      }
    }
    emitMemoryEditAudit(trust, id, "make_private");
    return reply.send({ status: "private", skipped });
  });
}
