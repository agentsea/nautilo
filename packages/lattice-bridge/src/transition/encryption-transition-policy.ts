export const ENCRYPTION_TRANSITION_MODES = Object.freeze([
  "plaintext_only",
  "shadow_encryption",
  "encrypted_only",
] as const);

export type EncryptionTransitionMode =
  typeof ENCRYPTION_TRANSITION_MODES[number];

export const LIVE_SHADOW_SELECTABLE_ENCRYPTION_TRANSITION_MODES = Object.freeze([
  "plaintext_only",
  "shadow_encryption",
  "encrypted_only",
] as const satisfies readonly EncryptionTransitionMode[]);

export type LiveShadowSelectableEncryptionTransitionMode =
  typeof LIVE_SHADOW_SELECTABLE_ENCRYPTION_TRANSITION_MODES[number];

export const LIVE_SHADOW_ENCRYPTION_TRANSITION_BEHAVIORS = Object.freeze([
  "fallback",
  "strict",
] as const);
export type LiveShadowEncryptionTransitionBehavior =
  typeof LIVE_SHADOW_ENCRYPTION_TRANSITION_BEHAVIORS[number];

export type EncryptionTransitionPolicy = Readonly<{
  mode: EncryptionTransitionMode;
  /** Omitted only by legacy in-process callers; selection defaults it safely. */
  shadowBehavior?: LiveShadowEncryptionTransitionBehavior;
}>;

export type LiveShadowEncryptionTransitionPolicy = Readonly<{
  mode: LiveShadowSelectableEncryptionTransitionMode;
  shadowBehavior: LiveShadowEncryptionTransitionBehavior;
}>;

export type LiveEncryptionRepresentationPolicy = Readonly<{
  read: "ordinary_only" | "protected_first" | "protected_only";
  write: "ordinary_only" | "ordinary_and_protected" | "protected_only";
  /** Permission after an unsuccessful protected attempt, never authorization. */
  allowOrdinaryFallback: boolean;
  allowOrdinaryLoader: boolean;
  allowProtectedCrypto: boolean;
  allowForwardRepair: boolean;
  allowReverseRepair: boolean;
}>;

export type LiveShadowEncryptionTransitionPolicySelectionResult =
  | Readonly<{ ok: true; value: LiveShadowEncryptionTransitionPolicy }>
  | Readonly<{
    ok: false;
    reason: "invalid_policy";
    error: string;
  }>;

/** Data-only representation boundary derived from the canonical live mode. */
export function selectLiveEncryptionRepresentationPolicy(
  policy: LiveShadowEncryptionTransitionPolicy,
): LiveEncryptionRepresentationPolicy {
  switch (policy.mode) {
    case "plaintext_only":
      return Object.freeze({
        read: "ordinary_only",
        write: "ordinary_only",
        allowOrdinaryFallback: false,
        allowOrdinaryLoader: true,
        allowProtectedCrypto: false,
        allowForwardRepair: false,
        allowReverseRepair: false,
      });
    case "shadow_encryption":
      return Object.freeze({
        read: "protected_first",
        write: "ordinary_and_protected",
        allowOrdinaryFallback: policy.shadowBehavior === "fallback",
        allowOrdinaryLoader: true,
        allowProtectedCrypto: true,
        allowForwardRepair: true,
        allowReverseRepair: true,
      });
    case "encrypted_only":
      return Object.freeze({
        read: "protected_only",
        write: "protected_only",
        allowOrdinaryFallback: false,
        allowOrdinaryLoader: false,
        allowProtectedCrypto: true,
        allowForwardRepair: false,
        allowReverseRepair: false,
      });
  }
}

function isEncryptionTransitionMode(
  value: unknown,
): value is EncryptionTransitionMode {
  return typeof value === "string"
    && ENCRYPTION_TRANSITION_MODES.includes(value as EncryptionTransitionMode);
}

/** Production live-Shadow policy selector. Audit tooling observes this boundary. */
export function selectLiveShadowEncryptionTransitionPolicy(
  input: unknown,
): LiveShadowEncryptionTransitionPolicySelectionResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {
      ok: false,
      reason: "invalid_policy",
      error: "Encryption transition policy must be an object",
    };
  }
  const record = input as Record<string, unknown>;
  const unsupported = Object.keys(record)
    .filter((key) => key !== "mode" && key !== "shadowBehavior")
    .sort();
  if (unsupported.length > 0 || !isEncryptionTransitionMode(record["mode"])) {
    return {
      ok: false,
      reason: "invalid_policy",
      error: "Encryption transition policy is malformed",
    };
  }
  const shadowBehavior = record["shadowBehavior"] ?? "fallback";
  if (
    typeof shadowBehavior !== "string"
    || !LIVE_SHADOW_ENCRYPTION_TRANSITION_BEHAVIORS.includes(
      shadowBehavior as LiveShadowEncryptionTransitionBehavior,
    )
    || (record["mode"] === "plaintext_only" && shadowBehavior !== "fallback")
  ) {
    return {
      ok: false,
      reason: "invalid_policy",
      error: "Encryption transition Shadow behavior is malformed",
    };
  }
  return {
    ok: true,
    value: Object.freeze({
      mode: record["mode"],
      shadowBehavior: shadowBehavior as LiveShadowEncryptionTransitionBehavior,
    }),
  };
}
