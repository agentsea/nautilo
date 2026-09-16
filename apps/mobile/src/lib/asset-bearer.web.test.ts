import { describe, expect, test } from "bun:test";

import { installBrowserAuth } from "./auth.web";
import type { MobileWebAuthSession } from "./browser-auth-session";
import { loadAssetBearer } from "./asset-bearer.web";
import { serverIdFromUrl } from "./server-store.web";

const origin = "https://alpha.example.test";

describe("Web asset bearer", () => {
  test("uses only the installed exact-origin browser session", async () => {
    const cleanup = installBrowserAuth({
      serverId: serverIdFromUrl(origin),
      serverOrigin: origin,
      session: { getAccessToken: () => Promise.resolve("asset-token") } as MobileWebAuthSession,
      runExclusive: (operation) => operation(),
    });

    expect(await loadAssetBearer(origin)).toBe("asset-token");
    expect(await loadAssetBearer("https://other.nautilo.dev")).toBeNull();
    cleanup();
    expect(await loadAssetBearer(origin)).toBeNull();
  });
});
