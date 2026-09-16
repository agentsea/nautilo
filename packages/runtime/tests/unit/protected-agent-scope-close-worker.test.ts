import { describe, expect, test } from "bun:test";
import type {
  PostgresProtectedScopeCloseSaga,
  ProtectedScopeCloseClaim,
  ProtectedScopeCloseItem,
} from "@nautilo/trust";

import {
  createProtectedAgentScopeCloseTransition,
  runProtectedAgentScopeCloseWorker,
} from "../../src/memory/protected-agent-scope-close-worker.ts";
import {
  createProtectedAgentScopeCloseLifecycleHandler,
  type ForegroundProtectedAgentMemoryToolRevalidator,
} from "../../src/memory/foreground-protected-agent-memory-session.ts";

const OPERATION = "scope-close:worker-1";
const AGENT = "22000000-0000-4000-8000-000000000001";
const HUMAN = "33000000-0000-4000-8000-000000000001";
const SCOPE = "44000000-0000-4000-8000-000000000001";
const TARGET_NAMESPACE = "99000000-0000-4000-8000-000000000001";

function item(ordinal: number): ProtectedScopeCloseItem {
  return Object.freeze({
    ordinal,
    memoryId: `66000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`,
    origin: ordinal === 0 ? "seed" : "scope",
    cryptoObjectId: `memory:v1:scope-${ordinal}`,
    expectedContentRevision: 2,
    expectedAccessRevision: 1,
    expectedRequiredNamespaceFingerprint: new Uint8Array(32).fill(ordinal + 1),
    sourceOriginNamespaceId: ordinal === 0
      ? null
      : "77000000-0000-4000-8000-000000000001",
    action: ordinal === 0 ? "detach_seed" : "promote_origin",
    targetNamespaceId: ordinal === 0
      ? null
      : "88000000-0000-4000-8000-000000000001",
  });
}

describe("protected AgentScope close worker", () => {
  test("starts and restart-replays the durable close through live foreground authorization", async () => {
    let observation: Awaited<ReturnType<
      PostgresProtectedScopeCloseSaga["observe"]
    >> = null;
    let leaseCalls = 0;
    const saga: Pick<
      PostgresProtectedScopeCloseSaga,
      "assertOpenForProtectedMutation" | "begin" | "observe"
    > = {
      observe: async () => observation,
      assertOpenForProtectedMutation: async () => ({
        status: "open",
        scopeId: SCOPE,
        scopeRevision: 4,
      }),
      begin: async (input) => {
        expect(input).toMatchObject({
          operationId: OPERATION,
          scopeId: SCOPE,
          parentAgentId: AGENT,
          speakerUserId: HUMAN,
          expectedScopeRevision: 4,
          targetNamespaceId: TARGET_NAMESPACE,
        });
        observation = {
          operationId: OPERATION,
          scopeId: SCOPE,
          state: "active",
          failureCode: null,
          capturedItemCount: 2,
          items: [],
        };
        return {
          status: "started",
          operationId: OPERATION,
          scopeId: SCOPE,
          sourceScopeRevision: 4,
          capturedItemCount: 2,
          inventoryDigest: new Uint8Array(32),
        };
      },
    };
    const revalidate: ForegroundProtectedAgentMemoryToolRevalidator = {
      run: async (input) => {
        leaseCalls += 1;
        expect(input.operation).toBe("encrypt");
        expect(input.namespaceIds).toEqual([TARGET_NAMESPACE]);
        return input.execute();
      },
    };
    const close = createProtectedAgentScopeCloseLifecycleHandler({ saga });
    const request = Object.freeze({
      operationId: OPERATION,
      scopeId: SCOPE,
      authority: Object.freeze({
        mode: "namespace" as const,
        subjectUserId: HUMAN,
        agentId: AGENT,
        readableNamespaceIds: Object.freeze([TARGET_NAMESPACE]),
        mutableNamespaceIds: Object.freeze([TARGET_NAMESPACE]),
        writableNamespaceId: TARGET_NAMESPACE,
      }),
    });
    expect(await close(request, revalidate)).toEqual({
      status: "success",
      value: { status: "closing", scopeId: SCOPE, transitionCount: 2 },
    });
    observation = { ...observation!, state: "complete" };
    expect(await close(request, revalidate)).toEqual({
      status: "success",
      value: { status: "replayed", scopeId: SCOPE, transitionCount: 2 },
    });
    expect(leaseCalls).toBe(1);
  });

  test("processes bounded durable claims and finalizes only after receipts", async () => {
    const pending = [item(0), item(1)];
    const completed: number[] = [];
    const saga: Pick<
      PostgresProtectedScopeCloseSaga,
      "claim" | "completeClaim" | "finalize"
    > = {
      claim: async (input): Promise<ProtectedScopeCloseClaim> => {
        const next = pending.shift();
        return next === undefined
          ? { status: "empty" }
          : {
              status: "claimed",
              operationId: input.operationId,
              claimToken: input.claimToken,
              claimOwner: input.claimOwner,
              claimExpiresAt: input.now + input.leaseMs,
              attemptCount: 1,
              item: next,
            };
      },
      completeClaim: async (input) => {
        if (input.result.status === "complete") completed.push(input.ordinal);
        return "applied";
      },
      finalize: async () => completed.length === 2 ? "complete" : "pending",
    };
    let token = 0;
    const transitioned: string[] = [];
    expect(await runProtectedAgentScopeCloseWorker({
      saga,
      operationId: OPERATION,
      scopeId: SCOPE,
      parentAgentId: AGENT,
      speakerUserId: HUMAN,
      workerId: "scope-worker-1",
      now: () => 10_000,
      createClaimToken: () =>
        `55000000-0000-4000-8000-${String(token++).padStart(12, "0")}`,
      transition: async ({ item: entry }) => {
        transitioned.push(entry.action);
        return {
          status: "complete",
          productReceiptRef: `product:${entry.ordinal}`,
          cryptoReceiptRef: entry.action === "detach_seed"
            ? "crypto:not-required"
            : `crypto:${entry.ordinal}`,
        };
      },
    })).toEqual({ status: "closed", processed: 2 });
    expect(transitioned).toEqual(["detach_seed", "promote_origin"]);
    expect(completed).toEqual([0, 1]);
  });

  test("turns a thrown transition into a bounded retry and keeps closing", async () => {
    const captured = item(0);
    let claimed = false;
    let retryAt = 0;
    const saga: Pick<
      PostgresProtectedScopeCloseSaga,
      "claim" | "completeClaim" | "finalize"
    > = {
      claim: async (input) => {
        if (claimed) return { status: "empty" };
        claimed = true;
        return {
          status: "claimed",
          operationId: input.operationId,
          claimToken: input.claimToken,
          claimOwner: input.claimOwner,
          claimExpiresAt: input.now + input.leaseMs,
          attemptCount: 1,
          item: captured,
        };
      },
      completeClaim: async (input) => {
        if (input.result.status === "retry") retryAt = input.result.nextAttemptAt;
        return "applied";
      },
      finalize: async () => "pending",
    };
    expect(await runProtectedAgentScopeCloseWorker({
      saga,
      operationId: OPERATION,
      scopeId: SCOPE,
      parentAgentId: AGENT,
      speakerUserId: HUMAN,
      workerId: "scope-worker-1",
      now: () => 20_000,
      createClaimToken: () => "55000000-0000-4000-8000-000000000001",
      transition: () => Promise.reject(new Error("response lost")),
      maximumItems: 1,
    })).toEqual({ status: "closing", processed: 1 });
    expect(retryAt).toBe(25_000);
  });

  test("reconciles response loss and uses a fresh operation only after pre-crypto abandonment", async () => {
    const promoted: string[] = [];
    const reconciled: string[] = [];
    const transition = createProtectedAgentScopeCloseTransition({
      detachSeed: ({ item: entry }) => Promise.resolve({
        status: "success",
        value: { productReceiptRef: `seed:${entry.memoryId}` },
      }),
      reconcilePromotion: ({ operationId }) => {
        reconciled.push(operationId);
        return Promise.resolve(reconciled.length === 1
          ? { status: "completed" as const }
          : { status: "stale" as const });
      },
      promote: ({ operationId }) => {
        promoted.push(operationId);
        return Promise.resolve({
          status: "success",
          value: { status: "updated" as const, memoryId: item(1).memoryId },
        });
      },
    });
    const base = {
      closeOperationId: OPERATION,
      scopeId: SCOPE,
      item: item(1),
    } as const;
    const first = await transition({ ...base, attemptCount: 1 });
    expect(first).toMatchObject({ status: "complete" });
    expect(promoted).toHaveLength(1);

    const recovered = await transition({ ...base, attemptCount: 2 });
    expect(recovered).toEqual(first);
    expect(promoted).toHaveLength(1);

    const fresh = await transition({ ...base, attemptCount: 3 });
    expect(fresh).toMatchObject({ status: "complete" });
    expect(promoted).toHaveLength(2);
    expect(promoted[1]).not.toBe(promoted[0]);
  });

  test("detaches a seed without invoking crypto promotion", async () => {
    let promoted = false;
    const transition = createProtectedAgentScopeCloseTransition({
      detachSeed: ({ item: entry }) => Promise.resolve({
        status: "success",
        value: { productReceiptRef: `seed:${entry.memoryId}` },
      }),
      reconcilePromotion: () => Promise.resolve({ status: "stale" }),
      promote: () => {
        promoted = true;
        return Promise.resolve({
          status: "unavailable",
          reason: "integrity_failure",
        });
      },
    });
    expect(await transition({
      closeOperationId: OPERATION,
      scopeId: SCOPE,
      attemptCount: 1,
      item: item(0),
    })).toEqual({
      status: "complete",
      productReceiptRef: `seed:${item(0).memoryId}`,
      cryptoReceiptRef: "crypto:not-required",
    });
    expect(promoted).toBeFalse();
  });
});
