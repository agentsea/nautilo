/** Catalogue-projected, provider-free Computer Use presentation. */
import type { ReactElement } from "react";
import type { ToolCardState } from "../tool-card-helpers";
import type { ToolRenderer, ToolRendererProps } from "./types";

type Presentation = Readonly<{
  label: string;
  summary: string;
  settlement: "completed" | "not_completed" | "unknown_completion" | "cancelled" | "revoked" | "stale" | "fenced" | "failed";
  ok: boolean;
}>;
const SETTLEMENTS = new Set<Presentation["settlement"]>(["completed", "not_completed", "unknown_completion", "cancelled", "revoked", "stale", "fenced", "failed"]);

function safeText(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) return false;
  return [...value].every((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined
      && !(codePoint <= 0x1f || codePoint === 0x7f || codePoint === 0x2028 || codePoint === 0x2029);
  });
}

/** Strictly consume the DTO and intentionally ignore the public result body. */
export function parseComputerUseResult(raw: string | undefined): Presentation | null {
  if (!raw?.trim()) return null;
  try {
    const root: unknown = JSON.parse(raw);
    if (typeof root !== "object" || root === null || Array.isArray(root)) return null;
    const value = root as Record<string, unknown>;
    if (value["version"] !== 1 || typeof value["ok"] !== "boolean") return null;
    const presentation = value["presentation"];
    if (typeof presentation !== "object" || presentation === null || Array.isArray(presentation)) return null;
    const dto = presentation as Record<string, unknown>;
    if (Object.keys(dto).length !== 2 || !safeText(dto["label"]) || !safeText(dto["summary"])) return null;
    if (typeof value["settlement"] !== "string" || !SETTLEMENTS.has(value["settlement"] as Presentation["settlement"])) return null;
    if (value["ok"] !== (value["settlement"] === "completed")) return null;
    return { label: dto["label"], summary: dto["summary"], settlement: value["settlement"] as Presentation["settlement"], ok: value["ok"] };
  } catch { return null; }
}

/** Keep only valid sealed presentation bytes out of generic JSON cards. */
export function preserveComputerUseResultForCard(toolName: string | undefined, raw: string | undefined): string | undefined {
  return toolName?.startsWith("computer_") === true && parseComputerUseResult(raw) !== null ? raw : undefined;
}

function collapsedSummary({ resultText }: Pick<ToolRendererProps, "resultText">): string {
  return parseComputerUseResult(resultText)?.summary ?? "Computer Use";
}

function ComputerUseExpanded({ resultText }: ToolRendererProps): ReactElement {
  const result = parseComputerUseResult(resultText);
  const attention = result?.ok !== true;
  return <div className="border-t border-border px-3 py-3 text-xs" data-testid="computer-use-result">
    <p role={attention ? "status" : undefined} className={attention ? "text-[var(--warning,#b58900)]" : "text-foreground-muted"}>
      {result?.summary ?? "Computer Use result is unavailable. Observe the current state before continuing."}
    </p>
  </div>;
}

export const computerUseRenderer: ToolRenderer = {
  displayName: "Computer Use",
  collapsedSummary,
  sealedResultParser: true,
  stateOverride: ({ resultText, state }): ToolCardState | null => {
    if (state === "pending" || state === "running") return null;
    const result = parseComputerUseResult(resultText);
    // Missing presentation bytes are not evidence that execution was blocked.
    // Preserve the transport-owned terminal state while the expanded body
    // truthfully reports that its sealed presentation is unavailable.
    if (result === null || result.ok) return null;
    if (result.settlement === "failed") return "error";
    if (result.settlement === "cancelled") return "cancelled";
    return "blocked";
  },
  ExpandedBody: ComputerUseExpanded,
};
