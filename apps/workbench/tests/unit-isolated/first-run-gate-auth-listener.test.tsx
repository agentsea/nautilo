/**
 * M214 Phase 9 — FirstRunGate auth-transition listener contract.
 *
 * Verifies setup-status refresh runs once per new viewerGeneration and
 * ignores credential-only same-viewer transitions while still honoring
 * profile-changed refresh.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import * as React from "react";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { SetupStatusResponse } from "@nautilo/api-client/browser";
import { dispatchAuthTransition } from "../../src/lib/auth-transition";

let happyWindow: Window;

const passThroughStatus: SetupStatusResponse = {
  instanceId: "inst-test",
  serverUrl: "http://127.0.0.1:3001",
  deploymentMode: "local-self-host",
  claimRequired: false,
  setupState: "claimed-needs-auth",
  recommendedSetupSurface: {
    kind: "workbench-admin",
    url: "http://127.0.0.1:3001",
  },
};

let FirstRunGate: (typeof import("../../src/components/first-run-gate"))["FirstRunGate"];

type ApiMod = typeof import("../../src/lib/api");
let apiClient: ApiMod["apiClient"];
let originalGetSetupStatus: ApiMod["apiClient"]["getSetupStatus"];

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

  mock.restore();
  mock.module("../../src/lib/desktop", () => ({
    isDesktop: false,
    desktopAPI: null,
    canSwitchDesktopServer: () => false,
    getShellStateOnBoot: () => null,
    computeInitialLastOpenAtSeed: (input: {
      hasEverBeenOpen: boolean;
      shellStateOnBoot: import("../../src/lib/desktop").ShellStateOnBoot | null;
      now: number;
    }) => (input.hasEverBeenOpen ? input.now : null),
  }));

  realUseCan = await import("../../src/hooks/use-can");
  mock.module("../../src/hooks/use-can", () => ({ useCan: () => () => false }));

  const [apiMod, gateMod] = await Promise.all([
    import("../../src/lib/api"),
    import("../../src/components/first-run-gate"),
  ]);
  apiClient = apiMod.apiClient;
  FirstRunGate = gateMod.FirstRunGate;

  originalGetSetupStatus =
    typeof apiClient.getSetupStatus === "function"
      ? apiClient.getSetupStatus.bind(apiClient)
      : ((async () => passThroughStatus) as typeof apiClient.getSetupStatus);
});

afterAll(async () => {
  apiClient.getSetupStatus = originalGetSetupStatus;
  mock.module("../../src/hooks/use-can", () => realUseCan);
  mock.restore();
  await new Promise<void>((r) => setTimeout(r, 50));
  const g = globalThis as Record<string, unknown>;
  for (const key of Object.keys(priorGlobals)) {
    if (priorGlobals[key] === undefined) {
      delete g[key];
    } else {
      g[key] = priorGlobals[key];
    }
  }
});

async function flush(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 0));
}

async function mountGate(): Promise<{ root: Root; host: HTMLDivElement; spy: ReturnType<typeof mock> }> {
  const getSetupStatusSpy = mock(async () => passThroughStatus);
  apiClient.getSetupStatus = getSetupStatusSpy as typeof apiClient.getSetupStatus;

  const host = happyWindow.document.createElement("div");
  happyWindow.document.body.appendChild(host);
  const root: Root = createRoot(host as unknown as HTMLElement);
  root.render(
    <MemoryRouter>
      <FirstRunGate>
        <div data-testid="m214-child">inside</div>
      </FirstRunGate>
    </MemoryRouter>,
  );

  for (let i = 0; i < 80; i++) {
    if (getSetupStatusSpy.mock.calls.length >= 1) break;
    await flush();
  }

  return { root, host, spy: getSetupStatusSpy };
}

describe("FirstRunGate auth listener (M214)", () => {
  test("initial mount fetches setup status once", async () => {
    const { root, host, spy } = await mountGate();
    expect(spy.mock.calls.length).toBe(1);

    root.unmount();
    host.remove();
    apiClient.getSetupStatus = originalGetSetupStatus;
  });

  test("credential-only refresh for same viewer generation is ignored after first auth event", async () => {
    const { root, host, spy } = await mountGate();
    expect(spy.mock.calls.length).toBe(1);

    dispatchAuthTransition({
      credentialGeneration: 2,
      viewerGeneration: 5,
      reason: "signed-in",
    });
    for (let i = 0; i < 40; i++) {
      if (spy.mock.calls.length >= 2) break;
      await flush();
    }
    expect(spy.mock.calls.length).toBe(2);

    dispatchAuthTransition({
      credentialGeneration: 3,
      viewerGeneration: 5,
      reason: "credential-refreshed",
    });
    await flush();
    await flush();
    expect(spy.mock.calls.length).toBe(2);

    root.unmount();
    host.remove();
    apiClient.getSetupStatus = originalGetSetupStatus;
  });

  test("viewer generation change triggers another setup-status refresh", async () => {
    const { root, host, spy } = await mountGate();
    expect(spy.mock.calls.length).toBe(1);

    dispatchAuthTransition({
      credentialGeneration: 2,
      viewerGeneration: 5,
      reason: "signed-in",
    });
    for (let i = 0; i < 40; i++) {
      if (spy.mock.calls.length >= 2) break;
      await flush();
    }

    dispatchAuthTransition({
      credentialGeneration: 3,
      viewerGeneration: 6,
      reason: "user-switched",
    });
    for (let i = 0; i < 40; i++) {
      if (spy.mock.calls.length >= 3) break;
      await flush();
    }
    expect(spy.mock.calls.length).toBe(3);

    root.unmount();
    host.remove();
    apiClient.getSetupStatus = originalGetSetupStatus;
  });

  test("profile-changed still refreshes setup status", async () => {
    const { root, host, spy } = await mountGate();
    expect(spy.mock.calls.length).toBe(1);

    window.dispatchEvent(new happyWindow.Event("nautilo:profile-changed"));
    for (let i = 0; i < 40; i++) {
      if (spy.mock.calls.length >= 2) break;
      await flush();
    }
    expect(spy.mock.calls.length).toBe(2);

    root.unmount();
    host.remove();
    apiClient.getSetupStatus = originalGetSetupStatus;
  });
});
