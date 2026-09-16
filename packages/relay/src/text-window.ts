import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
/** Lossless text pages. The page size bounds allocations, never the source. */
const TEXT_PAGE_BYTES = 64 * 1024;
// Bind the claimed byte/line positions to this reader session. A caller may
// select any line range, but may not forge citable line numbers for other bytes.
// After a reader restart, restart the range; source contents remain available.
const cursorKey = randomBytes(32);
function encodeCursor(value: readonly unknown[]): string {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${payload}.${createHmac("sha256", cursorKey).update(payload).digest("base64url")}`;
}
function decodeCursor(value: string): unknown {
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra !== undefined) throw new Error("invalid cursor");
  const expected = createHmac("sha256", cursorKey).update(payload).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("invalid cursor");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
}

export interface TextWindowSource {
  size: number;
  version: string;
  readRange(offset: number, length: number): Promise<Uint8Array>;
  currentVersion(): Promise<string>;
}

export interface TextWindow {
  command: "read";
  content: string;
  sourceVersion: string;
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
  partialStartLine: boolean;
  partialEndLine: boolean;
  nextCursor: string | null;
  nextLineOffset: number | null;
}

/** Cursor positions are data, never authority: callers reauthorize the path. */
export async function readTextWindow(
  source: TextWindowSource,
  input: { from: number; to: number; cursor?: string; signal?: AbortSignal },
): Promise<TextWindow> {
  let position = 0;
  let line = 1;
  let first = input.from;
  let last = input.to;
  let partialStartLine = false;
  if (input.cursor !== undefined) {
    let cursor: unknown;
    try { cursor = decodeCursor(input.cursor); }
    catch { throw new Error("Invalid or expired read cursor; restart the requested line range."); }
    if (!Array.isArray(cursor) || cursor.length !== 5 || typeof cursor[0] !== "string"
      || !Number.isSafeInteger(cursor[1]) || cursor[1] < 0 || cursor[1] > source.size
      || !Number.isSafeInteger(cursor[2]) || cursor[2] < 1
      || !Number.isSafeInteger(cursor[3]) || cursor[3] < cursor[2]
      || typeof cursor[4] !== "boolean") {
      throw new Error("Invalid or expired read cursor; restart the requested line range.");
    }
    if (cursor[0] !== source.version) throw new Error("Source changed; restart the requested line range. Do not combine versions.");
    position = cursor[1] as number;
    line = cursor[2] as number;
    last = cursor[3] as number;
    partialStartLine = cursor[4];
    first = line;
  }
  if (!Number.isSafeInteger(first) || first < 1 || !Number.isSafeInteger(last) || last < first) {
    throw new Error("Read requires positive safe integer line bounds with from <= to.");
  }
  let startByte = position;
  let startLine = line;
  let endLine = line;
  let selectedBytes = 0;
  let lastByte: number | undefined;
  const parts: Buffer[] = [];
  while (position < source.size && line <= last && selectedBytes < TEXT_PAGE_BYTES) {
    input.signal?.throwIfAborted();
    const bytes = Buffer.from(await source.readRange(position, Math.min(TEXT_PAGE_BYTES, source.size - position)));
    if (bytes.length === 0) throw new Error("Source changed during read; restart the requested range.");
    let partStart = -1;
    let i = 0;
    for (; i < bytes.length && line <= last && selectedBytes < TEXT_PAGE_BYTES; i += 1) {
      if (bytes[i] === 0) throw new Error("File appears binary; use binary/document read instead.");
      if (line >= first) {
        if (selectedBytes === 0) { startByte = position + i; startLine = line; }
        if (partStart < 0) partStart = i;
        selectedBytes += 1;
        endLine = line;
        lastByte = bytes[i];
      }
      if (bytes[i] === 10) line += 1;
    }
    if (partStart >= 0) parts.push(bytes.subarray(partStart, i));
    position += i;
  }
  let selected = Buffer.concat(parts, selectedBytes);
  // A byte page may end inside UTF-8. Return the incomplete character in the
  // next page instead of replacing it or losing any of its bytes.
  if (position < source.size && selected.length > 0 && lastByte !== 10) {
    let lead = selected.length - 1;
    while (lead > 0 && (selected[lead]! & 0xc0) === 0x80) lead -= 1;
    const byte = selected[lead]!;
    const width = byte < 0x80 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4;
    if (lead + width > selected.length) {
      position -= selected.length - lead;
      selected = selected.subarray(0, lead);
    }
  }
  const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(selected);
  if (await source.currentVersion() !== source.version) throw new Error("Source changed during read; restart the requested range. Do not combine versions.");
  input.signal?.throwIfAborted();
  const partialEndLine = selected.length > 0 && position < source.size && lastByte !== 10;
  const moreInRange = position < source.size && line <= last;
  return {
    command: "read", content, sourceVersion: source.version,
    startByte: selected.length ? startByte : position, endByte: position,
    startLine, endLine: selected.length ? endLine : 0,
    partialStartLine, partialEndLine,
    nextCursor: moreInRange
      ? encodeCursor([source.version, position, line, last, partialEndLine])
      : null,
    nextLineOffset: !moreInRange && position < source.size ? line : null,
  };
}
