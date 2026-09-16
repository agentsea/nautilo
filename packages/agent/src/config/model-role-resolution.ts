import {
  candidatesForModelRole,
  type ModelRole,
} from "@nautilo/config";
import type { ModelPurpose } from "@nautilo/trust";
import { assertModelRunnable, getEligibleModels } from "./eligible-models";

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
  const availabilityOptions = {
    purpose,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.allowChinaUpstream === undefined
      ? {}
      : { allowChinaUpstream: options.allowChinaUpstream }),
  } as const;
  if (configured) {
    assertModelRunnable(configured, availabilityOptions);
    return configured;
  }

  const eligible = getEligibleModels(availabilityOptions);
  const runnable = new Set(eligible.map((model) => model.id));
  const candidate = candidatesForModelRole(role).find((id) => runnable.has(id));
  if (candidate) return candidate;
  // Search preferences are an ordering, not an allowlist of providers. Reuse
  // signed catalogue priority after the curated preferences are exhausted.
  const isResearch = role === "webSearchSynthesis" || role.startsWith("deepResearch");
  if (isResearch && eligible[0]) return eligible[0].id;
  throw new NoRunnableModelForRoleError(role);
}
