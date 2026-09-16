import {
  insertResourceDirective,
  parseResourceDirective,
  projectedOffsetToSerializedOffset,
} from "./resource-directives";
import { parseHumanMentionDirective } from "./human-mention-directives";

function projectComposerDirective(raw: string): string | null {
  const resource = parseResourceDirective(raw);
  if (resource) return resource.label;
  const human = parseHumanMentionDirective(raw);
  return human ? `@${human.handle}` : null;
}

/**
 * Best-effort drop caret lookup. The Lexical input's DOM text is its clean
 * display text. Resource directives are expanded by the formatter, so this
 * returns a projected offset; callers translate it against serialized draft
 * text before inserting an opaque directive.
 */
function resourceDropOffset(
  root: HTMLElement,
  point: { x: number; y: number },
  fallbackOffset: number,
): number {
  const doc = root.ownerDocument;
  const fromPosition = doc.caretPositionFromPoint?.(point.x, point.y);
  const range = fromPosition
    ? (() => {
        const result = doc.createRange();
        result.setStart(fromPosition.offsetNode, fromPosition.offset);
        result.collapse(true);
        return result;
      })()
    : doc.caretRangeFromPoint?.(point.x, point.y) ?? null;
  if (!range || !root.contains(range.startContainer)) return fallbackOffset;

  const prefix = doc.createRange();
  prefix.selectNodeContents(root);
  prefix.setEnd(range.startContainer, range.startOffset);
  return prefix.toString().length;
}

export function currentComposerSelectionOffset(root: HTMLElement | null): number | null {
  if (!root) return null;
  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer)) return null;
  const prefix = root.ownerDocument.createRange();
  prefix.selectNodeContents(root);
  prefix.setEnd(range.startContainer, range.startOffset);
  return prefix.toString().length;
}

export function insertDroppedResourceDirective(args: {
  text: string;
  directive: string;
  root: HTMLElement | null;
  point: { x: number; y: number };
  selectionOffset: number | null;
}): string {
  const fallback = args.selectionOffset ?? args.text.length;
  const projectedOffset = args.root
    ? resourceDropOffset(args.root, args.point, fallback)
    : fallback;
  const serializedOffset = projectedOffsetToSerializedOffset(
    args.text,
    projectedOffset,
    projectComposerDirective,
  );
  return insertResourceDirective(args.text, serializedOffset, args.directive);
}
