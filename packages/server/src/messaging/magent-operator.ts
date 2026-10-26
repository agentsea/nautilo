import { createHash, randomUUID } from "node:crypto";
import {
  getSharedDirectAgentDb, getSharedDirectDb, createMagentOperatorConnectionWith, createFreshBolterBindingWith,
  listBolterBindingsWith, getBolterConnectionWith, getBolterBindingWith, bolterReceiverMatches, bolterBindingMatches,
  getMagentReceiptStatusWith, cancelMagentReceiptWith, claimBolterOutboxWith, loadBolterPublicationContentWith,
  settleBolterOutboxWith, withdrawMagentBindingWith, type BolterBindingContext,
} from "@nautilo/db";
import {
  assertCanInvokeAgent, assertExternalRoomTextMode, createAcceptedInvocationAuthority, findActorByOwnerId,
  findAgentActorForAgent, insertPrivateRoomBundleTx,
} from "@nautilo/trust";
import { type MagentOperatorConfig, type MagentTurnRequest, magentPublicationSettlementSchema } from "@nautilo/types";
import type { JobManager } from "@nautilo/runtime";
import type { ExternalRoomExecutionService } from "./external-room-execution";
import { loadMagentGenieAvatar } from "./magent-avatar";

/** The socket owns one binding; no request can select a sponsor, Genie, room or namespace. */
export async function createMagentOperatorService(options: {
  config: MagentOperatorConfig;
  execution: Pick<ExternalRoomExecutionService, "accept" | "recoverOwner">;
  jobManager: Pick<JobManager, "cancelJob">;
}) {
  const config = options.config;
  const db = getSharedDirectAgentDb();
  const owner = { userId: config.sponsorUserId };
  await assertExternalRoomTextMode();
  await assertCanInvokeAgent({ humanUserId: owner.userId, origin: "room_message", agentId: config.genieId });
  const credentialDigest = createHash("sha256").update(config.credential).digest("hex");
  const identityFingerprint = createHash("sha256").update(JSON.stringify([
    "magent-operator-v1", config.operatorBindingId, owner.userId, config.genieId, config.origin,
    config.providerAgentId, config.chatId, config.senderId, credentialDigest,
  ])).digest("hex");
  const connection = await createMagentOperatorConnectionWith(db, owner, {
    operatorBindingId: config.operatorBindingId, origin: config.origin,
    providerAgentId: config.providerAgentId, identityFingerprint,
  });
  const receiver = { ...owner, connectionId: connection.id, connectionGeneration: connection.generation,
    transportKind: "operator-unix" as const, operatorBindingId: config.operatorBindingId,
    relayId: null, desktopSessionId: null, pairingGenerationRef: null };
  const existing = await listBolterBindingsWith(db, owner, connection.id);
  let binding = existing[0];
  if (!binding) {
    if (!connection.enabled || connection.revokedAt) throw new Error("magent_binding_unavailable");
    const [human, genie] = await Promise.all([findActorByOwnerId(owner.userId), findAgentActorForAgent(config.genieId)]);
    if (!human || !genie) throw new Error("magent_sponsor_unavailable");
    binding = await createFreshBolterBindingWith(getSharedDirectDb(), receiver, async tx => {
      const roomId = randomUUID();
      const bundle = await insertPrivateRoomBundleTx(tx, { roomId, ownerUserId: owner.userId, label: config.roomName,
        graphThreadId: `room:${roomId}`, humanActorIds: [human.id], memberRows: [
          { actorId: human.id, roomRole: "admin" }, { actorId: genie.id, roomRole: "member", agentResponseMode: "active" },
        ], createdByActorId: human.id, roomKind: "private", roomType: "private", discoverable: false, externalContext: true });
      return { roomId, namespaceId: bundle.namespaceId, agentId: config.genieId, chatId: config.chatId,
        threadId: "", modelSponsorshipAccepted: true };
    });
  }
  if (existing.length > 1 || binding.provider !== "magent" || binding.agentId !== config.genieId
    || binding.origin !== config.origin || binding.providerAgentId !== config.providerAgentId
    || binding.chatId !== config.chatId || binding.threadId !== "") throw new Error("magent_binding_identity_conflict");
  const ctx: BolterBindingContext = { ...receiver, bindingId: binding.id, bindingRevision: binding.revision };
  const roomId = binding.roomId;
  async function available() {
    try {
      await assertExternalRoomTextMode();
      await assertCanInvokeAgent({ humanUserId: owner.userId, origin: "room_message", roomId, agentId: config.genieId });
    } catch { return false; }
    const [currentConnection, currentBinding] = await Promise.all([
      getBolterConnectionWith(db, owner, connection.id), getBolterBindingWith(db, owner, ctx.bindingId),
    ]);
    return !!currentConnection && !!currentBinding && bolterReceiverMatches(currentConnection, ctx)
      && bolterBindingMatches(currentBinding, ctx) && !!currentBinding.modelSponsorshipAcceptedAt;
  }
  return {
    async status() {
      return { status: await available() ? "ready" : "withdrawn", operatorBindingId: config.operatorBindingId,
        providerAgentId: config.providerAgentId, chatId: config.chatId, senderId: config.senderId };
    },
    async avatar() {
      if (!await available()) return null;
      const avatar = await loadMagentGenieAvatar(config.genieId);
      // Recheck the binding after asynchronous storage and image decoding.
      if (!await available()) return null;
      return avatar ? { status: "ready" as const, ...avatar } : { status: "absent" as const };
    },
    async accept(input: MagentTurnRequest) {
      if (input.senderId !== config.senderId) return null;
      const { sessionId, kind, ...message } = input;
      const result = await options.execution.accept({ receiver: ctx, operatorSessionId: sessionId, operatorControl: kind,
        invocationAuthority: createAcceptedInvocationAuthority(owner.userId, { originRoomId: roomId }) }, {
        ...message, type: "message", chatId: config.chatId, threadRootId: null, senderType: "anima",
        addressed: true, truncated: false, redelivered: false,
      });
      if (!result.ok) return null;
      return { receiptId: result.acceptance.receipt.id, state: result.acceptance.receipt.state, dispatch: result.dispatch };
    },
    receipt: (receiptId: string) => getMagentReceiptStatusWith(db, ctx, receiptId),
    async cancel(receiptId: string) {
      const cancelled = await cancelMagentReceiptWith(db, ctx, receiptId);
      if (cancelled?.jobId) await options.jobManager.cancelJob(cancelled.jobId);
      return getMagentReceiptStatusWith(db, ctx, receiptId);
    },
    async claim(outboxId: string, claimToken: string) {
      const claim = await claimBolterOutboxWith(db, ctx, outboxId, claimToken);
      if (!claim) return null;
      const content = await loadBolterPublicationContentWith(db, ctx, { outboxId, claimToken });
      return content ? { outboxId, claimToken, content: content.content } : null;
    },
    async authorize(outboxId: string, claimToken: string) {
      // Full content/causality guards are repeated at the last server-owned boundary.
      return await loadBolterPublicationContentWith(db, ctx, { outboxId, claimToken }) ? { authorized: true } : null;
    },
    async settle(outboxId: string, input: unknown) {
      const parsed = magentPublicationSettlementSchema.parse(input);
      const settled = await settleBolterOutboxWith(db, ctx, { outboxId, ...parsed });
      return settled ? { outboxId, state: settled.state, providerMessageId: settled.providerMessageId } : null;
    },
    async withdraw(state: "paused" | "revoked") {
      const current = await getBolterBindingWith(db, owner, ctx.bindingId);
      if (!current) return null;
      const changed = await withdrawMagentBindingWith(db, owner, { bindingId: ctx.bindingId,
        expectedRevision: current.revision, state });
      if (!changed) return null;
      await Promise.all(changed.cancelledJobIds.map(jobId => options.jobManager.cancelJob(jobId)));
      return { state: changed.binding.state };
    },
  };
}
export type MagentOperatorService = Awaited<ReturnType<typeof createMagentOperatorService>>;
