import type { ConductorContext } from "./types";

/**
 * D302 P3 (R4) — default addressivity threshold. Kept low to fail-open toward
 * the Floor Manager (wrong silence is worse than an extra cheap FM call).
 */
export const DEFAULT_ADDRESSIVITY_THRESHOLD = 0.15;

export interface ScoreAddressivityOptions {
  /** True when the sender has any active focus in the room (relational-recency). */
  hasRecentRelationship?: boolean;
  /** Override threshold (defaults to {@link DEFAULT_ADDRESSIVITY_THRESHOLD}). */
  threshold?: number;
}

export interface AddressivityResult {
  score: number;
  signals: Record<string, number>;
  bought: boolean;
}

const WH_QUESTION_START =
  /^\s*(what|where|when|who|whom|whose|why|how|which)\b/i;
const AUX_QUESTION_START =
  /^\s*(is|are|am|was|were|do|does|did|can|could|would|will|shall|should|have|has|had)\s+\S/i;
const SECOND_PERSON = /\b(you|your|yours)\b/i;
const THIRD_PERSON = /\b(they|them|their|he|him|his|she|her|hers)\b/i;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Interrogativity: seeks a response via `?` or a generic question shape. */
function signalInterrogativity(content: string): number {
  const trimmed = content.trim();
  if (!trimmed) return 0;
  if (/\?/.test(trimmed)) return 1;
  if (WH_QUESTION_START.test(trimmed)) return 0.75;
  if (AUX_QUESTION_START.test(trimmed)) return 0.65;
  return 0;
}

/** Directed-vs-ambient: 2nd-person / imperative-leaning vs third-person chatter. */
function signalDirected(content: string): number {
  const trimmed = content.trim();
  if (!trimmed) return 0;

  let score = 0.2;
  if (SECOND_PERSON.test(trimmed)) score += 0.55;
  if (THIRD_PERSON.test(trimmed)) score -= 0.35;
  return clamp01(score);
}

/** Relational-recency: prior focus with a bot raises plausibility of a reply. */
function signalRelationalRecency(hasRecentRelationship: boolean): number {
  return hasRecentRelationship ? 1 : 0;
}

/**
 * D302 P3 — non-LLM v1 addressivity scorer (R4). Generic signal categories
 * only; pluggable shape for future classifier/embedding backends.
 */
export function scoreAddressivity(
  ctx: ConductorContext,
  opts?: ScoreAddressivityOptions,
): AddressivityResult {
  const content = ctx.message.content;
  const threshold = opts?.threshold ?? DEFAULT_ADDRESSIVITY_THRESHOLD;
  const hasRecentRelationship = opts?.hasRecentRelationship ?? false;

  const interrogativity = signalInterrogativity(content);
  const directed = signalDirected(content);
  const relationalRecency = signalRelationalRecency(hasRecentRelationship);

  const score = clamp01(
    0.4 * interrogativity + 0.4 * directed + 0.2 * relationalRecency,
  );

  const signals: Record<string, number> = {
    interrogativity,
    directed,
    relationalRecency,
  };

  return {
    score,
    signals,
    bought: score >= threshold,
  };
}
