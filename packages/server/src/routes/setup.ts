import { homedir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { getSharedDirectDb } from "@nautilo/db";
import { fromRuntimeConfig, invalidateRuntimeConfigCache } from "@nautilo/config";
import { getAllKeyDefinitions, isCloudManagedDeployment, transaction } from "@nautilo/config-guard";
import { getRelayRegistry } from "@nautilo/agent";
import {
  canRelayExecuteBrowserResearchRead,
  canRelayExecuteBrowserResearchSearch,
  type RelayCapabilities,
} from "@nautilo/relay";
import { getUserCapabilities } from "@nautilo/trust";
import { warn } from "@nautilo/logger";
import { mintClaimInvite } from "../lib/mint-claim-invite";
import {
  getOwnerClaimProjection,
  installOwnerClaim,
  revokeOwnerClaim,
} from "../lib/owner-claim-control";
import { requestAllowsPrivilegedSetup } from "../lib/request-trust";
import { writeSecurityAuditEvent, type SecurityAuditEvent } from "../lib/security-audit-log";
import { managedProviderCredentialRouteIsBlocked } from "../managed-provider-route-inventory";

function audit(request: FastifyRequest, event: Record<string, unknown>): void {
  try {
    writeSecurityAuditEvent(join(homedir(), ".nautilo", "logs", "security-audit.log"), {
      ...event,
      ts: new Date().toISOString(),
      ip: request.ip,
      userAgent: request.headers["user-agent"],
    } as SecurityAuditEvent);
  } catch (err) {
    warn(`[setup] audit write failed: ${String(err)}`);
  }
}

const SetupKeysBodySchema = z.object({
  keys: z.record(z.string(), z.string()),
  overwrite: z.boolean().optional(),
});

const ResearchProviderBodySchema = z.object({
  provider: z.enum(["auto", "duckduckgo_html"]),
}).strict();

const OwnerClaimInstallBodySchema = z
  .object({ schemaVersion: z.literal(1), claimHash: z.string(), expiresAt: z.string() })
  .strict();

/**
 * D445 Phase 1 — Provider-management or owner capability gates remote browser writes to
 * provider keys. Loopback/bootstrap callers are authorized separately by
 * `requestAllowsPrivilegedSetup`; the two branches are an explicit OR and
 * never require a single bearer to satisfy both meanings.
 */
async function viewerCanManageProviderKeys(userId: string): Promise<boolean> {
  try {
    const caps = await getUserCapabilities(userId);
    return caps.includes("manage_connection_providers") || caps.includes("manage_server_settings");
  } catch {
    return false;
  }
}

/** Web-research routing is safe server operational policy. */
async function viewerHasResearchProviderCapability(
  userId: string,
  capability: "use_research_tools" | "read_server_settings" | "manage_server_operations",
): Promise<boolean> {
  try {
    return (await getUserCapabilities(userId)).includes(capability);
  } catch {
    return false;
  }
}

type ResearchRelayRegistry = {
  findByCapabilityForUser(capability: string, userId: string): string[];
  getCapabilities(relayId: string): RelayCapabilities | null | undefined;
  getProtocolVersion?(relayId: string): number | null | undefined;
};

function researchDesktopDiagnostics(userId: string): {
  desktopReaderAvailable: boolean;
  keylessSearchAvailable: boolean;
} {
  const registry = getRelayRegistry() as ResearchRelayRegistry | null;
  if (!registry) return { desktopReaderAvailable: false, keylessSearchAvailable: false };
  const relayIds = registry.findByCapabilityForUser("canResearchWeb", userId);
  let desktopReaderAvailable = false;
  let keylessSearchAvailable = false;
  for (const relayId of relayIds) {
    const capabilities = registry.getCapabilities(relayId);
    const protocolVersion = registry.getProtocolVersion?.(relayId);
    if (!capabilities || protocolVersion === null || protocolVersion === undefined) continue;
    desktopReaderAvailable ||= canRelayExecuteBrowserResearchRead(protocolVersion, capabilities);
    keylessSearchAvailable ||= canRelayExecuteBrowserResearchSearch(protocolVersion, capabilities);
  }
  return { desktopReaderAvailable, keylessSearchAvailable };
}

export function setupRoutes(app: FastifyInstance) {
  app.get("/api/setup/research-provider", async (request, reply) => {
    const sessionUserId = request.sessionUserId;
    if (!sessionUserId) return reply.code(401).send({ error: "Authentication required" });
    const canRead =
      await viewerHasResearchProviderCapability(sessionUserId, "read_server_settings") ||
      await viewerHasResearchProviderCapability(sessionUserId, "manage_server_operations");
    if (!canRead) return reply.code(403).send({ error: "server settings read required" });
    const configured = fromRuntimeConfig().nautilo_search_provider;
    return reply.send({
      provider: configured === "duckduckgo_html" ? "duckduckgo_html" : "auto",
      ...(!isCloudManagedDeployment()
        ? { tavilyConfigured: Boolean(process.env["TAVILY_API_KEY"]?.trim()) }
        : {}),
    });
  });

  app.get("/api/setup/research-status", async (request, reply) => {
    const sessionUserId = request.sessionUserId;
    if (!sessionUserId) return reply.code(401).send({ error: "Authentication required" });
    if (!(await viewerHasResearchProviderCapability(sessionUserId, "use_research_tools"))) {
      return reply.code(403).send({ error: "research tools required" });
    }
    return reply.send(researchDesktopDiagnostics(sessionUserId));
  });

  app.put("/api/setup/research-provider", async (request, reply) => {
    const sessionUserId = request.sessionUserId;
    if (!sessionUserId) return reply.code(401).send({ error: "Authentication required" });
    if (!(await viewerHasResearchProviderCapability(sessionUserId, "manage_server_operations"))) return reply.code(403).send({ error: "admin only" });
    const parsed = ResearchProviderBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid research provider" });
    const before = fromRuntimeConfig().nautilo_search_provider === "duckduckgo_html"
      ? "duckduckgo_html"
      : "auto";
    const result = await transaction({
      operations: [{ type: "set", key: "NAUTILO_SEARCH_PROVIDER", value: parsed.data.provider }],
      healthCheck: "none",
      overwrite: true,
      reason: "Web research provider changed in Server admin",
      actor: "setup-spa",
    });
    if (!result.success) return reply.code(400).send({ error: result.error ?? "Research provider could not be saved" });
    invalidateRuntimeConfigCache();
    audit(request, {
      kind: "server_research_provider_changed",
      actorId: sessionUserId,
      changes: { provider: { before, after: parsed.data.provider } },
    });
    return reply.send({
      provider: parsed.data.provider,
      ...(!isCloudManagedDeployment()
        ? { tavilyConfigured: Boolean(process.env["TAVILY_API_KEY"]?.trim()) }
        : {}),
    });
  });

  // D488 0B.6A — this public status is deliberately redacted: it reports
  // target readiness only and never a claim capability, hash, expiry, or
  // bootstrap authority. The CLI owns a strict parser for this exact shape.
  app.get("/api/setup/owner-claim/status", async (_request, reply) => {
    const projection = await getOwnerClaimProjection();
    return reply.send({ schemaVersion: 1, state: projection.status });
  });

  app.put("/api/setup/owner-claim", async (request, reply) => {
    if (!requestAllowsPrivilegedSetup(request)) {
      return reply.code(403).send({ schemaVersion: 1, error: "bootstrap_authority_retired_or_invalid" });
    }
    const parsed = OwnerClaimInstallBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ schemaVersion: 1, error: "invalid_owner_claim_request" });
    }
    const result = await installOwnerClaim({
      claimHash: parsed.data.claimHash,
      expiresAt: parsed.data.expiresAt,
    });
    if (!result.ok) {
      return reply
        .code(result.status === "invalid-claim" ? 400 : 409)
        .send({ schemaVersion: 1, error: result.status });
    }
    // The controller holds plaintext only in its OS credential store. Return
    // the same strict, redacted projection consumed by resume/status.
    const projection = await getOwnerClaimProjection();
    return reply.send({ schemaVersion: 1, state: projection.status });
  });

  app.delete("/api/setup/owner-claim", async (request, reply) => {
    if (!requestAllowsPrivilegedSetup(request)) {
      return reply.code(403).send({ schemaVersion: 1, error: "bootstrap_authority_retired_or_invalid" });
    }
    const result = await revokeOwnerClaim({});
    if (!result.ok) return reply.code(409).send({ schemaVersion: 1, error: result.status });
    const projection = await getOwnerClaimProjection();
    return reply.send({ schemaVersion: 1, state: projection.status });
  });

  app.post(
    "/api/setup/keys",
    async (request, reply) => {
      if (managedProviderCredentialRouteIsBlocked("/api/setup/keys")) {
        return reply.code(403).send({ error: "managed_credentials_control_plane_owned" });
      }
      // D445 Phase 1: authorize via EITHER the existing loopback/bootstrap
      // privileged-setup contract OR an authenticated session bearing
      // provider-management or owner capability. Never require both; the browser path
      // never carries a bootstrap token.
      if (!requestAllowsPrivilegedSetup(request)) {
        const sessionUserId = request.sessionUserId;
        if (!sessionUserId) {
          return reply.code(401).send({ error: "Authentication required" });
        }
        if (!(await viewerCanManageProviderKeys(sessionUserId))) {
          return reply.code(403).send({ error: "admin only" });
        }
      }

      const parsed = SetupKeysBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid request body",
          details: parsed.error.flatten(),
        });
      }

      const { keys, overwrite } = parsed.data;
      // This endpoint manages provider keys, never deployment or identity settings.
      const providerKeys = new Set(getAllKeyDefinitions().map((key) => key.envVar));
      if (Object.keys(keys).some((key) => !providerKeys.has(key))) {
        return reply.code(400).send({ error: "Only registered provider API keys can be changed here" });
      }
      const operations = Object.entries(keys).map(([key, value]) => ({
        type: "set" as const,
        key,
        value,
      }));

      const result = await transaction({
        operations,
        healthCheck: "keys",
        overwrite: overwrite ?? false,
        reason: "Keys added via setup wizard",
        actor: "setup-spa",
      });

      if (result.success) {
        return reply.send({
          success: true,
          applied: result.applied,
          skipped: result.skipped,
          snapshot: result.snapshot,
          details: result.details,
        });
      }

      const status = result.rolledBack ? 200 : 400;
      return reply.status(status).send({
        success: false,
        rolledBack: result.rolledBack,
        error: result.error,
        snapshot: result.snapshot,
        details: result.details,
      });
    },
  );

  app.post("/api/setup/mint-claim-invite", async (request, reply) => {
    if (!requestAllowsPrivilegedSetup(request)) {
      return reply.code(403).send({
        error:
          "Configuration changes require loopback origin or valid bootstrap token",
      });
    }

    const db = getSharedDirectDb();
    const instanceRoot = process.env["NAUTILO_INSTANCE_ROOT"]?.trim();
    const result = await mintClaimInvite({
      db,
      ...(instanceRoot && instanceRoot.length > 0
        ? { instanceRootDir: instanceRoot }
        : {}),
    });
    if (result.alreadyExists) {
      return reply.code(409).send({
        error: "claim invite already unredeemed",
        existing: true,
      });
    }
    return reply.send({ token: result.token });
  });
}
