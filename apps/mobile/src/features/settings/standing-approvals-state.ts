import type { NautiloApiClient } from "@nautilo/api-client/browser";

import {
  createSettingsDataState,
  sameSettingsDataScope,
  type SettingsDataScope,
  type SettingsDataStateController,
  type SettingsLoadResult,
  type SettingsMutationResult,
} from "@/features/settings/settings-data-state";

/** Uses the shared client response instead of recreating its wire DTO locally. */
export type StandingApproval = Awaited<ReturnType<NautiloApiClient["listStandingApprovals"]>>[number];

export interface StandingApprovalsApi {
  list(scope: SettingsDataScope): Promise<StandingApproval[]>;
  revoke(scope: SettingsDataScope, id: string): Promise<void>;
}

export interface StandingApprovalPresentation {
  title: string;
  scope: string;
  tool: string;
  room: string | null;
}

export type StandingApprovalsFailure =
  | { kind: "signed-out" }
  | { kind: "forbidden" }
  | { kind: "failed"; message: string };

export type StandingApprovalsScreenState =
  | { kind: "loading" }
  | {
      kind: "ready";
      approvals: readonly StandingApproval[];
      mutating: boolean;
      mutationFailure: StandingApprovalsFailure | null;
      /** DELETE succeeded; retry must refresh the canonical list, never DELETE again. */
      canonicalRefreshPending: boolean;
    }
  | StandingApprovalsFailure;

/** Human-readable, focused detail without introducing a second approval DTO. */
export function standingApprovalPresentation(row: StandingApproval): StandingApprovalPresentation {
  const isCapability = row.approvalKind === "capability";
  return {
    title: row.label,
    scope: row.scope === "room" ? "This room" : "This server",
    tool: isCapability
      ? `Capability: ${row.capabilitySlug ?? row.label}`
      : `Tool: ${row.toolPattern}`,
    room: row.scope === "room" ? row.roomLabel ?? row.roomId ?? "Unknown room" : null,
  };
}

export function standingApprovalsFailure(error: unknown): StandingApprovalsFailure {
  const status =
    error !== null && typeof error === "object" && "status" in error &&
    typeof (error as { status?: unknown }).status === "number"
      ? (error as { status: number }).status
      : null;
  if (status === 401) return { kind: "signed-out" };
  if (status === 403) return { kind: "forbidden" };
  return {
    kind: "failed",
    message: error instanceof Error && error.message ? error.message : "Could not load standing approvals.",
  };
}

export interface StandingApprovalsController {
  getState: SettingsDataStateController<StandingApproval[], null>["getState"];
  subscribe: SettingsDataStateController<StandingApproval[], null>["subscribe"];
  setScope: SettingsDataStateController<StandingApproval[], null>["setScope"];
  dispose: SettingsDataStateController<StandingApproval[], null>["dispose"];
  hasPendingCanonicalRefresh(): boolean;
  load(api: StandingApprovalsApi): Promise<SettingsLoadResult<StandingApproval[]>>;
  retry(api: StandingApprovalsApi): Promise<SettingsLoadResult<StandingApproval[]>>;
  /** Only an active row from the canonical list may be revoked. */
  revoke(
    id: string,
    api: StandingApprovalsApi,
  ): Promise<SettingsMutationResult<StandingApproval[]>>;
}

/**
 * Owns no cache of its own: the shared Settings fence is the source of truth.
 * Mutation intentionally re-reads before making the completed state visible.
 */
export function createStandingApprovalsController(): StandingApprovalsController {
  const state = createSettingsDataState<StandingApproval[], null>();
  let refreshScope: SettingsDataScope | null = null;

  const hasPendingCanonicalRefresh = (): boolean =>
    refreshScope !== null && sameSettingsDataScope(state.getState().scope, refreshScope);
  const clearRefreshIfCurrentScopeChanged = (): void => {
    if (!hasPendingCanonicalRefresh()) refreshScope = null;
  };

  return {
    getState: () => state.getState(),
    subscribe: (listener) => state.subscribe(listener),
    setScope: (scope) => {
      state.setScope(scope);
      clearRefreshIfCurrentScopeChanged();
    },
    dispose: () => {
      refreshScope = null;
      state.dispose();
    },
    hasPendingCanonicalRefresh,
    load(api) {
      return state.load((scope) => api.list(scope));
    },
    retry(api) {
      return state.retryLoad((scope) => api.list(scope));
    },
    revoke(id, api) {
      if (state.getState().mutating) return Promise.resolve({ status: "ignored" });
      if (hasPendingCanonicalRefresh()) {
        return state.retryLoad((scope) => api.list(scope)).then((result) => {
          if (result.status === "applied") refreshScope = null;
          return result;
        });
      }
      const row = state.getState().data?.find((candidate) => candidate.id === id);
      // The server list is canonical. A stale/foreign/deactivated row has no
      // mutation authority and must not generate a DELETE request.
      if (!row || !row.active) return Promise.resolve({ status: "ignored" });
      return state.mutate(
        async (scope) => {
          await api.revoke(scope, row.id);
          refreshScope = scope;
        },
        (scope) => api.list(scope),
      ).then((result) => {
        if (result.status === "applied" || !hasPendingCanonicalRefresh()) refreshScope = null;
        return result;
      });
    },
  };
}
