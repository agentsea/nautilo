/** One-shot D557 reconciliation over the existing feature owners. */

import {
  READY_TO_WORK_COMPONENT_IDS,
  readyToWorkAggregateStatus,
  type ReadyToWorkAggregateStatus,
  type ReadyToWorkComponentId,
  type ReadyToWorkComponentStatus,
  type ReadyToWorkDesiredState,
  type ReadyToWorkReason,
} from "./ready-to-work-contract";

type OwnerResult = Omit<ReadyToWorkComponentStatus, "id">;
type ReconcileTrigger = "startup" | "relay_reconnect" | "explicit_restore";

export interface ReadyToWorkCoordinatorOwners {
  restoreRendererOwners(input: Readonly<{
    voice: boolean | null;
    autoApprove: boolean | null;
  }>): Promise<Readonly<{ voice: OwnerResult; autoApprove: OwnerResult }>>;
  restoreWorkstation(desired: ReadyToWorkDesiredState): Promise<OwnerResult>;
  observeComputerUse(desired: ReadyToWorkDesiredState): Promise<OwnerResult>;
  restoreCodingConnection(
    desired: ReadyToWorkDesiredState,
    isCurrent: () => boolean | Promise<boolean>,
  ): Promise<OwnerResult>;
  disableRendererOwners(selection: ReadyToWorkDesiredState["components"]): Promise<void>;
  disableWorkstation(): Promise<void>;
  disableComputerUse(): Promise<void>;
  disableCodingConnection(): Promise<void>;
}

/** Serializes only D557 mutations/reconciliation; renderer acknowledgements bypass it. */
export class ReadyToWorkOperationQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function readyToWorkBoundedValue<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => finish(fallback), timeoutMs);
    void promise.then(finish, () => finish(fallback));
  });
}

/** Commits restart intent only while the exact reconciliation is still current. */
export async function commitReadyOwnerEnable(input: Readonly<{
  isCurrent: () => boolean | Promise<boolean>;
  persistEnabled: () => void;
  disable: () => Promise<void>;
}>): Promise<boolean> {
  if (!await input.isCurrent()) {
    await input.disable().catch(() => undefined);
    return false;
  }
  input.persistEnabled();
  return true;
}

/** A freshly minted D516 receipt survives only if its provider is still live. */
export async function commitReadyComputerUseEnable(input: Readonly<{
  providerReady: () => boolean | Promise<boolean>;
  disable: () => Promise<void>;
}>): Promise<boolean> {
  let ready = false;
  try {
    ready = await input.providerReady();
  } catch {
    ready = false;
  }
  if (ready) return true;
  // Do not swallow a failed canonical revoke: enrollment must not report a
  // harmless partial result when a just-minted receipt could remain live.
  await input.disable();
  return false;
}

const repairTarget = {
  voice: "voice_settings",
  auto_approve: "auto_approve_settings",
  workstation: "workstation_settings",
  computer_use: "computer_use_settings",
  coding_connection: "coding_connection_settings",
} as const;

export function readyToWorkWorkstationFailureReason(code: string): ReadyToWorkReason {
  if (code === "stale_revision" || code === "profile_not_found") {
    return "workstation_profile_update_needed";
  }
  if (code === "invalid_pin") return "startup_receipt_invalid";
  if (code === "capability_missing") return "workstation_capability_missing";
  if (["no_relay", "no_server", "no_user", "relay_binding_unavailable", "server_activation_failed"]
    .includes(code)) return "workstation_relay_unavailable";
  return "owner_rejected";
}

export function readyToWorkComputerUseFailureReason(input: Readonly<{
  accessibilityGranted: boolean;
  screenRecordingGranted: boolean;
  state: "unavailable" | "not-enabled" | "enabled";
  providerReady: boolean;
}>): ReadyToWorkReason | null {
  if (!input.accessibilityGranted) return "computer_use_accessibility_required";
  if (!input.screenRecordingGranted) return "computer_use_screen_recording_required";
  if (!input.providerReady) return "computer_use_provider_unavailable";
  if (input.state !== "enabled") return "computer_use_setup_required";
  return null;
}

function failed(id: ReadyToWorkComponentId, reason: OwnerResult["reason"] = "owner_unavailable"): OwnerResult {
  return { state: "needs_attention", reason, repairTarget: repairTarget[id] };
}

function attemptKey(desired: ReadyToWorkDesiredState): string {
  return [desired.humanId, desired.authority.scope, desired.authority.revision,
    desired.authority.connectionAttemptId, desired.authority.serverFingerprint].join("\0");
}

export class ReadyToWorkCoordinator {
  private startupAttemptKey: string | null = null;
  private snapshot: ReadyToWorkAggregateStatus = readyToWorkAggregateStatus(null);
  private snapshotKey: string | null = null;

  constructor(private readonly owners: ReadyToWorkCoordinatorOwners) {}

  status(): ReadyToWorkAggregateStatus { return this.snapshot; }

  reset(): ReadyToWorkAggregateStatus {
    this.startupAttemptKey = null;
    this.snapshotKey = null;
    this.snapshot = readyToWorkAggregateStatus(null);
    return this.snapshot;
  }

  /** Updates the redacted aggregate from current owner truth without restoring authority. */
  observe(
    desired: ReadyToWorkDesiredState,
    observed: Partial<Record<ReadyToWorkComponentId, OwnerResult>>,
  ): ReadyToWorkAggregateStatus {
    const key = `${attemptKey(desired)}\0${READY_TO_WORK_COMPONENT_IDS
      .map((id) => desired.components[id] ? "1" : "0").join("")}`;
    const merged: Partial<Record<ReadyToWorkComponentId, OwnerResult>> = {};
    if (this.snapshotKey === key) {
      for (const component of this.snapshot.components) {
        if (component.state !== "off_by_choice" && component.repairTarget !== null) {
          merged[component.id] = {
            state: component.state,
            reason: component.reason,
            repairTarget: component.repairTarget,
          };
        }
      }
    }
    Object.assign(merged, observed);
    this.snapshotKey = key;
    this.snapshot = readyToWorkAggregateStatus(desired, merged);
    return this.snapshot;
  }

  async reconcile(input: Readonly<{
    desired: ReadyToWorkDesiredState;
    trigger: ReconcileTrigger;
    isCurrent: () => boolean | Promise<boolean>;
  }>): Promise<ReadyToWorkAggregateStatus> {
    const key = attemptKey(input.desired);
    if (input.trigger === "startup" && this.startupAttemptKey === key) return this.snapshot;
    if (input.trigger === "startup") this.startupAttemptKey = key;
    const observed: Partial<Record<ReadyToWorkComponentId, OwnerResult>> = {};
    if (!await input.isCurrent()) {
      for (const id of READY_TO_WORK_COMPONENT_IDS) {
        if (input.desired.components[id]) observed[id] = failed(id, "authority_changed");
      }
      this.snapshotKey = `${key}\0${READY_TO_WORK_COMPONENT_IDS
        .map((id) => input.desired.components[id] ? "1" : "0").join("")}`;
      this.snapshot = readyToWorkAggregateStatus(input.desired, observed);
      return this.snapshot;
    }
    const run = async (
      id: ReadyToWorkComponentId,
      operation: () => Promise<OwnerResult>,
      rollback: () => Promise<void>,
    ) => {
      if (!input.desired.components[id]) return;
      if (!await input.isCurrent()) {
        observed[id] = failed(id, "authority_changed");
        return;
      }
      try {
        observed[id] = await operation();
        if (!await input.isCurrent()) {
          if (observed[id]?.state === "ready") await rollback().catch(() => undefined);
          observed[id] = failed(id, "authority_changed");
        }
      } catch { observed[id] = failed(id); }
    };

    const renderer = await this.owners.restoreRendererOwners({
      voice: input.desired.components.voice ? true : null,
      autoApprove: input.desired.components.auto_approve ? true : null,
    }).catch(() => ({ voice: failed("voice"), autoApprove: failed("auto_approve") }));
    if (input.desired.components.voice) observed.voice = renderer.voice;
    if (input.desired.components.auto_approve) observed.auto_approve = renderer.autoApprove;
    if (!await input.isCurrent()) {
      await this.owners.disableRendererOwners(input.desired.components).catch(() => undefined);
      if (input.desired.components.voice) observed.voice = failed("voice", "authority_changed");
      if (input.desired.components.auto_approve) observed.auto_approve = failed("auto_approve", "authority_changed");
    }
    await run("workstation", () => this.owners.restoreWorkstation(input.desired),
      () => this.owners.disableWorkstation());
    await run("computer_use", () => this.owners.observeComputerUse(input.desired),
      () => this.owners.disableComputerUse());
    await run("coding_connection", () => this.owners.restoreCodingConnection(input.desired, input.isCurrent),
      () => this.owners.disableCodingConnection());

    if (!await input.isCurrent()) {
      for (const id of READY_TO_WORK_COMPONENT_IDS) {
        if (input.desired.components[id] && observed[id]?.state === "ready") {
          observed[id] = failed(id, "authority_changed");
        }
      }
    }
    this.snapshotKey = `${key}\0${READY_TO_WORK_COMPONENT_IDS
      .map((id) => input.desired.components[id] ? "1" : "0").join("")}`;
    this.snapshot = readyToWorkAggregateStatus(input.desired, observed);
    return this.snapshot;
  }

  async disable(desired: ReadyToWorkDesiredState): Promise<void> {
    // Invoke every authority-reducing fence promptly in the fixed order, then
    // wait best-effort. An unavailable remote teardown must not delay another
    // owner's local fence.
    const shutdowns: Promise<void>[] = [];
    if (desired.components.coding_connection) {
      shutdowns.push(this.owners.disableCodingConnection().catch(() => undefined));
    }
    if (desired.components.computer_use) {
      shutdowns.push(this.owners.disableComputerUse().catch(() => undefined));
    }
    if (desired.components.workstation) {
      shutdowns.push(this.owners.disableWorkstation().catch(() => undefined));
    }
    if (desired.components.voice || desired.components.auto_approve) {
      shutdowns.push(this.owners.disableRendererOwners(desired.components).catch(() => undefined));
    }
    this.reset();
    await Promise.all(shutdowns);
    this.reset();
  }
}
