import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const electronRoot = join(import.meta.dir, "..", "..", "electron");
const main = readFileSync(join(electronRoot, "main.ts"), "utf8");
const flow = readFileSync(join(electronRoot, "desktop-connection-flow.ts"), "utf8");
const committedTerminal = readFileSync(join(electronRoot, "committed-cold-boot-terminal.ts"), "utf8");
const precommitTerminal = readFileSync(join(electronRoot, "active-precommit-cold-boot-terminal.ts"), "utf8");
const acceptedTerminal = readFileSync(join(electronRoot, "accepted-identity-cold-boot-terminal.ts"), "utf8");
const terminalRuntime = readFileSync(join(electronRoot, "cold-boot-terminal-runtime.ts"), "utf8");
const registry = readFileSync(join(electronRoot, "server-sessions", "registry.ts"), "utf8");
const logtoDiagnostic = readFileSync(join(electronRoot, "logto-auth-diagnostic.ts"), "utf8");

function handler(channel: string, nextChannel: string): string {
  const start = main.indexOf(`ipcMain.handle("${channel}"`);
  const end = main.indexOf(`ipcMain.handle("${nextChannel}"`, start + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return main.slice(start, end);
}

describe("switch/add production cutover source contract", () => {
  test("the connection attempt owns setup transport cancellation", () => {
    expect(main).toContain("probeServerClaimStateForUrl(origin, signal)");
    expect(main).not.toContain("probeServerClaimStateForUrl(origin);");
  });

  test("both entry points converge on DesktopConnectionFlow without legacy registry writes", () => {
    const switchHandler = handler("servers:switchTo", "servers:add");
    const addHandler = handler("servers:add", "servers:close");
    expect(switchHandler).toContain('mode: "switch-server"');
    expect(switchHandler).toContain("suggestedUrl: rawUrl.trim()");
    expect(switchHandler).toContain('desktopConnectionFlow.connect(rawUrl.trim(), "switch", theme)');
    expect(switchHandler).toContain('result.reason === "wrong-server"');
    expect(switchHandler).toContain("decisionId: result.decisionId");
    expect(addHandler).toContain('showGuardedServerPicker({');
    for (const source of [switchHandler, addHandler]) {
      expect(source).not.toContain("serverSessions.switchTo(");
      expect(source).not.toContain("serverSessions.add(");
      expect(source).not.toContain("saveConfig(");
      expect(source).not.toContain("pushRecentServer(");
    }
  });

  test("close and forget fallback activation also converge on DesktopConnectionFlow", () => {
    const configureStart = main.indexOf("function configureServerSessions()");
    const configureEnd = main.indexOf("// Relay status", configureStart);
    const configure = main.slice(configureStart, configureEnd);
    const forget = handler("servers:forget", "fs:openPath");
    expect(main).toContain('desktopConnectionFlow.connect(serverUrl, "switch")');
    expect(main).toContain("if (!desktopConnectionFlow.cancel()) return { kind: \"indeterminate\" }");
    expect(configure).toContain("activateFallback: activateFallbackWithConnectionFlow");
    for (const legacy of ["handoffRelay:", "resolveLogtoConfig:", "loadTokens:", "refreshTokens:",
      "probeFingerprint:", "storeFingerprint:"]) expect(configure).not.toContain(legacy);
    expect(main).not.toContain("function refreshTokensFor(");
    expect(main).not.toContain("function probeServerFingerprint(");
    expect(forget).not.toContain("saveConfig({ ...current, serverUrl: fallback })");
    const closeStart = registry.indexOf("async close(serverUrl: string)");
    const forgetStart = registry.indexOf("async forget(", closeStart);
    const clearStart = registry.indexOf("async clearPersistentPartitionsFor", forgetStart);
    expect(registry.slice(closeStart, forgetStart)).not.toContain("this.switchTo(");
    expect(registry.slice(forgetStart, clearStart)).not.toContain("this.switchTo(");
  });

  test("setup-status timeout is list-only diagnostic and cannot mutate authority surfaces", () => {
    const start = main.indexOf("async function fetchListSetupStatus(");
    const end = main.indexOf("async function activateFallbackWithConnectionFlow", start);
    const diagnostic = main.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(diagnostic).toContain("AbortSignal.timeout(5_000)");
    for (const mutation of ["createView", "setRecentServerFingerprint", "loadTokens", "startRelay",
      "activeScope", "saveConfig"]) expect(diagnostic).not.toContain(mutation);
    expect(main).toContain("fetchListSetupStatus,");
    const legacySwitch = registry.slice(registry.indexOf("async switchTo("), registry.indexOf("async add("));
    expect(legacySwitch).not.toContain("fetchListSetupStatus");
  });

  test("Logto projection is fetch-free and only explicit auth reprobe owns a timeout", () => {
    const applyStart = main.indexOf("function applyVerifiedLogtoHealthBody(");
    const reprobeStart = main.indexOf("async function reprobeLogtoConfigDiagnostic(");
    const refreshStart = main.indexOf("async function refreshTokens(", reprobeStart);
    const projection = main.slice(applyStart, reprobeStart);
    const reprobe = main.slice(reprobeStart, refreshStart);
    expect(applyStart).toBeGreaterThan(-1);
    expect(projection).not.toContain("fetch(");
    expect(projection).not.toContain("AbortSignal.timeout");
    expect(reprobe).not.toContain("fetch(`${serverUrl}/health`");
    expect(reprobe).not.toContain("AbortSignal.timeout");
    expect(reprobe).toContain("reprobeLogtoAuthDiagnostic({");
    expect(reprobe).toContain("timeoutMs: AUTH_DIAGNOSTIC_PROBE_TIMEOUT_MS");
    expect(reprobe).toContain("active === session");
    expect(reprobe).toContain("{ targetSession: captured }");
    expect(logtoDiagnostic).toContain("AbortSignal.timeout(ports.timeoutMs)");
    expect(logtoDiagnostic).toContain("await ports.fetch(healthUrl");
    const authStart = main.indexOf('"auth:open-account-page"');
    const resetStart = main.indexOf('ipcMain.handle("auth:openResetUrl"', authStart);
    const reprobeHandlerStart = main.indexOf('ipcMain.handle("auth:reprobe-server"');
    const reprobeHandlerEnd = main.indexOf("function activeLocalColdBootShell", resetStart);
    expect(reprobeHandlerStart).toBeGreaterThan(-1);
    expect(reprobeHandlerEnd).toBeGreaterThan(reprobeHandlerStart);
    const reprobeHandler = main.slice(reprobeHandlerStart, reprobeHandlerEnd);
    expect(reprobeHandler).toContain("reprobeLogtoConfigDiagnostic(session.serverUrl)");
    expect(main.slice(authStart, resetStart)).not.toContain("reprobeLogtoConfigDiagnostic");
  });

  test("boot and cold recovery project verified health without diagnostic reprobe", () => {
    expect(main).toContain("applyVerifiedLogtoHealthBody(serverUrl, observation.healthBody)");
    expect(main).toContain("initialColdBootObservation.healthBody,");
    expect(main.match(/reprobeLogtoConfigDiagnostic\(/g)?.length).toBe(2);
  });

  test("all runtime picker entry points share one guarded promise", () => {
    expect(main).toContain("let activeServerPicker: Promise<PickerConnectionResult | null> | null = null");
    expect(main).toContain("let activeServerPickerWindow: BrowserWindow | null = null");
    expect(main).toContain("if (activeServerPicker) return activeServerPicker");
    expect(handler("servers:add", "servers:close")).toContain("showGuardedServerPicker({");
    expect(handler("coldBoot:pairToDifferentServer", "coldBoot:useThisServerAnyway"))
      .toContain("showGuardedServerPicker({");
  });

  test("candidate Logto is owned by the normal connection picker", () => {
    const authStart = main.indexOf("async function authenticateConnectionCandidate(");
    const authEnd = main.indexOf("const desktopConnectionFlow", authStart);
    const candidateAuth = main.slice(authStart, authEnd);
    const pickerStart = main.indexOf("function showFirstRunPicker(");
    const pickerEnd = main.indexOf("// ---------------------------------------------------------------------------\n// Onboarding wizard", pickerStart);
    const picker = main.slice(pickerStart, pickerEnd);
    expect(candidateAuth).toContain("const pickerWindow = activeServerPickerWindow");
    expect(candidateAuth).toContain("pickerWindow && !pickerWindow.isDestroyed() ? pickerWindow : mainWindow");
    expect(candidateAuth).toContain("theme: input.theme");
    expect(picker).toContain("width: 760");
    expect(picker).toContain("height: 820");
    expect(picker).not.toContain("transitionBounds");
    expect(picker).toContain("if (activeServerPickerWindow === win) activeServerPickerWindow = null");
  });

  test("candidate construction is detached and connection health has no timeout ceiling", () => {
    expect(main).toContain("constructServerSessionView(session, false, false)");
    expect(main).toContain("createCandidateView: createCandidateServerSessionView");
    const fetchStart = main.indexOf("async function fetchConnectionHealth");
    const fetchEnd = main.indexOf("async function observeConnectionReadiness", fetchStart);
    expect(main.slice(fetchStart, fetchEnd)).not.toContain("AbortSignal.timeout");
    expect(flow).not.toContain("setTimeout(");
  });

  test("picker Connect directly owns the coordinator and defers metadata to promotion", () => {
    const pickerStart = main.indexOf("function showFirstRunPicker(");
    const pickerEnd = main.indexOf("// ---------------------------------------------------------------------------\n// Onboarding wizard", pickerStart);
    const picker = main.slice(pickerStart, pickerEnd);
    expect(picker).toContain("opts.theme ?? null");
    expect(picker).toContain('pickerMode === "first-run"');
    expect(picker).not.toContain("writePersistedTuiServerTarget(");
    expect(picker).not.toContain("pushRecentServer(");
    const firstRunUi = readFileSync(join(electronRoot, "..", "first-run", "index.tsx"), "utf8");
    expect(firstRunUi).not.toContain("Test connection");
    expect(firstRunUi).not.toContain('role="radio"');
    expect(firstRunUi).toContain('const displayedDecision = probe.kind === "error"');
    expect(firstRunUi).toContain("if (committing || displayedDecision)");
    expect(firstRunUi).toContain("await api?.abortAttempt()");
  });

  test("picker IPC projects only typed result state, never verified bodies", () => {
    const preload = readFileSync(join(electronRoot, "preload-first-run.ts"), "utf8");
    expect(preload).not.toContain("VerifiedHealth");
    expect(preload).not.toContain("healthBody");
    expect(preload).not.toContain("setup.raw");
    expect(main).toContain("return { ok: true as const, url: result.url }");
    expect(main).toContain('result.reason === "wrong-server"');
    expect(preload).toContain('ipcRenderer.invoke("first-run:confirm-downgrade", decisionId)');
    expect(preload).toContain('{ ok: false; reason: "downgrade-confirmation-required"; decisionId: string }');
    expect(main).toContain('_e.sender.id !== win.webContents.id || settled || typeof decisionId !== "string"');
    expect(main).toContain("desktopConnectionFlow.confirmDowngrade(decisionId)");
    expect(preload).toContain('ipcRenderer.invoke("first-run:accept-identity", decisionId)');
    expect(main).toContain("desktopConnectionFlow.acceptIdentity(decisionId)");
    expect(main).toContain("selectPreviousHttpsOrigin(");
    expect(main).toContain("listRecentServers(),");
  });

  test("identity decisions stay sender-scoped and renderer projections strip raw identity", () => {
    const acceptHandler = handler("servers:accept-identity", "servers:add");
    const preload = readFileSync(join(electronRoot, "preload.ts"), "utf8");
    const firstRunPreload = readFileSync(join(electronRoot, "preload-first-run.ts"), "utf8");
    const workbenchDesktop = readFileSync(join(electronRoot, "..", "..", "workbench", "src", "lib", "desktop.ts"), "utf8");
    expect(acceptHandler).toContain("assertMainWindowSender(e)");
    expect(acceptHandler).toContain("desktopConnectionFlow.acceptIdentity(decisionId)");
    expect(main).toContain("listRecentServers().map(rendererSafeConnectionValue)");
    expect(main).toContain("result.servers.map(rendererSafeConnectionValue)");
    expect(main).toContain("return rendererSafeConnectionValue(result)");
    expect(main).toContain("recentServers: targets.recentServers.map(rendererSafeConnectionValue)");
    for (const rendererSurface of [preload, firstRunPreload, workbenchDesktop]) {
      expect(rendererSurface).not.toContain("expectedFingerprint");
      expect(rendererSurface).not.toContain("observedFingerprint");
      expect(rendererSurface).not.toContain("foundFingerprint");
      expect(rendererSurface).not.toMatch(/\bfingerprint\??:/);
    }
  });

  test("stored identity retirement is health-bound and descriptor-independent", () => {
    const start = main.indexOf("retireStoredCandidateIdentity: async (serverUrl, health) => {");
    const end = main.indexOf("commitActiveAuthority:", start);
    const retirement = main.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(retirement).toContain("createIdentityBoundTokenStore({ routingServerUrl: serverUrl,");
    expect(retirement).toContain("logtoEndpoint: health.logtoConfig.endpoint");
    expect(retirement).toContain("clientAppId: health.logtoConfig.appId");
    expect(retirement).toContain(".retireExact()");
    expect(retirement).toContain("serverUrlScope(serverUrl)");
    expect(retirement).not.toContain("clearTokensFor(");
    expect(retirement).not.toContain("activeRoutingServerUrl");
  });

  test("picker preserves either follow-on decision across combined downgrade and identity acceptance", () => {
    const firstRunUi = readFileSync(join(electronRoot, "..", "first-run", "index.tsx"), "utf8");
    expect(firstRunUi).toContain('result.reason === "wrong-server" ? {');
    expect(firstRunUi).toContain("identityDecisionId: result.decisionId");
    expect(firstRunUi).toContain('result.reason === "downgrade-confirmation-required" ? {');
    expect(firstRunUi).toContain("downgradeDecisionId: result.decisionId");
    expect(firstRunUi.match(/if \(!result\.ok\) applyConnectionFailure\(result\)/g)).toHaveLength(3);
  });

  test("committed cold boot is a retained terminal branch that cannot enter the legacy tail", () => {
    const spliceStart = main.indexOf("committedColdBootTerminal = prepareProductionCommittedColdBootTerminal(");
    const legacyStart = main.indexOf("const initialColdBootObservation", spliceStart);
    const splice = main.slice(spliceStart, legacyStart);
    expect(spliceStart).toBeGreaterThan(-1);
    expect(splice).toContain("await committedColdBootTerminal.launch()");
    expect(splice).toMatch(/await committedColdBootTerminal\.launch\(\);\s*return;/);
    expect(handler("coldBoot:retry", "coldBoot:pairToDifferentServer"))
      .toContain("await committedColdBootTerminal.retry()");
    expect(handler("coldBoot:pairToDifferentServer", "coldBoot:useThisServerAnyway"))
      .toContain('reason: "committed-handoff-pending"');
    expect(handler("coldBoot:useThisServerAnyway", "coldBoot:quit"))
      .toContain("if (committedColdBootTerminal || activePrecommitColdBootTerminal || acceptedIdentityColdBootTerminal) return");
  });

  test("terminal fencing and release stay exact without bootstrap reload or recommit", () => {
    expect(committedTerminal).toContain("const begun = ports.beginCommitted(recovery)");
    expect(committedTerminal.indexOf("const begun = ports.beginCommitted(recovery)")).toBeLessThan(
      committedTerminal.indexOf("controller.launch()"),
    );
    expect(committedTerminal).toContain("!sameAuthority(ports.currentAuthority(), frozenAuthority)");
    expect(committedTerminal).toContain("commitActiveAuthority: () => Promise.resolve({ committed: false })");
    const releaseStart = main.indexOf("releaseCandidate: ({ recovery, facts })");
    const finishStart = main.indexOf("finishReleased: async ({ recovery })", releaseStart);
    const finishEnd = main.indexOf("onState:", finishStart);
    const release = main.slice(releaseStart, finishStart);
    const finish = main.slice(finishStart, finishEnd);
    expect(release.indexOf("drainPendingDeepLinks()")).toBeGreaterThan(-1);
    expect(finish).toContain("await finishReleasedDesktopBoot(recovery.routingServerUrl)");
    expect(`${release}${finish}`).not.toContain("loadActiveRenderer");
    expect(`${release}${finish}`).not.toContain("releaseVerifiedWorkbenchNavigation");
  });

  test("the Electron runtime facade is closed over committed bridges, not config authority", () => {
    expect(main).toContain("createColdBootTerminalRuntime");
    expect(main).toContain("runtime.committedPorts({");
    expect(terminalRuntime).toContain("beginCommittedHandoffRecovery");
    expect(terminalRuntime).toContain("AcceptedIdentityRuntimePorts");
    expect(terminalRuntime).toContain("forceDetachedReplacement: true");
    for (const forbidden of ["saveConfig(", "loadConfig(", "configForCommittedActiveConnection("]) {
      expect(terminalRuntime).not.toContain(forbidden);
    }
  });

  test("v2 identity replacement retires only before renderer authority and legacy journals stay local", () => {
    const registry = readFileSync(join(electronRoot, "server-sessions", "registry.ts"), "utf8");
    const pending = readFileSync(join(electronRoot, "pending-connection.ts"), "utf8");
    const steps = registry.slice(registry.indexOf("const steps:"));
    expect(steps.indexOf('checkpoint: "old-identity"')).toBeLessThan(steps.indexOf('checkpoint: "renderer-authority"'));
    expect(registry).toContain("acceptedReplacement !== replacesActiveView");
    expect(pending).toContain('disposition: "blocked-legacy-handoff"');
    expect(main).toContain('disposition === "blocked-legacy-handoff"');
    expect(handler("coldBoot:retry", "coldBoot:pairToDifferentServer")).toContain("if (blockedLegacyHandoff)");
    expect(handler("coldBoot:useThisServerAnyway", "coldBoot:quit")).toContain("if (blockedLegacyHandoff) return");
  });

  test("active precommit recovery remains a retained replacement terminal", () => {
    const spliceStart = main.indexOf("activePrecommitColdBootTerminal = prepareProductionActivePrecommitColdBootTerminal()");
    const legacyStart = main.indexOf("let launchConnectionCohort", spliceStart);
    const splice = main.slice(spliceStart, legacyStart);
    expect(spliceStart).toBeGreaterThan(-1);
    expect(splice).toContain("await activePrecommitColdBootTerminal.launch()");
    expect(splice).toContain("initialConnectionCohort = { url: outcome.cohort.url, verified: outcome.cohort }");
    expect(splice).not.toContain("loadBootSetupStatus");
    expect(handler("coldBoot:retry", "coldBoot:pairToDifferentServer"))
      .toContain("await activePrecommitColdBootTerminal.retry()");
    expect(handler("coldBoot:pairToDifferentServer", "coldBoot:useThisServerAnyway"))
      .toContain("return activePrecommitColdBootTerminal.pairToDifferentServer()");
    expect(handler("coldBoot:useThisServerAnyway", "coldBoot:quit"))
      .toContain("activePrecommitColdBootTerminal");
    expect(main).toContain("serverUrl: activePrecommitColdBootTerminal!.recoveryTarget");
    expect(main).toContain('if (result === null) return { kind: "cancelled" as const }');
    expect(precommitTerminal).toContain("postcommitOrUnknown ||= result.reason === \"promotion-failed\"");
    expect(precommitTerminal).toContain("if (!postcommitOrUnknown && !matchesPriorActive");
  });

  test("initial precommit only prefills the normal first-run picker", () => {
    const suggestionStart = main.indexOf("function initialPrecommitPickerSuggestion()");
    const suggestionEnd = main.indexOf("// ---------------------------------------------------------------------------\n// Onboarding wizard", suggestionStart);
    const suggestion = main.slice(suggestionStart, suggestionEnd);
    expect(suggestionStart).toBeGreaterThan(-1);
    expect(suggestion).toContain('loaded.disposition !== "precommit"');
    expect(suggestion).toContain('recovery.context === "initial"');
    expect(suggestion).toContain("recovery.priorActiveScope === null");
    expect(suggestion).toContain("recovery.priorRecoveryGuard.scope === null");
    expect(suggestion).toContain("recovery.priorRecoveryGuard.revision === null");
    const bootStart = main.indexOf('console.log("[desktop] First-run picker")');
    const bootEnd = main.indexOf("if (!connected?.ok)", bootStart);
    const firstRun = main.slice(bootStart, bootEnd);
    expect(firstRun).toContain("suggestedUrl: forceFirstRun ? null : initialPrecommitPickerSuggestion()");
    expect(firstRun).not.toContain("desktopConnectionFlow.connect(");
    const pickerStart = main.indexOf("function showFirstRunPicker(");
    const pickerEnd = main.indexOf("function initialPrecommitPickerSuggestion()", pickerStart);
    expect(main.slice(pickerStart, pickerEnd)).toContain("suggestedUrl: suggestedUrl ?? targets.suggestedUrl");
  });

  test("accepted identity cold boot delegates the exact proof into a detached, forward-only terminal", () => {
    const useAnyway = handler("coldBoot:useThisServerAnyway", "coldBoot:quit");
    expect(useAnyway).toContain("prepareProductionAcceptedIdentityColdBootTerminal");
    expect(useAnyway).not.toContain("commitAcceptedWrongServer");
    expect(main).toContain("runtime.acceptedPorts({");
    expect(main).toContain("commitAcceptedConfig: commitDesktopConnectionAuthority");
    const commit = main.slice(main.indexOf("function commitDesktopConnectionAuthority("), main.indexOf("const desktopConnectionTupleBinding"));
    expect(commit).toContain("configForCommittedActiveConnection(loadConfig()");
    expect(commit).toContain("saveConfig(committedConfig)");
    expect(acceptedTerminal).toContain("ACCEPTED_IDENTITY_REPLACEMENT_GATE_CONTEXT");
    expect(acceptedTerminal).toContain("acceptedIdentityReplacementReceipt: input.proof.receipt");
    expect(acceptedTerminal).toContain("ports.savePending(pendingAt(pending, \"metadata\"))");
    expect(acceptedTerminal).toContain("stage = \"committed-metadata\"");
    expect(acceptedTerminal).toContain("retireOldIdentity");
    expect(acceptedTerminal).toContain("sameAuthority(ports.currentAuthority(), frozenB)");
  });
});
