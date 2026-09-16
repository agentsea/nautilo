/**
 * Data-driven config for the navigation rail (D076 Chunk 4).
 *
 * Keeping items as data (not inline JSX in the rail component) means:
 *   - A future agent-tool that swaps the rail composition can do it
 *     by writing this array, not by re-authoring JSX.
 *   - Tests can assert the rail-items shape directly.
 *   - Route items gain active-state highlight via react-router's
 *     `useLocation`; action items opt out of active-state.
 *
 * Icon size + button affordance live in the rail component; this file
 * is pure configuration.
 */

import type { ComponentType, SVGProps } from "react";
import type { CapabilitySlug, UiTargetId } from "@nautilo/types";
import { Settings, ServerCog, ShieldCheck, Brain, SquareTerminal, SquareSlash, Blocks, CalendarClock } from "lucide-react";
import { SkillsRailIcon } from "./skills-rail-icon";
import { ADMIN_PAGE_CAPS } from "../../pages/admin/admin-sections";

/**
 * Route-based rail item. Clicking navigates; rail shows active state
 * when the current route starts with `matchRoute`.
 */
export interface RailRouteItem {
  kind: "route";
  id: string;
  label: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** When false, hidden for guest / unverified viewers (D263 Skills). */
  verifiedOnly?: boolean;
  /** react-router path to navigate to on click. */
  route: string;
  /**
   * Route prefix used for active-state matching. Defaults to `route`.
   * Set narrower if a deeper path should NOT highlight this item
   * (e.g. `/settings` should highlight for `/settings#profile` but
   * not for `/settings/no-such-subpage`).
   */
  matchRoute?: string;
  /** Accessible title + hover tooltip — shown on the rail item. */
  title: string;
  /** D513 semantic binding for a stable rendered destination. */
  catalogueTarget?: UiTargetId;
  /**
   * M129 — when set, the rail item renders only when the viewer holds at
   * least one of these capabilities (advisory UI gate; server enforces).
   */
  requiresAnyCap?: readonly CapabilitySlug[];
}

/**
 * Action-based rail item. Clicking runs the action; no active state.
 * Action id is a stable string the rail dispatcher uses to pick a
 * handler — avoids embedding closures in the items array (which would
 * force the config to be a hook rather than a module constant).
 */
export interface RailActionItem {
  kind: "action";
  id: RailActionId;
  label: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: string;
  /** Advisory visibility gate; the action target still enforces authority. */
  requiresAnyCap?: readonly CapabilitySlug[];
}

export type RailItem = RailRouteItem | RailActionItem;

/**
 * Stable action identifiers. The rail dispatcher in the workbench shell
 * maps these to real handlers. Centralising as a union keeps the
 * dispatcher switch exhaustive.
 *
 * Note: theme toggle was briefly in the rail (Chunk 4 first cut) but
 * removed — the header already has one and a second entry point is
 * visual noise. If we need a different control in the utility section
 * later, add the id here first.
 */
export type RailActionId = "open-folder" | "open-terminal";

/**
 * Top of the rail — entry destinations. Order matters: Home at the top
 * matches VS Code / Zed muscle memory.
 *
 * The shell's `extraSection` (the Rooms/conversations toggle) renders
 * immediately AFTER this group and BEFORE `DESTINATION_RAIL_ITEMS`, so
 * the rail reads top→bottom as: Home · Open folder · Conversations ·
 * Settings · Server admin.
 *
 * Notes:
 *   - Profile used to have its own rail item that deep-linked into
 *     `/settings#profile`. It was removed 2026-04-24 — it lit up
 *     simultaneously with Settings (both routes match `/settings`),
 *     which violates the "one active rail destination at a time"
 *     contract every comparable app follows (VSCode / Linear / Slack /
 *     Notion). Profile is still reachable via the Settings page's
 *     in-page section nav. **Account menu** (Settings + Sign out) now
 *     lives on the rail footer avatar and the header pill when verified
 *     (`WorkbenchAccountMenu`).
 *   - `Open folder` replaces the D075-era "Change Workspace" action
 *     per the D079 Phase 1 terminology freeze.
 */
export const PRIMARY_RAIL_ITEMS: readonly RailItem[] = [
  // D303: the rail's top destinations are now empty. "Home" was removed — it
  // was neither a clean destination (it competed with the panel toggles for the
  // highlight) nor an obvious action. The home/reset affordance moved to the
  // top-left NAUTILO wordmark (web-standard logo-as-home). The folder entry
  // likewise became the left-column panel toggles (Artifacts + Rooms), mounted
  // via the shell's extraSection. `RailActionId` machinery stays for future use.
];

/**
 * Lower destinations — the config/admin doors. Rendered AFTER the
 * `extraSection` (Conversations) so those scoped, less-frequent
 * destinations anchor below the primary day-to-day nav. Settings then
 * Server admin (gated). D220.
 */
export const DESTINATION_RAIL_ITEMS: readonly RailItem[] = [
  {
    kind: "route",
    id: "skills",
    label: "Skills",
    Icon: SkillsRailIcon,
    route: "/skills",
    matchRoute: "/skills",
    title: "Skills",
    catalogueTarget: "skills",
    verifiedOnly: true,
    requiresAnyCap: ["invoke_agents"],
  },
  {
    kind: "route",
    id: "commands",
    label: "Commands",
    Icon: SquareSlash,
    route: "/commands",
    matchRoute: "/commands",
    title: "Commands",
    catalogueTarget: "commands",
    verifiedOnly: true,
    requiresAnyCap: ["invoke_agents"],
  },
  {
    kind: "route",
    id: "approvals",
    label: "Approvals",
    Icon: ShieldCheck,
    route: "/approvals",
    matchRoute: "/approvals",
    title: "Approvals",
    catalogueTarget: "approvals",
    verifiedOnly: true,
    requiresAnyCap: ["invoke_agents"],
  },
  {
    kind: "route",
    id: "memory",
    label: "Memory",
    Icon: Brain,
    route: "/memory",
    matchRoute: "/memory",
    title: "Memory",
    catalogueTarget: "memory",
    verifiedOnly: true,
    requiresAnyCap: ["read_memories"],
  },
  {
    kind: "route",
    id: "scheduled-tasks",
    label: "Scheduled",
    Icon: CalendarClock,
    route: "/scheduled-tasks",
    matchRoute: "/scheduled-tasks",
    title: "Scheduled tasks",
    catalogueTarget: "scheduled_tasks",
    verifiedOnly: true,
    requiresAnyCap: ["invoke_agents"],
  },
  {
    kind: "route",
    id: "connections",
    label: "Connections",
    Icon: Blocks,
    route: "/connections",
    matchRoute: "/connections",
    title: "Connections — MCP servers + integrations",
    catalogueTarget: "connections",
    verifiedOnly: true,
    requiresAnyCap: ["invoke_agents"],
  },
  {
    kind: "route",
    id: "settings",
    label: "Settings",
    Icon: Settings,
    route: "/settings",
    matchRoute: "/settings",
    title: "Settings (⌘,)",
    catalogueTarget: "settings",
  },
  {
    kind: "route",
    id: "admin",
    label: "Server admin",
    Icon: ServerCog,
    route: "/admin",
    matchRoute: "/admin",
    title: "Server admin",
    requiresAnyCap: ADMIN_PAGE_CAPS,
    catalogueTarget: "admin",
  },
];

/**
 * Bottom of the rail — utility actions above the identity badge.
 * Empty today; retained as an extension point. Theme toggle was
 * evicted (header owns it) and mode switcher (D078) will live here
 * when Work / Chat / Rooms / Zen modes ship.
 */
export const UTILITY_RAIL_ITEMS: readonly RailItem[] = [
  // D373 / Stack 137 — open the terminal work surface. Desktop-only in
  // practice (the surface feature-detects the PTY bridge) and the shell's
  // openTerminal handler no-ops for unverified viewers.
  {
    kind: "action",
    id: "open-terminal",
    label: "Terminal",
    Icon: SquareTerminal,
    title: "Terminal",
    requiresAnyCap: ["use_workstation"],
  },
];
