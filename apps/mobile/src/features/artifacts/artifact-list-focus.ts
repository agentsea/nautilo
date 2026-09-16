export type ArtifactListFocusAction = "blocking" | "none" | "refresh";

export type ArtifactListFocusState = {
  scope: string | null;
};

export type ArtifactListFocusDecision = {
  action: ArtifactListFocusAction;
  next: ArtifactListFocusState;
  scopeChanged: boolean;
};

/** A room selection is valid only for the server that owned it. */
export type ServerOwnedRoom<Room> = { room: Room; serverId: string };

export function effectiveArtifactRoom<Room>(
  selection: ServerOwnedRoom<Room> | null,
  activeServerId: string | undefined,
): Room | null {
  return selection !== null && selection.serverId === activeServerId ? selection.room : null;
}

/** Reset synchronously when the active server changes, even while unfocused. */
export function resetArtifactListFocus(): ArtifactListFocusState {
  return { scope: null };
}

/**
 * Decide the only load caused by a focus transition. New server/source/room
 * scopes block with cleared rows; returning to the same scope refreshes. A
 * non-Nautilo source records its scope but never starts an artifact request.
 */
export function decideArtifactListFocus(
  state: ArtifactListFocusState,
  scope: string,
  canLoad: boolean,
): ArtifactListFocusDecision {
  const scopeChanged = state.scope !== scope;
  const next = { scope };
  if (!canLoad) return { action: "none", next, scopeChanged };
  return { action: scopeChanged ? "blocking" : "refresh", next, scopeChanged };
}
