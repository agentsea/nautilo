export type NativeSelection = { start: number; end: number };
export type NativeSourceBuffer = {
  baseline: string;
  current: string;
  selection: NativeSelection;
};
export function createNativeSourceBuffer(baseline: string): NativeSourceBuffer {
  return { baseline, current: baseline, selection: { start: 0, end: 0 } };
}
export function updateNativeSourceBuffer(
  buffer: NativeSourceBuffer,
  current: string,
  selection?: NativeSelection,
): boolean {
  buffer.current = current;
  if (selection) buffer.selection = selection;
  return current !== buffer.baseline;
}
/** Accept a server-confirmed source snapshot without discarding edits made while saving. */
export function commitNativeSourceBaseline(
  buffer: NativeSourceBuffer,
  baseline: string,
): boolean {
  buffer.baseline = baseline;
  buffer.selection = clampSelection(buffer.current, buffer.selection);
  return buffer.current !== buffer.baseline;
}
export function clampSelection(
  value: string,
  selection: NativeSelection,
): NativeSelection {
  const start = Math.max(0, Math.min(value.length, selection.start));
  const end = Math.max(0, Math.min(value.length, selection.end));
  return { start: Math.min(start, end), end: Math.max(start, end) };
}
export function wrapMarkdown(
  value: string,
  selection: NativeSelection,
  marker: string,
): { value: string; selection: NativeSelection } {
  const range = clampSelection(value, selection);
  const text = value.slice(range.start, range.end);
  const next = `${value.slice(0, range.start)}${marker}${text}${marker}${value.slice(range.end)}`;
  const point = range.start + marker.length + text.length;
  return {
    value: next,
    selection: {
      start: text ? range.start + marker.length : point,
      end: point,
    },
  };
}
export function insertMarkdownLink(
  value: string,
  selection: NativeSelection,
  href = "https://",
): { value: string; selection: NativeSelection } {
  const range = clampSelection(value, selection);
  const text = value.slice(range.start, range.end) || "link";
  const inserted = `[${text}](${href})`;
  const next = `${value.slice(0, range.start)}${inserted}${value.slice(range.end)}`;
  return {
    value: next,
    selection: { start: range.start + 1, end: range.start + 1 + text.length },
  };
}

/** Markdown links share Writer's bounded, control-character-safe URL policy. */
export function isSupportedMarkdownHref(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length <= 2000 &&
    !Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    /^(?:https?:\/\/[^\s]+|mailto:[^\s]+)$/iu.test(value)
  );
}

/** Replace (rather than stack) one-level Markdown block prefixes for selected lines. */
export function setMarkdownBlockPrefix(
  value: string,
  selection: NativeSelection,
  prefix: string,
): { value: string; selection: NativeSelection } {
  const range = clampSelection(value, selection);
  const start = Math.max(
    0,
    value.lastIndexOf("\n", Math.max(0, range.start - 1)) + 1,
  );
  // A non-empty range ending at a line's start did not select that next line.
  // A collapsed caret formats its own current line, including an empty line.
  const endProbe = range.start === range.end ? range.end : range.end - 1;
  const endAtNewline = value.indexOf("\n", endProbe);
  const end = endAtNewline === -1 ? value.length : endAtNewline;
  const original = value.slice(start, end);
  const blockPrefix = /^(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+)/;
  const lines = original.split("\n");
  const removed = lines.map((line) => line.match(blockPrefix)?.[0].length ?? 0);
  const replacement = lines
    .map((line, index) => `${prefix}${line.slice(removed[index])}`)
    .join("\n");
  const mapPosition = (position: number): number => {
    let lineStart = start;
    let delta = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const lineEnd = lineStart + lines[index].length;
      const removedLength = removed[index];
      const lineDelta = prefix.length - removedLength;
      if (position <= lineEnd) {
        if (position <= lineStart + removedLength)
          return lineStart + delta + prefix.length;
        return position + delta + lineDelta;
      }
      delta += lineDelta;
      lineStart = lineEnd + 1;
    }
    return position + delta;
  };
  const next = `${value.slice(0, start)}${replacement}${value.slice(end)}`;
  return {
    value: next,
    selection: clampSelection(next, {
      start: mapPosition(range.start),
      end: mapPosition(range.end),
    }),
  };
}
