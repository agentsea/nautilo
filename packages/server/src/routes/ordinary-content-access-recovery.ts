import type { FastifyInstance } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { and, desc, eq, inArray, lt, jobs, sql, type PersistedJobRecord } from "@nautilo/db";
import {
  defaultPostModelDeps, OrdinaryContentAccessRetryRequiredError, OrdinaryContentAccessRecoveryUnavailableError,
  type OrdinaryContentAccessForState, type OrdinaryContentAccessRecoveryCoordinate, type StreamEventProcessor,
} from "@nautilo/agent";
import {
  botThreadId, createPersistingProcessor, eventBus, jobManager,
} from "@nautilo/runtime";
import { createAcceptedInvocationAuthority, getRoomDetailForMember } from "@nautilo/trust";
import { getServerDirectDb } from "../lib/server-direct-db";
import { currentStrictShadowPolicy } from "../lib/strict-shadow-policy";
import { requireAgentInvocation, type AssertCanInvokeAgent } from "../lib/agent-invocation-admission";
import { isMaintenanceDrainError, replyMaintenanceRejection } from "../lib/maintenance-rejection";
import { resolveContentAccessPreviewKey } from "../content-access/preview-key";

const coordinateSchema = z.object({
  originalJobId: z.uuid(), checkpointId: z.string().min(1), turnId: z.string().min(1),
  toolCallId: z.string().min(1), agentId: z.uuid(),
}).strict();
type PublicCoordinate = z.infer<typeof coordinateSchema>;
type JobLocator = Pick<PersistedJobRecord, "id" | "requestorId" | "laneKey" | "input">;

/** Latest canonical foreground Job only. An older failed Job is not a fallback. */
async function latestRoomThreadJob(roomId: string, graphThreadId: string): Promise<JobLocator | null> {
  const [row] = await getServerDirectDb().select({
    id: jobs.id, requestorId: jobs.requestorId, laneKey: jobs.laneKey, input: jobs.input,
  }).from(jobs).where(and(eq(jobs.roomId, roomId), eq(jobs.type, "foreground"),
    // Execution identity lives in the existing Job JSON, not a second registry.
    sql`${jobs.input}->>'graphThreadId' = ${graphThreadId}`,
    sql`${jobs.input}->'forkRun' IS NULL`,
  )).orderBy(desc(jobs.createdAt), desc(jobs.id)).limit(1);
  return row ?? null;
}

// Approved lossless transport batch, not a cap on eligible operations. Every
// remaining candidate is reachable through nextCursor, including empty pages.
const FORK_RECOVERY_PAGE_SIZE = 50;
class InvalidRecoveryCursor extends Error {}

/** Position authentication avoids requiring a retained anchor Job. Deletion
 * between pages cannot strand recovery; the cursor grants no authority. */
function forkCursorCodec(roomId: string, userId: string, parentThreadIds: string[]) {
  const key = resolveContentAccessPreviewKey();
  const sign = (position: string) => createHmac("sha256", key).update("nautilo/content-access/fork-page/v1\0")
    .update(JSON.stringify([roomId, userId, [...new Set(parentThreadIds)].sort(), position])).digest();
  return {
    issue: (position: string) => `${position}.${sign(position).toString("base64url")}`,
    read: (cursor: string) => {
      const [position, signature, extra] = cursor.split(".");
      if (!position || !signature || extra !== undefined || !z.uuid().safeParse(position).success) throw new InvalidRecoveryCursor();
      const actual = Buffer.from(signature, "base64url");
      const expected = sign(position);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new InvalidRecoveryCursor();
      return position;
    },
  };
}

async function forkRoomJobPage(roomId: string, userId: string, parentThreadIds: string[], cursor: string | undefined,
  exactId?: string): Promise<{ jobs: JobLocator[]; nextCursor: string | null }> {
  const codec = forkCursorCodec(roomId, userId, parentThreadIds);
  const afterId = cursor === undefined ? undefined : codec.read(cursor);
  const db = getServerDirectDb();
  const scope = and(eq(jobs.roomId, roomId), eq(jobs.requestorId, userId), eq(jobs.type, "foreground"),
    inArray(jobs.status, ["failed", "completed"]), sql`${jobs.input}->'forkRun'->>'mode' = 'fork'`,
    inArray(sql<string>`${jobs.input}->'forkRun'->>'parentThreadId'`, parentThreadIds));
  const rows = await db.select({ id: jobs.id, requestorId: jobs.requestorId, laneKey: jobs.laneKey, input: jobs.input })
    .from(jobs).where(and(scope, afterId ? lt(jobs.id, afterId) : undefined, exactId ? eq(jobs.id, exactId) : undefined))
    .orderBy(desc(jobs.id)).limit(exactId === undefined ? FORK_RECOVERY_PAGE_SIZE + 1 : 1);
  const page = rows.slice(0, FORK_RECOVERY_PAGE_SIZE);
  return { jobs: page, nextCursor: rows.length > FORK_RECOVERY_PAGE_SIZE ? codec.issue(page.at(-1)!.id) : null };
}

export interface OrdinaryContentAccessRecoveryRouteDeps {
  readonly ordinaryContentAccessForState: OrdinaryContentAccessForState;
  readonly manager?: Pick<typeof jobManager, "discoverOrdinaryContentAccessRecovery" | "runOrdinaryContentAccessRecovery">;
  readonly roomDetail?: typeof getRoomDetailForMember;
  readonly latestJob?: typeof latestRoomThreadJob;
  readonly forkPage?: typeof forkRoomJobPage;
  readonly policy?: typeof currentStrictShadowPolicy;
  readonly assertCanInvokeAgent?: AssertCanInvokeAgent;
  readonly processor?: (input: Parameters<typeof createPersistingProcessor>[0]) => StreamEventProcessor;
}

function publicCoordinate(value: OrdinaryContentAccessRecoveryCoordinate): PublicCoordinate {
  return { originalJobId: value.originalJobId, checkpointId: value.checkpointId,
    turnId: value.turnId, toolCallId: value.toolCallId, agentId: value.agentId };
}

/** Browser/Desktop opt-in endpoint; existing Mobile protocol remains unchanged. */
export function ordinaryContentAccessRecoveryRoutes(app: FastifyInstance, deps: OrdinaryContentAccessRecoveryRouteDeps): void {
  const manager = deps.manager ?? jobManager;
  const path = "/api/rooms/:roomId/content-access-recovery";
  for (const method of ["GET", "POST"] as const) app.route<{ Params: { roomId: string }; Body: unknown; Querystring: { cursor?: string } }>({
    method, url: path,
    async handler(request, reply) {
      reply.header("Cache-Control", "no-store");
      const userId = request.sessionUserId;
      const actorId = request.sessionActorId;
      if (!userId || !actorId || request.policyContext?.actorRole === "guest") {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (!z.uuid().safeParse(request.params.roomId).success) return reply.code(400).send({ error: "Invalid Room" });
      const parsed = method === "POST" ? coordinateSchema.safeParse(request.body) : null;
      if (parsed !== null && !parsed.success) return reply.code(400).send({ error: "Invalid recovery coordinate" });
      const query = z.object({ cursor: z.string().min(1).optional() }).strict().safeParse(request.query);
      if (!query.success || (method === "POST" && query.data.cursor !== undefined)) return reply.code(400).send({ error: "Invalid recovery cursor" });
      try {
        const detail = await (deps.roomDetail ?? getRoomDetailForMember)(request.params.roomId, actorId);
        if (detail === null) return reply.code(404).send({ error: "Room not found" });
        if ((await (deps.policy ?? currentStrictShadowPolicy)()).mode !== "plaintext_only") {
          return reply.send(method === "GET" ? { recoveries: [], nextCursor: null } : { outcome: "unavailable" });
        }
        const agentIds = [...new Set(detail.members.flatMap((member) => member.kind === "agent" && member.agentId ? [member.agentId] : []))];
        const graphDeps = { ...defaultPostModelDeps, ordinaryContentAccessForState: async (...args: Parameters<OrdinaryContentAccessForState>) => {
          const selected = await deps.ordinaryContentAccessForState(...args);
          // This continuation has no protected invocation custody. A mode
          // transition stops the entire graph, including subsequent model work.
          if (selected.mode !== "plaintext_only") throw new OrdinaryContentAccessRecoveryUnavailableError();
          return selected;
        } };
        // Same direct/per-Agent locator semantics as existing foreground pending attention.
        const direct = agentIds.length === 1 && detail.members.filter((member) => member.kind === "user").length === 1;
        const recoveries: PublicCoordinate[] = [];
        const parents = agentIds.map((agentId) => direct ? detail.graphThreadId : botThreadId(detail.id, agentId));
        const candidates: { job: JobLocator; parentThreadId: string; fork: boolean }[] = [];
        if (query.data.cursor === undefined) for (const parentThreadId of parents) {
          const job = await (deps.latestJob ?? latestRoomThreadJob)(detail.id, parentThreadId);
          if (job) candidates.push({ job, parentThreadId, fork: false });
        }
        const page = parents.length === 0 ? { jobs: [], nextCursor: null }
          : await (deps.forkPage ?? forkRoomJobPage)(detail.id, userId, parents, query.data.cursor, parsed?.success ? parsed.data.originalJobId : undefined);
        for (const job of page.jobs) {
          const metadata = job.input?.["forkRun"] as { parentThreadId?: unknown } | undefined;
          if (typeof metadata?.parentThreadId === "string" && parents.includes(metadata.parentThreadId)) {
            candidates.push({ job, parentThreadId: metadata.parentThreadId, fork: true });
          }
        }
        const admitted = new Set<string>();
        for (const candidate of candidates) {
          const { job, parentThreadId } = candidate;
          const agentId = job.input?.["agentId"];
          if (typeof agentId !== "string" || !agentIds.includes(agentId)
            || (direct ? detail.graphThreadId : botThreadId(detail.id, agentId)) !== parentThreadId) continue;
          if (parsed?.success && parsed.data.agentId !== agentId) continue;
          const metadata = job.input?.["forkRun"] as { mode?: unknown; parentThreadId?: unknown; checkpointThreadId?: unknown; forkThreadId?: unknown; transcriptThreadId?: unknown } | undefined;
          if (candidate.fork && (metadata?.mode !== "fork" || typeof metadata.checkpointThreadId !== "string"
            || !metadata.checkpointThreadId || metadata.forkThreadId !== metadata.checkpointThreadId
            || metadata.transcriptThreadId !== parentThreadId || metadata.parentThreadId !== parentThreadId)) continue;
          if (!candidate.fork && metadata) continue;
          const graphThreadId = candidate.fork ? metadata!.checkpointThreadId as string : parentThreadId;
          if (job === null || job.requestorId !== userId || !job.laneKey
            || job.input?.["agentId"] !== agentId || job.input["roomId"] !== detail.id
            || job.input["graphThreadId"] !== parentThreadId
            || (parsed?.success && parsed.data.originalJobId !== job.id)) continue;
          if (!admitted.has(agentId) && !await requireAgentInvocation({ humanUserId: userId, roomId: detail.id, agentId,
            origin: "foreground_resume" }, reply, deps.assertCanInvokeAgent)) return;
          admitted.add(agentId);
          const authority = createAcceptedInvocationAuthority(userId);
          const scope = { originalJobId: job.id, graphThreadId, laneKey: job.laneKey,
            roomId: detail.id, humanUserId: userId, humanActorId: actorId, agentId,
            ...(candidate.fork ? { executionOwner: { kind: "fork" as const, parentThreadId, transcriptThreadId: parentThreadId } } : {}) };
          const found = await manager.discoverOrdinaryContentAccessRecovery(scope, graphDeps, authority);
          if (found === null) continue;
          if (method === "GET") { recoveries.push(publicCoordinate(found)); continue; }
          if (!parsed?.success || parsed.data.checkpointId !== found.checkpointId
            || parsed.data.turnId !== found.turnId || parsed.data.toolCallId !== found.toolCallId) continue;
          const processor = (deps.processor ?? createPersistingProcessor)({
            threadId: parentThreadId, ownerId: userId, agentId, roomId: detail.id,
            ...(detail.kind === "subthread" ? { subthreadRoomId: detail.id } : {}),
            laneKey: job.laneKey, eventBus, humanTurnId: found.turnId, causalHumanUserId: userId,
          });
          const outcome = await manager.runOrdinaryContentAccessRecovery(found, graphDeps, processor, authority);
          return reply.send({ outcome });
        }
        return reply.send(method === "GET" ? { recoveries, nextCursor: page.nextCursor } : { outcome: "unavailable" });
      } catch (error) {
        if (error instanceof InvalidRecoveryCursor) return reply.code(400).send({ error: "recovery_cursor_invalid", restartDiscovery: true });
        if (error instanceof OrdinaryContentAccessRecoveryUnavailableError) return reply.send(method === "GET" ? { recoveries: [], nextCursor: null } : { outcome: "unavailable" });
        if (error instanceof OrdinaryContentAccessRetryRequiredError) return reply.send({ outcome: "retry_required" });
        if (isMaintenanceDrainError(error)) return replyMaintenanceRejection(reply, error);
        // No raw checkpoint, principal snapshot, token or provider error is public.
        return reply.code(503).send({ error: "content_access_recovery_unavailable" });
      }
    },
  });
}
