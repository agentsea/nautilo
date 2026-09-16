import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DesktopConnectionFlow, rendererSafeConnectionValue, selectPreviousHttpsOrigin, type DesktopConnectionFlowDependencies, type VerifiedHealth } from "../../electron/desktop-connection-flow";
import { createPendingConnectionStore, type ActiveAuthority, type PendingConnection } from "../../electron/pending-connection";
import type { PreparedServerSwitchHandle, ServerSession } from "../../electron/server-sessions/registry";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function harness(overrides: Partial<DesktopConnectionFlowDependencies> = {}) {
  const events: string[] = [];
  const pending: PendingConnection[] = [];
  const prepareInputs: Parameters<DesktopConnectionFlowDependencies["prepare"]>[0][] = [];
  let activeOrigin = "https://a.test";
  const candidate = {
    scope: "b-scope", serverUrl: "https://b.test", partition: "persist:b",
    view: {} as never, logtoConfig: null, signedIn: false, relayActive: false,
    profile: null, connection: "connecting",
  } satisfies ServerSession;
  const handle = {
    attemptId: "attempt-1", generation: 1, canonicalOrigin: "https://b.test",
    targetRegistryScope: candidate.scope, priorRegistryScope: "a-scope",
    priorAuthorityGuard: { scope: "https://a.test", revision: "rev-a", connectionAttemptId: "boot-a" },
    session: candidate, newlyCreatedView: true, navigationReceipt: null,
    status: "prepared", checkpoint: "metadata",
  } as PreparedServerSwitchHandle;
  const health: VerifiedHealth = {
    answeringOrigin: "https://b.test",
    observedAtMs: 20,
    fingerprint: "fingerprint-b",
    logtoConfig: { endpoint: "https://id.test", appId: "desktop", resource: "api" },
    body: { status: "ok", authRequired: true, enrolled: true },
  };
  const deps: DesktopConnectionFlowDependencies = {
    active: () => ({
      authority: { scope: activeOrigin, revision: "rev-a", connectionAttemptId: "boot-a" },
      registryScope: "a-scope",
    }),
    expectedFingerprint: () => "fingerprint-b",
    previousHttpsOrigin: () => null,
    activeRoutingServerUrl: () => activeOrigin,
    savePending: (record) => { pending.push(record); events.push(`journal:${record.handoffCheckpoint}:${record.postCommitCheckpoint}`); },
    clearPending: () => { events.push("journal:clear"); },
    observeReadiness: async () => { events.push("readiness"); return 10; },
    fetchHealth: async () => { events.push("health"); return health; },
    observeSetup: async () => ({ observedAtMs: 21, state: "ready", raw: { setupState: "ready" } }),
    authenticateCandidate: async () => {
      events.push("authenticate");
      return {
        kind: "signed-in",
        persist: () => { events.push("auth:persist"); },
      };
    },
    prepare: async (input) => {
      prepareInputs.push(input);
      events.push(`prepare:${activeOrigin}`);
      return {
        ok: true,
        handle: { ...handle, attemptId: input.attemptId, generation: input.generation,
          identityTransition: input.identityTransition },
        navigationReceipt: {
          attemptId: input.attemptId as never, generation: input.generation,
          origin: input.canonicalOrigin, observedAtMs: 30,
        },
      };
    },
    applyCandidateFacts: (session, observed, options) => {
      events.push(`candidate-facts:${activeOrigin}`);
      events.push(`stored-credentials:${options.allowStoredCredentials}`);
      events.push(`authenticated:${options.authenticatedThisAttempt}`);
      session.logtoConfig = { ...observed.logtoConfig };
      session.signedIn = options.authenticatedThisAttempt;
    },
    retireStoredCandidateIdentity: async (serverUrl) => { events.push(`retire-stored:${serverUrl}`); },
    commitActiveAuthority: ({ canonicalOrigin }) => { events.push("config:commit"); activeOrigin = canonicalOrigin; },
    persistMetadata: async () => { events.push("metadata"); },
    stopOldCodex: async () => { events.push("old-codex"); },
    stopOldRelay: async () => { events.push("old-relay"); },
    deactivateOldProfile: async () => { events.push("old-profile"); },
    retireOldIdentity: async ({ priorRoutingServerUrl }) => { events.push(`retire-old:${priorRoutingServerUrl}`); },
    shouldStartTargetRelay: () => false,
    onActivated: (session) => { events.push(`activated:${session.signedIn}`); },
    promote: async (prepared, hooks) => {
      const committed = await hooks.commitActiveAuthority();
      if (!committed.committed) return { ok: false, reason: "commit-failed" };
      await hooks.persistMetadata(candidate);
      await hooks.persistNextCheckpoint("old-codex");
      await hooks.stopOldCodex(candidate);
      await hooks.persistNextCheckpoint("old-relay");
      await hooks.stopOldRelay(candidate);
      await hooks.persistNextCheckpoint("old-profile");
      await hooks.deactivateOldProfile(candidate);
      if (hooks.retireOldIdentity && prepared.identityTransition.kind === "accepted-identity-replacement") await hooks.retireOldIdentity({
        priorRoutingServerUrl: prepared.identityTransition.priorRoutingServerUrl,
        targetRegistryScope: candidate.scope,
      });
      await hooks.persistNextCheckpoint("pending-clear");
      await hooks.clearPending();
      return { ok: true };
    },
    resolveUnknownCommitOutcome: () => ({ outcome: "unresolved" }),
    mintAttemptId: () => "attempt-1",
    now: () => 25,
    ...overrides,
  };
  return { flow: new DesktopConnectionFlow("tuple", deps), deps, events, pending, prepareInputs, candidate, health, activeOrigin: () => activeOrigin };
}

describe("D514 desktop connection flow", () => {
  test("publishes reducer phases through a redacted monotonic presentation", async () => {
    const snapshots: import("../../electron/connection-presentation").ConnectionPresentation[] = [];
    const h = harness({ onPresentation: (snapshot) => snapshots.push(snapshot) });
    expect((await h.flow.connect("https://b.test", "switch")).ok).toBe(true);
    expect(snapshots.map((snapshot) => snapshot.phase)).toEqual([
      "preparing", "contacting", "waiting-for-server", "verifying-server",
      "verifying-identity", "discovering-setup", "discovering-sign-in",
      "opening-nautilo", "saving-connection", "complete",
    ]);
    expect(snapshots.map((snapshot) => snapshot.revision)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(snapshots.at(-1)).toMatchObject({ pairingStateChange: "changed", validActions: [] });
    expect(JSON.stringify(snapshots)).not.toContain("b.test");
    expect(JSON.stringify(snapshots)).not.toContain("fingerprint-b");
    expect(JSON.stringify(snapshots)).not.toContain("attempt-1");
  });

  test("presentation listeners cannot throw through connection authority", async () => {
    const h = harness({ onPresentation: () => { throw new Error("destroyed renderer"); } });
    expect(await h.flow.connect("https://b.test", "switch")).toEqual({ ok: true, url: "https://b.test" });
  });

  test("required authentication completes before candidate preparation or promotion", async () => {
    const h = harness();
    expect(await h.flow.connect("https://b.test", "add")).toEqual({ ok: true, url: "https://b.test" });
    expect(h.events.indexOf("authenticate")).toBeGreaterThan(-1);
    expect(h.events.indexOf("authenticate")).toBeLessThan(h.events.indexOf("prepare:https://a.test"));
    expect(h.events).toContain("authenticated:true");
    expect(h.candidate.signedIn).toBe(true);
    expect(h.events.indexOf("auth:persist")).toBeGreaterThan(h.events.indexOf("config:commit"));
    expect(h.events.indexOf("auth:persist")).toBeLessThan(h.events.indexOf("metadata"));
    expect(h.events.at(-1)).toBe("activated:true");
  });

  test("carries the selected Workbench theme into candidate authentication", async () => {
    for (const selectedTheme of ["light", "dark"] as const) {
      let receivedTheme: "light" | "dark" | null = null;
      const h = harness({
        authenticateCandidate: async ({ theme }) => {
          receivedTheme = theme;
          return { kind: "signed-in", persist: () => {} };
        },
      });

      expect(await h.flow.connect("https://b.test", "switch", selectedTheme)).toEqual({
        ok: true,
        url: "https://b.test",
      });
      expect(receivedTheme).toBe(selectedTheme);
    }
  });

  test("closing required authentication returns cancelled without preparing or changing A", async () => {
    const h = harness({ authenticateCandidate: async () => ({ kind: "cancelled" }) });
    expect(await h.flow.connect("https://b.test", "add")).toEqual({ ok: false, reason: "cancelled" });
    expect(h.prepareInputs).toHaveLength(0);
    expect(h.events).not.toContain("config:commit");
    expect(h.activeOrigin()).toBe("https://a.test");
    expect(h.pending.at(-1)?.handoffCheckpoint).toBe("candidate");
    expect(h.events.at(-1)).toBe("journal:clear");
  });

  test("invalid input publishes its exact failed reducer state", async () => {
    let presentation: import("../../electron/connection-presentation").ConnectionPresentation | null = null;
    const h = harness({ onPresentation: (snapshot) => { presentation = snapshot; } });
    expect(await h.flow.connect("not a host /", "switch")).toEqual({ ok: false, reason: "invalid-target" });
    expect(presentation).toMatchObject({
      phase: "failed", failureCode: "invalid-target", retrySafe: true,
      pairingStateChange: "unchanged", validActions: ["retry", "edit-target", "cancel"],
    });
  });

  test("active HTTPS authority is downgrade evidence for the same logical host and port", () => {
    expect(selectPreviousHttpsOrigin("http://alpha.example.test:8443", "https://alpha.example.test:8443", [])).toBe(
      "https://alpha.example.test:8443",
    );
    expect(selectPreviousHttpsOrigin("http://alpha.example.test:8444", "https://alpha.example.test:8443", [])).toBeNull();
  });

  test("only a fingerprint-bearing recent HTTPS target is downgrade evidence", () => {
    expect(selectPreviousHttpsOrigin("http://alpha.example.test:8443", null, [
      { url: "https://alpha.example.test:8443", fingerprint: "trusted-fingerprint" },
    ])).toBe("https://alpha.example.test:8443");
    expect(selectPreviousHttpsOrigin("http://alpha.example.test:8443", null, [
      { url: "https://alpha.example.test:8443" },
    ])).toBeNull();
  });

  test("renderer projection strips every identity-shaped field at runtime", () => {
    expect(rendererSafeConnectionValue({
      ok: false,
      reason: "wrong-server",
      fingerprint: "raw",
      expectedFingerprint: "expected",
      observedFingerprint: "observed",
      foundFingerprint: "found",
    })).toEqual({ ok: false, reason: "wrong-server" });
  });

  test("initial connect exposes its exact one-shot main-only facts cohort", async () => {
    const h = harness({
      active: () => ({
        authority: { scope: null, revision: null, connectionAttemptId: null },
        registryScope: null,
      }),
    });
    expect(await h.flow.connect("https://b.test", "initial")).toEqual({ ok: true, url: "https://b.test" });
    const cohort = h.flow.takeVerifiedCohort("https://b.test");
    expect(cohort?.health).toBe(h.health);
    expect(cohort?.setup.raw).toEqual({ setupState: "ready" });
    expect(h.events.filter((event) => event === "health")).toHaveLength(1);
    expect(h.flow.takeVerifiedCohort("https://b.test")).toBeNull();
  });

  test("a later same-origin action publishes only its newly re-proved facts cohort", async () => {
    const h = harness();
    expect((await h.flow.connect("https://b.test", "switch")).ok).toBe(true);
    expect(h.flow.takeVerifiedCohort("https://b.test")).not.toBeNull();
    expect((await h.flow.connect("https://b.test", "add")).ok).toBe(true);
    expect(h.flow.takeVerifiedCohort("https://b.test")).not.toBeNull();
    expect(h.events.filter((event) => event === "health")).toHaveLength(2);
  });

  test("cancel during readiness fences late work before prepare or commit", async () => {
    const readiness = deferred<number>();
    const h = harness({ observeReadiness: () => readiness.promise });
    const connecting = h.flow.connect("https://b.test", "switch");
    expect(h.flow.cancel()).toBe(true);
    readiness.resolve(10);
    expect(await connecting).toEqual({ ok: false, reason: "stale" });
    expect(h.events.some((event) => event.startsWith("prepare:"))).toBe(false);
    expect(h.events).not.toContain("config:commit");
  });

  test("cancel is rejected once promotion begins", async () => {
    const promoting = deferred<{ ok: true }>();
    const entered = deferred<void>();
    const h = harness({
      promote: async () => {
        entered.resolve();
        return promoting.promise;
      },
    });
    const connecting = h.flow.connect("https://b.test", "switch");
    await entered.promise;
    expect(h.flow.cancel()).toBe(false);
    promoting.resolve({ ok: true });
    expect((await connecting).ok).toBe(true);
  });

  test("switch and add converge on one authority flow and one health body", async () => {
    for (const context of ["switch", "add"] as const) {
      const h = harness();
      expect(await h.flow.connect("https://b.test", context)).toEqual({ ok: true, url: "https://b.test" });
      expect(h.events.filter((e) => e === "health")).toHaveLength(1);
      expect(h.activeOrigin()).toBe("https://b.test");
    }
  });

  test("add journals only against a complete legacy source authority, leaving A untouched when B is offline", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nautilo-d514-source-authority-"));
    try {
      let authority: ActiveAuthority = {
        scope: null, revision: null, connectionAttemptId: null, serverFingerprint: null,
      };
      const store = createPendingConnectionStore({
        filePath: path.join(root, "pending-connection.json"),
        tupleBinding: "tuple",
        currentActiveAuthority: () => authority,
        temporaryId: () => "pending-temp",
      });
      const h = harness({
        active: () => ({ authority, registryScope: "a-scope" }),
        savePending: (record) => store.save(record),
        observeReadiness: async () => { throw new Error("B is offline"); },
      });

      expect(h.flow.connect("http://127.0.0.1:9", "add")).rejects.toThrow(
        "pending connection record is invalid for this tuple",
      );
      authority = {
        scope: "http://127.0.0.1:3201",
        revision: "dev-revision-a",
        connectionAttemptId: "legacy-dev-a",
        serverFingerprint: null,
      };
      expect(h.flow.connect("http://127.0.0.1:9", "add")).resolves.toEqual({
        ok: false,
        reason: "offline",
      });
      expect(h.activeOrigin()).toBe("https://a.test");
      expect(store.load().disposition).toBe("precommit");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a slow healthy source remains pending without a terminal timer", async () => {
    const gate = deferred<VerifiedHealth>();
    const h = harness({ fetchHealth: () => gate.promise });
    let settled = false;
    const connecting = h.flow.connect("https://b.test", "switch").finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 5_050));
    expect(settled).toBe(false);
    gate.resolve(h.health);
    expect(await connecting).toEqual({ ok: true, url: "https://b.test" });
  }, 7_000);

  test("candidate facts remain candidate-scoped and A survives until config commit", async () => {
    const h = harness();
    await h.flow.connect("https://b.test", "switch");
    expect(h.events).toContain("candidate-facts:https://a.test");
    expect(h.candidate.logtoConfig?.appId).toBe("desktop");
    expect(h.events.indexOf("config:commit")).toBeLessThan(h.events.indexOf("old-codex"));
    expect(h.events.indexOf("old-codex")).toBeLessThan(h.events.indexOf("old-relay"));
    expect(h.events.indexOf("old-relay")).toBeLessThan(h.events.indexOf("old-profile"));
  });

  test("trusted identity is looked up for candidate B, not inherited from A", async () => {
    const h = harness({ expectedFingerprint: (origin) => origin === "https://b.test" ? "fingerprint-b" : "fingerprint-a" });
    expect((await h.flow.connect("https://b.test", "switch")).ok).toBe(true);
  });

  test("wrong-origin navigation receipt cannot promote", async () => {
    const h = harness({
      prepare: async (input) => ({
        ok: true,
        handle: {} as PreparedServerSwitchHandle,
        navigationReceipt: {
          attemptId: input.attemptId as never, generation: input.generation,
          origin: "https://c.test", observedAtMs: 30,
        },
      }),
    });
    expect(await h.flow.connect("https://b.test", "switch")).toEqual({ ok: false, reason: "stale" });
    expect(h.events).not.toContain("config:commit");
  });

  test("the active config linearizes before the committed journal and metadata", async () => {
    const h = harness();
    await h.flow.connect("https://b.test", "switch");
    const commit = h.events.indexOf("config:commit");
    const journal = h.events.indexOf("journal:active-committed:metadata");
    const metadata = h.events.indexOf("metadata");
    expect(commit).toBeGreaterThan(-1);
    expect(commit).toBeLessThan(journal);
    expect(journal).toBeLessThan(metadata);
  });

  test("the atomic authority commit carries the exact verified server fingerprint", async () => {
    let committedFingerprint: string | null = null;
    const h = harness({
      commitActiveAuthority: ({ serverFingerprint }) => {
        committedFingerprint = serverFingerprint;
      },
    });
    expect((await h.flow.connect("https://b.test", "switch")).ok).toBe(true);
    expect(committedFingerprint).toBe(h.health.fingerprint);
  });

  test("an exact prior-authority drift at the commit barrier cannot overwrite newer config", async () => {
    let capturedGuard: unknown = null;
    const h = harness({
      commitActiveAuthority: ({ priorAuthorityGuard }) => {
        capturedGuard = priorAuthorityGuard;
        h.events.push("config:cas-rejected");
        return false;
      },
    });
    expect(await h.flow.connect("https://b.test", "switch")).toEqual({
      ok: false,
      reason: "promotion-failed",
      authoritativePairingChanged: false,
    });
    expect(capturedGuard).toEqual(h.deps.active().authority);
    expect(h.events).not.toContain("metadata");
  });

  test("same-origin request re-proves active identity before a no-op", async () => {
    let activated = 0;
    const h = harness({
      active: () => ({
        authority: {
          scope: "https://b.test",
          revision: "rev-b",
          connectionAttemptId: "boot-b",
          serverFingerprint: "fingerprint-b",
        },
        registryScope: "b-scope",
      }),
      activateAlreadyActive: () => { activated += 1; },
    });
    expect(await h.flow.connect("https://b.test", "switch")).toEqual({ ok: true, url: "https://b.test" });
    expect(activated).toBe(1);
    expect(h.events).toContain("readiness");
    expect(h.events).toContain("health");
    expect(h.events).not.toContain("config:commit");
    expect(h.events).not.toContain("old-relay");
  });

  test("same-origin changed identity is a mismatch, never a stale-authority no-op", async () => {
    const h = harness({
      active: () => ({
        authority: {
          scope: "https://b.test",
          revision: "rev-b",
          connectionAttemptId: "boot-b",
          serverFingerprint: "fingerprint-a",
        },
        registryScope: "b-scope",
      }),
    });
    const result = await h.flow.connect("https://b.test", "switch");
    expect(result).toMatchObject({
      ok: false,
      reason: "wrong-server",
    });
    expect("decisionId" in result && typeof result.decisionId === "string").toBe(true);
    expect(h.events.some((event) => event.startsWith("prepare:"))).toBe(false);
  });

  test("same-origin accepted B is freshly re-proved and prepared as a detached replacement", async () => {
    const ids = ["attempt-1", "attempt-2"];
    const h = harness({
      mintAttemptId: () => ids.shift()!,
      active: () => ({
        authority: { scope: "https://b.test", revision: "rev-b", connectionAttemptId: "boot-b",
          serverFingerprint: "fingerprint-a" },
        registryScope: "b-scope",
      }),
      activeRoutingServerUrl: () => "https://b.test/tenant",
    });
    const mismatch = await h.flow.connect("https://b.test", "switch");
    expect(mismatch).toMatchObject({ ok: false, reason: "wrong-server" });
    if (mismatch.ok || mismatch.reason !== "wrong-server") throw new Error("decision missing");
    expect(mismatch).not.toHaveProperty("expectedFingerprint");
    expect(await h.flow.acceptIdentity(mismatch.decisionId)).toEqual({ ok: true, url: "https://b.test" });
    expect(h.prepareInputs[0]).toMatchObject({
      attemptId: "attempt-2",
      generation: 2,
      forceDetachedReplacement: true,
      identityTransition: { kind: "accepted-identity-replacement", priorConnectionAttemptId: "boot-b",
        priorServerFingerprint: "fingerprint-a", priorRoutingServerUrl: "https://b.test/tenant" },
      acceptedIdentityReplacementReceipt: { attemptId: "attempt-2", generation: 2, origin: "https://b.test" },
    });
    expect(h.events).toContain("stored-credentials:false");
    expect(h.events).toContain("retire-old:https://b.test/tenant");
    expect(h.events.indexOf("auth:persist")).toBeGreaterThan(
      h.events.indexOf("retire-old:https://b.test/tenant"),
    );
  });

  test("accepted B followed by fresh C fails closed without chaining another decision", async () => {
    const ids = ["attempt-1", "attempt-2"];
    let healthCalls = 0;
    const h = harness({
      mintAttemptId: () => ids.shift()!,
      expectedFingerprint: () => "fingerprint-a",
      fetchHealth: async () => ({ ...h.health,
        fingerprint: ++healthCalls === 1 ? "fingerprint-b" : "fingerprint-c" }),
    });
    const mismatch = await h.flow.connect("https://b.test", "switch");
    if (mismatch.ok || mismatch.reason !== "wrong-server") throw new Error("decision missing");
    expect(await h.flow.acceptIdentity(mismatch.decisionId)).toEqual({ ok: false, reason: "identity-changed-again" });
    expect(h.events).not.toContain("config:commit");
  });

  test("stored-target acceptance retires only B before candidate use and never loads stored credentials", async () => {
    const ids = ["attempt-1", "attempt-2"];
    const h = harness({
      mintAttemptId: () => ids.shift()!,
      expectedFingerprint: () => "fingerprint-old-b",
    });
    const mismatch = await h.flow.connect("https://b.test", "add");
    if (mismatch.ok || mismatch.reason !== "wrong-server") throw new Error("decision missing");
    expect(await h.flow.acceptIdentity(mismatch.decisionId)).toEqual({ ok: true, url: "https://b.test" });
    expect(h.events).toContain("retire-stored:https://b.test");
    expect(h.events).toContain("stored-credentials:false");
    expect(h.events).not.toContain("retire-stored:https://a.test");
    expect(h.pending.at(-2)?.identityTransition).toEqual({ kind: "ordinary" });
  });

  test("no-active stored-target acceptance uses the verified B retirement path", async () => {
    const ids = ["attempt-1", "attempt-2"];
    let retiredHealth: VerifiedHealth | null = null;
    const h = harness({
      mintAttemptId: () => ids.shift()!,
      active: () => ({ authority: { scope: null, revision: null, connectionAttemptId: null,
        serverFingerprint: null }, registryScope: null }),
      activeRoutingServerUrl: () => null,
      expectedFingerprint: () => "fingerprint-old-b",
      retireStoredCandidateIdentity: async (serverUrl, health) => {
        expect(serverUrl).toBe("https://b.test");
        retiredHealth = health;
      },
    });
    const mismatch = await h.flow.connect("https://b.test", "initial");
    if (mismatch.ok || mismatch.reason !== "wrong-server") throw new Error("decision missing");
    expect((await h.flow.acceptIdentity(mismatch.decisionId)).ok).toBe(true);
    expect(retiredHealth).toBe(h.health);
    expect(h.events.some((event) => event.startsWith("prepare:"))).toBe(true);
  });

  test("eligible local HTTP fallback advances the reducer to the fallback origin", async () => {
    const origins: string[] = [];
    const h = harness({
      active: () => ({
        authority: { scope: "https://a.test", revision: "rev-a", connectionAttemptId: "boot-a" },
        registryScope: "a-scope",
      }),
      expectedFingerprint: () => "fingerprint-b",
      observeReadiness: async (origin) => {
        origins.push(origin);
        if (origin.startsWith("https:")) throw new Error("TLS unavailable");
        return 10;
      },
      fetchHealth: async (origin) => ({ ...h.health, answeringOrigin: origin }),
    });
    expect(await h.flow.connect("127.0.0.1:3001", "switch")).toEqual({
      ok: true,
      url: "http://127.0.0.1:3001",
    });
    expect(origins).toEqual(["https://127.0.0.1:3001", "http://127.0.0.1:3001"]);
  });

  test("explicit HTTP downgrade consumes one opaque decision and continues the same attempt", async () => {
    const h = harness({
      previousHttpsOrigin: () => "https://b.test",
      fetchHealth: async (origin) => ({ ...h.health, answeringOrigin: origin }),
    });
    const displayed = await h.flow.connect("http://b.test", "switch");
    expect(displayed).toMatchObject({ ok: false, reason: "downgrade-confirmation-required" });
    if (displayed.ok || displayed.reason !== "downgrade-confirmation-required") throw new Error("decision missing");
    expect(displayed.decisionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.pending[0]).toMatchObject({ attemptId: "attempt-1", generation: 1,
      lastProgressPhase: "downgrade-confirmation", handoffCheckpoint: "candidate" });
    expect(h.events).not.toContain("readiness");
    expect(await h.flow.confirmDowngrade(displayed.decisionId)).toEqual({ ok: true, url: "http://b.test" });
    expect(h.pending[0]).toMatchObject({ attemptId: "attempt-1", generation: 1 });
    expect(await h.flow.confirmDowngrade(displayed.decisionId)).toEqual({ ok: false, reason: "stale" });
    expect(h.events.filter((event) => event === "config:commit")).toHaveLength(1);
  });

  test("downgrade confirmation fails closed when routed A drifts after display", async () => {
    let routed = "https://a.test/account";
    const h = harness({
      previousHttpsOrigin: () => "https://b.test",
      activeRoutingServerUrl: () => routed,
    });
    const displayed = await h.flow.connect("http://b.test", "add");
    if (displayed.ok || displayed.reason !== "downgrade-confirmation-required") throw new Error("decision missing");
    routed = "https://a.test/other";
    expect(await h.flow.confirmDowngrade(displayed.decisionId)).toEqual({ ok: false, reason: "stale" });
    expect(h.events).not.toContain("readiness");
  });

  test("a new connect supersedes a displayed downgrade decision", async () => {
    const h = harness({ previousHttpsOrigin: (target) => target.startsWith("http://b") ? "https://b.test" : null });
    const displayed = await h.flow.connect("http://b.test", "switch");
    if (displayed.ok || displayed.reason !== "downgrade-confirmation-required") throw new Error("decision missing");
    await h.flow.connect("https://b.test", "switch");
    expect(await h.flow.confirmDowngrade(displayed.decisionId)).toEqual({ ok: false, reason: "stale" });
  });

  test("a superseded late health response cannot prepare or commit", async () => {
    const first = deferred<VerifiedHealth>();
    let calls = 0;
    const h = harness({
      fetchHealth: async () => {
        calls += 1;
        return calls === 1 ? first.promise : h.health;
      },
    });
    const stale = h.flow.connect("https://b.test", "switch");
    const current = h.flow.connect("https://b.test", "add");
    first.resolve(h.health);
    expect(await stale).toEqual({ ok: false, reason: "stale" });
    expect((await current).ok).toBe(true);
    expect(h.events.filter((event) => event === "config:commit")).toHaveLength(1);
  });

  test("picker preview is generation-fenced and its exact facts are reused by add", async () => {
    const h = harness();
    expect((await h.flow.preview("https://b.test")).ok).toBe(true);
    expect((await h.flow.connect("https://b.test", "add")).ok).toBe(true);
    expect(h.events.filter((event) => event === "health")).toHaveLength(1);
    expect(h.events.filter((event) => event === "readiness")).toHaveLength(1);
  });

  test("Test facts remain reusable after 30 seconds until deterministic invalidation", async () => {
    let now = 25;
    const h = harness({ now: () => now });
    expect((await h.flow.preview("https://b.test")).ok).toBe(true);
    now = 60_025;
    expect((await h.flow.connect("https://b.test", "add")).ok).toBe(true);
    expect(h.events.filter((event) => event === "health")).toHaveLength(1);
    expect(h.events.filter((event) => event === "readiness")).toHaveLength(1);
  });

  test("a failed new Test invalidates the older successful cohort", async () => {
    let healthCalls = 0;
    const h = harness({
      fetchHealth: async () => {
        healthCalls += 1;
        if (healthCalls === 2) throw new Error("new test failed");
        return h.health;
      },
    });
    expect((await h.flow.preview("https://b.test")).ok).toBe(true);
    expect((await h.flow.preview("https://c.test")).ok).toBe(false);
    expect((await h.flow.connect("https://b.test", "add")).ok).toBe(true);
    expect(healthCalls).toBe(3);
  });

  test("commit-outcome-unknown rereads exact authority and resumes forward", async () => {
    let promoteCalls = 0;
    let committedAttempt = "boot-a";
    const h = harness({
      active: () => ({
        authority: committedAttempt === "boot-a"
          ? { scope: "https://a.test", revision: "rev-a", connectionAttemptId: "boot-a" }
          : { scope: "https://b.test", revision: "rev-b", connectionAttemptId: committedAttempt },
        registryScope: "a-scope",
      }),
      commitActiveAuthority: ({ attemptId }) => {
        committedAttempt = attemptId;
        throw new Error("rename outcome was not observed");
      },
      promote: async (prepared, hooks) => {
        promoteCalls += 1;
        if (promoteCalls === 1) {
          try { await hooks.commitActiveAuthority(); } catch { /* registry classifies this */ }
          return { ok: false, reason: "commit-outcome-unknown", handle: prepared };
        }
        await hooks.persistMetadata(prepared.session);
        await hooks.clearPending();
        return { ok: true };
      },
      resolveUnknownCommitOutcome: (prepared, authority) =>
        authority.connectionAttemptId === prepared.attemptId
          ? { outcome: "committed-handoff", handle: prepared }
          : { outcome: "unresolved" },
    });
    expect((await h.flow.connect("https://b.test", "switch")).ok).toBe(true);
    expect(promoteCalls).toBe(2);
  });

  test("unknown proved committed stays resume-only when the next checkpoint fails", async () => {
    let promoteCalls = 0;
    let committedAttempt = "boot-a";
    let commitCalls = 0;
    const h = harness({
      active: () => ({
        authority: committedAttempt === "boot-a"
          ? { scope: "https://a.test", revision: "rev-a", connectionAttemptId: "boot-a" }
          : { scope: "https://b.test", revision: "rev-b", connectionAttemptId: committedAttempt },
        registryScope: "a-scope",
      }),
      commitActiveAuthority: ({ attemptId }) => {
        commitCalls += 1;
        committedAttempt = attemptId;
        throw new Error("rename result lost");
      },
      promote: async (prepared, hooks) => {
        promoteCalls += 1;
        if (promoteCalls === 1) {
          try { await hooks.commitActiveAuthority(); } catch { /* outcome unknown */ }
          return { ok: false, reason: "commit-outcome-unknown", handle: prepared };
        }
        if (promoteCalls === 2) {
          return { ok: false, reason: "postcommit-failed", handle: prepared, checkpoint: "old-relay" };
        }
        await hooks.stopOldRelay(prepared.session);
        await hooks.clearPending();
        return { ok: true };
      },
      resolveUnknownCommitOutcome: (prepared, authority) =>
        authority.connectionAttemptId === prepared.attemptId
          ? { outcome: "committed-handoff", handle: prepared }
          : { outcome: "unresolved" },
    });
    expect(await h.flow.connect("https://b.test", "switch")).toEqual({
      ok: false,
      reason: "promotion-failed",
      authoritativePairingChanged: true,
    });
    expect((await h.flow.connect("must-not-start.test", "switch")).ok).toBe(true);
    expect(commitCalls).toBe(1);
    expect(promoteCalls).toBe(3);
  });

  test("delayed unknown resolution remains resume-only through a later checkpoint failure", async () => {
    let promoteCalls = 0;
    let resolutionCalls = 0;
    let committedAttempt = "boot-a";
    const h = harness({
      active: () => ({
        authority: committedAttempt === "boot-a"
          ? { scope: "https://a.test", revision: "rev-a", connectionAttemptId: "boot-a" }
          : { scope: "https://b.test", revision: "rev-b", connectionAttemptId: committedAttempt },
        registryScope: "a-scope",
      }),
      commitActiveAuthority: ({ attemptId }) => {
        committedAttempt = attemptId;
        throw new Error("rename result lost");
      },
      promote: async (prepared, hooks) => {
        promoteCalls += 1;
        if (promoteCalls === 1) {
          try { await hooks.commitActiveAuthority(); } catch { /* outcome unknown */ }
          return { ok: false, reason: "commit-outcome-unknown", handle: prepared };
        }
        if (promoteCalls === 2) {
          return { ok: false, reason: "postcommit-failed", handle: prepared, checkpoint: "old-relay" };
        }
        await hooks.clearPending();
        return { ok: true };
      },
      resolveUnknownCommitOutcome: (prepared) => {
        resolutionCalls += 1;
        return resolutionCalls === 1
          ? { outcome: "unresolved" }
          : { outcome: "committed-handoff", handle: prepared };
      },
    });
    expect(await h.flow.connect("https://b.test", "switch")).toEqual({
      ok: false,
      reason: "promotion-failed",
      authoritativePairingChanged: "unknown",
    });
    expect(await h.flow.connect("must-not-start.test", "switch")).toEqual({
      ok: false,
      reason: "promotion-failed",
      authoritativePairingChanged: true,
    });
    expect((await h.flow.connect("still-must-not-start.test", "switch")).ok).toBe(true);
    expect(promoteCalls).toBe(3);
  });

  test("a postcommit checkpoint failure resumes without committing twice", async () => {
    let promotionCalls = 0;
    let commits = 0;
    const h = harness({
      commitActiveAuthority: () => { commits += 1; },
      promote: async (prepared, hooks) => {
        promotionCalls += 1;
        if (promotionCalls === 1) {
          await hooks.commitActiveAuthority();
          return { ok: false, reason: "postcommit-failed", handle: prepared, checkpoint: "old-relay" };
        }
        await hooks.stopOldRelay(prepared.session);
        await hooks.clearPending();
        return { ok: true };
      },
    });
    expect(await h.flow.connect("https://b.test", "switch")).toEqual({
      ok: false,
      reason: "promotion-failed",
      authoritativePairingChanged: true,
    });
    expect((await h.flow.connect("ignored.test", "switch")).ok).toBe(true);
    expect(commits).toBe(1);
    expect(promotionCalls).toBe(2);
  });

  test("setup rejection is typed and leaves every candidate/promotion effect untouched", async () => {
    const h = harness({
      observeSetup: async () => { throw new Error("setup schema unavailable"); },
    });
    expect(await h.flow.connect("https://b.test", "switch")).toEqual({
      ok: false,
      reason: "incompatible",
    });
    expect(h.events.some((event) => event.startsWith("prepare:"))).toBe(false);
    expect(h.events).not.toContain("config:commit");
    expect(h.events).not.toContain("metadata");
    expect(h.events).not.toContain("old-relay");
  });
});
