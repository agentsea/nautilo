/**
 * Source-shape tests care about tokens and ordering, not formatter line wraps.
 * Keep ordinary spaces intact while removing whitespace introduced immediately
 * inside delimiters and formatter-only trailing commas.
 */
export function normalizeStaticSource(source: string): string {
  return source
    .replace(/\s+/g, " ")
    .replace(/([([{]) /g, "$1")
    .replace(/ ([)\]}])/g, "$1")
    .replace(/\s*\.\s*/g, ".")
    .replace(/,([)\]}])/g, "$1");
}
