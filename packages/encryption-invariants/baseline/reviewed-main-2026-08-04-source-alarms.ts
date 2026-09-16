import type { SourceAlarmReview } from "../src/node/source-alarm-review";

export const SUPERSEDED_MAIN_2026_08_04_SOURCE_ALARM_LOCATORS =
  new Set<string>([
    "apps/workbench/src/contexts/room-navigation-context.tsx#notification_emitter:962a50fc0c4e1420:1",
    "bin/nautilo-dev/src/commands/clone.ts#log_emitter:6eab313eca52a747:1",
    "bin/nautilo-dev/src/commands/clone.ts#log_emitter:6eab313eca52a747:2",
    "bin/nautilo-dev/src/commands/clone.ts#log_emitter:6eab313eca52a747:3",
    "bin/nautilo-dev/src/commands/clone.ts#log_emitter:c6d53eb0eb42455b:1",
    "bin/nautilo-dev/src/commands/clone.ts#subprocess_processor:eca9f030cb36bd73:2",
    "bin/nautilo-dev/src/commands/dev-stack.ts#log_emitter:468c68ed4723a1f2:9",
    "bin/nautilo-dev/src/commands/save.ts#log_emitter:468c68ed4723a1f2:1",
    "bin/nautilo-dev/src/commands/save.ts#log_emitter:468c68ed4723a1f2:2",
    "bin/nautilo-dev/src/commands/save.ts#log_emitter:468c68ed4723a1f2:3",
    "bin/nautilo-dev/src/commands/save.ts#log_emitter:6eab313eca52a747:1",
    "bin/nautilo-dev/src/commands/save.ts#log_emitter:6eab313eca52a747:2",
    "bin/nautilo-dev/src/lib/backup-quiescence.ts#log_emitter:e14e0fb752983214:1",
    "bin/nautilo-dev/src/lib/clone-operation.ts#filesystem_write:23219fe916e50594:1",
    "bin/nautilo-dev/src/lib/clone-operation.ts#filesystem_write:f68b0e5d292e324e:1",
  ]);

const DECLARATION_LOCATORS = [
  "bin/nautilo-dev/src/commands/clone.ts#subprocess_processor:ceb4e38c63c54ed4:1",
  "bin/nautilo-dev/src/commands/clone.ts#subprocess_processor:0f9be620f0e88cb4:1",
  "bin/nautilo-dev/src/commands/clone.ts#subprocess_processor:a3160316709a7b8d:1",
  "bin/nautilo-dev/src/commands/clone.ts#subprocess_processor:7f071c691e413c75:1",
  "bin/nautilo-dev/src/commands/compact-checkpoints.ts#subprocess_processor:eca9f030cb36bd73:1",
  "bin/nautilo-dev/src/commands/dev-stack.ts#filesystem_write:d005bf0747616ddb:1",
  "bin/nautilo-dev/src/commands/dev-stack.ts#filesystem_write:d005bf0747616ddb:2",
  "bin/nautilo-dev/src/commands/dev-stack.ts#subprocess_processor:e41132482d93785d:1",
  "bin/nautilo-dev/src/lib/backup-quiescence.ts#subprocess_processor:f0a3667a1c47b39a:1",
  "bin/nautilo-dev/src/lib/checkpoint-maintenance-backups.ts#filesystem_write:34e864634c05ba81:1",
  "bin/nautilo-dev/src/lib/checkpoint-maintenance-backups.ts#filesystem_write:543bfe18482736de:1",
  "bin/nautilo-dev/src/lib/checkpoint-maintenance-backups.ts#filesystem_write:c5fdc21f285f4648:1",
  "bin/nautilo-dev/src/lib/checkpoint-maintenance-backups.ts#filesystem_write:212eaae425781ba2:1",
  "bin/nautilo-dev/src/lib/checkpoint-physical-reclamation.ts#subprocess_processor:0b66d510c638d2c2:1",
  "bin/nautilo-dev/src/lib/checkpoint-semantic-compaction.ts#subprocess_processor:0b66d510c638d2c2:1",
  "bin/nautilo-dev/src/lib/clone-seed-store.ts#filesystem_write:34e864634c05ba81:1",
  "bin/nautilo-dev/src/lib/clone-seed-store.ts#filesystem_write:3b8fd8dd1464a85c:1",
  "bin/nautilo-dev/src/lib/d489-operation-records.ts#filesystem_write:7c24e58ae36a8fd4:1",
  "bin/nautilo-dev/src/lib/d489-operation-records.ts#filesystem_write:f68b0e5d292e324e:1",
  "packages/config/src/instance-allocation-lock.ts#filesystem_write:79553ddf576c0b9b:1",
] as const;

const EXCLUSION_LOCATORS = [
  "apps/desktop/electron/main.ts#log_emitter:63d2fefaeea77254:1",
  "apps/desktop/electron/main.ts#log_emitter:6e30eac9e1dfdc48:5",
  "apps/desktop/scripts/after-pack.cjs#subprocess_processor:97f115363517c1c6:1",
  "apps/desktop/scripts/after-pack.cjs#subprocess_processor:1591868ab5d7c7fc:1",
  "apps/desktop/scripts/after-pack.cjs#subprocess_processor:245149c4dd3033a0:1",
  "apps/desktop/scripts/after-sign.cjs#subprocess_processor:718781925b7f0518:1",
  "apps/desktop/scripts/inspect-macos-local-network-artifact.ts#subprocess_processor:ef77230c4d108e47:1",
  "apps/desktop/scripts/inspect-macos-local-network-artifact.ts#subprocess_processor:b84e55f3ad16d57d:1",
  "apps/desktop/scripts/inspect-macos-local-network-artifact.ts#subprocess_processor:99253cb87658d294:1",
  "apps/workbench/src/notifications/notification-state-context.tsx#notification_emitter:47e8b6e75f62b6ac:1",
  "apps/workbench/src/pages/settings/sections/mobile-access-section.tsx#filesystem_write:ffc15dccf825344c:1",
  "apps/workbench/src/pages/settings/sections/mobile-access-section.tsx#filesystem_write:5c8b6a6be2be4d79:1",
  "bin/nautilo-dev/src/commands/clone.ts#log_emitter:249be2c6523b36a4:1",
  "bin/nautilo-dev/src/commands/infra-start.ts#log_emitter:c467686340f4efc2:5",
  "bin/nautilo-dev/src/index.ts#log_emitter:05326275cfdab464:1",
  "bin/nautilo-dev/src/commands/dev-stack.ts#log_emitter:3832bbf1d6e89a4f:1",
  "bin/nautilo-dev/src/commands/dev-stack.ts#log_emitter:c467686340f4efc2:20",
  "bin/nautilo-dev/src/commands/dev-stack.ts#log_emitter:9a0075a24c1b046c:1",
  "bin/nautilo-dev/src/commands/dev-stack.ts#log_emitter:c467686340f4efc2:21",
  "bin/nautilo-dev/src/commands/infra-start.ts#log_emitter:c467686340f4efc2:4",
  "bin/nautilo-dev/src/commands/infra-start.ts#log_emitter:c6d53eb0eb42455b:10",
  "bin/nautilo-dev/src/commands/verify.ts#log_emitter:4f49d37593a52ffb:1",
  "bin/nautilo-dev/src/lib/docker-published-ports.ts#subprocess_processor:d47727fa7150941e:1",
  "packages/agent/src/graph/resume-host-choice.ts#log_emitter:a1436e7c26c240df:1",
  "packages/server/src/app.ts#log_emitter:a1436e7c26c240df:13",
  "packages/server/src/realtime/relay-endpoint.ts#log_emitter:89b81c36ea23316a:6",
  "packages/server/src/realtime/relay-endpoint.ts#log_emitter:89b81c36ea23316a:7",
  "packages/server/src/realtime/relay-endpoint.ts#log_emitter:89b81c36ea23316a:8",
  "packages/server/src/realtime/ws-publisher.ts#log_emitter:89b81c36ea23316a:2",
  "packages/server/src/routes/auth.ts#log_emitter:89b81c36ea23316a:6",
  "packages/server/src/routes/remote-control.ts#log_emitter:4653f2598ab1da64:1",
  "packages/server/src/routes/remote-control.ts#log_emitter:4653f2598ab1da64:2",
  "packages/server/src/routes/remote-control.ts#log_emitter:c915ecb77b1982e2:1",
  "packages/server/src/routes/ws.ts#log_emitter:89b81c36ea23316a:3",
] as const;

function owner(locator: string): string {
  return locator.split("#", 1)[0]!.split("/").slice(0, 2).join("/");
}

export const REVIEWED_MAIN_2026_08_04_SOURCE_ALARMS:
  readonly SourceAlarmReview[] = [
    ...DECLARATION_LOCATORS.map((locator, index) => ({
      locator,
      owner: owner(locator),
      closure: "declaration" as const,
      declarationId:
        `source.main-2026-08-04.operational-boundary-${String(index + 1).padStart(2, "0")}`,
      reason:
        "This exact callsite participates in an already inventoried development backup, clone, checkpoint-maintenance, instance-allocation, or operation-journal boundary; retaining that semantic declaration is more accurate than inventing a second data surface.",
    })),
    ...EXCLUSION_LOCATORS.map((locator, index) => ({
      locator,
      owner: owner(locator),
      closure: "reviewed_exclusion" as const,
      exclusionId:
        `exclusion.main-2026-08-04.fixed-operational-${String(index + 1).padStart(2, "0")}`,
      reason:
        "This exact callsite handles fixed packaging probes, bounded lifecycle identifiers, content-free notification state, browser-local QR/canvas presentation, or a fixed/redacted diagnostic; it does not persist or emit Room content, file bytes, credentials, private keys, or raw exception messages.",
    })),
  ];
