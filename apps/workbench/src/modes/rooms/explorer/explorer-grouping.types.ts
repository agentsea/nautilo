import type { AvatarRef, RoomKind } from "@nautilo/types";

export type ExplorerSectionKind =
  | "people"
  | "agents"
  | "my-agents"
  | "other-agents"
  | "groups"
  | "public"
  | "recent"
  | "agent-to-agent";

/**
 * Discriminator for nested explorer rows. The render layer (Subagent B) maps
 * each kind to indentation, expand/collapse affordances, and click targets.
 */
export type ExplorerRowKind =
  /** Top-level human entity under People. */
  | "entity-human"
  /** Top-level agent entity under My agents / Other agents. */
  | "entity-agent"
  /** L2 — the viewer's 1:1 human DM with this person. */
  | "direct-room"
  /** L2 — the viewer's 1:1 private room with this agent. */
  | "private-room"
  /** L2 — collapsible "Threads N" container (children are thread rows). */
  | "threads"
  /** L3 — one subthread under an agent's primary room. */
  | "thread"
  /** Flat navigable room (Groups, Recent threads, Agent-to-agent). */
  | "room";

/**
 * One navigable row in the Relationship Explorer (pure data; no React).
 *
 * Nested hierarchy: entity rows carry optional `children`. Only expanded nodes
 * contribute to the flattened `visibleRows` list in the render layer.
 */
export interface ExplorerRow {
  /** Stable key for React, activation, and expand/collapse (`useExplorerExpanded`). */
  id: string;
  kind: ExplorerRowKind;
  /** Nesting depth: 0 = section entity / flat room, 1 = L2, 2 = L3. */
  depth: number;
  /** What the user sees: "Alex" | "Direct room" | "# household". */
  label: string;
  /** Federated handle when applicable: { local, server }. */
  handle?: { local: string; server: string | null };
  /**
   * Room to activate on click. Empty string on non-navigable container rows
   * (threads headers) — the render layer opens children instead.
   */
  roomId: string;
  /** D124 will populate this in Phase 6; Phase 3 leaves it null. */
  preview?: null;
  /**
   * Legacy indent hint — true only for `thread` rows. Prefer `depth` + `kind`
   * in new render code.
   */
  isSubthread: boolean;
  /** Nested sub-rows (Direct/Private and their Threads). */
  children?: ExplorerRow[];
  /** Rolled-up unread for entity rows; per-room unread on room/thread rows. */
  unreadCount?: number;
  /** M238 — important unread within `unreadCount`; never independently derived. */
  importantUnreadCount?: number;
  /** Last activity ms for sort (`recent` mode). */
  lastActivityAt?: number;
  /** True subthread total on `threads` container rows (not capped). */
  subthreadCount?: number;
  /** Agent entity rows — `agents.id` for My/Other taxonomy. */
  agentId?: string;
  /** Custom avatar identity for Agent entity rows. Generic shell stays null/absent. */
  agentAvatar?: AvatarRef | null;
  /** M124 / D189 — server room kind; drives the public-room marker when `"open"`. */
  roomKind?: RoomKind;
}

export interface ExplorerSection {
  kind: ExplorerSectionKind;
  title: string;
  defaultCollapsed: boolean;
  rows: ExplorerRow[];
}

export type ExplorerRosterMember = {
  actorId: string;
  kind: "user" | "agent";
  displayName: string;
  /** Present for user-kind members — `users.id` for room creation. */
  userId?: string;
  /** Present for agent-kind members — `agents.id` for ownedAgents matching. */
  agentId?: string;
  agentAvatar?: AvatarRef | null;
  handle?: { local: string; server: string | null };
};

export type ExplorerSortMode = "recent" | "alpha";
export type ExplorerSortDir = "asc" | "desc";

export interface ExplorerSortSettings {
  mode: ExplorerSortMode;
  dir: ExplorerSortDir;
}

export const DEFAULT_EXPLORER_SORT: ExplorerSortSettings = {
  mode: "recent",
  dir: "desc",
};
