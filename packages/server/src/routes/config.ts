import type { FastifyInstance } from "fastify";
import type { GetEligibleModelsOptions } from "@nautilo/trust";
import { z } from "zod";
import {
  getEligibleModels,
  getActiveModelCatalogProvenance,
  getDefaultImageModel,
  kickRuntimeModelCatalogRefresh,
  MAX_RETAINED_MODEL_IDS,
  resolveRetainedModels,
  resolveProviderKey,
} from "@nautilo/agent";
import { fromRuntimeConfig } from "@nautilo/config";

export interface ConfigRouteDeps {
  readonly getDefaultImageModel?: typeof getDefaultImageModel;
  readonly resolveProviderKey?: typeof resolveProviderKey;
}

/**
 * Whether the currently selected image-generation model can be used locally.
 * This is deliberately configuration-only: it never probes a provider or
 * exposes the selected provider or credential state to callers.
 */
function avatarGenerationAvailable(deps: ConfigRouteDeps = {}): boolean {
  const getImageModel = deps.getDefaultImageModel ?? getDefaultImageModel;
  const providerKey = deps.resolveProviderKey ?? resolveProviderKey;
  try {
    const model = getImageModel();
    return providerKey(model.provider, {}) !== null;
  } catch {
    return false;
  }
}

/** Parses `?flag=true` / `1` style query params; unknown strings yield `undefined`. */
function parseBoolQuery(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  let candidate: unknown;
  if (Array.isArray(value)) {
    candidate = value[0];
  } else {
    candidate = value;
  }
  if (typeof candidate !== "string") return undefined;
  const s = candidate.trim().toLowerCase();
  if (s === "1" || s === "true" || s === "yes") return true;
  if (s === "0" || s === "false" || s === "no") return false;
  return undefined;
}

function eligibleModelsOptionsFromQuery(query: Record<string, unknown>): GetEligibleModelsOptions {
  const purpose = z
    .enum(["chat", "chat-tools", "vision", "vision-tools", "image-generation", "embeddings", "task-tool-free", "task-tools"])
    .safeParse(query["purpose"]);
  return {
    includeUnavailable: parseBoolQuery(query["includeUnavailable"]) ?? false,
    allowChinaUpstream: parseBoolQuery(query["allowChinaUpstream"]) ?? false,
    ...(purpose.success ? { purpose: purpose.data } : {}),
  };
}

const retainedModelsBodySchema = z
  .object({
    ids: z.array(z.string().trim().min(1).max(512)).max(MAX_RETAINED_MODEL_IDS),
    purpose: z
      .enum(["chat", "chat-tools", "vision", "vision-tools", "image-generation", "embeddings", "task-tool-free", "task-tools"])
      .optional(),
    allowChinaUpstream: z.boolean().optional(),
  })
  .strict();

export function configRoutes(app: FastifyInstance, deps: ConfigRouteDeps = {}) {
  /** Catalog + eligibility metadata only — no secrets. Same guest-access pattern as before D086 (preHandler sets guest context when no Bearer). */
  app.get("/api/config/models", async (request, reply) => {
    // D429 Phase 7 — kick a non-blocking background refresh so newly published
    // supported rows appear without a server restart. The response uses the
    // current atomic in-memory snapshot; no caller awaits a network request.
    kickRuntimeModelCatalogRefresh();
    const models = getEligibleModels(eligibleModelsOptionsFromQuery(request.query as Record<string, unknown>));
    return reply.send(models);
  });

  app.post("/api/config/models/resolve", async (request, reply) => {
    const parsed = retainedModelsBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: `invalid retained model request (maximum ${MAX_RETAINED_MODEL_IDS} ids)`,
      });
    }
    kickRuntimeModelCatalogRefresh();
    return reply.send(
      resolveRetainedModels(parsed.data.ids, {
        ...(parsed.data.purpose ? { purpose: parsed.data.purpose } : {}),
        ...(parsed.data.allowChinaUpstream === undefined
          ? {}
          : { allowChinaUpstream: parsed.data.allowChinaUpstream }),
      }),
    );
  });

  /**
   * D429 Phase 7 — non-secret catalog provenance diagnostics. Exposes only the
   * source (remote-fresh / remote-stale / checked-in-fallback), staleness, and
   * catalogVersion. The raw pointer/manifest URL, host, headers, signing keys,
   * and provider credentials are never represented here.
   */
  app.get("/api/config/catalog-provenance", async (_request, reply) => {
    kickRuntimeModelCatalogRefresh();
    return reply.send(getActiveModelCatalogProvenance());
  });

  app.get("/api/config/setup-flags", async (_request, reply) => {
    const config = fromRuntimeConfig();
    return reply.send({
      motherEasterEgg: config.nautilo_soul_mother_easter_egg,
      avatarGenAvail: avatarGenerationAvailable(deps),
    });
  });
}
