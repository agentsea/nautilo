import {
  candidatesForModelRole,
  type ModelRole,
} from "@nautilo/config";
import type { ModelPurpose } from "@nautilo/trust";
import { assertModelRunnable, getEligibleModels } from "./eligible-models";
import {
  managedGatewayKeyIsPresent,
  managedGatewayTransportIsRunnable,
  resolveOpenRouterTransport,
} from "../providers/openrouter-transport";

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
  visionFallback: "vision",
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
  const managedGatewayApplies = role !== "imageGeneration";
  const availabilityEnv = role === "imageGeneration"
    ? {
        ...env,
        NAUTILO_MANAGED_GATEWAY_API_KEY: undefined,
        NAUTILO_MANAGED_GATEWAY_BASE_URL: undefined,
      }
    : options.env;
  const availabilityOptions = {
    purpose,
    ...(availabilityEnv === undefined ? {} : { env: availabilityEnv }),
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
    if (managedGatewayApplies && configured.startsWith("openrouter:") && managedGatewayKeyIsPresent(env)) {
      resolveOpenRouterTransport({ env });
    }
    assertModelRunnable(configured, availabilityOptions);
    return configured;
  }

  // Automatic selection is Gateway-first when the operator configured a
  // managed key. A malformed managed configuration is an explicit error,
  // rather than permission to spend against unrelated BYOK credentials.
  const autoEmbeddingUsesOpenRouter = role === "embeddings"
    && !env["VENICE_API_KEY"]?.trim()
    && (!!env["OPENROUTER_API_KEY"]?.trim() || !env["OPENAI_API_KEY"]?.trim());
  if (
    managedGatewayApplies
    && managedGatewayKeyIsPresent(env)
    && (role !== "embeddings" || autoEmbeddingUsesOpenRouter)
  ) {
    resolveOpenRouterTransport({ env });
  }

  const eligible = getEligibleModels(availabilityOptions);
  const runnable = new Set(eligible
    .filter((model) => role !== "imageGeneration"
      || model.provider !== "openrouter"
      || !!env["OPENROUTER_API_KEY"]?.trim())
    .map((model) => model.id));
  const candidates = candidatesForModelRole(role);
  let orderedCandidates = candidates;
  if (managedGatewayApplies && managedGatewayTransportIsRunnable(env)) {
    if (role === "embeddings") {
      const legacyPrefixes = [
        env["VENICE_API_KEY"]?.trim() ? "venice:" : null,
        env["OPENROUTER_API_KEY"]?.trim() ? "openrouter:" : null,
        env["OPENAI_API_KEY"]?.trim() ? "openai:" : null,
      ].filter((prefix): prefix is string => prefix !== null);
      orderedCandidates = legacyPrefixes.length > 0
        ? [
            ...legacyPrefixes.flatMap((prefix) => candidates.filter((id) => id.startsWith(prefix))),
            ...candidates.filter((id) => !legacyPrefixes.some((prefix) => id.startsWith(prefix))),
          ]
        : [
            ...candidates.filter((id) => id.startsWith("openrouter:")),
            ...candidates.filter((id) => !id.startsWith("openrouter:")),
          ];
    } else {
      orderedCandidates = [
        ...candidates.filter((id) => id.startsWith("openrouter:")),
        ...candidates.filter((id) => !id.startsWith("openrouter:")),
      ];
    }
  }
  const candidate = orderedCandidates.find((id) => runnable.has(id));
  if (candidate) return candidate;
  // Search preferences are an ordering, not an allowlist of providers. Reuse
  // signed catalogue priority after the curated preferences are exhausted.
  const isResearch = role === "webSearchSynthesis" || role.startsWith("deepResearch");
  if (isResearch && eligible[0]) return eligible[0].id;
  throw new NoRunnableModelForRoleError(role);
}
