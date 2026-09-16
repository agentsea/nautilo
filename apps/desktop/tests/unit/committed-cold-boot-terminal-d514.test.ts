import { describe, expect, test } from "bun:test";
import {
  prepareCommittedColdBootTerminal,
  routedServerEndpoint,
  type CommittedColdBootTerminalPorts,
} from "../../electron/committed-cold-boot-terminal";
import type { ConnectionAttemptId, ObservationReceipt } from "../../electron/connection-attempt";
import type { ActiveAuthority, PendingConnection, PendingConnectionLoadResult } from "../../electron/pending-connection";
import type { PreparedServerSwitchHandle, ServerSession } from "../../electron/server-sessions/registry";

const origin = "https://b.nautilo.test";
const route = `${origin}/base`;
const attemptId = "attempt-b";
const generation = 7;
const authority: Extract<ActiveAuthority, { scope: string }> = {
  scope: origin,
  revision: "revision-b",
  connectionAttemptId: attemptId,
  serverFingerprint: "fingerprint-b",
};
const pending: PendingConnection = {
  version: 2,
  tupleBinding: "tuple-binding-b",
  attemptId,
  context: "cold-boot",
  generation,
  enteredTarget: route,
  candidateOrigin: origin,
  activeScopeGuard: "https://a.nautilo.test",
  activeRevisionGuard: "revision-a",
  identityTransition: { kind: "ordinary" },
  lastProgressPhase: "promotion",
  handoffCheckpoint: "active-committed",
  postCommitCheckpoint: "metadata",
};
const loaded: Extract<PendingConnectionLoadResult, { disposition: "committed-handoff" }> = {
  disposition: "committed-handoff",
  pending,
};

function response(url: string, body: Record<string, unknown>, ok = true): Response {
  return { ok, url, json: async () => body } as unknown as Response;
}

function endpointResponse(url: string): Response {
  if (url.endsWith("/health/ready")) return response(url, { status: "ready" });
  if (url.endsWith("/health")) return response(url, {
    status: "ok",
    serverIdentity: "fingerprint-b",
    logtoEndpoint: "https://login.b.test",
    logtoDesktopAppId: "desktop-b",
    logtoResource: `${origin}/api`,
  });
  if (url.endsWith("/api/setup/status")) return response(url, {
    instanceId: "instance-b",
    serverUrl: route,
    deploymentMode: "local-self-host",
    setupState: "fresh-unclaimed",
    claimRequired: true,
  });
  return response(url, { exists: true, onboardingCompleted: true });
}

function session(): ServerSession {
  return {
    scope: "scope-b",
    serverUrl: route,
    partition: `server-candidate-scope-b-${attemptId}-${generation}`,
    view: {} as ServerSession["view"],
    logtoConfig: null,
    signedIn: false,
    relayActive: false,
    profile: null,
    connection: "connecting",
  };
}

function handle(overrides: Partial<PreparedServerSwitchHandle> = {}): PreparedServerSwitchHandle {
  const candidate = session();
  return {
    attemptId,
    generation,
    canonicalOrigin: origin,
    targetRegistryScope: candidate.scope,
    priorRegistryScope: null,
    priorAuthorityGuard: null,
    session: candidate,
    view: candidate.view!,
    newlyCreatedView: true,
    navigationReceipt: null,
    expectedServerFingerprint: "fingerprint-b",
    status: "awaiting-revalidation",
    checkpoint: "metadata",
    ...overrides,
  };
}

function fixture(overrides: Partial<CommittedColdBootTerminalPorts> = {}) {
  const events: string[] = [];
  const saved: PendingConnection[] = [];
  const candidateHandle = handle();
  let currentAuthority: ActiveAuthority = authority;
  let finalizerFailures = 0;
  const ports: CommittedColdBootTerminalPorts = {
    initiateLocalShell: () => events.push("shell"),
    configureRegistry: () => events.push("registry"),
    loadPending: () => { events.push("pending"); return loaded; },
    projectCommitted: () => ({
      disposition: "committed-handoff",
      action: "resume-handoff",
      attemptId,
      generation,
      context: "cold-boot",
      candidateOrigin: origin,
      routingServerUrl: route,
      priorRecoveryGuard: { scope: "https://a.nautilo.test", revision: "revision-a" },
      priorRegistryScope: null,
      nextPostCommitCheckpoint: "metadata",
      validActions: ["resume-handoff"],
      requiresEphemeralFactReconstructionAndRevalidation: true,
    }),
    currentAuthority: () => currentAuthority,
    beginCommitted: () => {
      events.push("begin");
      return { handle: candidateHandle, activeAuthorityGuard: currentAuthority };
    },
    fetch: async (url) => {
      events.push(`fetch:${url}`);
      return endpointResponse(String(url));
    },
    fingerprintFromHealthBody: (body) => body["serverIdentity"] as string ?? null,
    navigateCandidate: async (input) => {
      events.push(`navigate:${input.navigationUrl}`);
      return {
        attemptId: attemptId as ConnectionAttemptId,
        generation,
        origin,
        observedAtMs: 1,
      };
    },
    completeCommitted: () => { events.push("complete"); return true; },
    promote: async (promoted, hooks) => {
      expect(promoted).toBe(candidateHandle);
      events.push(`promote:${hooks.pauseBeforeRendererAuthority === true}`);
      if (hooks.pauseBeforeRendererAuthority) {
        return { ok: true, paused: true, handle: candidateHandle, checkpoint: "renderer-authority" };
      }
      await hooks.persistNextCheckpoint("visibility");
      await hooks.clearPending();
      return {
        ok: true,
        receipt: { attemptId, generation, canonicalOrigin: origin, targetRegistryScope: "scope-b" },
      };
    },
    savePending: (next) => { events.push(`save-pending:${next.postCommitCheckpoint}`); saved.push(next); },
    clearPending: () => events.push("clear-pending"),
    persistMetadata: async () => { events.push("metadata"); },
    stopOldCodex: async () => { events.push("old-codex"); },
    stopOldRelay: async () => { events.push("old-relay"); },
    deactivateOldProfile: async () => { events.push("old-profile"); },
    startTargetRelay: async () => { events.push("target-relay"); },
    createTokenStore: (identity) => {
      events.push(`tokens:${identity.routingServerUrl}|${identity.logtoEndpoint}|${identity.clientAppId}`);
      return { load: () => null, save: () => {}, clear: () => {} };
    },
    observeRelayContract: () => events.push("relay-contract"),
    candidateUi: {
      startLoopback: async () => { throw new Error("not expected"); },
      openAuthSurface: async () => { throw new Error("not expected"); },
      showOnboarding: async () => { events.push("onboarding"); },
    },
    forceOnboarding: false,
    installActiveAuthDescriptor: () => events.push("install-descriptor"),
    releaseCandidate: () => events.push("release-candidate"),
    finishReleased: async () => {
      events.push("finalizer");
      if (finalizerFailures-- > 0) throw new Error("finalizer failed");
    },
    onState: (state) => events.push(`state:${state.phase}`),
    ...overrides,
  };
  return {
    events,
    saved,
    ports,
    candidateHandle,
    setAuthority: (next: ActiveAuthority) => { currentAuthority = next; },
    failFinalizerOnce: () => { finalizerFailures = 1; },
  };
}

describe("D514 committed cold-boot terminal", () => {
  test("prepares shell, registry, pending, and committed fence synchronously before network", async () => {
    const f = fixture();
    const terminal = prepareCommittedColdBootTerminal(f.ports);
    expect(terminal).not.toBeNull();
    expect(f.events).toEqual(["shell", "registry", "pending", "begin"]);
    const launch = terminal!.launch();
    expect(f.events.slice(0, 4)).toEqual(["shell", "registry", "pending", "begin"]);
    expect(f.events.findIndex((event) => event.startsWith("fetch:"))).toBe(-1);
    await launch;
    expect(f.events.findIndex((event) => event.startsWith("fetch:"))).toBeGreaterThan(3);
  });

  test("returns null for none and precommit after the same local ordering", () => {
    for (const pendingResult of [
      { disposition: "none" as const },
      { disposition: "precommit" as const, pending: { ...pending, handoffCheckpoint: "candidate" as const, postCommitCheckpoint: null } },
    ]) {
      const f = fixture({ loadPending: () => { f.events.push("pending"); return pendingResult; } });
      expect(prepareCommittedColdBootTerminal(f.ports)).toBeNull();
      expect(f.events).toEqual(["shell", "registry", "pending"]);
    }
  });

  test("preserves the routed base for every request/navigation and canonical origin for receipts", async () => {
    const f = fixture();
    const terminal = prepareCommittedColdBootTerminal(f.ports)!;
    await terminal.launch();
    expect(f.events).toEqual(expect.arrayContaining([
      `fetch:${route}/health/ready`,
      `fetch:${route}/health`,
      `fetch:${route}/api/setup/status`,
      `fetch:${route}/api/profile/status`,
      `navigate:${route}/`,
    ]));
    expect(terminal.snapshot()).toEqual({ phase: "released", canRetry: false });
  });

  test("pauses, runs exact identity-bound candidate gates, installs descriptor, then releases same handle", async () => {
    const f = fixture();
    await prepareCommittedColdBootTerminal(f.ports)!.launch();
    const paused = f.events.indexOf("promote:true");
    const tokenGate = f.events.findIndex((event) => event.startsWith("tokens:"));
    const descriptor = f.events.indexOf("install-descriptor");
    const release = f.events.indexOf("promote:false");
    expect(paused).toBeLessThan(tokenGate);
    expect(tokenGate).toBeLessThan(descriptor);
    expect(f.events.indexOf("relay-contract")).toBeLessThan(release);
    expect(descriptor).toBeLessThan(release);
    expect(f.candidateHandle.session.connection).toBe("live");
    expect(f.saved[0]).toMatchObject({
      lastProgressPhase: "promotion",
      handoffCheckpoint: "active-committed",
      postCommitCheckpoint: "visibility",
    });
  });

  test("invalid reconstructed handle returns recoverable with zero fetch and begin stays once across retry", async () => {
    const invalid = handle({ status: "prepared" });
    const f = fixture({ beginCommitted: () => {
      f.events.push("begin");
      return { handle: invalid, activeAuthorityGuard: authority };
    } });
    const terminal = prepareCommittedColdBootTerminal(f.ports)!;
    await terminal.launch();
    await terminal.retry();
    expect(terminal.snapshot()).toEqual({ phase: "recoverable", canRetry: true });
    expect(f.events.filter((event) => event === "begin")).toHaveLength(1);
    expect(f.events.some((event) => event.startsWith("fetch:"))).toBe(false);
  });

  test("full authority revision drift after navigation rejects before complete", async () => {
    const f = fixture({ navigateCandidate: async () => {
      f.setAuthority({ ...authority, revision: "revision-c" });
      return { attemptId: attemptId as ConnectionAttemptId, generation, origin, observedAtMs: 2 };
    } });
    const terminal = prepareCommittedColdBootTerminal(f.ports)!;
    await terminal.launch();
    expect(terminal.snapshot()).toEqual({ phase: "recoverable", canRetry: true });
    expect(f.events).not.toContain("complete");
    expect(f.events).not.toContain("promote:true");
  });

  test("authority drift during candidate gates blocks the second promotion", async () => {
    const f = fixture({
      forceOnboarding: true,
      createTokenStore: () => ({ load: () => ({
        access_token: "b-access", refresh_token: "b-refresh", id_token: "b-id",
        expires_in: 3600, refreshed_at: Date.now(),
      }), save: () => {}, clear: () => {} }),
      candidateUi: {
        startLoopback: async () => { throw new Error("not expected"); },
        openAuthSurface: async () => { throw new Error("not expected"); },
        showOnboarding: async () => { f.setAuthority({ ...authority, revision: "revision-c" }); },
      },
    });
    const terminal = prepareCommittedColdBootTerminal(f.ports)!;
    await terminal.launch();
    expect(terminal.snapshot()).toEqual({ phase: "recoverable", canRetry: true });
    expect(f.events).toContain("promote:true");
    expect(f.events).not.toContain("install-descriptor");
    expect(f.events).not.toContain("promote:false");
  });

  test("wrong fingerprint, redirected health, and wrong navigation origin remain recoverable", async () => {
    const cases: Array<Partial<CommittedColdBootTerminalPorts>> = [
      { fingerprintFromHealthBody: () => "fingerprint-c" },
      { fetch: async (url) => response(String(url).endsWith("/health") ? "https://c.test/health" : String(url), { status: "ready" }) },
      { navigateCandidate: async () => ({ attemptId: attemptId as ConnectionAttemptId, generation, origin: "https://c.test", observedAtMs: 3 }) },
    ];
    for (const change of cases) {
      const f = fixture(change);
      const terminal = prepareCommittedColdBootTerminal(f.ports)!;
      await terminal.launch();
      expect(terminal.snapshot()).toEqual({ phase: "recoverable", canRetry: true });
      expect(f.events).not.toContain("promote:true");
    }
  });

  test("profile 404, malformed body or JSON, and fetch failure remain unavailable and recover forward", async () => {
    const profileFailures: Array<() => Response | Promise<Response>> = [
      () => response(`${route}/api/profile/status`, {}, false),
      () => response(`${route}/api/profile/status`, { exists: "yes", onboardingCompleted: true }),
      () => ({ ok: true, url: `${route}/api/profile/status`, json: async () => { throw new Error("bad JSON"); } }) as Response,
      () => Promise.reject(new Error("profile unavailable")),
    ];
    for (const failProfile of profileFailures) {
      const f = fixture({
        fetch: async (url) => String(url).endsWith("/api/profile/status")
          ? failProfile()
          : endpointResponse(String(url)),
        releaseCandidate: ({ facts }) => expect(facts.profile).toEqual({ kind: "unavailable" }),
      });
      const terminal = prepareCommittedColdBootTerminal(f.ports)!;
      await terminal.launch();
      expect(terminal.snapshot()).toEqual({ phase: "released", canRetry: false });
      expect(f.events).toContain("promote:true");
    }
  });

  test("malformed setup response fails reconstruction before promotion", async () => {
    const f = fixture({
      fetch: async (url) => String(url).endsWith("/api/setup/status")
        ? response(String(url), { setupState: "fresh-unclaimed" })
        : endpointResponse(String(url)),
    });
    const terminal = prepareCommittedColdBootTerminal(f.ports)!;
    await terminal.launch();
    expect(terminal.snapshot()).toEqual({ phase: "recoverable", canRetry: true });
    expect(f.events).not.toContain("promote:true");
  });

  test("finalizer failure retries only finalization without begin, complete, or promotion", async () => {
    const f = fixture();
    f.failFinalizerOnce();
    const terminal = prepareCommittedColdBootTerminal(f.ports)!;
    await terminal.launch();
    expect(terminal.snapshot()).toEqual({ phase: "recoverable", canRetry: true });
    await terminal.retry();
    expect(f.events.filter((event) => event === "begin")).toHaveLength(1);
    expect(f.events.filter((event) => event === "complete")).toHaveLength(1);
    expect(f.events.filter((event) => event.startsWith("promote:"))).toHaveLength(2);
    expect(f.events.filter((event) => event === "release-candidate")).toHaveLength(1);
    expect(f.events.filter((event) => event === "finalizer")).toHaveLength(2);
    expect(f.events.indexOf("release-candidate")).toBeLessThan(f.events.indexOf("finalizer"));
  });

  test("a failed candidate gate retries its retained stage without refetch, rebegin, recomplete, or repause", async () => {
    let gates = 0;
    const f = fixture({
      forceOnboarding: true,
      createTokenStore: () => ({ load: () => ({
        access_token: "b-access", refresh_token: "b-refresh", id_token: "b-id",
        expires_in: 3600, refreshed_at: Date.now(),
      }), save: () => {}, clear: () => {} }),
      candidateUi: {
        startLoopback: async () => { throw new Error("not expected"); },
        openAuthSurface: async () => { throw new Error("not expected"); },
        showOnboarding: async () => { if (++gates === 1) throw new Error("gate failed"); },
      },
    });
    const terminal = prepareCommittedColdBootTerminal(f.ports)!;
    await terminal.launch();
    await terminal.retry();
    expect(f.events.filter((event) => event === "begin")).toHaveLength(1);
    expect(f.events.filter((event) => event.startsWith("fetch:"))).toHaveLength(4);
    expect(f.events.filter((event) => event === "complete")).toHaveLength(1);
    expect(f.events.filter((event) => event === "promote:true")).toHaveLength(1);
    expect(f.events.filter((event) => event === "promote:false")).toHaveLength(1);
    expect(terminal.snapshot()).toEqual({ phase: "released", canRetry: false });
  });

  test("endpoint helper normalizes one slash without erasing the routed path", () => {
    expect(routedServerEndpoint(`${route}/`, "/health")).toBe(`${route}/health`);
  });
});
