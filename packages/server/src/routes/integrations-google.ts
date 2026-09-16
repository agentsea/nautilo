import type { FastifyInstance } from "fastify";
import { resolveInstance } from "@nautilo/config";
import { getUserCapabilities } from "@nautilo/trust";
import {
  defaultGoogleOAuthClientStoreDeps,
  validateGoogleOAuthClientJson,
  type GoogleOAuthClientStoreDeps,
} from "../lib/google-oauth-client-store";
import { replyForConfigGuardError } from "../lib/config-guard-http";
import { ConfigGuardError } from "@nautilo/config-guard";
import { warn } from "@nautilo/logger";
import {
  type SecurityAuditEvent,
} from "../lib/security-audit-log";

const OAUTH_CLIENT_UPLOAD_MAX_BYTES = 256 * 1024;

export interface IntegrationsGoogleRouteDeps extends Partial<GoogleOAuthClientStoreDeps> {
  getCapabilities?: typeof getUserCapabilities;
  auditEvent?: (event: SecurityAuditEvent) => Promise<void> | void;
  isManagedDeployment?: () => boolean;
}

function isManagedDeploymentFromInstance(): boolean {
  return resolveInstance().deploymentMode === "cloud-managed";
}

async function audit(
  request: { sessionActorId?: string | null; ip: string; headers: Record<string, unknown> },
  userId: string,
  event: { action: "configure" | "remove"; clientId: string | null },
  write: NonNullable<IntegrationsGoogleRouteDeps["auditEvent"]>,
): Promise<void> {
  try {
    await write({
      kind: "google_oauth_client_config",
      ts: new Date().toISOString(),
      actorId: request.sessionActorId ?? userId,
      ip: request.ip,
      userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : undefined,
      outcome: "ok",
      ...event,
    });
  } catch (error) {
    warn(`[integrations-google] audit write failed: ${error instanceof Error ? error.name : "unknown"}`);
  }
}

function isMultipartTooLarge(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const o = err as { statusCode?: number; code?: string };
  return o.statusCode === 413 || o.code === "FST_REQ_FILE_TOO_LARGE";
}

async function viewerHasCapability(
  userId: string,
  capability: string,
  getCapabilities: typeof getUserCapabilities,
): Promise<boolean> {
  try {
    const caps = await getCapabilities(userId);
    return caps.includes(capability);
  } catch {
    return false;
  }
}

function resolveDeps(deps?: IntegrationsGoogleRouteDeps): GoogleOAuthClientStoreDeps & IntegrationsGoogleRouteDeps {
  return { ...defaultGoogleOAuthClientStoreDeps, ...deps };
}

export function integrationsGoogleRoutes(
  app: FastifyInstance,
  deps: IntegrationsGoogleRouteDeps = defaultGoogleOAuthClientStoreDeps,
): void {
  const resolved = resolveDeps(deps);
  const getCapabilities = resolved.getCapabilities ?? getUserCapabilities;
  const auditEvent = resolved.auditEvent ?? (() => {});
  const isManagedDeployment =
    resolved.isManagedDeployment ?? isManagedDeploymentFromInstance;

  app.get("/api/integrations/google/status", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) {
      return reply.code(401).send({ error: "Authentication required" });
    }

    const status = resolved.googleOAuthClientStatus();
    const managed = isManagedDeployment();
    const canManageProviderSetup =
      !managed &&
      (await viewerHasCapability(
        userId,
        "manage_connection_providers",
        getCapabilities,
      ));
    return reply.send({
      configured: status.configured,
      providerSetupStatus: managed
        ? "managed"
        : status.configured
          ? "ready"
          : "setup_required",
      canManageProviderSetup,
      ...(canManageProviderSetup && status.clientId
        ? { clientId: status.clientId }
        : {}),
    });
  });

  app.get("/api/integrations/google/oauth-client", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) {
      return reply.code(401).send({ error: "Authentication required" });
    }

    if (!(await viewerHasCapability(userId, "use_google_workspace", getCapabilities))) {
      return reply.code(403).send({
        error: "capability_missing",
        capability: "use_google_workspace",
      });
    }

    const json = resolved.getGoogleOAuthClient();
    if (!json) {
      return reply.code(404).send({ error: "not_configured" });
    }

    return reply.header("Content-Type", "application/json; charset=utf-8").send(Buffer.from(json, "utf8"));
  });

  app.post("/api/integrations/google/oauth-client", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) {
      return reply.code(401).send({ error: "Authentication required" });
    }

    if (isManagedDeployment()) {
      return reply.code(403).send({ error: "managed_by_cloud" });
    }

    if (!(await viewerHasCapability(userId, "manage_connection_providers", getCapabilities))) {
      return reply.code(403).send({
        error: "capability_missing",
        capability: "manage_connection_providers",
      });
    }

    let data;
    try {
      data = await request.file({
        limits: {
          fileSize: OAUTH_CLIENT_UPLOAD_MAX_BYTES,
          files: 1,
        },
      });
    } catch (err) {
      if (isMultipartTooLarge(err)) {
        return reply.code(413).send({ error: "file_too_large" });
      }
      if (err instanceof ConfigGuardError) {
        return replyForConfigGuardError(reply, err);
      }
      throw err;
    }

    if (!data || data.fieldname !== "file") {
      return reply.code(400).send({ error: "no_file" });
    }

    let bytes: Buffer;
    try {
      bytes = await data.toBuffer();
    } catch (err) {
      if (isMultipartTooLarge(err)) {
        return reply.code(413).send({ error: "file_too_large" });
      }
      return reply.code(400).send({ error: "no_file" });
    }

    const text = bytes.toString("utf8");
    const validation = validateGoogleOAuthClientJson(text);
    if (!validation.ok) {
      return reply.code(400).send({
        error: "invalid_oauth_client_json",
        detail: validation.detail,
      });
    }

    try {
      const result = await resolved.setGoogleOAuthClient(text);
      if (!result.configured) {
        return reply.code(400).send({
          error: "invalid_oauth_client_json",
          detail: result.detail,
        });
      }
      await audit(request, userId, { action: "configure", clientId: result.clientId }, auditEvent);
      return reply.send({ configured: true, clientId: result.clientId });
    } catch (err) {
      if (err instanceof ConfigGuardError) {
        return replyForConfigGuardError(reply, err);
      }
      throw err;
    }
  });

  app.delete("/api/integrations/google/oauth-client", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) {
      return reply.code(401).send({ error: "Authentication required" });
    }

    if (isManagedDeployment()) {
      return reply.code(403).send({ error: "managed_by_cloud" });
    }

    if (!(await viewerHasCapability(userId, "manage_connection_providers", getCapabilities))) {
      return reply.code(403).send({
        error: "capability_missing",
        capability: "manage_connection_providers",
      });
    }

    try {
      const cleared = await resolved.clearGoogleOAuthClient();
      if (!cleared) {
        return reply.code(500).send({ error: "clear_failed" });
      }
      await audit(request, userId, { action: "remove", clientId: null }, auditEvent);
      return reply.send({ configured: false });
    } catch (err) {
      if (err instanceof ConfigGuardError) {
        return replyForConfigGuardError(reply, err);
      }
      throw err;
    }
  });
}
