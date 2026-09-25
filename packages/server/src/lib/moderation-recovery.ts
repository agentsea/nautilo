import { and, asc, desc, eq, getSharedDirectDb, isNull, moderationActions, or, sql,
  type DirectDatabase } from "@nautilo/db";
import { recoverModerationEffects, type ModerationEffects } from "@nautilo/trust";
import { createReceiptRecoveryPump } from "./receipt-recovery";
import { writeModerationAuditEventOnce } from "./security-audit-log";

export interface ModerationRecoveryCursor {
  /** Keep database precision; converting through Date could skip tied rows. */
  readonly createdAt: string;
  readonly operationId: string;
}

export interface ModerationRecoveryStore {
  snapshotMaximum(): Promise<ModerationRecoveryCursor | null>;
  nextPending(after: ModerationRecoveryCursor | null, maximum: ModerationRecoveryCursor): Promise<ModerationRecoveryCursor | null>;
}

export function createModerationAuditSink(path: string): ModerationEffects["appendAudit"] {
  return event => Promise.resolve().then(() => {
    writeModerationAuditEventOnce(path, {
      kind: "moderation_action", ts: event.createdAt, correlationId: event.operationId,
      requesterUserId: event.requesterUserId, subjectId: event.subjectId,
      action: event.action, roomId: event.roomId,
      // A receipt has a Human id, not a captured Actor or network context.
      actorId: null, ip: "unknown", userAgent: undefined,
    });
  });
}

export function createPostgresModerationRecoveryStore(
  database: () => DirectDatabase = getSharedDirectDb,
): ModerationRecoveryStore {
  const pending = () => or(isNull(moderationActions.auditRecordedAt), isNull(moderationActions.convergedAt),
    and(eq(moderationActions.deleteCommunityMessages, true), isNull(moderationActions.communityMessagesDeletedAt)));
  const fields = { createdAt: sql<string>`${moderationActions.createdAt}::text`, operationId: moderationActions.operationId };
  const coordinate = sql`(${moderationActions.createdAt}, ${moderationActions.operationId})`;
  return Object.freeze({
    async snapshotMaximum() {
      const [row] = await database().select(fields).from(moderationActions).where(pending())
        .orderBy(desc(moderationActions.createdAt), desc(moderationActions.operationId)).limit(1);
      return row ?? null;
    },
    async nextPending(after: ModerationRecoveryCursor | null, maximum: ModerationRecoveryCursor) {
      const [row] = await database().select(fields).from(moderationActions).where(and(pending(),
        sql`${coordinate} <= (${maximum.createdAt}::timestamptz, ${maximum.operationId}::uuid)`,
        after === null ? undefined : sql`${coordinate} > (${after.createdAt}::timestamptz, ${after.operationId}::uuid)`,
      )).orderBy(asc(moderationActions.createdAt), asc(moderationActions.operationId)).limit(1);
      return row ?? null;
    },
  });
}

export function createModerationEffectRecovery(input: Readonly<{
  store: ModerationRecoveryStore;
  effects: ModerationEffects;
  deliver?: typeof recoverModerationEffects;
  /** Content-free observation only: no receipt, identity digest, or driver error. */
  onPassFailure?: (() => void) | undefined;
}>) {
  const deliver = input.deliver ?? recoverModerationEffects;
  return createReceiptRecoveryPump({
    onPassFailure: input.onPassFailure,
    async runPass(isStopped) {
      const maximum = await input.store.snapshotMaximum();
      if (maximum === null) return;
      let cursor: ModerationRecoveryCursor | null = null;
      while (!isStopped()) {
        const receipt = await input.store.nextPending(cursor, maximum);
        if (receipt === null) return;
        cursor = receipt;
        try {
          const result = await deliver(receipt.operationId, input.effects);
          if (!result.auditRecorded) input.onPassFailure?.();
          // Partial convergence is intentional while its remaining owners are
          // being wired. The row remains discoverable without a busy retry loop.
        } catch {
          input.onPassFailure?.();
        }
      }
    },
  });
}

export function installModerationEffectRecoveryLifecycle(
  app: Readonly<{
    addHook(name: "onListen", hook: () => void): void;
    addHook(name: "onClose", hook: () => Promise<void>): void;
  }>,
  recovery: ReturnType<typeof createModerationEffectRecovery>,
): void {
  app.addHook("onListen", () => recovery.start());
  app.addHook("onClose", () => recovery.stop());
}
