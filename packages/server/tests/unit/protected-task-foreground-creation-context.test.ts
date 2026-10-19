import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import {
  currentProtectedTaskForegroundCreationContext,
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
