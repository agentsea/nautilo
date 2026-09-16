import type { FastifyInstance, FastifyReply } from "fastify";
import {
  claudeConnectionCheckSchema,
  claudeConnectionSelectModelSchema,
  claudeConnectionToggleSchema,
} from "@nautilo/types";
import type { ClaudeConnectionController } from "../claude/connection-controller";

export interface ClaudeConnectionsRouteDeps { readonly controller: ClaudeConnectionController; }

type AuthenticatedRequest = {
  readonly sessionUserId: string | null;
  readonly policyContext?: { readonly actorRole?: string } | null;
  readonly headers: Readonly<Record<string, unknown>>;
};

function owner(request: AuthenticatedRequest, reply: FastifyReply): string | null {
  if (!request.sessionUserId) { reply.code(401).send({ error: "Authentication required" }); return null; }
  if (request.policyContext?.actorRole === "guest") { reply.code(403).send({ error: "Forbidden" }); return null; }
  return request.sessionUserId;
}
function relayHint(request: AuthenticatedRequest, reply: FastifyReply): string | null | undefined {
  const value = request.headers["x-nautilo-claude-relay-id"];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    reply.code(400).send({ error: "Invalid Claude Desktop identity" });
    return null;
  }
  return value;
}

/** Signed-in non-guest, user-scoped HTTP facade; browser payloads contain only semantic preferences. */
export function claudeConnectionsRoutes(app: FastifyInstance, deps: ClaudeConnectionsRouteDeps): void {
  app.get("/api/claude-connections", async (request, reply) => {
    const userId = owner(request as AuthenticatedRequest, reply); if (!userId) return;
    const hint = relayHint(request as AuthenticatedRequest, reply); if (hint === null) return;
    return deps.controller.summary(userId, hint);
  });
  app.post("/api/claude-connections/toggle", async (request, reply) => {
    const userId = owner(request as AuthenticatedRequest, reply); if (!userId) return;
    const hint = relayHint(request as AuthenticatedRequest, reply); if (hint === null) return;
    const parsed = claudeConnectionToggleSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid Claude connection request" });
    return deps.controller.setEnabled(userId, parsed.data.enabled, hint);
  });
  app.post("/api/claude-connections/check", async (request, reply) => {
    const userId = owner(request as AuthenticatedRequest, reply); if (!userId) return;
    const hint = relayHint(request as AuthenticatedRequest, reply); if (hint === null) return;
    const parsed = claudeConnectionCheckSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid Claude connection request" });
    return deps.controller.checkAgain(userId, hint);
  });
  app.post("/api/claude-connections/model", async (request, reply) => {
    const userId = owner(request as AuthenticatedRequest, reply); if (!userId) return;
    const hint = relayHint(request as AuthenticatedRequest, reply); if (hint === null) return;
    const parsed = claudeConnectionSelectModelSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid Claude model selection" });
    const summary = await deps.controller.selectModel(userId, parsed.data.modelId, hint);
    return summary ?? reply.code(409).send({ code: "CLAUDE_CONNECTION_CATALOG_STALE" });
  });
}
