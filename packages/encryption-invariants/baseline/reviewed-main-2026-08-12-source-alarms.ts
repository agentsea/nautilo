import { createHash } from "node:crypto";
import type { CoverageSurface } from "../src/model";
import type { SourceAlarmReview } from "../src/node/source-alarm-review";

export const SUPERSEDED_MAIN_2026_08_12_SOURCE_ALARM_LOCATORS = new Set<string>([
  "apps/desktop/electron/config.ts#filesystem_write:03e76a8b93c37594:1",
  "apps/desktop/electron/config.ts#filesystem_write:07e9a349d658ad0a:1",
  "apps/desktop/electron/main.ts#log_emitter:4c91318a6d584bcd:28",
  "apps/desktop/electron/main.ts#log_emitter:4c91318a6d584bcd:29",
  "apps/desktop/electron/main.ts#log_emitter:4c91318a6d584bcd:30",
  "apps/desktop/electron/main.ts#log_emitter:4c91318a6d584bcd:31",
  "apps/desktop/electron/main.ts#log_emitter:4c91318a6d584bcd:32",
  "apps/desktop/electron/main.ts#log_emitter:4c91318a6d584bcd:33",
  "apps/desktop/electron/main.ts#log_emitter:4c91318a6d584bcd:34",
  "apps/desktop/electron/main.ts#log_emitter:4c91318a6d584bcd:35",
  "apps/desktop/electron/main.ts#log_emitter:4c91318a6d584bcd:36",
  "apps/desktop/electron/main.ts#log_emitter:9318a4d9f9cc61d8:13",
  "apps/desktop/electron/main.ts#log_emitter:c59cd9d20d6b1e0b:7",
  "apps/desktop/electron/main.ts#log_emitter:c59cd9d20d6b1e0b:8",
  "apps/desktop/electron/main.ts#log_emitter:c59cd9d20d6b1e0b:9",
  "apps/desktop/electron/main.ts#log_emitter:c59cd9d20d6b1e0b:10",
  "apps/desktop/electron/main.ts#log_emitter:c59cd9d20d6b1e0b:11",
  "apps/desktop/electron/main.ts#log_emitter:c88b9bfe0560c022:10",
  "apps/desktop/electron/main.ts#network_processor:ef993855494c1601:1",
  "apps/desktop/electron/main.ts#network_processor:ef993855494c1601:2",
  "apps/desktop/electron/main.ts#network_processor:ef993855494c1601:3",
  "apps/desktop/first-run/index.tsx#log_emitter:610f2f24bde78727:1",
  "apps/desktop/scripts/build-electron.ts#filesystem_write:be38a5c635e9a7ee:4",
  "bin/nautilo-dev/src/lib/postgres-archive.ts#subprocess_processor:79da5f90a215fe52:1",
]);

const RUNTIME_LOCATORS = [
  "apps/desktop/electron/accepted-identity-cold-boot-terminal.ts#network_processor:600ef328b352035e:1",
  "apps/desktop/electron/accepted-identity-cold-boot-terminal.ts#network_processor:e4ac02307b139e3f:1",
  "apps/desktop/electron/cold-boot-observation.ts#network_processor:3d415350e0820701:1",
  "apps/desktop/electron/cold-boot-terminal-runtime.ts#network_processor:a8f4801219222770:1",
  "apps/desktop/electron/cold-boot-terminal-runtime.ts#network_processor:b4b370ef4d75fdfa:1",
  "apps/desktop/electron/committed-cold-boot-terminal.ts#network_processor:4f90bba6cdfd3c8e:1",
  "apps/desktop/electron/committed-cold-boot-terminal.ts#network_processor:c6a1cafe398bbf8a:1",
  "apps/desktop/electron/config-schema.ts#filesystem_write:3428227892cb5e8f:1",
  "apps/desktop/electron/config-schema.ts#filesystem_write:70b318ac90f9404d:1",
  "apps/desktop/electron/config-schema.ts#filesystem_write:ce9c26d85ed83796:1",
  "apps/desktop/electron/config-schema.ts#filesystem_write:d005bf0747616ddb:1",
  "apps/desktop/electron/logto-auth-diagnostic.ts#network_processor:5e6e53b383faf2d5:1",
  "apps/desktop/electron/main.ts#log_emitter:1fe75189a450468e:1",
  "apps/desktop/electron/main.ts#log_emitter:ae27fd70f90d5f14:10",
  "apps/desktop/electron/main.ts#network_processor:0d2ab469d7540d61:3",
  "apps/desktop/electron/main.ts#network_processor:0d2ab469d7540d61:4",
  "apps/desktop/electron/main.ts#network_processor:797805819cb40388:1",
  "apps/desktop/electron/main.ts#network_processor:797805819cb40388:2",
  "apps/desktop/electron/opencode-acp-execution-host.ts#log_emitter:2a33094f9395cf10:1",
  "apps/desktop/electron/opencode-acp-execution-host.ts#log_emitter:719911aae39366c8:1",
  "apps/desktop/electron/opencode-acp-execution-host.ts#log_emitter:bb073b82285b77ec:1",
  "apps/desktop/electron/opencode-acp-readiness-host.ts#subprocess_processor:00edbf1039e2ec30:1",
  "apps/desktop/electron/pending-connection.ts#filesystem_write:11c41373210c45d2:1",
  "apps/desktop/electron/pending-connection.ts#filesystem_write:70b318ac90f9404d:1",
  "apps/desktop/electron/pending-connection.ts#filesystem_write:d005bf0747616ddb:1",
  "apps/desktop/electron/pending-connection.ts#filesystem_write:dce1b35e401f05d0:1",
  "apps/desktop/first-run/index.tsx#log_emitter:c467686340f4efc2:1",
  "bin/nautilo-dev/src/commands/delete-instance.ts#log_emitter:c6d53eb0eb42455b:7",
  "packages/acp-host/src/process-supervisor.ts#subprocess_processor:eac758aede87fef7:1",
] as const;

const BUILD_AND_TEST_LOCATORS = [
  "apps/desktop/scripts/build-electron.ts#filesystem_write:d005bf0747616ddb:2",
  "apps/desktop/scripts/desktop-connection-smoke.ts#filesystem_write:d005bf0747616ddb:1",
  "apps/desktop/scripts/desktop-connection-smoke.ts#subprocess_processor:15eda82f572bacc4:1",
  "apps/desktop/scripts/desktop-connection-smoke.ts#temporary_storage:6195c4a697612961:1",
  "apps/desktop/scripts/desktop-connection-smoke.ts#temporary_storage:6d75cfad7940ae8b:1",
] as const;

const DEBT_KIND = {
  filesystem_write: { surface: "file", marker: "filesystem-write alarm" },
  network_processor: { surface: "processor", marker: "network-processor alarm" },
  subprocess_processor: { surface: "processor", marker: "subprocess-processor alarm" },
  log_emitter: { surface: "log", marker: "log-emitter alarm" },
} as const satisfies Record<string, { surface: CoverageSurface; marker: string }>;

function owner(locator: string): string {
  return locator.split("#", 1)[0]!.split("/").slice(0, 2).join("/");
}

function unresolvedRuntimeDebt(locator: string): SourceAlarmReview {
  const kind = (
    locator.split("#", 2)[1]!.split(":", 1)[0]!
  ) as keyof typeof DEBT_KIND;
  const { surface, marker } = DEBT_KIND[kind];
  const digest = createHash("sha256").update(locator).digest("hex").slice(0, 16);
  return {
    locator,
    owner: owner(locator),
    closure: "baseline_debt",
    debtId: `debt.source-alarm.${surface}.${kind}.${digest}`,
    surface,
    remediationState: "untriaged",
    releaseImpact: "blocks_whole_product_claim",
    reason:
      `${locator} is a current ${marker} whose exact payload classification and relationship to an encrypted semantic boundary remain untriaged.`,
    evidenceGap:
      `${locator} lacks executable evidence proving the exact fields, redaction or encryption contract, and plaintext-safety boundary for this ${marker}.`,
  };
}

export const REVIEWED_MAIN_2026_08_12_SOURCE_ALARMS:
  readonly SourceAlarmReview[] = [
  ...RUNTIME_LOCATORS.map(unresolvedRuntimeDebt),
  {
    locator: "bin/nautilo-dev/src/lib/postgres-archive.ts#subprocess_processor:f72b95afd3d6621f:1",
    owner: "bin/nautilo-dev",
    closure: "declaration",
    declarationId: "source.main-2026-08-03.dev-full-backup-11",
    reason:
      "This moved callsite streams the known full-development snapshot boundary through the existing pg_restore subprocess; its plaintext-at-rest status remains represented by source.backup.dev-snapshot.",
  },
  ...BUILD_AND_TEST_LOCATORS.map((locator, index) => ({
    locator,
    owner: "apps/desktop",
    closure: "reviewed_exclusion" as const,
    exclusionId:
      `exclusion.main-2026-08-12.build-test-${String(index + 1).padStart(2, "0")}`,
    reason:
      "This exact build or smoke-test callsite handles generated application assets, an isolated temporary fixture, or a test subprocess and is not reachable from product data processing.",
  })),
];
