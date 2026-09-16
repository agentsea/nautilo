import { createHash } from "node:crypto";

import type { SourceAlarmReview } from "../src/node/source-alarm-review";

type Run = readonly [path: string, kind: string, signature: string, count: number];

function runLocators([path, kind, signature, count]: Run): string[] {
  return Array.from(
    { length: count },
    (_, index) => `${path}#${kind}:${signature}:${index + 1}`,
  );
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

const ORDINAL_RUNS: readonly Run[] = [
  ["apps/workbench/src/adapters/nautilo-runtime.tsx", "log_emitter", "c6d53eb0eb42455b", 9],
  ["bin/nautilo-dev/src/commands/dev-stack.ts", "log_emitter", "468c68ed4723a1f2", 10],
  ["bin/nautilo-dev/src/commands/dev-stack.ts", "log_emitter", "6eab313eca52a747", 5],
  ["bin/nautilo-dev/src/commands/dev-stack.ts", "log_emitter", "c467686340f4efc2", 27],
  ["bin/nautilo-dev/src/commands/dev-stack.ts", "log_emitter", "c6d53eb0eb42455b", 15],
  ["bin/nautilo-server/src/index.ts", "log_emitter", "89b81c36ea23316a", 7],
  ["packages/agent/src/tools/invocation-service.ts", "log_emitter", "89b81c36ea23316a", 13],
  ["packages/config-guard/src/setup-toml-migration.ts", "log_emitter", "c467686340f4efc2", 8],
  ["packages/office-docs/scripts/verify-ime-browser.mjs", "log_emitter", "468c68ed4723a1f2", 10],
  ["packages/office-docs/scripts/verify-ime-browser.mjs", "log_emitter", "c467686340f4efc2", 2],
  ["packages/office-docs/scripts/verify-ime-browser.mjs", "log_emitter", "c4f22f3fb6bab4a7", 2],
  ["packages/office-slides/scripts/gen-shape-text-rects.mjs", "log_emitter", "468c68ed4723a1f2", 2],
  ["packages/office-slides/scripts/generate-model-schema.mjs", "log_emitter", "468c68ed4723a1f2", 3],
  ["packages/office-slides/src/view/editor/interactions/keyboard.ts", "log_emitter", "1b166cbf08993886", 2],
  ["packages/office-slides/src/view/editor/interactions/keyboard.ts", "log_emitter", "e40d8ce76a53e94b", 2],
  ["packages/runtime/src/stenographer/ordinary-stenographer-data-operation.ts", "log_emitter", "7100fec63ac40eee", 6],
  ["packages/runtime/src/stenographer/ordinary-stenographer-data-operation.ts", "log_emitter", "db40054dd207df4f", 2],
  ["packages/runtime/src/tasks/resume-task-approval.ts", "log_emitter", "89b81c36ea23316a", 2],
  ["packages/server/src/apps/app-tool-host.ts", "log_emitter", "89b81c36ea23316a", 2],
  ["packages/server/src/reflection/protected-authority-composition.ts", "log_emitter", "41b017e1495b9b88", 3],
  ["packages/server/src/routes/rooms.ts", "log_emitter", "a1436e7c26c240df", 11],
  ["packages/server/src/routes/workspace-artifacts.ts", "log_emitter", "89b81c36ea23316a", 6],
] as const;

export const MAIN_2026_09_12_ORDINAL_RUN_SOURCE_LOCATORS = new Set<string>(
  ORDINAL_RUNS.flatMap(runLocators),
);

const FFMPEG_EXCLUSIONS = [
  "apps/desktop/electron/ffmpeg-integrity.ts#subprocess_processor:00180a6abb3f6daf:1",
  "apps/desktop/electron/ffmpeg-integrity.ts#subprocess_processor:b08e6b27d46a5fad:1",
  "apps/desktop/scripts/after-pack.cjs#subprocess_processor:36873bcefb9d9910:1",
  "apps/desktop/scripts/after-sign.cjs#subprocess_processor:4c44544c9ce2caff:1",
  "apps/desktop/scripts/ffmpeg-distribution.ts#subprocess_processor:2e957872f89dae66:1",
  "apps/desktop/scripts/vendor-ffmpeg.ts#filesystem_write:3115daf32626457c:1",
  "apps/desktop/scripts/vendor-ffmpeg.ts#filesystem_write:3d4f3d541bf1c9e4:1",
  "apps/desktop/scripts/vendor-ffmpeg.ts#filesystem_write:3f9bcda5b5475f28:1",
  "apps/desktop/scripts/vendor-ffmpeg.ts#filesystem_write:5d65e6255adf6d37:1",
  "apps/desktop/scripts/vendor-ffmpeg.ts#filesystem_write:81c761033a5e53f7:1",
  "apps/desktop/scripts/vendor-ffmpeg.ts#log_emitter:285b5d9a17b13918:1",
  "apps/desktop/scripts/vendor-ffmpeg.ts#subprocess_processor:aab0293fab29c8ca:1",
  "apps/desktop/scripts/vendor-ffmpeg.ts#temporary_storage:3fe5c05342f3cebe:1",
  "apps/desktop/scripts/verify-ffmpeg.ts#log_emitter:468c68ed4723a1f2:1",
] as const;

const SLIDES_QUALIFICATION_EXCLUSIONS = [
  "packages/first-party-apps/presentation/scripts/capture-preview.ts#log_emitter:468c68ed4723a1f2:1",
  "packages/first-party-apps/presentation/scripts/qualify-authoring-browser.ts#log_emitter:8f8a5cc96ff15f7f:1",
  "packages/first-party-apps/presentation/scripts/qualify-authoring-browser.ts#temporary_storage:25bd032b5e5c3d6a:1",
  "packages/first-party-apps/presentation/scripts/qualify-authoring-browser.ts#temporary_storage:68761dd3929f3859:1",
  "packages/first-party-apps/presentation/scripts/qualify-browser.ts#log_emitter:13c67f5d8e5623ec:1",
  "packages/first-party-apps/presentation/scripts/qualify-browser.ts#log_emitter:3e81122257749c55:1",
  "packages/first-party-apps/presentation/scripts/qualify-browser.ts#log_emitter:468c68ed4723a1f2:1",
  "packages/first-party-apps/presentation/scripts/qualify-browser.ts#log_emitter:938f71437933ffed:1",
  "packages/first-party-apps/presentation/scripts/qualify-browser.ts#log_emitter:c02478bccf05c4a3:1",
  "packages/first-party-apps/presentation/scripts/qualify-browser.ts#log_emitter:f63e1d99b3e72ad6:1",
  "packages/first-party-apps/presentation/scripts/qualify-recovery-browser.ts#log_emitter:f63e1d99b3e72ad6:1",
  "packages/first-party-apps/presentation/scripts/qualify-templates-browser.ts#log_emitter:3e81122257749c55:1",
  "packages/first-party-apps/presentation/scripts/qualify-templates-browser.ts#log_emitter:468c68ed4723a1f2:1",
  "packages/first-party-apps/presentation/scripts/qualify-templates-browser.ts#log_emitter:938f71437933ffed:1",
  "packages/first-party-apps/presentation/scripts/qualify-templates-browser.ts#temporary_storage:25bd032b5e5c3d6a:1",
  "packages/first-party-apps/presentation/scripts/qualify-templates-browser.ts#temporary_storage:68761dd3929f3859:1",
  ...runLocators(ORDINAL_RUNS[8]!),
  ...runLocators(ORDINAL_RUNS[9]!),
  ...runLocators(ORDINAL_RUNS[10]!),
  "packages/office-docs/scripts/verify-ime-browser.mjs#log_emitter:44b8f9f2ba0f8199:1",
  "packages/office-docs/scripts/verify-ime-browser.mjs#log_emitter:c6d53eb0eb42455b:1",
  ...runLocators(ORDINAL_RUNS[11]!),
  "packages/office-slides/scripts/gen-shape-text-rects.mjs#filesystem_write:82e76b9369bd0983:1",
  "packages/office-slides/scripts/gen-shape-text-rects.mjs#log_emitter:6eab313eca52a747:1",
  "packages/office-slides/scripts/gen-shape-text-rects.mjs#log_emitter:c6d53eb0eb42455b:1",
  ...runLocators(ORDINAL_RUNS[12]!),
  "packages/office-slides/scripts/generate-model-schema.mjs#filesystem_write:935c7927be24fbf1:1",
] as const;

const DEV_STACK_EXCLUSIONS = ORDINAL_RUNS.slice(1, 5).flatMap(runLocators);

const DEV_STACK_DEBT = new Set<string>([
  "bin/nautilo-dev/src/commands/dev-stack.ts#log_emitter:c6d53eb0eb42455b:2",
  "bin/nautilo-dev/src/commands/dev-stack.ts#log_emitter:c6d53eb0eb42455b:4",
]);

const ADDITIONAL_REVIEWED_LOG_DEBT = [
  "bin/nautilo-dev/src/commands/dev-stack.ts#log_emitter:9a0075a24c1b046c:1",
] as const;

const OTHER_BUILD_EXCLUSIONS = [
  "packages/db/scripts/finalize-content-access-operations.ts#filesystem_write:ff2763bae2791e66:1",
  "packages/db/scripts/finalize-event-feed.ts#filesystem_write:ff2763bae2791e66:1",
  "packages/runtime/src/stenographer/ordinary-stenographer-data-operation.ts#log_emitter:beea086e1bde4b98:1",
] as const;

const CONTENT_DECLARATIONS = new Map<string, readonly [id: string, reason: string]>([
  ["apps/desktop/electron/mini-app-draft-recovery.ts#filesystem_write:4bc031be8d6ad2b1:1", ["source.main-2026-09-12.desktop-mini-app-draft-recovery-write", "This exact write persists only HEADER plus safeStorage ciphertext at mode 0600 under the device-local source.file.desktop-mini-app-draft-recovery boundary; protection availability and non-basic_text storage are required before use, but this is not a Namespace-encryption claim and retention lasts until tombstone or directory cleanup."]],
  ["apps/desktop/electron/mini-app-draft-recovery.ts#filesystem_write:4dc03b77ebd364d7:1", ["source.main-2026-09-12.desktop-mini-app-draft-recovery-publish", "This exact rename atomically publishes the fsynced HEADER-plus-safeStorage-ciphertext temporary into the device-local source.file.desktop-mini-app-draft-recovery boundary after authority is rechecked; it makes no Namespace-encryption claim and retained recovery files outlive handle revocation until tombstone or directory cleanup."]],
  ["apps/workbench/src/components/browser-column/apps-panel.tsx#filesystem_write:f3b4ac401ae53efc:1", ["source.main-2026-09-12.current-folder-template-create", "This exact call sends server-supplied mini-app template content to the Desktop Current Folder boundary selected by the Human; the host grant and null base provide authorized exclusive creation, while the resulting user-owned file follows Current Folder retention and is not claimed encrypted by Nautilo."]],
  ["packages/agent/src/tools/file/atomic-write.ts#filesystem_write:cfc3acd96c1a1e48:1", ["source.main-2026-09-12.agent-exclusive-atomic-link", "This exact hard-link is the exclusive atomic publication point for arbitrary bytes already written beneath an admitted local or Workspace file path; the owning file operation governs content and retention, and the helper itself makes no encryption claim."]],
  ["packages/agent/src/tools/file/atomic-write.ts#filesystem_write:4d8e0a93dfa6dec5:1", ["source.main-2026-09-12.agent-exclusive-atomic-write", "This exact write stores arbitrary caller bytes in a sibling temporary before fsync and exclusive publication beneath an admitted local or Workspace file path; cleanup removes failed temporaries, while final retention and encryption status belong to the owning file operation."]],
  ["packages/agent/src/tools/file/workspace-binary-artifact.ts#filesystem_write:137c83a01103bf0e:1", ["source.main-2026-09-12.workspace-binary-artifact-stream-publish", "This exact rename publishes fsynced provider stream bytes into the canonical ordinary Workspace Artifact filesystem on overwrite; artifact lifecycle governs retention and this call does not claim those bytes are encrypted."]],
  ["packages/server/src/lib/slide-template-service.ts#filesystem_write:379f023cfe42faf3:1", ["source.main-2026-09-12.slide-template-artifact-write", "This exact mode-0600 temporary write stores the complete user-supplied Slide template content under the ordinary Workspace Artifact root before fsync and exclusive publication; Artifact lifecycle governs retention and no encryption claim is made."]],
  ["packages/server/src/lib/slide-template-service.ts#filesystem_write:a8e48bc462634843:1", ["source.main-2026-09-12.slide-template-artifact-publish", "This exact hard-link exclusively publishes a complete fsynced Slide template into the ordinary Workspace Artifact root and the finally block removes the temporary; Artifact lifecycle governs retained content and no encryption claim is made."]],
  ["packages/office-docs/src/export/pdf-fonts.ts#network_processor:596abf2787d03931:1", ["source.main-2026-09-12.pdf-font-download", "This exact processor fetches pinned public OTF font resources, or a caller-injected custom-font URL, into the PDF font cache; it does not send document text, but custom URL metadata and cached font-byte retention remain part of the explicit font processor boundary rather than an encryption claim."]],
]);

const STENOGRAPHER_BOUNDED_LOGS = [
  ...runLocators(ORDINAL_RUNS[15]!),
  ...runLocators(ORDINAL_RUNS[16]!),
  "packages/runtime/src/stenographer/worker.ts#log_emitter:3a571294f7cbfcbc:1",
] as const;

const BOUNDED_LOG_DECLARATIONS = new Map<string, readonly [id: string, reason: string]>([
  ...STENOGRAPHER_BOUNDED_LOGS.map((locator, index) => [locator, [
    `source.main-2026-09-12.stenographer-bounded-diagnostic-${index + 1}`,
    `${locator} emits only a fixed Stenographer lifecycle label with closed stage/lane/trigger/failure classifications, counts, opaque work or model identifiers, and five-character database codes; source tests exclude prompts, message bodies, model output, keys, and raw exception text from this exact plaintext diagnostic.`,
  ] as const] as const),
  ["apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:c6d53eb0eb42455b:1", ["source.main-2026-09-12.workbench-key-waiting-error-class", "This exact plaintext diagnostic emits a fixed mounted-key refresh label and only Error.name or typeof; it emits no message body, protected payload, key material, stack, or raw exception object."]],
  ["apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:c6d53eb0eb42455b:4", ["source.main-2026-09-12.workbench-domain-catchup-error-class", "This exact plaintext diagnostic emits a fixed Domain-key catch-up label and only Error.name or typeof; it emits no key, envelope, protected payload, stack, message, or raw exception object."]],
  ["apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:c6d53eb0eb42455b:5", ["source.main-2026-09-12.workbench-domain-delivery-error-class", "This exact plaintext diagnostic emits a fixed Domain-key delivery label and only Error.name or typeof; it emits no key, envelope, protected payload, stack, message, or raw exception object."]],
  ["apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:c6d53eb0eb42455b:9", ["source.main-2026-09-12.workbench-background-authorization-error-class", "This exact plaintext diagnostic emits a fixed background-authorization label and only Error.name or typeof; it emits no authorization plan, payload, stack, message, or raw exception object."]],
  ["packages/agent/src/tools/file/artifact-store.ts#log_emitter:89b81c36ea23316a:1", ["source.main-2026-09-12.artifact-observer-fixed-diagnostic", "This exact post-commit plaintext diagnostic is fixed text only; it does not interpolate the Artifact, path, actor, exception, or content whose optional observer failed."]],
  ["packages/config-guard/src/env-writer.ts#log_emitter:064983095de744a8:1", ["source.main-2026-09-12.config-reload-fixed-diagnostic", "This exact plaintext diagnostic is fixed text only; it reports listener failure without emitting environment names, values, paths, exception text, or configuration content."]],
  ["packages/runtime/src/tasks/task-run-executor.ts#log_emitter:89b81c36ea23316a:1", ["source.main-2026-09-12.task-interrupt-replay-identifiers", "This exact plaintext diagnostic emits a fixed interrupt-replay label with opaque Task and run identifiers only; it emits no prompt, result, approval payload, stack, or exception text."]],
  ["packages/server/src/app.ts#log_emitter:9c37cff80e0cfebb:1", ["source.main-2026-09-12.event-feed-operation-code", "This exact plaintext diagnostic emits only the Event Feed's closed operation and code fields; the adapter does not receive event content, people labels, Artifact paths, or raw exceptions."]],
  ["packages/server/src/media-generation/production-worker.ts#log_emitter:4838fc5285bf34e1:1", ["source.main-2026-09-12.media-feed-fixed-diagnostic", "This exact best-effort plaintext diagnostic is fixed text only and emits no media prompt, result, user identity, Artifact path, or raw exception."]],
  ...runLocators(ORDINAL_RUNS[19]!).map((locator, index) => [locator, [
    `source.main-2026-09-12.reflection-failure-class-${index + 1}`,
    `${locator} emits a fixed Reflection authority-maintenance label and only classifyDataOperationFailure(error); it emits no authority bytes, key material, protected payload, exception message, stack, or raw error object.`,
  ] as const] as const),
]);

const STENOGRAPHER_CALLBACK_DEBT = [
  "packages/runtime/src/stenographer/ordinary-stenographer-data-operation.ts#log_emitter:6a450c440341d85b:1",
  "packages/runtime/src/stenographer/ordinary-stenographer-data-operation.ts#log_emitter:808faa524bf2b947:1",
  "packages/runtime/src/stenographer/ordinary-stenographer-data-operation.ts#log_emitter:c4c1a9cb106e92c7:1",
  "packages/runtime/src/stenographer/ordinary-stenographer-data-operation.ts#log_emitter:cbad719ce71c6b05:1",
  "packages/runtime/src/stenographer/worker.ts#log_emitter:0a4bb0710f8dd93b:1",
  "packages/runtime/src/stenographer/worker.ts#log_emitter:4a2b3cc9166e95d2:1",
  "packages/runtime/src/stenographer/worker.ts#log_emitter:7acab573ad5b8d95:1",
  "packages/runtime/src/stenographer/worker.ts#log_emitter:8dd02458440676ae:1",
  "packages/runtime/src/stenographer/worker.ts#log_emitter:c0a5d9b378ca0a91:1",
  "packages/runtime/src/stenographer/worker.ts#log_emitter:d2c051d87939b278:1",
] as const;

const PRODUCTION_LOG_LOCATORS = [
  "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:c6d53eb0eb42455b:9",
  "bin/nautilo-dev/src/commands/server-start.ts#log_emitter:dabd96dfa8ee8d84:1",
  "bin/nautilo-server/src/index.ts#log_emitter:89b81c36ea23316a:7",
  "packages/agent/src/config/foreground-model-controls.ts#log_emitter:7ef703451e44cded:1",
  "packages/agent/src/tools/file/artifact-store.ts#log_emitter:89b81c36ea23316a:1",
  "packages/agent/src/tools/invocation-service.ts#log_emitter:89b81c36ea23316a:13",
  "packages/config-guard/src/env-writer.ts#log_emitter:064983095de744a8:1",
  "packages/config-guard/src/setup-toml-migration.ts#log_emitter:c467686340f4efc2:8",
  "packages/office-docs/src/view/fonts.ts#log_emitter:550d37a247732e69:1",
  "packages/office-docs/src/view/text-box-editor.ts#log_emitter:610f2f24bde78727:1",
  "packages/office-slides/src/import/pptx/image.ts#log_emitter:e40d8ce76a53e94b:1",
  "packages/office-slides/src/view/canvas/shape-renderer.ts#log_emitter:02d6d32a757bab9d:1",
  ...runLocators(ORDINAL_RUNS[13]!),
  ...runLocators(ORDINAL_RUNS[14]!),
  "packages/office-slides/src/view/editor/text-box-editor.ts#log_emitter:610f2f24bde78727:1",
  "packages/runtime/src/tasks/resume-task-approval.ts#log_emitter:89b81c36ea23316a:2",
  "packages/runtime/src/tasks/task-run-executor.ts#log_emitter:89b81c36ea23316a:1",
  "packages/server/src/app.ts#log_emitter:1b34c036f128de14:1",
  "packages/server/src/app.ts#log_emitter:6eb9eabd28674f0a:1",
  "packages/server/src/app.ts#log_emitter:9c37cff80e0cfebb:1",
  "packages/server/src/apps/app-tool-host.ts#log_emitter:89b81c36ea23316a:2",
  "packages/server/src/lib/workspace-artifact-access-invalidation.ts#log_emitter:a1436e7c26c240df:1",
  "packages/server/src/media-generation/production-worker.ts#log_emitter:4838fc5285bf34e1:1",
  ...runLocators(ORDINAL_RUNS[19]!),
  "packages/server/src/routes/rooms.ts#log_emitter:a1436e7c26c240df:11",
  "packages/server/src/routes/workspace-artifacts.ts#log_emitter:89b81c36ea23316a:6",
] as const;

const HIGH_CONFIDENCE_NEW_EXCLUSIONS = [
  ...FFMPEG_EXCLUSIONS,
  ...SLIDES_QUALIFICATION_EXCLUSIONS,
  ...DEV_STACK_EXCLUSIONS.filter((locator) =>
    locator.endsWith("468c68ed4723a1f2:10")
    || locator.endsWith("6eab313eca52a747:5")
    || /c467686340f4efc2:2[3-7]$/.test(locator)
    || /c6d53eb0eb42455b:1[2-5]$/.test(locator)
  ),
  ...OTHER_BUILD_EXCLUSIONS,
] as const;

export const MAIN_2026_09_12_UNMAPPED_SOURCE_ALARM_LOCATORS = new Set<string>([
  ...HIGH_CONFIDENCE_NEW_EXCLUSIONS,
  ...CONTENT_DECLARATIONS.keys(),
  ...STENOGRAPHER_BOUNDED_LOGS,
  ...STENOGRAPHER_CALLBACK_DEBT,
  ...PRODUCTION_LOG_LOCATORS,
]);

const RETIRED_OR_MOVED_LOCATORS = [
  "apps/desktop/scripts/vendor-ffmpeg.ts#filesystem_write:92a4d8efa2cc5eef:1",
  "apps/desktop/scripts/vendor-ffmpeg.ts#filesystem_write:c7de9397f4000fb3:1",
  "apps/desktop/scripts/vendor-ffmpeg.ts#filesystem_write:d005bf0747616ddb:1",
  "apps/desktop/scripts/vendor-ffmpeg.ts#filesystem_write:d005bf0747616ddb:2",
  "apps/desktop/scripts/vendor-ffmpeg.ts#network_processor:98aa3c7a181df96c:1",
  "apps/workbench/src/components/browser-column/apps-panel.tsx#filesystem_write:4cf5ee4921cf7987:1",
  "packages/agent/src/nodes/agent.ts#log_emitter:7ef703451e44cded:4",
  "packages/agent/src/tools/file/workspace-binary-artifact.ts#filesystem_write:efeb5832012963cd:1",
  "packages/runtime/src/stenographer/worker.ts#log_emitter:60d2ebbc60ac0040:1",
  "packages/runtime/src/stenographer/worker.ts#log_emitter:6a450c440341d85b:1",
  "packages/runtime/src/stenographer/worker.ts#log_emitter:808faa524bf2b947:1",
  "packages/runtime/src/stenographer/worker.ts#log_emitter:92d51e586f3a6191:1",
  "packages/runtime/src/stenographer/worker.ts#log_emitter:b2ead30ccaff59a5:1",
  "packages/runtime/src/stenographer/worker.ts#log_emitter:c7bad5bfa618a221:1",
  "packages/runtime/src/stenographer/worker.ts#log_emitter:cbad719ce71c6b05:1",
  "packages/runtime/src/stenographer/worker.ts#log_emitter:e9b6ad585ff82896:1",
  "packages/runtime/src/stenographer/worker.ts#log_emitter:e9b6ad585ff82896:2",
  "packages/runtime/src/stenographer/worker.ts#log_emitter:e9b6ad585ff82896:3",
  "packages/runtime/src/stenographer/worker.ts#log_emitter:e9b6ad585ff82896:4",
  "packages/runtime/src/stenographer/worker.ts#log_emitter:e9b6ad585ff82896:5",
  "packages/runtime/src/stenographer/worker.ts#log_emitter:ede98c03825af9b8:1",
  "packages/runtime/src/stenographer/worker.ts#log_emitter:fc8e64962951e351:2",
] as const;

export const RETIRED_MAIN_2026_09_12_SOURCE_ALARM_LOCATORS = new Set<string>(
  RETIRED_OR_MOVED_LOCATORS,
);

export const SUPERSEDED_MAIN_2026_09_12_SOURCE_ALARM_LOCATORS = new Set<string>([
  ...RETIRED_OR_MOVED_LOCATORS,
  ...ADDITIONAL_REVIEWED_LOG_DEBT,
  ...[...MAIN_2026_09_12_ORDINAL_RUN_SOURCE_LOCATORS].filter(
    (locator) => !MAIN_2026_09_12_UNMAPPED_SOURCE_ALARM_LOCATORS.has(locator),
  ),
]);

const ALL_REVIEWED_LOCATORS = new Set<string>([
  ...MAIN_2026_09_12_UNMAPPED_SOURCE_ALARM_LOCATORS,
  ...MAIN_2026_09_12_ORDINAL_RUN_SOURCE_LOCATORS,
  ...ADDITIONAL_REVIEWED_LOG_DEBT,
]);
const ALL_EXCLUSIONS = new Set<string>([
  ...FFMPEG_EXCLUSIONS,
  ...SLIDES_QUALIFICATION_EXCLUSIONS,
  ...DEV_STACK_EXCLUSIONS.filter((locator) => !DEV_STACK_DEBT.has(locator)),
  ...OTHER_BUILD_EXCLUSIONS,
]);

function owner(locator: string): string {
  return locator.split("#", 1)[0]!.split("/").slice(0, 2).join("/");
}

function exclusionReason(locator: string): string {
  if (locator.includes("dev-stack.ts")) {
    return "This exact development-stack diagnostic emits only a fixed message or closed contributor-operational value: an instance label, process ID, port, URL, path, exit/status code, build/readiness result, or acceptance state. It is not a product runtime content sink; this exclusion applies only to the reviewed occurrence, while arbitrary exception and forwarded-message calls remain release-blocking debt.";
  }
  if (locator.includes("ffmpeg")) {
    return "This exact FFmpeg integrity or packaging call handles only pinned public LGPL binaries, source archives, notices, manifests, signatures, temporary build paths, or fixed verification status. It never receives Human content or live Nautilo runtime data.";
  }
  if (locator.includes("presentation/scripts/") || locator.includes("verify-ime-browser") || locator.includes("office-slides/scripts/")) {
    return "This exact developer-only Slides or Office qualification/code-generation call handles synthetic browser evidence, generated schemas, generated shape metadata, temporary scratch paths, or fixed test status. It is not shipped product data authority and receives no live Human Workspace content.";
  }
  if (locator.includes("packages/db/scripts/finalize-")) {
    return "This exact repository maintenance write post-processes the latest generated Drizzle migration SQL with deterministic RLS, role, grant, trigger, or immutability SQL; it does not access a database or product rows and is not a runtime persistence boundary.";
  }
  return "This scanner match is the Logger interface method signature rather than an executed call. The actual Stenographer callbacks and concrete diagnostics are reviewed separately and this exclusion grants no logging authority.";
}

function logDebtContext(locator: string): string {
  if (locator.includes("stenographer")) return "the forwarding callback accepts an unconstrained message and Record<string, unknown> fields";
  if (locator.endsWith("#log_emitter:9a0075a24c1b046c:1")) return "the runtime-acceptance callback forwards check detail assembled from probe stderr or arbitrary exception messages";
  if (locator.includes("dev-stack.ts")) return "the generated-Sheets validation catch emits an arbitrary exception message through error.message or String(error)";
  if (locator.includes("invocation-service")) return "the diagnostic can include tool labels, relay/provider failures, scanned threat strings, user identifiers, or arbitrary error text";
  if (locator.includes("rooms.ts")) return "the diagnostic can include Room or user identifiers and arbitrary exception messages or stacks";
  if (locator.includes("workspace-artifacts.ts")) return "the diagnostic can include Artifact paths, document kinds, multipart failures, or arbitrary exception text";
  if (locator.includes("setup-toml-migration")) return "the migration refusal can include a caller-produced warning or emitted configuration line";
  if (locator.includes("office-") || locator.includes("office-docs") || locator.includes("office-slides")) return "the diagnostic can include a document-internal path, shape kind, browser exception, listener exception, or other arbitrary error object";
  if (locator.includes("nautilo-runtime")) return "the call emits a raw exception object from reaction, authorization, key, or protected-message processing";
  if (locator.includes("foreground-model-controls")) return "the fallback diagnostic emits arbitrary preference/database exception text";
  if (locator.includes("resume-task-approval") || locator.includes("task-run-executor")) return "the diagnostic can include Task/run identifiers and arbitrary recovery exception text";
  if (locator.includes("server-start")) return "the callback forwards an unconstrained prerequisite warning string";
  if (locator.includes("bin/nautilo-server")) return "the diagnostic can include arbitrary shutdown, certificate, or mDNS exception text";
  if (locator.includes("workspace-artifact-access-invalidation")) return "the diagnostic emits arbitrary access-invalidation exception text";
  if (locator.includes("app.ts")) return "the Event Feed adapter can forward a caller-produced warning message";
  if (locator.includes("app-tool-host")) return "the diagnostic can include a runtime provisioning note produced outside this call site";
  return "the diagnostic contains a dynamic value whose plaintext-safety contract is not proven by this alarm review";
}

function review(locator: string): SourceAlarmReview {
  if (ALL_EXCLUSIONS.has(locator)) {
    return {
      locator,
      owner: owner(locator),
      closure: "reviewed_exclusion",
      exclusionId: `exclusion.main-2026-09-12.${digest(locator)}`,
      reason: exclusionReason(locator),
    };
  }
  const declaration = CONTENT_DECLARATIONS.get(locator)
    ?? BOUNDED_LOG_DECLARATIONS.get(locator);
  if (declaration) {
    return {
      locator,
      owner: owner(locator),
      closure: "declaration",
      declarationId: declaration[0],
      reason: declaration[1],
    };
  }
  const context = logDebtContext(locator);
  return {
    locator,
    owner: owner(locator),
    closure: "baseline_debt",
    debtId: `debt.source-alarm.log.log_emitter.${digest(locator)}`,
    surface: "log",
    remediationState: "untriaged",
    releaseImpact: "blocks_whole_product_claim",
    reason: `${locator} remains a reviewed log-emitter alarm because ${context}; this current plaintext diagnostic is not classified as content-free or encrypted.`,
    evidenceGap: `${locator} lacks log-emitter alarm evidence proving redaction of every dynamic field accepted by this exact call and every upstream callback path.`,
  };
}

export const REVIEWED_MAIN_2026_09_12_SOURCE_ALARMS: readonly SourceAlarmReview[] =
  [...ALL_REVIEWED_LOCATORS].sort().map(review);
