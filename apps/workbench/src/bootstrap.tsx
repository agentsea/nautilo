import { StrictMode, useEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { LogtoProvider } from "@logto/react";
import type { LogtoConfig } from "@logto/browser";
import { App } from "./app";
import { LogtoResourceContext, type LogtoResourceConfig } from "./contexts/auth-mode";
import { resolveInitialTheme } from "./hooks/use-theme";
import { apiClient } from "./lib/api";
import { NautiloWorkbenchLogtoClient } from "./lib/nautilo-logto-browser-client";
import { isDesktop } from "./lib/desktop";
import { applyRootInterfaceEntry } from "./lib/interface-preference";
import {
  captureOwnerClaimRouteBootstrap,
  type OwnerClaimRouteBootstrap,
} from "./lib/owner-claim-entry";

const DEFAULT_LOGTO_RESOURCE = "https://api.nautilo.local";

const BOOTSTRAP_JS_START_MARK = "nautilo:workbench:bootstrap-js-start";
const BOOTSTRAP_FRAME_COMMIT_MARK = "nautilo:workbench:bootstrap-frame-commit";
const BOOTSTRAP_FRAME_MEASURE = "nautilo:workbench:bootstrap-frame";

type Health = Awaited<ReturnType<typeof apiClient.getHealth>>;

type BootstrapState =
  | { kind: "loading" }
  | { kind: "ready"; authConfig: LogtoResourceConfig; logtoConfig: LogtoConfig }
  | { kind: "error"; message: string };

export interface WorkbenchBootstrapOptions {
  rootElement?: Element | DocumentFragment;
  getHealth?: () => Promise<Health>;
  createRoot?: typeof createRoot;
  /** Test seam for the synchronous, pre-bootstrap root-entry redirect. */
  interfaceEntry?: () => boolean;
}

/**
 * Apply the theme class to <html> before the first React frame. Default is
 * dark unless the user explicitly chose light.
 */
export function applyInitialThemeClass(): void {
  if (typeof document === "undefined") return;
  const theme = resolveInitialTheme(
    typeof window === "undefined" ? null : window.localStorage,
  );
  document.documentElement.classList.toggle("dark", theme === "dark");
}

function BootstrapFrame() {
  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-background p-6"
      data-testid="workbench-bootstrap-frame"
    >
      <div className="max-w-md rounded-lg border border-border-strong bg-background-panel p-8 shadow-xl">
        <h1 className="text-xl font-semibold text-primary">Starting Nautilo Workbench</h1>
        <p className="mt-3 text-sm text-foreground-muted">Establishing a secure connection…</p>
      </div>
    </div>
  );
}

function BootstrapErrorScreen({ message }: { message: string }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background p-6">
      <div className="max-w-md rounded-lg border border-border-strong bg-background-panel p-8 shadow-xl">
        <h1 className="text-xl font-semibold text-primary">Cannot start workbench</h1>
        <p className="mt-3 text-sm text-foreground-muted">{message}</p>
        <p className="mt-4 text-xs text-foreground-muted">
          Ensure the Nautilo server is running and Logto is configured, then reload this page.
        </p>
      </div>
    </div>
  );
}

function BootstrapScreen({ state }: { state: Extract<BootstrapState, { kind: "loading" | "error" }> }) {
  if (state.kind === "loading") return <BootstrapFrame />;
  return <BootstrapErrorScreen message={state.message} />;
}

function createWorkbenchRouter(
  authConfig: LogtoResourceConfig,
  ownerClaimBootstrap: OwnerClaimRouteBootstrap | null,
) {
  return createBrowserRouter([{
    path: "*",
    element: (
      <LogtoResourceContext.Provider value={authConfig}>
        <App ownerClaimBootstrap={ownerClaimBootstrap} />
      </LogtoResourceContext.Provider>
    ),
  }]);
}

function ReadyWorkbenchRoot({
  state,
  router,
}: {
  state: Extract<BootstrapState, { kind: "ready" }>;
  router: ReturnType<typeof createWorkbenchRouter>;
}) {
  useEffect(() => () => router.dispose(), [router]);
  return (
    <StrictMode>
      <LogtoProvider config={state.logtoConfig} LogtoClientClass={NautiloWorkbenchLogtoClient}>
        <RouterProvider router={router} />
      </LogtoProvider>
    </StrictMode>
  );
}

function toBootstrapState(health: Health): BootstrapState {
  if (!health.logtoEndpoint || !health.logtoWorkbenchAppId) {
    return {
      kind: "error",
      message: "Server health response is missing Logto configuration (endpoint / workbench app id).",
    };
  }

  const resource = health.logtoResource ?? DEFAULT_LOGTO_RESOURCE;
  return {
    kind: "ready",
    authConfig: {
      logtoResource: resource,
      logtoEndpoint: health.logtoEndpoint,
      redirectOrigins: [health.serverUrl, health.workbenchUrl].filter(
        (url): url is string => typeof url === "string" && url.length > 0,
      ),
    },
    logtoConfig: {
      endpoint: health.logtoEndpoint,
      appId: health.logtoWorkbenchAppId,
      resources: [resource],
      scopes: ["openid", "offline_access", "profile", "email"],
    },
  };
}

function markFirstFrameCommit(): void {
  if (typeof performance === "undefined") return;
  performance.mark(BOOTSTRAP_FRAME_COMMIT_MARK);
  performance.measure(BOOTSTRAP_FRAME_MEASURE, BOOTSTRAP_JS_START_MARK, BOOTSTRAP_FRAME_COMMIT_MARK);
}

/**
 * Mount one root immediately with a non-privileged frame, then refine that
 * same root after `/health` yields the Logto configuration.
 */
export async function startWorkbenchBootstrap(
  options: WorkbenchBootstrapOptions = {},
): Promise<void> {
  const redirected = options.interfaceEntry
    ? options.interfaceEntry()
    : typeof window !== "undefined" && applyRootInterfaceEntry(window, isDesktop);
  if (redirected) return;
  if (typeof performance !== "undefined") performance.mark(BOOTSTRAP_JS_START_MARK);
  const ownerClaimBootstrap = captureOwnerClaimRouteBootstrap();
  const rootElement = options.rootElement ?? document.getElementById("root");
  if (!rootElement) throw new Error("Workbench root element is missing.");

  const root = (options.createRoot ?? createRoot)(rootElement);
  flushSync(() => {
    root.render(
      <StrictMode>
        <BootstrapScreen state={{ kind: "loading" }} />
      </StrictMode>,
    );
  });
  markFirstFrameCommit();

  let state: BootstrapState;
  try {
    state = toBootstrapState(await (options.getHealth ?? (() => apiClient.getHealth()))());
  } catch (error) {
    state = {
      kind: "error",
      message:
        error instanceof Error
          ? `Could not reach the server: ${error.message}`
          : "Could not reach the server (health check failed).",
    };
  }

  if (state.kind === "ready") {
    const router = createWorkbenchRouter(state.authConfig, ownerClaimBootstrap);
    root.render(<ReadyWorkbenchRoot state={state} router={router} />);
  } else {
    root.render(
      <StrictMode>
        <BootstrapScreen state={state} />
      </StrictMode>,
    );
  }
}
