/**
 * D416 Phase 1.4 — `find_explainer` metadata-only tool card.
 *
 * List results are intentionally local catalog metadata. Playback, provider
 * URLs, signed tokens, and video identifiers do not belong in this renderer.
 */

import type { ExplainerCatalogListResult } from "@nautilo/types";
import { ExplainerCatalogListResultSchema } from "@nautilo/types";
import type { ReactElement } from "react";
import type { ToolRenderer, ToolRendererProps } from "./types";
import { looksLikeToolError } from "./shared";

/** Parse only the strict, shared list-result contract. */
export function parseExplainerCatalogResult(raw: string | undefined): ExplainerCatalogListResult | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = ExplainerCatalogListResultSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return minutes > 0 ? `${minutes}:${remainingSeconds.toString().padStart(2, "0")}` : `0:${remainingSeconds.toString().padStart(2, "0")}`;
}

export function formatCollapsedSummary(resultText: string | undefined): string {
  const result = parseExplainerCatalogResult(resultText);
  if (!result) return "find_explainer";
  const count = result.items.length;
  return `Find explainer · ${count} result${count === 1 ? "" : "s"}`;
}

function ExplainerVideoExpanded({ resultText, state, event }: ToolRendererProps): ReactElement {
  const toolError = looksLikeToolError(resultText) ? resultText : undefined;
  const result = toolError ? null : parseExplainerCatalogResult(resultText);

  if (toolError) {
    return (
      <div className="border-t border-border px-3 py-2">
        <div className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wide text-tool-error">
          Tool error
        </div>
        <pre className="whitespace-pre-wrap break-words text-xs text-tool-error">{toolError}</pre>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="border-t border-border px-3 py-2">
        {resultText && <pre className="whitespace-pre-wrap break-words text-xs">{resultText}</pre>}
        {state === "error" && event?.error && (
          <pre className="whitespace-pre-wrap text-xs text-tool-error">{event.error}</pre>
        )}
      </div>
    );
  }

  return (
    <div
      className="border-t border-border px-3 py-2 space-y-2"
      data-testid="explainer-video-expanded"
    >
      <p className="text-[0.65rem] text-foreground-dim">
        Local catalog · {result.total} available
      </p>
      {result.items.length === 0 ? (
        <p className="text-xs text-foreground-muted">No explainers matched this search.</p>
      ) : (
        <section aria-label="explainer search results" className="space-y-2">
          {result.items.map((item) => (
            <article
              key={item.id}
              className="rounded border border-border px-2 py-1.5 space-y-1"
              data-testid={`explainer-video-${item.id}`}
            >
              <div className="flex flex-wrap items-baseline gap-x-2">
                <h3 className="text-xs font-medium text-foreground">{item.title}</h3>
                <span className="text-[0.65rem] text-foreground-dim">{formatDuration(item.durationSeconds)}</span>
                <span className="text-[0.65rem] text-foreground-dim">
                  {item.captionsAvailable ? "Captions available" : "No captions"}
                </span>
              </div>
              <p className="text-[0.65rem] text-foreground-muted">{item.summary}</p>
              {item.tags.length > 0 && (
                <p className="text-[0.65rem] text-foreground-dim">{item.tags.join(" · ")}</p>
              )}
            </article>
          ))}
        </section>
      )}
      <p className="text-[0.65rem] text-foreground-dim">Playback is not configured.</p>
    </div>
  );
}

export const explainerVideoRenderer: ToolRenderer = {
  collapsedSummary: ({ resultText }) => formatCollapsedSummary(resultText),
  autoExpandOnResult: true,
  ExpandedBody: ExplainerVideoExpanded,
};
