import { developerWorkstationSeedProfile, resolveDeveloperWorkstationSeed } from "../../electron/workstation-profiles/developer-workstation-seed";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { developmentProfileScope, projectAgentAccess, selectionForAgentAccess, selectionForReadyComponents, type AgentAccessObservation } from "../../electron/agent-access";
import { createReadyToWorkDesiredState, parseReadyToWorkComponentSelection } from "../../electron/ready-to-work-contract";

const binding = { humanId: "human", authority: { scope: "https://server.example", serverFingerprint: "fingerprint", revision: "revision", connectionAttemptId: "attempt" } };
const components = { voice: true, auto_approve: true, workstation: true, computer_use: true, coding_connection: true };
const desired = createReadyToWorkDesiredState(binding, components);
const observation: AgentAccessObservation = { desired: null, persistenceUnavailable: false, authenticated: true, connected: true,
  commandAvailable: true, ptyAvailable: true, developmentReady: false, developmentReason: null, fullMac: { state: "inactive", eligible: true }, fullMacOneShot: false };

test("narrow first Development choice enables only workstation; subsequent choices preserve unrelated owners", () => {
  expect(selectionForAgentAccess(null, "development")).toEqual({ voice: false, auto_approve: false, workstation: true, computer_use: false, coding_connection: false });
  expect(selectionForAgentAccess(desired, "basic")).toEqual({ ...components, workstation: false });
  expect(selectionForReadyComponents(desired, { voice: false, auto_approve: false, computer_use: false, coding_connection: false }).workstation).toBe(true);
  expect(parseReadyToWorkComponentSelection(components)).toBeNull();
});

test("readiness requires acknowledged availability and keeps saved choice separate from disconnection", () => {
  expect(projectAgentAccess(observation)).toMatchObject({ sandboxedChoice: "basic", readiness: "ready", capabilities: { commands: true, fullMacOneShot: false } });
  expect(projectAgentAccess({ ...observation, commandAvailable: false })).toMatchObject({ readiness: "needs_attention", reason: "managed_execution_unavailable" });
  expect(projectAgentAccess({ ...observation, desired, connected: false })).toMatchObject({ sandboxedChoice: "development", readiness: "reconnecting", capabilities: { commands: false } });
  expect(projectAgentAccess({ ...observation, desired, developmentReason: "workstation_profile_update_needed" })).toMatchObject({ repairAction: "review_development" });
  expect(projectAgentAccess({ ...observation, persistenceUnavailable: true })).toMatchObject({ sandboxedChoice: null, choiceReason: "saved_state_unavailable" });
  expect(projectAgentAccess({ ...observation, fullMac: { state: "unconfirmed", eligible: false } })).toMatchObject({ readiness: "needs_attention", fullMac: { state: "unconfirmed" } });
});

// Run the actual main-process projection with the existing owners substituted.
// This catches async identity and source-failure behavior beyond pure DTO tests.
const main = readFileSync(new URL("../../electron/main.ts", import.meta.url), "utf8");
const start = main.indexOf("async function agentAccessStatusForSender(");
const end = main.indexOf('ipcMain.handle("readyToWork:getAgentAccess"', start);
const code = new Bun.Transpiler({ loader: "ts" }).transformSync(main.slice(start, end));
function fixture() {
  const renderer = { isDestroyed: () => false };
  const session = {};
  let active = session;
  let resolveBinding = async () => binding;
  let observe = async () => ({ state: "ready", reason: null });
  let saved: typeof desired | null = desired;
  const scope = { assertMainWindowSender() {}, resolveSessionFromSender: () => session, activeRenderer: () => renderer,
    serverSessions: { get active() { return active; } }, miniAppRecoveryAuthGeneration: 0, readyToWorkGeneration: 0,
    projectAgentAccess, resolveReadyToWorkBinding: () => resolveBinding(), readyToWorkPersistence: { retryStatus() {}, attention: () => null },
    readyRemembered: { loadFor: () => saved }, observeReadyWorkstation: () => observe(), getRelayStatus: () => "connected",
    readUncontainedHostCommandsStatus: async () => ({ confirmed: true, active: false, eligible: true }), readyBindingIsCurrent: () => active === session,
    getAcknowledgedLocalExecutionCapabilities: () => ({ canExecuteLocal: true, localExecution: { pty: true }, workstationProfileSnapshot: { profileId: "dev", profileRevision: 1 } }),
    activeWorkstationProfileController: { getActiveSession: () => ({ profileId: "dev", profileRevision: 1 }) },
  };
  const read = runInNewContext(`${code}; agentAccessStatusForSender`, scope) as (event: unknown) => Promise<ReturnType<typeof projectAgentAccess>>;
  return { read: () => read({ sender: renderer }), changeSession: () => { active = {}; },
    bindingFailure: () => { resolveBinding = async () => { throw new Error("offline"); }; },
    observationFailure: () => { observe = async () => { throw new Error("offline"); }; },
    pendingObservation: (wait: Promise<void>) => { observe = async () => { await wait; return { state: "ready", reason: null }; }; },
    noSaved: () => { saved = null; } };
}

test("main never invents Basic if exact identity could not be resolved", async () => {
  const f = fixture(); f.bindingFailure();
  expect(await f.read()).toMatchObject({ sandboxedChoice: null, readiness: "needs_attention" });
});
test("main preserves known Development when a subsequent owner status request fails", async () => {
  const f = fixture(); f.observationFailure();
  expect(await f.read()).toMatchObject({ sandboxedChoice: "development", readiness: "needs_attention" });
});
test("main suppresses the old account projection after an awaited observation", async () => {
  const f = fixture(); let release!: () => void;
  f.pendingObservation(new Promise<void>(resolve => { release = resolve; }));
  const reading = f.read(); await Promise.resolve(); f.changeSession(); release();
  expect(await reading).toMatchObject({ sandboxedChoice: null, capabilities: { commands: false } });
});
test("main confirms Development only from matching acknowledged profile and live owner", async () => {
  expect(await fixture().read()).toMatchObject({ sandboxedChoice: "development", readiness: "ready", capabilities: { commands: true } });
});

const enrollmentStart = main.indexOf("async function enrollReadyToWork(");
const enrollmentEnd = main.indexOf('ipcMain.handle("readyToWork:enroll"', enrollmentStart);
const enrollmentCode = new Bun.Transpiler({ loader: "ts" }).transformSync(main.slice(enrollmentStart, enrollmentEnd));
function enrollmentFixture(initial: typeof desired | null = desired) {
  let saved = initial; let activations = 0; let computerUse = 0; let proofWrites = 0;
  let beforePin = async () => {}; let beforeQueue = async () => {};
  const deps = {
    ipcRecord: (value: unknown) => value, parseReadyToWorkComponentSelection,
    parseReadyToWorkSelection: (value: unknown) => value,
    readyToWorkGeneration: 0, readyToWorkCleanupPromise: Promise.resolve(),
    readyToWorkOperationQueue: { run: async (operation: () => Promise<unknown>) => { await beforeQueue(); return operation(); } },
    resolveReadyToWorkBinding: async () => binding, resolveSessionFromSender: () => ({ serverUrl: binding.authority.scope }),
    readyRemembered: { assertWritable() {}, previousFor: () => saved, loadFor: () => saved,
      readReceipt: () => ({ ok: false }),
      save: (value: typeof desired) => { saved = value; proofWrites++; }, saveComponents: (value: typeof desired) => { saved = value; } },
    selectionForAgentAccess, selectionForReadyComponents,
    readyToWorkPersistence: { attention: () => null, recordFailure() {} },
    safeStorage: {}, isReadyToWorkStorageProtected: () => true,
    readyToWorkProfileSelectors: async () => ({ ok: true, profileId: "dev", profileRevision: 1 }),
    activeWorkstationProfileController: { getActiveSession: () => null },
    activateStoredWorkstationProfile: async () => { activations++; return { ok: true, data: { summary: { profileId: "dev", profileRevision: 1 }, startupReceipt: "synthetic-proof" } }; },
    verifyReadyEnrollmentPin: () => beforePin(), enableReadyComputerUseDuringEnrollment: async () => { computerUse++; return true; },
    readyBindingIsCurrent: () => true, readyToWorkActiveBindingMatches: async () => true,
    disableReadyWorkstationOwner: async () => {}, disableReadyComputerUseOwner: async () => {},
    createReadyToWorkDesiredState, readyToWorkCoordinator: { disable: async () => {} },
    reconcileReadyToWorkNow: async () => ({}), refreshReadyToWorkStatus: async () => ({}), publishReadyToWorkStatus() {},
  };
  const enroll = runInNewContext(`${enrollmentCode}; enrollReadyToWork`, deps) as (e: unknown, request: unknown, target: string, reviewed?: { profileId: string; profileRevision: number }) => Promise<unknown>;
  return { enroll: (selection: unknown, target = "components") => enroll({}, { selection, pin: "123456" }, target, { profileId: "dev", profileRevision: 1 }),
    enrollReviewed: (reviewed: { profileId: string; profileRevision: number }) => enroll({}, { selection: components, pin: "123456" }, "development", reviewed),
    saved: () => saved, counts: () => ({ activations, computerUse, proofWrites }),
    setSaved: (value: typeof desired) => { saved = value; }, waitForQueue: (wait: () => Promise<void>) => { beforeQueue = wait; },
    waitForPin: (wait: () => Promise<void>) => { beforePin = wait; }, invalidate: () => { deps.readyToWorkGeneration++; } };
}
const componentChoice = { voice: false, auto_approve: false, computer_use: false, coding_connection: false };
test("production component enrollment reads Development inside the queue and never activates or rewrites its proof", async () => {
  const f = enrollmentFixture(null); let release!: () => void;
  f.waitForQueue(() => new Promise<void>(resolve => { release = resolve; }));
  const operation = f.enroll(componentChoice); f.setSaved(desired); release(); await operation;
  expect(f.saved()?.components).toEqual({ ...componentChoice, workstation: true });
  expect(f.counts()).toEqual({ activations: 0, computerUse: 0, proofWrites: 0 });
});
test("production narrow Development enrollment preserves other choices without enabling their owners", async () => {
  const f = enrollmentFixture(desired); await f.enroll(components, "development");
  expect(f.saved()?.components).toEqual(components);
  expect(f.counts()).toEqual({ activations: 1, computerUse: 0, proofWrites: 1 });
});
test("production first narrow Development enrollment never borrows aggregate defaults", async () => {
  const f = enrollmentFixture(null); await f.enroll(components, "development");
  expect(f.saved()?.components).toEqual({ ...componentChoice, workstation: true });
});
test("old aggregate enrollment cannot overwrite the keyed access choice", async () => {
  const f = enrollmentFixture();
  const outcome = await f.enroll({ ...components, workstation: false }, "all").then(() => null, (error: Error) => error.message);
  expect(outcome).toContain("Use Agent access"); expect(f.counts().activations).toBe(0);
  await f.enroll({ ...componentChoice, workstation: true }, "all");
  expect(f.counts().proofWrites).toBe(0); expect(f.saved()?.components.workstation).toBe(true);
});
test("Off while component PIN verification waits prevents persistence", async () => {
  const f = enrollmentFixture(); let release!: () => void; let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  f.waitForPin(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
  const operation = f.enroll(componentChoice).then(() => null, (error: Error) => error.message);
  await waiting; f.invalidate(); release();
  expect(await operation).toContain("authority changed"); expect(f.saved()?.components).toEqual(components);
});

const disableStart = main.indexOf("function disableReadyComponentsForSender(");
const disableEnd = main.indexOf('ipcMain.handle("readyToWork:disableComponents"', disableStart);
const disableCode = new Bun.Transpiler({ loader: "ts" }).transformSync(main.slice(disableStart, disableEnd));
test("production component Off preserves Development and fences only component owners even if durable save fails", async () => {
  for (const fail of [false, true]) {
    let saved: typeof desired | null = null; const calls: string[] = []; const session = {};
    const deps = { resolveSessionFromSender: () => session, readyToWorkGeneration: 0, currentReadyBinding: () => binding,
      createReadyToWorkDesiredState, selectionForReadyComponents,
      readyRemembered: { loadFor: () => desired, saveComponents: (value: typeof desired) => { if (fail) throw new Error("disk unavailable"); saved = value; } },
      readyToWorkPersistence: { recordReductionFailure: () => calls.push("attention"), didReduceComponents: () => calls.push("saved") },
      disableReadyComputerUseOwner: async () => { calls.push("computer-use-off"); },
      requestReadyRendererOwners: async (value: unknown) => { expect(value).toEqual({ voice: false, autoApprove: false }); calls.push("renderer-off"); },
      settleReadyCleanup: async (_previous: Promise<void>, work: Promise<unknown>[]) => { await Promise.allSettled(work); },
      readyToWorkCleanupPromise: Promise.resolve(), readyToWorkOperationQueue: { run: (operation: () => Promise<unknown>) => operation() },
      serverSessions: { active: session }, refreshReadyToWorkStatus: async () => ({}), publishReadyToWorkStatus() {},
    };
    const disable = runInNewContext(`${disableCode}; disableReadyComponentsForSender`, deps) as (event: unknown) => Promise<unknown>;
    await disable({});
    expect(calls).toEqual([fail ? "attention" : "saved", "computer-use-off", "renderer-off"]);
    if (!fail) expect(saved).toMatchObject({ components: { ...componentChoice, workstation: true } });
  }
});

const reconcileStart = main.indexOf("async function reconcileReadyToWorkNow(");
const reconcileEnd = main.indexOf("function enabledReadyCodingHarnessStatuses(", reconcileStart);
const reconcileCode = new Bun.Transpiler({ loader: "ts" }).transformSync(main.slice(reconcileStart, reconcileEnd));
test("production component Restore passes only four choices to the existing coordinator and never migrates Development", async () => {
  let reconciled: typeof desired | null = null;
  const deps = { readyToWorkGeneration: 0, readyToWorkCoordinatorBinding: null, createReadyToWorkDesiredState,
    readyRemembered: { loadFor: () => desired, mayMigrate: () => { throw new Error("must not migrate"); } },
    readyToWorkPersistence: { mayRestore: (explicit: boolean) => { expect(explicit).toBe(false); return true; }, attention: () => null },
    readyToWorkActiveBindingMatches: async () => true,
    readyToWorkCoordinator: { reconcile: async (input: { desired: typeof desired; isCurrent(): Promise<boolean> }) => {
      expect(await input.isCurrent()).toBe(true); reconciled = input.desired; return {};
    } }, refreshReadyToWorkStatus: async (value: typeof desired) => value,
  };
  const reconcile = runInNewContext(`${reconcileCode}; reconcileReadyToWorkNow`, deps) as (...args: unknown[]) => Promise<unknown>;
  expect(await reconcile(binding, "explicit_restore", 0, true)).toEqual(desired);
  expect(reconciled).toMatchObject({ components: { ...components, workstation: false } });
});

test("changed reviewed profile selectors refuse Development before any owner activation or write", async () => {
  for (const reviewed of [{ profileId: "other", profileRevision: 1 }, { profileId: "dev", profileRevision: 2 }]) {
    const f = enrollmentFixture(null);
    const error = await f.enrollReviewed(reviewed).then(() => null, (cause: Error) => cause.message);
    expect(error).toContain("Development profile changed"); expect(f.counts()).toEqual({ activations: 0, computerUse: 0, proofWrites: 0 });
  }
});

const reviewStart = main.indexOf("async function prepareDevelopmentReviewForSender(");
const reviewEnd = main.indexOf('ipcMain.handle("workstationProfiles:prepareActivation"', reviewStart);
const reviewCode = new Bun.Transpiler({ loader: "ts" }).transformSync(main.slice(reviewStart, reviewEnd));
test("production review discloses actual stored profile revision and permissions, never stale shipped scope or env values", async () => {
  const seed = developerWorkstationSeedProfile({ home: "/tmp/fixture-home", platform: "linux" });
  const stored = { ...seed, revision: seed.revision + 1, roots: [{ path: "/tmp/explicit-fixture", access: ["read" as const] }],
    network: { mode: "isolated" as const, allow: [] }, toolchainCapabilities: [], environmentKeys: ["SYNTHETIC_KEY_NAME"], capabilities: ["user_environment"] };
  let current = true;
  const deps = { assertMainWindowSender() {}, readyToWorkGeneration: 0, resolveReadyToWorkBinding: async () => binding,
    resolveDeveloperWorkstationSeed,
    materializeSeedProfileForReview: () => ({ ok: true, profile: seed }),
    activeWorkstationProfileController: { getProfileStore: () => ({ get: async () => ({ ok: true, data: { profile: stored } }) }) },
    runSeedDiscoveryReview: async (profile: typeof seed) => { expect(profile).toBe(stored); return { ok: true, review: {} }; },
    readyBindingIsCurrent: () => current, profileIpcFailure: (code: string, message: string) => ({ ok: false, code, message }),
    buildSeedDescriptor: (profile: typeof seed) => ({ id: profile.id, revision: profile.revision, ...(profile.capabilities.includes("user_environment") ? { userEnvironment: true } : {}) }),
    developmentProfileScope, currentFolderPath: "/tmp/current-project", genieWorkspaceRoot: "/tmp/workspace" };
  const review = runInNewContext(`${reviewCode}; prepareDevelopmentReviewForSender`, deps) as (event: unknown) => Promise<unknown>;
  expect(await review({})).toMatchObject({ ok: true, data: { seed: { revision: stored.revision, userEnvironment: true }, scope: {
    currentProject: "/tmp/current-project", roots: stored.roots, network: { mode: "isolated", allow: [] }, environmentKeys: ["SYNTHETIC_KEY_NAME"] } } });
  current = false; expect(await review({})).toMatchObject({ ok: false });
});

test("active managed Full Mac truth exposes one-shot execution rather than interactive input", () => {
  expect(projectAgentAccess({ ...observation, fullMac: { state: "active", eligible: true }, fullMacOneShot: true }))
    .toMatchObject({ readiness: "ready", capabilities: { commands: true, fullMacOneShot: true, interactiveContainedTerminals: false } });
  expect(projectAgentAccess({ ...observation, fullMacOneShot: true })).toMatchObject({ capabilities: { fullMacOneShot: false, interactiveContainedTerminals: true } });
});

const selectorsStart = main.indexOf("async function readyToWorkProfileSelectors(");
const selectorsEnd = main.indexOf("async function activateStoredWorkstationProfile(", selectorsStart);
const selectorsCode = new Bun.Transpiler({ loader: "ts" }).transformSync(main.slice(selectorsStart, selectorsEnd));
test("production seed upgrade requires exact new review and completed PIN verification before compare-and-swap", async () => {
  const seed = developerWorkstationSeedProfile();
  const stored = { ...seed, revision: 1 };
  for (const scenario of ["old-review", "wrong-profile", "bad-pin", "cas-failure", "success"] as const) {
    const events: string[] = [];
    const store = { get: async () => ({ ok: true, data: { profile: stored } }),
      replaceReviewedRevision: async (input: unknown) => {
        events.push("write");
        expect(input).toEqual({
          profileId: seed.id,
          expectedRevision: 1,
          expectedProfile: stored,
          profile: seed,
        });
        return scenario === "cas-failure" ? { ok: false } : { ok: true, data: { profile: seed } };
      } };
    const select = runInNewContext(`${selectorsCode}; readyToWorkProfileSelectors`, {
      materializeSeedProfileForReview: () => ({ ok: true, profile: seed }),
      activeWorkstationProfileController: { getProfileStore: () => store },
      resolveDeveloperWorkstationSeed: () => ({ kind: "shipped_upgrade", previousRevision: 1, reviewProfile: seed }),
    }) as (reviewed: { profileId: string; profileRevision: number }, verify: () => Promise<void>) => Promise<{ ok: boolean }>;
    const reviewed = { profileId: scenario === "wrong-profile" ? "foreign" : seed.id,
      profileRevision: scenario === "old-review" ? 1 : seed.revision };
    const result = await select(reviewed, async () => {
      events.push("pin");
      if (scenario === "bad-pin") throw new Error("invalid PIN");
    }).catch(() => ({ ok: false }));
    expect(result.ok).toBe(scenario === "success");
    expect(events).toEqual(scenario === "old-review" || scenario === "wrong-profile" ? []
      : scenario === "bad-pin" ? ["pin"] : ["pin", "write"]);
  }
});
