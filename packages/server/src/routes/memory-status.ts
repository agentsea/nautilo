import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { memoryAdminStatusSchema, memoryRetryResponseSchema, type MemoryAdminStatus } from "@nautilo/types";
import { getUserCapabilities } from "@nautilo/trust";
import { STENOGRAPHER_STATUS_WINDOW_MS } from "./stenographer-status";

export interface MemoryStatusRoutesDeps {
  queryStatus(input: { now: Date; since: Date; until: Date }): Promise<MemoryAdminStatus>;
  /** The repository atomically marks only safely retryable failed work due. */
  retryFailed(): Promise<{ requested: number }>;
  getCapabilities?: typeof getUserCapabilities;
  now?: () => Date;
}

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
  app.post("/api/admin/memory-retry", async (request, reply) => {
    if (!await authorize(request, reply, "manage_server_operations")) return;
    try {
      return reply.send(memoryRetryResponseSchema.parse(await deps.retryFailed()));
    } catch {
      return reply.code(503).send({ error: "Memory retry unavailable; refresh to check current work" });
    }
  });
}
