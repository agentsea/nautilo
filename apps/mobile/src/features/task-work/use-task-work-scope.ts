import { useMemo, useRef } from "react";

import { settingsScopeForVerifiedViewer, type SettingsDataScope } from "@/features/settings/settings-data-state";

/** The complete identity fence for owner-scoped delegated-work reads. */
export interface TaskWorkScope extends SettingsDataScope {
  readonly viewerEpoch: number;
}

type TaskWorkScopeInput = {
  readonly server: { id: string } | null;
  readonly authStatus: string;
  readonly viewerId: string | null;
  readonly viewerActorId: string | null;
  readonly viewerState: string;
  readonly canInvokeAgents: boolean;
  /** Changes on a fresh same-ID verification, not just a person switch. */
  readonly viewerIdentity: object | null;
};

/**
 * Produces the one scope used by both the overview and exact-detail readers.
 * Server/user/actor equality alone is not enough after reauthentication: the
 * identity object advances the epoch synchronously during render.
 */
export function useTaskWorkScope(input: TaskWorkScopeInput): TaskWorkScope | null {
  const previousRef = useRef<Omit<TaskWorkScopeInput, "server"> & { serverId: string | null; epoch: number } | null>(null);
  const previous = previousRef.current;
  const serverId = input.server?.id ?? null;
  if (
    !previous
    || previous.serverId !== serverId
    || previous.authStatus !== input.authStatus
    || previous.viewerId !== input.viewerId
    || previous.viewerActorId !== input.viewerActorId
    || previous.viewerState !== input.viewerState
    || previous.canInvokeAgents !== input.canInvokeAgents
    || previous.viewerIdentity !== input.viewerIdentity
  ) {
    previousRef.current = { ...input, serverId, epoch: (previous?.epoch ?? -1) + 1 };
  }
  const viewerEpoch = previousRef.current!.epoch;
  return useMemo(() => {
    const verifiedScope = settingsScopeForVerifiedViewer(input.server, {
      status: input.authStatus,
      viewerState: input.viewerState,
      viewer: input.viewerId && input.viewerActorId && input.viewerState === "verified"
        ? { userId: input.viewerId, actorId: input.viewerActorId }
        : null,
    });
    return verifiedScope && input.canInvokeAgents ? { ...verifiedScope, viewerEpoch } : null;
  }, [input.authStatus, input.canInvokeAgents, input.server, input.viewerActorId, input.viewerId, input.viewerState, viewerEpoch]);
}
