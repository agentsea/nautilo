import { beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import {
  mobileWebRouterDestination,
  validatedMobileWebSignInReturnPath,
} from "@/lib/auth-gate-navigation-contract";

const browser = new Window({ url: "https://alpha.example.test/mobile/" });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  location: browser.location,
  IS_REACT_ACT_ENVIRONMENT: true,
});

type Props = Record<string, unknown> & { children?: ReactNode };
const element = (tag: string) => ({ children }: Props) => createElement(tag, null, children);
const Stack = Object.assign(element("div"), { Screen: element("div") });

mock.module("react-native", () => ({
  ActivityIndicator: element("span"),
  Pressable: element("button"),
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Text: element("span"),
  TextInput: element("input"),
  View: element("div"),
}));
mock.module("@/components/screen", () => ({ Screen: element("main") }));
mock.module("@/lib/auth-gate-navigation", () => ({
  currentSignInReturnPath: (value: string | readonly string[] | undefined) =>
    validatedMobileWebSignInReturnPath(value, window.location.origin),
  mobileWebRouterDestination,
}));

let params: { external?: string; returnTo?: string | string[] } = {};
const navigations: unknown[] = [];
mock.module("expo-router", () => ({
  Stack,
  router: { replace: (target: unknown) => { navigations.push(target); } },
  useLocalSearchParams: () => params,
}));

const theme = {
  color: {
    action: { primaryBg: "#00f" },
    border: { default: "#999" },
    brand: { accent: "#00f" },
    status: { error: "#c00" },
    surface: { panel: "#fff" },
    text: { disabled: "#aaa", foreground: "#000", muted: "#666", onPrimary: "#fff" },
  },
  radii: { lg: 16, sm: 8 },
  spacing: { lg: 16, md: 12, xl: 24 },
  typography: { body: {}, bodyStrong: {}, heading: {}, label: {} },
};
mock.module("@/providers/theme", () => ({ useAppTheme: () => theme }));

type AddServer = (origin: string) => Promise<string | null>;
let addServer: AddServer;
mock.module("@/providers/server-registry", () => ({
  useServers: () => ({ addServer }),
}));

const { default: AddCurrentOriginServerScreen } = await import("../app/(onboarding)/add-server.web");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(AddCurrentOriginServerScreen)); });
  return {
    close: async () => {
      await act(async () => { root.unmount(); });
      host.remove();
    },
  };
}

beforeEach(() => {
  params = {};
  navigations.length = 0;
  addServer = async () => null;
});

test("current-origin registration resumes one exact Task route", async () => {
  const taskId = "b487068d-9720-4f0f-a7a0-e84d9e4bff54";
  params = { returnTo: `/mobile/tasks/${taskId}` };
  const ui = await mount();
  try {
    expect(navigations).toEqual([`/tasks/${taskId}`]);
  } finally {
    await ui.close();
  }
});

test("registration failure and unmount never navigate", async () => {
  params = { returnTo: "/mobile/tasks/b487068d-9720-4f0f-a7a0-e84d9e4bff54" };
  addServer = async () => "unavailable";
  const failed = await mount();
  expect(navigations).toEqual([]);
  await failed.close();

  const pending = deferred<string | null>();
  addServer = () => pending.promise;
  const unmounted = await mount();
  await unmounted.close();
  await act(async () => { pending.resolve(null); await pending.promise; });
  expect(navigations).toEqual([]);
});

test("unsafe or ambiguous return values fall back to the Mobile root", async () => {
  const rejected: Array<string | string[]> = [
    "https://evil.example/mobile/tasks/b487068d-9720-4f0f-a7a0-e84d9e4bff54",
    ["/mobile/tasks/b487068d-9720-4f0f-a7a0-e84d9e4bff54", "/mobile/settings"],
    "/mobile/tasks/not-a-uuid",
    "/mobile/tasks/b487068d-9720-4f0f-a7a0-e84d9e4bff54?extra=1",
  ];
  for (const returnTo of rejected) {
    params = { returnTo };
    const ui = await mount();
    expect(navigations.at(-1)).toBe("/");
    await ui.close();
  }
});

test("external-server entry remains inert until the Human chooses a server", async () => {
  let calls = 0;
  addServer = async () => { calls += 1; return null; };
  params = {
    external: "1",
    returnTo: "/mobile/tasks/b487068d-9720-4f0f-a7a0-e84d9e4bff54",
  };
  const ui = await mount();
  try {
    expect(calls).toBe(0);
    expect(navigations).toEqual([]);
  } finally {
    await ui.close();
  }
});
