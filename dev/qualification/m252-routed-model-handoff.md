# M252 routed-model qualification handoff

Candidate source: `packages/agent/tests/fixtures/m252-routed-model-candidates.json`

## Candidate routes

| Route | Family | Intended proof |
| --- | --- | --- |
| `openrouter:openai/gpt-5.5` | OpenAI | chat, tools, Tasks, usage identity |
| `openrouter:anthropic/claude-sonnet-4.6` | Anthropic | chat, tools, Tasks, usage identity |
| `openrouter:google/gemini-3.1-pro-preview` | Google | chat, tools, Tasks, usage identity |
| `venice:openai-gpt-55-pro` | OpenAI | chat, tools, Tasks, usage identity |
| `venice:claude-sonnet-4-6` | Anthropic | chat, tools, Tasks, usage identity |
| `venice:gemini-3-1-pro-preview` | Google | chat, tools, Tasks, usage identity |
| `openrouter:openai/gpt-image-2` | OpenAI image | image request and route attribution |
| `venice:gpt-image-2` | OpenAI image | image request and route attribution |
| `openrouter:openai/text-embedding-3-small` | OpenAI embedding | embedding request and route attribution |
| `venice:text-embedding-3-small` | OpenAI embedding via Venice | embedding request and route attribution |

## Automated evidence

- Candidate rows remain unpublished fixtures; ordinary selection still requires the signed catalog.
- `routed-candidate-qualification.test.ts` covers purpose qualification, family construction, and tool binding.
- `model-route.test.ts` covers route-independent underlying-family classification.
- `usage-callback-binding.test.ts` covers one route-preserving usage callback for every chat candidate.
- `image-gen-routed.test.ts` covers provider-specific requests, sanitized failures, and route-preserving usage identity.
- `embeddings.test.ts` and `routed-candidate-qualification.test.ts` cover provider-specific embedding requests and signed-catalog role resolution.
- Task exact and automatic selection use the same signed-catalog, credential, and capability resolver.

## Bounded live status

PASS on the disposable `m252-models-qa` clone (2026-08-12). The opt-in
qualification suite proved all six chat routes through a forced tool call,
tool result, final answer, and non-zero usage metadata; both embedding routes
returned 1536-dimensional vectors; both image routes returned one bounded PNG;
and invalid credentials produced provider-labeled errors without the supplied
secret. Route-qualified chat, embedding, and image rows were also observed in
the clone's `llm_usage_events` table.

The initial Venice BGE-M3 candidate was rejected: Venice accepted the requested
dimension but returned a fixed vector incompatible with Nautilo's
`pgvector(1536)`. `venice:text-embedding-3-small` replaced it and passed live.
OpenRouter chat responses supplied token usage but no provider-reported dollar
cost; later consumption accounting can use the preserved route and token
counts. OpenRouter embedding usage did include provider-reported cost.

Evidence:

- `NAUTILO_RUN_M252_LIVE=1 bun test --timeout 180000 packages/agent/tests/integration/m252-routed-provider-live.integration.test.ts`
  — 10 pass, 2 image-gated skips, 0 fail.
- The same suite with `NAUTILO_RUN_M252_LIVE_IMAGES=1` — both routed image
  tests passed live.
- `NAUTILO_INSTANCE_ID=m252-models-qa bun test --timeout 60000 packages/runtime/tests/integration/task-model-selection.integration.test.ts ...`
  — 34 pass, 0 fail across Task persistence and routed-provider focused tests.

Wave 4 must repeat the proof after these exact rows are published in the signed
catalog, including the ordinary picker, mutation, and execution path.

The bounded run must record chat, tool round trip, authentication failure sanitization, usage metadata, Task selection, one embedding request per route, and one small image per approved image route. Never record keys, authorization headers, prompts containing private data, or raw provider response bodies.
