export const PERSONAL_CAPABILITY_ROLES = [
  "webSearchSynthesis",
  "deepResearchSupervisor",
  "deepResearchResearcher",
  "deepResearchSummarization",
  "deepResearchCompression",
  "deepResearchFinalReport",
  "decision",
] as const;

export type PersonalCapabilityRole =
  (typeof PERSONAL_CAPABILITY_ROLES)[number];

/**
 * Sparse Human-owned choices. An absent key means inherit the current
 * execution owner's choice; server defaults are never copied into this map.
 */
export type PersonalCapabilityPreferenceOverrides = Partial<
  Record<PersonalCapabilityRole, string | undefined>
>;

export interface PersonalCapabilityPreferences {
  readonly revision: number;
  readonly overrides: PersonalCapabilityPreferenceOverrides;
}

export type PersonalCapabilityPreferenceSource = "inherited" | "personal";

export type PersonalCapabilityReadinessStatus =
  | "ready"
  | "missing-credentials"
  | "unavailable";

export type PersonalCapabilityFundingSource = "personal" | "server";
export type PersonalCapabilityFundingPreference = "personal_first" | "server_first";

export interface PersonalCapabilityModelReadiness {
  readonly status: PersonalCapabilityReadinessStatus;
  readonly reason: string | null;
  readonly fundingSource: PersonalCapabilityFundingSource | null;
  readonly providerRoute: string | null;
}

export interface PersonalCapabilityModelOption {
  readonly modelId: string;
  readonly displayName: string;
  readonly provider: string;
  readonly readiness: PersonalCapabilityModelReadiness;
}

export interface PersonalCapabilityPreferenceProjection {
  readonly role: PersonalCapabilityRole;
  readonly label: string;
  readonly description: string;
  readonly selection: {
    readonly source: PersonalCapabilityPreferenceSource;
    /** Null means the inherited automatic selector is currently unresolved. */
    readonly modelId: string | null;
    readonly displayName: string;
  };
  readonly readiness: PersonalCapabilityModelReadiness;
  readonly options: readonly PersonalCapabilityModelOption[];
}

export interface PersonalCapabilityPreferencesResponse
  extends PersonalCapabilityPreferences {
  readonly fundingPreference: PersonalCapabilityFundingPreference;
  readonly capabilities: readonly PersonalCapabilityPreferenceProjection[];
}

export interface ReplacePersonalCapabilityPreferencesRequest {
  readonly expectedRevision: number;
  /** Full sparse replacement. Omitting a role explicitly resets inheritance. */
  readonly overrides: PersonalCapabilityPreferenceOverrides;
}

export function isPersonalCapabilityRole(
  value: unknown,
): value is PersonalCapabilityRole {
  return typeof value === "string"
    && (PERSONAL_CAPABILITY_ROLES as readonly string[]).includes(value);
}

export function parsePersonalCapabilityPreferenceOverrides(
  value: unknown,
): PersonalCapabilityPreferenceOverrides | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const parsed: PersonalCapabilityPreferenceOverrides = {};
  for (const [role, modelId] of Object.entries(value)) {
    if (!isPersonalCapabilityRole(role)
      || typeof modelId !== "string"
      || modelId.trim().length === 0
      || modelId.length > 512) {
      return null;
    }
    parsed[role] = modelId.trim();
  }
  return parsed;
}
