/**
 * D083 Phase 2b — tiny renderer for `delete_file` (+ unified `file.delete`
 * and any future delete-shaped tool).
 *
 * Nothing much to render: the action is destructive, the card's
 * job is confirming it happened + which path. Kept as its own
 * file so additions like "show file size that was reclaimed" can
 * land here without touching anything else.
 */

import type { ToolRenderer, ToolRendererProps } from "./types";
import { pickZonedPath, looksLikeToolError } from "./shared";

function collapsedSummary({ args }: { args: Record<string, unknown> }): string {
  return pickZonedPath(args);
}

function DeleteExpanded(props: ToolRendererProps): React.ReactElement {
  const { args, resultText, state, event } = props;
  const path = pickZonedPath(args);
  const recursive = args["recursive"] === true;
  const toolError = looksLikeToolError(resultText) ? resultText : undefined;
  const status = !toolError && resultText ? resultText : undefined;
  const rawError = event?.error;

  return (
    <div className="border-t border-border px-3 py-2 space-y-2 text-xs">
      {path && (
        <div>
          <span className="text-foreground-dim">path: </span>
          <span className="font-mono text-foreground">{path}</span>
          {recursive && (
            <span className="ml-2 rounded bg-[var(--warning,#b58900)]/10 px-1.5 py-0.5 text-[0.65rem] font-medium text-[var(--warning,#b58900)]">
              recursive
            </span>
          )}
        </div>
      )}

      {status && (
        <div className="text-tool-success">{status}</div>
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

export const deleteRenderer: ToolRenderer = {
  collapsedSummary,
  ExpandedBody: DeleteExpanded,
};
