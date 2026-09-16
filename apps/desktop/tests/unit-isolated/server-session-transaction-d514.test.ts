import { describe, expect, mock, test } from "bun:test";

mock.module("electron", () => ({
  app: { getPath: () => "/tmp", isPackaged: false },
}));

const { ServerSessionRegistry } = await import(
  "../../electron/server-sessions/registry"
);

type MockView = { id: number };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness() {
  const registry = new ServerSessionRegistry();
  const calls: string[] = [];
  const attached = new Set<number>();
  let id = 0;
  registry.configure({
    createCandidateView: (session) => {
      calls.push(`create:${session.serverUrl}`);
      return { id: ++id } as never;
    },
    attachCandidateView: (_session, view) => {
      const viewId = (view as unknown as MockView).id;
      calls.push(`attach:${viewId}`);
      attached.add(viewId);
    },
    bindCandidateSender: (_previous, candidate, view) => {
      const viewId = (view as unknown as MockView).id;
      calls.push(`bind:${viewId}`);
      if (!registry.attachSender(viewId, candidate.scope)) {
        throw new Error("candidate sender bind failed");
      }
    },
    destroyCandidateView: (view) => {
      const viewId = (view as unknown as MockView).id;
      calls.push(`destroy:${viewId}`);
      attached.delete(viewId);
    },
    destroyView: (view) => {
      const viewId = (view as unknown as MockView).id;
      calls.push(`destroy-attached:${viewId}`);
      attached.delete(viewId);
    },
    setRendererActive: (view, active) =>
      calls.push(`active:${(view as unknown as MockView).id}:${active}`),
    showView: (view) => {
      const viewId = (view as unknown as MockView).id;
      if (!attached.has(viewId)) throw new Error("candidate was shown while detached");
      calls.push(`show:${viewId}`);
    },
    hideView: (view) => calls.push(`hide:${(view as unknown as MockView).id}`),
  });
  const rawPrepare = registry.prepareSwitch.bind(registry);
  registry.prepareSwitch = (input) => rawPrepare({ routingServerUrl: input.canonicalOrigin,
    identityTransition: { kind: "ordinary" }, ...input });
  const attachExisting = (session: { view: unknown }, viewId: number): MockView => {
    const view = { id: viewId };
    session.view = view;
    attached.add(viewId);
    return view;
  };
  return { registry, calls, attached, attachExisting };
}

function receipt(
  input: { attemptId: string; generation: number; expectedOrigin: string },
  overrides: Partial<{
    attemptId: string;
    generation: number;
    origin: string;
    observedAtMs: number;
  }> = {},
) {
  return {
    attemptId: input.attemptId,
    generation: input.generation,
    origin: input.expectedOrigin,
    observedAtMs: 100,
    ...overrides,
  } as never;
}

function priorGuard(scope: string | null) {
  return {
    scope,
    revision: scope === null ? null : "prior-revision",
    connectionAttemptId: scope === null ? null : "prior-attempt",
    serverFingerprint: scope === null ? null : "fingerprint-a",
  };
}

async function preparedAB() {
  const h = harness();
  const a = h.registry.ensure("https://a.example");
  h.attachExisting(a, 100);
  const result = await h.registry.prepareSwitch({
    attemptId: "attempt-b",
    generation: 2,
    canonicalOrigin: "https://b.example",
    priorRegistryScope: a.scope,
    priorAuthorityGuard: {
      scope: a.serverUrl,
      revision: "revision-a",
      connectionAttemptId: "attempt-a",
      serverFingerprint: "fingerprint-a",
    },
    candidateServerFingerprint: "fingerprint-b",
    awaitNavigationReceipt: async (input) => receipt(input),
  });
  if (!result.ok) throw new Error(`prepare failed: ${result.reason}`);
  return {
    ...h,
    a,
    handle: result.handle,
    prepareReceipt: result.navigationReceipt,
  };
}

function promotionHooks(calls: string[], overrides: Record<string, unknown> = {}) {
  return {
    commitActiveAuthority: async () => {
      calls.push("commit");
      return { committed: true as const };
    },
    persistMetadata: async () => { calls.push("metadata"); },
    stopOldCodex: async () => { calls.push("old-codex"); },
    stopOldRelay: async () => { calls.push("old-relay"); },
    deactivateOldProfile: async () => { calls.push("old-profile"); },
    shouldStartTargetRelay: true,
    startTargetRelay: async () => { calls.push("target-relay"); },
    persistNextCheckpoint: async () => {},
    clearPending: async () => { calls.push("pending-clear"); },
    ...overrides,
  };
}

describe("D514 registry prepare/promote transaction", () => {
  test("prepare keeps A active and B detached", async () => {
    const { registry, calls, attached, a, handle, prepareReceipt } = await preparedAB();
    expect(registry.active).toBe(a);
    expect(handle.status).toBe("prepared");
    expect(handle.canonicalOrigin).toBe("https://b.example");
    expect(handle.targetRegistryScope).not.toBe(handle.canonicalOrigin);
    expect(handle.navigationReceipt).toEqual({
      attemptId: "attempt-b",
      generation: 2,
      origin: "https://b.example",
      observedAtMs: 100,
    });
    expect(prepareReceipt).toBe(handle.navigationReceipt);
    expect(attached.has(1)).toBe(false);
    expect(calls).toEqual(["create:https://b.example"]);
  });

  test("cancel destroys only the exact precommit candidate and preserves A", async () => {
    const { registry, calls, a, handle } = await preparedAB();
    expect(registry.cancelPreparedSwitch("another-attempt", handle.generation)).toBe(false);
    expect(registry.cancelPreparedSwitch(handle.attemptId, handle.generation)).toBe(true);
    expect(registry.active).toBe(a);
    expect(a.view).not.toBeNull();
    expect(registry.getByServerUrl("https://b.example")).toBeNull();
    expect(calls).toContain("destroy:1");
  });

  test("rejects invalid attempt identity/generation before candidate side effects", async () => {
    for (const [attemptId, generation] of [
      ["bad id", 1],
      ["valid", 0],
      ["valid", 1.5],
    ] as const) {
      const { registry, calls } = harness();
      const a = registry.ensure("https://a.example");
      expect(await registry.prepareSwitch({
        attemptId,
        generation,
        canonicalOrigin: "https://b.example",
        priorRegistryScope: a.scope,
        priorAuthorityGuard: priorGuard(a.serverUrl),
    candidateServerFingerprint: "fingerprint-b",
    awaitNavigationReceipt: async (input) => receipt(input),
      })).toEqual({ ok: false, reason: "invalid-attempt" });
      expect(calls).toEqual([]);
      expect(registry.getByServerUrl("https://b.example")).toBeNull();
    }
  });

  test("rejects adversarial navigation attempt/generation/time receipts", async () => {
    const cases = [
      { attemptId: "another" },
      { generation: 99 },
      { observedAtMs: -1 },
      { observedAtMs: Number.NaN },
    ];
    for (const overrides of cases) {
      const { registry, calls, attachExisting } = harness();
      const a = registry.ensure("https://a.example");
      attachExisting(a, 100);
      const result = await registry.prepareSwitch({
        attemptId: "receipt-test",
        generation: 7,
        canonicalOrigin: "https://b.example",
        priorRegistryScope: a.scope,
        priorAuthorityGuard: priorGuard(a.serverUrl),
        candidateServerFingerprint: "fingerprint-b",
        awaitNavigationReceipt: async (input) => receipt(input, overrides),
      });
      expect(result).toEqual({ ok: false, reason: "invalid-receipt" });
      expect(registry.active).toBe(a);
      expect(registry.getByServerUrl("https://b.example")).toBeNull();
      expect(calls).toContain("destroy:1");
    }
    const { registry, calls } = harness();
    const a = registry.ensure("https://a.example");
    const malformed = await registry.prepareSwitch({
      attemptId: "malformed-receipt",
      generation: 1,
      canonicalOrigin: "https://b.example",
      priorRegistryScope: a.scope,
      priorAuthorityGuard: priorGuard(a.serverUrl),
      candidateServerFingerprint: "fingerprint-b",
      awaitNavigationReceipt: async () => null as never,
    });
    expect(malformed).toEqual({ ok: false, reason: "invalid-receipt" });
    expect(calls).toContain("destroy:1");
  });

  test("rejects path/noncanonical origins and a stale prior scope", async () => {
    const { registry } = harness();
    const a = registry.ensure("https://a.example");
    expect(await registry.prepareSwitch({
      attemptId: "bad",
      generation: 1,
      canonicalOrigin: "https://b.example/path",
      priorRegistryScope: a.scope,
      priorAuthorityGuard: priorGuard(a.serverUrl),
    candidateServerFingerprint: "fingerprint-b",
    awaitNavigationReceipt: async (input) => receipt(input),
    })).toEqual({ ok: false, reason: "invalid-origin" });
    expect(await registry.prepareSwitch({
      attemptId: "stale",
      generation: 2,
      canonicalOrigin: "https://b.example",
      routingServerUrl: "https://b.example",
      identityTransition: { kind: "ordinary" },
      priorRegistryScope: "not-active",
      priorAuthorityGuard: priorGuard("https://not-active.example"),
    candidateServerFingerprint: "fingerprint-b",
    awaitNavigationReceipt: async (input) => receipt(input),
    })).toEqual({ ok: false, reason: "stale-prior" });
    expect(await registry.prepareSwitch({
      attemptId: "hashed-guard",
      generation: 3,
      canonicalOrigin: "https://b.example",
      priorRegistryScope: a.scope,
      priorAuthorityGuard: priorGuard(a.scope),
    candidateServerFingerprint: "fingerprint-b",
    awaitNavigationReceipt: async (input) => receipt(input),
    })).toEqual({ ok: false, reason: "stale-prior" });
  });

  test("navigation failure and cross-origin receipt preserve A and clean only new B", async () => {
    for (const mode of ["throw", "cross"] as const) {
      const { registry, calls, attachExisting } = harness();
      const a = registry.ensure("https://a.example");
      attachExisting(a, 100);
      const result = await registry.prepareSwitch({
        attemptId: mode,
        generation: 1,
        canonicalOrigin: "https://b.example",
        priorRegistryScope: a.scope,
        priorAuthorityGuard: priorGuard(a.serverUrl),
        candidateServerFingerprint: "fingerprint-b",
        awaitNavigationReceipt: async (input) => {
          if (mode === "throw") throw new Error("navigation failed");
          return receipt(input, { origin: "https://redirect.example" });
        },
      });
      expect(result).toEqual({
        ok: false,
        reason: mode === "throw" ? "navigation-failed" : "cross-origin",
      });
      expect(registry.active).toBe(a);
      expect(registry.getByServerUrl("https://b.example")).toBeNull();
      expect(calls).toContain("destroy:1");
      expect(calls).not.toContain("destroy:100");
    }
  });

  test("candidate creation failure is typed and leaves no candidate session", async () => {
    const registry = new ServerSessionRegistry();
    const a = registry.ensure("https://a.example");
    registry.configure({
      createCandidateView: () => { throw new Error("electron rejected view"); },
      attachCandidateView: () => {},
      bindCandidateSender: () => {},
      destroyCandidateView: () => {},
    });
    const result = await registry.prepareSwitch({
      attemptId: "create-failure",
      generation: 1,
      canonicalOrigin: "https://b.example",
      routingServerUrl: "https://b.example",
      identityTransition: { kind: "ordinary" },
      priorRegistryScope: a.scope,
      priorAuthorityGuard: priorGuard(a.serverUrl),
    candidateServerFingerprint: "fingerprint-b",
    awaitNavigationReceipt: async (input) => receipt(input),
    });
    expect(result).toEqual({ ok: false, reason: "view-unavailable" });
    expect(registry.active).toBe(a);
    expect(registry.getByServerUrl("https://b.example")).toBeNull();
  });

  test("existing B is observed without creation, hiding, or SPA navigation by registry", async () => {
    const { registry, calls, attached, attachExisting } = harness();
    const a = registry.ensure("https://a.example");
    attachExisting(a, 100);
    const b = registry.ensure("https://b.example");
    const bView = attachExisting(b, 200);
    let observed: unknown;
    const result = await registry.prepareSwitch({
      attemptId: "existing-b",
      generation: 3,
      canonicalOrigin: "https://b.example",
      priorRegistryScope: a.scope,
      priorAuthorityGuard: priorGuard(a.serverUrl),
      candidateServerFingerprint: "fingerprint-b",
      awaitNavigationReceipt: async (input) => {
        observed = input;
        return receipt(input);
      },
    });
    expect(result.ok).toBe(true);
    expect(observed).toMatchObject({ view: bView, newlyCreatedView: false });
    expect(calls).toEqual([]);
    expect(registry.active).toBe(a);
  });

  test("same-origin identity replacement stays detached with separate facts until promotion", async () => {
    const { registry, calls, attached, attachExisting } = harness();
    const active = registry.ensure("https://a.example");
    const oldView = attachExisting(active, 100);
    active.signedIn = true;
    active.connection = "live";
    active.profile = { name: "Existing A", iconUrl: "a.png" };
    registry.attachSender(100, active.scope);
    const accepted = receipt({
      attemptId: "identity-replacement",
      generation: 6,
      expectedOrigin: active.serverUrl,
    }, { observedAtMs: 90 });
    const prepared = await registry.prepareSwitch({
      attemptId: "identity-replacement",
      generation: 6,
      canonicalOrigin: active.serverUrl,
      priorRegistryScope: active.scope,
      priorAuthorityGuard: {
        scope: active.serverUrl,
        revision: "revision-a",
        connectionAttemptId: "attempt-a",
        serverFingerprint: "fingerprint-a",
      },
      forceDetachedReplacement: true,
      routingServerUrl: active.serverUrl,
      identityTransition: { kind: "accepted-identity-replacement", priorConnectionAttemptId: "attempt-a",
        priorServerFingerprint: "fingerprint-a", priorRoutingServerUrl: active.serverUrl },
      acceptedIdentityReplacementReceipt: accepted,
      candidateServerFingerprint: "fingerprint-new-identity",
      awaitNavigationReceipt: async (input) => {
        expect(input.session).not.toBe(active);
        input.session.connection = "offline";
        input.session.signedIn = false;
        input.session.profile = { name: "Candidate B", iconUrl: "b.png" };
        return receipt(input);
      },
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.handle.session).not.toBe(active);
    expect(prepared.handle.session.view).toBe(prepared.handle.view);
    expect(prepared.handle.session.partition).not.toBe(active.partition);
    expect(prepared.handle.session.partition).toBe(
      `server-candidate-${active.scope}-identity-replacement-6`,
    );
    expect(prepared.handle.session.partition.startsWith("persist:")).toBe(false);
    expect(active.partition).toBe(`persist:server-${active.scope}`);
    expect(active.view).toBe(oldView);
    expect(active.signedIn).toBe(true);
    expect(active.connection).toBe("live");
    expect(active.profile).toEqual({ name: "Existing A", iconUrl: "a.png" });
    expect(prepared.handle.session.connection).toBe("offline");
    expect(prepared.handle.session.profile).toEqual({
      name: "Candidate B",
      iconUrl: "b.png",
    });
    expect(registry.active).toBe(active);
    expect(registry.getByServerUrl(active.serverUrl)).toBe(active);
    expect(registry.getBySender(100)).toBe(active);
    expect(registry.getBySender(1)).toBeNull();
    expect(attached.has(1)).toBe(false);
    expect(calls).toEqual(["create:https://a.example"]);

    const promoted = await registry.promotePrepared(
      prepared.handle,
      promotionHooks(calls, { shouldStartTargetRelay: false, retireOldIdentity: async () => { calls.push("old-identity"); } }),
    );
    expect(promoted.ok).toBe(true);
    expect(registry.active).toBe(prepared.handle.session);
    expect(registry.getByServerUrl(active.serverUrl)).toBe(prepared.handle.session);
    expect(registry.getBySender(1)).toBe(prepared.handle.session);
    expect(registry.getBySender(100)).toBeNull();
    expect(prepared.handle.session.view).toBe(prepared.handle.view);
    expect(calls).toContain("bind:1");
    expect(calls).toContain("hide:100");
    expect(calls).toContain("destroy-attached:100");
  });

  test("same-scope replacement rejects missing or stale acceptance receipts before B exists", async () => {
    for (const replacementReceipt of [undefined, {
      attemptId: "wrong-attempt", generation: 6, origin: "https://a.example", observedAtMs: 1,
    }, {
      attemptId: "identity-replacement", generation: 5, origin: "https://a.example", observedAtMs: 1,
    }] as const) {
      const { registry, calls, attachExisting } = harness();
      const active = registry.ensure("https://a.example");
      const oldView = attachExisting(active, 100);
      const result = await registry.prepareSwitch({
        attemptId: "identity-replacement", generation: 6, canonicalOrigin: active.serverUrl,
        priorRegistryScope: active.scope, priorAuthorityGuard: priorGuard(active.serverUrl),
        forceDetachedReplacement: true, acceptedIdentityReplacementReceipt: replacementReceipt,
        candidateServerFingerprint: "fingerprint-new-identity",
        awaitNavigationReceipt: async (input) => receipt(input),
      });
      expect(result).toEqual({ ok: false, reason: "invalid-receipt" });
      expect(registry.active).toBe(active);
      expect(active.view).toBe(oldView);
      expect(calls).toEqual([]);
    }
  });

  test("failed same-origin replacement destroys only detached candidate", async () => {
    const { registry, calls, attached, attachExisting } = harness();
    const active = registry.ensure("https://a.example");
    const oldView = attachExisting(active, 100);
    registry.attachSender(100, active.scope);
    const result = await registry.prepareSwitch({
      attemptId: "replacement-fails",
      generation: 7,
      canonicalOrigin: active.serverUrl,
      priorRegistryScope: active.scope,
      priorAuthorityGuard: priorGuard(active.serverUrl),
      forceDetachedReplacement: true,
      routingServerUrl: active.serverUrl,
      identityTransition: { kind: "accepted-identity-replacement", priorConnectionAttemptId: "prior-attempt",
        priorServerFingerprint: "fingerprint-a", priorRoutingServerUrl: active.serverUrl },
      acceptedIdentityReplacementReceipt: receipt({
        attemptId: "replacement-fails",
        generation: 7,
        expectedOrigin: active.serverUrl,
      }),
      candidateServerFingerprint: "fingerprint-new-identity",
      awaitNavigationReceipt: async (input) =>
        receipt(input, { origin: "https://redirect.example" }),
    });
    expect(result).toEqual({ ok: false, reason: "cross-origin" });
    expect(registry.active).toBe(active);
    expect(active.view).toBe(oldView);
    expect(registry.getBySender(100)).toBe(active);
    expect(calls).toContain("destroy:1");
    expect(calls).not.toContain("destroy-attached:100");
  });

  test("ordinary same-origin prepare reuses the SPA unless replacement is explicit", async () => {
    const { registry, calls, attachExisting } = harness();
    const active = registry.ensure("https://a.example");
    const view = attachExisting(active, 100);
    const result = await registry.prepareSwitch({
      attemptId: "same-origin-noop",
      generation: 8,
      canonicalOrigin: active.serverUrl,
      priorRegistryScope: active.scope,
      priorAuthorityGuard: priorGuard(active.serverUrl),
    candidateServerFingerprint: "fingerprint-b",
    awaitNavigationReceipt: async (input) => receipt(input),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.handle.view).toBe(view);
    expect(result.handle.newlyCreatedView).toBe(false);
    expect(calls).toEqual([]);
  });

  test("supersede fences late B completion and supports A→B→A", async () => {
    const { registry, calls, attachExisting } = harness();
    const a = registry.ensure("https://a.example");
    attachExisting(a, 100);
    const late = deferred<ReturnType<typeof receipt>>();
    const bPrepare = registry.prepareSwitch({
      attemptId: "b",
      generation: 4,
      canonicalOrigin: "https://b.example",
      priorRegistryScope: a.scope,
      priorAuthorityGuard: priorGuard(a.serverUrl),
      candidateServerFingerprint: "fingerprint-b",
      awaitNavigationReceipt: () => late.promise,
    });
    await Promise.resolve();
    const backToA = await registry.prepareSwitch({
      attemptId: "a-again",
      generation: 5,
      canonicalOrigin: "https://a.example",
      priorRegistryScope: a.scope,
      priorAuthorityGuard: priorGuard(a.serverUrl),
    candidateServerFingerprint: "fingerprint-b",
    awaitNavigationReceipt: async (input) => receipt(input),
    });
    expect(backToA.ok).toBe(true);
    late.resolve(receipt({
      attemptId: "b",
      generation: 4,
      expectedOrigin: "https://b.example",
    }));
    expect(await bPrepare).toEqual({ ok: false, reason: "superseded" });
    expect(registry.getByServerUrl("https://b.example")).toBeNull();
    expect(calls).toContain("destroy:1");
  });

  test("initial connection uses the same prepare/promote path with null A", async () => {
    const { registry, calls } = harness();
    const prepared = await registry.prepareSwitch({
      attemptId: "initial",
      generation: 1,
      canonicalOrigin: "https://first.example",
      priorRegistryScope: null,
      priorAuthorityGuard: priorGuard(null),
    candidateServerFingerprint: "fingerprint-b",
    awaitNavigationReceipt: async (input) => receipt(input),
    });
    expect(prepared.ok).toBe(true);
    expect(registry.active).toBeNull();
    if (!prepared.ok) return;
    const promoted = await registry.promotePrepared(
      prepared.handle,
      promotionHooks(calls, { shouldStartTargetRelay: false }),
    );
    expect(promoted.ok).toBe(true);
    expect(registry.active?.serverUrl).toBe("https://first.example");
  });

  test("commit failure leaves A authoritative and destroys only candidate B", async () => {
    const { registry, calls, a, handle } = await preparedAB();
    const result = await registry.promotePrepared(handle, promotionHooks(calls, {
      commitActiveAuthority: async () => {
        calls.push("commit");
        return { committed: false as const };
      },
    }));
    expect(result).toEqual({ ok: false, reason: "commit-failed" });
    expect(registry.active).toBe(a);
    expect(registry.getByServerUrl("https://b.example")).toBeNull();
    expect(calls).toContain("destroy:1");
    expect(calls).not.toContain("active:100:false");
  });

  test("committed result with followup failure never rolls back or recommits", async () => {
    const { registry, calls, handle } = await preparedAB();
    const hooks = promotionHooks(calls, {
      commitActiveAuthority: async () => {
        calls.push("commit-with-followup-failure");
        return { committed: true as const, followupFailure: "metadata" as const };
      },
    });
    const failed = await registry.promotePrepared(handle, hooks);
    expect(failed).toMatchObject({
      ok: false,
      reason: "postcommit-failed",
      checkpoint: "metadata",
    });
    expect(registry.active).toBe(handle.session);
    expect(registry.getByServerUrl("https://b.example")).toBe(handle.session);
    expect(calls).not.toContain("destroy:1");
    expect((await registry.promotePrepared(handle, hooks)).ok).toBe(true);
    expect(calls.filter((call) => call === "commit-with-followup-failure")).toHaveLength(1);
  });

  test("thrown commit outcome blocks both authorities until exact reread proves A", async () => {
    const { registry, calls, a, handle } = await preparedAB();
    registry.attachSender(100, a.scope);
    registry.attachSender(1, handle.targetRegistryScope);
    const unknown = await registry.promotePrepared(handle, promotionHooks(calls, {
      commitActiveAuthority: async () => {
        calls.push("commit-throws");
        throw new Error("rename outcome unavailable");
      },
    }));
    expect(unknown).toMatchObject({
      ok: false,
      reason: "commit-outcome-unknown",
      handle,
    });
    expect(handle.status).toBe("commit-outcome-unknown");
    expect(registry.active).toBe(a);
    expect(calls).not.toContain("metadata");
    expect(calls).not.toContain("attach:1");
    expect(() => registry.resolveActiveFromSenderOrThrow(100)).toThrow(
      "commit outcome is unknown",
    );
    expect(() => registry.resolveActiveFromSenderOrThrow(1)).toThrow(
      "commit outcome is unknown",
    );
    expect(registry.resolveUnknownCommitOutcome(handle, {
      scope: a.serverUrl,
      revision: "different-revision",
      connectionAttemptId: "attempt-a",
      serverFingerprint: "fingerprint-a",
    })).toEqual({ outcome: "unresolved" });
    expect(registry.resolveUnknownCommitOutcome(handle, {
      scope: a.serverUrl,
      revision: null,
      connectionAttemptId: "attempt-a",
      serverFingerprint: "fingerprint-a",
    })).toEqual({ outcome: "unresolved" });
    expect(registry.resolveUnknownCommitOutcome(handle, {
      scope: a.serverUrl,
      revision: "revision-a",
      connectionAttemptId: "attempt-a",
      serverFingerprint: "fingerprint-a",
    })).toEqual({ outcome: "not-committed" });
    expect(registry.active).toBe(a);
    expect(registry.getByServerUrl("https://b.example")).toBeNull();
    expect(registry.resolveActiveFromSenderOrThrow(100)).toBe(a);
  });

  test("malformed commit outcome stays blocked until exact B reread resumes without recommit", async () => {
    const { registry, calls, handle } = await preparedAB();
    let commits = 0;
    const hooks = promotionHooks(calls, {
      commitActiveAuthority: async () => {
        commits += 1;
        return undefined as never;
      },
    });
    const unknown = await registry.promotePrepared(handle, hooks);
    expect(unknown).toMatchObject({
      ok: false,
      reason: "commit-outcome-unknown",
    });
    expect(registry.resolveUnknownCommitOutcome(handle, {
      scope: "https://unrelated.example",
      revision: "revision-c",
      connectionAttemptId: "attempt-c",
      serverFingerprint: "fingerprint-c",
    })).toEqual({ outcome: "unresolved" });
    expect(handle.status).toBe("commit-outcome-unknown");
    expect(calls).not.toContain("metadata");
    expect(registry.resolveUnknownCommitOutcome(handle, {
      scope: handle.targetRegistryScope,
      revision: "revision-b",
      connectionAttemptId: handle.attemptId,
      serverFingerprint: "fingerprint-b",
    })).toEqual({ outcome: "unresolved" });
    expect(registry.resolveUnknownCommitOutcome(handle, {
      scope: handle.canonicalOrigin,
      revision: "revision-b",
      connectionAttemptId: handle.attemptId,
      serverFingerprint: "fingerprint-b",
    })).toEqual({ outcome: "committed-handoff", handle });
    expect(registry.active).toBe(handle.session);
    expect((await registry.promotePrepared(handle, hooks)).ok).toBe(true);
    expect(commits).toBe(1);
  });

  test("commit await is fenced from supersede and concurrent promotion", async () => {
    const { registry, calls, handle } = await preparedAB();
    calls.length = 0;
    const commit = deferred<void>();
    const hooks = promotionHooks(calls, {
      commitActiveAuthority: async () => {
        calls.push("commit");
        await commit.promise;
        return { committed: true as const };
      },
    });
    const promoting = registry.promotePrepared(handle, hooks);
    await Promise.resolve();
    expect(handle.status).toBe("committing");
    expect(await registry.prepareSwitch({
      attemptId: "c",
      generation: 3,
      canonicalOrigin: "https://c.example",
      priorRegistryScope: handle.priorRegistryScope,
      priorAuthorityGuard: handle.priorAuthorityGuard!,
    candidateServerFingerprint: "fingerprint-b",
    awaitNavigationReceipt: async (input) => receipt(input),
    })).toEqual({ ok: false, reason: "committed-handoff-pending" });
    expect(await registry.promotePrepared(handle, hooks)).toEqual({
      ok: false,
      reason: "stale-handle",
    });
    commit.resolve();
    expect((await promoting).ok).toBe(true);
  });

  test("promotion linearizes at commit then performs the ordered handoff", async () => {
    const { registry, calls, handle } = await preparedAB();
    calls.length = 0;
    const result = await registry.promotePrepared(handle, promotionHooks(calls));
    expect(result).toEqual({
      ok: true,
      receipt: {
        attemptId: "attempt-b",
        generation: 2,
        canonicalOrigin: "https://b.example",
        targetRegistryScope: handle.targetRegistryScope,
      },
    });
    expect(registry.active).toBe(handle.session);
    expect(calls).toEqual([
      "commit",
      "metadata",
      "old-codex",
      "old-relay",
      "old-profile",
      "active:100:false",
      "bind:1",
      "active:1:true",
      "attach:1",
      "show:1",
      "hide:100",
      "target-relay",
      "pending-clear",
    ]);
  });

  test("committed promotion can pause before renderer authority and resume once", async () => {
    const { registry, calls, attached, a, handle } = await preparedAB();
    calls.length = 0;
    const hooks = promotionHooks(calls, { pauseBeforeRendererAuthority: true });
    const paused = await registry.promotePrepared(handle, hooks);
    expect(paused).toEqual({
      ok: true,
      paused: true,
      handle,
      checkpoint: "renderer-authority",
    });
    expect(handle.status).toBe("committed-paused");
    expect(a.view).not.toBeNull();
    expect(attached.has(1)).toBe(false);
    expect(calls).toEqual([
      "commit",
      "metadata",
      "old-codex",
      "old-relay",
      "old-profile",
    ]);

    const resumed = await registry.promotePrepared(
      handle,
      { ...hooks, pauseBeforeRendererAuthority: false },
    );
    expect(resumed.ok).toBe(true);
    expect(calls.filter((call) => call === "commit")).toHaveLength(1);
    expect(calls.filter((call) => call === "attach:1")).toHaveLength(1);
    expect(calls.filter((call) => call === "show:1")).toHaveLength(1);
    expect(calls.filter((call) => call === "hide:100")).toHaveLength(1);
  });

  test("persists each next checkpoint before executing that effect", async () => {
    const { registry, calls, handle } = await preparedAB();
    calls.length = 0;
    const checkpoints: string[] = [];
    const result = await registry.promotePrepared(handle, promotionHooks(calls, {
      persistNextCheckpoint: async (checkpoint: string) => {
        checkpoints.push(checkpoint);
      },
    }));
    expect(result.ok).toBe(true);
    expect(checkpoints).toEqual([
      "old-codex",
      "old-relay",
      "old-profile",
      "old-identity",
      "renderer-authority",
      "visibility",
      "target-relay",
      "pending-clear",
    ]);
  });

  test("checkpoint persistence failure does not execute the next effect", async () => {
    const { registry, calls, handle } = await preparedAB();
    calls.length = 0;
    let attempts = 0;
    const hooks = promotionHooks(calls, {
      persistNextCheckpoint: async (checkpoint: string) => {
        if (checkpoint === "old-codex" && attempts++ === 0) {
          throw new Error("journal unavailable");
        }
      },
    });
    const failed = await registry.promotePrepared(handle, hooks);
    expect(failed).toMatchObject({
      ok: false,
      reason: "postcommit-failed",
      checkpoint: "old-codex",
    });
    expect(calls).toContain("metadata");
    expect(calls).not.toContain("old-codex");
    expect((await registry.promotePrepared(handle, hooks)).ok).toBe(true);
    expect(calls.slice(0, 4)).toEqual([
      "commit",
      "metadata",
      "metadata",
      "old-codex",
    ]);
    expect(calls.filter((call) => call === "metadata")).toHaveLength(2);
    expect(calls.filter((call) => call === "old-codex")).toHaveLength(1);
  });

  test("privileged IPC fails closed between durable commit and renderer checkpoint", async () => {
    const { registry, calls, a, handle } = await preparedAB();
    registry.attachSender(100, a.scope);
    registry.attachSender(1, handle.targetRegistryScope);
    expect(registry.resolveActiveFromSenderOrThrow(100)).toBe(a);
    let metadataAttempts = 0;
    const hooks = promotionHooks(calls, {
      persistMetadata: async () => {
        metadataAttempts += 1;
        if (metadataAttempts === 1) throw new Error("metadata unavailable");
      },
    });
    const failed = await registry.promotePrepared(handle, hooks);
    expect(failed).toMatchObject({
      ok: false,
      reason: "postcommit-failed",
      checkpoint: "metadata",
    });
    expect(() => registry.resolveActiveFromSenderOrThrow(100)).toThrow(
      "sender is not the active session",
    );
    expect(() => registry.resolveActiveFromSenderOrThrow(1)).toThrow(
      "handoff is incomplete",
    );
    expect((await registry.promotePrepared(handle, hooks)).ok).toBe(true);
    expect(registry.resolveActiveFromSenderOrThrow(1)).toBe(handle.session);
  });

  test("B without auth still unconditionally tears down A relay and skips B relay", async () => {
    const { registry, calls, handle } = await preparedAB();
    calls.length = 0;
    const result = await registry.promotePrepared(
      handle,
      promotionHooks(calls, { shouldStartTargetRelay: false }),
    );
    expect(result.ok).toBe(true);
    expect(calls).toContain("old-relay");
    expect(calls).not.toContain("target-relay");
  });

  test("postcommit failure exposes resume-only checkpoint without recommit/double steps", async () => {
    const { registry, calls, handle } = await preparedAB();
    calls.length = 0;
    let clearAttempts = 0;
    const hooks = promotionHooks(calls, {
      clearPending: async () => {
        calls.push("pending-clear");
        clearAttempts += 1;
        if (clearAttempts === 1) throw new Error("fsync failed");
      },
    });
    const failed = await registry.promotePrepared(handle, hooks);
    expect(failed).toMatchObject({
      ok: false,
      reason: "postcommit-failed",
      checkpoint: "pending-clear",
    });
    expect(handle.status).toBe("committed-handoff");
    expect(registry.active).toBe(handle.session);

    const another = await registry.prepareSwitch({
      attemptId: "not-allowed",
      generation: 9,
      canonicalOrigin: "https://c.example",
      priorRegistryScope: handle.targetRegistryScope,
      priorAuthorityGuard: priorGuard(handle.canonicalOrigin),
    candidateServerFingerprint: "fingerprint-b",
    awaitNavigationReceipt: async (input) => receipt(input),
    });
    expect(another).toEqual({ ok: false, reason: "committed-handoff-pending" });

    const resumed = await registry.promotePrepared(handle, hooks);
    expect(resumed.ok).toBe(true);
    expect(calls.filter((call) => call === "commit")).toHaveLength(1);
    expect(calls.filter((call) => call === "metadata")).toHaveLength(1);
    expect(calls.filter((call) => call === "pending-clear")).toHaveLength(2);
    const repeated = await registry.promotePrepared(handle, hooks);
    expect(repeated).toEqual(resumed);
    expect(calls.filter((call) => call === "commit")).toHaveLength(1);

    const next = await registry.prepareSwitch({
      attemptId: "next",
      generation: 10,
      canonicalOrigin: "https://c.example",
      priorRegistryScope: handle.targetRegistryScope,
      priorAuthorityGuard: priorGuard(handle.canonicalOrigin),
      candidateServerFingerprint: "fingerprint-b",
      awaitNavigationReceipt: async (input) => receipt(input),
    });
    expect(next.ok).toBe(true);
  });

  test("fresh registry resumes committed handoff without invoking commit", async () => {
    const { registry, calls, attached, attachExisting } = harness();
    const b = registry.ensure("https://b.example/legacy/base");
    attachExisting(b, 200);
    const a = registry.ensure("https://a.example");
    attachExisting(a, 100);
    registry.attachSender(200, b.scope);
    registry.attachSender(100, a.scope);
    const resumed = registry.beginCommittedHandoffRecovery({
      attemptId: "resumed-attempt",
      generation: 8,
      canonicalOrigin: "https://b.example",
      routingServerUrl: b.serverUrl,
      targetRegistryScope: b.scope,
      priorRegistryScope: a.scope,
      nextCheckpoint: "metadata",
      identityTransition: { kind: "ordinary" },
      requiresEphemeralFactReconstructionAndRevalidation: true,
      priorRecoveryGuard: priorGuard(a.serverUrl),
      currentActiveAuthority: {
        scope: "https://b.example",
        revision: "revision-b",
        connectionAttemptId: "resumed-attempt",
        serverFingerprint: "fingerprint-b",
      },
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.handle.status).toBe("awaiting-revalidation");
    expect(resumed.handle.navigationReceipt).toBeNull();
    expect(resumed.handle.session).not.toBe(b);
    expect(resumed.handle.canonicalOrigin).toBe("https://b.example");
    expect(resumed.handle.session.serverUrl).toBe("https://b.example/legacy/base");
    expect(resumed.handle.session.view).toBe(resumed.handle.view);
    expect(resumed.handle.session.partition).toBe(
      `server-candidate-${b.scope}-resumed-attempt-8`,
    );
    expect(resumed.handle.session.partition.startsWith("persist:")).toBe(false);
    expect(b.partition).toBe(`persist:server-${b.scope}`);
    expect(resumed.handle.view).toEqual({ id: 1 });
    expect(attached.has(1)).toBe(false);
    expect(registry.active).toBe(b);
    expect(() => registry.resolveActiveFromSenderOrThrow(200)).toThrow(
      "revalidation is incomplete",
    );
    expect(() => registry.resolveActiveFromSenderOrThrow(100)).toThrow(
      "revalidation is incomplete",
    );
    expect(registry.completeCommittedHandoffRevalidation(
      resumed.handle,
      {
        navigationReceipt: receipt({
          attemptId: "resumed-attempt",
          generation: 8,
          expectedOrigin: "https://b.example",
        }),
        serverFingerprint: "fingerprint-b",
      },
    ).ok).toBe(true);
    let commits = 0;
    const hooks = promotionHooks(calls, {
      commitActiveAuthority: async () => {
        commits += 1;
        return { committed: true as const };
      },
      shouldStartTargetRelay: false,
      pauseBeforeRendererAuthority: true,
    });
    const paused = await registry.promotePrepared(
      resumed.handle,
      hooks,
    );
    expect(paused).toMatchObject({
      ok: true,
      paused: true,
      checkpoint: "renderer-authority",
    });
    expect(attached.has(1)).toBe(false);
    expect(calls).not.toContain("show:1");
    expect(calls).not.toContain("hide:200");
    const result = await registry.promotePrepared(
      resumed.handle,
      { ...hooks, pauseBeforeRendererAuthority: false },
    );
    expect(result.ok).toBe(true);
    expect(commits).toBe(0);
    expect(registry.active).toBe(resumed.handle.session);
    expect(registry.getByServerUrl("https://b.example/legacy/base")).toBe(
      resumed.handle.session,
    );
    expect(registry.getByServerUrl("https://b.example")).toBeNull();
    expect(registry.getBySender(200)).toBeNull();
    expect(registry.getBySender(1)).toBe(resumed.handle.session);
    expect(calls).toContain("old-relay");
    expect(calls).toContain("old-profile");
    expect(calls).toContain("active:1:true");
    expect(calls).toContain("hide:200");
    expect(calls).toContain("destroy-attached:200");
  });

  test("accepted recovery retries old-identity without a live A and fences renderer authority", async () => {
    const { registry, calls, attachExisting } = harness();
    const b = registry.ensure("https://b.example/base");
    attachExisting(b, 200);
    const marker = { kind: "accepted-identity-replacement" as const, priorConnectionAttemptId: "attempt-a",
      priorServerFingerprint: "fingerprint-a", priorRoutingServerUrl: "https://b.example/old" };
    const begun = registry.beginCommittedHandoffRecovery({ attemptId: "attempt-b", generation: 8,
      canonicalOrigin: "https://b.example", routingServerUrl: b.serverUrl, targetRegistryScope: b.scope,
      priorRegistryScope: null, nextCheckpoint: "old-identity", requiresEphemeralFactReconstructionAndRevalidation: true,
      priorRecoveryGuard: { scope: "https://b.example", revision: "revision-a" }, identityTransition: marker,
      currentActiveAuthority: { scope: "https://b.example", revision: "revision-b", connectionAttemptId: "attempt-b", serverFingerprint: "fingerprint-b" },
    });
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    expect(registry.completeCommittedHandoffRevalidation(begun.handle, { navigationReceipt: receipt({ attemptId: "attempt-b", generation: 8, expectedOrigin: "https://b.example" }), serverFingerprint: "fingerprint-b" }).ok).toBe(true);
    let tries = 0;
    const hooks = promotionHooks(calls, { commitActiveAuthority: async () => ({ committed: false }),
      retireOldIdentity: async (input: unknown) => { calls.push(`retire:${JSON.stringify(input)}`); if (tries++ === 0) throw new Error("retry"); },
    });
    const failed = await registry.promotePrepared(begun.handle, hooks);
    expect(failed).toMatchObject({ ok: false, reason: "postcommit-failed", checkpoint: "old-identity" });
    expect(calls.some((call) => call.startsWith("bind:") || call.startsWith("show:") || call.startsWith("attach:"))).toBe(false);
    const resumed = await registry.promotePrepared(begun.handle, hooks);
    expect(resumed.ok).toBe(true);
    expect(calls.filter((call) => call.startsWith("retire:"))).toHaveLength(2);
    expect(calls.filter((call) => call.startsWith("bind:") || call.startsWith("show:") || call.startsWith("attach:"))).toHaveLength(3);
  });

  test("committed recovery stays privilege-fenced when candidate creation must retry", async () => {
    const { registry, attachExisting } = harness();
    const b = registry.ensure("https://b.example");
    attachExisting(b, 200);
    registry.attachSender(200, b.scope);
    registry.configure({});
    const input = {
      attemptId: "recovery-retry",
      generation: 9,
      canonicalOrigin: b.serverUrl,
      routingServerUrl: b.serverUrl,
      targetRegistryScope: b.scope,
      priorRegistryScope: null,
      nextCheckpoint: "metadata" as const,
      identityTransition: { kind: "ordinary" as const },
      requiresEphemeralFactReconstructionAndRevalidation: true as const,
      priorRecoveryGuard: {
        scope: "https://a.example",
        revision: "revision-a",
      },
      currentActiveAuthority: {
        scope: b.serverUrl,
        revision: "revision-b",
        connectionAttemptId: "recovery-retry",
        serverFingerprint: "fingerprint-b",
      },
    };
    expect(registry.beginCommittedHandoffRecovery(input)).toEqual({
      ok: false,
      reason: "view-unavailable",
    });
    expect(() => registry.resolveActiveFromSenderOrThrow(200)).toThrow(
      "handoff is incomplete",
    );
    expect(await registry.switchTo("https://b.example")).toEqual({
      ok: false,
      reason: "handoff-pending",
    });

    registry.configure({
      createCandidateView: () => ({ id: 9 }) as never,
      attachCandidateView: () => {},
      bindCandidateSender: (_previous, candidate, view) => {
        registry.attachSender((view as unknown as MockView).id, candidate.scope);
      },
      destroyCandidateView: () => {},
      destroyView: () => {},
    });
    const retried = registry.beginCommittedHandoffRecovery(input);
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.handle.status).toBe("awaiting-revalidation");
    expect(retried.handle.view).toEqual({ id: 9 });
    expect(registry.active).toBe(b);
  });

  test("resume rejects records that do not exactly match current target authority", () => {
    const { registry, attachExisting } = harness();
    const b = registry.ensure("https://b.example");
    attachExisting(b, 200);
    expect(registry.beginCommittedHandoffRecovery({
      attemptId: "bad id",
      generation: 8,
      canonicalOrigin: "https://b.example",
      routingServerUrl: "https://b.example",
      targetRegistryScope: b.scope,
      priorRegistryScope: null,
      nextCheckpoint: "metadata",
      requiresEphemeralFactReconstructionAndRevalidation: true,
      priorRecoveryGuard: priorGuard(null),
      currentActiveAuthority: {
        scope: b.serverUrl,
        revision: "revision-b",
        connectionAttemptId: "bad id",
        serverFingerprint: "fingerprint-b",
      },
    })).toEqual({ ok: false, reason: "invalid-record" });
    expect(registry.beginCommittedHandoffRecovery({
      attemptId: "valid-id",
      generation: 8,
      canonicalOrigin: "https://b.example",
      routingServerUrl: "https://b.example/legacy/base?credential=nope",
      targetRegistryScope: b.scope,
      priorRegistryScope: null,
      nextCheckpoint: "metadata",
      requiresEphemeralFactReconstructionAndRevalidation: true,
      priorRecoveryGuard: priorGuard(null),
      currentActiveAuthority: {
        scope: b.serverUrl,
        revision: "revision-b",
        connectionAttemptId: "valid-id",
        serverFingerprint: "fingerprint-b",
      },
    })).toEqual({ ok: false, reason: "invalid-record" });
    expect(registry.beginCommittedHandoffRecovery({
      attemptId: "valid-id",
      generation: 8,
      canonicalOrigin: "https://c.example",
      routingServerUrl: "https://c.example",
      targetRegistryScope: b.scope,
      priorRegistryScope: null,
      nextCheckpoint: "metadata",
      requiresEphemeralFactReconstructionAndRevalidation: true,
      priorRecoveryGuard: priorGuard(null),
      currentActiveAuthority: {
        scope: "https://c.example",
        revision: "revision-c",
        connectionAttemptId: "valid-id",
        serverFingerprint: "fingerprint-c",
      },
    })).toEqual({ ok: false, reason: "invalid-record" });
    expect(registry.beginCommittedHandoffRecovery({
      attemptId: "valid-id",
      generation: 8,
      canonicalOrigin: "https://b.example",
      routingServerUrl: "https://b.example",
      targetRegistryScope: "wrong-scope",
      priorRegistryScope: null,
      nextCheckpoint: "metadata",
      requiresEphemeralFactReconstructionAndRevalidation: true,
      priorRecoveryGuard: priorGuard(null),
      currentActiveAuthority: {
        scope: b.serverUrl,
        revision: "revision-b",
        connectionAttemptId: "valid-id",
        serverFingerprint: "fingerprint-b",
      },
    })).toEqual({ ok: false, reason: "invalid-record" });
    expect(registry.beginCommittedHandoffRecovery({
      attemptId: "valid-id",
      generation: 8,
      canonicalOrigin: "https://b.example",
      routingServerUrl: "https://b.example",
      targetRegistryScope: b.scope,
      priorRegistryScope: null,
      nextCheckpoint: "metadata",
      requiresEphemeralFactReconstructionAndRevalidation: false as never,
      priorRecoveryGuard: priorGuard(null),
      currentActiveAuthority: {
        scope: b.serverUrl,
        revision: "revision-b",
        connectionAttemptId: "valid-id",
        serverFingerprint: "fingerprint-b",
      },
    })).toEqual({ ok: false, reason: "invalid-record" });
  });

  test("fresh resume reestablishes renderer privilege even from a later checkpoint", async () => {
    const { registry, calls, attached, attachExisting } = harness();
    const b = registry.ensure("https://b.example");
    attachExisting(b, 200);
    registry.attachSender(200, b.scope);
    const resumed = registry.beginCommittedHandoffRecovery({
      attemptId: "late-checkpoint",
      generation: 11,
      canonicalOrigin: "https://b.example",
      routingServerUrl: "https://b.example",
      targetRegistryScope: b.scope,
      priorRegistryScope: null,
      nextCheckpoint: "pending-clear",
      identityTransition: { kind: "ordinary" },
      requiresEphemeralFactReconstructionAndRevalidation: true,
      priorRecoveryGuard: priorGuard(null),
      currentActiveAuthority: {
        scope: b.serverUrl,
        revision: "revision-b",
        connectionAttemptId: "late-checkpoint",
        serverFingerprint: "fingerprint-b",
      },
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.handle.navigationReceipt).toBeNull();
    expect(resumed.handle.checkpoint).toBe("pending-clear");
    expect(() => registry.resolveActiveFromSenderOrThrow(200)).toThrow(
      "revalidation is incomplete",
    );
    const beforeProof = await registry.promotePrepared(
      resumed.handle,
      promotionHooks(calls, { shouldStartTargetRelay: false }),
    );
    expect(beforeProof).toEqual({ ok: false, reason: "stale-handle" });
    expect(registry.completeCommittedHandoffRevalidation(
      resumed.handle,
      {
        navigationReceipt: receipt({
          attemptId: "wrong-attempt",
          generation: 11,
          expectedOrigin: "https://b.example",
        }),
        serverFingerprint: "wrong-fingerprint",
      },
    )).toEqual({ ok: false, reason: "invalid-receipt" });
    expect(resumed.handle.status).toBe("awaiting-revalidation");
    expect(registry.completeCommittedHandoffRevalidation(
      resumed.handle,
      {
        navigationReceipt: receipt({
          attemptId: "late-checkpoint",
          generation: 11,
          expectedOrigin: "https://b.example",
        }),
        serverFingerprint: "fingerprint-b",
      },
    ).ok).toBe(true);
    const hooks = promotionHooks(calls, {
      shouldStartTargetRelay: false,
      pauseBeforeRendererAuthority: true,
    });
    expect(await registry.promotePrepared(
      resumed.handle,
      hooks,
    )).toMatchObject({
      ok: true,
      paused: true,
      checkpoint: "renderer-authority",
    });
    expect(attached.has(1)).toBe(false);
    expect(calls).not.toContain("show:1");
    expect(calls).not.toContain("hide:200");
    expect((await registry.promotePrepared(
      resumed.handle,
      { ...hooks, pauseBeforeRendererAuthority: false },
    )).ok).toBe(true);
    expect(registry.getBySender(200)).toBeNull();
    expect(registry.resolveActiveFromSenderOrThrow(1)).toBe(resumed.handle.session);
    expect(calls).not.toContain("metadata");
    expect(calls).toContain("active:1:true");
    expect(calls).toContain("attach:1");
    expect(calls).toContain("show:1");
    expect(calls).toContain("hide:200");
    expect(calls).toContain("destroy-attached:200");
  });

  test("committed pending handoff gates legacy authority mutators", async () => {
    const { registry, calls, handle } = await preparedAB();
    const failed = await registry.promotePrepared(handle, promotionHooks(calls, {
      persistMetadata: async () => { throw new Error("pause handoff"); },
    }));
    expect(failed).toMatchObject({ ok: false, reason: "postcommit-failed" });
    let fallbackCalls = 0;
    registry.configure({
      activateFallback: async () => { fallbackCalls += 1; return { kind: "activated" }; },
    });
    expect(await registry.switchTo("https://a.example")).toEqual({
      ok: false,
      reason: "handoff-pending",
    });
    expect(await registry.add("https://c.example")).toEqual({
      ok: false,
      reason: "handoff-pending",
    });
    expect(await registry.close("https://b.example")).toEqual({
      ok: false,
      reason: "handoff-pending",
    });
    expect(await registry.forget("https://b.example", [])).toEqual({
      ok: false,
      reason: "handoff-pending",
    });
    expect(fallbackCalls).toBe(0);
    expect(() => registry.ensure("https://c.example")).toThrow(
      "server-session-handoff-pending",
    );
    expect(registry.attachSender(7, handle.targetRegistryScope)).toBe(true);
    expect(registry.getBySender(7)).toBe(handle.session);
  });

  test("definite fallback failure cannot destructively forget across a prepared fence", async () => {
    const { registry } = await preparedAB();
    let teardown = 0;
    registry.configure({
      activateFallback: async () => ({
        kind: "not-activated",
        result: { ok: false, reason: "offline" },
      }),
      teardownForgottenActive: async () => { teardown += 1; },
    });
    expect(await registry.forget("https://a.example", ["https://a.example"], "https://b.example")).toEqual({
      ok: false,
      reason: "handoff-pending",
    });
    expect(teardown).toBe(0);
    expect(registry.getByServerUrl("https://a.example")).not.toBeNull();
    expect(registry.getByServerUrl("https://b.example")).not.toBeNull();
  });
});
