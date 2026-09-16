import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { error as logError } from "@nautilo/logger";
import { findPersonalAgentsForUser, userHasCapability } from "@nautilo/trust";
import { OFFICIAL_COMMANDS, getBundledCommand } from "@nautilo/agent";
import {
  and,
  eq,
  isNull,
  commands,
  getCommandByName,
  listCommandCatalog,
  setCommandEnabled,
  softDeleteCommand,
  upsertCommand,
} from "@nautilo/db";
import { getServerDirectDb } from "../lib/server-direct-db";

export interface CommandListItem {
  name: string;
  description: string;
  enabled: boolean;
  source: string;
  tokenEstimate: number;
  updatedAt: string;
  official: boolean;
  forked: boolean;
  version?: number;
}

export interface CommandDetail extends CommandListItem {
  body: string;
}

type OfficialCommandInput = {
  name: string;
  description: string;
  body: string;
  version: number;
};

export function buildCommandList(
  dbItems: CommandListItem[],
  official: OfficialCommandInput[],
): CommandListItem[] {
  const byName = new Map(dbItems.map((item) => [item.name, item]));
  const result: CommandListItem[] = [];

  for (const o of official) {
    const dbItem = byName.get(o.name);
    if (dbItem) {
      byName.delete(o.name);
      result.push({
        ...dbItem,
        official: true,
        forked: true,
        version: o.version,
      });
    } else {
      result.push({
        name: o.name,
        description: o.description,
        enabled: true,
        source: "official",
        tokenEstimate: estimateTokens(o.body),
        updatedAt: "",
        official: true,
        forked: false,
        version: o.version,
      });
    }
  }

  for (const item of byName.values()) {
    result.push(item);
  }

  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

async function ownsAgent(userId: string, agentId: string): Promise<boolean> {
  const owned = await findPersonalAgentsForUser(userId);
  return owned.some((row) => row.agentId === agentId);
}

async function canManageCommandsForAgent(
  userId: string,
  agentId: string,
): Promise<boolean> {
  if (await ownsAgent(userId, agentId)) return true;
  return userHasCapability(userId, "manage_agents");
}

function isGuestViewer(request: FastifyRequest): boolean {
  const role = request.policyContext?.actorRole;
  return role == null || role === "guest" || role === "anonymous" || !request.sessionUserId;
}

async function resolveSubjectAgentId(request: FastifyRequest): Promise<string | null> {
  const userId = request.sessionUserId;
  if (!userId) return null;
  const owned = await findPersonalAgentsForUser(userId);
  return owned[0]?.agentId ?? null;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function commandDetailFromRow(row: {
  name: string;
  description: string;
  body: string;
  enabled: boolean;
  source: string;
  updatedAt: Date;
}): CommandDetail {
  const official = getBundledCommand(row.name);
  return {
    name: row.name,
    description: row.description,
    body: row.body,
    enabled: row.enabled,
    source: row.source,
    tokenEstimate: estimateTokens(row.body),
    updatedAt: row.updatedAt.toISOString(),
    official: !!official,
    forked: !!official,
    ...(official ? { version: official.version } : {}),
  };
}

async function listCommandsForSpeaker(
  agentId: string,
  userId: string,
): Promise<CommandListItem[]> {
  const db = getServerDirectDb();
  const rows = await db
    .select({
      name: commands.name,
      description: commands.description,
      body: commands.body,
      enabled: commands.enabled,
      source: commands.source,
      updatedAt: commands.updatedAt,
    })
    .from(commands)
    .where(
      and(
        eq(commands.agentId, agentId),
        eq(commands.userId, userId),
        isNull(commands.deletedAt),
      ),
    )
    .orderBy(commands.name);

  return rows.map((row) => ({
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    source: row.source,
    tokenEstimate: estimateTokens(row.body),
    updatedAt: row.updatedAt.toISOString(),
    official: false,
    forked: false,
  }));
}

async function requireCommandsAccess(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ userId: string; agentId: string } | null> {
  if (!request.sessionUserId) {
    void reply.code(401).send({ error: "Authentication required" });
    return null;
  }
  if (isGuestViewer(request)) {
    void reply.code(403).send({ error: "Commands are not available to guests" });
    return null;
  }
  const agentId = await resolveSubjectAgentId(request);
  if (!agentId) {
    void reply.code(409).send({ error: "no_personal_agent" });
    return null;
  }
  return { userId: request.sessionUserId, agentId };
}

async function requireCommandsWrite(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ userId: string; agentId: string } | null> {
  const ctx = await requireCommandsAccess(request, reply);
  if (!ctx) return null;
  if (!(await canManageCommandsForAgent(ctx.userId, ctx.agentId))) {
    void reply.code(403).send({ error: "forbidden" });
    return null;
  }
  return ctx;
}

export function commandsRoutes(app: FastifyInstance) {
  app.get("/api/commands", async (request, reply) => {
    const ctx = await requireCommandsAccess(request, reply);
    if (!ctx) return;

    try {
      const dbItems = await listCommandsForSpeaker(ctx.agentId, ctx.userId);
      const items = buildCommandList(
        dbItems,
        OFFICIAL_COMMANDS.map(({ name, description, body, version }) => ({
          name,
          description,
          body,
          version,
        })),
      );
      const enabled = items.filter((c) => c.enabled).length;
      const disabled = items.length - enabled;
      return reply.send({
        commands: items,
        summary: { total: items.length, enabled, disabled },
        catalog: await listCommandCatalog(ctx.agentId, ctx.userId),
      });
    } catch (e) {
      logError(
        "[commands] GET /api/commands failed:",
        e instanceof Error ? e.stack ?? e.message : String(e),
      );
      return reply.code(500).send({ error: "Failed to list commands." });
    }
  });

  app.get<{ Params: { name: string } }>("/api/commands/:name", async (request, reply) => {
    const ctx = await requireCommandsAccess(request, reply);
    if (!ctx) return;

    try {
      const row = await getCommandByName(ctx.agentId, ctx.userId, request.params.name);
      if (row) {
        return reply.send({ command: commandDetailFromRow(row) });
      }

      const official = getBundledCommand(request.params.name);
      if (!official) {
        return reply.code(404).send({ error: "not_found" });
      }

      const detail: CommandDetail = {
        name: official.name,
        description: official.description,
        body: official.body,
        enabled: true,
        source: "official",
        tokenEstimate: estimateTokens(official.body),
        updatedAt: "",
        official: true,
        forked: false,
        version: official.version,
      };
      return reply.send({ command: detail });
    } catch (e) {
      logError(
        "[commands] GET /api/commands/:name failed:",
        e instanceof Error ? e.stack ?? e.message : String(e),
      );
      return reply.code(500).send({ error: "Failed to load command." });
    }
  });

  app.put<{
    Body: {
      name?: string;
      description?: string;
      body?: string;
      enabled?: boolean;
    };
  }>("/api/commands", async (request, reply) => {
    const ctx = await requireCommandsWrite(request, reply);
    if (!ctx) return;

    const body = request.body ?? {};
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const commandBody = typeof body.body === "string" ? body.body.trim() : "";
    const enabled = typeof body.enabled === "boolean" ? body.enabled : true;

    if (!name || !description || !commandBody) {
      return reply.code(400).send({ error: "name, description, and body are required" });
    }

    try {
      const row = await upsertCommand({
        agentId: ctx.agentId,
        userId: ctx.userId,
        name,
        description,
        body: commandBody,
        enabled,
        source: "user",
      });
      return reply.send({ command: commandDetailFromRow(row) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logError("[commands] PUT /api/commands failed:", msg);
      return reply.code(500).send({ error: "Failed to save command." });
    }
  });

  app.patch<{ Params: { name: string }; Body: { enabled?: boolean } }>(
    "/api/commands/:name",
    async (request, reply) => {
      const ctx = await requireCommandsWrite(request, reply);
      if (!ctx) return;

      if (typeof request.body?.enabled !== "boolean") {
        return reply.code(400).send({ error: "`enabled` must be a boolean" });
      }

      try {
        const row = await setCommandEnabled(
          ctx.agentId,
          ctx.userId,
          request.params.name,
          request.body.enabled,
        );
        if (!row) {
          return reply.code(404).send({ error: "not_found" });
        }
        return reply.send({ command: commandDetailFromRow(row) });
      } catch (e) {
        logError(
          "[commands] PATCH /api/commands/:name failed:",
          e instanceof Error ? e.message : String(e),
        );
        return reply.code(500).send({ error: "Failed to update command." });
      }
    },
  );

  app.delete<{ Params: { name: string } }>("/api/commands/:name", async (request, reply) => {
    const ctx = await requireCommandsWrite(request, reply);
    if (!ctx) return;

    try {
      const deleted = await softDeleteCommand(ctx.agentId, ctx.userId, request.params.name);
      if (!deleted) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.send({ ok: true });
    } catch (e) {
      logError(
        "[commands] DELETE /api/commands/:name failed:",
        e instanceof Error ? e.message : String(e),
      );
      return reply.code(500).send({ error: "Failed to delete command." });
    }
  });

  app.post<{ Params: { name: string } }>(
    "/api/commands/:name/customize",
    async (request, reply) => {
      const ctx = await requireCommandsWrite(request, reply);
      if (!ctx) return;

      try {
        const official = getBundledCommand(request.params.name);
        if (!official) {
          return reply.code(404).send({ error: "not_official" });
        }

        const existing = await getCommandByName(ctx.agentId, ctx.userId, request.params.name);
        if (existing) {
          return reply.code(409).send({ error: "already_customized" });
        }

        const row = await upsertCommand({
          agentId: ctx.agentId,
          userId: ctx.userId,
          name: official.name,
          description: official.description,
          body: official.body,
          enabled: true,
          source: "user",
        });
        return reply.send({ command: commandDetailFromRow(row) });
      } catch (e) {
        logError(
          "[commands] POST /api/commands/:name/customize failed:",
          e instanceof Error ? e.stack ?? e.message : String(e),
        );
        return reply.code(500).send({ error: "Failed to customize command." });
      }
    },
  );

  app.post<{ Params: { name: string } }>("/api/commands/:name/reset", async (request, reply) => {
    const ctx = await requireCommandsWrite(request, reply);
    if (!ctx) return;

    try {
      if (!getBundledCommand(request.params.name)) {
        return reply.code(404).send({ error: "not_official" });
      }

      const deleted = await softDeleteCommand(ctx.agentId, ctx.userId, request.params.name);
      if (!deleted) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.send({ ok: true });
    } catch (e) {
      logError(
        "[commands] POST /api/commands/:name/reset failed:",
        e instanceof Error ? e.stack ?? e.message : String(e),
      );
      return reply.code(500).send({ error: "Failed to reset command." });
    }
  });
}
