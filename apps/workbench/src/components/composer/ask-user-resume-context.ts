import type { NautiloApiClient } from "@nautilo/api-client/browser";

import { ASK_USER_TIMEOUT_MS } from "./ask-user-state";

type RoomMessageBody = Parameters<NautiloApiClient["sendRoomMessage"]>[1];

export type AskUserResumeContext = Omit<
  RoomMessageBody,
  | "content"
  | "uiSelectedBotActorId"
  | "resumeTurnId"
  | "resumeMessageId"
  | "clientActionSessionId"
  | "liveShadow"
>;

interface RetainedAskUserResumeContext {
  readonly roomId: string;
  readonly messageId: number;
  readonly expiresAt: number;
  readonly context: AskUserResumeContext;
}

const retainedByMessage = new Map<string, RetainedAskUserResumeContext>();

function normalizeMessageId(messageId: number | string | null): number | null {
  const parsed = typeof messageId === "number" ? messageId : Number(messageId);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function contextKey(roomId: string, messageId: number): string {
  return `${roomId}:${messageId}`;
}

function withoutResumeOnlyFields(body: RoomMessageBody): AskUserResumeContext {
  const context = structuredClone(body) as unknown as Record<string, unknown>;
  delete context.content;
  delete context.uiSelectedBotActorId;
  delete context.resumeTurnId;
  delete context.resumeMessageId;
  delete context.clientActionSessionId;
  delete context.liveShadow;
  return context as AskUserResumeContext;
}

/**
 * Retain the exact non-content envelope from a canonical Human room send.
 * The Conductor can ask the same client to choose a responder after that send
 * has completed; the picker must not rebuild a smaller request and silently
 * discard attachments, focused resources, model choice, or host authority.
 */
export function rememberAskUserResumeContext(
  roomId: string,
  messageId: number | null,
  body: RoomMessageBody,
  now: number = Date.now(),
): void {
  const normalizedMessageId = normalizeMessageId(messageId);
  if (!roomId || normalizedMessageId === null) return;
  for (const [key, retained] of retainedByMessage) {
    if (retained.expiresAt <= now) retainedByMessage.delete(key);
  }
  const key = contextKey(roomId, normalizedMessageId);
  retainedByMessage.delete(key);
  retainedByMessage.set(key, {
    roomId,
    messageId: normalizedMessageId,
    expiresAt: now + ASK_USER_TIMEOUT_MS,
    context: withoutResumeOnlyFields(body),
  });
}

/** Return a fresh copy only for the exact active picker message. */
export function readAskUserResumeContext(
  roomId: string,
  messageId: number | string | null,
  now: number = Date.now(),
): AskUserResumeContext | null {
  const normalizedMessageId = normalizeMessageId(messageId);
  if (normalizedMessageId === null) return null;
  const key = contextKey(roomId, normalizedMessageId);
  const retained = retainedByMessage.get(key);
  if (
    retained === undefined
    || retained.expiresAt <= now
  ) {
    if (retained?.expiresAt !== undefined && retained.expiresAt <= now) {
      retainedByMessage.delete(key);
    }
    return null;
  }
  return structuredClone(retained.context);
}

export function clearAskUserResumeContext(
  roomId?: string,
  messageId?: number | string | null,
): void {
  if (!roomId) {
    retainedByMessage.clear();
    return;
  }
  const normalizedMessageId = normalizeMessageId(messageId ?? null);
  if (normalizedMessageId !== null) {
    retainedByMessage.delete(contextKey(roomId, normalizedMessageId));
    return;
  }
  for (const [key, retained] of retainedByMessage) {
    if (retained.roomId === roomId) retainedByMessage.delete(key);
  }
}
