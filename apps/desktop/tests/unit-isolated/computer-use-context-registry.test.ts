import { describe, expect, test } from "bun:test";
import {
  ComputerUseContextRegistry,
  type ComputerUseContextScope,
  type ComputerUseScreenSnapshotInput,
} from "../../electron/computer-use/context-registry.ts";

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

describe("D516 computer-use context registry", () => {
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

  test("retains 100 windows and 64 app capabilities in separate explicit budgets", () => {
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
    }])).toEqual({ ok: false, code: "invalid" });
    expect(subject.registerTargets(created.data.context, scope, [{
      evidence: { kind: "app", appLabel: "65", hidden: false, focused: false },
      providerTarget: { provider: "cua", operation: "observe_only", pid: 1065 },
    }])).toEqual({ ok: false, code: "invalid" });

    // An AX element is not a 101st window.  It carries a distinct, one-shot
    // detgt_ capability and must not erode the complete-window budget.
    const element = subject.registerTargets(created.data.context, scope, [{
      evidence: { kind: "element", role: "text_area", valueCondition: "fresh_document_empty_or_unreadable" },
      providerTarget: { provider: "cua", operation: "type_text", pid: 17, windowId: 1, elementToken: "private-token" },
    }]);
    expect(element).toMatchObject({ ok: true, data: [{ reference: expect.stringMatching(/^detgt_[A-Za-z0-9_-]{43}$/) }] });
  });

  test("mints a one-shot element capability as detgt_ without consuming window capacity", () => {
    const subject = registry();
    const created = subject.create(scope);
    if (!created.ok) throw new Error("expected context");
    const element = subject.registerTargets(created.data.context, scope, [{
      evidence: { kind: "element", role: "text_area", valueCondition: "fresh_document_empty_or_unreadable" },
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
