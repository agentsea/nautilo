/**
 * D448 — presentation for the top-level multi-file apply_patch tool.
 *
 * This component consumes the bounded, already-scanned event projection. It
 * does not parse patch input, discover targets, or impose another limit; the
 * projection's whole ordered rows and whole diff sections are the UI boundary.
 */

import { useCallback, useMemo, useState, type MouseEvent } from "react";
import type { ToolRenderer, ToolRendererProps } from "./types";
import { UnifiedDiffBody } from "./diff-view";
import { requestUndoTurn } from "../../../adapters/tool-invoke-ref";

type PathStatus = "applied" | "failed" | "not_applied" | "unknown";
type Operation = "add" | "update" | "move" | "delete";

interface PathResult {
  operation: Operation;
  path: string;
  fromPath?: string;
  status: PathStatus;
  revisionId?: string | null;
  error?: { message?: string };
}

interface EventProjection {
  kind: "apply_patch";
  totalPaths: number;
  shownPaths: number;
  totalChangedFiles: number;
  shownChangedFiles: number;
  totalDiffChars: number;
  shownDiffChars: number;
  totalErrorMessageChars: number;
  shownErrorMessageChars: number;
  scalarFieldsTruncated: boolean;
  truncated: boolean;
}

type OperationCounts = Record<Operation, number>;

interface ApplyPatchProjection {
  status?: "applied" | "partial";
  failed: boolean;
  partial: boolean;
  turnId?: string;
  operationCounts: OperationCounts;
  pathResults: PathResult[];
  unifiedDiff: string;
  error?: { code?: string; message?: string };
  eventProjection: EventProjection;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function parseOperationCounts(value: unknown): OperationCounts | null {
  if (!isRecord(value)) return null;
  const operations = ["add", "update", "move", "delete"] as const;
  if (!operations.every((operation) => asCount(value[operation]) !== null)) return null;
  return {
    add: asCount(value["add"])!,
    update: asCount(value["update"])!,
    move: asCount(value["move"])!,
    delete: asCount(value["delete"])!,
  };
}

function parsePathResult(value: unknown): PathResult | null {
  if (!isRecord(value)) return null;
  const operation = value["operation"];
  const path = value["path"];
  const status = value["status"];
  if (
    (operation !== "add" && operation !== "update" && operation !== "move" && operation !== "delete") ||
    typeof path !== "string" ||
    (status !== "applied" && status !== "failed" && status !== "not_applied" && status !== "unknown")
  ) return null;
  if (operation === "move" && typeof value["fromPath"] !== "string") return null;
  const error = isRecord(value["error"]) && typeof value["error"]["message"] === "string"
    ? { message: value["error"]["message"] }
    : undefined;
  return {
    operation,
    path,
    status,
    ...(operation === "move" ? { fromPath: value["fromPath"] as string } : {}),
    ...(typeof value["revisionId"] === "string" || value["revisionId"] === null
      ? { revisionId: value["revisionId"] }
      : {}),
    ...(error ? { error } : {}),
  };
}

function parseProjection(resultText: string | undefined): ApplyPatchProjection | null {
  if (!resultText) return null;
  let value: unknown;
  try {
    value = JSON.parse(resultText);
  } catch {
    return null;
  }
  if (!isRecord(value) || !isRecord(value["eventProjection"])) return null;
  const metadata = value["eventProjection"];
  const failed = value["ok"] === false;
  const operationCounts = parseOperationCounts(value["operationCounts"]) ??
    (failed ? { add: 0, update: 0, move: 0, delete: 0 } : null);
  const countKeys = [
    "totalPaths",
    "shownPaths",
    "totalChangedFiles",
    "shownChangedFiles",
    "totalDiffChars",
    "shownDiffChars",
    "totalErrorMessageChars",
    "shownErrorMessageChars",
  ] as const;
  if (
    metadata["kind"] !== "apply_patch" ||
    typeof metadata["truncated"] !== "boolean" ||
    typeof metadata["scalarFieldsTruncated"] !== "boolean" ||
    !countKeys.every((key) => asCount(metadata[key]) !== null) ||
    operationCounts === null ||
    !Array.isArray(value["pathResults"]) ||
    typeof value["unifiedDiff"] !== "string"
  ) return null;
  const pathResults = value["pathResults"].map(parsePathResult);
  if (pathResults.some((row) => row === null)) return null;
  return {
    ...(value["status"] === "applied" || value["status"] === "partial" ? { status: value["status"] } : {}),
    failed,
    partial: value["partial"] === true || value["status"] === "partial",
    ...(typeof value["turnId"] === "string" ? { turnId: value["turnId"] } : {}),
    operationCounts,
    pathResults: pathResults as PathResult[],
    unifiedDiff: value["unifiedDiff"],
    ...(isRecord(value["error"]) && (typeof value["error"]["message"] === "string" || typeof value["error"]["code"] === "string")
      ? {
          error: {
            ...(typeof value["error"]["code"] === "string" ? { code: value["error"]["code"] } : {}),
            ...(typeof value["error"]["message"] === "string" ? { message: value["error"]["message"] } : {}),
          },
        }
      : {}),
    eventProjection: {
      kind: "apply_patch",
      totalPaths: asCount(metadata["totalPaths"])!,
      shownPaths: asCount(metadata["shownPaths"])!,
      totalChangedFiles: asCount(metadata["totalChangedFiles"])!,
      shownChangedFiles: asCount(metadata["shownChangedFiles"])!,
      totalDiffChars: asCount(metadata["totalDiffChars"])!,
      shownDiffChars: asCount(metadata["shownDiffChars"])!,
      totalErrorMessageChars: asCount(metadata["totalErrorMessageChars"])!,
      shownErrorMessageChars: asCount(metadata["shownErrorMessageChars"])!,
      scalarFieldsTruncated: metadata["scalarFieldsTruncated"],
      truncated: metadata["truncated"],
    },
  };
}

interface HarnessPatchSummary {
  readonly heading: string;
  readonly detail: string;
  readonly failed: boolean;
}

function parseHarnessPatchSummary(resultText: string | undefined): HarnessPatchSummary | null {
  if (!resultText?.trim()) return null;
  const lines = resultText.trim().split("\n");
  const heading = lines[0]?.trim() ?? "";
  if (!/^(?:File changes?|Patch) (?:completed|failed|output)/i.test(heading)) return null;
  return {
    heading,
    detail: lines.slice(1).join("\n").trim(),
    failed: /failed/i.test(heading),
  };
}

interface DiffSection {
  label: string;
  body: string;
}

/** The event projection retains only complete sections; this splits those for navigation. */
function splitProjectedDiffSections(value: string): DiffSection[] {
  if (value.length === 0) return [];
  const starts = [...value.matchAll(/^(?=diff --git |\*\*\* (?:Add|Update|Delete|Move) File:)/gm)]
    .map((match) => match.index ?? 0);
  const chunks = starts.length > 0 && starts[0] === 0
    ? starts.map((start, index) => value.slice(start, starts[index + 1]))
    : [value];
  return chunks.map((body, index) => ({ label: sectionLabel(body, index), body }));
}

function sectionLabel(section: string, index: number): string {
  const git = /^diff --git a\/(.+?) b\/(.+)$/m.exec(section);
  if (git?.[2]) return git[2];
  const codex = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/m.exec(section);
  if (codex?.[1]) return codex[1];
  const plus = /^\+\+\+ (?:b\/)?(.+)$/m.exec(section);
  if (plus?.[1] && plus[1] !== "/dev/null") return plus[1];
  return `Diff ${index + 1}`;
}

function statusClass(status: PathStatus): string {
  if (status === "applied") return "text-tool-success";
  if (status === "unknown") return "text-tool-warning";
  return "text-tool-error";
}

function statusLabel(status: PathStatus): string {
  return status === "not_applied" ? "not applied" : status;
}

function operationLabel(row: PathResult): string {
  if (row.operation === "move") return `Move ${row.fromPath} → ${row.path}`;
  return `${row.operation[0].toUpperCase()}${row.operation.slice(1)} ${row.path}`;
}

function resultCounts(rows: readonly PathResult[]): Record<PathStatus, number> {
  return rows.reduce<Record<PathStatus, number>>(
    (counts, row) => ({ ...counts, [row.status]: counts[row.status] + 1 }),
    { applied: 0, failed: 0, not_applied: 0, unknown: 0 },
  );
}

function totalApplied(counts: OperationCounts): number {
  return counts.add + counts.update + counts.move + counts.delete;
}

/**
 * `target` is a model-requested selector, never proof of the target that the
 * executor ultimately selected. In particular, omission means automatic
 * selection at execution time, not an inferred Workspace or Current Folder.
 */
function requestedTargetLabel(args: Record<string, unknown>): string {
  if (args["target"] === "workspace") return "Workspace";
  if (args["target"] === "current") return "Current Folder";
  return "Automatic target";
}

function ApplyPatchExpanded({ args, resultText, resultTruncated }: ToolRendererProps): React.ReactElement {
  const projection = useMemo(() => parseProjection(resultText), [resultText]);
  const harnessSummary = useMemo(() => parseHarnessPatchSummary(resultText), [resultText]);
  const sections = useMemo(
    () => splitProjectedDiffSections(projection?.unifiedDiff ?? ""),
    [projection?.unifiedDiff],
  );
  const [selectedSection, setSelectedSection] = useState(0);
  const onUndo = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!projection?.turnId || projection.eventProjection.scalarFieldsTruncated) return;
    if (totalApplied(projection.operationCounts) === 0) return;
    requestUndoTurn({ turnId: projection.turnId });
  }, [projection]);

  if (!projection) {
    if (harnessSummary) {
      return (
        <div className="border-t border-border px-3 py-2 space-y-2" data-testid="apply-patch-renderer">
          <div
            className={`rounded border px-3 py-2 text-xs ${harnessSummary.failed ? "border-tool-error/40 bg-tool-error/10 text-tool-error" : "border-tool-success/40 bg-tool-success/10 text-tool-success"}`}
            data-testid="apply-patch-harness-summary"
          >
            <div className="font-semibold">{harnessSummary.heading}</div>
            {harnessSummary.detail ? (
              <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[0.7rem] text-foreground">
                {harnessSummary.detail}
              </pre>
            ) : null}
          </div>
          {resultTruncated ? (
            <div className="text-xs text-foreground-muted">The harness summary was truncated.</div>
          ) : null}
        </div>
      );
    }
    return (
      <div className="border-t border-border px-3 py-2 text-xs text-foreground-muted" data-testid="apply-patch-renderer">
        Apply patch result is unavailable for structured display.
      </div>
    );
  }

  if (projection.failed) {
    return (
      <div className="border-t border-border px-3 py-2 space-y-2" data-testid="apply-patch-renderer">
        <div className="rounded border border-tool-error/40 bg-tool-error/10 px-3 py-2 text-xs text-tool-error" role="alert" data-testid="apply-patch-failure">
          <div className="font-semibold">
            Apply patch failed{projection.error?.code ? ` — ${projection.error.code}` : ""}
          </div>
          {projection.error?.message ? <div className="mt-1">{projection.error.message}</div> : null}
        </div>
        <div className="text-xs text-foreground-muted" data-testid="apply-patch-requested-target">
          Requested target: <span className="font-medium text-foreground">{requestedTargetLabel(args)}</span>
        </div>
      </div>
    );
  }

  const counts = resultCounts(projection.pathResults);
  const appliedTotal = totalApplied(projection.operationCounts);
  const rowsAreProjected = projection.eventProjection.truncated || resultTruncated;
  const canUndoTurn =
    typeof projection.turnId === "string" &&
    projection.turnId.length > 0 &&
    !projection.eventProjection.scalarFieldsTruncated &&
    appliedTotal > 0;
  const selected = sections[Math.min(selectedSection, Math.max(0, sections.length - 1))];

  return (
    <div className="border-t border-border px-3 py-2 space-y-3" data-testid="apply-patch-renderer">
      {projection.partial ? (
        <div className="rounded border border-tool-warning/40 bg-tool-warning/10 px-3 py-2 text-xs text-tool-warning" role="alert" data-testid="apply-patch-partial-warning">
          <span className="font-semibold">Partially applied.</span>{" "}
          {projection.error?.message ?? "Review the ordered path results before continuing or reverting the applied changes."}
        </div>
      ) : null}

      {(projection.eventProjection.truncated || resultTruncated) ? (
        <div className="rounded border border-border bg-background px-3 py-2 text-xs text-foreground-muted" data-testid="apply-patch-projection-banner">
          Showing {projection.eventProjection.shownPaths} of {projection.eventProjection.totalPaths} path results, {" "}
          {projection.eventProjection.shownChangedFiles} of {projection.eventProjection.totalChangedFiles} changed files, and {" "}
          {projection.eventProjection.shownDiffChars} of {projection.eventProjection.totalDiffChars} diff characters from the event projection.
          {projection.eventProjection.scalarFieldsTruncated ? " Some scalar metadata was omitted, so whole-turn recovery is unavailable here." : ""}
        </div>
      ) : null}

      <div className="text-xs text-foreground-muted" data-testid="apply-patch-requested-target">
        Requested target: <span className="font-medium text-foreground">{requestedTargetLabel(args)}</span>
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs" data-testid="apply-patch-counts">
        <span>{projection.eventProjection.totalPaths} total paths</span>
        <span className="text-tool-success">{appliedTotal} applied</span>
        {rowsAreProjected ? (
          <span className="text-foreground-muted">
            shown: {counts.applied} applied, {counts.not_applied} not applied, {counts.failed} failed, {counts.unknown} unknown
          </span>
        ) : <>
          <span className="text-tool-error">{counts.not_applied} not applied</span>
          <span className="text-tool-error">{counts.failed} failed</span>
          <span className="text-tool-warning">{counts.unknown} unknown</span>
        </>}
      </div>

      <ol className="space-y-1" data-testid="apply-patch-rows">
        {projection.pathResults.map((row, index) => (
          <li key={`${index}:${row.path}`} className="rounded border border-border bg-background px-3 py-2 text-xs">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="font-mono text-foreground">{operationLabel(row)}</span>
              <span className={`font-semibold ${statusClass(row.status)}`}>{statusLabel(row.status)}</span>
            </div>
            {row.status === "applied" && row.revisionId ? (
              <div className="mt-1 font-mono text-[0.7rem] text-foreground-muted">revision {row.revisionId}</div>
            ) : null}
            {row.status === "unknown" && row.error?.message ? (
              <div className="mt-1 text-tool-warning">Unknown outcome: {row.error.message}</div>
            ) : row.status !== "applied" && row.error?.message ? (
              <div className="mt-1 text-tool-error">{row.error.message}</div>
            ) : null}
          </li>
        ))}
      </ol>

      {sections.length > 0 ? (
        <section className="space-y-2" aria-label="projected file diffs">
          <div className="flex max-w-full gap-1 overflow-x-auto pb-1" data-testid="apply-patch-diff-navigation">
            {sections.map((section, index) => (
              <button
                key={`${index}:${section.label}`}
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setSelectedSection(index);
                }}
                className={`shrink-0 rounded border px-2 py-1 font-mono text-[0.7rem] ${index === selectedSection ? "border-accent text-foreground" : "border-border text-foreground-muted"}`}
                data-testid="apply-patch-diff-tab"
              >
                {section.label}
              </button>
            ))}
          </div>
          {selected ? <UnifiedDiffBody unifiedDiff={selected.body} /> : null}
        </section>
      ) : null}

      {canUndoTurn ? (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onUndo}
            className="rounded border border-border px-2.5 py-1 text-[0.7rem] font-medium text-foreground-muted hover:border-tool-error/40 hover:text-tool-error"
            data-testid="apply-patch-undo-turn"
          >
            Revert entire patch
          </button>
        </div>
      ) : null}
    </div>
  );
}

function collapsedProjection(resultText: string | undefined): ApplyPatchProjection | null {
  return parseProjection(resultText);
}

export const applyPatchRenderer: ToolRenderer = {
  collapsedSummary: ({ args, resultText }) => {
    const projection = collapsedProjection(resultText);
    const target = requestedTargetLabel(args);
    if (!projection) {
      const harnessSummary = parseHarnessPatchSummary(resultText);
      return harnessSummary ? harnessSummary.heading : `multi-file patch · ${target}`;
    }
    if (projection.failed) return `FAILED${projection.error?.code ? ` — ${projection.error.code}` : ""} · ${target}`;
    const applied = totalApplied(projection.operationCounts);
    const summary = `${applied}/${projection.eventProjection.totalPaths} applied`;
    const status = projection.partial ? `PARTIAL — ${summary}` : summary;
    return `${status} · ${target}`;
  },
  collapsedExtras: ({ resultText }) => {
    const projection = collapsedProjection(resultText);
    return projection?.eventProjection.truncated ? "projected" : null;
  },
  autoExpandOnResult: true,
  ExpandedBody: ApplyPatchExpanded,
};
