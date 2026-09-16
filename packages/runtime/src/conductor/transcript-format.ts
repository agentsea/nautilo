/**
 * M135 — shared labelled-transcript line formatting. Used by BOTH the P6
 * composite context block (server wake path) and the P5 Floor Manager prompt
 * so the two never drift.
 *
 * Hardening contract: a line is display name + `@handle` + ISO-8601 UTC time
 * ONLY. NEVER emit raw actor/agent/message/room/focus IDs into these lines —
 * they may be fed to the Floor Manager LLM.
 */
export interface TranscriptLineInput {
  /** Author display name (human name or agent display name). */
  displayName: string;
  /** Author `@`-handle WITHOUT the leading `@`. */
  handle: string;
  /** Message timestamp. Rendered as ISO-8601 UTC (`…Z`). */
  ts: Date;
  /** Message text. */
  content: string;
  /** M121 — optional count-only reaction snapshot. Omit `×1`. */
  reactions?: { emoji: string; count: number }[];
}

/** ISO-8601 UTC, second precision (`2026-06-01T13:02:11Z`). */
export function isoUtc(ts: Date): string {
  return `${ts.toISOString().slice(0, 19)}Z`;
}

function formatReactionSuffix(
  reactions: { emoji: string; count: number }[] | undefined,
): string {
  if (!reactions || reactions.length === 0) return "";
  const parts = reactions
    .filter((r) => r.count > 0)
    .map((r) => (r.count > 1 ? `${r.emoji}×${r.count}` : r.emoji));
  if (parts.length === 0) return "";
  return `  ·reactions: ${parts.join(" ")}`;
}

/** `[2026-06-01T13:02:11Z] Alex (@alex): what's blocking deploy?` */
export function formatTranscriptLine(line: TranscriptLineInput): string {
  const text = line.content.replace(/\s+/g, " ").trim();
  return `[${isoUtc(line.ts)}] ${line.displayName} (@${line.handle}): ${text}${formatReactionSuffix(line.reactions)}`;
}

export function formatTranscriptLines(lines: TranscriptLineInput[]): string {
  return lines.map(formatTranscriptLine).join("\n");
}
