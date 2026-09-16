/**
 * D279 Phase 4 — ephemeral requester-private state for the `conductor.ask_user`
 * disambiguation picker. Module store + `useSyncExternalStore` so the WS
 * bridge can update without entering the runtime provider's React tree.
 */

import { useSyncExternalStore } from "react";
import type { ConductorAskUserEvent } from "@nautilo/types";

/** Mirrors `ConductorAskUserEvent.options[]`. */
export interface AskUserOption {
  readonly botActorId: string;
  readonly handle: string;
}

export interface AskUserPickerState {
  readonly active: boolean;
  readonly roomId: string | null;
  readonly messageId: string | null;
  /** D302 R13 — original human row's turn id; echoed as `resumeTurnId` on pick. */
  readonly humanTurnId: string | null;
  readonly options: readonly AskUserOption[];
  readonly pendingContent: string | null;
  readonly reason: string;
}

export const ASK_USER_TIMEOUT_MS = 90_000;

const INERT: AskUserPickerState = {
  active: false,
  roomId: null,
  messageId: null,
  humanTurnId: null,
  options: [],
  pendingContent: null,
  reason: "",
};

let state: AskUserPickerState = INERT;
const listeners = new Set<() => void>();
let timeoutId: ReturnType<typeof setTimeout> | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

export function getAskUserPickerState(): AskUserPickerState {
  return state;
}

export function subscribeAskUserPicker(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function clearAskUserPicker(): void {
  if (timeoutId !== null) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }
  state = INERT;
  emit();
}

function scheduleTimeout(): void {
  if (timeoutId !== null) clearTimeout(timeoutId);
  timeoutId = setTimeout(() => {
    timeoutId = null;
    clearAskUserPicker();
  }, ASK_USER_TIMEOUT_MS);
}

/**
 * Apply a scoped `conductor.ask_user` payload. NO-OP (and clears any stale
 * picker) when fewer than two options — matches Floor Manager last-resort rules.
 */
export function applyConductorAskUserEvent(
  event: Pick<
    ConductorAskUserEvent,
    "roomId" | "messageId" | "options" | "reason" | "humanTurnId"
  >,
  pendingContent: string | null = null,
): void {
  if (event.options.length < 2) {
    clearAskUserPicker();
    return;
  }

  state = {
    active: true,
    roomId: event.roomId,
    messageId: event.messageId,
    humanTurnId: event.humanTurnId ?? null,
    options: event.options.map((o) => ({
      botActorId: o.botActorId,
      handle: o.handle,
    })),
    pendingContent,
    reason: event.reason,
  };
  scheduleTimeout();
  emit();
}

/** Patch pending content once the thread hydrates the persisted human message. */
export function setAskUserPendingContent(content: string | null): void {
  if (!state.active || !content) return;
  state = { ...state, pendingContent: content };
  emit();
}

/** True when an active picker lists this bot as a disambiguation candidate. */
export function isAskUserCandidate(botActorId: string): boolean {
  return (
    state.active && state.options.some((option) => option.botActorId === botActorId)
  );
}

export function useAskUserPicker(): AskUserPickerState {
  return useSyncExternalStore(subscribeAskUserPicker, getAskUserPickerState, () => INERT);
}

type ThreadContentPart = { readonly type?: string; readonly text?: string };

/** Resolve persisted human-message text from the visible thread by numeric id. */
export function findMessageContentById(
  messages: readonly {
    readonly id?: string;
    readonly role?: string;
    readonly content?: readonly ThreadContentPart[] | string;
  }[],
  messageId: string | null,
): string | null {
  if (!messageId) return null;
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    if (String(msg.id ?? "") !== messageId) continue;
    if (typeof msg.content === "string") return msg.content.trim() || null;
    if (!Array.isArray(msg.content)) return null;
    const parts: readonly ThreadContentPart[] = msg.content;
    const text = parts
      .map((part) =>
        part.type === "text" && typeof part.text === "string" ? part.text : "",
      )
      .join("")
      .trim();
    return text.length > 0 ? text : null;
  }
  return null;
}
