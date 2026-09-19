import { homedir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { getDefaultMediaGenerationModel, listMediaGenerationModels, listResolvedCatalogModels, kickRuntimeModelCatalogRefresh, ModelUnavailableError, NoRunnableModelForRoleError, resolveModelRole, resolveRetainedModels, getProtectedMemoryEmbeddingConfiguration, resolveProviderKey, EmbeddingProviderError } from "@nautilo/agent";
import { candidatesForModelRole } from "@nautilo/config";
import {
  getServerModelConfig,
  getCachedServerModelConfigRow,
  refreshServerModelConfigCache,
  upsertServerModelConfig,
  type ResolvedServerModelConfig,
  type ServerModelConfigDefaults,
  type ServerModelConfigPatch,
} from "@nautilo/db";
import { warn } from "@nautilo/logger";
import { getUserCapabilities } from "@nautilo/trust";
import { writeSecurityAuditEvent, type SecurityAuditEvent } from "../lib/security-audit-log";
import { getServerDirectDb } from "../lib/server-direct-db";

const REASONING_EFFORTS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** Read-only display projection of the same live catalog used by execution. */
function catalogModels() {
  kickRuntimeModelCatalogRefresh();
  return listResolvedCatalogModels({ includeUnavailable: true }).map((model) => ({
    id: model.id,
    displayName: model.displayName,
    provider: model.provider,
    workload: model.workload,
    availability: model.availability,
    ...(model.unavailableReason ? { unavailableReason: model.unavailableReason } : {}),
    input: model.input,
    output: model.output,
    features: {
      tools: model.features.tools,
      structuredOutputs: model.features.structuredOutputs,
      reasoning: model.features.reasoning,
      visualGrounding: model.features.visualGrounding ?? null,
      webSearch: model.features.webSearch,
      e2ee: model.features.e2ee,
    },
    decision: model.decision ? { operations: model.decision.operations } : null,
  }));
}

function embeddingModels() {
  return candidatesForModelRole("embeddings").map((id) => {
    const provider = id.split(":")[0] as "venice" | "openrouter" | "openai";
    const label = provider === "venice" ? "Venice" : provider === "openrouter" ? "OpenRouter" : "OpenAI";
    const modelId = id.slice(id.indexOf(":") + 1);
    return { id, displayName: `${label} — ${modelId} (1,536 dimensions)`,
      available: resolveProviderKey(provider) !== null };
  });
}

function effectiveEmbeddingModel(): string | null {
  try {
    const value = getProtectedMemoryEmbeddingConfiguration();
    return value.dimensions === 1536 ? `${value.provider}:${value.model}` : null;
  } catch (error) {
    if (error instanceof EmbeddingProviderError) return null;
    throw error;
  }
}

type MediaGenerationModelKind = "image" | "music" | "video";

function mediaGenerationModels(kind: MediaGenerationModelKind) {
  return listMediaGenerationModels(kind).map((model) => ({
    id: model.id,
    displayName: model.displayName,
    provider: model.provider,
    available: model.enabled,
    ...(model.unavailableReason ? { unavailableReason: model.unavailableReason } : {}),
  }));
}

function effectiveMediaGenerationModel(kind: MediaGenerationModelKind): string | null {
  try {
    return getDefaultMediaGenerationModel(kind).id;
  } catch {
    return null;
  }
}

function auditPath(): string {
  return join(homedir(), ".nautilo", "logs", "security-audit.log");
}

function audit(request: FastifyRequest, event: Record<string, unknown>): void {
  try {
    writeSecurityAuditEvent(auditPath(), {
      ...event,
      ts: new Date().toISOString(),
      ip: request.ip,
      userAgent: request.headers["user-agent"],
    } as SecurityAuditEvent);
  } catch (err) {
    warn(`[server-models] audit write failed: ${String(err)}`);
  }
}

async function viewerHasCapability(
  userId: string,
  capability: "read_server_settings" | "manage_server_operations",
  getCapabilities: typeof getUserCapabilities,
): Promise<boolean> {
  try {
    const caps = await getCapabilities(userId);
    return caps.includes(capability);
  } catch {
    return false;
  }
}

/**
 * Effective defaults the resolver falls back to when a field is unset. Default
 * chat model comes from the catalog picker; there is no server-wide fallback
 * chain baseline today (chains are per-user/per-agent), so it defaults to
 * empty.
 */
function modelConfigDefaults(): ServerModelConfigDefaults {
  const operatorDefault = process.env["NAUTILO_MODEL"]?.trim();
  let defaultChatModel: string;
  try {
    defaultChatModel = resolveModelRole("chat", operatorDefault
      ? { configuredId: operatorDefault }
      : undefined);
  } catch (error) {
    if (!(error instanceof ModelUnavailableError) && !(error instanceof NoRunnableModelForRoleError)) {
      throw error;
    }
    // Metadata and repair must remain reachable when an explicit host pin or
    // every automatic candidate is temporarily unavailable. Runtime execution
    // performs its own strict runnable-model resolution.
    defaultChatModel = operatorDefault || candidatesForModelRole("chat")[0]!;
  }
  return {
    defaultChatModel,
    fallbackChain: [],
  };
}

type ParseResult =
  | { ok: true; patch: ServerModelConfigPatch }
  | { ok: false; error: string };

function parseUpdateBody(
  body: unknown,
  listMediaModels: typeof mediaGenerationModels = mediaGenerationModels,
): ParseResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "invalid body" };
  }
  const raw = body as Record<string, unknown>;
  const patch: ServerModelConfigPatch = {};
  if ("embeddingModel" in raw) {
    const value = raw["embeddingModel"];
    if (value !== null && typeof value !== "string") {
      return { ok: false, error: "embeddingModel must be a string or null" };
    }
    const id = value?.trim() ?? null;
    if (id) {
      const option = embeddingModels().find((entry) => entry.id === id);
      if (!option) return { ok: false, error: "Unsupported embedding model: select a qualified 1,536-dimensional model" };
    }
    patch.embeddingModel = id;
  }
  for (const [field, kind] of [
    ["imageModel", "image"],
    ["musicModel", "music"],
    ["videoModel", "video"],
  ] as const) {
    if (!(field in raw)) continue;
    const value = raw[field];
    if (value !== null && typeof value !== "string") {
      return { ok: false, error: `${field} must be a string or null` };
    }
    const id = value?.trim() ?? null;
    if (id) {
      const option = listMediaModels(kind).find((entry) => entry.id === id);
      if (!option) {
        return { ok: false, error: `Unsupported ${kind} generation model` };
      }
      if (!option.available) {
        return {
          ok: false,
          error: `${kind} generation model unavailable: ${id} (${option.unavailableReason ?? "model is not runnable"})`,
        };
      }
    }
    patch[field] = id;
  }
  const unavailableReason = (
    modelId: string,
    purpose: "chat" | "chat-tools",
  ): string | null => {
    const row = resolveRetainedModels([modelId], { purpose })[0]!;
    return row.availability === "selectable"
      ? null
      : row.unavailableReason ?? "model is not runnable";
  };

  if ("defaultChatModel" in raw) {
    const v = raw["defaultChatModel"];
    if (typeof v !== "string") return { ok: false, error: "defaultChatModel must be a string" };
    if (v.trim() !== "") {
      const reason = unavailableReason(v, "chat-tools");
      if (reason) return { ok: false, error: `model unavailable: ${v} (${reason})` };
    }
    patch.defaultChatModel = v.trim() === "" ? null : v;
  }

  if ("conductorModel" in raw) {
    const v = raw["conductorModel"];
    if (typeof v !== "string") return { ok: false, error: "conductorModel must be a string" };
    // Empty string ⇒ inherit the default chat model (stored as null).
    if (v.trim() !== "") {
      const reason = unavailableReason(v, "chat");
      if (reason) return { ok: false, error: `model unavailable: ${v} (${reason})` };
    }
    patch.conductorModel = v.trim() === "" ? null : v;
  }

  if ("stenographerModel" in raw) {
    const v = raw["stenographerModel"];
    if (typeof v !== "string") {
      return { ok: false, error: "stenographerModel must be a string" };
    }
    if (v.trim() !== "") {
      const reason = unavailableReason(v, "chat");
      if (reason) return { ok: false, error: `model unavailable: ${v} (${reason})` };
    }
    patch.stenographerModel = v.trim() === "" ? null : v;
  }

  if ("reflectionModel" in raw) {
    const v = raw["reflectionModel"];
    if (typeof v !== "string") {
      return { ok: false, error: "reflectionModel must be a string" };
    }
    if (v.trim() !== "") {
      const reason = unavailableReason(v, "chat");
      if (reason) return { ok: false, error: `model unavailable: ${v} (${reason})` };
    }
    patch.reflectionModel = v.trim() === "" ? null : v;
  }

  if ("memoryReviewModel" in raw) {
    const value = raw["memoryReviewModel"];
    if (value !== null && typeof value !== "string") {
      return { ok: false, error: "memoryReviewModel must be a string or null" };
    }
    if (value?.trim()) {
      const reason = unavailableReason(value, "chat-tools");
      if (reason) return { ok: false, error: `model unavailable: ${value} (${reason})` };
    }
    patch.memoryReviewModel = value?.trim() ? value : null;
  }

  if ("fallbackChain" in raw) {
    const v = raw["fallbackChain"];
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
      return { ok: false, error: "fallbackChain must be an array of strings" };
    }
    for (const id of v) {
      const reason = unavailableReason(id, "chat-tools");
      if (reason) {
        return { ok: false, error: `model unavailable in fallbackChain: ${id} (${reason})` };
      }
    }
    patch.fallbackChain = v;
  }

  if ("reasoningOutput" in raw) {
    const v = raw["reasoningOutput"];
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      return { ok: false, error: "reasoningOutput must be an object" };
    }
    const map: Record<string, boolean> = {};
    for (const [modelId, enabled] of Object.entries(v as Record<string, unknown>)) {
      if (typeof enabled !== "boolean") {
        return { ok: false, error: `reasoningOutput.${modelId} must be a boolean` };
      }
      const reason = unavailableReason(modelId, "chat");
      if (reason) {
        return { ok: false, error: `model unavailable in reasoningOutput: ${modelId} (${reason})` };
      }
      map[modelId] = enabled;
    }
    patch.reasoningOutput = map;
  }

  if ("reasoningPolicy" in raw) {
    const v = raw["reasoningPolicy"];
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      return { ok: false, error: "reasoningPolicy must be an object" };
    }
    const policy = v as Record<string, unknown>;
    const defaultEffort = policy["defaultEffort"];
    if (defaultEffort !== null && (typeof defaultEffort !== "string" || !REASONING_EFFORTS.has(defaultEffort))) {
      return { ok: false, error: "reasoningPolicy.defaultEffort is invalid" };
    }
    const overrides = policy["overrides"];
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
      return { ok: false, error: "reasoningPolicy.overrides must be an object" };
    }
    const parsedOverrides: Record<string, "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"> = {};
    for (const [modelId, effort] of Object.entries(overrides as Record<string, unknown>)) {
      if (typeof effort !== "string" || !REASONING_EFFORTS.has(effort)) {
        return { ok: false, error: `reasoningPolicy.overrides.${modelId} is invalid` };
      }
      const reason = unavailableReason(modelId, "chat");
      if (reason) return { ok: false, error: `model unavailable in reasoningPolicy: ${modelId} (${reason})` };
      parsedOverrides[modelId] = effort as typeof parsedOverrides[string];
    }
    patch.reasoningPolicy = {
      defaultEffort: defaultEffort as typeof parsedOverrides[string] | null,
      overrides: parsedOverrides,
    };
  }

  if (
    patch.defaultChatModel === undefined &&
    patch.conductorModel === undefined &&
    patch.stenographerModel === undefined &&
    patch.reflectionModel === undefined &&
    patch.memoryReviewModel === undefined &&
    patch.embeddingModel === undefined &&
    patch.imageModel === undefined &&
    patch.musicModel === undefined &&
    patch.videoModel === undefined &&
    patch.fallbackChain === undefined &&
    patch.reasoningOutput === undefined
    && patch.reasoningPolicy === undefined
  ) {
    return { ok: false, error: "no recognized fields to update" };
  }
  return { ok: true, patch };
}

export function toWire(config: ResolvedServerModelConfig) {
  return {
    defaultChatModel: config.defaultChatModel,
    conductorModel: config.conductorModel,
    stenographerModel: config.stenographerModel,
    reflectionModel: config.reflectionModel,
    memoryReviewModel: config.memoryReviewModel,
    embeddingModel: config.embeddingModel,
    imageModel: config.imageModel,
    musicModel: config.musicModel,
    videoModel: config.videoModel,
    fallbackChain: config.fallbackChain,
    reasoningOutput: config.reasoningOutput,
    reasoningPolicy: config.reasoningPolicy,
  };
}

/** @internal Exported for unit tests — validation is deterministic and DB-free. */
export function parseUpdateBodyForTests(
  body: unknown,
  listMediaModels?: typeof mediaGenerationModels,
): ParseResult {
  return parseUpdateBody(body, listMediaModels);
}

function auditChanges(
  before: ResolvedServerModelConfig,
  after: ResolvedServerModelConfig,
  patch: ServerModelConfigPatch,
): Record<string, { before: unknown; after: unknown }> {
  const beforeWire = toWire(before);
  const afterWire = toWire(after);
  return Object.fromEntries(
    Object.keys(patch).map((field) => [
      field,
      {
        before: beforeWire[field as keyof typeof beforeWire],
        after: afterWire[field as keyof typeof afterWire],
      },
    ]),
  );
}

export interface ServerModelsRouteDeps {
  getCapabilities?: typeof getUserCapabilities;
  getConfig?: typeof getServerModelConfig;
  upsertConfig?: typeof upsertServerModelConfig;
  refreshConfigCache?: typeof refreshServerModelConfigCache;
  getDb?: typeof getServerDirectDb;
  getDefaults?: typeof modelConfigDefaults;
  auditEvent?: typeof audit;
  onConfigUpdated?(config: ResolvedServerModelConfig): Promise<void> | void;
  getEffectiveEmbeddingModel?: typeof effectiveEmbeddingModel;
  getActiveEmbeddingSelection?: () => string | null;
  listMediaModels?: typeof mediaGenerationModels;
  getEffectiveMediaModel?: typeof effectiveMediaGenerationModel;
}

export function serverModelsRoutes(
  app: FastifyInstance,
  overrides: ServerModelsRouteDeps = {},
): void {
  const getCapabilities = overrides.getCapabilities ?? getUserCapabilities;
  const getConfig = overrides.getConfig ?? getServerModelConfig;
  const upsertConfig = overrides.upsertConfig ?? upsertServerModelConfig;
  const refreshConfigCache = overrides.refreshConfigCache ?? refreshServerModelConfigCache;
  const getDb = overrides.getDb ?? getServerDirectDb;
  const getDefaults = overrides.getDefaults ?? modelConfigDefaults;
  const auditEvent = overrides.auditEvent ?? audit;
  const activeEmbeddingSelection = overrides.getActiveEmbeddingSelection
    ?? (() => getCachedServerModelConfigRow()?.embeddingModel ?? null);
  const listMediaModels = overrides.listMediaModels ?? mediaGenerationModels;
  const getEffectiveMediaModel = overrides.getEffectiveMediaModel ?? effectiveMediaGenerationModel;
  const wire = (config: ResolvedServerModelConfig) => ({ ...toWire(config),
    catalogModels: catalogModels(),
    effectiveEmbeddingModel: (overrides.getEffectiveEmbeddingModel ?? effectiveEmbeddingModel)(),
    embeddingSelectionPending: activeEmbeddingSelection() !== config.embeddingModel,
    embeddingModels: embeddingModels(),
    imageModels: listMediaModels("image"),
    musicModels: listMediaModels("music"),
    videoModels: listMediaModels("video"),
    effectiveImageModel: getEffectiveMediaModel("image"),
    effectiveMusicModel: getEffectiveMediaModel("music"),
    effectiveVideoModel: getEffectiveMediaModel("video"),
  });

  app.get("/api/admin/server-models", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) return reply.code(401).send({ error: "Authentication required" });
    if (!(await viewerHasCapability(userId, "read_server_settings", getCapabilities))) {
      return reply.code(403).send({ error: "admin only" });
    }
    const config = await getConfig(getDb(), getDefaults());
    // Retry reconciliation on reload; report the actual runtime snapshot even
    // when refresh retains stale state after a database failure.
    await refreshConfigCache(true);
    return reply.send(wire(config));
  });

  app.post("/api/admin/server-models", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) return reply.code(401).send({ error: "Authentication required" });
    if (!(await viewerHasCapability(userId, "manage_server_operations", getCapabilities))) {
      return reply.code(403).send({ error: "admin only" });
    }

    const parsed = parseUpdateBody(request.body, listMediaModels);
    if (!parsed.ok) return reply.code(422).send({ error: parsed.error });

    const db = getDb();
    const defaults = getDefaults();
    const before = await getConfig(db, defaults);
    const after = await upsertConfig(db, parsed.patch, defaults);

    // Make the write live for the sync consumers (default/conductor/fallback).
    await refreshConfigCache(true);

    auditEvent(request, {
      kind: "server_model_config_changed",
      actorId: userId,
      before: toWire(before),
      after: toWire(after),
      changes: auditChanges(before, after, parsed.patch),
    });

    try {
      await overrides.onConfigUpdated?.(after);
    } catch {
      warn("[server-models] live config reconciliation failed", {
        failureCode: "runtime_reconciliation_failed",
      });
    }
    return reply.send(wire(after));
  });
}
