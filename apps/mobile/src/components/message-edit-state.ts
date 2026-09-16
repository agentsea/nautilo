export type EditableMobileMessage = {
  id: string;
  content: string;
  editRevision: number;
};

export type MessageEditState = {
  draft: string;
  baseContent: string;
  baseRevision: number;
  saving: boolean;
  error: string | null;
  conflictCurrent: { content: string; editRevision: number } | null;
  conflictReviewRequired: boolean;
};

export type MessageEditAction =
  | { type: "draft"; value: string }
  | { type: "save-started" }
  | { type: "save-failed"; error: string }
  | { type: "conflict"; content: string; editRevision: number; source: "remote" | "save" }
  | { type: "conflict-reviewed" };

export function initialMessageEditState(message: EditableMobileMessage): MessageEditState {
  return {
    draft: message.content,
    baseContent: message.content,
    baseRevision: message.editRevision,
    saving: false,
    error: null,
    conflictCurrent: null,
    conflictReviewRequired: false,
  };
}

export function messageEditReducer(
  state: MessageEditState,
  action: MessageEditAction,
): MessageEditState {
  switch (action.type) {
    case "draft":
      return { ...state, draft: action.value, error: null };
    case "save-started":
      if (state.draft.trim().length === 0) {
        return { ...state, error: "A message can't be empty." };
      }
      return { ...state, saving: true, error: null };
    case "save-failed":
      return { ...state, saving: false, error: action.error };
    case "conflict":
      return {
        ...state,
        baseContent: action.content,
        baseRevision: action.editRevision,
        saving: false,
        conflictCurrent: { content: action.content, editRevision: action.editRevision },
        conflictReviewRequired: true,
        error:
          action.source === "remote"
            ? "This message changed elsewhere. Your draft is preserved; review the current message before saving."
            : "This message changed elsewhere while you were saving. Your draft is preserved; review the current message before saving.",
      };
    case "conflict-reviewed":
      return { ...state, conflictReviewRequired: false, error: null };
  }
}
