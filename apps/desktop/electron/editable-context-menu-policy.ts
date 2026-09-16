/**
 * D519 — serializable policy for the Workbench's native editable-text menu.
 *
 * This file deliberately does not import Electron. Keeping the context
 * ownership and menu ordering policy pure makes it possible to test the
 * platform contract without booting an Electron runtime.
 */

export type EditableContextMenuPlatform = string;

export type EditableContextMenuEditFlags = Readonly<{
  canUndo: boolean;
  canRedo: boolean;
  canCut: boolean;
  canCopy: boolean;
  canPaste: boolean;
  canDelete: boolean;
  canSelectAll: boolean;
}>;

export type EditableContextMenuInput = Readonly<{
  isEditable: boolean;
  selectionText: string;
  mediaType: string;
  linkURL: string;
  misspelledWord: string;
  dictionarySuggestions: readonly string[];
  editFlags: EditableContextMenuEditFlags;
  frameAvailable: boolean;
  platform: EditableContextMenuPlatform;
}>;

export type EditableContextMenuEditAction =
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "delete"
  | "selectAll";

export type EditableContextMenuDescriptor =
  | Readonly<{ kind: "separator" }>
  | Readonly<{ kind: "suggestion"; replacement: string }>
  | Readonly<{ kind: "learn"; word: string }>
  | Readonly<{
      kind: "edit";
      action: EditableContextMenuEditAction;
      enabled: boolean;
    }>;

const EDITABLE_ACTIONS: readonly EditableContextMenuEditAction[] = [
  "undo",
  "redo",
  "cut",
  "copy",
  "paste",
  "delete",
  "selectAll",
];

/**
 * Returns no descriptors unless this is an ordinary editable text context or
 * a text selection we can safely own. Media and links retain their existing
 * specialized context-menu owners. A usable event frame is mandatory so the
 * Electron bridge never retargets a menu action after frame destruction.
 */
export function buildEditableContextMenuPolicy(
  input: EditableContextMenuInput,
): readonly EditableContextMenuDescriptor[] {
  if (!input.frameAvailable || input.mediaType !== "none" || input.linkURL.length > 0) {
    return [];
  }

  const hasSelection = input.selectionText.length > 0;
  if (!input.isEditable && !hasSelection) return [];

  const groups: EditableContextMenuDescriptor[][] = [];
  const misspelledWord = input.misspelledWord.trim();
  if (input.isEditable && misspelledWord.length > 0) {
    const suggestions = input.dictionarySuggestions
      .map((suggestion) => suggestion.trim())
      .filter((suggestion) => suggestion.length > 0)
      .map((replacement): EditableContextMenuDescriptor => ({
        kind: "suggestion",
        replacement,
      }));
    groups.push([
      ...suggestions,
      { kind: "learn", word: misspelledWord },
    ]);
  }

  const edits = buildEditDescriptors(input, hasSelection);
  if (edits.length > 0) groups.push(edits);

  return compactGroups(groups);
}

function buildEditDescriptors(
  input: EditableContextMenuInput,
  hasSelection: boolean,
): EditableContextMenuDescriptor[] {
  const allowedActions: readonly EditableContextMenuEditAction[] = input.isEditable
    ? EDITABLE_ACTIONS
    : hasSelection
      ? ["copy", "selectAll"]
      : [];

  return allowedActions.map((action) => ({
    kind: "edit",
    action,
    enabled: input.editFlags[`can${capitalize(action)}` as keyof EditableContextMenuEditFlags],
  }));
}

function capitalize(action: EditableContextMenuEditAction): string {
  return action.charAt(0).toUpperCase() + action.slice(1);
}

function compactGroups(
  groups: readonly (readonly EditableContextMenuDescriptor[])[],
): readonly EditableContextMenuDescriptor[] {
  const compacted = groups.filter((group) => group.length > 0);
  return compacted.flatMap((group, index) =>
    index === 0 ? group : ([{ kind: "separator" }, ...group] as const),
  );
}
