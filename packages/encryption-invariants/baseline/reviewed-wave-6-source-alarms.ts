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

/**
 * Exact Wave 6 alarms introduced by the role lifecycle and disposable
 * Postgres test harness. Role credentials are owner-only operator secrets;
 * test harness processes carry only generated disposable data.
 */
export const REVIEWED_WAVE_6_SOURCE_ALARMS: readonly SourceAlarmReview[] = [
  exclusion(
    "bin/nautilo-dev/src/commands/infra-start.ts#log_emitter:a0c9ec1b6ab6b95f:3",
    "bin/nautilo-dev",
    "exclusion.wave6.infra-role-reconcile-error",
    "This diagnostic emits only the already-redacted reconciliation error contract and never the crypto database credential.",
  ),
  exclusion(
    "bin/nautilo-dev/src/commands/infra-start.ts#log_emitter:c6d53eb0eb42455b:8",
    "bin/nautilo-dev",
    "exclusion.wave6.infra-role-reconcile-status",
    "This exact lifecycle diagnostic contains only a fixed label and numeric subprocess exit status.",
  ),
  exclusion(
    "bin/nautilo-dev/src/commands/upgrade.ts#log_emitter:5dce54049323ea97:1",
    "bin/nautilo-dev",
    "exclusion.wave6.upgrade-role-reconcile-error",
    "This upgrade diagnostic emits the fixed role-reconciliation label plus an error contract that redacts credential values.",
  ),
  exclusion(
    "bin/nautilo-dev/src/commands/upgrade.ts#log_emitter:c6d53eb0eb42455b:2",
    "bin/nautilo-dev",
    "exclusion.wave6.upgrade-role-reconcile-status",
    "This exact lifecycle diagnostic contains only a fixed operation label and numeric exit status.",
  ),
  declaration(
    "bin/nautilo-dev/src/lib/compose-infra.ts#filesystem_write:0072bd4afc078c77:1",
    "bin/nautilo-dev",
    "source.wave6.file.dev-crypto-role-secret-temp",
    "This atomic temporary write contains only the generated crypto database role credential and is created mode 0600 beside its canonical owner-only secret path.",
  ),
  declaration(
    "bin/nautilo-dev/src/lib/compose-infra.ts#filesystem_write:00b11239e3e758e1:1",
    "bin/nautilo-dev",
    "source.wave6.file.dev-instance-env-strip-temp",
    "This atomic temporary write removes the legacy crypto credential from instance.env while preserving its existing owner-only configuration content at mode 0600.",
  ),
  declaration(
    "bin/nautilo-dev/src/lib/compose-infra.ts#filesystem_write:2893709eb9498d0c:1",
    "bin/nautilo-dev",
    "source.wave6.file.dev-crypto-role-secret-mode",
    "This filesystem operation enforces mode 0600 on the dedicated role-only crypto credential file and writes no additional payload.",
  ),
  declaration(
    "bin/nautilo-dev/src/lib/compose-infra.ts#filesystem_write:712772500efca8da:1",
    "bin/nautilo-dev",
    "source.wave6.file.dev-instance-env-strip-mode",
    "This filesystem operation restores mode 0600 after removing a legacy credential line from instance.env and writes no additional payload.",
  ),
  declaration(
    "deploy/compose-driver/src/ComposeDriver.ts#filesystem_write:4a3266ba0cbb93fd:17",
    "deploy/compose-driver",
    "source.wave6.file.production-crypto-role-secret",
    "This production driver write publishes the dedicated crypto database role credential only to its owner-only mode-0600 secret file.",
  ),
  declaration(
    "deploy/compose-driver/src/ComposeDriver.ts#filesystem_write:4a3266ba0cbb93fd:18",
    "deploy/compose-driver",
    "source.wave6.file.production-compose-role-env",
    "This production driver write publishes the crypto role credential only to the owner-only compose interpolation environment, never the server-mounted instance environment.",
  ),
  declaration(
    "deploy/compose-driver/src/ComposeDriver.ts#filesystem_write:eb64b17391d74fd8:3",
    "deploy/compose-driver",
    "source.wave6.file.production-instance-env-strip",
    "This production driver write removes the legacy crypto credential from the server-mounted instance environment while retaining mode 0600.",
  ),
  declaration(
    "deploy/compose-driver/src/ensureDbPasswords.ts#filesystem_write:44b27707c12abaf9:1",
    "deploy/compose-driver",
    "source.wave6.file.production-role-secret-temp",
    "This atomic temporary write contains only the generated crypto database role credential and is created mode 0600 before rename.",
  ),
  declaration(
    "deploy/compose-driver/src/ensureDbPasswords.ts#filesystem_write:a9d7aa29bbc17a8d:1",
    "deploy/compose-driver",
    "source.wave6.file.production-role-secret-mode",
    "This filesystem operation enforces mode 0600 on the dedicated crypto database role credential file and writes no additional payload.",
  ),
  exclusion(
    "packages/lattice-bridge/scripts/run-postgres-integration.ts#log_emitter:72319c0cf35dcdd8:1",
    "packages/lattice-bridge",
    "exclusion.wave6.integration-container-log",
    "This test-only failure diagnostic forwards disposable Postgres lifecycle logs; bootstrap scripts never print generated credential values.",
  ),
  exclusion(
    "packages/lattice-bridge/scripts/run-postgres-integration.ts#subprocess_processor:2b3d9b951573cd84:1",
    "packages/lattice-bridge",
    "exclusion.wave6.integration-command-runner",
    "This test-only process runner invokes fixed local Docker, Bun, and psql commands against a uniquely named disposable database with generated credentials passed by environment or stdin.",
  ),
  exclusion(
    "packages/lattice-bridge/scripts/run-postgres-integration.ts#subprocess_processor:ddd56a4e64189b4d:1",
    "packages/lattice-bridge",
    "exclusion.wave6.integration-health-probe",
    "This test-only Docker inspection reads only the disposable container health state and processes no product or user-authored data.",
  ),
  exclusion(
    "packages/lattice-bridge/scripts/run-postgres-integration.ts#subprocess_processor:eca9f030cb36bd73:1",
    "packages/lattice-bridge",
    "exclusion.wave6.integration-test-process",
    "This test-only Bun process receives generated disposable database URLs and executes only the committed lattice integration suite.",
  ),
  exclusion(
    "packages/lattice-bridge/scripts/run-postgres-integration.ts#subprocess_processor:eceb48e51aa24aa2:1",
    "packages/lattice-bridge",
    "exclusion.wave6.integration-container-cleanup",
    "This test-only Docker process stops one uniquely named disposable container and carries no persisted product payload.",
  ),
];
