import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createConnectedWebAccountActionServerRuntime } from "../../src/connected-web-accounts/action-tool-runtime";
import { ConnectedWebAccountController } from "../../src/connected-web-accounts/controller";
import { parseConnectedWebActionSafeReceipt } from "../../src/connected-web-accounts/store";

const account = {
  id: "00000000-0000-4000-8000-000000000001", label: "Nebius", service: "Nebius",
  origin: "https://console.nebius.com", status: "connected" as const,
  lastVerifiedAt: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};
const actor = { userId: "user", agentId: "agent", roomId: "room", callingRoomId: null, memoryAccessEnvelope: {} as never };
const input = { account: "Nebius", action: "save_item" as const, target: "my named item", deliveryId: "tool-call-1" };
const postcondition = "The named item my named item is saved, bookmarked, or favorited in this connected account.";
const parkedRequestDigest = createHash("sha256").update(JSON.stringify({ accountId: account.id, action: "save_item", target: input.target, postcondition })).digest("hex");

interface ActionRuntimeOverrides {
  providerResults?: (string | null)[];
  status?: string;
  claimed?: unknown;
  authorized?: boolean;
  terminalStatus?: "completed" | "cancelled";
  createFailureCode?: "invalid_configuration" | "invalid_browser_policy" | "resource_not_found" | "conflict" | "rate_limited" | "provider_unavailable" | "timeout" | "network_error" | "malformed_response";
  createStatus?: "completed" | "running";
  pollStatuses?: Array<"running" | "completed">;
  now?: () => Date;
  sleep?: () => Promise<void>;
  pollMalformed?: boolean;
  throwGetAt?: number;
  failActionActivationAt?: 1 | 2;
  failCheckpointActivationAt?: 1 | 2;
  finishCompletedThrows?: boolean;
  failAttentionFinish?: boolean;
  totalCosts?: (string | null)[];
}

function runtime(overrides: ActionRuntimeOverrides = {}) {
  const calls = { create: 0, reserve: 0, release: 0, complete: 0, cancel: 0, authenticationCancellationReceipt: null as unknown, finish: [] as string[], events: [] as string[], budgets: [] as number[], cost: [] as Array<{ operation: string; total: string | null }> };
  const providerResults = overrides.providerResults ?? [
    JSON.stringify({ outcome: "action_attempted", action: "save_item", target: input.target, origin: account.origin }),
    JSON.stringify({ outcome: "postcondition", observed: true, postcondition, origin: account.origin }),
  ];
  const status = overrides.status ?? "connected";
  let getCalls = 0;
  const claimed = overrides.claimed ?? { kind: "new", operation: { id: "op-1", ownerUserId: "user", accountId: account.id, deliveryId: input.deliveryId, requestDigest: "a".repeat(64), actionType: "save_item", target: input.target, status: "reserving", opaqueRunRef: null, receipt: null } };
  let currentOperation = (claimed as { operation?: { status: string; opaqueRunRef: string | null; receipt: unknown } }).operation;
  const value = createConnectedWebAccountActionServerRuntime({
    facts: { hasExactOwnedGenie: async () => overrides.authorized !== false, isOwnersPersonalPrivateRoom: async () => overrides.authorized !== false },
    accounts: {
      listForOwner: async () => status === "revoked" ? [{ ...account, status: "revoked" as const }] : [account],
      getBindingForOwner: async () => ({ accountId: account.id, ownerUserId: "user", service: account.service, origin: account.origin, status, profileRef: "profile", }),
    },
    executions: {
      reserveExecutionCheckpoint: async () => { calls.reserve++; },
      activateExecutionCheckpoint: async ({ opaqueExecutionRef }: { opaqueExecutionRef: string }) => { calls.events.push(`checkpoint:${opaqueExecutionRef}`); if (overrides.failCheckpointActivationAt === 1) throw new Error("checkpoint_activation_failed"); },
      rotateExecutionCheckpointReference: async ({ opaqueExecutionRef }: { opaqueExecutionRef: string }) => { calls.events.push(`checkpoint:${opaqueExecutionRef}`); if (overrides.failCheckpointActivationAt === 2) throw new Error("checkpoint_rotation_failed"); },
      completeExecution: async ({ status: next }: { status: string }) => {
        calls.complete++;
        if (next === "attention_needed" && overrides.failAttentionFinish) throw new Error("attention_checkpoint_failed");
        return account;
      }, releaseExecutionReservation: async () => { calls.release++; },
      claimActionOperation: async () => claimed as never,
      activateActionOperation: async ({ opaqueRunRef, nextStatus }: { opaqueRunRef: string; nextStatus?: "running" | "verifying" }) => {
        calls.events.push(`operation:${opaqueRunRef}`); const index = opaqueRunRef === "run-1" ? 1 : 2;
        if (overrides.failActionActivationAt === index) throw new Error("operation_activation_failed");
        if (currentOperation) currentOperation = { ...currentOperation, status: nextStatus ?? "running", opaqueRunRef };
      },
      finishActionOperation: async ({ status: next, receipt }: { status: string; receipt: unknown }) => {
        if (next === "completed" && overrides.finishCompletedThrows) throw new Error("receipt_write_failed");
        calls.finish.push(next); if (currentOperation) currentOperation = { ...currentOperation, status: next, opaqueRunRef: null, receipt };
      },
      getActionOperationForOwnerDelivery: async () => currentOperation as never,
      resumeActionOperation: async () => { if (currentOperation) currentOperation = { ...currentOperation, status: "reserving", opaqueRunRef: null, receipt: null }; },
      cancelActionAuthentication: async ({ receipt }: { receipt: unknown }) => {
        calls.authenticationCancellationReceipt = receipt;
        if (currentOperation) currentOperation = { ...currentOperation, status: "cancelled", opaqueRunRef: null, receipt };
      },
    },
    provider: {
      stopHostedReadBrowser: async (runId) => { calls.events.push(`browser-stop:${runId}`); return true; },
      health: () => ({ kind: "available" as const }),
      createHostedReadRun: async ({ maxCostUsd }: { maxCostUsd: number }) => {
        calls.budgets.push(maxCostUsd);
        return overrides.createFailureCode
        ? { kind: "failure" as const, code: overrides.createFailureCode }
        : ({ runId: `run-${++calls.create}`, status: overrides.createStatus ?? overrides.terminalStatus ?? "completed" });
      },
      pollHostedReadRun: async () => overrides.pollMalformed
        ? ({ malformed: true } as never)
        : ({ runId: "unused", status: overrides.pollStatuses?.shift() ?? "completed" }),
      getHostedReadResult: async () => { getCalls++; if (overrides.throwGetAt === getCalls) throw new Error("result_transport_lost"); const result = providerResults.shift() ?? null; const total = overrides.totalCosts?.shift() ?? null; return { runId: "unused", status: "completed" as const, result, totalCostUsd: total }; },
      cancelHostedReadRun: async () => { calls.cancel++; return { runId: calls.create === 0 ? "run-1" : `run-${calls.create}`, status: "cancelled" as const }; },
    },
    policy: { maxCostUsd: 1, pollIntervalMs: 1 },
    ...(overrides.now ? { now: overrides.now } : {}),
    ...(overrides.sleep ? { sleep: overrides.sleep } : {}),
    recordProviderCost: async ({ operation, actualCostUsd }) => { calls.cost.push({ operation, total: actualCostUsd }); },
  });
  return { value, calls };
}

describe("connected website save action", () => {
  test("continues action and verification runs beyond the former five-minute cutoff", async () => {
    let now = 0;
    const { value, calls } = runtime({
      createStatus: "running",
      pollStatuses: ["running", "completed", "running", "completed"],
      now: () => new Date(now),
      sleep: async () => { now += 180_000; },
    });

    expect(await value.act(actor, input)).toMatchObject({ ok: true, status: "completed" });
    expect(now).toBe(720_000);
    expect(calls.cancel).toBe(0);
  });

  test("requires independent observed postcondition before completion", async () => {
    const { value, calls } = runtime();
    const result = await value.act(actor, input);
    expect(result).toMatchObject({ ok: true, status: "completed", receipt: { executionRef: "op-1", effectState: "observed", evidenceCode: "postcondition_observed" } });
    expect(calls.create).toBe(2);
    expect(calls.finish).toEqual(["completed"]);
  });

  test("returns ambiguous after attempted effect when postcondition is malformed or false", async () => {
    const { value, calls } = runtime({ providerResults: [
      JSON.stringify({ outcome: "action_attempted", action: "save_item", target: input.target, origin: account.origin }),
      JSON.stringify({ outcome: "postcondition", observed: false, postcondition, origin: account.origin }),
    ] });
    expect(await value.act(actor, input)).toEqual({ ok: false, code: "ambiguous", recovery: "none" });
    expect(calls.finish).toEqual(["ambiguous"]);
  });

  test("quarantines uncertain action admission failures instead of reopening the profile", async () => {
    for (const code of ["provider_unavailable", "timeout", "network_error", "malformed_response"] as const) {
      const subject = runtime({ createFailureCode: code });
      expect(await subject.value.act(actor, input)).toEqual({ ok: false, code: "ambiguous", recovery: "none" });
      expect(subject.calls.release).toBe(0);
      expect(subject.calls.finish).toEqual(["ambiguous"]);
    }
  });

  test("releases the action reservation only for a clearly rejected admission", async () => {
    for (const code of ["invalid_configuration", "invalid_browser_policy", "resource_not_found", "conflict", "rate_limited"] as const) {
      const subject = runtime({ createFailureCode: code });
      expect(await subject.value.act(actor, input)).toEqual({ ok: false, code: "failed", recovery: "none" });
      expect(subject.calls.release).toBe(1);
      expect(subject.calls.finish).toEqual(["failed"]);
    }
  });

  test("persists each operation run before its matching account checkpoint, including verifier rotation", async () => {
    const subject = runtime();
    expect((await subject.value.act(actor, input)).ok).toBe(true);
    expect(subject.calls.events).toEqual(["operation:run-1", "checkpoint:run-1", "browser-stop:run-1", "operation:run-2", "checkpoint:run-2"]);
  });

  test("first action operation activation failure cancels the known provider run and stays ambiguous", async () => {
    const subject = runtime({ failActionActivationAt: 1 });
    expect(await subject.value.act(actor, input)).toEqual({ ok: false, code: "ambiguous", recovery: "none" });
    expect(subject.calls.cancel).toBe(1);
    expect(subject.calls.finish).toEqual(["ambiguous"]);
  });

  test("verification checkpoint rotation failure cancels the verifier and stays ambiguous", async () => {
    const subject = runtime({ failCheckpointActivationAt: 2 });
    expect(await subject.value.act(actor, input)).toEqual({ ok: false, code: "ambiguous", recovery: "none" });
    expect(subject.calls.events).toEqual(["operation:run-1", "checkpoint:run-1", "browser-stop:run-1", "operation:run-2", "checkpoint:run-2", "browser-stop:run-2"]);
    expect(subject.calls.cancel).toBe(1);
    expect(subject.calls.finish).toEqual(["ambiguous"]);
  });

  test("barriers never honor Stop or release a fence before cleaning up a known verifier", async () => {
    const active = { id: "op-1", ownerUserId: "user", accountId: account.id, deliveryId: input.deliveryId, requestDigest: "a".repeat(64), actionType: "save_item" as const, target: input.target, status: "running" as const, opaqueRunRef: "run-1", receipt: null };
    const stopped = { ...active, status: "ambiguous" as const, opaqueRunRef: null, receipt: { executionRef: "op-1", action: "save_item" as const, target: input.target, effectState: "ambiguous" as const, postcondition: null, evidenceCode: "owner_stopped_action_unverified", cost: { amountUsd: null, state: "unknown" as const } } };
    for (const barrier of ["before-b-create", "after-b-create", "between-rotations", "after-both-rotations"] as const) {
      const events: string[] = [];
      let stoppedNow = barrier === "before-b-create";
      let create = 0;
      let completed = 0;
      const value = createConnectedWebAccountActionServerRuntime({
        facts: { hasExactOwnedGenie: async () => true, isOwnersPersonalPrivateRoom: async () => true },
        accounts: { listForOwner: async () => [account], getBindingForOwner: async () => ({ accountId: account.id, ownerUserId: "user", service: account.service, origin: account.origin, status: "connected" as const, profileRef: "profile" }) },
        executions: {
          reserveExecutionCheckpoint: async () => undefined,
          activateExecutionCheckpoint: async () => undefined,
          rotateExecutionCheckpointReference: async () => {
            events.push("checkpoint:B");
            if (barrier === "between-rotations") { events.push("stop:prior"); stoppedNow = true; throw new Error("stop raced checkpoint rotation"); }
            if (barrier === "after-both-rotations") { events.push("stop:prior"); stoppedNow = true; }
          },
          completeExecution: async () => { completed++; return account; },
          releaseExecutionReservation: async () => { events.push("release"); },
          claimActionOperation: async () => ({ kind: "new" as const, operation: { ...active, status: "reserving" as const, opaqueRunRef: null } }),
          activateActionOperation: async ({ opaqueRunRef }: { opaqueRunRef: string }) => { if (opaqueRunRef === "run-2") { events.push("operation:B"); if (barrier === "after-b-create") { events.push("stop:prior"); stoppedNow = true; throw new Error("stop raced operation rotation"); } } },
          finishActionOperation: async () => { events.push("finish"); },
          getActionOperationForOwnerDelivery: async () => { events.push(`ledger:${stoppedNow ? "terminal" : "active"}`); return stoppedNow ? stopped : active; },
        } as never,
        provider: {
          stopHostedReadBrowser: async () => true,
          health: () => ({ kind: "available" as const }),
          createHostedReadRun: async () => ({ runId: `run-${++create}`, status: create === 2 && barrier === "after-both-rotations" ? "running" as const : "completed" as const }),
          pollHostedReadRun: async () => ({ runId: "unused", status: "cancelled" as const }),
          getHostedReadResult: async () => ({ runId: "unused", status: "completed" as const, result: create === 1
            ? JSON.stringify({ outcome: "action_attempted", action: "save_item", target: input.target, origin: account.origin })
            : JSON.stringify({ outcome: "postcondition", observed: true, postcondition, origin: account.origin }), totalCostUsd: null }),
          cancelHostedReadRun: async (runId: string) => { events.push(`cancel:${runId}`); stoppedNow = true; return { runId, status: "cancelled" as const }; },
        },
        policy: { maxCostUsd: 1, pollIntervalMs: 1 },
      });
      expect(await value.act(actor, input)).toEqual({ ok: false, code: "ambiguous", recovery: "none" });
      if (barrier === "before-b-create") {
        expect(create).toBe(1);
        expect(events).toEqual(["ledger:terminal"]);
      } else {
        expect(create).toBe(2);
        expect(events.indexOf("cancel:run-2")).toBeLessThan(events.indexOf("ledger:terminal"));
        expect(events).not.toContain("release");
        expect(completed).toBe(0);
      }
    }
  });

  test("records both hosted costs and returns their known combined actual cost", async () => {
    const subject = runtime({ totalCosts: ["0.1", "0.2"] });
    const result = await subject.value.act(actor, input);
    expect(result).toMatchObject({ ok: true, receipt: { cost: { state: "actual", amountUsd: 0.30000000000000004 } } });
    expect(subject.calls.cost).toEqual([
      { operation: "hosted_action", total: "0.1" },
      { operation: "hosted_action_observation", total: "0.2" },
    ]);
  });

  test("returns unknown combined cost when either hosted cost is not actual", async () => {
    const subject = runtime({ totalCosts: ["0.1", null] });
    expect(await subject.value.act(actor, input)).toMatchObject({ ok: true, receipt: { cost: { state: "unknown", amountUsd: null } } });
    expect(subject.calls.cost).toEqual([
      { operation: "hosted_action", total: "0.1" },
      { operation: "hosted_action_observation", total: null },
    ]);
  });

  test("action result throw cancels and persists ambiguous rather than escaping", async () => {
    const subject = runtime({ throwGetAt: 1 });
    expect(await subject.value.act(actor, input)).toEqual({ ok: false, code: "ambiguous", recovery: "none" });
    expect(subject.calls.cancel).toBe(1);
    expect(subject.calls.finish).toEqual(["ambiguous"]);
  });

  test("malformed poll response cancels and persists ambiguous rather than treating it as terminal", async () => {
    const subject = runtime({ createStatus: "running", pollMalformed: true });
    expect(await subject.value.act(actor, input)).toEqual({ ok: false, code: "ambiguous", recovery: "none" });
    expect(subject.calls.cancel).toBe(1);
    expect(subject.calls.finish).toEqual(["ambiguous"]);
  });

  test("completed receipt persistence failure never returns observed success or releases the account fence", async () => {
    const subject = runtime({ finishCompletedThrows: true });
    expect(await subject.value.act(actor, input)).toEqual({ ok: false, code: "ambiguous", recovery: "none" });
    expect(subject.calls.complete).toBe(0);
    expect(subject.calls.finish).toEqual([]);
  });

  test("never reruns an exact delivery and conflicts a mismatched delivery", async () => {
    const completed = { id: "op-previous", ownerUserId: "user", accountId: account.id, deliveryId: input.deliveryId, requestDigest: "a".repeat(64), actionType: "save_item" as const, target: input.target, status: "completed" as const, opaqueRunRef: null, receipt: { executionRef: "op-previous", action: "save_item" as const, target: input.target, effectState: "observed" as const, postcondition, evidenceCode: "postcondition_observed", cost: { amountUsd: 0.12, state: "actual" as const } } };
    const replay = runtime({ claimed: { kind: "existing", operation: completed } });
    expect(await replay.value.act(actor, input)).toMatchObject({ ok: true, receipt: { executionRef: "op-previous" } });
    expect(replay.calls.create).toBe(0);
    const conflict = runtime({ claimed: { kind: "conflict" } });
    expect(await conflict.value.act(actor, input)).toEqual({ ok: false, code: "idempotency_conflict", recovery: "none" });
    expect(conflict.calls.create).toBe(0);
  });

  test("resumes the same parked delivery by observing before it decides to write", async () => {
    const parked = {
      id: "op-parked", ownerUserId: "user", accountId: account.id, deliveryId: input.deliveryId,
      requestDigest: parkedRequestDigest, actionType: "save_item" as const, target: input.target,
      status: "authentication_required" as const, opaqueRunRef: null,
      receipt: { executionRef: "op-parked", action: "save_item" as const, target: input.target,
        effectState: "authentication_required" as const, postcondition: null, evidenceCode: "authentication_required",
        cost: { amountUsd: null, state: "unknown" as const } },
    };
    const subject = runtime({ claimed: { kind: "existing", operation: parked }, providerResults: [
      JSON.stringify({ outcome: "postcondition", observed: true, postcondition, origin: account.origin }),
    ] });
    expect(await subject.value.resumeAfterAuthentication(actor, { deliveryId: input.deliveryId })).toMatchObject({
      ok: true, status: "completed", receipt: { executionRef: "op-parked", evidenceCode: "postcondition_observed_before_resume" },
    });
    expect(subject.calls.create).toBe(1);
    expect(subject.calls.budgets).toEqual([1 / 6]);
    expect(subject.calls.events).toEqual(["operation:run-1", "checkpoint:run-1"]);
  });

  test("resume writes only after a fresh negative observation, then independently verifies", async () => {
    const parked = {
      id: "op-parked", ownerUserId: "user", accountId: account.id, deliveryId: input.deliveryId,
      requestDigest: parkedRequestDigest, actionType: "save_item" as const, target: input.target,
      status: "authentication_required" as const, opaqueRunRef: null,
      receipt: { executionRef: "op-parked", action: "save_item" as const, target: input.target,
        effectState: "authentication_required" as const, postcondition: null, evidenceCode: "authentication_required",
        cost: { amountUsd: null, state: "unknown" as const } },
    };
    const subject = runtime({ claimed: { kind: "existing", operation: parked }, providerResults: [
      JSON.stringify({ outcome: "postcondition", observed: false, postcondition, origin: account.origin }),
      JSON.stringify({ outcome: "action_attempted", action: "save_item", target: input.target, origin: account.origin }),
      JSON.stringify({ outcome: "postcondition", observed: true, postcondition, origin: account.origin }),
    ] });
    expect(await subject.value.resumeAfterAuthentication(actor, { deliveryId: input.deliveryId })).toMatchObject({ ok: true, status: "completed" });
    expect(subject.calls.create).toBe(3);
    expect(subject.calls.budgets).toEqual([1 / 6, 1 / 6, 1 / 6]);
    expect(subject.calls.events).toEqual([
      "operation:run-1", "checkpoint:run-1", "browser-stop:run-1", "operation:run-2", "checkpoint:run-2", "browser-stop:run-2", "operation:run-3", "checkpoint:run-3",
    ]);
  });

  test("a resumed receipt includes every known cost already incurred by that delivery", async () => {
    const parked = {
      id: "op-parked", ownerUserId: "user", accountId: account.id, deliveryId: input.deliveryId,
      requestDigest: parkedRequestDigest, actionType: "save_item" as const, target: input.target,
      status: "authentication_required" as const, opaqueRunRef: null,
      receipt: { executionRef: "op-parked", action: "save_item" as const, target: input.target,
        effectState: "authentication_required" as const, postcondition: null, evidenceCode: "authentication_required",
        cost: { amountUsd: 0.2, state: "actual" as const } },
    };
    const subject = runtime({
      claimed: { kind: "existing", operation: parked },
      providerResults: [
        JSON.stringify({ outcome: "postcondition", observed: false, postcondition, origin: account.origin }),
        JSON.stringify({ outcome: "action_attempted", action: "save_item", target: input.target, origin: account.origin }),
        JSON.stringify({ outcome: "postcondition", observed: true, postcondition, origin: account.origin }),
      ],
      totalCosts: ["0.1", "0.2", "0.2"],
    });

    const result = await subject.value.resumeAfterAuthentication(actor, { deliveryId: input.deliveryId });
    expect(result).toMatchObject({ ok: true, receipt: { cost: { state: "actual" } } });
    if (result.ok) expect(result.receipt.cost.amountUsd).toBeCloseTo(0.7);
    expect(subject.calls.budgets).toEqual([0.8 / 3, 0.8 / 3, 0.8 / 3]);
  });

  test("resume never mints a fresh delivery budget", async () => {
    const parked = {
      id: "op-parked", ownerUserId: "user", accountId: account.id, deliveryId: input.deliveryId,
      requestDigest: parkedRequestDigest, actionType: "save_item" as const, target: input.target,
      status: "authentication_required" as const, opaqueRunRef: null,
      receipt: { executionRef: "op-parked", action: "save_item" as const, target: input.target,
        effectState: "authentication_required" as const, postcondition: null, evidenceCode: "authentication_required",
        cost: { amountUsd: 1, state: "actual" as const } },
    };
    const subject = runtime({ claimed: { kind: "existing", operation: parked } });

    expect(await subject.value.resumeAfterAuthentication(actor, { deliveryId: input.deliveryId })).toEqual({
      ok: false, code: "unavailable", recovery: "none",
    });
    expect(subject.calls.create).toBe(0);
  });

  test("cancelling a parked authentication delivery is terminal without provider work", async () => {
    const parked = {
      id: "op-parked", ownerUserId: "user", accountId: account.id, deliveryId: input.deliveryId,
      requestDigest: parkedRequestDigest, actionType: "save_item" as const, target: input.target,
      status: "authentication_required" as const, opaqueRunRef: null,
      receipt: { executionRef: "op-parked", action: "save_item" as const, target: input.target,
        effectState: "authentication_required" as const, postcondition: null, evidenceCode: "authentication_required",
        cost: { amountUsd: 0.25, state: "actual" as const } },
    };
    const subject = runtime({ claimed: { kind: "existing", operation: parked } });
    expect(await subject.value.cancelAuthentication(actor, { deliveryId: input.deliveryId })).toEqual({ ok: false, code: "cancelled", recovery: "none" });
    expect(subject.calls.create).toBe(0);
    expect(subject.calls.cancel).toBe(0);
    expect(subject.calls.authenticationCancellationReceipt).toMatchObject({ cost: { amountUsd: 0.25, state: "actual" } });
    expect(await subject.value.resumeAfterAuthentication(actor, { deliveryId: input.deliveryId })).toEqual({ ok: false, code: "cancelled", recovery: "none" });
  });

  test("a repeated unknown-cost auth challenge stays parked rather than minting another budget", async () => {
    const parked = {
      id: "op-parked", ownerUserId: "user", accountId: account.id, deliveryId: input.deliveryId,
      requestDigest: parkedRequestDigest, actionType: "save_item" as const, target: input.target,
      status: "authentication_required" as const, opaqueRunRef: null,
      receipt: { executionRef: "op-parked", action: "save_item" as const, target: input.target,
        effectState: "authentication_required" as const, postcondition: null, evidenceCode: "authentication_required",
        cost: { amountUsd: null, state: "unknown" as const } },
    };
    const subject = runtime({ claimed: { kind: "existing", operation: parked }, providerResults: [
      JSON.stringify({ outcome: "authentication_required", reason: "mfa" }),
    ] });
    expect(await subject.value.resumeAfterAuthentication(actor, { deliveryId: input.deliveryId })).toMatchObject({
      ok: false, code: "authentication_required", intervention: { reason: "mfa" },
    });
    expect(await subject.value.resumeAfterAuthentication(actor, { deliveryId: input.deliveryId })).toEqual({ ok: false, code: "unavailable", recovery: "none" });
    expect(subject.calls.create).toBe(1);
    expect(subject.calls.budgets).toEqual([1 / 6]);
  });

  test("replays each valid terminal receipt without a provider run and rejects malformed receipt JSON", async () => {
    const receipt = (effectState: "ambiguous" | "cancelled" | "failed" | "authentication_required") => ({ executionRef: "op-terminal", action: "save_item" as const, target: input.target, effectState, postcondition: null, evidenceCode: `terminal_${effectState}`, cost: { amountUsd: null, state: "unknown" as const } });
    for (const status of ["ambiguous", "cancelled", "failed", "authentication_required"] as const) {
      const replay = runtime({ claimed: { kind: "existing", operation: { id: "op-terminal", ownerUserId: "user", accountId: account.id, deliveryId: input.deliveryId, requestDigest: "a".repeat(64), actionType: "save_item", target: input.target, status, opaqueRunRef: null, receipt: receipt(status) } } });
      const result = await replay.value.act(actor, input);
      expect(replay.calls.create).toBe(0);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe(status === "authentication_required" ? "authentication_required" : status);
    }
    const malformed = runtime({ claimed: { kind: "existing", operation: { id: "op-bad", ownerUserId: "user", accountId: account.id, deliveryId: input.deliveryId, requestDigest: "a".repeat(64), actionType: "save_item", target: input.target, status: "completed", opaqueRunRef: null, receipt: { executionRef: "op-bad", action: "save_item", target: input.target, effectState: "observed", postcondition, evidenceCode: "postcondition_observed", cost: { amountUsd: 1, state: "actual", providerId: "must_not_escape" } } } } });
    expect(await malformed.value.act(actor, input)).toEqual({ ok: false, code: "invalid_result", recovery: "none" });
    expect(malformed.calls.create).toBe(0);
  });

  test("strict receipt parser rejects provider, live, and malformed nested fields", () => {
    const valid = { executionRef: "op", action: "save_item", target: "item", effectState: "observed", postcondition: "saved", evidenceCode: "observed", cost: { amountUsd: 0.1, state: "actual" } };
    expect(parseConnectedWebActionSafeReceipt(valid)).not.toBeNull();
    expect(parseConnectedWebActionSafeReceipt({ ...valid, providerId: "provider-run" })).toBeNull();
    expect(parseConnectedWebActionSafeReceipt({ ...valid, cost: { ...valid.cost, liveUrl: "https://must-not-leak" } })).toBeNull();
  });

  test("fails closed for unauthorized, revoked, busy, malformed, auth, and cancelled paths", async () => {
    expect(await runtime({ authorized: false }).value.act(actor, input)).toEqual({ ok: false, code: "unavailable", recovery: "none" });
    expect(await runtime({ status: "revoked" }).value.act(actor, input)).toMatchObject({
      ok: false, code: "authentication_required", recovery: "connect",
      intervention: { mode: "connect", reason: "not_connected", target: { selector: "Nebius" } },
    });
    expect(await runtime({ status: "busy" }).value.act(actor, input)).toEqual({ ok: false, code: "unavailable", recovery: "none" });
    const malformed = runtime({ providerResults: ["not-json"] });
    expect(await malformed.value.act(actor, input)).toEqual({ ok: false, code: "ambiguous", recovery: "none" });
    expect(await runtime({ providerResults: [JSON.stringify({ outcome: "authentication_required", reason: "mfa" })] }).value.act(actor, input)).toMatchObject({ ok: false, code: "authentication_required", intervention: { reason: "mfa" } });
    const cancelled = runtime({ terminalStatus: "cancelled" });
    // A terminal cancellation after the hosted action was created is a possible effect, never a safe retry.
    expect(await cancelled.value.act(actor, input)).toEqual({ ok: false, code: "ambiguous", recovery: "none" });
  });

  test("never offers a protected sign-in when the account checkpoint cannot enter attention state", async () => {
    const initial = runtime({
      providerResults: [JSON.stringify({ outcome: "authentication_required", reason: "mfa" })],
      failAttentionFinish: true,
    });
    expect(await initial.value.act(actor, input)).toEqual({ ok: false, code: "ambiguous", recovery: "none" });

    const parked = {
      id: "op-parked", ownerUserId: "user", accountId: account.id, deliveryId: input.deliveryId,
      requestDigest: parkedRequestDigest, actionType: "save_item" as const, target: input.target,
      status: "authentication_required" as const, opaqueRunRef: null,
      receipt: { executionRef: "op-parked", action: "save_item" as const, target: input.target,
        effectState: "authentication_required" as const, postcondition: null, evidenceCode: "authentication_required",
        cost: { amountUsd: 0.1, state: "actual" as const } },
    };
    const resumed = runtime({
      claimed: { kind: "existing", operation: parked },
      providerResults: [JSON.stringify({ outcome: "authentication_required", reason: "captcha" })],
      totalCosts: ["0.1"],
      failAttentionFinish: true,
    });
    expect(await resumed.value.resumeAfterAuthentication(actor, { deliveryId: input.deliveryId })).toEqual({
      ok: false, code: "ambiguous", recovery: "none",
    });
  });

  test("boot reconciliation never replays actions: reserving and running remain ambiguous", async () => {
    const finished: Array<{ operationId: string; status: string; receipt: unknown }> = [];
    const cancelled: string[] = [];
    const controller = new ConnectedWebAccountController({
      store: {
        listStaleExecutions: async () => [],
        listStaleActionOperations: async () => [
          { id: "op-reserving", ownerUserId: "user", accountId: account.id, deliveryId: "one", requestDigest: "a".repeat(64), actionType: "save_item", target: "one", status: "reserving", opaqueRunRef: null, receipt: null },
          { id: "op-running", ownerUserId: "user", accountId: account.id, deliveryId: "two", requestDigest: "b".repeat(64), actionType: "save_item", target: "two", status: "running", opaqueRunRef: "run-possible-effect", receipt: null },
        ],
        finishActionOperation: async (value: { operationId: string; status: string; receipt: unknown }) => { finished.push(value); },
      } as never,
      browser: { stopHostedReadBrowser: async () => true, cancelHostedReadRun: async (runId: string) => { cancelled.push(runId); return { runId, status: "cancelled" }; } } as never,
      navigator: {} as never,
    });
    await controller.reconcileStaleExecutions();
    expect(cancelled).toEqual(["run-possible-effect"]);
    expect(finished).toMatchObject([
      { operationId: "op-reserving", status: "ambiguous", receipt: { executionRef: "op-reserving", effectState: "ambiguous", evidenceCode: "restart_before_provider_reference" } },
      { operationId: "op-running", status: "ambiguous", receipt: { executionRef: "op-running", effectState: "ambiguous", evidenceCode: "restart_possible_effect" } },
    ]);
  });

  test("boot keeps an action checkpoint and ledger ref when cancel reports running", async () => {
    let completed = 0;
    let finished = 0;
    let cancellations = 0;
    const controller = new ConnectedWebAccountController({
      store: {
        listStaleExecutions: async () => [{ accountId: account.id, ownerUserId: "user", checkpoint: { resource: "action", phase: "active", reservationToken: "reservation", opaqueExecutionRef: "run-live", recordedAt: "2026-01-01T00:00:00.000Z" } }],
        completeExecution: async () => { completed++; return account; },
        listStaleActionOperations: async () => [{ id: "op-live", ownerUserId: "user", accountId: account.id, deliveryId: "delivery", requestDigest: "a".repeat(64), actionType: "save_item" as const, target: input.target, status: "running" as const, opaqueRunRef: "run-live", receipt: null }],
        finishActionOperation: async () => { finished++; },
      } as never,
      browser: { cancelHostedReadRun: async () => { cancellations++; return { runId: "run-live", status: "running" }; } } as never,
      navigator: {} as never,
    });
    await controller.reconcileStaleExecutions();
    expect(completed).toBe(0);
    expect(finished).toBe(0);
    expect(cancellations).toBe(1);
  });

  test("boot keeps an action checkpoint and ledger ref when cancellation throws", async () => {
    let completed = 0;
    let finished = 0;
    let cancellations = 0;
    const controller = new ConnectedWebAccountController({
      store: {
        listStaleExecutions: async () => [{ accountId: account.id, ownerUserId: "user", checkpoint: { resource: "action", phase: "active", reservationToken: "reservation", opaqueExecutionRef: "run-live", recordedAt: "2026-01-01T00:00:00.000Z" } }],
        completeExecution: async () => { completed++; return account; },
        listStaleActionOperations: async () => [{ id: "op-live", ownerUserId: "user", accountId: account.id, deliveryId: "delivery", requestDigest: "a".repeat(64), actionType: "save_item" as const, target: input.target, status: "running" as const, opaqueRunRef: "run-live", receipt: null }],
        finishActionOperation: async () => { finished++; },
      } as never,
      browser: { cancelHostedReadRun: async () => { cancellations++; throw new Error("transport_lost"); } } as never,
      navigator: {} as never,
    });
    await controller.reconcileStaleExecutions();
    expect(completed).toBe(0);
    expect(finished).toBe(0);
    expect(cancellations).toBe(1);
  });

  test("boot cancels an active action exactly once before releasing its account and ledger", async () => {
    let completed = 0;
    let finished = 0;
    let cancellations = 0;
    const controller = new ConnectedWebAccountController({
      store: {
        listStaleExecutions: async () => [{ accountId: account.id, ownerUserId: "user", checkpoint: { resource: "action", phase: "active", reservationToken: "reservation", opaqueExecutionRef: "run-live", recordedAt: "2026-01-01T00:00:00.000Z" } }],
        completeExecution: async () => { completed++; return account; },
        listStaleActionOperations: async () => [{ id: "op-live", ownerUserId: "user", accountId: account.id, deliveryId: "delivery", requestDigest: "a".repeat(64), actionType: "save_item" as const, target: input.target, status: "running" as const, opaqueRunRef: "run-live", receipt: null }],
        finishActionOperation: async () => { finished++; },
      } as never,
      browser: { stopHostedReadBrowser: async () => true, cancelHostedReadRun: async () => { cancellations++; return { runId: "run-live", status: "cancelled" }; } } as never,
      navigator: {} as never,
    });
    await controller.reconcileStaleExecutions();
    expect(cancellations).toBe(1);
    expect(completed).toBe(1);
    expect(finished).toBe(1);
  });

  test("owner can revoke an action reservation with no provider reference instead of permanent busy", async () => {
    let revoked = 0;
    const controller = new ConnectedWebAccountController({
      store: {
        getBindingForOwner: async () => ({ accountId: account.id, ownerUserId: "user", service: account.service, origin: account.origin, status: "busy", profileRef: "profile", executionCheckpoint: { resource: "action", phase: "reserving", reservationToken: "reservation", recordedAt: "2026-01-01T00:00:00.000Z" } }),
        revokeForOwner: async () => { revoked++; return { ...account, status: "revoked" as const }; },
      } as never,
      browser: {} as never,
      navigator: {} as never,
    });
    expect(await controller.disconnect({ ownerUserId: "user", accountId: account.id })).toMatchObject({ status: "revoked" });
    expect(revoked).toBe(1);
  });

  test("disconnect refuses a still-running active action before profile deletion or revocation", async () => {
    let revoked = 0;
    let deleted = 0;
    const controller = new ConnectedWebAccountController({
      store: {
        getBindingForOwner: async () => ({ accountId: account.id, ownerUserId: "user", service: account.service, origin: account.origin, status: "busy", profileRef: "profile", executionCheckpoint: { resource: "action", phase: "active", reservationToken: "reservation", opaqueExecutionRef: "run-live", recordedAt: "2026-01-01T00:00:00.000Z" } }),
        revokeForOwner: async () => { revoked++; return { ...account, status: "revoked" as const }; },
      } as never,
      browser: { cancelHostedReadRun: async () => ({ runId: "run-live", status: "running" }), deleteProfile: async () => { deleted++; return { kind: "failure", code: "resource_not_found" }; } } as never,
      navigator: {} as never,
    });
    let failure: unknown = null;
    try { await controller.disconnect({ ownerUserId: "user", accountId: account.id }); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ kind: "provider_unavailable" });
    expect(deleted).toBe(0);
    expect(revoked).toBe(0);
  });
});
