import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import {
  currentProtectedTaskForegroundCreationContext,
  readProtectedTaskForegroundCreationPolicy,
  withProtectedTaskForegroundCreationContext,
  type ProtectedTaskForegroundCreationContext,
} from "../../src/routes/protected-task-foreground-creation-context";

function source(assertCurrent: () => Promise<void>): ProtectedTaskForegroundCreationContext {
  return {
    assertCurrent,
    admission: { admit: () => Promise.resolve({ kind: "unavailable", reason: "creation_origin_unavailable" }) },
    publishProtected: () => Promise.reject(new Error("Fixture cannot publish a Task")),
    preflightProtectedTaskUpdate: () => Promise.reject(new Error("Fixture cannot preflight a Task update")),
    updateProtectedTask: () => Promise.reject(new Error("Fixture cannot update a Task")),
    withTaskDefinitionAuthorization: input => input.use(),
    withProduct: input => input.use(),
  };
}

test("foreground creation ports are absent outside a turn and reject retained callbacks after it closes", async () => {
  expect(currentProtectedTaskForegroundCreationContext()).toBeNull();
  let checks = 0;
  const retained = await withProtectedTaskForegroundCreationContext(source(async () => { checks += 1; }), async () => {
    const context = currentProtectedTaskForegroundCreationContext();
    expect(context).not.toBeNull();
    if (context === null) throw new Error("Missing current creation owner");
    await context.assertCurrent();
    return context;
  });
  expect(checks).toBe(1);
  expect(currentProtectedTaskForegroundCreationContext()).toBeNull();
  await rejects(retained.assertCurrent(), /foreground scope closed/u);
  expect(checks).toBe(1);
});

test("nested creation scope restores the original owner and closes only the inner loan", async () => {
  await withProtectedTaskForegroundCreationContext(source(() => Promise.resolve()), async () => {
    const outer = currentProtectedTaskForegroundCreationContext();
    const inner = await withProtectedTaskForegroundCreationContext(source(() => Promise.resolve()), async () => {
      const value = currentProtectedTaskForegroundCreationContext();
      expect(value).not.toBe(outer);
      if (value === null) throw new Error("Missing inner creation owner");
      return value;
    });
    expect(currentProtectedTaskForegroundCreationContext()).toBe(outer);
    await rejects(inner.assertCurrent(), /foreground scope closed/u);
    await outer?.assertCurrent();
  });
});

test("a proof awaiting source authority cannot resume after its foreground closes", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let pending: Promise<void> | null = null;
  await withProtectedTaskForegroundCreationContext(source(() => gate), () => {
    const current = currentProtectedTaskForegroundCreationContext();
    if (current === null) throw new Error("Missing creation owner");
    pending = current.assertCurrent();
    void pending.catch(() => undefined);
    return Promise.resolve();
  });
  release();
  if (pending === null) throw new Error("Pending foreground assertion missing");
  await rejects(pending, /foreground scope closed/u);
});

test("policy reads use only an active held source and otherwise use the supplied fallback", async () => {
  const fallbackPolicy = Object.freeze({ mode: "plaintext_only" as const, shadowBehavior: "fallback" as const, revision: 1 });
  const heldPolicy = Object.freeze({ mode: "encrypted_only" as const, shadowBehavior: "strict" as const, revision: 3 });
  let fallbackReads = 0;
  const fallback = () => { fallbackReads += 1; return Promise.resolve(fallbackPolicy); };
  expect(await readProtectedTaskForegroundCreationPolicy(fallback)).toBe(fallbackPolicy);

  const retained = await withProtectedTaskForegroundCreationContext<ProtectedTaskForegroundCreationContext>({
    ...source(() => Promise.resolve()),
    readHeldPolicy: () => Promise.resolve(heldPolicy),
  }, async () => {
    const active = currentProtectedTaskForegroundCreationContext();
    if (active === null) throw new Error("Missing active policy reader");
    expect(await readProtectedTaskForegroundCreationPolicy(fallback)).toBe(heldPolicy);
    return active;
  });
  expect(fallbackReads).toBe(1);
  const retainedRead = retained.readHeldPolicy;
  if (retainedRead === undefined) throw new Error("Missing retained policy reader");
  await rejects(retainedRead, /foreground scope closed/u);

  let releaseEscapedRead!: () => void;
  const escapedReadGate = new Promise<void>(resolve => { releaseEscapedRead = resolve; });
  let escapedRead!: Promise<unknown>;
  await withProtectedTaskForegroundCreationContext({
    ...source(() => Promise.resolve()),
    readHeldPolicy: () => Promise.resolve(heldPolicy),
  }, () => {
    escapedRead = (async () => {
      await escapedReadGate;
      return readProtectedTaskForegroundCreationPolicy(fallback);
    })();
    void escapedRead.catch(() => undefined);
    return Promise.resolve();
  });
  releaseEscapedRead();
  await rejects(escapedRead, /foreground scope closed/u);

  let releasePendingFallback!: () => void;
  const pendingFallbackGate = new Promise<void>(resolve => { releasePendingFallback = resolve; });
  let pendingFallback!: Promise<unknown>;
  await withProtectedTaskForegroundCreationContext(source(() => Promise.resolve()), () => {
    pendingFallback = readProtectedTaskForegroundCreationPolicy(async () => {
      await pendingFallbackGate;
      return fallbackPolicy;
    });
    void pendingFallback.catch(() => undefined);
    return Promise.resolve();
  });
  releasePendingFallback();
  await rejects(pendingFallback, /foreground scope closed/u);

  const integrityFailure = new Error("held policy integrity failure");
  await withProtectedTaskForegroundCreationContext({
    ...source(() => Promise.resolve()),
    readHeldPolicy: () => Promise.reject(integrityFailure),
  }, async () => {
    await rejects(
      () => readProtectedTaskForegroundCreationPolicy(fallback),
      cause => cause === integrityFailure,
    );
  });
  expect(fallbackReads).toBe(1);
});
