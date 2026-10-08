import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const desktopRoot = join(import.meta.dir, "../..");
const main = readFileSync(join(desktopRoot, "electron/main.ts"), "utf8");
const preload = readFileSync(join(desktopRoot, "electron/preload.ts"), "utf8");
const workbenchTypes = readFileSync(join(desktopRoot, "../workbench/src/lib/desktop.ts"), "utf8");
const coordinator = readFileSync(join(desktopRoot, "electron/ready-to-work-coordinator.ts"), "utf8");

describe("Desktop Ready bridge", () => {
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
    expect(main).toContain("readyRemembered.save(");
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

    const enrollStart = main.indexOf("async function enrollReadyToWork(");
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
    expect(main).toContain('reconcileReadyToWorkNow(binding, "explicit_restore", generation, readyRemembered.loadFor(binding) !== null)');
    expect(coordinator).toContain("if (input.trigger === \"startup\" && this.startupAttemptKey === key)");
    expect(main).toContain("const authenticated = await resolveReadyToWorkBindingForSession(activeSession)");
    expect(main).toContain("const persisted = readyRemembered.loadFor(binding)");
    expect(main).toContain("persisted.components.workstation !== desired.components.workstation");
    expect(main).toContain("if (serverSessions.active !== activeSession) return false");
    expect(main).toContain("const refreshedAuthority = authoritativeConnectionSnapshot()");
    expect(main).toContain("return hasReadyToWorkSameBinding(binding, current)");
    expect(main).toContain("readyToWorkOperationQueue.run(async () =>");
  });

  test("PIN-free Off invokes persistence reduction and always reaches live shutdown paths", () => {
    const start = main.indexOf('ipcMain.handle("readyToWork:disable"');
    const slice = main.slice(start, start + 2_400);
    expect(slice).toContain("readyToWorkCoordinator.disable(desired)");
    expect(slice).toContain("readyToWorkPersistence.disable((desired, failedReduction)");
    expect(slice).toContain("resolveSessionFromSender(e)");
    expect(slice).not.toContain("resolveReadyToWorkBinding(e)");
    expect(slice).not.toContain("pin");
    const disableOwners = slice.indexOf("readyToWorkCoordinator.disable(desired)");
    const clearBinding = slice.indexOf("readyToWorkCoordinatorBinding = null");
    expect(disableOwners).toBeGreaterThan(clearBinding);
    expect(slice.indexOf("readyToWorkGeneration += 1")).toBeGreaterThan(clearBinding);
    expect(slice.indexOf("publishReadyToWorkStatus(status)")).toBeGreaterThan(disableOwners);
    expect(slice).toContain("readyToWorkCleanupPromise = awaitReadyToWorkBounded(");
    expect(slice).toContain("fenceDevelopmentLocalExecutions()");
    expect(slice).toContain("disableReadyWorkstationOwner(), disableReadyComputerUseOwner()");
    expect(slice).toContain("requestReadyRendererOwners({ voice: false, autoApprove: false })");
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
    const start = main.indexOf("async function enrollReadyToWork(");
    const end = main.indexOf('ipcMain.handle("readyToWork:restore"', start);
    const slice = main.slice(start, end);
    const revalidate = slice.indexOf("readyToWorkActiveBindingMatches(binding)");
    const save = slice.indexOf("readyRemembered.save(desired, receiptToPersist");
    const removed = slice.indexOf("const removed = {");
    const disable = slice.indexOf("readyToWorkCoordinator.disable(createReadyToWorkDesiredState(binding, removed))");
    expect(revalidate).toBeGreaterThan(-1);
    expect(save).toBeGreaterThan(revalidate);
    expect(slice.indexOf("generation !== readyToWorkGeneration", revalidate)).toBeLessThan(save);
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
    const start = main.indexOf("const existingReceipt = readyRemembered.readReceipt(binding)");
    const slice = main.slice(start, start + 6_000);
    expect(slice).toContain("const exactLive =");
    expect(slice).toContain("proof: { startupReceipt: existingReceipt.receipt }");
    expect(slice).toContain("canPreserveReceipt = false");
    const clear = slice.indexOf("readyToWorkPersistence.recordFailure(error, activatedComputerUse || activatedWorkstation)");
    expect(slice).not.toContain("readyToWorkProtectedReceiptStore().clear()");
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

  test("all status projections retain persistence attention and receipt failure invokes rollback", () => {
    for (const entry of ["async function readyToWorkStatusForSender", "async function reconcileReadyToWorkNow",
      "function attachReadyCodingHarnessPreview", "async function attachReadyCodingHarnessStatuses",
      "async function refreshReadyToWorkStatus", "function publishReadyToWorkStatus"]) {
      const start = main.indexOf(entry);
      expect(main.slice(start, start + 1_200)).toContain("readyToWorkPersistence.attention()");
    }
    const start = main.indexOf("const nextReceipt = activated.data.startupReceipt");
    expect(main.slice(start, start + 700)).toContain("readyToWorkPersistence.saveReceiptOrRollback(");
    expect(main.slice(start, start + 700)).toContain("disableReadyWorkstationOwner");
    expect(main).toContain("readyToWorkPersistence.recordFailure(error, activatedComputerUse || activatedWorkstation)");
  });

  test("Ready activation fences asynchronous admission and receipt writes after Off", () => {
    const restore = main.slice(main.indexOf("async function restoreReadyWorkstation("), main.indexOf("async function observeReadyWorkstation("));
    expect(restore).toContain("const generation = readyToWorkGeneration");
    expect(main).toContain('readyToWorkPersistence.mayRestore(!componentsOnly && trigger === "explicit_restore" && desired !== null)');
    const status = restore.indexOf("await getWorkstationServerSessionStatus()");
    const activate = restore.indexOf("await activateStoredWorkstationProfile(");
    expect(restore.indexOf("generation !== readyToWorkGeneration", status)).toBeLessThan(activate);
    expect(restore).toContain("}, () => readyBindingIsCurrent(binding, generation))");
    expect(restore).toContain("disableReadyWorkstationOwner, () => readyBindingIsCurrent(binding, generation)");
    const activation = main.slice(main.indexOf("async function activateStoredWorkstationProfile("), main.indexOf('  "workstationProfiles:selectActiveProfile"'));
    expect(activation).toContain("isCurrent: () => boolean = () => true");
    for (const [awaited, effect] of [
      ["const stored = await store.get", "const tokenPromise = getValidAccessToken"],
      ["const bearerToken =", "const serverResult = await activateWorkstationProfileViaServer"],
      ["const serverResult = await", "const userId = await"],
      ["const userId = await", "factsResult = await discoverWorkstationFacts"],
      ["factsResult = await discoverWorkstationFacts", "const activated = await activeWorkstationProfileController.activate"],
      ["const activated = await activeWorkstationProfileController.activate", "const advertisement = refreshDesktopRelayCapabilities"],
      ["const advertised =", "const completed = await completeWorkstationProfileActivation"],
      ["const completed = await", "// 6. Completion"],
    ]) {
      const begin = activation.indexOf(awaited!);
      const end = activation.indexOf(effect!, begin);
      expect(begin).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(begin);
      expect(activation.slice(begin, end)).toContain("if (!isCurrent())");
    }
  });

  test("Ready Computer use enrollment checks generation before enable and rolls back stale results", () => {
    const enable = main.slice(main.indexOf("async function enableReadyComputerUseDuringEnrollment("), main.indexOf("async function disableReadyComputerUseOwner("));
    expect(enable).toContain("isCurrent: () => boolean = () => true");
    expect(enable).toContain("if (!isCurrent() || !agentId) return false");
    const effect = enable.indexOf("await setup.enable(pin, agentId)");
    expect(enable.indexOf("if (!isCurrent())", effect)).toBeGreaterThan(effect);
    expect(enable.slice(effect)).toContain("await setup.disable()");
    expect(enable).toContain("return isCurrent() && enabledProjection?.effectiveProvider");
    expect(main).toContain("binding.humanId,\n          () => readyBindingIsCurrent(binding, generation)");
  });

  test("hard-bounds Ready authentication, status, and two-phase activation network", () => {
    expect(main).toContain("awaitReadyToWorkValueBounded(");
    expect(main).toContain("signal: AbortSignal.timeout(5_000)");
    expect(main).toContain("networkTimeoutMs: 5_000");
    expect(main).toContain("timeoutMs: args.networkTimeoutMs");
    expect(coordinator).toContain("readyToWorkBoundedValue<T>");
  });
});

test("keyed persistence is used at every main read/write seam and manual activation waits old cleanup", () => {
  expect(main).not.toContain("readyToWorkStore().loadFor(");
  expect(main).not.toContain("readyToWorkStore().save(");
  expect(main).not.toContain("readyToWorkProtectedReceiptStore().readFor(");
  expect(main).not.toContain("readyToWorkProtectedReceiptStore().clear(");
  expect(main).toContain("rememberedFilePath: readyToWorkRememberedStateFilePath()");
  expect(main).toContain("rememberedFilePath: readyToWorkRememberedReceiptFilePath()");
  const start = main.indexOf('  "workstationProfiles:selectActiveProfile",');
  const finish = main.indexOf('ipcMain.handle("app:getVersion"', start);
  const select = main.slice(start, finish);
  expect(select.indexOf("await readyToWorkCleanupPromise")).toBeLessThan(select.indexOf("await activateStoredWorkstationProfile"));
  expect(select).toContain("}, isCurrent)");
  expect(select).toContain("ownerSession === serverSessions.active");
  expect(main).toContain("settleReadyCleanup(readyToWorkCleanupPromise, [durableReduction, remoteCleanup])");
});
