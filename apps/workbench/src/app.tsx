import { Suspense, type ComponentType, type LazyExoticComponent } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { WorkbenchShell } from "./layouts/workbench-shell";
import { ActiveRoom } from "./modes/rooms/shape/ActiveRoom";
import { ContextPanel } from "./components/context-panel";
import { NautiloRuntimeProvider } from "./adapters/nautilo-runtime";
import { ToastProvider } from "./components/toast";
import { BrowserColumnProvider } from "./components/browser-column/browser-column.context";
import { WorkspaceProvider } from "./contexts/workspace-context";
import { PostureProvider } from "./contexts/posture-context";
import { ProfileProvider } from "./contexts/profile-context";
import { RoomNavigationProvider } from "./contexts/room-navigation-context";
import { useDesktopMenu } from "./hooks/use-desktop-menu";
import { AppErrorBoundary } from "./components/app-error-boundary";
import { AuthGate } from "./components/auth-gate";
import { FirstRunGate } from "./components/first-run-gate";
import { SignInCallback } from "./routes/auth-callback";
import { AuthProvider } from "./hooks/use-auth";
import { InstalledAppsProvider } from "./apps/use-installed-apps";
import { WorkspaceArtifactsProvider } from "./artifacts/workspace-artifacts-provider";
import { DrawerProvider } from "./modes/rooms/thread-drawer/drawer-state.tsx";
import { useDeepLink } from "./hooks/use-deep-link";
import { InviteRedeem } from "./routes/invite-redeem";
import { OwnerClaimRedeem } from "./routes/owner-claim-redeem";
import type { OwnerClaimRouteBootstrap } from "./lib/owner-claim-entry";
import { deploymentSafeLazy } from "./lib/deployment-safe-lazy";
import { RoomComposerDraftProvider } from "./contexts/room-composer-draft-context";
import { MaintenanceApplyingBoundary } from "./components/maintenance-applying-gate";
import { NotificationStateProvider } from "./notifications/notification-state-context";
import { EventFeedProvider } from "./event-feed/event-feed-context";
import { GenieCustomizationRoute } from "./genie-customization/genie-customization-route";
import { SystemPermissionsStartupGate } from "./components/system-permissions-startup-gate";
import { ADMIN_ACCESS_CONTROL_ROUTE } from "./pages/admin/admin-sections";
import { EncryptionReadinessProvider } from
  "./contexts/encryption-readiness-context";
import { CryptoDeviceAdmissionGate } from
  "./components/crypto-device-admission-gate";
import { EncryptionTransitionCard } from
  "./pages/admin/sections/encryption-transition-card";

// M214 Phase 12 — lazy-load management routes so ordinary room chat stays
// on the eager startup path. Named-export adapters match editor-surface.tsx.
const SettingsPage = deploymentSafeLazy(() =>
  import("./pages/settings/settings-page").then((m) => ({ default: m.SettingsPage })),
);
const AdminPage = deploymentSafeLazy(() =>
  import("./pages/admin/admin-page").then((m) => ({ default: m.AdminPage })),
);
const AccessControlPage = deploymentSafeLazy(() =>
  import("./pages/admin/access-control/access-control-page").then((m) => ({
    default: m.AccessControlPage,
  })),
);
const CostsPage = deploymentSafeLazy(() =>
  import("./pages/costs/costs-page").then((m) => ({ default: m.CostsPage })),
);
const SkillsPage = deploymentSafeLazy(() =>
  import("./pages/skills/skills-page").then((m) => ({ default: m.SkillsPage })),
);
const ConnectionsPage = deploymentSafeLazy(() =>
  import("./pages/connections/connections-page").then((m) => ({ default: m.ConnectionsPage })),
);
const CommandsPage = deploymentSafeLazy(() =>
  import("./pages/commands/commands-page").then((m) => ({ default: m.CommandsPage })),
);
const ApprovalsPage = deploymentSafeLazy(() =>
  import("./components/approvals/approvals-page").then((m) => ({ default: m.ApprovalsPage })),
);
const MemoryPage = deploymentSafeLazy(() =>
  import("./pages/memory/memory-page").then((m) => ({ default: m.MemoryPage })),
);
const ServerGuidePage = deploymentSafeLazy(() =>
  import("./pages/help/server-guide-page").then((m) => ({ default: m.ServerGuidePage })),
);

const ScheduledTasksPage = deploymentSafeLazy(() =>
  import("./pages/scheduled-tasks/scheduled-tasks-surface").then((m) => ({
    default: m.ScheduledTasksSurface,
  })),
);

/** Canonical stable route manifest. Resource routes, aliases, and redirects stay explicit below. */
const STABLE_APPLICATION_ROUTES_V1 = [
  { id: "customize-genie", catalogueTarget: "genie.customization", path: "/customize-genie", element: <GenieCustomizationRoute /> },
  { id: "info", catalogueTarget: "workbench.context", path: "/info", element: <ContextPanel /> },
  { id: "help-server", catalogueTarget: "help.server", path: "/help/server", element: <LazyManagementRoute Page={ServerGuidePage} /> },
  { id: "settings", catalogueTarget: "settings", path: "/settings", element: <LazyManagementRoute Page={SettingsPage} /> },
  { id: "admin", catalogueTarget: "admin", path: "/admin", element: <LazyManagementRoute Page={AdminPage} /> },
  { id: "access-control", catalogueTarget: "admin.access_control", path: ADMIN_ACCESS_CONTROL_ROUTE, element: <LazyManagementRoute Page={AccessControlPage} /> },
  { id: "costs", catalogueTarget: "costs", path: "/costs", element: <LazyManagementRoute Page={CostsPage} /> },
  { id: "skills", catalogueTarget: "skills", path: "/skills", element: <LazyManagementRoute Page={SkillsPage} /> },
  { id: "connections", catalogueTarget: "connections", path: "/connections", element: <LazyManagementRoute Page={ConnectionsPage} /> },
  { id: "commands", catalogueTarget: "commands", path: "/commands", element: <LazyManagementRoute Page={CommandsPage} /> },
  { id: "approvals", catalogueTarget: "approvals", path: "/approvals", element: <LazyManagementRoute Page={ApprovalsPage} /> },
  { id: "memory", catalogueTarget: "memory", path: "/memory", element: <LazyManagementRoute Page={MemoryPage} /> },
  { id: "scheduled-tasks", catalogueTarget: "scheduled_tasks", path: "/scheduled-tasks", element: <LazyManagementRoute Page={ScheduledTasksPage} /> },
] as const;

export const APPLICATION_ROUTE_TARGETS_V1 = STABLE_APPLICATION_ROUTES_V1.map(({ id, catalogueTarget }) => ({ id, catalogueTarget }));

const managementRouteFallback = (
  <div className="px-6 py-10 text-sm text-foreground-muted">Loading…</div>
);

function LazyManagementRoute({
  Page,
}: {
  Page: LazyExoticComponent<ComponentType>;
}) {
  return (
    <Suspense fallback={managementRouteFallback}>
      <Page />
    </Suspense>
  );
}

function DeepLinkMount() {
  useDeepLink();
  return null;
}

export function App({ ownerClaimBootstrap }: { readonly ownerClaimBootstrap?: OwnerClaimRouteBootstrap | null } = {}) {
  // M054 — `/auth/callback` is registered above AuthGate so the
  // @logto/react SDK's `useHandleSignInCallback` runs on the
  // post-redirect URL with no auth gating in front of it. AuthGate
  // would otherwise mask the callback render with the SignInScreen
  // and the SDK's token-store step would never fire.
  //
  // M101 Phase 3 — `/invite/:token` is also outside AuthGate so a cold
  // deep link is observable before sign-in; M104 owns the full wizard.
  // D488 — `/claim` is the hosted first-owner equivalent. Its capability is
  // in a URL fragment only and is removed before the component does work.
  return (
    <>
      <DeepLinkMount />
      <AuthProvider>
        <Routes>
          <Route path="/auth/callback" element={<SignInCallback />} />
          <Route path="/claim" element={<OwnerClaimRedeem bootstrap={ownerClaimBootstrap} />} />
          <Route path="/invite/:token" element={<InviteRedeem />} />
          <Route path="/redeem/:token" element={<InviteRedeem />} />
          <Route path="*" element={<AppShell />} />
        </Routes>
      </AuthProvider>
    </>
  );
}

function AppShell() {
  // D087 UX hotfix — wrap the whole runtime subtree in an error
  // boundary. Without it, a single throw (assistant-ui's duplicate-
  // message-id guard, a stray render error in a tool card, …)
  // unmounted the app and left the user with a blank gray window.
  // The boundary catches, shows a small recovery card with "Try
  // again" + "Reload window" affordances, and the app stays alive.
  return (
    <AppErrorBoundary label="app-root">
      <FirstRunGate>
      <AuthGate>
        <EncryptionReadinessProvider>
        <CryptoDeviceAdmissionGate>
        <InstalledAppsProvider>
        <ProfileProvider>
        <RoomNavigationProvider>
        <WorkspaceArtifactsProvider>
        <DrawerProvider>
        <NautiloRuntimeProvider>
        <EventFeedProvider>
        <NotificationStateProvider>
        <RoomComposerDraftProvider>
        <MaintenanceApplyingBoundary>
        {/* ToastProvider INSIDE runtime so useWsState is available to
            effects that fire toasts (e.g. prolonged-disconnect). Toasts
            can be triggered from any route below. */}
        <ToastProvider>
          {/* D079 Phase 3 — Genie's Workspace context (Surface A).
              Root-app state, always available (always-set default on
              desktop, null on web). Sits ABOVE BrowserColumnProvider
              because Workspace is conceptually broader and because
              both providers publish to the file-context-ref — having
              Workspace outer means the publish order on initial
              mount is deterministic (workspace → currentFolder). */}
          <WorkspaceProvider>
            {/* D057 2a.1 / D079 Phase 1 rename — BrowserColumn context
                owns the tabbed left column's state (active tab,
                currentFolderPath, its keyboard shortcut ⌘⇧B). Inside
                ToastProvider so tab-switch errors / current-folder-change
                confirmations can surface via useToast. */}
            <PostureProvider>
              <BrowserColumnProvider>
                <AppRoutes />
              </BrowserColumnProvider>
            </PostureProvider>
          </WorkspaceProvider>
        </ToastProvider>
        </MaintenanceApplyingBoundary>
        </RoomComposerDraftProvider>
        </NotificationStateProvider>
        </EventFeedProvider>
        </NautiloRuntimeProvider>
        </DrawerProvider>
        </WorkspaceArtifactsProvider>
        </RoomNavigationProvider>
        </ProfileProvider>
        </InstalledAppsProvider>
        </CryptoDeviceAdmissionGate>
        </EncryptionReadinessProvider>
      </AuthGate>
      </FirstRunGate>
    </AppErrorBoundary>
  );
}

/**
 * Inner router component. Exists only so `useDesktopMenu()` is called
 * inside `<BrowserColumnProvider>` — the hook reads `useBrowserColumn()`
 * for the "change-workspace" menu action, so hoisting the call into
 * `App` puts the consumer above its provider in the React tree and the
 * explicit guard in `browser-column.context.tsx:66` throws on mount
 * ("useBrowserColumn must be used within <BrowserColumnProvider>").
 *
 * Diagnosed during review after PR #57 merged — the crash was masked by a
 * missing render-smoke-test in the workbench. See the follow-up note
 * about adding RTL/Vitest scaffolding so we don't repeat this.
 */
function AppRoutes() {
  // D057 2a.4 — subscribe to native menu actions. No-op in browser.
  useDesktopMenu();

  return (
    <SystemPermissionsStartupGate>
    <Routes>
      {/* D510 — the wizard keeps auth, profile, and theme providers but avoids
          the normal Workbench shell so browser Back and direct URLs remain
          ordinary route behavior. Entry points intentionally remain unwired. */}
      <Route path={STABLE_APPLICATION_ROUTES_V1[0].path} element={STABLE_APPLICATION_ROUTES_V1[0].element} />
      <Route element={<WorkbenchShell />}>
        <Route path="/" element={<ActiveRoom />} />
        <Route path="/rooms/:roomId" element={<ActiveRoom />} />
        <Route path="/rooms/:roomId/threads/:threadRoomId" element={<ActiveRoom />} />
        <Route
          path="/admin/encryption"
          element={<main className="p-6"><EncryptionTransitionCard /></main>}
        />
        {STABLE_APPLICATION_ROUTES_V1.slice(1).map((route) => <Route key={route.id} path={route.path} element={route.element} />)}
        <Route path="/help" element={<LazyManagementRoute Page={ServerGuidePage} />} />
        <Route
          path={`${ADMIN_ACCESS_CONTROL_ROUTE}/users/:userId`}
          element={<LazyManagementRoute Page={AccessControlPage} />}
        />
        <Route
          path={`${ADMIN_ACCESS_CONTROL_ROUTE}/:tab`}
          element={<LazyManagementRoute Page={AccessControlPage} />}
        />
        <Route path="/skills/:name" element={<LazyManagementRoute Page={SkillsPage} />} />
        <Route path="/connections/:name" element={<LazyManagementRoute Page={ConnectionsPage} />} />
        <Route path="/commands/:name" element={<LazyManagementRoute Page={CommandsPage} />} />
        <Route path="/memory/:id" element={<LazyManagementRoute Page={MemoryPage} />} />
        {/* Pre-settings placeholders — now live as sections under
            /settings. Redirect so any existing bookmarks / menu
            actions land on the right anchor. Flagged by PR-007
            review (Ni-3). */}
        <Route
          path="/profile"
          element={<Navigate to="/settings#profile" replace />}
        />
        <Route
          path="/keys"
          element={<Navigate to="/admin#provider-credentials" replace />}
        />
      </Route>
    </Routes>
    </SystemPermissionsStartupGate>
  );
}
