/**
 * Conversation-shell copy decisions (ISSUE-D145).
 *
 * Extracts the two empty-state / disabled-state copy decisions from
 * `Conversation` into pure helpers so they're greppable and unit-
 * testable. Without this, the decision tree lived as inline ternaries
 * inside JSX which made it easy to (a) miss `authenticated_resuming`
 * (review finding for PR #173) and (b) regress the
 * authenticated-but-disconnected-vs-guest distinction without any
 * test catching it.
 *
 * Both helpers are pure: take primitive inputs, return primitive
 * output. No React. No DOM. Tests pin the full decision matrix.
 */

import type { RuntimeShellState } from "../adapters/runtime-shell-state";

// ---------- Empty-state copy (the bug-locus pre-D145) -------------

export interface ConversationEmptyCopyInput {
  shellState: RuntimeShellState;
  /** auth.viewer.isVerified — true once whoami has confirmed the actor. */
  verified: boolean;
  /** Active room label, or null if no room is selected. */
  activeRoomLabel: string | null;
}

/**
 * Pre-D145, the empty-state copy was always one of:
 *   - "New conversation - send a message to get started." (verified + new chat)
 *   - "Hey — I'm here when you're ready. What's on your mind?" (everything else)
 *
 * The "everything else" branch was the bug: it rendered to
 * authenticated-but-disconnected users and read as "Nautilo lost
 * your conversation."
 *
 * Post-D145 we add a third branch — "Connection required …" — that
 * fires for ANY non-connected authenticated shell state where the
 * messages list happens to be empty. This includes both
 * `authenticated_disconnected` AND `authenticated_resuming` (review
 * finding for PR #173: tooltip and empty-copy must agree across
 * BOTH disconnected variants, not just one).
 *
 * `authenticated_idle` (D146-reserved) is treated as "intentionally
 * not connected, but we expect to reopen the moment the user looks
 * at the tab" — it falls through to the original guest copy because
 * surfacing "(connection required)" on a backgrounded tab would
 * be alarmist. D146's PR will revisit if needed.
 */
export function pickConversationEmptyCopy(
  input: ConversationEmptyCopyInput,
): string {
  const { shellState, verified, activeRoomLabel } = input;

  if (
    shellState.kind === "authenticated_disconnected" ||
    shellState.kind === "authenticated_resuming"
  ) {
    return "Connection required to load messages for this room. Reconnecting…";
  }

  if (verified && activeRoomLabel?.startsWith("New chat ")) {
    return "New conversation - send a message to get started.";
  }

  return "Hey — I'm here when you're ready. What's on your mind?";
}

// ---------- Composer disabled-tooltip copy ------------------------

export interface ComposerDisabledTitleInput {
  shellState: RuntimeShellState;
  /**
   * True when the WS transport is in the `"open"` state. We accept a
   * boolean rather than the raw transport-state union so this helper
   * stays agnostic to the derived `useWsState()` result shape
   * (which adds `"disconnected-long"` on top of the transport union).
   */
  wsOpen: boolean;
  /** True when an active room is selected and ready to receive sends. */
  roomReady: boolean;
}

/**
 * The composer's disabled-state tooltip. Returns `undefined` when
 * the composer is enabled (no tooltip needed).
 *
 * Pre-D145 review for PR #173 caught a regression here: the
 * disconnected-tooltip branch fired only on `authenticated_disconnected`
 * and silently fell through to "Waiting for server connection" during
 * `authenticated_resuming` — i.e. once a reconnect started, the user
 * lost the honest "your message will send when reconnected" copy
 * mid-outage. Both disconnected variants must produce the same
 * disconnected-tooltip text.
 */
export function pickComposerDisabledTitle(
  input: ComposerDisabledTitleInput,
): string | undefined {
  const { shellState, wsOpen, roomReady } = input;

  if (!roomReady) {
    return "Select an available room before sending";
  }

  if (
    shellState.kind === "authenticated_disconnected" ||
    shellState.kind === "authenticated_resuming"
  ) {
    return "Server unreachable — your message will send when reconnected.";
  }

  if (!wsOpen) {
    return "Waiting for server connection";
  }

  return undefined;
}
