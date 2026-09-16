/**
 * D112 — `FirstRunGateView` renders the expected blocking / banner surfaces.
 *
 * Stack 19 Phase 6.9.6 amend 3 (2026-05-17): on Linux CI this file
 * crashed during render because LogtoProvider / react-router internally
 * read `window.location.origin` and `localStorage`. Bun's no-DOM-by-
 * default mode leaves both undefined. On macOS the failure was masked
 * (Bun's local env diverges; possibly different jsdom-ish defaults).
 * The original CI for ff127040 also didn't show it because the test
 * runner crashed earlier on mock-pollution SyntaxErrors; after the
 * Phase 6.9.6 mock-pollution fix unblocked the runner, this latent
 * crash surfaced.
 *
 * Fix: install a minimal happy-dom window+document via the
 * `beforeAll` hook before the SSR render. We use the same shape as
 * `first-run-gate-disconnected-boot.test.tsx` — capture priorGlobals,
 * assign happy-dom shims, restore via key-delete in afterAll.
 */
import { afterAll, beforeAll, describe, test, expect } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { LogtoProvider } from "@logto/react";
import type { SetupStatusResponse } from "@nautilo/api-client";
import { Window as HappyWindow } from "happy-dom";
import {
  FirstRunGateView,
  shouldRenderGenieSoftPrompt,
} from "../../src/components/first-run-gate";
import { LogtoResourceContext } from "../../src/contexts/auth-mode";
import { AuthProvider } from "../../src/hooks/use-auth";

// M126 follow-up: lazy-instantiate happy-dom inside `beforeAll`
// (see fallback-section.test.tsx / save-to-disk.test.ts for context —
// module-top construction cascades into "Export named X not found"
// errors on Linux Bun 1.3.11 once the workbench turbo cache busts).
let happyWindow: HappyWindow;

const priorGlobals: Record<string, unknown> = {};

beforeAll(() => {
  happyWindow = new HappyWindow({ url: "http://127.0.0.1:3001/" });
  for (const k of ["window", "document", "navigator", "localStorage", "sessionStorage"] as const) {
    priorGlobals[k] = (globalThis as Record<string, unknown>)[k];
  }
  Object.assign(globalThis, {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    localStorage: happyWindow.localStorage,
    sessionStorage: happyWindow.sessionStorage,
  });
});

afterAll(() => {
  // Delete keys that were originally undefined to avoid poisoning
  // subsequent test files (Object.assign with undefined SETS the
  // key on the target; same lesson as the disconnected-boot sibling).
  const g = globalThis as Record<string, unknown>;
  for (const key of Object.keys(priorGlobals)) {
    if (priorGlobals[key] === undefined) {
      delete g[key];
    } else {
      g[key] = priorGlobals[key];
    }
  }
});

const unitLogtoConfig = {
  endpoint: "http://127.0.0.1:3001",
  appId: "unit-test-workbench-app",
  resources: ["https://api.nautilo.local"] as [string, ...string[]],
  scopes: ["openid", "offline_access", "profile", "email"],
};

function wrapClaimedAuth(tree: ReactElement) {
  return (
    <LogtoProvider config={unitLogtoConfig}>
      <MemoryRouter>
        <LogtoResourceContext.Provider
          value={{
            logtoResource: "https://api.nautilo.local",
            logtoEndpoint: "",
          }}
        >
          <AuthProvider>{tree}</AuthProvider>
        </LogtoResourceContext.Provider>
      </MemoryRouter>
    </LogtoProvider>
  );
}

const baseStatus: Omit<SetupStatusResponse, "setupState" | "recommendedSetupSurface"> = {
  instanceId: "inst-test",
  serverUrl: "http://127.0.0.1:3001",
  deploymentMode: "local-self-host",
  claimRequired: false,
};

describe("FirstRunGateView (D112)", () => {
  test("fresh-unclaimed gives honest controller recovery guidance, not a circular link", () => {
    const status: SetupStatusResponse = {
      ...baseStatus,
      setupState: "fresh-unclaimed",
      recommendedSetupSurface: {
        kind: "electron-onboarding",
        url: "http://127.0.0.1:3001/",
      },
    };
    const html = renderToStaticMarkup(
      <FirstRunGateView status={status}>
        <main>child</main>
      </FirstRunGateView>,
    );
    expect(html).toContain("data-testid=\"first-run-blocking\"");
    expect(html).toContain("Finish claiming");
    expect(html).toContain("run the exact resume command");
    expect(html).toContain("reissue a fresh claim");
    expect(html).toContain("Check again");
    expect(html).not.toContain("Open onboarding");
    expect(html).not.toContain('href="http://127.0.0.1:3001/"');
    expect(html).not.toContain("child");
  });

  test("claimed-needs-auth passes through to children (AuthGate owns the dialog under M106)", () => {
    const status: SetupStatusResponse = {
      ...baseStatus,
      setupState: "claimed-needs-auth",
      recommendedSetupSurface: {
        kind: "workbench-admin",
        url: "http://127.0.0.1:3001",
      },
    };
    const html = renderToStaticMarkup(
      wrapClaimedAuth(
        <FirstRunGateView status={status}>
          <main data-child>inside</main>
        </FirstRunGateView>,
      ),
    );
    // M106: FirstRunGate just passes through; the AuthGate child owns
    // the <SignInDialog />.
    expect(html).toContain("inside");
  });

  test("server-needs-keys never blocks authenticated application routes", () => {
    const status: SetupStatusResponse = {
      ...baseStatus,
      setupState: "server-needs-keys",
      viewer: {
        serverRole: "admin",
        genieCustomized: true,
        byokConfigured: false,
      },
      providers: { hasLlm: false, managedByCloud: false },
      recommendedSetupSurface: { kind: "workbench-admin", url: "/admin#provider-credentials" },
    };
    for (const pathname of ["/", "/help/server", "/admin", "/settings"]) {
      const html = renderToStaticMarkup(
        <FirstRunGateView status={status} pathname={pathname}>
          <span>application content</span>
        </FirstRunGateView>,
      );
      expect(html).toContain("application content");
      expect(html).not.toContain("Provider keys required");
      expect(html).not.toContain("first-run-blocking");
    }
  });

  test("ready renders children only (Genie prompt needs client hooks)", () => {
    const status: SetupStatusResponse = {
      ...baseStatus,
      setupState: "ready",
      viewer: {
        serverRole: "admin",
        genieCustomized: true,
        byokConfigured: false,
      },
      providers: { hasLlm: true, managedByCloud: false },
      recommendedSetupSurface: { kind: "cli", url: null },
    };
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <FirstRunGateView status={status} omitGenieSoftPrompt>
          <main>chat</main>
        </FirstRunGateView>
      </MemoryRouter>,
    );
    expect(html).toContain("chat");
    expect(html).not.toContain("first-run-blocking");
  });

  test("the Server Guide suppresses the competing Genie prompt", () => {
    const status: SetupStatusResponse = {
      ...baseStatus,
      setupState: "ready",
      viewer: {
        serverRole: "owner",
        genieCustomized: false,
        byokConfigured: false,
      },
      providers: { hasLlm: true, managedByCloud: false },
      recommendedSetupSurface: { kind: "cli", url: null },
    };
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/help/server"]}>
        <FirstRunGateView status={status} pathname="/help/server">
          <main>server guide</main>
        </FirstRunGateView>
      </MemoryRouter>,
    );

    expect(html).toContain("server guide");
    expect(html).not.toContain("Genie customization");
    expect(shouldRenderGenieSoftPrompt("/help/server", false)).toBe(false);
    expect(shouldRenderGenieSoftPrompt("/", false)).toBe(true);
    expect(shouldRenderGenieSoftPrompt("/", true)).toBe(false);
  });
});
