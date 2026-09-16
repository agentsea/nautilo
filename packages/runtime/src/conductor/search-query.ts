const SEARCH_META_WORDS = new Set([
  "about",
  "again",
  "before",
  "chat",
  "chats",
  "conversation",
  "conversations",
  "discuss",
  "discussed",
  "discussing",
  "discussion",
  "earlier",
  "history",
  "mention",
  "mentioned",
  "past",
  "previous",
  "previously",
  "remember",
  "said",
  "talk",
  "talked",
  "talking",
  "thing",
  "was",
  "were",
]);

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "be",
  "can",
  "did",
  "do",
  "does",
  "for",
  "from",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "that",
  "the",
  "this",
  "to",
  "we",
  "what",
  "when",
  "where",
  "which",
  "who",
  "with",
  "you",
]);

const EMPHASIS_WORDS = new Set([
  "bloody",
  "damn",
  "freaking",
  "fuck",
  "fuckin",
  "fucking",
  "hell",
  "heck",
  "shit",
]);

export interface NormalizedSearchQuery {
  /** Topic-ish terms, ordered as they appeared in the input. */
  terms: string[];
  /** Queries to try in order, from strictest to most relaxed. */
  ladder: string[];
}

function tokenize(raw: string): string[] {
  return raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function keepSearchTerm(term: string): boolean {
  if (term.length < 2) return false;
  if (STOP_WORDS.has(term)) return false;
  if (SEARCH_META_WORDS.has(term)) return false;
  if (EMPHASIS_WORDS.has(term)) return false;
  return true;
}

function uniqPreservingOrder(terms: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of terms) {
    if (seen.has(term)) continue;
    seen.add(term);
    out.push(term);
  }
  return out;
}

export function normalizeSearchTerms(raw: string): string[] {
  return uniqPreservingOrder(tokenize(raw).filter(keepSearchTerm));
}

export function buildSearchQueryLadder(terms: readonly string[]): string[] {
  const uniq = uniqPreservingOrder([...terms]);
  if (uniq.length === 0) return [];

  const ladder: string[] = [];
  const push = (candidate: readonly string[]) => {
    if (candidate.length === 0) return;
    const query = candidate.join(" ");
    if (!ladder.includes(query)) ladder.push(query);
  };

  push(uniq);

  // Drop trailing terms first: model-generated search meta words and vague
  // qualifiers tend to accumulate at the end of a query.
  for (let size = uniq.length - 1; size >= 2; size -= 1) {
    push(uniq.slice(0, size));
  }

  // Keep pair windows before single terms so meaningful phrases like
  // "stock crash" win over either word alone.
  for (let i = 0; i < uniq.length - 1; i += 1) {
    push(uniq.slice(i, i + 2));
  }

  for (const term of uniq) {
    push([term]);
  }

  return ladder;
}

export function normalizeSearchQuery(raw: string): NormalizedSearchQuery {
  const terms = normalizeSearchTerms(raw);
  return { terms, ladder: buildSearchQueryLadder(terms) };
}
