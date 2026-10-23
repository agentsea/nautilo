import type { PersonalProviderCredential } from "@nautilo/agent";
import { chatGPTFundingModels, chatGPTFundingRegistration, chatGPTSessionStore, type ChatGPTFundingRegistration } from "./chatgpt-plan/runtime";
import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  hydrateSurplusChatCatalog,
  modelHasRunnableCredentials,
  resolveCatalogModel,
  resolveSurplusDecisionServingAvailability,
  PersonalDirectFundingUnavailableError,
  PersonalModelFundingUnavailableError,
  resolveProviderKey,
  resolveOpenRouterTransport,
  resolveSurplusChatServingAvailability,
  resolveQualifiedSurplusChatRoute,
  deriveSurplusMediaModelId,
  type QualifiedSurplusChatRoute,
} from "@nautilo/agent";
import {
  getCachedServerModelConfigRow,
  getPersonalProviderCredential,
  listPersonalProviderCredentials,
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

export type ModelFundingWorkload =
  | "foreground_text_chat"
  | "native_text_task"
  | "memory"
  | "research"
  | "decision"
  | "image_assistance"
  | "generation";

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
  /** A media request or bounded Surplus recovery may require a direct-only wire contract. */
  readonly directOnly?: boolean;
  /** A bounded personal recovery may use API keys but never a subscription registration. */
  readonly apiKeyOnly?: boolean;
}

export interface ModelFundingDeps {
  getPolicy: () => Promise<{
    allowPersonalProviderKeys: boolean;
    fundingPreference?: ServerProviderFundingPreference;
  }>;
  getCapabilities: (humanUserId: string) => Promise<readonly string[]>;
  getCredential: (humanUserId: string, provider: PersonalProviderId) => Promise<PersonalProviderCredentialRecord | null>;
  serverRoute: (
    modelId: string,
    workload?: ModelFundingWorkload,
    transport?: "direct" | "surplus",
  ) => string | null;
  personalSurplusRoute?: (modelId: string, workload?: ModelFundingWorkload) => boolean;
  /** Async discovery boundary; omitted by pure/offline tests. */
  hydrateSurplusChatCatalog?: typeof hydrateSurplusChatCatalog;
  getPreferSurplus?: () => boolean;
  getServerSurplusKeyConfigured?: () => boolean;
  readCustody: () => Promise<PersonalProviderCustody>;
  decrypt: typeof decryptPersonalProviderCredential;
  getSubscription?: (userId: string, id?: string) => Promise<ChatGPTFundingRegistration | null>;
  getSubscriptionModels?: (userId: string, id: string) => Promise<readonly string[]>;
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
  const decision = resolveCatalogModel(modelId, { env });
  const preferSurplus = input.preferSurplus
    ?? getCachedServerModelConfigRow()?.preferSurplus === true;
  if (decision.workload === "generation") {
    // Generation has its own transport contract; a chat alias never admits it.
    if (["selectable", "missing_credentials"].includes(decision.availability)
      && preferSurplus && deriveSurplusMediaModelId(modelId)
      && (input.surplusKeyConfigured ?? Boolean(input.env === undefined
        ? resolveProviderKey("surplus") : env["SURPLUS_API_KEY"]?.trim()))) return "surplus";
    if (decision.provider === "openrouter" && !env["OPENROUTER_API_KEY"]?.trim()) return null;
    return decision.availability === "selectable" && modelHasRunnableCredentials(modelId, env)
      ? decision.provider : null;
  }
  if (decision.workload === "decision") {
    if (!["selectable", "missing_credentials"].includes(decision.availability)) return null;
    const surplus = resolveSurplusDecisionServingAvailability({
      catalogModelId: modelId,
      policyEnabled: preferSurplus,
      keyConfigured: input.surplusKeyConfigured ?? Boolean(input.env === undefined ? resolveProviderKey("surplus") : env["SURPLUS_API_KEY"]?.trim()),
    });
    if (surplus.status === "available") return "surplus";
    return decision.availability === "selectable" ? decision.provider : null;
  }
  const surplus = resolveSurplusChatServingAvailability({
    catalogModelId: modelId,
    policyEnabled: preferSurplus,
    keyConfigured: input.surplusKeyConfigured ?? (input.env === undefined
      ? resolveProviderKey("surplus") !== null
      : Boolean(env["SURPLUS_API_KEY"]?.trim())),
    ...(input.routes === undefined ? {} : { routes: input.routes }),
  });
  if (surplus.status === "available") return "surplus";
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
  return null;
}

const DEFAULT_DEPS: ModelFundingDeps = {
  getSubscription: chatGPTFundingRegistration,
  getSubscriptionModels: chatGPTFundingModels,
  getPolicy: () => getServerProviderPolicy(getServerDirectDb()),
  getCapabilities: getUserCapabilities,
  getCredential: (humanUserId, provider) =>
    getPersonalProviderCredential(getServerDirectDb(), humanUserId, provider),
  serverRoute: (modelId, _workload, transport) => resolveServerFundingRoute(modelId, {
    ...(transport === undefined ? {} : { preferSurplus: transport === "surplus" }),
  }),
  personalSurplusRoute: (modelId, workload) => workload === "image_assistance"
    ? resolveQualifiedSurplusChatRoute(modelId)?.supportsVision === true
      && resolveSurplusChatServingAvailability({ catalogModelId: modelId,
        policyEnabled: getCachedServerModelConfigRow()?.preferSurplus === true,
        keyConfigured: true, fundingKind: "personal" }).status === "available"
    : workload === "generation"
    ? getCachedServerModelConfigRow()?.preferSurplus === true && deriveSurplusMediaModelId(modelId) !== null
    : (workload === "decision" ? resolveSurplusDecisionServingAvailability : resolveSurplusChatServingAvailability)({
    catalogModelId: modelId,
    policyEnabled: getCachedServerModelConfigRow()?.preferSurplus === true,
    keyConfigured: true, fundingKind: "personal",
  }).status === "available",
  hydrateSurplusChatCatalog,
  getPreferSurplus: () => getCachedServerModelConfigRow()?.preferSurplus === true,
  getServerSurplusKeyConfigured: () => resolveProviderKey("surplus") !== null,
  readCustody: readPersonalProviderCustody,
  decrypt: decryptPersonalProviderCredential,
};

/** Read the live operator policy through the same dependency boundary as funding admission. */
export function readModelFundingPolicy(deps: ModelFundingDeps = DEFAULT_DEPS) {
  return deps.getPolicy();
}

function directProvider(modelId: string): PersonalProviderId | null {
  const colon = modelId.indexOf(":");
  if (colon <= 0 || colon === modelId.length - 1) return null;
  const prefix = modelId.slice(0, colon).toLowerCase();
  return prefix !== "surplus" && (prefix === "typesafe" || (PERSONAL_CHAT_PROVIDER_IDS as readonly string[]).includes(prefix))
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
  if (prior.kind === "personal" && prior.providerRoute !== "surplus" && prior.providerRoute !== "openai-chatgpt"
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
    && input.workload !== "research" && input.workload !== "memory" && input.workload !== "decision"
    && input.workload !== "image_assistance" && input.workload !== "generation") {
    throw new ModelFundingError("unsupported_workload");
  }
  if (input.directOnly && input.workload === "memory") {
    throw new ModelFundingError("unsupported_workload");
  }
  if (input.directOnly && input.transport === "surplus") {
    throw new ModelFundingError("funding_source_changed");
  }
  if (!input.humanUserId.trim()) throw new ModelFundingError("server_credentials_forbidden");
  const provider = directProvider(input.modelId);
  if (provider === "typesafe" && input.workload !== "decision") throw new ModelFundingError("unsupported_provider");
  if (!provider && !isServerOnlyGateway(input.modelId)) {
    throw new ModelFundingError("unsupported_provider");
  }
  if (!provider && input.priorDecision?.kind === "personal") {
    throw new ModelFundingError("unsupported_provider");
  }
  verifyPrior(input, provider);
  if (input.transport && !input.priorDecision && input.workload !== "image_assistance") {
    throw new ModelFundingError("funding_source_changed");
  }

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

  const pinnedPersonalTransport = prior?.kind === "personal" && prior.modelId === input.modelId
    && prior.providerRoute !== "openai-chatgpt"
    ? prior.providerRoute === "surplus" ? "surplus" : "direct"
    : undefined;
  const pinnedServerTransport = prior?.kind === "server"
    ? prior.providerRoute === "surplus" ? "surplus" : "direct"
    : undefined;
  if (input.transport === "surplus"
    && (pinnedPersonalTransport === "direct" || pinnedServerTransport === "direct")) {
    throw new ModelFundingError("funding_source_changed");
  }
  const requestedPersonalTransport = input.transport
    ?? (input.directOnly ? "direct" : pinnedPersonalTransport);
  const requestedServerTransport = input.transport
    ?? (input.directOnly ? "direct" : pinnedServerTransport);
  const surplusPolicyEnabled = (transport: "direct" | "surplus" | undefined) =>
    !input.directOnly && transport !== "direct" && (deps.getPreferSurplus?.() ?? true);
  const hydrateSurplus = async (
    keyConfigured: boolean,
    transport: "direct" | "surplus" | undefined,
  ): Promise<void> => {
    if (!surplusPolicyEnabled(transport) || !keyConfigured || !deps.hydrateSurplusChatCatalog) return;
    try {
      await deps.hydrateSurplusChatCatalog({ catalogModelIds: [input.modelId] });
    } catch {
      // Discovery failure is fail-closed for Surplus. Direct routes remain
      // usable and the sync resolver below observes only the last verified map.
    }
  };
  const serverRoute = async (
    transport: "direct" | "surplus" | undefined = requestedServerTransport,
  ) => {
    await hydrateSurplus(deps.getServerSurplusKeyConfigured?.() === true, transport);
    const route = deps.serverRoute(input.modelId, input.workload, transport);
    // Only image-capable signed routes may receive the helper's image envelope.
    return input.workload === "image_assistance" && route === "surplus"
      && resolveQualifiedSurplusChatRoute(input.modelId)?.supportsVision !== true ? null : route;
  };

  // Explicit subscription selection pins a registration, including its failed
  // state. It must never degrade into API-key or server-funded inference.
  const pinnedSubscription = prior?.kind === "personal" && prior.providerRoute === "openai-chatgpt";
  const subscription = pinnedSubscription || (!input.apiKeyOnly && !input.directOnly && !prior
    && provider === "openai" && input.fundingKind !== "server")
    ? await deps.getSubscription?.(input.humanUserId, pinnedSubscription ? prior.credentialId : undefined)
    : null;
  if (subscription || pinnedSubscription) {
    if (!policy.allowPersonalProviderKeys) throw new ModelFundingError("personal_credentials_disabled");
    if (!personalAllowed) throw new ModelFundingError("personal_credentials_forbidden");
    if (provider !== "openai" || input.transport === "surplus") throw new ModelFundingError("funding_source_changed");
    if (input.workload === "decision" || input.workload === "generation") throw new ModelFundingError("unsupported_workload");
    if (!subscription || (pinnedSubscription && (subscription.id !== prior.credentialId || subscription.revision !== prior.credentialRevision))) {
      throw new ModelFundingError("personal_credential_stale");
    }
    if (!subscription.available) throw new ModelFundingError("personal_credential_unavailable");
    let modelIds: readonly string[] | undefined;
    try { modelIds = await deps.getSubscriptionModels?.(input.humanUserId, subscription.id) ?? subscription.modelIds; }
    catch { throw new ModelFundingError("personal_credential_unavailable"); }
    if (!modelIds || !modelIds.includes(input.modelId)) throw new ModelFundingError("unsupported_provider");
    const catalog = resolveCatalogModel(input.modelId, { env: {} });
    if (catalog.workload !== "chat" || !["selectable", "missing_credentials"].includes(catalog.availability)) {
      throw new ModelFundingError("unsupported_provider");
    }
    return { kind: "personal", humanUserId: input.humanUserId, payerHumanId: input.humanUserId,
      modelId: input.modelId, workload: input.workload, providerRoute: "openai-chatgpt",
      credentialId: subscription.id, credentialRevision: subscription.revision };
  }

  // Priority applies only to fresh admissions. An eligible server-first route
  // needs neither a personal row lookup nor access to personal key custody.
  if (!prior && input.fundingKind !== "personal" && policy.fundingPreference === "server_first"
    && caps.includes("use_server_provider_credentials")) {
    const route = await serverRoute();
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
    // Production discovers before consulting the sync route map. Pure test
    // dependencies without the policy/discovery seam retain their explicit
    // route-first behavior and never acquire a network dependency.
    const explicitSurplusEligibility = deps.getPreferSurplus === undefined
      ? requestedPersonalTransport !== "direct"
        && deps.personalSurplusRoute?.(input.modelId, input.workload) === true
      : surplusPolicyEnabled(requestedPersonalTransport);
    const surplusCredential = explicitSurplusEligibility
      ? prior?.kind === "personal" && prior.providerRoute === "surplus"
        ? priorCredential : await deps.getCredential(input.humanUserId, "surplus")
      : null;
    await hydrateSurplus(surplusCredential !== null, requestedPersonalTransport);
    const surplusEligible = surplusCredential !== null
      && (deps.getPreferSurplus === undefined || deps.personalSurplusRoute?.(input.modelId, input.workload) === true);
    const qualifiedSurplusCredential = surplusEligible ? surplusCredential : null;
    const selectedProvider = qualifiedSurplusCredential ? "surplus" : provider;
    const credential = qualifiedSurplusCredential ?? (requestedPersonalTransport === "surplus" ? null
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
      if (prior.providerRoute === "surplus" && requestedPersonalTransport === "direct") {
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
  const route = await serverRoute(requestedServerTransport);
  if (!route) throw new ModelFundingError("provider_credentials_missing");
  if (requestedServerTransport === "surplus" && route !== "surplus") {
    throw new ModelFundingError("funding_source_changed");
  }
  if (requestedServerTransport === "direct" && route === "surplus") {
    throw new ModelFundingError("funding_source_changed");
  }
  if (prior?.kind === "server" && prior.modelId === input.modelId
    && prior.providerRoute !== "surplus" && route !== prior.providerRoute) {
    throw new ModelFundingError("funding_source_changed");
  }
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


/** Typed credential injection for chat adapters; subscription tokens never masquerade as API keys. */
export async function withAdmittedPersonalCredential<T>(
  decision: Extract<ModelFundingDecision, { kind: "personal" }>,
  useCredential: (credential: PersonalProviderCredential) => Promise<T> | T,
  deps: ModelFundingDeps = DEFAULT_DEPS,
  initialDecision: ModelFundingDecision = decision,
): Promise<T> {
  if (decision.providerRoute !== "openai-chatgpt") {
    return withAdmittedPersonalProviderKey(decision, apiKey => useCredential({ apiKey }), deps, initialDecision);
  }
  const current = await resolveModelFunding({ humanUserId: decision.humanUserId, modelId: decision.modelId,
    workload: decision.workload, priorDecision: initialDecision, transport: "direct" }, deps);
  if (current.kind !== "personal" || current.providerRoute !== "openai-chatgpt"
    || current.credentialId !== decision.credentialId || current.credentialRevision !== decision.credentialRevision) {
    throw new ModelFundingError("personal_credential_stale");
  }
  // Token acquisition is an unbilled control-plane call. Its lifecycle follows
  // the existing provider request timeout; inference receives its own signal.
  const accessToken = await chatGPTSessionStore.accessToken(decision.humanUserId, decision.credentialId,
    decision.credentialRevision, AbortSignal.timeout(DEFAULT_PROVIDER_TIMEOUT_MS));
  return useCredential({ kind: "chatgpt_plan", accessToken });
}

/** Request-local readiness projection; subscription discovery can refresh tokens but never runs inference. Never use these dependencies to dispatch. */
export async function createModelFundingSnapshot(humanUserId: string) {
  const preferSurplus = DEFAULT_DEPS.getPreferSurplus?.() === true;
  const serverSurplusKeyConfigured = DEFAULT_DEPS.getServerSurplusKeyConfigured?.() === true;
  const [policy, capabilities, credentials] = await Promise.all([
    DEFAULT_DEPS.getPolicy(), DEFAULT_DEPS.getCapabilities(humanUserId),
    listPersonalProviderCredentials(getServerDirectDb(), humanUserId),
  ]);
  const subscriptions = new Map<string, Promise<ChatGPTFundingRegistration | null>>();
  const subscriptionModels = new Map<string, Promise<readonly string[]>>();
  const deps: ModelFundingDeps = {
    ...DEFAULT_DEPS,
    getSubscriptionModels: (human, id) => {
      if (human !== humanUserId) return Promise.resolve([]);
      let value = subscriptionModels.get(id);
      if (!value) { value = chatGPTFundingModels(human, id); subscriptionModels.set(id, value); }
      return value;
    },
    getSubscription: (human, id) => {
      if (human !== humanUserId) return Promise.resolve(null);
      const key = id ?? "selected";
      let value = subscriptions.get(key);
      if (!value) { value = chatGPTFundingRegistration(human, id); subscriptions.set(key, value); }
      return value;
    },
    getPolicy: () => Promise.resolve(policy),
    getPreferSurplus: () => preferSurplus,
    getServerSurplusKeyConfigured: () => serverSurplusKeyConfigured,
    getCapabilities: (human) => Promise.resolve(human === humanUserId ? capabilities : []),
    getCredential: (human, provider) => Promise.resolve(
      human === humanUserId ? credentials.find((row) => row.provider === provider) ?? null : null,
    ),
    readCustody: () => Promise.reject(new Error("Funding projection cannot decrypt credentials")),
  };
  return { policy, deps };
}
