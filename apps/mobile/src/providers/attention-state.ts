import type {
  ApprovalAskEvent,
  ApprovalReplyVerb,
  ApprovalResolvedEvent,
  IdentityChallengeEvent,
  ProveItChallengeEvent,
  ServerEvent,
} from "@nautilo/types";

/**
 * The only mutable custody model behind Mobile attention. React renders a
 * snapshot of this value, but websocket admission and network begins mutate
 * this one scoped record synchronously first.
 */
export interface AttentionScope {
  readonly serverId: string;
  readonly serverUrl: string;
  readonly userId: string;
  readonly actorId: string;
  readonly epoch: number;
}

export type PinChallenge =
  | { readonly kind: "prove_it"; readonly event: ProveItChallengeEvent }
  | { readonly kind: "identity"; readonly event: IdentityChallengeEvent };

export type TaskPinChallengeEvent = ProveItChallengeEvent | IdentityChallengeEvent;

export interface ApprovalAttempt {
  readonly approval: ApprovalAskEvent;
  readonly verb: ApprovalReplyVerb;
  readonly source: "auto" | "manual";
}

export interface ApprovalRecord {
  readonly approval: ApprovalAskEvent;
  /** Auto-approve asks are invisible until their exact POST rejects. */
  readonly hidden: boolean;
  readonly attempt: ApprovalAttempt | null;
}

export interface ChallengeAttempt {
  readonly challenge: PinChallenge;
  readonly action: "resolve" | "deny";
}

export interface ChallengeRecord {
  readonly challenge: PinChallenge;
  /** Hidden identity challenges remain reopenable from their exact Task. */
  readonly presented: boolean;
  readonly attempt: ChallengeAttempt | null;
}

export interface AttentionAuthorityState {
  readonly scope: AttentionScope | null;
  readonly approvals: readonly ApprovalRecord[];
  /** Bounded authoritative terminal evidence; never inferred from messages. */
  readonly approvalTombstones: readonly string[];
  readonly challenge: ChallengeRecord | null;
}

const EMPTY_ATTENTION_AUTHORITY: AttentionAuthorityState = Object.freeze({
  scope: null,
  approvals: [],
  approvalTombstones: [],
  challenge: null,
});

const MAX_TOMBSTONES = 64;

export function sameAttentionScope(left: AttentionScope | null, right: AttentionScope | null): boolean {
  return left?.serverId === right?.serverId
    && left?.serverUrl === right?.serverUrl
    && left?.userId === right?.userId
    && left?.actorId === right?.actorId
    && left?.epoch === right?.epoch;
}

/**
 * All Task-shaped attention is requester-private. Legacy room prompts may omit
 * `userId` for compatibility, but a Task prompt without it is never admitted.
 */
export function mayAdmitAttentionEvent(scope: AttentionScope, event: ServerEvent): boolean {
  if (event.type === "approval.resolved") return event.userId === scope.userId;
  const candidate = event as ServerEvent & {
    readonly userId?: string;
    readonly origin?: "task";
    readonly taskId?: string;
    readonly taskRunId?: string;
  };
  const taskShaped = isTaskShaped(candidate);
  if (taskShaped) return candidate.userId === scope.userId;
  return candidate.userId === undefined || candidate.userId === scope.userId;
}

export function taskApprovalMatches(approval: ApprovalAskEvent, taskId: string, taskRunId?: string | null): boolean {
  return isExactTaskApproval(approval)
    && approval.taskId === taskId
    && (taskRunId === undefined || approval.taskRunId === taskRunId);
}

export function taskChallengeMatches(event: TaskPinChallengeEvent, taskId: string, taskRunId?: string | null): boolean {
  return isExactTaskChallenge(event)
    && event.taskId === taskId
    && (taskRunId === undefined || event.taskRunId === taskRunId);
}

export function isExpiredChallenge(event: IdentityChallengeEvent, now = Date.now()): boolean {
  const expiresAt = Date.parse(event.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now;
}

function scopedBase(state: AttentionAuthorityState, scope: AttentionScope): AttentionAuthorityState {
  return sameAttentionScope(state.scope, scope)
    ? state
    : { ...EMPTY_ATTENTION_AUTHORITY, scope };
}

function approvalIdentity(approval: ApprovalAskEvent): string {
  return [
    "approval",
    approval.approvalId,
    approval.threadId,
    approval.laneKey,
    approval.origin ?? "room",
    approval.taskId ?? "",
    approval.taskRunId ?? "",
  ].join("\u0001");
}

function isExactTaskApproval(approval: ApprovalAskEvent): boolean {
  return approval.origin === "task"
    && typeof approval.taskId === "string"
    && approval.taskId.length > 0
    && typeof approval.taskRunId === "string"
    && approval.taskRunId.length > 0
    && approval.laneKey === `task:${approval.taskId}`;
}

function isTaskShaped(value: { readonly origin?: "task"; readonly taskId?: string; readonly taskRunId?: string }): boolean {
  return value.origin !== undefined || value.taskId !== undefined || value.taskRunId !== undefined;
}

function isExactTaskChallenge(event: TaskPinChallengeEvent): boolean {
  return event.origin === "task"
    && typeof event.taskId === "string"
    && event.taskId.length > 0
    && typeof event.taskRunId === "string"
    && event.taskRunId.length > 0
    && event.laneKey === `task:${event.taskId}`;
}

function legacyApprovalKey(approvalId: string, threadId: string, laneKey?: string): string {
  return ["room", approvalId, threadId, laneKey ?? ""].join("\u0001");
}

function legacyApprovalBaseKey(approvalId: string, threadId: string): string {
  return legacyApprovalKey(approvalId, threadId);
}

function terminalKey(event: ApprovalResolvedEvent): string | null {
  const taskShaped = event.origin !== undefined || event.taskId !== undefined || event.taskRunId !== undefined;
  if (taskShaped) {
    if (
      event.origin !== "task"
      || typeof event.taskId !== "string"
      || event.taskId.length === 0
      || typeof event.taskRunId !== "string"
      || event.taskRunId.length === 0
      || event.laneKey !== `task:${event.taskId}`
    ) return null;
    return ["approval", event.approvalId, event.threadId, event.laneKey, "task", event.taskId, event.taskRunId].join("\u0001");
  }
  return event.laneKey === undefined
    ? legacyApprovalBaseKey(event.approvalId, event.threadId)
    : legacyApprovalKey(event.approvalId, event.threadId, event.laneKey);
}

function approvalTombstoneKeys(approval: ApprovalAskEvent): readonly string[] {
  if (isExactTaskApproval(approval)) return [approvalIdentity(approval)];
  return [
    legacyApprovalKey(approval.approvalId, approval.threadId, approval.laneKey),
    legacyApprovalBaseKey(approval.approvalId, approval.threadId),
  ];
}

function isApprovalTombstoned(approval: ApprovalAskEvent, tombstones: readonly string[]): boolean {
  return approvalTombstoneKeys(approval).some((key) => tombstones.includes(key));
}

function appendTombstone(tombstones: readonly string[], key: string): readonly string[] {
  return tombstones.includes(key) ? tombstones : [...tombstones, key].slice(-MAX_TOMBSTONES);
}

function recordMatchesTerminal(record: ApprovalRecord, terminal: string): boolean {
  return approvalTombstoneKeys(record.approval).includes(terminal);
}

/** Synchronously admit a fresh ask and atomically reserve its one auto POST. */
function admitApprovalAsk(
  state: AttentionAuthorityState,
  scope: AttentionScope,
  approval: ApprovalAskEvent,
  autoResolve: boolean,
): { readonly state: AttentionAuthorityState; readonly autoAttempt: ApprovalAttempt | null } {
  const base = scopedBase(state, scope);
  if (isTaskShaped(approval) && !isExactTaskApproval(approval)) return { state: base, autoAttempt: null };
  if (isApprovalTombstoned(approval, base.approvalTombstones)) return { state: base, autoAttempt: null };
  const identity = approvalIdentity(approval);
  if (base.approvals.some((record) => approvalIdentity(record.approval) === identity)) {
    return { state: base, autoAttempt: null };
  }
  const autoAttempt = autoResolve && approval.allowedVerbs.includes("once")
    ? { approval, verb: "once" as const, source: "auto" as const }
    : null;
  const record: ApprovalRecord = { approval, hidden: autoAttempt !== null, attempt: autoAttempt };
  return { state: { ...base, approvals: [...base.approvals, record] }, autoAttempt };
}

/** Authoritative terminal evidence wins even when it arrives before its ask. */
function admitApprovalResolved(
  state: AttentionAuthorityState,
  scope: AttentionScope,
  event: ApprovalResolvedEvent,
): AttentionAuthorityState {
  const base = scopedBase(state, scope);
  const terminal = terminalKey(event);
  // A malformed task terminal must not clear or suppress any Task request.
  if (!terminal) return base;
  return {
    ...base,
    approvalTombstones: appendTombstone(base.approvalTombstones, terminal),
    approvals: base.approvals.filter((record) => !recordMatchesTerminal(record, terminal)),
  };
}

function isReplyAllowed(approval: ApprovalAskEvent, verb: ApprovalReplyVerb): boolean {
  if (!approval.allowedVerbs.includes(verb)) return false;
  if (!approval.requiresExplicitReview) return true;
  const hasExactEvidence = approval.localMcpInstall?.digest !== undefined
    || approval.structuredSsh !== undefined;
  return hasExactEvidence && (verb === "once" || verb === "deny");
}

/** Validates before beginning; callers POST only a non-null returned attempt. */
function beginApprovalReply(
  state: AttentionAuthorityState,
  scope: AttentionScope,
  expected: ApprovalAskEvent,
  verb: ApprovalReplyVerb,
): { readonly state: AttentionAuthorityState; readonly attempt: ApprovalAttempt | null } {
  if (!sameAttentionScope(state.scope, scope) || !isReplyAllowed(expected, verb)) {
    return { state, attempt: null };
  }
  const index = state.approvals.findIndex((record) => record.approval === expected);
  if (index < 0 || state.approvals[index].hidden || state.approvals[index].attempt !== null) {
    return { state, attempt: null };
  }
  const attempt: ApprovalAttempt = { approval: expected, verb, source: "manual" };
  const approvals = state.approvals.slice();
  approvals[index] = { ...approvals[index], attempt };
  return { state: { ...state, approvals }, attempt };
}

/** Every HTTP outcome settles only its still-current exact attempt. */
function settleApprovalAttempt(
  state: AttentionAuthorityState,
  scope: AttentionScope,
  attempt: ApprovalAttempt,
  ok: boolean,
): AttentionAuthorityState {
  if (!sameAttentionScope(state.scope, scope)) return state;
  const index = state.approvals.findIndex((record) => record.attempt === attempt);
  if (index < 0) return state;
  if (ok) {
    const terminal = isExactTaskApproval(attempt.approval)
      ? approvalIdentity(attempt.approval)
      : legacyApprovalKey(attempt.approval.approvalId, attempt.approval.threadId, attempt.approval.laneKey);
    return {
      ...state,
      approvalTombstones: appendTombstone(state.approvalTombstones, terminal),
      approvals: state.approvals.filter((_, currentIndex) => currentIndex !== index),
    };
  }
  const approvals = state.approvals.slice();
  approvals[index] = { ...approvals[index], hidden: false, attempt: null };
  return { ...state, approvals };
}

function admitChallenge(
  state: AttentionAuthorityState,
  scope: AttentionScope,
  challenge: PinChallenge,
  now = Date.now(),
): AttentionAuthorityState {
  const base = scopedBase(state, scope);
  if (isTaskShaped(challenge.event) && !isExactTaskChallenge(challenge.event)) return base;
  if (challenge.kind === "identity" && isExpiredChallenge(challenge.event, now)) return base;
  return { ...base, challenge: { challenge, presented: true, attempt: null } };
}

function presentChallenge(
  state: AttentionAuthorityState,
  scope: AttentionScope,
  expected: PinChallenge,
): AttentionAuthorityState {
  if (!sameAttentionScope(state.scope, scope) || state.challenge?.challenge !== expected) return state;
  return state.challenge.presented ? state : { ...state, challenge: { ...state.challenge, presented: true } };
}

/** Hide is intentionally non-terminal: an exact Task affordance may reopen it. */
function hideChallenge(
  state: AttentionAuthorityState,
  scope: AttentionScope,
  expected: PinChallenge,
): AttentionAuthorityState {
  if (!sameAttentionScope(state.scope, scope) || state.challenge?.challenge !== expected || state.challenge.attempt !== null) return state;
  return state.challenge.presented ? { ...state, challenge: { ...state.challenge, presented: false } } : state;
}

function expireChallenge(
  state: AttentionAuthorityState,
  scope: AttentionScope,
  expected: PinChallenge,
  now = Date.now(),
): AttentionAuthorityState {
  if (
    !sameAttentionScope(state.scope, scope)
    || state.challenge?.challenge !== expected
    || expected.kind !== "identity"
    || !isExpiredChallenge(expected.event, now)
  ) return state;
  return { ...state, challenge: null };
}

function beginChallenge(
  state: AttentionAuthorityState,
  scope: AttentionScope,
  expected: PinChallenge,
  action: "resolve" | "deny",
  pin?: string,
): { readonly state: AttentionAuthorityState; readonly attempt: ChallengeAttempt | null } {
  if (!sameAttentionScope(state.scope, scope) || state.challenge?.challenge !== expected || state.challenge.attempt !== null) {
    return { state, attempt: null };
  }
  if (expected.kind === "identity" && isExpiredChallenge(expected.event)) return { state, attempt: null };
  if (action === "resolve" && !/^\d{6,8}$/.test(pin ?? "")) return { state, attempt: null };
  const attempt: ChallengeAttempt = { challenge: expected, action };
  return { state: { ...state, challenge: { ...state.challenge, attempt } }, attempt };
}

function settleChallengeAttempt(
  state: AttentionAuthorityState,
  scope: AttentionScope,
  attempt: ChallengeAttempt,
  ok: boolean,
): AttentionAuthorityState {
  if (!sameAttentionScope(state.scope, scope) || state.challenge?.attempt !== attempt) return state;
  if (ok) return { ...state, challenge: null };
  return { ...state, challenge: { ...state.challenge, attempt: null } };
}

/** Identity has no denial endpoint; cancel hides the exact still-current record. */
function denyIdentityChallenge(
  state: AttentionAuthorityState,
  scope: AttentionScope,
  expected: PinChallenge,
): AttentionAuthorityState {
  if (expected.kind !== "identity") return state;
  return hideChallenge(state, scope, expected);
}

/** The provider injects only canonical API calls; this coordinator owns admission. */
export interface AttentionAuthorityEndpoints {
  readonly approvalReply: (scope: AttentionScope, approval: ApprovalAskEvent, verb: ApprovalReplyVerb) => Promise<boolean>;
  readonly proveIt: (scope: AttentionScope, challenge: ProveItChallengeEvent, pin: string) => Promise<boolean>;
  readonly denyProveIt: (scope: AttentionScope, challenge: ProveItChallengeEvent) => Promise<boolean>;
  readonly verifyIdentity: (scope: AttentionScope, challenge: IdentityChallengeEvent, pin: string) => Promise<boolean>;
  readonly enrollPin: (scope: AttentionScope, challenge: IdentityChallengeEvent, pin: string) => Promise<boolean>;
}

export interface AttentionAuthorityCoordinatorInput {
  readonly currentScope: () => AttentionScope | null;
  readonly endpoints: AttentionAuthorityEndpoints;
  readonly onStateChange: (next: AttentionAuthorityState) => void;
  readonly onEndpointError?: (error: unknown, scope: AttentionScope) => Promise<void> | void;
}

export interface AttentionAuthorityCoordinator {
  getState: () => AttentionAuthorityState;
  reconcileScope: (scope: AttentionScope | null) => void;
  receiveApproval: (scope: AttentionScope, approval: ApprovalAskEvent, autoResolve: boolean) => void;
  receiveResolvedApproval: (scope: AttentionScope, event: ApprovalResolvedEvent) => void;
  receiveChallenge: (scope: AttentionScope, challenge: PinChallenge) => void;
  replyApproval: (scope: AttentionScope, expected: ApprovalAskEvent, verb: ApprovalReplyVerb) => Promise<{ ok: boolean }>;
  resolveChallenge: (scope: AttentionScope, expected: PinChallenge, pin: string) => Promise<{ ok: boolean }>;
  denyChallenge: (scope: AttentionScope, expected: PinChallenge) => Promise<{ ok: boolean }>;
  presentChallenge: (scope: AttentionScope, expected: PinChallenge) => void;
  hideChallenge: (scope: AttentionScope, expected: PinChallenge) => void;
  expireChallenge: (scope: AttentionScope, expected: PinChallenge, now?: number) => void;
}

/**
 * One production-used, injectable coordinator. A begin transition is committed
 * before its endpoint starts; every response returns through the same exact
 * settlement fence. Tests use this object with fake endpoints.
 */
export function createAttentionAuthorityCoordinator(input: AttentionAuthorityCoordinatorInput): AttentionAuthorityCoordinator {
  let state: AttentionAuthorityState = EMPTY_ATTENTION_AUTHORITY;
  const commit = (next: AttentionAuthorityState): void => {
    if (next === state) return;
    state = next;
    input.onStateChange(next);
  };
  const scopeIsCurrent = (scope: AttentionScope): boolean => sameAttentionScope(input.currentScope(), scope);
  const settleForScope = (scope: AttentionScope, settle: () => AttentionAuthorityState): void => {
    if (scopeIsCurrent(scope)) commit(settle());
    else coordinator.reconcileScope(input.currentScope());
  };
  const reportError = async (error: unknown, scope: AttentionScope): Promise<void> => {
    // Recovery reporting itself is never allowed to strand the exact attempt.
    try { await input.onEndpointError?.(error, scope); } catch { /* settle below */ }
  };

  const executeApproval = async (scope: AttentionScope, attempt: ApprovalAttempt): Promise<{ ok: boolean }> => {
    let ok = false;
    try {
      ok = await input.endpoints.approvalReply(scope, attempt.approval, attempt.verb);
    } catch (error) {
      await reportError(error, scope);
    } finally {
      settleForScope(scope, () => settleApprovalAttempt(state, scope, attempt, ok));
    }
    return { ok };
  };

  const executeChallenge = async (
    scope: AttentionScope,
    attempt: ChallengeAttempt,
    pin: string | undefined,
  ): Promise<{ ok: boolean }> => {
    let ok = false;
    try {
      if (attempt.action === "deny") {
        // `beginChallenge` permits deny only for prove-it (identity is handled
        // synchronously below), keeping the endpoint choice unambiguous.
        ok = attempt.challenge.kind === "prove_it"
          ? await input.endpoints.denyProveIt(scope, attempt.challenge.event)
          : false;
      } else if (attempt.challenge.kind === "prove_it") {
        ok = await input.endpoints.proveIt(scope, attempt.challenge.event, pin!);
      } else if (attempt.challenge.event.mode === "enrollPin") {
        ok = await input.endpoints.enrollPin(scope, attempt.challenge.event, pin!);
      } else {
        ok = await input.endpoints.verifyIdentity(scope, attempt.challenge.event, pin!);
      }
    } catch (error) {
      await reportError(error, scope);
    } finally {
      settleForScope(scope, () => settleChallengeAttempt(state, scope, attempt, ok));
    }
    return { ok };
  };

  const coordinator: AttentionAuthorityCoordinator = {
    getState: () => state,
    reconcileScope: (scope) => {
      if (scope === null) commit(EMPTY_ATTENTION_AUTHORITY);
      else if (!sameAttentionScope(state.scope, scope)) commit({ ...EMPTY_ATTENTION_AUTHORITY, scope });
    },
    receiveApproval: (scope, approval, autoResolve) => {
      if (!scopeIsCurrent(scope)) return;
      const admitted = admitApprovalAsk(state, scope, approval, autoResolve);
      commit(admitted.state);
      if (admitted.autoAttempt) void executeApproval(scope, admitted.autoAttempt);
    },
    receiveResolvedApproval: (scope, event) => {
      if (scopeIsCurrent(scope)) commit(admitApprovalResolved(state, scope, event));
    },
    receiveChallenge: (scope, challenge) => {
      if (scopeIsCurrent(scope)) commit(admitChallenge(state, scope, challenge));
    },
    replyApproval: async (scope, expected, verb) => {
      if (!scopeIsCurrent(scope)) return { ok: false };
      const begun = beginApprovalReply(state, scope, expected, verb);
      commit(begun.state);
      return begun.attempt ? executeApproval(scope, begun.attempt) : { ok: false };
    },
    resolveChallenge: async (scope, expected, pin) => {
      if (!scopeIsCurrent(scope)) return { ok: false };
      const begun = beginChallenge(state, scope, expected, "resolve", pin);
      commit(begun.state);
      return begun.attempt ? executeChallenge(scope, begun.attempt, pin) : { ok: false };
    },
    denyChallenge: async (scope, expected) => {
      if (!scopeIsCurrent(scope)) return { ok: false };
      if (expected.kind === "identity") {
        if (isExpiredChallenge(expected.event)) {
          commit(expireChallenge(state, scope, expected));
          return { ok: false };
        }
        const next = denyIdentityChallenge(state, scope, expected);
        const changed = next !== state;
        commit(next);
        return { ok: changed };
      }
      const begun = beginChallenge(state, scope, expected, "deny");
      commit(begun.state);
      return begun.attempt ? executeChallenge(scope, begun.attempt, undefined) : { ok: false };
    },
    presentChallenge: (scope, expected) => {
      if (!scopeIsCurrent(scope)) return;
      if (expected.kind === "identity" && isExpiredChallenge(expected.event)) {
        commit(expireChallenge(state, scope, expected));
      } else {
        commit(presentChallenge(state, scope, expected));
      }
    },
    hideChallenge: (scope, expected) => {
      if (scopeIsCurrent(scope)) commit(hideChallenge(state, scope, expected));
    },
    expireChallenge: (scope, expected, now) => {
      if (scopeIsCurrent(scope)) commit(expireChallenge(state, scope, expected, now));
    },
  };
  return coordinator;
}
