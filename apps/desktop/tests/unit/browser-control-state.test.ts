import { describe, expect, test } from "bun:test";

import {
  browserControlStateHasActiveView,
  browserControlStateSessionId,
  browserControlStateSessionSource,
} from "../../electron/browser-control-state";

describe("browser control provider state", () => {
  test("requires a published CDP URL", () => {
    expect(browserControlStateHasActiveView(null)).toBe(false);
    expect(browserControlStateHasActiveView({ views: [] })).toBe(false);
    expect(
      browserControlStateHasActiveView({
        activeAppId: "browser",
        views: [{ appId: "browser", cdpUrl: null }],
      }),
    ).toBe(false);
  });

  test("accepts the active view or the first published fallback", () => {
    expect(
      browserControlStateHasActiveView({
        activeAppId: "browser",
        views: [{ appId: "browser", cdpUrl: "http://127.0.0.1:1234" }],
      }),
    ).toBe(true);
    expect(
      browserControlStateHasActiveView({
        activeAppId: null,
        views: [{ appId: "browser", cdpUrl: "http://127.0.0.1:1234" }],
      }),
    ).toBe(true);
  });

  test("exposes only the exact active CDP session source to Electron main", () => {
    expect(browserControlStateSessionSource({
      activeAppId: "second",
      views: [
        { appId: "first", cdpUrl: "http://127.0.0.1:1111" },
        { appId: "second", cdpUrl: "http://127.0.0.1:2222" },
      ],
    })).toBe("http://127.0.0.1:2222");
    expect(browserControlStateSessionSource({ views: [] })).toBeNull();
  });

  test("derives a stable opaque id that changes with the exact active Browser view", () => {
    const first = browserControlStateSessionId({
      activeAppId: "browser/main",
      views: [{ appId: "browser/main", cdpUrl: "http://127.0.0.1:1111" }],
    });
    expect(first).toMatch(/^nautilo-browser-main-[a-f0-9]{8}$/);
    expect(browserControlStateSessionId({
      activeAppId: "browser/main",
      views: [{ appId: "browser/main", cdpUrl: "http://127.0.0.1:1111" }],
    })).toBe(first);
    expect(browserControlStateSessionId({
      activeAppId: "browser/main",
      views: [{ appId: "browser/main", cdpUrl: "http://127.0.0.1:2222" }],
    })).not.toBe(first);
  });
});
