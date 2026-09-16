/**
 * D112 / M106 — claimed-needs-auth passes through FirstRunGate to AuthGate.
 *
 * Stack 19 Phase 6.9.6 lesson: on Linux CI, a prior test file's afterAll
 * can leave `globalThis.window = undefined` (Object.assign with undefined
 * SETS the key). LogtoProvider / react-router then crash on
 * `window.location.origin` and `localStorage` during SSR render. Mirror the
 * happy-dom shim used in first-run-gate.test.tsx.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { LogtoProvider } from "@logto/react";
import type { SetupStatusResponse } from "@nautilo/api-client";
import { Window as HappyWindow } from "happy-dom";
import { FirstRunGateView } from "../../src/components/first-run-gate";
import { LogtoResourceContext } from "../../src/contexts/auth-mode";
import { AuthProvider } from "../../src/hooks/use-auth";

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

describe("FirstRunGate routing — sign-in dialog", () => {
  test("missing providers do not create a second application-route authority", () => {
    const status: SetupStatusResponse = {
      ...baseStatus,
      setupState: "server-needs-keys",
      providers: { hasLlm: false, managedByCloud: false },
      recommendedSetupSurface: { kind: "ask-admin", url: null },
    };
    for (const pathname of ["/", "/help/server", "/settings", "/admin", "/memory"]) {
      const html = renderToStaticMarkup(
        <FirstRunGateView status={status} pathname={pathname} omitGenieSoftPrompt>
          <main>{pathname}</main>
        </FirstRunGateView>,
      );
      expect(html).toContain(`<main>${pathname}</main>`);
      expect(html).not.toContain("first-run-blocking");
    }
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
        <FirstRunGateView status={status} omitGenieSoftPrompt>
          <main data-child>inside</main>
        </FirstRunGateView>,
      ),
    );

    // No FirstRunGate-owned chrome; AuthGate (mounted inside `<main>`)
    // is responsible for rendering <SignInDialog />. We don't render
    // the AuthGate stack here, so just verify the children pass through.
    expect(html).toContain("inside");
    expect(html).not.toContain('data-testid="sign-in-handle"');
    expect(html).not.toContain('data-testid="sign-in-password"');
    expect(html).not.toContain('data-testid="sign-in-device-flow"');
    expect(html).not.toContain("Enter code");
    expect(html).not.toContain("user_code");
    expect(html).not.toContain("verification_uri");
  });
});
