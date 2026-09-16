/**
 * D154 Finding B — setup-status preflight must not block workbench mount
 * when Electron reports a cold-boot non-live shell state.
 *
 * All `../../src/*` imports are dynamic inside `beforeAll` so `lib/desktop`
 * loads only after `window.nautiloDesktop` exists (otherwise `desktopAPI`
 * freezes to `null` for the whole worker). No `mock.module` — it poisons
 * the shared barrel for other test files.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import * as React from "react";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SetupStatusResponse } from "@nautilo/api-client/browser";

// M126 follow-up: lazy-instantiate happy-dom inside `beforeAll`
// (see fallback-section.test.tsx / save-to-disk.test.ts for context —
// Bun 1.3.11 on Linux cascades module-top globals into other suites'
// module evaluation as "Export named X not found").
let happyWindow: Window;

let shellBootReturn: "live" | "disconnected" | "wrong-server" | "no-pairing" | null =
  "disconnected";

const readyStatus: SetupStatusResponse = {
  instanceId: "inst-test",
  serverUrl: "http://127.0.0.1:3001",
  deploymentMode: "local-self-host",
  claimRequired: false,
  setupState: "ready",
  viewer: {
    serverRole: "admin",
    genieCustomized: true,
    byokConfigured: false,
  },
  providers: { hasLlm: true, managedByCloud: false },
  recommendedSetupSurface: { kind: "cli", url: null },
};

const unitLogtoConfig = {
  endpoint: "http://127.0.0.1:3001",
  appId: "unit-test-workbench-app",
  resources: ["https://api.nautilo.local"] as [string, ...string[]],
  scopes: ["openid", "offline_access", "profile", "email"],
};

let FirstRunGate: (typeof import("../../src/components/first-run-gate"))["FirstRunGate"];

type ApiMod = typeof import("../../src/lib/api");
let apiClient: ApiMod["apiClient"];
let originalGetSetupStatus: ApiMod["apiClient"]["getSetupStatus"];

let LogtoProvider: (typeof import("@logto/react"))["LogtoProvider"];
let MemoryRouter: (typeof import("react-router-dom"))["MemoryRouter"];
let LogtoResourceContext: (typeof import("../../src/contexts/auth-mode"))["LogtoResourceContext"];
let AuthProvider: (typeof import("../../src/hooks/use-auth"))["AuthProvider"];
// M129 — FirstRunGate now calls `useCan()` (→ useAuth → AuthContext). Under
// Bun CI, a sibling suite's leaked passthrough `AuthProvider` mock provides
// no context, so useAuth would throw inside FirstRunGate. Mock `use-can` to
// a context-free stub so this suite tests its OWN concern (setup-status
// fetch gating) without depending on auth-context wiring, and restore the
// real module in afterAll (Bun CI does not un-replace via mock.restore()).
let realUseCan: typeof import("../../src/hooks/use-can");

const priorGlobals: Record<string, unknown> = {};

beforeAll(async () => {
  happyWindow = new Window({ url: "http://127.0.0.1:3001/" });
  for (const k of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "customElements",
    "localStorage",
    "sessionStorage",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ] as const) {
    priorGlobals[k] = (globalThis as Record<string, unknown>)[k];
  }

  Object.assign(globalThis, {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    HTMLElement: happyWindow.HTMLElement,
    customElements: happyWindow.customElements,
    localStorage: happyWindow.localStorage,
    sessionStorage: happyWindow.sessionStorage,
    requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
    cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
  });

  (happyWindow as unknown as { nautiloDesktop: { shellStateOnBoot: () => typeof shellBootReturn } })
    .nautiloDesktop = {
    shellStateOnBoot: () => shellBootReturn,
  };

  // Sibling suites (e.g. workbench-account-menu) mock.module `lib/desktop` with a
  // stub getShellStateOnBoot. Re-pin a bridge-aware implementation before
  // first-run-gate loads so D154 skip reads `window.nautiloDesktop`, not null.
  mock.restore();
  mock.module("../../src/lib/desktop", () => ({
    isDesktop: true,
    desktopAPI: null,
    canSwitchDesktopServer: () => false,
    getShellStateOnBoot: () => {
      if (typeof window === "undefined") return null;
      const api = (window as unknown as {
        nautiloDesktop?: { shellStateOnBoot?: () => import("../../src/lib/desktop").ShellStateOnBoot };
      }).nautiloDesktop;
      const fn = api?.shellStateOnBoot;
      if (typeof fn !== "function") return null;
      try {
        return fn();
      } catch {
        return null;
      }
    },
    computeInitialLastOpenAtSeed: (input: {
      hasEverBeenOpen: boolean;
      shellStateOnBoot: import("../../src/lib/desktop").ShellStateOnBoot | null;
      now: number;
    }) => {
      const base = input.hasEverBeenOpen ? input.now : null;
      const boot = input.shellStateOnBoot;
      if (boot != null && boot !== "live" && base === null) {
        return input.now;
      }
      return base;
    },
  }));

  realUseCan = await import("../../src/hooks/use-can");
  mock.module("../../src/hooks/use-can", () => ({ useCan: () => () => false }));

  const [apiMod, gateMod, logtoMod, routerMod, authModeMod, useAuthMod] = await Promise.all([
    import("../../src/lib/api"),
    import("../../src/components/first-run-gate"),
    import("@logto/react"),
    import("react-router-dom"),
    import("../../src/contexts/auth-mode"),
    import("../../src/hooks/use-auth"),
  ]);
  apiClient = apiMod.apiClient;
  FirstRunGate = gateMod.FirstRunGate;
  LogtoProvider = logtoMod.LogtoProvider;
  MemoryRouter = routerMod.MemoryRouter;
  LogtoResourceContext = authModeMod.LogtoResourceContext;
  AuthProvider = useAuthMod.AuthProvider;

  // Defensive: an earlier test in the same worker may have done
  // `mock.module("../../src/lib/api", ...)` with a partial stub that
  // omits methods our render path touches (setTokenProvider, setToken,
  // whoami via AuthProvider → useViewerAuth). Polyfill no-ops so the
  // tree mounts cleanly. Each test still overwrites getSetupStatus with
  // its own spy.
  const apiAny = apiClient as unknown as Record<string, unknown>;
  if (typeof apiAny.setTokenProvider !== "function") {
    apiAny.setTokenProvider = () => undefined;
  }
  if (typeof apiAny.setToken !== "function") {
    apiAny.setToken = () => undefined;
  }
  if (typeof apiAny.whoami !== "function") {
    apiAny.whoami = async () => ({ sessionUserId: null, groups: [] });
  }
  originalGetSetupStatus =
    typeof apiClient.getSetupStatus === "function"
      ? apiClient.getSetupStatus.bind(apiClient)
      : ((async () => readyStatus) as typeof apiClient.getSetupStatus);
});

afterAll(async () => {
  apiClient.getSetupStatus = originalGetSetupStatus;
  mock.module("../../src/hooks/use-can", () => realUseCan);
  mock.restore();
  await new Promise<void>((r) => setTimeout(r, 50));
  // Stack 19 Phase 6.9.6 amend (2026-05-17): `Object.assign` SETS
  // each key — including the undefined ones — which on Linux CI
  // leaves `globalThis.window = undefined` for subsequent test
  // files that did NOT have window pre-defined originally. That
  // breaks the FirstRunGateView (D112) suite (LogtoProvider /
  // React Router read window.location.origin during render). Local
  // macOS hides this because Bun's default env differs. Restore
  // by DELETING keys whose original value was undefined; only set
  // keys that had a concrete value.
  const g = globalThis as Record<string, unknown>;
  for (const key of Object.keys(priorGlobals)) {
    if (priorGlobals[key] === undefined) {
      delete g[key];
    } else {
      g[key] = priorGlobals[key];
    }
  }
});

function wrapForReadyGate(tree: React.ReactElement): React.ReactElement {
  return React.createElement(
    LogtoProvider,
    { config: unitLogtoConfig },
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(
        LogtoResourceContext.Provider,
        {
          value: {
            logtoResource: "https://api.nautilo.local",
            logtoEndpoint: "",
          },
        },
        React.createElement(AuthProvider, null, tree),
      ),
    ),
  );
}

async function flush(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 0));
}

describe("FirstRunGate D154 Finding B (setup-status bypass)", () => {
  test("static: D154 markers wrap skip branch in first-run-gate.tsx", () => {
    const path = join(import.meta.dir, "../../src/components/first-run-gate.tsx");
    const src = readFileSync(path, "utf8");
    const start = src.indexOf("// <D154-finding-B-setup-status-bypass>");
    const end = src.indexOf("// </D154-finding-B-setup-status-bypass>");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const slice = src.slice(start, end);
    expect(slice).toContain("skipSetupStatusPreflight");
    expect(slice).not.toContain("void refresh()");
  });

  test("disconnected cold boot → zero setup-status fetch; child mounts; no error banner", async () => {
    shellBootReturn = "disconnected";
    const getSetupStatusSpy = mock(async () => readyStatus);
    apiClient.getSetupStatus = getSetupStatusSpy as typeof apiClient.getSetupStatus;

    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root: Root = createRoot(host as unknown as HTMLElement);
    // M129 — `useCan` is mocked context-free for this suite (see beforeAll),
    // so FirstRunGate renders without an AuthProvider just as it did before.
    root.render(
      <MemoryRouter>
        <FirstRunGate>
          <div data-testid="d154-child">inside</div>
        </FirstRunGate>
      </MemoryRouter>,
    );

    let child: ReturnType<typeof host.querySelector> = null;
    for (let i = 0; i < 80; i++) {
      child = host.querySelector('[data-testid="d154-child"]');
      if (child) break;
      await flush();
    }

    expect(getSetupStatusSpy).toHaveBeenCalledTimes(0);
    expect(child).not.toBeNull();
    expect(host.innerHTML).not.toContain("setup-status-fetch-failed");

    root.unmount();
    host.remove();
    apiClient.getSetupStatus = originalGetSetupStatus;
  });

  test("live-equivalent boot (null shell) → setup-status fetch runs", async () => {
    shellBootReturn = null;
    const getSetupStatusSpy = mock(async () => readyStatus);
    apiClient.getSetupStatus = getSetupStatusSpy as typeof apiClient.getSetupStatus;

    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root: Root = createRoot(host as unknown as HTMLElement);
    root.render(
      wrapForReadyGate(
        <FirstRunGate>
          <div data-testid="d154-child">inside</div>
        </FirstRunGate>,
      ),
    );

    // LogtoProvider + AuthProvider can defer FirstRunGate commit on Linux CI;
    // poll until the setup-status preflight fires (do not rely on two ticks).
    for (let i = 0; i < 80; i++) {
      if (getSetupStatusSpy.mock.calls.length >= 1) break;
      await flush();
    }

    expect(getSetupStatusSpy.mock.calls.length).toBeGreaterThanOrEqual(1);

    root.unmount();
    host.remove();
    apiClient.getSetupStatus = originalGetSetupStatus;
  });
});
