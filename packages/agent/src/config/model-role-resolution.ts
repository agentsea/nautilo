import {
  candidatesForModelRole,
  type ModelRole,
} from "@nautilo/config";
import type { ModelPurpose } from "@nautilo/trust";
import { getCachedServerModelConfigRow } from "@nautilo/db";
import {
  assertModelRunnable,
  getEligibleModels,
  ModelUnavailableError,
} from "./eligible-models";
import { resolveProviderKey } from "../resolve-provider-key";
import {
  resolveSurplusChatServingAvailability,
  type QualifiedSurplusChatRoute,
} from "../providers/surplus-route";

const PURPOSE_BY_ROLE: Readonly<Record<ModelRole, ModelPurpose>> = {
  chat: "chat-tools",
  conductor: "chat",
  stenographer: "chat",
  sessionSearch: "chat",
  memoryFlush: "chat-tools",
  memoryReview: "chat-tools",
  webSearchSynthesis: "chat",
  systemTasks: "chat-tools",
  deepResearchSupervisor: "chat-tools",
  deepResearchResearcher: "chat-tools",
  deepResearchSynthesis: "chat",
  deepResearchFinalReport: "chat",
  embeddings: "embeddings",
  imageGeneration: "image-generation",
};

export class NoRunnableModelForRoleError extends Error {
  readonly code = "no_runnable_model_for_role" as const;

  constructor(readonly role: ModelRole) {
    super(`No signed, credentialed model is runnable for the ${role} role.`);
    this.name = "NoRunnableModelForRoleError";
  }
}

export interface ResolveModelRoleOptions {
  /** Explicit environment/server/user choice. It is never silently replaced. */
  configuredId?: string | null;
  env?: NodeJS.ProcessEnv;
  allowChinaUpstream?: boolean;
  /** Explicit server-funded lane. Omission preserves direct-only resolution. */
  serverSurplus?: {
    readonly policyEnabled?: boolean;
    readonly keyConfigured?: boolean;
    readonly routes?: readonly QualifiedSurplusChatRoute[];
  };
}

function isServerSurplusRunnable(
  modelId: string,
  purpose: ModelPurpose,
  options: ResolveModelRoleOptions,
): boolean {
  if (options.serverSurplus === undefined || purpose === "embeddings" || purpose === "image-generation") {
    return false;
  }
  const policyEnabled = options.serverSurplus.policyEnabled
    ?? getCachedServerModelConfigRow()?.preferSurplus === true;
  const keyConfigured = options.serverSurplus.keyConfigured
    ?? (options.env === undefined
      ? resolveProviderKey("surplus") !== null
      : Boolean(options.env["SURPLUS_API_KEY"]?.trim()));
  const availability = resolveSurplusChatServingAvailability({
    catalogModelId: modelId,
    policyEnabled,
    keyConfigured,
    fundingKind: "server",
    ...(options.serverSurplus.routes === undefined
      ? {}
      : { routes: options.serverSurplus.routes }),
  });
  return availability.status === "available"
    && (!(purpose === "chat-tools" || purpose === "vision-tools" || purpose === "task-tools")
      || availability.route.supportsTools);
}

/**
 * Return an ID solely for capability projection after selection has already
 * happened elsewhere. This deliberately does not claim the built-in candidate
 * is runnable; callers must never use it to start a provider request.
 */
export function modelIdForCapabilityProjection(
  role: ModelRole,
  configuredId?: string | null,
): string {
  const configured = configuredId?.trim();
  if (configured) return configured;
  const candidate = candidatesForModelRole(role)[0];
  if (!candidate) throw new Error(`Model role "${role}" has no built-in candidates.`);
  return candidate;
}

/**
 * Preserve explicit authority, otherwise choose the first runnable built-in
 * candidate. This is the sole automatic substitution policy.
 */
export function resolveModelRole(
  role: ModelRole,
  options: ResolveModelRoleOptions = {},
): string {
  const purpose = PURPOSE_BY_ROLE[role];
  const configured = options.configuredId?.trim() ?? "";
  const env = options.env ?? process.env;
  const availabilityOptions = {
    purpose,
    ...(options.env === undefined ? {} : { env }),
    ...(options.allowChinaUpstream === undefined
      ? {}
      : { allowChinaUpstream: options.allowChinaUpstream }),
  } as const;
  if (configured) {
    if (role === "imageGeneration"
      && configured.startsWith("openrouter:")
      && !env["OPENROUTER_API_KEY"]?.trim()) {
      throw new Error("The configured OpenRouter image model requires an OpenRouter credential.");
    }
    try {
      assertModelRunnable(configured, availabilityOptions);
    } catch (error) {
      if (!(error instanceof ModelUnavailableError)
        || error.availability !== "missing-key"
        || !isServerSurplusRunnable(configured, purpose, options)) throw error;
    }
    return configured;
  }

  const eligible = getEligibleModels({ ...availabilityOptions, includeUnavailable: true });
  const runnable = new Set(eligible
    .filter((model) => model.availability === "selectable"
      || (model.availability === "missing-key"
        && isServerSurplusRunnable(model.id, purpose, options)))
    .filter((model) => role !== "imageGeneration"
      || model.provider !== "openrouter"
      || !!env["OPENROUTER_API_KEY"]?.trim())
    .map((model) => model.id));
  const candidates = candidatesForModelRole(role);
  const candidate = candidates.find((id) => runnable.has(id));
  if (candidate) return candidate;
  // Search preferences are an ordering, not an allowlist of providers. Reuse
  // signed catalogue priority after the curated preferences are exhausted.
  const isResearch = role === "webSearchSynthesis" || role.startsWith("deepResearch");
  if (isResearch) {
    const first = eligible.find((model) => runnable.has(model.id));
    if (first) return first.id;
  }
  throw new NoRunnableModelForRoleError(role);
}
