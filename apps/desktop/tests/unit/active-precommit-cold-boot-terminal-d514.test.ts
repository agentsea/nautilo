import { describe, expect, test } from "bun:test";
import {
  prepareActivePrecommitColdBootTerminal,
  type ActivePrecommitColdBootTerminalPorts,
} from "../../electron/active-precommit-cold-boot-terminal";
import type { ActiveAuthority, PendingConnection, PendingConnectionLoadResult } from "../../electron/pending-connection";
import type { VerifiedConnectionCohort } from "../../electron/desktop-connection-flow";

const a = "https://a.nautilo.test";
const b = "https://b.nautilo.test";
const authority: Extract<ActiveAuthority, { scope: string }> = {
  scope: a, revision: "revision-a", connectionAttemptId: "attempt-a", serverFingerprint: "fingerprint-a",
};
const pending: PendingConnection = {
  version: 2, tupleBinding: "tuple", attemptId: "attempt-b", context: "cold-boot", generation: 4,
  enteredTarget: b, candidateOrigin: b, activeScopeGuard: a, activeRevisionGuard: "revision-a",
  lastProgressPhase: "health", handoffCheckpoint: "candidate", postCommitCheckpoint: null,
  identityTransition: { kind: "ordinary" },
};
const loaded: Extract<PendingConnectionLoadResult, { disposition: "precommit" }> = { disposition: "precommit", pending };
const verified: VerifiedConnectionCohort = {
  url: b,
  health: {
    answeringOrigin: b, body: { status: "ok" }, fingerprint: "fingerprint-b",
    logtoConfig: { endpoint: "https://login.b.test", appId: "desktop-b", resource: `${b}/api` }, observedAtMs: 1,
  },
  setup: { observedAtMs: 2, state: "ready", raw: { setupState: "ready" } }, authDiscoveredAtMs: 3,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function fixture(overrides: Partial<ActivePrecommitColdBootTerminalPorts> = {}) {
  const states: string[] = [];
  const calls: string[] = [];
  let current: ActiveAuthority = authority;
  let next = deferred<Awaited<ReturnType<ActivePrecommitColdBootTerminalPorts["connect"]>>>();
  let cohort: VerifiedConnectionCohort | null = verified;
  let cancellable = true;
  const ports: ActivePrecommitColdBootTerminalPorts = {
    loadPending: () => { calls.push("pending"); return loaded; },
    projectPrecommit: () => ({
      disposition: "precommit", action: "fresh-attempt", context: "cold-boot", enteredTarget: b,
      priorActiveScope: a, priorRecoveryGuard: { scope: a, revision: "revision-a" }, restartPhase: "normalizing",
      requiresFreshAttemptAndGeneration: true,
    }),
    currentAuthority: () => current,
    connect: async (target) => { calls.push(`connect:${target}`); return next.promise; },
    takeVerifiedCohort: (url) => url === b ? cohort : null,
    cancel: () => { calls.push("cancel"); return cancellable; },
    pairToDifferentServer: async () => ({ kind: "cancelled" as const }),
    onState: (state) => states.push(`${state.phase}:${state.canRetry}`),
    ...overrides,
  };
  return {
    ports, calls, states,
    setAuthority: (value: ActiveAuthority) => { current = value; },
    setCancellable: (value: boolean) => { cancellable = value; },
    setCohort: (value: VerifiedConnectionCohort | null) => { cohort = value; },
    resolveConnect: (value: Awaited<ReturnType<ActivePrecommitColdBootTerminalPorts["connect"]>>) => next.resolve(value),
    nextConnect: () => { next = deferred(); },
  };
}

describe("D514 active precommit cold-boot terminal", () => {
  test("ignores no journal, committed journal, and initial precommit", () => {
    for (const result of [
      { disposition: "none" as const },
      { disposition: "committed-handoff" as const, pending: { ...pending, handoffCheckpoint: "active-committed" as const } },
    ]) {
      const f = fixture({ loadPending: () => result });
      expect(prepareActivePrecommitColdBootTerminal(f.ports)).toBeNull();
    }
    const f = fixture({ projectPrecommit: () => ({
      disposition: "precommit", action: "fresh-attempt", context: "initial", enteredTarget: b,
      priorActiveScope: null, priorRecoveryGuard: { scope: null, revision: null }, restartPhase: "normalizing",
      requiresFreshAttemptAndGeneration: true,
    }) });
    expect(prepareActivePrecommitColdBootTerminal(f.ports)).toBeNull();
    const incoherent = fixture({ projectPrecommit: () => ({
      disposition: "precommit", action: "fresh-attempt", context: "cold-boot", enteredTarget: b,
      priorActiveScope: a, priorRecoveryGuard: { scope: "https://other.nautilo.test", revision: "revision-a" },
      restartPhase: "normalizing", requiresFreshAttemptAndGeneration: true,
    }) });
    expect(prepareActivePrecommitColdBootTerminal(incoherent.ports)).toBeNull();
  });

  test("rejects active guard drift before the retained flow connects", async () => {
    const f = fixture();
    f.setAuthority({ scope: a, revision: "revision-new", connectionAttemptId: "attempt-a", serverFingerprint: "fingerprint-a" });
    const terminal = prepareActivePrecommitColdBootTerminal(f.ports)!;
    expect(terminal.recoveryTarget).toBe(b);
    expect(terminal.priorActiveScope).toBe(a);
    void terminal.launch();
    await Promise.resolve();
    expect(f.calls).toEqual(["pending"]);
    expect(terminal.snapshot()).toEqual({ phase: "recoverable", canRetry: true });
    f.setAuthority(authority);
    f.nextConnect();
    const retry = terminal.retry();
    await Promise.resolve();
    expect(f.calls).toEqual(["pending", `connect:${b}`]);
    f.resolveConnect({ ok: true, url: b });
    await retry;
    expect(terminal.snapshot()).toEqual({ phase: "released", canRetry: false });
  });

  test("keeps local recovery pending through delayed failure, then retries into one verified cohort", async () => {
    const f = fixture();
    const terminal = prepareActivePrecommitColdBootTerminal(f.ports)!;
    let launched = false;
    const launch = terminal.launch().then((value) => { launched = true; return value; });
    await Promise.resolve();
    expect(f.calls).toEqual(["pending", `connect:${b}`]);
    expect(launched).toBeFalse();
    f.resolveConnect({ ok: false, reason: "offline" });
    await Bun.sleep(0);
    expect(terminal.snapshot()).toEqual({ phase: "recoverable", canRetry: true });
    expect(launched).toBeFalse();
    f.nextConnect();
    const retry = terminal.retry();
    await Promise.resolve();
    f.resolveConnect({ ok: true, url: b });
    await retry;
    await expect(launch).resolves.toEqual({ kind: "candidate", cohort: verified });
    expect(f.calls).toEqual(["pending", `connect:${b}`, `connect:${b}`]);
  });

  test("coalesces duplicate Retry and fences a late pre-cancel completion", async () => {
    const f = fixture();
    const terminal = prepareActivePrecommitColdBootTerminal(f.ports)!;
    void terminal.launch();
    await Promise.resolve();
    const retryOne = terminal.retry();
    const retryTwo = terminal.retry();
    await Promise.resolve();
    expect(f.calls).toEqual(["pending", `connect:${b}`]);
    const pair = terminal.pairToDifferentServer();
    await expect(pair).resolves.toEqual({ ok: false, reason: "cancelled" });
    f.resolveConnect({ ok: true, url: b });
    await Promise.all([retryOne, retryTwo]);
    expect(terminal.snapshot()).toEqual({ phase: "released", canRetry: false });
  });

  test("Pair only proceeds after precommit cancellation, and picker success releases its exact cohort", async () => {
    const f = fixture({ pairToDifferentServer: async () => ({ kind: "candidate" as const, cohort: verified }) });
    const terminal = prepareActivePrecommitColdBootTerminal(f.ports)!;
    const launch = terminal.launch();
    await Promise.resolve();
    await expect(terminal.pairToDifferentServer()).resolves.toEqual({ ok: true, url: b });
    await expect(launch).resolves.toEqual({ kind: "candidate", cohort: verified });

    const blocked = fixture();
    blocked.setCancellable(false);
    const blockedTerminal = prepareActivePrecommitColdBootTerminal(blocked.ports)!;
    await expect(blockedTerminal.pairToDifferentServer()).resolves.toEqual({ ok: false, reason: "handoff-pending" });
    expect(blocked.calls).toEqual(["pending", "cancel"]);
  });

  test("failed picker stays recoverable; only its actual cancellation resumes A", async () => {
    let picker: "failed" | "cancelled" = "failed";
    const f = fixture({ pairToDifferentServer: async () => ({ kind: picker }) });
    const terminal = prepareActivePrecommitColdBootTerminal(f.ports)!;
    let launched = false;
    const launch = terminal.launch().then((value) => { launched = true; return value; });
    await Promise.resolve();
    await expect(terminal.pairToDifferentServer()).resolves.toEqual({ ok: false, reason: "promotion-failed" });
    expect(terminal.snapshot()).toEqual({ phase: "recoverable", canRetry: true });
    expect(launched).toBeFalse();
    picker = "cancelled";
    await expect(terminal.pairToDifferentServer()).resolves.toEqual({ ok: false, reason: "cancelled" });
    await expect(launch).resolves.toEqual({ kind: "prior-active" });
  });

  test("an open Pair picker coalesces duplicate Pair and makes Retry inert", async () => {
    const picker = deferred<Awaited<ReturnType<ActivePrecommitColdBootTerminalPorts["pairToDifferentServer"]>>>();
    const f = fixture({ pairToDifferentServer: () => picker.promise });
    const terminal = prepareActivePrecommitColdBootTerminal(f.ports)!;
    const launch = terminal.launch();
    await Promise.resolve();
    const firstPair = terminal.pairToDifferentServer();
    const duplicatePair = terminal.pairToDifferentServer();
    expect(duplicatePair).toBe(firstPair);
    await terminal.retry();
    expect(f.calls).toEqual(["pending", `connect:${b}`, "cancel"]);
    picker.resolve({ kind: "cancelled" });
    await expect(firstPair).resolves.toEqual({ ok: false, reason: "cancelled" });
    await expect(launch).resolves.toEqual({ kind: "prior-active" });
  });

  test("a cancellation dependency failure remains locally recoverable", async () => {
    const f = fixture({ cancel: () => { throw new Error("cancel failed"); } });
    const terminal = prepareActivePrecommitColdBootTerminal(f.ports)!;
    await expect(terminal.pairToDifferentServer()).resolves.toEqual({
      ok: false,
      reason: "promotion-failed",
    });
    expect(terminal.snapshot()).toEqual({ phase: "recoverable", canRetry: true });
  });

  for (const changed of [true, "unknown"] as const) {
    test(`a ${changed} promotion outcome cannot cancel and Retry reuses the retained flow`, async () => {
      const f = fixture();
      const terminal = prepareActivePrecommitColdBootTerminal(f.ports)!;
      void terminal.launch();
      await Promise.resolve();
      f.resolveConnect({ ok: false, reason: "promotion-failed", authoritativePairingChanged: changed });
      await Bun.sleep(0);
      f.setCancellable(false);
      await expect(terminal.pairToDifferentServer()).resolves.toEqual({ ok: false, reason: "handoff-pending" });
      f.nextConnect();
      const retry = terminal.retry();
      await Promise.resolve();
      f.resolveConnect({ ok: true, url: b });
      await retry;
      expect(f.calls).toEqual(["pending", `connect:${b}`, "cancel", `connect:${b}`]);
    });
  }
});
