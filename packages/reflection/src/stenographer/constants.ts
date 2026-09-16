export const EVENT_COMPACTION_COUNT_TRIGGER = 200;
export const EVENT_COMPACTION_CHAR_TRIGGER = 40_000;
export const EVENT_COMPACTION_PROTECTED_TAIL = 50;
export const EVENT_STATEMENT_MAX_CHARS = 500;
export const EVENT_ROLLUP_MAX_CHARS = 12_000;
export const EVENT_COMPACTION_INPUT_MAX_CHARS = 100_000;
export const EVENT_SOURCE_MESSAGE_MAX = 16;
export const STENOGRAPHER_SOURCE_ROW_MAX_CHARS = 12_000;
export const STENOGRAPHER_INPUT_MAX_CHARS = 80_000;

export const EVIDENCE_ELISION_MARKER = "[... evidence elided ...]";

/** Count Unicode code points, matching PostgreSQL char_length for normal text. */
export function countCodePoints(value: string): number {
  return Array.from(value).length;
}

export function sliceCodePoints(
  value: string,
  start?: number,
  end?: number,
): string {
  return Array.from(value).slice(start, end).join("");
}

/** Bound a string by code points while retaining both ends. */
export function elideCodePoints(
  value: string,
  maxCodePoints: number,
  marker = EVIDENCE_ELISION_MARKER,
): string {
  if (!Number.isInteger(maxCodePoints) || maxCodePoints < 0) {
    throw new RangeError("maxCodePoints must be a non-negative integer");
  }
  if (countCodePoints(value) <= maxCodePoints) return value;
  if (maxCodePoints === 0) return "";

  const markerPoints = countCodePoints(marker);
  if (markerPoints >= maxCodePoints) {
    return sliceCodePoints(marker, 0, maxCodePoints);
  }

  const available = maxCodePoints - markerPoints;
  const headLength = Math.ceil(available / 2);
  const tailLength = Math.floor(available / 2);
  const points = Array.from(value);
  return [
    points.slice(0, headLength).join(""),
    marker,
    tailLength > 0 ? points.slice(-tailLength).join("") : "",
  ].join("");
}
