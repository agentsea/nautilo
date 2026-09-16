export const DELIVERED_FORMAT_LIMITS = {
  markdownChars: 200_000,
  /**
   * General fallback ceiling for generated delivered-format bytes when
   * no per-format cap applies. Per-format ceilings below take
   * precedence; the fallback is a safety net for new formats before a
   * dedicated cap is added.
   */
  generatedBytes: 10 * 1024 * 1024,
  /**
   * R6 — per-format byte ceilings. The omnibus `officecli` tool
   * (Wave 4) routes each generation through the matching cap; the
   * generic `convert` tool still falls back to `generatedBytes`.
   */
  generatedBytesXlsx: 100 * 1024 * 1024,
  generatedBytesPptx: 200 * 1024 * 1024,
  generatedBytesDocx: 50 * 1024 * 1024,
} as const;

export function assertGeneratedSize(bytes: number): string | null {
  if (bytes > DELIVERED_FORMAT_LIMITS.generatedBytes) {
    return `generated file is too large (${bytes} bytes; cap ${DELIVERED_FORMAT_LIMITS.generatedBytes} bytes)`;
  }
  return null;
}

/**
 * R6 — post-generation byte re-check against the per-format ceiling. Picks
 * the xlsx/pptx/docx cap by extension; unknown extensions fall back to the
 * general `generatedBytes` ceiling. Returns an error string when over cap,
 * or null when within.
 */
export function assertGeneratedSizeForFormat(bytes: number, ext: string): string | null {
  const normalized = ext.toLowerCase().replace(/^\./, "");
  const cap =
    normalized === "xlsx"
      ? DELIVERED_FORMAT_LIMITS.generatedBytesXlsx
      : normalized === "pptx"
        ? DELIVERED_FORMAT_LIMITS.generatedBytesPptx
        : normalized === "docx"
          ? DELIVERED_FORMAT_LIMITS.generatedBytesDocx
          : DELIVERED_FORMAT_LIMITS.generatedBytes;
  if (bytes > cap) {
    return `generated ${normalized || "file"} is too large (${bytes} bytes; cap ${cap} bytes)`;
  }
  return null;
}
