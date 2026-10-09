/** Main-process composition only: the existing stores retain all durable ownership. */
import { createReadyToWorkDesiredState, readyToWorkRememberedKey, type ReadyToWorkBinding, type ReadyToWorkDesiredState, type ReadyToWorkRemovalScope } from "./ready-to-work-contract";
import { ReadyToWorkPersistence, saveRememberedReadyToWork, refreshRememberedReadyReceipt } from "./ready-to-work-persistence";
import { ReadyToWorkPersistenceError, type ReadyToWorkStore, type ReadyToWorkInspection } from "./ready-to-work-store";
import type { ReadyToWorkProtectedReceiptStore, ProtectedReceiptReadResult } from "./ready-to-work-protected-receipt";

type Proof = Readonly<{ profileId: string; profileRevision: number; receipt: string }>;
export class ReadyToWorkRemembered {
  readonly persistence: ReadyToWorkPersistence;
  private reducingDevelopment = false;
  private inspectingMigration = false;
  constructor(readonly stores: { desired: ReadyToWorkStore; receipt: ReadyToWorkProtectedReceiptStore }, private readonly currentBinding: () => ReadyToWorkBinding | null) {
    this.persistence = new ReadyToWorkPersistence({
      desired: { inspect: () => this.inspect(), clear: () => {
        const binding = this.requireBinding();
        if (this.reducingDevelopment) {
          const previous = this.previousFor(binding);
          const components = previous?.components ?? { voice: false, auto_approve: false, workstation: false, computer_use: false, coding_connection: false };
          this.stores.desired.prepareRememberedWrite().commit({ kind: "save", desired: createReadyToWorkDesiredState(binding, { ...components, workstation: false }) });
        } else this.stores.desired.prepareRememberedWrite().commit({ kind: "remove", scope: { kind: "key", key: readyToWorkRememberedKey(binding) } });
        return true;
      } },
      receipt: { inspect: () => this.stores.receipt.inspectRemembered(), clear: () => {
        const binding = this.requireBinding();
        this.stores.receipt.removeRemembered({ kind: "key", key: readyToWorkRememberedKey(binding) }, () => this.currentBinding() === binding);
        return true;
      } },
    });
  }
  private requireBinding(): ReadyToWorkBinding {
    const binding = this.currentBinding();
    if (!binding) throw new ReadyToWorkPersistenceError("unavailable");
    return binding;
  }
  private inspect(): ReadyToWorkInspection {
    const binding = this.currentBinding();
    if (!binding) return { status: "missing" };
    const state = this.stores.desired.inspectRemembered(binding);
    if (state.status === "ready") return state.desired ? { status: "ready", desired: state.desired } : { status: "missing" };
    if (state.status === "confirmation_required" || state.status === "changed") return { status: "invalid" };
    if (state.status === "missing" && this.stores.desired.pendingLegacyFor(binding)) return { status: this.inspectingMigration ? "missing" : "invalid" };
    return { status: state.status };
  }
  /** Legacy inspection is not itself a restore failure, but an earlier Off or
   * failed activation must still prevent migration from starting authority. */
  mayMigrate(): boolean {
    this.inspectingMigration = true;
    try { return this.persistence.mayRestore(false); }
    finally { this.inspectingMigration = false; }
  }
  loadFor(binding: ReadyToWorkBinding): ReadyToWorkDesiredState | null {
    const state = this.stores.desired.inspectRemembered(binding);
    return state.status === "ready" ? state.desired : null;
  }
  /** For explicit choice editing only; this never admits restoration. */
  previousFor(binding: ReadyToWorkBinding): ReadyToWorkDesiredState | null {
    const state = this.stores.desired.inspectRemembered(binding);
    if (state.status === "ready" || state.status === "confirmation_required") return state.desired;
    if (state.status === "missing") return this.stores.desired.pendingLegacyFor(binding);
    throw new ReadyToWorkPersistenceError(state.status);
  }
  readReceipt(binding: ReadyToWorkBinding): ProtectedReceiptReadResult {
    const state = this.stores.desired.inspectRemembered(binding);
    return state.status === "ready" && state.desired?.components.workstation
      ? this.stores.receipt.readRememberedFor(binding, state.fenceId) : { ok: false, code: "invalid" };
  }
  assertWritable(): void {
    this.stores.desired.prepareRememberedWrite();
    const state = this.stores.receipt.inspectRemembered();
    if (state.status !== "ready" && state.status !== "missing") throw new ReadyToWorkPersistenceError(state.status);
  }
  save(selection: ReadyToWorkDesiredState, proof: Proof | null, isCurrent: () => boolean): void {
    if (selection.components.workstation) {
      if (!proof) throw new ReadyToWorkPersistenceError("unavailable");
      saveRememberedReadyToWork({ ...this.stores, selection, proof, isCurrent });
    } else {
      if (!isCurrent()) throw new ReadyToWorkPersistenceError("changed");
      this.stores.desired.prepareRememberedWrite().commit({ kind: "save", desired: selection });
      this.stores.receipt.removeRemembered({ kind: "key", key: readyToWorkRememberedKey(selection) }, isCurrent);
    }
    this.persistence.didSaveDesired();
  }
  /** Unrelated Ready choices cannot repair a fence or rotate Development proof. */
  saveComponents(selection: ReadyToWorkDesiredState, isCurrent: () => boolean): void {
    const state = this.stores.desired.inspectRemembered(selection);
    if (state.status !== "ready" && state.status !== "missing") throw new ReadyToWorkPersistenceError("changed");
    if ((state.status === "ready" ? state.desired?.components.workstation ?? false : false) !== selection.components.workstation
      || !isCurrent()) throw new ReadyToWorkPersistenceError("changed");
    this.stores.desired.prepareRememberedWrite().commit({ kind: "save", desired: selection });
  }
  refresh(binding: ReadyToWorkBinding, expectedReceipt: string, proof: Proof, isCurrent: () => boolean): boolean {
    refreshRememberedReadyReceipt({ ...this.stores, binding, expectedReceipt, proof, isCurrent });
    return true;
  }
  /** Reduce only Development, retaining voice/Computer use and coding choices. */
  disableDevelopment(fence: () => Promise<void>): Promise<void> {
    this.reducingDevelopment = true;
    try { return this.persistence.disable(() => fence()); }
    finally { this.reducingDevelopment = false; }
  }
  remove(scope: ReadyToWorkRemovalScope, isCurrent: () => boolean): void {
    if (!isCurrent()) throw new ReadyToWorkPersistenceError("changed");
    this.stores.desired.prepareRememberedWrite().commit({ kind: "remove", scope });
    this.stores.receipt.removeRemembered(scope, isCurrent);
  }
}

/** Wait for every cleanup outcome without making an old rejection a permanent
 * admission barrier. Per-operation errors and persistence latches remain with
 * their existing owners; fresh explicit enrollment may recover afterward. */
export async function settleReadyCleanup(previous: Promise<void>, work: readonly Promise<unknown>[]): Promise<void> {
  await Promise.allSettled([previous, ...work]);
}
