export function clampSoulPreview(text: string | null, maxChars = 220): string | null {
  if (!text) return null;
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars).trimEnd()}…`;
}
