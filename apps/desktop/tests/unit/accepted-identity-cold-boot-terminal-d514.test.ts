import { describe, expect, test } from "bun:test";
import {
  prepareAcceptedIdentityColdBootTerminal,
  type AcceptedIdentityColdBootTerminalPorts,
} from "../../electron/accepted-identity-cold-boot-terminal";
import type { ColdBootAcceptanceProof } from "../../electron/cold-boot-observation";
import type { ActiveAuthority, PendingConnection } from "../../electron/pending-connection";
import type { PreparedServerSwitchHandle, ServerSession } from "../../electron/server-sessions/registry";

const route = "https://alpha.example.test/base";
const origin = "https://alpha.example.test";
const attemptId = "accepted-b";
const generation = 9;
const authorityA: Extract<ActiveAuthority, { scope: string }> = {
  scope: origin, revision: "revision-a", connectionAttemptId: "attempt-a", serverFingerprint: "fingerprint-a",
};
const authorityB: Extract<ActiveAuthority, { scope: string }> = {
  scope: origin, revision: "revision-b", connectionAttemptId: attemptId, serverFingerprint: "fingerprint-b",
};

function proof(fingerprint = "fingerprint-b"): ColdBootAcceptanceProof {
  return {
    kind: "acceptance-proof", attemptId: attemptId as ColdBootAcceptanceProof["attemptId"], generation,
    serverUrl: route, displayedGeneration: 4, observedFingerprint: fingerprint,
    healthBody: { status: "ok", serverIdentity: fingerprint, logtoEndpoint: "https://login.nautilo.test",
      logtoDesktopAppId: "desktop", logtoResource: `${origin}/api` },
    receipt: { attemptId: attemptId as ColdBootAcceptanceProof["attemptId"], generation, origin, observedAtMs: 1 },
  };
}

function response(url: string, body: Record<string, unknown>): Response {
  return { ok: true, url, json: async () => body } as unknown as Response;
}

function fixture(mode: "success" | "false" | "unknown" = "success", overrides: Partial<AcceptedIdentityColdBootTerminalPorts> = {}) {
  const events: string[] = [];
  const saved: PendingConnection[] = [];
  let authority: ActiveAuthority = authorityA;
  let commitCalls = 0;
  let preparedCancelled = 0;
  let retired = 0;
  let finalizerFailures = 0;
  let postCommit = false;
  let releasedInput: { handle: PreparedServerSwitchHandle; facts: unknown } | null = null;
  const session: ServerSession = {
    scope: "scope-a", serverUrl: route,
    partition: `server-candidate-scope-a-${attemptId}-${generation}`,
    view: {} as ServerSession["view"], logtoConfig: null, signedIn: false,
    relayActive: false, profile: null, connection: "connecting",
  };
  const handle: PreparedServerSwitchHandle = {
    attemptId, generation, canonicalOrigin: origin, targetRegistryScope: "scope-a", priorRegistryScope: "scope-a",
    priorAuthorityGuard: authorityA, session, view: session.view!, newlyCreatedView: true,
    navigationReceipt: { attemptId: attemptId as ColdBootAcceptanceProof["attemptId"], generation, origin, observedAtMs: 2 },
    expectedServerFingerprint: "fingerprint-b",
    identityTransition: { kind: "accepted-identity-replacement", priorConnectionAttemptId: "attempt-a",
      priorServerFingerprint: "fingerprint-a", priorRoutingServerUrl: route },
    status: "prepared", checkpoint: "metadata",
  };
  const ports: AcceptedIdentityColdBootTerminalPorts = {
    currentAuthority: () => authority,
    currentRegistryScope: () => "scope-a",
    fetch: async (url) => {
      const value = String(url);
      events.push(`fetch:${value}`);
      if (value.endsWith("/health")) throw new Error("health must be reused from proof");
      if (value.endsWith("/api/setup/status")) return response(value, {
        instanceId: "instance", serverUrl: route, deploymentMode: "local-self-host",
        setupState: "fresh-unclaimed", claimRequired: true,
      });
      return response(value, { exists: true, onboardingCompleted: true });
    },
    fingerprintFromHealthBody: (body) => body["serverIdentity"] as string ?? null,
    savePending: (pending) => { events.push(`save:${pending.handoffCheckpoint}:${pending.postCommitCheckpoint}`); saved.push(pending); },
    clearPending: () => events.push("clear"),
    prepare: async (input) => {
      events.push("prepare");
      expect(input.acceptedIdentityReplacementReceipt.attemptId).toBe(attemptId);
      expect(input.acceptedIdentityReplacementReceipt.generation).toBe(generation);
      expect(input.acceptedIdentityReplacementReceipt.origin).toBe(origin);
      return { ok: true, handle, navigationReceipt: handle.navigationReceipt! };
    },
    cancelPrepared: () => { preparedCancelled += 1; events.push("cancel"); return true; },
    promote: async (_handle, hooks) => {
      events.push(`promote:${hooks.pauseBeforeRendererAuthority === true}`);
      if (!postCommit) {
        commitCalls += 1;
        try {
          const committed = await hooks.commitActiveAuthority({ canonicalOrigin: origin, targetRegistryScope: "scope-a",
            priorRegistryScope: "scope-a", attemptId, generation, serverFingerprint: "fingerprint-b" });
          if (!committed.committed) return { ok: false, reason: "commit-failed" };
        } catch { return { ok: false, reason: "commit-outcome-unknown", handle }; }
        postCommit = true;
      }
      if (hooks.pauseBeforeRendererAuthority) {
        await hooks.persistMetadata(session);
        await hooks.stopOldCodex(session);
        await hooks.stopOldRelay(session);
        await hooks.deactivateOldProfile(session);
        await hooks.retireOldIdentity?.({ priorRoutingServerUrl: route, targetRegistryScope: "scope-a" });
        retired += 1;
        await hooks.persistNextCheckpoint("renderer-authority");
        return { ok: true, paused: true, handle, checkpoint: "renderer-authority" };
      }
      await hooks.persistNextCheckpoint("visibility");
      await hooks.clearPending();
      return { ok: true, receipt: { attemptId, generation, canonicalOrigin: origin, targetRegistryScope: "scope-a" } };
    },
    resolveUnknownCommitOutcome: () => {
      if (authority !== authorityB) return { outcome: "not-committed" };
      postCommit = true;
      return { outcome: "committed-handoff", handle };
    },
    commitAcceptedConfig: () => {
      events.push("config");
      if (mode === "false") return false;
      authority = authorityB;
      if (mode === "unknown") throw new Error("rename outcome unknown");
      return true;
    },
    persistMetadata: async () => { events.push("metadata"); },
    stopOldCodex: async () => { events.push("old-codex"); },
    stopOldRelay: async () => { events.push("old-relay"); },
    deactivateOldProfile: async () => { events.push("old-profile"); },
    retireOldIdentity: async () => { events.push("retire"); },
    startTargetRelay: async () => { events.push("relay"); },
    createTokenStore: () => ({
      load: () => { throw new Error("accepted replacement must not load A tokens"); },
      save: () => {}, clear: () => {}, retireExact: () => events.push("retire-token"),
    }),
    observeRelayContract: () => events.push("relay-contract"),
    candidateUi: {
      startLoopback: async () => { throw new Error("not expected"); },
      openAuthSurface: async () => { throw new Error("not expected"); },
      showOnboarding: async () => { throw new Error("not expected"); },
    },
    forceOnboarding: false,
    installActiveAuthDescriptor: () => events.push("descriptor"),
    releaseCandidate: (input) => { releasedInput = { handle: input.handle, facts: input.facts }; events.push("release"); },
    finishReleased: async () => { events.push("finalize"); if (finalizerFailures-- > 0) throw new Error("finalizer"); },
    onState: (state) => events.push(`state:${state.phase}`),
    ...overrides,
  };
  const terminal = prepareAcceptedIdentityColdBootTerminal(ports, {
    displayed: { serverUrl: route, generation: 4, observedFingerprint: "fingerprint-b" },
    proof: proof(), priorRoutingServerUrl: route, tupleBinding: "tuple",
  });
  return { terminal, ports, events, saved, handle, get commitCalls() { return commitCalls; },
    get preparedCancelled() { return preparedCancelled; }, get retired() { return retired; },
    get releasedInput() { return releasedInput; }, failFinalizer: () => { finalizerFailures = 1; },
    setAuthority: (next: ActiveAuthority) => { authority = next; } };
}

describe("D514 accepted identity cold-boot terminal", () => {
  test("accepts only the exact displayed B proof, reuses health, journals before config, and retires before gates/renderer", async () => {
    const subject = fixture();
    expect(subject.terminal).not.toBeNull();
    expect(await subject.terminal!.launch()).toBe("released");
    expect(subject.events.filter((event) => event.endsWith("/health"))).toEqual([]);
    expect(subject.events.indexOf("save:candidate:null")).toBeLessThan(subject.events.indexOf("prepare"));
    expect(subject.events.indexOf("prepare")).toBeLessThan(subject.events.indexOf("config"));
    expect(subject.events.indexOf("save:active-committed:metadata")).toBeGreaterThan(subject.events.indexOf("config"));
    expect(subject.events.indexOf("retire-token")).toBeLessThan(subject.events.indexOf("descriptor"));
    expect(subject.events.indexOf("retire")).toBeLessThan(subject.events.indexOf("descriptor"));
    expect(subject.commitCalls).toBe(1);
    expect(subject.retired).toBe(1);
    expect(subject.saved.map((pending) => pending.postCommitCheckpoint)).toEqual([null, "metadata", "renderer-authority", "visibility"]);
    expect(subject.releasedInput?.handle).toBe(subject.handle);
  });

  test("B to C proof is rejected before candidate persistence or prepare", () => {
    const subject = fixture();
    const terminal = prepareAcceptedIdentityColdBootTerminal(subject.ports, {
      displayed: { serverUrl: route, generation: 4, observedFingerprint: "fingerprint-b" },
      proof: proof("fingerprint-c"), priorRoutingServerUrl: route, tupleBinding: "tuple",
    });
    expect(terminal).toBeNull();
    expect(subject.events).toEqual([]);
  });

  test("false precommit commit cancels only B and permits proof rollback", async () => {
    const subject = fixture("false");
    expect(await subject.terminal!.launch()).toBe("precommit-failed");
    expect(subject.preparedCancelled).toBe(1);
    expect(subject.events).toContain("clear");
    expect(subject.commitCalls).toBe(1);
  });

  test("unknown config outcome reconstructs committed metadata and retries forward without recommit", async () => {
    const subject = fixture("unknown");
    expect(await subject.terminal!.launch()).toBe("recoverable-forward");
    expect(subject.saved.map((pending) => pending.postCommitCheckpoint)).toEqual([null]);
    expect(await subject.terminal!.retry()).toBe("released");
    expect(subject.commitCalls).toBe(1);
    expect(subject.saved.map((pending) => pending.postCommitCheckpoint)).toContain("metadata");
  });

  test("unknown B may still prove A on Retry, which is the only forward path that permits rollback", async () => {
    const subject = fixture("unknown");
    expect(await subject.terminal!.launch()).toBe("recoverable-forward");
    subject.setAuthority(authorityA);
    expect(await subject.terminal!.retry()).toBe("precommit-failed");
    expect(subject.preparedCancelled).toBe(1);
  });

  test("a failed unknown-to-committed metadata journal retries without re-resolving or recommitting", async () => {
    const subject = fixture("unknown");
    expect(await subject.terminal!.launch()).toBe("recoverable-forward");
    const save = subject.ports.savePending;
    let failed = false;
    subject.ports.savePending = (pending) => {
      if (!failed && pending.postCommitCheckpoint === "metadata") { failed = true; throw new Error("disk"); }
      save(pending);
    };
    expect(await subject.terminal!.retry()).toBe("recoverable-forward");
    expect(await subject.terminal!.retry()).toBe("released");
    expect(subject.commitCalls).toBe(1);
  });

  test("finalizer failure retries without recommit or re-release", async () => {
    const subject = fixture();
    subject.failFinalizer();
    expect(await subject.terminal!.launch()).toBe("recoverable-forward");
    expect(await subject.terminal!.retry()).toBe("released");
    expect(subject.events.filter((event) => event === "release")).toHaveLength(1);
    expect(subject.commitCalls).toBe(1);
  });

  test("invalid setup, profile redirect, and an adversarial prepared handle fail before config", async () => {
    const setup = fixture("success", { fetch: async (url) => response(String(url), { invalid: true }) });
    expect(await setup.terminal!.launch()).toBe("precommit-failed");
    expect(setup.commitCalls).toBe(0);
    const redirect = fixture("success", { fetch: async (url) => response("https://other.nautilo.test/profile", String(url).endsWith("setup/status")
      ? { instanceId: "instance", serverUrl: route, deploymentMode: "local-self-host", setupState: "fresh-unclaimed", claimRequired: true }
      : { exists: true, onboardingCompleted: true }) });
    expect(await redirect.terminal!.launch()).toBe("precommit-failed");
    const wrongHandle = fixture("success");
    wrongHandle.handle.targetRegistryScope = "scope-other" as never;
    expect(await wrongHandle.terminal!.launch()).toBe("precommit-failed");
    expect(wrongHandle.commitCalls).toBe(0);
  });

  test("conflicting top-level navigation receipt and B-authority drift after gates never reach descriptor or renderer", async () => {
    const receipt = fixture();
    receipt.ports.prepare = async () => ({ ok: true, handle: receipt.handle,
      navigationReceipt: { ...receipt.handle.navigationReceipt!, origin: "https://other.nautilo.test" } });
    expect(await receipt.terminal!.launch()).toBe("precommit-failed");
    expect(receipt.commitCalls).toBe(0);
    const drift = fixture();
    drift.ports.observeRelayContract = () => drift.setAuthority(authorityA);
    expect(await drift.terminal!.launch()).toBe("recoverable-forward");
    expect(drift.events).not.toContain("descriptor");
  });
});
