import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { resolveNautiloRootDir } from "@nautilo/config";
import {
  getServerProviderPolicy,
  upsertServerProviderPolicy,
  type ServerProviderPolicyUpdate,
} from "@nautilo/db";
import { warn } from "@nautilo/logger";
import { getUserCapabilities } from "@nautilo/trust";
import { writeSecurityAuditEvent, type SecurityAuditEvent } from "../lib/security-audit-log";
import { getServerDirectDb } from "../lib/server-direct-db";

const STORAGE_UNAVAILABLE_RESPONSE = { error: "server_provider_policy_unavailable" } as const;

async function currentCapabilities(
  userId: string,
  getCapabilities: typeof getUserCapabilities,
): Promise<readonly string[]> {
  try {
    return await getCapabilities(userId);
  } catch {
    return [];
  }
}

function audit(request: FastifyRequest, event: Record<string, unknown>): void {
  try {
    writeSecurityAuditEvent(join(resolveNautiloRootDir(), "logs", "security-audit.log"), {
      ...event,
      ts: new Date().toISOString(),
      ip: request.ip,
      userAgent: request.headers["user-agent"],
    } as SecurityAuditEvent);
  } catch (error) {
    warn(`[server-provider-policy] audit write failed: ${String(error)}`);
  }
}

type ParseResult =
  | { ok: true; patch: ServerProviderPolicyUpdate }
  | { ok: false; error: string };

function parseUpdateBody(body: unknown): ParseResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "invalid body" };
  }
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  const knownKeys = new Set(["allowPersonalProviderKeys", "fundingPreference"]);
  if (keys.length === 0 || keys.some((key) => !knownKeys.has(key))) {
    return {
      ok: false,
      error: "only allowPersonalProviderKeys and fundingPreference are writable",
    };
  }
  if (
    "allowPersonalProviderKeys" in record
    && typeof record["allowPersonalProviderKeys"] !== "boolean"
  ) {
    return { ok: false, error: "allowPersonalProviderKeys must be a boolean" };
  }
  if (
    "fundingPreference" in record
    && record["fundingPreference"] !== "personal_first"
    && record["fundingPreference"] !== "server_first"
  ) {
    return {
      ok: false,
      error: "fundingPreference must be personal_first or server_first",
    };
  }
  const patch: ServerProviderPolicyUpdate = {};
  if (typeof record["allowPersonalProviderKeys"] === "boolean") {
    patch.allowPersonalProviderKeys = record["allowPersonalProviderKeys"];
  }
  if (
    record["fundingPreference"] === "personal_first"
    || record["fundingPreference"] === "server_first"
  ) {
    patch.fundingPreference = record["fundingPreference"];
  }
  return { ok: true, patch };
}

/** @internal Exported for deterministic unit coverage. */
export function parseServerProviderPolicyUpdateBodyForTests(body: unknown): ParseResult {
  return parseUpdateBody(body);
}

export interface ServerProviderPolicyRouteDeps {
  getCapabilities?: typeof getUserCapabilities;
  getPolicy?: typeof getServerProviderPolicy;
  upsertPolicy?: typeof upsertServerProviderPolicy;
  getDb?: typeof getServerDirectDb;
  auditEvent?: typeof audit;
}

export function serverProviderPolicyRoutes(
  app: FastifyInstance,
  overrides: ServerProviderPolicyRouteDeps = {},
): void {
  const getCapabilities = overrides.getCapabilities ?? getUserCapabilities;
  const getPolicy = overrides.getPolicy ?? getServerProviderPolicy;
  const upsertPolicy = overrides.upsertPolicy ?? upsertServerProviderPolicy;
  const getDb = overrides.getDb ?? getServerDirectDb;
  const auditEvent = overrides.auditEvent ?? audit;

  app.get("/api/admin/server-provider-policy", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) return reply.code(401).send({ error: "Authentication required" });
    const capabilities = await currentCapabilities(userId, getCapabilities);
    if (
      !capabilities.includes("read_server_settings")
      && !capabilities.includes("manage_server_settings")
    ) {
      return reply.code(403).send({ error: "admin only" });
    }
    try {
      return reply.send(await getPolicy(getDb()));
    } catch {
      return reply.code(503).send(STORAGE_UNAVAILABLE_RESPONSE);
    }
  });

  app.post("/api/admin/server-provider-policy", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) return reply.code(401).send({ error: "Authentication required" });
    const capabilities = await currentCapabilities(userId, getCapabilities);
    if (!capabilities.includes("manage_server_settings")) {
      return reply.code(403).send({ error: "admin only" });
    }
    const parsed = parseUpdateBody(request.body);
    if (!parsed.ok) return reply.code(422).send({ error: parsed.error });

    const persisted = await (async () => {
      try {
        return await upsertPolicy(getDb(), parsed.patch);
      } catch {
        warn("[server-provider-policy] policy storage unavailable");
        return null;
      }
    })();
    if (persisted === null) {
      return reply.code(503).send(STORAGE_UNAVAILABLE_RESPONSE);
    }
    try {
      auditEvent(request, {
        kind: "server_provider_policy_changed",
        actorId: userId,
        previous: persisted.previous.allowPersonalProviderKeys,
        effective: persisted.effective.allowPersonalProviderKeys,
        previousFundingPreference: persisted.previous.fundingPreference,
        effectiveFundingPreference: persisted.effective.fundingPreference,
      });
    } catch (error) {
      warn(`[server-provider-policy] audit write failed: ${String(error)}`);
    }
    return reply.send(persisted.effective);
  });
}
