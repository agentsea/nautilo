import type { RoomMemberView } from "./types";

/** Normalize a roster name token for case-insensitive direct-address comparison. */
export function normDirectAddressName(name: string): string {
  return name.replace(/^@+/, "").trim().toLowerCase();
}

export interface DirectAddressMatch {
  actorId: string;
  handle: string;
  /** Roster field that matched (`handle` or `displayName`). */
  matchedAs: "handle" | "displayName";
  /** The roster name string that matched at the leading position. */
  matchedName: string;
}

interface RosterNameEntry {
  actorId: string;
  handle: string;
  name: string;
  matchedAs: "handle" | "displayName";
}

/**
 * D421 Phase 6.2.1 — typed roster-name evidence classification.
 *
 * Distinguishes three outcomes for deterministic routing + history-owner
 * conflict suppression. Exact token boundaries and roster identity only; no
 * fuzzy/phonetic matching, and no generic "any name anywhere wakes" rule.
 */
export type RosterNameEvidenceKind =
  | "unique_addressee"
  | "ambiguous_addressee"
  | "reference_only";

export interface RosterNameEvidence {
  kind: RosterNameEvidenceKind;
  /** Actor ids named as addressees (1 for unique, 2+ for ambiguous, 0 for reference_only). */
  addresseeActorIds: string[];
  /**
   * Actor ids whose roster name appears anywhere in the message (exact token
   * boundary). Used to suppress a conflicting history-owner shortcut. This is
   * NOT a wake signal — non-leading/meta mentions are reference-only.
   */
  referencedActorIds: string[];
}

/**
 * D421 Phase 6.2.1 — roster-derived direct-address extractor.
 *
 * Accepted forms (exact token boundaries, roster identity only — no
 * fuzzy/phonetic matching):
 *   - Leading vocative: `Name, ...`, `Name ...` (name + whitespace + content),
 *     `hey Name, ...` (comma required after the name; bare `hey ...` is not
 *     evidence).
 *   - Discourse-prefixed: a clause-initial discourse marker (`and`, `or`,
 *     `so`, `but`, `now`, `then`, `well`) followed by the name, e.g.
 *     `And Jeannie are you around?`, `and Jeannie, what about you?`.
 *   - Presence question: a clause-initial (optionally discourse-marked)
 *     copula (`is`/`are`) + name + presence word (`here`/`around`/`available`/
 *     `present`/`there`/`online`), e.g. `is Jeannie here?`, `now is Jeannie
 *     here?`.
 *   - Compound vocative: `Name1 and Name2, ...` / `Name1, Name2, ...`.
 *
 * Mid-sentence incidental references are rejected. All matching is against
 * the supplied `candidates` roster (caller pre-filters mute/deaf/observe).
 */
export function findDirectAddressMatches(
  content: string,
  candidates: RoomMemberView[],
): DirectAddressMatch[] {
  return matchAddresseeForms(content, buildRosterNameEntries(candidates, "agent"));
}

/**
 * D302 R13 — same leading-vocative shapes as `findDirectAddressMatches`, but
 * matched against the room's HUMAN members. Used for advanced-mode
 * human-vocative suppression ("Casey, are you around?" → the conductor stays
 * silent; humans answer humans). Reuses the identical tokenization/delimiter
 * core so the two detectors cannot drift. Callers should exclude the sender.
 *
 * D421 Phase 6.2: human-vocative detection intentionally stays on the
 * LEADING-vocative shape only. The natural named-address extensions
 * (discourse-prefixed, presence-question) are agent-addressee signals; a
 * human named mid-clause ("is Casey here?") should NOT suppress an agent
 * wake, because that is a question ABOUT a human, not a message TO a human.
 */
export function findHumanVocativeMatches(
  content: string,
  humans: RoomMemberView[],
): DirectAddressMatch[] {
  return matchLeadingVocativeOnly(content, buildRosterNameEntries(humans, "user"));
}

/**
 * D421 Phase 6.2.1 — loose roster-name reference evidence anywhere in the
 * message (exact token boundary). This is NOT a deterministic wake signal
 * (non-leading names can be quoted/meta). It is only strong enough to prevent
 * room-history ownership from overriding a visibly named assistant. Used by
 * the Conductor to classify `reference_only` evidence and to suppress
 * conflicting history-owner shortcuts.
 */
export interface AssistantNameReference {
  actorId: string;
  handle: string;
  matchedName: string;
  matchedAs: "handle" | "displayName";
}

function findAssistantNameReferences(
  content: string,
  candidates: RoomMemberView[],
): AssistantNameReference[] {
  const text = content.trim();
  if (!text) return [];
  const entries = buildRosterNameEntries(candidates, "agent");
  const seen = new Set<string>();
  const refs: AssistantNameReference[] = [];
  for (const entry of entries) {
    if (!containsNameToken(text, entry.name)) continue;
    const key = entry.actorId;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({
      actorId: entry.actorId,
      handle: entry.handle,
      matchedName: entry.name,
      matchedAs: entry.matchedAs,
    });
  }
  return refs;
}

/**
 * D421 Phase 6.2.1 — classify roster-name evidence into unique addressee /
 * ambiguous addressee / reference-only. A unique natural named-agent address
 * outranks a conflicting active focus and history owner (applied by the
 * Conductor before those returns). Reference-only never wakes; it only
 * suppresses a conflicting history-owner shortcut.
 */
export function classifyRosterNameEvidence(
  content: string,
  candidates: RoomMemberView[],
): RosterNameEvidence {
  const addressee = findDirectAddressMatches(content, candidates);
  const refs = findAssistantNameReferences(content, candidates);
  const addresseeIds = dedupeActorIds(addressee.map((m) => m.actorId));
  const referencedIds = dedupeActorIds(refs.map((r) => r.actorId));
  let kind: RosterNameEvidenceKind;
  if (addresseeIds.length === 1) kind = "unique_addressee";
  else if (addresseeIds.length >= 2) kind = "ambiguous_addressee";
  else kind = "reference_only";
  return {
    kind,
    addresseeActorIds: addresseeIds,
    referencedActorIds: referencedIds,
  };
}

function dedupeActorIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Clause-initial discourse markers that may precede a named addressee. */
const DISCOURSE_MARKERS = ["and", "or", "so", "but", "now", "then", "well"];
/** Copulas that introduce a presence question. */
const COPULAS = ["is", "are"];
/** Presence words that complete `is/are <Name> <word>`. */
const PRESENCE_WORDS = ["here", "around", "available", "present", "there", "online"];

/**
 * D421 Phase 6.2 — addressee-form detector. Two passes:
 *   1. Vocative scan at clause-initial positions (leading vocative, hey form,
 *      discourse-marker + name, compound `Name1 and Name2`). If any vocative
 *      addressee is found, it is the addressee set — a presence-question name
 *      that appears later is a TOPIC, not an addressee.
 *   2. Only when no vocative addressee was found: a presence-question scan
 *      (`copula <Name> <presence-word>`) anywhere in the message with a word
 *      boundary before the copula. This lets discourse-filler prefixes like
 *      `Good and now is Jeannie here?` resolve to Jeannie without enumerating
 *      every filler phrase.
 *
 * Exact token boundaries only; no fuzzy/phonetic matching.
 */
function matchAddresseeForms(
  content: string,
  entries: RosterNameEntry[],
): DirectAddressMatch[] {
  const trimmed = content.trim();
  if (!trimmed || entries.length === 0) return [];

  // Pass 1: vocative forms at clause-initial positions.
  const positions = clauseStartPositions(trimmed);
  const byActor = new Map<string, DirectAddressMatch>();
  for (const pos of positions) {
    collectVocativeAtPosition(trimmed, pos, entries, byActor);
  }
  if (byActor.size > 0) return [...byActor.values()];

  // Pass 2: presence-question anywhere (no vocative addressee was found).
  collectPresenceAnywhere(trimmed, entries, byActor);
  return [...byActor.values()];
}

/** Scan the whole message for `copula <Name> <presence-word>` (word boundary before copula). */
function collectPresenceAnywhere(
  text: string,
  entries: RosterNameEntry[],
  out: Map<string, DirectAddressMatch>,
): void {
  const copulaRe = new RegExp(
    `(^|[^a-z0-9_])(${COPULAS.join("|")})\\s+`,
    "ig",
  );
  let m: RegExpExecArray | null;
  while ((m = copulaRe.exec(text)) !== null) {
    const namePos = m.index + m[0].length;
    const presence = tryNamePresenceAt(text, namePos, entries);
    if (presence) {
      for (const match of presence) out.set(match.actorId, match);
    }
  }
}

/**
 * At one clause-initial position, try vocative forms (leading, hey,
 * discourse-marker + name, compound). Records any roster agent named.
 */
function collectVocativeAtPosition(
  text: string,
  pos: number,
  entries: RosterNameEntry[],
  out: Map<string, DirectAddressMatch>,
): void {
  let p = pos;
  const heyMatch = /^hey\s+/i.exec(text.slice(p));
  let isHeyForm = false;
  if (heyMatch) {
    isHeyForm = true;
    p += heyMatch[0].length;
  }
  if (!isHeyForm) {
    const markerMatch = new RegExp(`^(${DISCOURSE_MARKERS.join("|")})\\s+`, "i").exec(
      text.slice(p),
    );
    if (markerMatch) {
      p += markerMatch[0].length;
    }
  }
  const vocative = tryVocativeAt(text, p, entries, isHeyForm);
  if (vocative) {
    for (const m of vocative.matches) out.set(m.actorId, m);
    expandCompoundVocative(text, vocative.end, entries, out);
  }
}

/** Indexes of clause-initial positions: 0, and just after a clause boundary + whitespace. */
function clauseStartPositions(text: string): number[] {
  const positions: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "." || ch === "?" || ch === "!" || ch === "," || ch === "\n") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j += 1;
      if (j < text.length) positions.push(j);
    }
  }
  return positions;
}

/** Try a vocative name + delimiter at `pos`. Returns matches + end offset. */
function tryVocativeAt(
  text: string,
  pos: number,
  entries: RosterNameEntry[],
  isHeyForm: boolean,
): { matches: DirectAddressMatch[]; end: number } | null {
  const rest = text.slice(pos);
  const restLower = rest.toLowerCase();
  let bestName: string | null = null;
  for (const entry of entries) {
    const nameLower = entry.name.toLowerCase();
    if (restLower.startsWith(nameLower)) {
      bestName = entry.name;
      break;
    }
  }
  if (!bestName) return null;
  const afterName = rest.slice(bestName.length);
  if (!isValidDirectAddressDelimiter(afterName, isHeyForm)) return null;
  const normBest = normDirectAddressName(bestName);
  const matches: DirectAddressMatch[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (normDirectAddressName(entry.name) !== normBest) continue;
    if (seen.has(entry.actorId)) continue;
    seen.add(entry.actorId);
    matches.push({
      actorId: entry.actorId,
      handle: entry.handle,
      matchedAs: entry.matchedAs,
      matchedName: entry.name,
    });
  }
  // End offset = pos + name length (delimiter region starts here for compound
  // expansion).
  return { matches, end: pos + bestName.length };
}

/** Expand `Name1 and|or Name2, ...` after a detected vocative name. */
function expandCompoundVocative(
  text: string,
  afterFirstNamePos: number,
  entries: RosterNameEntry[],
  out: Map<string, DirectAddressMatch>,
): void {
  let p = afterFirstNamePos;
  // Skip the delimiter region (comma and/or whitespace).
  while (p < text.length && /[\s,]/.test(text[p]!)) p += 1;
  const compoundMatch = new RegExp(
    `^(${["and", "or"].join("|")})\\s+`,
    "i",
  ).exec(text.slice(p));
  if (!compoundMatch) return;
  p += compoundMatch[0].length;
  const second = tryVocativeAt(text, p, entries, false);
  if (!second) return;
  for (const m of second.matches) out.set(m.actorId, m);
  // Recurse for `Name1 and Name2 and Name3, ...`.
  expandCompoundVocative(text, second.end, entries, out);
}

/** Try `<Name> <presence-word>` at `pos` (copula already consumed by the caller). */
function tryNamePresenceAt(
  text: string,
  pos: number,
  entries: RosterNameEntry[],
): DirectAddressMatch[] | null {
  const rest = text.slice(pos);
  // Require the roster name immediately; do NOT strip articles — `is the
  // Jeannie here?` is not a presence question about the rostered agent.
  const restLower = rest.toLowerCase();
  let bestName: string | null = null;
  for (const entry of entries) {
    const nameLower = entry.name.toLowerCase();
    if (restLower.startsWith(nameLower)) {
      bestName = entry.name;
      break;
    }
  }
  if (!bestName) return null;
  let r = rest.slice(bestName.length);
  // Require whitespace then a presence word at a token boundary.
  const wsMatch = /^\s+/.exec(r);
  if (!wsMatch) return null;
  r = r.slice(wsMatch[0].length);
  const presenceMatch = new RegExp(
    `^(${PRESENCE_WORDS.join("|")})\\b`,
    "i",
  ).exec(r);
  if (!presenceMatch) return null;
  const normBest = normDirectAddressName(bestName);
  const matches: DirectAddressMatch[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (normDirectAddressName(entry.name) !== normBest) continue;
    if (seen.has(entry.actorId)) continue;
    seen.add(entry.actorId);
    matches.push({
      actorId: entry.actorId,
      handle: entry.handle,
      matchedAs: entry.matchedAs,
      matchedName: entry.name,
    });
  }
  return matches;
}

/** Shared core: leading-name + delimiter match over pre-built roster entries. */
function matchLeadingVocativeOnly(
  content: string,
  entries: RosterNameEntry[],
): DirectAddressMatch[] {
  const trimmed = content.trim();
  if (!trimmed || entries.length === 0) return [];

  let rest = trimmed;
  let isHeyForm = false;
  const heyPrefix = /^hey\s+/i.exec(rest);
  if (heyPrefix) {
    isHeyForm = true;
    rest = rest.slice(heyPrefix[0].length).trimStart();
  }
  if (!rest) return [];

  const restLower = rest.toLowerCase();
  let bestName: string | null = null;
  for (const entry of entries) {
    const nameLower = entry.name.toLowerCase();
    if (restLower.startsWith(nameLower)) {
      bestName = entry.name;
      break;
    }
  }
  if (!bestName) return [];

  const afterName = rest.slice(bestName.length);
  if (!isValidDirectAddressDelimiter(afterName, isHeyForm)) return [];

  const normBest = normDirectAddressName(bestName);
  const seen = new Set<string>();
  const matches: DirectAddressMatch[] = [];

  for (const entry of entries) {
    if (normDirectAddressName(entry.name) !== normBest) continue;
    if (seen.has(entry.actorId)) continue;
    seen.add(entry.actorId);
    matches.push({
      actorId: entry.actorId,
      handle: entry.handle,
      matchedAs: entry.matchedAs,
      matchedName: entry.name,
    });
  }

  return matches;
}

function buildRosterNameEntries(
  members: RoomMemberView[],
  kind: "agent" | "user",
): RosterNameEntry[] {
  const entries: RosterNameEntry[] = [];
  for (const m of members) {
    if (m.kind !== kind) continue;
    // Agents must have a handle (it IS their canonical name); humans match on
    // display name and only optionally on a handle.
    if (kind === "agent" && !m.handle) continue;
    if (m.handle) {
      entries.push({
        actorId: m.actorId,
        handle: m.handle,
        name: m.handle,
        matchedAs: "handle",
      });
    }
    if (m.displayName) {
      const normDisplay = normDirectAddressName(m.displayName);
      const normHandle = m.handle ? normDirectAddressName(m.handle) : "";
      if (normDisplay !== normHandle) {
        entries.push({
          actorId: m.actorId,
          handle: m.handle,
          name: m.displayName,
          matchedAs: "displayName",
        });
      }
    }
  }
  entries.sort((a, b) => b.name.length - a.name.length);
  return entries;
}

function isValidDirectAddressDelimiter(afterName: string, isHeyForm: boolean): boolean {
  if (isHeyForm) {
    return /^\s*,/.test(afterName);
  }
  return /^\s*,/.test(afterName) || /^\s+\S/.test(afterName);
}

/**
 * Exact token-boundary test: does `content` contain `name` as a whole token
 * (optionally preceded by `@`)? Used for loose reference evidence only —
 * never as a wake signal. No fuzzy/phonetic matching.
 */
function containsNameToken(content: string, name: string): boolean {
  const needle = name.trim();
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9_@])@?${escaped}($|[^a-z0-9_])`, "i").test(content);
}
