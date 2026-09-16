/** Pure, fail-closed wire contract for live Writer edit proposals. */
/* eslint-disable no-control-regex */

import type { LiveDocumentVersion } from "@nautilo/types";
import { parseLiveDocumentVersion, parseNonNegativeSafeInteger } from "@nautilo/types";
import {
  validateBlockStyle,
  validateInlineStyle,
  validateTableCellStyle,
  type StyleValidationError,
} from "./writer-style-validation";

export const MAX_ANCHOR_WORDS = 5;
export const MAX_TEXT_LENGTH = 20_000;
export const MAX_BLOCK_ID_LENGTH = 200;

export type ProposalScope =
  | { kind: "match"; anchor: string }
  | { kind: "sentence"; anchor: string }
  | { kind: "block" }
  | { kind: "locator"; handle: string }
  | { kind: "range"; start: number; end: number };

export type InlineStylePatch = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  fontSize?: number;
  fontFamily?: string;
  color?: string;
  backgroundColor?: string;
  href?: string;
};

export type BlockStylePatch = {
  alignment?: "left" | "center" | "right" | "justify";
  lineHeight?: number;
  marginTop?: number;
  marginBottom?: number;
  textIndent?: number;
  marginLeft?: number;
};

export type BlockTypeChange =
  | { type: "paragraph" }
  | { type: "heading"; headingLevel?: 1 | 2 | 3 }
  | { type: "list-item"; listKind?: "ordered" | "unordered"; listLevel?: number };

export type MoveDestination =
  | { position: "start" }
  | { position: "end" }
  | { position: "after"; afterBlockId: string };

export type CellAddress = { rowIndex: number; colIndex: number };
export type CellStylePatch = {
  backgroundColor?: string;
  verticalAlign?: "top" | "middle" | "bottom";
  padding?: number;
};

export type ProposalOperation =
  | { kind: "insert"; blockId: string; scope: ProposalScope; text: string }
  | { kind: "delete"; blockId: string; scope: ProposalScope }
  | { kind: "replace"; blockId: string; scope: ProposalScope; text: string }
  | { kind: "format-inline"; blockId: string; scope: ProposalScope; style: InlineStylePatch }
  | { kind: "format-block"; blockId: string; scope: Extract<ProposalScope, { kind: "block" }>; style: BlockStylePatch }
  | { kind: "set-block-type"; blockId: string; scope: Extract<ProposalScope, { kind: "block" }>; blockType: BlockTypeChange }
  | { kind: "move-block"; blockId: string; destination: MoveDestination }
  | { kind: "insert-table-row"; tableBlockId: string; rowIndex: number; blockId?: never }
  | { kind: "delete-table-row"; tableBlockId: string; rowIndex: number; blockId?: never }
  | { kind: "insert-table-column"; tableBlockId: string; colIndex: number; blockId?: never }
  | { kind: "delete-table-column"; tableBlockId: string; colIndex: number; blockId?: never }
  | { kind: "merge-table-cells"; tableBlockId: string; start: CellAddress; end: CellAddress; blockId?: never }
  | { kind: "split-table-cell"; tableBlockId: string; cell: CellAddress; blockId?: never }
  | { kind: "set-table-cell-style"; tableBlockId: string; cell: CellAddress; style: CellStylePatch; blockId?: never }
  | { kind: "delete-table"; tableBlockId: string; blockId?: never };

export type EditOpenWriterRequest = {
  sessionToken: string;
  documentVersion: LiveDocumentVersion;
  operations: ProposalOperation[];
};

export type ProposalValidationError = {
  ok: false;
  code: "invalid_request";
  field: string;
  message: string;
};

export type ProposalValidationResult =
  | { ok: true; request: EditOpenWriterRequest }
  | ProposalValidationError;

function fail(field: string, message: string): ProposalValidationError {
  return { ok: false, code: "invalid_request", field, message };
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function rejectUnknownFields(
  value: Record<string, unknown>,
  field: string,
  allowed: ReadonlySet<string>,
): ProposalValidationError | null {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return fail(`${field}.${key}`, "is not an allowed property");
  }
  return null;
}
function blockId(value: unknown, field: string): string | ProposalValidationError {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_BLOCK_ID_LENGTH || /[\x00-\x1f\x7f]/.test(value)) {
    return fail(field, "must be a non-empty safe block ID");
  }
  return value;
}
function text(value: unknown, field: string): string | ProposalValidationError {
  if (typeof value !== "string" || value.length > MAX_TEXT_LENGTH) return fail(field, `must be a string up to ${MAX_TEXT_LENGTH} characters`);
  return value;
}
function anchor(value: unknown, field: string): string | ProposalValidationError {
  if (typeof value !== "string" || value.trim().length === 0) return fail(field, "must be a non-empty 1–5-word freshness anchor");
  const words = value.trim().split(/\s+/u);
  if (words.length > MAX_ANCHOR_WORDS) return fail(field, "must contain at most 5 words");
  return value;
}
function nonNegativeInteger(value: unknown, field: string): number | ProposalValidationError {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fail(field, "must be a non-negative integer");
}
function cellAddress(value: unknown, field: string): CellAddress | ProposalValidationError {
  const address = record(value);
  if (!address) return fail(field, "must be a cell address");
  const unknown = rejectUnknownFields(address, field, new Set(["rowIndex", "colIndex"]));
  if (unknown) return unknown;
  const rowIndex = nonNegativeInteger(address["rowIndex"], `${field}.rowIndex`);
  const colIndex = nonNegativeInteger(address["colIndex"], `${field}.colIndex`);
  if (typeof rowIndex !== "number") return rowIndex;
  if (typeof colIndex !== "number") return colIndex;
  return { rowIndex, colIndex };
}

function validateScope(value: unknown, field: string): ProposalScope | ProposalValidationError {
  const scope = record(value);
  if (!scope) return fail(field, "must be an object");
  if (scope["kind"] === "match") {
    const unknown = rejectUnknownFields(scope, field, new Set(["kind", "anchor"]));
    if (unknown) return unknown;
    const a = anchor(scope["anchor"], `${field}.anchor`);
    return typeof a === "string" ? { kind: "match", anchor: a } : a;
  }
  if (scope["kind"] === "sentence") {
    const unknown = rejectUnknownFields(scope, field, new Set(["kind", "anchor"]));
    if (unknown) return unknown;
    const a = anchor(scope["anchor"], `${field}.anchor`);
    return typeof a === "string" ? { kind: "sentence", anchor: a } : a;
  }
  if (scope["kind"] === "block") {
    const unknown = rejectUnknownFields(scope, field, new Set(["kind"]));
    return unknown ?? { kind: "block" };
  }
  if (scope["kind"] === "locator") {
    const unknown = rejectUnknownFields(scope, field, new Set(["kind", "handle"]));
    if (unknown) return unknown;
    const handle = scope["handle"];
    if (typeof handle !== "string" || handle.length < 32 || handle.length > 256) {
      return fail(`${field}.handle`, "must be an opaque locator handle");
    }
    return { kind: "locator", handle };
  }
  if (scope["kind"] === "range") {
    const unknown = rejectUnknownFields(scope, field, new Set(["kind", "start", "end"]));
    if (unknown) return unknown;
    const start = nonNegativeInteger(scope["start"], `${field}.start`);
    const end = nonNegativeInteger(scope["end"], `${field}.end`);
    if (typeof start !== "number") return start;
    if (typeof end !== "number") return end;
    return start <= end ? { kind: "range", start, end } : fail(field, "range start must not exceed end");
  }
  return fail(`${field}.kind`, 'must be "match", "sentence", "block", "locator", or "range"');
}

function proposalStyleError(field: string, error: StyleValidationError): ProposalValidationError {
  return fail(error.field === "style" ? field : `${field}.${error.field}`, error.message);
}

function validateOperation(value: unknown, index: number): ProposalOperation | ProposalValidationError {
  const field = `operations[${index}]`;
  const op = record(value);
  if (!op) return fail(field, "must be an object");
  const kind = op["kind"];
  const structural = typeof kind === "string" && kind.includes("table");
  const id = structural ? "" : blockId(op["blockId"], `${field}.blockId`);
  if (typeof id !== "string") return id;
  const scope = kind === "move-block" || structural ? undefined : validateScope(op["scope"], `${field}.scope`);
  if (scope && !("kind" in scope)) return scope;
  switch (kind) {
    case "insert":
    case "replace": {
      const unknown = rejectUnknownFields(op, field, new Set(["kind", "blockId", "scope", "text"]));
      if (unknown) return unknown;
      const nextText = text(op["text"], `${field}.text`);
      if (typeof nextText !== "string") return nextText;
      return { kind, blockId: id, scope: scope!, text: nextText };
    }
    case "delete": {
      const unknown = rejectUnknownFields(op, field, new Set(["kind", "blockId", "scope"]));
      if (unknown) return unknown;
      return { kind: "delete", blockId: id, scope: scope! };
    }
    case "format-inline": {
      const unknown = rejectUnknownFields(op, field, new Set(["kind", "blockId", "scope", "style"]));
      if (unknown) return unknown;
      const style = validateInlineStyle<InlineStylePatch>(op["style"], "proposal", true);
      return style.ok
        ? { kind: "format-inline", blockId: id, scope: scope!, style: style.value }
        : proposalStyleError(`${field}.style`, style);
    }
    case "format-block": {
      const unknown = rejectUnknownFields(op, field, new Set(["kind", "blockId", "scope", "style"]));
      if (unknown) return unknown;
      if (scope?.kind !== "block") return fail(`${field}.scope`, "format-block requires block scope");
      const style = validateBlockStyle<BlockStylePatch>(op["style"], true);
      return style.ok
        ? { kind: "format-block", blockId: id, scope, style: style.value }
        : proposalStyleError(`${field}.style`, style);
    }
    case "set-block-type": {
      const unknown = rejectUnknownFields(op, field, new Set(["kind", "blockId", "scope", "blockType"]));
      if (unknown) return unknown;
      if (scope?.kind !== "block") return fail(`${field}.scope`, "set-block-type requires block scope");
      const change = record(op["blockType"]);
      if (!change) return fail(`${field}.blockType`, "must be an object");
      if (change["type"] === "paragraph") {
        const nestedUnknown = rejectUnknownFields(change, `${field}.blockType`, new Set(["type"]));
        return nestedUnknown ?? { kind: "set-block-type", blockId: id, scope, blockType: { type: "paragraph" } };
      }
      if (change["type"] === "heading" && (change["headingLevel"] === undefined || (typeof change["headingLevel"] === "number" && [1, 2, 3].includes(change["headingLevel"])))) {
        const nestedUnknown = rejectUnknownFields(change, `${field}.blockType`, new Set(["type", "headingLevel"]));
        if (nestedUnknown) return nestedUnknown;
        const headingLevel = change["headingLevel"];
        return {
          kind: "set-block-type",
          blockId: id,
          scope,
          blockType: {
            type: "heading",
            ...(headingLevel === undefined ? {} : { headingLevel: headingLevel as 1 | 2 | 3 }),
          },
        };
      }
      if (
        change["type"] === "list-item"
        && (change["listKind"] === undefined || change["listKind"] === "ordered" || change["listKind"] === "unordered")
        && (
          change["listLevel"] === undefined
          || (typeof change["listLevel"] === "number" && Number.isSafeInteger(change["listLevel"]) && change["listLevel"] >= 0 && change["listLevel"] <= 8)
        )
      ) {
        const nestedUnknown = rejectUnknownFields(change, `${field}.blockType`, new Set(["type", "listKind", "listLevel"]));
        if (nestedUnknown) return nestedUnknown;
        const listKind = change["listKind"];
        const listLevel = change["listLevel"];
        return {
          kind: "set-block-type",
          blockId: id,
          scope,
          blockType: {
            type: "list-item",
            ...(listKind === undefined ? {} : { listKind }),
            ...(listLevel === undefined ? {} : { listLevel }),
          },
        };
      }
      return fail(`${field}.blockType`, "must be a supported paragraph, heading, or list-item change");
    }
    case "move-block": {
      const unknown = rejectUnknownFields(op, field, new Set(["kind", "blockId", "destination"]));
      if (unknown) return unknown;
      const destination = record(op["destination"]);
      if (!destination) return fail(`${field}.destination`, "must be an object");
      if (destination["position"] === "start") {
        const nestedUnknown = rejectUnknownFields(destination, `${field}.destination`, new Set(["position"]));
        return nestedUnknown ?? { kind: "move-block", blockId: id, destination: { position: "start" } };
      }
      if (destination["position"] === "end") {
        const nestedUnknown = rejectUnknownFields(destination, `${field}.destination`, new Set(["position"]));
        return nestedUnknown ?? { kind: "move-block", blockId: id, destination: { position: "end" } };
      }
      if (destination["position"] === "after") {
        const nestedUnknown = rejectUnknownFields(destination, `${field}.destination`, new Set(["position", "afterBlockId"]));
        if (nestedUnknown) return nestedUnknown;
        const afterBlockId = blockId(destination["afterBlockId"], `${field}.destination.afterBlockId`);
        if (typeof afterBlockId !== "string") return afterBlockId;
        if (afterBlockId === id) return fail(`${field}.destination.afterBlockId`, "cannot name the moved block");
        return { kind: "move-block", blockId: id, destination: { position: "after", afterBlockId } };
      }
      return fail(`${field}.destination.position`, 'must be "start", "end", or "after"');
    }
    case "insert-table-row":
    case "delete-table-row": {
      const unknown = rejectUnknownFields(op, field, new Set(["kind", "tableBlockId", "rowIndex"]));
      if (unknown) return unknown;
      const tableBlockId = blockId(op["tableBlockId"], `${field}.tableBlockId`);
      const rowIndex = nonNegativeInteger(op["rowIndex"], `${field}.rowIndex`);
      if (typeof tableBlockId !== "string") return tableBlockId;
      if (typeof rowIndex !== "number") return rowIndex;
      return { kind, tableBlockId, rowIndex };
    }
    case "insert-table-column":
    case "delete-table-column": {
      const unknown = rejectUnknownFields(op, field, new Set(["kind", "tableBlockId", "colIndex"]));
      if (unknown) return unknown;
      const tableBlockId = blockId(op["tableBlockId"], `${field}.tableBlockId`);
      const colIndex = nonNegativeInteger(op["colIndex"], `${field}.colIndex`);
      if (typeof tableBlockId !== "string") return tableBlockId;
      if (typeof colIndex !== "number") return colIndex;
      return { kind, tableBlockId, colIndex };
    }
    case "merge-table-cells": {
      const unknown = rejectUnknownFields(op, field, new Set(["kind", "tableBlockId", "start", "end"]));
      if (unknown) return unknown;
      const tableBlockId = blockId(op["tableBlockId"], `${field}.tableBlockId`);
      const start = cellAddress(op["start"], `${field}.start`);
      const end = cellAddress(op["end"], `${field}.end`);
      if (typeof tableBlockId !== "string") return tableBlockId;
      if ("ok" in start) return start;
      if ("ok" in end) return end;
      return { kind: "merge-table-cells", tableBlockId, start, end };
    }
    case "split-table-cell": {
      const unknown = rejectUnknownFields(op, field, new Set(["kind", "tableBlockId", "cell"]));
      if (unknown) return unknown;
      const tableBlockId = blockId(op["tableBlockId"], `${field}.tableBlockId`);
      const cell = cellAddress(op["cell"], `${field}.cell`);
      if (typeof tableBlockId !== "string") return tableBlockId;
      if ("ok" in cell) return cell;
      return { kind: "split-table-cell", tableBlockId, cell };
    }
    case "set-table-cell-style": {
      const unknown = rejectUnknownFields(op, field, new Set(["kind", "tableBlockId", "cell", "style"]));
      if (unknown) return unknown;
      const tableBlockId = blockId(op["tableBlockId"], `${field}.tableBlockId`);
      const cell = cellAddress(op["cell"], `${field}.cell`);
      const style = validateTableCellStyle<CellStylePatch>(op["style"], true);
      if (typeof tableBlockId !== "string") return tableBlockId;
      if ("ok" in cell) return cell;
      return style.ok
        ? { kind: "set-table-cell-style", tableBlockId, cell, style: style.value }
        : proposalStyleError(`${field}.style`, style);
    }
    case "delete-table": {
      const unknown = rejectUnknownFields(op, field, new Set(["kind", "tableBlockId"]));
      if (unknown) return unknown;
      const tableBlockId = blockId(op["tableBlockId"], `${field}.tableBlockId`);
      return typeof tableBlockId === "string" ? { kind: "delete-table", tableBlockId } : tableBlockId;
    }
    default:
      return fail(`${field}.kind`, "is not a supported proposal operation");
  }
}

/** Parses the strict live-tool documentVersion union from untrusted tool input. */
export function parseEditOpenWriterDocumentVersion(value: unknown): LiveDocumentVersion | null {
  const parsed = parseLiveDocumentVersion(value);
  if (parsed) return parsed;
  const legacyRevision = parseNonNegativeSafeInteger(value);
  if (legacyRevision !== null) {
    return { kind: "artifact_revision", revision: legacyRevision };
  }
  return null;
}

/** Validates untrusted model input without throwing. */
export function validateEditOpenWriterRequest(value: unknown): ProposalValidationResult {
  const request = record(value);
  if (!request) return fail("request", "must be an object");
  const unknown = rejectUnknownFields(request, "request", new Set(["sessionToken", "documentVersion", "baseRevision", "operations"]));
  if (unknown) return unknown;
  const sessionToken = request["sessionToken"];
  const documentVersion = parseEditOpenWriterDocumentVersion(
    request["documentVersion"] ?? request["baseRevision"],
  );
  const operationsInput = request["operations"];
  if (typeof sessionToken !== "string" || sessionToken.trim().length === 0) return fail("sessionToken", "must be an opaque non-empty token");
  if (!documentVersion) return fail("documentVersion", "must be a supported live document version");
  if (!Array.isArray(operationsInput) || operationsInput.length === 0) return fail("operations", "must contain at least one operation");
  const operations: ProposalOperation[] = [];
  for (let i = 0; i < operationsInput.length; i++) {
    const op = validateOperation(operationsInput[i], i);
    if ("ok" in op) return op;
    operations.push(op);
  }
  return { ok: true, request: { sessionToken, documentVersion, operations } };
}
