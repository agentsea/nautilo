import {
  and, eq, messageBackfillScans, messageBackfillFailures,
  acquireEncryptionConsumptionFence,
} from "@nautilo/db";
import { messageBackfillClaimSchema, type MessageBackfillClaim } from "@nautilo/api-client/browser";
import type { ConversationProductCanonicalTransactionRunner } from "./postgres-conversation-product-store.ts";
import { readMessageBackfillCandidates } from "./postgres-message-backfill-discovery.ts";
import { classifyMessageBackfillState } from "../../message/message-backfill-state.ts";

export type MessageBackfillCandidate = Awaited<ReturnType<typeof readMessageBackfillCandidates>>[number];
type Scan = typeof messageBackfillScans.$inferSelect;

function claimMatchesCurrentCandidate(
  claim: MessageBackfillClaim,
  candidate: MessageBackfillCandidate | undefined,
  humanId: string,
  policyRevision: number,
): boolean {
  if (candidate === undefined
    || claim.subjectHumanId !== humanId
    || claim.policyRevision !== policyRevision
    || claim.sourceRevision !== (candidate.role === "tool" ? candidate.messageSourceRevision : null)
    || claim.coordinate.sessionId !== candidate.sessionId
    || claim.coordinate.messageId !== candidate.messageId
    || claim.coordinate.revision !== candidate.revision
    || claim.coordinate.roomId !== candidate.sourceRoomId
    || claim.coordinate.namespaceId !== candidate.namespaceId
    || claim.coordinate.role !== candidate.role
    || claim.coordinate.logicalMessageKey !== candidate.logicalMessageKey
    || claim.createdAt !== candidate.createdAt.getTime()
    || claim.authorHumanTurnId !== candidate.humanTurnId
    || claim.sessionAgentId !== candidate.sessionAgentId
    || claim.namespaceAccessRevision !== candidate.namespaceAccessRevision
    || claim.keyClass !== (candidate.lifecycle?.keyClass ?? candidate.targetKeyClass)
    || (candidate.cryptoObjectId !== null
      && candidate.cryptoObjectId !== claim.cryptoObjectId)) return false;
  return classifyMessageBackfillState({
    message: {...candidate, roomId: candidate.sourceRoomId},
    lifecycle: candidate.lifecycle,
    supportedTopology: candidate.supportedTopology,
    ordinaryRestorationAccepted: candidate.ordinaryRestorationAccepted,
  }).action === claim.action;
}

/** Persistent liveness only. A lease or acknowledged outcome never proves a representation. */
export class PostgresMessageBackfillScan {
  constructor(private readonly runner: ConversationProductCanonicalTransactionRunner) {}

  async select(input: Readonly<{humanId: string; deviceId: string; now: number; resumeAt: number;
    urgentMessageId?: number}>) {
    return this.runner.transaction(async (tx, executor) => {
      const policy = await acquireEncryptionConsumptionFence(tx);
      if (policy.mode !== "shadow_encryption") return { status: "disabled" as const };
      await tx.insert(messageBackfillScans).values({humanActorId: input.humanId})
        .onConflictDoNothing();
      const [scan] = await tx.select().from(messageBackfillScans)
        .where(eq(messageBackfillScans.humanActorId, input.humanId)).for("update");
      if (!scan) throw new Error("Message sweep is unavailable");
      if (input.urgentMessageId !== undefined) {
        await tx.update(messageBackfillScans).set({urgentMessageId: input.urgentMessageId})
          .where(eq(messageBackfillScans.humanActorId, input.humanId));
        scan.urgentMessageId = input.urgentMessageId;
      }
      if (scan.leaseExpiresAt !== null && scan.leaseExpiresAt.getTime() > input.now) {
        const retained = messageBackfillClaimSchema.safeParse(scan.claim);
        const claim = retained.success ? retained.data : null;
        const [current] = claim === null ? [] : await readMessageBackfillCandidates(executor, {
          subjectHumanId: input.humanId,
          afterMessageId: claim.coordinate.messageId - 1,
          throughMessageId: claim.coordinate.messageId,
        });
        if (claim !== null && claimMatchesCurrentCandidate(
          claim,
          current,
          input.humanId,
          policy.revision,
        )) {
          return scan.leaseDeviceId === input.deviceId
            ? {status: "claimed" as const, claim}
            : {status: "waiting" as const, resumeAt: scan.leaseExpiresAt.getTime()};
        }
        // Product state or policy changed while the lease was live. Preserve the
        // cursor and let canonical discovery reconsider this exact Message now.
        await tx.update(messageBackfillScans).set({...clearLease, claimIsUrgent: 0})
          .where(eq(messageBackfillScans.humanActorId, input.humanId));
        scan.claim = null;
        scan.leaseToken = null;
        scan.leaseDeviceId = null;
        scan.leaseExpiresAt = null;
        scan.claimIsUrgent = 0;
      }
      if (scan.claim !== null) {
        // Expiry is not evidence that work completed. Continue past the leased
        // coordinate for this sweep so unavailable authority cannot starve
        // unrelated repair; wraparound or a fresh priority revisits it.
        const expired = messageBackfillClaimSchema.safeParse(scan.claim);
        const expiredContinuation: Partial<Pick<Scan, "cursorMessageId">> = {};
        if (expired.success) {
          // Urgent installation consumed its own marker. Any marker present now
          // was written after the lease and must survive an unacknowledged expiry.
          if (scan.claimIsUrgent !== 1) {
            const cursorMessageId = Math.max(
              scan.cursorMessageId,
              expired.data.coordinate.messageId,
            );
            expiredContinuation.cursorMessageId = cursorMessageId;
            scan.cursorMessageId = cursorMessageId;
          }
        }
        await tx.update(messageBackfillScans).set({
          ...clearLease,
          claimIsUrgent: 0,
          ...expiredContinuation,
        })
          .where(eq(messageBackfillScans.humanActorId, input.humanId));
        scan.claim = null;
        scan.leaseToken = null;
        scan.leaseDeviceId = null;
        scan.leaseExpiresAt = null;
        scan.claimIsUrgent = 0;
      }
      if (scan.resumeAt !== null && scan.resumeAt.getTime() > input.now
        && scan.urgentMessageId === null) {
        return {status: "waiting" as const, resumeAt: scan.resumeAt.getTime()};
      }
      const urgent = scan.urgentMessageId !== null && scan.claimIsUrgent === 0;
      const rows = await readMessageBackfillCandidates(executor, {
        subjectHumanId: input.humanId,
        afterMessageId: urgent ? scan.urgentMessageId! - 1 : scan.cursorMessageId,
        ...(urgent ? {throughMessageId: scan.urgentMessageId!} : {}),
      });
      for (const row of rows) {
        const state = classifyMessageBackfillState({
          message: {...row, roomId: row.sourceRoomId}, lifecycle: row.lifecycle,
          supportedTopology: row.supportedTopology,
          ordinaryRestorationAccepted: row.ordinaryRestorationAccepted,
        });
        if (state.action === "none") {
          await tx.delete(messageBackfillFailures).where(eq(messageBackfillFailures.messageId, row.messageId));
          if (urgent) {
            await tx.update(messageBackfillScans).set({urgentMessageId: null, claimIsUrgent: 1,
              lastActiveAt: new Date(input.now)}).where(eq(messageBackfillScans.humanActorId, input.humanId));
            // The caller must revalidate the returned candidate's exact tuple and
            // current device/Room authority before exposing a refresh signal.
            return {status: "priority_resolved" as const, candidate: row};
          }
          continue;
        }
        const [failure] = await tx.select().from(messageBackfillFailures)
          .where(eq(messageBackfillFailures.messageId, row.messageId));
        if (failure && failure.editRevision === row.revision
          && failure.namespaceAccessRevision === row.namespaceAccessRevision
          && failure.policyRevision === policy.revision
          && failure.cryptoObjectId === row.cryptoObjectId
          && (row.role !== "tool" || failure.sourceRevision === row.messageSourceRevision)
          && (failure.reason !== "unsupported" || state.action === "unsupported")) continue;
        if (state.action === "failed" || state.action === "unsupported") {
          await tx.insert(messageBackfillFailures).values({
            messageId: row.messageId, editRevision: row.revision,
            sourceRevision: row.role === "tool" ? row.messageSourceRevision : null,
            namespaceAccessRevision: row.namespaceAccessRevision, policyRevision: policy.revision,
            cryptoObjectId: row.cryptoObjectId,
            reason: state.action === "unsupported" ? "unsupported" : "integrity_failure",
          }).onConflictDoUpdate({target: messageBackfillFailures.messageId, set: {
            editRevision: row.revision, namespaceAccessRevision: row.namespaceAccessRevision,
            sourceRevision: row.role === "tool" ? row.messageSourceRevision : null,
            policyRevision: policy.revision, cryptoObjectId: row.cryptoObjectId,
            reason: state.action === "unsupported" ? "unsupported" : "integrity_failure",
            observedAt: new Date(input.now),
          }});
          continue;
        }
        return {status: "candidate" as const, candidate: row, action: state.action,
          policyRevision: policy.revision, cursor: scan.cursorMessageId, urgent};
      }
      const last = rows.at(-1);
      const finished = !urgent && rows.length === 0;
      await tx.update(messageBackfillScans).set({
        ...clearLease, lastActiveAt: new Date(input.now),
        ...(urgent ? {urgentMessageId: null, claimIsUrgent: 1} : {
          cursorMessageId: last?.messageId ?? 0, claimIsUrgent: 0,
          ...(finished ? {lastSweepAt: new Date(input.now), sweepStartedAt: new Date(input.now),
            resumeAt: new Date(input.resumeAt)} : {resumeAt: null}),
        }),
      }).where(eq(messageBackfillScans.humanActorId, input.humanId));
      return finished ? {status: "swept" as const, resumeAt: input.resumeAt}
        : {status: "more" as const};
    }, {isolationLevel: "read committed"});
  }

  async install(input: Readonly<{claim: MessageBackfillClaim; cursor: number; urgent: boolean; now: number}>) {
    const claim = messageBackfillClaimSchema.parse(input.claim);
    return this.runner.transaction(async (tx) => {
      const policy = await acquireEncryptionConsumptionFence(tx);
      if (policy.mode !== "shadow_encryption" || policy.revision !== claim.policyRevision) return false;
      const [scan] = await tx.select().from(messageBackfillScans)
        .where(eq(messageBackfillScans.humanActorId, claim.subjectHumanId)).for("update");
      if (!scan || scan.cursorMessageId !== input.cursor
        || (scan.leaseExpiresAt !== null && scan.leaseExpiresAt.getTime() > input.now)
        || (input.urgent && scan.urgentMessageId !== claim.coordinate.messageId)) return false;
      await tx.update(messageBackfillScans).set({
        claim, leaseToken: claim.claimId, leaseDeviceId: claim.deviceId,
        leaseExpiresAt: new Date(claim.expiresAt), claimIsUrgent: input.urgent ? 1 : 0,
        // A later non-null value is therefore a fresh priority written while
        // this lease is live, including the same Message coordinate.
        ...(input.urgent ? {urgentMessageId: null} : {}),
        lastActiveAt: new Date(input.now), resumeAt: null,
      }).where(eq(messageBackfillScans.humanActorId, claim.subjectHumanId));
      return true;
    }, {isolationLevel: "read committed"});
  }

  async defer(input: Readonly<{humanId: string; cursor: number; messageId: number; urgent: boolean; now: number}>) {
    return this.runner.transaction(async (tx) => {
      const [row] = await tx.select().from(messageBackfillScans)
        .where(eq(messageBackfillScans.humanActorId, input.humanId)).for("update");
      if (!row || row.claim !== null || row.cursorMessageId !== input.cursor) return;
      await tx.update(messageBackfillScans).set({
        lastActiveAt: new Date(input.now), claimIsUrgent: input.urgent ? 1 : 0,
        ...(input.urgent ? {urgentMessageId: null} : {cursorMessageId: input.messageId}),
      }).where(eq(messageBackfillScans.humanActorId, input.humanId));
    }, {isolationLevel: "read committed"});
  }

  async current(humanId: string, deviceId: string, claimId: string, now: number) {
    return this.runner.transaction(async (tx) => {
      const [row] = await tx.select().from(messageBackfillScans).where(and(
        eq(messageBackfillScans.humanActorId, humanId), eq(messageBackfillScans.leaseToken, claimId),
        eq(messageBackfillScans.leaseDeviceId, deviceId),
      ));
      if (!row?.leaseExpiresAt || row.leaseExpiresAt.getTime() <= now) return null;
      const claim = messageBackfillClaimSchema.safeParse(row.claim);
      return claim.success ? claim.data : null;
    }, {isolationLevel: "read committed"});
  }

  async advance(input: Readonly<{claim: MessageBackfillClaim; now: number;
    failure?: "integrity_failure" | "parity_mismatch" | "unsupported"}>) {
    return this.runner.transaction(async (tx) => {
      const c = input.claim;
      const [row] = await tx.select().from(messageBackfillScans).where(and(
        eq(messageBackfillScans.humanActorId, c.subjectHumanId), eq(messageBackfillScans.leaseToken, c.claimId),
      )).for("update");
      if (!row || row.leaseExpiresAt === null || row.leaseExpiresAt.getTime() <= input.now) return false;
      if (input.failure !== undefined) {
        const value = {messageId: c.coordinate.messageId, editRevision: c.coordinate.revision,
          sourceRevision: c.sourceRevision,
          namespaceAccessRevision: c.namespaceAccessRevision, policyRevision: c.policyRevision,
          cryptoObjectId: c.action === "encrypt" ? null : c.cryptoObjectId,
          reason: input.failure, observedAt: new Date(input.now)};
        await tx.insert(messageBackfillFailures).values(value).onConflictDoUpdate({
          target: messageBackfillFailures.messageId, set: value,
        });
      }
      await tx.update(messageBackfillScans).set({
        ...clearLease, lastActiveAt: new Date(input.now), resumeAt: null,
        ...(row.claimIsUrgent === 1
          ? row.urgentMessageId === c.coordinate.messageId ? {urgentMessageId: null} : {}
          : {cursorMessageId: c.coordinate.messageId}),
      }).where(eq(messageBackfillScans.humanActorId, c.subjectHumanId));
      return true;
    }, {isolationLevel: "read committed"});
  }
}

const clearLease = {claim: null, leaseToken: null, leaseDeviceId: null, leaseExpiresAt: null} satisfies Partial<Scan>;
