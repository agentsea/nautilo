import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement, type ComponentType, useEffect } from "react";
import { createRoot } from "react-dom/client";

const browser = new Window();
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
});

type AppStateValue = "active" | "background" | "inactive";
type AppStateListener = (next: AppStateValue) => void;
type Scope = { serverId: string; userId: string; actorId: string };

let focused = true;
const appStateListeners = new Set<AppStateListener>();

type ObservedController = {
  loads: number;
  scopes: Array<Scope | null>;
  data: {
    subscribe(listener: () => void): () => void;
    getState(): Readonly<Record<string, unknown>>;
  };
  setScope(scope: Scope | null): void;
  load(): Promise<{ status: "applied" }>;
};

const capabilityControllers: ObservedController[] = [];
const costControllers: ObservedController[] = [];

function observedController(): ObservedController {
  const snapshot = {
    scope: null,
    data: null,
    draft: null,
    loading: false,
    mutating: false,
    loadError: null,
    mutationError: null,
  };
  return {
    loads: 0,
    scopes: [],
    data: {
      subscribe: () => () => {},
      getState: () => snapshot,
    },
    setScope(scope) {
      this.scopes.push(scope);
    },
    async load() {
      this.loads += 1;
      return { status: "applied" };
    },
  };
}

const element = (tag: string) => ({ children }: { children?: unknown }) =>
  createElement(tag, null, children as never);
const Stack = Object.assign(element("div"), { Screen: element("div") });

mock.module("react-native", () => ({
  ActivityIndicator: element("span"),
  AppState: {
    addEventListener: (_event: "change", listener: AppStateListener) => {
      appStateListeners.add(listener);
      return { remove: () => appStateListeners.delete(listener) };
    },
  },
  Pressable: element("button"),
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Text: element("span"),
  View: element("div"),
}));
mock.module("expo-router", () => ({
  Stack,
  router: { back() {}, canGoBack: () => false, push() {}, replace() {} },
  useFocusEffect: (effect: () => void | (() => void)) => {
    useEffect(() => focused ? effect() : undefined, [effect, focused]);
  },
  useLocalSearchParams: () => ({ role: "researcher" }),
}));
mock.module("@/components/app-bar", () => ({
  AppBar: element("header"),
  AppBarBackButton: element("button"),
}));
mock.module("@/components/screen", () => ({ Screen: element("main") }));
mock.module("@/components/settings/settings-picker-screen", () => ({
  SettingsPickerScreen: element("section"),
}));
mock.module("@/components/settings/settings-status", () => ({
  SettingsStatus: element("div"),
}));
mock.module("@/features/settings/personal-capability-preferences-controller", () => ({
  createPersonalCapabilityPreferencesController: () => {
    const controller = observedController();
    capabilityControllers.push(controller);
    return controller;
  },
  personalCapabilityPreferenceErrorMessage: () => "error",
}));
mock.module("@/features/settings/personal-account-controller", () => ({
  createPersonalCostsController: () => {
    const controller = observedController();
    costControllers.push(controller);
    return controller;
  },
  personalAccountErrorMessage: () => "error",
}));

const activeServer = { id: "server-a", serverUrl: "https://server.invalid" };
const viewer = { userId: "human-a", actorId: "actor-a" };
mock.module("@/providers/server-registry", () => ({
  useServers: () => ({ activeServer }),
}));
mock.module("@/providers/auth", () => ({
  useAuth: () => ({ status: "signed-in", viewer, viewerState: "verified" }),
}));
mock.module("@/providers/theme", () => ({
  useAppTheme: () => ({
    color: {
      border: { default: "#999" },
      brand: { accent: "#00f" },
      status: { success: "#090", warning: "#990" },
      surface: { background: "#fff", panel: "#eee", subtle: "#ddd" },
      text: { foreground: "#000", muted: "#666" },
    },
    radii: { lg: 12, md: 8, pill: 999 },
    spacing: { sm: 8, md: 12, lg: 16, xl: 24 },
    typography: { body: {}, bodyStrong: {}, caption: {}, heading: {}, label: {}, subheading: {} },
  }),
}));
mock.module("@/lib/api", () => ({
  getApiClient: () => { throw new Error("the route must use its injected controller"); },
}));

const { default: CapabilityModelsScreen } = await import(
  "../../app/(drawer)/(tabs)/settings/capability-models"
);
const { default: CapabilityModelPickerScreen } = await import(
  "../../app/(drawer)/(tabs)/settings/capability-model-picker"
);
const { default: PersonalCostsScreen } = await import(
  "../../app/(drawer)/(tabs)/settings/personal-costs"
);

async function renderRoute(Component: ComponentType) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = async () => {
    await act(async () => {
      root.render(createElement(Component));
      await Promise.resolve();
    });
  };
  await render();
  return {
    render,
    close: async () => {
      await act(async () => {
        root.unmount();
        await Promise.resolve();
      });
      host.remove();
    },
  };
}

async function emitAppState(next: AppStateValue): Promise<void> {
  await act(async () => {
    for (const listener of [...appStateListeners]) listener(next);
    await Promise.resolve();
  });
}

beforeEach(() => {
  focused = true;
  appStateListeners.clear();
  capabilityControllers.length = 0;
  costControllers.length = 0;
});

describe("personal settings resume refresh", () => {
  const cases: ReadonlyArray<{
    name: string;
    Component: ComponentType;
    controllers: ObservedController[];
  }> = [
    { name: "capability models", Component: CapabilityModelsScreen, controllers: capabilityControllers },
    { name: "capability model picker", Component: CapabilityModelPickerScreen, controllers: capabilityControllers },
    { name: "personal costs", Component: PersonalCostsScreen, controllers: costControllers },
  ];

  for (const { name, Component, controllers } of cases) {
    test(`${name} refreshes on active resume only while focused and cleans up`, async () => {
      const route = await renderRoute(Component);
      const controller = controllers.at(-1)!;
      try {
        expect(controller.loads).toBe(1);
        expect(controller.scopes.at(-1)).toEqual({
          serverId: "server-a",
          userId: "human-a",
          actorId: "actor-a",
        });
        expect(appStateListeners.size).toBe(1);

        await emitAppState("background");
        expect(controller.loads).toBe(1);
        await emitAppState("active");
        expect(controller.loads).toBe(2);

        focused = false;
        await route.render();
        expect(controller.scopes.at(-1)).toBeNull();
        await emitAppState("active");
        expect(controller.loads).toBe(2);

        focused = true;
        await route.render();
        expect(controller.loads).toBe(3);
      } finally {
        await route.close();
      }
      expect(controller.scopes.at(-1)).toBeNull();
      expect(appStateListeners.size).toBe(0);
    });
  }
});
