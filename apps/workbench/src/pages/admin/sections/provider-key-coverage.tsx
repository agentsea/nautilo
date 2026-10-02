import type { KeyReport } from "@nautilo/config-guard";
import { ProviderKeyCoverageTable } from "../../../components/provider-key-coverage-table";

// Keep this explicit UI projection aligned with the runtime provider owners;
// KeyReport categories are broader registry groupings, not capabilities.
const COVERAGE_ROWS = [
  {
    functionality: "Classification and scoring",
    providers: [["typesafe", "TypeSafe"], ["openrouter", "OpenRouter"], ["venice", "Venice"]],
  },
  {
    functionality: "Chat",
    providers: [
      ["venice", "Venice"],
      ["openrouter", "OpenRouter"],
      ["openai", "OpenAI"],
      ["anthropic", "Anthropic"],
      ["google", "Google"],
      ["fireworks", "Fireworks"],
      ["gateway", "OpenAI-compatible Gateway"],
    ],
  },
  {
    functionality: "Embeddings",
    providers: [
      ["venice", "Venice"],
      ["openrouter", "OpenRouter"],
      ["openai", "OpenAI"],
    ],
  },
  { functionality: "Text-to-speech", providers: [["elevenlabs", "ElevenLabs"]] },
  {
    functionality: "Speech-to-text",
    providers: [
      ["elevenlabs", "ElevenLabs"],
      ["groq", "Groq"],
    ],
  },
  {
    functionality: "Image generation",
    providers: [
      ["venice", "Venice"],
      ["openrouter", "OpenRouter"],
      ["openai", "OpenAI"],
      ["google", "Google"],
    ],
  },
  { functionality: "Music generation", providers: [["venice", "Venice"]] },
  { functionality: "Video generation", providers: [["venice", "Venice"]] },
  { functionality: "Web search", providers: [["tavily", "Tavily"]] },
  { functionality: "Browser use", providers: [["browser-use", "Browser Use"]] },
  {
    functionality: "Document conversion",
    providers: [["cloudconvert", "CloudConvert"]],
  },
] as const;

function isConfigured(status: KeyReport["status"]): boolean {
  return status === "present" || status === "verified";
}

export function ProviderKeyCoverage({ keys }: { keys: KeyReport[] }) {
  const configuredProviderIds = new Set(
    keys.filter((key) => isConfigured(key.status)).map((key) => key.id),
  );

  return (
    <section
      className="mb-5 border-b border-border pb-5"
      aria-labelledby="provider-key-coverage-title"
      data-testid="provider-key-coverage"
    >
      <h3 id="provider-key-coverage-title" className="text-sm font-semibold">
        API key coverage
      </h3>
      <p className="mt-1 text-xs text-foreground-muted">
        Shows API key coverage, not service availability. Additional configuration and local
        alternatives are not evaluated.
      </p>

      <ProviderKeyCoverageTable
        configuredProviderIds={configuredProviderIds}
        rows={COVERAGE_ROWS}
      />
    </section>
  );
}
