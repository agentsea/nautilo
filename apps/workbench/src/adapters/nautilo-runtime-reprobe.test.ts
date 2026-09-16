import { describe, expect, mock, test } from "bun:test";
import { reprobeDesktopServerOnReconnect } from "./nautilo-runtime";

describe("reprobeDesktopServerOnReconnect", () => {
  test("reprobes Electron auth metadata when the socket becomes open", async () => {
    const reprobeServer = mock(async () => ({ ok: true, hasLogto: true }));

    await reprobeDesktopServerOnReconnect("connecting", "open", {
      auth: { reprobeServer },
    });

    expect(reprobeServer).toHaveBeenCalledTimes(1);
  });

  test("does not reprobe for initial/non-open steady-state transitions", async () => {
    const reprobeServer = mock(async () => ({ ok: true, hasLogto: true }));
    const desktop = { auth: { reprobeServer } };

    await reprobeDesktopServerOnReconnect("open", "open", desktop);
    await reprobeDesktopServerOnReconnect("closed", "connecting", desktop);

    expect(reprobeServer).not.toHaveBeenCalled();
  });

  test("is a no-op in browser builds and swallows a failed optional IPC", async () => {
    const reprobeServer = mock(async () => {
      throw new Error("main process unavailable");
    });

    await expect(reprobeDesktopServerOnReconnect("closed", "open", null)).resolves.toBeUndefined();
    await expect(
      reprobeDesktopServerOnReconnect("closed", "open", { auth: { reprobeServer } }),
    ).resolves.toBeUndefined();
    expect(reprobeServer).toHaveBeenCalledTimes(1);
  });
});
