/** Pure validation shared by live proposals and closed-document Writer tools. */
/* eslint-disable no-control-regex */

export const FONT_SIZE_MIN = 1;
export const FONT_SIZE_MAX = 200;
export const FONT_FAMILY_MAX = 100;
export const HREF_MAX = 2000;
export const BLOCK_STYLE_NUMBER_MIN = 0;
export const BLOCK_STYLE_NUMBER_MAX = 1000;
export const CELL_PADDING_MIN = 0;
export const CELL_PADDING_MAX = 100;

export type StyleValidationError = {
  ok: false;
  field: string;
  message: string;
};

export type StyleValidationResult<T extends Record<string, unknown>> =
  | { ok: true; value: T }
  | StyleValidationError;

export type InlineStyleValidationProfile = "proposal" | "closed";

const PROPOSAL_INLINE_KEYS = new Set([
  "bold", "italic", "underline", "strikethrough", "fontSize",
  "fontFamily", "color", "backgroundColor", "href",
]);
const CLOSED_INLINE_KEYS = new Set([
  ...PROPOSAL_INLINE_KEYS,
  "superscript", "subscript", "clear",
]);
const BLOCK_STYLE_KEYS = new Set([
  "alignment", "lineHeight", "marginTop", "marginBottom", "textIndent", "marginLeft",
]);
const CELL_STYLE_KEYS = new Set(["backgroundColor", "verticalAlign", "padding"]);
const BOOLEAN_INLINE_KEYS = new Set([
  "bold", "italic", "underline", "strikethrough", "superscript", "subscript", "clear",
]);
const BLOCK_NUMBER_KEYS = new Set(["lineHeight", "marginTop", "marginBottom", "textIndent", "marginLeft"]);
const ALIGNMENTS = new Set(["left", "center", "right", "justify"]);
const VERTICAL_ALIGNMENTS = new Set(["top", "middle", "bottom"]);
const HEX_COLOR = /^#?(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

function fail(field: string, message: string): StyleValidationError {
  return { ok: false, field, message };
}

function styleRecord(
  value: unknown,
  requireNonEmpty: boolean,
): StyleValidationResult<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("style", "must be an object");
  }
  const style = value as Record<string, unknown>;
  if (requireNonEmpty && Object.keys(style).length === 0) {
    return fail("style", "must be a non-empty style object");
  }
  return { ok: true, value: style };
}

function rejectUnknown(
  style: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): StyleValidationError | null {
  for (const key of Object.keys(style)) {
    if (!allowed.has(key)) return fail(key, "is not an allowed property");
  }
  return null;
}

function boundedNumber(
  value: unknown,
  field: string,
  min: number,
  max: number,
): StyleValidationError | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    return fail(field, `must be a finite number in [${min}, ${max}]`);
  }
  return null;
}

function safeBoundedString(
  value: unknown,
  field: string,
  max: number,
): StyleValidationError | null {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    return fail(field, `must be a non-empty string up to ${max} chars`);
  }
  if (CONTROL_CHARS.test(value)) return fail(field, "must not contain control characters");
  return null;
}

export function validateInlineStyle<T extends Record<string, unknown>>(
  value: unknown,
  profile: InlineStyleValidationProfile,
  requireNonEmpty = false,
): StyleValidationResult<T> {
  const parsed = styleRecord(value, requireNonEmpty);
  if (!parsed.ok) return parsed;
  const style = parsed.value;
  const unknown = rejectUnknown(style, profile === "proposal" ? PROPOSAL_INLINE_KEYS : CLOSED_INLINE_KEYS);
  if (unknown) return unknown;

  for (const key of BOOLEAN_INLINE_KEYS) {
    if (style[key] !== undefined && typeof style[key] !== "boolean") {
      return fail(key, "must be a boolean");
    }
  }
  if (style["fontSize"] !== undefined) {
    const error = boundedNumber(style["fontSize"], "fontSize", FONT_SIZE_MIN, FONT_SIZE_MAX);
    if (error) return error;
  }
  if (style["fontFamily"] !== undefined) {
    const error = safeBoundedString(style["fontFamily"], "fontFamily", FONT_FAMILY_MAX);
    if (error) return error;
  }
  for (const key of ["color", "backgroundColor"] as const) {
    if (style[key] !== undefined && (typeof style[key] !== "string" || !HEX_COLOR.test(style[key]))) {
      return fail(key, 'must be a hex color string (e.g. "#rrggbb")');
    }
  }
  if (style["href"] !== undefined) {
    const error = safeBoundedString(style["href"], "href", HREF_MAX);
    if (error) return error;
  }
  return { ok: true, value: style as T };
}

export function validateBlockStyle<T extends Record<string, unknown>>(
  value: unknown,
  requireNonEmpty = false,
): StyleValidationResult<T> {
  const parsed = styleRecord(value, requireNonEmpty);
  if (!parsed.ok) return parsed;
  const style = parsed.value;
  const unknown = rejectUnknown(style, BLOCK_STYLE_KEYS);
  if (unknown) return unknown;
  if (style["alignment"] !== undefined && (typeof style["alignment"] !== "string" || !ALIGNMENTS.has(style["alignment"]))) {
    return fail("alignment", 'must be "left", "center", "right", or "justify"');
  }
  for (const key of BLOCK_NUMBER_KEYS) {
    if (style[key] !== undefined) {
      const error = boundedNumber(style[key], key, BLOCK_STYLE_NUMBER_MIN, BLOCK_STYLE_NUMBER_MAX);
      if (error) return error;
    }
  }
  return { ok: true, value: style as T };
}

export function validateTableCellStyle<T extends Record<string, unknown>>(
  value: unknown,
  requireNonEmpty = false,
): StyleValidationResult<T> {
  const parsed = styleRecord(value, requireNonEmpty);
  if (!parsed.ok) return parsed;
  const style = parsed.value;
  const unknown = rejectUnknown(style, CELL_STYLE_KEYS);
  if (unknown) return unknown;
  if (style["backgroundColor"] !== undefined &&
      (typeof style["backgroundColor"] !== "string" || !HEX_COLOR.test(style["backgroundColor"]))) {
    return fail("backgroundColor", 'must be a hex color string (e.g. "#rrggbb")');
  }
  if (style["verticalAlign"] !== undefined &&
      (typeof style["verticalAlign"] !== "string" || !VERTICAL_ALIGNMENTS.has(style["verticalAlign"]))) {
    return fail("verticalAlign", 'must be "top", "middle", or "bottom"');
  }
  if (style["padding"] !== undefined) {
    const error = boundedNumber(style["padding"], "padding", CELL_PADDING_MIN, CELL_PADDING_MAX);
    if (error) return error;
  }
  return { ok: true, value: style as T };
}
