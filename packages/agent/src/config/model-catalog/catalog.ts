/**
 * D429 Phase 7 — local-only model catalog resolution.
 *
 * Parses the checked-in seed manifest through the strict
 * {@link ModelCatalogSchema} before any resolver code can consume it. This is
 * the deterministic fallback the runtime seam serves when no validated remote
 * snapshot exists, and the last-known-good bootstrap. It performs no network
 * I/O and never constructs provider URLs or credentials.
 */
import {
  ModelCatalogSchema,
  type ModelCatalog,
} from "@nautilo/types";
import seedManifest from "./seed/catalog.json";

/** Parse untrusted catalog JSON before resolver code can consume it. */
function parseModelCatalog(manifest: unknown): ModelCatalog {
  return ModelCatalogSchema.parse(manifest);
}

/**
 * Checked-in fallback / bootstrap. This is last-known-good evidence for the
 * fallback, NOT the canonical release source — the canonical source is the
 * signed remote release. Update it only as an explicit catalog/fallback
 * migration; future remote releases may legitimately diverge while this
 * fixture remains the fallback baseline (mirrors the Phase-6 parity contract).
 * Do not author new capability facts only in this seed: update the canonical
 * catalog source first, then import the reviewed manifest. The source-parity
 * test pins its serialized artifact hash so a local-only edit cannot silently
 * keep claiming the same release identity.
 */
export const localModelCatalog = parseModelCatalog(seedManifest);
