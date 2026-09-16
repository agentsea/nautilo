import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getTaskById } from "@nautilo/db";
import { defaultPostModelDeps, OrdinaryContentAccessRecoveryUnavailableError,
  type OrdinaryContentAccessForState } from "@nautilo/agent";
import { discoverTaskContentAccessRecovery, runTaskContentAccessRecovery, createMaintenanceAcceptanceAuthority, getMaintenanceGate } from "@nautilo/runtime";
import { AgentInvocationDeniedError, createAcceptedInvocationAuthority, toActionCapabilityHttpDenial } from "@nautilo/trust";
import { getServerDirectDb } from "../lib/server-direct-db";
import { currentStrictShadowPolicy } from "../lib/strict-shadow-policy";
import { isMaintenanceDrainError, replyMaintenanceRejection } from "../lib/maintenance-rejection";

const coordinate = z.object({ taskId: z.uuid(), taskRunId: z.uuid(), checkpointId: z.string().min(1),
  toolCallId: z.string().min(1) }).strict();

export interface TaskContentAccessRecoveryRouteDeps {
  ordinaryContentAccessForState: OrdinaryContentAccessForState;
  task?: (taskId: string) => ReturnType<typeof getTaskById>;
  discover?: typeof discoverTaskContentAccessRecovery;
  run?: typeof runTaskContentAccessRecovery;
  policy?: typeof currentStrictShadowPolicy;
}

/** Owner-only Task continuation. The client never chooses a graph address. */
export function taskContentAccessRecoveryRoutes(app: FastifyInstance, deps: TaskContentAccessRecoveryRouteDeps): void {
  for (const method of ["GET", "POST"] as const) app.route<{ Params: { id: string }; Body: unknown }>({
    method, url: "/api/tasks/:id/content-access-recovery",
    async handler(request, reply) {
      reply.header("Cache-Control", "no-store");
      const userId = request.sessionUserId;
      if (!userId || !request.sessionActorId || request.policyContext?.actorRole === "guest") return reply.code(401).send({ error: "Authentication required" });
      if (!z.uuid().safeParse(request.params.id).success) return reply.code(400).send({ error: "Invalid Task" });
      if (!z.object({}).strict().safeParse(request.query).success) return reply.code(400).send({ error: "Unexpected query coordinates" });
      const parsed = method === "POST" ? coordinate.safeParse(request.body) : null;
      if (parsed && (!parsed.success || parsed.data.taskId !== request.params.id)) return reply.code(400).send({ error: "Invalid recovery coordinate" });
      try {
        const task = await (deps.task ?? ((id) => getTaskById(getServerDirectDb(), id)))(request.params.id);
        if (!task || task.ownerId !== userId) return reply.code(404).send({ error: "Task not found" });
        if ((await (deps.policy ?? currentStrictShadowPolicy)()).mode !== "plaintext_only") return reply.send(method === "GET" ? { recovery: null } : { outcome: "unavailable" });
        const graph = { ...defaultPostModelDeps, ordinaryContentAccessForState: async (...args: Parameters<OrdinaryContentAccessForState>) => {
          const selected = await deps.ordinaryContentAccessForState(...args);
          if (selected.mode !== "plaintext_only") throw new OrdinaryContentAccessRecoveryUnavailableError();
          return selected;
        } };
        if (method === "GET") return reply.send({ recovery: await (deps.discover ?? discoverTaskContentAccessRecovery)(task.id, userId, { graph }) });
        if (!parsed?.success) return reply.code(400).send({ error: "Invalid recovery coordinate" });
        // Mint continuation authority only after the existing ingress gate.
        await getMaintenanceGate().assertAcceptingNewWork();
        const outcome = await (deps.run ?? runTaskContentAccessRecovery)(parsed.data, userId, {
          invocation: createAcceptedInvocationAuthority(task.requestorId), maintenance: createMaintenanceAcceptanceAuthority(),
        }, { graph });
        return reply.send({ outcome });
      } catch (error) {
        if (error instanceof AgentInvocationDeniedError) return reply.code(403).send(toActionCapabilityHttpDenial(error));
        if (error instanceof OrdinaryContentAccessRecoveryUnavailableError) return reply.send(method === "GET" ? { recovery: null } : { outcome: "unavailable" });
        if (isMaintenanceDrainError(error)) return replyMaintenanceRejection(reply, error);
        return reply.code(503).send({ error: "content_access_recovery_unavailable" });
      }
    },
  });
}
