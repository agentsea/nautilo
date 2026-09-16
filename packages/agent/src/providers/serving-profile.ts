/**
 * D462 Phase 3.2 — the initial serving vertical slice is deliberately closed.
 * Catalog/profile ids are browser-safe labels; only this trusted module turns
 * one into provider request state. Do not widen this into arbitrary model ids
 * or request-body parameters.
 */

export const FIREWORKS_KIMI_K3_MODEL_ID = "fireworks:accounts/fireworks/models/kimi-k3" as const;
export const FIREWORKS_KIMI_K3_FAST_ROUTER_ID =
  "fireworks:accounts/fireworks/routers/kimi-k3-fast" as const;

export const FIREWORKS_KIMI_K3_SERVING_PROFILE_IDS = [
  "standard",
  "priority",
  "fast",
] as const;
export type FireworksKimiK3ServingProfileId =
  (typeof FIREWORKS_KIMI_K3_SERVING_PROFILE_IDS)[number];

export interface ResolvedFireworksKimiK3ServingProfile {
  /** Stable catalog identity used by pricing and usage accounting (D462 3.4). */
  readonly canonicalModelId: typeof FIREWORKS_KIMI_K3_MODEL_ID;
  /** Actual Fireworks model/router invoked for this serving path. */
  readonly effectiveModelId:
    | typeof FIREWORKS_KIMI_K3_MODEL_ID
    | typeof FIREWORKS_KIMI_K3_FAST_ROUTER_ID;
  readonly profileId: FireworksKimiK3ServingProfileId;
  /** Only Priority has a reviewed provider request parameter. */
  readonly requestModelKwargs?: Readonly<{ readonly service_tier: "priority" }>;
}

export function isFireworksKimiK3ServingProfileId(
  value: unknown,
): value is FireworksKimiK3ServingProfileId {
  return (
    typeof value === "string" &&
    (FIREWORKS_KIMI_K3_SERVING_PROFILE_IDS as readonly string[]).includes(value)
  );
}

/**
 * Resolve a signed profile ID to the complete provider shape. A stale/malicious
 * profile and a profile applied to a different Fireworks model both fail closed
 * before a client is constructed.
 */
export function resolveFireworksKimiK3ServingProfile(
  modelId: string,
  profileId: unknown,
): ResolvedFireworksKimiK3ServingProfile {
  if (modelId !== FIREWORKS_KIMI_K3_MODEL_ID) {
    throw new Error(
      `Fireworks serving profiles are not available for model "${modelId}".`,
    );
  }
  if (!isFireworksKimiK3ServingProfileId(profileId)) {
    throw new Error(`Unsupported Fireworks Kimi K3 serving profile: ${String(profileId)}`);
  }

  switch (profileId) {
    case "standard":
      return {
        canonicalModelId: FIREWORKS_KIMI_K3_MODEL_ID,
        effectiveModelId: FIREWORKS_KIMI_K3_MODEL_ID,
        profileId,
      };
    case "priority":
      return {
        canonicalModelId: FIREWORKS_KIMI_K3_MODEL_ID,
        effectiveModelId: FIREWORKS_KIMI_K3_MODEL_ID,
        profileId,
        requestModelKwargs: { service_tier: "priority" },
      };
    case "fast":
      return {
        canonicalModelId: FIREWORKS_KIMI_K3_MODEL_ID,
        effectiveModelId: FIREWORKS_KIMI_K3_FAST_ROUTER_ID,
        profileId,
      };
  }
}
