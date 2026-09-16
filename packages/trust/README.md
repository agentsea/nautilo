# @nautilo/trust

Policy resolution, room and agent queries, Logto integration, and trust-layer types.

## Model list pipeline (D086 Phase 4)

The Workbench / Electron **Settings → Model** UI loads models through one HTTP surface:

`ModelSection` → `apiClient.getModels()` → `GET /api/config/models` → `getEligibleModels()` in `@nautilo/agent` (returning `EligibleModel` rows whose **types** are defined in this package).

Non-Venice `EligibleModel.capabilities` are a **UI projection** of `@nautilo/model-capabilities` (`resolveModelCapabilities()`); Venice rows use the same base projection, then overlay fields from a **disk cache** of `GET https://api.venice.ai/api/v1/models` (`data/venice-models-catalog.json` under the resolved storage root, overridable via `NAUTILO_VENICE_MODELS_CACHE_PATH`). Static defaults apply until the first successful refresh.

## D112 onboarding + D094 CLI consumption (Phase 5 contract)

- **Onboarding (D112)** should call the same Phase 4 API as the server route: `getEligibleModels({ tier, includeUnavailable, allowChinaUpstream })` from `@nautilo/agent`. Use `includeUnavailable: true` when surfacing Venice rows that need a key. Do not maintain a separate Venice-only model list or duplicate picker filtering.
- **Admin CLI (D094)** can call `getEligibleModels()` for tab-completion and display metadata; policy and filtering stay in `@nautilo/agent` / `@nautilo/trust` types — the CLI should not reimplement eligibility rules.
- **Workbench / Electron Settings → Model** is wired in **Phase 4.7** (shared picker source). It is not a Phase 5 deliverable; Phase 5 only documents that D112 and D094 consume the same primitives.
- If onboarding or CLI need extra display-only fields, extend `EligibleModel` / `GetEligibleModelsOptions` in this package (Phase 4) rather than adding a D112-only adapter type.
