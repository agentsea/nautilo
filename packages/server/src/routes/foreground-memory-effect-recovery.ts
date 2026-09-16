import {
  deliverForegroundMemoryMutationEffect,
  type CommittedForegroundMemoryEffectReceipt,
} from "@nautilo/agent";
import {
  and,
  asc,
  eq,
  getSharedDirectDb,
  gt,
  isNotNull,
  isNull,
  inArray,
  lte,
  max,
  memoryCryptoOperations,
  type DirectDatabase,
} from "@nautilo/db";

type PendingReceipt = CommittedForegroundMemoryEffectReceipt & Readonly<{
  sequence: number;
}>;

export interface ForegroundMemoryEffectRecoveryStore {
  snapshotMaximumSequence(): Promise<number | null>;
  nextPending(
    afterSequence: number,
    maximumSequence: number,
  ): Promise<PendingReceipt | null>;
  acknowledge(receipt: PendingReceipt): Promise<
    "acknowledged" | "already_acknowledged"
  >;
}

export interface ForegroundMemoryEffectRecovery {
  start(): void;
  wake(): void;
  stop(): Promise<void>;
}

export function createForegroundMemoryEffectRecovery(input: Readonly<{
  store: ForegroundMemoryEffectRecoveryStore;
  deliver?: typeof deliverForegroundMemoryMutationEffect;
  /** Content-free observation only; receipt or driver errors are never exposed. */
  onPassFailure?: () => void;
}>): ForegroundMemoryEffectRecovery {
  const deliver = input.deliver ?? deliverForegroundMemoryMutationEffect;
  let stopped = false;
  let requested = false;
  let current: Promise<void> | null = null;

  const pass = async (): Promise<void> => {
    const maximum = await input.store.snapshotMaximumSequence();
    if (maximum === null) return;
    let cursor = 0;
    while (!stopped) {
      const receipt = await input.store.nextPending(cursor, maximum);
      if (receipt === null) return;
      cursor = receipt.sequence;
      try {
        await deliver({
          receipt,
          acknowledge: () => input.store.acknowledge(receipt),
        });
      } catch {
        // One corrupt or temporarily undeliverable receipt cannot starve all
        // later committed effects. Its content-free durable row remains
        // unacknowledged for the next wake or restart.
        input.onPassFailure?.();
      }
    }
  };

  const pump = (): void => {
    if (stopped || current !== null) return;
    requested = false;
    current = pass().catch(() => {
      // The durable receipt remains pending for a later wake or restart.
      input.onPassFailure?.();
    }).finally(() => {
      current = null;
      if (requested && !stopped) pump();
    });
  };

  const request = (): void => {
    if (stopped) return;
    requested = true;
    pump();
  };

  return Object.freeze({
    start: request,
    wake: request,
    async stop() {
      stopped = true;
      requested = false;
      await current;
    },
  });
}

export function createPostgresForegroundMemoryEffectRecoveryStore(
  database: () => DirectDatabase = getSharedDirectDb,
): ForegroundMemoryEffectRecoveryStore {
  return Object.freeze({
    async snapshotMaximumSequence() {
      const db = database();
      const rows = await db.select({ sequence: max(memoryCryptoOperations.sequence) })
        .from(memoryCryptoOperations).where(and(
          inArray(memoryCryptoOperations.completion,
            ["complete", "ordinary_fallback"]),
          isNotNull(memoryCryptoOperations.semanticChangeKind),
          isNull(memoryCryptoOperations.semanticChangeAcknowledgedAt),
        ));
      return rows[0]?.sequence ?? null;
    },
    async nextPending(afterSequence: number, maximumSequence: number) {
      const db = database();
      const rows = await db.select({
        sequence: memoryCryptoOperations.sequence,
        operationId: memoryCryptoOperations.operationId,
        memoryId: memoryCryptoOperations.memoryId,
        changeKind: memoryCryptoOperations.semanticChangeKind,
        completion: memoryCryptoOperations.completion,
        acknowledgedAt: memoryCryptoOperations.semanticChangeAcknowledgedAt,
      }).from(memoryCryptoOperations).where(and(
        gt(memoryCryptoOperations.sequence, afterSequence),
        lte(memoryCryptoOperations.sequence, maximumSequence),
        inArray(memoryCryptoOperations.completion,
          ["complete", "ordinary_fallback"]),
        isNotNull(memoryCryptoOperations.semanticChangeKind),
        isNull(memoryCryptoOperations.semanticChangeAcknowledgedAt),
      )).orderBy(asc(memoryCryptoOperations.sequence)).limit(1);
      const row = rows[0];
      if (row === undefined || row.changeKind === null) return null;
      return Object.freeze({ ...row,
        changeKind: row.changeKind,
        completion: "complete" as const,
        acknowledgedAt: null,
      });
    },
    acknowledge: (receipt: PendingReceipt) => database().transaction(async (transaction) => {
      const updated = await transaction.update(memoryCryptoOperations).set({
        semanticChangeAcknowledgedAt: new Date(),
      }).where(and(
        eq(memoryCryptoOperations.sequence, receipt.sequence),
        eq(memoryCryptoOperations.operationId, receipt.operationId),
        eq(memoryCryptoOperations.memoryId, receipt.memoryId),
        eq(memoryCryptoOperations.semanticChangeKind, receipt.changeKind),
        inArray(memoryCryptoOperations.completion,
          ["complete", "ordinary_fallback"]),
        isNull(memoryCryptoOperations.semanticChangeAcknowledgedAt),
      )).returning({ sequence: memoryCryptoOperations.sequence });
      if (updated.length === 1) return "acknowledged" as const;
      const exact = await transaction.select({
        acknowledgedAt: memoryCryptoOperations.semanticChangeAcknowledgedAt,
      }).from(memoryCryptoOperations).where(and(
        eq(memoryCryptoOperations.sequence, receipt.sequence),
        eq(memoryCryptoOperations.operationId, receipt.operationId),
        eq(memoryCryptoOperations.memoryId, receipt.memoryId),
        eq(memoryCryptoOperations.semanticChangeKind, receipt.changeKind),
        inArray(memoryCryptoOperations.completion,
          ["complete", "ordinary_fallback"]),
      )).limit(2);
      if (exact.length === 1 && exact[0]!.acknowledgedAt !== null) {
        return "already_acknowledged" as const;
      }
      throw new Error("Foreground Memory recovery lost its exact effect receipt");
    }, { isolationLevel: "serializable" }),
  });
}

export function installForegroundMemoryEffectRecoveryLifecycle(
  app: Readonly<{
    addHook(name: "onListen", hook: () => void): void;
    addHook(name: "onClose", hook: () => Promise<void>): void;
  }>,
  recovery: ForegroundMemoryEffectRecovery,
): void {
  app.addHook("onListen", () => recovery.start());
  app.addHook("onClose", () => recovery.stop());
}
