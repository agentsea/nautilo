import { sql, type SQL } from "@nautilo/db";

// The existing Room search excerpt allowance, shared with overflow session search.
export const MESSAGE_SEARCH_SNIPPET_MAX = 280;

/** Overflow search is literal: no stemming or stopword removal. */
function literalMessageSearchPatterns(raw: string, mode: "whole" | "prefix"): string[] {
  const text = raw.trim().normalize("NFKC");
  const escape = (value: string): string => value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  if (mode === "prefix" && text.includes("/") && /^[\p{L}\p{N}._~/-]+$/u.test(text)) {
    return [escape(text)];
  }
  return (text.match(/[\p{L}\p{N}]+/gu) ?? []).map((term) =>
    `(^|[^[:alnum:]])${escape(term)}${mode === "whole" ? "($|[^[:alnum:]])" : ""}`);
}

/** The caller owns authorization, logical-message selection, ordering and paging. */
export function messageSearchPredicate(
  tsquery: SQL,
  raw: string,
  mode: "whole" | "prefix",
  ignoreCase = true,
): SQL {
  const patterns = literalMessageSearchPatterns(raw, mode);
  const literal = patterns.length === 0 ? sql`FALSE` : sql.join(patterns.map((pattern) =>
    ignoreCase ? sql`sm.content ~* ${pattern}` : sql`sm.content ~ ${pattern}`), sql` AND `);
  return sql`(sm.content_search @@ ${tsquery} OR (
    sm.content_search IS NULL AND sm.content IS NOT NULL AND ${literal}
  ))`;
}

/** Only overflow bodies are excerpted here; ordinary session search is unchanged. */
export function sessionSearchContent(query: string): SQL {
  const pattern = literalMessageSearchPatterns(query, "whole")[0];
  // One match-centered excerpt, explicitly partial. The stored source is never cut.
  return sql`CASE WHEN sm.content_search IS NULL THEN
    '[Partial excerpt; full message remains in conversation history] …' ||
    substring(sm.content FROM greatest(1,
      regexp_instr(sm.content, ${pattern ?? ""}, 1, 1, 0, 'i') - ${MESSAGE_SEARCH_SNIPPET_MAX / 2})
      FOR ${MESSAGE_SEARCH_SNIPPET_MAX}) || '…'
    ELSE sm.content END`;
}
