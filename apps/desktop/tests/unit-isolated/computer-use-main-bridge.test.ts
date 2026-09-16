import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ComputerUseOwnedWorkEntry } from "../../electron/relay";

mock.module("electron", () => ({
  app: { getPath: () => "/tmp/nautilo-computer-use-test" },
}));

const { cancelComputerUseOwnedWork } = await import("../../electron/relay");
const mainSource = readFileSync(join(import.meta.dir, "../../electron/main.ts"), "utf8");
const preloadSource = readFileSync(join(import.meta.dir, "../../electron/preload.ts"), "utf8");

function work(epoch: string, generation: number, abort: () => void): ComputerUseOwnedWorkEntry {
  return { installationEpoch: epoch, grantGeneration: generation, abort };
}

describe("D516 main-process Computer use revocation fencing", () => {
  test("status stays side-effect free while startup and manual recovery share the managed Host route", () => {
    const statusStart = mainSource.indexOf('ipcMain.handle("computerUse:status"');
    const checkStart = mainSource.indexOf('ipcMain.handle("computerUse:check"');
    const enableStart = mainSource.indexOf('ipcMain.handle("computerUse:enable"');
    expect(statusStart).toBeGreaterThan(-1);
    expect(checkStart).toBeGreaterThan(statusStart);
    const statusHandler = mainSource.slice(statusStart, checkStart);
    const checkHandler = mainSource.slice(checkStart, enableStart);
    expect(statusHandler).toContain('return await computerUseStatus("computer use status reconciliation")');
    expect(mainSource).toContain("const status = await setup.localStatus();\n  void refreshComputerUseRelay(reason);");
    expect(statusHandler).not.toContain("managedComputerUseHostRuntime.bootstrap()");
    expect(mainSource).toContain("recordComputerUseHostState(await managedComputerUseHostRuntime.bootstrap());");
    expect(mainSource).toContain("const computerUseHostBroker = new ComputerUseHostBroker(");
    expect(mainSource).not.toContain("supportedActions:");
    expect(mainSource).not.toContain("CuaComputerUseAdapter");
    expect(mainSource).toContain("void startComputerUseReadiness();");
    expect(checkHandler).toContain("const cuaCheck = checkCuaAgainstCurrentHostPermissions();");
    expect(mainSource).toContain("async function checkCuaAgainstCurrentHostPermissions");
    expect(mainSource).toContain("await reconcileCuaHostPermissionSignature(before);");
    expect(mainSource).toContain("if (after !== before)");
    expect(mainSource).toContain("await reconcileCuaHostPermissionSignature(after);");
    expect(checkHandler.indexOf("clearCuaRouteState({ clearRouteAttestation: true });"))
      .toBeLessThan(checkHandler.indexOf("const cuaCheck = checkCuaAgainstCurrentHostPermissions();"));
    expect(checkHandler.indexOf("const cuaCheck = checkCuaAgainstCurrentHostPermissions();"))
      .toBeLessThan(checkHandler.indexOf("let checked = await setup.check();"));
    expect(checkHandler.indexOf("await cuaCheck;"))
      .toBeLessThan(checkHandler.indexOf("const projection = await refreshComputerUseProviderProjection();"));
    expect(checkHandler.indexOf("const projection = await refreshComputerUseProviderProjection();"))
      .toBeLessThan(checkHandler.indexOf("void refreshComputerUseRelay"));
    expect(mainSource).toContain('return { ready: true, reason: null, lifecycle: "healthy" };');
    expect(mainSource).toContain('return { ready: false, reason: "not_checked", lifecycle: "installed" };');
    expect(checkHandler).toContain("let checked = await setup.check();");
    expect(checkHandler).toContain('if (checked.state === "enabled" && projection.effectiveProvider === null)');
    expect(checkHandler).toContain('void refreshComputerUseRelay(before.state === "enabled" && checked.state !== "enabled"');
    expect(checkHandler).toContain("return await computerUseStatusFromLocal(checked);");
  });

  test("managed Host provenance and retained-update failure are content-safe and explicit", () => {
    expect(mainSource).toContain("function recordComputerUseHostState(state: ComputerUseHostState)");
    expect(mainSource).toContain("source=${state.source}");
    expect(mainSource).toContain("release=${state.release.releaseId}");
    expect(mainSource).toContain("version=${state.release.version}");
    expect(mainSource).toContain("archiveSha256=${state.release.archive.sha256}");
    expect(mainSource).toContain("entrypointSha256=${entrypoint?.sha256 ?? \"missing\"}");
    expect(mainSource).toContain("generation=${state.generation}");
    expect(mainSource).toContain("retained:${state.remoteUpdateFailure}");
    expect(mainSource).not.toContain("[desktop][computer-use-host] path=");
  });

  test("a Logto sign-in after bootstrap rebinds a stale relay actor before the Connections retry", () => {
    const relayBootStart = mainSource.indexOf("async function bootRelayIfPossible");
    const relayBootEnd = mainSource.indexOf("async function startRelayForSession", relayBootStart);
    expect(relayBootStart).toBeGreaterThan(-1);
    expect(relayBootEnd).toBeGreaterThan(relayBootStart);
    const relayBoot = mainSource.slice(relayBootStart, relayBootEnd);

    const resolveActor = relayBoot.indexOf("const expectedHumanUserId = await resolveRelayUserId(serverUrl);");
    const connectedGuard = relayBoot.indexOf('getRelayStatus() === "connected"');
    const rebind = relayBoot.indexOf("await startRelayForSession(bootSessionForRelay(serverUrl));");
    const wakeConnections = relayBoot.indexOf("notifyComputerUseStatusChanged();");
    expect(resolveActor).toBeGreaterThan(-1);
    expect(connectedGuard).toBeGreaterThan(resolveActor);
    expect(relayBoot).toContain("activeRuntime?.humanUserId === expectedHumanUserId");
    expect(rebind).toBeGreaterThan(connectedGuard);
    expect(wakeConnections).toBeGreaterThan(rebind);

    const signInStart = mainSource.indexOf("async function handleSignIn(");
    const signInEnd = mainSource.indexOf("/**\n * M101", signInStart);
    expect(signInStart).toBeGreaterThan(-1);
    expect(mainSource.slice(signInStart, signInEnd)).toContain("void bootRelayIfPossible(serverUrl);");
  });

  test("a reconnect refreshes and wakes an already-mounted Connections card even when local status fails", () => {
    const relayStart = mainSource.indexOf("async function startRelayForSession");
    const reconcileStart = mainSource.indexOf("async function reconcileComputerUseTopology");
    const reconcileEnd = mainSource.indexOf("// D418", reconcileStart);
    expect(mainSource.slice(relayStart, reconcileStart)).toContain(
      "onComputerUseTopologyChange: (refreshRelayCapabilities) =>\n      reconcileComputerUseTopology(refreshRelayCapabilities),",
    );
    expect(reconcileStart).toBeGreaterThan(-1);
    expect(reconcileEnd).toBeGreaterThan(reconcileStart);
    const reconciliation = mainSource.slice(reconcileStart, reconcileEnd);
    const reload = reconciliation.indexOf("await computerUseSetup?.status();");
    const statusFailure = reconciliation.indexOf("} catch {", reload);
    const advertise = reconciliation.indexOf(
      'await refreshRelayCapabilities("computer use topology reconciliation");',
    );
    const wake = reconciliation.indexOf("notifyComputerUseStatusChanged();");
    expect(reload).toBeGreaterThan(-1);
    expect(statusFailure).toBeGreaterThan(reload);
    expect(advertise).toBeGreaterThan(statusFailure);
    expect(wake).toBeGreaterThan(advertise);
    expect(reconciliation).toContain(
      "refreshRelayCapabilities: (reason?: string) => Promise<boolean>",
    );
    expect(reconciliation).not.toContain("refreshComputerUseRelay(");
  });

  test("keeps Host authority private and clears it before capability refresh", () => {
    expect(mainSource).toContain("const computerUseHostBroker = new ComputerUseHostBroker(");
    expect(mainSource).toContain("computerUseProviderRouteAttestation = new ComputerUseHostRouteAttestation(");
    expect(mainSource).toContain("await computerUseHostBroker.dispatch({");
    expect(mainSource).toContain("authorityLeaseId: invocation.binding.computerUseContextId");
    expect(mainSource).toContain("authorityGeneration: invocation.binding.grantGeneration");
    expect(mainSource).toContain("contract: invocation.computerUseRequest.contract");
    expect(mainSource).not.toContain("supportedActions:");
    expect(preloadSource).toContain('ipcRenderer.on("computerUse:statusChanged", listener)');
    expect(preloadSource).toContain('ipcRenderer.removeListener("computerUse:statusChanged", listener)');
    const clearStart = mainSource.indexOf("function clearCuaRouteState(");
    const clearEnd = mainSource.indexOf("async function currentCuaProviderAvailability", clearStart);
    const clearRoute = mainSource.slice(clearStart, clearEnd);
    expect(clearRoute).toContain("void computerUseHostBroker.close();");
    expect(clearRoute.indexOf("computerUseProviderRouteAttestation?.clear()"))
      .toBeGreaterThan(clearRoute.indexOf("void computerUseHostBroker.close();"));
  });

  test("quit awaits the app-owned Computer Use Host", () => {
    const beforeQuit = mainSource.slice(mainSource.indexOf('app.on("before-quit"'));
    expect(beforeQuit).toContain("await computerUseHostBroker.close();");
  });

  test("both in-process post-commit handoffs stop the old relay before revoking its Computer use store", () => {
    const liveStart = mainSource.indexOf("const desktopConnectionFlow = new DesktopConnectionFlow");
    const liveEnd = mainSource.indexOf("function coldBootTerminalRuntime", liveStart);
    expect(liveStart).toBeGreaterThan(-1);
    expect(liveEnd).toBeGreaterThan(liveStart);
    const livePromotion = mainSource.slice(liveStart, liveEnd);
    const liveHookStart = livePromotion.indexOf("stopOldRelay: async () => {");
    const liveHookEnd = livePromotion.indexOf("deactivateOldProfile:", liveHookStart);
    expect(liveHookStart).toBeGreaterThan(-1);
    expect(liveHookEnd).toBeGreaterThan(liveHookStart);
    const liveOldRelayCheckpoint = livePromotion.slice(liveHookStart, liveHookEnd);
    expect(liveOldRelayCheckpoint.indexOf("await stopRelay();"))
      .toBeLessThan(liveOldRelayCheckpoint.indexOf("await configureComputerUseForServer(null);"));

    const recoveryStart = mainSource.indexOf("function coldBootTerminalRuntime");
    const recoveryEnd = mainSource.indexOf(
      "function prepareProductionCommittedColdBootTerminal",
      recoveryStart,
    );
    expect(recoveryStart).toBeGreaterThan(-1);
    expect(recoveryEnd).toBeGreaterThan(recoveryStart);
    const coldBootRecovery = mainSource.slice(recoveryStart, recoveryEnd);
    const recoveryHookStart = coldBootRecovery.indexOf("stopOldRelay: async () => {");
    const recoveryHookEnd = coldBootRecovery.indexOf("deactivateOldProfile:", recoveryHookStart);
    expect(recoveryHookStart).toBeGreaterThan(-1);
    expect(recoveryHookEnd).toBeGreaterThan(recoveryHookStart);
    const recoveryOldRelayCheckpoint = coldBootRecovery.slice(recoveryHookStart, recoveryHookEnd);
    expect(recoveryOldRelayCheckpoint.indexOf("await stopRelay();"))
      .toBeLessThan(recoveryOldRelayCheckpoint.indexOf("await configureComputerUseForServer(null);"));
  });

  test("PIN-free Off returns from local authority before best-effort relay re-advertisement", () => {
    const disableStart = mainSource.indexOf('ipcMain.handle("computerUse:disable"');
    const nextHandlerStart = mainSource.indexOf('ipcMain.handle("', disableStart + 1);
    expect(disableStart).toBeGreaterThan(-1);
    expect(nextHandlerStart).toBeGreaterThan(disableStart);
    const disableHandler = mainSource.slice(disableStart, nextHandlerStart);
    expect(disableHandler).toContain("const revoked = await setup.disable();");
    expect(disableHandler).toContain('void refreshComputerUseRelay("computer use disabled");');
    expect(disableHandler).toContain("return await computerUseStatusFromLocal(revoked);");
  });

  test("exact-grant revoke cancels only work covered by that epoch/generation", () => {
    const oldAbort = mock(() => undefined);
    const futureAbort = mock(() => undefined);
    const foreignAbort = mock(() => undefined);
    const registry = new Map([
      ["old", work("epoch-1", 3, oldAbort)],
      ["future", work("epoch-1", 5, futureAbort)],
      ["foreign", work("epoch-2", 1, foreignAbort)],
    ]);
    cancelComputerUseOwnedWork(registry, {
      kind: "exact_grant", installationEpoch: "epoch-1", grantGeneration: 4,
    });
    expect(oldAbort).toHaveBeenCalledTimes(1);
    expect(futureAbort).not.toHaveBeenCalled();
    expect(foreignAbort).not.toHaveBeenCalled();
    expect([...registry.keys()].sort()).toEqual(["foreign", "future"]);
  });

  test("installation-epoch recovery cancels all owned work because the old epoch is unknowable", () => {
    const firstAbort = mock(() => undefined);
    const secondAbort = mock(() => undefined);
    const registry = new Map([
      ["first", work("unknown-old-epoch", 9, firstAbort)],
      ["second", work("another-epoch", 2, secondAbort)],
    ]);
    cancelComputerUseOwnedWork(registry, {
      kind: "installation_epoch_reset", installationEpoch: "fresh-epoch", grantGeneration: 0,
    });
    expect(firstAbort).toHaveBeenCalledTimes(1);
    expect(secondAbort).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);
  });
});
