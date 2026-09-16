/**
 * D299 Phase 2 — bounded history-intent extractor.
 *
 * Identifies a small v1 set of past-context request shapes and derives a
 * conservative FTS search query. Does NOT decide which bot to wake.
 */

export type HistoryIntentShape =
  | "who-talking-about"
  | "what-decide-about"
  | "where-discussing";

export interface HistoryIntentMatch {
  shape: HistoryIntentShape;
  /** Conservative room-history FTS query derived from the topic fragment. */
  searchQuery: string;
  /** Short metadata for logs/tests. */
  reason: string;
}

interface IntentPattern {
  shape: HistoryIntentShape;
  reason: string;
  re: RegExp;
}

const PATTERNS: IntentPattern[] = [
  {
    shape: "who-talking-about",
    reason: "who was I talking with/to about X",
    re: /^who\s+(?:(?:the\s+)?(?:fuck|hell|heck)\s+|exactly\s+)?was\s+i\s+talking\s+(?:with|to)\s+about\s+(.+)$/i,
  },
  {
    shape: "what-decide-about",
    reason: "what did we decide about X",
    re: /^what\s+did\s+we\s+decide\s+about\s+(.+)$/i,
  },
  {
    shape: "where-discussing",
    reason: "where were we discussing X",
    re: /^where\s+were\s+we\s+discussing\s+(.+)$/i,
  },
];

function conservativeSearchQuery(topicRaw: string): string | null {
  let topic = topicRaw.trim().replace(/[?!.,;:]+$/, "").trim();
  if (!topic) return null;
  topic = topic
    .replace(/\b(?:damn|fucking|fuckin|freaking|bloody)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  topic = topic.replace(/^(?:the|a|an)\s+/i, "").trim();
  topic = topic.replace(/\s+(?:earlier)$/i, "").trim();
  if (topic.length < 2) return null;
  return topic;
}

/**
 * Returns a bounded history-intent match when `content` matches a v1
 * past-context request shape; otherwise `null`. Never inspects the room roster.
 */
export function extractHistoryIntent(content: string): HistoryIntentMatch | null {
  const trimmed = content.trim().replace(/^hey\s*,?\s+/i, "");
  if (!trimmed) return null;

  for (const { shape, reason, re } of PATTERNS) {
    const match = re.exec(trimmed);
    if (!match) continue;
    const searchQuery = conservativeSearchQuery(match[1]!);
    if (!searchQuery) continue;
    return { shape, searchQuery, reason };
  }
  return null;
}
