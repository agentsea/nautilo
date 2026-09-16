import { describe, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";

import {
  fetchCdpTargets,
  NAUTILO_DESKTOP_SURFACE,
  NAUTILO_FIRST_RUN_SURFACE,
  surfaceContractMismatch,
} from "../../scripts/smoke-packaged";

describe("packaged Desktop preload smoke contract", () => {
  test("includes recently added privileged bridges", () => {
    expect(NAUTILO_DESKTOP_SURFACE).toContain("miniAppRecovery");
    expect(NAUTILO_DESKTOP_SURFACE).toContain("binaryRead");
    expect(NAUTILO_DESKTOP_SURFACE).toContain("mediaProxy");
    expect(NAUTILO_DESKTOP_SURFACE).toContain("mediaExport");
    expect(NAUTILO_DESKTOP_SURFACE).toContain("codexConnection");
    expect(NAUTILO_DESKTOP_SURFACE).toContain("hermesConnection");
    expect(NAUTILO_DESKTOP_SURFACE).toContain("readyToWork");
    expect(NAUTILO_DESKTOP_SURFACE).toContain("structuredSsh");
    expect(NAUTILO_DESKTOP_SURFACE).toContain("computerUse");
    expect(NAUTILO_DESKTOP_SURFACE).toContain("systemPermissions");
    expect(NAUTILO_DESKTOP_SURFACE).toContain("remoteControl");
    expect(NAUTILO_DESKTOP_SURFACE).toContain("ordinaryChat");
    expect(NAUTILO_DESKTOP_SURFACE).toContain("foregroundShadow");
    expect(NAUTILO_DESKTOP_SURFACE).toContain("encryptionRecovery");
    expect(NAUTILO_DESKTOP_SURFACE).toContain("browserResearch");
    expect(NAUTILO_DESKTOP_SURFACE).toContain("uncontainedHostCommands");
  });

  test("pins the exact first-run picker bridge", () => {
    expect(NAUTILO_FIRST_RUN_SURFACE).toEqual([
      "getConnectTargets", "commit", "confirmDowngrade", "acceptIdentity",
      "abortAttempt", "onConnectionPresentation", "cancel",
    ]);
  });

  test("fails closed for missing and undocumented top-level keys", () => {
    expect(
      surfaceContractMismatch(
        ["isDesktop", "binaryRead", "unexpected"],
        ["isDesktop", "binaryRead", "fs"],
      ),
    ).toEqual({
      undocumented: ["unexpected"],
      missing: ["fs"],
    });
  });

  test("a stalled CDP discovery request cannot defeat the smoke deadline", async () => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected TCP test listener address");
    }
    const startedAt = Date.now();
    try {
      let failure: unknown = null;
      try {
        await fetchCdpTargets(address.port, 50);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
