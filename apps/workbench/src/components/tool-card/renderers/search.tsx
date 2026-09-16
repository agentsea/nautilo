/**
 * D083 Phase 2b — specialized renderer for `search_memory` (+ unified
 * `file.grep` and other grep-shaped tools).
 *
 * Collapsed: "query" + match count parsed from the canonical
 *            "N matches for ..." header.
 * Expanded:  match list with `path:line — preview` rows, capped at
 *            MATCH_CAP. Parser (`parseSearchResult` in shared.ts)
 *            falls back to raw rendering if the result doesn't look
 *            like a search output.
 */

import type { ToolRenderer, ToolRendererProps } from "./types";
import { pickQuery, parseSearchResult, looksLikeToolError } from "./shared";

const MATCH_CAP = 15;

function collapsedSummary({ args }: { args: Record<string, unknown> }): string {
  const q = pickQuery(args);
  return q ? `"${q}"` : "";
}

function collapsedExtras({
  resultText,
}: {
  resultText: string | undefined;
}): string | null {
  if (!resultText) return null;
  const parsed = parseSearchResult(resultText);
  if (parsed.matches) {
    const n = parsed.matches.length;
    return `${n} match${n === 1 ? "" : "es"}`;
  }
  return null;
}

function SearchExpanded(props: ToolRendererProps): React.ReactElement {
  const { resultText, state, event } = props;
  const toolError = looksLikeToolError(resultText) ? resultText : undefined;
  const parsed = toolError ? {} : parseSearchResult(resultText);
  const shown = (parsed.matches ?? []).slice(0, MATCH_CAP);
  const excess = (parsed.matches?.length ?? 0) - shown.length;
  const rawError = event?.error;

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

      {parsed.header && (
        <div className="text-xs text-foreground-muted">{parsed.header}</div>
      )}

      {parsed.matches && parsed.matches.length > 0 && (
        <section aria-label="matches">
          <ul className="max-h-96 space-y-1 overflow-y-auto font-mono text-xs">
            {shown.map((m, i) => (
              <li key={i} className="text-foreground-muted">
                <span className="text-accent">{m.path}</span>
                {m.line !== null && (
                  <span className="text-foreground-dim">:{m.line}</span>
                )}
                {m.preview && (
                  <>
                    <span className="mx-1 text-foreground-dim">—</span>
                    <span className="text-foreground">{m.preview}</span>
                  </>
                )}
              </li>
            ))}
          </ul>
          {excess > 0 && (
            <div className="mt-1 text-[0.65rem] italic text-foreground-dim">
              … {excess} more match{excess === 1 ? "" : "es"}
            </div>
          )}
        </section>
      )}

      {parsed.matches && parsed.matches.length === 0 && !toolError && (
        <div className="text-xs italic text-foreground-dim">(no matches)</div>
      )}

      {!toolError && parsed.raw && (
        <section aria-label="raw output">
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

export const searchRenderer: ToolRenderer = {
  collapsedSummary,
  collapsedExtras,
  ExpandedBody: SearchExpanded,
};
