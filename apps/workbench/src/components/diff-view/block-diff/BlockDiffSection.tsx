/**
 * One expandable section per staging `BlockOp` — header, optional within-block
 * diff (jsdiff via `diff` package).
 */

import { useMemo } from "react";
import type { BlockDiffSection as BlockDiffSectionModel } from "./group-ops-by-block";
import { pickDiffAlgo } from "./content-type-sniffer";
import { buildBlockDiffSegments } from "./build-segments";

// NOTE — text escaping intentionally absent. React's JSX renders
// {string} as a text node, automatically escaping `<` / `>` / `&`
// for safe display inside `<code>`. An explicit pre-escape (e.g.
// `&lt;` → text) would double-escape and surface literal `&lt;`
// glyphs in the diff viewport. (D121-P5 orchestrator viz audit
// caught this on the v1 commit; pre-escape was removed.)

function formatHeader(section: BlockDiffSectionModel): string {
  const { op, blockId, tag } = section;
  if (op === "moved" && section.blockOp.op === "move") {
    const a = section.blockOp.anchor;
    return `${tag} \`${blockId}\` moved ${a.rel} \`${a.id}\``;
  }
  const verb =
    op === "added" ? "added"
    : op === "deleted" ? "deleted"
    : op === "moved" ? "moved"
    : "modified";
  return `${tag} \`${blockId}\` ${verb}`;
}

export interface BlockDiffSectionProps {
  section: BlockDiffSectionModel;
}

export function BlockDiffSection(props: BlockDiffSectionProps): React.ReactElement {
  const { section } = props;

  const segments = useMemo(() => {
    if (section.op === "moved") return [];
    if (section.op === "added" && section.after) {
      const algo = pickDiffAlgo(section.tag);
      return buildBlockDiffSegments("", section.after, algo).filter((s) => s.kind !== "equal");
    }
    if (section.op === "deleted" && section.before) {
      const algo = pickDiffAlgo(section.tag);
      return buildBlockDiffSegments(section.before, "", algo).filter((s) => s.kind !== "equal");
    }
    const b = section.before ?? "";
    const a = section.after ?? "";
    if (b === "" && a === "") return [];
    const algo = pickDiffAlgo(section.tag);
    return buildBlockDiffSegments(b, a, algo);
  }, [section]);

  const header = formatHeader(section);

  return (
    <section
      className="rounded border border-border bg-background"
      data-testid="block-diff-section"
      data-block-id={section.blockId}
    >
      <header className="border-b border-border px-2 py-1.5 text-[0.7rem] font-medium text-foreground">
        {header}
      </header>

      {section.op === "moved" ? (
        <div className="px-2 py-2 text-xs italic text-foreground-muted">
          No content change — block position only.
        </div>
      ) : (
        <pre className="max-h-64 overflow-y-auto px-2 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
          <code>
            {segments.map((seg, idx) => {
              if (seg.kind === "del") {
                return (
                  <span
                    key={idx}
                    className="bg-tool-error/10 text-tool-error line-through"
                    data-testid="block-diff-del"
                  >
                    {seg.text}
                  </span>
                );
              }
              if (seg.kind === "add") {
                return (
                  <span
                    key={idx}
                    className="bg-tool-success/10 text-tool-success"
                    data-testid="block-diff-add"
                  >
                    {seg.text}
                  </span>
                );
              }
              return (
                <span key={idx} data-testid="block-diff-eq">
                  {seg.text}
                </span>
              );
            })}
          </code>
        </pre>
      )}
    </section>
  );
}
