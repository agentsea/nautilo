/**
 * Human-readable messages for failed `/api/stt` responses (D105).
 * Keeps JSON parsing in one place for the speech hook and unit tests.
 */
export async function formatSttHttpError(response: Response): Promise<string> {
  if (response.ok) return "";
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return `Transcription failed (HTTP ${response.status}).`;
  }
  const o = body as { error?: unknown; detail?: unknown };
  const err =
    typeof o.error === "string" && o.error.trim().length > 0
      ? o.error.trim()
      : `Transcription failed (HTTP ${response.status}).`;
  const detail =
    typeof o.detail === "string" && o.detail.trim().length > 0 ? ` ${o.detail.trim()}` : "";
  return err + detail;
}
