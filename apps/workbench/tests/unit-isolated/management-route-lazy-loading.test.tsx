/**
 * M214 Phase 12 — management route lazy-loading adapters.
 *
 * Verifies named-export lazy adapters resolve and that a representative
 * deep-link route renders through Suspense without booting the workbench.
 */
import { act, lazy, Suspense } from "react";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const priorGlobals: Record<string, unknown> = {};
let happyWindow: Window;
let root: Root | null = null;

beforeAll(() => {
  happyWindow = new Window({ url: "https://nautilo.example.test/settings" });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  for (const k of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "localStorage",
    "sessionStorage",
  ] as const) {
    priorGlobals[k] = (globalThis as Record<string, unknown>)[k];
  }
  Object.assign(globalThis, {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    HTMLElement: happyWindow.HTMLElement,
    localStorage: happyWindow.localStorage,
    sessionStorage: happyWindow.sessionStorage,
  });

  mock.module("../../src/pages/settings/settings-page", () => ({
    SettingsPage: () => <main data-testid="lazy-settings-page">Settings</main>,
  }));
});

afterAll(() => {
  act(() => {
    root?.unmount();
    root = null;
  });
  const g = globalThis as Record<string, unknown>;
  for (const key of Object.keys(priorGlobals)) {
    if (priorGlobals[key] === undefined) {
      delete g[key];
    } else {
      g[key] = priorGlobals[key];
    }
  }
  mock.restore();
});

const managementRouteModules = [
  ["settings", () => import("../../src/pages/settings/settings-page"), "SettingsPage"],
  ["admin", () => import("../../src/pages/admin/admin-page"), "AdminPage"],
  ["costs", () => import("../../src/pages/costs/costs-page"), "CostsPage"],
  ["skills", () => import("../../src/pages/skills/skills-page"), "SkillsPage"],
  [
    "connections",
    () => import("../../src/pages/connections/connections-page"),
    "ConnectionsPage",
  ],
  ["commands", () => import("../../src/pages/commands/commands-page"), "CommandsPage"],
  [
    "approvals",
    () => import("../../src/components/approvals/approvals-page"),
    "ApprovalsPage",
  ],
  ["memory", () => import("../../src/pages/memory/memory-page"), "MemoryPage"],
] as const;

describe("management route lazy loading (M214 Phase 12)", () => {
  test("named-export lazy adapters resolve for every management route", async () => {
    for (const [, loadModule, exportName] of managementRouteModules) {
      const mod = await loadModule();
      expect(typeof mod[exportName as keyof typeof mod]).toBe("function");
    }
  });

  test("deep-linked /settings renders after Suspense resolves the lazy chunk", async () => {
    const LazySettingsPage = lazy(() =>
      import("../../src/pages/settings/settings-page").then((m) => ({
        default: m.SettingsPage,
      })),
    );

    const container = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(
        <MemoryRouter initialEntries={["/settings"]}>
          <Routes>
            <Route
              path="/settings"
              element={
                <Suspense fallback={<div data-testid="route-loading">Loading…</div>}>
                  <LazySettingsPage />
                </Suspense>
              }
            />
          </Routes>
        </MemoryRouter>,
      );
    });

    expect(happyWindow.document.querySelector('[data-testid="lazy-settings-page"]')).not.toBeNull();
    expect(happyWindow.document.querySelector('[data-testid="route-loading"]')).toBeNull();
  });
});
