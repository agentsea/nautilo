import {
  configureSurplusModelCatalog,
  hydrateSurplusModelCatalog,
} from "../../src/providers/surplus-catalog";

/** Content-free vendor-shaped discovery, separate from the signed catalogue. */
const SURPLUS_CHAT_FIXTURES = [
  { id: "claude-sonnet-4.6", aliases: ["claude-sonnet-4-6", "anthropic/claude-sonnet-4.6"], context: 1_000_000, output: 64_000 },
  { id: "kimi-k3", aliases: ["moonshotai/kimi-k3", "accounts/fireworks/models/kimi-k3"], context: 1_000_000, output: 131_072 },
  { id: "kimi-k2.6", aliases: ["moonshotai/kimi-k2.6"], context: 262_142, output: 131_072 },
  { id: "minimax-m3-preview", aliases: [], context: 524_288, output: 65_536 },
  { id: "gpt-5.6-sol", aliases: ["openai/gpt-5.6-sol"], context: 1_050_000, output: 128_000 },
  { id: "gpt-5.5-2026-04-23", aliases: [], context: 1_050_000, output: 128_000 },
  { id: "gemini-2.5-pro", aliases: [], context: 1_048_576, output: 65_536 },
  { id: "gemini-3.1-pro-preview", aliases: [], context: 1_048_576, output: 65_536 },
] as const;

export async function installSurplusCatalogFixture(): Promise<void> {
  const rows = SURPLUS_CHAT_FIXTURES.map((model) => ({
    id: model.id,
    context_length: model.context,
    top_provider: { context_length: model.context, max_completion_tokens: model.output },
    architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
    supported_parameters: ["max_tokens", "tools", "tool_choice", "reasoning", "reasoning_effort"],
    supported_features: ["tools", "reasoning", "streaming", "vision"],
  }));
  configureSurplusModelCatalog({
    fetchImpl: ((input: Parameters<typeof fetch>[0]) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/v1/models") return Promise.resolve(Response.json({ data: rows }));
      const requested = decodeURIComponent(url.pathname.slice("/v1/models/".length));
      const model = SURPLUS_CHAT_FIXTURES.find((candidate) => candidate.id === requested
        || (candidate.aliases as readonly string[]).includes(requested));
      return Promise.resolve(model
        ? Response.json(rows.find((row) => row.id === model.id))
        : Response.json({ error: { code: "model_not_found" } }, { status: 404 }));
    }) as unknown as typeof fetch,
  });
  await hydrateSurplusModelCatalog(SURPLUS_CHAT_FIXTURES.flatMap((model) => [model.id, ...model.aliases]));
}
