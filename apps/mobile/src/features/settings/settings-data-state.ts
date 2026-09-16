import {
  EMPTY_RECOVERY_SECRET_STATE,
  transitionRecoverySecretState,
  type RecoverySecretState,
} from "@/lib/settings-secret-state";

/**
 * The identity boundary for all server-backed Settings state. It deliberately
 * matches the fresh-reauth identity: a server alone is not a safe cache key.
 */
export interface SettingsDataScope {
  serverId: string;
  userId: string;
  actorId: string;
}

export interface SettingsViewerSnapshot {
  status: string;
  viewerState: string;
  viewer: { userId: string; actorId: string } | null;
}

export interface SettingsServerSnapshot {
  id: string;
}

/**
 * Build the only scope a Settings screen may commit into: an active server and
 * a viewer AuthProvider has verified for that server. Cached/stale viewers are
 * intentionally not sufficient for actionable Settings data.
 */
export function settingsScopeForVerifiedViewer(
  activeServer: SettingsServerSnapshot | null,
  auth: SettingsViewerSnapshot,
): SettingsDataScope | null {
  if (
    !activeServer ||
    auth.status !== "signed-in" ||
    auth.viewerState !== "verified" ||
    !auth.viewer
  ) {
    return null;
  }
  return {
    serverId: activeServer.id,
    userId: auth.viewer.userId,
    actorId: auth.viewer.actorId,
  };
}

export function sameSettingsDataScope(
  left: SettingsDataScope | null,
  right: SettingsDataScope | null,
): boolean {
  return (
    left?.serverId === right?.serverId &&
    left?.userId === right?.userId &&
    left?.actorId === right?.actorId
  );
}

export interface SettingsDataState<TData, TDraft> {
  scope: SettingsDataScope | null;
  data: TData | null;
  /** Drafts are deliberately user-entered, non-secret state only. */
  draft: TDraft | null;
  secret: RecoverySecretState;
  loading: boolean;
  mutating: boolean;
  loadError: Error | null;
  mutationError: Error | null;
}

export type SettingsLoadResult<TData> =
  | { status: "applied"; data: TData }
  | { status: "ignored" }
  | { status: "failed"; error: unknown };

export type SettingsMutationResult<TData> = SettingsLoadResult<TData>;

/** A successful destructive action intentionally leaves no detail to render. */
export type SettingsClearMutationResult =
  | { status: "applied" }
  | { status: "ignored" }
  | { status: "failed"; error: unknown };

export type SettingsLoader<TData> = (scope: SettingsDataScope) => Promise<TData>;
export type SettingsMutation = (scope: SettingsDataScope) => Promise<void>;

/**
 * A Settings read must not leave a route indefinitely in "Refreshing" when a
 * server or transport has stopped responding. This is deliberately a local
 * ownership fence rather than a global fetch timeout: mutations retain their
 * normal uncertain-outcome semantics, and each screen can offer an explicit
 * retry after this controller reports the failed read.
 */
const SETTINGS_READ_DEADLINE_MS = 15_000;

export interface SettingsDataStateOptions {
  /** Test seam for the finite Settings read deadline. Invalid values stay finite. */
  readDeadlineMs?: number;
  scheduleReadDeadline?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  clearReadDeadline?: (handle: ReturnType<typeof setTimeout>) => void;
}

type ReadOutcome<TData> =
  | { kind: "applied"; data: TData }
  | { kind: "failed"; error: unknown }
  | { kind: "deadline" }
  | { kind: "cancelled" };

interface PendingRead {
  cancel(): void;
}

export interface SettingsDataStateController<TData, TDraft> {
  getState(): Readonly<SettingsDataState<TData, TDraft>>;
  subscribe(listener: () => void): () => void;
  /** Change identity, logout, auth-dead, or server switch: erase all owned state. */
  setScope(scope: SettingsDataScope | null): void;
  /** Route cleanup: make every outstanding completion inert and erase custody state. */
  dispose(): void;
  setDraft(draft: TDraft | null): void;
  clearDraft(): void;
  revealSecret(secret: string): boolean;
  clearSecret(): void;
  load(loader: SettingsLoader<TData>): Promise<SettingsLoadResult<TData>>;
  /** Alias kept explicit at call sites where a user is retrying a failed read. */
  retryLoad(loader: SettingsLoader<TData>): Promise<SettingsLoadResult<TData>>;
  /**
   * Write, then re-fetch canonical server state before reporting success. A
   * failed write/reload leaves the non-secret draft intact for a retry.
   */
  mutate(
    mutation: SettingsMutation,
    reload: SettingsLoader<TData>,
  ): Promise<SettingsMutationResult<TData>>;
  /**
   * Complete a destructive server mutation and erase the route-owned detail.
   * This is deliberately not a fake GET-after-DELETE: a 404 after a confirmed
   * delete is the expected state, not a mutation failure.
   */
  mutateAndClear(mutation: SettingsMutation): Promise<SettingsClearMutationResult>;
}

/**
 * A deliberately small ownership fence for Settings screens. It is not a
 * query cache: each screen owns one controller and feeds it the current
 * ServerRegistryProvider/AuthProvider scope. A scope change increments both
 * generations, so promises from a previous server, viewer, route lifetime, or
 * earlier retry can finish but can never commit visible state.
 */
export function createSettingsDataState<TData, TDraft>(
  options: SettingsDataStateOptions = {},
): SettingsDataStateController<
  TData,
  TDraft
> {
  const deadlineMs: number = Number.isFinite(options.readDeadlineMs) && (options.readDeadlineMs ?? 0) > 0
    ? options.readDeadlineMs!
    : SETTINGS_READ_DEADLINE_MS;
  const scheduleReadDeadline = options.scheduleReadDeadline
    ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearReadDeadline = options.clearReadDeadline
    ?? ((handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));
  let disposed = false;
  let readGeneration = 0;
  let mutationGeneration = 0;
  let state: SettingsDataState<TData, TDraft> = emptyState(null);
  const listeners = new Set<() => void>();
  const pendingReads = new Map<number, PendingRead>();

  const emit = (): void => {
    for (const listener of listeners) listener();
  };
  const replace = (next: SettingsDataState<TData, TDraft>): void => {
    state = next;
    emit();
  };
  const canCommitRead = (scope: SettingsDataScope, generation: number): boolean =>
    !disposed && readGeneration === generation && sameSettingsDataScope(state.scope, scope);
  const canCommitMutation = (scope: SettingsDataScope, generation: number): boolean =>
    !disposed && mutationGeneration === generation && sameSettingsDataScope(state.scope, scope);

  const cancelPendingReads = (): void => {
    for (const read of pendingReads.values()) read.cancel();
    pendingReads.clear();
  };

  const runLoad = async (
    loader: SettingsLoader<TData>,
  ): Promise<SettingsLoadResult<TData>> => {
    const scope = state.scope;
    if (disposed || !scope) return { status: "ignored" };
    const generation = ++readGeneration;
    // A later explicit refresh replaces an earlier read. The older request is
    // not necessarily abortable in React Native, but its timer and UI claim
    // are both cancelled immediately and its eventual completion is inert.
    cancelPendingReads();
    replace({ ...state, loading: true, loadError: null });

    let deadline: ReturnType<typeof setTimeout> | null = null;
    let resolveBoundary!: (outcome: Extract<ReadOutcome<TData>, { kind: "deadline" | "cancelled" }>) => void;
    let settled = false;
    const boundary = new Promise<Extract<ReadOutcome<TData>, { kind: "deadline" | "cancelled" }>>(
      (resolve) => {
        resolveBoundary = resolve;
      },
    );
    const settleBoundary = (outcome: Extract<ReadOutcome<TData>, { kind: "deadline" | "cancelled" }>): void => {
      if (settled) return;
      settled = true;
      if (deadline !== null) {
        clearReadDeadline(deadline);
        deadline = null;
      }
      resolveBoundary(outcome);
    };
    const clearPendingRead = (): void => {
      pendingReads.delete(generation);
      if (deadline !== null) {
        clearReadDeadline(deadline);
        deadline = null;
      }
    };
    const request = Promise.resolve()
      .then(() => loader(scope))
      .then(
        (data): ReadOutcome<TData> => ({ kind: "applied", data }),
        (error: unknown): ReadOutcome<TData> => ({ kind: "failed", error }),
      );
    pendingReads.set(generation, { cancel: () => settleBoundary({ kind: "cancelled" }) });
    deadline = scheduleReadDeadline(() => settleBoundary({ kind: "deadline" }), deadlineMs);

    const outcome = await Promise.race([request, boundary]);
    clearPendingRead();

    if (!canCommitRead(scope, generation) || outcome.kind === "cancelled") {
      return { status: "ignored" };
    }
    if (outcome.kind === "deadline") {
      // Fence the actual fetch too: many React Native transport layers finish
      // after local cancellation, so a late success must never revive this UI.
      readGeneration += 1;
      const error = new Error("Nautilo did not respond. Try again.");
      replace({ ...state, loading: false, loadError: error });
      return { status: "failed", error };
    }
    if (outcome.kind === "applied") {
      replace({ ...state, data: outcome.data, loading: false, loadError: null });
      return { status: "applied", data: outcome.data };
    }
    replace({ ...state, loading: false, loadError: toError(outcome.error) });
    return { status: "failed", error: outcome.error };
  };

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    setScope(scope) {
      if (disposed || sameSettingsDataScope(state.scope, scope)) return;
      cancelPendingReads();
      readGeneration += 1;
      mutationGeneration += 1;
      replace(emptyState(scope));
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      cancelPendingReads();
      readGeneration += 1;
      mutationGeneration += 1;
      state = emptyState(null);
      listeners.clear();
    },

    setDraft(draft) {
      if (disposed || !state.scope) return;
      replace({ ...state, draft });
    },

    clearDraft() {
      if (disposed || state.draft === null) return;
      replace({ ...state, draft: null });
    },

    revealSecret(secret) {
      if (disposed || !state.scope) return false;
      replace({
        ...state,
        secret: transitionRecoverySecretState(state.secret, { type: "reveal", secret }),
      });
      return true;
    },

    clearSecret() {
      if (disposed || state.secret.status === "hidden") return;
      replace({
        ...state,
        secret: transitionRecoverySecretState(state.secret, { type: "scope-change" }),
      });
    },

    load: runLoad,
    retryLoad: runLoad,

    async mutate(mutation, reload) {
      const scope = state.scope;
      if (disposed || !scope) return { status: "ignored" };
      const generation = ++mutationGeneration;
      // A retry may retain a non-secret draft, never a one-time reveal.
      replace({
        ...state,
        secret: EMPTY_RECOVERY_SECRET_STATE,
        mutating: true,
        mutationError: null,
      });

      try {
        await mutation(scope);
      } catch (error) {
        if (!canCommitMutation(scope, generation)) return { status: "ignored" };
        replace({ ...state, mutating: false, mutationError: toError(error) });
        return { status: "failed", error };
      }

      if (!canCommitMutation(scope, generation)) return { status: "ignored" };
      const refreshed = await runLoad(reload);
      if (!canCommitMutation(scope, generation)) return { status: "ignored" };

      if (refreshed.status === "applied") {
        replace({ ...state, mutating: false, mutationError: null });
      } else if (refreshed.status === "failed") {
        replace({ ...state, mutating: false, mutationError: toError(refreshed.error) });
      } else {
        return { status: "ignored" };
      }
      return refreshed;
    },

    async mutateAndClear(mutation) {
      const scope = state.scope;
      if (disposed || !scope) return { status: "ignored" };
      const generation = ++mutationGeneration;
      // A concurrent GET cannot revive the just-deleted detail afterwards.
      cancelPendingReads();
      readGeneration += 1;
      replace({
        ...state,
        secret: EMPTY_RECOVERY_SECRET_STATE,
        loading: false,
        mutating: true,
        mutationError: null,
      });
      try {
        await mutation(scope);
      } catch (error) {
        if (!canCommitMutation(scope, generation)) return { status: "ignored" };
        replace({ ...state, mutating: false, mutationError: toError(error) });
        return { status: "failed", error };
      }
      if (!canCommitMutation(scope, generation)) return { status: "ignored" };
      replace({
        ...state,
        data: null,
        draft: null,
        secret: EMPTY_RECOVERY_SECRET_STATE,
        loading: false,
        mutating: false,
        mutationError: null,
      });
      return { status: "applied" };
    },
  };
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error("Settings request failed");
}

function emptyState<TData, TDraft>(
  scope: SettingsDataScope | null,
): SettingsDataState<TData, TDraft> {
  return {
    scope,
    data: null,
    draft: null,
    secret: EMPTY_RECOVERY_SECRET_STATE,
    loading: false,
    mutating: false,
    loadError: null,
    mutationError: null,
  };
}
