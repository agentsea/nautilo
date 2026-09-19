import type { KeyReport } from "@nautilo/config-guard";
import { SquareCheck, X } from "lucide-react";

// Keep this explicit UI projection aligned with the runtime provider owners;
// KeyReport categories are broader registry groupings, not capabilities.
const COVERAGE_ROWS = [
  {
    functionality: "Chat",
    providers: [
      ["nautilo-gateway", "Nautilo Gateway"],
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
      ["nautilo-gateway", "Nautilo Gateway"],
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

      <table className="mt-3 w-full table-fixed border-collapse text-left text-xs">
        <thead>
          <tr className="border-b border-border text-foreground-muted">
            <th scope="col" className="w-2/5 pb-2 pr-3 font-medium">
              Functionality
            </th>
            <th scope="col" className="w-3/5 pb-2 font-medium">
              Providers
            </th>
          </tr>
        </thead>
        <tbody>
          {COVERAGE_ROWS.map(({ functionality, providers }) => {
            const covered = providers.some(([id]) => configuredProviderIds.has(id));
            return (
              <tr
                key={functionality}
                className="border-b border-border/40 last:border-b-0"
              >
                <th scope="row" className="py-2 pr-3 align-top font-medium text-foreground">
                  <span className="flex min-w-0 items-start gap-2">
                    {covered ? (
                      <SquareCheck
                        role="img"
                        aria-label={`${functionality}: supporting API key configured`}
                        className="mt-0.5 size-4 shrink-0 text-[var(--success)]"
                      />
                    ) : (
                      <X
                        role="img"
                        aria-label={`${functionality}: no supporting API key configured`}
                        className="mt-0.5 size-4 shrink-0 text-foreground-dim"
                      />
                    )}
                    <span className="min-w-0 break-words">{functionality}</span>
                  </span>
                </th>
                <td className="py-2 align-top">
                  <div className="flex min-w-0 flex-wrap gap-1.5">
                    {providers.map(([id, name]) => {
                      const configured = configuredProviderIds.has(id);
                      return (
                        <span
                          key={id}
                          aria-label={`${name}: ${configured ? "API key configured" : "API key not configured"}`}
                          className={
                            configured
                              ? "max-w-full break-words rounded-full bg-[var(--success)]/15 px-2 py-0.5 font-medium text-[var(--success)]"
                              : "max-w-full break-words rounded-full bg-background-element px-2 py-0.5 text-foreground-muted"
                          }
                        >
                          {name}
                        </span>
                      );
                    })}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
