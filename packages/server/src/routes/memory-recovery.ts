import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { getUserCapabilities } from "@nautilo/trust";
import {
  memoryRecoveryPreviewSchema,
  memoryRecoveryRequestSchema,
  memoryRecoveryResultSchema,
  type MemoryRecoveryPreview,
  type MemoryRecoveryRequest,
  type MemoryRecoveryResult,
} from "@nautilo/types";

interface MemoryRecoveryRoutesDeps {
  preview(roomId: string): Promise<MemoryRecoveryPreview | null>;
  run(input: MemoryRecoveryRequest, authorizedBy: string): Promise<MemoryRecoveryResult>;
  getCapabilities?: typeof getUserCapabilities;
}

const params = z.object({ roomId: z.string().uuid() }).strict();

export function memoryRecoveryRoutes(app: FastifyInstance, deps: MemoryRecoveryRoutesDeps): void {
  const capabilities = deps.getCapabilities ?? getUserCapabilities;
  async function authorize(
    request: FastifyRequest,
    reply: FastifyReply,
    capability: "read_server_settings" | "manage_server_operations",
  ): Promise<string | null> {
    const userId = request.sessionUserId;
    if (!userId) {
      reply.code(401).send({ error: "Authentication required" });
      return null;
    }
    const allowed = await capabilities(userId).then(
      (effective) => effective.includes(capability),
      () => false,
    );
    if (!allowed) {
      reply.code(403).send({ error: `${capability} capability required` });
      return null;
    }
    return userId;
  }

  app.get("/api/admin/memory-recovery/:roomId", async (request, reply) => {
    if (!(await authorize(request, reply, "read_server_settings"))) return;
    const input = params.safeParse(request.params);
    if (!input.success) return reply.code(400).send({ error: "A valid Room ID is required" });
    try {
      const preview = await deps.preview(input.data.roomId);
      if (!preview) return reply.code(404).send({ error: "Room not found" });
      return reply.send(memoryRecoveryPreviewSchema.parse(preview));
    } catch {
      return reply.code(503).send({ error: "Room recovery preview unavailable" });
    }
  });

  app.post("/api/admin/memory-recovery", async (request, reply) => {
    const userId = await authorize(request, reply, "manage_server_operations");
    if (!userId) return;
    const input = memoryRecoveryRequestSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "Exact recovery coordinates are required" });
    try {
      const result = memoryRecoveryResultSchema.parse(await deps.run(input.data, userId));
      return reply.code(result.status === "queued" ? 202 : 200).send(result);
    } catch {
      return reply.code(503).send({ error: "Room recovery unavailable. Refresh the preview before retrying." });
    }
  });
}
