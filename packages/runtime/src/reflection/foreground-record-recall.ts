import type { RecallRecordsPortForState } from "@nautilo/agent";

let installedFactory: RecallRecordsPortForState | undefined;

/**
 * Install the one server-owned foreground Record-recall composition.
 * Runtime only carries the already-bound Agent port into direct foreground
 * graph construction; forks, Tasks, and background graphs never consult it.
 */
export function installForegroundRecordRecallPortFactory(
  factory: RecallRecordsPortForState,
): void {
  if (installedFactory !== undefined && installedFactory !== factory) {
    throw new Error("foreground_record_recall_factory_already_installed");
  }
  installedFactory = factory;
}

export function uninstallForegroundRecordRecallPortFactory(): void {
  installedFactory = undefined;
}

/** @internal Stable graph dependency; resolves the current server binding. */
export const foregroundRecordRecallPortForState: RecallRecordsPortForState =
  (state) => installedFactory?.(state);

export function hasForegroundRecordRecallPortFactory(): boolean {
  return installedFactory !== undefined;
}
