import { describe, expect, test } from "bun:test";

import type { DeviceFlowEvent, RefreshOutcome } from "@nautilo/cli-auth";
import {
  normalizeDevicePairingInstruction,
  pairStandaloneRelay,
  RelayPairingError,
  type RelayPairingDependencies,
} from "../../src/pairing";
import type {
  RelayCredentialStore,
  RelayPairingIdentity,
  RelayStoredCredential,
} from "../../src/credential-store";

const identity: RelayPairingIdentity = {
  formatVersion: 1,
  serverUrl: "https://nautilo.example",
  installationId: "11111111-1111-4111-8111-111111111111",
};
const HUMAN_ID = "22222222-2222-4222-8222-222222222222";

class MemoryStore implements RelayCredentialStore {
  readonly serverUrl = identity.serverUrl;
  credential: RelayStoredCredential | null = null;
  saves = 0;

  async getOrCreatePairingIdentity(): Promise<RelayPairingIdentity> {
    return identity;
  }
  async load(): Promise<RelayStoredCredential | null> {
    return this.credential;
  }
  async save(credential: RelayStoredCredential): Promise<void> {
    this.saves += 1;
    this.credential = credential;
  }
  async clear(): Promise<void> {
    this.credential = null;
  }
}

async function* successfulDeviceFlow(): AsyncGenerator<DeviceFlowEvent> {
  yield {
    type: "code",
    data: {
      device_code: "opaque-device-code",
      user_code: "ABCD-1234",
      verification_uri: "https://identity.example/device",
      expires_in: 600,
    },
  };
  yield {
    type: "success",
    data: {
      access_token: "opaque-access",
      refresh_token: "initial-refresh",
      id_token: "",
      expires_in: 3600,
    },
  };
}

function subject() {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const output: string[] = [];
  const revoked: string[] = [];
  const store = new MemoryStore();
  const dependencies: RelayPairingDependencies = {
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const value = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      requests.push({ url: value, ...(init !== undefined ? { init } : {}) });
      if (value.endsWith("/health")) {
        return Response.json({
          logtoEndpoint: "https://identity.example",
          logtoTuiAppId: "relay-device-app",
          logtoResource: "https://api.nautilo.local",
          relayPairingContractVersion: 2,
        });
      }
      if (value.endsWith("/api/auth/whoami")) {
        return Response.json({ sessionUserId: HUMAN_ID });
      }
      if (value.endsWith("/api/relay/pair")) {
        return Response.json({
          relayToken: `rty_${"c".repeat(32)}`,
          pairingContractVersion: 2,
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch,
    runDeviceFlow: successfulDeviceFlow,
    refreshAccessToken: async (): Promise<RefreshOutcome> => ({
      kind: "ok",
      tokens: {
        access_token: "server-jwt",
        refresh_token: "upgraded-refresh",
        id_token: "",
        expires_in: 3600,
      },
    }),
    revokeRefreshToken: async ({ refreshToken }) => {
      revoked.push(refreshToken);
    },
    writeInstruction: (message) => output.push(message),
    deviceLabel: () => "Test Relay",
  };
  return { dependencies, output, requests, revoked, store };
}

describe("standalone Relay pairing", () => {
  test("uses device auth, binds one installation, stores only the relay credential, and revokes temporary auth", async () => {
    const { dependencies, output, requests, revoked, store } = subject();
    const credential = await pairStandaloneRelay({ store, dependencies });

    expect(credential).toEqual({
      ...identity,
      userId: HUMAN_ID,
      relayToken: `rty_${"c".repeat(32)}`,
    });
    expect(store.credential).toEqual(credential);
    expect(store.saves).toBe(1);
    expect(output).toEqual(["Open: https://identity.example/device\nCode: ABCD-1234\n"]);
    expect(output.join(" ")).not.toContain("server-jwt");
    expect(output.join(" ")).not.toContain("rty_");
    expect(revoked).toEqual(["upgraded-refresh"]);

    const pair = requests.find((request) => request.url.endsWith("/api/relay/pair"))!;
    expect(pair.init?.headers).toEqual({
      authorization: "Bearer server-jwt",
      "content-type": "application/json",
    });
    expect(typeof pair.init?.body).toBe("string");
    expect(JSON.parse(pair.init?.body as string)).toEqual({
      deviceLabel: "Test Relay",
      installationId: identity.installationId,
      capabilities: { profile: "desktop-agent" },
    });
  });

  test("re-pairing reuses the installation identity and atomically replaces the local secret", async () => {
    const { dependencies, store } = subject();
    const first = await pairStandaloneRelay({ store, dependencies });
    const second = await pairStandaloneRelay({ store, dependencies });
    expect(second.installationId).toBe(first.installationId);
    expect(store.saves).toBe(2);
  });

  test("best-effort temporary-token cleanup cannot override successful pairing", async () => {
    const { dependencies, store } = subject();
    const credential = await pairStandaloneRelay({
      store,
      dependencies: {
        ...dependencies,
        revokeRefreshToken: async () => {
          throw new Error("cleanup unavailable");
        },
      },
    });
    expect(store.credential).toEqual(credential);
  });

  test("rejects terminal injection and a verification URL on another origin", () => {
    expect(() => normalizeDevicePairingInstruction(
      "https://identity.example",
      "https://evil.example/device",
      "ABCD-1234",
    )).toThrow(RelayPairingError);
    expect(() => normalizeDevicePairingInstruction(
      "https://identity.example",
      "https://identity.example/device\u001b[31m",
      "ABCD-1234",
    )).toThrow(RelayPairingError);
  });

  test("fails closed without persisting when the server lacks pairing contract v2", async () => {
    const { dependencies, store } = subject();
    const originalFetch = dependencies.fetch;
    const unsupportedDependencies: RelayPairingDependencies = {
      ...dependencies,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const value = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (value.endsWith("/health")) {
        return Response.json({
          logtoEndpoint: "https://identity.example",
          logtoTuiAppId: "relay-device-app",
          logtoResource: "https://api.nautilo.local",
          relayPairingContractVersion: 1,
        });
      }
      return originalFetch(url, init);
      }) as typeof fetch,
    };

    const failure = await pairStandaloneRelay({
      store,
      dependencies: unsupportedDependencies,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RelayPairingError);
    expect((failure as Error).message).toContain("does not support standalone Relay pairing");
    expect(store.credential).toBeNull();
  });
});
