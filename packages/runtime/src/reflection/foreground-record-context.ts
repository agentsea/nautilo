import type { ForegroundRecordContextPort } from "@nautilo/reflection/foreground";

export type ForegroundRecordContextPortForRoom = (
  roomId: string,
) => ForegroundRecordContextPort | undefined;

let installedFactory: ForegroundRecordContextPortForRoom | undefined;

/** Install the one server-owned initial Record-context composition. */
export function installForegroundRecordContextPortFactory(
  factory: ForegroundRecordContextPortForRoom,
): void {
  if (installedFactory !== undefined && installedFactory !== factory) {
    throw new Error("foreground_record_context_factory_already_installed");
  }
  installedFactory = factory;
}

export function uninstallForegroundRecordContextPortFactory(): void {
  installedFactory = undefined;
}

/** Foreground main/fork executors only; background paths never consult it. */
export function foregroundRecordContextPortForRoom(
  roomId: string,
): ForegroundRecordContextPort | undefined {
  return installedFactory?.(roomId);
}

export function hasForegroundRecordContextPortFactory(): boolean {
  return installedFactory !== undefined;
}
