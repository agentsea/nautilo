export type ProviderKeyCategory =
  | "llm"
  | "llm+embeddings"
  | "voice"
  | "search"
  | "conversion"
  | "browser"
  | "decision";

export interface ProviderKeyCatalogueEntry {
  readonly id: string;
  readonly name: string;
  readonly envVar: string;
  readonly category: ProviderKeyCategory;
  readonly purpose: string;
  readonly required: boolean;
  readonly signupUrl?: string;
  readonly formatHint?: string;
}

export const PERSONAL_PROVIDER_CAPABILITIES = ["chat", "research", "decision"] as const;
export type PersonalProviderCapability = (typeof PERSONAL_PROVIDER_CAPABILITIES)[number];

export interface PersonalProviderKeyCatalogueEntry extends ProviderKeyCatalogueEntry {
  readonly personalCapabilities: readonly PersonalProviderCapability[];
  readonly destination?: string | null;
}

export const PROVIDER_KEY_CATALOGUE: readonly ProviderKeyCatalogueEntry[] = [
  { id: "typesafe", name: "TypeSafe", envVar: "TYPESAFE_API_KEY", category: "decision", purpose: "Jev classification, probability judgments and rubric scoring", required: false, signupUrl: "https://console.typesafe.ai/", formatHint: "raw opaque API key" },
  { id: "anthropic", name: "Anthropic", envVar: "ANTHROPIC_API_KEY", category: "llm", purpose: "Anthropic models", required: false, signupUrl: "https://platform.claude.com/settings/keys", formatHint: "sk-ant-api03-..." },
  { id: "openai", name: "OpenAI", envVar: "OPENAI_API_KEY", category: "llm+embeddings", purpose: "GPT models + embeddings", required: false, signupUrl: "https://platform.openai.com/api-keys", formatHint: "sk-proj-..." },
  { id: "openrouter", name: "OpenRouter", envVar: "OPENROUTER_API_KEY", category: "llm", purpose: "OpenRouter-compatible chat models through one gateway key", required: false, signupUrl: "https://openrouter.ai/settings/keys", formatHint: "sk-or-v1-..." },
  { id: "gateway", name: "OpenAI-Compatible Gateway", envVar: "NAUTILO_GATEWAY_API_KEY", category: "llm", purpose: "Custom OpenAI-compatible chat endpoint. Also requires NAUTILO_GATEWAY_BASE_URL and a gateway model selection.", required: false, formatHint: "opaque gateway API key" },
  { id: "google", name: "Google", envVar: "GOOGLE_API_KEY", category: "llm", purpose: "Gemini models", required: false, signupUrl: "https://aistudio.google.com/apikey", formatHint: "opaque API key (20+ chars)" },
  { id: "xai", name: "xAI", envVar: "XAI_API_KEY", category: "llm", purpose: "xAI models", required: false, formatHint: "raw opaque API key" },
  { id: "fireworks", name: "Fireworks", envVar: "FIREWORKS_API_KEY", category: "llm", purpose: "Fireworks AI models", required: false, signupUrl: "https://app.fireworks.ai/settings/users/api-keys", formatHint: "fw_..." },
  { id: "together", name: "Together AI", envVar: "TOGETHER_API_KEY", category: "llm", purpose: "Together AI models", required: false, formatHint: "raw opaque API key" },
  { id: "venice", name: "Venice", envVar: "VENICE_API_KEY", category: "llm", purpose: "Venice AI — no-log inference proxy, anchor of the Paranoid tier", required: false, signupUrl: "https://venice.ai/settings/api", formatHint: "raw opaque API key (single printable line, 20+ chars)" },
  { id: "surplus", name: "Surplus Intelligence", envVar: "SURPLUS_API_KEY", category: "llm", purpose: "Marketplace serving for qualified text routes when Prefer Surplus is enabled", required: false, signupUrl: "https://www.surplusintelligence.ai/", formatHint: "raw Surplus buyer API key" },
  { id: "elevenlabs", name: "ElevenLabs", envVar: "ELEVENLABS_API_KEY", category: "voice", purpose: "Text-to-speech — gives the assistant a voice", required: false, signupUrl: "https://elevenlabs.io/app/developers/api-keys", formatHint: "sk_..." },
  { id: "groq", name: "Groq", envVar: "GROQ_API_KEY", category: "voice", purpose: "Speech-to-text transcription (Whisper)", required: false, signupUrl: "https://console.groq.com/keys", formatHint: "gsk_..." },
  { id: "tavily", name: "Tavily", envVar: "TAVILY_API_KEY", category: "search", purpose: "Web search — enables internet access", required: false, signupUrl: "https://app.tavily.com/home", formatHint: "tvly-..." },
  { id: "browser-use", name: "Browser Use", envVar: "BROWSER_USE_API_KEY", category: "browser", purpose: "Protected website sign-in and cloud browser automation", required: false, signupUrl: "https://cloud.browser-use.com/settings?tab=api-keys&new=1", formatHint: "bu_..." },
  { id: "cloudconvert", name: "CloudConvert", envVar: "CLOUDCONVERT_API_KEY", category: "conversion", purpose: "Cloud file conversion — unlocks the CloudConvert backend for the convert tool", required: false, signupUrl: "https://cloudconvert.com/dashboard/api/v2/keys", formatHint: "JWT (eyJ… three segments, usually ~1000 chars)" },
] as const;

const PERSONAL_CHAT_PROVIDER_IDS = new Set([
  "anthropic",
  "openai",
  "openrouter",
  "google",
  "xai",
  "fireworks",
  "together",
  "venice",
  "surplus",
]);

const PERSONAL_RESEARCH_PROVIDER_IDS = new Set([
  ...PERSONAL_CHAT_PROVIDER_IDS,
  "tavily",
]);

const PERSONAL_DECISION_PROVIDER_IDS = new Set([
  "typesafe",
  "openrouter",
  "venice",
  "surplus",
]);

export const PERSONAL_PROVIDER_KEY_CATALOGUE: readonly PersonalProviderKeyCatalogueEntry[] = PROVIDER_KEY_CATALOGUE
  .filter(({ id }) => id !== "gateway")
  .map((entry) => ({
    ...entry,
    purpose: entry.id === "surplus"
      ? "Marketplace serving for qualified personal chat and research routes; decisions require a pilot-enabled Surplus account"
      : entry.id === "openai"
        ? "OpenAI text models; embeddings remain server-managed"
        : entry.purpose,
    personalCapabilities: [
      ...(PERSONAL_CHAT_PROVIDER_IDS.has(entry.id) ? ["chat" as const] : []),
      ...(PERSONAL_RESEARCH_PROVIDER_IDS.has(entry.id) ? ["research" as const] : []),
      ...(PERSONAL_DECISION_PROVIDER_IDS.has(entry.id) ? ["decision" as const] : []),
    ],
  }));

const PERSONAL_PROVIDER_CAPABILITY_LABELS: Record<PersonalProviderCapability, string> = {
  chat: "personal chat and native text Tasks",
  research: "Research",
  decision: "Decisions",
};

export function personalProviderCapabilitySummary(
  provider: Pick<PersonalProviderKeyCatalogueEntry, "id" | "personalCapabilities">,
): string {
  if (provider.personalCapabilities.length === 0) {
    return "Not used by delivered personal workflows in this release.";
  }
  const labels = provider.personalCapabilities.map((capability) =>
    PERSONAL_PROVIDER_CAPABILITY_LABELS[capability]);
  const joined = labels.length === 1
    ? labels[0]
    : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
  const entitlement = provider.id === "surplus" && provider.personalCapabilities.includes("decision")
    ? " Surplus Decisions also require a pilot-enabled account; saving a key does not grant that entitlement."
    : "";
  return `Eligible for ${joined}.${entitlement}`;
}

const KEY_DISPLAY_ORDER = [
  "venice",
  "openrouter",
  "surplus",
  "elevenlabs",
  "openai",
  "anthropic",
  "google",
  "xai",
  "fireworks",
  "together",
  "groq",
] as const;

function displayOrder(providerId: string): number {
  if (providerId === "gateway") return KEY_DISPLAY_ORDER.length + 1;
  if (providerId === "nautilo-gateway") return KEY_DISPLAY_ORDER.length + 2;
  const index = KEY_DISPLAY_ORDER.indexOf(providerId as (typeof KEY_DISPLAY_ORDER)[number]);
  return index === -1 ? KEY_DISPLAY_ORDER.length : index;
}

/** Keep provider-key surfaces aligned without disturbing fallback input order. */
export function orderProviderKeys<T extends { id: string }>(providers: readonly T[]): T[] {
  return providers
    .map((provider, registryIndex) => ({ provider, registryIndex }))
    .sort((left, right) =>
      displayOrder(left.provider.id) - displayOrder(right.provider.id)
      || left.registryIndex - right.registryIndex)
    .map(({ provider }) => provider);
}
