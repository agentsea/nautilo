/**
 * D121-P5 / D087-P2B — block-aware applied patch preview. Routes when
 * envelope `blockOps` is non-empty; uses the same Revert path as `DiffView`.
 */

import { useCallback, useMemo } from "react";
import type { AppliedEnvelope, StagedEnvelope } from "../../../lib/staged-envelope";
import { requestRevert } from "../../../adapters/tool-invoke-ref";
import { groupOpsByBlock } from "./group-ops-by-block";
import { BlockDiffSection } from "./BlockDiffSection";

export interface BlockDiffViewProps {
  envelope: AppliedEnvelope | StagedEnvelope;
  mode?: "applied" | "historical";
}

export function BlockDiffView(props: BlockDiffViewProps): React.ReactElement {
  const { envelope, mode = "applied" } = props;
  const {
    path,
    stats,
    summary,
    binary,
    bytes,
    warnings,
    blockOps = [],
    zone,
    command,
  } = envelope;
  const revisionId = "revisionId" in envelope ? envelope.revisionId : undefined;

  const sections = useMemo(() => groupOpsByBlock(blockOps), [blockOps]);

  const handleRevert = useCallback(() => {
    requestRevert({ revisionId, path, zone, command });
  }, [revisionId, path, zone, command]);

  const showRevert = mode === "applied" && path.length > 0;

  return (
    <div className="border-t border-border px-3 py-2 space-y-2" data-testid="block-diff-view">
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

      {summary && (
        <div className="text-xs italic text-foreground-muted">{summary}</div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-border bg-background-element px-2 py-1.5 text-[0.7rem]">
        <span className="text-foreground-muted">
          {sections.length} block-level change{sections.length === 1 ? "" : "s"}
        </span>
      </div>

      {warnings?.map((warning, idx) => (
        <div key={idx} className="text-xs text-tool-warning">
          {warning}
        </div>
      ))}

      <div className="space-y-2">
        {sections.map((section, idx) => (
          <BlockDiffSection
            key={`${section.blockId}-${idx}`}
            section={section}
          />
        ))}
      </div>

      {(showRevert || mode === "historical") && (
        <div
          className="flex items-center justify-end gap-2 border-t border-border pt-1"
          data-testid="block-diff-view-actions"
        >
          {mode === "historical" ? (
            <span
              className="text-[0.7rem] italic text-foreground-muted"
              data-testid="block-diff-historical-badge"
            >
              Historical edit
            </span>
          ) : (
            <button
              type="button"
              onClick={handleRevert}
              className="rounded border border-border px-2.5 py-1 text-[0.7rem] font-medium text-foreground-muted hover:border-tool-error/40 hover:text-tool-error"
              data-testid="block-diff-revert"
            >
              Revert
            </button>
          )}
        </div>
      )}
    </div>
  );
}
