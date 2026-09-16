import type { SourceAlarmReview } from "../src/node/source-alarm-review";

function declaration(
  locator: string,
  owner: string,
  declarationId: string,
  reason: string,
): SourceAlarmReview {
  return {
    locator,
    owner,
    closure: "declaration",
    declarationId,
    reason,
  };
}

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

/** Exact source-alarm review for the dormant Wave 7 implementation. */
export const REVIEWED_WAVE_7_SOURCE_ALARMS: readonly SourceAlarmReview[] = [
  exclusion(
    "packages/db/scripts/finalize-crypto-delivery-migration.ts#filesystem_write:d005bf0747616ddb:1",
    "packages/db",
    "exclusion.wave7.generated-migration-finalizer",
    "This build-time helper writes only deterministic generated migration DDL after Drizzle generation; it never processes product content or key material.",
  ),
  exclusion(
    "packages/lattice-bridge/scripts/run-browser-vault-integration.ts#log_emitter:468c68ed4723a1f2:1",
    "packages/lattice-bridge",
    "exclusion.wave7.browser-harness-launch-log",
    "This test-only diagnostic emits a fixed browser-engine name and launch status, with no vault bytes, profile identifiers, or recovery material.",
  ),
  exclusion(
    "packages/lattice-bridge/scripts/run-browser-vault-integration.ts#log_emitter:468c68ed4723a1f2:2",
    "packages/lattice-bridge",
    "exclusion.wave7.browser-harness-run-log",
    "This test-only diagnostic emits a fixed browser-engine name and harness status, with no vault bytes, profile identifiers, or recovery material.",
  ),
  exclusion(
    "packages/lattice-bridge/scripts/run-browser-vault-integration.ts#log_emitter:468c68ed4723a1f2:3",
    "packages/lattice-bridge",
    "exclusion.wave7.browser-harness-result-log",
    "This test-only diagnostic emits only fixed assertion labels returned by the synthetic browser harness and never emits the synthetic profile canary.",
  ),
  exclusion(
    "packages/lattice-bridge/scripts/run-browser-vault-integration.ts#log_emitter:02d6d32a757bab9d:1",
    "packages/lattice-bridge",
    "exclusion.wave7.browser-harness-platform-warning",
    "This test-only warning contains only a fixed unsupported-platform explanation and no runtime, profile, or cryptographic data.",
  ),
  exclusion(
    "packages/lattice-bridge/scripts/run-browser-vault-integration.ts#network_processor:5023a20296f359e1:1",
    "packages/lattice-bridge",
    "exclusion.wave7.browser-harness-loopback-handler",
    "This test-only loopback HTTP handler serves only the generated synthetic browser harness bundle and a fixed HTML shell from an ephemeral local port.",
  ),
  exclusion(
    "packages/lattice-bridge/scripts/run-browser-vault-integration.ts#temporary_storage:0e6fc8a36ae6f0b6:1",
    "packages/lattice-bridge",
    "exclusion.wave7.browser-harness-system-temp-root",
    "This test-only system temporary-directory lookup carries no bytes and is used only to scope a uniquely named browser bundle directory.",
  ),
  exclusion(
    "packages/lattice-bridge/scripts/run-browser-vault-integration.ts#temporary_storage:b34ab20f4fb8fd81:1",
    "packages/lattice-bridge",
    "exclusion.wave7.browser-harness-temporary-bundle",
    "This test-only directory contains only a generated synthetic browser harness bundle and is recursively removed in the runner's finalizer.",
  ),
  declaration(
    "packages/lattice-bridge/src/client/file-vault.ts#filesystem_write:b4a5e2ff1e6b7a09:1",
    "packages/lattice-bridge",
    "source.wave7.file.encrypted-client-vault-temp",
    "This atomic mode-0600 temporary write contains only an authenticated encrypted profile document or an OS-protected wrapping-key envelope.",
  ),
  declaration(
    "packages/lattice-bridge/src/client/file-vault.ts#filesystem_write:f68b0e5d292e324e:1",
    "packages/lattice-bridge",
    "source.wave7.file.encrypted-client-vault-publish",
    "This atomic rename publishes only the authenticated encrypted profile document or OS-protected wrapping-key envelope previously written mode 0600.",
  ),
  exclusion(
    "packages/lattice-bridge/src/server/delivery/postgres-device-delivery-fetch-repository.ts#network_processor:cefa5ac0fc46bc91:1",
    "packages/lattice-bridge",
    "exclusion.wave7.delivery-fetch-method-name",
    "The scanner matched the repository method named fetch; this callsite performs an exact role-verified Postgres transaction and is not a network fetch API.",
  ),
];
