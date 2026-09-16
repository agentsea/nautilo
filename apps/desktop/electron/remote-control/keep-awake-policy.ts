export type KeepAwakePolicy =
  | "off"
  | "while_remote_enabled_and_on_external_power";

export type KeepAwakeReleaseReason =
  | "policy_off"
  | "remote_disabled"
  | "external_power_lost"
  | "signed_out"
  | "host_revoked"
  | "app_shutdown";

export interface KeepAwakeConditions {
  policy: KeepAwakePolicy;
  remoteEnabled: boolean;
  onExternalPower: boolean;
  signedIn: boolean;
  hostRevoked: boolean;
  appShuttingDown: boolean;
}

export interface KeepAwakeAdapter {
  start(): number;
  stop(blockerId: number): void;
}

export interface KeepAwakeState {
  active: boolean;
  blockerId: number | null;
  reason: "remote_enabled_on_external_power" | null;
  lastReleaseReason: KeepAwakeReleaseReason | null;
  error: "start_failed" | "stop_failed" | null;
}

export class KeepAwakeLeasePolicy {
  private readonly adapter: KeepAwakeAdapter;
  private current: KeepAwakeState = {
    active: false,
    blockerId: null,
    reason: null,
    lastReleaseReason: null,
    error: null,
  };

  constructor(adapter: KeepAwakeAdapter) {
    this.adapter = adapter;
  }

  state(): Readonly<KeepAwakeState> {
    return { ...this.current };
  }

  reconcile(conditions: KeepAwakeConditions): Readonly<KeepAwakeState> {
    const desired = desiredLease(conditions);
    if (desired.active) {
      if (this.current.active) {
        this.current = { ...this.current, reason: desired.reason, error: null };
        return this.state();
      }
      try {
        const blockerId = this.adapter.start();
        if (!Number.isSafeInteger(blockerId) || blockerId < 0) {
          throw new Error("invalid blocker id");
        }
        this.current = {
          active: true,
          blockerId,
          reason: desired.reason,
          lastReleaseReason: this.current.lastReleaseReason,
          error: null,
        };
      } catch {
        this.current = {
          active: false,
          blockerId: null,
          reason: null,
          lastReleaseReason: this.current.lastReleaseReason,
          error: "start_failed",
        };
      }
      return this.state();
    }

    if (!this.current.active || this.current.blockerId === null) {
      this.current = {
        ...this.current,
        active: false,
        blockerId: null,
        reason: null,
        lastReleaseReason: desired.releaseReason,
      };
      return this.state();
    }

    try {
      this.adapter.stop(this.current.blockerId);
      this.current = {
        active: false,
        blockerId: null,
        reason: null,
        lastReleaseReason: desired.releaseReason,
        error: null,
      };
    } catch {
      // Retain the blocker identity so a later reconciliation can retry.
      this.current = {
        ...this.current,
        lastReleaseReason: desired.releaseReason,
        error: "stop_failed",
      };
    }
    return this.state();
  }
}

function desiredLease(
  input: KeepAwakeConditions,
):
  | {
      active: true;
      reason: "remote_enabled_on_external_power";
    }
  | { active: false; releaseReason: KeepAwakeReleaseReason } {
  if (input.appShuttingDown) return { active: false, releaseReason: "app_shutdown" };
  if (input.hostRevoked) return { active: false, releaseReason: "host_revoked" };
  if (!input.signedIn) return { active: false, releaseReason: "signed_out" };
  if (!input.remoteEnabled) return { active: false, releaseReason: "remote_disabled" };
  if (input.policy === "off") return { active: false, releaseReason: "policy_off" };
  return input.onExternalPower
    ? { active: true, reason: "remote_enabled_on_external_power" }
    : { active: false, releaseReason: "external_power_lost" };
}

export interface MacPowerPostureInput {
  lid: "open" | "closed" | "unknown";
  onExternalPower: boolean;
  externalDisplayConnected: boolean;
}

export type MacPowerPosture =
  | { supported: true; reason: "supported" }
  | {
      supported: false;
      reason:
        | "lid_state_unknown"
        | "lid_closed_requires_external_power"
        | "lid_closed_requires_external_display";
    };

export function evaluateMacPowerPosture(input: MacPowerPostureInput): MacPowerPosture {
  if (input.lid === "unknown") {
    return { supported: false, reason: "lid_state_unknown" };
  }
  if (input.lid === "closed" && !input.onExternalPower) {
    return { supported: false, reason: "lid_closed_requires_external_power" };
  }
  if (input.lid === "closed" && !input.externalDisplayConnected) {
    return { supported: false, reason: "lid_closed_requires_external_display" };
  }
  return { supported: true, reason: "supported" };
}

export interface MacRemoteReachabilityInput extends MacPowerPostureInput {
  /** Authoritative live observations, not desired policy or stored settings. */
  awake: boolean;
  unlocked: boolean;
  relayLive: boolean;
}

export interface MacRemoteReachability {
  ready: boolean;
  reason:
    | Exclude<MacPowerPosture["reason"], "supported">
    | "asleep"
    | "locked"
    | "relay_offline"
    | "ready";
}

export function evaluateMacRemoteReachability(
  input: MacRemoteReachabilityInput,
): MacRemoteReachability {
  const posture = evaluateMacPowerPosture(input);
  if (!posture.supported) return { ready: false, reason: posture.reason };
  if (!input.awake) return { ready: false, reason: "asleep" };
  if (!input.unlocked) return { ready: false, reason: "locked" };
  if (!input.relayLive) {
    return { ready: false, reason: "relay_offline" };
  }
  return { ready: true, reason: "ready" };
}
