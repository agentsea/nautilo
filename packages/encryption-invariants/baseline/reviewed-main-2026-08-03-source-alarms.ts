import type { SourceAlarmReview } from "../src/node/source-alarm-review";

const SUPERSEDED_SAVE_ALARMS = [
  "bin/nautilo-dev/src/commands/save.ts#log_emitter:c467686340f4efc2:1",
  "bin/nautilo-dev/src/commands/save.ts#log_emitter:c467686340f4efc2:2",
  "bin/nautilo-dev/src/commands/save.ts#log_emitter:c6d53eb0eb42455b:1",
  "bin/nautilo-dev/src/commands/save.ts#log_emitter:c6d53eb0eb42455b:2",
  "bin/nautilo-dev/src/commands/save.ts#filesystem_write:9004274503fc3324:1",
  "bin/nautilo-dev/src/commands/save.ts#log_emitter:468c68ed4723a1f2:4",
  "bin/nautilo-dev/src/commands/save.ts#log_emitter:468c68ed4723a1f2:5",
  "bin/nautilo-dev/src/commands/save.ts#log_emitter:468c68ed4723a1f2:6",
  "bin/nautilo-dev/src/commands/save.ts#filesystem_write:a72952a28b4432ab:1",
  "bin/nautilo-dev/src/commands/save.ts#log_emitter:468c68ed4723a1f2:7",
  "bin/nautilo-dev/src/commands/save.ts#log_emitter:c6d53eb0eb42455b:3",
  "bin/nautilo-dev/src/commands/save.ts#log_emitter:468c68ed4723a1f2:8",
  "bin/nautilo-dev/src/commands/save.ts#filesystem_write:743c9d7e046f8a09:1",
  "bin/nautilo-dev/src/commands/save.ts#log_emitter:468c68ed4723a1f2:9",
  "bin/nautilo-dev/src/commands/save.ts#filesystem_write:42fe693909f60053:1",
  "bin/nautilo-dev/src/commands/save.ts#log_emitter:468c68ed4723a1f2:10",
  "bin/nautilo-dev/src/commands/save.ts#log_emitter:468c68ed4723a1f2:11",
  "bin/nautilo-dev/src/commands/save.ts#subprocess_processor:bbabf7a25358076a:1",
  "bin/nautilo-dev/src/commands/save.ts#log_emitter:468c68ed4723a1f2:12",
  "bin/nautilo-dev/src/commands/save.ts#subprocess_processor:1dc4e0075d020627:1",
  "bin/nautilo-dev/src/commands/save.ts#log_emitter:468c68ed4723a1f2:13",
  "bin/nautilo-dev/src/commands/save.ts#log_emitter:468c68ed4723a1f2:14",
] as const;

const SUPERSEDED_DATABASE_HELPER_ALARMS = [
  "bin/nautilo-dev/src/lib/docker-db.ts#temporary_storage:a6ad30c103c71aba:1",
  "bin/nautilo-dev/src/lib/docker-db.ts#subprocess_processor:bbabf7a25358076a:1",
  "bin/nautilo-dev/src/lib/logto-db.ts#temporary_storage:a6ad30c103c71aba:1",
  "bin/nautilo-dev/src/lib/logto-db.ts#subprocess_processor:bbabf7a25358076a:1",
] as const;

/** Alarm locators removed by the reviewed full-backup/clone refactor. */
export const SUPERSEDED_MAIN_2026_08_03_SOURCE_ALARM_LOCATORS =
  new Set<string>([
    ...SUPERSEDED_SAVE_ALARMS,
    ...SUPERSEDED_DATABASE_HELPER_ALARMS,
  ]);

const BACKUP_DECLARATION_LOCATORS = [
  "bin/nautilo-dev/src/commands/clone.ts#subprocess_processor:fdb5ef6544f875a9:1",
  "bin/nautilo-dev/src/commands/save.ts#subprocess_processor:eca9f030cb36bd73:1",
  "bin/nautilo-dev/src/commands/save.ts#filesystem_write:80513c1f6b1a6eb9:1",
  "bin/nautilo-dev/src/commands/save.ts#filesystem_write:d89b2e16115c1b38:1",
  "bin/nautilo-dev/src/lib/full-dev-backup.ts#filesystem_write:64c6ed672e2a42f6:1",
  "bin/nautilo-dev/src/lib/postgres-archive.ts#subprocess_processor:daa553662e7385df:1",
  "bin/nautilo-dev/src/lib/postgres-archive.ts#subprocess_processor:c0fde6ee995a0176:1",
  "bin/nautilo-dev/src/lib/postgres-archive.ts#subprocess_processor:96771472e98b362f:1",
  "bin/nautilo-dev/src/lib/postgres-archive.ts#filesystem_write:86aac7134eeff2af:1",
  "bin/nautilo-dev/src/lib/postgres-archive.ts#subprocess_processor:c13feca0e96afcb0:1",
  "bin/nautilo-dev/src/lib/postgres-archive.ts#subprocess_processor:79da5f90a215fe52:1",
  "bin/nautilo-dev/src/lib/postgres-archive.ts#subprocess_processor:eca9f030cb36bd73:1",
] as const;

const OPERATIONAL_EXCLUSION_LOCATORS = [
  "bin/nautilo-dev/src/commands/clone.ts#subprocess_processor:65563aae60c4e467:1",
  "bin/nautilo-dev/src/commands/clone.ts#subprocess_processor:eca9f030cb36bd73:1",
  "bin/nautilo-dev/src/commands/clone.ts#subprocess_processor:5b210ea7747eb17c:1",
  "bin/nautilo-dev/src/commands/clone.ts#subprocess_processor:eca9f030cb36bd73:2",
  "bin/nautilo-dev/src/commands/clone.ts#log_emitter:6eab313eca52a747:1",
  "bin/nautilo-dev/src/commands/clone.ts#log_emitter:6eab313eca52a747:2",
  "bin/nautilo-dev/src/commands/clone.ts#log_emitter:c6d53eb0eb42455b:1",
  "bin/nautilo-dev/src/commands/clone.ts#log_emitter:6eab313eca52a747:3",
  "bin/nautilo-dev/src/commands/infra-start.ts#log_emitter:c6d53eb0eb42455b:9",
  "bin/nautilo-dev/src/commands/infra-start.ts#log_emitter:6eab313eca52a747:9",
  "bin/nautilo-dev/src/commands/inspect.ts#log_emitter:468c68ed4723a1f2:14",
  "bin/nautilo-dev/src/commands/inspect.ts#log_emitter:6eab313eca52a747:4",
  "bin/nautilo-dev/src/commands/inspect.ts#log_emitter:468c68ed4723a1f2:15",
  "bin/nautilo-dev/src/commands/inspect.ts#log_emitter:468c68ed4723a1f2:16",
  "bin/nautilo-dev/src/commands/save.ts#log_emitter:6eab313eca52a747:1",
  "bin/nautilo-dev/src/commands/save.ts#log_emitter:6eab313eca52a747:2",
  "bin/nautilo-dev/src/index.ts#log_emitter:c467686340f4efc2:4",
  "bin/nautilo-dev/src/lib/backup-quiescence.ts#log_emitter:e14e0fb752983214:1",
  "bin/nautilo-dev/src/lib/backup-quiescence.ts#subprocess_processor:eca9f030cb36bd73:1",
  "bin/nautilo-dev/src/lib/backup-quiescence.ts#subprocess_processor:5bc15047ae44ba3b:1",
  "bin/nautilo-dev/src/lib/backup-quiescence.ts#subprocess_processor:5bc15047ae44ba3b:2",
  "bin/nautilo-dev/src/lib/clone-operation.ts#filesystem_write:23219fe916e50594:1",
  "bin/nautilo-dev/src/lib/clone-operation.ts#filesystem_write:f68b0e5d292e324e:1",
  "bin/nautilo-dev/src/lib/clone-preflight.ts#subprocess_processor:65563aae60c4e467:1",
  "bin/nautilo-dev/src/lib/clone-preflight.ts#subprocess_processor:5b210ea7747eb17c:1",
  "packages/lattice-bridge/scripts/run-postgres-integration.ts#subprocess_processor:4d6ddb0782180ba8:1",
  "packages/lattice-bridge/scripts/run-postgres-integration.ts#subprocess_processor:84691d95fdd56350:1",
] as const;

/**
 * Exact closures for the source alarms introduced by the full-backup/clone
 * refactor and by the self-contained lattice Postgres test harness.
 */
export const REVIEWED_MAIN_2026_08_03_SOURCE_ALARMS:
  readonly SourceAlarmReview[] = [
    ...BACKUP_DECLARATION_LOCATORS.map((locator, index) => ({
      locator,
      owner: "bin/nautilo-dev",
      closure: "declaration" as const,
      declarationId:
        `source.main-2026-08-03.dev-full-backup-${String(index + 1).padStart(2, "0")}`,
      reason:
        "This exact callsite reads, writes, transports, or atomically publishes the known full-development snapshot boundary; its plaintext-at-rest status remains represented by source.backup.dev-snapshot rather than hidden as a new surface.",
    })),
    ...OPERATIONAL_EXCLUSION_LOCATORS.map((locator, index) => ({
      locator,
      owner: locator.startsWith("packages/lattice-bridge/")
        ? "packages/lattice-bridge"
        : "bin/nautilo-dev",
      closure: "reviewed_exclusion" as const,
      exclusionId:
        `exclusion.main-2026-08-03.operational-${String(index + 1).padStart(2, "0")}`,
      reason:
        "This exact callsite handles only fixed diagnostics, bounded instance/migration metadata, an owner-only operation journal, or Docker lifecycle state; it does not emit or persist product content, credentials, private keys, or snapshot bytes.",
    })),
  ];
