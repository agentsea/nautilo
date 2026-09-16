/**
 * Per-command renderer for the unified `file` tool's `list` command.
 * (Originally shipped as `list-directory.tsx` for the legacy
 * `list_directory` tool — M088B removed that tool; the rendering
 * logic stays here for `file({command:"list", ...})`.)
 *
 * Collapsed: zoned-path + `(N entries)` parsed from the result.
 * Expanded:  entry list (dir entries styled with a trailing "/"
 *            glyph, files as plain). Capped at ENTRY_CAP to respect
 *            the D083 spec's "tree preview, cap 30" guidance;
 *            a "… N more" marker when we're past the cap.
 */

import type { ToolRenderer, ToolRendererProps } from "./types";
import { pickZonedPath, parseListResult, looksLikeToolError } from "./shared";

const ENTRY_CAP = 30;

function collapsedSummary({ args }: { args: Record<string, unknown> }): string {
  return pickZonedPath(args);
}

function collapsedExtras({
  resultText,
}: {
  resultText: string | undefined;
}): string | null {
  if (!resultText) return null;
  const parsed = parseListResult(resultText);
  if (parsed.entries) {
    const n = parsed.entries.length;
    return `${n} entr${n === 1 ? "y" : "ies"}`;
  }
  return null;
}

function ListDirectoryExpanded(props: ToolRendererProps): React.ReactElement {
  const { resultText, state, event } = props;
  const toolError = looksLikeToolError(resultText) ? resultText : undefined;
  const parsed = toolError ? { raw: undefined } : parseListResult(resultText);
  const rawError = event?.error;

  const shown = (parsed.entries ?? []).slice(0, ENTRY_CAP);
  const excess = (parsed.entries?.length ?? 0) - shown.length;

  return (
    <div className="border-t border-border px-3 py-2 space-y-2">
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

      {parsed.entries && parsed.entries.length > 0 && (
        <section aria-label="entries">
          <div className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wide text-foreground-dim">
            Entries{excess > 0 ? ` (showing ${shown.length} of ${parsed.entries.length})` : ""}
          </div>
          <ul className="max-h-96 space-y-0.5 overflow-y-auto font-mono text-xs">
            {shown.map((e, i) => (
              <li
                key={`${e.name}-${i}`}
                className={
                  e.kind === "dir"
                    ? "text-accent"
                    : "text-foreground-muted"
                }
              >
                <span className="select-none mr-1 text-foreground-dim" aria-hidden>
                  {e.kind === "dir" ? "▸" : "·"}
                </span>
                {e.name}
              </li>
            ))}
          </ul>
          {excess > 0 && (
            <div className="mt-1 text-[0.65rem] italic text-foreground-dim">
              … {excess} more entr{excess === 1 ? "y" : "ies"}
            </div>
          )}
        </section>
      )}

      {parsed.entries && parsed.entries.length === 0 && !toolError && (
        <div className="text-xs italic text-foreground-dim">(empty directory)</div>
      )}

      {!toolError && parsed.raw && (
        <section aria-label="raw output">
          <div className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wide text-foreground-dim">
            Output
          </div>
          <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded bg-background px-2 py-1.5 font-mono text-xs leading-relaxed text-foreground-muted">
            {parsed.raw}
          </pre>
        </section>
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

export const fileListRenderer: ToolRenderer = {
  collapsedSummary,
  collapsedExtras,
  ExpandedBody: ListDirectoryExpanded,
};
