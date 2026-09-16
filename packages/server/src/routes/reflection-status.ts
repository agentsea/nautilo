import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  reflectionAdminStatusSchema,
  type ReflectionAdminStatus,
  type ReflectionProtectedAuthorityStatus,
} from "@nautilo/types";
import { getUserCapabilities } from "@nautilo/trust";
import { error as logError } from "@nautilo/logger";

export const REFLECTION_STATUS_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ReflectionStatusQueryInput {
  now: Date;
  since: Date;
  until: Date;
}

export type QueryReflectionStatus = (
  input: ReflectionStatusQueryInput,
) => Promise<ReflectionAdminStatus>;

export interface ReflectionStatusRoutesDeps {
  queryStatus: QueryReflectionStatus;
  queryAuthorityStatus?: (
    input: ReflectionStatusQueryInput,
  ) => Promise<ReflectionProtectedAuthorityStatus>;
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

/** Content-free Reflection/Sleep diagnostics for server operators. */
export function reflectionStatusRoutes(
  app: FastifyInstance,
  deps: ReflectionStatusRoutesDeps,
): void {
  const hasCapability = deps.hasCapability ?? (async (userId: string) => {
    try {
      return (await getUserCapabilities(userId)).includes("read_server_settings");
    } catch {
      return false;
    }
  });
  const now = deps.now ?? (() => new Date());

  app.get("/api/admin/reflection-status", async (request, reply) => {
    if (!(await requireServerSettingsRead(request, reply, hasCapability))) return;
    const until = now();
    const since = new Date(until.getTime() - REFLECTION_STATUS_WINDOW_MS);
    let status: ReflectionAdminStatus;
    try {
      const input = { now: until, since, until };
      const [ordinaryStatus, protectedAuthority] = await Promise.all([
        deps.queryStatus(input),
        deps.queryAuthorityStatus?.(input),
      ]);
      status = protectedAuthority === undefined
        ? ordinaryStatus
        : { ...ordinaryStatus, protectedAuthority };
    } catch (error) {
      logError("[reflection-status] query failed", {
        failureCode: "reflection_status_query_failed",
        errorCode: typeof error === "object" && error !== null && "code" in error
          && typeof error.code === "string"
          ? error.code
          : null,
      });
      return reply.code(500).send({ error: "Reflection status unavailable" });
    }

    const parsed = reflectionAdminStatusSchema.safeParse(status);
    if (!parsed.success) {
      logError("[reflection-status] projection invalid", {
        failureCode: "reflection_status_projection_invalid",
        issues: parsed.error.issues.map((issue) => ({
          code: issue.code,
          path: issue.path.join("."),
        })),
      });
      return reply.code(500).send({ error: "Reflection status unavailable" });
    }
    return reply.send(parsed.data);
  });
}
