import { HumanMessage } from "@langchain/core/messages";
import { log } from "@nautilo/logger";
import { getEnabledModels, type AssistantModelConfig } from "../config/assistant-models";
import { createUniversalModel } from "../providers/universal";

export interface ModelHealth {
  modelId: string;
  healthy: boolean;
  lastChecked: Date;
  lastError?: string;
  responseTimeMs?: number;
}

/**
 * Account-isolated health scope for a decrypted personal provider credential.
 * Personal health is deliberately not cached until probes can use that exact
 * credential without crossing into the server-funded provider path.
 */
export type PersonalModelHealthScope = Readonly<{
  kind: "personal";
  humanUserId: string;
  credentialId: string;
  credentialRevision: number;
}>;

const healthCache = new Map<string, ModelHealth>();
/** Positive probe results stay fresh briefly so we do not hammer the API. */
const CACHE_TTL_MS = 60_000;
/** After invoke failures (429, timeout, etc.), skip this model in fallback until this elapses. */
const INVOKE_FAILURE_COOLDOWN_MS = 90_000;
const HEALTH_CHECK_TIMEOUT_MS = 10_000;

/**
 * Remaining process-local cooldown after a real invocation failure.
 *
 * Callers use this to avoid immediately re-entering an already unhealthy
 * model lane. Zero means the lane may make one real call as its recovery
 * probe; the provider invocation remains the authority for recovery.
 */
export function modelInvokeCooldownRemainingMs(
  modelId: string,
  nowMs = Date.now(),
  scope?: PersonalModelHealthScope,
): number {
  if (scope?.kind === "personal") return 0;
  const cached = healthCache.get(modelId);
  if (cached === undefined || cached.healthy) return 0;
  return Math.min(
    INVOKE_FAILURE_COOLDOWN_MS,
    Math.max(
      0,
      INVOKE_FAILURE_COOLDOWN_MS - (nowMs - cached.lastChecked.getTime()),
    ),
  );
}

export async function checkModelHealth(
  modelId: string,
  forceFresh = false,
  scope?: PersonalModelHealthScope,
): Promise<boolean> {
  // Never probe a personal lane through createUniversalModel without its
  // exact decrypted credential. Until personal probes are explicitly wired,
  // invocation remains the authority and no server-funded key is consulted.
  if (scope?.kind === "personal") return true;
  if (!forceFresh) {
    const cached = healthCache.get(modelId);
    if (cached) {
      const age = Date.now() - cached.lastChecked.getTime();
      const ttl = cached.healthy ? CACHE_TTL_MS : INVOKE_FAILURE_COOLDOWN_MS;
      if (age < ttl) return cached.healthy;
    }
  }

  const startTime = Date.now();
  try {
    const llm = await createUniversalModel(modelId, { maxTokens: 5, reasoningOutput: false });
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Health check timeout")), HEALTH_CHECK_TIMEOUT_MS);
    });
    await Promise.race([llm.invoke([new HumanMessage("Hi")]), timeoutPromise]);
    healthCache.set(modelId, { modelId, healthy: true, lastChecked: new Date(), responseTimeMs: Date.now() - startTime });
    log(`[model-health] ${modelId} healthy (${Date.now() - startTime}ms)`);
    return true;
  } catch (error) {
    healthCache.set(modelId, {
      modelId,
      healthy: false,
      lastChecked: new Date(),
      lastError: error instanceof Error ? error.message : String(error),
      responseTimeMs: Date.now() - startTime,
    });
    log(`[model-health] ${modelId} unhealthy: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export function isModelHealthy(
  modelId: string,
  scope?: PersonalModelHealthScope,
): boolean {
  if (scope?.kind === "personal") return true;
  const cached = healthCache.get(modelId);
  if (!cached) return true;
  return cached.healthy || modelInvokeCooldownRemainingMs(modelId) === 0;
}

/** Marks a model unhealthy for {@link INVOKE_FAILURE_COOLDOWN_MS} (e.g. after 429 or invoke timeout). */
export function markModelInvokeFailure(
  modelId: string,
  reason?: string,
  scope?: PersonalModelHealthScope,
): void {
  if (scope?.kind === "personal") return;
  const entry: ModelHealth = {
    modelId,
    healthy: false,
    lastChecked: new Date(),
  };
  if (reason !== undefined) entry.lastError = reason;
  healthCache.set(modelId, entry);
  log(`[model-health] ${modelId} invoke cooldown (${INVOKE_FAILURE_COOLDOWN_MS}ms): ${reason ?? "unknown"}`);
}

export function getHealthyModels(scope?: PersonalModelHealthScope): AssistantModelConfig[] {
  return getEnabledModels().filter((m) => isModelHealthy(m.id, scope));
}

export function clearHealthCache(scope?: PersonalModelHealthScope): void {
  if (scope?.kind === "personal") return;
  healthCache.clear();
}
