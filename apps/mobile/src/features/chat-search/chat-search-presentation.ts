/**
 * Decode exactly one server HTML-escaping pass for display in native Text.
 * Ampersand is deliberately last so double-encoded input is not recursively
 * decoded into markup-like text.
 */
export function decodeChatSearchSnippet(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}
