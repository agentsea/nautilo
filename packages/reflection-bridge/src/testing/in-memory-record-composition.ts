import {
  assertLifecycleTransition,
  assertNewRecordStructure,
  assertSuccessorStructure,
  type DirectRecordDispositionMutation,
  type DirectRecordDispositionResult,
  type DurableRecordLifecycleMutation,
  type DurableRecordLifecycleMutationResult,
  type DurableRecordEnvelope,
  type DurableRecordPublication,
  type DurableRecordPublicationResult,
  type HierarchyStructuralRecord,
  type HierarchyStructuralView,
  type SuccessorEdge,
} from "@nautilo/reflection/durable";

import type {
  ProtectedRecordPublicationPort,
  RecordProductPublicationReservation,
  RecordProductStorePort,
  RecordProductVisibleRow,
  RecordRepositoryFailureCode,
  ProtectedRecordFailureDisposition,
  ProtectedRecordRetirement,
} from "../server/contracts";

interface StoredRecord {
  envelope: DurableRecordEnvelope;
  disposition: "available" | "blocked" | "purged";
  ordinary?: Uint8Array;
  protectedObjectId?: string;
}

interface Receipt {
  readonly recordId: string;
  readonly commitment: Uint8Array;
  readonly representation: "ordinary" | "protected";
  readonly replay?: NonNullable<import("../server/contracts").ClaimedProtectedRecordPublication["replay"]>;
  state: "reserved" | "crypto_complete" | "product_attached" | "complete" | "blocked" | "quarantined";
  cryptoObjectId?: string;
  reservedCryptoObjectId?: string;
  attemptCount: number;
  leaseToken?: string;
  terminalDisposition?: "blocked" | "purged";
  cryptoRetired?: boolean;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((value, index) => value === right[index]);
}

function structural(envelope: DurableRecordEnvelope): HierarchyStructuralRecord {
  return {
    recordRef: envelope.recordRef,
    lifecycle: envelope.lifecycle,
    structuralHeight: envelope.structuralHeight,
    statement: envelope.semantic.statement,
    anchorRefs: envelope.semantic.anchors.map((anchor) => anchor.anchorRef),
    sourceRefs: envelope.semantic.sourceDependencies.map((source) => source.logicalSourceRef),
    childRecordRefs: envelope.semantic.childRecordRefs,
  };
}

/** Hermetic conformance store; production uses the PostgreSQL adapter. */
export class InMemoryRecordProductStore implements RecordProductStorePort {
  readonly #records = new Map<string, StoredRecord>();
  readonly #receipts = new Map<string, Receipt>();
  readonly #successors = new Map<string, SuccessorEdge>();

  readonly #view: HierarchyStructuralView = {
    getRecord: (recordRef) => {
      const value = this.#records.get(recordRef);
      return value === undefined ? undefined : structural(value.envelope);
    },
    successorEdgesFrom: (recordRef) => {
      const edge = this.#successors.get(recordRef);
      return edge === undefined ? [] : [edge];
    },
  };

  readCompletedPublicationRecordId(input: Readonly<{
    idempotencyKey: string;
  }>): Promise<
    | { readonly status: "available"; readonly recordId: string }
    | {
        readonly status: "unavailable";
        readonly reason: "not_found" | "incomplete" | "blocked" | "purged";
      }
  > {
    const receipt = this.#receipts.get(input.idempotencyKey);
    if (receipt === undefined) {
      return Promise.resolve({ status: "unavailable", reason: "not_found" });
    }
    const disposition = this.#records.get(receipt.recordId)?.disposition;
    if (disposition === "blocked" || disposition === "purged") {
      return Promise.resolve({ status: "unavailable", reason: disposition });
    }
    if (receipt.state !== "complete") {
      return Promise.resolve({ status: "unavailable", reason: "incomplete" });
    }
    return Promise.resolve({ status: "available", recordId: receipt.recordId });
  }

  publishOrdinary(input: Readonly<{
    publication: DurableRecordPublication;
    payloadBytes: Uint8Array;
    requestCommitment: Uint8Array;
  }>): Promise<DurableRecordPublicationResult> {
    const replay = this.#receiptReplay(input.publication, input.requestCommitment);
    if (replay !== null) return Promise.resolve(replay);
    try {
      this.#validate(input.publication);
    } catch {
      return Promise.resolve({ status: "rejected", recordRef: input.publication.record.recordRef, reason: "structural_conflict" });
    }
    this.#attach(input.publication, { ordinary: input.payloadBytes.slice() });
    this.#receipts.set(input.publication.idempotencyKey, {
      recordId: input.publication.record.recordRef,
      commitment: input.requestCommitment.slice(),
      representation: "ordinary",
      state: "complete",
      attemptCount: 0,
    });
    return Promise.resolve({ status: "published", record: input.publication.record });
  }

  transitionLifecycle(
    input: DurableRecordLifecycleMutation,
  ): Promise<DurableRecordLifecycleMutationResult> {
    const record = this.#records.get(input.recordRef);
    if (record === undefined) {
      return Promise.resolve({
        status: "not_found",
        recordRef: input.recordRef,
        replayed: false,
      });
    }
    if (record.disposition !== "available") {
      return Promise.resolve({
        status: record.disposition,
        recordRef: input.recordRef,
        replayed: false,
      });
    }
    if (
      record.envelope.lifecycle === input.to
      && record.envelope.processingGeneration
        === input.expectedProcessingGeneration + 1
    ) {
      return Promise.resolve({
        status: "transitioned",
        recordRef: input.recordRef,
        lifecycle: input.to,
        replayed: true,
      });
    }
    try {
      assertLifecycleTransition(input.from, input.to, {
        successorAttached: false,
      });
    } catch {
      return Promise.resolve({
        status: "conflict",
        recordRef: input.recordRef,
        replayed: false,
      });
    }
    if (
      record.envelope.processingGeneration
        !== input.expectedProcessingGeneration
      || record.envelope.lifecycle !== input.from
    ) {
      return Promise.resolve({
        status: "conflict",
        recordRef: input.recordRef,
        replayed: false,
      });
    }
    record.envelope = {
      ...record.envelope,
      lifecycle: input.to,
      processingGeneration: input.expectedProcessingGeneration + 1,
    };
    return Promise.resolve({
      status: "transitioned",
      recordRef: input.recordRef,
      lifecycle: input.to,
      replayed: false,
    });
  }

  reserveProtected(input: Readonly<{
    publication: DurableRecordPublication;
    requestCommitment: Uint8Array;
  }>): Promise<RecordProductPublicationReservation> {
    const existing = this.#receipts.get(input.publication.idempotencyKey);
    if (existing !== undefined) {
      const disposition = this.#records.get(existing.recordId)?.disposition;
      if (disposition === "blocked" || disposition === "purged") {
        return Promise.resolve({ status: disposition, recordId: existing.recordId });
      }
      if (
        existing.recordId !== input.publication.record.recordRef
        || !equalBytes(existing.commitment, input.requestCommitment)
        || existing.representation !== "protected"
      ) return Promise.resolve({ status: "conflict", recordId: input.publication.record.recordRef });
      if (existing.state === "blocked" || existing.state === "quarantined") {
        return Promise.resolve({
          status: existing.terminalDisposition ?? "blocked",
          recordId: existing.recordId,
        });
      }
      return Promise.resolve({
        status: "replayed",
        recordId: existing.recordId,
        state: existing.state,
        ...(existing.cryptoObjectId === undefined ? {} : { cryptoObjectId: existing.cryptoObjectId }),
      });
    }
    const record = this.#records.get(input.publication.record.recordRef);
    if (record?.disposition === "blocked") return Promise.resolve({ status: "blocked", recordId: record.envelope.recordRef });
    if (record?.disposition === "purged") return Promise.resolve({ status: "purged", recordId: record.envelope.recordRef });
    if ([...this.#receipts.values()].some((receipt) =>
      receipt.recordId === input.publication.record.recordRef
      && receipt.representation === "protected"
    )) {
      return Promise.resolve({
        status: "conflict",
        recordId: input.publication.record.recordRef,
      });
    }
    this.#receipts.set(input.publication.idempotencyKey, {
      recordId: input.publication.record.recordRef,
      commitment: input.requestCommitment.slice(),
      representation: "protected",
      replay: {
        publicationBindingRef: input.publication.publicationBindingRef,
        ...(input.publication.originPublicationBindingRef === undefined
          ? {}
          : {
              originPublicationBindingRef:
                input.publication.originPublicationBindingRef,
            }),
        requestCommitment: input.requestCommitment.slice(),
        structuralHeight: input.publication.record.structuralHeight,
        processingGeneration: input.publication.record.processingGeneration,
        ...(input.publication.predecessor === undefined
          ? {}
          : { predecessor: { ...input.publication.predecessor } }),
      },
      state: "reserved",
      attemptCount: 0,
    });
    return Promise.resolve({ status: "reserved", recordId: input.publication.record.recordRef });
  }

  bindProtectedOutput(input: Readonly<{
    idempotencyKey: string;
    recordId: string;
    cryptoObjectId: string;
    requestCommitment: Uint8Array;
  }>): Promise<"updated" | "replayed" | "blocked" | "conflict"> {
    const receipt = this.#receipts.get(input.idempotencyKey);
    if (
      receipt === undefined
      || receipt.recordId !== input.recordId
      || receipt.representation !== "protected"
      || !equalBytes(receipt.commitment, input.requestCommitment)
    ) return Promise.resolve("conflict");
    if (receipt.state === "blocked" || receipt.state === "quarantined") {
      return Promise.resolve("blocked");
    }
    if (
      (receipt.reservedCryptoObjectId !== undefined
        && receipt.reservedCryptoObjectId !== input.cryptoObjectId)
      || (receipt.cryptoObjectId !== undefined
        && receipt.cryptoObjectId !== input.cryptoObjectId)
    ) return Promise.resolve("conflict");
    if (receipt.reservedCryptoObjectId === input.cryptoObjectId) {
      return Promise.resolve("replayed");
    }
    receipt.reservedCryptoObjectId = input.cryptoObjectId;
    return Promise.resolve("updated");
  }

  markProtectedCryptoComplete(input: Readonly<{ idempotencyKey: string; recordId: string; cryptoObjectId: string; leaseToken?: string }>): Promise<"updated" | "replayed" | "blocked" | "conflict"> {
    const receipt = this.#receipts.get(input.idempotencyKey);
    if (receipt === undefined || receipt.recordId !== input.recordId) return Promise.resolve("conflict");
    if (receipt.state === "blocked" || receipt.state === "quarantined") return Promise.resolve("blocked");
    if (input.leaseToken !== undefined && receipt.leaseToken !== input.leaseToken) {
      return Promise.resolve("conflict");
    }
    if (receipt.cryptoObjectId !== undefined && receipt.cryptoObjectId !== input.cryptoObjectId) return Promise.resolve("conflict");
    if (receipt.reservedCryptoObjectId !== undefined && receipt.reservedCryptoObjectId !== input.cryptoObjectId) return Promise.resolve("conflict");
    const replayed = receipt.state !== "reserved";
    receipt.cryptoObjectId = input.cryptoObjectId;
    if (!replayed) {
      receipt.state = "crypto_complete";
      if (input.leaseToken === undefined) delete receipt.leaseToken;
    }
    return Promise.resolve(replayed ? "replayed" : "updated");
  }

  attachProtected(input: Readonly<{
    publication: DurableRecordPublication;
    cryptoObjectId: string;
    requestCommitment: Uint8Array;
    leaseToken?: string;
  }>): Promise<"attached" | "replayed" | "blocked" | "conflict"> {
    const receipt = this.#receipts.get(input.publication.idempotencyKey);
    if (
      receipt === undefined
      || receipt.recordId !== input.publication.record.recordRef
      || receipt.cryptoObjectId !== input.cryptoObjectId
      || !equalBytes(receipt.commitment, input.requestCommitment)
      || (input.leaseToken !== undefined && receipt.leaseToken !== input.leaseToken)
    ) return Promise.resolve("conflict");
    if (receipt.state === "blocked" || receipt.state === "quarantined") return Promise.resolve("blocked");
    if (receipt.state === "product_attached" || receipt.state === "complete") return Promise.resolve("replayed");
    try {
      this.#validate(input.publication);
    } catch {
      return Promise.resolve("conflict");
    }
    this.#attach(input.publication, { protectedObjectId: input.cryptoObjectId });
    receipt.state = "product_attached";
    return Promise.resolve("attached");
  }

  completeProtected(input: Readonly<{ idempotencyKey: string; recordId: string; leaseToken?: string }>): Promise<"complete" | "replayed" | "blocked" | "conflict"> {
    const receipt = this.#receipts.get(input.idempotencyKey);
    if (receipt === undefined || receipt.recordId !== input.recordId) return Promise.resolve("conflict");
    if (receipt.state === "blocked" || receipt.state === "quarantined") return Promise.resolve("blocked");
    if (input.leaseToken !== undefined && receipt.leaseToken !== input.leaseToken) return Promise.resolve("conflict");
    if (receipt.state === "complete") return Promise.resolve("replayed");
    if (receipt.state !== "product_attached") return Promise.resolve("conflict");
    receipt.state = "complete";
    delete receipt.leaseToken;
    return Promise.resolve("complete");
  }

  failProtected(input: Readonly<{ idempotencyKey: string; recordId: string; failureCode: RecordRepositoryFailureCode; terminal: boolean; leaseToken?: string }>): Promise<ProtectedRecordFailureDisposition> {
    const receipt = this.#receipts.get(input.idempotencyKey);
    if (
      receipt === undefined
      || receipt.recordId !== input.recordId
      || (input.leaseToken !== undefined && receipt.leaseToken !== input.leaseToken)
      || receipt.state === "complete"
    ) {
      return Promise.resolve("ignored");
    }
    delete receipt.leaseToken;
    if (!input.terminal && input.failureCode === "authorization_unavailable") {
      return Promise.resolve("scheduled");
    }
    receipt.attemptCount += 1;
    if (input.terminal) {
      receipt.state = "quarantined";
      return Promise.resolve("quarantined");
    }
    if (receipt.attemptCount >= 8) {
      receipt.state = "quarantined";
      return Promise.resolve("retry_exhausted");
    }
    return Promise.resolve("scheduled");
  }

  readVisible(input: Readonly<{ recordId: string; representation: "ordinary" | "protected" }>): Promise<{ status: "available"; row: RecordProductVisibleRow } | { status: "unavailable"; reason: "not_found" | "selected_representation_missing" | "blocked" | "purged" }> {
    const record = this.#records.get(input.recordId);
    if (record === undefined) return Promise.resolve({ status: "unavailable", reason: "not_found" });
    if (record.disposition !== "available") return Promise.resolve({ status: "unavailable", reason: record.disposition });
    if (input.representation === "ordinary" && record.ordinary === undefined) return Promise.resolve({ status: "unavailable", reason: "selected_representation_missing" });
    if (input.representation === "protected" && record.protectedObjectId === undefined) return Promise.resolve({ status: "unavailable", reason: "selected_representation_missing" });
    return Promise.resolve({ status: "available", row: {
      recordId: record.envelope.recordRef,
      lifecycle: record.envelope.lifecycle,
      structuralHeight: record.envelope.structuralHeight,
      processingGeneration: record.envelope.processingGeneration,
      producerPolicyVersion: record.envelope.semantic.producer.policyVersion,
      representation: input.representation,
      representationGeneration: 1,
      ...(record.ordinary === undefined ? {} : { payloadBytes: record.ordinary.slice() }),
      ...(record.protectedObjectId === undefined ? {} : { cryptoObjectId: record.protectedObjectId }),
    } });
  }

  readGraphPage(input: Readonly<{ recordId: string; direction: "dependencies" | "parents" | "successors" | "predecessors"; limit: number; continuation?: string }>): Promise<Readonly<{ items: readonly string[] | readonly SuccessorEdge[]; continuation?: string }>> {
    const offset = input.continuation === undefined ? 0 : Number(input.continuation);
    let items: readonly string[] | readonly SuccessorEdge[];
    if (input.direction === "dependencies") items = this.#records.get(input.recordId)?.envelope.semantic.childRecordRefs ?? [];
    else if (input.direction === "parents") items = [...this.#records.values()].filter((record) => record.envelope.semantic.childRecordRefs.includes(input.recordId)).map((record) => record.envelope.recordRef).sort();
    else if (input.direction === "successors") { const edge = this.#successors.get(input.recordId); items = edge === undefined ? [] : [edge]; }
    else items = [...this.#successors.values()].filter((edge) => edge.successorRecordRef === input.recordId);
    const page = items.slice(offset, offset + input.limit) as readonly string[] | readonly SuccessorEdge[];
    const next = offset + page.length < items.length ? String(offset + page.length) : undefined;
    return Promise.resolve({ items: page, ...(next === undefined ? {} : { continuation: next }) });
  }

  block(input: DirectRecordDispositionMutation): Promise<DirectRecordDispositionResult> {
    return Promise.resolve(this.#dispose(input, "blocked"));
  }

  purge(input: DirectRecordDispositionMutation): Promise<
    DirectRecordDispositionResult & {
      protectedRetirements?: readonly ProtectedRecordRetirement[];
    }
  > {
    const result = this.#dispose(input, "purged");
    const record = this.#records.get(input.recordRef);
    if (record !== undefined) {
      delete record.ordinary;
    }
    const protectedRetirements = [...this.#receipts.entries()]
      .filter(([, receipt]) =>
        receipt.recordId === input.recordRef
        && receipt.representation === "protected"
        && receipt.cryptoObjectId !== undefined
        && receipt.cryptoRetired !== true
      )
      .map(([idempotencyKey, receipt]) => ({
        idempotencyKey,
        recordId: receipt.recordId,
        representationGeneration: 1,
        cryptoObjectId: receipt.cryptoObjectId!,
      }));
    return Promise.resolve({
      ...result,
      ...(protectedRetirements.length === 0 ? {} : { protectedRetirements }),
    });
  }

  claimDueProtected(
    limit: number,
    options?: Readonly<{ requireReservedOutput?: boolean }>,
  ): Promise<readonly import("../server/contracts").ClaimedProtectedRecordPublication[]> {
    return Promise.resolve([...this.#receipts.entries()]
      .filter(([, receipt]) => receipt.representation === "protected"
        && ["reserved", "crypto_complete", "product_attached"].includes(receipt.state)
        && receipt.leaseToken === undefined
        && (options?.requireReservedOutput !== true
          || receipt.reservedCryptoObjectId !== undefined))
      .slice(0, limit)
      .map(([idempotencyKey, receipt], index) => {
        const leaseToken = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
        receipt.leaseToken = leaseToken;
        return {
          idempotencyKey,
          recordId: receipt.recordId,
          state: receipt.state as "reserved" | "crypto_complete" | "product_attached",
          leaseToken,
          ...(receipt.cryptoObjectId === undefined ? {} : { cryptoObjectId: receipt.cryptoObjectId }),
          ...(receipt.reservedCryptoObjectId === undefined
            ? {}
            : { reservedCryptoObjectId: receipt.reservedCryptoObjectId }),
          ...(receipt.replay === undefined
            ? {}
            : {
                replay: {
                  ...receipt.replay,
                  requestCommitment: receipt.replay.requestCommitment.slice(),
                },
              }),
        };
      }));
  }

  listDueProtectedRetirements(
    limit: number,
  ): Promise<readonly ProtectedRecordRetirement[]> {
    return Promise.resolve([...this.#receipts.entries()]
      .filter(([, receipt]) => {
        if (
          receipt.representation !== "protected"
          || receipt.cryptoObjectId === undefined
          || receipt.cryptoRetired === true
        ) return false;
        const record = this.#records.get(receipt.recordId);
        return record?.disposition === "purged"
          || (
            ["blocked", "quarantined"].includes(receipt.state)
            && record?.protectedObjectId !== receipt.cryptoObjectId
          );
      })
      .slice(0, limit)
      .map(([idempotencyKey, receipt]) => ({
        idempotencyKey,
        recordId: receipt.recordId,
        representationGeneration: 1,
        cryptoObjectId: receipt.cryptoObjectId!,
      })));
  }

  completeProtectedRetirement(
    input: ProtectedRecordRetirement,
  ): Promise<"completed" | "replayed" | "conflict"> {
    const receipt = this.#receipts.get(input.idempotencyKey);
    if (
      receipt === undefined
      || receipt.recordId !== input.recordId
      || receipt.cryptoObjectId !== input.cryptoObjectId
      || input.representationGeneration !== 1
    ) return Promise.resolve("conflict");
    if (receipt.cryptoRetired === true) return Promise.resolve("replayed");
    const record = this.#records.get(input.recordId);
    if (record?.protectedObjectId === input.cryptoObjectId) {
      if (record.disposition !== "purged") return Promise.resolve("conflict");
      delete record.protectedObjectId;
    }
    receipt.cryptoRetired = true;
    return Promise.resolve("completed");
  }

  #receiptReplay(publication: DurableRecordPublication, commitment: Uint8Array): DurableRecordPublicationResult | null {
    const receipt = this.#receipts.get(publication.idempotencyKey);
    if (receipt === undefined) return null;
    const disposition = this.#records.get(publication.record.recordRef)?.disposition;
    if (disposition === "blocked" || disposition === "purged") {
      return { status: "rejected", recordRef: publication.record.recordRef, reason: disposition };
    }
    if (receipt.recordId !== publication.record.recordRef || !equalBytes(receipt.commitment, commitment) || receipt.representation !== "ordinary") return { status: "rejected", recordRef: publication.record.recordRef, reason: "idempotency_conflict" };
    return { status: "replayed", record: publication.record };
  }

  #validate(publication: DurableRecordPublication): void {
    if (publication.predecessor === undefined) assertNewRecordStructure({ record: structural(publication.record), view: this.#view, requireCurrent: true });
    else assertSuccessorStructure({ predecessorRecordRef: publication.predecessor.recordRef, successor: structural(publication.record), relation: publication.predecessor.relation, view: this.#view });
  }

  #attach(publication: DurableRecordPublication, representation: { ordinary?: Uint8Array; protectedObjectId?: string }): void {
    this.#records.set(publication.record.recordRef, { envelope: publication.record, disposition: "available", ...representation });
    if (publication.predecessor !== undefined) {
      const predecessor = this.#records.get(publication.predecessor.recordRef)!;
      predecessor.envelope = { ...predecessor.envelope, lifecycle: publication.predecessor.relation === "supersedes" ? "superseded" : "resolved" };
      this.#successors.set(publication.predecessor.recordRef, { predecessorRecordRef: publication.predecessor.recordRef, successorRecordRef: publication.record.recordRef, relation: publication.predecessor.relation });
    }
  }

  #dispose(input: DirectRecordDispositionMutation, target: "blocked" | "purged"): DirectRecordDispositionResult {
    const record = this.#records.get(input.recordRef);
    const receipts = [...this.#receipts.values()].filter((receipt) => receipt.recordId === input.recordRef);
    if (record === undefined && receipts.length === 0) return { status: "not_found", recordRef: input.recordRef, replayed: false };
    const replayed = record?.disposition === target;
    if (record !== undefined) record.disposition = target;
    for (const receipt of receipts) {
      receipt.state = "blocked";
      receipt.terminalDisposition = target;
    }
    return { status: target, recordRef: input.recordRef, replayed };
  }
}

export class InMemoryProtectedRecordPublicationPort implements ProtectedRecordPublicationPort {
  readonly #payloads = new Map<string, Uint8Array>();
  readonly #retired = new Set<string>();

  publish(input: Readonly<{ recordId: string; representationGeneration: number; payloadBytes: Uint8Array; publicationBindingRef: string }>): Promise<{ status: "created" | "duplicate"; objectId: string }> {
    const objectId = `record:${input.recordId}:generation:${input.representationGeneration}`;
    const existing = this.#payloads.get(objectId);
    this.#payloads.set(objectId, existing ?? input.payloadBytes.slice());
    return Promise.resolve({ status: existing === undefined ? "created" : "duplicate", objectId });
  }
  verify(input: Readonly<{ objectId: string }>): Promise<"complete" | "absent" | "incomplete" | "mismatch"> { return Promise.resolve(this.#payloads.has(input.objectId) && !this.#retired.has(input.objectId) ? "complete" : "absent"); }
  open(input: Readonly<{ objectId: string }>): Promise<{ status: "available"; payloadBytes: Uint8Array } | { status: "unavailable"; reason: "not_found" }> { const payload = this.#payloads.get(input.objectId); return Promise.resolve(payload === undefined || this.#retired.has(input.objectId) ? { status: "unavailable", reason: "not_found" } : { status: "available", payloadBytes: payload.slice() }); }
  retire(objectId: string): Promise<void> { this.#retired.add(objectId); return Promise.resolve(); }
}
