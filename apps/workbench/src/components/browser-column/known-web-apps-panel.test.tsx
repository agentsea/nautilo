import { reapplyHappyDomGlobals } from "../../../tests/bun-dom-preload";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render, waitFor } from "@testing-library/react";

const requestOpenSaasApp = mock(() => true);
const requestWebsiteConnection = mock(() => true);
const setWebsiteConnectionIntentDispatcher = mock(() => {});

mock.module("../../adapters/open-saas-app-ref", () => ({
  requestOpenSaasApp,
}));

mock.module("../../adapters/website-connection-intent", () => ({
  requestWebsiteConnection,
  setWebsiteConnectionIntentDispatcher,
}));

mock.module("../../hooks/use-auth", () => ({
  useAuth: () => ({
    viewer: {
      isVerified: true,
      sessionUserId: "user-1",
      userIdentity: "alex@example.com",
    },
  }),
}));

const { KnownWebAppsPanel } = await import("./known-web-apps-panel");
const {
  addPinnedSite,
  pushHistory,
  removePinnedSite,
} = await import("../../lib/web-prefs");

beforeEach(() => {
  reapplyHappyDomGlobals();
  localStorage.clear();
  requestOpenSaasApp.mockClear();
  requestWebsiteConnection.mockClear();
});

describe("KnownWebAppsPanel", () => {
  test("renders pinned search/actions and opens Google Docs", () => {
    const onCollapse = mock(() => {});
    const view = render(<KnownWebAppsPanel onCollapse={onCollapse} />);

    expect(view.getByPlaceholderText("Search apps…")).toBeTruthy();
    expect(view.getByText("🌐 Open browser…")).toBeTruthy();
    expect(view.getByText("＋ Add an app")).toBeTruthy();
    expect(view.getByTestId("known-web-apps-google-suite-toggle").getAttribute("aria-expanded")).toBe("true");
    expect(view.getByTestId("known-web-app-google-sheets")).toBeTruthy();
    const panelText = view.getByTestId("known-web-apps-panel").textContent ?? "";
    expect(panelText.indexOf("Google Sheets")).toBeLessThan(
      panelText.indexOf("Google Slides"),
    );

    fireEvent.click(view.getByText("🌐 Open browser…"));
    expect(requestOpenSaasApp).toHaveBeenCalledWith({
      appId: "browser",
      displayName: "Browser",
      initialUrl: "https://duckduckgo.com",
      mode: "browser",
    });

    fireEvent.click(view.getByTestId("known-web-app-google-docs"));
    expect(requestOpenSaasApp).toHaveBeenLastCalledWith({
      appId: "google-docs",
      displayName: "Google Docs",
      initialUrl: "https://docs.google.com/document/u/0/",
      skills: ["write", "read", "new doc"],
      status: "experimental",
    });

    fireEvent.click(view.getByLabelText("Hide web"));
    expect(onCollapse).toHaveBeenCalled();
  });

  test("filters known apps by search text", async () => {
    const view = render(<KnownWebAppsPanel onCollapse={() => {}} />);
    expect(view.getByTestId("known-web-app-gmail")).toBeTruthy();

    fireEvent.input(view.getByPlaceholderText("Search apps…"), {
      target: { value: "missing" },
    });
    await waitFor(() => {
      expect(view.queryByTestId("known-web-app-google-docs")).toBeNull();
      expect(view.queryByTestId("known-web-app-gmail")).toBeNull();
    });
  });

  test("projects catalogue websites through the shared connect-intent seam", () => {
    const view = render(<KnownWebAppsPanel onCollapse={() => {}} />);

    fireEvent.click(view.getByText("＋ Add an app"));
    expect(requestWebsiteConnection).toHaveBeenCalledWith({ kind: "custom", url: "" });

    fireEvent.click(view.getByTestId("known-web-website-notion"));
    expect(requestWebsiteConnection).toHaveBeenLastCalledWith({ kind: "catalogue", websiteId: "notion" });
    expect(view.getByTestId("known-web-apps-panel").textContent).not.toContain("Connected");
  });

  test("collapses Google Suite and persists viewer-scoped state", () => {
    const view = render(<KnownWebAppsPanel onCollapse={() => {}} />);
    fireEvent.click(view.getByTestId("known-web-apps-google-suite-toggle"));

    expect(view.getByTestId("known-web-apps-google-suite-toggle").getAttribute("aria-expanded")).toBe("false");
    expect(view.queryByTestId("known-web-app-google-docs")).toBeNull();
    expect(localStorage.getItem("nautilo.known-web-apps.google-suite.expanded.v1:user-1")).toBe("0");
  });

  test("search temporarily shows matches while Google Suite is collapsed", async () => {
    const view = render(<KnownWebAppsPanel onCollapse={() => {}} />);
    fireEvent.click(view.getByTestId("known-web-apps-google-suite-toggle"));
    expect(view.queryByTestId("known-web-app-google-docs")).toBeNull();

    fireEvent.input(view.getByPlaceholderText("Search apps…"), {
      target: { value: "sheets" },
    });

    await waitFor(() => {
      expect(view.getByTestId("known-web-app-google-sheets")).toBeTruthy();
    });
  });

  test("opens Gmail from known web apps", () => {
    const view = render(<KnownWebAppsPanel onCollapse={() => {}} />);

    fireEvent.click(view.getByTestId("known-web-app-gmail"));

    expect(requestOpenSaasApp).toHaveBeenCalledWith({
      appId: "gmail",
      displayName: "Gmail",
      initialUrl: "https://mail.google.com/mail/u/0/#inbox",
      skills: ["email", "drafts", "search"],
      status: "experimental",
    });
  });

  test("opens Google Sheets from known web apps", () => {
    const view = render(<KnownWebAppsPanel onCollapse={() => {}} />);

    fireEvent.click(view.getByTestId("known-web-app-google-sheets"));

    expect(requestOpenSaasApp).toHaveBeenCalledWith({
      appId: "google-sheets",
      displayName: "Google Sheets",
      initialUrl: "https://docs.google.com/spreadsheets/u/0/",
      skills: ["spreadsheets", "sheets", "tables"],
      status: "experimental",
    });
  });

  test("pinned empty-state hint shows when no pins", () => {
    const view = render(<KnownWebAppsPanel onCollapse={() => {}} />);
    expect(
      view.getByText("No pinned sites yet — ⭐ a page in the browser to pin it."),
    ).toBeTruthy();
    expect(view.queryByTestId("known-web-apps-pinned-any")).toBeNull();
  });

  test("renders a pinned tile, opens it in browser mode, and unpins", async () => {
    const viewerKey = "user-1";
    addPinnedSite(viewerKey, {
      appId: "pinned-docs",
      displayName: "My Doc",
      url: "https://example.com/doc",
      mode: "browser",
    });
    const view = render(<KnownWebAppsPanel onCollapse={() => {}} />);

    const tile = await waitFor(() =>
      view.getByTestId("known-web-apps-pinned-pinned-docs"),
    );
    expect(tile.textContent).toContain("My Doc");
    expect(tile.textContent).toContain("example.com");

    fireEvent.click(tile);
    expect(requestOpenSaasApp).toHaveBeenLastCalledWith({
      appId: "pinned-docs",
      displayName: "My Doc",
      initialUrl: "https://example.com/doc",
      mode: "browser",
    });

    fireEvent.click(view.getByLabelText("Unpin My Doc"));
    await waitFor(() =>
      expect(view.queryByTestId("known-web-apps-pinned-pinned-docs")).toBeNull(),
    );
    expect(removePinnedSite(viewerKey, "https://example.com/doc")).toEqual([]);
  });

  test("history entries render most-recent-first, open in browser mode, and Clear empties the list", async () => {
    const viewerKey = "user-1";
    pushHistory(viewerKey, { url: "https://example.com/a", title: "Page A", at: 1 });
    pushHistory(viewerKey, { url: "https://example.com/b", title: "Page B", at: 2 });

    const view = render(<KnownWebAppsPanel onCollapse={() => {}} />);

    expect(view.getByTestId("known-web-apps-history-toggle").getAttribute("aria-expanded")).toBe("false");
    expect(view.queryByTestId("known-web-apps-history-0")).toBeNull();

    fireEvent.click(view.getByTestId("known-web-apps-history-toggle"));
    expect(view.getByTestId("known-web-apps-history-toggle").getAttribute("aria-expanded")).toBe("true");
    expect(localStorage.getItem("nautilo.known-web-apps.history.expanded.v1:user-1")).toBe("1");

    const first = await waitFor(() => view.getByTestId("known-web-apps-history-0"));
    expect(first.textContent).toContain("Page B");
    expect(view.getByTestId("known-web-apps-history-1").textContent).toContain("Page A");

    fireEvent.click(first);
    expect(requestOpenSaasApp).toHaveBeenLastCalledWith({
      appId: "browser",
      displayName: "Page B",
      initialUrl: "https://example.com/b",
      mode: "browser",
    });

    fireEvent.click(view.getByLabelText("Clear history"));
    await waitFor(() =>
      expect(view.queryByTestId("known-web-apps-history-0")).toBeNull(),
    );
  });

  test("live-updates pinned sites via subscribeWebPrefs", async () => {
    const view = render(<KnownWebAppsPanel onCollapse={() => {}} />);
    expect(view.queryByTestId("known-web-apps-pinned-pinned-live")).toBeNull();

    addPinnedSite("user-1", {
      appId: "pinned-live",
      displayName: "Live Pin",
      url: "https://example.com/live",
      mode: "browser",
    });

    await waitFor(() =>
      view.getByTestId("known-web-apps-pinned-pinned-live"),
    );
  });
});
