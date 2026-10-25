import { warn } from "@nautilo/logger";
import { createHash, randomUUID } from "node:crypto";
import {
  acceptBolterInboundWith, bolterConnections, getBolterBindingWith, getBolterConnectionWith,
  getSharedDirectAgentDb, insertAcceptanceInTransaction, persistJobInTransaction,
  loadBolterExecutionWith, linkBolterExecutionAcceptanceWith, startBolterExecutionWith,
  settleBolterExecutionWith, completeBolterExecutionWith, getBolterRecoveryWindowWith, nextBolterRecoverableExecutionWith, getBolterExecutionInputForReceiptWith,
  and, asc, desc, gt, lte, type BolterRecoveryCursor,
  type BolterBindingContext, type BolterBridgeDatabase, type BolterExecutionInput,
} from "@nautilo/db";
import {
  appendCanonicalTranscriptRowsInTx, assertCanInvokeAgent, assertAcceptedInvocationAuthoritySubject,
  createAcceptedInvocationAuthority, findActorByOwnerId, findUserHighestRoleSlug, getRoomDetailForMember,
  PersonalPolicyResolver, loadActiveSilenceForRoom, assertExternalRoomTextMode,
  type AcceptedInvocationAuthority, type CanonicalTranscriptAppendRow,
} from "@nautilo/trust";
import {
  eventBus, getMaintenanceGate, routeBoundExternalRoomMessage,
  type JobManager, type JobExecutor, type ExternalRoomExecutionCandidate, type ExternalRoomJobReference,
} from "@nautilo/runtime";
import { type MessageNewEvent } from "@nautilo/types";
import { createReceiptRecoveryPump } from "../lib/receipt-recovery";
import { getServerDirectDb } from "../lib/server-direct-db";
import { prepareBolterExternalRoomTurn, prepareMagentExternalRoomTurn, externalRoomTurnMatchesLockedBinding } from "./external-room-turn";

function emitCommittedMessage(event: MessageNewEvent): void {
  try { eventBus.emit(event); }
  catch { warn("[external-room] committed message observation failed"); }
}

function fingerprint(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function transcriptRow(input: Pick<CanonicalTranscriptAppendRow, "role" | "content" | "fingerprint" | "humanTurnId" | "metadata" | "replyToMessageId">): CanonicalTranscriptAppendRow {
  return { ...input, toolCalls: null, toolName: null, transcriptOrigin: "main", parentThreadId: null,
    scopeId: null, subthreadRoomId: null };
}

/** Internal Server service. Provider JSON cannot supply an invocation authority. */
export function createExternalRoomExecutionService(options: {
  jobManager: Pick<JobManager, "adoptExternalRoomJob" | "getJob" | "retryQuiescentExternalRoomClaims">;
  db?: BolterBridgeDatabase;
  executor?: JobExecutor;
  onPendingPublication?: (receiver: BolterBindingContext) => void;
  onRecoveryPass?: () => void;
}) {
  const db = options.db ?? getSharedDirectAgentDb();
  let closed = false;

  async function sponsorEnvelope(userId: string, roomId: string, agentId: string) {
    await assertExternalRoomTextMode();
    await assertCanInvokeAgent({ humanUserId: userId, origin: "room_message", roomId, agentId });
    const actor = await findActorByOwnerId(userId);
    if (!actor) throw new Error("external_room_sponsor_unavailable");
    const resolver = new PersonalPolicyResolver(userId, agentId);
    return { actor, actorRole: await findUserHighestRoleSlug(userId) ?? "guest", envelope: await resolver.buildEnvelope(actor.id, `room:${roomId}`, agentId, roomId) };
  }

  async function adopt(userId: string, input: BolterExecutionInput): Promise<"adopted" | "active" | "ineligible" | "ownership-unproven"> {
    if (closed) throw new Error("external_room_execution_closed");
    const ctx = { userId };
    if (options.jobManager.getJob(input.jobId)?.isRunning()) return "active";
    const initial = await loadBolterExecutionWith(db, ctx, input);
    if (!initial) {
      await settleBolterExecutionWith(db, ctx, { ...input, status: "cancelled", reason: "authority_withdrawn", expectedPredecessor: "queued" });
      return "ineligible";
    }
    if (initial.job.status === "running") return "ownership-unproven";
    if (initial.job.status !== "queued") return "ineligible";
    const authority = createAcceptedInvocationAuthority(userId, { originRoomId: input.reference.roomId });
    let didStart = false;
    const candidate: ExternalRoomExecutionCandidate = {
      ...input, sponsorUserId: userId, invocationAuthority: authority,
      async verifyPersisted() {
        const current = await loadBolterExecutionWith(db, ctx, input);
        if (!current || current.job.status !== "queued") throw new Error("external_room_job_unavailable");
        await sponsorEnvelope(userId, input.reference.roomId, input.reference.agentId);
      },
      async linkAcceptance() {
        if (await linkBolterExecutionAcceptanceWith(db, ctx, input) !== "linked") throw new Error("external_room_acceptance_withdrawn");
      },
      async updateStatus(status, cancellationReason = "user_stop", executionClaim) {
        if (status === "running") {
          if (await startBolterExecutionWith(db, ctx, { ...input, ...(executionClaim ? { executionClaim } : {}) }) !== "started") throw new Error("external_room_start_withdrawn");
          didStart = true;
          return "running";
        }
        if (status === "queued") return "queued";
        const settled = await settleBolterExecutionWith(db, ctx, { ...input, status, expectedPredecessor: didStart ? "running" : "queued",
          ...(status === "cancelled" ? { reason: cancellationReason } : status === "failed" ? { reason: "execution_failed" as const } : {}) });
        if (settled.kind === "rejected") throw new Error("external_room_settlement_unavailable");
        return settled.status as import("@nautilo/types").JobStatus;
      },
      async hydrate() {
        const current = await loadBolterExecutionWith(db, ctx, input);
        if (!current || current.job.status !== "running") throw new Error("external_room_job_unavailable");
        const { actor, actorRole, envelope } = await sponsorEnvelope(userId, input.reference.roomId, input.reference.agentId);
        const room = await getRoomDetailForMember(input.reference.roomId, actor.id);
        if (!room) throw new Error("external_room_unavailable");
        const route = await routeBoundExternalRoomMessage({
          loadActiveSilenceForRoom: (roomId, now) => loadActiveSilenceForRoom(getServerDirectDb(), roomId, now),
        }, { roomId: room.id, boundAgentId: input.reference.agentId, members: room.members.map(member => ({ ...member, handle: member.handle ?? "" })), now: new Date() });
        if (route.kind !== "wake") throw new Error("external_room_genie_muted");
        const origin = current.origin;
        if (!origin || typeof current.sourceMessage.content !== "string") throw new Error("external_room_source_unavailable");
        const assertSponsorship = async () => {
          const live = await loadBolterExecutionWith(db, ctx, input);
          if (!live || live.job.status !== "running" || !live.binding.modelSponsorshipAcceptedAt) throw new Error("external_room_sponsorship_withdrawn");
          await sponsorEnvelope(userId, input.reference.roomId, input.reference.agentId);
        };
        return {
          input: { ownerId: userId, requestorId: userId, transcriptOwnerId: userId, causalHumanUserId: null,
            roomId: room.id, agentId: input.reference.agentId, turnId: input.reference.turnId,
            graphThreadId: current.session.threadId, threadId: current.session.threadId,
            message: current.sourceMessage.content, currentMessageId: current.sourceMessage.id,
            humanAlreadyPersisted: true, memoryAccessEnvelope: envelope, actorRole },
          context: { reference: input.reference, sponsorUserId: userId, origin, assertSponsorship,
            ...(current.receipt.controlInput ? { operatorControl: "operator_control_v1" as const } : {}),
            async complete(finalText: string) {
              let event: MessageNewEvent | undefined;
              const outbox = await completeBolterExecutionWith(db, ctx, input, async (tx, execution) => {
                const fp = fingerprint(["external-room-final-v1", input.reference.receiptId, input.jobId, finalText]);
                if (execution.receipt.controlInput) return { sessionMessageId: null, controlResult: finalText, fingerprint: fp };
                const appended = await appendCanonicalTranscriptRowsInTx(tx, {
                  session: { threadId: current.session.threadId, ownerId: userId, personaId: "owner",
                    agentId: input.reference.agentId, roomId: input.reference.roomId, title: "External conversation" },
                  rows: [transcriptRow({ role: "assistant", content: finalText, fingerprint: fp,
                    humanTurnId: null, replyToMessageId: execution.receipt.sessionMessageId,
                    metadata: { externalFinalReply: { kind: origin.provider === "bolter" ? "bolter_final_reply_v1" : "external_room_final_reply_v1", receiptId: input.reference.receiptId,
                      jobId: input.jobId, turnId: input.reference.turnId, acceptanceId: input.reference.acceptanceId } } })],
                  notificationContext: { causalHumanUserId: null, causalHumanTurnId: null, mentionedHumanUserIds: [] },
                });
                const row = appended.insertedRows[0];
                if (!row || appended.failedIndices.length) throw new Error("external_room_final_persistence_failed");
                event = { type: "message.new", laneKey: `room:${input.reference.roomId}`, messageId: row.id,
                  role: "ai", content: finalText, authorAgentId: input.reference.agentId,
                  ...(row.createdAt ? { createdAt: row.createdAt } : {}) };
                return { sessionMessageId: Number(row.id), fingerprint: fp };
              });
              if (!outbox) throw new Error("external_room_completion_withdrawn");
              if (event) emitCommittedMessage(event);
              try { options.onPendingPublication?.(current.receiverContext); } catch { warn("[external-room] publication observation failed"); }
            },
          },
        };
      },
    };
    await options.jobManager.adoptExternalRoomJob(candidate, options.executor);
    return "adopted";
  }

  async function* recoverOwnerEntries(userId: string) {
    if (closed) return;
    const upperBound = await getBolterRecoveryWindowWith(db, { userId });
    if (!upperBound) return;
    let after: BolterRecoveryCursor | undefined;
    while (!closed) {
      const next = await nextBolterRecoverableExecutionWith(db, { userId }, { upperBound, ...(after ? { after } : {}) });
      if (!next) return;
      after = next.cursor;
      if (next.execution) yield { jobId: next.execution.jobId,
        outcome: await adopt(userId, next.execution).catch(() => "pending-recovery" as const) };
    }
  }

  const service = {
    async accept(input: { receiver: BolterBindingContext; invocationAuthority: AcceptedInvocationAuthority; operatorSessionId?: string; operatorControl?: "operator_control_v1" }, raw: unknown) {
      if (closed) throw new Error("external_room_execution_closed");
      await getMaintenanceGate().assertAcceptingNewWork();
      const receiver = input.receiver;
      assertAcceptedInvocationAuthoritySubject(input.invocationAuthority, receiver.userId);
      const [connection, binding] = await Promise.all([
        getBolterConnectionWith(db, receiver, receiver.connectionId), getBolterBindingWith(db, receiver, receiver.bindingId),
      ]);
      if (!connection || !binding || !binding.modelSponsorshipAcceptedAt) throw new Error("external_room_sponsorship_unavailable");
      if ((connection.provider === "magent") !== (input.operatorControl === "operator_control_v1")) return { ok: false as const, reason: "unsupported-content" as const };
      const { envelope } = await sponsorEnvelope(receiver.userId, binding.roomId, binding.agentId);
      const prepare = connection.provider === "magent" ? prepareMagentExternalRoomTurn : prepareBolterExternalRoomTurn;
      const prepared = prepare({ receiver, connection, binding, memoryEnvelope: envelope,
        representationMode: "plaintext_only", invocationAuthority: input.invocationAuthority }, raw);
      if (!prepared.ok) return prepared;
      const turn = prepared.turn;
      let acceptedJob: BolterExecutionInput | undefined;
      let event: MessageNewEvent | undefined;
      const accepted = await acceptBolterInboundWith(db, receiver, turn.receipt, async (tx, locked, receiptId) => {
        if (!externalRoomTurnMatchesLockedBinding(turn, locked) || !locked.modelSponsorshipAcceptedAt) throw new Error("external_room_binding_changed");
        const turnId = randomUUID();
        const acceptanceId = await insertAcceptanceInTransaction(tx, "foreground");
        const reference: ExternalRoomJobReference = { kind: "external_room_turn_v1", receiptId, acceptanceId,
          bindingId: locked.id, bindingRevision: locked.revision, connectionGeneration: receiver.connectionGeneration,
          roomId: locked.roomId, agentId: locked.agentId, turnId };
        if (input.operatorControl === "operator_control_v1") {
          const jobId = await persistJobInTransaction(tx, { ownerId: receiver.userId, requestorId: receiver.userId,
            laneKey: `room:${locked.roomId}`, roomId: locked.roomId, type: "foreground", input: { ...reference } });
          acceptedJob = { jobId, reference };
          return { sessionMessageId: null, turnId, jobId,
            controlInput: { kind: "operator_control_v1" as const, content: turn.literalText, origin: turn.origin } };
        }
        const appended = await appendCanonicalTranscriptRowsInTx(tx, {
          session: { threadId: turn.graphThreadId, ownerId: receiver.userId, personaId: "owner", agentId: locked.agentId,
            roomId: locked.roomId, title: "External conversation" },
          rows: [transcriptRow({ role: "user", content: turn.literalText, fingerprint: fingerprint(["external-room-input-v1", receiptId]),
            humanTurnId: turnId, replyToMessageId: null, metadata: { externalOrigin: turn.origin, externalReceiptId: receiptId } })],
          notificationContext: { causalHumanUserId: null, causalHumanTurnId: null, mentionedHumanUserIds: [] },
        });
        const row = appended.insertedRows[0];
        if (!row || appended.failedIndices.length) throw new Error("external_room_input_persistence_failed");
        const jobId = await persistJobInTransaction(tx, { ownerId: receiver.userId, requestorId: receiver.userId,
          laneKey: `room:${locked.roomId}`, roomId: locked.roomId, type: "foreground", input: { ...reference } });
        acceptedJob = { jobId, reference };
        event = { type: "message.new", laneKey: `room:${locked.roomId}`, messageId: row.id, role: "user",
          content: turn.literalText, externalOrigin: turn.origin, ...(row.createdAt ? { createdAt: row.createdAt } : {}) };
        return { sessionMessageId: Number(row.id), turnId, jobId };
      }, input.operatorSessionId);
      if (accepted.status === "unavailable") return { ok: false as const, reason: "stale-binding" as const };
      if (accepted.status === "quarantined") return { ok: false as const, reason: "identity-conflict" as const };
      let dispatch: "not-needed" | "adopted" | "active" | "ineligible" | "ownership-unproven" | "pending-recovery" = "not-needed";
      if (accepted.status === "duplicate") {
        acceptedJob = await getBolterExecutionInputForReceiptWith(db, receiver, accepted.receipt.id) ?? undefined;
      }
      if ((accepted.status === "accepted" || accepted.status === "duplicate") && acceptedJob) {
        if (event) emitCommittedMessage(event);
        // Acceptance survives enqueue failure, which is explicitly reported to the receiver.
        try { dispatch = await adopt(receiver.userId, acceptedJob); }
        catch { dispatch = "pending-recovery"; }
      }
      return { ok: true as const, acceptance: accepted, dispatch };
    },
    async recoverOwner(userId: string) {
      await options.jobManager.retryQuiescentExternalRoomClaims();
      const outcomes = [];
      for await (const outcome of recoverOwnerEntries(userId)) outcomes.push(outcome);
      return outcomes;
    },
    async recover() {
      let unresolved = 0;
      let pending = await options.jobManager.retryQuiescentExternalRoomClaims();
      const productDb = getServerDirectDb();
      const [maximum] = await productDb.selectDistinct({ userId: bolterConnections.userId }).from(bolterConnections)
        .orderBy(desc(bolterConnections.userId)).limit(1);
      if (!maximum) return { unresolved, pending };
      let afterOwner: string | undefined;
      while (!closed) {
        const [owner] = await productDb.selectDistinct({ userId: bolterConnections.userId }).from(bolterConnections)
          .where(and(lte(bolterConnections.userId, maximum.userId), afterOwner ? gt(bolterConnections.userId, afterOwner) : undefined))
          .orderBy(asc(bolterConnections.userId)).limit(1);
        if (!owner) break;
        afterOwner = owner.userId;
        try {
          for await (const outcome of recoverOwnerEntries(owner.userId)) {
            if (outcome.outcome === "ownership-unproven") unresolved += 1;
            if (outcome.outcome === "pending-recovery") pending += 1;
          }
        } catch { pending += 1; }
      }
      return { unresolved, pending };
    },
    start(input: { intervalMs: number }) {
      if (closed || timer !== undefined) return;
      if (!Number.isFinite(input.intervalMs) || input.intervalMs <= 0) throw new TypeError("Invalid recovery interval");
      recovery.start();
      timer = setInterval(recovery.wake, input.intervalMs);
      timer.unref?.();
    },
    async close() {
      closed = true;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      await recovery.stop();
      await options.jobManager.retryQuiescentExternalRoomClaims();
    },
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  let previousRecoveryState = "0:0";
  let recoveryPassFailed = false;
  const recovery = createReceiptRecoveryPump({
    async runPass() {
      const { unresolved, pending } = await service.recover();
      options.onRecoveryPass?.();
      if (recoveryPassFailed) warn("[external-room] receipt recovery resumed");
      recoveryPassFailed = false;
      const state = `${unresolved}:${pending}`;
      if (state !== previousRecoveryState) {
        previousRecoveryState = state;
        warn(`[external-room] recovery state: ownership-unproven=${unresolved} pending=${pending}`);
      }
    },
    onPassFailure: () => {
      if (!recoveryPassFailed) warn("[external-room] recovery deferred; durable work remains pending");
      recoveryPassFailed = true;
    },
  });
  return service;
}

export type ExternalRoomExecutionService = ReturnType<typeof createExternalRoomExecutionService>;

declare module "fastify" {
  interface FastifyInstance { externalRoomExecution: ExternalRoomExecutionService }
}
