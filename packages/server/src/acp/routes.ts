import type { FastifyInstance } from "fastify";
import {
  classifyHermesAcpReadiness,
  classifyOpenCodeAcpReadiness,
} from "@nautilo/acp-host";
import {
  HERMES_ACP_HARNESS_DESCRIPTOR,
  OPENCODE_ACP_HARNESS_DESCRIPTOR,
} from "./harness-registration";
import { HermesAcpRelayReadinessResolver, OpenCodeAcpRelayReadinessResolver, type AcpReadinessRelayPort } from "./readiness-control-plane";

type AuthenticatedRequest = {
  readonly sessionUserId: string | null;
  readonly policyContext?: { readonly actorRole?: string } | null;
};

export interface AcpReadinessRouteDeps {
  readonly relay: AcpReadinessRelayPort;
  /** Server-owned lookup; the browser cannot name an unpaired host. */
  readonly resolveHost: (
    userId: string,
    requestedRelayId?: string,
  ) => Promise<{ readonly relayId: string } | null>;
}

/**
 * Readiness-only product surface. Listing is static data and does not contact
 * Electron. An explicit owner-scoped readiness request selects exactly one
 * currently paired ACP relay and returns only the fixed public enum/action.
 */
export function acpReadinessRoutes(app: FastifyInstance, deps: AcpReadinessRouteDeps): void {
  app.get("/api/acp/harnesses", async (request, reply) => {
    const context = request as typeof request & AuthenticatedRequest;
    if (!authorized(context)) return reply.code(context.sessionUserId ? 403 : 401).send({ error: "Authentication required" });
    return reply.send({ harnesses: [HERMES_ACP_HARNESS_DESCRIPTOR, OPENCODE_ACP_HARNESS_DESCRIPTOR] });
  });

  app.post<{ Params: { harnessId: string }; Body: unknown }>(
    "/api/acp/harnesses/:harnessId/readiness",
    async (request, reply) => {
      const context = request as typeof request & AuthenticatedRequest;
      if (!authorized(context)) return reply.code(context.sessionUserId ? 403 : 401).send({ error: "Authentication required" });
      if (request.params.harnessId !== "hermes-acp" && request.params.harnessId !== "opencode-acp") {
        return reply.code(404).send({ code: "ACP_HARNESS_UNAVAILABLE" });
      }
      const requestedRelayId = requestedRelay(request.body);
      if (requestedRelayId === null) return reply.code(400).send({ code: "ACP_REQUEST_INVALID" });
      const target = await deps.resolveHost(context.sessionUserId!, requestedRelayId ?? undefined);
      if (target === null) return reply.code(404).send({ code: "ACP_HARNESS_UNAVAILABLE" });
      try {
        const targetScope = {
          relayId: target.relayId,
          userId: context.sessionUserId!,
        };
        if (request.params.harnessId === "opencode-acp") {
          return reply.send(classifyOpenCodeAcpReadiness(
            await new OpenCodeAcpRelayReadinessResolver(deps.relay, targetScope).inspect(),
          ));
        }
        return reply.send(classifyHermesAcpReadiness(
          await new HermesAcpRelayReadinessResolver(deps.relay, targetScope).inspect(),
        ));
      } catch {
        // Relay lifecycle errors stay a fixed safe state, not a host detail.
        return reply.send({
          state: "unavailable",
          action: `${request.params.harnessId === "opencode-acp" ? "OpenCode" : "Hermes"} is unavailable on this paired desktop. Verify its native local setup, then retry.`,
        });
      }
    },
  );
}

function authorized(context: AuthenticatedRequest): boolean {
  return context.sessionUserId !== null && context.policyContext?.actorRole !== "guest";
}

function requestedRelay(body: unknown): string | undefined | null {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== "object" || Array.isArray(body)) return null;
  const entries = Object.entries(body as Record<string, unknown>);
  if (entries.length === 0) return undefined;
  if (entries.length !== 1 || entries[0]![0] !== "relayId") return null;
  const value = entries[0]![1];
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !value.includes("\0")
    ? value
    : null;
}
