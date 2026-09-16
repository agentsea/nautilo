/**
 * ISSUE-D440 — pure approval lifecycle reducer.
 *
 * The Workbench approval dock (`ApprovalAskState`) is driven by this
 * reducer so that the approval lifecycle is a single, testable state
 * machine keyed by `approvalId` / `threadId` / `laneKey` identity,
 * rather than scattered `setApprovalAskState(...)` call sites whose
 * invariants live only in the prose comments around them.
 *
 * Why this exists (grounded verdict for D440):
 *   - Backend ordering is safe: `approval.ask` → decision → resume →
 *     `tool.start` → side effect → `tool.end`. The defect is purely
 *     Workbench stale state after a lost HTTP acknowledgement and
 *     after late / duplicate `approval.ask` events.
 *   - Lost ack must reconcile on AUTHORITATIVE terminal evidence, not
 *     on a 200 that may never arrive and not on unrelated tool/job
 *     events. The server emits requester-private `approval.resolved`
 *     after canonical resume settles. Until that event arrives, the
 *     conservative reconciliation is: do NOT clear on a lost ack;
 *     keep the dock visible so the user can retry. We never infer
 *     resolution from `tool.end` / `job.status` / arbitrary tool text.
 *   - Completion / denial / cancellation / expiry clears EXACTLY ONCE.
 *     A late or duplicate `approval.ask` for an already-terminal
 *     `approvalId` cannot reopen the dock.
 *   - Unrelated tool / job events never clear another approval.
 *
 * The reducer is pure (no React, no WS, no network). The provider in
 * `nautilo-runtime.tsx` is the only place that dispatches actions.
 */

import type {
  ApprovalAskNetworkContext,
  ApprovalAskReason,
  ApprovalReplyVerb,
  ApprovalScopeInfo,
  LocalMcpInstallApproval,
  MediaGenerationApproval,
  StructuredSshApproval,
  ProveItToolInfo,
} from "@nautilo/types";

export interface PendingApprovalPreviewQueue<T> {
  readonly active: T | null;
  readonly waiting: readonly T[];
}

export function initialPendingApprovalPreviewQueue<T>(): PendingApprovalPreviewQueue<T> {
  return { active: null, waiting: [] };
}

export function enqueuePendingApprovalPreviews<T>(
  state: PendingApprovalPreviewQueue<T>,
  incoming: readonly T[],
  keyOf?: (item: T) => string,
): PendingApprovalPreviewQueue<T> {
  const additions = keyOf === undefined ? incoming : incoming.filter((item, index) => {
    const key = keyOf(item);
    return state.active === null || keyOf(state.active) !== key
      ? !state.waiting.some((waiting) => keyOf(waiting) === key)
        && incoming.findIndex((candidate) => keyOf(candidate) === key) === index
      : false;
  });
  if (additions.length === 0) return state;
  if (state.active !== null) {
    return { active: state.active, waiting: [...state.waiting, ...additions] };
  }
  return { active: additions[0] ?? null, waiting: [...additions.slice(1)] };
}

export function settlePendingApprovalPreview<T>(
  state: PendingApprovalPreviewQueue<T>,
  matches: (active: T) => boolean = () => true,
): PendingApprovalPreviewQueue<T> {
  if (state.active === null || !matches(state.active)) return state;
  return {
    active: state.waiting[0] ?? null,
    waiting: state.waiting.slice(1),
  };
}

export function reconcilePendingApprovalPreviewSnapshot<T>(
  state: PendingApprovalPreviewQueue<T>,
  canonical: readonly T[],
  keyOf: (item: T) => string,
): Readonly<{ queue: PendingApprovalPreviewQueue<T>; retainedActive: boolean }> {
  const unique = canonical.filter((item, index) =>
    canonical.findIndex((candidate) => keyOf(candidate) === keyOf(item)) === index);
  if (state.active !== null) {
    const activeKey = keyOf(state.active);
    if (unique.some((item) => keyOf(item) === activeKey)) {
      return Object.freeze({
        retainedActive: true,
        queue: Object.freeze({
          active: state.active,
          waiting: Object.freeze(unique.filter((item) => keyOf(item) !== activeKey)),
        }),
      });
    }
  }
  return Object.freeze({
    retainedActive: false,
    queue: Object.freeze({ active: unique[0] ?? null, waiting: Object.freeze(unique.slice(1)) }),
  });
}

/** How an approval id reached its terminal state. */
export type ApprovalResolution =
  | "approved"
  | "denied"
  | "cancelled"
  | "expired";

/**
 * The payload of an `approval.ask` event, narrowed to the fields the
 * dock renders. Kept as a value type (not the full `ApprovalAskEvent`)
 * so the reducer does not depend on the WS envelope and is trivially
 * constructable in tests.
 */
export interface ApprovalAskPayload {
  /** Room captured when the authenticated approval event was received. */
  roomId?: string;
  approvalId: string;
  threadId: string;
  laneKey: string;
  tools: ProveItToolInfo[];
  reason: string;
  reasonCode: ApprovalAskReason | null;
  network: ApprovalAskNetworkContext | null;
  allowedVerbs: ApprovalReplyVerb[];
  scopeInfo: ApprovalScopeInfo[];
  localMcpInstall?: LocalMcpInstallApproval | null;
  mediaGeneration?: MediaGenerationApproval | null;
  structuredSsh?: StructuredSshApproval | null;
  requiresExplicitReview?: boolean;
}

/**
 * The reducer's view of the world. The dock's `ApprovalAskState` is a
 * pure derivation of `pending` + `hidden` + `submitting` + `error`
 * (see {@link deriveApprovalAskView}).
 */
export interface ApprovalLifecycleState {
  /** The currently-pending ask, or null when no dock is armed. */
  readonly pending: ApprovalAskPayload | null;
  /**
   * When true, an ask is armed (pending) but the dock is NOT shown.
   * Used by the D375 Auto-Approve path, which fires the HTTP reply
   * without surfacing the dock; on failure `submitError` flips this
   * to false so the user can retry. Keeps the no-flash auto-approve
   * UX while still arming the terminality guard.
   */
  readonly hidden: boolean;
  /** UI submit in-flight flag (mirrors `ApprovalAskState.submitting`). */
  readonly submitting: boolean;
  /** Last submit error (mirrors `ApprovalAskState.error`). null when clean. */
  readonly error: string | null;
  /**
   * Terminal approvalIds. A late or duplicate `ask` for an id in this set
   * is ignored — the dock cannot be reopened for a resolved approval.
   * Session-scoped; deliberately NOT cleared on room switch so switching
   * rooms cannot be used to resurrect a terminal approval.
   */
  readonly resolvedApprovalIds: ReadonlySet<string>;
}

/** Actions the provider dispatches. */
export type ApprovalLifecycleAction =
  | { kind: "ask"; payload: ApprovalAskPayload; silent?: boolean }
  | { kind: "submitStart" }
  | { kind: "submitAck"; approvalId?: string; resolution: ApprovalResolution }
  | { kind: "submitError"; approvalId?: string; error: string }
  | {
      kind: "resolved";
      approvalId: string;
      resolution: ApprovalResolution;
      /** `server-event` = authoritative `approval.resolved`; `submit-ack` = local HTTP ack. */
      source: "server-event" | "submit-ack";
    }
  | { kind: "hide" };

export function initialApprovalLifecycleState(): ApprovalLifecycleState {
  return {
    pending: null,
    hidden: false,
    submitting: false,
    error: null,
    resolvedApprovalIds: new Set<string>(),
  };
}

export function shouldQueueApprovalAsk(
  state: ApprovalLifecycleState,
  approvalId: string,
): boolean {
  return !state.resolvedApprovalIds.has(approvalId);
}

/**
 * Map a reply verb to a resolution. `deny` → `denied`; any approve-grain
 * verb (`once` / `room` / `always`) → `approved`. This is the ONLY place
 * that interprets the verb, so the reducer stays the single source of
 * truth for "did the user approve or deny".
 */
export function resolutionFromVerb(verb: ApprovalReplyVerb): ApprovalResolution {
  return verb === "deny" ? "denied" : "approved";
}

/**
 * Pure reducer. All invariants live here:
 *
 * 1. **Late / duplicate ask guard.** `ask` for an id already in
 *    `resolvedApprovalIds` is a no-op — the dock stays in whatever
 *    state it is in (hidden if already cleared, or the newer pending
 *    ask if a different id is showing). A terminal approval can never
 *    be reopened.
 *
 * 2. **Exactly-once clear.** `submitAck` and `resolved` both clear
 *    `pending` and record the id as terminal. Repeated `resolved` for
 *    the same id is idempotent (the set dedups; a null `pending` stays
 *    null). The dock is cleared exactly once.
 *
 * 3. **Lost ack stays visible.** `submitError` clears `submitting` and
 *    records `error` but KEEPS `pending` — the dock stays visible so
 *    the user can retry. We do not invent terminal evidence.
 *
 * 4. **Unrelated events don't clear.** There is no action for
 *    `tool.end` / `job.status` / arbitrary tool text. The provider
 *    never dispatches one, so by construction those events cannot
 *    clear another approval.
 *
 * 5. **Matched clear only.** `resolved` (server-event) clears the dock
 *    only when its `approvalId` matches the pending ask. A server
 *    resolution for a different (or stale) id does not wipe a newer
 *    pending ask — it just records that id as terminal.
 */
export function reduceApprovalLifecycle(
  state: ApprovalLifecycleState,
  action: ApprovalLifecycleAction,
): ApprovalLifecycleState {
  switch (action.kind) {
    case "ask": {
      // Late / duplicate ask guard — terminal ids never reopen.
      if (state.resolvedApprovalIds.has(action.payload.approvalId)) {
        return state;
      }
      return {
        ...state,
        pending: action.payload,
        hidden: action.silent === true,
        submitting: false,
        error: null,
      };
    }

    case "submitStart": {
      if (state.pending === null) return state;
      return { ...state, submitting: true, error: null };
    }

    case "submitAck": {
      // Client-authoritative: the server accepted the user's decision.
      // Clear the dock exactly once + record terminality so a late ask
      // for this id cannot reopen it.
      if (state.pending === null) {
        // Nothing visible (e.g. a duplicate ack); still nothing to clear.
        return state;
      }
      if (action.approvalId !== undefined && action.approvalId !== state.pending.approvalId) {
        return state;
      }
      const resolvedApprovalIds = new Set(state.resolvedApprovalIds);
      resolvedApprovalIds.add(state.pending.approvalId);
      return {
        pending: null,
        hidden: false,
        submitting: false,
        error: null,
        resolvedApprovalIds,
      };
    }

    case "submitError": {
      // Lost ack — surface the dock (flip hidden off) with the error so
      // the user can retry. Do NOT record terminality (we don't know
      // whether the server received the decision).
      if (state.pending === null) return state;
      if (action.approvalId !== undefined && action.approvalId !== state.pending.approvalId) {
        return state;
      }
      return { ...state, hidden: false, submitting: false, error: action.error };
    }

    case "resolved": {
      // Authoritative terminal evidence (server `approval.resolved`)
      // or a local submit-ack. Idempotent: a repeated resolution for
      // an already-terminal id is a no-op beyond set membership.
      const resolvedApprovalIds = new Set(state.resolvedApprovalIds);
      resolvedApprovalIds.add(action.approvalId);

      // Clear the dock ONLY when the resolution matches the pending
      // ask. A resolution for a stale / different id must not wipe a
      // newer pending ask.
      if (state.pending !== null && state.pending.approvalId === action.approvalId) {
        return {
          pending: null,
          hidden: false,
          submitting: false,
          error: null,
          resolvedApprovalIds,
        };
      }
      return { ...state, resolvedApprovalIds };
    }

    case "hide": {
      // Room switch / rehydrate: hide the dock but KEEP the terminal
      // set so a late ask for a resolved id still cannot reopen.
      if (state.pending === null && state.error === null && !state.submitting) {
        return state;
      }
      return { ...state, pending: null, hidden: false, submitting: false, error: null };
    }

    default: {
      // Exhaustiveness check — a new action kind added without a
      // reducer case is a compile error here.
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

/**
 * The dock-facing view, structurally identical to `ApprovalAskState`
 * (defined in `adapters/runtime-contexts.ts`). Kept as a local
 * interface so the pure module does not import from a React-context
 * file; the adapter assigns the result to `ApprovalAskState`.
 */
export interface ApprovalAskView {
  roomId?: string;
  show: boolean;
  approvalId: string | null;
  tools: ProveItToolInfo[];
  reason: string;
  reasonCode: ApprovalAskReason | null;
  network: ApprovalAskNetworkContext | null;
  allowedVerbs: ApprovalReplyVerb[];
  scopeInfo: ApprovalScopeInfo[];
  localMcpInstall: LocalMcpInstallApproval | null;
  mediaGeneration: MediaGenerationApproval | null;
  structuredSsh: StructuredSshApproval | null;
  requiresExplicitReview: boolean;
  error: string | null;
  submitting: boolean;
}

const DEFAULT_ALLOWED_VERBS: ApprovalReplyVerb[] = ["once", "room", "always", "deny"];

/**
 * Derive the dock-facing view from the lifecycle state. The dock is
 * shown iff an ask is pending AND not hidden (the auto-approve silent
 * path arms `pending` without showing).
 */
export function deriveApprovalAskView(state: ApprovalLifecycleState): ApprovalAskView {
  const pending = state.pending;
  if (pending === null) {
    return {
      show: false,
      approvalId: null,
      tools: [],
      reason: "",
      reasonCode: null,
      network: null,
      allowedVerbs: DEFAULT_ALLOWED_VERBS,
      scopeInfo: [],
      localMcpInstall: null,
      mediaGeneration: null,
      structuredSsh: null,
      requiresExplicitReview: false,
      error: state.error,
      submitting: state.submitting,
    };
  }
  return {
    show: !state.hidden,
    ...(pending.roomId ? { roomId: pending.roomId } : {}),
    approvalId: pending.approvalId,
    tools: pending.tools,
    reason: pending.reason,
    reasonCode: pending.reasonCode,
    network: pending.network,
    allowedVerbs: pending.allowedVerbs,
    scopeInfo: pending.scopeInfo,
    localMcpInstall: pending.localMcpInstall ?? null,
    mediaGeneration: pending.mediaGeneration ?? null,
    structuredSsh: pending.structuredSsh ?? null,
    requiresExplicitReview: pending.requiresExplicitReview === true,
    error: state.error,
    submitting: state.submitting,
  };
}
