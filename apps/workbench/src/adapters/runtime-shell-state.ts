/**
 * RuntimeShellState — discriminated union for the workbench shell's
 * top-level lifecycle (ISSUE-D145, P-7 cross-boundary discriminated
 * union).
 *
 * Why this exists: prior to D145 the renderer collapsed
 * "authenticated user whose WS is mid-restart" and "unauthenticated
 * guest" into the same render path, both ending at `<EmptyState>`
 * with the generic "Hey — I'm here when you're ready" copy. Two
 * very different states, one (wrong) screen.
 *
 * RuntimeShellState makes the distinction explicit at the seam
 * between the runtime adapter and every consumer (Conversation
 * empty-state, composer disabled-tooltip, banner copy). The pure
 * `deriveRuntimeShellState()` is the only place the mapping lives;
 * tests pin every branch.
 *
 * The variant `authenticated_idle` is produced when the signed-in
 * tab intentionally idles the WS (ISSUE-D146 Option β — e.g.
 * `document.hidden`) so UI can distinguish intentional background
 * close from an unexpected disconnect.
 */

import type { WsTransportState } from "./runtime-contexts";

export type RuntimeShellState =
  | { kind: "bootstrapping" }
  | { kind: "unauthenticated" }
  | { kind: "authenticated_connecting" }
  | { kind: "authenticated_connected" }
  /** ISSUE-D146 — WS intentionally closed while tab is hidden (Option β). */
  | { kind: "authenticated_idle" }
  | { kind: "authenticated_disconnected"; lastOpenAt: number }
  | { kind: "authenticated_resuming"; reconnectStartedAt: number };

export interface DeriveShellStateInput {
  authState: "unknown" | "signed-out" | "signing-in" | "signed-in";
  /** Source of truth: `WsTransportState` from runtime-contexts. */
  wsState: WsTransportState;
  /** Epoch ms of last `wsState === "open"`, or null if never observed. */
  lastOpenAt: number | null;
  /** Epoch ms when current reconnect began, or null when not reconnecting. */
  reconnectStartedAt: number | null;
  /**
   * D146 — `document.hidden` while signed in. Omitted or `false` means
   * visible foreground (call sites that do not thread visibility yet).
   */
  visibilityHidden?: boolean | undefined;
}

/**
 * Pure derivation. The branching here is the single source of truth
 * for "what high-level shell state are we in" — no consumer should
 * re-derive locally.
 */
export function deriveRuntimeShellState(
  input: DeriveShellStateInput,
): RuntimeShellState {
  const { authState, wsState, lastOpenAt, reconnectStartedAt } = input;
  const visibilityHidden = input.visibilityHidden ?? false;

  if (authState === "unknown") {
    return { kind: "bootstrapping" };
  }
  if (authState !== "signed-in") {
    return { kind: "unauthenticated" };
  }

  if (wsState === "open") {
    return { kind: "authenticated_connected" };
  }

  // Signed-in, WS not currently open.
  // D146 — before disconnected/resuming: hidden + clean close + we've
  // been open this session (`lastOpenAt` set) means intentional idle, not
  // "first paint still connecting" (lastOpenAt null).
  if (
    visibilityHidden &&
    wsState === "closed" &&
    lastOpenAt !== null
  ) {
    return { kind: "authenticated_idle" };
  }

  if (lastOpenAt === null) {
    // Never been open this session — first connection still pending.
    return { kind: "authenticated_connecting" };
  }
  if (reconnectStartedAt !== null) {
    return { kind: "authenticated_resuming", reconnectStartedAt };
  }
  return { kind: "authenticated_disconnected", lastOpenAt };
}
