import { expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

const task = "b487068d-9720-4f0f-a7a0-e84d9e4bff54";
const browser = new Window({
  url: `https://alpha.example/mobile/sign-in?returnTo=${encodeURIComponent(`/mobile/tasks/${task}`)}`,
});
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
});

type Props = Record<string, unknown> & { children?: ReactNode };
const element = (tag: string) => ({ children }: Props) => createElement(tag, null, children);
mock.module("react-native", () => ({
  ActivityIndicator: element("progress"),
  Platform: { OS: "web" },
  Pressable: element("button"),
  Text: element("span"),
  TextInput: element("input"),
}));
mock.module("react-native-keyboard-controller", () => ({
  KeyboardAvoidingView: element("div"),
}));

let navigationState: { key: string } | undefined;
const navigations: unknown[] = [];
mock.module("expo-router", () => ({
  router: { replace: (target: unknown) => { navigations.push(target); } },
  useRootNavigationState: () => navigationState,
}));

const webResume = await import("@/lib/crypto-admission-navigation-resume.web");
mock.module("@/lib/crypto-admission-navigation-resume", () => webResume);

let auth: Readonly<{
  status: "loading" | "signed-in";
  viewer: { userId: string } | null;
}> = { status: "loading", viewer: null };
const activeServer = {
  id: "server-a",
  serverUrl: "https://alpha.example",
  displayName: "Alpha",
};
mock.module("@/providers/auth", () => ({ useAuth: () => auth }));
mock.module("@/providers/server-registry", () => ({
  useServers: () => ({
    activeServer,
    addServer: async () => null,
    servers: [activeServer],
    switchTo: async () => {},
  }),
}));
mock.module("@/providers/theme", () => ({
  useAppTheme: () => ({
    color: {
      action: { primaryBg: "#00f" },
      border: { default: "#999" },
      brand: { accent: "#00f" },
      status: { error: "#c00" },
      surface: { background: "#fff" },
      text: { disabled: "#aaa", foreground: "#000", muted: "#666", onPrimary: "#fff" },
    },
  }),
}));

let resolvePolicy!: (policy: { requiresCryptoDevice: boolean }) => void;
const policy = new Promise<{ requiresCryptoDevice: boolean }>((resolve) => {
  resolvePolicy = resolve;
});
mock.module("@/lib/api", () => ({
  getApiClient: () => ({
    admin: { encryptionTransition: { getPolicy: () => policy } },
    setDeviceAdmissionRequiredHandler: () => {},
  }),
}));

const { CryptoDeviceAdmissionBoundary } = await import("./crypto-device-admission-boundary");
const { CryptoAdmissionNavigationResume } = webResume;

let shellReady = false;
function ProtectedShell() {
  return createElement(
    "div",
    { id: "protected" },
    "protected-provider-tree",
    createElement(CryptoAdmissionNavigationResume, { ready: shellReady }),
  );
}

test("real boundary context resumes once after crypto and canonical shell readiness", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = async () => {
    await act(async () => {
      root.render(createElement(
        CryptoDeviceAdmissionBoundary,
        null,
        createElement(ProtectedShell),
      ));
      await Promise.resolve();
    });
  };
  try {
    await render();
    expect(host.textContent).toContain("protected-provider-tree");

    auth = { status: "signed-in", viewer: { userId: "human-a" } };
    await render();
    expect(host.textContent).not.toContain("protected-provider-tree");
    expect(navigations).toEqual([]);

    await act(async () => {
      resolvePolicy({ requiresCryptoDevice: false });
      await policy;
    });
    expect(host.textContent).toContain("protected-provider-tree");
    expect(navigations).toEqual([]);

    navigationState = { key: "root-ready" };
    await render();
    expect(navigations).toEqual([]);

    shellReady = true;
    await render();
    expect(navigations).toEqual([`/tasks/${task}`]);
    await render();
    expect(navigations).toEqual([`/tasks/${task}`]);
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
  }
});
