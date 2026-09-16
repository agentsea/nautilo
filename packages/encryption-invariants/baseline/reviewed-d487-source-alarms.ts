import type { SourceAlarmReview } from "../src/node/source-alarm-review";

export const SUPERSEDED_D487_SOURCE_ALARM_LOCATORS = new Set<string>([
  "apps/desktop/electron/main.ts#network_processor:dde76a4b5d6b7d64:7",
  "apps/desktop/electron/main.ts#network_processor:281b5d976945ea38:1",
  "apps/desktop/electron/main.ts#network_processor:281b5d976945ea38:2",
  "apps/workbench/src/pages/settings/sections/profile-section.tsx#network_processor:ef993855494c1601:3",
  "packages/agent/src/tools/config/manage-avatar.ts#filesystem_write:f93d4a3efdea11d2:1",
  "packages/server/src/routes/_helpers/avatar.ts#filesystem_write:06362db978430045:1",
  "packages/server/src/routes/_helpers/avatar.ts#filesystem_write:d9381c42d36446da:1",
  "packages/server/src/routes/profile.ts#filesystem_write:fb6904ff027915ff:1",
  "packages/server/src/routes/profile.ts#filesystem_write:fb6904ff027915ff:2",
]);

const LOG_LOCATORS = [
  "packages/server/scripts/backfill-owned-photo-library.ts#log_emitter:468c68ed4723a1f2:1",
  "packages/server/scripts/backfill-owned-photo-library.ts#log_emitter:468c68ed4723a1f2:2",
  "packages/server/scripts/backfill-owned-photo-library.ts#log_emitter:8e87459ebb753985:1",
  "packages/server/scripts/gc-owned-photo-library.ts#log_emitter:468c68ed4723a1f2:1",
  "packages/server/scripts/gc-owned-photo-library.ts#log_emitter:468c68ed4723a1f2:2",
  "packages/server/scripts/gc-owned-photo-library.ts#log_emitter:8e87459ebb753985:1",
  "packages/server/scripts/recover-owned-photo-library.ts#log_emitter:468c68ed4723a1f2:1",
  "packages/server/scripts/recover-owned-photo-library.ts#log_emitter:468c68ed4723a1f2:2",
  "packages/server/scripts/recover-owned-photo-library.ts#log_emitter:bdc6a67d4071d67d:1",
  "packages/server/src/routes/profile.ts#log_emitter:26f18bcb8c9682d6:1",
  "packages/server/src/routes/profile.ts#log_emitter:26f18bcb8c9682d6:2",
  "packages/server/src/routes/profile.ts#log_emitter:26f18bcb8c9682d6:3",
  "packages/server/src/routes/profile.ts#log_emitter:26f18bcb8c9682d6:4",
  "packages/server/src/routes/profile.ts#log_emitter:57bff0db6fb2985e:1",
  "packages/server/src/routes/profile.ts#log_emitter:57bff0db6fb2985e:2",
  "packages/server/src/routes/profile.ts#log_emitter:57bff0db6fb2985e:3",
  "packages/server/src/routes/profile.ts#log_emitter:b42bef868da1b34b:1",
  "packages/server/src/routes/profile.ts#log_emitter:b42bef868da1b34b:2",
  "packages/server/src/routes/profile.ts#log_emitter:b42bef868da1b34b:3",
] as const;

const AVATAR_FILE_LOCATORS = [
  "packages/server/src/photo-library/legacy-current-reference-backfill.ts#filesystem_write:3e1d91ccc297150d:1",
  "packages/server/src/photo-library/owned-avatar-staging.ts#filesystem_write:0ab5b179230d1f88:1",
  "packages/server/src/photo-library/owned-avatar-staging.ts#filesystem_write:4bc031be8d6ad2b1:1",
] as const;

function owner(locator: string): string {
  return locator.split("#", 1)[0]!.split("/").slice(0, 2).join("/");
}

export const REVIEWED_D487_SOURCE_ALARMS: readonly SourceAlarmReview[] = [
  {
    locator: "apps/desktop/electron/main.ts#network_processor:05751ea08e74971f:1",
    owner: "apps/desktop",
    closure: "declaration",
    declarationId: "source.d487.onboarding-setup-flags",
    reason:
      "This exact onboarding callsite reads only the already inventoried GET /api/config/setup-flags response containing the two boolean feature flags; the retired avatar status request and its second network alarm were removed.",
  },
  ...LOG_LOCATORS.map((locator, index) => ({
    locator,
    owner: owner(locator),
    closure: "declaration" as const,
    declarationId: `source.d487.generic-log-${index + 1}`,
    reason:
      "This exact callsite uses Nautilo's already inventoried generic log boundary for fixed operator guidance, bounded maintenance-command outcomes/counts/identifiers, or the existing profile-route diagnostic policy; it does not create a second persistence surface.",
  })),
  ...AVATAR_FILE_LOCATORS.map((locator, index) => ({
    locator,
    owner: owner(locator),
    closure: "declaration" as const,
    declarationId: `source.d487.profile-avatar-file-${index + 1}`,
    reason:
      "This exact callsite writes or atomically links bytes inside the already inventoried owner-scoped profile-avatar file boundary; staging, commit, cleanup, and backfill tests cover that single semantic surface.",
  })),
];
