export interface RevertRequest {
  revisionId?: string;
  path: string;
  zone?: "workspace" | "current" | "absolute";
  command?: string;
}

/** A whole-turn recovery request for the top-level multi-file apply_patch tool. */
export interface UndoTurnRequest {
  /** Trusted result field; callers must not derive this from a path or zone. */
  turnId: string;
}

let _sendText: ((text: string) => void) | null = null;
export type FocusedTurnPresentation = "advanced_video";

let _sendFocusedTurn: ((
  text: string,
  resources: readonly ChatFocusedResourceRef[],
  presentation?: FocusedTurnPresentation,
) => void) | null = null;

export function setRevertDispatcher(fn: ((text: string) => void) | null): void {
  _sendText = fn;
}

/**
 * Sends a card-authored follow-up with an exact, detached focused-resource
 * list. This deliberately does not borrow from or clear the visible Composer.
 */
export function setFocusedTurnDispatcher(
  fn: ((
    text: string,
    resources: readonly ChatFocusedResourceRef[],
    presentation?: FocusedTurnPresentation,
  ) => void) | null,
): void {
  _sendFocusedTurn = fn;
}

export function hasFocusedTurnDispatcher(): boolean {
  return _sendFocusedTurn !== null;
}

export function requestFocusedTurn(
  text: string,
  resources: readonly ChatFocusedResourceRef[],
  presentation?: FocusedTurnPresentation,
): boolean {
  if (!_sendFocusedTurn || text.trim().length === 0 || resources.length === 0) return false;
  _sendFocusedTurn(text, resources, presentation);
  return true;
}

export function hasRevertDispatcher(): boolean {
  return _sendText !== null;
}

export function requestRevert(req: RevertRequest): void {
  if (!_sendText) return;
  const command = req.command ?? "edit";
  const parts: string[] = [];
  if (req.zone) parts.push(`zone: ${req.zone}`);
  if (req.revisionId) parts.push(`revision: ${req.revisionId}`);
  const suffix = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  _sendText(`Revert the ${command} I just applied to ${req.path}${suffix}.`);
}

/**
 * Send the existing file.undo_turn invocation through the established tool
 * bridge. A multi-file patch has no safe per-path fallback: its trusted turn
 * id is the sole recovery scope, so no zone, path, or revision is inferred.
 */
export function requestUndoTurn(req: UndoTurnRequest): void {
  if (!_sendText || req.turnId.trim().length === 0) return;
  _sendText(`Use file with ${JSON.stringify({ command: "undo_turn", targetTurnId: req.turnId })}.`);
}
import type { ChatFocusedResourceRef } from "@nautilo/types";
