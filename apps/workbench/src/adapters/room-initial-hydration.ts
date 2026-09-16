/**
 * Pure initial-history state for the active Room (ISSUE-D530).
 *
 * This is deliberately independent of message payloads, cache I/O, and
 * pagination. The runtime owns those concerns; consumers need only a truthful
 * projection of whether the active Room's first history frame is resolved.
 */

/**
 * The authority fence captured when a Room hydration attempt starts.
 *
 * `viewerGeneration` changes whenever the authenticated viewer or server
 * context changes, so a late completion cannot be accepted merely because it
 * happens to target the same Room id.
 */
export interface RoomInitialHydrationScope {
  readonly origin: string;
  readonly viewerKey: string;
  readonly viewerGeneration: number;
  readonly roomId: string;
  readonly generation: number;
}

export type RoomInitialHydrationState =
  | { readonly kind: "unresolved"; readonly scope: RoomInitialHydrationScope }
  | { readonly kind: "syncing"; readonly scope: RoomInitialHydrationScope }
  | { readonly kind: "ready"; readonly scope: RoomInitialHydrationScope }
  | { readonly kind: "empty"; readonly scope: RoomInitialHydrationScope }
  | {
      readonly kind: "waiting-for-authority";
      readonly scope: RoomInitialHydrationScope;
      /** A resolved partial page may still use the separately gated current write path. */
      readonly sendAuthorized: boolean;
    }
  | {
      readonly kind: "recoverable-error";
      readonly scope: RoomInitialHydrationScope;
      /** Whether the existing disconnect-cache policy permits the stale frame to remain visible. */
      readonly retainsCachedFrame: boolean;
    }
  | {
      readonly kind: "access-terminal-error";
      readonly scope: RoomInitialHydrationScope;
      readonly reason: "unauthorized" | "not-found";
    };

export type RoomInitialHydrationTransition =
  | { readonly kind: "cache-hit"; readonly scope: RoomInitialHydrationScope }
  | { readonly kind: "cache-miss"; readonly scope: RoomInitialHydrationScope }
  | { readonly kind: "server-success"; readonly scope: RoomInitialHydrationScope }
  | { readonly kind: "server-empty"; readonly scope: RoomInitialHydrationScope }
  | {
      readonly kind: "server-waiting-for-authority";
      readonly scope: RoomInitialHydrationScope;
      readonly sendAuthorized: boolean;
    }
  | {
      readonly kind: "server-failure";
      readonly scope: RoomInitialHydrationScope;
      readonly retainCachedFrame: boolean;
    }
  | {
      readonly kind: "access-terminal";
      readonly scope: RoomInitialHydrationScope;
      readonly reason: "unauthorized" | "not-found";
    };

export type RoomInitialHydrationDisclosure =
  | "skeletons"
  | "syncing-latest"
  | "waiting-for-authority"
  | "none";

/** Starts a new active Room attempt; callers allocate a new generation for retries and selections. */
export function beginRoomInitialHydration(
  scope: RoomInitialHydrationScope,
): RoomInitialHydrationState {
  return { kind: "unresolved", scope };
}

/**
 * Applies an event only when it still belongs to the exact active attempt.
 * Superseded cache reads and server responses are therefore explicit no-ops.
 */
export function transitionRoomInitialHydration(
  state: RoomInitialHydrationState,
  transition: RoomInitialHydrationTransition,
): RoomInitialHydrationState {
  if (!isCurrentRoomInitialHydrationScope(state.scope, transition.scope)) {
    return state;
  }

  switch (transition.kind) {
    case "cache-hit":
      return state.kind === "unresolved"
        ? { kind: "syncing", scope: state.scope }
        : state;
    case "cache-miss":
      return state;
    case "server-success":
      return isRoomInitialHydrationPending(state)
        ? { kind: "ready", scope: state.scope }
        : state;
    case "server-empty":
      return isRoomInitialHydrationPending(state)
        ? { kind: "empty", scope: state.scope }
        : state;
    case "server-waiting-for-authority":
      return isRoomInitialHydrationPending(state)
        ? {
            kind: "waiting-for-authority",
            scope: state.scope,
            sendAuthorized: transition.sendAuthorized,
          }
        : state;
    case "server-failure":
      return isRoomInitialHydrationPending(state)
        ? {
            kind: "recoverable-error",
            scope: state.scope,
            retainsCachedFrame: state.kind === "syncing" && transition.retainCachedFrame,
          }
        : state;
    case "access-terminal":
      return isRoomInitialHydrationPending(state)
        ? {
            kind: "access-terminal-error",
            scope: state.scope,
            reason: transition.reason,
          }
        : state;
  }
}

function isRoomInitialHydrationPending(
  state: RoomInitialHydrationState,
): state is Extract<RoomInitialHydrationState, {
  kind: "unresolved" | "syncing" | "waiting-for-authority";
}> {
  return state.kind === "unresolved" || state.kind === "syncing"
    || state.kind === "waiting-for-authority";
}

/** Exact matching prevents cross-server, cross-viewer, cross-Room, and stale-generation commits. */
function isCurrentRoomInitialHydrationScope(
  active: RoomInitialHydrationScope,
  candidate: RoomInitialHydrationScope,
): boolean {
  return active.origin === candidate.origin &&
    active.viewerKey === candidate.viewerKey &&
    active.viewerGeneration === candidate.viewerGeneration &&
    active.roomId === candidate.roomId &&
    active.generation === candidate.generation;
}

/** The transcript renders one loading disclosure, never a stack of indicators. */
export function deriveRoomInitialHydrationDisclosure(
  state: RoomInitialHydrationState,
): RoomInitialHydrationDisclosure {
  switch (state.kind) {
    case "unresolved":
      return "skeletons";
    case "syncing":
      return "syncing-latest";
    case "waiting-for-authority":
      return "waiting-for-authority";
    case "ready":
    case "empty":
    case "recoverable-error":
    case "access-terminal-error":
      return "none";
  }
}
