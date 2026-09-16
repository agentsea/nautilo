/**
 * D083 Phase 2b — specialized renderer for `edit_file` (+ unified
 * `file` edit-shaped commands such as `str_replace` in the activity feed).
 *
 * Supports:
 *   - mode + content ({ path, zone, mode: replace|append|prepend, content })
 *   - str-replace shape ({ path, oldStr, newStr })
 *
 * This renderer handles both defensively. Collapsed shows the path
 * + a mode badge (replace/append/prepend) or a "±N lines" diff-
 * shorthand when old+new content is present. Expanded shows the
 * content blocks with clear before/after separators — a true
 * line-level diff belongs to a later phase (it needs a real diff
 * library; shipping a naive version would mislead more than help).
 */

import type { ToolRenderer, ToolRendererProps } from "./types";
import { pickZonedPath, previewLines, looksLikeToolError } from "./shared";

const MAX_PREVIEW_LINES = 120;

interface EditIntent {
  mode: "replace" | "append" | "prepend" | "str-replace" | "unknown";
  content?: string;
  oldStr?: string;
  newStr?: string;
}

function extractIntent(args: Record<string, unknown>): EditIntent {
  // mode + content shape (replace / append / prepend)
  const mode = args["mode"];
  const content = args["content"];
  if (typeof mode === "string" && typeof content === "string") {
    if (mode === "replace" || mode === "append" || mode === "prepend") {
      return { mode, content };
    }
  }
  // edit_file: { oldStr, newStr }
  const oldStr = args["oldStr"];
  const newStr = args["newStr"];
  if (typeof oldStr === "string" && typeof newStr === "string") {
    return { mode: "str-replace", oldStr, newStr };
  }
  // Fallback — we see an object we don't recognize.
  return {
    mode: "unknown",
    ...(typeof content === "string" ? { content } : {}),
  };
}

function modeLabel(intent: EditIntent): string {
  switch (intent.mode) {
    case "replace":
      return "replace";
    case "append":
      return "append";
    case "prepend":
      return "prepend";
    case "str-replace":
      return "str-replace";
    case "unknown":
      return "edit";
  }
}

function countLines(s: string | undefined): number {
  if (!s) return 0;
  const parts = s.split(/\r?\n/);
  return parts[parts.length - 1] === "" ? parts.length - 1 : parts.length;
}

function collapsedSummary({ args }: { args: Record<string, unknown> }): string {
  return pickZonedPath(args);
}

function collapsedExtras({
  args,
}: {
  args: Record<string, unknown>;
}): string | null {
  const intent = extractIntent(args);
  if (intent.mode === "str-replace") {
    const oldLines = countLines(intent.oldStr);
    const newLines = countLines(intent.newStr);
    return `-${oldLines}/+${newLines}`;
  }
  if (intent.content !== undefined) {
    const lines = countLines(intent.content);
    const prefix = intent.mode === "prepend" || intent.mode === "append" ? "+" : "~";
    return `${prefix}${lines} · ${modeLabel(intent)}`;
  }
  return modeLabel(intent);
}

function EditFileExpanded(props: ToolRendererProps): React.ReactElement {
  const { args, resultText, state, event } = props;
  const intent = extractIntent(args);
  const toolError = looksLikeToolError(resultText) ? resultText : undefined;
  const status = !toolError && resultText ? resultText : undefined;
  const rawError = event?.error;

  return (
    <div className="border-t border-border px-3 py-2 space-y-2">
      {intent.mode === "str-replace" && (
        <>
          <section aria-label="before">
            <div className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wide text-tool-error">
              − before
            </div>
            <pre className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded bg-background px-2 py-1.5 font-mono text-xs leading-relaxed text-foreground">
              {previewLines(intent.oldStr ?? "", MAX_PREVIEW_LINES).preview}
            </pre>
          </section>
          <section aria-label="after">
            <div className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wide text-tool-success">
              + after
            </div>
            <pre className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded bg-background px-2 py-1.5 font-mono text-xs leading-relaxed text-foreground">
              {previewLines(intent.newStr ?? "", MAX_PREVIEW_LINES).preview}
            </pre>
          </section>
        </>
      )}

      {intent.mode !== "str-replace" && intent.content !== undefined && (
        <section aria-label={`${modeLabel(intent)} content`}>
          <div className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wide text-tool-success">
            {modeLabel(intent) === "replace" ? "~" : "+"} {modeLabel(intent)}
          </div>
          <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded bg-background px-2 py-1.5 font-mono text-xs leading-relaxed text-foreground">
            {previewLines(intent.content, MAX_PREVIEW_LINES).preview}
          </pre>
        </section>
      )}

      {toolError && (
        <section aria-label="tool error">
          <div className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wide text-tool-error">
            Tool error
          </div>
          <pre className="whitespace-pre-wrap break-words text-xs text-tool-error">
            {toolError}
          </pre>
        </section>
      )}

      {status && (
        <div className="text-xs text-foreground-muted">{status}</div>
      )}

      {state === "error" && rawError && rawError !== resultText && (
        <section aria-label="error">
          <div className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wide text-tool-error">
            Error
          </div>
          <pre className="whitespace-pre-wrap break-words text-xs text-tool-error">
            {rawError}
          </pre>
        </section>
      )}
    </div>
  );
}

export const editFileRenderer: ToolRenderer = {
  collapsedSummary,
  collapsedExtras,
  ExpandedBody: EditFileExpanded,
};
