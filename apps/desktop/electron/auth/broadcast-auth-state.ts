import { warn } from "@nautilo/logger";

export type AuthStatePayload = "signed-in" | "signed-out";

export interface BroadcastAuthStateDeps {
  getAllWindows: () => Iterable<{
    readonly id: number;
    isDestroyed(): boolean;
    webContents: { send(channel: string, ...args: unknown[]): void };
  }>;
}

/**
 * Post `auth:state-change` to every live BrowserWindow. Injected
 * `getAllWindows` keeps the logic unit-testable without Electron.
 */
export function broadcastAuthState(
  deps: BroadcastAuthStateDeps,
  state: AuthStatePayload,
): void {
  for (const w of deps.getAllWindows()) {
    if (!w.isDestroyed()) {
      try {
        w.webContents.send("auth:state-change", { state });
      } catch (err) {
        warn(
          `[auth] broadcastAuthState failed for window ${w.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
}
