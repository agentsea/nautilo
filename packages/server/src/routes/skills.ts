import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { error as logError } from "@nautilo/logger";
import { findPersonalAgentsForUser, userHasCapability } from "@nautilo/trust";
import { OFFICIAL_SKILLS, getBundledSkill } from "@nautilo/agent";
import { getToolCatalog } from "@nautilo/catalog";
import {
  and,
  eq,
  isNull,
  skills,
  getByName,
  listCatalog,
  setSkillEnabled,
  softDeleteSkill,
  upsertSkill,
} from "@nautilo/db";
import { getServerDirectDb } from "../lib/server-direct-db";

export interface SkillListItem {
  name: string;
  description: string;
  enabled: boolean;
  source: string;
  requiresTools: string[];
  tokenEstimate: number;
  updatedAt: string;
  official: boolean;
  forked: boolean;
  version?: number;
}

export interface SkillDetail extends SkillListItem {
  body: string;
}

export interface SkillToolOption {
  name: string;
  label: string;
  description: string;
  category: string;
}

type OfficialSkillInput = {
  name: string;
  description: string;
  body: string;
  requiresTools: string[];
  version: number;
};

export function buildSkillList(
  dbItems: SkillListItem[],
  official: OfficialSkillInput[],
): SkillListItem[] {
  const byName = new Map(dbItems.map((item) => [item.name, item]));
  const result: SkillListItem[] = [];

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
        requiresTools: o.requiresTools,
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

async function canManageSkillsForAgent(userId: string, agentId: string): Promise<boolean> {
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

const FRIENDLY_TOOL_LABELS: Readonly<Record<string, string>> = {
  activate_tools: "Enable capabilities",
  add_memory_to_scope: "Add relevant memory",
  apply_patch: "Edit files",
  deactivate_tools: "Disable capabilities",
  discover_tools: "Find capabilities",
  file: "Files and documents",
  manage_local_mcp: "Local MCP setup",
  read_artifact_events: "Live document changes",
  run_shell: "Shell commands",
  run_web_search: "Web search",
};

function humanizeToolName(name: string): string {
  return name
    .split(/[_-]+/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function friendlySkillToolLabel(name: string): string {
  const known = FRIENDLY_TOOL_LABELS[name];
  if (known) return known;
  const appTool = /^app_(.+?)__(.+)$/u.exec(name);
  if (appTool) {
    return `${humanizeToolName(appTool[2] ?? "")} (${humanizeToolName(appTool[1] ?? "app")})`;
  }
  return humanizeToolName(name);
}

function skillToolOptionsForRequest(request: FastifyRequest): SkillToolOption[] {
  const catalog = getToolCatalog();
  if (!catalog) return [];
  const envelope = request.memoryEnvelope;
  const readableNamespaces = envelope && envelope.memoryMode === "namespace"
    ? envelope.readableNamespaces
    : undefined;
  return catalog
    .getFiltered(envelope?.toolPolicy, undefined, {
      skipRelayLiveCheck: true,
      ...(readableNamespaces ? { readableNamespaces } : {}),
    })
    .entries
    .map((entry) => ({
      name: entry.name,
      label: friendlySkillToolLabel(entry.name),
      description: entry.description,
      category: entry.category,
    }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.name.localeCompare(b.name));
}

export function unknownSkillToolRequirements(
  requiresTools: readonly string[],
  allowedNames: ReadonlySet<string>,
): string[] {
  return [...new Set(requiresTools.map((name) => name.trim()).filter(Boolean))]
    .filter((name) => !allowedNames.has(name))
    .sort();
}

function skillDetailFromRow(row: {
  name: string;
  description: string;
  body: string;
  enabled: boolean;
  source: string;
  requiresTools: string[];
  updatedAt: Date;
}): SkillDetail {
  const official = getBundledSkill(row.name);
  return {
    name: row.name,
    description: row.description,
    body: row.body,
    enabled: row.enabled,
    source: row.source,
    requiresTools: row.requiresTools,
    tokenEstimate: estimateTokens(row.body),
    updatedAt: row.updatedAt.toISOString(),
    official: !!official,
    forked: !!official,
    ...(official ? { version: official.version } : {}),
  };
}

async function listSkillsForSpeaker(
  agentId: string,
  userId: string,
): Promise<SkillListItem[]> {
  const db = getServerDirectDb();
  const rows = await db
    .select({
      name: skills.name,
      description: skills.description,
      body: skills.body,
      enabled: skills.enabled,
      source: skills.source,
      requiresTools: skills.requiresTools,
      updatedAt: skills.updatedAt,
    })
    .from(skills)
    .where(
      and(
        eq(skills.agentId, agentId),
        eq(skills.userId, userId),
        isNull(skills.deletedAt),
      ),
    )
    .orderBy(skills.name);

  return rows.map((row) => ({
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    source: row.source,
    requiresTools: row.requiresTools,
    tokenEstimate: estimateTokens(row.body),
    updatedAt: row.updatedAt.toISOString(),
    official: false,
    forked: false,
  }));
}

async function requireSkillsAccess(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ userId: string; agentId: string } | null> {
  if (!request.sessionUserId) {
    void reply.code(401).send({ error: "Authentication required" });
    return null;
  }
  if (isGuestViewer(request)) {
    void reply.code(403).send({ error: "Skills are not available to guests" });
    return null;
  }
  const agentId = await resolveSubjectAgentId(request);
  if (!agentId) {
    void reply.code(409).send({ error: "no_personal_agent" });
    return null;
  }
  return { userId: request.sessionUserId, agentId };
}

async function requireSkillsWrite(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ userId: string; agentId: string } | null> {
  const ctx = await requireSkillsAccess(request, reply);
  if (!ctx) return null;
  if (!(await canManageSkillsForAgent(ctx.userId, ctx.agentId))) {
    void reply.code(403).send({ error: "forbidden" });
    return null;
  }
  return ctx;
}

export function skillsRoutes(app: FastifyInstance) {
  app.get("/api/skills/tool-options", async (request, reply) => {
    const ctx = await requireSkillsAccess(request, reply);
    if (!ctx) return;
    return reply.send({ tools: skillToolOptionsForRequest(request) });
  });

  app.get("/api/skills", async (request, reply) => {
    const ctx = await requireSkillsAccess(request, reply);
    if (!ctx) return;

    try {
      const dbItems = await listSkillsForSpeaker(ctx.agentId, ctx.userId);
      const items = buildSkillList(
        dbItems,
        OFFICIAL_SKILLS.map(({ name, description, body, requiresTools, version }) => ({
          name,
          description,
          body,
          requiresTools,
          version,
        })),
      );
      const enabled = items.filter((s) => s.enabled).length;
      const disabled = items.length - enabled;
      return reply.send({
        skills: items,
        summary: { total: items.length, enabled, disabled },
        catalog: await listCatalog(ctx.agentId, ctx.userId),
      });
    } catch (e) {
      logError(
        "[skills] GET /api/skills failed:",
        e instanceof Error ? e.stack ?? e.message : String(e),
      );
      return reply.code(500).send({ error: "Failed to list skills." });
    }
  });

  app.get<{ Params: { name: string } }>("/api/skills/:name", async (request, reply) => {
    const ctx = await requireSkillsAccess(request, reply);
    if (!ctx) return;

    try {
      const row = await getByName(ctx.agentId, ctx.userId, request.params.name);
      if (row) {
        return reply.send({ skill: skillDetailFromRow(row) });
      }

      const official = getBundledSkill(request.params.name);
      if (!official) {
        return reply.code(404).send({ error: "not_found" });
      }

      const detail: SkillDetail = {
        name: official.name,
        description: official.description,
        body: official.body,
        enabled: true,
        source: "official",
        requiresTools: official.requiresTools,
        tokenEstimate: estimateTokens(official.body),
        updatedAt: "",
        official: true,
        forked: false,
        version: official.version,
      };
      return reply.send({ skill: detail });
    } catch (e) {
      logError(
        "[skills] GET /api/skills/:name failed:",
        e instanceof Error ? e.stack ?? e.message : String(e),
      );
      return reply.code(500).send({ error: "Failed to load skill." });
    }
  });

  app.put<{
    Body: {
      name?: string;
      description?: string;
      body?: string;
      enabled?: boolean;
      requiresTools?: string[];
    };
  }>("/api/skills", async (request, reply) => {
    const ctx = await requireSkillsWrite(request, reply);
    if (!ctx) return;

    const body = request.body ?? {};
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const skillBody = typeof body.body === "string" ? body.body.trim() : "";
    const enabled = typeof body.enabled === "boolean" ? body.enabled : true;
    const requiresTools = Array.isArray(body.requiresTools)
      ? [...new Set(body.requiresTools
          .filter((t): t is string => typeof t === "string")
          .map((tool) => tool.trim())
          .filter(Boolean))]
      : [];

    if (!name || !description || !skillBody) {
      return reply.code(400).send({ error: "name, description, and body are required" });
    }

    const unknownRequiredTools = unknownSkillToolRequirements(
      requiresTools,
      new Set(skillToolOptionsForRequest(request).map((tool) => tool.name)),
    );
    if (unknownRequiredTools.length > 0) {
      return reply.code(400).send({
        error: "One or more selected capabilities are no longer available.",
        code: "unknown_required_tools",
        tools: unknownRequiredTools,
      });
    }

    try {
      const row = await upsertSkill({
        agentId: ctx.agentId,
        userId: ctx.userId,
        name,
        description,
        body: skillBody,
        enabled,
        requiresTools,
        source: "user",
      });
      return reply.send({ skill: skillDetailFromRow(row) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logError("[skills] PUT /api/skills failed:", msg);
      return reply.code(500).send({ error: "Failed to save skill." });
    }
  });

  app.patch<{ Params: { name: string }; Body: { enabled?: boolean } }>(
    "/api/skills/:name",
    async (request, reply) => {
      const ctx = await requireSkillsWrite(request, reply);
      if (!ctx) return;

      if (typeof request.body?.enabled !== "boolean") {
        return reply.code(400).send({ error: "`enabled` must be a boolean" });
      }

      try {
        const row = await setSkillEnabled(
          ctx.agentId,
          ctx.userId,
          request.params.name,
          request.body.enabled,
        );
        if (!row) {
          return reply.code(404).send({ error: "not_found" });
        }
        return reply.send({ skill: skillDetailFromRow(row) });
      } catch (e) {
        logError(
          "[skills] PATCH /api/skills/:name failed:",
          e instanceof Error ? e.message : String(e),
        );
        return reply.code(500).send({ error: "Failed to update skill." });
      }
    },
  );

  app.delete<{ Params: { name: string } }>("/api/skills/:name", async (request, reply) => {
    const ctx = await requireSkillsWrite(request, reply);
    if (!ctx) return;

    try {
      const deleted = await softDeleteSkill(ctx.agentId, ctx.userId, request.params.name);
      if (!deleted) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.send({ ok: true });
    } catch (e) {
      logError(
        "[skills] DELETE /api/skills/:name failed:",
        e instanceof Error ? e.message : String(e),
      );
      return reply.code(500).send({ error: "Failed to delete skill." });
    }
  });

  app.post<{ Params: { name: string } }>(
    "/api/skills/:name/customize",
    async (request, reply) => {
      const ctx = await requireSkillsWrite(request, reply);
      if (!ctx) return;

      try {
        const official = getBundledSkill(request.params.name);
        if (!official) {
          return reply.code(404).send({ error: "not_official" });
        }

        const existing = await getByName(ctx.agentId, ctx.userId, request.params.name);
        if (existing) {
          return reply.code(409).send({ error: "already_customized" });
        }

        const row = await upsertSkill({
          agentId: ctx.agentId,
          userId: ctx.userId,
          name: official.name,
          description: official.description,
          body: official.body,
          requiresTools: official.requiresTools,
          enabled: true,
          source: "user",
        });
        return reply.send({ skill: skillDetailFromRow(row) });
      } catch (e) {
        logError(
          "[skills] POST /api/skills/:name/customize failed:",
          e instanceof Error ? e.stack ?? e.message : String(e),
        );
        return reply.code(500).send({ error: "Failed to customize skill." });
      }
    },
  );

  app.post<{ Params: { name: string } }>("/api/skills/:name/reset", async (request, reply) => {
    const ctx = await requireSkillsWrite(request, reply);
    if (!ctx) return;

    try {
      if (!getBundledSkill(request.params.name)) {
        return reply.code(404).send({ error: "not_official" });
      }

      const deleted = await softDeleteSkill(ctx.agentId, ctx.userId, request.params.name);
      if (!deleted) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.send({ ok: true });
    } catch (e) {
      logError(
        "[skills] POST /api/skills/:name/reset failed:",
        e instanceof Error ? e.stack ?? e.message : String(e),
      );
      return reply.code(500).send({ error: "Failed to reset skill." });
    }
  });
}
