import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render } from "@testing-library/react";
import type { GenieHandoffV1 } from "@nautilo/types";

const attachWebview = mock(async () => null);
const detachWebview = mock(async () => true);
const openExternal = mock(async () => undefined);

mock.module("../../src/lib/desktop", () => ({
  desktopAPI: {
    browserControl: {
      attachWebview,
      detachWebview,
      openExternal,
    },
  },
}));

mock.module("../../src/hooks/use-auth", () => ({
  useAuth: () => ({
    viewer: { isVerified: true, sessionUserId: "viewer-1", userIdentity: null },
  }),
}));

const { SaasAppSurface } = await import("../../src/apps/saas-app-surface");
const { getHistory, setHome } = await import("../../src/lib/web-prefs");

beforeEach(() => {
  reapplyHappyDomGlobals();
  attachWebview.mockClear();
  detachWebview.mockClear();
  openExternal.mockClear();
  try {
    window.localStorage.clear();
  } catch {
    /* localStorage may be unavailable in some envs */
  }
});

describe("SaasAppSurface", () => {
  test("adopts an already-ready webview without waiting for another dom-ready", async () => {
    const getWebContentsId = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "getWebContentsId",
    );
    Object.defineProperty(HTMLElement.prototype, "getWebContentsId", {
      configurable: true,
      value: () => 84,
    });

    try {
      const { getByTestId } = render(
        <SaasAppSurface
          appId="browser"
          displayName="Browser"
          initialUrl="https://example.com"
          mode="browser"
          onClose={() => {}}
        />,
      );

      await act(async () => {
        await Promise.resolve();
      });

      expect(attachWebview).toHaveBeenCalledTimes(1);
      expect(attachWebview).toHaveBeenCalledWith({
        appId: "browser",
        mode: "browser",
        partition: "persist:browser",
        url: "https://example.com",
        webContentsId: 84,
      });

      await act(async () => {
        getByTestId("saas-app-webview").dispatchEvent(new Event("dom-ready"));
      });
      expect(attachWebview).toHaveBeenCalledTimes(1);
    } finally {
      if (getWebContentsId) {
        Object.defineProperty(HTMLElement.prototype, "getWebContentsId", getWebContentsId);
      } else {
        delete (HTMLElement.prototype as { getWebContentsId?: unknown }).getWebContentsId;
      }
    }
  });

  test("renders a webview and adopts its webContents on dom-ready", async () => {
    const { getByTestId, unmount } = render(
      <SaasAppSurface
        appId="google-docs"
        displayName="Google Docs"
        initialUrl="https://docs.google.com"
        onClose={() => {}}
      />,
    );

    const webview = getByTestId("saas-app-webview");
    expect(webview).toBeTruthy();
    expect(webview.getAttribute("src")).toBe("https://docs.google.com");
    expect(webview.getAttribute("partition")).toBe("persist:google-docs");

    (webview as unknown as { getWebContentsId: () => number }).getWebContentsId =
      () => 42;

    await act(async () => {
      webview.dispatchEvent(new Event("dom-ready"));
    });

    expect(attachWebview).toHaveBeenCalledWith({
      appId: "google-docs",
      mode: "app",
      partition: "persist:google-docs",
      url: "https://docs.google.com",
      webContentsId: 42,
    });

    unmount();
    expect(detachWebview).toHaveBeenCalledWith({ appId: "google-docs" });
  });

  test("renders browser chrome in browser mode", () => {
    const { getByLabelText, getByTestId } = render(
      <SaasAppSurface
        appId="browser"
        displayName="Browser"
        initialUrl="https://duckduckgo.com"
        mode="browser"
        onClose={() => {}}
      />,
    );

    expect(getByTestId("browser-chrome")).toBeTruthy();
    expect(getByLabelText("Back")).toBeTruthy();
    expect(getByLabelText("Forward")).toBeTruthy();
    expect(getByLabelText("Reload")).toBeTruthy();
    expect(getByLabelText("Home")).toBeTruthy();
    expect((getByLabelText("Browser address") as HTMLInputElement).value).toBe(
      "https://duckduckgo.com",
    );
    expect(getByLabelText("Set as home")).toBeTruthy();
  });

  test("smart address bar routes a query to search, not a bad URL", () => {
    const { getByLabelText, getByTestId } = render(
      <SaasAppSurface
        appId="browser"
        displayName="Browser"
        initialUrl="https://duckduckgo.com"
        mode="browser"
        onClose={() => {}}
      />,
    );

    const webview = getByTestId("saas-app-webview");
    const loadURL = mock((_url: string) => {});
    (webview as unknown as { loadURL: (u: string) => void }).loadURL = loadURL;

    const input = getByLabelText("Browser address") as HTMLInputElement;
    // happy-dom does not propagate fireEvent.change to controlled inputs; the
    // "input" event maps to React's onChange.
    fireEvent.input(input, { target: { value: "nautilo docs" } });
    fireEvent.submit(getByTestId("browser-chrome"));

    expect(loadURL).toHaveBeenCalledTimes(1);
    const target = loadURL.mock.calls[0]?.[0] ?? "";
    expect(target.startsWith("https://duckduckgo.com/?q=")).toBe(true);
    expect(target).not.toBe("https://nautilo docs");
  });

  test("Send to Genie builds the exact browser draft handoff", async () => {
    const received: GenieHandoffV1[] = [];

    const { getByLabelText } = render(
      <SaasAppSurface
        appId="browser"
        displayName="Browser"
        initialUrl="https://duckduckgo.com"
        mode="browser"
        assistantName="Genie"
        onClose={() => {}}
        onSendToGenie={async (handoff) => { received.push(handoff); return true; }}
      />,
    );

    await act(async () => {
      fireEvent.click(getByLabelText("Send to Genie"));
      await Promise.resolve();
    });

    expect(received).toEqual([{
      version: 1,
      source: "browser.page",
      intent: "Help me understand this page.",
      context: { url: "https://duckduckgo.com" },
      delivery: "draft-current-room",
    }]);
  });

  test("Send to Genie normalizes selected page text before a reviewed handoff", async () => {
    const received: GenieHandoffV1[] = [];

    const { getByLabelText, getByTestId } = render(
      <SaasAppSurface
        appId="browser"
        displayName="Browser"
        initialUrl="https://duckduckgo.com"
        mode="browser"
        assistantName="Genie"
        onClose={() => {}}
        onSendToGenie={async (handoff) => { received.push(handoff); return true; }}
      />,
    );
    (getByTestId("saas-app-webview") as unknown as {
      executeJavaScript: (source: string) => Promise<unknown>;
    }).executeJavaScript = async () => "  e\u0301\nsecond line  ";

    await act(async () => {
      fireEvent.click(getByLabelText("Send to Genie"));
      await Promise.resolve();
    });

    expect(received).toEqual([{
      version: 1,
      source: "browser.page",
      intent: "Help me understand this page.",
      context: { url: "https://duckduckgo.com", selection: "é\nsecond line" },
      delivery: "draft-current-room",
    }]);
  });

  test("Send to Genie uses URL-only context when guest selection retrieval fails or is not text", async () => {
    const received: GenieHandoffV1[] = [];
    const { getByLabelText, getByTestId } = render(
      <SaasAppSurface appId="browser" displayName="Browser" initialUrl="https://duckduckgo.com" mode="browser" onClose={() => {}} onSendToGenie={async (handoff) => { received.push(handoff); return true; }} />,
    );
    const webview = getByTestId("saas-app-webview") as unknown as {
      executeJavaScript: (source: string) => Promise<unknown>;
    };
    webview.executeJavaScript = async () => { throw new Error("guest failed"); };
    await act(async () => { fireEvent.click(getByLabelText("Send to Genie")); await Promise.resolve(); });
    webview.executeJavaScript = async () => ({ selection: "not text" });
    await act(async () => { fireEvent.click(getByLabelText("Send to Genie")); await Promise.resolve(); });
    expect(received.map((handoff) => handoff.context)).toEqual([
      { url: "https://duckduckgo.com" },
      { url: "https://duckduckgo.com" },
    ]);
  });

  test("Send to Genie rejects oversized, hostile, and credential-bearing input with fixed feedback", async () => {
    const secret = "sk-do-not-echo-abcdefghijk";
    const received: GenieHandoffV1[] = [];
    const cases: Array<{ url: string; selection: string }> = [
      { url: "https://example.com", selection: "x".repeat(4097) },
      { url: "https://example.com", selection: "€".repeat(4096) },
      { url: "https://example.com", selection: "bad\u0000selection" },
      { url: `https://example.com/?token=${secret}`, selection: "safe" },
    ];
    for (const input of cases) {
      const view = render(
        <SaasAppSurface appId="browser" displayName="Browser" initialUrl={input.url} mode="browser" onClose={() => {}} onSendToGenie={async (handoff) => { received.push(handoff); return true; }} />,
      );
      const webview = view.getByTestId("saas-app-webview") as unknown as {
        executeJavaScript: (source: string) => Promise<unknown>;
      };
      webview.executeJavaScript = async () => input.selection;
      await act(async () => { fireEvent.click(view.getByLabelText("Send to Genie")); await Promise.resolve(); });
      const status = view.getByRole("status");
      expect(status.textContent).toBe("Could not add this page to Genie’s draft.");
      expect(status.textContent).not.toContain(secret);
      view.unmount();
    }
    expect(received).toEqual([]);
  });

  test("Send to Genie bounds guest extraction at 4097 code units", async () => {
    const sources: string[] = [];
    const { getByLabelText, getByRole, getByTestId } = render(
      <SaasAppSurface appId="browser" displayName="Browser" initialUrl="https://example.com" mode="browser" onClose={() => {}} onSendToGenie={async () => true} />,
    );
    (getByTestId("saas-app-webview") as unknown as {
      executeJavaScript: (source: string) => Promise<unknown>;
    }).executeJavaScript = async (source) => {
      sources.push(source);
      return "x".repeat(4097);
    };
    await act(async () => { fireEvent.click(getByLabelText("Send to Genie")); await Promise.resolve(); });
    expect(sources).toEqual(["String(window.getSelection && window.getSelection() || '').slice(0, 4097)"]);
    expect(getByRole("status").textContent).toBe("Could not add this page to Genie’s draft.");
  });

  test("Send to Genie reports missing or rejected draft dispatch without exposing the cause", async () => {
    const secret = "sk-do-not-echo-abcdefghijk";
    const missing = render(
      <SaasAppSurface appId="browser" displayName="Browser" initialUrl="https://example.com" mode="browser" onClose={() => {}} />,
    );
    await act(async () => { fireEvent.click(missing.getByLabelText("Send to Genie")); await Promise.resolve(); });
    expect(missing.getByRole("status").textContent).toBe("Could not add this page to Genie’s draft.");
    missing.unmount();

    const rejected = render(
      <SaasAppSurface appId="browser" displayName="Browser" initialUrl="https://example.com" mode="browser" onClose={() => {}} onSendToGenie={async () => { throw new Error(secret); }} />,
    );
    await act(async () => { fireEvent.click(rejected.getByLabelText("Send to Genie")); await Promise.resolve(); });
    expect(rejected.getByRole("status").textContent).toBe("Could not add this page to Genie’s draft.");
    expect(rejected.getByRole("status").textContent).not.toContain(secret);
  });

  test("Home navigates to the saved home (default DuckDuckGo, then override)", () => {
    const { getByLabelText, getByTestId, rerender } = render(
      <SaasAppSurface
        appId="browser"
        displayName="Browser"
        initialUrl="https://start.example"
        mode="browser"
        onClose={() => {}}
      />,
    );
    const webview = getByTestId("saas-app-webview");
    const loadURL = mock((_url: string) => {});
    (webview as unknown as { loadURL: (u: string) => void }).loadURL = loadURL;

    fireEvent.click(getByLabelText("Home"));
    expect(loadURL).toHaveBeenLastCalledWith("https://duckduckgo.com");

    // A viewer-set home wins on the next Home click (viewer key = "viewer-1").
    setHome("viewer-1", "https://home.example");
    rerender(
      <SaasAppSurface
        appId="browser"
        displayName="Browser"
        initialUrl="https://start.example"
        mode="browser"
        onClose={() => {}}
      />,
    );
    fireEvent.click(getByLabelText("Home"));
    expect(loadURL).toHaveBeenLastCalledWith("https://home.example");
  });

  test("records ad-hoc browser navigations to per-viewer history", () => {
    const { getByTestId } = render(
      <SaasAppSurface
        appId="browser"
        displayName="Browser"
        initialUrl="https://duckduckgo.com"
        mode="browser"
        onClose={() => {}}
      />,
    );
    const webview = getByTestId("saas-app-webview") as unknown as {
      getURL: () => string;
      getTitle: () => string;
      canGoBack: () => boolean;
      canGoForward: () => boolean;
      dispatchEvent: (e: Event) => boolean;
    };
    webview.getURL = () => "https://example.com/page";
    webview.getTitle = () => "Example Page";
    webview.canGoBack = () => false;
    webview.canGoForward = () => false;

    act(() => {
      (webview as unknown as HTMLElement).dispatchEvent(new Event("did-navigate"));
    });

    const history = getHistory("viewer-1");
    expect(history[0]?.url).toBe("https://example.com/page");
    expect(history[0]?.title).toBe("Example Page");
  });

  test("Copy URL writes the current page URL to the clipboard", () => {
    const writeText = mock((_t: string) => Promise.resolve());
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    const { getByLabelText } = render(
      <SaasAppSurface
        appId="browser"
        displayName="Browser"
        initialUrl="https://duckduckgo.com"
        mode="browser"
        onClose={() => {}}
      />,
    );
    fireEvent.click(getByLabelText("Copy URL"));
    expect(writeText).toHaveBeenCalledWith("https://duckduckgo.com");
  });

  test("Open in external browser routes the current URL to the desktop bridge", () => {
    const { getByLabelText } = render(
      <SaasAppSurface
        appId="browser"
        displayName="Browser"
        initialUrl="https://duckduckgo.com"
        mode="browser"
        onClose={() => {}}
      />,
    );
    fireEvent.click(getByLabelText("Open in external browser"));
    expect(openExternal).toHaveBeenCalledWith({ url: "https://duckduckgo.com" });
  });

  test("Find in page opens a find bar and searches the guest", () => {
    const { getByLabelText, getByTestId, queryByTestId } = render(
      <SaasAppSurface
        appId="browser"
        displayName="Browser"
        initialUrl="https://duckduckgo.com"
        mode="browser"
        onClose={() => {}}
      />,
    );
    expect(queryByTestId("browser-find-bar")).toBeNull();

    const webview = getByTestId("saas-app-webview");
    const findInPage = mock((_t: string) => 1);
    (webview as unknown as { findInPage: (t: string) => number }).findInPage = findInPage;
    (webview as unknown as { stopFindInPage: () => void }).stopFindInPage = mock(() => {});

    fireEvent.click(getByLabelText("Find in page"));
    expect(getByTestId("browser-find-bar")).toBeTruthy();

    fireEvent.input(getByLabelText("Find in page input"), {
      target: { value: "hello" },
    });
    expect(findInPage).toHaveBeenCalledWith("hello", { forward: true, findNext: true });
  });
});
