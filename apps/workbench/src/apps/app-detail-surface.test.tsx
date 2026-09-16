import { reapplyHappyDomGlobals } from "../../tests/bun-dom-preload";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { PublicMiniAppDto } from "@nautilo/api-client/browser";
import type { InstalledAppsState } from "./use-installed-apps";

const sampleApp: PublicMiniAppDto = {
  id: "sample-app",
  name: "Sample App",
  version: "0.1.0",
  status: "ready",
  sourceHash: "a".repeat(64),
  fileAssociations: { extensions: [".html"], mimeTypes: [] },
  createActions: [],
  canEditSource: false,
  description: "A small workspace utility",
  installedAt: "2026-01-10T00:00:00.000Z",
  enabled: true,
};

const sheetsApp: PublicMiniAppDto = {
  ...sampleApp,
  id: "nautilo-spreadsheet",
  name: "Sheets",
  fileAssociations: { extensions: [], mimeTypes: [] },
  contentAssociations: [{
    id: "wafflebase-spreadsheet",
    kind: "html-script-json",
    scriptId: "manifest",
    scriptType: "application/vnd.nautilo.document+json",
    match: { documentType: "spreadsheet", editor: "wafflebase" },
  }],
};

const slidesApp: PublicMiniAppDto = {
  ...sheetsApp,
  id: "nautilo-presentation",
  name: "Slides",
  fileAssociations: { extensions: [], mimeTypes: [] },
  contentAssociations: [{
    id: "wafflebase-presentation",
    kind: "html-script-json",
    scriptId: "manifest",
    scriptType: "application/vnd.nautilo.document+json",
    match: { documentType: "presentation", editor: "wafflebase" },
  }],
};

const writerApp: PublicMiniAppDto = {
  ...sheetsApp,
  id: "nautilo-writer",
  name: "Writer",
  fileAssociations: { extensions: [], mimeTypes: [] },
  contentAssociations: [{
    id: "writer-document",
    kind: "html-script-json",
    scriptId: "manifest",
    scriptType: "application/vnd.nautilo.document+json",
    match: { documentType: "document", editor: "wafflebase" },
  }],
};

const boardApp: PublicMiniAppDto = {
  ...sheetsApp,
  id: "nautilo-board",
  name: "Board",
  fileAssociations: { extensions: [], mimeTypes: [] },
  contentAssociations: [{
    id: "wafflebase-board",
    kind: "html-script-json",
    scriptId: "manifest",
    scriptType: "application/vnd.nautilo.document+json",
    match: { documentType: "board", editor: "wafflebase" },
  }],
};

let installedAppsState: InstalledAppsState = { kind: "loading" };
const requestOpenMiniApp = mock(() => true);
const requestOpenAppDetail = mock(() => true);
const reload = mock(() => {});
const setMiniAppEnabled = mock(async () => ({ ...sampleApp, enabled: false }));
const onClose = mock(() => {});
const onBack = mock(() => {});

mock.module("./use-installed-apps", () => ({
  useInstalledApps: () => ({ ...installedAppsState, reload }),
}));

mock.module("../lib/api", () => ({
  apiClient: { setMiniAppEnabled },
}));

mock.module("../adapters/open-mini-app-ref", () => ({
  requestOpenMiniApp,
}));
const appSurfaceDispatchers = await import("../adapters/open-apps-surface-ref");
mock.module("../adapters/open-apps-surface-ref", () => ({
  ...appSurfaceDispatchers,
  requestOpenAppDetail,
}));

const { AppDetailSurface } = await import("./app-detail-surface");

/** Match the overview tests: happy-dom does not dispatch controlled search changes. */
function searchApps(input: HTMLElement, value: string): void {
  const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props not found on search input");
  const props = (input as HTMLElement & Record<string, unknown>)[propsKey] as {
    onChange: (event: { target: { value: string } }) => void;
  };
  act(() => props.onChange({ target: { value } }));
}

beforeEach(() => {
  cleanup();
  reapplyHappyDomGlobals();
  installedAppsState = { kind: "loading" };
  requestOpenMiniApp.mockClear();
  requestOpenAppDetail.mockClear();
  reload.mockClear();
  setMiniAppEnabled.mockClear();
  onClose.mockClear();
  onBack.mockClear();
});

describe("AppDetailSurface", () => {
  test("searches installed app descriptions and opens matching details without launching", () => {
    installedAppsState = { kind: "ready", apps: [sheetsApp, { ...sampleApp, id: "writer", name: "Writer", description: "Rich text documents", enabled: false }] };
    const view = render(<AppDetailSurface appId={sheetsApp.id} onClose={onClose} onBack={onBack} />);
    const search = view.getByRole("searchbox", { name: "Search apps" });
    searchApps(search, " RICH TEXT ");
    expect(view.getByRole("status").textContent).toBe("1 app found");
    fireEvent.click(view.getByRole("button", { name: "Writer Disabled" }));
    expect(requestOpenAppDetail).toHaveBeenCalledWith("writer");
    expect(requestOpenMiniApp).not.toHaveBeenCalled();
    expect(search).toHaveProperty("value", "");
    expect(view.queryByRole("navigation", { name: "App search results" }) === null).toBe(true);
  });

  test("search handles no matches, Escape, and clearing without leaving stale results", () => {
    installedAppsState = { kind: "ready", apps: [sheetsApp] };
    const view = render(<AppDetailSurface appId={sheetsApp.id} onClose={onClose} onBack={onBack} />);
    const search = view.getByRole("searchbox", { name: "Search apps" });
    searchApps(search, "unknown");
    expect(view.getByRole("status").textContent).toBe('No apps match “unknown”.');
    expect(requestOpenAppDetail).not.toHaveBeenCalled();
    fireEvent.keyDown(search.parentElement!.parentElement!, { key: "Escape" });
    expect(view.queryByRole("navigation", { name: "App search results" }) === null).toBe(true);
    searchApps(search, "sheets");
    expect(view.getByRole("status").textContent).toBe("1 app found");
    searchApps(search, "");
    expect(view.queryByRole("navigation", { name: "App search results" }) === null).toBe(true);
  });

  test("search dismisses when focus leaves and provides retry on load failure", () => {
    installedAppsState = { kind: "error", message: "network error" };
    const view = render(<AppDetailSurface appId={sheetsApp.id} onClose={onClose} onBack={onBack} />);
    const search = view.getByRole("searchbox", { name: "Search apps" });
    searchApps(search, "sheets");
    const retry = view.getByRole("button", { name: "Try again" });
    fireEvent.blur(search, { relatedTarget: retry });
    fireEvent.click(retry);
    expect(reload).toHaveBeenCalledTimes(1);
    fireEvent.blur(retry, { relatedTarget: view.getByTestId("app-detail-back") });
    expect(view.queryByRole("navigation", { name: "App search results" }) === null).toBe(true);
  });

  test("Video 0.2.1 has a recognizable icon and bundled editor overview instead of an empty preview", () => {
    installedAppsState = { kind: "ready", apps: [{ ...sampleApp, id: "nautilo-video", name: "Video", version: "0.2.1" }] };
    const view = render(<AppDetailSurface appId="nautilo-video" onClose={onClose} onBack={onBack} />);
    expect(view.getByLabelText("Video editor")).toBeTruthy();
    expect(view.getByTestId("video-app-overview")).toBeTruthy();
    expect(view.getByRole("img", { name: /Video editor overview/ })).toBeTruthy();
    expect(view.queryByText("No preview yet")).toBeNull();
    expect(view.getByText(/v0.2.1/)).toBeTruthy();
  });
  test("renders name and description for a known app", () => {
    installedAppsState = { kind: "ready", apps: [sampleApp] };
    const view = render(
      <AppDetailSurface appId="sample-app" onClose={onClose} onBack={onBack} />,
    );

    expect(view.getByText("Sample App")).toBeTruthy();
    expect(view.getByTestId("app-detail-description").textContent).toBe(
      "A small workspace utility",
    );
    expect(view.getByTestId("app-detail-associations").textContent).toBe(".html");
  });

  test("summarizes Writer, Sheets, and Slides content associations from their verified manifests", () => {
    installedAppsState = { kind: "ready", apps: [writerApp, sheetsApp, slidesApp] };
    const view = render(<AppDetailSurface appId={writerApp.id} onClose={onClose} onBack={onBack} />);
    expect(view.getByTestId("app-detail-associations").textContent).toBe(
      "Document documents · verified manifest",
    );

    view.rerender(<AppDetailSurface appId={sheetsApp.id} onClose={onClose} onBack={onBack} />);
    expect(view.getByTestId("app-detail-associations").textContent).toBe(
      "Spreadsheet documents · verified manifest",
    );

    view.rerender(<AppDetailSurface appId={slidesApp.id} onClose={onClose} onBack={onBack} />);
    expect(view.getByTestId("app-detail-associations").textContent).toBe(
      "Presentation documents · verified manifest",
    );
  });

  test("summarizes an unknown content-only app and falls back when associations are absent", () => {
    const unknownContentApp: PublicMiniAppDto = {
      ...sheetsApp,
      id: "content-only",
      fileAssociations: { extensions: [], mimeTypes: [] },
      contentAssociations: [{
        id: "unknown-content",
        kind: "html-script-json",
        scriptId: "manifest",
        scriptType: "application/vnd.nautilo.document+json",
        match: { documentType: "canvas", editor: "wafflebase" },
      }],
    };
    const noAssociationsApp: PublicMiniAppDto = {
      ...sheetsApp,
      id: "no-associations",
      fileAssociations: null,
      contentAssociations: [],
    };
    installedAppsState = { kind: "ready", apps: [unknownContentApp, noAssociationsApp] };
    const view = render(
      <AppDetailSurface appId={unknownContentApp.id} onClose={onClose} onBack={onBack} />,
    );
    expect(view.getByTestId("app-detail-associations").textContent).toBe(
      "Canvas documents · verified manifest",
    );

    view.rerender(
      <AppDetailSurface appId={noAssociationsApp.id} onClose={onClose} onBack={onBack} />,
    );
    expect(view.getByTestId("app-detail-associations").textContent).toBe("No associations");
  });

  test("renders the branded Sheets icon and product preview with useful alt text", () => {
    installedAppsState = { kind: "ready", apps: [sheetsApp] };
    const view = render(
      <AppDetailSurface appId="nautilo-spreadsheet" onClose={onClose} onBack={onBack} />,
    );

    expect(view.getByRole("img", { name: "Sheets showing a studio launch budget with formulas and spending totals" }).getAttribute("src")).toBe(
      "/apps/office/sheets-preview.png",
    );
    const icon = view.container.querySelector('img[src="/apps/office/sheets.svg"]');
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
  });

  test("falls back cleanly when the Sheets preview cannot load", () => {
    installedAppsState = { kind: "ready", apps: [sheetsApp] };
    const view = render(
      <AppDetailSurface appId="nautilo-spreadsheet" onClose={onClose} onBack={onBack} />,
    );
    fireEvent.error(view.getByRole("img", { name: "Sheets showing a studio launch budget with formulas and spending totals" }));
    expect(view.getByText("No preview yet")).toBeTruthy();
  });

  test("renders the Slides icon and real editor preview with useful alt text", () => {
    installedAppsState = { kind: "ready", apps: [slidesApp] };
    const view = render(
      <AppDetailSurface appId="nautilo-presentation" onClose={onClose} onBack={onBack} />,
    );

    const preview = view.getByRole("img", {
      name: "Nautilo Slides showing a Studio North launch presentation with slide thumbnails and speaker notes",
    });
    expect(preview.getAttribute("src")).toBe("/apps/office/slides-preview.png");
    expect(view.container.querySelector('img[src="/apps/office/slides.svg"]')?.getAttribute("aria-hidden")).toBe("true");

    fireEvent.error(preview);
    expect(view.getByText("No preview yet")).toBeTruthy();
  });

  test("renders the Board icon and real editor preview with useful alt text", () => {
    installedAppsState = { kind: "ready", apps: [boardApp] };
    const view = render(<AppDetailSurface appId="nautilo-board" onClose={onClose} onBack={onBack} />);

    const preview = view.getByRole("img", {
      name: "Board showing Studio North's launch map with connected notes for the signal, story, moment, and launch week",
    });
    expect(preview.getAttribute("src")).toBe("/apps/office/board-preview.png");
    expect(view.container.querySelector('img[src="/apps/office/board.svg"]')?.getAttribute("aria-hidden")).toBe("true");

    fireEvent.error(preview);
    expect(view.getByText("No preview yet")).toBeTruthy();
  });

  test("switches between Writer and Design previews in expanded app details", () => {
    const designApp = { ...sampleApp, id: "nautilo-design", name: "Nautilo Design" };
    installedAppsState = { kind: "ready", apps: [writerApp, designApp] };
    const view = render(<AppDetailSurface appId={writerApp.id} onClose={onClose} onBack={onBack} />);
    const writerPreview = view.getByRole("img", { name: /Writer editing a Studio North creative brief/ });
    expect(writerPreview.getAttribute("src")).toBe("/apps/office/writer-preview.png");
    expect(view.queryByText("No preview yet")).toBeNull();

    fireEvent.error(writerPreview);
    expect(view.getByText("No preview yet")).toBeTruthy();
    view.rerender(<AppDetailSurface appId={designApp.id} onClose={onClose} onBack={onBack} />);
    const designPreview = view.getByRole("img", { name: /Nautilo Design showing a Studio North launch poster/ });
    expect(designPreview.getAttribute("src")).toBe("/apps/office/design-preview.png");
    expect(view.queryByText("No preview yet")).toBeNull();
    fireEvent.error(designPreview);
    expect(view.getByText("No preview yet")).toBeTruthy();
  });

  test("launch button calls requestOpenMiniApp", () => {
    installedAppsState = { kind: "ready", apps: [sampleApp] };
    const view = render(
      <AppDetailSurface appId="sample-app" onClose={onClose} onBack={onBack} />,
    );

    fireEvent.click(view.getByTestId("app-detail-launch"));
    expect(requestOpenMiniApp).toHaveBeenCalledWith("sample-app");
  });

  test("back button calls onBack", () => {
    installedAppsState = { kind: "ready", apps: [sampleApp] };
    const view = render(
      <AppDetailSurface appId="sample-app" onClose={onClose} onBack={onBack} />,
    );

    fireEvent.click(view.getByTestId("app-detail-back"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  test("unknown appId shows not-found state", () => {
    installedAppsState = { kind: "ready", apps: [sampleApp] };
    const view = render(
      <AppDetailSurface appId="missing" onClose={onClose} onBack={onBack} />,
    );

    expect(view.getByTestId("app-detail-not-found")).toBeTruthy();
    expect(view.getByText("App not found.")).toBeTruthy();
  });

  test("disable button is actionable (D343); uninstall still disabled", () => {
    installedAppsState = { kind: "ready", apps: [sampleApp] };
    const view = render(
      <AppDetailSurface appId="sample-app" onClose={onClose} onBack={onBack} />,
    );

    const disable = view.getByTestId("app-detail-disable");
    expect(disable).toHaveProperty("disabled", false);
    expect(disable.textContent).toBe("Disable");
    expect(view.getByTestId("app-detail-uninstall")).toHaveProperty("disabled", true);
  });

  test("does not launch a disabled app but leaves Enable available", () => {
    installedAppsState = { kind: "ready", apps: [{ ...sampleApp, enabled: false }] };
    const view = render(
      <AppDetailSurface appId="sample-app" onClose={onClose} onBack={onBack} />,
    );

    expect(view.getByTestId("app-detail-launch")).toHaveProperty("disabled", true);
    expect(view.getByTestId("app-detail-disable")).toHaveProperty("disabled", false);
    expect(view.getByTestId("app-detail-disable").textContent).toBe("Enable");
  });

  test("reports a failed enable request", async () => {
    installedAppsState = { kind: "ready", apps: [{ ...sampleApp, enabled: false }] };
    setMiniAppEnabled.mockRejectedValueOnce(new Error("denied"));
    const view = render(
      <AppDetailSurface appId="sample-app" onClose={onClose} onBack={onBack} />,
    );

    await act(async () => {
      fireEvent.click(view.getByTestId("app-detail-disable"));
    });
    expect(view.getByRole("alert").textContent).toBe("Could not update this app. Try again.");
  });
});
