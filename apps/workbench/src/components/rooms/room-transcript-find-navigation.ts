import type { RoomMessageSearchHit } from "@nautilo/types";
import type { RoomMessageSearchControls } from "../../adapters/runtime-contexts";

export type FindDirection = "older" | "newer";

export interface RoomFindSelection {
  messageId: string;
  pageIndex: number;
  indexInPage: number;
  /** Absolute newest-first position, one-based. */
  ordinal: number;
}

export type RoomFindMoveResult =
  | { kind: "selected"; selection: RoomFindSelection }
  | { kind: "boundary"; direction: FindDirection }
  | { kind: "unavailable" };

/**
 * Server pages are stable newest-first cursor slots. A non-terminal page has
 * the configured page size, so this stays stable even when older cached pages
 * are evicted and refetched.
 */
export function roomFindOrdinal(pageIndex: number, indexInPage: number, pageSize = 20): number {
  return pageIndex * pageSize + indexInPage + 1;
}

export function roomFindTotalLabel(args: {
  selection: RoomFindSelection | null;
  search: Pick<RoomMessageSearchControls, "currentPageIndex" | "hits" | "hasMoreOlder">;
  pageSize?: number;
}): string | null {
  if (!args.selection) return null;
  const pageSize = args.pageSize ?? 20;
  if (args.search.hasMoreOlder) return `${(args.search.currentPageIndex + 1) * pageSize}+`;
  return String(args.search.currentPageIndex * pageSize + args.search.hits.length);
}

export function roomFindSelectionForHit(
  search: Pick<RoomMessageSearchControls, "pages">,
  messageId: string | null,
  pageSize = 20,
): RoomFindSelection | null {
  if (!messageId) return null;
  for (const { index: pageIndex, page } of search.pages) {
    const indexInPage = page.hits.findIndex((hit) => hit.messageId === messageId);
    if (indexInPage >= 0) {
      return { messageId, pageIndex, indexInPage, ordinal: roomFindOrdinal(pageIndex, indexInPage, pageSize) };
    }
  }
  return null;
}

function selectionAt(
  pageIndex: number,
  indexInPage: number,
  hit: RoomMessageSearchHit,
  pageSize: number,
): RoomFindSelection {
  return { messageId: hit.messageId, pageIndex, indexInPage, ordinal: roomFindOrdinal(pageIndex, indexInPage, pageSize) };
}

function pageAt(search: Pick<RoomMessageSearchControls, "pages">, index: number) {
  return search.pages.find((candidate) => candidate.index === index)?.page ?? null;
}

/**
 * Advances only because the user explicitly chose Next/Previous. It invokes
 * at most one boundary operation and never loops, prefetches, or counts.
 */
export async function moveRoomFindSelection(args: {
  selection: RoomFindSelection | null;
  direction: FindDirection;
  getSearch: () => RoomMessageSearchControls;
  pageSize?: number;
}): Promise<RoomFindMoveResult> {
  const pageSize = args.pageSize ?? 20;
  const search = args.getSearch();
  const current = args.selection ?? (() => {
    const hit = search.hits[0];
    return hit ? selectionAt(search.currentPageIndex, 0, hit, pageSize) : null;
  })();
  if (!current) return { kind: "unavailable" };
  const page = pageAt(search, current.pageIndex);
  if (!page) return { kind: "unavailable" };

  const delta = args.direction === "older" ? 1 : -1;
  const adjacent = current.indexInPage + delta;
  if (adjacent >= 0 && adjacent < page.hits.length) {
    return { kind: "selected", selection: selectionAt(current.pageIndex, adjacent, page.hits[adjacent], pageSize) };
  }

  if (args.direction === "newer" && current.pageIndex === 0) {
    return { kind: "boundary", direction: "newer" };
  }
  if (args.direction === "older" && !search.hasMoreOlder) {
    return { kind: "boundary", direction: "older" };
  }

  // The runtime controller changes its current page as part of this explicit
  // operation. Await exactly once, then select the edge hit from that page.
  const moved = args.direction === "older"
    ? await search.loadOlder()
    : await search.loadNewer();
  if (!moved) return { kind: "boundary", direction: args.direction };
  const after = args.getSearch();
  const hit = args.direction === "older" ? after.hits[0] : after.hits.at(-1);
  if (!hit) return { kind: "unavailable" };
  const indexInPage = args.direction === "older" ? 0 : after.hits.length - 1;
  return { kind: "selected", selection: selectionAt(after.currentPageIndex, indexInPage, hit, pageSize) };
}

export function reconcileRoomFindSelection(args: {
  previousGeneration: number;
  generation: number;
  query: string;
  selection: RoomFindSelection | null;
  search: Pick<RoomMessageSearchControls, "currentPageIndex" | "hits" | "pages">;
  pageSize?: number;
}): RoomFindSelection | null {
  const pageSize = args.pageSize ?? 20;
  if (args.generation !== args.previousGeneration || args.query.trim() === "" || args.search.hits.length === 0) {
    return null;
  }
  const retained = roomFindSelectionForHit(args.search, args.selection?.messageId ?? null, pageSize);
  if (retained) return retained;
  const first = args.search.hits[0];
  return first ? selectionAt(args.search.currentPageIndex, 0, first, pageSize) : null;
}

export function shouldOwnRoomFindShortcut(args: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  insideConversation: boolean;
  browserGuestFocused: boolean;
}): boolean {
  return args.key.toLowerCase() === "f" && (args.ctrlKey || args.metaKey) &&
    !args.altKey && !args.defaultPrevented && args.insideConversation && !args.browserGuestFocused;
}

export function roomFindKeyDirection(args: {
  key: string;
  shiftKey: boolean;
  snippetListOwnsFocus: boolean;
}): FindDirection | null {
  if (args.key === "Enter") return args.shiftKey ? "newer" : "older";
  if (!args.snippetListOwnsFocus) return null;
  if (args.key === "ArrowDown") return "older";
  if (args.key === "ArrowUp") return "newer";
  return null;
}

export function roomFindEscapeIntent(defaultPrevented: boolean): "close-and-restore-focus" | null {
  return defaultPrevented ? null : "close-and-restore-focus";
}

export function captureRoomFindFocusRestoreTarget(
  activeElement: Element | null,
  conversationRoot: Element | null,
): HTMLElement | null {
  return typeof HTMLElement !== "undefined" && activeElement instanceof HTMLElement && conversationRoot?.contains(activeElement)
    ? activeElement
    : null;
}
