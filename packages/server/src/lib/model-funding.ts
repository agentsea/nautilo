import {
  modelHasRunnableCredentials,
  PersonalDirectFundingUnavailableError,
  PersonalModelFundingUnavailableError,
  resolveProviderKey,
  resolveOpenRouterTransport,
  resolveSurplusChatServingAvailability,
  type QualifiedSurplusChatRoute,
} from "@nautilo/agent";
import {
  getCachedServerModelConfigRow,
  getPersonalProviderCredential,
  getServerProviderPolicy,
  type PersonalProviderCredentialRecord,
  type PersonalProviderId,
  type ServerProviderFundingPreference,
} from "@nautilo/db";
import {
  decryptPersonalProviderCredential,
  type PersonalProviderCustody,
} from "@nautilo/operator-secrets";
import { getUserCapabilities } from "@nautilo/trust";
import { readPersonalProviderCustody } from "./personal-provider-custody";
import { getServerDirectDb } from "./server-direct-db";

export type ModelFundingWorkload = "foreground_text_chat" | "native_text_task" | "image_assistance";

/** Runnable personal chat adapters; storing a service key never enables its paid path. */
export const PERSONAL_CHAT_PROVIDER_IDS = [
  "anthropic", "openai", "openrouter", "google", "xai", "fireworks", "together", "venice", "surplus",
] as const satisfies readonly PersonalProviderId[];

interface FundingBase {
  readonly humanUserId: string;
  readonly modelId: string;
  readonly providerRoute: string;
  readonly workload: ModelFundingWorkload;
}

/** Safe to use in projections and usage records. Never add a key to this type. */
export type ModelFundingDecision =
  | (FundingBase & { readonly kind: "server" })
  | (FundingBase & {
      readonly kind: "personal";
      readonly payerHumanId: string;
      readonly credentialId: string;
      readonly credentialRevision: number;
    });

export type ModelFundingErrorCode =
  | "personal_credentials_disabled"
  | "personal_credentials_forbidden"
  | "personal_credential_missing"
  | "server_credentials_forbidden"
  | "provider_credentials_missing"
  | "personal_credential_stale"
  | "personal_credential_unavailable"
  | "funding_source_changed"
  | "unsupported_workload"
  | "unsupported_provider";

export class ModelFundingError extends Error {
  constructor(readonly code: ModelFundingErrorCode) {
    super(code);
    this.name = "ModelFundingError";
  }
}

export interface ResolveModelFundingInput {
  readonly humanUserId: string;
  readonly modelId: string;
  readonly workload: ModelFundingWorkload;
  /** The first admitted source pins every later retry or fallback to that source. */
  readonly priorDecision?: ModelFundingDecision;
  /** A definitive marketplace refusal may request a same-source direct attempt. */
  readonly transport?: "direct" | "surplus";
  /** A related image call may narrow admission to the main turn's payer class. */
  readonly fundingKind?: "server" | "personal";
}

export interface ModelFundingDeps {
  getPolicy: () => Promise<{
    allowPersonalProviderKeys: boolean;
    fundingPreference?: ServerProviderFundingPreference;
  }>;
  getCapabilities: (humanUserId: string) => Promise<readonly string[]>;
  getCredential: (humanUserId: string, provider: PersonalProviderId) => Promise<PersonalProviderCredentialRecord | null>;
  serverRoute: (modelId: string) => string | null;
  personalSurplusRoute?: (modelId: string) => boolean;
  readCustody: () => Promise<PersonalProviderCustody>;
  decrypt: typeof decryptPersonalProviderCredential;
}

export function resolveServerFundingRoute(
  modelId: string,
  input: {
    readonly env?: NodeJS.ProcessEnv;
    readonly preferSurplus?: boolean;
    readonly surplusKeyConfigured?: boolean;
    readonly routes?: readonly QualifiedSurplusChatRoute[];
  } = {},
): string | null {
  const env = input.env ?? process.env;
  if (modelHasRunnableCredentials(modelId, env)) {
    if (modelId.toLowerCase().startsWith("openrouter:")) {
      try {
        return resolveOpenRouterTransport({ env })?.kind ?? null;
      } catch {
        return null;
      }
    }
    return modelId.slice(0, modelId.indexOf(":"));
  }
  const surplus = resolveSurplusChatServingAvailability({
    catalogModelId: modelId,
    policyEnabled: input.preferSurplus ?? getCachedServerModelConfigRow()?.preferSurplus === true,
    keyConfigured: input.surplusKeyConfigured ?? (input.env === undefined
      ? resolveProviderKey("surplus") !== null
      : Boolean(env["SURPLUS_API_KEY"]?.trim())),
    ...(input.routes === undefined ? {} : { routes: input.routes }),
  });
  return surplus.status === "available" ? "surplus" : null;
}

const DEFAULT_DEPS: ModelFundingDeps = {
  getPolicy: () => getServerProviderPolicy(getServerDirectDb()),
  getCapabilities: getUserCapabilities,
  getCredential: (humanUserId, provider) =>
    getPersonalProviderCredential(getServerDirectDb(), humanUserId, provider),
  serverRoute: resolveServerFundingRoute,
  personalSurplusRoute: (modelId) => resolveSurplusChatServingAvailability({
    catalogModelId: modelId,
    policyEnabled: getCachedServerModelConfigRow()?.preferSurplus === true,
    keyConfigured: true, fundingKind: "personal",
  }).status === "available",
  readCustody: readPersonalProviderCustody,
  decrypt: decryptPersonalProviderCredential,
};

function directProvider(modelId: string): PersonalProviderId | null {
  const colon = modelId.indexOf(":");
  if (colon <= 0 || colon === modelId.length - 1) return null;
  const prefix = modelId.slice(0, colon).toLowerCase();
  return prefix !== "surplus" && (PERSONAL_CHAT_PROVIDER_IDS as readonly string[]).includes(prefix)
    ? prefix as PersonalProviderId
    : null;
}

function isServerOnlyGateway(modelId: string): boolean {
  const colon = modelId.indexOf(":");
  return colon > 0 && colon < modelId.length - 1
    && modelId.slice(0, colon).toLowerCase() === "gateway";
}

function verifyPrior(input: ResolveModelFundingInput, provider: PersonalProviderId | null): void {
  const prior = input.priorDecision;
  if (!prior) return;
  if (input.fundingKind && prior.kind !== input.fundingKind) {
    throw new ModelFundingError("funding_source_changed");
  }
  if (prior.humanUserId !== input.humanUserId || prior.workload !== input.workload) {
    throw new ModelFundingError("funding_source_changed");
  }
  if (prior.kind === "personal" && prior.payerHumanId !== input.humanUserId) {
    throw new ModelFundingError("funding_source_changed");
  }
  if (prior.kind === "personal" && !provider) {
    throw new ModelFundingError("funding_source_changed");
  }
  if (prior.kind === "personal" && prior.providerRoute !== "surplus"
    && directProvider(prior.modelId) !== prior.providerRoute) {
    throw new ModelFundingError("funding_source_changed");
  }
  if (prior.kind === "personal" && prior.providerRoute === provider
    && (!prior.credentialId || !Number.isSafeInteger(prior.credentialRevision))) {
    throw new ModelFundingError("funding_source_changed");
  }
}

/**
 * Resolve a single paid model attempt from live policy and the causal Human.
 * Fresh operations follow the saved source priority for this model's route.
 * Validation remains an observation. An admitted source never changes later.
 */
export async function resolveModelFunding(
  input: ResolveModelFundingInput,
  deps: ModelFundingDeps = DEFAULT_DEPS,
): Promise<ModelFundingDecision> {
  if (input.workload !== "foreground_text_chat" && input.workload !== "native_text_task"
    && input.workload !== "image_assistance") {
    throw new ModelFundingError("unsupported_workload");
  }
  if (input.workload === "image_assistance" && input.transport !== "direct") {
    throw new ModelFundingError("unsupported_workload");
  }
  if (!input.humanUserId.trim()) throw new ModelFundingError("server_credentials_forbidden");
  const provider = directProvider(input.modelId);
  if (!provider && !isServerOnlyGateway(input.modelId)) {
    throw new ModelFundingError("unsupported_provider");
  }
  if (!provider && input.priorDecision?.kind === "personal") {
    throw new ModelFundingError("unsupported_provider");
  }
  verifyPrior(input, provider);

  const policy = await deps.getPolicy();
  const caps = await deps.getCapabilities(input.humanUserId);
  if (!provider && !caps.includes("use_server_provider_credentials")) {
    throw new ModelFundingError("unsupported_provider");
  }
  const personalAllowed = policy.allowPersonalProviderKeys
    && caps.includes("use_personal_provider_credentials");
  const prior = input.priorDecision;
  if (prior?.kind === "personal" && !policy.allowPersonalProviderKeys) {
    throw new ModelFundingError("personal_credentials_disabled");
  }
  if (prior?.kind === "personal" && !personalAllowed) {
    throw new ModelFundingError("personal_credentials_forbidden");
  }

  // Priority applies only to fresh admissions. An eligible server-first route
  // needs neither a personal row lookup nor access to personal key custody.
  const serverRoute = () => {
    const route = deps.serverRoute(input.modelId);
    // Image assistance uses the reviewed direct adapters. A text marketplace
    // mapping is not proof that the same route accepts image payloads.
    return input.transport === "direct" && route === "surplus" ? null : route;
  };
  if (!prior && input.fundingKind !== "personal" && policy.fundingPreference === "server_first"
    && caps.includes("use_server_provider_credentials")) {
    const route = serverRoute();
    if (route) {
      return {
        kind: "server", humanUserId: input.humanUserId,
        modelId: input.modelId, providerRoute: route, workload: input.workload,
      };
    }
  }

  // A fallback to a different provider must still honor the originally
  // admitted revision. Replacement or deletion ends the prior operation.
  let priorCredential: PersonalProviderCredentialRecord | null = null;
  if (prior?.kind === "personal") {
    const priorProvider = prior.providerRoute === "surplus" ? "surplus" : directProvider(prior.modelId);
    if (!priorProvider) throw new ModelFundingError("funding_source_changed");
    priorCredential = await deps.getCredential(input.humanUserId, priorProvider);
    if (!priorCredential) throw new ModelFundingError("personal_credential_stale");
    if (priorCredential.id !== prior.credentialId
      || priorCredential.revision !== prior.credentialRevision) {
      throw new ModelFundingError("personal_credential_stale");
    }
  }

  // Switch-off and admitted server operations never inspect personal rows.
  if (personalAllowed && provider && prior?.kind !== "server" && input.fundingKind !== "server") {
    const surplusEligible = input.transport !== "direct" && deps.personalSurplusRoute?.(input.modelId) === true;
    const surplusCredential = surplusEligible
      ? prior?.kind === "personal" && prior.providerRoute === "surplus"
        ? priorCredential : await deps.getCredential(input.humanUserId, "surplus")
      : null;
    const selectedProvider = surplusCredential ? "surplus" : provider;
    const credential = surplusCredential ?? (input.transport === "surplus" ? null
      : prior?.kind === "personal" && prior.providerRoute === provider
        ? priorCredential : await deps.getCredential(input.humanUserId, provider));
    if (credential) {
      if (prior?.kind === "personal" && prior.providerRoute === selectedProvider
        && (credential.id !== prior.credentialId || credential.revision !== prior.credentialRevision)) {
        throw new ModelFundingError("personal_credential_stale");
      }
      return {
        kind: "personal", humanUserId: input.humanUserId,
        payerHumanId: input.humanUserId, modelId: input.modelId,
        providerRoute: selectedProvider, workload: input.workload,
        credentialId: credential.id, credentialRevision: credential.revision,
      };
    }
    if (prior?.kind === "personal") {
      // Reaching this branch proves the initially admitted personal credential
      // still exists at its exact revision and current policy and capability
      // still admit it. The distinct requested transport or later model's
      // credential is absent, so invocation may safely consult the configured
      // same-payer model chain without starting a provider call.
      if (prior.providerRoute === "surplus" && input.transport === "direct") {
        throw new PersonalDirectFundingUnavailableError();
      }
      if (prior.modelId !== input.modelId) {
        throw new PersonalModelFundingUnavailableError();
      }
      throw new ModelFundingError("personal_credential_missing");
    }
  }
  if (prior?.kind === "personal") throw new PersonalModelFundingUnavailableError();
  if (input.fundingKind === "personal") {
    throw new ModelFundingError(!policy.allowPersonalProviderKeys
      ? "personal_credentials_disabled"
      : !personalAllowed ? "personal_credentials_forbidden" : "personal_credential_missing");
  }
  if (!caps.includes("use_server_provider_credentials")) {
    throw new ModelFundingError(personalAllowed && provider && prior?.kind !== "server"
      ? "personal_credential_missing"
      : "server_credentials_forbidden");
  }
  const route = serverRoute();
  if (!route) throw new ModelFundingError("provider_credentials_missing");
  return {
    kind: "server", humanUserId: input.humanUserId,
    modelId: input.modelId, providerRoute: route, workload: input.workload,
  };
}

/**
 * Decrypt only at the trusted provider boundary, after a fresh admission of
 * the exact credential revision. The plaintext is never returned or persisted.
 */
export async function withAdmittedPersonalProviderKey<T>(
  decision: Extract<ModelFundingDecision, { kind: "personal" }>,
  useKey: (apiKey: string) => Promise<T> | T,
  deps: ModelFundingDeps = DEFAULT_DEPS,
  initialDecision: ModelFundingDecision = decision,
): Promise<T> {
  const current = await resolveModelFunding({
    humanUserId: decision.humanUserId,
    modelId: decision.modelId,
    workload: decision.workload,
    priorDecision: initialDecision,
    transport: decision.providerRoute === "surplus" ? "surplus" : "direct",
  }, deps);
  if (current.kind !== "personal" || current.credentialId !== decision.credentialId
    || current.credentialRevision !== decision.credentialRevision) {
    throw new ModelFundingError("personal_credential_stale");
  }
  const provider = decision.providerRoute === "surplus" ? "surplus" : directProvider(decision.modelId);
  if (!provider) throw new ModelFundingError("unsupported_provider");
  const record = await deps.getCredential(decision.humanUserId, provider);
  if (!record || record.id !== decision.credentialId || record.revision !== decision.credentialRevision) {
    throw new ModelFundingError("personal_credential_stale");
  }
  let apiKey: string;
  try {
    const custody = await deps.readCustody();
    if (record.envelope.keyId !== custody.keyId) {
      throw new ModelFundingError("personal_credential_unavailable");
    }
    apiKey = deps.decrypt(custody, record.envelope, record);
  } catch (error) {
    if (error instanceof ModelFundingError) throw error;
    // Custody and authentication failures must never be read as key absence.
    throw new ModelFundingError("personal_credential_unavailable");
  }
  return useKey(apiKey);
}
