# Model catalog compatibility

The bundled `seed/catalog.json` is an exact import from the canonical model
catalog. `model-catalog-source-parity.test.ts` pins the compact JSON plus newline
artifact hash. Change metadata at its canonical source before importing it here.

Version 4 adds the `decision` workload. Its `decision.inputTokens` and
`decision.maxChoices` describe the Choice provider's input constraints; they are
not chat context/output limits. Decision rows have no chat feature or intelligence
claims. Versions 1–3 keep their existing validation rules.

## Reader compatibility

The current shared pointer serves v3 readers. Publishing the canonical v4 source
there would make those readers reject it and retain their validated last-known-good
catalog, or their bundled fallback if none exists.

Before releasing v4, the private publisher must derive two signed views from the
same canonical source: a v3 projection on the existing shared pointer and the full
v4 artifact on a version-specific pointer used by v4 readers. The projection omits
decision rows and fields unknown to v3, including `features.visualGrounding`; it is
an automatic publication transform, never a second authored catalog. That publisher
transform and pointer rollout are not implemented or published yet, so old clients
will receive continuing catalog updates only after the projection release exists.

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
