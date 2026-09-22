import { Suspense, useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { Outlet, useBlocker, useLocation, useNavigate } from "react-router-dom";
import { isFullWidthManagementRoute } from "./is-full-width-management-route";
import { useMiniAppRouteGuard } from "./use-mini-app-route-guard";
import { useBreakpoint } from "../hooks/use-breakpoint";
import { useTheme } from "../hooks/use-theme";
import { useAuth } from "../hooks/use-auth";
import { isAuthenticatedHumanViewer } from "../hooks/viewer-authentication";
import { useCan } from "../hooks/use-can";
import { useProfile } from "../hooks/use-profile";
import {
  SHELL_AGENT_NAME,
  type LiveDocumentVersion,
  type RoomMemberDto,
  type RoomSummaryRosterMemberDto,
} from "@nautilo/types";
import {
  MENU_TOGGLE_BROWSER_COLUMN_EVENT,
  MENU_TOGGLE_CONTEXT_PANEL_EVENT,
  MENU_TOGGLE_NAV_RAIL_EVENT,
} from "../hooks/use-desktop-menu";
import { useWebKeyboardShortcuts } from "../hooks/use-web-keyboard-shortcuts";
import { ContextPanel } from "../components/context-panel";
import { Conversation } from "../components/conversation";
import type { ReaderFocusedResourceTarget } from "../components/conversation/reader-focused-resource";
import { Toast } from "../components/toast";
import { ProlongedDisconnectToast } from "../components/prolonged-disconnect-toast";
import { ServerUpgradeNotice } from "../components/server-upgrade-notice";
import { ServerGuideCompanion } from "../components/server-guide-companion";
import { TerminalControlRequestProvider } from "../components/terminal-control-request-context";
import { TerminalControlConsentDialog } from "../components/terminal-control-consent-dialog";
import { BrowserColumn } from "../components/browser-column/browser-column";
import { KnownWebAppsPanel } from "../components/browser-column/known-web-apps-panel";
import { ConnectedWebsiteJourney } from "../pages/connections/connected-website-journey";
import { AppsPanel } from "../components/browser-column/apps-panel";
import { RelationshipExplorer } from "../modes/rooms/explorer/RelationshipExplorer";
import { ServersPanel } from "../modes/servers/ServersPanel";
import { useBrowserColumn } from "../components/browser-column/browser-column.context";
import { Footer } from "../components/footer/footer";
import { NavigationRail, RoomRail, ArtifactsRail, AppsRail, WebRail } from "../components/navigation-rail";
import { ServersRail } from "../components/navigation-rail/ServersRail";
import {
  artifactsIconState,
  roomsIconState,
  appsIconState,
  webIconState,
  serversIconState,
  artifactsToggleIntent,
  roomsToggleIntent,
  appsToggleIntent,
  webToggleIntent,
  serversToggleIntent,
  SERVERS_PANEL_USEFUL_WIDTH_PX,
  type LeftColumnState,
  type ToggleIntent,
} from "../components/navigation-rail/left-column-nav";
import { WorkbenchAccountMenu } from "../components/workbench-account-menu";
import {
  buildGridCols,
  RAIL_WIDTH_PX,
  SHELL_ROOT_CLASSES,
  SHELL_GRID_CLASSES,
} from "./chrome-shell.layout";
import { usePanelSizes } from "./use-panel-sizes";
import { PanelDivider } from "./panel-divider";
import { PanelEdgeStrip } from "./panel-edge-strip";
import { ContextPanelCollapseChevron } from "./context-panel-collapse-chevron";
import {
  AppDetailSurface,
  AppsOverviewSurface,
  AppSourceEditorSurface,
  BrowserResearchSurface,
  EditorSurface,
  MiniAppSurface,
  OfficeDocSurface,
  ReaderSurface,
  SaasAppSurface,
  TerminalSurface,
} from "./lazy-work-surfaces";
import type { ActiveMiniAppContext, MiniAppDraftSeed } from "../apps/app-bridge";
import { useInstalledApps } from "../apps/use-installed-apps";
import { useWorkspaceArtifactEventHub } from "../artifacts/workspace-artifacts-provider";
import {
  isWorkspaceArtifactCommittedMutation,
  workspaceArtifactEventClientMutationId,
  workspaceArtifactEventId,
  workspaceArtifactEventPath,
} from "../artifacts/workspace-document-mutation-events";
import { useBrowserDownloadToasts } from "../hooks/use-browser-download-toasts";
import { useDesktopUpdateStatus } from "../hooks/use-desktop-update-status";
import {
  clearActiveMiniApp,
  mapActiveMiniAppContext,
  publishActiveMiniApp,
  publishLiveMiniAppSession,
} from "../adapters/mini-app-context-ref";
import type { ReaderFile } from "../components/work-surface/reader-surface";
import { isLocalArtifactSaveMutation } from "../editors/local-artifact-save-mutations";
import { isLocalFsSaveSha } from "../editors/local-fs-save-shas";
import { sha256HexForText } from "../editors/editor-io";
import { canSwitchDesktopServerInProcess, desktopAPI, isDesktop, type DesktopBrowserResearchIntervention } from "../lib/desktop";
import { fsDirectoryChangeAffectsFile } from "../lib/fs-directory-changed";
import { shouldClearWorkSurfaceForAuth } from "./work-surface-auth";
import { setOpenFileDispatcher } from "../adapters/open-file-ref";
import { setOpenMiniAppDispatcher } from "../adapters/open-mini-app-ref";
import type { OpenMiniAppMode } from "../adapters/open-mini-app-ref";
import { setOpenAppSourceDispatcher } from "../adapters/open-app-source-ref";
import type { AppSourceTarget } from "../adapters/open-app-source-ref";
import { setOpenSaasAppDispatcher, type SaasAppTarget } from "../adapters/open-saas-app-ref";
import {
  setOpenTerminalDispatcher,
  requestOpenTerminal,
  type OpenTerminalTarget,
} from "../adapters/open-terminal-ref";
import {
  setOpenOfficeDocDispatcher,
  type OfficeDocTarget,
} from "../adapters/open-office-doc-ref";
import {
  setOpenAppsOverviewDispatcher,
  setOpenAppDetailDispatcher,
} from "../adapters/open-apps-surface-ref";
import { useRoomNavigation } from "../contexts/room-navigation-context";
import { stableViewerKeyForStorage } from "../rooms/room-navigation-storage";
import type { ArtifactDto } from "@nautilo/api-client/browser";
import type { OpenFileTarget } from "../components/browser-column/browser-column";
import {
  artifactOpenFileTarget,
  reloadArtifactOpenFileTarget,
  type ActiveArtifactTarget,
} from "../components/browser-column/open-file-target";
import { isOfficeDocPath } from "../viewers/file-kind";
import { useDrawer } from "../modes/rooms/thread-drawer/use-drawer";
import { canRestoreDrawerInRoom } from "../modes/rooms/thread-drawer/drawer-state";
import { ThreadDrawer } from "../modes/rooms/thread-drawer/ThreadDrawer";
import { DrawerShell } from "../modes/rooms/thread-drawer/components/DrawerShell";
import { NewConversationProvider } from "../modes/rooms/new-conversation/new-conversation-context";
import { useRoomMembers } from "../modes/rooms/shape/use-room-members";
import { RoomAuthorScope } from "../modes/rooms/shape/RoomAuthorScope";
import { usesMembersManagerPanel } from "../modes/rooms/shape/members-panel-model";
import { MembersManagerPanel } from "../modes/rooms/shape/MembersManagerPanel";
import { RoomManageBridge } from "../modes/rooms/shape/RoomManageBridge";
import { useMembersPanelView } from "../modes/rooms/shape/use-members-panel-view";
import { RoomFocusProvider } from "../modes/rooms/shape/room-focus-context";
import { MEMBERS_RAIL_WIDTH_PX } from "./chrome-shell.layout";
import { AppErrorBoundary } from "../components/app-error-boundary";
import { useWorkSurfaceEventTargets } from "./use-work-surface-event-target";
import { createGenieHandoffBridge } from "../lib/genie-handoff";
import type { MiniAppCloseReason } from "../apps/mini-app-lifecycle";
import { EventFeedPanel } from "../event-feed/EventFeedPanel";
import { EventFeedQuietControl } from "../event-feed/EventFeedQuietControl";
import { useEventFeed } from "../event-feed/event-feed-context";
import { EventFeedBell } from "./event-feed-bell";

type WorkSurfaceState =
  | { kind: "none" }
  | { kind: "file"; file: ReaderFile; mode: "read" | "edit" }
  | {
      kind: "app";
      appId: string;
      mode: OpenMiniAppMode;
      target?: OpenFileTarget;
      /** D342 Phase 2 — warm-up draft for a no-doc launch (pre-materialize). */
      draft?: MiniAppDraftSeed;
      sourceHash?: string;
    }
  | { kind: "saas-app"; appId: string; displayName: string; initialUrl: string; mode?: "app" | "browser" }
  | { kind: "browser-research"; intervention: DesktopBrowserResearchIntervention }
  // D362 — read-only office viewer (Collabora-backed) for a workspace artifact.
  | { kind: "office-doc"; artifactId: string; displayName: string; documentPath: string; roomId?: string }
  | { kind: "app-source"; appId: string; path: string }
  // D344 — full-width Apps surfaces: the all-apps overview/manager and a
  // per-app detail page.
  | { kind: "apps-overview" }
  | { kind: "app-detail"; appId: string }
  // D373 / Stack 137 — terminal (PTY) work surface. `sessionId` is set
  // after the first spawn so re-open reattaches the same main-process PTY.
  | { kind: "terminal"; sessionId?: string };

type PendingRouteTransition = {
  destinationKey: string;
  proceed: () => void;
  reset: () => void;
};

const TERMINAL_SESSION_COUNT_POLL_MS = 2000;

/**
 * Keep the shell's direct-human decision on the same immediate summary roster
 * that ActiveRoom hands to Conversation. Detail still replaces this seed in
 * `useRoomMembers`, whose cache and stale-response guard remain authoritative.
 */
function summaryRosterToMembers(
  roster: readonly RoomSummaryRosterMemberDto[] | undefined,
): RoomMemberDto[] {
  if (!roster?.length) return [];
  return roster.map((member) => ({
    actorId: member.actorId,
    kind: member.kind,
    displayName: member.displayName,
    roomRole: "member" as const,
    ...(member.userId ? { userId: member.userId } : {}),
    ...(member.agentId ? { agentId: member.agentId } : {}),
    ...(typeof member.handle === "string" && member.handle.length > 0
      ? { handle: member.handle }
      : {}),
  }));
}

/**
 * D182 Phase 11.6.B — browser column mode.
 *
 * "artifacts" (default) → `<BrowserColumn />` with its existing
 *   Artifacts / Files tabs.
 * "rooms" → `<RelationshipExplorer />` with grouped People / Agents /
 *   Groups / Recent / Agent-to-Agent sections (the same component
 *   D111 P3 shipped, but as a USER-TOGGLED MODE rather than a
 *   permanent hijack of verified users).
 *
 * Toggled by clicking the Rooms icon on the navigation rail.
 *
 * D342 — "apps" → `<AppsPanel />`, the dedicated installed-mini-apps panel
 *   (promoted out of the Artifacts column's old middle tab), toggled by the
 *   Apps rail icon. Distinct from D336's future "web" SaaS panel.
 */
type BrowserColumnMode = "artifacts" | "rooms" | "apps" | "web" | "servers";

const READER_CHAT_DEFAULT_WIDTH_PX = 380;
const workSurfaceFallback = (
  <div
    role="status"
    aria-live="polite"
    className="flex h-full items-center justify-center bg-background text-sm text-foreground-muted"
  >
    Loading workspace…
  </div>
);

/**
 * D185 — per-viewer storage key for the browser-column mode.
 *
 * Previously a flat `nautilo.workbench.browserMode.v1` key, which leaked one
 * user's mode to the next on a shared browser profile. We now namespace it by
 * the same stable viewer key the room-navigation store uses
 * (`stableViewerKeyForStorage`). Returns `null` for unverified/guest viewers →
 * persistence disabled, in-memory only this session (so a guest's mode never
 * persists or leaks). The old flat key is intentionally abandoned (a returning
 * user re-establishes their mode once; no migration code for a polish fix).
 */
const BROWSER_MODE_STORAGE_PREFIX = "nautilo.workbench.browserMode.v1";
function browserModeStorageKey(viewerKey: string | null): string | null {
  return viewerKey ? `${BROWSER_MODE_STORAGE_PREFIX}:${viewerKey}` : null;
}

/**
 * Workbench shell (D057 2a.1 / D077 chrome overhaul).
 *
 * Layout progression per research/workbench-ui-vocabulary.md §4.5:
 *
 *   Stage 1 (no workspace):            [1fr _ context]
 *   Stage 1 with workspace (desktop):  [browser _ 1fr _ context]   ← current
 *   Stage 2 (rail + workspace):        [rail _ browser _ 1fr _ context]  (D076)
 *
 * Column widths are CSS-var-driven (D077) so drag-resize updates grid
 * reflow without React re-renders. `buildGridCols()` owns the template
 * string; `usePanelSizes()` owns the widths + collapse flags; this
 * component wires them together.
 */
export function WorkbenchShell() {
  // One shell-owned bridge connects the active SaaS sidecar to the reader-rail
  // composer only. It is intentionally not global and cannot outlive this
  // Workbench instance.
  const genieHandoffBridgeRef = useRef<ReturnType<typeof createGenieHandoffBridge> | null>(null);
  if (!genieHandoffBridgeRef.current) {
    genieHandoffBridgeRef.current = createGenieHandoffBridge();
  }
  const genieHandoffBridge = genieHandoffBridgeRef.current;
  const bp = useBreakpoint();
  const { theme, setTheme } = useTheme();
  const auth = useAuth();
  const can = useCan();
  const authenticatedHuman = isAuthenticatedHumanViewer(auth.viewer);
  const canInvokeAgents = can("invoke_agents");
  const canWriteArtifacts = can("write_artifacts");
  // Server selection belongs to the Desktop client, independent of this
  // server's permissions to invoke agents or write artifacts.
  const canSelectDesktopServer = isDesktop && canSwitchDesktopServerInProcess();
  const { agent } = useProfile();
  const assistantName = agent?.name ?? SHELL_AGENT_NAME;
  const roomNav = useRoomNavigation();
  const activeRoomSummaryMembers = summaryRosterToMembers(roomNav.activeRoom?.roster);
  // Seed the roster from the active-room summary so panel selection is stable
  // while the detailed member request resolves.
  const {
    members: activeRoomMembers,
    conductorMode: activeRoomConductorMode,
  } = useRoomMembers(roomNav.activeRoomId, activeRoomSummaryMembers);
  // Human-only rooms and group rooms use the room-owned Members panel. An
  // exact 1-Human + 1-Agent chat keeps the richer §5.2 Agent soul panel.
  const roomUsesMembersPanel = usesMembersManagerPanel(activeRoomMembers);
  const membersView = useMembersPanelView(
    roomUsesMembersPanel ? roomNav.activeRoomId : null,
  );
  const browser = useBrowserColumn();
  const installedApps = useInstalledApps();
  const subscribeWorkspaceArtifactEvents = useWorkspaceArtifactEventHub();
  const panelSizes = usePanelSizes();
  const location = useLocation();
  const navigate = useNavigate();
  const officeEnabled = auth.viewer.features?.office.enabled === true;
  useBrowserDownloadToasts();
  const desktopUpdate = useDesktopUpdateStatus();
  const [workSurface, setWorkSurfaceState] = useState<WorkSurfaceState>({ kind: "none" });
  const [nativeQuitPrepared, setNativeQuitPrepared] = useState(false);
  const shellRootRef = useRef<HTMLDivElement>(null);
  const setNativeQuitInteractionLock = useCallback((locked: boolean): void => {
    if (locked) shellRootRef.current?.setAttribute("inert", "");
    else shellRootRef.current?.removeAttribute("inert");
    setNativeQuitPrepared(locked);
  }, []);
  const workSurfaceRef = useRef<WorkSurfaceState>(workSurface);
  const miniAppTransitionGuardRef = useRef<
    ((reason: MiniAppCloseReason) => Promise<boolean>) | null
  >(null);
  const [miniAppGuardRegistered, setMiniAppGuardRegistered] = useState(false);
  const transitionQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingWorkSurfaceTransitionRef = useRef<SetStateAction<WorkSurfaceState> | null>(null);
  const pendingRouteTransitionRef = useRef<PendingRouteTransition | null>(null);
  const shellMountedRef = useRef(true);
  useEffect(() => {
    shellMountedRef.current = true;
    return () => {
      shellMountedRef.current = false;
      const pendingRoute = pendingRouteTransitionRef.current;
      pendingRouteTransitionRef.current = null;
      pendingRoute?.reset();
    };
  }, []);
  useEffect(() => {
    workSurfaceRef.current = workSurface;
  }, [workSurface]);
  const setWorkSurface = useCallback((update: SetStateAction<WorkSurfaceState>): void => {
    const leavesApp = (current: Extract<WorkSurfaceState, { kind: "app" }>, next: WorkSurfaceState) =>
      next.kind !== "app" || next.appId !== current.appId || next.mode !== current.mode ||
        (next.target?.kind === "artifact" ? `artifact:${next.target.id}`
          : next.target?.kind === "fs" ? `fs:${next.target.path}` : "draft") !==
        (current.target?.kind === "artifact" ? `artifact:${current.target.id}`
          : current.target?.kind === "fs" ? `fs:${current.target.path}` : "draft");
    const immediateCurrent = workSurfaceRef.current;
    const immediateNext = typeof update === "function" ? update(immediateCurrent) : update;
    const immediateGuard = immediateCurrent.kind === "app" && leavesApp(immediateCurrent, immediateNext)
      ? miniAppTransitionGuardRef.current
      : null;
    if (!immediateGuard) {
      if (!Object.is(immediateCurrent, immediateNext)) {
        workSurfaceRef.current = immediateNext;
        setWorkSurfaceState(immediateNext);
      }
      return;
    }
    const run = async (): Promise<void> => {
      const current = workSurfaceRef.current;
      const next = typeof update === "function" ? update(current) : update;
      if (Object.is(current, next)) return;
      if (current.kind === "app") {
        if (leavesApp(current, next)) {
          const guard = miniAppTransitionGuardRef.current;
          if (guard && !(await guard(next.kind === "none" ? "close" : "replace"))) {
            pendingWorkSurfaceTransitionRef.current = update;
            return;
          }
        }
      }
      pendingWorkSurfaceTransitionRef.current = null;
      workSurfaceRef.current = next;
      setWorkSurfaceState(next);
    };
    transitionQueueRef.current = transitionQueueRef.current.then(run, run);
  }, []);
  const routeBlocker = useBlocker(({ currentLocation, nextLocation }) =>
    miniAppGuardRegistered && workSurfaceRef.current.kind === "app" &&
    currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (routeBlocker.state !== "blocked") return;
    const transition: PendingRouteTransition = {
      destinationKey: `${routeBlocker.location.key}:${routeBlocker.location.pathname}${routeBlocker.location.search}${routeBlocker.location.hash}`,
      proceed: routeBlocker.proceed,
      reset: routeBlocker.reset,
    };
    pendingRouteTransitionRef.current = transition;
    const run = async (): Promise<void> => {
      if (!shellMountedRef.current || pendingRouteTransitionRef.current !== transition) return;
      const guard = miniAppTransitionGuardRef.current;
      if (!guard) {
        pendingRouteTransitionRef.current = null;
        transition.proceed();
        return;
      }
      const ready = await guard("navigate");
      if (!shellMountedRef.current || pendingRouteTransitionRef.current !== transition) return;
      if (!ready) return;
      pendingRouteTransitionRef.current = null;
      transition.proceed();
    };
    transitionQueueRef.current = transitionQueueRef.current.then(run, run);
  }, [routeBlocker]);
  const miniAppBeforeLeaveRef = useRef<((leave: () => void, stay?: () => void) => void) | null>(null);
  const registerMiniAppBeforeLeave = useCallback(
    (guard: ((leave: () => void, stay?: () => void) => void) | null) => {
      miniAppBeforeLeaveRef.current = guard;
    },
    [],
  );
  const requestWorkSurfaceTransition = useCallback((transition: () => void, stay?: () => void) => {
    const guard = miniAppBeforeLeaveRef.current;
    if (guard) guard(transition, stay);
    else transition();
  }, []);
  // D373 — last live terminal session, so reopening the surface reattaches
  // instead of spawning a new (orphaned) PTY.
  const lastTerminalSessionIdRef = useRef<string | null>(null);
  const [terminalSessionCount, setTerminalSessionCount] = useState(0);
  const [terminalControlRequestSessionId, setTerminalControlRequestSessionId] =
    useState<string | null>(null);
  const [terminalControlConsentSessionId, setTerminalControlConsentSessionId] =
    useState<string | null>(null);
  // Desktop session activation is owned by main. Default false in Electron so
  // a preserved background renderer cannot issue privileged IPC before the
  // preload receives its initial lifecycle replay.
  const [desktopSessionActive, setDesktopSessionActive] = useState(() => !isDesktop);
  const [, setActiveMiniAppContext] = useState<ActiveMiniAppContext | null>(null);
  const readingFile =
    workSurface.kind === "file" && authenticatedHuman
      ? workSurface.file
      : null;
  const appWorkSurface =
    workSurface.kind === "app" && auth.viewer.isVerified ? workSurface : null;
  const appSourceWorkSurface =
    workSurface.kind === "app-source" && auth.viewer.isVerified ? workSurface : null;
  const saasAppWorkSurface =
    workSurface.kind === "saas-app" && auth.viewer.isVerified ? workSurface : null;
  const browserResearchWorkSurface =
    workSurface.kind === "browser-research" && auth.viewer.isVerified ? workSurface : null;
  const officeDocWorkSurface =
    workSurface.kind === "office-doc" && authenticatedHuman ? workSurface : null;
  // D344 — full-width Apps overview / detail pages own the main column.
  const appsOverviewWorkSurface =
    workSurface.kind === "apps-overview" && auth.viewer.isVerified ? workSurface : null;
  const appDetailWorkSurface =
    workSurface.kind === "app-detail" && auth.viewer.isVerified ? workSurface : null;
  const terminalWorkSurface =
    workSurface.kind === "terminal" && auth.viewer.isVerified ? workSurface : null;
  const activeArtifact: ActiveArtifactTarget | null =
    workSurface.kind === "file" && workSurface.file.kind === "artifact"
      ? workSurface.file
      : workSurface.kind === "app" && workSurface.target?.kind === "artifact"
        ? workSurface.target
        : workSurface.kind === "office-doc"
          ? { id: workSurface.artifactId, path: workSurface.documentPath }
          : null;
  const workSurfaceActive =
    readingFile !== null ||
    appWorkSurface !== null ||
    appSourceWorkSurface !== null ||
    saasAppWorkSurface !== null ||
    browserResearchWorkSurface !== null ||
    officeDocWorkSurface !== null ||
    appsOverviewWorkSurface !== null ||
    appDetailWorkSurface !== null ||
    terminalWorkSurface !== null;
  const workSurfaceEventFile =
    workSurface.kind === "file"
      ? workSurface.file
      : workSurface.kind === "app"
        ? workSurface.target
        : null;
  const readerFocusedResourceTarget: ReaderFocusedResourceTarget | undefined =
    activeArtifact
      ? {
          kind: "workspace-artifact",
          artifactInternalId: activeArtifact.id,
        }
      : workSurfaceEventFile?.kind === "fs"
        ? {
            kind: "local-file",
            path: workSurfaceEventFile.path,
            rootPath: workSurfaceEventFile.rootPath,
          }
        : undefined;
  const {
    artifact: artifactEventTarget,
    fs: fsEventTarget,
  } = useWorkSurfaceEventTargets(workSurfaceEventFile);
  const terminalControlRequestVisibleInSurface =
    terminalControlRequestSessionId !== null &&
    terminalWorkSurface !== null &&
    (terminalWorkSurface.sessionId ?? lastTerminalSessionIdRef.current) ===
      terminalControlRequestSessionId;

  useEffect(() => {
    if (!isDesktop) {
      setDesktopSessionActive(true);
      return;
    }
    const subscribe = desktopAPI?.activeSession?.onStateChange;
    if (typeof subscribe !== "function") {
      // Older single-renderer builds do not expose this lifecycle surface.
      setDesktopSessionActive(true);
      return;
    }
    setDesktopSessionActive(false);
    return subscribe(({ active }) => setDesktopSessionActive(active));
  }, []);

  useEffect(() => {
    const subscribe = desktopAPI?.workbench?.onPrepareQuit;
    if (typeof subscribe !== "function") return;
    const unsubscribe = subscribe(async (cancellation) => {
      const releasePreparedUi = () => setNativeQuitInteractionLock(false);
      const stopListeningForCancellation = cancellation.onCancelled(releasePreparedUi);
      const cancelledResult = () => ({ ready: false, errorMessage: "Quit was cancelled." });
      const guard = miniAppTransitionGuardRef.current;
      if (!guard) {
        if (cancellation.isCancelled()) {
          stopListeningForCancellation();
          return cancelledResult();
        }
        setNativeQuitInteractionLock(true);
        if (cancellation.isCancelled()) {
          stopListeningForCancellation();
          setNativeQuitInteractionLock(false);
          return cancelledResult();
        }
        return { ready: true };
      }
      const ready = await guard("quit");
      if (cancellation.isCancelled()) {
        stopListeningForCancellation();
        return cancelledResult();
      }
      if (ready) setNativeQuitInteractionLock(true);
      if (cancellation.isCancelled()) {
        stopListeningForCancellation();
        setNativeQuitInteractionLock(false);
        return cancelledResult();
      }
      if (!ready) stopListeningForCancellation();
      return ready
        ? { ready: true }
        : { ready: false, errorMessage: "This app could not save or preserve its draft exactly." };
    });
    return () => {
      unsubscribe();
      setNativeQuitInteractionLock(false);
    };
  }, [setNativeQuitInteractionLock]);

  const refreshTerminalSessionCount = useCallback(async () => {
    const api = desktopAPI?.terminal;
    if (!api || !auth.viewer.isVerified || !desktopSessionActive) {
      setTerminalSessionCount(0);
      setTerminalControlRequestSessionId(null);
      return;
    }
    try {
      const sessions = await api.list();
      setTerminalSessionCount(sessions.length);
      setTerminalControlRequestSessionId((current) => {
        if (current && sessions.some((s) => s.id === current && s.requested)) {
          return current;
        }
        return sessions.find((s) => s.requested)?.id ?? null;
      });
    } catch {
      setTerminalSessionCount(0);
    }
  }, [auth.viewer.isVerified, desktopSessionActive]);

  useEffect(() => {
    void refreshTerminalSessionCount();
    const timer = setInterval(
      () => void refreshTerminalSessionCount(),
      TERMINAL_SESSION_COUNT_POLL_MS,
    );
    return () => clearInterval(timer);
  }, [refreshTerminalSessionCount]);

  // Route-driven auto-hide of the context (Agent) panel.
  //
  // On the Settings page the main column is multi-cell (section nav +
  // scrollable content + key editor) and needs the full horizontal
  // breathing room. With the context panel visible, the API-key values
  // clip off the right edge (live-repro 2026-04-24). We force-hide the
  // panel while the user is on /settings and restore it automatically
  // when they leave — the user's explicit collapse preference
  // (`panelSizes.contextCollapsed`) is left UNTOUCHED so navigating
  // back to / brings the panel back exactly as they had it.
  //
  // We do NOT render the panel's edge-strip on /settings either — its
  // whole purpose is "click to expand", which would undo the auto-hide
  // while the user is still on a page that cannot accommodate the
  // extra column.
  // D220 — /admin (server admin) is the same kind of full-width management
  // surface as /settings: auto-hide BOTH the right context/Genie column and
  // the left browser column so the section-nav + body get the whole width.
  // D263/D296 — /skills (list + routed editor) is a full-width management
  // surface like /settings: it owns the center column, so auto-hide both the
  // right context panel AND the left rooms/artifacts explorer. (startsWith to
  // cover /skills/:name and /skills/new.)
  const fullWidthManagementRoute = isFullWidthManagementRoute(location.pathname);
  const miniAppRouteWaiting = useMiniAppRouteGuard(
    Boolean(appWorkSurface) && !miniAppGuardRegistered,
    requestWorkSurfaceTransition,
  );
  // D293 — reader state persists across management-route navigation, but the
  // management page must own the center column (Outlet) instead of ReaderSurface.
  const workSurfaceOwnsMain = workSurfaceActive && (!fullWidthManagementRoute || miniAppRouteWaiting);
  const contextAutoHiddenByRoute = fullWidthManagementRoute || !canInvokeAgents;
  const contextEffectivelyCollapsed =
    panelSizes.contextCollapsed || contextAutoHiddenByRoute;

  // D278 §4.7.4 — when an active room owns the right column, its tri-state ladder
  // (not the shared context-collapse flag) decides width + visibility. The
  // members panel is suppressed while reading a document (the right column is
  // the reader chat rail then) and on /settings + /admin (via
  // contextAutoHiddenByRoute).
  const membersPanelActive =
    Boolean(roomNav.activeRoomId) &&
    roomUsesMembersPanel &&
    !workSurfaceOwnsMain &&
    !contextAutoHiddenByRoute;
  const membersPanelRail = membersPanelActive && membersView.view === "rail";
  const membersPanelHidden = membersPanelActive && membersView.view === "hidden";
  // Unified "is the right column hidden" gate used for grid + aside + divider.
  const contextColumnHidden =
    membersPanelActive ? membersPanelHidden : contextEffectivelyCollapsed;

  // /settings, /admin, /approvals, and /skills are full-width management surfaces. Hide the
  // left browser column (artifacts OR the rooms explorer) on all of them so the
  // section-nav + body get the whole width — mirrors the right context-panel
  // auto-hide. (Live-review: the explorer previously lingered next to Settings
  // and Skills.) `panelSizes.browserCollapsed` (explicit pref) is untouched.
  const browserAutoHiddenByRoute = fullWidthManagementRoute;

  const drawer = useDrawer();
  const drawerOpen = drawer.current.kind !== "closed";
  const eventFeed = useEventFeed();
  const [eventsOpen, setEventsOpen] = useState(false);
  const eventFeedBellRef = useRef<HTMLButtonElement>(null);
  const closeEvents = useCallback(() => {
    if (!canRestoreDrawerInRoom(drawer.current, roomNav.activeRoomId)) {
      drawer.close();
    }
    setEventsOpen(false);
    queueMicrotask(() => eventFeedBellRef.current?.focus());
  }, [drawer, roomNav.activeRoomId]);
  const toggleEvents = useCallback(() => {
    if (eventsOpen) {
      closeEvents();
      return;
    }
    setEventsOpen(true);
    void eventFeed.refresh();
  }, [closeEvents, eventFeed, eventsOpen]);
  const trailingDrawerOpen = drawerOpen || eventsOpen;
  useEffect(() => {
    if (!authenticatedHuman && eventsOpen) setEventsOpen(false);
  }, [authenticatedHuman, eventsOpen]);

  // D182 Phase 11.6.B — browser column mode. Default to artifacts so
  // the user lands on Files / Artifacts on first sign-in (consistent
  // with the canonical workbench-ui-vocabulary.md §4.5 behavior). Rail
  // Rooms icon click toggles to "rooms" and back.
  //
  // D185 (Stack 24 P2) — persist the choice to localStorage so the
  // user's last toggle survives reload. Defaults to "artifacts" on
  // first load and on any read error (private mode, quota, malformed
  // value). Storage key is namespaced to avoid colliding with future
  // browser-column state.
  const browserModeViewerKey = stableViewerKeyForStorage(auth.viewer);
  const [browserMode, setBrowserMode] = useState<BrowserColumnMode>("artifacts");

  // D185 — load the signed-in viewer's stored mode when identity resolves, and
  // reset to the default whenever the viewer changes (sign-out, switch user) so
  // one user's choice never leaks to the next. Async by nature: auth resolves
  // after first paint, so a brief default-mode render before the stored value
  // loads is expected and harmless.
  useEffect(() => {
    const key = browserModeStorageKey(browserModeViewerKey);
    if (typeof window === "undefined" || !key) {
      setBrowserMode("artifacts");
      return;
    }
    try {
      const stored = window.localStorage.getItem(key);
      setBrowserMode(
        stored === "artifacts" ||
          stored === "rooms" ||
          stored === "apps" ||
          stored === "web" ||
          (stored === "servers" && canSelectDesktopServer)
          ? stored
          : "artifacts",
      );
    } catch {
      setBrowserMode("artifacts");
    }
  }, [browserModeViewerKey, canSelectDesktopServer]);

  useEffect(() => {
    const key = browserModeStorageKey(browserModeViewerKey);
    if (typeof window === "undefined" || !key) return;
    try {
      window.localStorage.setItem(key, browserMode);
    } catch {
      /* ignore quota / private mode */
    }
  }, [browserMode, browserModeViewerKey]);

  // M259 — a mode persisted while the viewer had broader authority must not
  // leave a newly restricted session with an empty browser column.
  useEffect(() => {
    const modeRequiresInvocation = browserMode === "web";
    const modeRequiresInvocationAndWrite = browserMode === "apps";
    if (
      (modeRequiresInvocation && !canInvokeAgents) ||
      (modeRequiresInvocationAndWrite &&
        (!canInvokeAgents || !canWriteArtifacts))
    ) {
      setBrowserMode("artifacts");
    }
  }, [browserMode, canInvokeAgents, canWriteArtifacts]);

  // Web-only keyboard shortcuts (⌘⇧B / ⌘⇧I). No-op on desktop where
  // native menu accelerators cover the same keystrokes.
  useWebKeyboardShortcuts();

  // Browser column mounts whenever we're at the desktop breakpoint.
  // Post-D079 Phase 1 the column is always reachable (even with no
  // current folder open) so the CurrentFolderHeader dropdown is
  // available for the user to open one. Previously the column was
  // gated on having a workspace set; with the main-process auto-
  // default removed, that gating would strand users with no entry
  // point. The Files tab's own empty state covers the no-folder case.
  //
  // Whether it's VISIBLE on top of that is `!browserCollapsed` from
  // panelSizes — usePanelSizes is the sole owner of the collapse flag
  // after D077 (was BrowserColumnContext in 2a.1, migrated so both
  // panels' geometry live in one hook).
  //
  // Keep `browser.currentFolderPath` referenced so the shell re-renders
  // when it transitions null↔set; even though browserVisible no longer
  // depends on it, downstream (e.g. grid-cols inputs with the rail)
  // may want to derive from it.
  void browser.currentFolderPath;
  const browserVisible = true;
  // Route auto-hide folds into the effective-collapsed flag so the grid
  // reclaims the column and nothing renders in it on /admin.
  const browserEffectivelyCollapsed =
    panelSizes.browserCollapsed || browserAutoHiddenByRoute;
  const showBrowserColumn =
    bp === "desktop" && browserVisible && !browserEffectivelyCollapsed;

  // D303 — single source of truth for the left-column rail toggles
  // (Artifacts + Rooms): 3-state icon + click intent via the pure
  // `left-column-nav` view-model. `panelEligible` = the route can host the
  // left column (not a full-width route); `browserCollapsed` = the explicit
  // user collapse (route auto-hide is captured by panelEligible instead).
  const leftColState: LeftColumnState = {
    panelEligible: !fullWidthManagementRoute,
    browserMode,
    browserCollapsed: panelSizes.browserCollapsed,
  };

  // D076 Chunk 4 — navigation rail. Desktop-only; collapsible via
  // ⌘⇧0. Default visible — the rail is the primary destination
  // entry point so it stays visible unless the user explicitly hides
  // it for focus work.
  const showRail = bp === "desktop" && !panelSizes.railCollapsed;

  // A persisted Servers mode must also recover at its useful width after launch;
  // the rail-click intent below covers only interactive mode changes.
  useEffect(() => {
    if (browserMode === "servers" && !browserEffectivelyCollapsed &&
      panelSizes.browserWidth < SERVERS_PANEL_USEFUL_WIDTH_PX) {
      panelSizes.setWidth("browser", SERVERS_PANEL_USEFUL_WIDTH_PX);
    }
  }, [browserEffectivelyCollapsed, browserMode, panelSizes]);

  const gridCols = buildGridCols({
    bp,
    railVisible: showRail,
    browserVisible,
    browserCollapsed: browserEffectivelyCollapsed,
    contextCollapsed: workSurfaceOwnsMain ? panelSizes.contextCollapsed : contextColumnHidden,
    // GH-674 — a transient drawer owns a real right-column track even when the
    // persisted context/sidebar preference is collapsed. buildGridCols also
    // prevents a room's 48px members rail from squeezing the drawer.
    drawerOpen: trailingDrawerOpen,
    // Group-room rail → a fixed 48px column (avatar-only); reading → the chat
    // rail default; otherwise the user's persisted context width.
    contextDefaultPx: workSurfaceOwnsMain
      ? READER_CHAT_DEFAULT_WIDTH_PX
      : membersPanelRail
        ? MEMBERS_RAIL_WIDTH_PX
        : undefined,
    contextFixedWidth: membersPanelRail ? true : undefined,
    readerChatSidecarLayout: workSurfaceOwnsMain,
  });

  // D076 Chunk 4 — dispatcher for rail action items. Keep the handlers
  // in the shell (not inside the rail) so the rail component stays
  // pure-presentation; all side effects flow through one place here.
  // D365 — the theme toggle lives on the navigation rail (bottom, above
  // the voice controls), not the header — single entry point.
  // D303 — apply a left-column rail toggle intent (FilesRail / RoomRail). The
  // intent is computed by the pure `left-column-nav` view-model; the shell just
  // executes the state writes it asks for.
  const applyToggleIntent = useCallback(
    (intent: ToggleIntent) => {
      if (intent.browserMode !== undefined) setBrowserMode(intent.browserMode);
      if (intent.minimumWidthPx !== undefined && panelSizes.browserWidth < intent.minimumWidthPx) {
        panelSizes.setWidth("browser", intent.minimumWidthPx);
      }
      if (intent.collapsed !== undefined) {
        panelSizes.setCollapsed("browser", intent.collapsed);
      }
      if (intent.navigateHome) void navigate("/");
    },
    [navigate, panelSizes],
  );

  // M238 — typed important-arrival events now own generic desktop popup
  // eligibility in NotificationStateProvider. This shell retains only native
  // click-to-Room routing. `desktopSessionActive` is still tracked here for the
  // terminal surface and servers panel.

  // M161 Phase 3 emits this after an in-process server session becomes active.
  // Routing preserves the renderer and its other live sessions.
  useEffect(() => {
    return desktopAPI?.servers?.onNavigateHome?.(() => {
      void navigate("/");
    }) ?? (() => {});
  }, [navigate]);

  const resolveMiniAppName = useCallback(
    (appId: string): string | undefined => {
      if (installedApps.kind !== "ready") return undefined;
      return installedApps.apps.find((app) => app.id === appId)?.name ?? undefined;
    },
    [installedApps],
  );

  // D342 Phase 2 — build the warm-up draft seed for a bare app launch: pick the
  // app's first workspace create-action as the blank-doc template + filename,
  // scoped to the active room. Returns undefined if the app isn't ready.
  const buildMiniAppDraftSeed = useCallback(
    (appId: string): MiniAppDraftSeed | undefined => {
      if (installedApps.kind !== "ready") return undefined;
      const app = installedApps.apps.find((a) => a.id === appId);
      if (!app || app.status !== "ready") return undefined;
      const action = (app.createActions ?? []).find((a) =>
        a.targetSurfaces.includes("workspace"),
      );
      return {
        appId,
        createActionId: action?.id ?? null,
        suggestedName: action?.defaultFilename ?? "Untitled",
        ...(roomNav.activeRoomId ? { roomId: roomNav.activeRoomId } : {}),
      };
    },
    [installedApps, roomNav.activeRoomId],
  );

  const focusFile = useCallback((target: OpenFileTarget) => {
    if (!authenticatedHuman) return;
    requestWorkSurfaceTransition(() => {
      setActiveMiniAppContext(null);
      clearActiveMiniApp();
      panelSizes.setCollapsed("context", false);
      if (panelSizes.contextWidth < READER_CHAT_DEFAULT_WIDTH_PX) {
        panelSizes.setWidth("context", READER_CHAT_DEFAULT_WIDTH_PX);
      }
      if (officeEnabled && target.kind === "artifact" && isOfficeDocPath(target.path)) {
        setWorkSurface({
          kind: "office-doc",
          artifactId: target.id,
          displayName: target.path.split("/").pop() ?? target.path,
          documentPath: target.path,
          ...(target.roomId !== undefined ? { roomId: target.roomId } : {}),
        });
        return;
      }
      setWorkSurface({ kind: "file", file: target, mode: "read" });
    });
  }, [authenticatedHuman, officeEnabled, panelSizes, requestWorkSurfaceTransition, setWorkSurface]);

  const focusFileInEditMode = useCallback((target: OpenFileTarget) => {
    if (
      target.kind === "artifact"
        ? !authenticatedHuman || !canWriteArtifacts
        : !authenticatedHuman
    ) return;
    requestWorkSurfaceTransition(() => {
      setActiveMiniAppContext(null);
      clearActiveMiniApp();
      panelSizes.setCollapsed("context", false);
      if (panelSizes.contextWidth < READER_CHAT_DEFAULT_WIDTH_PX) {
        panelSizes.setWidth("context", READER_CHAT_DEFAULT_WIDTH_PX);
      }
      setWorkSurface({ kind: "file", file: target, mode: "edit" });
    });
  }, [authenticatedHuman, canWriteArtifacts, panelSizes, requestWorkSurfaceTransition, setWorkSurface]);

  const openMiniApp = useCallback(
    (appId: string, target?: OpenFileTarget, options?: { mode?: OpenMiniAppMode }) => {
      const mode = options?.mode ?? "edit";
      if (!auth.viewer.isVerified || (mode === "edit" && (!canInvokeAgents || !canWriteArtifacts))) return;
      requestWorkSurfaceTransition(() => {
      setActiveMiniAppContext(null);
      clearActiveMiniApp();
      // D344 — collapse the left column ONLY on a bare Launch (no document):
      // the Apps panel is a launcher, so maximizing the work surface is right.
      // But when opening a SPECIFIC document in a mini-app (a `target` — e.g.
      // clicking a spreadsheet in the Files/Artifacts panel), DO NOT collapse:
      // the user keeps their browser to switch between files and collapses it
      // themselves (`‹` / rail icon) if they want. (D342 collapsed always,
      // which killed Files/Artifacts context when picking a file to edit.)
      if (target === undefined) {
        panelSizes.setCollapsed("browser", true);
      }
      panelSizes.setCollapsed("context", false);
      if (panelSizes.contextWidth < READER_CHAT_DEFAULT_WIDTH_PX) {
        panelSizes.setWidth("context", READER_CHAT_DEFAULT_WIDTH_PX);
      }
      // D342 Phase 2 — a bare launch (no bound doc) opens a warm-up draft: the
      // app runs against a blank seeded from its default workspace create-action
      // and only materializes a workspace artifact on first edit (no clutter).
      const draft = target === undefined ? buildMiniAppDraftSeed(appId) : undefined;
      setWorkSurface({
        kind: "app",
        appId,
        mode,
        ...(target !== undefined ? { target } : {}),
        ...(draft ? { draft } : {}),
      });
      });
    },
    [auth.viewer.isVerified, canInvokeAgents, canWriteArtifacts, panelSizes, buildMiniAppDraftSeed, requestWorkSurfaceTransition, setWorkSurface],
  );

  // D342 Phase 2 — when a draft materializes into a real artifact, re-bind the
  // work surface so panel toggles / reloads keep the now-saved document.
  const handleMiniAppMaterialized = useCallback((artifact: OpenFileTarget) => {
    const prev = workSurfaceRef.current;
    if (prev.kind !== "app") return;
    const next: WorkSurfaceState = { kind: "app", appId: prev.appId, mode: prev.mode, target: artifact };
    workSurfaceRef.current = next;
    setWorkSurfaceState(next);
  }, []);

  // D344 — open the full-width Apps overview / per-app detail pages. Like other
  // launches, collapse the left column to maximize the surface.
  const openAppsOverview = useCallback(() => {
    if (!auth.viewer.isVerified) return;
    requestWorkSurfaceTransition(() => {
      panelSizes.setCollapsed("browser", true);
      setWorkSurface({ kind: "apps-overview" });
    });
  }, [auth.viewer.isVerified, panelSizes, requestWorkSurfaceTransition, setWorkSurface]);

  const openAppDetail = useCallback(
    (appId: string) => {
      if (!auth.viewer.isVerified) return;
      requestWorkSurfaceTransition(() => {
        panelSizes.setCollapsed("browser", true);
        setWorkSurface({ kind: "app-detail", appId });
      });
    },
    [auth.viewer.isVerified, panelSizes, requestWorkSurfaceTransition, setWorkSurface],
  );

  useEffect(() => {
    setOpenAppsOverviewDispatcher(openAppsOverview);
    return () => setOpenAppsOverviewDispatcher(null);
  }, [openAppsOverview]);

  useEffect(() => {
    setOpenAppDetailDispatcher(openAppDetail);
    return () => setOpenAppDetailDispatcher(null);
  }, [openAppDetail]);

  const openAppSource = useCallback(
    (target: AppSourceTarget) => {
      if (!auth.viewer.isVerified) return;
      requestWorkSurfaceTransition(() => {
      setActiveMiniAppContext(null);
      clearActiveMiniApp();
      panelSizes.setCollapsed("context", false);
      if (panelSizes.contextWidth < READER_CHAT_DEFAULT_WIDTH_PX) {
        panelSizes.setWidth("context", READER_CHAT_DEFAULT_WIDTH_PX);
      }
      setWorkSurface({ kind: "app-source", appId: target.appId, path: target.path });
      });
    },
    [auth.viewer.isVerified, panelSizes, requestWorkSurfaceTransition, setWorkSurface],
  );

  const openSaasApp = useCallback(
    (target: SaasAppTarget) => {
      if (!auth.viewer.isVerified) return;
      requestWorkSurfaceTransition(() => {
      setActiveMiniAppContext(null);
      clearActiveMiniApp();
      panelSizes.setCollapsed("browser", true);
      panelSizes.setCollapsed("context", false);
      if (panelSizes.contextWidth < READER_CHAT_DEFAULT_WIDTH_PX) {
        panelSizes.setWidth("context", READER_CHAT_DEFAULT_WIDTH_PX);
      }
      setWorkSurface({
        kind: "saas-app",
        appId: target.appId,
        displayName: target.displayName,
        initialUrl: target.initialUrl,
        mode: target.mode ?? "app",
      });
      });
    },
    [auth.viewer.isVerified, panelSizes, requestWorkSurfaceTransition, setWorkSurface],
  );

  // D362 — open the read-only office viewer for a workspace artifact. Same
  // panel behavior as a SaaS app launch (collapse browser, keep chat available).
  const openOfficeDoc = useCallback(
    (target: OfficeDocTarget) => {
      if (!authenticatedHuman) return;
      if (!officeEnabled) return;
      requestWorkSurfaceTransition(() => {
      setActiveMiniAppContext(null);
      clearActiveMiniApp();
      panelSizes.setCollapsed("browser", true);
      panelSizes.setCollapsed("context", false);
      if (panelSizes.contextWidth < READER_CHAT_DEFAULT_WIDTH_PX) {
        panelSizes.setWidth("context", READER_CHAT_DEFAULT_WIDTH_PX);
      }
      setWorkSurface({
        kind: "office-doc",
        artifactId: target.artifactId,
        displayName: target.displayName,
        documentPath: target.documentPath ?? target.displayName,
        ...(target.roomId !== undefined ? { roomId: target.roomId } : {}),
      });
      });
    },
    [authenticatedHuman, officeEnabled, panelSizes, requestWorkSurfaceTransition, setWorkSurface],
  );

  useEffect(() => {
    setOpenMiniAppDispatcher(openMiniApp);
    return () => setOpenMiniAppDispatcher(null);
  }, [openMiniApp]);

  useEffect(() => {
    setOpenAppSourceDispatcher(openAppSource);
    return () => setOpenAppSourceDispatcher(null);
  }, [openAppSource]);

  useEffect(() => {
    setOpenSaasAppDispatcher(openSaasApp);
    return () => setOpenSaasAppDispatcher(null);
  }, [openSaasApp]);

  useEffect(() => {
    const subscribe = desktopAPI?.browserControl?.onOpenRequested;
    if (!subscribe) return;
    return subscribe(({ url }) => {
      openSaasApp({
        appId: "browser",
        displayName: "Browser",
        initialUrl: url,
        mode: "browser",
      });
    });
  }, [openSaasApp]);

  useEffect(() => {
    const api = desktopAPI?.browserResearch;
    if (!api?.onPresentRequested) return;
    return api.onPresentRequested((intervention) => {
      if (!auth.viewer.isVerified) {
        void api.cancel(intervention.id);
        return;
      }
      requestWorkSurfaceTransition(() => {
      setActiveMiniAppContext(null);
      clearActiveMiniApp();
      panelSizes.setCollapsed("browser", true);
      panelSizes.setCollapsed("context", false);
      if (panelSizes.contextWidth < READER_CHAT_DEFAULT_WIDTH_PX) {
        panelSizes.setWidth("context", READER_CHAT_DEFAULT_WIDTH_PX);
      }
      setWorkSurface({ kind: "browser-research", intervention });
      });
    });
  }, [auth.viewer.isVerified, panelSizes, requestWorkSurfaceTransition, setWorkSurface]);

  useEffect(() => {
    const subscribe = desktopAPI?.browserResearch?.onSurfaceClosed;
    if (!subscribe) return;
    return subscribe(({ id }) => {
      setWorkSurface((current) =>
        current.kind === "browser-research" && current.intervention.id === id
          ? { kind: "none" }
          : current,
      );
    });
  }, [setWorkSurface]);

  // D373 / Stack 137 — open the terminal work surface (center column,
  // chat slides to the reader sidecar, same as saas-app/office-doc).
  const openTerminal = useCallback(
    (target: OpenTerminalTarget) => {
      if (!auth.viewer.isVerified) return;
      requestWorkSurfaceTransition(() => {
      setActiveMiniAppContext(null);
      clearActiveMiniApp();
      panelSizes.setCollapsed("browser", true);
      panelSizes.setCollapsed("context", false);
      if (panelSizes.contextWidth < READER_CHAT_DEFAULT_WIDTH_PX) {
        panelSizes.setWidth("context", READER_CHAT_DEFAULT_WIDTH_PX);
      }
      // Reopen reattaches the last session (surface replays scrollback and
      // falls back to a fresh spawn if it died) so clicking Terminal again
      // doesn't orphan a running shell.
      const sid = target.sessionId ?? lastTerminalSessionIdRef.current ?? undefined;
      setWorkSurface({
        kind: "terminal",
        ...(sid !== undefined ? { sessionId: sid } : {}),
      });
      // Management pages own the full center column. Return to the ordinary
      // workspace so a visible Terminal launcher never appears to do nothing.
      if (fullWidthManagementRoute) void navigate("/");
      });
    },
    [auth.viewer.isVerified, fullWidthManagementRoute, navigate, panelSizes, requestWorkSurfaceTransition, setWorkSurface],
  );

  useEffect(() => {
    setOpenTerminalDispatcher(openTerminal);
    // Spike affordance: a dev-console / Electron-Debug entry point to open
    // the terminal without a rail icon yet (the rail launcher is P1 1.6).
    (window as unknown as { __nautiloOpenTerminal?: () => void }).__nautiloOpenTerminal =
      () => requestOpenTerminal();
    return () => {
      setOpenTerminalDispatcher(null);
      delete (window as unknown as { __nautiloOpenTerminal?: () => void })
        .__nautiloOpenTerminal;
    };
  }, [openTerminal]);

  useEffect(() => {
    const api = desktopAPI?.terminal;
    if (
      !api ||
      !auth.viewer.isVerified ||
      !desktopSessionActive ||
      typeof api.onRequest !== "function"
    ) return;
    return api.onRequest((evt) => {
      setTerminalControlRequestSessionId((current) => {
        if (evt.requested) return evt.sessionId;
        return current === evt.sessionId ? null : current;
      });
    });
  }, [auth.viewer.isVerified, desktopSessionActive]);

  const approveTerminalControlRequest = useCallback(async () => {
    const sid = terminalControlRequestSessionId;
    const api = desktopAPI?.terminal;
    if (!sid || !api) return;
    try {
      const session = (await api.list()).find((candidate) => candidate.id === sid);
      if (!session) return;
      if (session.sandboxed || session.agentControlConsented) {
        await api.setController(sid, "agent");
        return;
      }
      setTerminalControlConsentSessionId(sid);
    } catch {
      /* session may have closed */
    }
  }, [terminalControlRequestSessionId]);

  const denyTerminalControlRequest = useCallback(async () => {
    const sid = terminalControlRequestSessionId;
    const api = desktopAPI?.terminal;
    if (!sid || !api) return;
    try {
      await api.clearRequest(sid);
    } catch {
      /* session may have closed */
    }
  }, [terminalControlRequestSessionId]);

  const openRequestedTerminal = useCallback(() => {
    const sid = terminalControlRequestSessionId;
    if (!sid) return;
    requestOpenTerminal({ sessionId: sid });
  }, [terminalControlRequestSessionId]);

  const confirmTerminalControlConsent = useCallback(async () => {
    const sid = terminalControlConsentSessionId;
    const api = desktopAPI?.terminal;
    if (!sid || !api) return;
    try {
      const granted = await api.grantAgentControl(sid);
      if (granted) setTerminalControlConsentSessionId(null);
    } catch {
      /* session may have closed */
    }
  }, [terminalControlConsentSessionId]);

  const cancelTerminalControlConsent = useCallback(async () => {
    const sid = terminalControlConsentSessionId;
    const api = desktopAPI?.terminal;
    setTerminalControlConsentSessionId(null);
    if (sid && api) {
      try {
        await api.clearRequest(sid);
      } catch {
        /* session may have closed */
      }
    }
  }, [terminalControlConsentSessionId]);

  useEffect(() => {
    setOpenOfficeDocDispatcher(openOfficeDoc);
    return () => setOpenOfficeDocDispatcher(null);
  }, [openOfficeDoc]);

  useEffect(() => {
    setOpenFileDispatcher(focusFile);
    return () => setOpenFileDispatcher(null);
  }, [focusFile]);

  const clearWorkSurfaceImmediately = useCallback(() => {
    setActiveMiniAppContext(null);
    clearActiveMiniApp();
    setWorkSurface({ kind: "none" });
  }, [setWorkSurface]);

  const clearWorkSurface = useCallback(() => {
    requestWorkSurfaceTransition(clearWorkSurfaceImmediately);
  }, [clearWorkSurfaceImmediately, requestWorkSurfaceTransition]);

  // D303 — the shell header remains mounted above work surfaces, so Home must
  // close the current surface through its draft guard before resetting chrome.
  const goHome = useCallback(() => {
    requestWorkSurfaceTransition(() => {
      clearWorkSurfaceImmediately();
      setBrowserMode("artifacts");
      panelSizes.setCollapsed("browser", false);
      panelSizes.setCollapsed("context", false);
      void navigate("/");
    });
  }, [clearWorkSurfaceImmediately, navigate, panelSizes, requestWorkSurfaceTransition]);

  const openEventRoom = useCallback((roomId: string) => {
    requestWorkSurfaceTransition(() => {
      clearWorkSurfaceImmediately();
      roomNav.setActiveRoom(roomId);
    });
  }, [clearWorkSurfaceImmediately, requestWorkSurfaceTransition, roomNav]);

  const openEventArtifact = useCallback((artifact: ArtifactDto) => {
    focusFile(artifactOpenFileTarget({
      id: artifact.id,
      path: artifact.path,
      mimeType: artifact.mimeType,
      sizeBytes: artifact.size,
    }));
  }, [focusFile]);

  const registerMiniAppTransitionGuard = useCallback((
    guard: ((reason: MiniAppCloseReason) => Promise<boolean>) | null,
  ) => {
    miniAppTransitionGuardRef.current = guard;
    setMiniAppGuardRegistered(guard !== null);
    if (!guard && pendingRouteTransitionRef.current) {
      pendingRouteTransitionRef.current.reset();
      pendingRouteTransitionRef.current = null;
    }
  }, []);

  const retryMiniAppTransition = useCallback(() => {
    const pendingRoute = pendingRouteTransitionRef.current;
    if (pendingRoute) {
      pendingRouteTransitionRef.current = null;
      pendingRoute.proceed();
      return;
    }
    const pending = pendingWorkSurfaceTransitionRef.current;
    if (pending) setWorkSurface(pending);
    else clearWorkSurface();
  }, [clearWorkSurface, setWorkSurface]);

  const cancelMiniAppTransition = useCallback(() => {
    pendingWorkSurfaceTransitionRef.current = null;
    const pendingRoute = pendingRouteTransitionRef.current;
    pendingRouteTransitionRef.current = null;
    pendingRoute?.reset();
  }, []);

  const focusWorkSurface = useCallback(() => {
    panelSizes.setCollapsed("browser", true);
    panelSizes.setCollapsed("context", true);
  }, [panelSizes]);

  const handleMiniAppContextUpdate = useCallback(
    (context: ActiveMiniAppContext, mode: OpenMiniAppMode) => {
      setActiveMiniAppContext(context);
      publishActiveMiniApp(
        mapActiveMiniAppContext(context, resolveMiniAppName(context.appId), mode),
      );
    },
    [resolveMiniAppName],
  );

  const handleLiveMiniAppSessionChange = useCallback(
    (session: {
      sessionToken: string;
      sessionId: string;
      documentVersion: LiveDocumentVersion;
    } | null) => {
      publishLiveMiniAppSession(session);
    },
    [],
  );

  useEffect(() => {
    const authenticatedHumanFileSurface =
      authenticatedHuman &&
      (workSurface.kind === "office-doc" ||
        workSurface.kind === "file");
    if (
      authenticatedHumanFileSurface ||
      !shouldClearWorkSurfaceForAuth(workSurface.kind, auth.viewer.isVerified)
    ) return;
    clearWorkSurfaceImmediately();
  }, [auth.viewer.isVerified, authenticatedHuman, clearWorkSurfaceImmediately, workSurface]);

  useEffect(() => {
    if (officeEnabled || workSurface.kind !== "office-doc") return;
    clearWorkSurfaceImmediately();
  }, [clearWorkSurfaceImmediately, officeEnabled, workSurface.kind]);

  useEffect(() => {
    if (!artifactEventTarget) return;

    const unsub = subscribeWorkspaceArtifactEvents((event) => {
        const eventArtifactId = workspaceArtifactEventId(event);
        if (eventArtifactId !== artifactEventTarget.id) return;
        if (
          event.type === "deleted" ||
          (isWorkspaceArtifactCommittedMutation(event) && event.mutation === "delete")
        ) {
          clearWorkSurface();
          return;
        }
        // Resolve "is this our own local save?" exactly once, OUTSIDE the
        // setState updater. A coordinator commit is the single Workspace editor
        // echo; legacy producers can still emit a patch projection or changed
        // notification until their own cutover lands.
        const isOwnArtifactSave =
          (event.type === "changed" ||
            event.type === "document.patch.applied" ||
            isWorkspaceArtifactCommittedMutation(event)) &&
          isLocalArtifactSaveMutation(workspaceArtifactEventClientMutationId(event));
        setWorkSurface((prev) => {
          const currentArtifact =
            prev.kind === "file" && prev.file.kind === "artifact"
              ? prev.file
              : prev.kind === "app" && prev.target?.kind === "artifact"
                ? prev.target
                : null;
          if (!currentArtifact || currentArtifact.id !== eventArtifactId) return prev;

          if (event.type === "renamed") {
            const nextTarget = {
              ...currentArtifact,
              path: event.newPath,
              reloadToken: (currentArtifact.reloadToken ?? 0) + 1,
            };
            if (prev.kind === "app") {
              return {
                ...prev,
                target: nextTarget,
              };
            }
            if (prev.kind !== "file") return prev;
            return {
              kind: "file",
              mode: prev.mode,
              file: {
                ...currentArtifact,
                path: event.newPath,
                ...(prev.mode === "read"
                  ? { reloadToken: (currentArtifact.reloadToken ?? 0) + 1 }
                  : {}),
              },
            };
          }
          // Our own editor save: never reload, in read OR edit mode. Return
          // the previous state unchanged so the file object identity is stable.
          if (isOwnArtifactSave) return prev;
          // MiniAppSurface owns live app-document sync: patch events become
          // sanitized iframe messages and changed events become reloadRequired
          // notifications when needed. Avoid a duplicate reloadToken bump here.
          if (
            prev.kind === "app" &&
            (event.type === "changed" ||
              event.type === "document.patch.applied" ||
              isWorkspaceArtifactCommittedMutation(event))
          ) {
            return prev;
          }
          // Edit-mode artifact sync is handled by usePatchDocumentSession.
          if (
            prev.kind === "file" &&
            prev.mode === "edit" &&
            (event.type === "changed" ||
              event.type === "document.patch.applied" ||
              isWorkspaceArtifactCommittedMutation(event))
          ) {
            return prev;
          }
          // Someone else's change: reload read mode and app mode.
          const nextPath = workspaceArtifactEventPath(event) ?? currentArtifact.path;
          const nextTarget = reloadArtifactOpenFileTarget(currentArtifact, nextPath);
          if (prev.kind === "app") {
            return {
              ...prev,
              target: nextTarget,
            };
          }
          if (prev.kind !== "file") return prev;
          return {
            kind: "file",
            mode: prev.mode,
            file: {
              ...currentArtifact,
              path: nextPath,
              reloadToken: (currentArtifact.reloadToken ?? 0) + 1,
            },
          };
        });
      }, {
        artifactId: artifactEventTarget.id,
        roomId: artifactEventTarget.roomId,
        onReconnect: () => {
          setWorkSurface((previous) => {
            const target =
              previous.kind === "file" && previous.file.kind === "artifact"
                ? previous.file
                : previous.kind === "app" && previous.target?.kind === "artifact"
                  ? previous.target
                  : null;
            if (!target || target.id !== artifactEventTarget.id) return previous;
            if (previous.kind === "app") return previous;
            return {
              ...previous,
              file: reloadArtifactOpenFileTarget(target),
            };
          });
        },
      });

    return () => {
      unsub();
    };
  }, [artifactEventTarget, clearWorkSurface, setWorkSurface, subscribeWorkspaceArtifactEvents]);

  useEffect(() => {
    if (!fsEventTarget) return;
    let retainedIdentity: {
      relayId: string;
      canonicalPath: string;
    } | null = null;
    const refreshIdentityAndBytes = async () => {
      const api = desktopAPI;
      if (!api) return null;
      try {
        const stat = await api.fs.stat(fsEventTarget.path);
        retainedIdentity = stat.documentIdentity ?? null;
        if (stat.exists && stat.isFile) await api.fs.readFile(fsEventTarget.path);
      } catch {
        retainedIdentity = null;
      }
      return retainedIdentity;
    };
    void refreshIdentityAndBytes();
    return subscribeWorkspaceArtifactEvents(async (event) => {
      if (
        event.type !== "document.mutation.committed" ||
        event.mutation !== "update" ||
        event.after.identity.kind !== "local_file"
      ) return;
      let identity = retainedIdentity;
      if (
        !identity ||
        identity.relayId !== event.after.identity.relayId ||
        identity.canonicalPath !== event.after.identity.canonicalPath
      ) {
        // The Desktop stream can become ready before this surface's initial
        // stat completes. Resolve authoritative identity again instead of
        // permanently dropping a committed change during that gap.
        identity = await refreshIdentityAndBytes();
      }
      if (
        !identity ||
        identity.relayId !== event.after.identity.relayId ||
        identity.canonicalPath !== event.after.identity.canonicalPath
      ) return;
      if (isLocalArtifactSaveMutation(workspaceArtifactEventClientMutationId(event))) return;
      setWorkSurface((previous) => {
        const target =
          previous.kind === "file" && previous.file.kind === "fs"
            ? previous.file
            : previous.kind === "app" && previous.target?.kind === "fs"
              ? previous.target
              : null;
        if (!target || target.path !== fsEventTarget.path) return previous;
        // Edit and app surfaces consume the exact batch themselves.
        if (previous.kind === "app" || (previous.kind === "file" && previous.mode === "edit")) {
          return previous;
        }
        return {
          ...previous,
          file: { ...target, reloadToken: (target.reloadToken ?? 0) + 1 },
        };
      });
    }, {
      onReconnect: async () => {
        await refreshIdentityAndBytes();
        setWorkSurface((previous) => {
          if (
            previous.kind !== "file" ||
            previous.file.kind !== "fs" ||
            previous.file.path !== fsEventTarget.path ||
            previous.mode !== "read"
          ) return previous;
          return {
            ...previous,
            file: {
              ...previous.file,
              reloadToken: (previous.file.reloadToken ?? 0) + 1,
            },
          };
        });
      },
    });
  }, [fsEventTarget, setWorkSurface, subscribeWorkspaceArtifactEvents]);

  // Local (Current Folder) files have no SSE author id, so we discriminate
  // our own writes from external/agent edits by comparing the file's current
  // sha256 against the sha we registered just before writing. On a directory
  // change to the open file in read mode: reload only when the bytes differ
  // from our last write. Edit-mode sync is handled by usePatchDocumentSession.
  // We deliberately do NOT call unwatchRoot on cleanup — the desktop watcher is
  // keyed by resolved path and NOT ref-counted, so unwatching here would also
  // kill the Files-tab tree watcher on the same root.
  useEffect(() => {
    const watchingFsFile =
      workSurface.kind === "file" &&
      workSurface.file.kind === "fs" &&
      workSurface.mode === "read"
        ? workSurface.file
        : null;
    if (!watchingFsFile) return;
    const api = desktopAPI;
    if (!api?.fs.onDirectoryChanged) return;

    void api.fs.watchRoot?.(watchingFsFile.rootPath).catch(() => {
      /* best-effort; tree watcher may already cover this root */
    });

    const unsub = api.fs.onDirectoryChanged((evt) => {
      if (!fsDirectoryChangeAffectsFile(evt, watchingFsFile.path)) return;
      void (async () => {
        let currentSha: string | null = null;
        try {
          const st = await api.fs.stat(watchingFsFile.path);
          if (st.exists && st.isFile) {
            const content = await api.fs.readFile(watchingFsFile.path);
            currentSha = await sha256HexForText(content);
          }
        } catch {
          /* unreadable / gone — fall through to a reload so the surface re-resolves */
        }
        if (isLocalFsSaveSha(watchingFsFile.path, currentSha)) return;
        setWorkSurface((prev) => {
          if (prev.kind !== "file" || prev.file.kind !== "fs") return prev;
          if (prev.file.path !== watchingFsFile.path) return prev;
          return {
            kind: "file",
            mode: prev.mode,
            file: {
              ...prev.file,
              reloadToken: (prev.file.reloadToken ?? 0) + 1,
            },
          };
        });
      })();
    });

    return () => {
      unsub();
    };
  }, [setWorkSurface, workSurface]);

  useEffect(() => {
    if (!workSurfaceActive || eventsOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      clearWorkSurface();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [clearWorkSurface, eventsOpen, workSurfaceActive]);

  // Wire menu-dispatched window events to the panel-toggle actions.
  // Menu (native on desktop, web-keyboard hook elsewhere) dispatches;
  // shell listens. One listener, one toggle, one state change.
  useEffect(() => {
    const onBrowser = () => panelSizes.toggleCollapsed("browser");
    const onContext = () => panelSizes.toggleCollapsed("context");
    const onRail = () => panelSizes.toggleCollapsed("rail");
    window.addEventListener(MENU_TOGGLE_BROWSER_COLUMN_EVENT, onBrowser);
    window.addEventListener(MENU_TOGGLE_CONTEXT_PANEL_EVENT, onContext);
    window.addEventListener(MENU_TOGGLE_NAV_RAIL_EVENT, onRail);
    return () => {
      window.removeEventListener(MENU_TOGGLE_BROWSER_COLUMN_EVENT, onBrowser);
      window.removeEventListener(MENU_TOGGLE_CONTEXT_PANEL_EVENT, onContext);
      window.removeEventListener(MENU_TOGGLE_NAV_RAIL_EVENT, onRail);
    };
  }, [panelSizes]);

  return (
    // Shell + grid classnames (including the load-bearing
    // `overflow-hidden` scroll-boundary guards) are defined in
    // `chrome-shell.layout.ts` and regression-tested there — see the
    // constants' JSDoc for the full rationale.
    // D182 / Phase 11.6.E.2 — NewConversationProvider hosts the
    // single dialog mount-point so the explorer "+" + RoomsPanel
    // "+ New conversation…" + future triggers all open the same
    // dialog instance via `useNewConversation().open(...)`.
    <TerminalControlRequestProvider
      value={{
        sessionId: terminalControlRequestVisibleInSurface
          ? null
          : terminalControlRequestSessionId,
        onApprove: approveTerminalControlRequest,
        onDeny: denyTerminalControlRequest,
        onOpenTerminal: openRequestedTerminal,
      }}
    >
    <NewConversationProvider>
    <div ref={shellRootRef} className={SHELL_ROOT_CLASSES}>
      <RoomManageBridge />
      <ConnectedWebsiteJourney />

      {authenticatedHuman && roomNav.roomListError ? (
        <div
          role="alert"
          className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-amber-500/15 px-4 py-2 text-xs text-foreground"
        >
          <span className="min-w-0 truncate">{roomNav.roomListError}</span>
          <button
            type="button"
            className="shrink-0 rounded border border-border bg-background px-2 py-1 text-[11px] font-medium hover:bg-[var(--primary-muted)]"
            onClick={() => void roomNav.refreshRooms()}
          >
            Retry
          </button>
        </div>
      ) : null}

      {/* Grid container — position:relative so the absolutely-positioned
          dividers can anchor against it. Column widths come from
          buildGridCols; the class list (incl. overflow-hidden) is a
          named constant so the scroll-boundary contract is testable. */}
      <div
        className={SHELL_GRID_CLASSES}
        style={{ gridTemplateColumns: gridCols }}
      >
        {/* D278 §4.7.4 — one shared Conversational Focus source for this room
            so the Members panel cards/rail AND the in-transcript agent avatars
            (R4) read & toggle the same state. Context.Provider adds no DOM, so
            the grid layout is unaffected. */}
        <RoomFocusProvider roomId={roomNav.activeRoomId}>
        {/* D076 Chunk 4 — Navigation rail. Grid column 1 when visible.
            Desktop-only; ⌘⇧0 or View → Toggle Navigation Rail collapses.
            buildGridCols drops its column when railVisible is false
            so the rest of the grid slides left seamlessly. */}
        {showRail && (
          <NavigationRail
            showVerifiedOnlyRoutes={auth.viewer.isVerified}
            identityLabel={auth.viewer.label}
            identityRole={auth.viewer.role}
            terminalSessionCount={terminalSessionCount}
            onAction={(id) => {
              if (id === "open-terminal") requestOpenTerminal();
            }}
            accountFooter={authenticatedHuman ? <WorkbenchAccountMenu variant="rail" /> : undefined}
            // D365 — theme toggle now lives on the rail (bottom, above voice),
            // not the center header. Single entry point.
            theme={theme}
            onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
            updateStatus={desktopUpdate.status}
            onOpenUpdate={desktopUpdate.open}
            // D303 — two left-column PANEL toggles: Artifacts (Boxes) and Rooms
            // (chat). Each is 3-state (open / collapsed `›` / inactive) from the
            // pure left-column-nav view-model, mutually exclusive, and operates
            // IN PLACE on any room route (no navigation) — so you can pop
            // artifacts open in a group chat to drag a file in. Clicking the open
            // one is a no-op (hide is the panel's own `‹`); collapsing keeps the
            // icon's chevron so the highlight never jumps to Home.
            extraSection={
              <>
                {canSelectDesktopServer ? (
                  <ServersRail
                    state={serversIconState(leftColState)}
                    onToggle={() => applyToggleIntent(serversToggleIntent(leftColState))}
                  />
                ) : null}
                <ArtifactsRail
                  state={artifactsIconState(leftColState)}
                  onToggle={() => applyToggleIntent(artifactsToggleIntent(leftColState))}
                />
                <RoomRail
                  state={roomsIconState(leftColState)}
                  onToggle={() => applyToggleIntent(roomsToggleIntent(leftColState))}
                />
                {/* D342 — installed mini-apps panel toggle (LayoutGrid, "apps"). */}
                {canInvokeAgents && canWriteArtifacts ? (
                  <AppsRail
                    state={appsIconState(leftColState)}
                    onToggle={() => applyToggleIntent(appsToggleIntent(leftColState))}
                  />
                ) : null}
                {/* D336 — Web / SaaS control panel toggle (Globe2, "web"). */}
                {canInvokeAgents ? (
                  <WebRail
                    state={webIconState(leftColState)}
                    onToggle={() => applyToggleIntent(webToggleIntent(leftColState))}
                  />
                ) : null}
              </>
            }
            // D303 — the rail no longer has a Home item; the home/reset
            // affordance is the top-left NAUTILO wordmark (see header). All
            // rail route items (including Scheduled tasks and Connections)
            // navigate normally; active state is pathname-matched.
          />
        )}

        {/* D057 2a.1 — Browser column. Mode-driven (D182 Phase 11.6.B):
            - "artifacts" (default) renders the existing <BrowserColumn />
              with its Artifacts / Files tabs.
            - "rooms" renders <RelationshipExplorer /> with grouped
              People / Agents / Groups / Recent sections per
              workbench-ui-vocabulary.md §4.5 + D111 P3's explorer
              groupings, but as a USER-CONTROLLED TOGGLE rather than
              a permanent hijack of verified users.
            The collapse affordance (chevron + edge-strip) lives on
            the BrowserColumn path; toggling to rooms mode mounts the
            explorer in the same grid slot. The user keeps reach to
            Files/Artifacts at all times — one rail click away. */}
        {showBrowserColumn && browserMode === "artifacts" && (
          <BrowserColumn
            onCollapse={() => panelSizes.setCollapsed("browser", true)}
            onOpenFile={focusFile}
            onOpenFileEdit={focusFileInEditMode}
            activeArtifact={activeArtifact}
            onCloseActiveArtifact={clearWorkSurfaceImmediately}
          />
        )}
        {showBrowserColumn && browserMode === "rooms" && (
          <RelationshipExplorer
            onCollapse={() => panelSizes.setCollapsed("browser", true)}
          />
        )}
        {/* D342 — dedicated installed-mini-apps panel ("apps"). */}
        {showBrowserColumn && browserMode === "apps" && canInvokeAgents && canWriteArtifacts && (
          <AppsPanel
            onCollapse={() => panelSizes.setCollapsed("browser", true)}
            onOpenFile={focusFile}
          />
        )}
        {/* D336 — Web / known-SaaS panel ("web"). */}
        {showBrowserColumn && browserMode === "web" && canInvokeAgents && (
          <KnownWebAppsPanel
            onCollapse={() => panelSizes.setCollapsed("browser", true)}
          />
        )}
        {showBrowserColumn && browserMode === "servers" && canSelectDesktopServer && (
          <ServersPanel
            activeSession={desktopSessionActive}
            onCollapse={() => panelSizes.setCollapsed("browser", true)}
          />
        )}

        <main className="grid min-w-0 grid-rows-[48px_1fr] overflow-hidden">
          <header className="flex items-center justify-between border-b border-border px-4">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={goHome}
                title="Home — default view"
                aria-label="Home — default view"
                className="cursor-pointer rounded text-sm font-semibold tracking-tight text-foreground hover:text-primary"
              >
                NAUTILO
              </button>
              {authenticatedHuman ? (
                <WorkbenchAccountMenu variant="header" />
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    void auth.session.signIn().catch((err) => {
                      console.error("[workbench-shell] sign-in failed", err);
                    });
                  }}
                  title="Sign in"
                  className="ml-2 cursor-pointer rounded-full bg-foreground-muted/20 px-2 py-0.5 text-xs font-medium text-foreground-muted hover:bg-foreground-muted/30 hover:text-foreground"
                >
                  Guest · Sign in
                </button>
              )}
            </div>
            <div className="flex items-center gap-3">
              {canInvokeAgents ? <ServerGuideCompanion /> : null}
              {authenticatedHuman ? (
                <EventFeedBell
                  buttonRef={eventFeedBellRef}
                  open={eventsOpen}
                  unreadCount={eventFeed.quietPreference === null ? null : eventFeed.unreadCount}
                  quiet={eventFeed.quiet}
                  onClick={toggleEvents}
                />
              ) : null}
              {bp !== "desktop" && !eventsOpen ? (
                <button
                  type="button"
                  aria-label="Open information"
                  className="rounded-md p-1.5 text-foreground-muted hover:text-foreground"
                >
                  ⓘ
                </button>
              ) : null}
            </div>
          </header>

          <div className="relative min-h-0 min-w-0 overflow-hidden">
          <div
            className="h-full min-h-0 min-w-0 overflow-hidden"
            inert={eventsOpen && bp !== "desktop"}
            aria-hidden={eventsOpen && bp !== "desktop" ? true : undefined}
          >
          {workSurfaceOwnsMain ? (
            <AppErrorBoundary key={workSurface.kind} label={`work-surface:${workSurface.kind}`}>
            <Suspense fallback={workSurfaceFallback}>
            {workSurface.kind === "app" ? (
              <MiniAppSurface
                appId={workSurface.appId}
                mode={workSurface.mode}
                onEdit={() => openMiniApp(workSurface.appId, workSurface.target, { mode: "edit" })}
                theme={theme}
                target={workSurface.target}
                draft={workSurface.draft}
                sourceHash={workSurface.sourceHash}
                onContextUpdate={handleMiniAppContextUpdate}
                onLiveMiniAppSessionChange={handleLiveMiniAppSessionChange}
                onMaterialized={handleMiniAppMaterialized}
                registerBeforeLeave={registerMiniAppBeforeLeave}
                workspaceCopyDestination={roomNav.activeRoomId ? { roomId: roomNav.activeRoomId, label: roomNav.activeRoom?.label ?? "Current Room" } : undefined}
                onToggleChat={() =>
                  panelSizes.setCollapsed("context", !panelSizes.contextCollapsed)
                }
                chatVisible={!panelSizes.contextCollapsed}
                onRegisterTransitionGuard={registerMiniAppTransitionGuard}
                onLifecycleRetryReady={retryMiniAppTransition}
                onLifecycleCancel={cancelMiniAppTransition}
                onClose={clearWorkSurfaceImmediately}
                onToggleBrowser={() =>
                  panelSizes.setCollapsed("browser", !panelSizes.browserCollapsed)
                }
                browserVisible={!panelSizes.browserCollapsed}
              />
            ) : workSurface.kind === "browser-research" ? (
              <BrowserResearchSurface
                intervention={workSurface.intervention}
                onClose={clearWorkSurface}
              />
            ) : workSurface.kind === "saas-app" ? (
              <SaasAppSurface
                appId={workSurface.appId}
                displayName={workSurface.displayName}
                initialUrl={workSurface.initialUrl}
                mode={workSurface.mode ?? "app"}
                onClose={clearWorkSurface}
                onFocus={focusWorkSurface}
                onToggleChat={() =>
                  panelSizes.setCollapsed("context", !panelSizes.contextCollapsed)
                }
                chatVisible={!panelSizes.contextCollapsed}
                assistantName={assistantName}
                onSendToGenie={genieHandoffBridge.deliverBrowserPageDraft}
              />
            ) : workSurface.kind === "office-doc" ? (
              <OfficeDocSurface
                artifactId={workSurface.artifactId}
                displayName={workSurface.displayName}
                documentPath={workSurface.documentPath}
                {...(workSurface.roomId !== undefined ? { roomId: workSurface.roomId } : {})}
                onClose={clearWorkSurface}
                onFocus={focusWorkSurface}
                onToggleChat={() =>
                  panelSizes.setCollapsed("context", !panelSizes.contextCollapsed)
                }
                chatVisible={!panelSizes.contextCollapsed}
                assistantName={assistantName}
              />
            ) : workSurface.kind === "apps-overview" ? (
              <AppsOverviewSurface onClose={clearWorkSurface} />
            ) : workSurface.kind === "app-detail" ? (
              <AppDetailSurface
                appId={workSurface.appId}
                onClose={clearWorkSurface}
                onBack={openAppsOverview}
              />
            ) : workSurface.kind === "app-source" ? (
              <AppSourceEditorSurface
                target={{
                  kind: "app-source",
                  appId: workSurface.appId,
                  path: workSurface.path,
                }}
                onClose={clearWorkSurface}
              />
            ) : workSurface.kind === "terminal" ? (
              <TerminalSurface
                activeSession={desktopSessionActive}
                {...(workSurface.sessionId !== undefined
                  ? { sessionId: workSurface.sessionId }
                  : {})}
                onSession={(id) => {
                  // A2: only remember the id for reopen (ref, no re-render).
                  // Do NOT push it into workSurface state — that would change
                  // the surface's sessionId prop and re-run its mount effect,
                  // tearing down + reattaching the just-created session.
                  lastTerminalSessionIdRef.current = id;
                }}
                onSelectSession={(id) => {
                  // Explicit switch (tab click / new): DO drive it through the
                  // sessionId prop so the surface remounts + attaches to that PTY.
                  lastTerminalSessionIdRef.current = id;
                  setWorkSurface({ kind: "terminal", sessionId: id });
                }}
                assistantName={assistantName}
                onClose={clearWorkSurface}
              />
            ) : workSurface.kind === "file" && workSurface.mode === "edit" ? (
              <EditorSurface
                file={readingFile!}
                onView={() =>
                  setWorkSurface({ kind: "file", file: workSurface.file, mode: "read" })
                }
                onClose={clearWorkSurface}
                onFocus={focusWorkSurface}
              />
            ) : (
              <ReaderSurface
                file={readingFile!}
                officeEnabled={officeEnabled}
                onClose={clearWorkSurface}
                {...(readingFile?.kind === "fs" || canWriteArtifacts
                  ? { onEdit: (f: ReaderFile) => setWorkSurface({ kind: "file", file: f, mode: "edit" }) }
                  : {})}
              />
            )}
            </Suspense>
            </AppErrorBoundary>
          ) : (
            <Outlet />
          )}
          </div>
          {eventsOpen && bp !== "desktop" ? (
            <section className="absolute inset-0 z-40 bg-background" aria-label="Events">
              <DrawerShell title="Events" actions={<EventFeedQuietControl />} onClose={closeEvents}>
                <EventFeedPanel onOpenRoom={openEventRoom} onOpenArtifact={openEventArtifact} />
              </DrawerShell>
            </section>
          ) : null}
          </div>
        </main>

        {/* Context panel / Drawer (right) — desktop only.
            When drawer is open, hide ContextPanel and render ThreadDrawer.
            D077 — parent aside is position:relative so the collapse
            chevron can float in the top-left corner.
            D093 follow-up — auto-hidden on /settings to give the
            settings page the full horizontal column (API-key values
            were clipping off the right edge). */}
        {bp === "desktop" && trailingDrawerOpen && (
          <aside className="relative grid min-h-0 min-w-0 grid-rows-[1fr] overflow-hidden border-l border-border bg-background">
            {eventsOpen ? (
              <DrawerShell title="Events" actions={<EventFeedQuietControl />} onClose={closeEvents}>
                <EventFeedPanel onOpenRoom={openEventRoom} onOpenArtifact={openEventArtifact} />
              </DrawerShell>
            ) : (
              <ThreadDrawer state={drawer.current} onClose={drawer.close} />
            )}
          </aside>
        )}
        {bp === "desktop" && !trailingDrawerOpen && workSurfaceOwnsMain && !panelSizes.contextCollapsed && (
          <aside className="relative grid min-h-0 min-w-0 grid-rows-[auto_1fr] overflow-hidden border-l border-border bg-background">
            <ContextPanelCollapseChevron
              onCollapse={() =>
                panelSizes.setCollapsed("context", true)
              }
              label="Hide chat panel"
            />
            {readingFile ? <ReadingChatHeader file={readingFile} /> : null}
            <div className="min-h-0 min-w-0">
              {/* D352 — supply the active room's author/member context so the
                  reader-rail chat's @-mention picker, agent identity, and peer
                  labels match the center chat. `activeRoomMembers` is already
                  fetched above (group detection), so this adds no round-trip. */}
              <RoomAuthorScope members={activeRoomMembers}>
                {/* Baseline: <Conversation chromeDensity="readerRail" />. D513 adds
                    only the shell-owned draft registrar below. */}
                <Conversation
                  chromeDensity="readerRail"
                  registerSendToGenieDraftDispatcher={genieHandoffBridge.registerBrowserPageDraftDispatcher}
                  {...(readerFocusedResourceTarget ? { readerFocusedResourceTarget } : {})}
                />
              </RoomAuthorScope>
            </div>
          </aside>
        )}
        {bp === "desktop" && !trailingDrawerOpen && !workSurfaceOwnsMain && !contextColumnHidden && (
          <aside className="relative border-l border-border bg-background-panel overflow-y-auto">
            {membersPanelActive && roomNav.activeRoomId ? (
              // Active room: the collapse ladder lives in the panel header
              // (« / » / ‹), so we do NOT render the shell chevron here —
              // that was the duplicate control that confused the ladder.
              <MembersManagerPanel
                roomId={roomNav.activeRoomId}
                roomLabel={roomNav.activeRoom?.label ?? ""}
                members={activeRoomMembers}
                conductorMode={activeRoomConductorMode}
                viewerActorId={auth.viewer.sessionActorId ?? ""}
                view={membersPanelRail ? "rail" : "full"}
                onSetView={membersView.setView}
              />
            ) : (
              <>
                <ContextPanelCollapseChevron
                  onCollapse={() => panelSizes.setCollapsed("context", true)}
                />
                <ContextPanel />
              </>
            )}
          </aside>
        )}

        {/* D077 — draggable dividers. Rendered only when the panel on
            at least one side of the divider is actually visible; no
            point offering drag handles for hidden panels.
            Browser divider: anchor is `left:`, which is window-relative.
            When the rail is visible it pushes the browser column right
            by RAIL_WIDTH_PX; the divider must match that offset or its
            hit-strip floats out in empty space over the main column.
            Context divider: anchor is `right:`, unaffected by the rail. */}
        {showBrowserColumn && (
          <PanelDivider
            kind="browser"
            sizes={panelSizes}
            railOffsetPx={showRail ? RAIL_WIDTH_PX : 0}
          />
        )}
        {bp === "desktop" &&
          (trailingDrawerOpen ||
            (workSurfaceOwnsMain && !panelSizes.contextCollapsed) ||
            // Room members use the discrete ladder (full/rail/hidden), not a
            // free-drag width — so no context divider there.
            (!workSurfaceOwnsMain &&
              !membersPanelActive &&
              !contextEffectivelyCollapsed)) && (
          <PanelDivider kind="context" sizes={panelSizes} />
        )}

        {/* D077 — accordion edge strips. Rendered only when the matching
            panel is collapsed. Hover-reveal chevron; click expands back
            to the pre-collapse width. Replaces the old header toggle
            icons (`▤` / `ⓘ`) which overloaded glyphs that mean other
            things in every other app. */}
        {/* D303 — the browser edge strip was removed. It sat at the window's
            left edge (left:0), overlapping the 48px nav rail. Reopen the left
            column via its rail toggle (FilesRail / RoomRail) instead. The
            context edge strip (right side, no rail to overlap) is unaffected. */}
        {/* Context edge strip — hidden on /settings so the auto-hide
            cannot be overridden by a stray hover-click. The strip is
            "click here to expand the panel back"; on /settings we do
            not want that affordance because the layout can't
            accommodate it. Also hidden when the drawer is open. */}
        {bp === "desktop" && !trailingDrawerOpen && membersPanelActive && (
          // Active room: hidden state lives in the members ladder; restore goes
          // back to the last non-hidden state (rail or full).
          <PanelEdgeStrip
            kind="context"
            sizes={panelSizes}
            forceCollapsed={membersPanelHidden}
            onExpand={membersView.restore}
            label="Show members"
          />
        )}
        {bp === "desktop" &&
          !trailingDrawerOpen &&
          !membersPanelActive &&
          ((workSurfaceOwnsMain && panelSizes.contextCollapsed) ||
            (!workSurfaceOwnsMain && !contextAutoHiddenByRoute)) && (
          <PanelEdgeStrip
            kind="context"
            sizes={panelSizes}
            label={workSurfaceOwnsMain ? "Show chat panel" : undefined}
          />
        )}
        </RoomFocusProvider>
      </div>

      <Footer />
      <ServerUpgradeNotice />

      {/* D057 2a.10 / D059 3.5 — toast rendering + prolonged-disconnect
          effect. Toast lives under ToastProvider (App.tsx) and renders
          via portal; ProlongedDisconnectToast is an effect-only
          component that fires the 30s escalation. */}
      <Toast />
      <ProlongedDisconnectToast />
      {nativeQuitPrepared ? (
        <div
          className="fixed inset-0 z-[9999] grid cursor-wait place-items-center bg-background/80 backdrop-blur-sm"
          role="status"
          aria-live="polite"
        >
          <div className="rounded-lg border border-border bg-background-panel px-5 py-3 text-sm text-foreground shadow-lg">
            Open work preserved. Quitting Nautilo…
          </div>
        </div>
      ) : null}
      {terminalControlConsentSessionId && (
        <TerminalControlConsentDialog
          assistantName={assistantName}
          onCancel={cancelTerminalControlConsent}
          onConfirm={confirmTerminalControlConsent}
        />
      )}
    </div>
    </NewConversationProvider>
    </TerminalControlRequestProvider>
  );
}

function ReadingChatHeader({ file }: { file: ReaderFile }) {
  const fileName = file.path.split(/[/\\]/).pop() ?? file.path;
  return (
    <header className="flex min-w-0 items-center justify-between border-b border-border bg-background-panel pl-8 pr-3">
      <div className="min-w-0">
        <div className="text-xs font-semibold text-foreground">Chat</div>
        <div className="truncate text-[11px] text-foreground-muted" title={file.path}>
          {fileName}
        </div>
      </div>
      <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] text-foreground-muted">
        Reader
      </span>
    </header>
  );
}
