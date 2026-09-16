import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";

import type { AuthAPI } from "../../src/hooks/use-auth";

const BEARER = "browser-bearer";
const priorGlobals: Record<string, unknown> = {};
let happyWindow: Window;
let root: Root | null = null;
let AuthProvider: (props: { children: ReactNode }) => ReactNode;
let useAuth: () => AuthAPI;
let observedAuth: AuthAPI | null = null;
let apiToken: string | null = null;
let credentialGeneration = 0;
let sdkAccessTokenCalls = 0;
let sdkClaimsCalls = 0;
let sdkSignOutCalls = 0;
let sdkBearer: string | null = BEARER;
let sdkSignOutClearsBearer = true;
let resolveSdkSignOut: (() => void) | null = null;
let readBearerDuringTeardown = false;
let teardownBearer: string | null | undefined;
const sdkState = {
  isAuthenticated: true,
  isLoading: false,
  signIn: async () => undefined,
  signOut: async () => {
    sdkSignOutCalls += 1;
    sdkState.isLoading = true;
    if (resolveSdkSignOut !== null) {
      await new Promise<void>((resolve) => {
        resolveSdkSignOut = resolve;
      });
    }
    if (sdkSignOutClearsBearer) sdkBearer = null;
    sdkState.isLoading = false;
  },
  getAccessToken: async () => {
    sdkAccessTokenCalls += 1;
    return sdkBearer;
  },
  getIdTokenClaims: async () => {
    sdkClaimsCalls += 1;
    return { sub: "logto:alice", name: "Alice" };
  },
};

const apiClient = {
  getToken: () => apiToken,
  getCredentialGeneration: () => credentialGeneration,
  setToken: (token: string | null) => {
    const normalized = token && token.length > 0 ? token : null;
    if (normalized !== apiToken) {
      apiToken = normalized;
      credentialGeneration += 1;
    }
  },
  setTokenProvider: () => undefined,
  setActionCapabilityDenialHandler: () => undefined,
  teardownLiveShadowForegroundAuthorizationSessions: async () => {
    if (readBearerDuringTeardown) {
      teardownBearer = await observedAuth!.session.getAccessToken();
    }
  },
  markPasswordRecoveryCompleted: async () => undefined,
  whoamiConditional: async () => ({
    status: 200 as const,
    etag: "viewer-v1",
    body: {
      sessionUserId: "user-alice",
      sessionActorId: "actor-alice",
      userIdentity: "alice@example.test",
      handle: "alice",
      displayName: "Alice",
      externalId: "logto:alice",
      instanceId: "instance-browser",
      mustChangePassword: false,
      groups: [],
      capabilities: [],
      highestRole: "owner",
      features: { office: { enabled: false } },
    },
  }),
};

function Probe() {
  observedAuth = useAuth();
  return <div data-actor={observedAuth.viewer.sessionActorId ?? "guest"} />;
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await act(flush);
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

async function renderProvider(): Promise<void> {
  const host = happyWindow.document.createElement("div");
  happyWindow.document.body.replaceChildren(host);
  root ??= createRoot(host);
  await act(async () => {
    root?.render(<AuthProvider><Probe /></AuthProvider>);
    await flush();
  });
}

beforeAll(async () => {
  happyWindow = new Window({ url: "http://localhost:3201/" });
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "localStorage",
    "sessionStorage",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ] as const) {
    priorGlobals[key] = (globalThis as Record<string, unknown>)[key];
  }
  Object.assign(globalThis, {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    HTMLElement: happyWindow.HTMLElement,
    localStorage: happyWindow.localStorage,
    sessionStorage: happyWindow.sessionStorage,
    requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
    cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  mock.module("@logto/react", () => ({
    LogtoProvider: ({ children }: { children: ReactNode }) => children,
    Prompt: { Login: "login", Consent: "consent" },
    useLogto: () => sdkState,
  }));
  mock.module("../../src/lib/desktop", () => ({
    isDesktop: false,
    desktopAPI: null,
  }));
  mock.module("../../src/lib/api", () => ({ apiClient }));
  const auth = await import("../../src/hooks/use-auth");
  AuthProvider = auth.AuthProvider;
  useAuth = auth.useAuth;
});

beforeEach(() => {
  sdkState.isAuthenticated = true;
  sdkState.isLoading = false;
  sdkAccessTokenCalls = 0;
  sdkClaimsCalls = 0;
  sdkSignOutCalls = 0;
  sdkBearer = BEARER;
  sdkSignOutClearsBearer = true;
  resolveSdkSignOut = null;
  readBearerDuringTeardown = false;
  teardownBearer = undefined;
  apiToken = null;
  credentialGeneration = 0;
  observedAuth = null;
  happyWindow.localStorage.clear();
});

afterEach(async () => {
  resolveSdkSignOut?.();
  resolveSdkSignOut = null;
  if (root) {
    await act(async () => root?.unmount());
    root = null;
  }
  happyWindow.document.body.replaceChildren();
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  const globals = globalThis as Record<string, unknown>;
  for (const [key, value] of Object.entries(priorGlobals)) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
  mock.restore();
});

test("an authenticated SDK busy state keeps the same bearer and viewer identity", async () => {
  await renderProvider();
  await waitFor(() => {
    expect(observedAuth?.viewer.sessionActorId).toBe("actor-alice");
  });
  const initialCredentialGeneration = observedAuth!.credentialGeneration;
  const initialViewerGeneration = observedAuth!.viewerGeneration;
  const accessCallsBeforeBusy = sdkAccessTokenCalls;

  sdkState.isLoading = true;
  await renderProvider();
  let acquired: string | null = null;
  await act(async () => {
    acquired = await observedAuth!.session.getAccessToken();
    await flush();
  });

  expect(acquired).toBe(BEARER);
  expect(apiToken).toBe(BEARER);
  expect(sdkAccessTokenCalls).toBe(accessCallsBeforeBusy + 1);
  expect(observedAuth?.credentialGeneration).toBe(initialCredentialGeneration);
  expect(observedAuth?.viewerGeneration).toBe(initialViewerGeneration);
  expect(observedAuth?.viewer.sessionActorId).toBe("actor-alice");
});

test("an unauthenticated initial callback does not call token SDK methods", async () => {
  sdkState.isAuthenticated = false;
  sdkState.isLoading = true;
  await renderProvider();
  await act(async () => {
    await flush();
    await flush();
  });

  expect(sdkAccessTokenCalls).toBe(0);
  expect(sdkClaimsCalls).toBe(0);
  expect(apiToken).toBeNull();
  expect(observedAuth?.viewer.sessionActorId).toBeNull();
});

test("a pending sign-out blocks concurrent bearer reacquisition", async () => {
  await renderProvider();
  await waitFor(() => {
    expect(observedAuth?.viewer.sessionActorId).toBe("actor-alice");
  });
  readBearerDuringTeardown = true;
  resolveSdkSignOut = () => undefined;
  let signOut!: Promise<void>;
  await act(async () => {
    signOut = observedAuth!.session.signOut();
    await flush();
  });
  await waitFor(() => expect(sdkSignOutCalls).toBe(1));
  expect(teardownBearer).toBe(BEARER);
  const accessCallsBeforeConcurrentRead = sdkAccessTokenCalls;

  let concurrentBearer: string | null = BEARER;
  await act(async () => {
    concurrentBearer = await observedAuth!.session.getAccessToken();
    await flush();
  });
  expect(concurrentBearer).toBeNull();
  expect(sdkAccessTokenCalls).toBe(accessCallsBeforeConcurrentRead);

  await act(async () => {
    resolveSdkSignOut?.();
    resolveSdkSignOut = null;
    await signOut;
  });
  const accessCallsAfterSignOut = sdkAccessTokenCalls;
  let bearerAfterSignOut: string | null = BEARER;
  await act(async () => {
    bearerAfterSignOut = await observedAuth!.session.getAccessToken();
    await flush();
  });
  expect(bearerAfterSignOut).toBeNull();
  expect(sdkAccessTokenCalls).toBe(accessCallsAfterSignOut + 1);
});

test("a swallowed sign-out failure releases the bearer fence for retry", async () => {
  await renderProvider();
  await waitFor(() => {
    expect(observedAuth?.viewer.sessionActorId).toBe("actor-alice");
  });
  sdkSignOutClearsBearer = false;

  await act(async () => {
    await observedAuth!.session.signOut();
    await flush();
  });
  expect(sdkSignOutCalls).toBe(1);
  const accessCallsAfterSignOut = sdkAccessTokenCalls;

  let recoveredBearer: string | null = null;
  await act(async () => {
    recoveredBearer = await observedAuth!.session.getAccessToken();
    await flush();
  });
  expect(recoveredBearer).toBe(BEARER);
  expect(sdkAccessTokenCalls).toBe(accessCallsAfterSignOut + 1);
});
