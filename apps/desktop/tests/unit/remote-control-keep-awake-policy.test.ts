import { describe, expect, test } from "bun:test";
import {
  KeepAwakeLeasePolicy,
  evaluateMacPowerPosture,
  evaluateMacRemoteReachability,
  type KeepAwakeAdapter,
  type KeepAwakeConditions,
} from "../../electron/remote-control/keep-awake-policy";

function conditions(
  overrides: Partial<KeepAwakeConditions> = {},
): KeepAwakeConditions {
  return {
    policy: "while_remote_enabled_and_on_external_power",
    remoteEnabled: true,
    onExternalPower: true,
    signedIn: true,
    hostRevoked: false,
    appShuttingDown: false,
    ...overrides,
  };
}

function harness(): {
  policy: KeepAwakeLeasePolicy;
  starts: number[];
  stops: number[];
} {
  const starts: number[] = [];
  const stops: number[] = [];
  let nextId = 40;
  const adapter: KeepAwakeAdapter = {
    start() {
      starts.push(nextId);
      return nextId++;
    },
    stop(blockerId) {
      stops.push(blockerId);
    },
  };
  return { policy: new KeepAwakeLeasePolicy(adapter), starts, stops };
}

describe("scoped desktop keep-awake lease", () => {
  test("off never starts a blocker", () => {
    const { policy, starts } = harness();
    expect(policy.reconcile(conditions({ policy: "off" }))).toMatchObject({
      active: false,
      lastReleaseReason: "policy_off",
    });
    expect(starts).toEqual([]);
  });

  test("external-power policy starts exactly once while eligible", () => {
    const { policy, starts } = harness();
    expect(policy.reconcile(conditions())).toMatchObject({
      active: true,
      blockerId: 40,
      reason: "remote_enabled_on_external_power",
    });
    expect(policy.reconcile(conditions())).toMatchObject({ active: true, blockerId: 40 });
    expect(starts).toEqual([40]);
  });

  test.each([
    ["policy off", { policy: "off" }, "policy_off"],
    ["Remote disabled", { remoteEnabled: false }, "remote_disabled"],
    ["external power lost", { onExternalPower: false }, "external_power_lost"],
    ["sign-out", { signedIn: false }, "signed_out"],
    ["host revoke", { hostRevoked: true }, "host_revoked"],
    ["app shutdown", { appShuttingDown: true }, "app_shutdown"],
  ] as const)("%s releases an active lease", (_label, patch, releaseReason) => {
    const { policy, stops } = harness();
    policy.reconcile(conditions());
    expect(
      policy.reconcile(conditions(patch as Partial<KeepAwakeConditions>)),
    ).toMatchObject({
      active: false,
      blockerId: null,
      lastReleaseReason: releaseReason,
    });
    expect(stops).toEqual([40]);
  });

  test("an injected start failure is visible and leaves no fabricated active lease", () => {
    const policy = new KeepAwakeLeasePolicy({
      start() {
        throw new Error("native blocker unavailable");
      },
      stop() {
        throw new Error("must not stop");
      },
    });
    expect(policy.reconcile(conditions())).toEqual({
      active: false,
      blockerId: null,
      reason: null,
      lastReleaseReason: null,
      error: "start_failed",
    });
  });

  test("an injected stop failure retains the blocker ID for deterministic retry", () => {
    let failStop = true;
    const stops: number[] = [];
    const policy = new KeepAwakeLeasePolicy({
      start: () => 9,
      stop(blockerId) {
        stops.push(blockerId);
        if (failStop) throw new Error("injected stop failure");
      },
    });
    policy.reconcile(conditions());
    expect(policy.reconcile(conditions({ remoteEnabled: false }))).toMatchObject({
      active: true,
      blockerId: 9,
      error: "stop_failed",
    });
    failStop = false;
    expect(policy.reconcile(conditions({ remoteEnabled: false }))).toMatchObject({
      active: false,
      blockerId: null,
      error: null,
    });
    expect(stops).toEqual([9, 9]);
  });
});

describe("truthful Mac reachability projection", () => {
  test("lid-open is a supported posture independent of blocker policy", () => {
    expect(
      evaluateMacPowerPosture({
        lid: "open",
        onExternalPower: false,
        externalDisplayConnected: false,
      }),
    ).toEqual({ supported: true, reason: "supported" });
  });

  test("lid-open live reachability comes from awake, unlocked, relay observations", () => {
    expect(
      evaluateMacRemoteReachability({
        lid: "open",
        onExternalPower: false,
        externalDisplayConnected: false,
        awake: true,
        unlocked: true,
        relayLive: true,
      }),
    ).toEqual({ ready: true, reason: "ready" });
    expect(
      evaluateMacRemoteReachability({
        lid: "open",
        onExternalPower: false,
        externalDisplayConnected: false,
        awake: false,
        unlocked: true,
        relayLive: true,
      }),
    ).toEqual({ ready: false, reason: "asleep" });
  });

  test("battery-only lid-closed hosting is never shown as supported", () => {
    expect(
      evaluateMacRemoteReachability({
        lid: "closed",
        onExternalPower: false,
        externalDisplayConnected: true,
        awake: true,
        unlocked: true,
        relayLive: true,
      }),
    ).toEqual({
      ready: false,
      reason: "lid_closed_requires_external_power",
    });
  });

  test("lid-closed hosting requires both external power and an external display", () => {
    expect(
      evaluateMacRemoteReachability({
        lid: "closed",
        onExternalPower: true,
        externalDisplayConnected: false,
        awake: true,
        unlocked: true,
        relayLive: true,
      }),
    ).toEqual({
      ready: false,
      reason: "lid_closed_requires_external_display",
    });
    expect(
      evaluateMacRemoteReachability({
        lid: "closed",
        onExternalPower: true,
        externalDisplayConnected: true,
        awake: true,
        unlocked: true,
        relayLive: true,
      }),
    ).toEqual({ ready: true, reason: "ready" });
  });

  test("unknown lid state fails closed", () => {
    expect(
      evaluateMacRemoteReachability({
        lid: "unknown",
        onExternalPower: true,
        externalDisplayConnected: true,
        awake: true,
        unlocked: true,
        relayLive: true,
      }),
    ).toEqual({ ready: false, reason: "lid_state_unknown" });
  });

  test.each([
    ["locked", { awake: true, unlocked: false, relayLive: true }, "locked"],
    ["relay offline", { awake: true, unlocked: true, relayLive: false }, "relay_offline"],
  ] as const)("%s is not positively reachable", (_label, live, reason) => {
    expect(
      evaluateMacRemoteReachability({
        lid: "open",
        onExternalPower: true,
        externalDisplayConnected: false,
        ...live,
      }),
    ).toEqual({ ready: false, reason });
  });
});
