import { convergeHumanRoomCatalogs, publishBolterStateChanged } from "../realtime/ws-publisher";
import { warn } from "@nautilo/logger";
import { createReceiptRecoveryPump } from "../lib/receipt-recovery";
import { createHash, randomUUID } from "node:crypto";
import { ATTACHMENT_POLICY } from "@nautilo/attachments";
import { BOLTER_FILES_PROTOCOL_VERSION } from "@nautilo/relay";
import {
  BOLTER_ORIGIN, bolterConnectionObservationSchema, type BolterConnectionObservation, type BolterConnectionSummary,
  type BolterConnectionsResponse, type BolterConversationsResponse, type BolterOperationResponse, type BolterNativeCommand, type BolterRoomLinkSummary,
  type BolterAttachmentDescriptor, type BolterCreateRoomRequest, type BolterReviewedMessageRequest, type BolterStatusReason, type BolterDeliverySelection,
} from "@nautilo/types";
import {
  getSharedDirectAgentDb, getSharedDirectDb, listBolterConnectionsWith, getBolterConnectionWith,
  createBolterConnectionWith, rotateBolterReceiverWith, listBolterBindingsWith, getBolterBindingWith,
  createFreshBolterBindingWith, resolveBolterBindingWith, setBolterConnectionStateWith, updateBolterBindingStateWith,
  listBolterOutboxWith, listBolterDeliverySummariesWith, getBolterDeliveryCountsWith, acceptBolterReviewedShareWith, rooms, eq,
  loadBolterShareAttachmentsWith, retainBolterShareAttachmentsInTx, bolterReviewedTextFingerprint,
  type BolterConnection, type BolterRoomBinding, type BolterBindingContext, type BolterReceiverContext,
} from "@nautilo/db";
import {
  assertExternalRoomTextMode, assertCanInvokeAgent, createAcceptedInvocationAuthority, findActorByOwnerId,
  findAgentActorForAgent, insertPrivateRoomBundleTx, appendCanonicalTranscriptRowsInTx,
} from "@nautilo/trust";
import { eventBus, type InMemoryRelayRegistry } from "@nautilo/runtime";
import { createDatabaseBolterPublicationService } from "./bolter-publication";
import { readBolterAttachmentBytes } from "./bolter-attachments";
import { isBolterMessageAddressed } from "./bolter-addressing";
import type { createExternalRoomExecutionService } from "./external-room-execution";

type Registry = Pick<InMemoryRelayRegistry, "getBolterSession" | "listBolterSessions" | "requestBolterCommand" | "onBolterObservation" | "onBolterBatch" | "onBolterContext">;
type Scope = NonNullable<ReturnType<Registry["getBolterSession"]>>;
type Execution = ReturnType<typeof createExternalRoomExecutionService>;
type Operation = { userId: string; scope: Scope; homeHandle: string; connectionId: string; response: BolterOperationResponse; abort: AbortController };
export class BolterControlError extends Error {
  constructor(readonly code: BolterStatusReason) { super(code); }
}
const sameScope = (a: Scope, b: Scope | null) => b !== null && a.userId === b.userId && a.relayId === b.relayId
  && a.relaySessionId === b.relaySessionId && a.desktopSessionId === b.desktopSessionId
  && a.pairingGenerationRef === b.pairingGenerationRef && a.selectedProtocolVersion === b.selectedProtocolVersion
  && a.capabilityRevision === b.capabilityRevision;

/** One owner-scoped semantic controller over the existing authenticated Relay Host. */
export function createBolterController(options: { relay: Registry; execution: Execution }) {
  const db = getSharedDirectAgentDb();
  const productDb = getSharedDirectDb();
  const lifetime = new AbortController();
  const observations = new Map<string, { scope: Scope; generation: number; value: BolterConnectionObservation }>();
  const conversationLabels = new Map<string, ReadonlyMap<string, string>>();
  const conversationKey = (chatId: string, threadRootId: string | null) => JSON.stringify([chatId, threadRootId]);
  function cacheConversations(id: string, conversations: readonly { chatId: string; threadRootId: string | null; label: string }[]) {
    conversationLabels.set(id, new Map(conversations.map(item => [conversationKey(item.chatId, item.threadRootId), item.label])));
  }
  function remember(id: string, entry: { scope: Scope; generation: number; value: BolterConnectionObservation }) {
    const previous = observations.get(id);
    observations.set(id, entry);
    if (!previous || !sameScope(previous.scope, entry.scope) || previous.generation !== entry.generation
      || previous.value.receiver !== entry.value.receiver || previous.value.reason !== entry.value.reason
      || previous.value.authentication !== entry.value.authentication
      || previous.value.attachments !== entry.value.attachments
      || previous.value.identity?.label !== entry.value.identity?.label
      || previous.value.identity?.providerAgentId !== entry.value.identity?.providerAgentId
      || previous.value.identity?.identityFingerprint !== entry.value.identity?.identityFingerprint) {
      publishBolterStateChanged(entry.scope.userId);
    }
  }
  function forget(id: string) {
    conversationLabels.delete(id);
    const previous = observations.get(id);
    if (observations.delete(id) && previous) publishBolterStateChanged(previous.scope.userId);
  }
  const operations = new Map<string, Operation>();
  const choices = new Map<string, { userId: string; connectionId: string; revision: number; scope: Scope; chatId: string; threadRootId: string | null; label: string }>();
  const publishing = new Map<string, Promise<void>>();
  const publicationRequested = new Set<string>();
  const pendingWork = new Set<Promise<unknown>>();
  const observing = new Map<string, Promise<void>>();
  function track<T>(work: Promise<T>): Promise<T> {
    pendingWork.add(work);
    void work.then(() => pendingWork.delete(work), () => pendingWork.delete(work));
    return work;
  }
  const active = (scope: Scope) => !lifetime.signal.aborted && sameScope(scope, options.relay.getBolterSession(scope.relayId, scope.userId));
  async function mode() { try { await assertExternalRoomTextMode(); return true; } catch { return false; } }
  async function requireMode() { if (!await mode()) throw new BolterControlError("mode_unsupported"); }
  async function connection(userId: string, id: string) {
    const row = await getBolterConnectionWith(db, { userId }, id);
    if (!row || row.transportKind === "operator-unix" || row.relayId === null) throw new BolterControlError("not_found");
    return row;
  }
  function receiver(row: BolterConnection, scope: Scope): BolterReceiverContext {
    if (!active(scope) || row.userId !== scope.userId || row.relayId !== scope.relayId
      || row.desktopSessionId !== scope.desktopSessionId || row.pairingGenerationRef !== scope.pairingGenerationRef) throw new BolterControlError("authority_changed");
    return { userId: row.userId, connectionId: row.id, connectionGeneration: row.generation,
      relayId: scope.relayId, desktopSessionId: scope.desktopSessionId, pairingGenerationRef: scope.pairingGenerationRef };
  }
  function live(row: BolterConnection) {
    const entry = observations.get(row.id);
    if (!entry || !active(entry.scope) || entry.generation !== row.generation
      || entry.value.authentication !== "confirmed" || entry.value.identity?.providerAgentId !== row.providerAgentId
      || entry.value.identity.identityFingerprint !== row.identityFingerprint) return null;
    try { receiver(row, entry.scope); } catch { return null; }
    return entry;
  }
  async function summary(row: BolterConnection): Promise<BolterConnectionSummary> {
    const entry = live(row);
    const supported = await mode();
    return { id: row.id, revision: row.revision, displayName: "Bolter", identity: { providerAgentId: row.providerAgentId, label: entry?.value.identity?.label ?? "Bolter identity" },
      device: { relayId: row.relayId!, label: "Desktop" }, status: row.revokedAt ? "revoked" : !row.enabled ? "paused" : !supported ? "qualification_required" : entry ? "connected" : "offline",
      receiver: entry?.value.receiver ?? "stopped", canCreateRoom: supported && row.enabled && !row.revokedAt && entry !== null,
      ...(!supported ? { reason: "mode_unsupported" as const } : !entry ? { reason: "desktop_offline" as const }
        : entry.value.reason ? { reason: entry.value.reason } : {}) };
  }
  async function command(scope: Scope, command: BolterNativeCommand, signal = lifetime.signal) {
    if (!active(scope)) throw new BolterControlError("desktop_offline");
    const result = await options.relay.requestBolterCommand({ relayId: scope.relayId, userId: scope.userId, command, signal });
    if (!active(scope)) throw new BolterControlError("authority_changed");
    return result;
  }
  async function observe(userId: string, connectionId: string, generation: number, scope: Scope, value: BolterConnectionObservation) {
    const previous = observing.get(connectionId);
    const work = (async () => {
      if (previous) await previous.catch(() => undefined);
      await performObserve(userId, connectionId, generation, scope, value);
    })();
    observing.set(connectionId, work);
    try { await work; } finally { if (observing.get(connectionId) === work) observing.delete(connectionId); }
  }
  async function performObserve(userId: string, connectionId: string, generation: number, scope: Scope, value: BolterConnectionObservation) {
    const parsed = bolterConnectionObservationSchema.safeParse(value);
    if (!parsed.success || !active(scope) || scope.userId !== userId) return;
    const pending = [...operations.values()].find(op => op.userId === userId && op.connectionId === connectionId && sameScope(op.scope, scope) && !op.abort.signal.aborted && (op.response.status === "pending" || op.response.status === "auth_pending"));
    if (pending && generation === 1 && parsed.data.authentication === "confirmed" && parsed.data.identity) {
      const identity = parsed.data.identity;
      const row = await createBolterConnectionWith(db, { userId }, { id: connectionId, relayId: scope.relayId,
        desktopSessionId: scope.desktopSessionId, pairingGenerationRef: scope.pairingGenerationRef, homeHandle: pending.homeHandle,
        origin: BOLTER_ORIGIN, providerAgentId: identity.providerAgentId, identityFingerprint: identity.identityFingerprint });
      if (!active(scope) || pending.abort.signal.aborted) {
        await setBolterConnectionStateWith(db, { userId }, { connectionId: row.id, expectedRevision: row.revision, enabled: false });
        return;
      }
      remember(row.id, { scope, generation: row.generation, value: parsed.data });
      pending.response = { operationId: pending.response.operationId, status: "completed", connection: await summary(row) };
      return;
    }
    const row = await getBolterConnectionWith(db, { userId }, connectionId);
    if (!row || !active(scope) || row.generation !== generation) return;
    try { receiver(row, scope); } catch { return; }
    if (parsed.data.authentication !== "confirmed" || parsed.data.identity?.providerAgentId !== row.providerAgentId
      || parsed.data.identity.identityFingerprint !== row.identityFingerprint) { forget(connectionId); return; }
    remember(connectionId, { scope, generation, value: parsed.data });
  }
  const publisher = createDatabaseBolterPublicationService(db, {
    isCurrent(ctx) {
      const observation = observations.get(ctx.connectionId);
      return !!observation && active(observation.scope) && observation.generation === ctx.connectionGeneration
        && observation.scope.userId === ctx.userId && observation.scope.desktopSessionId === ctx.desktopSessionId
        && observation.scope.pairingGenerationRef === ctx.pairingGenerationRef && observation.scope.relayId === ctx.relayId;
    },
    async send(request) {
      const entry = observations.get(request.receiver.connectionId);
      if (!entry || !active(entry.scope)) return { status: "unavailable" };
      try {
        let released: { chatId: string; threadRootId: string | null; content: string } | null = null;
        const result = await options.relay.requestBolterCommand({ relayId: entry.scope.relayId, userId: entry.scope.userId,
          command: { action: "send", connectionId: request.receiver.connectionId,
            generation: request.receiver.connectionGeneration, outboxId: request.claim.outboxId,
            bindingId: request.receiver.bindingId, bindingRevision: request.receiver.bindingRevision }, signal: lifetime.signal,
          authorize: async () => {
            if (!active(entry.scope)) return null;
            if (released) return await request.reauthorize() && active(entry.scope) ? released : null;
            const text = await request.authorize();
            if (!text || !active(entry.scope) || (text.files?.length && !entry.value.attachments)) return null;
            const files = text.files?.length ? await Promise.all(text.files.map(async file => ({
              id: file.id, filename: file.filename, mimeType: file.mimeType, sizeBytes: file.sizeBytes, sha256: file.sha256,
              base64: (await readBolterAttachmentBytes(file)).toString("base64"),
            }))) : undefined;
            if (files && (!await request.reauthorize() || !active(entry.scope))) return null;
            released = { chatId: text.chatId, threadRootId: text.threadRootId, content: text.content };
            return active(entry.scope) ? { ...released,
              ...(files ? { files } : {}) } : null;
          },
        });
        return result.kind === "sent" ? { status: "sent", receipt: result.receipt }
          : result.kind === "unavailable" ? { status: "unavailable" } : { status: "uncertain" };
      } catch { return { status: "uncertain" }; }
    },
  });
  async function publishPending(ctx: BolterBindingContext) {
    publicationRequested.add(ctx.bindingId);
    if (publishing.has(ctx.bindingId)) { await publishing.get(ctx.bindingId); return; }
    const work = (async () => {
      while (publicationRequested.delete(ctx.bindingId)) {
        for (const item of await listBolterOutboxWith(db, ctx, ctx.bindingId)) {
          if (lifetime.signal.aborted) return;
          if (item.state === "pending") {
            await publisher.publish(ctx, item.id);
            publishBolterStateChanged(ctx.userId);
          }
        }
      }
    })();
    publishing.set(ctx.bindingId, work);
    try { await work; } finally { publishing.delete(ctx.bindingId); }
  }
  async function bindingContext(userId: string, bindingId: string) {
    const binding = await getBolterBindingWith(db, { userId }, bindingId);
    if (!binding) throw new BolterControlError("not_found");
    const row = await connection(userId, binding.connectionId);
    const entry = live(row);
    if (!entry || !row.enabled || row.revokedAt) throw new BolterControlError("desktop_offline");
    return { binding, connection: row, scope: entry.scope, ctx: { ...receiver(row, entry.scope), bindingId, bindingRevision: binding.revision } };
  }
  async function linkSummary(binding: BolterRoomBinding): Promise<BolterRoomLinkSummary> {
    const row = await connection(binding.userId, binding.connectionId);
    const detail = await summary(row);
    const delivery = await getBolterDeliveryCountsWith(db, { userId: binding.userId }, binding.id);
    const [room] = await productDb.select({ label: rooms.label }).from(rooms).where(eq(rooms.id, binding.roomId)).limit(1);
    return { id: binding.id, revision: binding.revision, roomId: binding.roomId, roomName: room?.label ?? "Bolter Room",
      agentId: binding.agentId, connectionId: row.id,
      conversationLabel: conversationLabels.get(row.id)?.get(conversationKey(binding.chatId, binding.threadId || null))
        ?? conversationLabels.get(row.id)?.get(conversationKey(binding.chatId, null)) ?? binding.chatId, chatId: binding.chatId,
      threadRootId: binding.threadId || null, providerAgentId: row.providerAgentId, identityLabel: detail.identity?.label ?? "Bolter identity",
      status: binding.state, receiver: detail.receiver, outboundPolicy: "causal_replies_and_reviewed_messages",
      canManage: true, canSend: detail.canCreateRoom && binding.state === "active",
      canAttach: detail.canCreateRoom && binding.state === "active" && observations.get(row.id)?.value.attachments === true
        && (observations.get(row.id)?.scope.selectedProtocolVersion ?? 0) >= BOLTER_FILES_PROTOCOL_VERSION,
      delivery, ...(detail.reason ? { reason: detail.reason } : {}) };
  }
  async function checkConnection(userId: string, id: string) {
      await requireMode(); let row = await connection(userId, id);
      if (row.revokedAt || !row.enabled) return summary(row);
      const scope = row.relayId ? options.relay.getBolterSession(row.relayId, userId) : null;
      if (!scope) return summary(row);
      const result = await command(scope, { action: "check", connectionId: id, generation: row.generation });
      if (result.kind !== "observation") { forget(id); return summary(row); }
      if (result.observation.authentication === "confirmed" && result.observation.identity?.providerAgentId === row.providerAgentId
        && result.observation.identity.identityFingerprint === row.identityFingerprint && active(scope)) {
        if (row.desktopSessionId !== scope.desktopSessionId || row.pairingGenerationRef !== scope.pairingGenerationRef) {
          const rotated = await rotateBolterReceiverWith(db, { userId }, { connectionId: id, expectedRevision: row.revision,
            desktopSessionId: scope.desktopSessionId, pairingGenerationRef: scope.pairingGenerationRef });
          if (!rotated) throw new BolterControlError("authority_changed"); row = rotated;
        }
        await observe(userId, id, row.generation, scope, result.observation);
        const conversations = await command(scope, { action: "list_conversations", connectionId: id, generation: row.generation });
        if (conversations.kind === "conversations" && active(scope)) {
          cacheConversations(id, conversations.conversations);
          publishBolterStateChanged(userId);
        }
        const bindings = (await listBolterBindingsWith(db, { userId }, id)).filter(binding => binding.state === "active");
        if (bindings.length) await startReceiver(row, scope);
        for (const binding of bindings) {
          await publishPending({ ...receiver(row, scope), bindingId: binding.id, bindingRevision: binding.revision });
        }
      } else forget(id);
      return summary(row);
    }
  async function startReceiver(row: BolterConnection, scope: Scope) {
    try {
      const result = await command(scope, { action: "start_receiver", connectionId: row.id, generation: row.generation });
      if (result.kind === "observation") await observe(row.userId, row.id, row.generation, scope, result.observation);
      else {
        const entry = observations.get(row.id);
        if (entry && sameScope(entry.scope, scope)) remember(row.id, { ...entry, value: { ...entry.value, receiver: "stopped", reason: "receiver_unavailable" } });
      }
    } catch {
      const entry = observations.get(row.id);
      if (entry && sameScope(entry.scope, scope)) remember(row.id, { ...entry, value: { ...entry.value, receiver: "stopped", reason: "receiver_unavailable" } });
    }
  }
  const dispose = [
    options.relay.onBolterObservation(({ userId, message }) => { const scope = options.relay.getBolterSession(message.scope.relayId, userId);
      if (scope && sameScope(scope, { ...message.scope, userId })) void track(observe(userId, message.connectionId, message.generation, scope, message.observation)).catch(() => { forget(message.connectionId); }); }),
    options.relay.onBolterContext((relayId, userId, session) => {
      publishBolterStateChanged(userId);
      for (const [id, value] of observations) if (value.scope.relayId === relayId && value.scope.userId === userId) forget(id);
      for (const [id, value] of choices) if (value.scope.relayId === relayId && value.userId === userId) choices.delete(id);
      for (const op of operations.values()) if (op.scope.relayId === relayId && op.userId === userId && !active(op.scope)) {
        op.abort.abort(); op.response = { operationId: op.response.operationId, status: "unavailable", reason: "desktop_offline" };
      }
      if (session) void track((async () => {
        for (const row of await listBolterConnectionsWith(db, { userId })) {
          if (!active(session)) return;
          if (row.relayId === relayId && row.enabled && !row.revokedAt) await checkConnection(userId, row.id);
        }
      })()).catch(() => { warn("[bolter] connection recovery deferred"); });
    }),
    options.relay.onBolterBatch(({ userId, message }) => track((async () => {
      try {
        await requireMode();
        const row = await connection(userId, message.connectionId);
        const entry = live(row);
        if (!entry || row.generation !== message.generation || !sameScope(entry.scope, { ...message.scope, userId })) return "blocked";
        const ctx = receiver(row, entry.scope);
        for (const item of message.messages) {
          if (!active(entry.scope)) return "blocked";
          if (item.senderType === "system" || item.senderId === row.providerAgentId || !isBolterMessageAddressed(item, row.providerAgentId)) continue;
          if (item.truncated || !item.content.trim()) {
            remember(row.id, { ...entry, value: { ...entry.value, reason: "unsupported_content" } });
            return "blocked";
          }
          const binding = await resolveBolterBindingWith(db, ctx, { origin: row.origin, providerAgentId: row.providerAgentId,
            chatId: item.chatId, threadId: item.threadRootId ?? "" });
          if (!binding) continue;
          const accepted = await options.execution.accept({ receiver: { ...ctx, bindingId: binding.id, bindingRevision: binding.revision },
            invocationAuthority: createAcceptedInvocationAuthority(userId, { originRoomId: binding.roomId }) }, item);
          if (!accepted.ok && accepted.reason !== "identity-conflict") return "blocked";
        }
        return active(entry.scope) ? "accepted" : "blocked";
      } catch { return "blocked" as const; }
    })())),
  ];
  let publicationRecoveryFailed = false;
  const publicationRecovery = createReceiptRecoveryPump({
    async runPass(stopped) {
      for (const [id, entry] of observations) {
        if (stopped()) return;
        if (!active(entry.scope)) continue;
        const row = await getBolterConnectionWith(db, { userId: entry.scope.userId }, id);
        if (!row || !live(row) || !row.enabled || row.revokedAt) continue;
        for (const binding of await listBolterBindingsWith(db, { userId: row.userId }, id)) {
          if (stopped()) return;
          if (binding.state === "active") await publishPending({ ...receiver(row, entry.scope), bindingId: binding.id, bindingRevision: binding.revision });
        }
      }
      publicationRecoveryFailed = false;
    },
    onPassFailure() {
      if (!publicationRecoveryFailed) warn("[bolter] publication recovery deferred");
      publicationRecoveryFailed = true;
    },
  });
  return {
    async connections(userId: string): Promise<BolterConnectionsResponse> {
      const supported = await mode();
      const sessions = options.relay.listBolterSessions(userId);
      const connections = await Promise.all((await listBolterConnectionsWith(db, { userId })).filter(row => row.transportKind !== "operator-unix").map(summary));
      return { connections, desktops: sessions.map(scope => ({ relayId: scope.relayId, label: "Desktop" })), availability: { state: !supported ? "mode_unsupported" : !sessions.length ? "desktop_required"
        : "available" } };
    },
    async connect(userId: string, relayId?: string) {
      await requireMode();
      const sessions = options.relay.listBolterSessions(userId).filter(scope => !relayId || scope.relayId === relayId);
      if (sessions.length !== 1) throw new BolterControlError(sessions.length ? "desktop_selection_required" : "desktop_required");
      const scope = sessions[0]!;
      const pending = [...operations.values()].find(op => op.userId === userId && (op.response.status === "pending" || op.response.status === "auth_pending") && !op.abort.signal.aborted);
      if (pending) {
        if (!sameScope(pending.scope, scope)) throw new BolterControlError("conflict");
        return pending.response;
      }
      for (const [id, old] of operations) if (old.userId === userId) { old.abort.abort(); operations.delete(id); }
      const operationId = randomUUID();
      const op: Operation = { userId, scope, homeHandle: randomUUID(), connectionId: randomUUID(), abort: new AbortController(),
        response: { operationId, status: "pending" } };
      operations.set(operationId, op);
      void track(command(scope, { action: "connect", operationId, connectionId: op.connectionId, homeHandle: op.homeHandle }, op.abort.signal)
        .then(async result => {
          if (op.abort.signal.aborted || !active(scope)) return;
          if (result.kind === "auth_pending") op.response = { operationId, status: "auth_pending", auth: result.auth };
          else if (result.kind === "observation") { await observe(userId, op.connectionId, 1, scope, result.observation);
            if (op.response.status !== "completed") op.response = { operationId, status: "unavailable", reason: result.observation.reason ?? "qualification_required" }; }
          else op.response = { operationId, status: "unavailable", reason: result.kind === "unavailable" ? result.reason : "runtime_unavailable" };
        }).catch(() => { if (!op.abort.signal.aborted) op.response = { operationId, status: "unavailable", reason: "runtime_unavailable" }; }));
      return op.response;
    },
    operation(userId: string, id: string) { const op = operations.get(id); if (!op || op.userId !== userId) throw new BolterControlError("not_found"); return op.response; },
    async cancelOperation(userId: string, id: string) {
      const op = operations.get(id); if (!op || op.userId !== userId) throw new BolterControlError("not_found");
      op.abort.abort(); op.response = { operationId: id, status: "unavailable", reason: "operation_cancelled" };
      await command(op.scope, { action: "cancel_connect", operationId: id }).catch(() => undefined);
      return op.response;
    },
    check: checkConnection,
    async updateConnection(userId: string, id: string, expectedRevision: number, enabled: boolean, revoke = false) {
      await connection(userId, id);
      const row = await setBolterConnectionStateWith(db, { userId }, { connectionId: id, expectedRevision, enabled, ...(revoke ? { revoke: true } : {}) });
      if (!row || row.transportKind === "operator-unix") throw new BolterControlError("authority_changed");
      const scope = row.relayId ? options.relay.getBolterSession(row.relayId, userId) : null;
      forget(id);
      if (scope && (!enabled || revoke)) await command(scope, { action: revoke ? "revoke" : "pause", connectionId: id, generation: row.generation }).catch(() => undefined);
      publishBolterStateChanged(userId);
      if (enabled && !revoke) return checkConnection(userId, id);
      return summary(row);
    },
    async conversations(userId: string, id: string): Promise<BolterConversationsResponse> {
      await requireMode(); const row = await connection(userId, id); const entry = live(row);
      if (!entry) return { status: "unavailable" as const, conversations: [], reason: "desktop_offline" as const };
      const result = await command(entry.scope, { action: "list_conversations", connectionId: id, generation: row.generation });
      if (result.kind !== "conversations") return { status: "unavailable" as const, conversations: [], reason: "qualification_required" as const };
      cacheConversations(id, result.conversations);
      for (const [key, choice] of choices) if (choice.userId === userId && choice.connectionId === id) choices.delete(key);
      return { status: "available" as const, conversations: result.conversations.map(item => {
        const choiceId = randomUUID(); choices.set(choiceId, { ...item, userId, connectionId: id, revision: row.revision, scope: entry.scope });
        return { id: choiceId, ...item };
      }) };
    },
    async createRoom(userId: string, id: string, input: BolterCreateRoomRequest) {
      await requireMode(); const row = await connection(userId, id); const entry = live(row); const choice = choices.get(input.choiceId);
      if (!entry || !choice || choice.userId !== userId || choice.connectionId !== id || choice.revision !== row.revision || !active(choice.scope)) throw new BolterControlError("authority_changed");
      await assertCanInvokeAgent({ humanUserId: userId, origin: "room_message", agentId: input.agentId });
      const [human, genie] = await Promise.all([findActorByOwnerId(userId), findAgentActorForAgent(input.agentId)]);
      if (!human || !genie) throw new BolterControlError("not_found");
      const binding = await createFreshBolterBindingWith(productDb, receiver(row, entry.scope), async tx => {
        const roomId = randomUUID();
        const bundle = await insertPrivateRoomBundleTx(tx, { roomId, ownerUserId: userId, label: input.name,
          graphThreadId: `room:${roomId}`, humanActorIds: [human.id], memberRows: [{ actorId: human.id, roomRole: "admin" },
            { actorId: genie.id, roomRole: "member", agentResponseMode: "active" }], createdByActorId: human.id,
          roomKind: "private", roomType: "private", discoverable: false, externalContext: true });
        return { roomId, namespaceId: bundle.namespaceId, agentId: input.agentId, chatId: choice.chatId, threadId: choice.threadRootId ?? "", modelSponsorshipAccepted: true };
      });
      choices.delete(input.choiceId);
      await convergeHumanRoomCatalogs([{ userId, actorId: human.id }]);
      publishBolterStateChanged(userId);
      await startReceiver(row, entry.scope);
      return { roomId: binding.roomId, link: await linkSummary(binding) };
    },
    async connectionRooms(userId: string, id: string) {
      await connection(userId, id);
      return { links: await Promise.all((await listBolterBindingsWith(db, { userId }, id)).map(linkSummary)) };
    },
    async room(userId: string, roomId: string) {
      const binding = (await listBolterBindingsWith(db, { userId })).find(item => item.roomId === roomId && item.provider !== "magent");
      return { link: binding ? await linkSummary(binding) : null };
    },
    async updateBinding(userId: string, id: string, expectedRevision: number, state: "active" | "paused" | "revoked") {
      const existing = await getBolterBindingWith(db, { userId }, id);
      if (!existing || existing.provider === "magent") throw new BolterControlError("not_found");
      const row = await updateBolterBindingStateWith(db, { userId }, { bindingId: id, expectedRevision, state });
      if (!row) throw new BolterControlError("authority_changed");
      publishBolterStateChanged(userId);
      if (state === "active") await checkConnection(userId, row.connectionId);
      return linkSummary(row);
    },
    async sendReviewed(userId: string, id: string, input: BolterReviewedMessageRequest) {
      await requireMode(); const { binding, ctx } = await bindingContext(userId, id);
      if (input.expectedRevision !== binding.revision || binding.state !== "active") throw new BolterControlError("authority_changed");
      const actor = input.attachmentIds?.length ? await findActorByOwnerId(userId) : null;
      const attachments: BolterAttachmentDescriptor[] = [];
      if (input.attachmentIds?.length) {
        if (!actor || observations.get(ctx.connectionId)?.value.attachments !== true
          || (observations.get(ctx.connectionId)?.scope.selectedProtocolVersion ?? 0) < BOLTER_FILES_PROTOCOL_VERSION) throw new BolterControlError("unsupported_content");
        const rows = await loadBolterShareAttachmentsWith(db, ctx, { attachmentIds: input.attachmentIds, uploaderActorId: actor.id });
        if (rows.reduce((total, row) => total + row.sizeBytes, 0) > ATTACHMENT_POLICY.maxAcceptedBytesPerMessage) throw new BolterControlError("unsupported_content");
        for (const row of rows) {
          const bytes = await readBolterAttachmentBytes(row);
          attachments.push({ id: row.id, filename: row.filename, mimeType: row.mimeType, sizeBytes: row.sizeBytes,
            sha256: createHash("sha256").update(bytes).digest("hex") });
        }
        const fingerprint = bolterReviewedTextFingerprint(id, input.requestId, input.content, attachments);
        if (rows.some(row => row.status === "retained" && row.turnId !== fingerprint)) throw new BolterControlError("conflict");
      }
      let inserted = false;
      const outbox = await acceptBolterReviewedShareWith(db, ctx, { ...input, attachments }, async (tx, share) => {
        if (attachments.length) await retainBolterShareAttachmentsInTx(tx, { attachments, uploaderActorId: actor!.id,
          namespaceId: binding.namespaceId, fingerprint: share.fingerprint });
        const [room] = await tx.select({ threadId: rooms.graphThreadId }).from(rooms).where(eq(rooms.id, binding.roomId)).limit(1);
        if (!room) throw new BolterControlError("not_found");
        const turnId = randomUUID();
        const appended = await appendCanonicalTranscriptRowsInTx(tx, { session: { threadId: room.threadId, ownerId: userId,
          personaId: "owner", agentId: binding.agentId, roomId: binding.roomId, title: "Bolter conversation" },
          rows: [{ role: "user", content: input.content, fingerprint: share.fingerprint, humanTurnId: turnId,
            metadata: { bolterReviewedShare: { shareId: share.shareId, requestId: input.requestId },
              ...(attachments.length ? { bolterAttachments: attachments } : {}) }, replyToMessageId: null,
            toolCalls: null, toolName: null, transcriptOrigin: "main", parentThreadId: null, scopeId: null, subthreadRoomId: null }],
          notificationContext: { causalHumanUserId: null, causalHumanTurnId: null, mentionedHumanUserIds: [] } });
        const message = appended.insertedRows[0];
        if (!message || appended.failedIndices.length) throw new BolterControlError("authority_changed");
        inserted = true;
        return Number(message.id);
      });
      try { if (inserted) eventBus.emit({ type: "message.new", laneKey: `room:${binding.roomId}`, messageId: String(outbox.sessionMessageId), role: "user", content: input.content, sourceUserId: userId, senderUserId: userId,
        ...(attachments.length ? { attachments: attachments.map(file => ({ attachmentId: file.id, filename: file.filename, mimeType: file.mimeType, sizeBytes: file.sizeBytes })) } : {}) }); } catch { /* Canonical commit is authoritative. */ }
      void publishPending(ctx).catch(() => { warn("[bolter] publication remains pending"); });
      return { messageId: outbox.sessionMessageId, outboxId: outbox.id, state: outbox.state };
    },
    async deliveries(userId: string, id: string, selection?: BolterDeliverySelection) {
      if (!await getBolterBindingWith(db, { userId }, id)) throw new BolterControlError("not_found");
      return { deliveries: (await listBolterDeliverySummariesWith(db, { userId }, id, selection)).map(item => ({ ...item, createdAt: item.createdAt.toISOString() })) };
    },
    publishPending,
    wakePublications: publicationRecovery.wake,
    async close() { lifetime.abort(); for (const op of operations.values()) op.abort.abort(); for (const stop of dispose) stop();
      await Promise.allSettled(pendingWork);
      await publicationRecovery.stop();
      await Promise.allSettled(publishing.values()); observations.clear(); operations.clear(); choices.clear(); },
  };
}
export type BolterController = ReturnType<typeof createBolterController>;
