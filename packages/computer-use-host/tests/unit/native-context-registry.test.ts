import { describe, expect, test } from "bun:test";
import {
  ComputerUseContextRegistry,
  type ComputerUseContextScope,
  type ComputerUseScreenSnapshotInput,
} from "../../src/native-context-registry.ts";

const scope: ComputerUseContextScope = {
  computerUseContextId: "computer-use-context-1",
  installationEpoch: "epoch-1",
  grantGeneration: 1,
  provider: "cua",
  providerGeneration: "provider-generation-1",
  originHumanId: "human-1",
  originRunId: "run-1",
  originAgentId: "agent-1",
  lineageId: "lineage-1",
  serverBindingId: "server-binding-1",
  relayId: "relay-1",
  pairingGeneration: "pairing-1",
  desktopSessionId: "session-1",
};

function registry(clock = { now: 0 }) {
  let sequence = 0;
  return new ComputerUseContextRegistry({
    clock: () => clock.now,
    ttlMs: 10,
    maxContexts: 2,
    randomId: () => `${(++sequence).toString(36).padStart(43, "a")}`,
  });
}

function screenSnapshot(bytes = Buffer.from([1, 2, 3])): ComputerUseScreenSnapshotInput {
  return {
    pngBytes: bytes,
    metadata: {
      format: "png",
      nativeDimensions: { width: 1200, height: 800 },
      presentedDimensions: { width: 1200, height: 800 },
      display: { coordinateSpace: "desktop_pixels", origin: { x: 0, y: 0 } },
    },
    providerSnapshot: {
      provider: "cua",
      kind: "desktop",
      nativeWidth: 1200,
      nativeHeight: 800,
      screenWidth: 600,
      screenHeight: 400,
      scaleFactor: 2,
    },
  };
}

function windowSnapshot(pid: number, windowId: number, bytes = Buffer.from([4, 5, 6])): ComputerUseScreenSnapshotInput {
  return {
    pngBytes: bytes,
    metadata: { format: "png", dimensions: { width: 800, height: 600 }, coordinateSpace: "window_snapshot_pixels" },
    providerSnapshot: { provider: "cua", kind: "window", pid, windowId, width: 800, height: 600 },
  };
}

function retainedSnapshotBytes(subject: ComputerUseContextRegistry, context: string, reference?: string): Buffer[] {
  const contexts = (subject as unknown as {
    contexts: Map<string, { screenSnapshots: Map<string, { reference: string; record: { pngBytes: Buffer } }> }>;
  }).contexts;
  return [...(contexts.get(context)?.screenSnapshots.values() ?? [])]
    .filter((snapshot) => reference === undefined || snapshot.reference === reference)
    .map((snapshot) => snapshot.record.pngBytes);
}

describe("D516 computer-use context registry", () => {
  test("settled actions preserve read anchors and the lease, but only fresh exact reads renew mutation authority", async () => {
    const subject = registry();
    const created = subject.create(scope);
    if (!created.ok) throw new Error("expected context");
    const context = created.data.context;
    let releases = 0;
    subject.retainContextLease(context, scope, async () => { releases += 1; });
    const registered = subject.registerTargets(context, scope, [20, 21].map((windowId) => ({
      evidence: { kind: "window" as const, appLabel: "Fixture", bounds: { x: 1, y: 2, width: 800, height: 600 } },
      providerTarget: { provider: "cua" as const, operation: "focus" as const, pid: 10, windowId },
    })));
    if (!registered.ok) throw new Error("expected windows");
    const [first, second] = registered.data;
    const oldRead = subject.beginWindowRead(context, scope, 10, 20);
    if (!oldRead.ok) throw new Error("expected read");
    const observed = subject.registerWindowObservation(context, scope, oldRead.data, { snapshot: windowSnapshot(10, 20) });
    if (!observed.ok || observed.data.snapshot === null) throw new Error("expected snapshot");
    const staleRead = subject.beginWindowRead(context, scope, 10, 20);
    if (!staleRead.ok) throw new Error("expected read ticket");
    expect(subject.claimSnapshotMutation(context, scope).ok).toBe(true);
    expect(subject.beginWindowRead(context, scope, 10, 20)).toEqual({ ok: false, code: "replay_forbidden" });
    expect(subject.resolveObservationTarget(context, scope, first!.reference)).toMatchObject({ ok: false });
    expect(subject.resolveScreenSnapshot(context, scope, observed.data.snapshot.reference)).toMatchObject({ ok: false });
    expect(subject.registerWindowObservation(context, scope, staleRead.data, {})).toMatchObject({ ok: false });
    expect(subject.settleSnapshotMutation(context, scope).ok).toBe(true);
    await Promise.resolve();
    expect(releases).toBe(0);
    expect(subject.resolveTarget(context, scope, first!.reference)).toEqual({ ok: false, code: "replay_forbidden" });
    expect(subject.resolveObservationTarget(context, { ...scope, grantGeneration: 2 }, first!.reference).ok).toBe(false);
    expect(subject.resolveObservationTarget(context, scope, first!.reference).ok).toBe(true);
    const freshRead = subject.beginWindowRead(context, scope, 10, 20);
    if (!freshRead.ok) throw new Error("expected fresh read");
    expect(subject.registerWindowObservation(context, scope, freshRead.data, {
      bounds: { x: 500, y: 260, width: 700, height: 420 }, snapshot: windowSnapshot(10, 20),
    }).ok).toBe(true);
    expect(subject.resolveTarget(context, scope, first!.reference)).toMatchObject({ ok: true, data: { evidence: { bounds: { x: 500, y: 260, width: 700, height: 420 } } } });
    expect(subject.resolveTarget(context, scope, second!.reference)).toEqual({ ok: false, code: "replay_forbidden" });
    expect(subject.resolveScreenSnapshot(context, scope, observed.data.snapshot.reference).ok).toBe(false);
    subject.markUnknownCompletion(context, scope);
    expect(subject.resolveObservationTarget(context, scope, first!.reference)).toEqual({ ok: false, code: "replay_forbidden" });
    await subject.close();
    expect(releases).toBe(1);
  });

  test("fresh recovery establishes a read baseline but still fences Human input during that read", () => {
    const subject = registry();
    const created = subject.create(scope);
    if (!created.ok) throw new Error("expected context");
    const context = created.data.context;
    const registered = subject.registerTargets(context, scope, [{
      evidence: { kind: "window", appLabel: "Fixture" },
      providerTarget: { provider: "cua", operation: "focus", pid: 10, windowId: 20 },
    }]);
    if (!registered.ok) throw new Error("expected window");
    const reference = registered.data[0]!.reference;
    expect(subject.advanceHumanInputEpoch(context, scope, 10, 1).ok).toBe(true);
    expect(subject.retireMutationCapabilities(context, scope).ok).toBe(true);
    expect(subject.resolveObservationTarget(context, scope, reference).ok).toBe(true);
    expect(subject.advanceHumanInputEpoch(context, scope, 100, 1).ok).toBe(true);
    // Resolving again must not reset the in-progress observation's baseline.
    expect(subject.resolveObservationTarget(context, scope, reference).ok).toBe(true);
    expect(subject.advanceHumanInputEpoch(context, scope, 200, 1)).toEqual({ ok: false, code: "external_interference" });
    expect(subject.resolveObservationTarget(context, scope, reference).ok).toBe(false);
  });

  test("retains only one exact-scope lease and releases it on context replacement", async () => {
    const subject = registry();
    const first = subject.create(scope);
    if (!first.ok) throw new Error("expected first context");
    const releases: string[] = [];
    expect(subject.retainContextLease(
      first.data.context,
      { ...scope, originRunId: "wrong-run" },
      async () => { releases.push("wrong"); },
    )).toBe(false);
    expect(subject.retainContextLease(
      first.data.context,
      scope,
      async () => { releases.push("first"); },
    )).toBe(true);
    expect(subject.retainContextLease(
      first.data.context,
      scope,
      async () => { releases.push("duplicate"); },
    )).toBe(false);

    const replacement = subject.create(scope);
    if (!replacement.ok) throw new Error("expected replacement context");
    await subject.close();
    expect(releases).toEqual(["first"]);
  });

  test("expires a retained lease at its deadline without a later registry call", async () => {
    const clock = { now: 0 };
    const scheduled: Array<{ callback: () => void; delayMs: number; cancelled: boolean }> = [];
    let sequence = 0;
    const subject = new ComputerUseContextRegistry({
      clock: () => clock.now,
      ttlMs: 10,
      maxContexts: 2,
      randomId: () => `${(++sequence).toString(36).padStart(43, "a")}`,
      scheduleExpiry: (callback, delayMs) => {
        const entry = { callback, delayMs, cancelled: false };
        scheduled.push(entry);
        return { cancel: () => { entry.cancelled = true; } };
      },
    });
    const created = subject.create(scope);
    if (!created.ok) throw new Error("expected context");
    let releases = 0;
    expect(subject.retainContextLease(created.data.context, scope, async () => { releases += 1; })).toBe(true);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.delayMs).toBe(10);
    clock.now = 10;
    scheduled[0]!.callback();
    await subject.close();
    expect(releases).toBe(1);
    expect(subject.resolveTarget(created.data.context, scope, "dtgt_missing"))
      .toEqual({ ok: false, code: "not_found" });
  });

  test("re-arms the same retained lease when its deadline timer fires early after clock rollback", async () => {
    const clock = { now: 0 };
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    let sequence = 0;
    const subject = new ComputerUseContextRegistry({
      clock: () => clock.now,
      ttlMs: 10,
      maxContexts: 2,
      randomId: () => `${(++sequence).toString(36).padStart(43, "a")}`,
      scheduleExpiry: (callback, delayMs) => {
        scheduled.push({ callback, delayMs });
        return { cancel: () => undefined };
      },
    });
    const created = subject.create(scope);
    if (!created.ok) throw new Error("expected context");
    let releases = 0;
    expect(subject.retainContextLease(created.data.context, scope, async () => { releases += 1; })).toBe(true);
    expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([10]);

    clock.now = -5;
    scheduled[0]!.callback();
    expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([10, 15]);
    expect(releases).toBe(0);
    expect(subject.resolveTarget(created.data.context, scope, "dtgt_missing"))
      .toEqual({ ok: false, code: "not_found" });

    clock.now = 10;
    scheduled[1]!.callback();
    await subject.close();
    expect(releases).toBe(1);
  });

  test("releases retained leases once on authority fence and unknown completion", async () => {
    const subject = registry();
    const releases: string[] = [];
    const fenced = subject.create(scope);
    if (!fenced.ok) throw new Error("expected fenced context");
    expect(subject.retainContextLease(fenced.data.context, scope, async () => { releases.push("fenced"); })).toBe(true);
    subject.fence({ installationEpoch: scope.installationEpoch, grantGeneration: scope.grantGeneration });

    const unknown = subject.create(scope);
    if (!unknown.ok) throw new Error("expected unknown context");
    expect(subject.retainContextLease(unknown.data.context, scope, async () => { releases.push("unknown"); })).toBe(true);
    expect(subject.markUnknownCompletion(unknown.data.context, scope)).toEqual({ ok: true, data: undefined });
    expect(subject.markUnknownCompletion(unknown.data.context, scope)).toEqual({ ok: true, data: undefined });
    await subject.close();
    expect(releases).toEqual(["fenced", "unknown"]);
  });

  test("close fences reservations immediately and waits for retained cleanup", async () => {
    const subject = registry();
    const created = subject.create(scope);
    if (!created.ok) throw new Error("expected context");
    const lateReservation = subject.reserveContext({ ...scope, computerUseContextId: "late-context" });
    if (!lateReservation.ok) throw new Error("expected late reservation");
    const release = Promise.withResolvers<void>();
    expect(subject.retainContextLease(created.data.context, scope, () => release.promise)).toBe(true);
    let closed = false;
    const closing = subject.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(subject.reserveContext(scope)).toEqual({ ok: false, code: "fenced" });
    expect(subject.createReserved(lateReservation.data.reservation, { ...scope, computerUseContextId: "late-context" }))
      .toEqual({ ok: false, code: "invalid" });
    expect(subject.retainContextLease(created.data.context, scope, async () => undefined)).toBe(false);
    release.resolve();
    await closing;
    expect(closed).toBe(true);
  });

  test("commits a launch capability set atomically, preserves prior state on collision, and removes it only after a successful swap", () => {
    const cuaScope = scope;
    const stable = registry();
    const prior = stable.create(cuaScope);
    if (!prior.ok) throw new Error("expected prior context");
    const old = stable.registerTargets(prior.data.context, cuaScope, [{
      evidence: { kind: "window", appLabel: "Old", windowLabel: "Old window" },
      providerTarget: { provider: "cua", operation: "focus", pid: 1, windowId: 2, bundleId: "org.example.Old" },
    }]);
    if (!old.ok) throw new Error("expected prior window");
    const reservation = stable.reserveContext(cuaScope);
    if (!reservation.ok) throw new Error("expected reservation");
    const launched = stable.createReservedLaunch(reservation.data.reservation, cuaScope, {
      evidence: { kind: "app", appLabel: "TextEdit", focused: false },
      providerTarget: { provider: "cua", operation: "observe_only", app: "TextEdit", pid: 77, bundleId: "com.apple.TextEdit" },
    }, [{
      evidence: { kind: "window", appLabel: "TextEdit", windowLabel: "Untitled" },
      providerTarget: { provider: "cua", operation: "focus", app: "TextEdit", pid: 77, windowId: 500, bundleId: "com.apple.TextEdit" },
    }]);
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    expect(stable.resolveTarget(prior.data.context, cuaScope, old.data[0]!.reference)).toEqual({ ok: false, code: "not_found" });
    expect(stable.resolveTarget(launched.data.context, cuaScope, launched.data.app.reference).ok).toBe(true);
    expect(stable.resolveTarget(launched.data.context, cuaScope, launched.data.windows[0]!.reference).ok).toBe(true);

    const fixed = new ComputerUseContextRegistry({ randomId: () => "a".repeat(43) });
    const collisionPrior = fixed.create(cuaScope);
    if (!collisionPrior.ok) throw new Error("expected collision prior");
    const collisionOld = fixed.registerTargets(collisionPrior.data.context, cuaScope, [{
      evidence: { kind: "window", appLabel: "Old", windowLabel: "Old window" },
      providerTarget: { provider: "cua", operation: "focus", pid: 1, windowId: 2, bundleId: "org.example.Old" },
    }]);
    if (!collisionOld.ok) throw new Error("expected old target");
    const collisionReservation = fixed.reserveContext(cuaScope);
    if (!collisionReservation.ok) throw new Error("expected collision reservation");
    expect(fixed.createReservedLaunch(collisionReservation.data.reservation, cuaScope, {
      evidence: { kind: "app", appLabel: "TextEdit", focused: false },
      providerTarget: { provider: "cua", operation: "observe_only", app: "TextEdit", pid: 77, bundleId: "com.apple.TextEdit" },
    }, [])).toEqual({ ok: false, code: "invalid" });
    expect(fixed.resolveTarget(collisionPrior.data.context, cuaScope, collisionOld.data[0]!.reference).ok).toBe(true);
    fixed.releaseContextReservation(collisionReservation.data.reservation);
  });

  test("keeps launch windows private by exact bundle, has no partial mint, and honors scope and replay fences", () => {
    const cuaScope = scope;
    const subject = registry();
    const reservation = subject.reserveContext(cuaScope);
    if (!reservation.ok) throw new Error("expected reservation");
    // Wrong target kinds and an over-budget set fail before a context exists.
    expect(subject.createReservedLaunch(reservation.data.reservation, cuaScope, {
      evidence: { kind: "window", appLabel: "Bad", windowLabel: "Bad" },
      providerTarget: { provider: "cua", operation: "focus", pid: 1, windowId: 2, bundleId: "org.example.Bad" },
    }, [])).toEqual({ ok: false, code: "invalid" });
    subject.releaseContextReservation(reservation.data.reservation);

    const launchReservation = subject.reserveContext(cuaScope);
    if (!launchReservation.ok) throw new Error("expected launch reservation");
    // A mismatched provider window is rejected before commit. The same
    // reservation remains usable, proving no partial target/context mint.
    expect(subject.createReservedLaunch(launchReservation.data.reservation, cuaScope, {
      evidence: { kind: "app", appLabel: "TextEdit", focused: false },
      providerTarget: { provider: "cua", operation: "observe_only", app: "TextEdit", pid: 77, bundleId: "com.apple.TextEdit" },
    }, [
      { evidence: { kind: "window", appLabel: "Other", windowLabel: "Wrong owner" }, providerTarget: { provider: "cua", operation: "focus", app: "Other", pid: 78, windowId: 500, bundleId: "org.example.Other" } },
    ])).toEqual({ ok: false, code: "invalid" });
    const launched = subject.createReservedLaunch(launchReservation.data.reservation, cuaScope, {
      evidence: { kind: "app", appLabel: "TextEdit", focused: false },
      providerTarget: { provider: "cua", operation: "observe_only", app: "TextEdit", pid: 77, bundleId: "com.apple.TextEdit" },
    }, [
      { evidence: { kind: "window", appLabel: "TextEdit", windowLabel: "Text" }, providerTarget: { provider: "cua", operation: "focus", app: "TextEdit", pid: 77, windowId: 500, bundleId: "com.apple.TextEdit" } },
    ], 101);
    if (!launched.ok) throw new Error("expected launch context");
    expect(subject.resolveApplicationWindows(launched.data.context, cuaScope, launched.data.app.reference)).toMatchObject({ ok: true, data: { discovered: 101, targets: [launched.data.windows[0]] } });
    expect(subject.resolveApplicationWindows(launched.data.context, { ...cuaScope, originRunId: "other" }, launched.data.app.reference)).toEqual({ ok: false, code: "scope_mismatch" });
    subject.markUnknownCompletion(launched.data.context, cuaScope);
    expect(subject.resolveApplicationWindows(launched.data.context, cuaScope, launched.data.app.reference)).toEqual({ ok: false, code: "replay_forbidden" });
  });

  test("atomically refreshes delayed launch windows without changing the opaque app capability", () => {
    const cuaScope = scope;
    const subject = registry();
    const reservation = subject.reserveContext(cuaScope);
    if (!reservation.ok) throw new Error("expected reservation");
    const launched = subject.createReservedLaunch(reservation.data.reservation, cuaScope, {
      evidence: { kind: "app", appLabel: "TextEdit", focused: false },
      providerTarget: { provider: "cua", operation: "observe_only", app: "TextEdit", pid: 77, bundleId: "com.apple.TextEdit" },
    }, [], 0);
    if (!launched.ok) throw new Error("expected launch context");
    const refreshed = subject.refreshApplicationWindows(launched.data.context, cuaScope, launched.data.app.reference, [{
      evidence: { kind: "window", appLabel: "TextEdit", windowLabel: "Untitled" },
      providerTarget: { provider: "cua", operation: "focus", app: "TextEdit", pid: 77, windowId: 500, bundleId: "com.apple.TextEdit" },
    }], 0, 101);
    expect(refreshed).toMatchObject({ ok: true, data: { discovered: 101, targets: [{ reference: expect.stringMatching(/^dtgt_/) }] } });
    if (!refreshed.ok) return;
    expect(subject.resolveTarget(launched.data.context, cuaScope, launched.data.app.reference)).toMatchObject({ ok: true });
    expect(subject.resolveApplicationWindows(launched.data.context, cuaScope, launched.data.app.reference))
      .toMatchObject({ ok: true, data: { discovered: 101, targets: refreshed.data.targets } });

    const before = subject.resolveApplicationWindows(launched.data.context, cuaScope, launched.data.app.reference);
    expect(subject.refreshApplicationWindows(launched.data.context, cuaScope, launched.data.app.reference, [{
      evidence: { kind: "window", appLabel: "Other", windowLabel: "Wrong owner" },
      providerTarget: { provider: "cua", operation: "focus", app: "Other", pid: 78, windowId: 501, bundleId: "org.example.Other" },
    }], 1)).toEqual({ ok: false, code: "invalid" });
    expect(subject.resolveApplicationWindows(launched.data.context, cuaScope, launched.data.app.reference)).toEqual(before);
  });

  test("prunes closed-window images only after a complete same-process inventory", () => {
    const subject = registry();
    const reservation = subject.reserveContext(scope);
    if (!reservation.ok) throw new Error("expected reservation");
    const created = subject.createReservedDesktopState(reservation.data.reservation, scope, [
      { evidence: { kind: "app", appLabel: "TextEdit" }, providerTarget: { provider: "cua", operation: "observe_only", app: "TextEdit", pid: 77, bundleId: "com.apple.TextEdit" } },
      { evidence: { kind: "window", appLabel: "TextEdit" }, providerTarget: { provider: "cua", operation: "focus", app: "TextEdit", pid: 77, windowId: 500, bundleId: "com.apple.TextEdit" } },
      { evidence: { kind: "window", appLabel: "TextEdit" }, providerTarget: { provider: "cua", operation: "focus", app: "TextEdit", pid: 77, windowId: 501, bundleId: "com.apple.TextEdit" } },
    ], screenSnapshot(Buffer.from([1])));
    if (!created.ok || created.data.screenSnapshot === null) throw new Error("expected desktop state");
    const app = created.data.targets.find((target) => target.evidence.kind === "app");
    if (app === undefined) throw new Error("expected app target");
    const closed = subject.registerWindowSnapshot(created.data.context, scope, windowSnapshot(77, 500, Buffer.from([2])));
    const retained = subject.registerWindowSnapshot(created.data.context, scope, windowSnapshot(77, 501, Buffer.from([3])));
    const otherPid = subject.registerWindowSnapshot(created.data.context, scope, windowSnapshot(88, 600, Buffer.from([4])));
    if (!closed.ok || !retained.ok || !otherPid.ok) throw new Error("expected retained images");
    const closedBytes = retainedSnapshotBytes(subject, created.data.context, closed.data.reference)[0]!;
    const remainingWindow = {
      evidence: { kind: "window" as const, appLabel: "TextEdit" },
      providerTarget: { provider: "cua" as const, operation: "focus" as const, app: "TextEdit", pid: 77, windowId: 501, bundleId: "com.apple.TextEdit" },
    };

    expect(subject.refreshApplicationWindows(created.data.context, scope, app.reference, [remainingWindow], 0, 2).ok).toBe(true);
    expect(subject.resolveScreenSnapshot(created.data.context, scope, closed.data.reference).ok).toBe(true);
    expect([...closedBytes]).toEqual([2]);

    expect(subject.refreshApplicationWindows(created.data.context, scope, app.reference, [remainingWindow], 1, 1).ok).toBe(true);
    expect(subject.resolveScreenSnapshot(created.data.context, scope, closed.data.reference)).toEqual({ ok: false, code: "not_found" });
    expect([...closedBytes]).toEqual([0]);
    expect(subject.resolveScreenSnapshot(created.data.context, scope, retained.data.reference).ok).toBe(true);
    expect(subject.resolveScreenSnapshot(created.data.context, scope, otherPid.data.reference).ok).toBe(true);
    expect(subject.resolveScreenSnapshot(created.data.context, scope, created.data.screenSnapshot.reference).ok).toBe(true);
  });
  test("keeps provider identifiers host-side and requires the exact full invocation scope", () => {
    const subject = registry();
    const created = subject.create(scope);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data.context).toMatch(/^dctx_[A-Za-z0-9_-]{43}$/);
    const targets = subject.registerTargets(created.data.context, scope, [{
      evidence: { kind: "window", appLabel: "Nautilo", windowLabel: "Settings" },
      providerTarget: { provider: "cua", operation: "focus", pid: 123, windowId: 456 },
    }]);
    expect(targets).toEqual({
      ok: true,
      data: [expect.objectContaining({ reference: expect.stringMatching(/^dtgt_[A-Za-z0-9_-]{43}$/), evidence: { kind: "window", appLabel: "Nautilo", windowLabel: "Settings" } })],
    });
    const reference = targets.ok ? targets.data[0]!.reference : "";
    expect(subject.resolveTarget(created.data.context, { ...scope, originRunId: "other-run" }, reference))
      .toEqual({ ok: false, code: "scope_mismatch" });
    expect(subject.resolveTarget(created.data.context, scope, reference)).toEqual({
      ok: true,
      data: {
        evidence: { kind: "window", appLabel: "Nautilo", windowLabel: "Settings" },
        providerTarget: { provider: "cua", operation: "focus", pid: 123, windowId: 456 },
      },
    });
  });

  test("retains the complete provider-bounded target set and keeps an explicit test containment seam", () => {
    const subject = registry();
    const created = subject.create(scope);
    if (!created.ok) throw new Error("expected context");
    const windows = Array.from({ length: 100 }, (_, index) => ({
      evidence: { kind: "window" as const, appLabel: "Fixture", windowLabel: `Window ${index}` },
      providerTarget: { provider: "cua" as const, operation: "focus" as const, pid: 17, windowId: index + 1 },
    }));
    const apps = Array.from({ length: 64 }, (_, index) => ({
      evidence: { kind: "app" as const, appLabel: `Fixture ${index}`, hidden: false, focused: false },
      providerTarget: { provider: "cua" as const, operation: "observe_only" as const, pid: index + 1000 },
    }));
    expect(subject.registerTargets(created.data.context, scope, [...windows, ...apps]).ok).toBe(true);
    expect(subject.registerTargets(created.data.context, scope, [{
      evidence: { kind: "window", appLabel: "Fixture", windowLabel: "101" },
      providerTarget: { provider: "cua", operation: "focus", pid: 17, windowId: 101 },
    }]).ok).toBe(true);
    expect(subject.registerTargets(created.data.context, scope, [{
      evidence: { kind: "app", appLabel: "65", hidden: false, focused: false },
      providerTarget: { provider: "cua", operation: "observe_only", pid: 1065 },
    }]).ok).toBe(true);

    // An AX element is not a 101st window.  It carries a distinct, one-shot
    // detgt_ capability and must not erode the complete-window budget.
    const element = subject.registerTargets(created.data.context, scope, [{
      evidence: { kind: "element", role: "text_area", action: "type_text" },
      providerTarget: { provider: "cua", operation: "type_text", pid: 17, windowId: 1, elementToken: "private-token" },
    }]);
    expect(element).toMatchObject({ ok: true, data: [{ reference: expect.stringMatching(/^detgt_[A-Za-z0-9_-]{43}$/) }] });

    let sequence = 0;
    const contained = new ComputerUseContextRegistry({
      clock: () => 0,
      ttlMs: 10,
      maxContexts: 1,
      maxTargetsPerContext: 1,
      randomId: () => `${(++sequence).toString(36).padStart(43, "a")}`,
    });
    const containedContext = contained.create(scope);
    if (!containedContext.ok) throw new Error("expected contained context");
    expect(contained.registerTargets(containedContext.data.context, scope, windows.slice(0, 2)))
      .toEqual({ ok: false, code: "invalid" });
  });

  test("mints a one-shot element capability as detgt_ without consuming window capacity", () => {
    const subject = registry();
    const created = subject.create(scope);
    if (!created.ok) throw new Error("expected context");
    const element = subject.registerTargets(created.data.context, scope, [{
      evidence: { kind: "element", role: "text_area", action: "type_text" },
      providerTarget: { provider: "cua", operation: "type_text", app: "TextEdit", pid: 17, windowId: 1, elementToken: "private-token" },
    }]);
    expect(element).toMatchObject({ ok: true, data: [{ reference: expect.stringMatching(/^detgt_[A-Za-z0-9_-]{43}$/) }] });
    if (!element.ok) return;
  });

  test("redeems retained continuations locally, expires bounded state, and fences authority generations", () => {
    const clock = { now: 0 };
    const subject = registry(clock);
    const created = subject.create(scope);
    if (!created.ok) throw new Error("expected context");
    const targets = subject.registerTargets(created.data.context, scope, [{
      evidence: { kind: "window", appLabel: "Nautilo", windowLabel: "Connections" },
      providerTarget: { provider: "cua", operation: "focus", windowId: 1 },
    }]);
    if (!targets.ok) throw new Error("expected target");
    const continuation = subject.mintContinuation(created.data.context, scope, [targets.data[0]!.reference]);
    if (!continuation.ok) throw new Error("expected continuation");
    expect(subject.redeemContinuation(created.data.context, scope, continuation.data.reference)).toEqual({
      ok: true,
      data: { targets: targets.data, coverage: null },
    });
    expect(subject.redeemContinuation(created.data.context, scope, continuation.data.reference))
      .toEqual({ ok: false, code: "not_found" });
    subject.fence({ installationEpoch: scope.installationEpoch, grantGeneration: scope.grantGeneration });
    expect(subject.redeemContinuation(created.data.context, scope, continuation.data.reference))
      .toEqual({ ok: false, code: "not_found" });

    const next = subject.create(scope);
    if (!next.ok) throw new Error("expected second context");
    clock.now = 10;
    expect(subject.resolveTarget(next.data.context, scope, "dtgt_missing"))
      .toEqual({ ok: false, code: "expired" });
  });

  test("marks unknown completion as a hard no-replay fence", () => {
    const subject = registry();
    const created = subject.create(scope);
    if (!created.ok) throw new Error("expected context");
    const targets = subject.registerTargets(created.data.context, scope, [{
      evidence: { kind: "window", appLabel: "Nautilo", windowLabel: "Connections" },
      providerTarget: { provider: "cua", operation: "focus", windowId: 1 },
    }]);
    if (!targets.ok) throw new Error("expected target");
    expect(subject.markUnknownCompletion(created.data.context, scope)).toEqual({ ok: true, data: undefined });
    expect(subject.resolveTarget(created.data.context, scope, targets.data[0]!.reference))
      .toEqual({ ok: false, code: "replay_forbidden" });
  });

  test("retains a Cua app observation as host-only observe_only rather than a hide capability", () => {
    const subject = registry();
    const cuaScope = scope;
    const created = subject.create(cuaScope);
    if (!created.ok) throw new Error("expected context");
    const registered = subject.registerTargets(created.data.context, cuaScope, [{
      evidence: { kind: "app", appLabel: "Nautilo", focused: true },
      providerTarget: { provider: "cua", operation: "observe_only", pid: 42, bundleId: "com.nautilo.desktop" },
    }]);
    if (!registered.ok) throw new Error("expected Cua app target");
    expect(subject.resolveTarget(created.data.context, cuaScope, registered.data[0]!.reference)).toEqual({
      ok: true,
      data: {
        evidence: { kind: "app", appLabel: "Nautilo", focused: true },
        providerTarget: { provider: "cua", operation: "observe_only", pid: 42, bundleId: "com.nautilo.desktop" },
      },
    });
  });

  test("atomically retains one opaque snapshot with defensive bytes and exact scope", () => {
    const subject = registry();
    const cuaScope = scope;
    const reservation = subject.reserveContext(cuaScope);
    if (!reservation.ok) throw new Error("expected reservation");
    const sourceBytes = Buffer.from([1, 2, 3]);
    const created = subject.createReservedDesktopState(
      reservation.data.reservation,
      cuaScope,
      [{
        evidence: { kind: "window", appLabel: "Fixture", windowLabel: "Document" },
        providerTarget: { provider: "cua", operation: "focus", pid: 10, windowId: 20 },
      }],
      screenSnapshot(sourceBytes),
    );
    if (!created.ok || created.data.screenSnapshot === null) throw new Error("expected snapshot");
    expect(created.data.screenSnapshot).toEqual({
      reference: expect.stringMatching(/^dsnap_[A-Za-z0-9_-]{43}$/),
      evidence: { kind: "screen" },
      metadata: screenSnapshot().metadata,
    });
    sourceBytes.fill(9);
    const resolved = subject.resolveScreenSnapshot(created.data.context, cuaScope, created.data.screenSnapshot.reference);
    if (!resolved.ok) throw new Error("expected retained snapshot");
    expect([...resolved.data.pngBytes]).toEqual([1, 2, 3]);
    resolved.data.pngBytes.fill(8);
    const resolvedAgain = subject.resolveScreenSnapshot(created.data.context, cuaScope, created.data.screenSnapshot.reference);
    expect(resolvedAgain.ok && [...resolvedAgain.data.pngBytes]).toEqual([1, 2, 3]);
    expect(subject.resolveScreenSnapshot(created.data.context, { ...cuaScope, originRunId: "other" }, created.data.screenSnapshot.reference))
      .toEqual({ ok: false, code: "scope_mismatch" });
    expect(subject.resolveScreenSnapshot(created.data.context, cuaScope, `dsnap_${"z".repeat(43)}`))
      .toEqual({ ok: false, code: "not_found" });
    expect(subject.markUnknownCompletion(created.data.context, cuaScope)).toEqual({ ok: true, data: undefined });
    expect(subject.resolveScreenSnapshot(created.data.context, cuaScope, created.data.screenSnapshot.reference))
      .toEqual({ ok: false, code: "replay_forbidden" });
  });

  test("replaces one exact window snapshot with a privately mapped precision view", () => {
    const subject = registry();
    const created = subject.create(scope);
    if (!created.ok) throw new Error("expected context");
    const full = subject.registerWindowSnapshot(created.data.context, scope, {
      pngBytes: Buffer.from([1, 2, 3]),
      metadata: { format: "png", dimensions: { width: 800, height: 600 }, coordinateSpace: "window_snapshot_pixels" },
      providerSnapshot: { provider: "cua", kind: "window", pid: 10, windowId: 20, width: 800, height: 600 },
    });
    if (!full.ok) throw new Error("expected full window snapshot");
    expect(subject.registerWindowRegionSnapshot(created.data.context, scope, `dsnap_${"z".repeat(43)}`, {
      pngBytes: Buffer.from([4, 5, 6]),
      metadata: { format: "png", dimensions: { width: 100, height: 80 }, coordinateSpace: "presented_snapshot_pixels" },
      providerSnapshot: {
        provider: "cua", kind: "window_region", pid: 10, windowId: 20,
        windowWidth: 800, windowHeight: 600, origin: { x: 40, y: 50 }, width: 100, height: 80,
      },
    })).toEqual({ ok: false, code: "invalid" });
    expect(subject.resolveScreenSnapshot(created.data.context, scope, full.data.reference).ok).toBe(true);

    const region = subject.registerWindowRegionSnapshot(created.data.context, scope, full.data.reference, {
      pngBytes: Buffer.from([4, 5, 6]),
      metadata: { format: "png", dimensions: { width: 100, height: 80 }, coordinateSpace: "presented_snapshot_pixels" },
      providerSnapshot: {
        provider: "cua", kind: "window_region", pid: 10, windowId: 20,
        windowWidth: 800, windowHeight: 600, origin: { x: 40, y: 50 }, width: 100, height: 80,
      },
    });
    if (!region.ok) throw new Error("expected precision snapshot");
    expect(subject.resolveScreenSnapshot(created.data.context, scope, full.data.reference))
      .toEqual({ ok: false, code: "not_found" });
    const resolved = subject.resolveScreenSnapshot(created.data.context, scope, region.data.reference);
    expect(resolved).toMatchObject({
      ok: true,
      data: {
        metadata: { format: "png", dimensions: { width: 100, height: 80 }, coordinateSpace: "presented_snapshot_pixels" },
        providerSnapshot: {
          provider: "cua", kind: "window_region", pid: 10, windowId: 20,
          windowWidth: 800, windowHeight: 600, origin: { x: 40, y: 50 }, width: 100, height: 80,
        },
      },
    });
    expect(resolved.ok && [...resolved.data.pngBytes]).toEqual([4, 5, 6]);
  });

  test("retains independent desktop and per-window images while replacing or cropping one window", () => {
    const subject = registry();
    const reservation = subject.reserveContext(scope);
    if (!reservation.ok) throw new Error("expected reservation");
    const created = subject.createReservedDesktopState(reservation.data.reservation, scope, [], screenSnapshot(Buffer.from([1])));
    if (!created.ok || created.data.screenSnapshot === null) throw new Error("expected desktop snapshot");
    const windowA = subject.registerWindowSnapshot(created.data.context, scope, windowSnapshot(77, 900, Buffer.from([2])));
    const windowB = subject.registerWindowSnapshot(created.data.context, scope, windowSnapshot(77, 901, Buffer.from([3])));
    if (!windowA.ok || !windowB.ok) throw new Error("expected window snapshots");
    const originalABytes = retainedSnapshotBytes(subject, created.data.context, windowA.data.reference)[0]!;
    expect(subject.resolveScreenSnapshot(created.data.context, scope, created.data.screenSnapshot.reference).ok).toBe(true);
    expect(subject.resolveScreenSnapshot(created.data.context, scope, windowA.data.reference).ok).toBe(true);
    expect(subject.resolveScreenSnapshot(created.data.context, scope, windowB.data.reference).ok).toBe(true);

    const replacementA = subject.registerWindowSnapshot(created.data.context, scope, windowSnapshot(77, 900, Buffer.from([4])));
    if (!replacementA.ok) throw new Error("expected replacement A");
    expect(subject.resolveScreenSnapshot(created.data.context, scope, windowA.data.reference)).toEqual({ ok: false, code: "not_found" });
    expect([...originalABytes]).toEqual([0]);
    expect(subject.resolveScreenSnapshot(created.data.context, scope, windowB.data.reference).ok).toBe(true);
    expect(subject.resolveScreenSnapshot(created.data.context, scope, created.data.screenSnapshot.reference).ok).toBe(true);
    const replacementABytes = retainedSnapshotBytes(subject, created.data.context, replacementA.data.reference)[0]!;

    const regionA = subject.registerWindowRegionSnapshot(created.data.context, scope, replacementA.data.reference, {
      pngBytes: Buffer.from([5]),
      metadata: { format: "png", dimensions: { width: 100, height: 80 }, coordinateSpace: "presented_snapshot_pixels" },
      providerSnapshot: {
        provider: "cua", kind: "window_region", pid: 77, windowId: 900,
        windowWidth: 800, windowHeight: 600, origin: { x: 40, y: 50 }, width: 100, height: 80,
      },
    });
    if (!regionA.ok) throw new Error("expected crop A");
    expect(subject.resolveScreenSnapshot(created.data.context, scope, replacementA.data.reference)).toEqual({ ok: false, code: "not_found" });
    expect([...replacementABytes]).toEqual([0]);
    expect(subject.resolveScreenSnapshot(created.data.context, scope, regionA.data.reference).ok).toBe(true);
    expect(subject.resolveScreenSnapshot(created.data.context, scope, windowB.data.reference).ok).toBe(true);
    expect(subject.resolveScreenSnapshot(created.data.context, scope, created.data.screenSnapshot.reference).ok).toBe(true);
  });

  test("rejects foreign, forged, and cross-window crops without disturbing retained images", () => {
    const subject = registry();
    const created = subject.create(scope);
    if (!created.ok) throw new Error("expected context");
    const source = subject.registerWindowSnapshot(created.data.context, scope, windowSnapshot(77, 900, Buffer.from([1, 2])));
    if (!source.ok) throw new Error("expected source");
    const sourceBytes = retainedSnapshotBytes(subject, created.data.context, source.data.reference)[0]!;
    const region = (windowId: number): ComputerUseScreenSnapshotInput => ({
      pngBytes: Buffer.from([8, 9]),
      metadata: { format: "png", dimensions: { width: 100, height: 80 }, coordinateSpace: "presented_snapshot_pixels" },
      providerSnapshot: {
        provider: "cua", kind: "window_region", pid: 77, windowId,
        windowWidth: 800, windowHeight: 600, origin: { x: 20, y: 30 }, width: 100, height: 80,
      },
    });
    expect(subject.registerWindowRegionSnapshot(created.data.context, { ...scope, originRunId: "foreign" }, source.data.reference, region(900)))
      .toEqual({ ok: false, code: "scope_mismatch" });
    expect(subject.registerWindowRegionSnapshot(created.data.context, scope, `dsnap_${"z".repeat(43)}`, region(900)))
      .toEqual({ ok: false, code: "invalid" });
    expect(subject.registerWindowRegionSnapshot(created.data.context, scope, source.data.reference, region(901)))
      .toEqual({ ok: false, code: "invalid" });
    const retained = subject.resolveScreenSnapshot(created.data.context, scope, source.data.reference);
    expect(retained.ok && [...retained.data.pngBytes]).toEqual([1, 2]);
    expect([...sourceBytes]).toEqual([1, 2]);
  });

  test("preserves the prior exact-window image when replacement minting fails", () => {
    let sequence = 0;
    let failMint = false;
    const subject = new ComputerUseContextRegistry({
      randomId: () => failMint ? "invalid" : `${(++sequence).toString(36).padStart(43, "a")}`,
    });
    const created = subject.create(scope);
    if (!created.ok) throw new Error("expected context");
    const prior = subject.registerWindowSnapshot(created.data.context, scope, windowSnapshot(77, 900, Buffer.from([6, 7])));
    if (!prior.ok) throw new Error("expected prior snapshot");
    const priorBytes = retainedSnapshotBytes(subject, created.data.context, prior.data.reference)[0]!;
    failMint = true;
    expect(() => subject.registerWindowSnapshot(created.data.context, scope, windowSnapshot(77, 900, Buffer.from([8, 9]))))
      .toThrow("randomId must return 43 base64url characters");
    const retained = subject.resolveScreenSnapshot(created.data.context, scope, prior.data.reference);
    expect(retained.ok && [...retained.data.pngBytes]).toEqual([6, 7]);
    expect([...priorBytes]).toEqual([6, 7]);
  });

  test("retires every retained desktop and per-window image on context termination", () => {
    const clock = { now: 0 };
    const subject = registry(clock);
    const createImages = () => {
      const reservation = subject.reserveContext(scope);
      if (!reservation.ok) throw new Error("expected reservation");
      const created = subject.createReservedDesktopState(reservation.data.reservation, scope, [], screenSnapshot(Buffer.from([1])));
      if (!created.ok || created.data.screenSnapshot === null) throw new Error("expected desktop image");
      const a = subject.registerWindowSnapshot(created.data.context, scope, windowSnapshot(77, 900, Buffer.from([2])));
      const b = subject.registerWindowSnapshot(created.data.context, scope, windowSnapshot(77, 901, Buffer.from([3])));
      if (!a.ok || !b.ok) throw new Error("expected window images");
      return {
        context: created.data.context,
        references: [created.data.screenSnapshot.reference, a.data.reference, b.data.reference],
        buffers: retainedSnapshotBytes(subject, created.data.context),
      };
    };
    const expectUnavailable = (fixture: ReturnType<typeof createImages>, code: "expired" | "not_found" | "replay_forbidden") => {
      for (const reference of fixture.references) {
        expect(subject.resolveScreenSnapshot(fixture.context, scope, reference)).toEqual({ ok: false, code });
      }
    };

    const expired = createImages();
    clock.now = 10;
    expect(subject.resolveScreenSnapshot(expired.context, scope, expired.references[0]!)).toEqual({ ok: false, code: "expired" });
    for (const reference of expired.references.slice(1)) {
      expect(subject.resolveScreenSnapshot(expired.context, scope, reference)).toEqual({ ok: false, code: "not_found" });
    }
    for (const bytes of expired.buffers) expect([...bytes].every((byte) => byte === 0)).toBe(true);
    clock.now = 11;
    const fenced = createImages();
    subject.fence({ installationEpoch: scope.installationEpoch, grantGeneration: scope.grantGeneration });
    expectUnavailable(fenced, "not_found");
    for (const bytes of fenced.buffers) expect([...bytes].every((byte) => byte === 0)).toBe(true);
    const cleared = createImages();
    subject.clear();
    expectUnavailable(cleared, "not_found");
    for (const bytes of cleared.buffers) expect([...bytes].every((byte) => byte === 0)).toBe(true);
    const unknown = createImages();
    expect(subject.markUnknownCompletion(unknown.context, scope)).toEqual({ ok: true, data: undefined });
    expectUnavailable(unknown, "replay_forbidden");
    for (const bytes of unknown.buffers) expect([...bytes].every((byte) => byte === 0)).toBe(true);
  });

  test("prebuilds snapshot state before replacing the prior observation", () => {
    let sequence = 0;
    let failMint = false;
    const subject = new ComputerUseContextRegistry({
      clock: () => 0,
      ttlMs: 10,
      maxContexts: 2,
      randomId: () => failMint ? "invalid" : `${(++sequence).toString(36).padStart(43, "a")}`,
    });
    const cuaScope = scope;
    const firstReservation = subject.reserveContext(cuaScope);
    if (!firstReservation.ok) throw new Error("expected reservation");
    const first = subject.createReservedDesktopState(firstReservation.data.reservation, cuaScope, [], screenSnapshot());
    if (!first.ok || first.data.screenSnapshot === null) throw new Error("expected first snapshot");

    const failedReservation = subject.reserveContext(cuaScope);
    if (!failedReservation.ok) throw new Error("expected replacement reservation");
    failMint = true;
    expect(() => subject.createReservedDesktopState(failedReservation.data.reservation, cuaScope, [], screenSnapshot()))
      .toThrow("randomId must return 43 base64url characters");
    subject.releaseContextReservation(failedReservation.data.reservation);
    expect(subject.resolveScreenSnapshot(first.data.context, cuaScope, first.data.screenSnapshot.reference).ok).toBe(true);

    failMint = false;
    const replacementReservation = subject.reserveContext(cuaScope);
    if (!replacementReservation.ok) throw new Error("expected replacement reservation");
    const replacement = subject.createReservedDesktopState(replacementReservation.data.reservation, cuaScope, [], screenSnapshot(Buffer.from([4, 5, 6])));
    if (!replacement.ok || replacement.data.screenSnapshot === null) throw new Error("expected replacement");
    expect(subject.resolveScreenSnapshot(first.data.context, cuaScope, first.data.screenSnapshot.reference))
      .toEqual({ ok: false, code: "not_found" });
    const resolved = subject.resolveScreenSnapshot(replacement.data.context, cuaScope, replacement.data.screenSnapshot.reference);
    expect(resolved.ok && [...resolved.data.pngBytes]).toEqual([4, 5, 6]);
  });

  test("disposes snapshot state on expiry, authority fencing, and clear", () => {
    const clock = { now: 0 };
    const subject = registry(clock);
    const cuaScope = scope;
    const createSnapshot = () => {
      const reservation = subject.reserveContext(cuaScope);
      if (!reservation.ok) throw new Error("expected reservation");
      const created = subject.createReservedDesktopState(reservation.data.reservation, cuaScope, [], screenSnapshot());
      if (!created.ok || created.data.screenSnapshot === null) throw new Error("expected snapshot");
      return created.data;
    };
    const expired = createSnapshot();
    clock.now = 10;
    expect(subject.resolveScreenSnapshot(expired.context, cuaScope, expired.screenSnapshot!.reference))
      .toEqual({ ok: false, code: "expired" });
    clock.now = 11;
    const fenced = createSnapshot();
    subject.fence({ installationEpoch: cuaScope.installationEpoch, grantGeneration: cuaScope.grantGeneration });
    expect(subject.resolveScreenSnapshot(fenced.context, cuaScope, fenced.screenSnapshot!.reference))
      .toEqual({ ok: false, code: "not_found" });
    const cleared = createSnapshot();
    subject.clear();
    expect(subject.resolveScreenSnapshot(cleared.context, cuaScope, cleared.screenSnapshot!.reference))
      .toEqual({ ok: false, code: "not_found" });
  });

  test("retires exact-window elements at the read boundary without changing document provenance", () => {
    const subject = registry();
    const created = subject.create(scope);
    if (!created.ok) throw new Error("expected context");
    const windows = subject.registerTargets(created.data.context, scope, [{
      evidence: { kind: "window", appLabel: "TextEdit", windowLabel: "Untitled" },
      providerTarget: { provider: "cua", operation: "focus", app: "TextEdit", pid: 77, windowId: 900, freshAppeared: false },
    }, {
      evidence: { kind: "window", appLabel: "TextEdit", windowLabel: "Other" },
      providerTarget: { provider: "cua", operation: "focus", app: "TextEdit", pid: 77, windowId: 901 },
    }]);
    if (!windows.ok) throw new Error("expected windows");
    const freshWriter = subject.registerTargets(created.data.context, scope, [{
      evidence: { kind: "element", role: "text_area", action: "type_text" },
      providerTarget: { provider: "cua", operation: "type_text", pid: 77, windowId: 900, elementToken: "old-private-token" },
    }]);
    const otherElement = subject.registerTargets(created.data.context, scope, [{
      evidence: { kind: "element", role: "button", action: "click" },
      providerTarget: { provider: "cua", operation: "click", pid: 77, windowId: 901, elementToken: "other-private-token" },
    }]);
    if (!freshWriter.ok || !otherElement.ok) throw new Error("expected elements");

    const read = subject.beginWindowRead(created.data.context, scope, 77, 900);
    if (!read.ok) throw new Error("expected read ticket");
    expect(subject.resolveTarget(created.data.context, scope, freshWriter.data[0]!.reference))
      .toEqual({ ok: false, code: "not_found" });
    expect(subject.resolveTarget(created.data.context, scope, otherElement.data[0]!.reference).ok).toBe(true);
    expect(subject.resolveTarget(created.data.context, scope, windows.data[0]!.reference))
      .toMatchObject({ ok: true, data: { providerTarget: { freshAppeared: false } } });

    expect(subject.registerWindowObservation(created.data.context, scope, read.data, {}))
      .toEqual({ ok: true, data: { element: null, snapshot: null } });
    expect(subject.resolveTarget(created.data.context, scope, windows.data[0]!.reference))
      .toMatchObject({ ok: true, data: { providerTarget: { freshAppeared: false } } });

    const observation = {
      element: {
        evidence: { kind: "element", role: "text_area", action: "type_text" },
        providerTarget: { provider: "cua", operation: "type_text", pid: 77, windowId: 900, elementToken: "new-private-token" },
      },
      snapshot: windowSnapshot(77, 900),
    } as const;
    expect(subject.registerWindowObservation(created.data.context, scope, read.data, observation))
      .toEqual({ ok: false, code: "refresh_conflict" });

    const nextRead = subject.beginWindowRead(created.data.context, scope, 77, 900);
    if (!nextRead.ok) throw new Error("expected successor read ticket");
    const committed = subject.registerWindowObservation(created.data.context, scope, nextRead.data, observation);
    if (!committed.ok || committed.data.element === null || committed.data.snapshot === null) {
      throw new Error("expected atomic window observation");
    }
    expect(subject.resolveTarget(created.data.context, scope, windows.data[0]!.reference))
      .toMatchObject({ ok: true, data: { providerTarget: { freshAppeared: false } } });
    expect(subject.resolveTarget(created.data.context, scope, committed.data.element.reference).ok).toBe(true);
    expect(subject.resolveScreenSnapshot(created.data.context, scope, committed.data.snapshot.reference))
      .toMatchObject({ ok: true, data: { providerSnapshot: { pid: 77, windowId: 900 } } });
  });

  test("allows a fresh exact selection after a writer is consumed without permitting old-token replay", () => {
    const subject = registry();
    const created = subject.create(scope);
    if (!created.ok) throw new Error("expected context");
    const window = subject.registerTargets(created.data.context, scope, [{
      evidence: { kind: "window", appLabel: "TextEdit" },
      providerTarget: { provider: "cua", operation: "focus", pid: 77, windowId: 900, freshAppeared: false },
    }]);
    const writer = subject.registerTargets(created.data.context, scope, [{
      evidence: { kind: "element", role: "text_area", action: "type_text" },
      providerTarget: { provider: "cua", operation: "type_text", pid: 77, windowId: 900, elementToken: "claimed-private-token" },
    }]);
    if (!window.ok || !writer.ok) throw new Error("expected targets");
    expect(subject.claimElementTarget(created.data.context, scope, writer.data[0]!.reference).ok).toBe(true);
    const read = subject.beginWindowRead(created.data.context, scope, 77, 900);
    if (!read.ok) throw new Error("expected read ticket");
    expect(subject.resolveTarget(created.data.context, scope, window.data[0]!.reference))
      .toMatchObject({ ok: true, data: { providerTarget: { freshAppeared: false } } });
    expect(subject.registerWindowObservation(created.data.context, scope, read.data, {
      element: {
        evidence: { kind: "element", role: "text_area", action: "type_text" },
        providerTarget: { provider: "cua", operation: "type_text", pid: 77, windowId: 900, elementToken: "replacement-private-token" },
      },
    }).ok).toBe(true);
    expect(subject.claimElementTarget(created.data.context, scope, writer.data[0]!.reference))
      .toEqual({ ok: false, code: "not_found" });
  });

  test("rejects late same-window publication while isolating a different window", () => {
    const subject = registry();
    const created = subject.create(scope);
    if (!created.ok) throw new Error("expected context");
    const older = subject.beginWindowRead(created.data.context, scope, 77, 900);
    const different = subject.beginWindowRead(created.data.context, scope, 77, 901);
    const newer = subject.beginWindowRead(created.data.context, scope, 77, 900);
    if (!older.ok || !different.ok || !newer.ok) throw new Error("expected tickets");

    expect(subject.isCurrentWindowRead(created.data.context, scope, older.data))
      .toEqual({ ok: false, code: "refresh_conflict" });
    expect(subject.isCurrentWindowRead(created.data.context, scope, different.data))
      .toEqual({ ok: true, data: undefined });
    expect(subject.isCurrentWindowRead(created.data.context, scope, newer.data))
      .toEqual({ ok: true, data: undefined });
    expect(subject.registerWindowObservation(created.data.context, scope, older.data, {
      snapshot: windowSnapshot(77, 900, Buffer.from([1])),
    })).toEqual({ ok: false, code: "refresh_conflict" });
    const current = subject.registerWindowObservation(created.data.context, scope, newer.data, {
      snapshot: windowSnapshot(77, 900, Buffer.from([9])),
    });
    if (!current.ok || current.data.snapshot === null) throw new Error("expected current snapshot");
    const resolved = subject.resolveScreenSnapshot(created.data.context, scope, current.data.snapshot.reference);
    expect(resolved.ok && [...resolved.data.pngBytes]).toEqual([9]);
  });

  test("fences same-provider native window reads across isolated contexts only", () => {
    let sequence = 0;
    const subject = new ComputerUseContextRegistry({
      maxContexts: 4,
      randomId: () => `${(++sequence).toString(36).padStart(43, "a")}`,
    });
    const scopeA = { ...scope, computerUseContextId: "computer-use-context-a" };
    const scopeB = { ...scope, computerUseContextId: "computer-use-context-b", originRunId: "run-b" };
    const otherGenerationScope = {
      ...scope,
      computerUseContextId: "computer-use-context-other-generation",
      originRunId: "run-other-generation",
      providerGeneration: "provider-generation-2",
    };
    const contextA = subject.create(scopeA);
    const contextB = subject.create(scopeB);
    const otherGeneration = subject.create(otherGenerationScope);
    if (!contextA.ok || !contextB.ok || !otherGeneration.ok) throw new Error("expected isolated contexts");

    const windowsA = subject.registerTargets(contextA.data.context, scopeA, [
      { evidence: { kind: "window", appLabel: "TextEdit" }, providerTarget: { provider: "cua", operation: "focus", pid: 77, windowId: 900 } },
      { evidence: { kind: "window", appLabel: "TextEdit" }, providerTarget: { provider: "cua", operation: "focus", pid: 77, windowId: 901 } },
    ]);
    const windowB = subject.registerTargets(contextB.data.context, scopeB, [{
      evidence: { kind: "window", appLabel: "TextEdit" },
      providerTarget: { provider: "cua", operation: "focus", pid: 77, windowId: 900, freshAppeared: true },
    }]);
    const otherGenerationWindow = subject.registerTargets(otherGeneration.data.context, otherGenerationScope, [{
      evidence: { kind: "window", appLabel: "TextEdit" },
      providerTarget: { provider: "cua", operation: "focus", pid: 77, windowId: 900 },
    }]);
    if (!windowsA.ok || !windowB.ok || !otherGenerationWindow.ok) throw new Error("expected windows");

    const pendingA = subject.beginWindowRead(contextA.data.context, scopeA, 77, 900);
    if (!pendingA.ok) throw new Error("expected pending read");
    const elementA = subject.registerTargets(contextA.data.context, scopeA, [{
      evidence: { kind: "element", role: "button", action: "click" },
      providerTarget: { provider: "cua", operation: "click", pid: 77, windowId: 900, elementToken: "private-a-900" },
    }]);
    const otherWindowElement = subject.registerTargets(contextA.data.context, scopeA, [{
      evidence: { kind: "element", role: "button", action: "click" },
      providerTarget: { provider: "cua", operation: "click", pid: 77, windowId: 901, elementToken: "private-a-901" },
    }]);
    const otherGenerationElement = subject.registerTargets(otherGeneration.data.context, otherGenerationScope, [{
      evidence: { kind: "element", role: "button", action: "click" },
      providerTarget: { provider: "cua", operation: "click", pid: 77, windowId: 900, elementToken: "private-other-generation" },
    }]);
    if (!elementA.ok || !otherWindowElement.ok || !otherGenerationElement.ok) throw new Error("expected elements");

    const readB = subject.beginWindowRead(contextB.data.context, scopeB, 77, 900);
    if (!readB.ok) throw new Error("expected cross-context read");
    expect(subject.isCurrentWindowRead(contextA.data.context, scopeA, pendingA.data))
      .toEqual({ ok: false, code: "refresh_conflict" });
    expect(subject.resolveTarget(contextA.data.context, scopeA, elementA.data[0]!.reference))
      .toEqual({ ok: false, code: "not_found" });
    expect(subject.resolveTarget(contextA.data.context, scopeA, otherWindowElement.data[0]!.reference).ok).toBe(true);
    expect(subject.resolveTarget(otherGeneration.data.context, otherGenerationScope, otherGenerationElement.data[0]!.reference).ok).toBe(true);
    expect(subject.resolveTarget(contextA.data.context, scopeB, windowsA.data[0]!.reference))
      .toEqual({ ok: false, code: "scope_mismatch" });

    const committed = subject.registerWindowObservation(contextB.data.context, scopeB, readB.data, {
      element: {
        evidence: { kind: "element", role: "text_area", action: "type_text" },
        providerTarget: { provider: "cua", operation: "type_text", pid: 77, windowId: 900, elementToken: "private-b-fresh-writer" },
      },
    });
    if (!committed.ok || committed.data.element === null) throw new Error("expected current writer");
    expect(subject.resolveTarget(contextB.data.context, scopeB, windowB.data[0]!.reference))
      .toMatchObject({ ok: true, data: { providerTarget: { freshAppeared: true } } });
    expect(subject.resolveTarget(contextB.data.context, scopeB, committed.data.element.reference).ok).toBe(true);
  });

  test("never evicts a live context at capacity", () => {
    const subject = registry();
    const first = subject.create(scope);
    const second = subject.create({ ...scope, computerUseContextId: "computer-use-context-2" });
    if (!first.ok || !second.ok) throw new Error("expected retained contexts");
    const target = subject.registerTargets(first.data.context, scope, [{
      evidence: { kind: "window", appLabel: "Nautilo", windowLabel: "Connections" },
      providerTarget: { provider: "cua", operation: "focus", windowId: 1 },
    }]);
    if (!target.ok) throw new Error("expected retained target");
    expect(subject.create({ ...scope, computerUseContextId: "computer-use-context-3" }))
      .toEqual({ ok: false, code: "capacity_exhausted" });
    expect(subject.resolveTarget(first.data.context, scope, target.data[0]!.reference).ok).toBe(true);
  });

  test("lets a completed observation supersede its own server context without evicting other runs", () => {
    const subject = registry();
    const first = subject.create(scope);
    if (!first.ok) throw new Error("expected first context");
    const target = subject.registerTargets(first.data.context, scope, [{
      evidence: { kind: "window", appLabel: "Nautilo", windowLabel: "Connections" },
      providerTarget: { provider: "cua", operation: "focus", windowId: 1 },
    }]);
    if (!target.ok) throw new Error("expected first target");
    const failedObservationReservation = subject.reserveContext(scope);
    if (!failedObservationReservation.ok) throw new Error("expected same-run reservation");
    subject.releaseContextReservation(failedObservationReservation.data.reservation);
    expect(subject.resolveTarget(first.data.context, scope, target.data[0]!.reference).ok).toBe(true);
    // Repeated observations for this one server context can continue beyond
    // the ordinary concurrent-context capacity without touching another run.
    let newest = first;
    for (let index = 0; index < 5; index += 1) {
      newest = subject.create(scope);
      if (!newest.ok) throw new Error("same run should supersede its own context");
    }
    expect(subject.resolveTarget(first.data.context, scope, target.data[0]!.reference))
      .toEqual({ ok: false, code: "not_found" });
    expect(subject.create({ ...scope, computerUseContextId: "computer-use-context-other" }).ok).toBe(true);
    expect(newest.ok).toBe(true);
  });
});
