import type { SourceAlarmReview } from "../src/node/source-alarm-review";

export const SUPERSEDED_MAIN_2026_08_17_SOURCE_ALARM_LOCATORS =
  new Set<string>([
    "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:02d6d32a757bab9d:5",
  ]);

export const REVIEWED_MAIN_2026_08_17_SOURCE_ALARMS:
  readonly SourceAlarmReview[] = [
  {
    locator:
      "apps/desktop/electron/local-file-history/storage.ts#filesystem_write:ec592f0b9a6a033d:1",
    owner: "apps/desktop",
    closure: "declaration",
    declarationId: "source.file.desktop-local-history",
    reason:
      "This exact atomic manifest write belongs to the already-declared desktop local-history store. Its manifest and payload roots remain explicit plaintext file debt; the new call site does not create a second persistence boundary.",
  },
  {
    locator:
      "packages/server/src/maintenance/portable-recovery-job.ts#filesystem_write:60425627aebfd1e2:1",
    owner: "packages/server",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.main-2026-08-17.portable-restore-list",
    reason:
      "This exact mode-0600 temporary file contains only a filtered pg_restore table-of-contents list assembled from archive metadata. It carries no restored row values, user content, credential, key, or decrypted payload and is removed with the job staging directory.",
  },
];
