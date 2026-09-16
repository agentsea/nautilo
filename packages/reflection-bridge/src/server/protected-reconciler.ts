import { timingSafeEqual } from "node:crypto";

import type { DurableRecordPublication } from "@nautilo/reflection/durable";

import type {
  ClaimedProtectedRecordPublication,
  ProtectedRecordPublicationPort,
  RecordRequestCommitmentPort,
  RecordProductStorePort,
} from "./contracts";
import { decodeDurableRecordEnvelope } from "./record-mapping";

export type ProtectedRecordReconciliationOutcome =
  | "waiting_for_replay"
  | "attached"
  | "completed"
  | "retired"
  | "cleanup_pending"
  | "quarantined"
  | "retry_exhausted";

/** Reconstruct and authenticate the exact durable publication saved for replay. */
export function recoverVerifiedRecordPublication(
  item: ClaimedProtectedRecordPublication,
  plaintext: Uint8Array,
  commitment: RecordRequestCommitmentPort,
): DurableRecordPublication | null {
  const replay = item.replay;
  if (replay === undefined) return null;
  let calculated: Uint8Array | undefined;
  try {
    const publication: DurableRecordPublication = {
      record: decodeDurableRecordEnvelope({
        recordRef: item.recordId,
        lifecycle: "current",
        structuralHeight: replay.structuralHeight,
        processingGeneration: replay.processingGeneration,
        payloadBytes: plaintext,
      }),
      idempotencyKey: item.idempotencyKey,
      publicationBindingRef: replay.publicationBindingRef,
      ...(replay.originPublicationBindingRef === undefined
        ? {}
        : { originPublicationBindingRef: replay.originPublicationBindingRef }),
      ...(replay.predecessor === undefined
        ? {}
        : { predecessor: replay.predecessor }),
    };
    calculated = commitment.commit(plaintext, publication);
    return calculated.byteLength === replay.requestCommitment.byteLength
      && timingSafeEqual(calculated, replay.requestCommitment)
      ? publication
      : null;
  } catch {
    return null;
  } finally {
    calculated?.fill(0);
  }
}

/**
 * Content-free recovery. A reservation with no object deliberately waits for
 * exact caller replay because neither plaintext nor authority is persisted.
 */
export class ProtectedRecordPublicationReconciler {
  constructor(
    private readonly product: RecordProductStorePort,
    private readonly crypto: ProtectedRecordPublicationPort,
    private readonly commitment?: RecordRequestCommitmentPort,
  ) {}

  async reconcile(limit: number): Promise<readonly ProtectedRecordReconciliationOutcome[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new RangeError("Protected Record reconciliation limit must be 1..256");
    }
    const outcomes: ProtectedRecordReconciliationOutcome[] = [];
    const retirements = await this.product.listDueProtectedRetirements(limit);
    for (const retirement of retirements) {
      try {
        await this.crypto.retire(retirement.cryptoObjectId);
        const completed = await this.product.completeProtectedRetirement(retirement);
        outcomes.push(completed === "conflict" ? "cleanup_pending" : "retired");
      } catch {
        outcomes.push("cleanup_pending");
      }
    }
    const remaining = limit - outcomes.length;
    if (remaining === 0) return outcomes;
    const due = await this.product.claimDueProtected(remaining);
    for (const item of due) {
      try {
        outcomes.push(await this.reconcileClaim(item));
      } finally {
        item.replay?.requestCommitment.fill(0);
      }
    }
    return outcomes;
  }

  /** May join an already-held Lattice recovery transaction with an exact receipt lease. */
  async reconcileClaim(
    item: ClaimedProtectedRecordPublication,
  ): Promise<ProtectedRecordReconciliationOutcome> {
    const cryptoObjectId = item.cryptoObjectId ?? item.reservedCryptoObjectId;
    if (item.state === "reserved" && cryptoObjectId === undefined) {
      const failure = await this.product.failProtected({
        idempotencyKey: item.idempotencyKey,
        recordId: item.recordId,
        failureCode: "crypto_absent",
        terminal: false,
        leaseToken: item.leaseToken,
      });
      return failure === "retry_exhausted" ? failure : "waiting_for_replay";
    }
    if (cryptoObjectId === undefined) {
      await this.product.failProtected({
        idempotencyKey: item.idempotencyKey,
        recordId: item.recordId,
        failureCode: "crypto_mismatch",
        terminal: true,
        leaseToken: item.leaseToken,
      });
      return "quarantined";
    }
    const verified = await this.crypto.verify({
      objectId: cryptoObjectId,
      recordId: item.recordId,
      representationGeneration: 1,
    });
    if (verified !== "complete") {
      const terminal = verified === "mismatch" || item.state === "product_attached";
      const failure = await this.product.failProtected({
        idempotencyKey: item.idempotencyKey,
        recordId: item.recordId,
        failureCode: verified === "absent"
          ? "crypto_absent"
          : verified === "incomplete"
            ? "crypto_incomplete"
            : "crypto_mismatch",
        terminal,
        leaseToken: item.leaseToken,
      });
      return terminal
        ? "quarantined"
        : failure === "retry_exhausted"
          ? failure
          : "waiting_for_replay";
    }
    if (item.state === "product_attached") {
      const completion = await this.product.completeProtected({
        idempotencyKey: item.idempotencyKey,
        recordId: item.recordId,
        leaseToken: item.leaseToken,
      });
      return completion === "complete" || completion === "replayed"
        ? "completed"
        : "quarantined";
    }
    const replay = item.replay;
    if (replay === undefined || this.commitment === undefined) {
      const failure = await this.product.failProtected({
        idempotencyKey: item.idempotencyKey,
        recordId: item.recordId,
        // Legacy receipts cannot reconstruct authenticated graph facts, and a
        // legacy constructor has no commitment authority. Keep both retryable
        // without consuming a bounded publication attempt.
        failureCode: "authorization_unavailable",
        terminal: false,
        leaseToken: item.leaseToken,
      });
      return failure === "retry_exhausted" ? failure : "waiting_for_replay";
    }
    const opened = await this.crypto.open({
      objectId: cryptoObjectId,
      recordId: item.recordId,
      representationGeneration: 1,
      readBindingRef: replay.publicationBindingRef,
    });
    if (opened.status === "unavailable") {
      const terminal = opened.reason === "integrity_failure";
      const failure = await this.product.failProtected({
        idempotencyKey: item.idempotencyKey,
        recordId: item.recordId,
        failureCode: opened.reason === "unauthorized"
          ? "authorization_unavailable"
          : opened.reason === "not_found"
            ? "crypto_absent"
            : "integrity_failure",
        terminal,
        leaseToken: item.leaseToken,
      });
      return terminal
        ? "quarantined"
        : failure === "retry_exhausted"
          ? failure
          : "waiting_for_replay";
    }
    try {
      const publication = recoverVerifiedRecordPublication(
        item,
        opened.payloadBytes,
        this.commitment,
      );
      if (publication === null) {
        await this.product.failProtected({idempotencyKey: item.idempotencyKey, recordId: item.recordId,
          failureCode: "integrity_failure", terminal: true, leaseToken: item.leaseToken});
        return "quarantined";
      }
      // A reserved pointer is only a lookup hint. Promote it after the saved
      // bytes and replay facts have passed the canonical commitment check.
      if (item.state === "reserved") {
        const marked = await this.product.markProtectedCryptoComplete({
          idempotencyKey: item.idempotencyKey,
          recordId: item.recordId,
          cryptoObjectId,
          leaseToken: item.leaseToken,
        });
        if (marked === "blocked" || marked === "conflict") return "quarantined";
      }
      const attached = await this.product.attachProtected({
        publication,
        cryptoObjectId,
        requestCommitment: replay.requestCommitment,
        leaseToken: item.leaseToken,
      });
      if (attached === "blocked") return "quarantined";
      if (attached === "conflict") {
        await this.product.failProtected({
          idempotencyKey: item.idempotencyKey,
          recordId: item.recordId,
          failureCode: "mapping_conflict",
          terminal: true,
          leaseToken: item.leaseToken,
        });
        return "quarantined";
      }
      const completion = await this.product.completeProtected({
        idempotencyKey: item.idempotencyKey,
        recordId: item.recordId,
        leaseToken: item.leaseToken,
      });
      return completion === "complete" || completion === "replayed"
        ? "completed"
        : "quarantined";
    } finally {
      opened.payloadBytes.fill(0);
    }
  }
}
