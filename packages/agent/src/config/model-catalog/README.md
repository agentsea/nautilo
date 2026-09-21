# Model catalog compatibility

The bundled `seed/catalog.json` is an exact import from the canonical model
catalog. `model-catalog-source-parity.test.ts` pins the compact JSON plus newline
artifact hash. Change metadata at its canonical source before importing it here.

Version 4 adds the `decision` workload. Its `decision.inputTokens` and
`decision.maxChoices` describe the Choice provider's input constraints; they are
not chat context/output limits. Decision rows have no chat feature or intelligence
claims. Versions 1–3 keep their existing validation rules.

Version 6 adds Choice, Noul (binary probability), and Score operations, shared-state
multi-question support, aggregate token budgets, score level bounds, and reviewed
rate cards. Input modality remains independent of operation: the installed Jev
adapters currently accept text/JSON only. Image or extraction metadata cannot
install an executable adapter.

The direct TypeSafe route uses `TYPESAFE_API_KEY`; Venice and OpenRouter reuse
existing provider credentials. Server Controls exposes TypeSafe as a decision
provider, so it cannot satisfy chat setup. `discover_models` can filter by
`decision_operation`; `evaluate_decisions` evaluates independent named questions
within an admitted, non-Full-encryption turn and its cancellation signal. It
returns a complete validated batch or a failure, never a partial success or an
action. The existing browser Choice consumer uses the same transport.

Each evaluation makes one HTTP request without hidden retries. Provider usage
is recorded once even when a billed result is malformed or arrives after
cancellation. Provider-reported cost and identity remain distinct from catalog
price estimates and requested aliases. Current promotional rates are catalog
metadata, not permanent promises. No request content belongs in diagnostics.

## Reader compatibility

The current reader uses `https://media.nautilo.ai/models/v6/latest.json`.
The private publisher derives compatible v3, v4 and v5 views from one authored
manifest. V3 omits decisions, speech, and `features.visualGrounding`; v4 omits
speech; v4/v5 retain only text Choice routes their installed adapters support,
with the original closed decision metadata. V5 preserves speech.

Every view has its own signed hash and immutable artifact. All artifacts are
verified before pointer promotion. Reader changes do not publish feeds: until
a compatible signed feed is available, the reader retains its validated
last-known-good or bundled fallback. Invalid signatures and schemas never
replace the active valid catalog.

## Visual grounding metadata

Optional `features.visualGrounding` describes screenshot-to-coordinate support
for the exact catalog route. Missing or `null` means unknown. Support does not
promise equal accuracy, replace fresh-state verification, or follow merely from
image input. `discover_models` exposes the fact and its positive capability filter;
it does not change browser execution or choose a helper automatically. Qualify the
reader before publishing this field: older strict readers reject unknown feature
keys and keep their validated fallback.

Version 5 adds a separate `speech` workload with fixed, locally implemented
transport identifiers, supported output formats, provider request character
limits, and estimated USD per thousand characters. Speech rows are excluded
from chat selection. The server-wide speech setting selects an exact catalog
ID; when unset, the first runnable speech row in catalog priority order wins.
Replies freeze that selection at admission and retain each Genie's voice.
Catalog authoring, signed publication, and installed reader adoption remain separate release steps.
