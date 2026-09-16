import {
  CodexHostError,
  type BindingRequest,
  type BindingOpenReservation,
  type BindingRebindReservation,
  type BindingRebindRequest,
  type BindingResumeRequest,
  type BoundThread,
  type ChildIdentity,
  type CodexBindingStore,
  type OpaqueHandle,
  type PersistedBindingRecord,
} from "./contracts";

export const MAX_BINDINGS_PER_CHILD = 32;

/** Store-backed binding routing; a production adapter may persist these records. */
export class CodexBindingRegistry {
  constructor(
    private readonly child: ChildIdentity,
    private readonly store: CodexBindingStore,
    private readonly maxBindings = MAX_BINDINGS_PER_CHILD,
  ) { if (maxBindings <= 0) throw new Error("maxBindings must be positive"); }

  async reserveOpen(request: BindingRequest): Promise<{ readonly kind: "existing"; readonly binding: BoundThread } | { readonly kind: "started"; readonly reservation: BindingOpenReservation } | { readonly kind: "pending" }> {
    const existing = await this.match(request);
    if (existing) return { kind: "existing", binding: bound(existing) };
    if ((await this.store.list(this.child)).length >= this.maxBindings) throw new CodexHostError("BINDING_LIMIT_REACHED", "Codex child binding limit reached");
    const reservation: BindingOpenReservation = Object.freeze({ ...request, child: this.child, reservationId: crypto.randomUUID(), state: "opening" });
    const state = await this.store.beginOpen(reservation);
    if (state === "started") return { kind: "started", reservation };
    if (state === "same_pending") return { kind: "pending" };
    throw new CodexHostError("CHILD_GENERATION_STALE", "Binding id was reused with different authority");
  }
  async completeOpen(reservation: BindingOpenReservation, threadId: string): Promise<BoundThread> {
    const record: PersistedBindingRecord = Object.freeze({
      bindingId: reservation.bindingId,
      bindingGeneration: reservation.bindingGeneration,
      threadId,
      child: this.child,
      workspace: reservation.workspace,
      taskId: reservation.taskId,
      jobId: reservation.jobId,
      workingDirectory: reservation.workingDirectory,
      model: reservation.model,
      posture: reservation.posture,
      activeTurns: 0,
      pendingRequests: 0,
      outstandingRpcs: 0,
    });
    if (!(await this.store.completeOpen(reservation, record))) throw new CodexHostError("BINDING_UNCERTAIN", "Binding reservation could not be completed");
    return bound(record);
  }
  abortOpen(reservation: BindingOpenReservation): Promise<void> { return this.store.abortOpen(reservation); }

  async get(bindingId: OpaqueHandle, child: ChildIdentity): Promise<PersistedBindingRecord> {
    const binding = await this.store.get(bindingId);
    if (!binding || !sameChild(binding.child, child)) throw new CodexHostError("CHILD_GENERATION_STALE", "Binding does not belong to the current Codex child");
    return binding;
  }
  async getByThread(threadId: string): Promise<PersistedBindingRecord | undefined> {
    const matches = (await this.store.list(this.child)).filter(
      (binding) => binding.threadId === threadId,
    );
    if (matches.length > 1) {
      throw new CodexHostError(
        "BINDING_UNCERTAIN",
        "More than one binding claimed the same Codex thread",
      );
    }
    return matches[0];
  }
  async match(request: BindingRequest): Promise<PersistedBindingRecord | undefined> {
    const existing = await this.store.get(request.bindingId);
    if (!existing) return undefined;
    if (!sameChild(existing.child, this.child) || !sameBindingAuthority(existing, request, existing.threadId)) {
      throw new CodexHostError("CHILD_GENERATION_STALE", "Binding authority changed");
    }
    return existing;
  }
  async matchResume(request: BindingResumeRequest): Promise<PersistedBindingRecord> {
    const existing = await this.store.get(request.bindingId);
    if (!existing || !sameChild(existing.child, this.child) || existing.bindingGeneration !== request.bindingGeneration || !sameWorkspace(existing.workspace, request.workspace) || existing.taskId !== request.taskId || existing.jobId !== request.jobId || existing.threadId !== request.threadId) {
      throw new CodexHostError("CHILD_GENERATION_STALE", "Binding resume authority changed");
    }
    return existing;
  }

  async remove(bindingId: OpaqueHandle): Promise<void> { await this.store.remove(bindingId); }
  async reserveRebind(request: BindingRebindRequest, current: PersistedBindingRecord): Promise<{ readonly kind: "started"; readonly reservation: BindingRebindReservation } | { readonly kind: "pending" }> {
    if (request.bindingGeneration !== current.bindingGeneration || request.nextBindingGeneration !== current.bindingGeneration + 1) {
      throw new CodexHostError("CHILD_GENERATION_STALE", "Binding rebind generation must advance exactly once");
    }
    if (!sameWorkspaceFingerprint(request.successorWorkspace, current.workspace)) {
      throw new CodexHostError("WORKSPACE_STALE", "Binding rebind must preserve the paired-host routing receipt");
    }
    if (current.taskId !== request.taskId || current.jobId !== request.jobId || current.threadId !== request.threadId) {
      throw new CodexHostError("CHILD_GENERATION_STALE", "Binding rebind changed immutable authority");
    }
    const reservation: BindingRebindReservation = Object.freeze({ ...request, child: this.child, current, reservationId: crypto.randomUUID(), state: "rebinding" });
    const result = await this.store.beginRebind(reservation, current);
    if (result === "started") return { kind: "started", reservation };
    if (result === "same_pending") return { kind: "pending" };
    throw new CodexHostError("CHILD_GENERATION_STALE", "Binding rebind authority changed");
  }
  async completeRebind(reservation: BindingRebindReservation, current: PersistedBindingRecord): Promise<BoundThread> {
    const next: PersistedBindingRecord = Object.freeze({
      ...current,
      bindingGeneration: reservation.nextBindingGeneration,
      workspace: reservation.successorWorkspace,
    });
    if (!(await this.store.completeRebind(reservation, current, next))) throw new CodexHostError("BINDING_UNCERTAIN", "Binding rebind reservation could not be completed");
    return bound(next);
  }
  abortRebind(reservation: BindingRebindReservation): Promise<void> { return this.store.abortRebind(reservation); }
  async updateActivity(bindingId: OpaqueHandle, change: Partial<Pick<PersistedBindingRecord, "activeTurns" | "pendingRequests" | "outstandingRpcs">>): Promise<void> {
    const current = await this.get(bindingId, this.child);
    const next = { ...current, ...change };
    if (next.activeTurns < 0 || next.pendingRequests < 0 || next.outstandingRpcs < 0) throw new CodexHostError("SUPERVISOR_UNAVAILABLE", "Binding activity underflow");
    await this.store.update(Object.freeze(next));
  }
  async isIdle(): Promise<boolean> {
    return (await this.store.list(this.child)).every((binding) => binding.activeTurns === 0 && binding.pendingRequests === 0 && binding.outstandingRpcs === 0);
  }
}

/** Atomic test/reference store. Replace with a host-local durable adapter in Electron. */
export class InMemoryCodexBindingStore implements CodexBindingStore {
  private readonly records = new Map<OpaqueHandle, PersistedBindingRecord>();
  private readonly reservations = new Map<OpaqueHandle, BindingOpenReservation | BindingRebindReservation>();
  get(bindingId: OpaqueHandle): Promise<PersistedBindingRecord | undefined> { return Promise.resolve(this.records.get(bindingId)); }
  list(child: ChildIdentity): Promise<readonly PersistedBindingRecord[]> { return Promise.resolve([...this.records.values()].filter((record) => sameChild(record.child, child))); }
  beginOpen(reservation: BindingOpenReservation): Promise<"started" | "same_pending" | "conflict"> { return Promise.resolve(this.begin(reservation)); }
  completeOpen(reservation: BindingOpenReservation, record: PersistedBindingRecord): Promise<boolean> { if (!this.sameReservation(reservation)) return Promise.resolve(false); this.reservations.delete(reservation.bindingId); this.records.set(record.bindingId, record); return Promise.resolve(true); }
  abortOpen(reservation: BindingOpenReservation): Promise<void> { if (this.sameReservation(reservation)) this.reservations.delete(reservation.bindingId); return Promise.resolve(); }
  beginRebind(reservation: BindingRebindReservation, expected: PersistedBindingRecord): Promise<"started" | "same_pending" | "conflict"> { if (this.records.get(expected.bindingId) !== expected) return Promise.resolve("conflict"); return Promise.resolve(this.begin(reservation)); }
  completeRebind(reservation: BindingRebindReservation, expected: PersistedBindingRecord, next: PersistedBindingRecord): Promise<boolean> { if (!this.sameReservation(reservation) || this.records.get(expected.bindingId) !== expected) return Promise.resolve(false); this.reservations.delete(reservation.bindingId); this.records.set(next.bindingId, next); return Promise.resolve(true); }
  abortRebind(reservation: BindingRebindReservation): Promise<void> { if (this.sameReservation(reservation)) this.reservations.delete(reservation.bindingId); return Promise.resolve(); }
  update(record: PersistedBindingRecord): Promise<void> { if (!this.records.has(record.bindingId)) return Promise.reject(new CodexHostError("CHILD_GENERATION_STALE", "Binding is unavailable")); this.records.set(record.bindingId, record); return Promise.resolve(); }
  remove(bindingId: OpaqueHandle): Promise<void> { this.records.delete(bindingId); this.reservations.delete(bindingId); return Promise.resolve(); }
  private begin(reservation: BindingOpenReservation | BindingRebindReservation): "started" | "same_pending" | "conflict" { if (reservation.state === "opening" && this.records.has(reservation.bindingId)) return "conflict"; const existing = this.reservations.get(reservation.bindingId); if (!existing) { this.reservations.set(reservation.bindingId, reservation); return "started"; } return sameReservationAuthority(existing, reservation) ? "same_pending" : "conflict"; }
  private sameReservation(reservation: BindingOpenReservation | BindingRebindReservation): boolean { return this.reservations.get(reservation.bindingId)?.reservationId === reservation.reservationId; }
}

function bound(record: PersistedBindingRecord): BoundThread { return { bindingId: record.bindingId, bindingGeneration: record.bindingGeneration, threadId: record.threadId, child: record.child }; }
export function sameChild(left: ChildIdentity, right: ChildIdentity): boolean { return left.profile.actorId === right.profile.actorId && left.profile.profileHandle === right.profile.profileHandle && left.profile.profileGeneration === right.profile.profileGeneration && left.accountGeneration === right.accountGeneration && left.runtimeGeneration === right.runtimeGeneration && left.childGeneration === right.childGeneration; }

export function sameWorkspace(left: BindingRequest["workspace"], right: BindingRequest["workspace"]): boolean {
  return left.handle === right.handle && left.actorId === right.actorId && left.relayId === right.relayId && left.relaySessionId === right.relaySessionId && left.desktopSessionId === right.desktopSessionId && left.pairingGenerationRef === right.pairingGenerationRef && left.capabilityRevision === right.capabilityRevision && left.revision === right.revision && left.fingerprint === right.fingerprint && left.issuedAt === right.issuedAt && left.expiresAt === right.expiresAt;
}
export function sameWorkspaceFingerprint(left: BindingRequest["workspace"], right: BindingRequest["workspace"]): boolean {
  return left.actorId === right.actorId && left.relayId === right.relayId && left.pairingGenerationRef === right.pairingGenerationRef && left.fingerprint === right.fingerprint;
}

function sameBindingAuthority(existing: PersistedBindingRecord, request: BindingRequest, threadId: string, allowNextGeneration = false): boolean {
  const expectedGeneration = allowNextGeneration ? existing.bindingGeneration + 1 : existing.bindingGeneration;
  return request.bindingGeneration === expectedGeneration
    && sameWorkspace(existing.workspace, request.workspace)
    && existing.taskId === request.taskId
    && existing.jobId === request.jobId
    && existing.workingDirectory === request.workingDirectory
    && (request.threadId === undefined || request.threadId === existing.threadId)
    && existing.threadId === threadId
    && existing.model === request.model
    && samePosture(existing.posture, request.posture);
}

function samePosture(left: BindingRequest["posture"], right: BindingRequest["posture"]): boolean { return left.kind === right.kind; }
/** Durable restart/replay comparator; mutable activity counters are intentionally excluded. */
export function sameReservationAuthority(left: BindingOpenReservation | BindingRebindReservation, right: BindingOpenReservation | BindingRebindReservation): boolean {
  if (left.state !== right.state || left.bindingGeneration !== right.bindingGeneration || left.bindingId !== right.bindingId || !sameChild(left.child, right.child) || left.taskId !== right.taskId || left.jobId !== right.jobId) return false;
  if (left.state === "opening" && right.state === "opening") return sameWorkspace(left.workspace, right.workspace) && left.workingDirectory === right.workingDirectory && left.model === right.model && samePosture(left.posture, right.posture);
  if (left.state === "rebinding" && right.state === "rebinding") return left.threadId === right.threadId && left.nextBindingGeneration === right.nextBindingGeneration && sameWorkspace(left.successorWorkspace, right.successorWorkspace) && sameRecord(left.current, right.current);
  return false;
}
function sameRecord(left: PersistedBindingRecord, right: PersistedBindingRecord): boolean { return left.bindingId === right.bindingId && left.bindingGeneration === right.bindingGeneration && left.threadId === right.threadId && sameChild(left.child, right.child) && sameWorkspace(left.workspace, right.workspace) && left.taskId === right.taskId && left.jobId === right.jobId && left.workingDirectory === right.workingDirectory && left.model === right.model && samePosture(left.posture, right.posture); }
