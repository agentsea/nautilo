import { PROVIDER_KEY_CATALOGUE, type ProviderKeyCatalogueEntry } from "@nautilo/types";
import type { KeyDefinition } from "./types";

export const BROWSER_USE_API_KEY_ENV_VAR = "BROWSER_USE_API_KEY";

function isSinglePrintableAsciiLine(value: string): boolean {
  return [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 0x21 && code <= 0x7e;
  });
}

type KeyBehaviour = Omit<KeyDefinition, keyof ProviderKeyCatalogueEntry>;

function providerKey(id: string, behaviour: KeyBehaviour): KeyDefinition {
  const presentation: ProviderKeyCatalogueEntry | undefined = PROVIDER_KEY_CATALOGUE
    .find((entry) => entry.id === id);
  if (!presentation) throw new Error(`Missing provider-key presentation for ${id}`);
  return {
    ...presentation,
    signupUrl: presentation.signupUrl ?? "",
    formatHint: presentation.formatHint ?? "",
    ...behaviour,
  };
}

export const KEY_REGISTRY: KeyDefinition[] = [
  providerKey("typesafe", {
    formatCheck: (value) => value.length > 0 && isSinglePrintableAsciiLine(value) && !/^Bearer\s/i.test(value),
    doctorHints: [],
  }),
  providerKey("anthropic", {
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
  }),
  providerKey("openai", {
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
  }),
  providerKey("openrouter", {
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
  }),
  providerKey("gateway", {
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
  }),
  providerKey("google", {
    // Google keys are opaque: classic AI Studio keys are AIzaSy…, but Cloud /
    // Gemini console also issues other prefixes (e.g. AQ.…). Accept any
    // non-trivial length; live validity is checked by health-checker.
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
  }),
  providerKey("xai", {
    formatCheck: (value) => (
      value.length > 0
      && value.trim() === value
      && !/^Bearer\s/i.test(value)
      && isSinglePrintableAsciiLine(value)
    ),
    doctorHints: [
      {
        condition: (value) => value.trim() !== value,
        message: "Key has leading/trailing whitespace",
      },
      {
        condition: (value) => /^Bearer\s/i.test(value.trimStart()),
        message: "Paste the raw xAI key only — do not include a 'Bearer ' prefix",
      },
    ],
    healthCheck: "format_only",
  }),
  providerKey("fireworks", {
    formatCheck: (v) => v.startsWith("fw_") && v.length > 10,
    doctorHints: [],
  }),
  providerKey("together", {
    formatCheck: (value) => (
      value.length > 0
      && value.trim() === value
      && !/^Bearer\s/i.test(value)
      && isSinglePrintableAsciiLine(value)
    ),
    doctorHints: [
      {
        condition: (value) => value.trim() !== value,
        message: "Key has leading/trailing whitespace",
      },
      {
        condition: (value) => /^Bearer\s/i.test(value.trimStart()),
        message: "Paste the raw Together AI key only — do not include a 'Bearer ' prefix",
      },
    ],
    healthCheck: "format_only",
  }),
  providerKey("venice", {
    // Venice publishes opaque tokens without a stable prefix convention.
    // Reject paste/transport mistakes locally, then let the live models probe
    // be the authority on whether an otherwise-plausible token is valid.
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
  }),
  providerKey("surplus", {
    formatCheck: (value) => (
      value.length > 0
      && value.trim() === value
      && !/^Bearer\s/i.test(value)
      && isSinglePrintableAsciiLine(value)
    ),
    doctorHints: [
      {
        condition: (value) => value.trim() !== value,
        message: "Key has leading/trailing whitespace",
      },
      {
        condition: (value) => /^Bearer\s/i.test(value.trimStart()),
        message: "Paste the raw Surplus key only — do not include a 'Bearer ' prefix",
      },
    ],
  }),
  providerKey("elevenlabs", {
    formatCheck: (v) => v.startsWith("sk_") && v.length >= 20,
    doctorHints: [
      {
        condition: (v) => v.startsWith("sk-ant-"),
        message: "This looks like an Anthropic key, not ElevenLabs",
      },
    ],
  }),
  providerKey("groq", {
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
  }),
  providerKey("tavily", {
    formatCheck: (v) => v.startsWith("tvly-") && v.length > 10,
    doctorHints: [],
  }),
  providerKey("browser-use", {
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
  }),
  providerKey("cloudconvert", {
    // CloudConvert v2 keys are JWTs (typically ~800–1200 chars, three
    // base64url segments). Short / two-segment pastes are almost always
    // truncated copies and fail live auth with Unauthenticated.
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
  }),
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
