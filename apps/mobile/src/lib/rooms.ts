// D369 Phase 5 — pure room-list helpers (no React, no I/O).
// Sort + categorize + display-name + relative-time formatting for the Chats
// list. Kept pure so a future Vitest suite can pin behavior without a host.
import type { RoomKind, RoomSummaryDto } from "@nautilo/types";

export type ConversationCatalogueKind = "person" | "genie" | "group" | "room";

/** Kinds shown in the Chats list. Subthreads / tasks / access containers are
 *  excluded — they surface elsewhere (or never, for `access`). */
export function isListableRoom(kind: RoomKind): boolean {
  return kind === "private" || kind === "group" || kind === "multi_agent" || kind === "open";
}

/**
 * Human-facing conversation category. Dispatch `kind` is deliberately not
 * enough: a private named Room and a private 1:1 chat share the same dispatch
 * machinery. New named Rooms carry `type="room"`; participant chats are then
 * projected from the compact roster relative to the verified viewer.
 *
 * Missing or ambiguous legacy roster data fails into Group chat, never a
 * false 1:1 identity claim.
 */
export function conversationCatalogueKind(
  room: RoomSummaryDto,
  viewerUserId: string | null | undefined,
): ConversationCatalogueKind {
  if (room.kind === "open" || room.type === "room") return "room";
  if (!viewerUserId || room.roster?.length !== 2) return "group";

  const peers = room.roster.filter(
    (member) => !(member.kind === "user" && member.userId === viewerUserId),
  );
  if (peers.length !== 1) return "group";
  return peers[0]?.kind === "agent" ? "genie" : "person";
}

export function conversationCatalogueLabel(
  room: RoomSummaryDto,
  viewerUserId: string | null | undefined,
): string {
  const kind = conversationCatalogueKind(room, viewerUserId);
  if (kind === "person") return "Person";
  if (kind === "genie") return "Genie";
  if (kind === "group") return "Group chat";
  return room.kind === "open" ? "Public room" : "Private room";
}

/**
 * Human-facing Group Chats includes every multi-participant conversation and
 * every named channel. The underlying `room` catalogue kind remains useful
 * for row labels and icons, but it must not split channels away from the
 * Group Chats filter.
 */
export function isGroupChatConversation(
  room: RoomSummaryDto,
  viewerUserId: string | null | undefined,
): boolean {
  const kind = conversationCatalogueKind(room, viewerUserId);
  return kind === "group" || kind === "room";
}

/**
 * A strict one-Human/one-Agent chat is useful only to a Human who may invoke
 * Agents. Mixed and named Rooms remain visible because their Human history is
 * independently useful.
 */
export function isConversationVisibleToViewer(
  room: RoomSummaryDto,
  viewerUserId: string | null | undefined,
  canInvokeAgents: boolean,
): boolean {
  return canInvokeAgents || conversationCatalogueKind(room, viewerUserId) !== "genie";
}

/**
 * Sort rooms by recency — descending by `lastMessageAt ?? createdAt`. Rooms
 * with no `lastMessageAt` fall back to their creation time, so freshly created
 * 1:1s still appear on top until the first message lands. Stable on equal
 * timestamps (preserves server order).
 */
export function sortRoomsByRecency(rooms: readonly RoomSummaryDto[]): RoomSummaryDto[] {
  const copy = rooms.slice();
  copy.sort((a, b) => {
    const aTs = a.lastMessageAt ?? a.createdAt;
    const bTs = b.lastMessageAt ?? b.createdAt;
    if (aTs === bTs) return 0;
    return aTs < bTs ? 1 : -1; // descending
  });
  return copy;
}

/** Trimmed label with a fallback. Never empty in the UI. */
export function roomDisplayName(room: RoomSummaryDto): string {
  const trimmed = room.label?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "Untitled";
}

/**
 * Local catalogue search used by the persistent Chats-list field. The server
 * has already authorized and projected this compact roster, so searching it
 * neither fans out requests nor reveals detail-only participant data.
 */
export function conversationMatchesQuery(room: RoomSummaryDto, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;

  const searchable = [
    roomDisplayName(room),
    ...((room.roster ?? []).flatMap((member) => [member.displayName, member.federatedId ?? ""])),
  ]
    .join(" ")
    .toLocaleLowerCase();
  return searchable.includes(normalized);
}

/**
 * Short, locale-agnostic relative-time label for row timestamps
 * (e.g. "now", "5m", "3h", "2d", "1/15/26"). Mirrors the shape WhatsApp uses:
 * minutes for the first hour, hours for the first day, days for the first
 * week, then a compact M/D/YY date. Returns "" for unparseable input.
 *
 * Kept here (not in a date lib) so the Chats row has a deterministic,
 * unit-testable formatter with no extra dep.
 */
export function formatRelativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "";
  const diffMs = now.getTime() - ts;
  if (diffMs < 0) return "now";
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  // Same year → M/D; cross-year → M/D/YY.
  const d = new Date(ts);
  const month = d.getMonth() + 1;
  const date = d.getDate();
  const year = d.getFullYear();
  const nowYear = now.getFullYear();
  return nowYear === year ? `${month}/${date}` : `${month}/${date}/${String(year).slice(-2)}`;
}
