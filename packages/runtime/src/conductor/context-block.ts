import { formatTranscriptLine, isoUtc } from "./transcript-format";
import type { RoomHistoryHit } from "./history-search";

/**
 * M135 Phase 6 — composite labelled-transcript context block for a woken
 * GROUP-room bot. Prepended (as a synthetic leading block) to the human turn
 * fed to the executor; the per-bot LangGraph is NOT modified.
 *
 * Rules (spec):
 *   - Every line is display name + `@handle` + ISO-8601 UTC time. NEVER raw
 *     actor/agent/message IDs.
 *   - Bounded: window = last N messages; truncate OLDEST-first with a
 *     `… earlier messages elided …` marker.
 *   - Idempotent across re-wakes: a line whose formatted text already appears
 *     in `seenText` (the per-(room,bot) thread checkpoint contents) is
 *     skipped, so a re-wake never re-injects identical lines.
 *   - `deaf` filtering is a TODO(D190) no-op for now (D-A) — no deaf bot in
 *     M135, so the transcript is the full visible room history.
 */
export interface CompositeContextOptions {
  /** Recent room messages, oldest→newest (e.g. from `recentRoomMessages`). */
  messages: RoomHistoryHit[];
  /** Max lines retained in the block (oldest-first truncation beyond this). */
  maxLines: number;
  /**
   * Concatenated contents already present in the woken bot's thread
   * checkpoint. Lines whose formatted text is already present are dropped to
   * keep re-wakes idempotent. Empty string ⇒ nothing seen yet.
   */
  seenText?: string;
  /**
   * Display name of who addressed the bot this turn (for the
   * `--- you were addressed by: X ---` marker). Omitted ⇒ no marker.
   */
  addressedBy?: string;
}

const ELIDED_MARKER = "… earlier messages elided …";

export function assembleCompositeContextBlock(
  opts: CompositeContextOptions,
): string | null {
  const seen = opts.seenText ?? "";
  const maxLines = Math.max(1, Math.trunc(opts.maxLines));

  // Drop lines already injected into the bot's checkpoint (idempotency).
  const fresh: { line: string }[] = [];
  for (const m of opts.messages) {
    const line = formatTranscriptLine({
      displayName: m.authorDisplayName,
      handle: m.handle,
      ts: m.ts,
      content: m.snippet,
      ...(m.reactions ? { reactions: m.reactions } : {}),
    });
    if (seen.length > 0 && seen.includes(line)) continue;
    fresh.push({ line });
  }

  if (fresh.length === 0) return null;

  // Bound to the last `maxLines`, marking oldest-first truncation.
  let truncated = false;
  let kept = fresh;
  if (fresh.length > maxLines) {
    kept = fresh.slice(fresh.length - maxLines);
    truncated = true;
  }

  const lines: string[] = [];
  if (truncated) lines.push(ELIDED_MARKER);
  for (const f of kept) lines.push(f.line);
  if (opts.addressedBy) {
    lines.push(`--- you were addressed by: ${opts.addressedBy} ---`);
  }
  return lines.join("\n");
}

/**
 * M135 P6 — DM (exactly 1 human + 1 agent) server-time prefix for a human
 * turn. No speaker labels, no composite block — just time grounding.
 * `[2026-06-01T13:02:11Z] <text>`.
 */
export function dmTimePrefix(ts: Date, text: string): string {
  return `[${isoUtc(ts)}] ${text}`;
}
