import { homedir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  getServerContextConfig,
  isMaxRoomContextPercent,
  isMinimumFullTurns,
  isRecentConversationLimit,
  isStenographerPriorConversationLimit,
  MAX_ROOM_CONTEXT_PERCENT_MAX,
  MAX_ROOM_CONTEXT_PERCENT_MIN,
  MINIMUM_FULL_TURNS_MAX,
  MINIMUM_FULL_TURNS_MIN,
  RECENT_CONVERSATION_LIMIT_MAX,
  RECENT_CONVERSATION_LIMIT_MIN,
  STENOGRAPHER_PRIOR_CONVERSATION_LIMIT_MAX,
  STENOGRAPHER_PRIOR_CONVERSATION_LIMIT_MIN,
  upsertServerContextConfig,
  type ServerContextConfigPatch,
} from "@nautilo/db";
import { warn } from "@nautilo/logger";
import { getUserCapabilities } from "@nautilo/trust";
import { writeSecurityAuditEvent, type SecurityAuditEvent } from "../lib/security-audit-log";
import { getServerDirectDb } from "../lib/server-direct-db";

async function viewerHasCapability(
  userId: string,
  capability: "read_server_settings" | "manage_server_operations",
  getCapabilities: typeof getUserCapabilities,
): Promise<boolean> {
  try {
    return (await getCapabilities(userId)).includes(capability);
  } catch {
    return false;
  }
}

function audit(request: FastifyRequest, event: Record<string, unknown>): void {
  try {
    writeSecurityAuditEvent(join(homedir(), ".nautilo", "logs", "security-audit.log"), {
      ...event,
      ts: new Date().toISOString(),
      ip: request.ip,
      userAgent: request.headers["user-agent"],
    } as SecurityAuditEvent);
  } catch (err) {
    warn(`[server-context] audit write failed: ${String(err)}`);
  }
}

type ParseResult =
  | { ok: true; patch: ServerContextConfigPatch }
  | { ok: false; error: string };

function parseUpdateBody(body: unknown): ParseResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "invalid body" };
  }
  const record = body as Record<string, unknown>;
  const patch: ServerContextConfigPatch = {};
  if ("recentConversationLimit" in record) {
    const value = record["recentConversationLimit"];
    if (typeof value !== "number" || !isRecentConversationLimit(value)) {
      return {
        ok: false,
        error:
          `recentConversationLimit must be an integer between ` +
          `${RECENT_CONVERSATION_LIMIT_MIN} and ${RECENT_CONVERSATION_LIMIT_MAX}`,
      };
    }
    patch.recentConversationLimit = value;
  }
  if ("minimumFullTurns" in record) {
    const value = record["minimumFullTurns"];
    if (typeof value !== "number" || !isMinimumFullTurns(value)) {
      return {
        ok: false,
        error:
          `minimumFullTurns must be an integer between ` +
          `${MINIMUM_FULL_TURNS_MIN} and ${MINIMUM_FULL_TURNS_MAX}`,
      };
    }
    patch.minimumFullTurns = value;
  }
  if ("maxRoomContextPercent" in record) {
    const value = record["maxRoomContextPercent"];
    if (typeof value !== "number" || !isMaxRoomContextPercent(value)) {
      return {
        ok: false,
        error:
          `maxRoomContextPercent must be an integer between ` +
          `${MAX_ROOM_CONTEXT_PERCENT_MIN} and ${MAX_ROOM_CONTEXT_PERCENT_MAX}`,
      };
    }
    patch.maxRoomContextPercent = value;
  }
  if ("stenographerPriorConversationLimit" in record) {
    const value = record["stenographerPriorConversationLimit"];
    if (typeof value !== "number" || !isStenographerPriorConversationLimit(value)) {
      return {
        ok: false,
        error:
          `stenographerPriorConversationLimit must be an integer between ` +
          `${STENOGRAPHER_PRIOR_CONVERSATION_LIMIT_MIN} and ` +
          `${STENOGRAPHER_PRIOR_CONVERSATION_LIMIT_MAX}`,
      };
    }
    patch.stenographerPriorConversationLimit = value;
  }
  if ("passiveRecallEnabled" in record) {
    const value = record["passiveRecallEnabled"];
    if (typeof value !== "boolean") {
      return {
        ok: false,
        error: "passiveRecallEnabled must be a boolean",
      };
    }
    patch.passiveRecallEnabled = value;
  }
  if ("reflectionSleepEnabled" in record) {
    const value = record["reflectionSleepEnabled"];
    if (typeof value !== "boolean") {
      return {
        ok: false,
        error: "reflectionSleepEnabled must be a boolean",
      };
    }
    patch.reflectionSleepEnabled = value;
  }
  if ("memoryReviewEnabled" in record) {
    const value = record["memoryReviewEnabled"];
    if (value !== null && typeof value !== "boolean") {
      return { ok: false, error: "memoryReviewEnabled must be a boolean or null" };
    }
    patch.memoryReviewEnabled = value;
  }
  if (Object.keys(patch).length === 0) {
    return {
      ok: false,
      error: "at least one server context setting is required",
    };
  }
  return { ok: true, patch };
}

/** @internal Exported for deterministic unit coverage. */
export function parseServerContextUpdateBodyForTests(body: unknown): ParseResult {
  return parseUpdateBody(body);
}

export interface ServerContextRouteDeps {
  getCapabilities?: typeof getUserCapabilities;
  getConfig?: typeof getServerContextConfig;
  upsertConfig?: typeof upsertServerContextConfig;
  getDb?: typeof getServerDirectDb;
  auditEvent?: typeof audit;
  onConfigUpdated?(config: Awaited<ReturnType<typeof getServerContextConfig>>):
    Promise<void> | void;
}

export function serverContextRoutes(
  app: FastifyInstance,
  overrides: ServerContextRouteDeps = {},
): void {
  const getCapabilities = overrides.getCapabilities ?? getUserCapabilities;
  const getConfig = overrides.getConfig ?? getServerContextConfig;
  const upsertConfig = overrides.upsertConfig ?? upsertServerContextConfig;
  const getDb = overrides.getDb ?? getServerDirectDb;
  const auditEvent = overrides.auditEvent ?? audit;

  app.get("/api/admin/server-context", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) return reply.code(401).send({ error: "Authentication required" });
    if (!(await viewerHasCapability(userId, "read_server_settings", getCapabilities))) {
      return reply.code(403).send({ error: "admin only" });
    }
    return reply.send(await getConfig(getDb()));
  });

  app.post("/api/admin/server-context", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) return reply.code(401).send({ error: "Authentication required" });
    if (!(await viewerHasCapability(userId, "manage_server_operations", getCapabilities))) {
      return reply.code(403).send({ error: "admin only" });
    }
    const parsed = parseUpdateBody(request.body);
    if (!parsed.ok) return reply.code(422).send({ error: parsed.error });

    const db = getDb();
    const before = await getConfig(db);
    const after = await upsertConfig(db, parsed.patch);
    auditEvent(request, {
      kind: "server_context_config_changed",
      actorId: userId,
      before,
      after,
    });
    try {
      await overrides.onConfigUpdated?.(after);
    } catch {
      // Persistence is canonical. A transient runtime reconciliation failure
      // must not turn a completed policy mutation into an ambiguous API error.
      warn("[server-context] live config reconciliation failed", {
        failureCode: "runtime_reconciliation_failed",
      });
    }
    return reply.send(after);
  });
}
