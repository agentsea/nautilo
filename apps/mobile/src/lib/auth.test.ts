/// <reference types="bun-types" />

import { describe, expect, mock, test } from "bun:test";

type RequestConfig = {
  extraParams: Record<string, string>;
};

const requests: RequestConfig[] = [];
const getHealth = mock(async () => ({
  status: "ok",
  logtoEndpoint: "https://logto.example.test",
  logtoMobileAppId: "mobile-client-id",
  logtoResource: "https://nautilo.example.test/api",
}));
const saveTokens = mock(async () => {});
const clearTokens = mock(async () => {});
const loadTokens = mock(async () => null as {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
} | null);
const loadTokenSnapshot = mock(async () => ({ tokens: await loadTokens(), revision: 0 }));
const saveTokensIfRevision = mock(async () => true);
const clearTokensIfRevision = mock(async () => true);
const refreshAsync = mock(async () => ({
  accessToken: "refreshed-access-token",
  refreshToken: "rotated-refresh-token",
  expiresIn: 3600,
}));

const browserApi = await import("@nautilo/api-client/browser");

class FakeDirectory {
  readonly uri: string;

  constructor(base: string, name: string) {
    this.uri = `${base.replace(/\/$/, "")}/${name}`;
  }

  create(): void {}
}

class FakeFile {
  static readonly downloadFileAsync = mock(async (_url: string, destination: FakeFile) => destination);
  readonly uri: string;
  exists = true;

  constructor(base: string | FakeDirectory, name?: string) {
    const root = typeof base === "string" ? base : base.uri;
    this.uri = name ? `${root.replace(/\/$/, "")}/${name}` : root;
  }

  async text(): Promise<string> {
    return "";
  }

  delete(): void {
    this.exists = false;
  }
}

class FakeAuthRequest {
  readonly codeVerifier = "pkce-verifier";

  constructor(config: RequestConfig) {
    requests.push(config);
  }

  async promptAsync() {
    return { type: "success" as const, params: { code: "authorization-code" } };
  }
}

mock.module("expo-auth-session", () => ({
  makeRedirectUri: mock(() => "nautilo://callback"),
  fetchDiscoveryAsync: mock(async () => ({
    authorizationEndpoint: "https://logto.example.test/oidc/auth",
    tokenEndpoint: "https://logto.example.test/oidc/token",
  })),
  AuthRequest: FakeAuthRequest,
  exchangeCodeAsync: mock(async () => ({
    accessToken: "new-access-token",
    refreshToken: "new-refresh-token",
    expiresIn: 3600,
  })),
  refreshAsync,
}));

mock.module("expo-web-browser", () => ({
  maybeCompleteAuthSession: mock(() => {}),
}));

mock.module("expo-file-system", () => ({
  Directory: FakeDirectory,
  File: FakeFile,
  Paths: { cache: "file:///cache" },
}));

mock.module("@nautilo/api-client/browser", () => ({
  ...browserApi,
  NautiloApiClient: class FakeApiClient extends browserApi.NautiloApiClient {
    getHealth = getHealth;
  },
}));

mock.module("@/lib/server-store", () => ({
  clearTokens,
  clearTokensIfRevision,
  loadTokenSnapshot,
  loadTokens,
  saveTokens,
  saveTokensIfRevision,
}));

const { ensureValidToken, reauthenticateToServer, signInToServer } = await import("./auth");

describe("interactive Logto auth modes", () => {
  test("ordinary sign-in forces fresh account entry and remains uncommitted until provider verification", async () => {
    requests.length = 0;
    getHealth.mockClear();
    saveTokens.mockClear();
    saveTokensIfRevision.mockClear();

    await signInToServer("srv_example", "https://nautilo.example.test");

    expect(requests).toHaveLength(1);
    expect(requests[0]?.extraParams).toEqual({
      prompt: "login consent",
      resource: "https://nautilo.example.test/api",
    });
    expect(saveTokens).not.toHaveBeenCalled();
  });

  test("fresh reauthentication emits prompt=login without persisting before verification", async () => {
    requests.length = 0;
    saveTokens.mockClear();

    await reauthenticateToServer("srv_example", "https://nautilo.example.test");

    expect(requests).toHaveLength(1);
    expect(requests[0]?.extraParams).toEqual({
      prompt: "login",
      resource: "https://nautilo.example.test/api",
    });
    expect(saveTokens).not.toHaveBeenCalled();
  });
});

describe("silent token refresh", () => {
  test("collapses concurrent refreshes per server and returns the rotated access token", async () => {
    loadTokens.mockImplementation(async () => ({
      accessToken: "expired-access-token",
      refreshToken: "refresh-token",
      expiresAt: Date.now() - 1,
    }));
    refreshAsync.mockClear();
    saveTokens.mockClear();
    saveTokensIfRevision.mockClear();

    const [first, second] = await Promise.all([
      ensureValidToken("srv_refresh", "https://nautilo.example.test"),
      ensureValidToken("srv_refresh", "https://nautilo.example.test"),
    ]);

    expect(first).toBe("refreshed-access-token");
    expect(second).toBe("refreshed-access-token");
    expect(refreshAsync).toHaveBeenCalledTimes(1);
    expect(saveTokensIfRevision).toHaveBeenCalledTimes(1);
  });
});
