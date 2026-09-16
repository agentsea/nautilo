import { expect, test } from "bun:test";
import { completeHostedExecution, reconcileHostedExecutionCleanup } from "../../src/connected-web-accounts/hosted-execution-cleanup";
import type { ConnectedWebAccountStore } from "../../src/connected-web-accounts/store";

test("failed synchronous shutdown retains exact custody for a later cleanup tick, without replaying a task", async () => {
  const events: string[] = [];
  let pending = false;
  let stops = 0;
  const checkpoint = { resource: "read" as const, phase: "active" as const, reservationToken: "reservation", opaqueExecutionRef: "run", recordedAt: new Date().toISOString(), cleanupStatus: "connected" as const };
  const store = {
    requestExecutionCleanup: async () => { pending = true; events.push("checkpoint"); return "run"; },
    completeExecution: async () => { pending = false; events.push("complete"); return {} as never; },
    listPendingExecutionCleanup: async () => pending ? [{ accountId: "account", ownerUserId: "owner", checkpoint }] : [],
  } satisfies Pick<ConnectedWebAccountStore, "requestExecutionCleanup" | "completeExecution" | "listPendingExecutionCleanup">;
  const provider = { stopHostedReadBrowser: async (runId: string) => { events.push(`stop:${runId}`); return ++stops > 1; } };
  expect(await completeHostedExecution(store, provider, { accountId: "account", reservationToken: "reservation", status: "connected" }).catch((error: unknown) => error)).toBeInstanceOf(Error);
  expect(pending).toBe(true);
  expect(events).toEqual(["checkpoint", "stop:run"]);
  await reconcileHostedExecutionCleanup(store, provider);
  expect(events).toEqual(["checkpoint", "stop:run", "checkpoint", "stop:run", "complete"]);
  expect(pending).toBe(false);
  await reconcileHostedExecutionCleanup(store, provider);
  expect(stops).toBe(2);
});

test("a stale cleanup checkpoint cannot reach the provider or clear a newer execution", async () => {
  let stopped = false;
  const store = {
    requestExecutionCleanup: async () => { throw new Error("conflict"); },
    completeExecution: async () => { throw new Error("must not complete"); },
    listPendingExecutionCleanup: async () => [],
  };
  expect(await completeHostedExecution(store, { stopHostedReadBrowser: async () => { stopped = true; return true; } }, {
    accountId: "account", reservationToken: "old-reservation", expectedOpaqueExecutionRef: "old-run", status: "connected",
  }).catch((error: unknown) => error)).toBeInstanceOf(Error);
  expect(stopped).toBe(false);
});
