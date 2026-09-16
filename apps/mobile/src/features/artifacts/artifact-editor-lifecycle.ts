export type ArtifactEditorPhase = "loading" | "error" | "ready";
export type ArtifactEditorSaveState = "unavailable" | "idle" | "saving";

export type ArtifactEditorLifecycle = {
  phase: ArtifactEditorPhase;
  dirty: boolean;
};

export const initialArtifactEditorLifecycle: ArtifactEditorLifecycle = {
  phase: "loading",
  dirty: false,
};

export function transitionArtifactEditorPhase(
  state: ArtifactEditorLifecycle,
  phase: ArtifactEditorPhase,
): ArtifactEditorLifecycle {
  if (state.phase === phase) return state;
  return { phase, dirty: false };
}

export function markArtifactEditorDirty(
  state: ArtifactEditorLifecycle,
): ArtifactEditorLifecycle {
  return state.phase === "ready" ? { ...state, dirty: true } : state;
}

export function markArtifactEditorClean(
  state: ArtifactEditorLifecycle,
): ArtifactEditorLifecycle {
  return state.dirty ? { ...state, dirty: false } : state;
}

export function canSaveArtifactEditor(
  state: ArtifactEditorLifecycle,
  saveState: ArtifactEditorSaveState,
  hasSave: boolean,
): boolean {
  return state.phase === "ready" && state.dirty && saveState === "idle" && hasSave;
}

export type ArtifactEditorExit = "proceed" | "confirm-discard";

export function requestArtifactEditorExit(
  state: ArtifactEditorLifecycle,
): ArtifactEditorExit {
  return state.phase === "ready" && state.dirty ? "confirm-discard" : "proceed";
}

export type ArtifactEditorDiscardPrompt = {
  keepEditing: () => void;
  discardChanges: () => void;
};

export type ArtifactEditorExitEffects = {
  present: (prompt: ArtifactEditorDiscardPrompt) => void;
  markClean: () => void;
  onDiscard?: () => void;
};

export function createArtifactEditorExitCoordinator() {
  let bypass = false;
  let confirmationOpen = false;

  const request = (
    state: ArtifactEditorLifecycle,
    proceed: () => void,
    effects: ArtifactEditorExitEffects,
  ): void => {
    if (requestArtifactEditorExit(state) === "proceed") {
      proceed();
      return;
    }
    if (confirmationOpen) return;
    confirmationOpen = true;
    effects.present({
      keepEditing: () => { confirmationOpen = false; },
      discardChanges: () => {
        confirmationOpen = false;
        bypass = true;
        effects.markClean();
        effects.onDiscard?.();
        proceed();
      },
    });
  };

  return {
    request,
    intercept(
      state: ArtifactEditorLifecycle,
      event: { preventDefault: () => void; action: unknown },
      dispatch: (action: unknown) => void,
      effects: ArtifactEditorExitEffects,
    ): void {
      if (bypass) {
        bypass = false;
        return;
      }
      if (requestArtifactEditorExit(state) === "proceed") return;
      event.preventDefault();
      request(state, () => dispatch(event.action), effects);
    },
    reset(): void {
      bypass = false;
      confirmationOpen = false;
    },
  };
}
