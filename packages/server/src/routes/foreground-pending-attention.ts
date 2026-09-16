import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { SQLWrapper } from "drizzle-orm";
import { liveShadowMessagePlanRequestV1Schema } from "@nautilo/api-client";
import {
  alias, and, asc, eq, gt, inArray, isNull, notExists, or,
  memoryReviewTurns, rooms, sessions,
  createPostgresJsBridgeConnection, getSharedDirectCryptoDb,
  getEncryptionTransitionPolicy,
} from "@nautilo/db";
import { readPendingInterruptEventsForThread } from "@nautilo/agent";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  inspectDomainKeyV2CryptoAuthority,
  LIVE_SHADOW_FOREGROUND_AUTHORIZATION_TTL_MS,
  PostgresDomainKeyAuthorityRepository,
  PostgresNamespaceProductAuthority,
  type LiveShadowRecipientRegistry,
} from "@nautilo/lattice-bridge/server";
import {
  botThreadId,
  readProtectedPendingInterruptEvents,
  requiresEncryptedForegroundCheckpoint,
} from "@nautilo/runtime";
import { envelopeReadableNamespaces, getPolicyResolver, getRoomDetailForMember } from "@nautilo/trust";
import type { ServerEvent } from "@nautilo/types";
import { getServerDirectDb } from "../lib/server-direct-db";
import { liveShadowLargeRequestRouteOptions } from "./live-shadow-request-boundary";
import type { LiveShadowMessageClientSessionInspector } from "./live-shadow-message";
import {
  createForegroundCheckpointReadAuthority,
  type ForegroundCheckpointReadBinding,
  type ForegroundCheckpointReadLocator,
  type ForegroundCheckpointReadSnapshot,
} from "./foreground-checkpoint-read-authority";

type PendingAttentionEvent = Extract<ServerEvent, {
  type: "approval.ask" | "prove_it.challenge" | "identity.challenge";
}>;

type PendingAttentionCursor = Readonly<{
  version: 1;
  createdAt: Date;
  reviewTurnId: string;
}>;

type PendingAttentionRoomShape = Readonly<{
  id: string;
  graphThreadId: string;
  members: readonly Readonly<{
    kind: "user" | "agent";
    agentId?: string;
  }>[];
}>;

type PendingAttentionTurnShape = Readonly<{
  agentId: string;
  threadId: string;
  checkpointThreadId: string;
  turnId: string;
}>;

type PendingAttentionLocatorResult =
  | Readonly<{ status: "found"; locator: ForegroundCheckpointReadLocator }>
  | Readonly<{ status: "exhausted" }>
  | Readonly<{ status: "unavailable" }>;

type PendingAttentionPage = Readonly<{
  status: "ready" | "unavailable";
  events: PendingAttentionEvent[];
  nextCursor: string | null;
  challenge?: Readonly<{
    challengeId: string;
    roomId: string;
    authorizationPlanBytesBase64url: string;
    recipientPublicKeyBase64url: string;
    deadlineAt: number;
  }>;
}>;

type PendingAttentionRead = Readonly<{
  status: "read" | "unavailable";
  events: PendingAttentionEvent[];
}>;

const unavailablePage: PendingAttentionPage = {
  status: "unavailable",
  events: [],
  nextCursor: null,
};

const uuidSchema = z.string().uuid();

/**
 * One hydration walks the rows that existed in creation order while it ran.
 * A newly admitted row after the terminal page is delivered by the existing
 * live-event fence, which invalidates and restarts hydration.
 */
export function encodeForegroundPendingAttentionCursor(
  cursor: PendingAttentionCursor,
): string {
  return Buffer.from(JSON.stringify({
    version: cursor.version,
    createdAt: cursor.createdAt.toISOString(),
    reviewTurnId: cursor.reviewTurnId,
  })).toString("base64url");
}

export function decodeForegroundPendingAttentionCursor(
  encoded: string,
): PendingAttentionCursor | null {
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.length === 0 || bytes.toString("base64url") !== encoded) {
      return null;
    }
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (typeof value !== "object" || value === null) return null;
    const record = value as Record<string, unknown>;
    if (
      record["version"] !== 1
      || typeof record["createdAt"] !== "string"
      || !uuidSchema.safeParse(record["reviewTurnId"]).success
      || Object.keys(record).sort().join(",")
        !== "createdAt,reviewTurnId,version"
    ) return null;
    const createdAt = new Date(record["createdAt"]);
    if (
      Number.isNaN(createdAt.getTime())
      || createdAt.toISOString() !== record["createdAt"]
    ) return null;
    return Object.freeze({
      version: 1,
      createdAt,
      reviewTurnId: record["reviewTurnId"] as string,
    });
  } catch {
    return null;
  }
}

export function resolveForegroundPendingAttentionTurnCoordinates(
  detail: PendingAttentionRoomShape,
  humanActorId: string,
  turn: PendingAttentionTurnShape,
): Readonly<{
  entrypointId: "foreground.main" | "foreground.fork";
  laneKey: string;
}> | null {
  const agents = detail.members.filter((member) =>
    member.kind === "agent" && member.agentId !== undefined
  );
  if (!agents.some((member) => member.agentId === turn.agentId)) return null;
  const direct = agents.length === 1
    && detail.members.filter((member) => member.kind === "user").length === 1;
  const expectedThreadId = direct
    ? detail.graphThreadId
    : botThreadId(detail.id, turn.agentId);
  if (turn.threadId !== expectedThreadId) return null;
  const entrypointId = turn.checkpointThreadId === turn.threadId
    ? "foreground.main" as const
    : (() => {
        const prefix = `${turn.threadId}:fork:${turn.turnId}:`;
        const suffix = turn.checkpointThreadId.startsWith(prefix)
          ? turn.checkpointThreadId.slice(prefix.length)
          : "";
        return /^[0-9a-f]{8}$/u.test(suffix)
          ? "foreground.fork" as const
          : null;
      })();
  if (entrypointId === null) return null;
  return Object.freeze({
    entrypointId,
    laneKey: direct
      ? `room:${detail.id}`
      : `room:${detail.id}:user:${humanActorId}:bot:${turn.agentId}`,
  });
}

export function sameForegroundPendingAttentionLocator(
  left: ForegroundCheckpointReadLocator,
  right: ForegroundCheckpointReadLocator,
): boolean {
  return left.reviewTurnId === right.reviewTurnId
    && left.generationId === right.generationId
    && left.turnId === right.turnId
    && left.checkpointThreadId === right.checkpointThreadId
    && left.threadId === right.threadId
    && left.sessionId === right.sessionId
    && left.roomId === right.roomId
    && left.topLevelRoomId === right.topLevelRoomId
    && left.agentId === right.agentId
    && left.namespaceId === right.namespaceId
    && left.accessScope === right.accessScope
    && left.firstMessageId === right.firstMessageId
    && left.createdAt.getTime() === right.createdAt.getTime()
    && left.entrypointId === right.entrypointId
    && left.laneKey === right.laneKey;
}

/** Keep PostgreSQL's full timestamp precision; a JS Date is not an SQL cursor. */
export function foregroundPendingAttentionAfterAnchor(
  createdAt: SQLWrapper,
  reviewTurnId: string,
) {
  return or(
    gt(memoryReviewTurns.createdAt, createdAt),
    and(eq(memoryReviewTurns.createdAt, createdAt), gt(memoryReviewTurns.id, reviewTurnId)),
  );
}

/** One page is one checkpoint/authorization, not an arbitrary truncated batch. */
export function createProductionForegroundPendingAttention(recipients: LiveShadowRecipientRegistry) {
  const db = getServerDirectDb();
  const crypto = new LatticeCrypto();
  const productAuthority = new PostgresNamespaceProductAuthority(createPostgresJsBridgeConnection(db));
  const repository = new PostgresDomainKeyAuthorityRepository(
    createPostgresJsBridgeConnection(getSharedDirectCryptoDb()), crypto,
    process.env["NAUTILO_PUBLIC_BASE_URL"]?.trim() || "http://localhost:3001",
  );

  async function locate(binding: ForegroundCheckpointReadBinding, roomId: string, options: {
    cursor?: string; exact?: ForegroundCheckpointReadLocator;
  } = {}): Promise<PendingAttentionLocatorResult> {
    const detail = await getRoomDetailForMember(roomId, binding.humanActorId);
    if (detail === null) return { status: "unavailable" };
    const currentAgentIds = detail.members.flatMap((member) => member.kind === "agent" && member.agentId !== undefined ? [member.agentId] : []);
    // An accessible Human-only conversation has no Agent approvals to restore.
    // An exact checkpoint lookup must still fail closed if its Agent left.
    if (currentAgentIds.length === 0) return options.exact === undefined
      ? { status: "exhausted" }
      : { status: "unavailable" };
    const direct = currentAgentIds.length === 1
      && detail.members.filter((member) => member.kind === "user").length === 1;
    const expectedThreadIds = direct
      ? [detail.graphThreadId]
      : currentAgentIds.map((agentId) => botThreadId(roomId, agentId));
    const cursor = options.cursor === undefined
      ? null
      : decodeForegroundPendingAttentionCursor(options.cursor);
    if (options.cursor !== undefined && cursor === null) return { status: "unavailable" };
    const anchor = alias(memoryReviewTurns, "pending_attention_cursor_anchor");
    const anchorQuery = cursor === null ? null : db.select({ createdAt: anchor.createdAt })
      .from(anchor).where(and(
        eq(anchor.id, cursor.reviewTurnId),
        eq(anchor.ownerId, binding.userId),
        eq(anchor.actorId, binding.humanActorId),
        eq(anchor.roomId, roomId),
      ));
    const anchorIsCurrent = async (): Promise<boolean> => {
      if (anchorQuery === null || cursor === null) return true;
      const anchors = await anchorQuery;
      return anchors.length === 1
        && anchors[0]!.createdAt.getTime() === cursor.createdAt.getTime();
    };
    // The cursor's Date validates its legacy millisecond coordinate, but
    // ordering uses the exact stored timestamp selected by immutable row id.
    // Completed anchors remain usable; missing anchors are not an empty page.
    if (!await anchorIsCurrent()) return { status: "unavailable" };
    const newer = alias(memoryReviewTurns, "pending_attention_newer_turn");
    const rows = await db.select({ turn: memoryReviewTurns, namespaceId: rooms.namespaceId, parentRoomId: rooms.parentRoomId })
      .from(memoryReviewTurns)
      .innerJoin(sessions, eq(sessions.id, memoryReviewTurns.sessionId))
      .innerJoin(rooms, eq(rooms.id, memoryReviewTurns.roomId))
      .where(and(
        eq(memoryReviewTurns.ownerId, binding.userId), eq(memoryReviewTurns.actorId, binding.humanActorId),
        inArray(memoryReviewTurns.agentId, currentAgentIds),
        eq(memoryReviewTurns.roomId, roomId), inArray(memoryReviewTurns.threadId, expectedThreadIds),
        eq(sessions.roomId, roomId), eq(sessions.agentId, memoryReviewTurns.agentId),
        eq(sessions.threadId, memoryReviewTurns.threadId),
        eq(sessions.ownerId, memoryReviewTurns.ownerId),
        eq(memoryReviewTurns.state, "awaiting"), isNull(memoryReviewTurns.receiptId),
        isNull(rooms.archivedAt),
        cursor === null || anchorQuery === null ? undefined
          : foregroundPendingAttentionAfterAnchor(anchorQuery, cursor.reviewTurnId),
        options.exact === undefined ? undefined : and(
          eq(memoryReviewTurns.id, options.exact.reviewTurnId), eq(memoryReviewTurns.turnId, options.exact.turnId),
          eq(memoryReviewTurns.checkpointThreadId, options.exact.checkpointThreadId),
          eq(memoryReviewTurns.sessionId, options.exact.sessionId), eq(memoryReviewTurns.agentId, options.exact.agentId),
          eq(memoryReviewTurns.generationId, options.exact.generationId),
          eq(memoryReviewTurns.accessScope, options.exact.accessScope),
          eq(memoryReviewTurns.firstMessageId, options.exact.firstMessageId),
          eq(memoryReviewTurns.threadId, options.exact.threadId),
          eq(rooms.namespaceId, options.exact.namespaceId),
        ),
        notExists(db.select({ id: newer.id }).from(newer).where(and(
          eq(newer.sessionId, memoryReviewTurns.sessionId),
          eq(newer.agentId, memoryReviewTurns.agentId),
          eq(newer.roomId, memoryReviewTurns.roomId),
          eq(newer.ownerId, memoryReviewTurns.ownerId),
          eq(newer.actorId, memoryReviewTurns.actorId),
          eq(newer.accessScope, memoryReviewTurns.accessScope),
          eq(newer.threadId, memoryReviewTurns.threadId),
          eq(newer.checkpointThreadId, memoryReviewTurns.checkpointThreadId),
          gt(newer.firstMessageId, memoryReviewTurns.firstMessageId),
        ))),
      )).orderBy(asc(memoryReviewTurns.createdAt), asc(memoryReviewTurns.id)).limit(1);
    const row = rows[0];
    if (row === undefined) {
      if (!await anchorIsCurrent()) return { status: "unavailable" };
      return options.exact === undefined
        ? { status: "exhausted" }
        : { status: "unavailable" };
    }
    if (row.namespaceId === null) return { status: "unavailable" };
    const coordinates = resolveForegroundPendingAttentionTurnCoordinates(
      detail,
      binding.humanActorId,
      row.turn,
    );
    if (coordinates === null) return { status: "unavailable" };
    const resolver = getPolicyResolver();
    if (resolver === null) return { status: "unavailable" };
    const envelope = await resolver.buildEnvelope(binding.humanActorId, coordinates.laneKey, row.turn.agentId, roomId);
    if (envelope.ownerId !== binding.userId || envelope.actorId !== binding.humanActorId
      || !envelopeReadableNamespaces(envelope).includes(row.namespaceId)) return { status: "unavailable" };
    return { status: "found", locator: {
      reviewTurnId: row.turn.id, turnId: row.turn.turnId,
      checkpointThreadId: row.turn.checkpointThreadId, sessionId: row.turn.sessionId,
      roomId, topLevelRoomId: row.parentRoomId ?? roomId,
      agentId: row.turn.agentId, namespaceId: row.namespaceId,
      generationId: row.turn.generationId,
      accessScope: row.turn.accessScope,
      firstMessageId: row.turn.firstMessageId,
      createdAt: row.turn.createdAt,
      threadId: row.turn.threadId,
      laneKey: coordinates.laneKey,
      entrypointId: coordinates.entrypointId,
    } };
  }

  async function resolveCurrent(binding: ForegroundCheckpointReadBinding, locator: ForegroundCheckpointReadLocator): Promise<ForegroundCheckpointReadSnapshot | null> {
    const located = await locate(binding, locator.roomId, { exact: locator });
    if (located.status !== "found"
      || !sameForegroundPendingAttentionLocator(located.locator, locator)) return null;
    const current = located.locator;
    // Preserve the existing foreground protected Subthread admission boundary.
    if (current.roomId !== current.topLevelRoomId) return null;
    const policy = await getEncryptionTransitionPolicy(db);
    if (!requiresEncryptedForegroundCheckpoint(policy)) return null;
    const inspected = await inspectDomainKeyV2CryptoAuthority({
      productAuthority, repository, exactNamespaceOnly: true,
      planInput: { authority: { userId: binding.userId, humanActorId: binding.humanActorId }, clientDeviceId: binding.clientDeviceId },
      product: { roomId: current.roomId, namespaceId: current.namespaceId, agentId: current.agentId },
      topLevelRoomId: current.topLevelRoomId,
      resolveReadableNamespaces: async (coordinates) => {
        const resolver = getPolicyResolver();
        if (resolver === null) throw new Error("Pending attention policy unavailable");
        const envelope = await resolver.buildEnvelope(
          coordinates.humanActorId,
          current.laneKey,
          coordinates.agentId,
          coordinates.roomId,
        );
        if (envelope.ownerId !== binding.userId || envelope.actorId !== binding.humanActorId) throw new Error("Pending attention authority changed");
        return envelopeReadableNamespaces(envelope);
      },
    });
    if (inspected.status !== "ready") return null;
    const authority = inspected.authority;
    let transferred = false;
    try {
      const signingKey = await repository.inspectForegroundDeviceSigningAuthority({
      userId: binding.userId, subjectHumanId: binding.humanActorId, deviceId: binding.clientDeviceId,
      generation: authority.committerDeviceSigningKeyGeneration, revision: authority.hostAuthorizationRevision,
    });
      if (signingKey === null) return null;
      transferred = true;
      return { ...authority, policyRevision: policy.revision, committerDeviceSigningPublicKey: signingKey };
    } finally {
      if (!transferred) {
        for (const value of Object.values(authority.room)) if (value instanceof Uint8Array) value.fill(0);
        for (const domain of authority.domains) {
          domain.participantDigest.fill(0); domain.headDigest.fill(0); domain.activeNamespaceBindingSetDigest.fill(0);
        }
      }
    }
  }

  const reads = createForegroundCheckpointReadAuthority({ crypto, recipients, namespaceKeys: repository, resolveCurrent });
  function viewerEvents(
    events: ServerEvent[],
    binding: ForegroundCheckpointReadBinding,
  ): PendingAttentionEvent[] {
    return events.filter((event): event is PendingAttentionEvent =>
      (event.type === "approval.ask"
        || event.type === "prove_it.challenge"
        || event.type === "identity.challenge")
      && "userId" in event
      && event.userId === binding.userId
    );
  }
  return {
    async page(
      binding: ForegroundCheckpointReadBinding,
      roomId: string,
      cursor?: string,
    ): Promise<PendingAttentionPage> {
      const located = await locate(binding, roomId, cursor === undefined ? {} : { cursor });
      if (located.status === "unavailable") return unavailablePage;
      if (located.status === "exhausted") {
        return {
          status: "ready" as const,
          events: [] as PendingAttentionEvent[],
          nextCursor: null,
        };
      }
      const locator = located.locator;
      const policy = await getEncryptionTransitionPolicy(db);
      if (!requiresEncryptedForegroundCheckpoint(policy)) {
        const events = await readPendingInterruptEventsForThread(
          locator.checkpointThreadId,
          locator.laneKey,
        );
        const latestPolicy = await getEncryptionTransitionPolicy(db);
        const current = await locate(binding, roomId, { exact: locator });
        if (
          latestPolicy.revision !== policy.revision
          || current.status !== "found"
          || !sameForegroundPendingAttentionLocator(current.locator, locator)
        ) return unavailablePage;
        return { status: "ready" as const, events: viewerEvents(events, binding), nextCursor: encodeForegroundPendingAttentionCursor({
          version: 1, createdAt: locator.createdAt, reviewTurnId: locator.reviewTurnId,
        }) };
      }
      const challenge = await reads.plan({ binding, locator, deadlineAt: Date.now() + LIVE_SHADOW_FOREGROUND_AUTHORIZATION_TTL_MS });
      if (challenge.status !== "authorization_required") return unavailablePage;
      try {
        return { status: "ready" as const, events: [] as PendingAttentionEvent[], nextCursor: encodeForegroundPendingAttentionCursor({
          version: 1, createdAt: locator.createdAt, reviewTurnId: locator.reviewTurnId,
        }),
          challenge: { challengeId: challenge.challengeId, roomId,
            authorizationPlanBytesBase64url: Buffer.from(challenge.authorizationPlanBytes).toString("base64url"),
            recipientPublicKeyBase64url: Buffer.from(challenge.recipientPublicKey).toString("base64url"), deadlineAt: challenge.deadlineAt } };
      } finally {
        challenge.authorizationPlanBytes.fill(0); challenge.recipientPublicKey.fill(0);
      }
    },
    async read(
      binding: ForegroundCheckpointReadBinding,
      roomId: string,
      challengeId: string,
      authorizationBytes: Uint8Array,
    ): Promise<PendingAttentionRead> {
      const result = await reads.read({ binding, challengeId, authorizationBytes,
        execute: async (checkpoint, locator) => {
          if (locator.roomId !== roomId) throw new Error("Pending attention Room changed");
          return viewerEvents(await readProtectedPendingInterruptEvents({
            logicalThreadId: locator.checkpointThreadId,
            laneKey: locator.laneKey,
            checkpoint,
          }), binding);
        } });
      return result.status === "read" ? { status: "read" as const, events: result.value }
        : { status: "unavailable" as const, events: [] as PendingAttentionEvent[] };
    },
    cancelForClientSession: reads.cancelForClientSession,
    cancelForHuman: reads.cancelForHuman,
    close: reads.close,
  };
}

const bindingSchema = z.object({
  clientActionSessionId: liveShadowMessagePlanRequestV1Schema.shape.clientActionSessionId,
  authorizationDeviceId: liveShadowMessagePlanRequestV1Schema.shape.clientDeviceId,
});
const pageSchema = bindingSchema.extend({
  cursor: z.string().min(1).refine((value) =>
    decodeForegroundPendingAttentionCursor(value) !== null
  ).optional(),
});
const readSchema = bindingSchema.extend({ challengeId: z.string().uuid(), authorizationBytesBase64url: z.string().min(1) });

export function foregroundPendingAttentionRoutes(app: FastifyInstance, options: {
  service: ReturnType<typeof createProductionForegroundPendingAttention>;
  clientSessions: LiveShadowMessageClientSessionInspector;
}) {
  app.post<{
    Params: { roomId: string };
    Body: z.infer<typeof pageSchema>;
  }>(
    "/api/rooms/:roomId/pending-attention",
    liveShadowLargeRequestRouteOptions,
    async (request, reply) => {
      reply.header("Cache-Control", "private, no-store").header("Vary", "Authorization");
      if (!request.sessionUserId || !request.sessionActorId || request.policyContext?.actorRole === "guest") return reply.code(401).send({ error: "unauthorized" });
      const parsed = pageSchema.safeParse(request.body);
      if (!parsed.success || !z.string().uuid().safeParse(request.params.roomId).success) return reply.code(400).send({ error: "invalid_request" });
      const session = options.clientSessions.inspect({ clientActionSessionId: parsed.data.clientActionSessionId, actorId: request.sessionActorId });
      if (session?.initiatingClientSurface !== "workbench.browser" && session?.initiatingClientSurface !== "workbench.desktop") return reply.code(403).send({ error: "client_unavailable" });
      const binding = { userId: request.sessionUserId, humanActorId: request.sessionActorId,
        clientDeviceId: parsed.data.authorizationDeviceId, clientActionSessionId: parsed.data.clientActionSessionId };
      try {
        return await options.service.page(
          binding,
          request.params.roomId,
          parsed.data.cursor,
        );
      } catch {
        return unavailablePage;
      }
    },
  );

  app.post<{
    Params: { roomId: string };
    Body: z.infer<typeof readSchema>;
  }>(
    "/api/rooms/:roomId/pending-attention/read",
    liveShadowLargeRequestRouteOptions,
    async (request, reply) => {
      reply.header("Cache-Control", "private, no-store").header("Vary", "Authorization");
      if (!request.sessionUserId || !request.sessionActorId || request.policyContext?.actorRole === "guest") return reply.code(401).send({ error: "unauthorized" });
      const parsed = readSchema.safeParse(request.body);
      if (!parsed.success || !z.string().uuid().safeParse(request.params.roomId).success) return reply.code(400).send({ error: "invalid_request" });
      const session = options.clientSessions.inspect({ clientActionSessionId: parsed.data.clientActionSessionId, actorId: request.sessionActorId });
      if (session?.initiatingClientSurface !== "workbench.browser" && session?.initiatingClientSurface !== "workbench.desktop") return reply.code(403).send({ error: "client_unavailable" });
      const binding = { userId: request.sessionUserId, humanActorId: request.sessionActorId,
        clientDeviceId: parsed.data.authorizationDeviceId, clientActionSessionId: parsed.data.clientActionSessionId };
      const bytes = Buffer.from(parsed.data.authorizationBytesBase64url, "base64url");
      if (bytes.length === 0 || bytes.toString("base64url") !== parsed.data.authorizationBytesBase64url) return reply.code(400).send({ error: "invalid_request" });
      try {
        return await options.service.read(
          binding,
          request.params.roomId,
          parsed.data.challengeId,
          bytes,
        );
      } catch {
        return { status: "unavailable", events: [] };
      } finally {
        bytes.fill(0);
      }
    },
  );
}
