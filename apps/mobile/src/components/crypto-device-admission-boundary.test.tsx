import { beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

const browser = new Window();
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

type AuthState = Readonly<{
  status: "loading" | "signed-in" | "signed-out";
  viewer: { userId: string } | null;
}>;
type Server = Readonly<{ id: string; serverUrl: string; displayName: string }>;
let auth: AuthState = { status: "loading", viewer: null };
let activeServer: Server | null = null;
mock.module("@/providers/auth", () => ({ useAuth: () => auth }));
mock.module("@/providers/server-registry", () => ({
  useServers: () => ({
    activeServer,
    addServer: async () => null,
    servers: activeServer ? [activeServer] : [],
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, reject, resolve };
}

type Policy = { requiresCryptoDevice: boolean };
const policies = new Map<string, ReturnType<typeof deferred<Policy>>>();
const handlers = new Map<string, (() => void) | null>();
mock.module("@/lib/api", () => ({
  getApiClient: (url: string) => ({
    admin: { encryptionTransition: { getPolicy: () => policies.get(url)!.promise } },
    setDeviceAdmissionRequiredHandler: (handler: (() => void) | null) => { handlers.set(url, handler); },
  }),
}));

const captures: string[] = [];
const resumeBindings: unknown[] = [];
mock.module("@/lib/crypto-admission-navigation-resume", () => ({
  captureCryptoAdmissionNavigationResume: (key: string) => {
    captures.push(key);
    return { admissionKey: key, destination: "/tasks/remembered" };
  },
}));
mock.module("@/lib/crypto-admission-navigation-resume-context", () => ({
  CryptoAdmissionNavigationResumeProvider: ({ binding, children }: Props) => {
    resumeBindings.push(binding);
    return createElement("div", null, children);
  },
}));

const { CryptoDeviceAdmissionBoundary } = await import("./crypto-device-admission-boundary");

async function mountBoundary() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = async () => {
    await act(async () => {
      root.render(createElement(
        CryptoDeviceAdmissionBoundary,
        null,
        createElement("div", { id: "protected" }, "protected-provider-tree"),
      ));
      await Promise.resolve();
    });
  };
  await render();
  return {
    host,
    render,
    close: async () => {
      await act(async () => { root.unmount(); });
      host.remove();
    },
  };
}

beforeEach(() => {
  auth = { status: "loading", viewer: null };
  activeServer = null;
  policies.clear();
  handlers.clear();
  captures.length = 0;
  resumeBindings.length = 0;
});

test("unmounts protected providers during admission and resumes the first exact scope", async () => {
  const alpha = { id: "server-a", serverUrl: "https://alpha.example", displayName: "Alpha" };
  policies.set(alpha.serverUrl, deferred());
  const ui = await mountBoundary();
  try {
    expect(ui.host.textContent).toContain("protected-provider-tree");

    activeServer = alpha;
    auth = { status: "signed-in", viewer: { userId: "human-a" } };
    await ui.render();
    expect(ui.host.textContent).not.toContain("protected-provider-tree");
    expect(ui.host.textContent).toContain("Checking encryption");
    expect(captures).toEqual(["server-a\0https://alpha.example\0human-a"]);

    await act(async () => {
      policies.get(alpha.serverUrl)!.resolve({ requiresCryptoDevice: false });
      await policies.get(alpha.serverUrl)!.promise;
    });
    expect(ui.host.textContent).toContain("protected-provider-tree");
    const binding = resumeBindings.at(-1) as {
      intent: { admissionKey: string; destination: string };
      onConsumed(intent: { admissionKey: string; destination: string }): void;
    };
    expect(binding).toMatchObject({
      admissionKey: "server-a\0https://alpha.example\0human-a",
      intent: {
        admissionKey: "server-a\0https://alpha.example\0human-a",
        destination: "/tasks/remembered",
      },
    });
    binding.onConsumed(binding.intent);
    await ui.render();
    expect(resumeBindings.at(-1)).toBeNull();
  } finally {
    await ui.close();
  }
});

test("a loading scope transition clears and permanently locks the remembered locator", async () => {
  const alpha = { id: "server-a", serverUrl: "https://alpha.example", displayName: "Alpha" };
  const beta = { id: "server-b", serverUrl: "https://beta.example", displayName: "Beta" };
  policies.set(alpha.serverUrl, deferred());
  policies.set(beta.serverUrl, deferred());
  activeServer = alpha;
  auth = { status: "signed-in", viewer: { userId: "human-a" } };
  const ui = await mountBoundary();
  try {
    expect(captures).toEqual(["server-a\0https://alpha.example\0human-a"]);

    auth = { status: "loading", viewer: null };
    await ui.render();
    activeServer = beta;
    auth = { status: "signed-in", viewer: { userId: "human-b" } };
    await ui.render();
    expect(captures).toEqual(["server-a\0https://alpha.example\0human-a"]);
    expect(resumeBindings.filter(Boolean)).toEqual([]);

    await act(async () => {
      policies.get(alpha.serverUrl)!.resolve({ requiresCryptoDevice: false });
      await policies.get(alpha.serverUrl)!.promise;
    });
    expect(ui.host.textContent).not.toContain("protected-provider-tree");
    expect(resumeBindings.filter(Boolean)).toEqual([]);

    await act(async () => {
      policies.get(beta.serverUrl)!.resolve({ requiresCryptoDevice: false });
      await policies.get(beta.serverUrl)!.promise;
    });
    expect(ui.host.textContent).toContain("protected-provider-tree");
    expect(resumeBindings.filter(Boolean)).toEqual([]);
  } finally {
    await ui.close();
  }
});

test("an account change under one server cannot recapture the visible locator", async () => {
  const alpha = { id: "server-a", serverUrl: "https://alpha.example", displayName: "Alpha" };
  policies.set(alpha.serverUrl, deferred());
  activeServer = alpha;
  auth = { status: "signed-in", viewer: { userId: "human-a" } };
  const ui = await mountBoundary();
  try {
    auth = { status: "signed-in", viewer: { userId: "human-b" } };
    policies.set(alpha.serverUrl, deferred());
    await ui.render();
    expect(captures).toEqual(["server-a\0https://alpha.example\0human-a"]);
    await act(async () => {
      policies.get(alpha.serverUrl)!.resolve({ requiresCryptoDevice: false });
      await policies.get(alpha.serverUrl)!.promise;
    });
    expect(resumeBindings.filter(Boolean)).toEqual([]);
  } finally {
    await ui.close();
  }
});

test("unsupported and unavailable policy states never mount protected providers", async () => {
  const alpha = { id: "server-a", serverUrl: "https://alpha.example", displayName: "Alpha" };
  const unsupported = deferred<Policy>();
  policies.set(alpha.serverUrl, unsupported);
  activeServer = alpha;
  auth = { status: "signed-in", viewer: { userId: "human-a" } };
  const ui = await mountBoundary();
  try {
    await act(async () => {
      unsupported.resolve({ requiresCryptoDevice: true });
      await unsupported.promise;
    });
    expect(ui.host.textContent).not.toContain("protected-provider-tree");
    expect(ui.host.textContent).toContain("Encryption is not available");
  } finally {
    await ui.close();
  }

  policies.set(alpha.serverUrl, deferred());
  const unavailable = await mountBoundary();
  try {
    await act(async () => {
      policies.get(alpha.serverUrl)!.reject(new Error("unavailable"));
      await policies.get(alpha.serverUrl)!.promise.catch(() => undefined);
    });
    expect(unavailable.host.textContent).not.toContain("protected-provider-tree");
    expect(unavailable.host.textContent).toContain("Encryption status is unavailable");
  } finally {
    await unavailable.close();
  }
});
