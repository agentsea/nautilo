import { createHash } from "node:crypto";
import type { CoverageSurface } from "../src/model";
import type { SourceAlarmReview } from "../src/node/source-alarm-review";
import { REVIEWED_MAIN_2026_08_11_SOURCE_ALARMS } from "./reviewed-main-2026-08-11-source-alarms";
import { REVIEWED_MAIN_2026_08_13_SOURCE_ALARMS } from "./reviewed-main-2026-08-13-source-alarms";
import { REVIEWED_MAIN_2026_08_29_SOURCE_ALARMS } from "./reviewed-main-2026-08-29-source-alarms";
import { REVIEWED_MAIN_2026_08_04_SOURCE_ALARMS } from "./reviewed-main-2026-08-04-source-alarms";
import { SOURCE_ALARM_BASELINE_REVIEWS } from "./source-alarm-reviews";

const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

const ownerFor = (locator: string): string =>
  locator.split("#", 1)[0]!.split("/").slice(0, 2).join("/");

const declaration = (
  locator: string,
  reason: string,
  declarationId = `source.ci-reconciliation.${digest(locator)}`,
): SourceAlarmReview => ({
  locator,
  owner: ownerFor(locator),
  closure: "declaration",
  declarationId,
  reason,
});

const exclusion = (
  locator: string,
  reason: string,
  exclusionId = `exclusion.ci-reconciliation.${digest(locator)}`,
): SourceAlarmReview => ({
  locator,
  owner: ownerFor(locator),
  closure: "reviewed_exclusion",
  exclusionId,
  reason,
});

const debt = (
  locator: string,
  surface: CoverageSurface,
  marker: string,
  reason: string,
  evidenceGap: string,
): SourceAlarmReview => {
  const kind = locator.match(/#([a-z_]+):/)?.[1] ?? "invalid";
  return {
    locator,
    owner: ownerFor(locator),
    closure: "baseline_debt",
    debtId: `debt.source-alarm.${surface}.${kind}.${digest(locator)}`,
    surface,
    remediationState: "untriaged",
    releaseImpact: "blocks_whole_product_claim",
    reason: `${locator} is a reviewed ${marker}. ${reason}`,
    evidenceGap: `${locator} lacks ${marker} evidence ${evidenceGap}`,
  };
};

const historicalOperationJournalLocators = REVIEWED_MAIN_2026_08_04_SOURCE_ALARMS
  .filter((review) =>
    review.closure === "declaration"
    && (
      review.declarationId.endsWith("operational-boundary-18")
      || review.declarationId.endsWith("operational-boundary-19")
    )
  )
  .map((review) => review.locator);

/** Exact historical reviews retired after checking the current source tree. */
export const SUPERSEDED_CI_SOURCE_RECONCILIATION_LOCATORS = new Set<string>([
  "apps/cli/src/commands/artifacts-relocate.ts#filesystem_write:281ad536784f833d:1",
  "apps/cli/src/lib/bootstrap-tokens.ts#filesystem_write:02b1e72e79b8972c:1",
  "apps/cli/src/lib/bootstrap-tokens.ts#filesystem_write:9e4c3c7cdae058fd:1",
  "apps/cli/src/lib/cli-release.ts#subprocess_processor:b074d89bb40f7a06:1",
  "apps/cli/src/lib/cli-release.ts#subprocess_processor:dcbe30e3ca8fc26f:1",
  "apps/cli/src/lib/cli-release.ts#subprocess_processor:e3b35ce5aabc1377:1",
  "apps/cli/src/lib/compose-driver-factory.ts#filesystem_write:4a8a176ddd6e9a0f:1",
  "apps/cli/src/lib/doctor-migrate-config.ts#filesystem_write:36514275337b0e01:1",
  "apps/cli/src/lib/doctor-migrate-config.ts#filesystem_write:7e02113c114f29d3:1",
  "apps/cli/src/lib/protected-handoff.ts#filesystem_write:bf7035716c6bbd17:1",
  "apps/cli/src/lib/railway-launch-state-store.ts#filesystem_write:c7ad26333722f974:1",
  "apps/cli/src/lib/railway-launch-state-store.ts#filesystem_write:d4e5d08ea1dfcf52:1",
  "apps/cli/src/lib/railway-maintenance-state.ts#filesystem_write:a022fe8ea98c3354:1",
  "apps/desktop/electron/bolter-bridge/runtime.ts#filesystem_write:972e179d0755bf73:1",
  "apps/desktop/electron/bolter-bridge/runtime.ts#filesystem_write:d03202c1e0d07587:1",
  "apps/desktop/electron/bolter-bridge/runtime.ts#subprocess_processor:b0ca953d0d9928fc:1",
  "apps/desktop/electron/codex-runtime/metadata-store.ts#filesystem_write:4206ade3d3abd0ec:1",
  "apps/desktop/electron/codex-runtime/metadata-store.ts#filesystem_write:7212f941d20dbe20:1",
  "apps/desktop/electron/desktop-filesystem-grants/storage.ts#filesystem_write:cc3f45572e2a1485:1",
  "apps/desktop/electron/desktop-filesystem-grants/storage.ts#filesystem_write:e960c05c3d3ef21b:1",
  "apps/desktop/electron/local-execution-history.ts#filesystem_write:77dd32cc7c306f0d:1",
  "apps/desktop/electron/local-execution-history.ts#filesystem_write:9b9c5ce7939eb291:1",
  "apps/desktop/electron/local-file-history/file-adapter.ts#filesystem_write:d8f7212bcaa0cfa5:1",
  "apps/desktop/electron/main.ts#log_emitter:02d6d32a757bab9d:6",
  "apps/desktop/electron/main.ts#log_emitter:6eab313eca52a747:10",
  "apps/desktop/electron/main.ts#network_processor:1d20e50546d0320b:1",
  "apps/desktop/electron/security-scan/ledger.ts#filesystem_write:684b20b3a4b025e9:1",
  "apps/desktop/electron/security-scan/ledger.ts#filesystem_write:cd760dfd57153ca8:1",
  "apps/desktop/electron/security-scan/ledger.ts#filesystem_write:fda32526d64b4cb2:1",
  "apps/desktop/scripts/desktop-connection-smoke.ts#temporary_storage:6195c4a697612961:1",
  "apps/desktop/scripts/vendor-bun.ts#filesystem_write:119f8b77ef3cbafe:1",
  "apps/desktop/scripts/vendor-cua-driver.ts#filesystem_write:1c391f45335c98af:1",
  "apps/desktop/scripts/vendor-cua-driver.ts#filesystem_write:85cb63369bc68f48:1",
  "apps/desktop/scripts/vendor-cua-driver.ts#filesystem_write:cdde7934c0bb6bb9:1",
  "apps/desktop/scripts/vendor-sharp-darwin.ts#subprocess_processor:5e6b496195b39843:1",
  "apps/desktop/scripts/vendor-sharp-darwin.ts#subprocess_processor:fb613521c2a96aff:1",
  "bin/nautilo-dev/src/commands/cleanup-test-cruft.ts#filesystem_write:826e9afd89677daa:1",
  "bin/nautilo-dev/src/commands/cleanup-test-cruft.ts#filesystem_write:9cb99ff047a987fe:1",
  "bin/nautilo-dev/src/commands/gen-setup-template.ts#filesystem_write:7bc940bca4cf5345:1",
  "bin/nautilo-dev/src/commands/migrate-add-agent-role.ts#subprocess_processor:cd434aaf14b50a69:1",
  "bin/nautilo-dev/src/commands/restore.ts#subprocess_processor:c8fc3c3c55eefdd5:1",
  "bin/nautilo-dev/src/commands/save.ts#filesystem_write:d89b2e16115c1b38:1",
  "bin/nautilo-dev/src/commands/save.ts#filesystem_write:fa96ddf7b79030c4:1",
  "bin/nautilo-dev/src/lib/bootstrap-claim-invite.ts#filesystem_write:02b1e72e79b8972c:1",
  "bin/nautilo-dev/src/lib/bootstrap-claim-invite.ts#filesystem_write:6921a35bd5696a42:1",
  "bin/nautilo-dev/src/lib/clone-seed-store.ts#filesystem_write:3b8fd8dd1464a85c:1",
  "bin/nautilo-dev/src/lib/compose-infra.ts#filesystem_write:0072bd4afc078c77:1",
  "bin/nautilo-dev/src/lib/compose-infra.ts#filesystem_write:00b11239e3e758e1:1",
  "bin/nautilo-dev/src/lib/compose-infra.ts#filesystem_write:2893709eb9498d0c:1",
  "bin/nautilo-dev/src/lib/compose-infra.ts#filesystem_write:3f3cd33fb9b747a6:1",
  "bin/nautilo-dev/src/lib/compose-infra.ts#filesystem_write:712772500efca8da:1",
  "bin/nautilo-dev/src/lib/compose-infra.ts#filesystem_write:c73c4ac016bd759c:1",
  ...historicalOperationJournalLocators,
  "bin/nautilo-dev/src/lib/full-dev-backup.ts#filesystem_write:64c6ed672e2a42f6:1",
  // Added boot diagnostics shifted identical log-call ordinals: the former
  // mDNS review now names a PID path and the former listening review names the
  // mDNS announcement. Replace both with their exact current boundaries.
  "bin/nautilo-server/src/index.ts#log_emitter:7ef703451e44cded:15",
  "bin/nautilo-server/src/index.ts#log_emitter:7ef703451e44cded:16",
  "bin/nautilo-relay/src/credential-store.ts#filesystem_write:a0f84e5a669e0a65:1",
  "deploy/compose-driver/src/ComposeDriver.ts#network_processor:cbc20fe4369cda28:1",
  "deploy/compose-driver/src/artifact-relocation-backup.ts#subprocess_processor:a1bfc61b41ebbc7e:1",
  "packages/api-client/src/cli-session-store.ts#filesystem_write:3fa5300420ea53dc:1",
  "packages/api-client/src/cli-session-store.ts#filesystem_write:6293b9e3b2f9e231:1",
  "packages/api-client/src/cli-session-store.ts#filesystem_write:a2ea9183aae8418c:1",
  "packages/config-guard/src/env-writer.ts#filesystem_write:6be1b5b20d914292:1",
  "packages/config-guard/src/env-writer.ts#filesystem_write:6e661ae3078dbf8e:1",
  "packages/config-guard/src/snapshot-store.ts#filesystem_write:263327eec14b666a:1",
  "packages/config-guard/src/snapshot-store.ts#filesystem_write:a89957230f5935e4:1",
  "packages/config-guard/src/snapshot-store.ts#filesystem_write:c291884e3cbb497e:1",
  "packages/config/src/instance-allocation-lock.ts#filesystem_write:79553ddf576c0b9b:1",
  "packages/config/src/resolve-instance.ts#filesystem_write:66d5bff540c0489e:1",
  "packages/config/src/vendored-binary-fetch.ts#subprocess_processor:f0193e70568c9602:1",
  "packages/db/src/utils/moderation-migration-compat.ts#filesystem_write:54e7b48834f70e43:1",
  "packages/db/src/utils/moderation-migration-compat.ts#temporary_storage:3fe5c05342f3cebe:1",
  "packages/hosting/src/launch-receipt-store.ts#filesystem_write:78de6584202b9f0b:1",
  "packages/hosting/src/launch-receipt-store.ts#filesystem_write:f68b0e5d292e324e:1",
  "packages/lattice-bridge/src/client/file-vault.ts#filesystem_write:b4a5e2ff1e6b7a09:1",
  "packages/lattice-bridge/src/client/file-vault.ts#filesystem_write:f68b0e5d292e324e:1",
  "packages/operator-secrets/src/appender.ts#filesystem_write:04558535bb415d7e:1",
  "packages/operator-secrets/src/appender.ts#filesystem_write:5d2d65d4fecb462b:1",
  "packages/operator-secrets/src/bootstrap-dir.ts#filesystem_write:02b1e72e79b8972c:1",
  "packages/operator-secrets/src/bootstrap-dir.ts#filesystem_write:23a3838f62f9ecc7:1",
  "packages/operator-secrets/src/personal-provider-custody-file.ts#filesystem_write:05b973f09487c818:1",
  "packages/operator-secrets/src/personal-provider-custody-file.ts#filesystem_write:fb0980fa9ecc6acd:1",
  "packages/server/src/lib/slide-template-service.ts#filesystem_write:379f023cfe42faf3:1",
  "packages/server/src/maintenance/portable-recovery-job.ts#filesystem_write:2dcc31d3a82d0aaf:1",
  "packages/server/src/maintenance/portable-recovery-job.ts#filesystem_write:df729d8a835b148a:1",
  "packages/server/src/maintenance/portable-recovery-job.ts#temporary_storage:6811fae8bf6fa69f:1",
  "packages/server/src/maintenance/portable-recovery-job.ts#temporary_storage:95f730bfd89839e2:1",
  "packages/vault/src/atomic-fs.ts#filesystem_write:4af2cd5f0b6f4308:1",
  "packages/vault/src/atomic-fs.ts#filesystem_write:64cdedc845527aac:1",
  // These three current locators had two competing historical owners.
  "packages/agent/src/utils/chat-model-invocation.ts#log_emitter:7ef703451e44cded:13",
  "packages/server/src/maintenance/portable-recovery-job.ts#filesystem_write:8e6cfffeb0550793:1",
  "packages/server/src/maintenance/portable-recovery-job.ts#filesystem_write:fdc33a22c73a3493:1",
]);

const buildToolExclusions = [
  "apps/cli/src/lib/cli-release.ts#subprocess_processor:3d051d2c14b1e0df:1",
  "apps/cli/src/lib/cli-release.ts#subprocess_processor:54dd99822cecc56b:1",
  "apps/cli/src/lib/cli-release.ts#subprocess_processor:70783419ab2effe6:1",
  "apps/desktop/scripts/bun-vendor-cache.ts#filesystem_write:8570d0e917082ec0:1",
  "apps/desktop/scripts/desktop-connection-smoke.ts#temporary_storage:735a1f18f47ea35e:1",
  "apps/desktop/scripts/vendor-bun.ts#filesystem_write:2fe7fe0ab45947d3:1",
  "apps/desktop/scripts/vendor-bun.ts#subprocess_processor:ccd173b6d51a4f04:1",
  "apps/desktop/scripts/vendor-sharp-darwin.ts#subprocess_processor:50a1e0dc5c3f4a0f:1",
  "apps/desktop/scripts/vendor-sharp-darwin.ts#subprocess_processor:afc01fab27057a47:1",
  "packages/config/src/private-filesystem-fixtures.ts#subprocess_processor:61215369d4c20df0:1",
  "packages/config/src/vendored-binary-fetch.ts#subprocess_processor:aeddf12b4bfccbf6:1",
  "packages/db/scripts/finalize-magent-control.ts#filesystem_write:ff2763bae2791e66:1",
  "packages/db/scripts/finalize-magent-transport.ts#filesystem_write:ff2763bae2791e66:1",
  "packages/db/scripts/finalize-message-search.ts#filesystem_write:ff2763bae2791e66:1",
] as const;

const fixedDiagnosticExclusions = [
  "packages/agent/src/providers/surplus-attempt.ts#log_emitter:a557d2199faa36e7:5",
  "packages/agent/src/usage/surplus-embedding-attempt.ts#log_emitter:dd9ce09822966263:1",
  "packages/agent/src/usage/surplus-embedding-attempt.ts#log_emitter:dd9ce09822966263:2",
  "packages/agent/src/usage/surplus-embedding-attempt.ts#log_emitter:dd9ce09822966263:3",
  "packages/agent/src/usage/surplus-embedding-attempt.ts#log_emitter:dd9ce09822966263:4",
] as const;

const inheritedCurrentRiskLocators = [
  "apps/cli/src/lib/compose-driver-factory.ts#filesystem_write:20c9c22a6e10104b:1",
  "apps/cli/src/lib/protected-handoff.ts#filesystem_write:9aa1fa4113634f15:1",
  "apps/desktop/electron/local-file-history/file-adapter.ts#filesystem_write:4bc031be8d6ad2b1:1",
  "bin/nautilo-dev/src/commands/migrate-add-agent-role.ts#subprocess_processor:9a61f59523ec0280:1",
  "bin/nautilo-server/src/index.ts#log_emitter:89b81c36ea23316a:9",
  "packages/config/src/private-filesystem.ts#filesystem_write:1a4bbd98a0b599a4:1",
  "packages/config/src/private-filesystem.ts#filesystem_write:6c18bacbebc0e63b:1",
  "packages/config/src/private-filesystem.ts#filesystem_write:af1959c8d640e0ac:1",
  "packages/config/src/private-filesystem.ts#filesystem_write:ceed349ee7f3a9b3:1",
  "packages/config/src/private-filesystem.ts#subprocess_processor:4821138eddd362e4:1",
  "packages/config/src/private-filesystem.ts#subprocess_processor:b16f732dd2fc342b:1",
  "packages/server/src/maintenance/portable-recovery-job.ts#temporary_storage:29af85d956be0c3d:1",
  "packages/server/src/maintenance/portable-recovery-job.ts#temporary_storage:f8cfc4c69ad53e42:1",
] as const;

const historicalDebtReviews = [
  ...SOURCE_ALARM_BASELINE_REVIEWS,
  ...REVIEWED_MAIN_2026_08_11_SOURCE_ALARMS,
  ...REVIEWED_MAIN_2026_08_13_SOURCE_ALARMS,
  ...REVIEWED_MAIN_2026_08_29_SOURCE_ALARMS,
].filter((review) =>
  review.closure === "baseline_debt"
  && SUPERSEDED_CI_SOURCE_RECONCILIATION_LOCATORS.has(review.locator)
);

/**
 * Exact lineage for historical debt whose helper-level alarms moved or changed
 * hash. The current set intentionally stays many-to-many: centralized private
 * filesystem primitives now govern payload risk previously repeated at callers.
 */
export const CI_SOURCE_ALARM_DEBT_LINEAGE = {
  supersededLocators: historicalDebtReviews.map((review) => review.locator),
  currentLocators: inheritedCurrentRiskLocators,
} as const;

/** Reviews for exact current alarms introduced or relocated by the reconciled source. */
export const REVIEWED_CI_SOURCE_RECONCILIATION_ALARMS: readonly SourceAlarmReview[] = [
  ...buildToolExclusions.map((locator) => exclusion(
    locator,
    "This exact build, packaging, migration-finalizer, fixture, or smoke-test sink handles reviewed source inputs, pinned release artifact bytes, fixed SQL, or an isolated test directory. It is not reachable from product data processing.",
  )),
  ...fixedDiagnosticExclusions.map((locator) => exclusion(
    locator,
    "This exact accounting diagnostic emits a fixed sentence and a literal failureCode. Provider responses, receipt bodies, prompts, credentials, identifiers, and caught exceptions are omitted.",
  )),
  debt(
    "apps/cli/src/lib/compose-driver-factory.ts#filesystem_write:20c9c22a6e10104b:1",
    "file",
    "filesystem-write alarm",
    "This carries forward the retired callsite's debt: the write can persist updated operator environment configuration and is not content-free.",
    "proving every persisted environment field is metadata-safe or protected by a separately declared secret-custody boundary.",
  ),
  debt(
    "apps/cli/src/lib/protected-handoff.ts#filesystem_write:9aa1fa4113634f15:1",
    "file",
    "filesystem-write alarm",
    "This carries forward the retired callsite's debt: the write serializes a protected handoff record whose complete field classification remains explicit debt.",
    "proving the exact serialized fields, destination, retention, and encryption contract.",
  ),
  debt(
    "apps/desktop/electron/bolter-bridge/connection-owner.ts#log_emitter:d9fe2303095b762b:1",
    "log",
    "log-emitter alarm",
    "The diagnostic logs a provider-controlled event kind. JSON encoding prevents log-structure injection but does not make the value content-free.",
    "that the provider event kind is a closed metadata vocabulary or is redacted before reaching the plaintext console.",
  ),
  exclusion(
    "apps/desktop/electron/bolter-bridge/runtime.ts#subprocess_processor:c1578c55b6e1cfd0:1",
    "The fixed version command runs the attested public CLI with no account HOME, login, message stdin, or credential environment. It compares bounded release stdout and discards stderr.",
  ),
  exclusion(
    "apps/desktop/electron/bolter-bridge/runtime.ts#filesystem_write:36b99b4dc507072a:1",
    "This sink writes only size-bounded public CLI artifact bytes from the fixed HTTPS release origin before exact digest and executable-format verification. It never receives account credentials or messages.",
  ),
  exclusion(
    "apps/desktop/electron/bolter-bridge/runtime.ts#filesystem_write:9f77b665b75a949a:1",
    "This sink writes a private release receipt containing only the public version, platform, origin URL, byte count, and digest. It contains no provider identity, credential, or message data.",
  ),
  exclusion(
    "apps/desktop/electron/bolter-bridge/runtime.ts#filesystem_write:2d6ce54808f36c11:1",
    "This rename publishes the verified public CLI artifact and its content-free release receipt. It does not publish account or message data.",
  ),
  exclusion(
    "apps/desktop/electron/desktop-filesystem-grants/storage.ts#filesystem_write:55fe418b6ebf54ee:1",
    "This is a TypeScript dependency-port method declaration, not an executable write. The concrete exact write is reviewed separately.",
  ),
  declaration(
    "apps/desktop/electron/desktop-filesystem-grants/storage.ts#filesystem_write:bd1498b33aa7cd9a:1",
    "This exclusive mode-0600 temporary write belongs to source.file.desktop-filesystem-grants and persists the validated grant journal before atomic publication. The declaration makes no Namespace-encryption claim.",
    "source.file.desktop-filesystem-grants",
  ),
  debt(
    "apps/desktop/electron/local-file-history/file-adapter.ts#filesystem_write:4bc031be8d6ad2b1:1",
    "file",
    "filesystem-write alarm",
    "This carries forward the retired callsite's debt: the selected local-file adapter writes caller-provided bytes to a Human-granted destination and is not an encrypted internal store.",
    "proving the complete grant, content-origin, and retention contract for every caller of this adapter.",
  ),
  debt(
    "bin/nautilo-dev/src/commands/migrate-add-agent-role.ts#subprocess_processor:9a61f59523ec0280:1",
    "processor",
    "subprocess-processor alarm",
    "This carries forward the retired callsite's debt: the development migration command crosses database authority and SQL through a subprocess.",
    "identifying the exact stdin, arguments, output, database target, and credential boundary.",
  ),
  declaration(
    "bin/nautilo-dev/src/commands/restore.ts#subprocess_processor:6a1edf99b072ee11:1",
    "This tar subprocess extracts a selected development snapshot into the local instance home while excluding durable protection and profile authority. Snapshot bytes remain on the explicit plaintext development-backup boundary.",
    "source.backup.dev-snapshot",
  ),
  debt(
    "bin/nautilo-server/src/index.ts#log_emitter:89b81c36ea23316a:9",
    "log",
    "log-emitter alarm",
    "This carries forward the retired diagnostic debt: the mDNS failure diagnostic interpolates arbitrary error.message or String(error) text.",
    "proving the exception is content-free or replaced with a closed diagnostic code.",
  ),
  debt(
    "bin/nautilo-server/src/index.ts#log_emitter:7ef703451e44cded:15",
    "log",
    "log-emitter alarm",
    "The boot diagnostic emits the resolved local PID-file path, which may include operator-specific filesystem components.",
    "proving the path is content-free across supported installations or replacing it with a closed diagnostic code.",
  ),
  declaration(
    "bin/nautilo-server/src/index.ts#log_emitter:7ef703451e44cded:16",
    "This boot diagnostic emits only the configured mDNS hostname and bounded instance display name after successful announcement; it contains no Human content, credential, key, prompt, Record, Memory, or Artifact payload.",
    "source.main-2026-08-15.log.server-mdns-announcement",
  ),
  declaration(
    "bin/nautilo-server/src/index.ts#log_emitter:7ef703451e44cded:17",
    "This startup diagnostic emits the configured server listening URL. It is operational origin metadata on the existing plaintext server log boundary and includes no Message, prompt, credential, or key material.",
    "source.main-2026-08-15.log.server-listening-origin",
  ),
  declaration(
    "deploy/compose-driver/src/artifact-relocation-backup.ts#subprocess_processor:ba42ba0cbc14d77a:1",
    "This tar subprocess streams one verified regular member from the selected Compose artifact backup. It remains on the explicit plaintext backup/relocation processor boundary and is not claimed content-free.",
    "source.backup.compose-bundle",
  ),
  exclusion(
    "packages/agent/src/soul/generate-soul-file.ts#log_emitter:a1436e7c26c240df:4",
    "This fallback diagnostic emits only generated character count and catalog-selected model identifier. The generated content, prompt, provider response, error, credentials, and keys are omitted.",
  ),
  ...[
    "packages/config/src/private-filesystem.ts#filesystem_write:1a4bbd98a0b599a4:1",
    "packages/config/src/private-filesystem.ts#filesystem_write:6c18bacbebc0e63b:1",
    "packages/config/src/private-filesystem.ts#filesystem_write:af1959c8d640e0ac:1",
    "packages/config/src/private-filesystem.ts#filesystem_write:ceed349ee7f3a9b3:1",
  ].map((locator) => debt(
    locator,
    "file",
    "filesystem-write alarm",
    "This centralized primitive carries forward retired caller-level debt: it can persist arbitrary caller-provided bytes, including operator secrets, and cannot be classified from this call alone.",
    "binding every caller to an exact declared custody boundary and retention contract.",
  )),
  ...[
    "packages/config/src/private-filesystem.ts#subprocess_processor:4821138eddd362e4:1",
    "packages/config/src/private-filesystem.ts#subprocess_processor:b16f732dd2fc342b:1",
  ].map((locator) => debt(
    locator,
    "processor",
    "subprocess-processor alarm",
    "This centralized helper carries forward retired caller-level debt: it receives arbitrary path and content bytes over stdin while applying operating-system ACLs.",
    "binding every caller payload to an exact declared custody boundary and proving subprocess output and lifecycle containment.",
  )),
  debt(
    "packages/server/src/lib/surplus-cost-reconciliation.ts#network_processor:86dfa121e0954a46:1",
    "processor",
    "network-processor alarm",
    "The HTTPS receipt lookup sends a receipt-read API credential and consumes provider-controlled response bytes before strict bounded accounting validation.",
    "proving the exact processor declaration for credential admission, remote recipient authority, response-field classification, and bounded failure handling.",
  ),
  ...[
    "packages/server/src/maintenance/portable-recovery-job.ts#temporary_storage:29af85d956be0c3d:1",
    "packages/server/src/maintenance/portable-recovery-job.ts#temporary_storage:f8cfc4c69ad53e42:1",
  ].map((locator) => debt(
    locator,
    "cache",
    "temporary-storage alarm",
    "This carries forward the retired temporary-storage debt: the private directory holds a mode-0600 PostgreSQL password file for one recovery subprocess and therefore contains plaintext operator authority.",
    "proving the exact lifecycle, deletion outcome, and operating-system custody of the password file.",
  )),
  exclusion(
    "packages/server/src/maintenance/portable-recovery-job.ts#filesystem_write:a6867f8caeb97783:1",
    "This atomic rename publishes only the verified-stage marker containing recovery identity, operation coordinates, and ciphertext digest metadata. It contains no recovered database, file-root, credential, or key bytes.",
  ),
  debt(
    "packages/server/src/maintenance/portable-recovery-job.ts#filesystem_write:a04d34a13e441ff9:1",
    "file",
    "filesystem-write alarm",
    "The rollback rename can move a complete recovered plaintext root back into a retained staging directory after partial promotion failure.",
    "an exact declared portable-recovery file boundary covering rollback retention, cleanup, and every payload class in the recovered root.",
  ),
  // Resolve the three duplicate predecessors with one boundary-specific owner.
  exclusion(
    "packages/agent/src/utils/chat-model-invocation.ts#log_emitter:7ef703451e44cded:13",
    "Canonical external-Room execution carries diagnostic privacy through asynchronous execution independently of funding, including local Human turns. The trusted funding session also preserves the restriction for external inputs. This exact call emits only the model coordinate, closed failure category and retryable boolean, never the provider exception message or payload. The shared model cooldown also receives the category only; the separate ordinary-provider raw-error branch retains its existing classification.",
    "exclusion.external-room.provider-failure-category",
  ),
  {
    locator: "packages/server/src/maintenance/portable-recovery-job.ts#filesystem_write:fdc33a22c73a3493:1",
    owner: "packages/server",
    closure: "declaration",
    declarationId: "source.file.chatgpt-portable-custody",
    reason: "The write installs authenticated recovered operator custody in a mode-0600 temporary file beneath a private operator directory. It is an explicit operator-secret boundary, not harmless metadata or Message encryption.",
  },
  {
    locator: "packages/server/src/maintenance/portable-recovery-job.ts#filesystem_write:8e6cfffeb0550793:1",
    owner: "packages/server",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.chatgpt-portable-custody-promotion",
    reason: "This atomic rename promotes exactly the temporary custody file owned by source.file.chatgpt-portable-custody. It creates no second payload or storage boundary and retains the file's mode-0600 operator-secret classification.",
  },
] as const;
