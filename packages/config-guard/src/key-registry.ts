import type { KeyDefinition } from "./types";

export const BROWSER_USE_API_KEY_ENV_VAR = "BROWSER_USE_API_KEY";

function isSinglePrintableAsciiLine(value: string): boolean {
  return [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 0x21 && code <= 0x7e;
  });
}

export const KEY_REGISTRY: KeyDefinition[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    envVar: "ANTHROPIC_API_KEY",
    category: "llm",
    purpose: "Anthropic models",
    required: false,
    signupUrl: "https://platform.claude.com/settings/keys",
    formatHint: "sk-ant-api03-...",
    formatCheck: (v) => v.startsWith("sk-ant-") && v.length > 20,
    doctorHints: [
      {
        condition: (v) => v.startsWith("sk-proj-"),
        message: "This looks like an OpenAI key, not Anthropic",
      },
      {
        condition: (v) => v.trim() !== v,
        message: "Key has leading/trailing whitespace",
      },
      {
        condition: (v) => v.length < 20,
        message: "Key appears truncated",
      },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    envVar: "OPENAI_API_KEY",
    category: "llm+embeddings",
    purpose: "GPT models + embeddings",
    required: false,
    signupUrl: "https://platform.openai.com/api-keys",
    formatHint: "sk-proj-...",
    formatCheck: (v) => v.startsWith("sk-") && v.length > 20,
    doctorHints: [
      {
        condition: (v) => v.startsWith("sk-ant-"),
        message: "This looks like an Anthropic key, not OpenAI",
      },
      {
        condition: (v) => v.trim() !== v,
        message: "Key has leading/trailing whitespace",
      },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    envVar: "OPENROUTER_API_KEY",
    category: "llm",
    purpose: "OpenRouter-compatible chat models through one gateway key",
    required: false,
    signupUrl: "https://openrouter.ai/settings/keys",
    formatHint: "sk-or-v1-...",
    formatCheck: (v) => v.startsWith("sk-or-v1-") && v.length > 20,
    doctorHints: [
      {
        condition: (v) => v.startsWith("sk-proj-"),
        message: "This looks like an OpenAI key, not OpenRouter",
      },
      {
        condition: (v) => v.startsWith("sk-ant-"),
        message: "This looks like an Anthropic key, not OpenRouter",
      },
      {
        condition: (v) => v.trim() !== v,
        message: "Key has leading/trailing whitespace",
      },
      {
        condition: (v) => v.length < 20,
        message: "Key appears truncated",
      },
    ],
  },
  {
    id: "gateway",
    name: "OpenAI-Compatible Gateway",
    envVar: "NAUTILO_GATEWAY_API_KEY",
    category: "llm",
    purpose: "Custom OpenAI-compatible chat endpoint. Also requires NAUTILO_GATEWAY_BASE_URL and a gateway model selection.",
    required: false,
    // Custom endpoints have no universal key-issuance page.
    signupUrl: "",
    formatHint: "opaque gateway API key",
    formatCheck: (v) => v.trim().length > 0,
    doctorHints: [
      {
        condition: (v) => v.trim() !== v,
        message: "Key has leading/trailing whitespace",
      },
      {
        condition: (v) => v.length < 8,
        message: "Key appears very short; confirm this gateway accepts it",
      },
    ],
  },
  {
    id: "google",
    name: "Google",
    envVar: "GOOGLE_API_KEY",
    category: "llm",
    purpose: "Gemini models",
    required: false,
    signupUrl: "https://aistudio.google.com/apikey",
    // Google keys are opaque: classic AI Studio keys are AIzaSy…, but Cloud /
    // Gemini console also issues other prefixes (e.g. AQ.…). Accept any
    // non-trivial length; live validity is checked by health-checker.
    formatHint: "opaque API key (20+ chars)",
    formatCheck: (v) => v.trim().length >= 20,
    doctorHints: [
      {
        condition: (v) => v.startsWith("sk-"),
        message: "This looks like an OpenAI/Anthropic key, not Google",
      },
      {
        condition: (v) => v.trim() !== v,
        message: "Key has leading/trailing whitespace",
      },
      {
        condition: (v) => v.trim().length > 0 && v.trim().length < 20,
        message: "Key appears truncated",
      },
    ],
  },
  {
    id: "fireworks",
    name: "Fireworks",
    envVar: "FIREWORKS_API_KEY",
    category: "llm",
    purpose: "Fireworks AI models",
    required: false,
    signupUrl: "https://app.fireworks.ai/settings/users/api-keys",
    formatHint: "fw_...",
    formatCheck: (v) => v.startsWith("fw_") && v.length > 10,
    doctorHints: [],
  },
  {
    id: "venice",
    name: "Venice",
    envVar: "VENICE_API_KEY",
    category: "llm",
    purpose: "Venice AI — no-log inference proxy, anchor of the Paranoid tier",
    required: false,
    signupUrl: "https://venice.ai/settings/api",
    // Venice publishes opaque tokens without a stable prefix convention.
    // Reject paste/transport mistakes locally, then let the live models probe
    // be the authority on whether an otherwise-plausible token is valid.
    formatHint: "raw opaque API key (single printable line, 20+ chars)",
    formatCheck: (v) => (
      v.length >= 20
      && v.trim() === v
      && !/^Bearer\s/i.test(v)
      && isSinglePrintableAsciiLine(v)
    ),
    doctorHints: [
      {
        condition: (v) => v.startsWith("sk-ant-"),
        message: "This looks like an Anthropic key, not Venice",
      },
      {
        condition: (v) => v.startsWith("sk-proj-") || (v.startsWith("sk-") && !v.startsWith("sk_")),
        message: "This looks like an OpenAI key, not Venice",
      },
      {
        condition: (v) => v.startsWith("fw_"),
        message: "This looks like a Fireworks key, not Venice",
      },
      {
        condition: (v) => v.startsWith("AIzaSy"),
        message: "This looks like a Google key, not Venice",
      },
      {
        condition: (v) => v.trim() !== v,
        message: "Key has leading/trailing whitespace",
      },
      {
        condition: (v) => /^Bearer\s/i.test(v.trimStart()),
        message: "Paste the raw Venice key only — do not include a 'Bearer ' prefix",
      },
      {
        condition: (v) => !isSinglePrintableAsciiLine(v) && v.trim() === v,
        message: "Key must be one printable line without spaces or control characters",
      },
      {
        condition: (v) => v.trim().length > 0 && v.trim().length < 20,
        message: "Key appears truncated",
      },
    ],
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    envVar: "ELEVENLABS_API_KEY",
    category: "voice",
    purpose: "Text-to-speech — gives the assistant a voice",
    required: false,
    signupUrl: "https://elevenlabs.io/app/developers/api-keys",
    formatHint: "sk_...",
    formatCheck: (v) => v.startsWith("sk_") && v.length >= 20,
    doctorHints: [
      {
        condition: (v) => v.startsWith("sk-ant-"),
        message: "This looks like an Anthropic key, not ElevenLabs",
      },
    ],
  },
  {
    id: "groq",
    name: "Groq",
    envVar: "GROQ_API_KEY",
    category: "voice",
    purpose: "Speech-to-text transcription (Whisper)",
    required: false,
    signupUrl: "https://console.groq.com/keys",
    formatHint: "gsk_...",
    formatCheck: (v) => v.startsWith("gsk_") && v.length > 20,
    doctorHints: [
      {
        condition: (v) => v.startsWith("sk-") || v.startsWith("sk_"),
        message: "This looks like an OpenAI or ElevenLabs key, not Groq",
      },
      {
        condition: (v) => v.trim() !== v,
        message: "Key has leading/trailing whitespace",
      },
    ],
  },
  {
    id: "tavily",
    name: "Tavily",
    envVar: "TAVILY_API_KEY",
    category: "search",
    purpose: "Web search — enables internet access",
    required: false,
    signupUrl: "https://app.tavily.com/home",
    formatHint: "tvly-...",
    formatCheck: (v) => v.startsWith("tvly-") && v.length > 10,
    doctorHints: [],
  },
  {
    id: "browser-use",
    name: "Browser Use",
    envVar: BROWSER_USE_API_KEY_ENV_VAR,
    category: "browser",
    purpose: "Protected website sign-in and cloud browser automation",
    required: false,
    signupUrl: "https://cloud.browser-use.com/settings?tab=api-keys&new=1",
    formatHint: "bu_...",
    formatCheck: (v) => (
      v.startsWith("bu_")
      && v.length > 10
      && v.trim() === v
      && isSinglePrintableAsciiLine(v)
    ),
    doctorHints: [
      {
        condition: (v) => v.trim() !== v,
        message: "Key has leading/trailing whitespace",
      },
      {
        condition: (v) => v.trim().length > 0 && !v.trim().startsWith("bu_"),
        message: "Browser Use API keys start with bu_",
      },
      {
        condition: (v) => v.trim().length > 0 && v.trim().length <= 10,
        message: "Key appears truncated",
      },
    ],
    // Browser Use V4 documents no non-mutating credential-health endpoint.
    healthCheck: "format_only",
  },
  {
    id: "cloudconvert",
    name: "CloudConvert",
    envVar: "CLOUDCONVERT_API_KEY",
    category: "conversion",
    purpose: "Cloud file conversion — unlocks the CloudConvert backend for the convert tool",
    required: false,
    signupUrl: "https://cloudconvert.com/dashboard/api/v2/keys",
    // CloudConvert v2 keys are JWTs (typically ~800–1200 chars, three
    // base64url segments). Short / two-segment pastes are almost always
    // truncated copies and fail live auth with Unauthenticated.
    formatHint: "JWT (eyJ… three segments, usually ~1000 chars)",
    formatCheck: (v) => {
      const t = v.trim();
      if (t.startsWith("Bearer ")) return false;
      const parts = t.split(".");
      return (
        parts.length === 3 &&
        parts.every((p) => p.length >= 20) &&
        t.length >= 200
      );
    },
    doctorHints: [
      {
        condition: (v) => v.trimStart().startsWith("Bearer "),
        message: "Paste the raw JWT only — do not include a 'Bearer ' prefix",
      },
      {
        condition: (v) => {
          const t = v.trim();
          const parts = t.split(".");
          return t.length > 0 && (parts.length !== 3 || t.length < 200);
        },
        message:
          "CloudConvert keys are long JWTs (three segments, often ~1000 chars). This value looks truncated or incomplete",
      },
      {
        condition: (v) => v.startsWith("sk-ant-"),
        message: "This looks like an Anthropic key, not CloudConvert",
      },
      {
        condition: (v) => v.startsWith("sk-proj-") || (v.startsWith("sk-") && !v.startsWith("sk_")),
        message: "This looks like an OpenAI key, not CloudConvert",
      },
      {
        condition: (v) => v.startsWith("tvly-"),
        message: "This looks like a Tavily key, not CloudConvert",
      },
      {
        condition: (v) => v.trim() !== v,
        message: "Key has leading/trailing whitespace",
      },
    ],
  },
];

export function getAllKeyDefinitions(): KeyDefinition[] {
  return KEY_REGISTRY;
}

export function getKeyDefinition(id: string): KeyDefinition | undefined {
  return KEY_REGISTRY.find((k) => k.id === id);
}

export function getKeyByEnvVar(envVar: string): KeyDefinition | undefined {
  return KEY_REGISTRY.find((k) => k.envVar === envVar);
}

export function firstDoctorHint(def: KeyDefinition, value: string): string | null {
  for (const h of def.doctorHints) {
    if (h.condition(value)) {
      return h.message;
    }
  }
  return null;
}

export function maskValue(value: string): string {
  if (value.length <= 12) {
    return `${value.slice(0, 4)}...`;
  }
  return `${value.slice(0, 8)}...`;
}
