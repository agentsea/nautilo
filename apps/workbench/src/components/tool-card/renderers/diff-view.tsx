/**
 * D087 Phase 1 §1.5 — DiffView component.
 *
 * Parses a git-style unified-diff string (produced by the agent-side
 * staged-patch store) and renders it as red/green line-level diff with
 * hunk headers, line numbers, and a stats header. Below the diff,
 * applied edits show a Revert button that asks the Agent to undo.
 *
 * Design notes:
 *   - Line-level only in §1.5a; word-level clusters land in Phase 4
 *     §4.1 using `diff.diffWordsWithSpace` over each modified-line
 *     pair.
 *   - No syntax highlighting yet — monospace plain. Syntax highlight
 *     is a Phase 1.5 polish pass; shipping unhighlighted first keeps
 *     this commit reviewable.
 *   - Long diffs render with a max-height + scroll rather than
 *     truncating. A 10,000-line diff is rare; when it happens the
 *     scroll experience is still better than a hidden cliff.
 */

import { useCallback, useMemo, type ReactNode } from "react";
import { parsePatch, type StructuredPatch, type StructuredPatchHunk } from "diff";
import { requestRevert } from "../../../adapters/tool-invoke-ref";

interface DiffViewProps {
  unifiedDiff: string;
  path: string;
  stats: { additions: number; deletions: number };
  binary?: true;
  bytes?: number;
  warnings?: string[];
  /** Optional one-line summary the handler built ("Applied: str_replace 1 occurrence"). */
  summary?: string;
  revisionId?: string;
  zone?: "workspace" | "current" | "absolute";
  command?: string;
  mode?: "applied" | "historical";
  /** D121-P6 — optional workspace HTML “Open in Work” row above the diff body. */
  openInWorkSlot?: ReactNode;
}

interface RenderedLine {
  kind: "context" | "add" | "del" | "hunk-header";
  oldLine?: number;
  newLine?: number;
  content: string;
}

type ParsedDiff =
  | { lines: RenderedLine[]; malformed: false }
  | { lines: []; malformed: true };

function parseHunk(hunk: StructuredPatchHunk): RenderedLine[] {
  const out: RenderedLine[] = [];
  out.push({
    kind: "hunk-header",
    content: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
  });
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  for (const raw of hunk.lines) {
    if (!raw.length) continue;
    const prefix = raw[0];
    const body = raw.slice(1);
    if (prefix === "+") {
      out.push({ kind: "add", newLine, content: body });
      newLine++;
    } else if (prefix === "-") {
      out.push({ kind: "del", oldLine, content: body });
      oldLine++;
    } else {
      out.push({ kind: "context", oldLine, newLine, content: body });
      oldLine++;
      newLine++;
    }
  }
  return out;
}

function parseAllHunks(unifiedDiff: string): ParsedDiff {
  try {
    const patches: StructuredPatch[] = parsePatch(unifiedDiff);
    const lines: RenderedLine[] = [];
    for (const p of patches) {
      for (const hunk of p.hunks) {
        lines.push(...parseHunk(hunk));
      }
    }
    return { lines, malformed: false };
  } catch {
    // Historical tool results are untrusted display data. Old producers and
    // interrupted streams can leave a summary line after an otherwise valid
    // hunk. A preview parser must never turn that payload defect into a
    // renderer-wide failure.
    return { lines: [], malformed: true };
  }
}

/**
 * Shared, presentation-only unified-diff body. Multi-file consumers select a
 * complete projected section before rendering this component; it deliberately
 * does not slice or otherwise reinterpret the authoritative result.
 */
export function UnifiedDiffBody({ unifiedDiff }: { unifiedDiff: string }): React.ReactElement {
  const parsed = useMemo(() => parseAllHunks(unifiedDiff), [unifiedDiff]);

  if (parsed.malformed) {
    return (
      <div
        className="space-y-1 rounded border border-border bg-background px-3 py-2"
        data-testid="diff-view-raw-fallback"
      >
        <div className="text-xs text-tool-warning">
          Diff preview unavailable. Showing the raw change.
        </div>
        <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground">
          {unifiedDiff}
        </pre>
      </div>
    );
  }

  if (parsed.lines.length === 0) {
    return (
      <div className="rounded bg-background px-3 py-2 font-mono text-xs text-foreground-muted">
        No line diff was supplied for this file.
      </div>
    );
  }

  return (
    <pre className="max-h-96 overflow-y-auto rounded bg-background font-mono text-xs leading-relaxed">
      <code>
        {parsed.lines.map((line, idx) => (
          <DiffLine key={idx} line={line} />
        ))}
      </code>
    </pre>
  );
}

export function DiffView(props: DiffViewProps): React.ReactElement {
  const {
    unifiedDiff,
    path,
    stats,
    summary,
    revisionId,
    zone,
    command,
    binary,
    bytes,
    warnings,
    mode = "applied",
    openInWorkSlot,
  } = props;
  const handleRevert = useCallback(() => {
    requestRevert({ revisionId, path, zone, command });
  }, [revisionId, path, zone, command]);

  const showRevert = mode === "applied" && path.length > 0;

  return (
    <div className="border-t border-border px-3 py-2 space-y-2" data-testid="diff-view">
      <header className="flex items-baseline justify-between gap-3 text-[0.65rem]">
        <span className="truncate font-mono text-foreground-muted" title={path}>
          {path}
        </span>
        {binary ?
          <span className="flex-shrink-0 font-semibold text-foreground-muted">
            {typeof bytes === "number" ? `${bytes} bytes` : "binary"}
          </span>
        : <span className="flex-shrink-0 font-semibold">
            <span className="text-tool-success">+{stats.additions}</span>
            <span className="text-foreground-dim"> / </span>
            <span className="text-tool-error">-{stats.deletions}</span>
          </span>
        }
      </header>

      {openInWorkSlot}

      {summary && (
        <div className="text-xs italic text-foreground-muted">{summary}</div>
      )}

      {binary ? (
        <div className="rounded border border-border bg-background px-3 py-2 text-xs text-foreground-muted">
          <div className="font-medium text-foreground">Binary file applied</div>
          <div>
            Generated file written to disk. Use Revert to undo.
          </div>
          {warnings?.map((warning, idx) => (
            <div key={idx} className="mt-1 text-tool-warning">
              {warning}
            </div>
          ))}
        </div>
      ) : <UnifiedDiffBody unifiedDiff={unifiedDiff} />}

      {(showRevert || mode === "historical") && (
        <div
          className="flex items-center justify-end gap-2 pt-1"
          data-testid="diff-view-actions"
        >
          {mode === "historical" ? (
            <span
              className="text-[0.7rem] italic text-foreground-muted"
              data-testid="diff-view-historical-badge"
            >
              Historical edit
            </span>
          ) : (
            <button
              type="button"
              onClick={handleRevert}
              className="rounded border border-border px-2.5 py-1 text-[0.7rem] font-medium text-foreground-muted hover:border-tool-error/40 hover:text-tool-error"
              data-testid="diff-view-revert"
            >
              Revert
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function DiffLine({ line }: { line: RenderedLine }): React.ReactElement {
  if (line.kind === "hunk-header") {
    return (
      <div className="bg-background-element px-2 py-0.5 text-foreground-muted">
        {line.content}
      </div>
    );
  }
  const bg =
    line.kind === "add"
      ? "bg-tool-success/10"
      : line.kind === "del"
        ? "bg-tool-error/10"
        : "";
  const marker =
    line.kind === "add"
      ? { sym: "+", color: "text-tool-success" }
      : line.kind === "del"
        ? { sym: "-", color: "text-tool-error" }
        : { sym: " ", color: "text-foreground-dim" };

  return (
    <div className={`grid grid-cols-[2.5rem_2.5rem_1rem_1fr] gap-x-1 px-1 py-0 ${bg}`}>
      <span className="text-right text-foreground-dim">
        {line.oldLine ?? ""}
      </span>
      <span className="text-right text-foreground-dim">
        {line.newLine ?? ""}
      </span>
      <span className={`text-center font-bold ${marker.color}`}>
        {marker.sym}
      </span>
      <span className="whitespace-pre-wrap break-words text-foreground">
        {line.content}
      </span>
    </div>
  );
}
