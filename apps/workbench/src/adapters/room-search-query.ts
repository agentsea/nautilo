const MAX_QUERY_CHARS = 256;
const MAX_TERMS = 16;

export type NormalizedRoomSearchQuery =
  | { ok: true; query: string }
  | { ok: false; error: string };

/** Shared D430/D470 client-side bounds; the server remains authoritative. */
export function normalizeRoomSearchQuery(value: string): NormalizedRoomSearchQuery {
  const query = value.trim();
  if (query.length === 0) return { ok: false, error: "" };
  if (query.length > MAX_QUERY_CHARS) {
    return { ok: false, error: "Search queries must be at most 256 characters." };
  }
  const terms = query.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [];
  if (terms.length === 0) {
    return { ok: false, error: "Enter a search term containing letters or numbers." };
  }
  if (terms.length > MAX_TERMS) {
    return { ok: false, error: "Search queries may contain at most 16 terms." };
  }
  return { ok: true, query };
}
