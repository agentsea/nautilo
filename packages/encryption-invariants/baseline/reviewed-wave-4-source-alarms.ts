import type { SourceAlarmReview } from "../src/node/source-alarm-review";

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

/**
 * Exact post-Wave-0 source alarms reviewed by M228.
 *
 * These are either a call site belonging to a concrete semantic boundary or a
 * mechanical status/exit operation with no distinct payload. No new baseline
 * debt is permitted here.
 */
export const REVIEWED_WAVE_4_SOURCE_ALARMS: readonly SourceAlarmReview[] = [
  declaration(
    "apps/desktop/electron/auth/relay-pair.ts#filesystem_write:cf998831cb05ac37:1",
    "apps/desktop",
    "source.wave4.file.desktop-physical-device-seed",
    "Atomic publication of the owner-only random physical-device seed is device-local state with no server or agent recipient.",
  ),
  declaration(
    "apps/desktop/electron/auth/relay-pair.ts#filesystem_write:851f24973bbff4a7:2",
    "apps/desktop",
    "source.wave4.file.desktop-relay-installation-id",
    "The mode-0600 installation UUID is device-local grouping state and is neither an authentication credential nor user-authored content.",
  ),
  declaration(
    "apps/desktop/electron/auth/relay-pair.ts#filesystem_write:6ac7bae0059480b3:3",
    "apps/desktop",
    "source.wave4.file.desktop-relay-token",
    "This atomic relay-token publication writes an operator credential through safeStorage when available with an explicit mode-0600 fallback.",
  ),
  declaration(
    "apps/desktop/electron/github-cli-connection.ts#subprocess_processor:25b4ed5560e2e5f0:1",
    "apps/desktop",
    "source.wave4.processor.github-cli-connection",
    "This local GitHub CLI subprocess receives only fixed commands; its bounded status output and one-time device code remain in the owner-operated desktop process and are never persisted or sent to Nautilo's server.",
  ),
  declaration(
    "bin/nautilo-dev/src/commands/infra-start.ts#log_emitter:a0c9ec1b6ab6b95f:1",
    "bin/nautilo-dev",
    "source.wave4.log.infra-credential-plan-error",
    "The operator diagnostic contains only an instance identifier, instance-env path, missing credential key names, or fixed redaction text and never credential values.",
  ),
  declaration(
    "bin/nautilo-dev/src/commands/infra-start.ts#log_emitter:a0c9ec1b6ab6b95f:2",
    "bin/nautilo-dev",
    "source.wave4.log.infra-persistence-guard-error",
    "The operator diagnostic contains only an instance identifier, instance-env path, credential key names, or Docker volume names and never credential values.",
  ),
  declaration(
    "bin/nautilo-dev/src/commands/infra-start.ts#log_emitter:6eab313eca52a747:8",
    "bin/nautilo-dev",
    "source.wave4.log.bootstrap-claim-invite",
    "This deliberate operator-secret terminal boundary prints the one-time bootstrap claim credential only to the invoking local operator.",
  ),
  declaration(
    "bin/nautilo-dev/src/commands/server-start.ts#log_emitter:a0c9ec1b6ab6b95f:1",
    "bin/nautilo-dev",
    "source.wave4.log.server-credential-plan-error",
    "The server-start diagnostic contains only an instance identifier, instance-env path, credential key names, or Docker volume names and never credential values.",
  ),
  declaration(
    "bin/nautilo-dev/src/lib/service-role-reconcile.ts#subprocess_processor:72b056e782b94184:1",
    "bin/nautilo-dev",
    "source.wave4.processor.service-role-reconcile",
    "Internal service-role credentials cross this local Docker subprocess only over stdin; argv, stdout, stderr, and thrown diagnostics redact their values.",
  ),
  declaration(
    "packages/config-guard/src/snapshot-store.ts#filesystem_write:c291884e3cbb497e:1",
    "packages/config-guard",
    "source.wave4.file.config-snapshot-env",
    "The mode-0600 configuration snapshot intentionally retains operator-secret environment content under an owner-only mode-0700 directory.",
  ),
  declaration(
    "packages/config-guard/src/snapshot-store.ts#filesystem_write:263327eec14b666a:1",
    "packages/config-guard",
    "source.wave4.file.config-snapshot-metadata",
    "The mode-0600 configuration snapshot metadata is owner-only operator state retained with the corresponding secret environment snapshot.",
  ),
  declaration(
    "packages/config-guard/src/snapshot-store.ts#filesystem_write:a89957230f5935e4:1",
    "packages/config-guard",
    "source.wave4.file.config-snapshot-result",
    "This mode-0600 update preserves owner-only transaction result metadata without widening the configuration snapshot recipient boundary.",
  ),
  exclusion(
    "bin/nautilo-dev/src/commands/dev-stack.ts#log_emitter:c6d53eb0eb42455b:7",
    "bin/nautilo-dev",
    "exclusion.wave4.dev-stack-runtime-acceptance-exit",
    "This exact diagnostic emits only a fixed label and a numeric process exit status.",
  ),
  exclusion(
    "bin/nautilo-dev/src/commands/dev-stack.ts#log_emitter:468c68ed4723a1f2:9",
    "bin/nautilo-dev",
    "exclusion.wave4.dev-stack-static-shutdown-help",
    "This exact diagnostic is a fixed Ctrl-C lifecycle instruction with no dynamic payload.",
  ),
  exclusion(
    "bin/nautilo-dev/src/commands/infra-start.ts#log_emitter:c6d53eb0eb42455b:5",
    "bin/nautilo-dev",
    "exclusion.wave4.infra-compose-exit",
    "This exact diagnostic emits only a fixed operation label and a numeric process exit status.",
  ),
  exclusion(
    "bin/nautilo-dev/src/commands/infra-start.ts#log_emitter:c6d53eb0eb42455b:6",
    "bin/nautilo-dev",
    "exclusion.wave4.infra-health-status",
    "This exact diagnostic reports a localhost readiness failure using fixed endpoint construction and bounded transport status text.",
  ),
  exclusion(
    "bin/nautilo-dev/src/commands/infra-start.ts#log_emitter:c6d53eb0eb42455b:7",
    "bin/nautilo-dev",
    "exclusion.wave4.infra-bootstrap-exit",
    "This exact diagnostic emits only a fixed bootstrap label and a numeric process exit status.",
  ),
  exclusion(
    "bin/nautilo-dev/src/commands/infra-start.ts#log_emitter:468c68ed4723a1f2:12",
    "bin/nautilo-dev",
    "exclusion.wave4.infra-static-role-contract",
    "This exact diagnostic is a fixed service-role reconciliation status message with no dynamic payload.",
  ),
  exclusion(
    "bin/nautilo-dev/src/commands/infra-start.ts#log_emitter:468c68ed4723a1f2:13",
    "bin/nautilo-dev",
    "exclusion.wave4.infra-static-claim-status",
    "This exact diagnostic is a fixed bootstrap-claim lifecycle status message with no credential payload.",
  ),
  exclusion(
    "bin/nautilo-dev/src/commands/infra-start.ts#log_emitter:468c68ed4723a1f2:14",
    "bin/nautilo-dev",
    "exclusion.wave4.infra-static-completion",
    "This exact diagnostic is a fixed completion instruction with no dynamic payload.",
  ),
  exclusion(
    "bin/nautilo-dev/src/lib/compose-infra.ts#subprocess_processor:31634450c17bb93e:1",
    "bin/nautilo-dev",
    "exclusion.wave4.compose-volume-inspect",
    "This exact Docker subprocess receives only the derived Compose volume name and fixed volume-inspect arguments.",
  ),
  declaration(
    "packages/config/src/officecli/run.ts#subprocess_processor:ec4da32dc8c52176:1",
    "packages/config",
    "source.wave4.processor.officecli-bounded-runner",
    "This local OfficeCLI subprocess is the declared document-transform processor boundary; arguments are fixed by trusted profiles, stdout and stderr are independently bounded, and cancellation, deadlines, and child cleanup are enforced.",
  ),
];

/** Reviews superseded by an exact source fix or a moved current call site. */
export const SUPERSEDED_WAVE_0_SOURCE_ALARM_LOCATORS: ReadonlySet<string> =
  new Set([
    "apps/desktop/electron/main.ts#log_emitter:ae27fd70f90d5f14:8",
    "packages/config-guard/src/snapshot-store.ts#filesystem_write:6c9d26dd02808165:1",
    "packages/config-guard/src/snapshot-store.ts#filesystem_write:88fddc56da19bace:1",
    "packages/config-guard/src/snapshot-store.ts#filesystem_write:d2ec519567ab6b7d:1",
  ]);
