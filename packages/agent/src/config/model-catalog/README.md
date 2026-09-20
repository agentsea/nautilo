# Model catalog compatibility

The bundled `seed/catalog.json` is an exact import from the canonical model
catalog. `model-catalog-source-parity.test.ts` pins the compact JSON plus newline
artifact hash. Change metadata at its canonical source before importing it here.

Version 4 adds the `decision` workload. Its `decision.inputTokens` and
`decision.maxChoices` describe the Choice provider's input constraints; they are
not chat context/output limits. Decision rows have no chat feature or intelligence
claims. Versions 1–3 keep their existing validation rules.

## Reader compatibility

The reader uses `https://media.nautilo.ai/models/v4/latest.json`. Older clients
keep using `https://media.nautilo.ai/models/latest.json` for the v3 view. Both
feeds use the same canonical catalog source and existing signature contract.

The private publisher generates the v3 view by omitting decision rows and fields
unknown to v3, including `features.visualGrounding`. This is a publication
transform, never a second authored catalog. Each view has its own signed hash
and immutable artifact; both artifacts are verified before either pointer moves.
Reader source changes do not themselves publish either feed. Until its feed is
published, a reader retains its validated last-known-good or bundled fallback.

The current reader uses the existing signature, artifact hash, strict schema, and
last-known-good path for v4 too. Invalid signatures or payloads never replace the
active valid catalog.

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
The v5 bootstrap is a candidate imported from canonical catalog authoring;
publication of the signed v5 channel is a separate release step.
