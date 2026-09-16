import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  stenographerAdminStatusSchema,
  type StenographerAdminStatus,
  stenographerProtectionStatusSchema,
  type StenographerProtectionStatus,
} from "@nautilo/types";
import { getUserCapabilities } from "@nautilo/trust";

export const STENOGRAPHER_STATUS_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface StenographerStatusQueryInput {
  now: Date;
  since: Date;
  until: Date;
}

/**
 * Repository adapter consumed by the route. The DB implementation belongs in
 * `@nautilo/db`; keeping this function injected makes route/auth tests
 * hermetic and prevents the HTTP layer from growing per-Room query logic.
 */
export type QueryStenographerStatus = (
  input: StenographerStatusQueryInput,
) => Promise<StenographerAdminStatus>;

export type QueryStenographerProtectionStatus = (
  input: StenographerStatusQueryInput,
) => Promise<StenographerProtectionStatus>;

export interface StenographerStatusRoutesDeps {
  queryStatus: QueryStenographerStatus;
  queryProtectionStatus?: QueryStenographerProtectionStatus | undefined;
  hasCapability?: ((userId: string) => Promise<boolean>) | undefined;
  now?: (() => Date) | undefined;
}

async function requireServerSettingsRead(
  request: FastifyRequest,
  reply: FastifyReply,
  hasCapability: (userId: string) => Promise<boolean>,
): Promise<boolean> {
  const userId = request.sessionUserId;
  if (!userId) {
    reply.code(401).send({ error: "Authentication required" });
    return false;
  }

  if (!(await hasCapability(userId))) {
    reply.code(403).send({ error: "read_server_settings capability required" });
    return false;
  }

  return true;
}

/**
 * Registers the content-free M219 operational status endpoint.
 *
 * There is deliberately no fake/default query implementation. Production
 * registration must inject the set-based `@nautilo/db` repository adapter.
 */
export function stenographerStatusRoutes(
  app: FastifyInstance,
  deps: StenographerStatusRoutesDeps,
): void {
  const hasCapability =
    deps.hasCapability ??
    (async (userId: string) => {
      try {
        return (await getUserCapabilities(userId)).includes("read_server_settings");
      } catch {
        return false;
      }
    });
  const now = deps.now ?? (() => new Date());

  app.get("/api/admin/stenographer-status", async (request, reply) => {
    if (!(await requireServerSettingsRead(request, reply, hasCapability))) return;

    const until = now();
    const since = new Date(until.getTime() - STENOGRAPHER_STATUS_WINDOW_MS);

    try {
      const status = await deps.queryStatus({ now: until, since, until });
      return reply.send(stenographerAdminStatusSchema.parse(status));
    } catch {
      return reply.code(500).send({ error: "Stenographer status unavailable" });
    }
  });

  app.get("/api/admin/stenographer-status/protection", async (request, reply) => {
    if (!(await requireServerSettingsRead(request, reply, hasCapability))) return;
    if (deps.queryProtectionStatus === undefined) {
      return reply.code(503).send({
        error: "Stenographer protection status unavailable",
      });
    }

    const until = now();
    const since = new Date(until.getTime() - STENOGRAPHER_STATUS_WINDOW_MS);

    try {
      const status = await deps.queryProtectionStatus({ now: until, since, until });
      return reply.send(stenographerProtectionStatusSchema.parse(status));
    } catch {
      return reply.code(500).send({
        error: "Stenographer protection status unavailable",
      });
    }
  });
}
