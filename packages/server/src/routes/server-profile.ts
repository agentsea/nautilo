import { homedir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { getServerIconRoot, resolveInstance } from "@nautilo/config";
import {
  upsertServerProfile,
  deriveDefaultServerName,
  type ResolveServerProfileOpts,
  type ServerProfilePatch,
} from "@nautilo/db";
import { getUserCapabilities } from "@nautilo/trust";
import { warn } from "@nautilo/logger";
import { persistUploadedServerImage } from "../lib/server-image-upload";
import { getServerDirectDb } from "../lib/server-direct-db";
import { resolvePublicServerUrl } from "../lib/public-urls";
import { writeSecurityAuditEvent, type SecurityAuditEvent } from "../lib/security-audit-log";

function audit(request: FastifyRequest, event: Record<string, unknown>): void {
  try {
    writeSecurityAuditEvent(join(homedir(), ".nautilo", "logs", "security-audit.log"), {
      ...event,
      ts: new Date().toISOString(),
      ip: request.ip,
      userAgent: request.headers["user-agent"],
    } as SecurityAuditEvent);
  } catch (err) {
    warn(`[server-profile] audit write failed: ${String(err)}`);
  }
}

function serverProfileResolveOpts(): ResolveServerProfileOpts {
  const instance = resolveInstance();
  return {
    defaultName: deriveDefaultServerName({
      host: resolvePublicServerUrl(instance),
      instanceId: instance.instanceId,
    }),
  };
}

async function viewerCanManageServerOperations(
  userId: string,
  getCapabilities: typeof getUserCapabilities,
): Promise<boolean> {
  try {
    const caps = await getCapabilities(userId);
    return caps.includes("manage_server_operations");
  } catch {
    return false;
  }
}

function parseProfileUpdateBody(body: unknown): ServerProfilePatch | "invalid" {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "invalid";
  }

  const raw = body as Record<string, unknown>;
  const patch: ServerProfilePatch = {};

  if ("name" in raw) {
    if (raw["name"] !== null && typeof raw["name"] !== "string") {
      return "invalid";
    }
    patch.name = raw["name"];
  }

  if ("description" in raw) {
    if (raw["description"] !== null && typeof raw["description"] !== "string") {
      return "invalid";
    }
    patch.description = raw["description"];
  }

  if ("descriptionVisibility" in raw) {
    const visibility = raw["descriptionVisibility"];
    if (visibility !== "public" && visibility !== "members") {
      return "invalid";
    }
    patch.descriptionVisibility = visibility;
  }

  if ("reviewed" in raw) {
    if (raw["reviewed"] !== true) return "invalid";
    patch.reviewedAt = new Date();
  }

  if (
    patch.name === undefined &&
    patch.description === undefined &&
    patch.descriptionVisibility === undefined &&
    patch.reviewedAt === undefined
  ) {
    return "invalid";
  }

  return patch;
}

export interface ServerProfileRouteDeps {
  getCapabilities?: typeof getUserCapabilities;
  upsertProfile?: typeof upsertServerProfile;
  getDb?: typeof getServerDirectDb;
  resolveOpts?: typeof serverProfileResolveOpts;
  auditEvent?: typeof audit;
}

export function serverProfileRoutes(
  app: FastifyInstance,
  overrides: ServerProfileRouteDeps = {},
): void {
  const getCapabilities = overrides.getCapabilities ?? getUserCapabilities;
  const upsertProfile = overrides.upsertProfile ?? upsertServerProfile;
  const getDb = overrides.getDb ?? getServerDirectDb;
  const resolveOpts = overrides.resolveOpts ?? serverProfileResolveOpts;
  const auditEvent = overrides.auditEvent ?? audit;

  app.post("/api/server/profile", async (request, reply) => {
    const sessionUserId = request.sessionUserId;
    if (!sessionUserId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    if (!(await viewerCanManageServerOperations(sessionUserId, getCapabilities))) {
      return reply.code(403).send({ error: "admin only" });
    }

    const patch = parseProfileUpdateBody(request.body);
    if (patch === "invalid") {
      return reply.code(400).send({ error: "invalid body" });
    }

    const profile = await upsertProfile(getDb(), patch, resolveOpts());
    auditEvent(request, {
      kind: "server_profile_changed",
      actorId: sessionUserId,
      changes: Object.fromEntries(
        Object.entries(patch).map(([field, after]) => [field, { after }]),
      ),
    });
    return reply.send({ serverProfile: profile });
  });

  app.post("/api/server/icon", async (request, reply) => {
    const sessionUserId = request.sessionUserId;
    if (!sessionUserId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    if (!(await viewerCanManageServerOperations(sessionUserId, getCapabilities))) {
      return reply.code(403).send({ error: "admin only" });
    }

    const icon = await persistUploadedServerImage(request, reply, getServerIconRoot());
    if (!icon) return;

    const profile = await upsertProfile(getDb(), { icon }, resolveOpts());
    auditEvent(request, {
      kind: "server_profile_changed",
      actorId: sessionUserId,
      changes: { icon: { after: profile.icon } },
    });
    return reply.send({ serverProfile: profile });
  });
}
