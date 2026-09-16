import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const desktopRoot = join(import.meta.dir, "../..");
const main = readFileSync(join(desktopRoot, "electron/main.ts"), "utf8");
const preload = readFileSync(join(desktopRoot, "electron/preload.ts"), "utf8");
const workbenchTypes = readFileSync(join(desktopRoot, "../workbench/src/lib/desktop.ts"), "utf8");
const coordinator = readFileSync(join(desktopRoot, "electron/ready-to-work-coordinator.ts"), "utf8");

describe("D557 Desktop Ready bridge", () => {
  test("Hermes owner intent is sender-gated, durable, and removes routing before refresh", () => {
    expect(preload).toContain('ipcRenderer.invoke("hermesConnection:status")');
    expect(workbenchTypes).toContain("interface DesktopHermesConnectionAPI");
    const disableStart = main.indexOf('ipcMain.handle("hermesConnection:disable"');
    const disableEnd = main.indexOf('type ReadyOwnerResult', disableStart);
    const disable = main.slice(disableStart, disableEnd);
    expect(disable.indexOf("resolveSessionFromSender(e)")).toBeGreaterThanOrEqual(0);
    expect(disable.indexOf("saveHermesConnectionIntent(session.serverUrl, false)"))
      .toBeLessThan(disable.indexOf('acpExecutionRouter.reconcileRegistration("hermes-acp")'));
    expect(disable.indexOf('acpExecutionRouter.reconcileRegistration("hermes-acp")'))
      .toBeLessThan(disable.indexOf('refreshDesktopRelayCapabilities("Hermes connection disabled")'));
  });

  test("verified source health completes the exact live authority used by enroll and restore", () => {
    const sourceStart = main.indexOf("let sourceDevelopmentAuthority:");
    const sourceEnd = main.indexOf("const desktopConnectionTupleBinding", sourceStart);
    const source = main.slice(sourceStart, sourceEnd);
    expect(source).toContain("function promoteSourceDevelopmentAuthorityFingerprint(");
    expect(source).toContain("scope = new URL(serverUrl).origin");
    expect(source).toContain("if (sourceDevelopmentAuthority.scope !== scope) return");
    expect(source).toContain("serverFingerprint,");
    const healthStart = main.indexOf("function applyVerifiedLogtoHealthBody(");
    const healthEnd = main.indexOf("const AUTH_DIAGNOSTIC_PROBE_TIMEOUT_MS", healthStart);
    expect(main.slice(healthStart, healthEnd)).toContain(
      "promoteSourceDevelopmentAuthorityFingerprint(serverUrl, observedFingerprint)",
    );
    const resolveStart = main.indexOf("async function resolveReadyToWorkBindingForSession(");
    const resolveEnd = main.indexOf("async function resolveReadyToWorkBinding(", resolveStart);
    const resolve = main.slice(resolveStart, resolveEnd);
    expect(resolve).toContain("const authority = authoritativeConnectionSnapshot()");
    expect(resolve).not.toContain("projectActiveAuthority(config)");
    const revalidateStart = main.indexOf("async function readyToWorkActiveBindingMatches(");
    const revalidateEnd = main.indexOf("async function reconcileReadyToWorkNow(", revalidateStart);
    expect(main.slice(revalidateStart, revalidateEnd)).toContain(
      "const refreshedAuthority = authoritativeConnectionSnapshot()",
    );
  });

  test("packaged verified boot completes the exact legacy authority before Workbench release", () => {
    const projectionStart = main.indexOf("function applyVerifiedLogtoHealthBody(");
    const projectionEnd = main.indexOf("function logtoConfig", projectionStart);
    const projection = main.slice(projectionStart, projectionEnd);
    const applyAtBoot = main.indexOf("const logtoResolved = applyVerifiedLogtoHealthBody(");
    const release = main.indexOf("if (!releaseVerifiedWorkbenchNavigation(serverUrl)) return;");

    expect(projection).toContain("app.isPackaged && observedFingerprint && !sourceDevelopmentAuthority");
    expect(projection).toContain('activeAuthority.connectionAttemptId.startsWith("legacy-")');
    expect(projection).toContain("activeAuthority.scope === observedOrigin");
    expect(projection).toContain("configForVerifiedLegacyConnection(currentConfig");
    expect(projection).toContain("serverFingerprint: observedFingerprint");
    expect(applyAtBoot).toBeGreaterThanOrEqual(0);
    expect(release).toBeGreaterThan(applyAtBoot);
  });

  test("enrollment accepts one transient PIN while receipt storage stays main-only", () => {
    expect(main).toContain('ipcMain.handle("readyToWork:enroll"');
    expect(main).toContain('Object.keys(request).sort().join(",") === "pin,selection"');
    expect(main).toContain("readyToWorkProtectedReceiptStore().save(");
    expect(preload).toContain("enroll: (input: { selection: ReadyToWorkSelection; pin: string })");
    expect(preload).not.toContain("startupReceipt");
    expect(workbenchTypes).not.toContain("startupReceipt");
  });

  test("enrollment reuses the canonical Computer Use PIN ceremony without another owner", () => {
    const helperStart = main.indexOf("async function enableReadyComputerUseDuringEnrollment(");
    const helperEnd = main.indexOf("async function disableReadyComputerUseOwner()", helperStart);
    const helper = main.slice(helperStart, helperEnd);
    expect(helperStart).toBeGreaterThan(-1);
    expect(helper).toContain("awaitReadyToWorkValueBounded(setup.status(), 5_000, null)");
    expect(helper).toContain("fetchCurrentComputerUseOwnedAgents(accessToken, expectedHumanUserId)");
    expect(helper).toContain("const enabled = await setup.enable(pin, agentId)");
    expect(helper).toContain("const retained = await commitReadyComputerUseEnable({");
    expect(helper).toContain("disable: async () => { await setup.disable(); }");
    expect(helper).not.toContain("ComputerUseLocalStore");
    expect(helper).not.toContain("store.mint");

    const enrollStart = main.indexOf('ipcMain.handle("readyToWork:enroll"');
    const enrollEnd = main.indexOf('ipcMain.handle("readyToWork:restore"', enrollStart);
    const enroll = main.slice(enrollStart, enrollEnd);
    expect(enroll).toContain("activatedComputerUse = await enableReadyComputerUseDuringEnrollment(");
    expect(enroll).toContain("pin,");
    expect(enroll).toContain("binding.humanId,");
    const revalidate = enroll.indexOf("readyToWorkActiveBindingMatches(binding)");
    expect(enroll.indexOf("enableReadyComputerUseDuringEnrollment(")).toBeLessThan(revalidate);
    expect(enroll.indexOf("disableReadyComputerUseOwner()", revalidate)).toBeGreaterThan(revalidate);
    expect(enroll).toContain(
      "if (activatedComputerUse) await disableReadyComputerUseOwner().catch(() => undefined)",
    );
  });

  test("sender-gates owner acknowledgements and exposes only desired booleans", () => {
    const start = main.indexOf('ipcMain.handle("readyToWork:ackRendererOwners"');
    expect(start).toBeGreaterThan(-1);
    const slice = main.slice(start, start + 1_200);
    expect(slice).toContain("assertMainWindowSender(e)");
    expect(slice).toContain('"attemptId,autoApprove,voice"');
    expect(slice).not.toContain("receipt");
    expect(slice).not.toContain("pin");
    expect(preload).toContain("onRestoreRendererOwners:");
    expect(preload).toContain("acknowledgeRendererOwners:");
  });

  test("reconciles after relay readiness once and keeps explicit restore as retry", () => {
    expect(main).toContain("void reconcileReadyForServerSession(session)");
    expect(main).toContain('trigger: "startup" | "relay_reconnect" | "explicit_restore"');
    expect(main).not.toContain('"owner_changed"');
    expect(main).toContain('reconcileReadyForServerSession(active, "relay_reconnect")');
    expect(main).toContain('reconcileReadyToWorkNow(binding, "explicit_restore", generation)');
    expect(coordinator).toContain("if (input.trigger === \"startup\" && this.startupAttemptKey === key)");
    expect(main).toContain("const authenticated = await resolveReadyToWorkBindingForSession(activeSession)");
    expect(main).toContain("const persisted = readyToWorkStore().loadFor(binding)");
    expect(main).toContain("persisted.components.workstation !== desired.components.workstation");
    expect(main).toContain("if (serverSessions.active !== activeSession) return false");
    expect(main).toContain("const refreshedAuthority = authoritativeConnectionSnapshot()");
    expect(main).toContain("return hasReadyToWorkSameBinding(binding, current)");
    expect(main).toContain("readyToWorkOperationQueue.run(async () =>");
  });

  test("PIN-free Off clears both stores and invokes owner disable paths", () => {
    const start = main.indexOf('ipcMain.handle("readyToWork:disable"');
    const slice = main.slice(start, start + 2_400);
    expect(slice).toContain("readyToWorkCoordinator.disable(desired)");
    expect(slice).toContain("readyToWorkProtectedReceiptStore().clear()");
    expect(slice).toContain("readyToWorkStore().clear()");
    expect(slice).toContain("resolveSessionFromSender(e)");
    expect(slice).not.toContain("resolveReadyToWorkBinding(e)");
    expect(slice).not.toContain("pin");
    const clearIntent = slice.indexOf("readyToWorkStore().clear()");
    const clearReceipt = slice.indexOf("readyToWorkProtectedReceiptStore().clear()");
    const disableOwners = slice.indexOf("readyToWorkCoordinator.disable(desired)");
    expect(clearIntent).toBeGreaterThan(-1);
    expect(clearReceipt).toBeGreaterThan(clearIntent);
    const clearBinding = slice.indexOf("readyToWorkCoordinatorBinding = null");
    expect(clearBinding).toBeGreaterThan(clearReceipt);
    expect(disableOwners).toBeGreaterThan(clearReceipt);
    expect(disableOwners).toBeGreaterThan(clearBinding);
    expect(slice.indexOf("readyToWorkGeneration += 1")).toBeGreaterThan(clearBinding);
    expect(slice.indexOf("publishReadyToWorkStatus(status)")).toBeLessThan(disableOwners);
    expect(slice).toContain("readyToWorkCleanupPromise = awaitReadyToWorkBounded(");
    expect(slice).toContain("Durable intent is already disarmed");
  });

  test("uses null for omitted renderer owners so enrollment does not change them", () => {
    expect(coordinator).toContain("voice: input.desired.components.voice ? true : null");
    expect(coordinator).toContain("autoApprove: input.desired.components.auto_approve ? true : null");
    expect(main).toContain("voice: selection.voice ? false : null");
    expect(main).toContain("autoApprove: selection.auto_approve ? false : null");
  });

  test("acknowledges selected renderer shutdown without rewriting harness owner choices", () => {
    expect(main).toContain("disableRendererOwners: async (selection) =>");
    expect(main).toContain("await requestReadyRendererOwners({");
    expect(main).toContain("loadConfig()?.codexConnectionEnabled !== true");
    expect(main).toContain("disableCodingConnection: () => Promise.resolve()");
    const restoreStart = main.indexOf("restoreCodingConnection: async");
    const restoreEnd = main.indexOf("disableRendererOwners: async", restoreStart);
    const restore = main.slice(restoreStart, restoreEnd);
    expect(restore).not.toContain("saveCodexConnectionIntent");
  });

  test("revalidates enrollment before persistence and narrows before owner cleanup", () => {
    const start = main.indexOf('ipcMain.handle("readyToWork:enroll"');
    const end = main.indexOf('ipcMain.handle("readyToWork:restore"', start);
    const slice = main.slice(start, end);
    const revalidate = slice.indexOf("readyToWorkActiveBindingMatches(binding)");
    const save = slice.indexOf("readyToWorkStore().save(desired)");
    const removed = slice.indexOf("const removed = {");
    const disable = slice.indexOf("readyToWorkCoordinator.disable(createReadyToWorkDesiredState(binding, removed))");
    expect(revalidate).toBeGreaterThan(-1);
    expect(save).toBeGreaterThan(revalidate);
    expect(removed).toBeGreaterThan(save);
    expect(disable).toBeGreaterThan(removed);
    expect(slice).toContain("if (activatedWorkstation) await disableReadyWorkstationOwner()");
    expect(slice).toContain("canPreserveReceipt");
  });

  test("refreshes main-owned truth and accepts observational renderer reports", () => {
    expect(main).toContain("return await refreshReadyToWorkStatus(desired, generation)");
    expect(main).toContain('ipcMain.handle("readyToWork:get", async (e) => {');
    expect(main).toContain("!await readyToWorkActiveBindingMatches(binding)");
    expect(main).toContain("await awaitReadyToWorkValueBounded(setup.status(), 5_000, null)");
    expect(main).toContain('ipcMain.handle("readyToWork:reportRendererOwners"');
    expect(main).toContain("Current renderer-owned truth is observational only");
    expect(preload).toContain("reportRendererOwners:");
    expect(preload).toContain("onStatusChanged:");
    expect(workbenchTypes).toContain("reportRendererOwners:");
  });

  test("verifies a non-live stored receipt before preserving it and keeps rollback best-effort", () => {
    const start = main.indexOf("const existingReceipt = readyToWorkProtectedReceiptStore().readFor(binding)");
    const slice = main.slice(start, start + 6_000);
    expect(slice).toContain("const exactLive =");
    expect(slice).toContain("proof: { startupReceipt: existingReceipt.receipt }");
    expect(slice).toContain("canPreserveReceipt = false");
    const clear = slice.indexOf(
      "try { readyToWorkProtectedReceiptStore().clear(); } catch { /* rollback continues */ }",
    );
    expect(clear).toBeGreaterThan(-1);
    expect(slice.indexOf("if (activatedWorkstation) await disableReadyWorkstationOwner()", clear))
      .toBeGreaterThan(clear);
  });

  test("fences the local Workstation profile before bounded remote cleanup", () => {
    const start = main.indexOf("async function disableReadyWorkstationOwner()");
    const slice = main.slice(start, start + 1_800);
    const deactivate = slice.indexOf("activeWorkstationProfileController.deactivate()");
    const advertise = slice.indexOf("refreshDesktopRelayCapabilities(");
    const token = slice.indexOf("getValidAccessToken({");
    expect(deactivate).toBeGreaterThan(-1);
    expect(advertise).toBeGreaterThan(deactivate);
    expect(token).toBeGreaterThan(advertise);
    expect(slice).toContain("awaitReadyToWorkBounded(");
    expect(main).toContain("signal: AbortSignal.timeout(1_500)");
  });

  test("generation-cancels old work before persistence or Ready publication", () => {
    expect(main).toContain("let readyToWorkGeneration = 0");
    expect(main).toContain("generation !== readyToWorkGeneration");
    expect(main).toContain("if (generation === readyToWorkGeneration) publishReadyToWorkStatus(status)");
    expect(main).toContain("await readyToWorkCleanupPromise");
    expect(coordinator).toContain("reset(): ReadyToWorkAggregateStatus");
  });

  test("hard-bounds Ready authentication, status, and two-phase activation network", () => {
    expect(main).toContain("awaitReadyToWorkValueBounded(");
    expect(main).toContain("signal: AbortSignal.timeout(5_000)");
    expect(main).toContain("networkTimeoutMs: 5_000");
    expect(main).toContain("timeoutMs: args.networkTimeoutMs");
    expect(coordinator).toContain("readyToWorkBoundedValue<T>");
  });
});
