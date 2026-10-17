import { getEligibleModels } from "@nautilo/agent";
import { getServerProviderPolicy, listPersonalProviderCredentials } from "@nautilo/db";
import { getUserCapabilities } from "@nautilo/trust";
import { getServerDirectDb } from "./server-direct-db";
import { createModelFundingSnapshot, resolveModelFunding, resolveServerFundingRoute } from "./model-funding";

/** Presence-only selection data. No credential plaintext crosses model discovery. */
const PERSONAL_CHAT_ENV: Readonly<Record<string, string>> = {
  anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", openrouter: "OPENROUTER_API_KEY",
  google: "GOOGLE_API_KEY", xai: "XAI_API_KEY", fireworks: "FIREWORKS_API_KEY",
  together: "TOGETHER_API_KEY", venice: "VENICE_API_KEY",
  surplus: "SURPLUS_API_KEY",
};

export async function callerTaskModelEnvironment(humanUserId: string): Promise<NodeJS.ProcessEnv> {
  const caps = await getUserCapabilities(humanUserId);
  const env: NodeJS.ProcessEnv = caps.includes("use_server_provider_credentials")
    ? { ...process.env } : { NAUTILO_ALLOW_CHINA_UPSTREAM: process.env["NAUTILO_ALLOW_CHINA_UPSTREAM"] };
  if (caps.includes("use_personal_provider_credentials")
    && (await getServerProviderPolicy(getServerDirectDb())).allowPersonalProviderKeys) {
    for (const credential of await listPersonalProviderCredentials(getServerDirectDb(), humanUserId)) {
      const key = PERSONAL_CHAT_ENV[credential.provider];
      if (key) {
        env[key] = "configured";
      }
    }
  }
  return env;
}

export async function callerTaskModelIds(humanUserId: string): Promise<readonly string[]> {
  const snapshot = await createModelFundingSnapshot(humanUserId);
  const rows = getEligibleModels({ purpose: "chat", includeUnavailable: true, env: {} });
  const admitted = await Promise.all(rows.map(async row => {
    if (row.availability !== "selectable" && row.availability !== "missing-key") return null;
    try {
      await resolveModelFunding({ humanUserId, modelId: row.id, workload: "native_text_task" }, snapshot.deps);
      return row.id;
    } catch { return null; }
  }));
  return admitted.filter((id): id is string => id !== null);
}

export async function personalOnlyTaskModelIds(humanUserId: string, models: readonly string[]): Promise<readonly string[]> {
  const caps = await getUserCapabilities(humanUserId);
  return models.filter((modelId) => !caps.includes("use_server_provider_credentials")
    || resolveServerFundingRoute(modelId) === null);
}
