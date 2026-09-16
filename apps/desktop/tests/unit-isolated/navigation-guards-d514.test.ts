import { beforeEach, describe, expect, mock, test } from "bun:test";

const openExternal = mock(async () => undefined);
const logInfo = mock(() => {});
const logWarn = mock(() => {});

mock.module("electron", () => ({
  shell: { openExternal },
}));
mock.module("electron-log/main", () => ({ default: { info: logInfo, warn: logWarn } }));

const { attachNavigationGuards, isAllowedNavigationTarget, isExternalLink, safeNavigationUrlForLogging } = await import(
  "../../electron/navigation-guards"
);

const bootstrap = "/Applications/Nautilo.app/Contents/Resources/app/bootstrap.html";
const picker = "/Applications/Nautilo.app/Contents/Resources/app/cold-boot-picker.html";

beforeEach(() => {
  openExternal.mockClear();
  logInfo.mockClear();
  logWarn.mockClear();
});

describe("D514 navigation release policy", () => {
  test("default-deny permits only the exact trusted local bootstrap/recovery paths", () => {
    const localFiles = new Set([bootstrap, picker]);
    const noRemoteOrigins = new Set<string>();

    expect(
      isAllowedNavigationTarget(`file://${picker}?mode=disconnected`, noRemoteOrigins, localFiles),
    ).toBe(true);
    expect(
      isAllowedNavigationTarget(
        "file:///tmp/attacker.html",
        noRemoteOrigins,
        localFiles,
      ),
    ).toBe(false);
    expect(
      isAllowedNavigationTarget(
        `file://evil${picker}`,
        noRemoteOrigins,
        localFiles,
      ),
    ).toBe(false);
    expect(
      isAllowedNavigationTarget(
        "https://alpha.example.test/",
        noRemoteOrigins,
        localFiles,
      ),
    ).toBe(false);
  });

  test("exact verified origin release permits only that origin", () => {
    const origins = new Set(["https://alpha.example.test"]);
    const localFiles = new Set([bootstrap, picker]);

    expect(isAllowedNavigationTarget("https://alpha.example.test/workbench", origins, localFiles)).toBe(true);
    expect(isAllowedNavigationTarget("http://alpha.example.test/", origins, localFiles)).toBe(false);
    expect(isAllowedNavigationTarget("https://alpha.example.test:444/", origins, localFiles)).toBe(false);
    expect(isAllowedNavigationTarget("https://attacker.example/", origins, localFiles)).toBe(false);
  });

  test("controller atomically swaps local hold for remote release and restores local hold", () => {
    const listeners = new Map<string, (...args: any[]) => void>();
    const contents = {
      setWindowOpenHandler: () => undefined,
      on: (event: string, listener: (...args: any[]) => void) => {
        listeners.set(event, listener);
      },
    };
    const controller = attachNavigationGuards(contents as never, {
      allowedOrigins: [],
      allowedLocalFilePaths: [bootstrap, picker],
      windowName: "d514-test",
    });
    const blocked = (url: string) => {
      let prevented = false;
      listeners.get("will-navigate")?.({ preventDefault: () => { prevented = true; } }, url);
      return prevented;
    };

    expect(blocked(`file://${picker}`)).toBe(false);
    expect(blocked("https://alpha.example.test/")).toBe(true);

    controller.replaceAllowedOrigins(["https://alpha.example.test"]);
    expect(blocked(`file://${picker}`)).toBe(true);
    expect(blocked("https://alpha.example.test/")).toBe(false);

    controller.holdLocalNavigation();
    expect(blocked(`file://${picker}`)).toBe(false);
    expect(blocked("https://alpha.example.test/")).toBe(true);
  });

  test("external http(s)/mailto handling remains distinct from in-app authority", () => {
    expect(isExternalLink("https://external.example/docs")).toBe(true);
    expect(isExternalLink("mailto:support@example.test")).toBe(true);
    expect(isExternalLink("file:///tmp/attacker.html")).toBe(false);
  });

  test("allows only the exact protected-login origin in child frames", () => {
    const listeners = new Map<string, (...args: any[]) => void>();
    const contents = {
      setWindowOpenHandler: () => undefined,
      on: (event: string, listener: (...args: any[]) => void) => {
        listeners.set(event, listener);
      },
    };
    attachNavigationGuards(contents as never, {
      allowedOrigins: ["https://alpha.example.test"],
      allowedFrameOrigins: ["https://live.browser-use.com"],
      windowName: "d568-test",
    });
    const frameNavigationPrevented = (url: string, isMainFrame = false) => {
      let prevented = false;
      listeners.get("will-frame-navigate")?.({
        url,
        isMainFrame,
        preventDefault: () => { prevented = true; },
      });
      return prevented;
    };

    expect(frameNavigationPrevented("https://live.browser-use.com/session?token=secret")).toBe(false);
    expect(frameNavigationPrevented("https://live.browser-use.com.evil.test/session")).toBe(true);
    expect(frameNavigationPrevented("https://attacker.example/frame?token=secret")).toBe(true);
    expect(openExternal).not.toHaveBeenCalled();
  });

  test("frame-only authority never permits top-level navigation", () => {
    const listeners = new Map<string, (...args: any[]) => void>();
    const contents = {
      setWindowOpenHandler: () => undefined,
      on: (event: string, listener: (...args: any[]) => void) => {
        listeners.set(event, listener);
      },
    };
    attachNavigationGuards(contents as never, {
      allowedOrigins: ["https://alpha.example.test"],
      allowedFrameOrigins: ["https://live.browser-use.com"],
      windowName: "d568-test",
    });
    let prevented = false;
    const url = "https://live.browser-use.com/session?token=secret";
    listeners.get("will-frame-navigate")?.({ url, isMainFrame: true, preventDefault: () => {} });
    listeners.get("will-navigate")?.({ preventDefault: () => { prevented = true; } }, url);

    expect(prevented).toBe(true);
    expect(openExternal).toHaveBeenCalledWith(url);
  });

  test("navigation logs strip query parameters, fragments, and credentials", () => {
    const secret = "secret-capability";
    expect(safeNavigationUrlForLogging(
      `https://user:password@live.browser-use.com/session/path?token=${secret}#fragment`,
    )).toBe("https://live.browser-use.com");
    expect(safeNavigationUrlForLogging("mailto:private@example.test")).toBe("mailto:[redacted]");

    const listeners = new Map<string, (...args: any[]) => void>();
    attachNavigationGuards({
      setWindowOpenHandler: () => undefined,
      on: (event: string, listener: (...args: any[]) => void) => {
        listeners.set(event, listener);
      },
    } as never, {
      allowedOrigins: ["https://alpha.example.test"],
      windowName: "d568-log-test",
    });
    listeners.get("will-frame-navigate")?.({
      url: `https://user:password@attacker.example/frame?token=${secret}#fragment`,
      isMainFrame: false,
      preventDefault: () => {},
    });

    const serializedLogs = JSON.stringify([
      ...logInfo.mock.calls,
      ...logWarn.mock.calls,
    ]);
    expect(serializedLogs).not.toContain(secret);
    expect(serializedLogs).not.toContain("password");
    expect(serializedLogs).toContain("https://attacker.example");
    expect(serializedLogs).not.toContain("/frame");
  });
});
