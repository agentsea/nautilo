/* eslint-disable @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call, @typescript-eslint/await-thenable, @typescript-eslint/prefer-promise-reject-errors -- This source-contract test deliberately evaluates isolated main-process seams and controlled promise fixtures. */
/**
 * Static contract for the privileged cold-boot boundary.
 * Browser-shell tests are intentionally source-level: importing Electron's
 * main module would boot the app. The delay fixture in preflight-url.test.ts
 * exercises the same URL-probe envelope with real controlled timers.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const desktopRoot = join(import.meta.dir, "../..");
const read = (...parts: string[]) => readFileSync(join(desktopRoot, ...parts), "utf8");

function inlineScript(html: string): string {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error("expected an inline script");
  return match[1] ?? "";
}

function withoutComments(script: string): string {
  return script
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function bootstrapSupersessionClassifier(input: Readonly<{
  error: unknown;
  requestedUrl: string;
  releaseEpochAtRequest: number;
  connectBootstrapEntryHref: string | null;
  coldBootBootstrapReady: boolean;
  verifiedWorkbenchOrigin: string | null;
  verifiedBootstrapRelease: { epoch: number; origin: string } | null;
}>): boolean {
  const main = read("electron", "main.ts");
  const start = main.indexOf("function isExpectedBootstrapSupersession");
  const end = main.indexOf("function workbenchBackgroundColor", start);
  if (start < 0 || end < 0) throw new Error("expected bootstrap supersession classifier");
  const helper = new Bun.Transpiler({ loader: "ts" }).transformSync(main.slice(start, end));
  const classifier = new Function(
    "connectBootstrapEntryHref",
    "coldBootBootstrapReady",
    "verifiedWorkbenchOrigin",
    "verifiedBootstrapRelease",
    `${helper}; return isExpectedBootstrapSupersession;`,
  )(
    input.connectBootstrapEntryHref,
    input.coldBootBootstrapReady,
    input.verifiedWorkbenchOrigin,
    input.verifiedBootstrapRelease,
  ) as (error: unknown, intent: { requestedUrl: string; releaseEpochAtRequest: number }) => boolean;
  return classifier(input.error, {
    requestedUrl: input.requestedUrl,
    releaseEpochAtRequest: input.releaseEpochAtRequest,
  });
}

function bootstrapLoadHarness(input: Readonly<{
  connectBootstrapEntryHref: string | null;
  coldBootBootstrapReady: boolean;
  verifiedWorkbenchOrigin: string | null;
  verifiedBootstrapRelease: { epoch: number; origin: string } | null;
}>) {
  const main = read("electron", "main.ts");
  const start = main.indexOf("type BootstrapLoadIntent");
  const end = main.indexOf("function workbenchBackgroundColor", start);
  if (start < 0 || end < 0) throw new Error("expected bootstrap load boundary");
  const boundary = new Bun.Transpiler({ loader: "ts" }).transformSync(main.slice(start, end));
  return new Function(
    "connectBootstrapEntryHref",
    "coldBootBootstrapReady",
    "verifiedWorkbenchOrigin",
    "verifiedBootstrapRelease",
    `${boundary}; return {
      loadRendererUrl,
      setRelease(value) { verifiedBootstrapRelease = value; },
    };`,
  )(
    input.connectBootstrapEntryHref,
    input.coldBootBootstrapReady,
    input.verifiedWorkbenchOrigin,
    input.verifiedBootstrapRelease,
  ) as {
    loadRendererUrl(contents: { loadURL(url: string): Promise<void> }, url: string): Promise<void>;
    setRelease(value: { epoch: number; origin: string } | null): void;
  };
}

function sourceDevelopmentAuthorityHarness(
  persisted: Readonly<{ scope: string; revision: string; connectionAttemptId: string; serverFingerprint: string }> | null,
) {
  const main = read("electron", "main.ts");
  const start = main.indexOf("let sourceDevelopmentAuthority:");
  const end = main.indexOf("const desktopConnectionTupleBinding", start);
  if (start < 0 || end < 0) throw new Error("expected source development authority seam");
  const seam = new Bun.Transpiler({ loader: "ts" }).transformSync(main.slice(start, end));
  return new Function(
    "randomUUID",
    "loadConfig",
    "projectActiveAuthority",
    "serverSessions",
    "getRecentServerFingerprint",
    `${seam}; return { installSourceDevelopmentAuthority, authoritativeConnectionSnapshot };`,
  )(
    (() => "fixed-uuid"),
    () => persisted === null ? null : { version: 1, mode: "connect", serverUrl: persisted.scope },
    () => persisted,
    { active: { scope: "ignored-session", serverUrl: "https://ignored.test" } },
    (serverUrl: string) => serverUrl === "http://127.0.0.1:3201" ? "trusted-a" : null,
  ) as {
    installSourceDevelopmentAuthority(serverUrl: string): void;
    authoritativeConnectionSnapshot(): {
      scope: string | null;
      revision: string | null;
      connectionAttemptId: string | null;
      serverFingerprint: string | null;
    };
  };
}

type TestActiveAuthority = Readonly<{
  scope: string | null;
  revision: string | null;
  connectionAttemptId: string | null;
  serverFingerprint: string | null;
}>;

function desktopAuthorityCommitHarness(input: Readonly<{
  persistedAuthority: TestActiveAuthority | null;
  saveThrows?: boolean;
}>) {
  const main = read("electron", "main.ts");
  const start = main.indexOf("let sourceDevelopmentAuthority:");
  const end = main.indexOf("const desktopConnectionTupleBinding", start);
  if (start < 0 || end < 0) throw new Error("expected Desktop authority commit seam");
  const seam = new Bun.Transpiler({ loader: "ts" }).transformSync(main.slice(start, end));
  let storedConfig: { authority: TestActiveAuthority } | null = input.persistedAuthority
    ? { authority: input.persistedAuthority }
    : null;
  const saved: Array<{ authority: TestActiveAuthority }> = [];
  const harness = new Function(
    "randomUUID",
    "loadConfig",
    "projectActiveAuthority",
    "serverSessions",
    "getRecentServerFingerprint",
    "configForCommittedActiveConnection",
    "saveConfig",
    `${seam}; return {
      installSourceDevelopmentAuthority,
      authoritativeConnectionSnapshot,
      commitDesktopConnectionAuthority,
    };`,
  )(
    (() => "fixed-uuid"),
    () => storedConfig,
    (config: { authority: TestActiveAuthority } | null) => config?.authority ?? null,
    { active: null },
    (serverUrl: string) => serverUrl === "http://127.0.0.1:3201" ? "fingerprint-a" : null,
    (_current: unknown, next: Readonly<{
      serverUrl: string;
      connectionAttemptId: string;
      serverFingerprint: string;
    }>) => ({
      authority: {
        scope: new URL(next.serverUrl).origin,
        revision: `revision-${next.connectionAttemptId}`,
        connectionAttemptId: next.connectionAttemptId,
        serverFingerprint: next.serverFingerprint,
      },
    }),
    (config: { authority: TestActiveAuthority }) => {
      if (input.saveThrows) throw new Error("disk write failed");
      storedConfig = config;
      saved.push(config);
    },
  ) as {
    installSourceDevelopmentAuthority(serverUrl: string): void;
    authoritativeConnectionSnapshot(): TestActiveAuthority;
    commitDesktopConnectionAuthority(input: Readonly<{
      routingServerUrl: string;
      attemptId: string;
      serverFingerprint: string;
      priorAuthorityGuard: TestActiveAuthority;
    }>): boolean;
  };
  return { ...harness, saved };
}

function activeLocalColdBootShellHarness(input: Readonly<{
  rendererUrl: string;
  rendererId?: number;
  allowedPaths: readonly string[];
}>) {
  const main = read("electron", "main.ts");
  const start = main.indexOf("function activeLocalColdBootShell(");
  const end = main.indexOf("function assertColdBootActionSender", start);
  if (start < 0 || end < 0) throw new Error("expected local cold-boot shell seam");
  const seam = new Bun.Transpiler({ loader: "ts" }).transformSync(main.slice(start, end));
  const renderer = {
    id: input.rendererId ?? 41,
    getURL: () => input.rendererUrl,
  };
  const activeLocalColdBootShell = new Function(
    "activeRenderer",
    "coldBootLocalShellPaths",
    "pathToFileURL",
    `${seam}; return activeLocalColdBootShell;`,
  )(
    () => renderer,
    () => [...input.allowedPaths],
    pathToFileURL,
  ) as (event?: { sender: { id: number } }) => typeof renderer | null;
  return { activeLocalColdBootShell, renderer };
}

function menuProjectionKey(
  state:
    | { scope: string; hasLogto: boolean; signedIn: boolean }
    | null,
): string {
  if (!state) return "no-active-server";
  return [
    state.scope,
    state.hasLogto ? "logto-ready" : "logto-unresolved",
    state.signedIn ? "signed-in" : "signed-out",
  ].join("|");
}

describe("cold boot has one main-owned reachability authority", () => {
  test("host resizing follows the active view after recovery replacement and server switching", () => {
    const main = read("electron", "main.ts");
    const start = main.indexOf("  const resizeActiveView = (): void => {");
    const end = main.indexOf("  resizeActiveView();", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const seam = new Bun.Transpiler({ loader: "ts" }).transformSync(main.slice(start, end));
    type Bounds = { x: number; y: number; width: number; height: number };
    const originalBounds: Bounds[] = [];
    const replacementBounds: Bounds[] = [];
    const original = { setBounds: (bounds: Bounds) => originalBounds.push(bounds) };
    const replacement = { setBounds: (bounds: Bounds) => replacementBounds.push(bounds) };
    const sessions: { active: { view: typeof original } | null } = { active: { view: original } };
    let size = { width: 1000, height: 700 };
    const resize = new Function("mainWindow", "view", "serverSessions", `${seam}; return resizeActiveView;`)(
      { isDestroyed: () => false, getContentBounds: () => size }, original, sessions,
    ) as () => void;

    resize();
    expect(originalBounds).toEqual([{ x: 0, y: 0, width: 1000, height: 700 }]);
    sessions.active = { view: replacement };
    size = { width: 1400, height: 900 };
    resize();
    expect(replacementBounds).toEqual([{ x: 0, y: 0, width: 1400, height: 900 }]);
    expect(originalBounds).toHaveLength(1);
    sessions.active = { view: original };
    size = { width: 800, height: 600 };
    resize();
    expect(originalBounds.at(-1)).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    expect(replacementBounds).toHaveLength(1);
    sessions.active = null;
    expect(resize).not.toThrow();
  });

  test("candidate onboarding adapter accepts only explicit B partition, bearer, and cancellation inputs", () => {
    const main = read("electron", "main.ts");
    const start = main.indexOf("function showOnboardingWizard(");
    const end = main.indexOf("function setupLogging()", start);
    const wizard = main.slice(start, end);

    expect(wizard).toContain("partition?: string");
    expect(wizard).toContain("getBearer?: () => Promise<string | null>");
    expect(wizard).toContain("signal?: AbortSignal");
    expect(wizard).toContain("...(opts.partition ? { partition: opts.partition } : {})");
    expect(wizard).toContain("opts.signal?.removeEventListener(\"abort\", onAbort)");
    expect(wizard).not.toContain("resolvedServerUrl()");
  });

  test("persisted cold boot has no elapsed-time terminal authority and is bound to the Phase-1 attempt reducer", () => {
    const main = read("electron", "main.ts");
    const observation = read("electron", "cold-boot-observation.ts");
    const authorityStart = main.indexOf("function initializeColdBootObservationAuthority");
    const authorityEnd = main.indexOf("async function observeColdBootConnection", authorityStart);
    const authority = main.slice(authorityStart, authorityEnd);

    expect(authority).toContain("priorActiveScope: resolvedServerUrl");
    expect(authority).not.toContain("timeoutMs");
    expect(observation).toContain('context: "cold-boot"');
    expect(observation).toContain("beginConnectionAttempt");
    expect(observation).toContain("transitionConnectionAttempt");
    expect(observation).toContain("planServerTarget(serverUrl)");
    expect(observation).not.toMatch(/setTimeout\s*\(/);
  });

  test("bootstrap and recovery shell never fetch or impose a private health timeout", () => {
    const bootstrap = read("electron", "bootstrap.html");
    const picker = read("electron", "cold-boot-picker.html");

    for (const shell of [bootstrap, picker].map(inlineScript).map(withoutComments)) {
      expect(shell).not.toMatch(/\bfetch\s*\(/);
      expect(shell).not.toMatch(/AbortSignal\.timeout\s*\(/);
    }
    expect(bootstrap).toContain("api.getBootstrapState()");
    expect(picker).toContain("api?.retry?.()");
  });

  test("cold-boot picker query state remains an exact local-shell authority", () => {
    const pickerPath = join(desktopRoot, "electron", "cold-boot-picker.html");
    const bootstrapPath = join(desktopRoot, "electron", "bootstrap.html");
    const pickerHref = pathToFileURL(pickerPath).href;
    const allowedPaths = [bootstrapPath, pickerPath];
    const query = activeLocalColdBootShellHarness({
      rendererUrl: `${pickerHref}?mode=wrong-server&server=http%3A%2F%2F127.0.0.1%3A3201`,
      allowedPaths,
    });
    expect(query.activeLocalColdBootShell({ sender: { id: query.renderer.id } })).toBe(query.renderer);

    const hash = activeLocalColdBootShellHarness({
      rendererUrl: `${pickerHref}#recovery`,
      allowedPaths,
    });
    expect(hash.activeLocalColdBootShell({ sender: { id: hash.renderer.id } })).toBe(hash.renderer);

    const differentFile = activeLocalColdBootShellHarness({
      rendererUrl: pathToFileURL(join(desktopRoot, "electron", "preload.ts")).href,
      allowedPaths,
    });
    expect(differentFile.activeLocalColdBootShell()).toBeNull();
    const remote = activeLocalColdBootShellHarness({
      rendererUrl: "https://nautilo.test/cold-boot-picker.html?mode=wrong-server",
      allowedPaths,
    });
    expect(remote.activeLocalColdBootShell()).toBeNull();
    expect(query.activeLocalColdBootShell({ sender: { id: query.renderer.id + 1 } })).toBeNull();
  });

  test("main coalesces duplicate retries, generation-fences stale results, and keeps response bodies private", () => {
    const main = read("electron", "main.ts");
    const preload = read("electron", "preload.ts");
    const getStateStart = main.indexOf('ipcMain.handle("coldBoot:getBootstrapState"');
    const getStateEnd = main.indexOf('ipcMain.handle("coldBoot:retry"', getStateStart);
    const getStateHandler = main.slice(getStateStart, getStateEnd);

    expect(main).toContain("ColdBootObservationAuthority");
    expect(main).toContain("initializeColdBootObservationAuthority().observe(serverUrl, options)");
    expect(main).toContain('ipcMain.handle("coldBoot:getBootstrapState"');
    expect(getStateHandler).toContain("healthBody` remains main-private");
    expect(getStateHandler).not.toContain("healthBody:");
    expect(preload).toContain('ipcRenderer.invoke("coldBoot:getBootstrapState")');
    expect(preload).not.toContain("coldBoot:getBootstrapContext");
    expect(preload).not.toContain("coldBoot:setShellStateOnBoot");
  });

  test("main preserves distinct unavailable, malformed, and wrong-identity outcomes", () => {
    const main = read("electron", "main.ts");
    const bootstrap = read("electron", "bootstrap.html");

    const observation = read("electron", "cold-boot-observation.ts");
    expect(observation).toContain('kind: "unavailable"');
    expect(observation).toContain('kind: "malformed"');
    expect(observation).toContain('kind: "wrong-server"');
    expect(observation).toContain('"invalid-json"');
    expect(bootstrap).toContain('picker("malformed"');
    expect(bootstrap).toContain('picker("wrong-server"');
  });

  test("Retry obtains a fresh main observation and only loads the typed projection afterwards", () => {
    const main = read("electron", "main.ts");
    const retryStart = main.indexOf('ipcMain.handle("coldBoot:retry"');
    const retryEnd = main.indexOf('ipcMain.handle("coldBoot:pairToDifferentServer"', retryStart);
    const retryHandler = main.slice(retryStart, retryEnd);

    expect(retryHandler).toContain("await observeColdBootConnection(serverUrl)");
    expect(retryHandler).toContain('if (observation.kind === "live")');
    expect(retryHandler).toContain("applyVerifiedLogtoHealthBody(serverUrl, observation.healthBody)");
    expect(retryHandler).toContain("await loadActiveRenderer(bootstrapEntryHref)");
    expect(retryHandler).not.toMatch(/\bfetch\s*\(/);
  });

  test("ordinary Retry retains its paused continuation, while accepted identity delegates to the terminal", () => {
    const main = read("electron", "main.ts");
    const retryStart = main.indexOf('ipcMain.handle("coldBoot:retry"');
    const retryEnd = main.indexOf('ipcMain.handle("coldBoot:pairToDifferentServer"', retryStart);
    const retryHandler = main.slice(retryStart, retryEnd);
    const acceptStart = main.indexOf('ipcMain.handle("coldBoot:useThisServerAnyway"');
    const acceptEnd = main.indexOf('ipcMain.handle("coldBoot:quit"', acceptStart);
    const acceptHandler = main.slice(acceptStart, acceptEnd);

    expect(retryHandler).toContain("const pausedBootContinuation = coldBootRecoveryContinue");
    expect(retryHandler).toContain("if (pausedBootContinuation)");
    expect(retryHandler).toContain("coldBootRecoveryContinue === pausedBootContinuation");
    expect(retryHandler).toMatch(/coldBootRecoveryContinue = null;[\s\S]*?pausedBootContinuation\(\)|coldBootRecoveryContinue = null;[\s\S]*?continueBoot\(\)/);
    expect(acceptHandler).toContain("prepareProductionAcceptedIdentityColdBootTerminal");
    expect(acceptHandler).not.toContain("pausedBootContinuation");
    expect(acceptHandler).not.toContain("coldBootRecoveryContinue()");
  });

  test("recovery actions cannot release Workbench while boot is resuming through setup/auth/onboarding", () => {
    const main = read("electron", "main.ts");
    const retryStart = main.indexOf('ipcMain.handle("coldBoot:retry"');
    const retryEnd = main.indexOf('ipcMain.handle("coldBoot:pairToDifferentServer"', retryStart);
    const retryHandler = main.slice(retryStart, retryEnd);
    const acceptStart = main.indexOf('ipcMain.handle("coldBoot:useThisServerAnyway"');
    const acceptEnd = main.indexOf('ipcMain.handle("coldBoot:quit"', acceptStart);
    const acceptHandler = main.slice(acceptStart, acceptEnd);

    expect(main).toContain("type ColdBootLifecycleState");
    for (const handler of [retryHandler, acceptHandler]) {
      expect(handler).toContain('coldBootLifecycle === "resuming" || coldBootLifecycle === "observing"');
      expect(handler).toContain('coldBootBootstrapReady = false');
      expect(handler).toContain("await loadActiveRenderer(bootstrapEntryHref)");
      expect(handler).toContain("return;");
    }
    expect(main).toContain('coldBootLifecycle = "resuming"');
    expect(main).toContain('coldBootLifecycle = "complete"');
  });

  test("explicit wrong-server acceptance proves the displayed identity in one fresh reducer attempt", () => {
    const main = read("electron", "main.ts");
    const acceptStart = main.indexOf('ipcMain.handle("coldBoot:useThisServerAnyway"');
    const acceptEnd = main.indexOf('ipcMain.handle("coldBoot:quit"', acceptStart);
    const acceptHandler = main.slice(acceptStart, acceptEnd);

    expect(acceptHandler).toContain("forceFresh: true");
    expect(acceptHandler).toContain("acceptDisplayedWrongServer: displayed");
    expect(acceptHandler).toContain('proof.kind !== "acceptance-proof"');
    expect(acceptHandler).toContain('attempt?.phase !== "setup"');
    expect(acceptHandler).toContain("fingerprintFromHealthBody(proof.healthBody) !== displayed.observedFingerprint");
    expect(acceptHandler).toContain("prepareProductionAcceptedIdentityColdBootTerminal");
    expect(acceptHandler).toContain("acceptedIdentityColdBootProof = proof");
    expect(acceptHandler).toContain("authority.rollbackAcceptedWrongServer(proof)");
    expect(acceptHandler).not.toContain("authority.commitAcceptedWrongServer(proof)");
    expect(acceptHandler).not.toContain("replaceRecentServerFingerprint");
    expect(acceptHandler).not.toContain("acceptCurrentWrongServer()");
    expect(acceptHandler).not.toContain("isSameWrongServerIdentity");
    expect(main).toContain('shellStateOnBoot = "live"');
    expect(acceptHandler).not.toMatch(/\bfetch\s*\(/);
    expect(acceptHandler).not.toContain("AbortSignal.timeout");
  });

  test("local shell infrastructure is created before waiting on health, queues links before release, and builds unresolved menu", () => {
    const main = read("electron", "main.ts");
    const bootStart = main.indexOf("const bootSession = serverSessions.ensure(serverUrl)");
    const bootEnd = main.indexOf("function resumeQuitAfterPersistence", bootStart);
    expect(bootEnd).toBeGreaterThan(bootStart);
    const boot = main.slice(bootStart, bootEnd);

    expect(main).toContain('runColdBootLaunchGate,');
    expect(main).toContain('from "./cold-boot-lifecycle"');
    expect(boot).toContain("const initialColdBootObservation = launchConnectionCohort");
    expect(boot).toContain(": await runColdBootLaunchGate({");
    expect(main).toContain("function projectVerifiedConnectionCohort(");
    expect(main).toContain(".projectVerifiedCohort({");
    expect(main).toContain("fingerprint: cohort.verified.health.fingerprint,");
    expect(boot).toContain("return projectVerifiedConnectionCohort(launchConnectionCohort);");
    expect(main).toContain("projectVerifiedConnectionCohort(recoveryReplacementCohort);");
    expect(boot).toContain("currentObservation: () => initializeColdBootObservationAuthority().snapshot()");
    expect(boot).toContain("createLocalShell: () => {");
    expect(boot).toContain("createWindow(lastMainWindowLoadUrl)");
    expect(boot).toContain("rebuildApplicationMenu()");
    expect(boot).toContain("observe: () => observeColdBootConnection(serverUrl)");
    expect(boot).toContain("projectRecovery: async () => {");
    const gateIndex = boot.indexOf("const initialColdBootObservation = launchConnectionCohort");
    expect(gateIndex).toBeLessThan(boot.indexOf("await loadBootSetupStatus(serverUrl)"));
    expect(boot.indexOf("await loadBootSetupStatus(serverUrl)")).toBeLessThan(
      boot.indexOf("applyVerifiedLogtoHealthBody("),
    );
    expect(boot.indexOf("applyVerifiedLogtoHealthBody(")).toBeLessThan(
      boot.indexOf("await shouldShowOnboarding(serverUrl)"),
    );
    expect(boot.indexOf("queueInitialDeepLinksOnce();")).toBeLessThan(
      boot.indexOf("releaseVerifiedWorkbenchNavigation(serverUrl)"),
    );
    expect(boot.indexOf("await shouldShowOnboarding(serverUrl)")).toBeLessThan(
      boot.indexOf("releaseVerifiedWorkbenchNavigation(serverUrl)"),
    );
  });

  test("markerless legacy connect config receives only a local authority guard before cold-boot network work", () => {
    const main = read("electron", "main.ts");
    const connectStart = main.indexOf('if (cfg.mode === "connect")');
    const connectEnd = main.indexOf("const bootSession = serverSessions.ensure(serverUrl)", connectStart);
    expect(connectEnd).toBeGreaterThan(connectStart);
    const connect = main.slice(connectStart, connectEnd);
    const bootStart = main.indexOf("const bootSession = serverSessions.ensure(serverUrl)");
    const gateStart = main.indexOf("await runColdBootLaunchGate({", bootStart);

    expect(connect).toContain("configForLegacyConnectionGuard");
    expect(connect).toContain("saveConfig(cfg)");
    expect(connect).toContain("configuredServerUrl = cfg.serverUrl");
    expect(connect).not.toContain("getRecentServerFingerprint");
    expect(main.indexOf("configForLegacyConnectionGuard(cfg)", connectStart)).toBeLessThan(bootStart);
    expect(bootStart).toBeLessThan(gateStart);
  });

  test("source boot installs one exact legacy authority for its selected A and never lets a stale persisted B replace it", () => {
    const main = read("electron", "main.ts");
    const sourceStart = main.indexOf(
      "if (!app.isPackaged && !forceFirstRun && !preferPersistedConnection)",
    );
    const sourceEnd = main.indexOf("} else if (explicitServerUrl", sourceStart);
    const sourceBoot = main.slice(sourceStart, sourceEnd);
    const bootSession = main.indexOf("const bootSession = serverSessions.ensure(serverUrl)");
    const pendingLoad = main.indexOf("connectionPendingStore().load()", bootSession);
    const authorityStart = main.indexOf("function authoritativeConnectionSnapshot()");
    const authorityEnd = main.indexOf("const desktopConnectionTupleBinding", authorityStart);
    const authority = main.slice(authorityStart, authorityEnd);

    expect(sourceStart).toBeGreaterThanOrEqual(0);
    expect(main).toContain(
      'process.env["NAUTILO_PREFER_PERSISTED_CONNECTION"] === "1"',
    );
    expect(sourceBoot).toContain("sourceDevelopmentAuthority = null");
    expect(main.indexOf("installSourceDevelopmentAuthority(bootSession.serverUrl)", bootSession)).toBeGreaterThan(bootSession);
    expect(main.indexOf("installSourceDevelopmentAuthority(bootSession.serverUrl)", bootSession)).toBeLessThan(pendingLoad);
    expect(authority).toContain("if (sourceDevelopmentAuthority) return sourceDevelopmentAuthority");
    expect(authority.indexOf("if (sourceDevelopmentAuthority) return sourceDevelopmentAuthority")).toBeLessThan(
      authority.indexOf("const config = loadConfig()"),
    );
    const commitStart = main.indexOf("function commitDesktopConnectionAuthority(");
    const commitEnd = main.indexOf("const desktopConnectionTupleBinding", commitStart);
    const commit = main.slice(commitStart, commitEnd);
    expect(commit).toContain("authoritativeConnectionSnapshot()");
    expect(commit).toContain("sourceDevelopmentAuthority = committedAuthority");
    expect(commit).toContain("projectActiveAuthority(committedConfig)");
    expect(main).toContain("commitActiveAuthority: commitDesktopConnectionAuthority");
    expect(main).toContain("commitAcceptedConfig: commitDesktopConnectionAuthority");

    const staleB = {
      scope: "https://stale-b.test", revision: "revision-b",
      connectionAttemptId: "attempt-b", serverFingerprint: "fingerprint-b",
    };
    const firstSourceRun = sourceDevelopmentAuthorityHarness(staleB);
    firstSourceRun.installSourceDevelopmentAuthority("http://127.0.0.1:3201/");
    expect(firstSourceRun.authoritativeConnectionSnapshot()).toEqual({
      scope: "http://127.0.0.1:3201",
      revision: "dev-fixed-uuid",
      connectionAttemptId: "legacy-dev-fixed-uuid",
      serverFingerprint: "trusted-a",
    });
    const restartedSourceRun = sourceDevelopmentAuthorityHarness(staleB);
    restartedSourceRun.installSourceDevelopmentAuthority("http://127.0.0.1:3201/");
    expect(restartedSourceRun.authoritativeConnectionSnapshot().scope).toBe("http://127.0.0.1:3201");
  });

  test("shared authority commit promotes a fresh source boot from A to B", () => {
    const subject = desktopAuthorityCommitHarness({ persistedAuthority: null });
    subject.installSourceDevelopmentAuthority("http://127.0.0.1:3201/");
    const prior = subject.authoritativeConnectionSnapshot();

    expect(subject.commitDesktopConnectionAuthority({
      routingServerUrl: "http://127.0.0.1:3201/",
      attemptId: "attempt-b",
      serverFingerprint: "fingerprint-b",
      priorAuthorityGuard: prior,
    })).toBe(true);
    expect(subject.saved).toHaveLength(1);
    expect(subject.authoritativeConnectionSnapshot()).toEqual({
      scope: "http://127.0.0.1:3201",
      revision: "revision-attempt-b",
      connectionAttemptId: "attempt-b",
      serverFingerprint: "fingerprint-b",
    });
  });

  test("shared authority commit rejects a stale guard without persisting", () => {
    const authorityA: TestActiveAuthority = {
      scope: "https://alpha.test",
      revision: "revision-a",
      connectionAttemptId: "attempt-a",
      serverFingerprint: "fingerprint-a",
    };
    const subject = desktopAuthorityCommitHarness({ persistedAuthority: authorityA });

    expect(subject.commitDesktopConnectionAuthority({
      routingServerUrl: "https://alpha.test",
      attemptId: "attempt-b",
      serverFingerprint: "fingerprint-b",
      priorAuthorityGuard: { ...authorityA, revision: "stale-revision" },
    })).toBe(false);
    expect(subject.saved).toEqual([]);
    expect(subject.authoritativeConnectionSnapshot()).toEqual(authorityA);
  });

  test("failed source authority persistence leaves process-local A active", () => {
    const subject = desktopAuthorityCommitHarness({ persistedAuthority: null, saveThrows: true });
    subject.installSourceDevelopmentAuthority("http://127.0.0.1:3201/");
    const prior = subject.authoritativeConnectionSnapshot();

    expect(() => subject.commitDesktopConnectionAuthority({
      routingServerUrl: "http://127.0.0.1:3201/",
      attemptId: "attempt-b",
      serverFingerprint: "fingerprint-b",
      priorAuthorityGuard: prior,
    })).toThrow("disk write failed");
    expect(subject.saved).toEqual([]);
    expect(subject.authoritativeConnectionSnapshot()).toEqual(prior);
  });

  test("shared authority commit preserves the packaged persisted-config path", () => {
    const authorityA: TestActiveAuthority = {
      scope: "https://alpha.test",
      revision: "revision-a",
      connectionAttemptId: "attempt-a",
      serverFingerprint: "fingerprint-a",
    };
    const subject = desktopAuthorityCommitHarness({ persistedAuthority: authorityA });

    expect(subject.commitDesktopConnectionAuthority({
      routingServerUrl: "https://alpha.test/base",
      attemptId: "attempt-b",
      serverFingerprint: "fingerprint-b",
      priorAuthorityGuard: authorityA,
    })).toBe(true);
    expect(subject.saved).toHaveLength(1);
    expect(subject.authoritativeConnectionSnapshot()).toEqual({
      scope: "https://alpha.test",
      revision: "revision-attempt-b",
      connectionAttemptId: "attempt-b",
      serverFingerprint: "fingerprint-b",
    });
  });

  test("only an explicit verified-release intent may consume either bootstrap ERR_ABORTED", async () => {
    const main = read("electron", "main.ts");
    const helperStart = main.indexOf("function isExpectedBootstrapSupersession");
    const helperEnd = main.indexOf("function workbenchBackgroundColor", helperStart);
    const helper = main.slice(helperStart, helperEnd);
    const createWindowStart = main.indexOf("function createWindow(");
    const createWindowEnd = main.indexOf("function constructServerSessionView", createWindowStart);
    expect(createWindowEnd).toBeGreaterThan(createWindowStart);
    const createWindow = main.slice(createWindowStart, createWindowEnd);

    expect(helper).toContain("errorCode === -3");
    expect(helper).toContain("intent.requestedUrl !== connectBootstrapEntryHref");
    expect(helper).toContain("verifiedBootstrapRelease");
    expect(helper).toContain("release.epoch < intent.releaseEpochAtRequest");
    expect(helper).toContain("coldBootBootstrapReady");
    expect(createWindow).toContain("loadRendererUrl(view.webContents, url)");
    expect(main).toContain("return loadRendererUrl(renderer, url)");

    const bootstrap = "file:///bundle/bootstrap.html";
    const release = { epoch: 1, origin: "http://127.0.0.1:3201" };
    // The original local-shell request started before release. Chromium may
    // reject it before getURL() reflects the remote redirect.
    expect(bootstrapSupersessionClassifier({
      error: { code: -3 }, requestedUrl: bootstrap, releaseEpochAtRequest: 0,
      connectBootstrapEntryHref: bootstrap, coldBootBootstrapReady: true,
      verifiedWorkbenchOrigin: "http://127.0.0.1:3201",
      verifiedBootstrapRelease: release,
    })).toBe(true);
    // The post-release `await loadActiveRenderer(bootstrap)` makes a second
    // bootstrap request. Its own redirect may reject before Workbench commits.
    expect(bootstrapSupersessionClassifier({
      error: { code: -3 }, requestedUrl: bootstrap, releaseEpochAtRequest: 1,
      connectBootstrapEntryHref: bootstrap, coldBootBootstrapReady: true,
      verifiedWorkbenchOrigin: "http://127.0.0.1:3201",
      verifiedBootstrapRelease: release,
    })).toBe(true);
    expect(bootstrapSupersessionClassifier({
      error: { code: -3 }, requestedUrl: "file:///bundle/other.html", releaseEpochAtRequest: 1,
      connectBootstrapEntryHref: bootstrap, coldBootBootstrapReady: true,
      verifiedWorkbenchOrigin: "http://127.0.0.1:3201",
      verifiedBootstrapRelease: release,
    })).toBe(false);
    expect(bootstrapSupersessionClassifier({
      error: { code: -3 }, requestedUrl: bootstrap, releaseEpochAtRequest: 1,
      connectBootstrapEntryHref: bootstrap, coldBootBootstrapReady: true,
      verifiedWorkbenchOrigin: "http://attacker.test",
      verifiedBootstrapRelease: release,
    })).toBe(false);
    expect(bootstrapSupersessionClassifier({
      error: new Error("ordinary load failure"), requestedUrl: bootstrap, releaseEpochAtRequest: 1,
      connectBootstrapEntryHref: bootstrap, coldBootBootstrapReady: true,
      verifiedWorkbenchOrigin: "http://127.0.0.1:3201",
      verifiedBootstrapRelease: release,
    })).toBe(false);
    expect(bootstrapSupersessionClassifier({
      error: { code: -3 }, requestedUrl: bootstrap, releaseEpochAtRequest: 1,
      connectBootstrapEntryHref: bootstrap, coldBootBootstrapReady: false,
      verifiedWorkbenchOrigin: "http://127.0.0.1:3201",
      verifiedBootstrapRelease: release,
    })).toBe(false);

    let rejectInitial!: (error: unknown) => void;
    const initialPromise = new Promise<void>((_resolve, reject) => { rejectInitial = reject; });
    const initialLoad = bootstrapLoadHarness({
      connectBootstrapEntryHref: bootstrap, coldBootBootstrapReady: true,
      verifiedWorkbenchOrigin: "http://127.0.0.1:3201", verifiedBootstrapRelease: null,
    });
    const beforeRelease = initialLoad.loadRendererUrl({ loadURL: () => initialPromise }, bootstrap);
    initialLoad.setRelease(release);
    rejectInitial({ code: -3 });
    await expect(beforeRelease).resolves.toBeUndefined();

    const postRelease = bootstrapLoadHarness({
      connectBootstrapEntryHref: bootstrap, coldBootBootstrapReady: true,
      verifiedWorkbenchOrigin: "http://127.0.0.1:3201", verifiedBootstrapRelease: release,
    });
    await expect(postRelease.loadRendererUrl({ loadURL: () => Promise.reject({ code: -3 }) }, bootstrap))
      .resolves.toBeUndefined();
  });

  test("runtime deep links queue during local recovery and direct-send only to the verified Workbench", () => {
    const main = read("electron", "main.ts");
    const forwardStart = main.indexOf("function forwardDeepLinkToRenderer");
    const forwardEnd = main.indexOf("function drainPendingDeepLinks", forwardStart);
    const forward = main.slice(forwardStart, forwardEnd);
    const finishLoadStart = main.indexOf('view.webContents.on("did-finish-load"');
    const finishLoadEnd = main.indexOf('view.webContents.once("destroyed"', finishLoadStart);
    const finishLoad = main.slice(finishLoadStart, finishLoadEnd);

    expect(main).toContain("function isVerifiedWorkbenchRenderer");
    expect(main).toContain("new URL(renderer.getURL()).origin === verifiedWorkbenchOrigin");
    expect(forward).toContain("isVerifiedWorkbenchRenderer(renderer)");
    expect(forward).toContain("pendingDeepLinks.push(link)");
    expect(finishLoad).toContain("new URL(view.webContents.getURL()).origin !== verifiedWorkbenchOrigin");
    expect(finishLoad).toContain("drainPendingDeepLinks()");
  });

  test("auth diagnostics reflect actual Logto projection changes", () => {
    const main = read("electron", "main.ts");
    expect(main).toContain("const hadLogtoBeforeResolution = logtoConfig() !== null");
    expect(main).toContain("stateChanged: hadLogtoBeforeResolution !== (logtoConfig() !== null)");
  });

  test("active-server and auth-projection transitions coalesce one menu rebuild for the final state", () => {
    const main = read("electron", "main.ts");
    const transitionStart = main.indexOf("function refreshMenuForActiveServerTransition");
    const transitionEnd = main.indexOf("/** Phase 1 compatibility seam", transitionStart);
    const transition = main.slice(transitionStart, transitionEnd);
    const rebuildStart = main.indexOf("function rebuildApplicationMenu");
    const rebuildEnd = main.indexOf("function loadWindowState", rebuildStart);
    expect(rebuildEnd).toBeGreaterThan(rebuildStart);
    const rebuild = main.slice(rebuildStart, rebuildEnd);

    expect(main).toContain('if (!active) return "no-active-server"');
    expect(main).toContain('active.logtoConfig ? "logto-ready" : "logto-unresolved"');
    expect(main).toContain('active.signedIn ? "signed-in" : "signed-out"');
    expect(transition).toContain("nextProjectionKey === renderedMenuAuthProjectionKey");
    expect(transition).toContain("if (menuAuthRebuildQueued) return");
    expect(transition).toContain("queueMicrotask");
    expect(transition).toContain("activeMenuAuthProjectionKey() === renderedMenuAuthProjectionKey");
    expect(transition).toContain("rebuildApplicationMenu()");
    expect(rebuild).toContain("renderedMenuAuthProjectionKey = activeMenuAuthProjectionKey()");
    expect(main).toMatch(
      /serverSessions\.onChange\(\(\) => \{\s*companionWindows\.reconcile\(\);\s*refreshMenuForActiveServerTransition\(\)/,
    );
  });

  test("A-ready → B-unresolved → B-ready and single-server → no-active each require a new projection", () => {
    const aReady = menuProjectionKey({ scope: "A", hasLogto: true, signedIn: true });
    const bUnresolved = menuProjectionKey({ scope: "B", hasLogto: false, signedIn: false });
    const bReady = menuProjectionKey({ scope: "B", hasLogto: true, signedIn: false });
    const noActive = menuProjectionKey(null);

    expect(aReady).not.toBe(bUnresolved);
    expect(bUnresolved).not.toBe(bReady);
    expect(aReady).not.toBe(noActive);
    expect(menuProjectionKey(null)).toBe("no-active-server");
  });

  test("ordinary boot uses one idempotent finalizer in the preserved release order", () => {
    const main = read("electron", "main.ts");
    const bootStart = main.indexOf("async function boot()");
    const boot = main.slice(bootStart, main.indexOf("app.setAboutPanelOptions", bootStart));

    for (const helper of ["registerOnboardingOpenHandler", "queueInitialDeepLinksOnce", "finishReleasedDesktopBoot"]) {
      expect(main.match(new RegExp(`function ${helper}\\b`, "g"))?.length).toBe(1);
      expect(boot.match(new RegExp(`${helper}\\(`, "g"))?.length).toBe(1);
    }
    expect(main).toContain("if (onboardingOpenHandlerRegistered) return;");
    expect(main).toContain("if (initialDeepLinksQueued) return;");
    expect(main).toContain("if (releasedDesktopBootFinalizer) return releasedDesktopBootFinalizer;");
    expect(main).toContain("if (!tray) createTray();");
    expect(main).toContain("if (productionUpdaterFeedEnabled && !releasedDesktopBootUpdaterStarted)");
    expect(main).toContain("if (!releasedDesktopBootActivateHandlerRegistered)");
    expect(main).toContain("if (releasedDesktopBootFinalizer === finalizer)");
    expect(main).toContain("releasedDesktopBootFinalizer = null;");
    expect(boot.indexOf("registerOnboardingOpenHandler();")).toBeLessThan(boot.indexOf("queueInitialDeepLinksOnce();"));
    expect(boot.indexOf("queueInitialDeepLinksOnce();")).toBeLessThan(boot.indexOf("releaseVerifiedWorkbenchNavigation(serverUrl)"));
    expect(boot.indexOf("releaseVerifiedWorkbenchNavigation(serverUrl)")).toBeLessThan(boot.indexOf("await finishReleasedDesktopBoot(serverUrl);"));
    const release = boot.indexOf("releaseVerifiedWorkbenchNavigation(serverUrl)");
    expect(boot.indexOf("await finishReleasedDesktopBoot(serverUrl);", release))
      .toBeLessThan(boot.indexOf("await loadActiveRenderer(bootstrapEntryHref);", release));
  });
});
