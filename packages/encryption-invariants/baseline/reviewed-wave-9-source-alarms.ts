import type { SourceAlarmReview } from "../src/node/source-alarm-review";

function exclusion(
  locator: string,
  owner: string,
  exclusionId: string,
  reason: string,
): SourceAlarmReview {
  return {
    locator,
    owner,
    closure: "reviewed_exclusion",
    exclusionId,
    reason,
  };
}

/**
 * Exact closures for development probes merged alongside Wave 9 and for the
 * Wave 9 migration/checkpoint diagnostics. None is a product plaintext
 * persistence or transport boundary.
 */
export const REVIEWED_WAVE_9_SOURCE_ALARMS: readonly SourceAlarmReview[] = [
  exclusion(
    "apps/desktop/scripts/smoke-packaged.ts#network_processor:5023a20296f359e1:1",
    "apps/desktop",
    "exclusion.wave9.packaged-smoke-loopback-server",
    "This test-only loopback handler returns fixed health, setup, and HTML smoke responses from an ephemeral local port; it receives no authenticated product content.",
  ),
  exclusion(
    "apps/workbench/scripts/ooxml-contract-probe.ts#network_processor:609dfabf69e7aab5:1",
    "apps/workbench",
    "exclusion.wave9.ooxml-contract-loopback-probe",
    "This test-only fetch polls the fixed local Vite root only for readiness and carries no document, credential, or product payload.",
  ),
  exclusion(
    "apps/workbench/scripts/ooxml-contract-probe.ts#subprocess_processor:4055b8de21f32fb0:1",
    "apps/workbench",
    "exclusion.wave9.ooxml-contract-vite-process",
    "This test-only subprocess starts the fixed local Vite contract harness; the OOXML fixture bytes remain in the bounded local probe and are not product data.",
  ),
  exclusion(
    "apps/workbench/scripts/ooxml-delivery-probe.ts#network_processor:f40c065106cc6ab2:1",
    "apps/workbench",
    "exclusion.wave9.ooxml-asset-delivery-probe",
    "This test-only probe fetches fixed parser asset names from an explicitly supplied Nautilo test server and records only status, headers, size, and magic-byte facts.",
  ),
  exclusion(
    "apps/workbench/scripts/ooxml-fixtures/generate_office.mjs#filesystem_write:0fd244be33e680c3:1",
    "apps/workbench",
    "exclusion.wave9.ooxml-malformed-fixture-write",
    "This developer-only generator writes a deterministic truncated OOXML test fixture beneath the committed fixture root and never handles product documents.",
  ),
  exclusion(
    "apps/workbench/scripts/ooxml-fixtures/generate_office.mjs#filesystem_write:fdce233afb698637:1",
    "apps/workbench",
    "exclusion.wave9.ooxml-reference-fixture-write",
    "This developer-only generator writes deterministic synthetic OOXML fixtures and reference renders beneath the committed fixture root and never handles product documents.",
  ),
  exclusion(
    "apps/workbench/scripts/ooxml-fixtures/generate_office.mjs#log_emitter:44b8f9f2ba0f8199:1",
    "apps/workbench",
    "exclusion.wave9.ooxml-fixture-generation-error",
    "This developer-only failure log can describe only deterministic synthetic fixture generation; it cannot contain authenticated product content or cryptographic material.",
  ),
  exclusion(
    "packages/db/scripts/finalize-m237-message-crypto-lifecycle.ts#filesystem_write:38832cb9afa308b1:1",
    "packages/db",
    "exclusion.wave9.generated-migration-finalizer",
    "This schema-development helper writes only reviewed deterministic migration DDL after Drizzle generation; it never processes product rows, content, or key material.",
  ),
  exclusion(
    "packages/runtime/src/conversation/protected-checkpoint-saver-disposal.ts#log_emitter:02d6d32a757bab9d:1",
    "packages/runtime",
    "exclusion.wave9.protected-checkpoint-disposal-summary",
    "This protected-runtime warning emits only fixed labels, booleans, bounded failure counts, and a closed close-status value; it never emits an exception message or checkpoint bytes.",
  ),
  exclusion(
    "packages/runtime/src/executors/fork-langgraph-executor.ts#log_emitter:89b81c36ea23316a:2",
    "packages/runtime",
    "exclusion.wave9.protected-fork-cleanup-warning",
    "This protected-runtime warning is a fixed content-free sentence after the callsite deliberately discards the caught exception; no transcript, checkpoint, or provider detail is emitted.",
  ),
];
