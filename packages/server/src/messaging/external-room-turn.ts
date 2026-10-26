import { createHash } from "node:crypto";
import { z } from "zod";
import { externalMessageOriginSchema, type ExternalMessageOrigin } from "@nautilo/types";
import { bolterBindingMatches, bolterReceiverMatches, type BolterBindingContext, type BolterConnection,
  type BolterRoomBinding, type BolterInboundInsert } from "@nautilo/db";
import { assertAcceptedInvocationAuthoritySubject, getAcceptedInvocationAuthorityOrigin, restrictExternalRoomEnvelope,
  type AcceptedInvocationAuthority, type MemoryAccessEnvelope } from "@nautilo/trust";
import { isBolterMessageAddressed } from "./bolter-addressing";

const opaqueId = z.string().min(1).refine((value) => value.trim() === value && !/\s/u.test(value)
  && [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127));
const providerTextSchema = z.object({
  type: z.literal("message"), messageId: opaqueId, chatId: opaqueId,
  threadRootId: opaqueId.nullable(), senderId: opaqueId,
  senderType: z.enum(["user", "anima", "system"]),
  senderLabel: z.string().min(1).optional(),
  content: z.string().refine((value) => value.trim().length > 0),
  createdAt: z.iso.datetime({ offset: true }),
  addressed: z.boolean(), truncated: z.boolean(), redelivered: z.boolean(),
}).strict();

export type ExternalRoomIntakeFailure = "unsupported-content" | "unsupported-mode" | "stale-binding"
  | "destination-mismatch" | "echo" | "not-addressed" | "sponsor-authority-unavailable" | "namespace-mismatch";

/** Canonical server snapshots; never populate these fields from the provider body. */
export interface ExternalRoomIntakeContext {
  readonly receiver: BolterBindingContext;
  readonly connection: BolterConnection;
  readonly binding: BolterRoomBinding;
  readonly memoryEnvelope: MemoryAccessEnvelope;
  readonly representationMode: string;
  readonly invocationAuthority: AcceptedInvocationAuthority;
}

export interface PreparedExternalRoomTurn {
  readonly roomId: string;
  readonly agentId: string;
  readonly graphThreadId: string;
  readonly sponsorUserId: string;
  readonly bindingContext: Readonly<BolterBindingContext>;
  readonly origin: ExternalMessageOrigin;
  /** Exact provider text, including slash commands; no skill/command expansion. */
  readonly literalText: string;
  readonly memoryEnvelope: MemoryAccessEnvelope;
  readonly invocationAuthority: AcceptedInvocationAuthority;
  readonly receipt: Readonly<BolterInboundInsert>;
}

export type ExternalRoomIntakeResult =
  | { readonly ok: true; readonly turn: PreparedExternalRoomTurn }
  | { readonly ok: false; readonly reason: ExternalRoomIntakeFailure };

/**
 * Pure intake preparation, not live admission. Call acceptBolterInboundWith using
 * the returned context/receipt, then revalidate the locked binding before storing
 * the canonical message and Job in its transaction. No message body is duplicated
 * in the receipt, and no imported text is interpreted as Human authorization.
 */
export function prepareBolterExternalRoomTurn(context: ExternalRoomIntakeContext, raw: unknown): ExternalRoomIntakeResult {
  return prepareExternalRoomTurn(context, raw, "bolter");
}

export function prepareMagentExternalRoomTurn(context: ExternalRoomIntakeContext, raw: unknown): ExternalRoomIntakeResult {
  return prepareExternalRoomTurn(context, raw, "magent");
}

function prepareExternalRoomTurn(context: ExternalRoomIntakeContext, raw: unknown, provider: "bolter" | "magent"): ExternalRoomIntakeResult {
  const fail = (reason: ExternalRoomIntakeFailure): ExternalRoomIntakeResult => ({ ok: false, reason });
  if (context.representationMode !== "plaintext_only") return fail("unsupported-mode");
  const { receiver, connection, binding } = context;
  if (!binding.modelSponsorshipAcceptedAt) return fail("sponsor-authority-unavailable");
  if (!bolterReceiverMatches(connection, receiver) || !bolterBindingMatches(binding, receiver)
    || (connection.provider ?? "bolter") !== provider || (binding.provider ?? "bolter") !== provider
    || (provider === "bolter" ? binding.origin !== "https://bolter.chat" || (connection.transportKind ?? "desktop-relay") !== "desktop-relay"
      : connection.transportKind !== "operator-unix") || connection.origin !== binding.origin
    || connection.providerAgentId !== binding.providerAgentId) return fail("stale-binding");
  try {
    assertAcceptedInvocationAuthoritySubject(context.invocationAuthority, receiver.userId);
    const acceptedOrigin = getAcceptedInvocationAuthorityOrigin(context.invocationAuthority);
    if (acceptedOrigin.originRoomId !== binding.roomId || acceptedOrigin.originTaskId !== undefined) {
      return fail("sponsor-authority-unavailable");
    }
  }
  catch { return fail("sponsor-authority-unavailable"); }
  const envelope = context.memoryEnvelope;
  if (envelope.externalContext !== true || envelope.roomId !== binding.roomId
    || envelope.agentId !== binding.agentId || envelope.ownerId !== receiver.userId
    || !("readableNamespaces" in envelope)
    || !envelope.readableNamespaces.includes(binding.namespaceId)) return fail("namespace-mismatch");
  const parsed = providerTextSchema.safeParse(raw);
  if (!parsed.success || parsed.data.truncated) return fail("unsupported-content");
  const message = parsed.data;
  if (message.chatId !== binding.chatId || (message.threadRootId ?? "") !== binding.threadId) return fail("destination-mismatch");
  if (message.senderType === "system" || message.senderId === binding.providerAgentId) return fail("echo");
  if (provider === "magent" && message.senderType !== "anima") return fail("unsupported-content");
  if (!isBolterMessageAddressed(message, binding.providerAgentId)) return fail("not-addressed");
  const originResult = externalMessageOriginSchema.safeParse({
    kind: "external_message", version: 1, provider, origin: binding.origin,
    connectionId: connection.id, bindingId: binding.id, providerAgentId: binding.providerAgentId,
    chatId: message.chatId, threadRootId: message.threadRootId, messageId: message.messageId,
    senderId: message.senderId, senderType: message.senderType,
    senderLabel: message.senderLabel ?? message.senderId, createdAt: message.createdAt,
  });
  if (!originResult.success) return fail("unsupported-content");
  const origin = originResult.data;
  // Delivery flags and mutable display labels do not alter immutable message identity.
  const fingerprint = createHash("sha256").update(JSON.stringify([
    origin.provider, origin.origin, origin.providerAgentId, origin.chatId, origin.threadRootId,
    origin.messageId, origin.senderId, origin.senderType, origin.createdAt, message.content,
  ]), "utf8").digest("hex");
  const restricted = restrictExternalRoomEnvelope(envelope, binding.namespaceId);
  if (!("readableNamespaces" in restricted)) return fail("namespace-mismatch");
  Object.freeze(restricted.readableNamespaces);
  Object.freeze(restricted.writableNamespaces);
  Object.freeze(restricted.mutableNamespaces);
  Object.freeze(restricted.toolPolicy);
  const memoryEnvelope = Object.freeze(restricted);
  return { ok: true, turn: Object.freeze({ roomId: binding.roomId, agentId: binding.agentId,
    graphThreadId: `room:${binding.roomId}:bot:${binding.agentId}`, sponsorUserId: receiver.userId,
    bindingContext: Object.freeze({ ...receiver }), origin, literalText: message.content,
    memoryEnvelope, invocationAuthority: context.invocationAuthority,
    receipt: Object.freeze({ providerMessageId: message.messageId, fingerprint,
      externalSenderId: message.senderId }),
  }) };
}

/** Use with the binding freshly locked by acceptBolterInboundWith, never a cached row. */
export function externalRoomTurnMatchesLockedBinding(turn: PreparedExternalRoomTurn, binding: BolterRoomBinding): boolean {
  return bolterBindingMatches(binding, turn.bindingContext)
    && binding.roomId === turn.roomId && binding.agentId === turn.agentId
    && (binding.provider ?? "bolter") === turn.origin.provider && binding.origin === turn.origin.origin && binding.providerAgentId === turn.origin.providerAgentId
    && binding.chatId === turn.origin.chatId && binding.threadId === (turn.origin.threadRootId ?? "")
    && "readableNamespaces" in turn.memoryEnvelope
    && turn.memoryEnvelope.readableNamespaces.length === 1
    && turn.memoryEnvelope.readableNamespaces[0] === binding.namespaceId;
}
