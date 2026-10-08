import { readyToWorkRememberedKey as rememberedKey, READY_TO_WORK_COMPONENT_IDS, type ReadyToWorkAggregateStatus, type ReadyToWorkDesiredState } from "./ready-to-work-contract";
import { ReadyToWorkPersistenceError, type ReadyToWorkStore } from "./ready-to-work-store";
import type { ReadyToWorkProtectedReceiptStore } from "./ready-to-work-protected-receipt";

type PersistenceReason = NonNullable<ReadyToWorkAggregateStatus["persistence"]>["reason"];

/** Composes the existing stores; owns no files, grants, or execution lifecycle. */
export class ReadyToWorkPersistence {
  private failedReduction: PersistenceReason | null = null;
  private componentReductionFailure = false;
  private componentRestoreBlockWasSet = false;
  private saveFailure: PersistenceReason | null = null;
  private restoreBlocked = false;
  private rollbackPending = false;
  private stopping = false;

  constructor(private readonly stores: {
    desired: Pick<ReadyToWorkStore, "inspect" | "clear">;
    receipt: Pick<ReadyToWorkProtectedReceiptStore, "inspect" | "clear">;
  }) {}

  private inspectionFailure(): PersistenceReason | null {
    try {
      for (const store of [this.stores.desired, this.stores.receipt]) {
        const { status } = store.inspect();
        if (status !== "ready" && status !== "missing") return status;
      }
      return null;
    } catch { return "unavailable"; }
  }

  attention(): ReadyToWorkAggregateStatus | null {
    const reason = this.inspectionFailure() ?? this.failedReduction ?? this.saveFailure;
    if (reason === null) return null;
    return { mode: "needs_attention", persistence: { reason, liveAccess: this.stopping ? "stopping" : "unchanged" },
      components: READY_TO_WORK_COMPONENT_IDS.map(id => ({ id, state: "needs_attention",
        reason: "saved_state_unavailable", repairTarget: "startup_settings" })) };
  }

  /** Explicit enrollment may retry understood state; failed Off never auto-restores. */
  assertWritable(): void {
    const reason = this.inspectionFailure();
    if (reason !== null) throw new ReadyToWorkPersistenceError(reason);
  }

  /** Call only after a successful, explicit save of understood desired intent. */
  didSaveDesired(): void {
    this.failedReduction = null;
    this.componentReductionFailure = false;
    this.saveFailure = null;
    this.restoreBlocked = false;
    this.stopping = false;
  }

  recordFailure(error: unknown, stopping = false): void {
    this.saveFailure = error instanceof ReadyToWorkPersistenceError ? error.reason : "unavailable";
    this.stopping ||= stopping;
    if (stopping && this.componentReductionFailure) this.componentRestoreBlockWasSet = true;
    this.restoreBlocked ||= stopping;
  }

  /** A scoped reduction failed; healthy reads cannot undo the Human Off intent. */
  recordReductionFailure(error: unknown): void {
    if (this.failedReduction === null) {
      this.componentReductionFailure = true;
      this.componentRestoreBlockWasSet = this.restoreBlocked;
    }
    this.failedReduction = error instanceof ReadyToWorkPersistenceError ? error.reason : "unavailable";
    this.stopping = true;
    this.restoreBlocked = true;
  }

  /** A successful component-only retry cannot erase a Development Off failure. */
  didReduceComponents(): void {
    if (!this.componentReductionFailure) return;
    this.componentReductionFailure = false;
    this.failedReduction = null;
    this.restoreBlocked = this.componentRestoreBlockWasSet;
    // A pre-existing or subsequently recorded activation fence stays intact.
  }

  /** Observing healthy storage clears a transient save diagnostic, never failed Off. */
  retryStatus(): void {
    if (!this.rollbackPending && this.inspectionFailure() === null) this.saveFailure = null;
  }

  mayRestore(explicit: boolean): boolean {
    if (this.inspectionFailure() !== null || this.failedReduction !== null || this.rollbackPending) return false;
    if (explicit) { this.saveFailure = null; this.restoreBlocked = false; }
    return this.saveFailure === null && !this.restoreBlocked;
  }

  async saveReceiptOrRollback(save: () => boolean, rollback: () => Promise<void>, isCurrent: () => boolean = () => true): Promise<"saved" | "failed" | "stale"> {
    if (!isCurrent()) {
      await rollback();
      return "stale";
    }
    try {
      if (save()) return "saved";
      throw new ReadyToWorkPersistenceError("unavailable");
    } catch (error) {
      this.recordFailure(error, true);
      this.rollbackPending = true;
      try { await rollback(); } finally { this.rollbackPending = false; }
      return "failed";
    }
  }

  /** Reduce intent first; always invoke local fences even when disk reduction fails. */
  disable(fence: (desired: ReadyToWorkDesiredState | null, failedReduction: boolean) => Promise<void>): Promise<void> {
    let desired: ReadyToWorkDesiredState | null = null;
    let reductionFailed = false;
    this.stopping = true;
    try {
      const inspection = this.stores.desired.inspect();
      if (inspection.status === "ready") desired = inspection.desired;
      this.stores.desired.clear();
      // Durable intent is already disarmed. Unusable proof bytes can be kept
      // without authorizing restoration; do not reset an unfamiliar format.
      this.failedReduction = null;
      this.componentReductionFailure = false;
      this.saveFailure = null;
      this.restoreBlocked = false;
      try { this.stores.receipt.clear(); }
      catch (error) { this.recordFailure(error); }
    } catch (error) {
      reductionFailed = true;
      this.componentReductionFailure = false;
      this.failedReduction = error instanceof ReadyToWorkPersistenceError ? error.reason : "unavailable";
    }
    try { return fence(desired, reductionFailed); }
    catch (error) { return Promise.reject(error instanceof Error ? error : new Error("Ready owner shutdown failed")); }
  }
}

/** Explicit enrollment only; automatic rotation uses refreshRememberedReadyReceipt.
 * Opt-in composition over the same two owners. These helpers never
 * enable a feature: main supplies authenticated identity, current server proof
 * validation, its generation fence, and existing feature-owner rollback. */
export function saveRememberedReadyToWork(input: Readonly<{
  desired: ReadyToWorkStore;
  receipt: ReadyToWorkProtectedReceiptStore;
  selection: ReadyToWorkDesiredState;
  proof: Readonly<{ profileId: string; profileRevision: number; receipt: string }>;
  isCurrent: () => boolean;
}>): void {
  if (!input.selection.components.workstation) throw new Error("Remembered Development requires an explicit selection");
  const plan = input.desired.prepareRememberedWrite();
  const isCurrent = () => input.isCurrent() && plan.isCurrent();
  if (!isCurrent()) throw new ReadyToWorkPersistenceError("changed");
  input.receipt.saveRemembered({ binding: input.selection, fenceId: plan.fenceId, retainedProofKeys: plan.retainedProofKeys, ...input.proof, isCurrent });
  // Proof first, then intent. Orphan proof is not a restoration request.
  if (!isCurrent()) throw new ReadyToWorkPersistenceError("changed");
  plan.commit({ kind: "save", desired: input.selection });
}

/** Upgrade only an exact old binding with independently validated protected
 * proof. Neither a manual activation nor legacy intent alone qualifies. */
export async function migrateRememberedReadyToWork(input: Readonly<{
  desired: ReadyToWorkStore;
  receipt: ReadyToWorkProtectedReceiptStore;
  binding: import("./ready-to-work-contract").ReadyToWorkBinding;
  /** Revalidate current Human/pairing eligibility and the extant contained
   * Development profile; reject Full Mac, revoked, or changed profile proof. */
  validate: (proof: Readonly<{ profileId: string; profileRevision: number; receipt: string }>) => Promise<Readonly<{ profileId: string; profileRevision: number; receipt: string }> | null>;
  isCurrent: () => boolean;
}>): Promise<"migrated" | "not_eligible" | "stale"> {
  if (!input.isCurrent()) return "stale";
  const selection = input.desired.pendingLegacyFor(input.binding);
  const proof = input.receipt.pendingLegacyFor(input.binding);
  if (!selection?.components.workstation || !proof.ok) return "not_eligible";
  const plan = input.desired.prepareRememberedWrite();
  const validated = await input.validate(proof);
  if (!input.isCurrent() || !plan.isCurrent()) return "stale";
  const currentProof = input.receipt.pendingLegacyFor(input.binding);
  if (!currentProof.ok || currentProof.receipt !== proof.receipt || currentProof.profileId !== proof.profileId || currentProof.profileRevision !== proof.profileRevision) return "stale";
  if (!validated || validated.profileId !== proof.profileId || validated.profileRevision !== proof.profileRevision) return "not_eligible";
  const isCurrent = () => input.isCurrent() && plan.isCurrent();
  input.receipt.saveRemembered({ binding: input.binding, fenceId: plan.fenceId, retainedProofKeys: plan.retainedProofKeys, ...validated, isCurrent });
  if (!isCurrent()) return "stale";
  plan.commit({ kind: "save", desired: { ...selection, ...input.binding } });
  return "migrated";
}

/** Durable reduction precedes proof cleanup; local authority is fenced even
 * when either store refuses a write. A failure is never durable Off. */
export async function disableRememberedDevelopment(input: Readonly<{
  desired: ReadyToWorkStore;
  receipt: ReadyToWorkProtectedReceiptStore;
  binding: import("./ready-to-work-contract").ReadyToWorkBinding;
  isCurrent: () => boolean;
  fence: () => Promise<void>;
}>): Promise<void> {
  let failure: unknown;
  try {
    if (!input.isCurrent()) throw new ReadyToWorkPersistenceError("changed");
    const inspection = input.desired.inspectRemembered(input.binding);
    if (inspection.status !== "ready" && inspection.status !== "confirmation_required" && inspection.status !== "missing") throw new ReadyToWorkPersistenceError(inspection.status);
    const previous = inspection.status === "ready" || inspection.status === "confirmation_required"
      ? inspection.desired : input.desired.pendingLegacyFor(input.binding);
    const selection = previous?.components ?? { voice: false, auto_approve: false, workstation: false, computer_use: false, coding_connection: false };
    const plan = input.desired.prepareRememberedWrite();
    plan.commit({ kind: "save", desired: { version: 1, ...input.binding, components: { ...selection, workstation: false } } });
    input.receipt.removeRemembered({ kind: "key", key: rememberedKey(input.binding) }, input.isCurrent);
  } catch (error) { failure = error; }
  // Invoked synchronously before the first await in this helper.
  const fenced = input.fence();
  try { await fenced; } catch (error) { failure ??= error; }
  if (failure !== undefined) throw failure instanceof Error ? failure : new ReadyToWorkPersistenceError("unavailable");
}

export async function removeRememberedReadyToWork(input: Readonly<{
  desired: ReadyToWorkStore;
  receipt: ReadyToWorkProtectedReceiptStore;
  scope: import("./ready-to-work-contract").ReadyToWorkRemovalScope;
  isCurrent: () => boolean;
  fence: () => Promise<void>;
}>): Promise<void> {
  let failure: unknown;
  try {
    if (!input.isCurrent()) throw new ReadyToWorkPersistenceError("changed");
    input.desired.prepareRememberedWrite().commit({ kind: "remove", scope: input.scope });
    input.receipt.removeRemembered(input.scope, input.isCurrent);
  } catch (error) { failure = error; }
  const fenced = input.fence();
  try { await fenced; } catch (error) { failure ??= error; }
  if (failure !== undefined) throw failure instanceof Error ? failure : new ReadyToWorkPersistenceError("unavailable");
}

/** Automatic receipt rotation cannot repair a downgrade fence or create a new
 * remembered choice. Its caller must still revalidate the existing server proof. */
export function refreshRememberedReadyReceipt(input: Readonly<{
  desired: ReadyToWorkStore;
  receipt: ReadyToWorkProtectedReceiptStore;
  binding: import("./ready-to-work-contract").ReadyToWorkBinding;
  expectedReceipt: string;
  proof: Readonly<{ profileId: string; profileRevision: number; receipt: string }>;
  isCurrent: () => boolean;
}>): void {
  const selected = input.desired.inspectRemembered(input.binding);
  if (selected.status !== "ready" || !selected.desired?.components.workstation) throw new ReadyToWorkPersistenceError("changed");
  const previous = input.receipt.readRememberedFor(input.binding, selected.fenceId);
  if (!previous.ok || previous.receipt !== input.expectedReceipt || previous.profileId !== input.proof.profileId
    || previous.profileRevision !== input.proof.profileRevision) throw new ReadyToWorkPersistenceError("changed");
  const plan = input.desired.prepareRememberedWrite();
  if (plan.fenceId !== selected.fenceId) throw new ReadyToWorkPersistenceError("changed");
  const isCurrent = () => input.isCurrent() && plan.isCurrent();
  input.receipt.saveRemembered({ binding: input.binding, fenceId: plan.fenceId, retainedProofKeys: plan.retainedProofKeys, ...input.proof, isCurrent });
}
