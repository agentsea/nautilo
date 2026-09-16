import { evaluatePreMutation, type PreMutationEvaluation } from "./pre-mutation";
import {
  HOSTING_CAPABILITIES,
  type CapabilityEnhancement,
  type CapabilityExperience,
  type CapabilityStatus,
  type HostingCapability,
  type InfrastructureState,
} from "./types";

/**
 * Provider IDs mirrored from config-guard's current KEY_REGISTRY. Keeping the
 * list closed makes unknown config input visible instead of silently treating
 * an arbitrary environment variable as a deployable provider credential.
 */
export const HOSTING_PROVIDER_ENV_VARS = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  gateway: "NAUTILO_GATEWAY_API_KEY",
  google: "GOOGLE_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  venice: "VENICE_API_KEY",
  elevenlabs: "ELEVENLABS_API_KEY",
  groq: "GROQ_API_KEY",
  tavily: "TAVILY_API_KEY",
  "browser-use": "BROWSER_USE_API_KEY",
  cloudconvert: "CLOUDCONVERT_API_KEY",
} as const;

export type HostingProvider = keyof typeof HOSTING_PROVIDER_ENV_VARS;
export const HOSTING_PROVIDERS: readonly HostingProvider[] = Object.keys(HOSTING_PROVIDER_ENV_VARS) as HostingProvider[];

export type ProviderCredentialSourceKind = "environment" | "documented-config";

/**
 * A caller-resolved credential reference. It deliberately contains neither a
 * value nor a filesystem path. Parsing env/config files belongs to the caller;
 * this package only plans over its redacted result.
 */
export interface ProviderCredentialReference {
  readonly provider: HostingProvider;
  readonly source: ProviderCredentialSourceKind;
  readonly state: "configured" | "invalid";
}

export interface ProviderSelectionInput {
  readonly references: readonly ProviderCredentialReference[];
  /** Implements `--all-providers`: all recognized configured references only. */
  readonly allProviders: boolean;
  /** Implements repeatable `--include-provider`; unknown strings fail visibly. */
  readonly includeProviders?: readonly string[] | undefined;
  /** Exclusion wins over both all-providers and explicit inclusion. */
  readonly excludeProviders?: readonly string[] | undefined;
  /**
   * Baselines already qualified by runtime/integration evidence outside this
   * resolver. This prevents provider selection from inventing browser/device or
   * future OpenRouter search/voice coverage.
   */
  readonly qualifiedBaselineCapabilities?: readonly HostingCapability[] | undefined;
  readonly infrastructure: InfrastructureState;
  readonly coreDegradedConsent: boolean;
}

export type ProviderSelectionState =
  | "configured"
  | "invalid"
  | "missing"
  | "excluded"
  | "not-selected";

export interface ProviderSelectionStatus {
  readonly provider: HostingProvider;
  readonly name: string;
  readonly state: ProviderSelectionState;
  readonly selected: boolean;
  readonly source?: ProviderCredentialSourceKind | undefined;
  readonly capabilities: readonly HostingCapability[];
}

export type ProviderSelectionIssueCode =
  | "provider.unsupported-reference"
  | "provider.duplicate-reference"
  | "provider.unsupported-selection"
  | "provider.missing-credential"
  | "provider.invalid-credential"
  | "provider.invalid-baseline";

/** Unknown caller text and validation details are intentionally never echoed. */
export interface ProviderSelectionIssue {
  readonly code: ProviderSelectionIssueCode;
  readonly provider?: HostingProvider | undefined;
  readonly count?: number | undefined;
}

export interface ProviderCapabilityPlan {
  readonly providers: readonly ProviderSelectionStatus[];
  readonly capabilities: readonly CapabilityStatus[];
  readonly readiness: PreMutationEvaluation;
  readonly issues: readonly ProviderSelectionIssue[];
}

interface ProviderDefinition {
  readonly provider: HostingProvider;
  readonly name: string;
  readonly coverage: Readonly<Partial<Record<HostingCapability, "baseline" | "enhanced">>>;
}

/**
 * Current, code-grounded coverage only. OpenRouter and Venice support chat and
 * qualified memory embeddings, but not search/TTS/STT.
 * CloudConvert is recognized for selection but is not a V0 core capability.
 */
const PROVIDER_DEFINITIONS: readonly ProviderDefinition[] = [
  { provider: "anthropic", name: "Anthropic", coverage: { chat: "baseline" } },
  { provider: "openai", name: "OpenAI", coverage: { chat: "baseline", embeddings: "baseline" } },
  { provider: "openrouter", name: "OpenRouter", coverage: { chat: "baseline", embeddings: "baseline" } },
  { provider: "gateway", name: "OpenAI-Compatible Gateway", coverage: { chat: "baseline" } },
  { provider: "google", name: "Google", coverage: { chat: "baseline" } },
  { provider: "fireworks", name: "Fireworks", coverage: { chat: "baseline" } },
  { provider: "venice", name: "Venice", coverage: { chat: "baseline", embeddings: "baseline" } },
  { provider: "elevenlabs", name: "ElevenLabs", coverage: { tts: "enhanced", stt: "enhanced" } },
  { provider: "groq", name: "Groq", coverage: { stt: "baseline" } },
  { provider: "tavily", name: "Tavily", coverage: { search: "enhanced" } },
  // Browser automation is not a substitute for the dedicated search capability.
  { provider: "browser-use", name: "Browser Use", coverage: {} },
  { provider: "cloudconvert", name: "CloudConvert", coverage: {} },
];

const definitionByProvider = new Map(
  PROVIDER_DEFINITIONS.map((definition) => [definition.provider, definition] as const),
);
const providerSet = new Set<string>(HOSTING_PROVIDERS);
const capabilitySet = new Set<string>(HOSTING_CAPABILITIES);
const repairTarget = { kind: "admin-providers" } as const;

function isHostingProvider(value: unknown): value is HostingProvider {
  return typeof value === "string" && providerSet.has(value);
}

function isHostingCapability(value: unknown): value is HostingCapability {
  return typeof value === "string" && capabilitySet.has(value);
}

function uniqueKnownProviders(values: readonly string[]): {
  readonly known: ReadonlySet<HostingProvider>;
  readonly unsupportedCount: number;
} {
  const known = new Set<HostingProvider>();
  let unsupportedCount = 0;
  for (const value of values) {
    if (isHostingProvider(value)) known.add(value);
    else unsupportedCount += 1;
  }
  return { known, unsupportedCount };
}

function providerCapabilities(definition: ProviderDefinition): readonly HostingCapability[] {
  return HOSTING_CAPABILITIES.filter((capability) => definition.coverage[capability] !== undefined);
}

function capabilityImpact(
  capability: HostingCapability,
  experience: CapabilityExperience,
): string {
  if (experience === "invalid") return `${capability} has only an invalid selected credential.`;
  if (experience === "unavailable") return `${capability} is unavailable with the selected qualified providers.`;
  if (experience === "enhanced") return `${capability} has an enhanced provider.`;
  return `${capability} has a qualified baseline provider.`;
}

function enhancementFor(
  capability: HostingCapability,
  providers: readonly ProviderSelectionStatus[],
): CapabilityEnhancement | undefined {
  const provider = capability === "search" ? "tavily" : capability === "tts" ? "elevenlabs" : undefined;
  if (provider === undefined) return undefined;
  const selection = providers.find((candidate) => candidate.provider === provider);
  const availability = selection?.state === "invalid" ? "invalid" : "absent";
  const feature = provider === "tavily" ? "dedicated research/search" : "premium voice";
  return {
    provider,
    availability,
    impact: `${selection?.name ?? provider} is ${availability}; ${feature} is unavailable while the qualified baseline remains usable.`,
    repairTarget: { ...repairTarget, capability },
  };
}

function buildCapabilities(
  providers: readonly ProviderSelectionStatus[],
  qualifiedBaselines: ReadonlySet<HostingCapability>,
): readonly CapabilityStatus[] {
  return HOSTING_CAPABILITIES.map((capability): CapabilityStatus => {
    const configuredCoverage = providers.flatMap((selection) => {
      if (!selection.selected || selection.state !== "configured") return [];
      const coverage = definitionByProvider.get(selection.provider)?.coverage[capability];
      return coverage === undefined ? [] : [coverage];
    });
    const hasInvalidCoverage = providers.some((selection) =>
      selection.selected &&
      selection.state === "invalid" &&
      definitionByProvider.get(selection.provider)?.coverage[capability] !== undefined,
    );

    const experience: CapabilityExperience = configuredCoverage.includes("enhanced")
      ? "enhanced"
      : configuredCoverage.includes("baseline") || qualifiedBaselines.has(capability)
        ? "baseline"
        : hasInvalidCoverage
          ? "invalid"
          : "unavailable";
    const enhancement = experience === "baseline"
      ? enhancementFor(capability, providers)
      : undefined;

    return {
      capability,
      experience,
      impact: capabilityImpact(capability, experience),
      repairTarget: { ...repairTarget, capability },
      ...(enhancement === undefined ? {} : { enhancement }),
    };
  });
}

/**
 * Deterministically resolves caller-supplied, already-redacted credential
 * references into provider selection and capability readiness. It performs no
 * file/env reads and never returns caller strings other than recognized IDs.
 */
export function resolveProviderCapabilities(
  input: ProviderSelectionInput,
): ProviderCapabilityPlan {
  const issues: ProviderSelectionIssue[] = [];
  const references = new Map<HostingProvider, ProviderCredentialReference>();
  const invalidReferences = new Set<HostingProvider>();
  const seenReferences = new Set<HostingProvider>();
  const reportedDuplicateReferences = new Set<HostingProvider>();
  let unsupportedReferenceCount = 0;

  for (const candidate of input.references as readonly unknown[]) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      !("provider" in candidate) ||
      !isHostingProvider(candidate.provider)
    ) {
      unsupportedReferenceCount += 1;
      continue;
    }
    const reference = candidate as ProviderCredentialReference;
    if (seenReferences.has(reference.provider)) {
      references.delete(reference.provider);
      invalidReferences.add(reference.provider);
      if (!reportedDuplicateReferences.has(reference.provider)) {
        reportedDuplicateReferences.add(reference.provider);
        issues.push({ code: "provider.duplicate-reference", provider: reference.provider });
      }
      continue;
    }
    seenReferences.add(reference.provider);
    if (
      (reference.source !== "environment" && reference.source !== "documented-config") ||
      (reference.state !== "configured" && reference.state !== "invalid")
    ) {
      issues.push({ code: "provider.invalid-credential", provider: reference.provider });
      invalidReferences.add(reference.provider);
      continue;
    }
    references.set(reference.provider, reference);
  }
  if (unsupportedReferenceCount > 0) {
    issues.push({ code: "provider.unsupported-reference", count: unsupportedReferenceCount });
  }

  const included = uniqueKnownProviders(input.includeProviders ?? []);
  const excluded = uniqueKnownProviders(input.excludeProviders ?? []);
  const unsupportedSelectionCount = included.unsupportedCount + excluded.unsupportedCount;
  if (unsupportedSelectionCount > 0) {
    issues.push({ code: "provider.unsupported-selection", count: unsupportedSelectionCount });
  }

  const selected = new Set<HostingProvider>();
  if (input.allProviders) {
    for (const provider of references.keys()) selected.add(provider);
    for (const provider of invalidReferences) selected.add(provider);
  }
  for (const provider of included.known) selected.add(provider);
  for (const provider of excluded.known) selected.delete(provider);

  const providers = PROVIDER_DEFINITIONS.map((definition): ProviderSelectionStatus => {
    const reference = references.get(definition.provider);
    const isExcluded = excluded.known.has(definition.provider) &&
      (input.allProviders || included.known.has(definition.provider) || reference !== undefined || invalidReferences.has(definition.provider));
    const isSelected = selected.has(definition.provider);
    let state: ProviderSelectionState = "not-selected";
    if (isExcluded) state = "excluded";
    else if (isSelected && invalidReferences.has(definition.provider)) state = "invalid";
    else if (isSelected && reference === undefined) state = "missing";
    else if (isSelected && reference?.state === "invalid") state = "invalid";
    else if (isSelected) state = "configured";

    if (state === "missing") {
      issues.push({ code: "provider.missing-credential", provider: definition.provider });
    } else if (state === "invalid" && !invalidReferences.has(definition.provider)) {
      issues.push({ code: "provider.invalid-credential", provider: definition.provider });
    }

    return {
      provider: definition.provider,
      name: definition.name,
      state,
      selected: isSelected,
      ...(isSelected && reference !== undefined ? { source: reference.source } : {}),
      capabilities: providerCapabilities(definition),
    };
  });

  const qualifiedBaselines = new Set<HostingCapability>();
  let invalidBaselineCount = 0;
  for (const capability of input.qualifiedBaselineCapabilities ?? []) {
    if (isHostingCapability(capability)) qualifiedBaselines.add(capability);
    else invalidBaselineCount += 1;
  }
  if (invalidBaselineCount > 0) {
    issues.push({ code: "provider.invalid-baseline", count: invalidBaselineCount });
  }

  const capabilities = buildCapabilities(providers, qualifiedBaselines);
  const readiness = evaluatePreMutation({
    infrastructure: input.infrastructure,
    capabilities,
    coreDegradedConsent: input.coreDegradedConsent,
  });

  issues.sort((left, right) =>
    left.code.localeCompare(right.code) ||
    (left.provider ?? "").localeCompare(right.provider ?? "") ||
    (left.count ?? 0) - (right.count ?? 0),
  );

  return { providers, capabilities, readiness, issues };
}
