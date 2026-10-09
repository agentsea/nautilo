import { type UsageFundingProvenance } from "@nautilo/agent";
import { getPersonalProviderCredential, getServerProviderPolicy, type PersonalProviderCredentialRecord } from "@nautilo/db";
import { decryptPersonalProviderCredential, type PersonalProviderCustody } from "@nautilo/operator-secrets";
import { getUserCapabilities } from "@nautilo/trust";
import { parseTaskFundingBinding, type TaskFundingBinding } from "@nautilo/types";
import { ModelFundingError } from "./model-funding";
import { readPersonalProviderCustody } from "./personal-provider-custody";
import { getServerDirectDb } from "./server-direct-db";

export interface ServiceFundingDeps {
  getPolicy: () => Promise<{ allowPersonalProviderKeys: boolean; fundingPreference?: "personal_first" | "server_first" }>;
  getCapabilities: (humanUserId: string) => Promise<readonly string[]>;
  getCredential: (humanUserId: string, provider: "tavily") => Promise<PersonalProviderCredentialRecord | null>;
  serverKey: (provider: "tavily") => string | null;
  readCustody: () => Promise<PersonalProviderCustody>;
  decrypt: typeof decryptPersonalProviderCredential;
}

const DEFAULT_DEPS: ServiceFundingDeps = {
  getPolicy: () => getServerProviderPolicy(getServerDirectDb()),
  getCapabilities: getUserCapabilities,
  getCredential: (human, provider) => getPersonalProviderCredential(getServerDirectDb(), human, provider),
  serverKey: () => process.env["TAVILY_API_KEY"]?.trim() || null,
  readCustody: readPersonalProviderCustody,
  decrypt: decryptPersonalProviderCredential,
};

/** One service operation chooses a payer before dispatch; recovery retains it. */
export async function resolveServiceFunding(
  humanUserId: string,
  provider: "tavily",
  prior?: TaskFundingBinding,
  deps: ServiceFundingDeps = DEFAULT_DEPS,
): Promise<TaskFundingBinding> {
  if (!humanUserId.trim() || provider !== "tavily") throw new ModelFundingError("unsupported_workload");
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
    if (prior?.kind === "personal" && (!credential || credential.id !== prior.credentialId || credential.revision !== prior.credentialRevision)) {
      throw new ModelFundingError("personal_credential_stale");
    }
    if (credential) return { kind: "personal", providerRoute: provider, credentialId: credential.id, credentialRevision: credential.revision };
  }
  if (!serverAllowed) throw new ModelFundingError(personalAllowed ? "personal_credential_missing" : "server_credentials_forbidden");
  if (!deps.serverKey(provider)) throw new ModelFundingError("provider_credentials_missing");
  return { kind: "server", providerRoute: provider };
}

export async function openServiceFunding(
  humanUserId: string,
  provider: "tavily",
  prior?: TaskFundingBinding,
  deps: ServiceFundingDeps = DEFAULT_DEPS,
) {
  const binding = await resolveServiceFunding(humanUserId, provider, prior, deps);
  return {
    binding,
    async runAttempt<T>(run: (attempt: { apiKey: string; usageFunding: UsageFundingProvenance }) => Promise<T>): Promise<T> {
      const current = await resolveServiceFunding(humanUserId, provider, binding, deps);
      if (current.kind === "server") {
        const apiKey = deps.serverKey(provider);
        if (!apiKey) throw new ModelFundingError("provider_credentials_missing");
        return run({ apiKey, usageFunding: { kind: "server", humanUserId, providerRoute: provider } });
      }
      const credential = await deps.getCredential(humanUserId, provider);
      if (!credential || credential.id !== current.credentialId || credential.revision !== current.credentialRevision) throw new ModelFundingError("personal_credential_stale");
      let apiKey: string;
      try {
        const custody = await deps.readCustody();
        if (credential.envelope.keyId !== custody.keyId) throw new Error("custody_changed");
        apiKey = deps.decrypt(custody, credential.envelope, credential);
      } catch { throw new ModelFundingError("personal_credential_unavailable"); }
      return run({ apiKey, usageFunding: { kind: "personal", humanUserId, payerHumanId: humanUserId,
        providerRoute: provider, credentialId: current.credentialId, credentialRevision: current.credentialRevision } });
    },
  };
}
