import type {
  AuthorityProjectionCasInput,
  AuthorityProtectedReconciliationReceipt,
  AuthorityProjectionCommitmentPort,
  AuthorityProjectionStorePort,
  AuthorityReconciliationFailureCode,
  CurrentAuthorityProjection,
  MaterializedAccessAudience,
  ProtectedAuthorityRepublisherPort,
  RecordAccessAudiencePort,
} from "../server/authority-contracts";
import { createHmacAuthorityProjectionCheckpointPort } from "../server/authority-commitment";

function equalBytes(left: Uint8Array | null | undefined, right: Uint8Array | undefined): boolean {
  return left != null && right !== undefined && left.length === right.length && left.every((byte, index) => byte === right[index]);
}
function emptyReceipt(input: Readonly<{recordRef: string; expectedProjectionGeneration: number; sourceChangeGeneration: number}>): AuthorityProtectedReconciliationReceipt {
  return {receiptId: `authority-work:${input.recordRef}:${input.sourceChangeGeneration}`, recordRef: input.recordRef,
    expectedProjectionGeneration: input.expectedProjectionGeneration, sourceChangeGeneration: input.sourceChangeGeneration, state: "pending", completedAt: null,
    targetRepresentationGeneration: null, targetCryptoObjectId: null, targetAccessNamespaceIds: null, targetAudienceSetCommitment: null,
    targetCryptoRetiredAt: null, formerCryptoObjectId: null, formerCryptoRetiredAt: null};
}

function audienceKey(humanRefs: readonly string[]): string {
  return JSON.stringify([...humanRefs].sort());
}

function cloneProjection(value: CurrentAuthorityProjection): CurrentAuthorityProjection {
  return {
    ...value,
    ...(value.audienceSetCommitment === undefined ? {} : {audienceSetCommitment: value.audienceSetCommitment.slice()}),
    alternatives: value.alternatives.map((alternative) => ({
      ...alternative,
      alternativeCommitment: alternative.alternativeCommitment.slice(),
    })),
    terminalAuthorityLeafHandles: [...value.terminalAuthorityLeafHandles],
  };
}

/** Hermetic strict kind=access Room materializer. */
export class InMemoryRecordAccessAudiencePort implements RecordAccessAudiencePort {
  readonly #byAudience = new Map<string, MaterializedAccessAudience[]>();
  readonly #byNamespace = new Map<string, MaterializedAccessAudience>();
  #nextId = 1;

  seedAccessAudience(input: MaterializedAccessAudience): void {
    const normalized = { ...input, humanRefs: [...input.humanRefs].sort() };
    const key = audienceKey(normalized.humanRefs);
    this.#byAudience.set(key, [...(this.#byAudience.get(key) ?? []), normalized]);
    this.#byNamespace.set(normalized.accessNamespaceId, normalized);
  }

  resolveOrCreateExact(
    humanRefs: readonly string[],
  ): Promise<MaterializedAccessAudience> {
    const normalized = [...new Set(humanRefs)].sort();
    if (normalized.length === 0 || normalized.length !== humanRefs.length) {
      throw new TypeError("Record access audience must be non-empty and exact");
    }
    const existing = this.#byAudience.get(audienceKey(normalized))?.[0];
    if (existing !== undefined) {
      return Promise.resolve({ ...existing, humanRefs: [...existing.humanRefs] });
    }
    const id = this.#nextId;
    this.#nextId += 1;
    const created: MaterializedAccessAudience = {
      accessRoomId: `access-room-${id}`,
      accessNamespaceId: `access-namespace-${id}`,
      humanRefs: normalized,
    };
    this.seedAccessAudience(created);
    return Promise.resolve({ ...created, humanRefs: [...created.humanRefs] });
  }

  readExactSet(accessNamespaceIds: readonly string[]) {
    const values = accessNamespaceIds.map((accessNamespaceId) =>
      this.#byNamespace.get(accessNamespaceId)
    );
    return Promise.resolve(values.some((value) => value === undefined)
      ? { status: "unavailable" as const }
      : {
          status: "available" as const,
          audiences: values.map((value) => [...value!.humanRefs]),
        });
  }

  list(): readonly MaterializedAccessAudience[] {
    return [...this.#byNamespace.values()].map((value) => ({
      ...value,
      humanRefs: [...value.humanRefs],
    }));
  }
}

export class InMemoryAuthorityProjectionStore implements AuthorityProjectionStorePort {
  readonly #current = new Map<string, CurrentAuthorityProjection>();
  readonly #closures = new Map<string, Readonly<{ generation: number; handles: string[] }>>();
  readonly #reverse = new Map<string, Set<string>>();
  readonly #changes = new Map<string, string>();
  readonly #blocksByRecord = new Map<string, "blocked" | "purged">();
  readonly #blocksByLeaf = new Map<string, "blocked" | "purged">();
  readonly #pendingSourceGeneration = new Map<string, number>();
  readonly #work = new Map<string, {
    recordRef: string;
    expectedProjectionGeneration: number;
    sourceChangeGeneration: number;
    state: "pending" | "leased" | "quarantined" | "complete";
    attemptCount: number;
    leaseToken?: string;
    leaseExpiresAt?: Date;
    nextAttemptAt?: Date;
    sealedCheckpoint?: Uint8Array;
    failureCode?: AuthorityReconciliationFailureCode;
  }>();
  readonly #receipts = new Map<string, AuthorityProtectedReconciliationReceipt>();
  #nextLease = 1;
  readonly sealedRepairStates = new Map<string, Uint8Array>();
  readonly #retirements = new Map<string, Readonly<{
    recordRef: string;
    sourceChangeGeneration: number;
    formerCryptoObjectId: string;
    completed: boolean;
  }>>();

  seedProjection(projection: CurrentAuthorityProjection): void {
    this.#current.set(projection.recordRef, cloneProjection(projection));
    this.#closures.set(projection.recordRef, {
      generation: projection.projectionGeneration,
      handles: [...projection.terminalAuthorityLeafHandles],
    });
    for (const handle of projection.terminalAuthorityLeafHandles) {
      const records = this.#reverse.get(handle) ?? new Set<string>();
      records.add(projection.recordRef);
      this.#reverse.set(handle, records);
    }
  }

  readCurrent(recordRef: string): Promise<CurrentAuthorityProjection | null> {
    const value = this.#current.get(recordRef);
    const receipt = value === undefined ? undefined : this.#receipts.get(`${recordRef}:${value.sourceChangeGeneration}`);
    const ready = value !== undefined && value.processingState === "current" && receipt?.state === "complete"
      && receipt.expectedProjectionGeneration + 1 === value.projectionGeneration && receipt.targetCryptoRetiredAt === null
      && receipt.targetCryptoObjectId === value.protectedCryptoObjectId && receipt.targetRepresentationGeneration === value.representationGeneration
      && JSON.stringify(receipt.targetAccessNamespaceIds) === JSON.stringify(value.alternatives.map(entry => entry.accessNamespaceId).sort())
      && equalBytes(receipt.targetAudienceSetCommitment, value.audienceSetCommitment);
    return Promise.resolve(value === undefined ? null : {...cloneProjection(value), protectedAuthorityCurrent: ready});
  }

  readProtectedReconciliation(input: Readonly<{recordRef: string; sourceChangeGeneration: number}>): Promise<AuthorityProtectedReconciliationReceipt | null> {
    const value = this.#receipts.get(`${input.recordRef}:${input.sourceChangeGeneration}`);
    return Promise.resolve(value === undefined ? null : structuredClone(value));
  }

  isImmediatelyBlocked(input: Readonly<{
    recordRef: string;
    terminalAuthorityLeafHandles?: readonly string[];
  }>): Promise<"blocked" | "purged" | null> {
    const direct = this.#blocksByRecord.get(input.recordRef);
    if (direct !== undefined) return Promise.resolve(direct);
    for (const handle of input.terminalAuthorityLeafHandles ?? []) {
      const disposition = this.#blocksByLeaf.get(handle);
      if (disposition !== undefined) return Promise.resolve(disposition);
    }
    return Promise.resolve(null);
  }

  installInitialClosure(input: Readonly<{
    recordRef: string;
    closureGeneration: number;
    terminalAuthorityLeafHandles: readonly string[];
  }>): Promise<"installed" | "replayed" | "conflict"> {
    const existing = this.#closures.get(input.recordRef);
    const handles = [...new Set(input.terminalAuthorityLeafHandles)].sort();
    if (existing !== undefined) {
      return Promise.resolve(existing.generation === input.closureGeneration
          && JSON.stringify(existing.handles) === JSON.stringify(handles)
        ? "replayed"
        : "conflict");
    }
    this.#closures.set(input.recordRef, { generation: input.closureGeneration, handles });
    for (const handle of handles) {
      const records = this.#reverse.get(handle) ?? new Set<string>();
      records.add(input.recordRef);
      this.#reverse.set(handle, records);
    }
    if (!this.#current.has(input.recordRef)) {
      this.#current.set(input.recordRef, {
        recordRef: input.recordRef,
        recordLifecycle: "current",
        recordDisposition: "available",
        projectionGeneration: input.closureGeneration,
        sourceChangeGeneration: input.closureGeneration,
        processingState: "dirty",
        alternatives: [],
        terminalAuthorityLeafHandles: handles,
        representationGeneration: 1,
      });
    }
    this.#work.set(`${input.recordRef}:${input.closureGeneration}`, {
      recordRef: input.recordRef,
      expectedProjectionGeneration: input.closureGeneration,
      sourceChangeGeneration: input.closureGeneration,
      state: "pending",
      attemptCount: 0,
    });
    return Promise.resolve("installed");
  }

  admitSourceChange(input: Readonly<{
    changeRef: string;
    terminalAuthorityLeafHandle: string;
    sourceChangeGeneration: number;
  }>): Promise<Readonly<{ dirtyRecordCount: number; replayed: boolean }>> {
    const coordinate = `${input.terminalAuthorityLeafHandle}:${input.sourceChangeGeneration}`;
    const existing = this.#changes.get(input.changeRef);
    if (existing !== undefined) {
      if (existing !== coordinate) throw new Error("Authority change idempotency conflict");
      return Promise.resolve({ dirtyRecordCount: 0, replayed: true });
    }
    this.#changes.set(input.changeRef, coordinate);
    let dirtyRecordCount = 0;
    for (const recordRef of this.#reverse.get(input.terminalAuthorityLeafHandle) ?? []) {
      const current = this.#current.get(recordRef);
      if (current === undefined) continue;
      this.#pendingSourceGeneration.set(
        recordRef,
        Math.max(this.#pendingSourceGeneration.get(recordRef) ?? 0, input.sourceChangeGeneration),
      );
      if (current.processingState !== "dirty") {
        const { unavailableReason: _, ...repairable } = current;
        this.#current.set(recordRef, { ...repairable, processingState: "dirty" });
        dirtyRecordCount += 1;
      }
      const workKey = `${recordRef}:${input.sourceChangeGeneration}`;
      for (const work of this.#work.values()) {
        if (
          work.recordRef === recordRef
          && work.sourceChangeGeneration < input.sourceChangeGeneration
          && work.state === "pending"
        ) {
          work.state = "quarantined";
          work.failureCode = "mapping_conflict";
        }
      }
      if (!this.#work.has(workKey)) {
        this.#work.set(workKey, {
          recordRef,
          expectedProjectionGeneration: current.projectionGeneration,
          sourceChangeGeneration: input.sourceChangeGeneration,
          state: "pending",
          attemptCount: 0,
        });
      }
    }
    return Promise.resolve({ dirtyRecordCount, replayed: false });
  }

  async applyProjectionCas(
    input: AuthorityProjectionCasInput,
  ): Promise<"applied" | "stale" | "blocked"> {
    const current = this.#current.get(input.recordRef);
    const key = `${input.recordRef}:${input.sourceChangeGeneration}`;
    const receipt = this.#receipts.get(key);
    const transition = input.protectedTransition;
    const attachOnly = current !== undefined && current.projectionGeneration === input.expectedProjectionGeneration + 1
      && current.sourceChangeGeneration === input.sourceChangeGeneration && current.processingState === "current"
      && equalBytes(current.audienceSetCommitment, input.audienceSetCommitment);
    if (transition !== undefined) {
      if (receipt === undefined || receipt.expectedProjectionGeneration !== input.expectedProjectionGeneration
        || receipt.targetCryptoObjectId !== transition.cryptoObjectId || receipt.targetRepresentationGeneration !== transition.representationGeneration
        || JSON.stringify(receipt.targetAccessNamespaceIds) !== JSON.stringify(input.alternatives.map(entry => entry.accessNamespaceId).sort())
        || !equalBytes(receipt.targetAudienceSetCommitment, input.audienceSetCommitment)) throw new TypeError("Protected projection does not match its completed crypto receipt");
      if (receipt.state === "quarantined" || receipt.targetCryptoRetiredAt !== null) return "stale";
      if (receipt.state === "complete" && attachOnly && current?.protectedCryptoObjectId === transition.cryptoObjectId
        && current.representationGeneration === transition.representationGeneration) {
        if ((this.#pendingSourceGeneration.get(input.recordRef) ?? 0) > input.sourceChangeGeneration) return "stale";
        const at = await transition.authorizeCommit();
        if (!Number.isSafeInteger(at) || at < 0) throw new TypeError("Protected commit fence returned an invalid time");
        if (await this.isImmediatelyBlocked({recordRef: input.recordRef, terminalAuthorityLeafHandles: current.terminalAuthorityLeafHandles}) !== null) return "blocked";
        return "applied";
      }
      if (receipt.state !== "crypto_complete" && receipt.state !== "complete") return "stale";
      if (current === undefined || current.representationGeneration + 1 !== transition.representationGeneration
        || current.protectedCryptoObjectId !== receipt.formerCryptoObjectId) return "stale";
    }
    if (current === undefined || (current.projectionGeneration !== input.expectedProjectionGeneration && !(transition !== undefined && attachOnly))) return "stale";
    if ((this.#pendingSourceGeneration.get(input.recordRef) ?? 0) > input.sourceChangeGeneration) return "stale";
    if (current.recordDisposition !== "available" || await this.isImmediatelyBlocked({recordRef: input.recordRef,
      terminalAuthorityLeafHandles: current.terminalAuthorityLeafHandles}) !== null) return "blocked";
    if (attachOnly && (JSON.stringify(current.alternatives) !== JSON.stringify(input.alternatives)
      || JSON.stringify([...current.terminalAuthorityLeafHandles].sort()) !== JSON.stringify([...input.terminalAuthorityLeafHandles].sort()))) return "stale";
    if (transition !== undefined) {
      if (typeof transition.authorizeCommit !== "function") throw new TypeError("Protected projection requires a current commit fence");
      const at = await transition.authorizeCommit();
      if (!Number.isSafeInteger(at) || at < 0) throw new TypeError("Protected commit fence returned an invalid time");
      // The hermetic store has no DB lock; recheck state after the async fence.
      if (this.#current.get(input.recordRef) !== current || (this.#pendingSourceGeneration.get(input.recordRef) ?? 0) > input.sourceChangeGeneration) return "stale";
      if (await this.isImmediatelyBlocked({recordRef: input.recordRef, terminalAuthorityLeafHandles: current.terminalAuthorityLeafHandles}) !== null) return "blocked";
    }
    const generation = attachOnly ? current.projectionGeneration : current.projectionGeneration + 1;
    const next: CurrentAuthorityProjection = {
      recordRef: input.recordRef,
      recordLifecycle: current.recordLifecycle,
      recordDisposition: current.recordDisposition,
      projectionGeneration: generation,
      audienceSetCommitment: input.audienceSetCommitment.slice(),
      sourceChangeGeneration: input.sourceChangeGeneration,
      processingState: input.unavailableReason === undefined ? "current" : "unavailable",
      alternatives: input.alternatives.map((alternative) => ({
        ...alternative,
        alternativeCommitment: alternative.alternativeCommitment.slice(),
      })),
      ...(input.unavailableReason === undefined
        ? {}
        : { unavailableReason: input.unavailableReason }),
      terminalAuthorityLeafHandles: [...input.terminalAuthorityLeafHandles],
      representationGeneration:
        input.protectedTransition?.representationGeneration ?? current.representationGeneration,
      ...(input.protectedTransition === undefined
        ? current.protectedCryptoObjectId === undefined
          ? {}
          : { protectedCryptoObjectId: current.protectedCryptoObjectId }
        : { protectedCryptoObjectId: input.protectedTransition.cryptoObjectId }),
    };
    this.#current.set(input.recordRef, next);
    this.#receipts.set(key, {...(receipt ?? emptyReceipt(input)), state: transition === undefined && receipt?.targetCryptoObjectId != null ? receipt.state : "complete", completedAt: receipt?.completedAt ?? new Date()});
    const completedWork = this.#work.get(`${input.recordRef}:${input.sourceChangeGeneration}`);
    if (completedWork !== undefined) completedWork.state = "complete";
    this.#pendingSourceGeneration.delete(input.recordRef);
    if (input.sealedRepairState !== undefined) {
      this.sealedRepairStates.set(
        `${input.recordRef}:${generation}`,
        input.sealedRepairState.slice(),
      );
    }
    if (
      input.protectedTransition !== undefined
      && current.protectedCryptoObjectId !== undefined
    ) {
      const key = `${input.recordRef}:${input.sourceChangeGeneration}`;
      this.#retirements.set(key, {
        recordRef: input.recordRef,
        sourceChangeGeneration: input.sourceChangeGeneration,
        formerCryptoObjectId: current.protectedCryptoObjectId,
        completed: false,
      });
    }
    return "applied";
  }

  async recordProtectedCryptoComplete(input: Parameters<AuthorityProjectionStorePort["recordProtectedCryptoComplete"]>[0]): Promise<"recorded" | "replayed" | "stale" | "blocked"> {
    const key = `${input.recordRef}:${input.sourceChangeGeneration}`;
    const receipt = this.#receipts.get(key);
    const current = this.#current.get(input.recordRef);
    if (receipt !== undefined && (receipt.expectedProjectionGeneration !== input.expectedProjectionGeneration
      || (receipt.targetCryptoObjectId !== null && (receipt.targetCryptoObjectId !== input.targetCryptoObjectId
        || receipt.targetRepresentationGeneration !== input.targetRepresentationGeneration)))) return "stale";
    if (receipt?.targetAccessNamespaceIds != null && (JSON.stringify(receipt.targetAccessNamespaceIds) !== JSON.stringify(input.targetAccessNamespaceIds)
      || !equalBytes(receipt.targetAudienceSetCommitment, input.targetAudienceSetCommitment))) throw new TypeError("Protected authority target access conflicts with its receipt");
    if (receipt?.state === "quarantined" || receipt?.targetCryptoRetiredAt != null) return "stale";
    const logicalApplied = current !== undefined && current.projectionGeneration === input.expectedProjectionGeneration + 1
      && current.sourceChangeGeneration === input.sourceChangeGeneration && current.processingState === "current"
      && receipt?.completedAt != null && equalBytes(current.audienceSetCommitment, input.targetAudienceSetCommitment);
    if (receipt?.state === "complete" && receipt.targetCryptoObjectId === input.targetCryptoObjectId
      && current?.protectedCryptoObjectId === input.targetCryptoObjectId && current.representationGeneration === input.targetRepresentationGeneration) return "replayed";
    if (receipt?.state === "complete" && receipt.targetCryptoObjectId !== null) return "stale";
    const blocked = current !== undefined && (current.recordDisposition !== "available" || await this.isImmediatelyBlocked({recordRef: input.recordRef, terminalAuthorityLeafHandles: current.terminalAuthorityLeafHandles}) !== null);
    const stale = current === undefined || (current.projectionGeneration !== input.expectedProjectionGeneration && !logicalApplied)
      || (this.#pendingSourceGeneration.get(input.recordRef) ?? 0) > input.sourceChangeGeneration
      || current.representationGeneration + 1 !== input.targetRepresentationGeneration || current.protectedCryptoObjectId === input.targetCryptoObjectId;
    if (receipt?.state === "crypto_complete" && !blocked && !stale) return "replayed";
    this.#receipts.set(key, {...(receipt ?? emptyReceipt(input)), state: blocked || stale ? "quarantined" : "crypto_complete",
      targetCryptoObjectId: input.targetCryptoObjectId, targetRepresentationGeneration: input.targetRepresentationGeneration,
      targetAccessNamespaceIds: [...input.targetAccessNamespaceIds], targetAudienceSetCommitment: input.targetAudienceSetCommitment.slice(),
      formerCryptoObjectId: receipt?.formerCryptoObjectId ?? current?.protectedCryptoObjectId ?? null});
    return blocked ? "blocked" : stale ? "stale" : "recorded";
  }

  claimDueReconciliations(
    limit: number,
    exact?: Parameters<AuthorityProjectionStorePort["claimDueReconciliations"]>[1],
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new RangeError("Authority reconciliation claim limit must be 1..256");
    }
    if (
      exact !== undefined
      && (
        exact.recordRef.trim().length === 0
        || !Number.isSafeInteger(exact.sourceChangeGeneration)
        || exact.sourceChangeGeneration < 1
      )
    ) {
      throw new TypeError("Exact authority reconciliation claim is invalid");
    }
    if (exact !== undefined) {
      const key = `${exact.recordRef}:${exact.sourceChangeGeneration}`;
      const current = this.#current.get(exact.recordRef);
      if (
        !this.#work.has(key)
        && current?.sourceChangeGeneration === exact.sourceChangeGeneration
        && (current.processingState === "dirty"
          || current.processingState === "reconciling")
      ) {
        this.#work.set(key, {
          recordRef: exact.recordRef,
          expectedProjectionGeneration: current.projectionGeneration,
          sourceChangeGeneration: exact.sourceChangeGeneration,
          state: "pending",
          attemptCount: 0,
        });
      }
    }
    const now = Date.now();
    const claimed = [...this.#work.values()]
      .filter((entry) =>
        (exact === undefined
          || (entry.recordRef === exact.recordRef
            && entry.sourceChangeGeneration === exact.sourceChangeGeneration))
        && entry.attemptCount < 8
        && (entry.state === "pending"
          || (entry.state === "leased"
            && (entry.leaseExpiresAt?.getTime() ?? 0) <= now))
        && (entry.nextAttemptAt?.getTime() ?? 0) <= now)
      .sort((left, right) =>
        left.sourceChangeGeneration - right.sourceChangeGeneration
        || left.recordRef.localeCompare(right.recordRef))
      .slice(0, limit)
      .map((entry) => {
        entry.state = "leased";
        entry.attemptCount += 1;
        entry.leaseToken = `authority-lease-${this.#nextLease}`;
        this.#nextLease += 1;
        entry.leaseExpiresAt = new Date(now + 2 * 60 * 1_000);
        const projection = this.#current.get(entry.recordRef);
        if (projection?.processingState === "dirty") {
          this.#current.set(entry.recordRef, {
            ...projection,
            processingState: "reconciling",
          });
        }
        return {
          recordRef: entry.recordRef,
          expectedProjectionGeneration: entry.expectedProjectionGeneration,
          sourceChangeGeneration: entry.sourceChangeGeneration,
          leaseToken: entry.leaseToken,
          attemptCount: entry.attemptCount,
          ...(entry.sealedCheckpoint === undefined
            ? {}
            : { sealedCheckpoint: entry.sealedCheckpoint.slice() }),
        };
      });
    return Promise.resolve(claimed);
  }

  deferReconciliation(input: Readonly<{
    recordRef: string;
    sourceChangeGeneration: number;
    leaseToken: string;
    sealedCheckpoint?: Uint8Array;
    failureCode?: AuthorityReconciliationFailureCode;
    nextAttemptAt: Date;
    terminal: boolean;
  }>): Promise<"deferred" | "retry_exhausted" | "quarantined" | "conflict"> {
    const entry = this.#work.get(`${input.recordRef}:${input.sourceChangeGeneration}`);
    if (
      entry === undefined
      || entry.state !== "leased"
      || entry.leaseToken !== input.leaseToken
      || !Number.isFinite(input.nextAttemptAt.getTime())
    ) return Promise.resolve("conflict");
    const checkpointOnly = input.sealedCheckpoint !== undefined
      && input.failureCode === undefined
      && !input.terminal;
    const exhausted = !checkpointOnly && entry.attemptCount >= 8;
    if (checkpointOnly) entry.attemptCount = Math.max(0, entry.attemptCount - 1);
    entry.state = input.terminal || exhausted ? "quarantined" : "pending";
    delete entry.leaseToken;
    delete entry.leaseExpiresAt;
    entry.nextAttemptAt = input.nextAttemptAt;
    if (input.sealedCheckpoint === undefined) delete entry.sealedCheckpoint;
    else entry.sealedCheckpoint = input.sealedCheckpoint.slice();
    if (input.failureCode === undefined) delete entry.failureCode;
    else entry.failureCode = input.failureCode;
    const projection = this.#current.get(entry.recordRef);
    if (projection?.processingState === "reconciling") {
      this.#current.set(entry.recordRef, { ...projection, processingState: "dirty" });
    }
    return Promise.resolve(input.terminal
      ? "quarantined"
      : exhausted
        ? "retry_exhausted"
        : "deferred");
  }

  async withProtectedRetirementFence(input: Readonly<{recordRef: string; sourceChangeGeneration: number; cryptoObjectId: string; kind: "former" | "target"}>, retire: () => Promise<void>): Promise<"completed" | "replayed" | "conflict"> {
    const key = `${input.recordRef}:${input.sourceChangeGeneration}`, receipt = this.#receipts.get(key);
    if (receipt === undefined || (input.kind === "target" ? receipt.state !== "quarantined" || receipt.targetCryptoObjectId !== input.cryptoObjectId
      : receipt.state !== "complete" || receipt.formerCryptoObjectId !== input.cryptoObjectId)
      || [...this.#current.values()].some(entry => entry.protectedCryptoObjectId === input.cryptoObjectId)) return "conflict";
    if ((input.kind === "target" ? receipt.targetCryptoRetiredAt : receipt.formerCryptoRetiredAt) !== null) return "replayed";
    await retire();
    this.#receipts.set(key, {...receipt, ...(input.kind === "target" ? {targetCryptoRetiredAt: new Date()} : {formerCryptoRetiredAt: new Date()})});
    if (input.kind === "former") {
      const retirement = this.#retirements.get(key); if (retirement !== undefined) this.#retirements.set(key, {...retirement, completed: true});
    }
    return "completed";
  }

  async listDueProtectedTargetRetirements(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new RangeError("Authority retirement limit must be 1..256");
    const result: {recordRef: string; sourceChangeGeneration: number; targetCryptoObjectId: string}[] = [];
    for (const [key, receipt] of this.#receipts) {
      if (result.length >= limit) break;
      if (receipt.targetCryptoObjectId === null || receipt.targetCryptoRetiredAt !== null
        || [...this.#current.values()].some(current => current.protectedCryptoObjectId === receipt.targetCryptoObjectId)) continue;
      let candidate = receipt;
      if (receipt.state === "crypto_complete" || receipt.state === "attached") {
        const current = this.#current.get(receipt.recordRef);
        if ((this.#pendingSourceGeneration.get(receipt.recordRef) ?? 0) > receipt.sourceChangeGeneration || current === undefined
          || current.recordDisposition !== "available" || await this.isImmediatelyBlocked({recordRef: receipt.recordRef, terminalAuthorityLeafHandles: current.terminalAuthorityLeafHandles}) !== null) {
          candidate = {...receipt, state: "quarantined"}; this.#receipts.set(key, candidate);
        }
      }
      if (candidate.state === "quarantined") result.push({recordRef: candidate.recordRef, sourceChangeGeneration: candidate.sourceChangeGeneration, targetCryptoObjectId: candidate.targetCryptoObjectId!});
    }
    return result;
  }

  completeProtectedTargetRetirement(input: Readonly<{recordRef: string; sourceChangeGeneration: number; targetCryptoObjectId: string}>) {
    return this.withProtectedRetirementFence({...input, cryptoObjectId: input.targetCryptoObjectId, kind: "target"}, () => Promise.resolve());
  }

  listDueProtectedRetirements(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new RangeError("Authority retirement limit must be 1..256");
    }
    return Promise.resolve([...this.#retirements.values()]
      .filter((entry) => !entry.completed)
      .slice(0, limit)
      .map(({ completed: _, ...entry }) => entry));
  }

  completeProtectedRetirement(input: Readonly<{
    recordRef: string;
    sourceChangeGeneration: number;
    formerCryptoObjectId: string;
  }>): Promise<"completed" | "replayed" | "conflict"> {
    const key = `${input.recordRef}:${input.sourceChangeGeneration}`;
    const existing = this.#retirements.get(key);
    if (existing === undefined || existing.formerCryptoObjectId !== input.formerCryptoObjectId) {
      return Promise.resolve("conflict");
    }
    if (existing.completed) return Promise.resolve("replayed");
    if ([...this.#current.values()].some(entry => entry.protectedCryptoObjectId === input.formerCryptoObjectId)) return Promise.resolve("conflict");
    this.#retirements.set(key, { ...existing, completed: true });
    const receipt = this.#receipts.get(key);
    if (receipt !== undefined) this.#receipts.set(key, {...receipt, formerCryptoRetiredAt: new Date()});
    return Promise.resolve("completed");
  }

  block(input: Readonly<{
    blockRef: string;
    recordRef?: string;
    terminalAuthorityLeafHandle?: string;
    disposition: "blocked" | "purged";
  }>): Promise<"applied" | "replayed" | "conflict"> {
    if ((input.recordRef === undefined) === (input.terminalAuthorityLeafHandle === undefined)) {
      return Promise.resolve("conflict");
    }
    const target = input.recordRef === undefined
      ? this.#blocksByLeaf
      : this.#blocksByRecord;
    const key = input.recordRef ?? input.terminalAuthorityLeafHandle!;
    const existing = target.get(key);
    if (existing !== undefined) {
      if (existing === input.disposition) return Promise.resolve("replayed");
      if (existing === "blocked" && input.disposition === "purged") {
        target.set(key, "purged");
        if (input.recordRef !== undefined) {
          const current = this.#current.get(input.recordRef);
          if (current !== undefined) {
            this.#current.set(input.recordRef, {
              ...current,
              recordDisposition: "purged",
            });
          }
        }
        return Promise.resolve("applied");
      }
      return Promise.resolve("conflict");
    }
    target.set(key, input.disposition);
    if (input.recordRef !== undefined) {
      const current = this.#current.get(input.recordRef);
      if (current !== undefined) {
        this.#current.set(input.recordRef, {
          ...current,
          recordDisposition: input.disposition,
        });
      }
    }
    return Promise.resolve("applied");
  }

  readContentFreeHealth(
    representation: "ordinary" | "protected",
  ) {
    const counts = {
      current: 0,
      dirty: 0,
      reconciling: 0,
      unavailable: 0,
      purged: 0,
    };
    for (const projection of this.#current.values()) counts[projection.processingState] += 1;
    const work = [...this.#work.values()];
    return Promise.resolve({
      selectedRepresentation: representation,
      currentCount: counts.current,
      dirtyCount: counts.dirty,
      reconcilingCount: counts.reconciling,
      unavailableCount: counts.unavailable,
      purgedCount: counts.purged,
      oldestDirtyAt: null,
      maximumAttemptCount: Math.max(0, ...work.map((entry) => entry.attemptCount)),
      retryExhaustedCount: work.filter((entry) =>
        entry.state === "quarantined" && entry.attemptCount >= 8).length,
    });
  }
}

export function createSyntheticAuthorityCommitments(
  secret = "synthetic-authority-test-key",
): AuthorityProjectionCommitmentPort {
  const key = new TextEncoder().encode(secret.padEnd(32, "\0"));
  return createHmacAuthorityProjectionCheckpointPort(key);
}

export class InMemoryProtectedAuthorityRepublisher implements ProtectedAuthorityRepublisherPort {
  readonly publications: Array<Readonly<{
    recordRef: string;
    expectedRepresentationGeneration: number;
    targetRepresentationGeneration: number;
    exactAccessNamespaceIds: readonly string[];
    workBindingRef: string;
  }>> = [];
  readonly retired: string[] = [];
  failNext = false;
  failRetirement = false;

  constructor(private readonly projections?: AuthorityProjectionStorePort) {}

  async republishExact(input: Parameters<ProtectedAuthorityRepublisherPort["republishExact"]>[0]) {
    this.publications.push({ ...input, exactAccessNamespaceIds: [...input.exactAccessNamespaceIds] });
    if (this.failNext) {
      this.failNext = false;
      return Promise.resolve({ status: "unavailable" as const, reason: "storage_transient" as const });
    }
    if (this.projections === undefined) throw new Error("Synthetic protected republisher requires its projection store");
    const cryptoObjectId = `authority-object:${input.recordRef}:${input.targetRepresentationGeneration}`;
    const attachment = await input.attach({cryptoObjectId, authorizeCommit: () => Promise.resolve(Date.now()), projections: this.projections});
    return {status: "published" as const, cryptoObjectId, attachment};
  }

  retire(cryptoObjectId: string): Promise<void> {
    if (this.failRetirement) {
      this.failRetirement = false;
      return Promise.reject(new Error("synthetic retirement failure"));
    }
    this.retired.push(cryptoObjectId);
    return Promise.resolve();
  }
}
