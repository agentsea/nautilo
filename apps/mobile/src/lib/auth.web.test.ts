import { describe, expect, test } from "bun:test";

import {
  clearBrowserAuthSession,
  createBrowserAuthExclusiveRunner,
  ensureValidToken,
  hasInstalledBrowserAuth,
  installBrowserAuth,
  signOutServer,
} from "./auth.web";
import type { MobileWebAuthSession } from "./browser-auth-session";
import { serverIdFromUrl } from "./server-store.web";

const origin = "https://alpha.example.test";
const serverId = serverIdFromUrl(origin);

describe("browser auth runtime", () => {
  test("fails closed unless the exact current-origin server owns the session", async () => {
    expect(await ensureValidToken(serverId, origin)).toBeNull();
    const cleanup = installBrowserAuth({
      serverId,
      serverOrigin: origin,
      session: { getAccessToken: () => Promise.resolve("token") } as MobileWebAuthSession,
      runExclusive: (operation) => operation(),
    });
    expect(hasInstalledBrowserAuth(serverId, origin)).toBe(true);
    expect(await ensureValidToken(serverId, origin)).toBe("token");
    expect(await ensureValidToken(serverId, "https://other.nautilo.dev")).toBeNull();
    expect(await ensureValidToken("srv_forged", origin)).toBeNull();
    cleanup();
    expect(await ensureValidToken(serverId, origin)).toBeNull();
  });

  test("forwards forced refresh only through the installed session", async () => {
    const seen: unknown[] = [];
    const cleanup = installBrowserAuth({
      serverId,
      serverOrigin: origin,
      session: {
        getAccessToken: (options) => {
          seen.push(options);
          return Promise.resolve("fresh");
        },
      } as MobileWebAuthSession,
      runExclusive: (operation) => operation(),
    });
    expect(await ensureValidToken(serverId, origin, { forceRefresh: true })).toBe("fresh");
    expect(seen).toEqual([{ forceRefresh: true }]);
    cleanup();
  });

  test("does not let stale provider cleanup detach its replacement", async () => {
    const cleanupOld = installBrowserAuth({
      serverId,
      serverOrigin: origin,
      session: { getAccessToken: () => Promise.resolve("old-token") } as MobileWebAuthSession,
      runExclusive: (operation) => operation(),
    });
    const cleanupCurrent = installBrowserAuth({
      serverId,
      serverOrigin: origin,
      session: { getAccessToken: () => Promise.resolve("current-token") } as MobileWebAuthSession,
      runExclusive: (operation) => operation(),
    });

    cleanupOld();
    expect(await ensureValidToken(serverId, origin)).toBe("current-token");
    cleanupCurrent();
    expect(await ensureValidToken(serverId, origin)).toBeNull();
  });

  test("uses one origin-private Web Lock name for competing tab operations", async () => {
    const names: string[] = [];
    const runner = createBrowserAuthExclusiveRunner("mobile-web", {
      request: async (name, operation) => {
        names.push(name);
        return operation();
      },
    });
    expect(await runner(() => Promise.resolve("done"))).toBe("done");
    expect(names).toEqual(["nautilo:mobile-web:oidc:mobile-web"]);
  });

  test("serializes local clearing and logout for only the installed server", async () => {
    const operations: string[] = [];
    const cleanup = installBrowserAuth({
      serverId,
      serverOrigin: origin,
      session: {
        clearLocalSession: () => {
          operations.push("clear");
          return Promise.resolve();
        },
        signOut: () => {
          operations.push("sign-out");
          return Promise.resolve();
        },
      } as MobileWebAuthSession,
      runExclusive: async (operation) => {
        operations.push("lock");
        return operation();
      },
    });
    await clearBrowserAuthSession("srv_forged");
    await signOutServer("srv_forged");
    await clearBrowserAuthSession(serverId);
    await signOutServer(serverId);
    expect(operations).toEqual(["lock", "clear", "lock", "sign-out"]);
    cleanup();
  });
});
