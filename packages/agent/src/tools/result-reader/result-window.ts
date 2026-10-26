import { createHash } from "node:crypto";
import { z } from "zod";

const position = z.number().int().nonnegative().safe();
export const resultReferenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("call"), callId: z.string().min(1), sourceVersion: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.strictObject({ kind: z.literal("room"), roomId: z.string().min(1), messageId: position.positive(), sourceVersion: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.strictObject({ kind: z.literal("task"), taskId: z.string().min(1), runId: z.string().min(1), messageId: position.positive(), sourceVersion: z.string().regex(/^[a-f0-9]{64}$/) }),
]);
export type ResultReference = z.infer<typeof resultReferenceSchema>;
export const resultReadSchema = z.strictObject({
  reference: resultReferenceSchema,
  operation: z.enum(["inspect", "read", "search"]),
  path: z.array(z.string()).optional().describe("Exact JSON object keys or array indices, discovered with inspect. Omit to read the original text."),
  query: z.string().min(1).optional().describe("Literal, case-sensitive text to find. Search returns one match window at a time."),
  offset: position.optional().describe("UTF-8 byte offset for read/search, or field offset for inspect. Use match.startByte to read near a search hit. Do not combine with cursor."),
  cursor: z.string().optional(),
});
export type ResultReadArgs = z.infer<typeof resultReadSchema>;
export const resultVersion = (content: string): string => createHash("sha256").update(content).digest("hex");
const byteSize = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
const cursorSchema = z.strictObject({ selection: z.string(), offset: position });
const encode = (selection: string, offset: number): string => Buffer.from(JSON.stringify({ selection, offset })).toString("base64url");

export function resultReceipt(reference: ResultReference, content: string, outcome: "success" | "error" | "unknown" = "unknown") {
  return {
    version: "tool-result-v1", kind: "retained", outcome, bytes: Buffer.byteLength(content, "utf8"),
    reference, read: { reference, operation: "inspect" },
    disclosure: "The result is retained in the conversation but omitted from this model request. Use read_tool_result to inspect, select JSON fields, read pages or search literal text. Do not repeat the original operation. Unread output has not been reviewed; a page or search is not complete analysis.",
  };
}

function selectedValue(source: string, path: readonly string[]): unknown {
  let value: unknown = JSON.parse(source);
  for (const key of path) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) throw new Error("Selected JSON field is unavailable");
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function selectedText(source: string, path: readonly string[] | undefined): string {
  if (path === undefined) return source;
  const value = selectedValue(source, path);
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** A byte page may split a long record, but never a UTF-8 character. */
function utf8End(bytes: Buffer, proposed: number): number {
  let end = Math.min(bytes.length, proposed);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return end;
}

/** Pure presentation of an already authorized source. Cursors convey no authority. */
export function readResultWindow(source: string, args: ResultReadArgs, budget: number): string {
  if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error("No result response budget is available");
  if (resultVersion(source) !== args.reference.sourceVersion) throw new Error("Result changed; inspect a current reference instead of combining versions");
  if (args.operation === "search" && !args.query) throw new Error("Search requires literal query text");
  if (args.operation !== "search" && args.query !== undefined) throw new Error("Query is only valid for search");
  const text = selectedText(source, args.path);
  const selection = resultVersion(JSON.stringify([args.reference, args.operation, args.path ?? null, args.query ?? null]));
  let offset = args.offset ?? 0;
  if (args.cursor && args.offset !== undefined) throw new Error("Use cursor or offset, not both");
  if (args.cursor) {
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(args.cursor, "base64url").toString("utf8")));
    if (cursor.selection !== selection) throw new Error("Cursor belongs to another result or selection");
    offset = cursor.offset;
  }
  const common = { version: "tool-result-v1", reference: args.reference, path: args.path ?? null };
  if (args.operation === "inspect") {
    let value: unknown;
    if (args.path !== undefined) value = selectedValue(source, args.path);
    else try { value = JSON.parse(text); } catch { value = text; }
    const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    const keys = value !== null && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
    if (offset > keys.length) throw new Error("Inspection cursor is outside the selected object");
    const result = { ...common, kind: "inspection", type, bytes: Buffer.byteLength(text),
      ...(Array.isArray(value) ? { records: value.length } : {}), fields: [] as string[],
      complete: true, nextCursor: null as string | null,
      disclosure: "Structure only; no source values were reviewed. Read this selection or extend path with an exact field or array index. A selected object is serialized as JSON; selected strings return their text." };
    for (let i = offset; i < keys.length; i++) {
      const candidate = { ...result, fields: [...result.fields, keys[i]!], complete: i + 1 === keys.length,
        nextCursor: i + 1 === keys.length ? null : encode(selection, i + 1) };
      if (byteSize(candidate) > budget) break;
      Object.assign(result, candidate);
    }
    if (offset + result.fields.length < keys.length) {
      if (!result.fields.length) throw new Error("A field name does not fit; read the original text in pages instead");
      result.complete = false;
      result.nextCursor = encode(selection, offset + result.fields.length);
    }
    if (byteSize(result) > budget) throw new Error("Result framing does not fit the available budget");
    return JSON.stringify(result);
  }
  const bytes = Buffer.from(text, "utf8");
  if (offset > bytes.length || utf8End(bytes, offset) !== offset) throw new Error("Cursor is outside a UTF-8 boundary");
  let start = offset;
  let match: { startByte: number; endByte: number } | undefined;
  if (args.operation === "search") {
    const index = bytes.indexOf(Buffer.from(args.query!), offset);
    if (index < 0) {
      const result = { ...common, kind: "search", query: args.query, match: null, complete: true, nextCursor: null,
        disclosure: "No further literal match in this selection; this is not a semantic search or proof of complete analysis." };
      if (byteSize(result) > budget) throw new Error("Search framing does not fit the available budget");
      return JSON.stringify(result);
    }
    match = { startByte: index, endByte: index + Buffer.byteLength(args.query!) };
    // Reserve most of the page for the matching text and following context.
    start = utf8End(bytes, Math.max(0, index - Math.floor(budget / 4)));
  }
  const envelope = (end: number) => ({ ...common, kind: args.operation, totalBytes: bytes.length, startByte: start, endByte: end,
    text: bytes.subarray(start, end).toString("utf8"), ...(match ? { query: args.query, match } : {}),
    complete: args.operation === "read" && end === bytes.length,
    nextCursor: args.operation === "search" ? encode(selection, match!.endByte) : end < bytes.length ? encode(selection, end) : null,
    disclosure: "Exact UTF-8 window of this selection. A record or line may span pages. Use read for context around a match; search continuation advances to the next match. Only visible content has been reviewed." });
  let low = start, high = Math.min(bytes.length, start + budget);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (byteSize(envelope(utf8End(bytes, mid))) <= budget) low = mid;
    else high = mid - 1;
  }
  const end = utf8End(bytes, low);
  if (byteSize(envelope(end)) > budget || end <= start && start < bytes.length) throw new Error("No source character fits the available response budget");
  if (match && end <= match.startByte) throw new Error("Match framing does not fit; use a shorter query or read pages");
  return JSON.stringify(envelope(end));
}
