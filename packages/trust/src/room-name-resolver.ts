import {
  findAuthorizedRoomNameCandidates,
  userHasCapability,
  type AuthorizedRoomNameCandidateRow,
} from "./queries";

/** The resolver never puts more than this many Room choices in a tool result. */
export const MAX_ROOM_NAME_CANDIDATES = 5;

/** One extra row lets the resolver prove a candidate class is not unique. */
export const ROOM_NAME_QUERY_CANDIDATE_LIMIT = MAX_ROOM_NAME_CANDIDATES + 1;

/**
 * A deliberately modest typo threshold. Fuzzy matches are *only* offered as
 * choices; this value can never cause an automatic destination selection.
 */
export const ROOM_NAME_FUZZY_THRESHOLD = 0.78;

/** Public, human-readable facts for a Room-selection UI or tool result. */
export type RoomNameCandidate = Readonly<{
  label: string;
  kind: AuthorizedRoomNameCandidateRow["kind"];
  memberCount: number;
  choiceToken: string;
}>;

/**
 * Trusted-only destination facts. Do not serialize this object into model
 * input, approval copy, or a client response: identifiers stay in the trust
 * and checkpoint lanes after name resolution.
 */
export type ResolvedRoomDestination = Readonly<{
  roomId: string;
  namespaceId: string;
  label: string;
  kind: AuthorizedRoomNameCandidateRow["kind"];
  memberCount: number;
  /** Opaque, checkpoint-only proof of the canonical current Room audience. */
  audienceFingerprint: string;
}>;

export type RoomNameResolution =
  | Readonly<{ status: "resolved"; destination: ResolvedRoomDestination }>
  | Readonly<{ status: "needs_disambiguation"; candidates: readonly RoomNameCandidate[] }>
  | Readonly<{ status: "not_found" }>
  | Readonly<{ status: "forbidden" }>
  | Readonly<{ status: "invalid_query" }>
  /**
   * A weak or duplicate name must not be selected without a server-owned
   * token codec. This is intentionally a configuration outcome, not a
   * best-effort fallback to a Room id or rank.
   */
  | Readonly<{ status: "choice_token_codec_required" }>;

/**
 * Server-owned opaque-token seam. The trust package deliberately does not
 * source a secret or mint cryptography itself: no suitable server signing
 * secret is currently owned here. A production codec must bind issuance and
 * verification to all three trusted values and must not expose `roomId` in
 * its token representation.
 */
export type RoomChoiceTokenCodec = Readonly<{
  issue(input: Readonly<{
    requesterUserId: string;
    normalizedQuery: string;
    roomId: string;
  }>): Promise<string> | string;
  verify(input: Readonly<{
    token: string;
    requesterUserId: string;
    normalizedQuery: string;
    candidateRoomIds: readonly string[];
  }>): Promise<string | null> | string | null;
}>;

export type AuthorizedRoomNameResolverDependencies = Readonly<{
  findAuthorizedRoomNameCandidates: typeof findAuthorizedRoomNameCandidates;
  userHasCapability: typeof userHasCapability;
  choiceTokenCodec?: RoomChoiceTokenCodec;
}>;

export type ResolveAuthorizedRoomNameInput = Readonly<{
  /** Authenticated Human user id; never model supplied. */
  requesterUserId: string;
  /** Authenticated Human actor id; listRoomsForActor verifies membership. */
  requesterActorId: string;
  /** Human/model language, never an opaque Room or Namespace identifier. */
  targetRoomName: string;
  /** A prior resolver result's opaque choice only; never a Room id. */
  roomChoiceToken?: string;
}>;

type RankedRoom = Readonly<{
  room: AuthorizedRoomNameCandidateRow;
  strength: "semantic_exact" | "prefix" | "token" | "fuzzy";
  score: number;
}>;

const DEFAULT_DEPENDENCIES: AuthorizedRoomNameResolverDependencies = {
  findAuthorizedRoomNameCandidates,
  userHasCapability,
};

/**
 * Normalizes display names for equality and token matching without producing
 * an identifier. Unicode compatibility normalization, case-folding, and
 * separator collapse make "Pub-Room" and " pub room " equivalent.
 */
export function normalizeRoomName(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    // PostgreSQL's Unicode lower() uses simple folding: dotted capital I
    // becomes plain i and final sigma becomes ordinary sigma. Canonicalize
    // those two JavaScript full-lowercase differences before matching the
    // database-generated Room search label.
    .replace(/\u0307/gu, "")
    .replace(/\u03c2/gu, "\u03c3")
    // PostgreSQL's UTF-8 `[:punct:]` class includes Unicode punctuation and
    // symbols (including emoji). Treat both as separators here as well.
    .replace(/[\s\p{P}\p{S}]+/gu, " ")
    .trim();
}

function tokens(value: string): string[] {
  return normalizeRoomName(value).split(" ").filter(Boolean);
}

function editDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  return previous[right.length] ?? Math.max(left.length, right.length);
}

function fuzzyScore(query: string, label: string): number {
  // Fuzzy matching is bounded in CPU as well as outcome. Long names can still
  // be found by exact/prefix/token matching, but never trigger fuzzy work.
  if (query.length < 3 || query.length > 128 || label.length > 128) return 0;
  return 1 - editDistance(query, label) / Math.max(query.length, label.length);
}

function rankRooms(rooms: readonly AuthorizedRoomNameCandidateRow[], query: string): RankedRoom[] {
  const queryNormalized = normalizeRoomName(query);
  const queryTokens = tokens(query);

  const ranked: RankedRoom[] = [];
  for (const room of rooms) {
    const labelNormalized = normalizeRoomName(room.label);
    const labelTokens = tokens(room.label);

    if (labelNormalized === queryNormalized) {
      // Case-only and separator/whitespace variants are one semantic-exact
      // class. Keeping them separate would let one spelling auto-select over
      // an equally valid normalized destination.
      ranked.push({ room, strength: "semantic_exact", score: 1 });
      continue;
    }
    if (labelNormalized.startsWith(queryNormalized)) {
      ranked.push({ room, strength: "prefix", score: queryNormalized.length / labelNormalized.length });
      continue;
    }
    if (queryTokens.length > 0 && queryTokens.every((queryToken) => labelTokens.some((labelToken) => labelToken.startsWith(queryToken)))) {
      ranked.push({ room, strength: "token", score: queryTokens.length / Math.max(labelTokens.length, 1) });
      continue;
    }
    const score = fuzzyScore(queryNormalized, labelNormalized);
    if (score >= ROOM_NAME_FUZZY_THRESHOLD) {
      ranked.push({ room, strength: "fuzzy", score });
    }
  }

  const strengthOrder: Record<RankedRoom["strength"], number> = {
    semantic_exact: 0,
    prefix: 1,
    token: 2,
    fuzzy: 3,
  };
  return ranked.sort((left, right) =>
    strengthOrder[left.strength] - strengthOrder[right.strength]
    || right.score - left.score
    || left.room.label.localeCompare(right.room.label, "en-US")
    || left.room.id.localeCompare(right.room.id),
  );
}

function destinationFor(room: AuthorizedRoomNameCandidateRow): ResolvedRoomDestination {
  return {
    roomId: room.id,
    namespaceId: room.namespaceId,
    label: room.label,
    kind: room.kind,
    memberCount: room.memberCount,
    audienceFingerprint: room.audienceFingerprint,
  };
}

/**
 * Resolves a display name only within the requester's current, top-level Room
 * membership and capability envelope. The candidate query joins canonical
 * membership to the Human actor owned by the authenticated requester, filters
 * archived/internal Rooms, and returns at most six rows. It uses the indexed,
 * generated normalized label for exact/prefix paths and a bounded trigram
 * candidate path for token/typo matching. The local Room model has no
 * federated Room origin, so this query never accepts a remote Room address.
 * Invisible and inaccessible names deliberately collapse to `not_found`.
 */
export async function resolveAuthorizedRoomName(
  input: ResolveAuthorizedRoomNameInput,
  dependencies: AuthorizedRoomNameResolverDependencies = DEFAULT_DEPENDENCIES,
): Promise<RoomNameResolution> {
  const requesterUserId = input.requesterUserId.trim();
  const requesterActorId = input.requesterActorId.trim();
  const normalizedQuery = normalizeRoomName(input.targetRoomName);
  if (!requesterUserId || !requesterActorId || !normalizedQuery || normalizedQuery.length > 128) {
    return { status: "invalid_query" };
  }

  // Capability denial happens before room lookup so it cannot become a Room
  // existence oracle for callers lacking manage_memories.
  if (!(await dependencies.userHasCapability(requesterUserId, "manage_memories"))) {
    return { status: "forbidden" };
  }

  const visibleRooms = await dependencies.findAuthorizedRoomNameCandidates({
    requesterUserId,
    requesterActorId,
    normalizedTargetRoomName: normalizedQuery,
    limit: ROOM_NAME_QUERY_CANDIDATE_LIMIT,
  });
  const ranked = rankRooms(visibleRooms, input.targetRoomName);
  if (ranked.length === 0) return { status: "not_found" };

  const selectable = ranked.slice(0, MAX_ROOM_NAME_CANDIDATES);
  if (input.roomChoiceToken) {
    const codec = dependencies.choiceTokenCodec;
    if (!codec) return { status: "choice_token_codec_required" };
    let chosenRoomId: string | null;
    try {
      chosenRoomId = await codec.verify({
        token: input.roomChoiceToken,
        requesterUserId,
        normalizedQuery,
        candidateRoomIds: selectable.map(({ room }) => room.id),
      });
    } catch {
      // Verification failures (including malformed/tampered values) must not
      // become a distinguishable Room-existence or signer-health oracle.
      return { status: "not_found" };
    }
    const selected = selectable.find(({ room }) => room.id === chosenRoomId);
    if (!selected) return { status: "not_found" };
    return { status: "resolved", destination: destinationFor(selected.room) };
  }

  const strongest = selectable[0]!;
  const strongestMatches = ranked.filter(({ strength }) => strength === strongest.strength);
  if (
    strongestMatches.length === 1
    && strongest.strength === "semantic_exact"
  ) {
    return { status: "resolved", destination: destinationFor(strongest.room) };
  }

  const codec = dependencies.choiceTokenCodec;
  if (!codec) return { status: "choice_token_codec_required" };
  let candidates: RoomNameCandidate[];
  try {
    candidates = await Promise.all(selectable.map(async ({ room }) => {
      const choiceToken = await codec.issue({ requesterUserId, normalizedQuery, roomId: room.id });
      if (!choiceToken.trim()) throw new Error("Room choice token codec returned an empty token");
      return {
        label: room.label,
        kind: room.kind,
        memberCount: room.memberCount,
        choiceToken,
      };
    }));
  } catch {
    // A selection list without verifiable tokens is not actionable and must
    // not invite a caller to substitute an identifier or rank themselves.
    return { status: "choice_token_codec_required" };
  }
  return { status: "needs_disambiguation", candidates };
}
