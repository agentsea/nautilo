/**
 * D278 P2 — pure, runtime-free model for the members panel (drawer + compact
 * column share this). Kept separate from the component so the logic is
 * unit-testable without a DOM, mirroring the §8.3 presence-strip model.
 *
 * Backend source of truth for focus semantics:
 * `specs/room-conductor-conversational-focus.md` (Conversational Focus is
 * private per-`(room, user)`, a *set* of bot foci, active/inactive).
 */

/**
 * D278 — a room is a **group room** (gets the always-on Members/Agent-Manager
 * panel, and is where the Conductor turns on) iff it has more than one human
 * OR more than one agent. A 1-human + 1-bot DM is NOT a group room. Matches
 * `specs/room-conductor-conversational-focus.md` (humanCount>1 OR agentCount>1).
 */
export function isGroupRoom(
  members: ReadonlyArray<{ readonly kind: "user" | "agent" }>,
): boolean {
  let humans = 0;
  let agents = 0;
  for (const m of members) {
    if (m.kind === "user") humans++;
    else agents++;
  }
  return humans > 1 || agents > 1;
}

/**
 * Selects the room-owned Members panel without displacing the richer §5.2
 * Agent soul panel in a direct 1-Human + 1-Agent chat.
 *
 * Human-only rooms still need the Members panel at every roster size so their
 * management entry stays available. Multi-Human or multi-Agent rooms retain
 * the group-room panel defined by D278.
 */
export function usesMembersManagerPanel(
  members: ReadonlyArray<{ readonly kind: "user" | "agent" }>,
): boolean {
  if (members.length === 0) return false;
  return members.every((member) => member.kind === "user") || isGroupRoom(members);
}

export type MemberTypeSuffix = "H" | "G";

export interface SuffixMember {
  readonly kind: "user" | "agent";
}

/**
 * Member type suffix — a binary derived straight from `member.kind`:
 * **H** = Human, **G** = Genie (Nautilo's product term for an agent). No
 * server field needed. We deliberately do NOT try to split "my Genie vs
 * someone else's agent vs a system bot" — that three-way distinction would
 * need ownership/role metadata and isn't worth the glance-value here.
 */
export function memberTypeSuffix(member: SuffixMember): MemberTypeSuffix {
  return member.kind === "user" ? "H" : "G";
}

/**
 * Focus-ring resolution (D278 §4.7.4 "Which avatar gets the ring").
 *
 * Render the *routing consequence*, not the raw held set: a bare message wakes
 * ≤1 bot, so exactly-one active focus → ring that bot; several → ambiguous (the
 * router will `ask_user`) so ring none + mark the held set; zero → none.
 */
export interface ActiveFocusLite {
  readonly botActorId: string;
  /** Epoch ms. */
  readonly expiresAt: number;
}

export type FocusRing =
  | { readonly kind: "none" }
  | { readonly kind: "single"; readonly botActorId: string }
  | { readonly kind: "ambiguous"; readonly botActorIds: readonly string[] };

export function resolveFocusRing(
  foci: readonly ActiveFocusLite[],
  nowMs: number,
): FocusRing {
  const active = foci.filter((f) => f.expiresAt > nowMs);
  if (active.length === 0) return { kind: "none" };
  if (active.length === 1) return { kind: "single", botActorId: active[0].botActorId };
  return { kind: "ambiguous", botActorIds: active.map((f) => f.botActorId) };
}

/** True iff this bot is the single routing target (gets the ring). */
export function isRingTarget(ring: FocusRing, botActorId: string): boolean {
  return ring.kind === "single" && ring.botActorId === botActorId;
}

/** True iff this bot is held in focus but not the sole target (subtle dot). */
export function isHeldFocus(ring: FocusRing, botActorId: string): boolean {
  return ring.kind === "ambiguous" && ring.botActorIds.includes(botActorId);
}

/**
 * Sort comparator for the members list (D278 §4.7.4): most-recently-talking
 * first, then admins, then alphabetical. `lastSpokeAtMs` is derived
 * client-side from the thread transcript (author `actorId` → latest
 * `createdAt`); members with no recent message sort last within their tier.
 */
export interface SortableMember {
  readonly actorId: string;
  readonly roomRole: "admin" | "member";
  readonly displayName: string;
}

function compareMembersByTalking(
  a: SortableMember,
  b: SortableMember,
  lastSpokeAtMs: ReadonlyMap<string, number>,
): number {
  const ta = lastSpokeAtMs.get(a.actorId);
  const tb = lastSpokeAtMs.get(b.actorId);
  if (ta !== tb) {
    if (ta === undefined) return 1;
    if (tb === undefined) return -1;
    if (ta !== tb) return tb - ta;
  }
  if (a.roomRole !== b.roomRole) return a.roomRole === "admin" ? -1 : 1;
  return a.displayName.localeCompare(b.displayName);
}

export function sortMembersByTalking<T extends SortableMember>(
  members: readonly T[],
  lastSpokeAtMs: ReadonlyMap<string, number>,
): T[] {
  return [...members].sort((a, b) => compareMembersByTalking(a, b, lastSpokeAtMs));
}
