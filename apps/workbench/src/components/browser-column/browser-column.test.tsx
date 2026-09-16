import { reapplyHappyDomGlobals } from "../../../tests/bun-dom-preload";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { render } from "@testing-library/react";
import { BROWSER_TABS, firstVisibleTab } from "./browser-column.tabs";

mock.module("../../lib/desktop", () => ({
  isDesktop: false,
  desktopAPI: null,
}));
mock.module("./workspace-tab", () => ({
  WorkspaceTab: () => <div>Workspace contents</div>,
}));
mock.module("./files-tab", () => ({
  FilesTab: () => <div>Current folder contents</div>,
}));
mock.module("./current-folder-header", () => ({
  CurrentFolderHeader: () => <div>Current folder</div>,
}));

const { BrowserColumnProvider, useBrowserColumn } = await import("./browser-column.context");
const { BrowserColumn } = await import("./browser-column");

function ActiveTabProbe() {
  const { activeTab } = useBrowserColumn();
  return <span data-testid="active-tab">{activeTab}</span>;
}

beforeEach(() => {
  reapplyHappyDomGlobals();
  localStorage.clear();
});

describe("browser-column tabs visibility", () => {
  test("web shows Workspace but not Files", () => {
    const ctx = { isDesktop: false, currentFolderPath: null };
    expect(BROWSER_TABS.filter((tab) => tab.visible(ctx)).map((tab) => tab.id)).toEqual([
      "workspace",
    ]);
    expect(firstVisibleTab(ctx)).toBe("workspace");
  });

  test("desktop shows Workspace and Files", () => {
    const ctx = { isDesktop: true, currentFolderPath: "/tmp/project" };
    expect(BROWSER_TABS.filter((tab) => tab.visible(ctx)).map((tab) => tab.id)).toEqual([
      "workspace",
      "files",
    ]);
  });
});

describe("BrowserColumnProvider tab persistence", () => {
  test("migrates legacy apps tab to workspace", () => {
    localStorage.setItem("nautilo.browser.activeTab", "apps");
    const view = render(
      <BrowserColumnProvider>
        <ActiveTabProbe />
      </BrowserColumnProvider>,
    );
    expect(view.getByTestId("active-tab").textContent).toBe("workspace");
  });

  test("migrates legacy artifacts tab to workspace", () => {
    localStorage.setItem("nautilo.browser.activeTab", "artifacts");
    const view = render(
      <BrowserColumnProvider>
        <ActiveTabProbe />
      </BrowserColumnProvider>,
    );
    expect(view.getByTestId("active-tab").textContent).toBe("workspace");
  });

  test("migrates legacy activity tab to workspace", () => {
    localStorage.setItem("nautilo.browser.activeTab", "activity");
    const view = render(
      <BrowserColumnProvider>
        <ActiveTabProbe />
      </BrowserColumnProvider>,
    );
    expect(view.getByTestId("active-tab").textContent).toBe("workspace");
  });
});

describe("BrowserColumn tab presentation", () => {
  test("keeps Workspace selected without an accent underline", () => {
    const view = render(
      <BrowserColumnProvider>
        <BrowserColumn />
      </BrowserColumnProvider>,
    );
    const workspaceTab = view.getByRole("tab", { name: "Workspace" });

    expect(workspaceTab.getAttribute("aria-selected")).toBe("true");
    expect(workspaceTab.className).toContain("bg-background-muted");
    expect(workspaceTab.className).toContain("border-transparent");
    expect(workspaceTab.className).not.toContain("border-accent");
  });
});
