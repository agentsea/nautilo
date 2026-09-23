/**
 * Navigation rail (D076 Chunk 4).
 *
 * 48px-wide icon column anchored to the left of the workbench shell.
 * Replaces the native-menu-only routing model ("Settings via Cmd+,")
 * with a visible always-reachable entry point for Home / Profile /
 * Open folder / Settings / Theme + an identity footer.
 *
 * Layout:
 *
 *   ┌─────┐
 *   │ 🏠  │ ← Home (route /)
 *   │ 📂  │ ← Open folder… (action)
 *   │ ⚙   │ ← Settings (route /settings)
 *   │     │
 *   │     │ ← flex-grow spacer
 *   │ ─── │
 *   │ O   │ ← Identity badge (owner-initial, title: "Owner")
 *   └─────┘
 *
 * Width is fixed (no drag-resize). Collapse via ⌘⇧0 or the native
 * View menu → Toggle Navigation Rail. Collapsed state lives in
 * usePanelSizes.
 *
 * Active state:
 *   - Home highlights when pathname === "/"
 *   - Settings highlights when pathname starts with "/settings"
 *   - Action items never highlight (they're controls).
 *
 * Rendering model:
 *   - Pure-data item config in rail-items.ts — tests can assert shape
 *     independently of JSX.
 *   - Action items dispatch via a strict `onAction(id)` prop so the
 *     shell owns all the action implementations in one place. Adding
 *     a new action is: (1) add the id to RailActionId union, (2)
 *     handle it in the shell's switch, (3) add an entry to rail-items.
 */

import { useCallback, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { ComponentType, SVGProps } from "react";
import type { ViewerRole } from "@nautilo/types";
import { ArrowDown, AudioLines, Check, LoaderCircle, Moon, Sun } from "lucide-react";
import { useCan } from "../../hooks/use-can";
import { useViewerAffordances } from "../../hooks/use-viewer-affordances";
import { useVoiceControls } from "../../adapters/runtime-contexts";
import type { DesktopUpdateStatus } from "../../lib/desktop";
import {
  PRIMARY_RAIL_ITEMS,
  DESTINATION_RAIL_ITEMS,
  UTILITY_RAIL_ITEMS,
  type RailActionId,
  type RailItem,
  type RailRouteItem,
} from "./rail-items";

export interface NavigationRailProps {
  /** D263 — withhold Skills rail entry for guests / unverified viewers. */
  showVerifiedOnlyRoutes?: boolean;
  /** Invoked when the user clicks an action rail item. */
  onAction: (id: RailActionId) => void;
  /** D373 — live PTY sessions hidden/running in the background. */
  terminalSessionCount?: number;
  /** Current identity label — shown in the footer badge. */
  identityLabel: string;
  /** Canonical role for the active Human->Agent relationship. */
  identityRole: ViewerRole;
  /**
   * When set, replaces the default footer identity badge (e.g. account
   * menu for verified users). Guests keep the muted dot badge.
   */
  accountFooter?: ReactNode;
  /**
   * D182 Phase 11.6.B — extra section rendered between primary
   * destinations and the flex-grow spacer. Used by the workbench
   * shell to mount `<RoomRail />` (Slack-style room navigation) per
   * `workbench-ui-vocabulary.md` §4.2 / §4.5. Kept as a generic
   * `ReactNode` slot so the rail component stays pure-presentation
   * and the shell decides composition.
   */
  extraSection?: ReactNode;
  /**
   * D365 — current theme. When provided together with `onToggleTheme`,
   * the rail renders a light/dark toggle above the voice controls
   * (single entry point; the old header button was removed).
   */
  theme?: "light" | "dark";
  /** D365 — invoked to flip the theme from the rail toggle. */
  onToggleTheme?: () => void;
  /** D103 — sanitized main-process updater state; omitted on web/older desktop builds. */
  updateStatus?: DesktopUpdateStatus;
  /** D103 — request main open its native update UI (no renderer-owned install action). */
  onOpenUpdate?: () => void;
  /**
   * D182 Phase 11.6.B — when set, overrides the route-based active
   * state of a primary route item. Used by the shell to enforce the
   * "one active rail destination at a time" contract when the
   * browser column is in a non-default mode (e.g. rooms-explorer
   * mode active should suppress Home's active highlight even though
   * `pathname === "/"`). The keys are route-item ids from
   * `rail-items.ts`; the boolean value is the explicit active state.
   * If absent or `undefined` for an id, the route-match default
   * applies.
   */
  activeRouteOverrides?: Record<string, boolean | undefined>;
  /**
   * D182 Phase 11.6.B — invoked BEFORE the default navigation when
   * the user clicks a route item. If the handler returns `false`,
   * navigation is suppressed (caller has fully handled the click).
   * If it returns `true` / `undefined`, navigation proceeds as
   * usual. Used by the shell to fold side effects (e.g. resetting
   * browserMode to "artifacts" when Home is clicked) into the same
   * gesture without forcing the rail to know about workbench-shell
   * state.
   */
  onRouteClickIntercept?: (id: string) => boolean | undefined;
}

export function NavigationRail(props: NavigationRailProps) {
  const {
    showVerifiedOnlyRoutes = false,
    onAction,
    terminalSessionCount = 0,
    identityLabel,
    identityRole,
    accountFooter,
    extraSection,
    theme,
    onToggleTheme,
    updateStatus,
    onOpenUpdate,
    activeRouteOverrides,
    onRouteClickIntercept,
  } = props;
  const location = useLocation();
  const navigate = useNavigate();
  const can = useCan();
  const voice = useVoiceControls();
  const { canToggleSessionSpeech } = useViewerAffordances();
  const visibleUpdateStatus =
    updateStatus && updateStatus.kind !== "hidden" ? updateStatus : null;
  const showUpdateIndicator =
    visibleUpdateStatus !== null && typeof onOpenUpdate === "function";

  const isActive = useCallback(
    (item: RailRouteItem): boolean => {
      const override = activeRouteOverrides?.[item.id];
      if (override !== undefined) return override;
      const match = item.matchRoute ?? item.route;
      if (match === "/") return location.pathname === "/";
      return location.pathname === match || location.pathname.startsWith(`${match}/`);
    },
    [location.pathname, activeRouteOverrides],
  );

  const renderItem = useCallback(
    (item: RailItem) => {
      if (
        item.requiresAnyCap &&
        !item.requiresAnyCap.some((cap) => can(cap))
      ) {
        return null;
      }
      if (item.kind === "route") {
        if (item.verifiedOnly && !showVerifiedOnlyRoutes) {
          return null;
        }
        const active = isActive(item);
        return (
          <RailButton
            key={item.id}
            Icon={item.Icon}
            label={item.label}
            title={item.title}
            active={active}
            onClick={() => {
              const proceed = onRouteClickIntercept?.(item.id) ?? true;
              if (proceed === false) return;
              void navigate(item.route);
            }}
          />
        );
      }
      const badge =
        item.id === "open-terminal" && terminalSessionCount > 0
          ? terminalSessionCount
          : undefined;
      const title =
        badge !== undefined
          ? `${item.title} — ${badge} terminal ${badge === 1 ? "session" : "sessions"} running`
          : item.title;
      return (
        <RailButton
          key={item.id}
          Icon={item.Icon}
          label={item.label}
          title={title}
          active={false}
          onClick={() => onAction(item.id)}
          badge={badge}
        />
      );
    },
    [
      can,
      isActive,
      navigate,
      onAction,
      onRouteClickIntercept,
      showVerifiedOnlyRoutes,
      terminalSessionCount,
    ],
  );

  return (
    <aside
      data-testid="navigation-rail"
      aria-label="Primary navigation"
      className="flex h-full w-full flex-col items-stretch border-r border-border bg-background-panel py-2"
    >
      <nav aria-label="Destinations" className="flex flex-col items-stretch gap-0.5">
        {PRIMARY_RAIL_ITEMS.map(renderItem)}
      </nav>

      {/* D182 Phase 11.6.B — caller-supplied extra section (e.g. RoomRail
          / Conversations). Rendered between the top destinations and the
          lower config/admin destinations so it reads: Home · Open folder ·
          Conversations · Settings · Server admin (D220 — operator wanted
          conversations above the gear + server icons). Returns null
          gracefully when extraSection is undefined or renders null. */}
      {extraSection}

      {/* Lower destinations — Settings + Server admin (gated). Below the
          conversations toggle per the operator's requested ordering. */}
      {DESTINATION_RAIL_ITEMS.length > 0 ? (
        <nav aria-label="Settings and admin" className="flex flex-col items-stretch gap-0.5">
          {DESTINATION_RAIL_ITEMS.map(renderItem)}
        </nav>
      ) : null}

      {/* Flex-grow spacer — pushes the footer to the bottom so the
          rail reads top-to-bottom as "destinations, then (future
          controls,) then you". */}
      <div className="flex-1" />

      {/* D365 — theme toggle. Moved here from the center-column header so
          appearance lives with the other bottom controls (above voice /
          sound). Single entry point; the header button was removed. */}
      {theme && onToggleTheme ? (
        <nav aria-label="Appearance" className="flex flex-col items-stretch gap-0.5">
          <RailButton
            Icon={theme === "dark" ? Moon : Sun}
            label={theme === "dark" ? "Dark mode" : "Light mode"}
            title={`Theme: ${theme} — switch to ${theme === "dark" ? "light" : "dark"}`}
            active={false}
            onClick={onToggleTheme}
            dataTestId="navigation-rail-theme-toggle"
          />
        </nav>
      ) : null}

      {canToggleSessionSpeech ? (
        <nav aria-label="Voice controls" className="flex flex-col items-stretch gap-0.5">
          <RailButton
            Icon={AudioLines}
            label={voice.enabled ? "Voice mode on" : "Voice mode off"}
            title={voice.enabled ? "Turn voice off" : "Turn voice on"}
            active={voice.enabled}
            onClick={voice.toggle}
            dataTestId="navigation-rail-voice-toggle"
            activeClassName="bg-[var(--success)]/20 text-[var(--success)]"
          />
          {voice.enabled && voice.playing ? (
            <button
              type="button"
              onClick={voice.stop}
              aria-label="Stop voice playback"
              title="Stop voice playback"
              className="mx-1.5 mt-0.5 rounded-md px-1 py-0.5 text-[9px] font-medium text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground"
            >
              Stop
            </button>
          ) : null}
        </nav>
      ) : null}

      {UTILITY_RAIL_ITEMS.length > 0 ? (
        <nav aria-label="Controls" className="flex flex-col items-stretch gap-0.5">
          {UTILITY_RAIL_ITEMS.map(renderItem)}
        </nav>
      ) : null}

      {/* D103 — a transient but unmistakable update cue immediately above the
          identity footer divider. Native main owns dialog/restart decisions. */}
      {visibleUpdateStatus && onOpenUpdate ? (
        <UpdateIndicator status={visibleUpdateStatus} onOpen={onOpenUpdate} />
      ) : null}

      <div
        data-testid="navigation-rail-footer-divider"
        className={`${showUpdateIndicator ? "mt-1" : "mt-2"} flex justify-center border-t border-border pt-2`}
      >
        {accountFooter ?? (
          <IdentityBadge label={identityLabel} role={identityRole} />
        )}
      </div>
    </aside>
  );
}

function UpdateIndicator(props: {
  status: Exclude<DesktopUpdateStatus, { kind: "hidden" }>;
  onOpen: () => void;
}) {
  const { status, onOpen } = props;
  const copy = updateIndicatorCopy(status);
  const installing = status.kind === "installing";
  const progress = status.kind === "downloading" ? Math.round(status.percent) : undefined;

  return (
    <div className="flex justify-center">
      <button
        type="button"
        onClick={installing ? undefined : onOpen}
        disabled={installing}
        aria-label={copy.label}
        title={copy.title}
        data-testid="navigation-rail-update-indicator"
        data-update-state={status.kind}
        data-update-progress={progress}
        className={[
          "relative mx-1.5 flex h-9 w-9 items-center justify-center rounded-full bg-sky-500 text-white shadow-[0_0_16px_rgba(14,165,233,0.5)] ring-2 ring-sky-300/70 transition hover:scale-105 hover:bg-sky-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-wait disabled:hover:scale-100",
          status.kind === "available" || status.kind === "ready"
            ? "motion-safe:animate-[pulse_1s_ease-in-out_3]"
            : "",
        ].join(" ")}
      >
        {status.kind === "downloading" ? (
          <svg aria-hidden="true" className="absolute inset-0 h-9 w-9 -rotate-90" viewBox="0 0 36 36">
            <circle cx="18" cy="18" r="15.5" fill="none" stroke="rgba(255,255,255,0.28)" strokeWidth="3" />
            <circle
              cx="18"
              cy="18"
              r="15.5"
              fill="none"
              stroke="white"
              strokeWidth="3"
              strokeLinecap="round"
              pathLength="100"
              strokeDasharray="100"
              strokeDashoffset={100 - status.percent}
            />
          </svg>
        ) : null}
        {status.kind === "ready" ? (
          <Check aria-hidden="true" className="relative h-4 w-4 stroke-[3]" />
        ) : status.kind === "installing" ? (
          <LoaderCircle aria-hidden="true" className="relative h-4 w-4 motion-safe:animate-spin" />
        ) : (
          <ArrowDown aria-hidden="true" className="relative h-4 w-4 stroke-[3]" />
        )}
      </button>
    </div>
  );
}

function updateIndicatorCopy(
  status: Exclude<DesktopUpdateStatus, { kind: "hidden" }>,
): { label: string; title: string } {
  switch (status.kind) {
    case "available":
      return {
        label: `Update ${status.version} is available`,
        title: `Update ${status.version} is available`,
      };
    case "downloading":
      return {
        label: `Downloading update ${status.version}: ${status.percent}% complete`,
        title: `Downloading update ${status.version}: ${status.percent}% complete`,
      };
    case "ready":
      return {
        label: `Update ${status.version} is ready to install`,
        title: `Update ${status.version} is ready to install`,
      };
    case "installing":
      return {
        label: `Installing update ${status.version}; Nautilo will restart`,
        title: `Installing update ${status.version}; Nautilo will restart automatically`,
      };
  }
}

/**
 * Shared rail button. Icon-only (label is hidden visually but exposed
 * to screen readers via aria-label + visible in tooltip via title).
 * Active state is a subtle background + accent left bar to signal
 * "current destination" without being loud.
 */
function RailButton(props: {
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  label: string;
  title: string;
  active: boolean;
  onClick: () => void;
  dataTestId?: string;
  activeClassName?: string;
  badge?: number;
}) {
  const { Icon, label, title, active, onClick, dataTestId, activeClassName, badge } =
    props;
  const badgeLabel = badge !== undefined && badge > 9 ? "9+" : String(badge ?? "");
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active ? "true" : "false"}
      title={title}
      data-testid={dataTestId}
      data-active={active || undefined}
      className={[
        "relative mx-1.5 flex h-9 items-center justify-center rounded-md transition-colors",
        active
          ? activeClassName ?? "bg-[var(--primary-muted)] text-foreground"
          : "text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground",
      ].join(" ")}
    >
      {active ? (
        <span
          aria-hidden="true"
          className="absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-r-sm bg-accent"
        />
      ) : null}
      <Icon aria-hidden="true" className="h-4 w-4" />
      {badge !== undefined && badge > 0 ? (
        <span
          aria-hidden="true"
          className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-zinc-900 px-1 text-[9px] font-bold leading-none text-white shadow-sm ring-1 ring-background-panel dark:bg-white dark:text-zinc-950"
        >
          {badgeLabel}
        </span>
      ) : null}
    </button>
  );
}

/**
 * Footer identity badge. Owner → green-tinted circle with the user's
 * initial; Guest → muted circle with a dot. Used when no custom
 * `accountFooter` is supplied; otherwise `WorkbenchAccountMenu` replaces
 * this for verified users.
 */
function IdentityBadge(props: { label: string; role: ViewerRole }) {
  const { label, role } = props;
  const initial = label.trim().charAt(0).toUpperCase() || "·";
  const verified = role !== "guest" && role !== "stranger";

  return (
    <div
      role="img"
      aria-label={verified ? `Signed in as ${label} (${role})` : `${role} — not verified`}
      title={verified ? `Signed in as ${label} (${role})` : `${role} — not verified`}
      className={[
        "flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold",
        roleToneClass(role),
      ].join(" ")}
    >
      {verified ? initial : "·"}
    </div>
  );
}

function roleToneClass(role: ViewerRole): string {
  switch (role) {
    case "owner":
    case "admin":
      return "bg-[var(--success)]/20 text-[var(--success)]";
    case "superuser":
      return "bg-primary/20 text-primary";
    case "member":
      return "bg-[var(--warning)]/20 text-[var(--warning)]";
    case "contributor":
    case "community":
      return "bg-primary/10 text-primary";
    case "guest":
    case "stranger":
    case "anonymous":
      return "bg-foreground-muted/20 text-foreground-muted";
  }
}
