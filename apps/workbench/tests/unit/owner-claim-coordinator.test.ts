import { describe, expect, test } from "bun:test";
import {
  createOwnerClaimCoordinator,
  type OwnerClaimCoordinatorTraceEvent,
  type OwnerClaimEffectAdapter,
  type OwnerClaimEffectOutcome,
  type OwnerClaimEffectRequest,
} from "../../src/lib/owner-claim-coordinator";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function requestAt(
  requests: readonly OwnerClaimEffectRequest[],
  commandKind: OwnerClaimEffectRequest["command"]["kind"],
): OwnerClaimEffectRequest {
  const request = requests.find((candidate) => candidate.command.kind === commandKind);
  if (request === undefined) throw new Error(`Missing ${commandKind} request.`);
  return request;
}

describe("D508 owner-claim coordinator", () => {
  test("aborts and rejects a delayed stale preview after auth changes", async () => {
    const pending = deferred<OwnerClaimEffectOutcome>();
    const requests: OwnerClaimEffectRequest[] = [];
    const trace: OwnerClaimCoordinatorTraceEvent[] = [];
    const effects: OwnerClaimEffectAdapter = {
      execute(request) {
        requests.push(request);
        return pending.promise;
      },
    };
    const coordinator = createOwnerClaimCoordinator({ effects, eventSink: (event) => trace.push(event) });

    coordinator.dispatch({ type: "checkpoint", checkpoint: "preview" });
    expect(coordinator.getState().phase).toBe("waiting-auth");
    coordinator.dispatch({ type: "auth", auth: "signed-out" });
    expect(coordinator.getState().phase).toBe("previewing");
    const preview = requestAt(requests, "preview-claim");

    coordinator.dispatch({ type: "auth", auth: "unknown" });
    expect(preview.signal.aborted).toBe(true);
    expect(coordinator.getState()).toMatchObject({ phase: "waiting-auth", auth: "unknown" });

    pending.resolve({ commandKind: "preview-claim", result: "resolved", continuation: "resume-owner" });
    await settle();
    expect(coordinator.getState()).toMatchObject({ phase: "waiting-auth", continuation: null });
    expect(trace.map((event) => event.result)).toEqual(["started", "aborted", "stale"]);
  });

  test("disposal aborts effects and late results cannot mutate the last state", async () => {
    const pending = deferred<OwnerClaimEffectOutcome>();
    const requests: OwnerClaimEffectRequest[] = [];
    const trace: OwnerClaimCoordinatorTraceEvent[] = [];
    const coordinator = createOwnerClaimCoordinator({
      effects: { execute: (request) => {
        requests.push(request);
        return pending.promise;
      } },
      eventSink: (event) => trace.push(event),
    });

    coordinator.dispatch({ type: "checkpoint", checkpoint: "preview" });
    coordinator.dispatch({ type: "auth", auth: "signed-out" });
    const beforeDispose = coordinator.getState();
    coordinator.dispose();
    expect(requestAt(requests, "preview-claim").signal.aborted).toBe(true);
    pending.resolve({ commandKind: "preview-claim", result: "resolved" });
    await settle();
    expect(coordinator.getState()).toBe(beforeDispose);
    expect(trace.map((event) => event.result)).toEqual(["started", "aborted", "stale"]);
  });

  test("invalidates active work for both route changes and replacement checkpoints", () => {
    for (const invalidation of ["route", "checkpoint"] as const) {
      const pending = deferred<OwnerClaimEffectOutcome>();
      const requests: OwnerClaimEffectRequest[] = [];
      const coordinator = createOwnerClaimCoordinator({
        effects: { execute: (request) => {
          requests.push(request);
          return pending.promise;
        } },
      });
      coordinator.dispatch({ type: "checkpoint", checkpoint: "preview" });
      coordinator.dispatch({ type: "auth", auth: "signed-out" });
      const preview = requestAt(requests, "preview-claim");
      if (invalidation === "route") coordinator.invalidate("route");
      else coordinator.dispatch({ type: "checkpoint", checkpoint: "preview" });
      expect(preview.signal.aborted).toBe(true);
      coordinator.dispose();
    }
  });

  test("permits one logical mutation, aborts it on auth change, and refuses its stale completion", async () => {
    const binds: Deferred<OwnerClaimEffectOutcome>[] = [];
    const requests: OwnerClaimEffectRequest[] = [];
    let active = 0;
    let maximumActive = 0;
    const coordinator = createOwnerClaimCoordinator({
      effects: {
        execute(request) {
          requests.push(request);
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          const bind = deferred<OwnerClaimEffectOutcome>();
          binds.push(bind);
          return bind.promise.finally(() => { active -= 1; });
        },
      },
    });

    coordinator.dispatch({ type: "checkpoint", checkpoint: "awaiting-bind" });
    coordinator.dispatch({ type: "auth", auth: "signed-in" });
    coordinator.dispatch({ type: "auth", auth: "signed-in" });
    expect(requests.filter((request) => request.command.kind === "bind-subject")).toHaveLength(1);
    expect(maximumActive).toBe(1);

    const bindRequest = requestAt(requests, "bind-subject");
    coordinator.dispatch({ type: "auth", auth: "signed-out" });
    expect(bindRequest.signal.aborted).toBe(true);
    expect(coordinator.getState()).toMatchObject({ phase: "awaiting-callback", auth: "signed-out" });
    // A fresh signed-in observation wants another bind, but the first unknown
    // write is still physically pending. The coordinator must wait for its
    // settlement instead of overlapping mutations just because abort was sent.
    coordinator.dispatch({ type: "auth", auth: "signed-in" });
    expect(requests.filter((request) => request.command.kind === "bind-subject")).toHaveLength(1);
    binds[0]?.resolve({ commandKind: "bind-subject", result: "resolved" });
    await settle();
    expect(requests.filter((request) => request.command.kind === "bind-subject")).toHaveLength(2);
    expect(maximumActive).toBe(1);
    binds[1]?.resolve({ commandKind: "bind-subject", result: "resolved" });
    await settle();
    expect(coordinator.getState().phase).toBe("profile");
  });

  test("maps a failed sign-out to explicit same-phase recovery without an automatic retry", async () => {
    const trace: OwnerClaimCoordinatorTraceEvent[] = [];
    const coordinator = createOwnerClaimCoordinator({
      effects: { execute: async (request) => request.command.kind === "preview-claim"
        ? { commandKind: "preview-claim", result: "resolved" }
        : { commandKind: "sign-out", result: "failed" } },
      eventSink: (event) => trace.push(event),
    });

    coordinator.dispatch({ type: "checkpoint", checkpoint: "preview" });
    coordinator.dispatch({ type: "auth", auth: "signed-out" });
    await settle();
    coordinator.dispatch({ type: "auth", auth: "signed-in" });
    coordinator.dispatch({ type: "switch-account" });
    await settle();
    expect(coordinator.getState()).toMatchObject({
      phase: "recoverable",
      recoverableReason: "authentication-failed",
      retryTarget: "new-owner",
    });
    expect(trace.filter((event) => event.commandKind === "sign-out")).toMatchObject([
      { commandKind: "sign-out", result: "started" },
      { commandKind: "sign-out", result: "failed" },
    ]);
  });

  test("keeps the expected Logto signing-in observation attached to its active launch", async () => {
    const launch = deferred<OwnerClaimEffectOutcome>();
    const requests: OwnerClaimEffectRequest[] = [];
    const trace: OwnerClaimCoordinatorTraceEvent[] = [];
    const coordinator = createOwnerClaimCoordinator({
      effects: {
        execute(request) {
          requests.push(request);
          if (request.command.kind === "preview-claim") {
            return Promise.resolve({ commandKind: "preview-claim", result: "resolved", continuation: "new-owner" });
          }
          if (request.command.kind === "prepare-signup") {
            return Promise.resolve({ commandKind: "prepare-signup", result: "prepared" });
          }
          if (request.command.kind === "launch-logto-signup") return launch.promise;
          throw new Error(`Unexpected command: ${request.command.kind}`);
        },
      },
      eventSink: (event) => trace.push(event),
    });

    coordinator.dispatch({ type: "checkpoint", checkpoint: "preview" });
    coordinator.dispatch({ type: "auth", auth: "signed-out" });
    await settle();
    coordinator.dispatch({ type: "begin-signup" });
    await settle();
    const request = requestAt(requests, "launch-logto-signup");
    expect(coordinator.getState()).toMatchObject({ phase: "awaiting-callback", auth: "signed-out" });

    coordinator.dispatch({ type: "auth", auth: "signing-in" });
    expect(request.signal.aborted).toBe(false);
    expect(coordinator.getState()).toMatchObject({ phase: "awaiting-callback", auth: "signing-in" });

    launch.reject(new Error("Logto launch rejected"));
    await settle();
    expect(coordinator.getState()).toMatchObject({
      phase: "recoverable",
      recoverableReason: "authentication-failed",
      retryTarget: "resume-owner",
    });
    expect(trace.filter((event) => event.commandKind === "launch-logto-signup").map((event) => event.result))
      .toEqual(["started", "failed"]);
  });

  test("serializes signed-in resume as preview, prepare, then direct bind with no Logto launch", async () => {
    const requests: OwnerClaimEffectRequest[] = [];
    const coordinator = createOwnerClaimCoordinator({
      effects: {
        execute(request) {
          requests.push(request);
          switch (request.command.kind) {
            case "preview-claim":
              return Promise.resolve({ commandKind: "preview-claim", result: "resolved", continuation: "resume-owner" });
            case "prepare-resume":
              return Promise.resolve({ commandKind: "prepare-resume", result: "prepared" });
            case "bind-subject":
              return Promise.resolve({ commandKind: "bind-subject", result: "resolved" });
            default:
              throw new Error(`Unexpected command: ${request.command.kind}`);
          }
        },
      },
    });

    coordinator.dispatch({ type: "checkpoint", checkpoint: "preview" });
    coordinator.dispatch({ type: "auth", auth: "signed-in" });
    await settle();

    expect(requests.map((request) => request.command.kind)).toEqual([
      "preview-claim",
      "prepare-resume",
      "bind-subject",
    ]);
    expect(coordinator.getState()).toMatchObject({ phase: "profile", auth: "signed-in" });
  });

  test("still invalidates an active Logto launch for every unrelated auth change", async () => {
    const launch = deferred<OwnerClaimEffectOutcome>();
    const requests: OwnerClaimEffectRequest[] = [];
    const coordinator = createOwnerClaimCoordinator({
      effects: {
        execute(request) {
          requests.push(request);
          if (request.command.kind === "preview-claim") {
            return Promise.resolve({ commandKind: "preview-claim", result: "resolved", continuation: "resume-owner" });
          }
          if (request.command.kind === "prepare-resume") {
            return Promise.resolve({ commandKind: "prepare-resume", result: "prepared" });
          }
          if (request.command.kind === "launch-logto-signin") return launch.promise;
          throw new Error(`Unexpected command: ${request.command.kind}`);
        },
      },
    });

    coordinator.dispatch({ type: "checkpoint", checkpoint: "preview" });
    coordinator.dispatch({ type: "auth", auth: "signed-out" });
    await settle();
    coordinator.dispatch({ type: "begin-resume" });
    await settle();
    const request = requestAt(requests, "launch-logto-signin");

    coordinator.dispatch({ type: "auth", auth: "unknown" });
    expect(request.signal.aborted).toBe(true);
    expect(coordinator.getState()).toMatchObject({ phase: "awaiting-callback", auth: "unknown" });
    launch.resolve({ commandKind: "launch-logto-signin", result: "launched" });
    await settle();
    expect(coordinator.getState()).toMatchObject({ phase: "awaiting-callback", auth: "unknown" });
  });

  test("turns an unsupported adapter result into a typed recoverable machine event", async () => {
    const trace: OwnerClaimCoordinatorTraceEvent[] = [];
    const coordinator = createOwnerClaimCoordinator({
      effects: { execute: async () => ({ commandKind: "bind-subject", result: "resolved" }) },
      eventSink: (event) => trace.push(event),
    });
    coordinator.dispatch({ type: "checkpoint", checkpoint: "preview" });
    coordinator.dispatch({ type: "auth", auth: "signed-out" });
    await settle();
    expect(coordinator.getState()).toMatchObject({
      phase: "recoverable",
      recoverableReason: "preview-failed",
      retryTarget: "preview",
    });
    expect(trace).toContainEqual(expect.objectContaining({
      commandKind: "preview-claim",
      result: "unsupported",
    }));
  });

  test("keeps qualification events structurally redacted and keeps environment ownership injected", async () => {
    const trace: OwnerClaimCoordinatorTraceEvent[] = [];
    const coordinator = createOwnerClaimCoordinator({
      effects: { execute: async () => ({ commandKind: "preview-claim", result: "unavailable" }) },
      eventSink: (event) => trace.push(event),
    });
    coordinator.dispatch({ type: "checkpoint", checkpoint: "preview" });
    coordinator.dispatch({ type: "auth", auth: "signed-out" });
    await settle();

    expect(Object.keys(trace[0] ?? {}).sort()).toEqual([
      "commandKind",
      "navigationIntent",
      "operationId",
      "phase",
      "result",
    ]);
    // Command names are controlled enum labels; only their associated
    // authority values must be impossible to emit. Representative raw values
    // cannot appear because the trace shape has no value-bearing field.
    expect(JSON.stringify(trace)).not.toContain("test-raw-capability-value");
    expect(JSON.stringify(trace)).not.toContain("test-prepared-state-value");

    const source = await Bun.file(new URL("../../src/lib/owner-claim-coordinator.ts", import.meta.url)).text();
    expect(source).toMatch(/from "\.\/owner-claim-machine"/);
    expect(source).not.toMatch(/from\s+["'][^"']*(?:react|api-client|use-auth|owner-claim-handoff)/);
    expect(source).not.toMatch(/\b(?:window|document|localStorage|sessionStorage|fetch|setTimeout|setInterval)\s*[.(]/);
  });
});
