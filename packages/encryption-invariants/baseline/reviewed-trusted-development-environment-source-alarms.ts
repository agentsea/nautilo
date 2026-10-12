import type { SourceAlarmReview } from "../src/node/source-alarm-review";

/** Exact live reviews retired with the removed typed Git broker implementation. */
export const SUPERSEDED_TRUSTED_DEVELOPMENT_ENVIRONMENT_SOURCE_ALARM_LOCATORS = new Set<string>([
  "packages/sandbox/src/git-broker/broker.ts#filesystem_write:c67c5d78f38057e2:1",
  "packages/sandbox/src/git-broker/execute.ts#subprocess_processor:fe63969364ea488f:1",
  "packages/sandbox/src/git-broker/materialize.ts#filesystem_write:e5ddec14e21c9401:1",
  "packages/sandbox/src/git-broker/materialize.ts#filesystem_write:efb264fb439a29ee:1",
  "packages/sandbox/src/git-broker/transaction.ts#filesystem_write:07ca069052dd0489:1",
  "packages/sandbox/src/git-broker/transaction.ts#filesystem_write:1c186b5ae38d53d3:1",
  "packages/sandbox/src/git-broker/transaction.ts#filesystem_write:7667758033ff7db9:1",
  "packages/sandbox/src/git-broker/transaction.ts#filesystem_write:c0ea800dba5eea9a:1",
  "packages/sandbox/src/git-broker/transaction.ts#filesystem_write:efb264fb439a29ee:1",
  "packages/sandbox/src/git-broker/transaction.ts#filesystem_write:f5b3e78e4da512ee:1",
  "packages/sandbox/src/git-broker/transaction.ts#temporary_storage:78cf4a3c2a2b6625:1",
]);

export const REVIEWED_TRUSTED_DEVELOPMENT_ENVIRONMENT_SOURCE_ALARMS: readonly SourceAlarmReview[] = [{
  locator: "apps/desktop/electron/augment-path.ts#temporary_storage:53225b227e9c43b5:1",
  owner: "apps/desktop",
  closure: "reviewed_exclusion",
  exclusionId: "exclusion.trusted-development-environment.login-shell-environment-memory",
  reason: "This exact process-local cache retains the bounded native login-shell environment for locally launched processes. This capture performs no persistence, network serialization, or logging; values are passed only in the owned child process environment rather than argv or diagnostics.",
}];
