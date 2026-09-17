import type { SourceAlarmReview } from "../src/node/source-alarm-review";

/** Exact locators removed or replaced on current main; no path or signature wildcard. */
export const SUPERSEDED_MAIN_2026_09_17_SOURCE_ALARM_LOCATORS = new Set<string>([
  "apps/desktop/electron/main.ts#network_processor:4cb9916574d10a14:1",
  "apps/desktop/electron/sequence-export-host.ts#subprocess_processor:a536c8590ec41360:1",
  "apps/desktop/scripts/vendor-bun.ts#filesystem_write:d005bf0747616ddb:1",
  "apps/desktop/scripts/vendor-bun.ts#filesystem_write:ddb52c2d8ebc0532:1",
  "apps/desktop/scripts/vendor-bun.ts#network_processor:4914e11c0443fd44:1",
  "bin/nautilo-dev/src/commands/restore.ts#subprocess_processor:1dc4e0075d020627:1",
  "deploy/compose-driver/src/ComposeDriver.ts#subprocess_processor:e7307c1f6f0638c4:1",
  "packages/hosting/src/release-publication.ts#filesystem_write:b8bafc7e88becf13:1",
  "packages/hosting/src/release-publication.ts#filesystem_write:ce0c2279fda4a6af:1",
  "packages/hosting/src/release-publication.ts#filesystem_write:e46d41a03aed5f54:1",
  "packages/hosting/src/release-publication.ts#filesystem_write:febb47bcf1c5069c:1",
  "packages/hosting/src/server-release-publication.ts#filesystem_write:b8bafc7e88becf13:1",
  "packages/hosting/src/server-release-publication.ts#filesystem_write:ce0c2279fda4a6af:1",
  "packages/hosting/src/server-release-publication.ts#filesystem_write:e46d41a03aed5f54:1",
  "packages/hosting/src/server-release-publication.ts#filesystem_write:febb47bcf1c5069c:1",
]);

const declaration = (
  locator: string,
  owner: string,
  declarationId: string,
  reason: string,
): SourceAlarmReview => ({
  locator,
  owner,
  closure: "declaration",
  declarationId,
  reason,
});

const exclusion = (
  locator: string,
  owner: string,
  exclusionId: string,
  reason: string,
): SourceAlarmReview => ({
  locator,
  owner,
  closure: "reviewed_exclusion",
  exclusionId,
  reason,
});

const PROTECT_INSTANCE_EXCLUSIONS = [
  ["bin/nautilo-dev/src/commands/protect-instance.ts#filesystem_write:8049aa3e28e93307:1", "profile-temporary-write"],
  ["bin/nautilo-dev/src/commands/protect-instance.ts#filesystem_write:3f3cd33fb9b747a6:1", "profile-atomic-rename"],
  ["bin/nautilo-dev/src/commands/protect-instance.ts#log_emitter:c467686340f4efc2:1", "missing-id-diagnostic"],
  ["bin/nautilo-dev/src/commands/protect-instance.ts#log_emitter:c467686340f4efc2:2", "invalid-id-diagnostic"],
  ["bin/nautilo-dev/src/commands/protect-instance.ts#log_emitter:c467686340f4efc2:3", "path-guard-diagnostic"],
  ["bin/nautilo-dev/src/commands/protect-instance.ts#log_emitter:c6d53eb0eb42455b:1", "missing-descriptor-diagnostic"],
  ["bin/nautilo-dev/src/commands/protect-instance.ts#log_emitter:c6d53eb0eb42455b:2", "descriptor-mismatch-diagnostic"],
  ["bin/nautilo-dev/src/commands/protect-instance.ts#log_emitter:c6d53eb0eb42455b:3", "descriptor-json-diagnostic"],
  ["bin/nautilo-dev/src/commands/protect-instance.ts#log_emitter:c467686340f4efc2:4", "authority-failure-diagnostic"],
  ["bin/nautilo-dev/src/commands/protect-instance.ts#log_emitter:6eab313eca52a747:1", "protection-success-diagnostic"],
] as const;

const BOARD_QUALIFICATION_EXCLUSIONS = [
  ["packages/first-party-apps/board/scripts/capture-preview.ts#log_emitter:468c68ed4723a1f2:1", "capture-output"],
  ["packages/first-party-apps/board/scripts/generate-board-model-schema.mjs#log_emitter:468c68ed4723a1f2:1", "schema-check"],
  ["packages/first-party-apps/board/scripts/generate-board-model-schema.mjs#filesystem_write:935c7927be24fbf1:1", "schema-generation"],
  ["packages/first-party-apps/board/scripts/generate-board-model-schema.mjs#log_emitter:468c68ed4723a1f2:2", "schema-output"],
  ["packages/first-party-apps/board/scripts/generate-board-model-schema.mjs#log_emitter:468c68ed4723a1f2:3", "validator-output"],
  ["packages/first-party-apps/board/scripts/qualify-browser.ts#network_processor:14e5a061bb531b1b:1", "preview-local-handler"],
  ["packages/first-party-apps/board/scripts/qualify-browser.ts#log_emitter:468c68ed4723a1f2:1", "qualification-step"],
  ["packages/first-party-apps/board/scripts/qualify-browser.ts#log_emitter:bdc6a67d4071d67d:1", "qualification-summary"],
  ["packages/first-party-apps/board/scripts/qualify-browser.ts#log_emitter:75bfbedaa6d6d760:1", "qualification-failure"],
  ["packages/first-party-apps/board/scripts/qualify-canonical-browser.ts#network_processor:fdcaea01dba45a25:1", "canonical-local-handler"],
  ["packages/first-party-apps/board/scripts/qualify-canonical-browser.ts#log_emitter:0da12e99119886f8:1", "canonical-summary"],
  ["packages/first-party-apps/board/scripts/serve-preview.ts#network_processor:5023a20296f359e1:1", "preview-static-handler"],
  ["packages/first-party-apps/board/scripts/serve-preview.ts#log_emitter:468c68ed4723a1f2:1", "preview-url"],
  ["packages/office-board/scripts/qualify-browser.mjs#temporary_storage:08ee410a07c8ecea:1", "engine-build-temporary"],
  ["packages/office-board/scripts/qualify-browser.mjs#log_emitter:47c0dbe5646a06f5:1", "fixture-page-error"],
  ["packages/office-board/scripts/qualify-browser.mjs#log_emitter:468c68ed4723a1f2:1", "engine-summary"],
  ["packages/office-board/scripts/qualify-exports.mjs#log_emitter:6eab313eca52a747:1", "export-summary"],
] as const;

export const REVIEWED_MAIN_2026_09_17_SOURCE_ALARMS: readonly SourceAlarmReview[] = [
  exclusion(
    "apps/cli/src/commands/artifacts-relocate.ts#filesystem_write:281ad536784f833d:1",
    "apps/cli",
    "exclusion.main-2026-09-17.artifact-relocation-plan-metadata",
    "This exact owner-only mode-0600 write persists relocation control metadata only: physical paths, file sizes, hashes and verified backup identity before a directory fsync. It contains no Artifact bytes, Human content, credential or key; the ordinary Artifact and Compose backup content remain on their existing semantic boundaries.",
  ),
  declaration(
    "apps/desktop/electron/sequence-export-host.ts#subprocess_processor:1a362bfafa05b5d7:1",
    "apps/desktop",
    "source.main-2026-09-09.platform.20",
    "This exact replacement ffmpeg call reads an authorized snapshot of Human media and returns only stream-presence metadata. Arguments and temporary media remain on the existing plaintext sequence-export processor boundary; no encrypted-processing claim is made.",
  ),
  exclusion(
    "apps/desktop/scripts/after-pack.cjs#subprocess_processor:efe918190b0f4186:1",
    "apps/desktop",
    "exclusion.main-2026-09-17.desktop-license-packaging",
    "This exact packaging subprocess invokes the checked-in license-payload verifier against a build resources directory. It processes repository legal notices and pinned Bun license bytes only, not Human or instance content.",
  ),
  exclusion(
    "apps/desktop/scripts/desktop-license-payload.ts#filesystem_write:67fe126a07665dd2:1",
    "apps/desktop",
    "exclusion.main-2026-09-17.desktop-bun-license-copy",
    "This exact build-time write copies the pinned public Bun LICENSE.txt bytes into Desktop package resources. Its source, destination and retained payload are distribution assets with no Human or instance data.",
  ),
  ...PROTECT_INSTANCE_EXCLUSIONS.map(([locator, suffix], index) => exclusion(
    locator,
    "bin/nautilo-dev",
    `exclusion.main-2026-09-17.protect-instance.${index + 1}.${suffix}`,
    index < 2
      ? "This exact developer command call atomically persists mode-0600 local instance profile authority metadata (instance id, transport, lifecycle and retention) outside the instance root. It contains no Namespace payload or credential and is not an encrypted product-data store."
      : "This exact developer-command diagnostic emits only fixed protection workflow text plus a validated local instance id, validation result, bounded profile-authority failure message or success state. It does not emit instance content, credentials, keys or protected payload bytes.",
  )),
  exclusion(
    "bin/nautilo-dev/src/commands/reset-test-cruft.ts#log_emitter:c467686340f4efc2:3",
    "bin/nautilo-dev",
    "exclusion.main-2026-09-17.reset-test-cruft-home",
    "This exact developer-only diagnostic reports that HOME is absent while recreating the fixed test-cruft instance. It contains no HOME value, fixture content, credential or protected payload.",
  ),
  exclusion(
    "bin/nautilo-dev/src/commands/reset-test-cruft.ts#log_emitter:c467686340f4efc2:4",
    "bin/nautilo-dev",
    "exclusion.main-2026-09-17.reset-test-cruft-retention",
    "This exact developer-only diagnostic reports a bounded local retention-authority failure for the fixed test-cruft instance. It emits no fixture rows, database bytes, credentials, keys or protected payload.",
  ),
  declaration(
    "bin/nautilo-dev/src/commands/restore.ts#subprocess_processor:c8fc3c3c55eefdd5:1",
    "bin/nautilo-dev",
    "source.backup.dev-snapshot",
    "This exact replacement tar subprocess extracts a selected developer snapshot into the local instance home while explicitly excluding durable protection and profile authority. Snapshot bytes remain on the existing plaintext development-backup boundary; no encrypted restore claim is made.",
  ),
  exclusion(
    "bin/nautilo-dev/src/lib/protected-durable-instance.ts#filesystem_write:b7846bd1934463c7:1",
    "bin/nautilo-dev",
    "exclusion.main-2026-09-17.protected-instance-marker",
    "This exact exclusive mode-0600 write stores the fixed text 'protected-by=operator' as local cleanup authority. The marker contains no instance id, Human content, credential, key or protected payload.",
  ),
  exclusion(
    "bin/nautilo-dev/src/lib/recorded-main-merge-migration.ts#subprocess_processor:d67d053925c857ad:1",
    "bin/nautilo-dev",
    "exclusion.main-2026-09-17.recorded-main-git-inspection",
    "This exact developer safety helper runs local Git read commands over commit, index, migration and approval-receipt bytes. It has no network, product-runtime, Human-content or retained subprocess boundary.",
  ),
  declaration(
    "deploy/compose-driver/src/artifact-relocation-backup.ts#subprocess_processor:a1bfc61b41ebbc7e:1",
    "deploy/compose-driver",
    "source.backup.compose-bundle",
    "This exact replacement tar subprocess lists or streams one verified regular member from an original Compose artifact backup. The stream can contain ordinary Artifact bytes and remains on the explicit plaintext backup/relocation processor boundary; it is not a content-free subprocess.",
  ),
  ...BOARD_QUALIFICATION_EXCLUSIONS.map(([locator, suffix], index) => exclusion(
    locator,
    locator.startsWith("packages/office-board/")
      ? "packages/office-board"
      : "packages/first-party-apps",
    `exclusion.main-2026-09-17.board-qualification.${index + 1}.${suffix}`,
    "This exact Board build or browser-qualification call operates only on checked-in source, generated schemas, fictional fixture documents, local loopback responses, screenshots, or disposable build output. The scripts explicitly use no live Nautilo account, instance, provider or persisted Human data.",
  )),
  ...[
    ["packages/server/src/routes/event-feed-preferences.ts#log_emitter:89b81c36ea23316a:1", "read"],
    ["packages/server/src/routes/event-feed-preferences.ts#log_emitter:89b81c36ea23316a:2", "update"],
    ["packages/server/src/routes/event-feed-preferences.ts#log_emitter:89b81c36ea23316a:3", "change-hint"],
  ].map(([locator, suffix], index) => exclusion(
    locator!,
    "packages/server",
    `exclusion.main-2026-09-17.event-feed-preference.${index + 1}.${suffix}`,
    "This exact plaintext warning is fixed text only. It emits no Human id, preference value, snooze time, request body, exception object, message, stack, credential, key or protected content.",
  )),
];
