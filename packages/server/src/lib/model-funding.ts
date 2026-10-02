import {
  modelHasRunnableCredentials,
  resolveProviderKey,
  resolveOpenRouterTransport,
  resolveSurplusChatServingAvailability,
  type QualifiedSurplusChatRoute,
} from "@nautilo/agent";
import {
  getCachedServerModelConfigRow,
  getPersonalProviderCredential,
  getServerProviderPolicy,
  PERSONAL_PROVIDER_IDS,
  type PersonalProviderCredentialRecord,
  type PersonalProviderId,
} from "@nautilo/db";
import {
  decryptPersonalProviderCredential,
  type PersonalProviderCustody,
} from "@nautilo/operator-secrets";
import { getUserCapabilities } from "@nautilo/trust";
import { readPersonalProviderCustody } from "./personal-provider-custody";
import { getServerDirectDb } from "./server-direct-db";

export type ModelFundingWorkload = "foreground_text_chat";

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
}

export interface ModelFundingDeps {
  getPolicy: () => Promise<{ allowPersonalProviderKeys: boolean }>;
  getCapabilities: (humanUserId: string) => Promise<readonly string[]>;
  getCredential: (humanUserId: string, provider: PersonalProviderId) => Promise<PersonalProviderCredentialRecord | null>;
  serverRoute: (modelId: string) => string | null;
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
  if (modelHasRunnableCredentials(modelId, env, "chat")) {
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
  readCustody: readPersonalProviderCustody,
  decrypt: decryptPersonalProviderCredential,
};

function directProvider(modelId: string): PersonalProviderId | null {
  const colon = modelId.indexOf(":");
  if (colon <= 0 || colon === modelId.length - 1) return null;
  const prefix = modelId.slice(0, colon).toLowerCase();
  return (PERSONAL_PROVIDER_IDS as readonly string[]).includes(prefix)
    ? prefix as PersonalProviderId
    : null;
}

function verifyPrior(input: ResolveModelFundingInput, provider: PersonalProviderId | null): void {
  const prior = input.priorDecision;
  if (!prior) return;
  if (prior.humanUserId !== input.humanUserId || prior.workload !== input.workload) {
    throw new ModelFundingError("funding_source_changed");
  }
  if (prior.kind === "personal" && prior.payerHumanId !== input.humanUserId) {
    throw new ModelFundingError("funding_source_changed");
  }
  if (prior.kind === "personal" && !provider) {
    throw new ModelFundingError("funding_source_changed");
  }
  if (prior.kind === "personal" && directProvider(prior.modelId) !== prior.providerRoute) {
    throw new ModelFundingError("funding_source_changed");
  }
  if (prior.kind === "personal" && prior.providerRoute === provider
    && (!prior.credentialId || !Number.isSafeInteger(prior.credentialRevision))) {
    throw new ModelFundingError("funding_source_changed");
  }
}

/**
 * Resolve a single paid model attempt from live policy and the causal Human.
 * A present personal row always wins for a fresh operation, regardless of its
 * validation observation. An admitted source never changes on later attempts.
 */
export async function resolveModelFunding(
  input: ResolveModelFundingInput,
  deps: ModelFundingDeps = DEFAULT_DEPS,
): Promise<ModelFundingDecision> {
  if (input.workload !== "foreground_text_chat") throw new ModelFundingError("unsupported_workload");
  if (!input.humanUserId.trim()) throw new ModelFundingError("server_credentials_forbidden");
  const provider = directProvider(input.modelId);
  const serverOnlyGateway = input.modelId.toLowerCase().startsWith("gateway:")
    && input.modelId.length > "gateway:".length;
  if (!provider && !serverOnlyGateway) throw new ModelFundingError("unsupported_provider");
  verifyPrior(input, provider);

  const policy = await deps.getPolicy();
  const caps = await deps.getCapabilities(input.humanUserId);
  const personalAllowed = policy.allowPersonalProviderKeys
    && caps.includes("use_personal_provider_credentials");
  const prior = input.priorDecision;
  if (prior?.kind === "personal" && !policy.allowPersonalProviderKeys) {
    throw new ModelFundingError("personal_credentials_disabled");
  }
  if (prior?.kind === "personal" && !personalAllowed) {
    throw new ModelFundingError("personal_credentials_forbidden");
  }

  // A fallback to a different provider must still honor the originally
  // admitted revision. Replacement or deletion ends the prior operation.
  let priorCredential: PersonalProviderCredentialRecord | null = null;
  if (prior?.kind === "personal") {
    const priorProvider = directProvider(prior.modelId);
    if (!priorProvider) throw new ModelFundingError("funding_source_changed");
    priorCredential = await deps.getCredential(input.humanUserId, priorProvider);
    if (!priorCredential) throw new ModelFundingError("personal_credential_missing");
    if (priorCredential.id !== prior.credentialId
      || priorCredential.revision !== prior.credentialRevision) {
      throw new ModelFundingError("personal_credential_stale");
    }
  }

  // Switch-off and admitted server operations never inspect personal rows.
  if (personalAllowed && provider && prior?.kind !== "server") {
    const credential = prior?.kind === "personal" && prior.providerRoute === provider
      ? priorCredential
      : await deps.getCredential(input.humanUserId, provider);
    if (credential) {
      if (prior?.kind === "personal" && prior.providerRoute === provider
        && (credential.id !== prior.credentialId || credential.revision !== prior.credentialRevision)) {
        throw new ModelFundingError("personal_credential_stale");
      }
      return {
        kind: "personal", humanUserId: input.humanUserId,
        payerHumanId: input.humanUserId, modelId: input.modelId,
        providerRoute: provider, workload: input.workload,
        credentialId: credential.id, credentialRevision: credential.revision,
      };
    }
    if (prior?.kind === "personal") throw new ModelFundingError("personal_credential_missing");
  }
  if (prior?.kind === "personal") throw new ModelFundingError("personal_credential_missing");
  if (!caps.includes("use_server_provider_credentials")) {
    throw new ModelFundingError(personalAllowed && provider && prior?.kind !== "server"
      ? "personal_credential_missing"
      : "server_credentials_forbidden");
  }
  const route = deps.serverRoute(input.modelId);
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
  }, deps);
  if (current.kind !== "personal" || current.credentialId !== decision.credentialId
    || current.credentialRevision !== decision.credentialRevision) {
    throw new ModelFundingError("personal_credential_stale");
  }
  const provider = directProvider(decision.modelId);
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
