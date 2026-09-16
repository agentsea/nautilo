/** Ordinary and protected Memory lists share the same stable product ordering.
 * The cursor contains only structural position, never Memory content. */
export function encodeMemoryListCursor(createdAt: Date, id: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ createdAt: createdAt.toISOString(), id }));
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function decodeMemoryListCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const raw = atob(cursor.replaceAll("-", "+").replaceAll("_", "/"));
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true })
      .decode(Uint8Array.from(raw, (character) => character.charCodeAt(0))));
    if (typeof parsed !== "object" || parsed === null
      || !("createdAt" in parsed) || typeof parsed.createdAt !== "string"
      || !("id" in parsed) || typeof parsed.id !== "string" || parsed.id.length === 0) return null;
    const createdAt = new Date(parsed.createdAt);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id: parsed.id };
  } catch { return null; }
}
