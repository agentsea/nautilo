import type { Document } from "@nautilo/office-docs/node";
import type { ProposalOperation, ProposalScope } from "./proposal-contract";

export type ResolvedRange = { start: number; end: number };
export type ResolvedProposalOperation =
  (
    | (Exclude<Extract<ProposalOperation, { blockId: string }>, { kind: "move-block" }> & { range: ResolvedRange })
    | Extract<ProposalOperation, { kind: "move-block" }>
    | Exclude<ProposalOperation, { blockId: string }>
  ) & { operationIndex?: number };
export type ProposalResolutionError = {
  ok: false;
  code: "unknown_block" | "anchor_not_found" | "anchor_ambiguous" | "invalid_scope" | "invalid_destination";
  operationIndex?: number;
  message: string;
};
export type ProposalResolutionResult =
  | { ok: true; operations: ResolvedProposalOperation[] }
  | ProposalResolutionError;

type TextBlock = { id?: unknown; inlines?: unknown; type?: unknown; tableData?: { rows?: Array<{ cells?: Array<{ blocks?: TextBlock[]; colSpan?: number }> }> } };
type NormalizedText = { text: string; starts: number[]; ends: number[] };

function error(code: ProposalResolutionError["code"], message: string, operationIndex?: number): ProposalResolutionError {
  return { ok: false, code, message, ...(operationIndex === undefined ? {} : { operationIndex }) };
}
function blockText(block: TextBlock): string {
  if (!Array.isArray(block.inlines)) return "";
  return block.inlines.map((inline) => {
    if (!inline || typeof inline !== "object") return "";
    const text = (inline as { text?: unknown }).text;
    return typeof text === "string" ? text : "";
  }).join("");
}

/**
 * Normalization is intentionally narrow: typographic quotes, en/em dashes,
 * and all whitespace runs. It neither folds case nor alters letters.
 */
export function normalizeProposalText(value: string): NormalizedText {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let whitespaceStart = -1;
  for (let offset = 0; offset < value.length;) {
    const codePoint = value.codePointAt(offset)!;
    const char = String.fromCodePoint(codePoint);
    const width = char.length;
    if (/\s/u.test(char)) {
      if (whitespaceStart < 0) {
        whitespaceStart = offset;
        text += " ";
        starts.push(offset);
        ends.push(offset + width);
      } else {
        ends[ends.length - 1] = offset + width;
      }
      offset += width;
      continue;
    }
    whitespaceStart = -1;
    const normalized =
      /[\u2018\u2019\u201A\u201B]/u.test(char) ? "'" :
      /[\u201C\u201D\u201E\u201F]/u.test(char) ? '"' :
      /[\u2013\u2014]/u.test(char) ? "-" : char;
    text += normalized;
    starts.push(offset);
    ends.push(offset + width);
    offset += width;
  }
  return { text, starts, ends };
}

function findRange(text: string, scope: ProposalScope): ResolvedRange | ProposalResolutionError {
  if (scope.kind === "block") return { start: 0, end: text.length };
  if (scope.kind === "range") {
    return scope.end <= text.length ? { start: scope.start, end: scope.end } : error("invalid_scope", "structural range is outside the logical block text");
  }
  if (scope.kind === "locator") {
    return error("invalid_scope", "opaque locator was not resolved by the live Writer server gate");
  }
  const normalizedBlock = normalizeProposalText(text);
  const normalizedAnchor = normalizeProposalText(scope.anchor).text;
  if (!normalizedAnchor) return error("invalid_scope", "anchor is empty after normalization");
  const matches: number[] = [];
  let from = 0;
  while (from <= normalizedBlock.text.length - normalizedAnchor.length) {
    const index = normalizedBlock.text.indexOf(normalizedAnchor, from);
    if (index < 0) break;
    matches.push(index);
    from = index + Math.max(1, normalizedAnchor.length);
  }
  if (matches.length === 0) return error("anchor_not_found", "anchor does not occur in the specified block");
  if (matches.length > 1) return error("anchor_ambiguous", "anchor occurs more than once in the specified block");
  const matchStart = matches[0]!;
  const matchEnd = matchStart + normalizedAnchor.length;
  const start = normalizedBlock.starts[matchStart]!;
  const end = normalizedBlock.ends[matchEnd - 1]!;
  if (scope.kind === "match") return { start, end };
  const sentenceStart = Math.max(
    0,
    Math.max(text.lastIndexOf(".", start - 1), text.lastIndexOf("!", start - 1), text.lastIndexOf("?", start - 1)) + 1,
  );
  const nextStops = [text.indexOf(".", end), text.indexOf("!", end), text.indexOf("?", end)].filter((index) => index >= 0);
  const sentenceEnd = nextStops.length === 0 ? text.length : Math.min(...nextStops) + 1;
  return { start: sentenceStart, end: sentenceEnd };
}

/** Resolves model-provided locators against a snapshot without mutating it. */
export function resolveProposalOperations(
  document: Pick<Document, "blocks">,
  operations: readonly ProposalOperation[],
): ProposalResolutionResult {
  const blocks = document.blocks as readonly TextBlock[];
  const ids = new Set<string>();
  for (const block of blocks) {
    if (typeof block?.id === "string") ids.add(block.id);
    if (block?.type === "table") {
      for (const row of block.tableData?.rows ?? []) for (const cell of row.cells ?? []) {
        if (cell.colSpan === 0) continue;
        for (const nested of cell.blocks ?? []) if (typeof nested.id === "string") {
          if (ids.has(nested.id)) return error("invalid_scope", `duplicate nested block "${nested.id}"`);
          ids.add(nested.id);
        }
      }
    }
  }
  const resolved: ResolvedProposalOperation[] = [];
  for (let index = 0; index < operations.length; index++) {
    const operation = operations[index]!;
    if ("tableBlockId" in operation) {
      const table = blocks.find((candidate) => candidate?.id === operation.tableBlockId && candidate.type === "table");
      if (!table) return error("unknown_block", `table "${operation.tableBlockId}" does not exist`, index);
      resolved.push({ ...operation, operationIndex: index });
      continue;
    }
    let block = blocks.find((candidate) => candidate?.id === operation.blockId);
    if (!block) {
      for (const table of blocks) if (table.type === "table") {
        for (const row of table.tableData?.rows ?? []) for (const cell of row.cells ?? []) {
          if (cell.colSpan === 0) continue;
          const nested = (cell.blocks ?? []).find((candidate) => candidate?.id === operation.blockId);
          if (nested) { block = nested; break; }
        }
        if (block) break;
      }
    }
    if (!block) return error("unknown_block", `block "${operation.blockId}" does not exist`, index);
    if (operation.kind === "move-block") {
      if (operation.destination.position === "after" && !ids.has(operation.destination.afterBlockId)) {
        return error("invalid_destination", `destination block "${operation.destination.afterBlockId}" does not exist`, index);
      }
      resolved.push({ ...operation, operationIndex: index });
      continue;
    }
    const range = findRange(blockText(block), operation.scope);
    if ("ok" in range) return { ...range, operationIndex: index };
    resolved.push({ ...operation, range, operationIndex: index });
  }
  return { ok: true, operations: resolved };
}
