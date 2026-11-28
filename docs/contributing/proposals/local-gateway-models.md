# Select qualified models from the OpenAI-compatible gateway

## Status

`PROPOSED`

Only maintainers change this to `APPROVED FOR PROTOTYPE` or
`APPROVED FOR IMPLEMENTATION` during review.

## Published problem

- Public problem URL: <https://nautilo.ai/community/roadmap#local-ai>
  ("Run models on hardware you control")
- Proposal issue URL: https://github.com/agentsea/nautilo/issues/192
- Contribution mode and approval state shown on the problem: open for
  proposals ("Propose an approach"); the brief asks for a measured
  model-and-hardware experiment that builds on Nautilo's provider architecture
  rather than a separate agent stack.

## Outcome

A server administrator who runs models on hardware they control can choose
those models for Genie chat and for background text work, through the
OpenAI-compatible gateway Nautilo already supports. Today the gateway can be
configured with a URL and key, but no gateway model can be selected for any
role, so the configuration has no effect on chat.

After this change the administrator opens **Server admin → Models**, sees the
models the gateway reports, checks one with a single test request, and selects
it as the chat default or for a background text role. Usage records show that
the model ran on the gateway and do not invent a cloud price for it.

This belongs in Nautilo because the gateway adapter, server funding route,
role resolution and model pickers already exist. What is missing is a safe way
for a model to enter admission. An external package cannot add that: admission
is deliberately limited to the signed catalogue and server-owned discovery.

## Verified current state

Inspected commit: `35042f97` (`upstream/main`, 2026-11-14).

### The gateway adapter exists and accepts local endpoints

- `gateway:<model>` ids route to `buildGatewayCreateModelOptions`, which reads
  `NAUTILO_GATEWAY_API_KEY`, `NAUTILO_GATEWAY_BASE_URL` and
  `NAUTILO_GATEWAY_LABEL` and creates an OpenAI-compatible client
  (`packages/agent/src/providers/universal.ts:244-278`, `:572-580`).
- `normalizeGatewayBaseUrl` accepts `http:` and `https:` base URLs, so a
  loopback or LAN endpoint is valid (`packages/agent/src/providers/universal.ts:232-242`).
- `gateway` is a supported catalogue provider prefix
  (`packages/agent/src/config/model-catalog/supported-providers.ts:14-26`).
- Funding treats `gateway:` ids as server-only
  (`packages/server/src/lib/model-funding.ts:254-258`, `:424`); personal
  gateway keys are excluded (`CHANGELOG.md:601`,
  `packages/types/src/provider-key-catalogue.ts:74`).

### No gateway model can be admitted

- A configured or selected model must pass `assertModelRunnable`
  (`packages/agent/src/config/model-role-resolution.ts:106-137`,
  `packages/agent/src/config/eligible-models.ts:306-317`).
- `resolveRetainedModels` only knows signed catalogue rows and caller-scoped
  MindSwapper discoveries; any other id becomes `unknown-model` with
  "model is not present in the current signed catalog"
  (`packages/agent/src/config/eligible-models.ts:267-303`).
- The checked-in fallback catalogue contains no `gateway:` row
  (`packages/agent/src/config/model-catalog/catalog.ts:14,32`; no `"gateway`
  in its seed). The signed remote catalogue served on 2026-11-14 also listed
  none (140 rows on a running server's Models page).
- `NAUTILO_MODEL_CATALOG_POINTER_URL` can point at another catalogue, but its
  pointer must be signed by a key built into the source
  (`packages/agent/src/config/model-catalog/runtime-catalog.ts:49-52`,
  `packages/agent/src/config/model-catalog/remote-catalog.ts:345-379`,
  `packages/agent/src/config/model-catalog/trusted-keys.ts:22-34`).
- `NAUTILO_MODEL` is read by `modelConfigDefaults` and `getDefaultModel`
  (`packages/server/src/routes/server-models.ts:221-241`), but config-guard
  rejects it as an unknown variable (`packages/config-guard/src/validator.ts:47-52`),
  and a `gateway:` value would fail admission anyway.
- Execution limits for an uncatalogued id throw
  `MissingModelExecutionLimitsError(..., "not-catalogued")`
  (`packages/agent/src/providers/models.ts:220-235`).
- Chat roles with purpose `chat-tools` require `features.tools === true`
  (`packages/agent/src/config/eligible-models.ts:16-40`,
  `packages/agent/src/config/model-role-resolution.ts:19-34`).

### Text that promises what does not exist

- The API Keys entry says the gateway "also requires NAUTILO_GATEWAY_BASE_URL
  and a gateway model selection" (`packages/types/src/provider-key-catalogue.ts:34`).
  No such selection exists.
- `.env.example:65` shows `NAUTILO_MODEL=gateway:openai/gpt-oss-120b`, which
  is both a disallowed variable and an inadmissible model.
- The `getModelById` comment says dynamic gateway ids "work without a catalog
  row" (`packages/agent/src/config/assistant-models.ts:217-219`); they do not.

### Precedent: MindSwapper live discovery

MindSwapper models enter admission through server-owned discovery of
`<base>/models`. The fetch is bounded (512 rows, 1 MiB, 5 s timeout,
`redirect: "error"`), the result is held in memory with a 30 s refresh and a
5 min maximum age, and it is scoped per caller with `AsyncLocalStorage`
(`packages/server/src/lib/mindswapper-catalog.ts:6-14`, `:122-147`, `:182-186`;
`packages/agent/src/config/mindswapper-models.ts:30-59`). Discovered rows are
projected next to signed rows (`packages/agent/src/config/eligible-models.ts:161-245`,
`packages/agent/src/config/resolved-catalog.ts:409-450`, `:613-629`) and are
restricted to chat (`packages/agent/src/config/model-role-resolution.ts:121-122`).
MindSwapper's model list reports capabilities; a generic OpenAI-compatible
`/models` list does not.

### Cost recording today

An unpriced model is priced at the Sonnet baseline times its cost coefficient
(`packages/agent/src/config/model-pricing.ts:294-312`). A gateway model would
therefore be recorded with an estimated cloud price even when it runs on local
hardware at no per-token cost.

### Base URL configuration

`NAUTILO_GATEWAY_BASE_URL` is a config-guard mode entry validated as an http(s)
URL (`packages/config-guard/src/mode-registry.ts:278-283`). The Workbench can
store the gateway key but not the base URL; the CLI or instance environment
sets it.

## Measured experiment

Hardware: AMD Ryzen AI Max+ PRO 495 with Radeon 8065S graphics, 192 GB
unified memory (160 GB assigned to the GPU), Windows 11 Pro. Runtime: Unsloth
Studio serving GGUF models behind an OpenAI-compatible endpoint on
`http://127.0.0.1:8888/v1`. Model: Ornith-1.5-35B-A3B (mixture of experts,
GGUF, about 25 GB).

Each run sends one system prompt of filler context, one user question and
30 tool definitions, expects a `get_weather` call for Berlin, returns a tool
result and expects a one-sentence answer that uses it.

| Prompt tokens | Correct tool call | Answer used result | Call time, first / repeat |
| --- | --- | --- | --- |
| 4,495 | 2 of 2 | 2 of 2 | 152.9 s / 2.9 s |
| 19,135 | 2 of 2 | 2 of 2 | 42.1 s / 4.7 s |
| 30,385 | 2 of 2 | 2 of 2 | 39.4 s / 6.6 s |

The answer turn took 2.9–4.9 s. Repeat calls benefit from the runtime's
prompt cache, which matches a Genie conversation whose system prompt is
stable across turns. The first call of a run includes cache misses; the
153 s outlier at 4,495 tokens was the first request after the model had been
idle and was not investigated further. For comparison, ordinary Genie chat
turns on the same server sent 21,000 and 34,000 input tokens per model call.

`/v1/models` on this runtime reports `loaded` for each model, and
`context_length` (262,144 for Ornith) only for the model that is loaded.
Other runtimes report different fields or none. Twenty models were listed,
including speech and embedding models that cannot serve chat.

Limitations: one model, one runtime, one machine, synthetic tasks. No
multi-turn Genie session, memory or Task workload was measured yet; the
implementation slice must add that evidence.

## Proposed requirements

All requirements are `PROPOSED`.

1. **Discovery.** When the gateway key and base URL are configured, the server
   reads `<base>/models` with the same class of bounds as MindSwapper
   discovery: row and byte limits, a timeout, `redirect: "error"`, no
   credentials in logs. Model ids are untrusted strings: they are length- and
   character-checked and rendered as text.
2. **Qualification on request.** An administrator with
   `manage_server_operations` can check one discovered model. The server sends
   one bounded chat-completions request with a fixed synthetic prompt and one
   tool definition. The model passes the chat check when the response is a
   valid chat completion, and the function-calling check when it contains
   exactly one call to that tool with parseable arguments that name the
   requested value. No Human content is sent. Discovery never triggers a
   check automatically, because a check can load a model into memory.
3. **Limits.** A qualified model needs a context size and an output limit.
   The context size is taken from a recognised field in the gateway's model
   list when present (for example `context_length`, `max_model_len`);
   otherwise the administrator enters it. The administrator confirms or
   enters the output limit.
4. **Durable record.** The result (model id, outcome of each check, limits,
   checked-at time, checking administrator) is stored server-side and bound
   to the gateway destination: the normalized base URL and a fingerprint of
   the key. Changing either invalidates every qualification.
5. **Admission.** A qualified model becomes a `gateway:<id>` row next to signed
   rows, with `features.tools` set from the function-calling check and its
   limits from requirement 3. It is selectable while it appears in a
   discovery snapshot no older than a bounded age. Otherwise it is listed as
   unavailable with a reason such as "gateway unreachable" or "model no longer
   listed".
6. **Roles.** A qualified model can be selected wherever an administrator
   chooses a text model: chat default, fallback chain, conductor,
   stenographer, reflection and memory review, plus exact native text Task
   selection and `discover_models`. Roles with purpose `chat-tools` require a
   passed function-calling check; roles with purpose `chat` require a passed
   chat check. Embeddings, image understanding, image, music, video and
   speech roles are excluded. Automatic role candidates never select a
   gateway model; only an explicit administrator choice does.
7. **No silent substitution.** A selected gateway model that becomes
   unavailable fails with an explicit, actionable error. It is never replaced
   by another provider except through the fallback chain the administrator
   configured.
8. **Funding.** Gateway models remain server-funded and require
   `use_server_provider_credentials`, as today.
9. **Cost.** Usage for a gateway model does not use the Sonnet baseline. It is
   recorded as `unknown` unless the gateway reports a cost or the
   administrator sets a price for the model; a price of zero is allowed for
   local hardware.
10. **Corrected text.** The API Keys description, `.env.example` and the
    `getModelById` comment describe the real behaviour.

## Constraints and non-goals

- No change to signed-catalogue trust, its keys or its pointer rules.
- No personal gateway keys; the gateway stays server-only.
- No embeddings, vision, image, audio or video through the gateway in this
  proposal.
- No automatic qualification of every discovered model.
- No new provider type and no parallel agent stack; the existing `gateway:`
  adapter performs inference.
- No Workbench field for the gateway base URL in this proposal. It is a
  separate, smaller change, noted under unknowns.
- No LAN or HTTPS deployment work; that is a separate problem.
- The gateway key health check is out of scope here; it is addressed in
  [agentsea/nautilo#189](https://github.com/agentsea/nautilo/pull/189).

## Product and architecture fit

- **Identity and ownership.** The gateway destination is server configuration
  owned by administrators. Qualification records belong to the server, not to
  a Human. The checking administrator is recorded for audit.
- **Permissions.** Discovery reads follow `read_server_settings`, like the
  Models page. Checks and limit edits require `manage_server_operations`,
  like model selection (`packages/server/src/routes/server-models.ts:633-703`).
  Both write audit events.
- **Data flow.** Discovery and checks send only the fixed probe and the
  gateway key to the configured destination. Ordinary inference sends the same
  data it would send to any provider; the administrator chose that
  destination.
- **Execution.** Inference uses the existing adapter and funding route. The
  model row, limits and tool capability come from the qualification record
  instead of the signed catalogue.
- **Rooms, Namespaces, Agents.** Unchanged. A Genie using a gateway model has
  the same tools, approvals and Memory rules as with any other model.

## Unknowns and decision forks

1. **Storage.** (a) A new table keyed by destination fingerprint and model id
   (additive migration, clear ownership); (b) a JSONB column on
   `server_model_config` (no new table, but mixes per-model records into a
   singleton row); (c) `provider_catalog_cache` (exists, but has expiry
   semantics and suits caches, not decisions). Recommendation: (a).
2. **Scope of the discovered list.** Process-wide, because the gateway is
   server configuration, or scoped per caller with `AsyncLocalStorage` like
   MindSwapper. Process-wide is simpler. It needs confirmation that every
   process that resolves models (server, runtime executors, workers) installs
   the same snapshot.
3. **Limits source.** Which gateway fields are trusted for the context size,
   and whether a reported value is used directly or capped by an
   administrator value.
4. **Cost.** `unknown` by default with an optional administrator price
   (recommended), or always `unknown`, or the current baseline estimate.
5. **Requalification.** Whether a qualification expires after a period, or
   only when the destination, key or model listing changes.
6. **Intelligence tier.** MindSwapper defaults to `frontier`; a local model's
   tier is unknown. Options: `mid` (the general default), an administrator
   choice, or excluding gateway models from tier-based routing.
7. **Base URL in the Workbench.** Whether a follow-up should let
   administrators set the gateway URL beside its key, as MindSwapper allows.

## Implementation seams

- `packages/server/src/lib/`: gateway discovery and qualification (new
  module, modelled on `mindswapper-catalog.ts`); a new admin route under
  `/api/admin/` for listing, checking and editing limits.
- `packages/db`: schema and generated migration for the qualification record
  if fork 1(a) is chosen; query inventory update.
- `packages/agent/src/config/`: a gateway model source beside
  `mindswapper-models.ts`; branches in `resolved-catalog.ts`,
  `eligible-models.ts`, `model-role-resolution.ts`, `assistant-models.ts`,
  `model-selection.ts`, `validate-exact-task-model.ts`.
- `packages/agent/src/providers/models.ts`: execution limits for qualified
  gateway models.
- `packages/agent/src/config/model-pricing.ts` and usage recording: cost state
  for gateway models.
- `packages/server/src/routes/server-models.ts`: accept qualified gateway ids
  per role in `parseUpdateBody`; return discovery state.
- `apps/workbench/src/pages/admin/sections/models-section.tsx`: the gateway
  panel and the role selectors.
- `packages/api-client`: typed calls for the new route.
- Text corrections in `packages/types/src/provider-key-catalogue.ts`,
  `.env.example` and `assistant-models.ts`; operator documentation.

## Failure, recovery, and rollback

- **Gateway unreachable during discovery.** The panel shows the error and the
  time of the last good snapshot; qualified models become unavailable after
  the snapshot ages out. Selected roles fail with an explicit error.
- **Check fails or times out.** The model stays unqualified with the reason
  (no completion, no tool call, wrong tool, unparseable arguments, timeout).
  Nothing else changes. A check can be repeated.
- **Gateway changes its model list.** A missing model becomes unavailable
  with "model no longer listed"; its record is kept and is valid again if the
  model returns at the same destination.
- **Destination or key changes.** Every qualification for the old destination
  becomes invalid; selections stay stored but are refused until the model is
  checked again.
- **Inference errors.** Existing provider error handling and retries apply;
  failures do not change the funding source.
- **Restart.** Records are durable; discovery repopulates in memory.
- **Rollback.** Code rollback leaves the table unused. Stored role selections
  that name `gateway:` models are retained but refused by older code, which
  already rejects them; the administrator selects another model.

## Security and privacy

- The administrator already controls the gateway destination, and inference
  already sends requests there. Discovery and checks add a bounded `GET` and
  one bounded `POST` to the same destination, with redirects refused.
- The key is never logged, returned or placed in model context; records store
  only a fingerprint.
- Model ids from the gateway are untrusted text: length- and character-checked,
  escaped in the UI, and treated as data where `discover_models` shows them.
- The probe contains no Human content, Memory or credentials.
- No new route is reachable without the existing admin capabilities.

## Interaction evidence

The panel sits on **Server admin → Models**, above the role selectors.

```text
OpenAI-compatible gateway · Local LLM Gateway          [Refresh list]
http://127.0.0.1:8888/v1 · listed 20 models · 14:02

Model                                   Context    Status
Ornith-1.5-35B-A3B-…-GGUF               262,144    Qualified · tools   [Check again]
Qwen3.8-27B-CodeForge-…-GGUF            [ ____ ]   Needs context size  [Check]
Flint-40B-A2.5B-abliterated-GGUF        [ ____ ]   Needs context size  [Check]
OmniVoice-GGUF                          [ ____ ]   Failed · no completion
nomic-embed-text-v2-moe-GGUF            [ ____ ]   Not checked         [Check]
```

Model names and the Ornith context size come from the measured setup; the
other statuses illustrate the proposed states and were not measured.

States: gateway not configured (a link to API Keys), loading, unreachable
(error and last good time), empty list, checking (button busy, other rows
usable), qualified (chat only or chat with tools), failed with a reason,
needs context size, and model no longer listed.

Qualified models appear in each eligible role selector in a group named
after the gateway label, the same way MindSwapper models do today. Keyboard
and screen-reader behaviour follow the existing table and selector
components; status is given as text, not colour alone. On narrow screens the
table becomes a stacked list.

## Verification

- **Unit:** discovery parsing and bounds; id validation; each check
  outcome; destination binding and invalidation; admission per role and
  purpose; refusal of unqualified, stale and missing models; execution
  limits; cost state; `parseUpdateBody` acceptance and refusal; no automatic
  candidate selection.
- **Contract:** a fake OpenAI-compatible server fixture in tests, covering a
  model that calls the tool, one that answers in text, one that errors and one
  that hangs.
- **Integration:** foreground chat and a native text Task run on a qualified
  gateway model against the fixture, with usage rows showing the gateway and
  the expected cost state.
- **Manual QA:** Unsloth Studio on the hardware above, plus at least one
  other runtime (for example Ollama or LM Studio): discover, check, select as
  chat default, chat with tool use in the Workbench, unplug the gateway and
  observe the error, then restore.
- **Documentation:** operator documentation for configuring a gateway and
  qualifying models; CHANGELOG entry; corrected texts.
- **Migration checks** if a table is added: generated migration, query
  inventory, row-level security consistent with other server tables.

## Delivery slices

1. **Chat on a local model.** Discovery, qualification, durable record,
   admission for the chat default, execution limits, cost state, the panel and
   the chat selector. An administrator can chat with a Genie on a qualified
   local model end to end.
2. **Background text roles.** Conductor, stenographer, reflection, memory
   review, fallback chain, native text Tasks and `discover_models`.
3. **Documentation and corrections.** Operator guide, CHANGELOG, corrected
   API Keys text, `.env.example` and code comment. Small text fixes may land
   with slice 1.

## Stewardship

The author (GitHub `tobitege`) intends to maintain the discovery and
qualification code, its tests and fixtures, and the operator documentation,
and to re-run the measured experiment when the gateway contract changes. The
author runs a Windows server with local models and can verify releases on
that setup. Ownership of the shared admission and role-resolution code stays
with the maintainers of `packages/agent`.

## Maintainer decision

_Maintainer-owned. Contributors leave this section unchanged._

- Decision: `PENDING`
- Approved scope:
- Required revisions:
- Approval expiry or revalidation trigger:
