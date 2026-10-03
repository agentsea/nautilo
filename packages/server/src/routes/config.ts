import type { FastifyInstance } from "fastify";
import type { EligibleModel, GetEligibleModelsOptions } from "@nautilo/trust";
import { z } from "zod";
import {
  getEligibleModels,
  getActiveModelCatalogProvenance,
  getDefaultImageModel,
  kickRuntimeModelCatalogRefresh,
  MAX_RETAINED_MODEL_IDS,
  resolveCatalogModel,
  resolveRetainedModels,
  resolveProviderKey,
} from "@nautilo/agent";
import { fromRuntimeConfig } from "@nautilo/config";
import {
  ModelFundingError,
  resolveModelFunding,
  type ModelFundingDecision,
} from "../lib/model-funding";

export interface ConfigRouteDeps {
  readonly getDefaultImageModel?: typeof getDefaultImageModel;
  readonly resolveProviderKey?: typeof resolveProviderKey;
  readonly getEligibleModels?: typeof getEligibleModels;
  readonly resolveCallerAvailability?: typeof resolveCallerModelAvailability;
}

export interface CallerModelAvailability {
  /** Signed-catalog and capability projection after caller funding admission. */
  readonly model: EligibleModel;
  /** Non-secret funding identity. Never serialize this from the guest catalog route. */
  readonly funding: ModelFundingDecision | null;
  /** True when the caller may select this model for the supported foreground text-chat path. */
  readonly selectableInThisRelease: boolean;
}

export interface CallerModelAvailabilityDeps {
  readonly resolveFunding?: typeof resolveModelFunding;
}

const FUNDING_UNAVAILABLE_REASON: Readonly<Record<ModelFundingError["code"], string>> = {
  personal_credentials_disabled: "personal provider credentials are disabled",
  personal_credentials_forbidden: "personal provider credentials are not permitted",
  personal_credential_missing: "a provider credential is not available for this caller",
  server_credentials_forbidden: "server provider credentials are not permitted for this caller",
  provider_credentials_missing: "provider credentials are not configured",
  personal_credential_stale: "the personal provider credential changed; retry selection",
  personal_credential_unavailable: "the personal provider credential is temporarily unavailable",
  funding_source_changed: "the admitted funding source changed; retry selection",
  unsupported_workload: "personal funding is not supported for this workload",
  unsupported_provider: "personal funding is not supported for this provider",
};

function unavailableForCaller(model: EligibleModel, reason: string): EligibleModel {
  return {
    ...model,
    enabled: false,
    availability: "missing-key",
    unavailableReason: reason,
  };
}

/**
 * Internal caller-scoped projection for foreground text chat. It composes the
 * signed catalog/capability/routing result with the server-owned funding
 * resolver. Personal projections deliberately suppress capabilities whose
 * paid execution paths are outside the supported personal text-chat slice.
 */
export async function resolveCallerModelAvailability(
  humanUserId: string,
  modelId: string,
  options: Omit<GetEligibleModelsOptions, "includeUnavailable"> = {},
  deps: CallerModelAvailabilityDeps = {},
): Promise<CallerModelAvailability> {
  const base = resolveRetainedModels([modelId], { ...options, purpose: "chat" })[0]!;
  if (base.availability !== "selectable" && base.availability !== "missing-key") {
    return { model: base, funding: null, selectableInThisRelease: false };
  }
  // Missing credentials can mask purpose qualification in the generic
  // catalogue. A caller's key must never make an image-only or other
  // non-chat model selectable for foreground text.
  const catalogModel = resolveCatalogModel(modelId, {
    ...(options.allowChinaUpstream !== undefined
      ? { allowChinaUpstream: options.allowChinaUpstream }
      : {}),
    env: {},
  });
  if (catalogModel.workload !== "chat" || !catalogModel.output.includes("text")) {
    return {
      model: {
        ...base,
        enabled: false,
        availability: "unsupported-capability",
        unavailableReason: catalogModel.output.includes("text")
          ? "model cannot be used for chat"
          : "model does not produce text",
      },
      funding: null,
      selectableInThisRelease: false,
    };
  }

  try {
    const funding = await (deps.resolveFunding ?? resolveModelFunding)({
      humanUserId,
      modelId,
      workload: "foreground_text_chat",
    });
    if (funding.kind === "server" && options.purpose === "chat-tools"
      && catalogModel.features.tools !== true) {
      return {
        model: {
          ...base,
          enabled: false,
          availability: "unsupported-capability",
          unavailableReason: catalogModel.features.tools === false
            ? "model does not support tool/function calling"
            : "tool/function calling capability is unverified",
        },
        funding: null,
        selectableInThisRelease: false,
      };
    }
    // Existing server-funded selection still requires a tool-capable chat
    // model. Personal-funded selection is the narrower text-only surface.
    const selectedBase = funding.kind === "server" && options.purpose === "chat-tools"
      ? resolveRetainedModels([modelId], options)[0]!
      : base;
    if (selectedBase.availability !== "selectable" && selectedBase.availability !== "missing-key") {
      return { model: selectedBase, funding: null, selectableInThisRelease: false };
    }
    const model: EligibleModel = {
      ...selectedBase,
      enabled: true,
      availability: "selectable",
      ...(funding.kind === "personal"
        ? {
            capabilities: {
              ...selectedBase.capabilities,
              tools: false,
              vision: false,
              webSearch: false,
            },
          }
        : {}),
    };
    delete model.unavailableReason;
    return {
      model,
      funding,
      selectableInThisRelease: true,
    };
  } catch (error) {
    const reason = error instanceof ModelFundingError
      ? FUNDING_UNAVAILABLE_REASON[error.code]
      : "model funding is temporarily unavailable";
    return {
      model: unavailableForCaller(base, reason),
      funding: null,
      selectableInThisRelease: false,
    };
  }
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

  /** Caller-funded foreground text-chat catalogue. Authentication is required
   * because availability can reveal whether this Human has usable credentials. */
  app.get("/api/config/models/caller", async (request, reply) => {
    const humanUserId = request.sessionUserId;
    if (!humanUserId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    kickRuntimeModelCatalogRefresh();
    const query = request.query as Record<string, unknown>;
    const includeUnavailable = parseBoolQuery(query["includeUnavailable"]) ?? false;
    const allowChinaUpstream = parseBoolQuery(query["allowChinaUpstream"]) ?? false;
    const listModels = deps.getEligibleModels ?? getEligibleModels;
    const resolveAvailability = deps.resolveCallerAvailability ?? resolveCallerModelAvailability;
    const candidates = listModels({
      includeUnavailable: true,
      allowChinaUpstream,
      purpose: "chat",
      // Credential availability comes from the caller funding resolver below.
      // The signed catalogue projection must not require a process-wide key.
      env: {},
    });
    const resolved = await Promise.all(
      candidates.map(async (candidate) =>
        (await resolveAvailability(
          humanUserId,
          candidate.id,
          { purpose: "chat-tools", allowChinaUpstream, env: {} },
        )).model,
      ),
    );
    return reply.send(
      includeUnavailable
        ? resolved
        : resolved.filter((model) => model.availability === "selectable"),
    );
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
