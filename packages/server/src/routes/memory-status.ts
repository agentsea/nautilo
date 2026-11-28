import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { memoryAdminStatusSchema, memoryRetryResponseSchema, memoryRecoveryRunSchema, type MemoryRecoveryRun, type MemoryAdminStatus } from "@nautilo/types";
import { getUserCapabilities } from "@nautilo/trust";
import { z } from "zod";
import { STENOGRAPHER_STATUS_WINDOW_MS } from "./stenographer-status";

export interface MemoryStatusRoutesDeps {
  queryStatus(input: { now: Date; since: Date; until: Date }): Promise<MemoryAdminStatus>;
  /** The repository atomically marks only safely retryable failed work due. */
  retryFailed(): Promise<{ requested: number }>;
  requestModelRecovery(input: {
    workId: string; headTurnId: string; authorizedBy: string; now: Date;
  }): Promise<"queued" | "already_requested" | "blocked">;
  recovery: {
    latest(): Promise<MemoryRecoveryRun | null>;
    request(input: { requestId: string; authorizedBy: string; now: Date }): Promise<MemoryRecoveryRun>;
  };
  getCapabilities?: typeof getUserCapabilities;
  now?: () => Date;
}

const modelRecoveryRequest = z.object({
  workId: z.string().uuid(),
  headTurnId: z.string().uuid(),
  confirmBillableRerun: z.literal(true),
}).strict();

export function memoryStatusRoutes(app: FastifyInstance, deps: MemoryStatusRoutesDeps): void {
  const capabilities = deps.getCapabilities ?? getUserCapabilities;
  async function authorize(
    request: FastifyRequest, reply: FastifyReply,
    capability: "read_server_settings" | "manage_server_operations",
  ): Promise<boolean> {
    if (!request.sessionUserId) {
      reply.code(401).send({ error: "Authentication required" });
      return false;
    }
    let allowed = false;
    try { allowed = (await capabilities(request.sessionUserId)).includes(capability); } catch { /* deny closed */ }
    if (!allowed) reply.code(403).send({ error: `${capability} capability required` });
    return allowed;
  }
  app.get("/api/admin/memory-status", async (request, reply) => {
    if (!await authorize(request, reply, "read_server_settings")) return;
    const until = (deps.now ?? (() => new Date()))();
    try {
      return reply.send(memoryAdminStatusSchema.parse(await deps.queryStatus({
        now: until, until, since: new Date(until.getTime() - STENOGRAPHER_STATUS_WINDOW_MS),
      })));
    } catch {
      return reply.code(503).send({ error: "Memory processing status unavailable" });
    }
  });
  app.get("/api/admin/memory-recovery", async (request, reply) => {
    if (!await authorize(request, reply, "read_server_settings")) return;
    try {
      return reply.send({ run: memoryRecoveryRunSchema.nullable().parse(await deps.recovery.latest()) });
    } catch {
      return reply.code(503).send({ error: "Memory recovery status unavailable" });
    }
  });
  app.post("/api/admin/memory-recovery", async (request, reply) => {
    if (!await authorize(request, reply, "manage_server_operations")) return;
    const input = z.object({ requestId: z.string().uuid(), confirmBillableRerun: z.literal(true) }).strict().safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "Recovery request ID and billable rerun confirmation required" });
    try {
      const result = await deps.recovery.request({ requestId: input.data.requestId, authorizedBy: request.sessionUserId!,
        now: (deps.now ?? (() => new Date()))() });
      return reply.code(202).send(memoryRecoveryRunSchema.parse(result));
    } catch {
      return reply.code(503).send({ error: "Recovery request could not be confirmed. Retry with the same request ID." });
    }
  });
  app.post("/api/admin/memory-review-recovery", async (request, reply) => {
    if (!await authorize(request, reply, "manage_server_operations")) return;
    const input = modelRecoveryRequest.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "Exact review coordinates and rerun confirmation required" });
    try {
      const result = await deps.requestModelRecovery({
        workId: input.data.workId, headTurnId: input.data.headTurnId,
        authorizedBy: request.sessionUserId!, now: (deps.now ?? (() => new Date()))(),
      });
      return reply.code(result === "blocked" ? 409 : result === "queued" ? 202 : 200).send({ status: result });
    } catch {
      return reply.code(503).send({ error: "Memory review recovery unavailable" });
    }
  });
  app.post("/api/admin/memory-retry", async (request, reply) => {
    if (!await authorize(request, reply, "manage_server_operations")) return;
    try {
      return reply.send(memoryRetryResponseSchema.parse(await deps.retryFailed()));
    } catch {
      return reply.code(503).send({ error: "Memory retry unavailable; refresh to check current work" });
    }
  });
}
