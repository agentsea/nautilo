/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { createAuthSessionEndCoordinator } from "./auth-session-end";

describe("D468 authenticated session-end coordinator", () => {
  test("revokes or tombstones before local bearer, viewer, token, and signed-out commit", async () => {
    const calls: string[] = [];
    const coordinator = createAuthSessionEndCoordinator({
      loadStoredBearer: async () => "stored-a",
      releasePushBinding: async ({ bearerToken }) => { calls.push(`release:${bearerToken}`); },
      clearClientBearer: () => { calls.push("client-clear"); },
      clearViewerCache: async () => { calls.push("viewer-clear"); },
      clearTokens: async () => { calls.push("tokens-clear"); },
    });

    await coordinator.end({
      serverId: "srv_a",
      serverUrl: "https://a.test",
      bearerToken: undefined,
      commitSignedOut: () => { calls.push("signed-out"); },
    });

    expect(calls).toEqual([
      "release:stored-a",
      "client-clear",
      "viewer-clear",
      "tokens-clear",
      "signed-out",
    ]);
  });

  test("coalesces duplicate auth-dead/session-end calls for one server", async () => {
    let release!: () => void;
    let calls = 0;
    const coordinator = createAuthSessionEndCoordinator({
      loadStoredBearer: async () => "stored-a",
      releasePushBinding: async () => {
        calls += 1;
        await new Promise<void>((resolve) => { release = resolve; });
      },
      clearClientBearer: () => { calls += 1; },
      clearViewerCache: async () => { calls += 1; },
      clearTokens: async () => { calls += 1; },
    });
    const first = coordinator.end({
      serverId: "srv_a",
      serverUrl: "https://a.test",
      bearerToken: "a",
      commitSignedOut: () => { calls += 1; },
    });
    const duplicate = coordinator.end({
      serverId: "srv_a",
      serverUrl: "https://a.test",
      bearerToken: "a",
      commitSignedOut: () => { calls += 100; },
    });
    expect(duplicate).toBe(first);

    release();
    await first;
    expect(calls).toBe(5);
  });

  test("refuses to clear any local state when durable push cleanup fails", async () => {
    const calls: string[] = [];
    const coordinator = createAuthSessionEndCoordinator({
      loadStoredBearer: async () => "stored-a",
      releasePushBinding: async () => { throw new Error("tombstone write failed"); },
      clearClientBearer: () => { calls.push("client-clear"); },
      clearViewerCache: async () => { calls.push("viewer-clear"); },
      clearTokens: async () => { calls.push("tokens-clear"); },
    });

    let failure: unknown = null;
    try {
      await coordinator.end({
        serverId: "srv_a",
        serverUrl: "https://a.test",
        bearerToken: "a",
        commitSignedOut: () => { calls.push("signed-out"); },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("tombstone write failed");
    expect(calls).toEqual([]);
  });

  test("an unconfirmed verified owner leaves loading only after ordered terminal cleanup", async () => {
    const calls: string[] = [];
    let viewerState = "loading";
    const coordinator = createAuthSessionEndCoordinator({
      loadStoredBearer: async () => "stored-a",
      releasePushBinding: async () => { calls.push("release"); },
      clearClientBearer: () => { calls.push("client-clear"); },
      clearViewerCache: async () => { calls.push("viewer-clear"); },
      clearTokens: async () => { calls.push("tokens-clear"); },
    });
    const ownerConfirmed = false;

    // This is the AuthProvider's false-confirmation branch: an uncertain
    // Human never becomes verified, and it cannot leave cold start loading.
    if (!ownerConfirmed) {
      await coordinator.end({
        serverId: "srv_a",
        serverUrl: "https://a.test",
        bearerToken: "latched-a",
      });
      viewerState = "signed-out";
    }

    expect(calls).toEqual(["release", "client-clear", "viewer-clear", "tokens-clear"]);
    expect(viewerState).toBe("signed-out");
  });
});
