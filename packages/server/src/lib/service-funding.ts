import { createHash } from "node:crypto";
import { type UsageFundingProvenance } from "@nautilo/agent";
import { getPersonalProviderCredential, getServerProviderPolicy, type PersonalProviderCredentialRecord } from "@nautilo/db";
import { decryptPersonalProviderCredential, type PersonalProviderCustody } from "@nautilo/operator-secrets";
import { getUserCapabilities } from "@nautilo/trust";
import {
  isPaidServiceProvider,
  parseDurableServiceFundingBinding,
  parseTaskFundingBinding,
  type DurableServiceFundingBinding,
  type PaidServiceProvider,
  type TaskFundingBinding,
} from "@nautilo/types";
import { ModelFundingError } from "./model-funding";
import { readPersonalProviderCustody } from "./personal-provider-custody";
import { getServerDirectDb } from "./server-direct-db";

export interface ServiceFundingDeps {
  getPolicy: () => Promise<{ allowPersonalProviderKeys: boolean; fundingPreference?: "personal_first" | "server_first" }>;
  getCapabilities: (humanUserId: string) => Promise<readonly string[]>;
  getCredential: (humanUserId: string, provider: PaidServiceProvider) => Promise<PersonalProviderCredentialRecord | null>;
  serverKey: (provider: PaidServiceProvider) => string | null;
  readCustody: () => Promise<PersonalProviderCustody>;
  decrypt: typeof decryptPersonalProviderCredential;
}

const SERVER_KEY_ENV = {
  tavily: "TAVILY_API_KEY",
  "browser-use": "BROWSER_USE_API_KEY",
  cloudconvert: "CLOUDCONVERT_API_KEY",
} as const satisfies Readonly<Record<PaidServiceProvider, string>>;

const DEFAULT_DEPS: ServiceFundingDeps = {
  getPolicy: () => getServerProviderPolicy(getServerDirectDb()),
  getCapabilities: getUserCapabilities,
  getCredential: (human, provider) => getPersonalProviderCredential(getServerDirectDb(), human, provider),
  serverKey: (provider) => process.env[SERVER_KEY_ENV[provider]]?.trim() || null,
  readCustody: readPersonalProviderCustody,
  decrypt: decryptPersonalProviderCredential,
};

function exactPersonalCredential(
  credential: PersonalProviderCredentialRecord | null,
  humanUserId: string,
  provider: PaidServiceProvider,
  binding?: Extract<TaskFundingBinding, { kind: "personal" }>,
): credential is PersonalProviderCredentialRecord {
  return credential !== null
    && credential.userId === humanUserId
    && credential.provider === provider
    && (binding === undefined
      || (credential.id === binding.credentialId
        && credential.revision === binding.credentialRevision));
}

function credentialFingerprint(provider: PaidServiceProvider, apiKey: string): string {
  return createHash("sha256")
    .update("nautilo:paid-service-credential:v1\0", "utf8")
    .update(provider, "utf8")
    .update("\0", "utf8")
    .update(apiKey, "utf8")
    .digest("hex");
}

function usageFundingForService(
  humanUserId: string,
  provider: PaidServiceProvider,
  binding: TaskFundingBinding,
): UsageFundingProvenance {
  return binding.kind === "server"
    ? { kind: "server", humanUserId, providerRoute: provider }
    : {
        kind: "personal",
        humanUserId,
        payerHumanId: humanUserId,
        providerRoute: provider,
        credentialId: binding.credentialId,
        credentialRevision: binding.credentialRevision,
      };
}

async function withFundingKey<T>(
  humanUserId: string,
  provider: PaidServiceProvider,
  binding: TaskFundingBinding,
  expectedFingerprint: string | undefined,
  callback: (attempt: { apiKey: string; usageFunding: UsageFundingProvenance }) => T | Promise<T>,
  deps: ServiceFundingDeps,
): Promise<T> {
  const usageFunding = usageFundingForService(humanUserId, provider, binding);
  if (binding.kind === "server") {
    const apiKey = deps.serverKey(provider);
    if (!apiKey) throw new ModelFundingError("provider_credentials_missing");
    if (expectedFingerprint && credentialFingerprint(provider, apiKey) !== expectedFingerprint) {
      throw new ModelFundingError("funding_source_changed");
    }
    return callback({ apiKey, usageFunding });
  }

  const credential = await deps.getCredential(humanUserId, provider);
  if (!exactPersonalCredential(credential, humanUserId, provider, binding)) {
    throw new ModelFundingError("personal_credential_stale");
  }
  let apiKey: string;
  try {
    const custody = await deps.readCustody();
    if (credential.envelope.keyId === custody.resetFromKeyId
      || credential.envelope.keyId !== custody.keyId) {
      throw new Error("custody_changed");
    }
    apiKey = deps.decrypt(custody, credential.envelope, credential);
  } catch {
    throw new ModelFundingError("personal_credential_unavailable");
  }
  if (expectedFingerprint && credentialFingerprint(provider, apiKey) !== expectedFingerprint) {
    throw new ModelFundingError("personal_credential_stale");
  }
  return callback({ apiKey, usageFunding });
}

/** One service operation chooses a payer before dispatch; recovery retains it. */
export async function resolveServiceFunding(
  humanUserId: string,
  provider: PaidServiceProvider,
  prior?: TaskFundingBinding,
  deps: ServiceFundingDeps = DEFAULT_DEPS,
): Promise<TaskFundingBinding> {
  if (!humanUserId.trim() || !isPaidServiceProvider(provider)) {
    throw new ModelFundingError("unsupported_workload");
  }
  if (prior) {
    prior = parseTaskFundingBinding(prior);
    if (prior.providerRoute !== provider) throw new ModelFundingError("funding_source_changed");
  }
  const [policy, caps] = await Promise.all([deps.getPolicy(), deps.getCapabilities(humanUserId)]);
  const serverAllowed = caps.includes("use_server_provider_credentials");
  const personalAllowed = policy.allowPersonalProviderKeys && caps.includes("use_personal_provider_credentials");
  if (prior?.kind === "personal") {
    if (!policy.allowPersonalProviderKeys) throw new ModelFundingError("personal_credentials_disabled");
    if (!personalAllowed) throw new ModelFundingError("personal_credentials_forbidden");
  }
  if (prior?.kind === "server" || (!prior && policy.fundingPreference === "server_first" && serverAllowed && deps.serverKey(provider))) {
    if (!serverAllowed) throw new ModelFundingError("server_credentials_forbidden");
    if (!deps.serverKey(provider)) throw new ModelFundingError("provider_credentials_missing");
    return { kind: "server", providerRoute: provider };
  }
  if (personalAllowed) {
    const credential = await deps.getCredential(humanUserId, provider);
    if (prior?.kind === "personal" && !exactPersonalCredential(credential, humanUserId, provider, prior)) {
      throw new ModelFundingError("personal_credential_stale");
    }
    if (credential) {
      if (!exactPersonalCredential(credential, humanUserId, provider)) {
        throw new ModelFundingError("personal_credential_unavailable");
      }
      return {
        kind: "personal",
        providerRoute: provider,
        credentialId: credential.id,
        credentialRevision: credential.revision,
      };
    }
  }
  if (!serverAllowed) throw new ModelFundingError(personalAllowed ? "personal_credential_missing" : "server_credentials_forbidden");
  if (!deps.serverKey(provider)) throw new ModelFundingError("provider_credentials_missing");
  return { kind: "server", providerRoute: provider };
}

/**
 * Admit and serialize the exact creating account for a provider-owned job.
 * Passing a prior binding rechecks current spending authority without rebinding it.
 */
export async function admitDurableServiceFunding(
  humanUserId: string,
  provider: PaidServiceProvider,
  prior?: DurableServiceFundingBinding,
  deps: ServiceFundingDeps = DEFAULT_DEPS,
): Promise<DurableServiceFundingBinding> {
  const parsedPrior = prior === undefined
    ? undefined
    : parseDurableServiceFundingBinding(prior);
  if (parsedPrior
    && (parsedPrior.humanUserId !== humanUserId || parsedPrior.provider !== provider)) {
    throw new ModelFundingError("funding_source_changed");
  }
  const binding = await resolveServiceFunding(
    humanUserId,
    provider,
    parsedPrior?.binding,
    deps,
  );
  const fingerprint = await withFundingKey(
    humanUserId,
    provider,
    binding,
    parsedPrior?.credentialFingerprint,
    ({ apiKey }) => credentialFingerprint(provider, apiKey),
    deps,
  );
  if (parsedPrior) return parsedPrior;
  return Object.freeze({
    humanUserId,
    provider,
    binding,
    credentialFingerprint: fingerprint,
  });
}

/**
 * Adopt a caller-authorized legacy provider resource that predates persisted
 * service funding. The caller must prove resource ownership first. This
 * deliberately requires the currently admitted server account and never falls
 * back to a personal credential.
 */
export async function admitLegacyServerServiceFunding(
  humanUserId: string,
  provider: PaidServiceProvider,
  deps: ServiceFundingDeps = DEFAULT_DEPS,
): Promise<DurableServiceFundingBinding> {
  if (!humanUserId.trim() || !isPaidServiceProvider(provider)) {
    throw new ModelFundingError("unsupported_workload");
  }
  const binding = { kind: "server", providerRoute: provider } as const;
  const fingerprint = await withFundingKey(
    humanUserId,
    provider,
    binding,
    undefined,
    ({ apiKey }) => credentialFingerprint(provider, apiKey),
    deps,
  );
  return Object.freeze({
    humanUserId,
    provider,
    binding,
    credentialFingerprint: fingerprint,
  });
}

/**
 * Open the exact creating credential only for the duration of the callback.
 * `recover` is for caller-authorized owned-resource polling, cancellation,
 * cleanup, or result retrieval. The caller must establish that resource
 * authority first; this helper does not grant it and recovery must not create
 * a new paid effect.
 */
export async function runWithDurableServiceFunding<T>(
  durableBinding: DurableServiceFundingBinding,
  intent: "spend" | "recover",
  callback: (attempt: { apiKey: string; usageFunding: UsageFundingProvenance }) => Promise<T>,
  deps: ServiceFundingDeps = DEFAULT_DEPS,
): Promise<T> {
  const parsed = parseDurableServiceFundingBinding(durableBinding);
  if (intent !== "spend" && intent !== "recover") {
    throw new ModelFundingError("unsupported_workload");
  }
  if (intent === "spend") {
    await resolveServiceFunding(parsed.humanUserId, parsed.provider, parsed.binding, deps);
  }
  return withFundingKey(
    parsed.humanUserId,
    parsed.provider,
    parsed.binding,
    parsed.credentialFingerprint,
    callback,
    deps,
  );
}

/** Compatibility adapter for foreground services that persist TaskFundingBinding. */
export async function openServiceFunding(
  humanUserId: string,
  provider: PaidServiceProvider,
  prior?: TaskFundingBinding,
  deps: ServiceFundingDeps = DEFAULT_DEPS,
) {
  const binding = await resolveServiceFunding(humanUserId, provider, prior, deps);
  const fingerprint = await withFundingKey(
    humanUserId,
    provider,
    binding,
    undefined,
    ({ apiKey }) => credentialFingerprint(provider, apiKey),
    deps,
  );
  const durableBinding: DurableServiceFundingBinding = {
    humanUserId,
    provider,
    binding,
    credentialFingerprint: fingerprint,
  };
  return {
    binding,
    runAttempt<T>(callback: (attempt: { apiKey: string; usageFunding: UsageFundingProvenance }) => Promise<T>): Promise<T> {
      return runWithDurableServiceFunding(durableBinding, "spend", callback, deps);
    },
  };
}
