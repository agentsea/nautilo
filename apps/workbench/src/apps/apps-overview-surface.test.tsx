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
  fileAssociations: { extensions: [], mimeTypes: [] },
  createActions: [],
  canEditSource: false,
  description: "A small workspace utility",
  installedAt: "2026-01-10T00:00:00.000Z",
};

const sheetsApp: PublicMiniAppDto = {
  ...sampleApp,
  id: "nautilo-spreadsheet",
  name: "Sheets",
};

const writerApp: PublicMiniAppDto = {
  ...sampleApp,
  id: "nautilo-writer",
  name: "Writer",
};

const slidesApp: PublicMiniAppDto = {
  ...sampleApp,
  id: "nautilo-presentation",
  name: "Slides",
};

const paintApp: PublicMiniAppDto = {
  id: "paint",
  name: "Paint Lite",
  version: "0.2.0",
  status: "ready",
  sourceHash: "b".repeat(64),
  fileAssociations: null,
  createActions: [],
  canEditSource: false,
  description: "Simple drawing",
  installedAt: "2026-02-01T00:00:00.000Z",
};

const notesApp: PublicMiniAppDto = {
  id: "notes",
  name: "Notes",
  version: "1.0.0",
  status: "needs_dependencies",
  sourceHash: null,
  fileAssociations: null,
  createActions: [],
  canEditSource: false,
  description: null,
  installedAt: null,
};

let installedAppsState: InstalledAppsState = { kind: "loading" };
const requestOpenMiniApp = mock(() => true);
const requestOpenAppDetail = mock(() => true);
const reload = mock(() => {});
const setMiniAppEnabled = mock(async () => ({ ...sampleApp, enabled: false }));
const onClose = mock(() => {});

mock.module("./use-installed-apps", () => ({
  useInstalledApps: () => ({ ...installedAppsState, reload }),
}));

mock.module("../lib/api", () => ({
  apiClient: { setMiniAppEnabled },
}));

mock.module("../adapters/open-mini-app-ref", () => ({
  requestOpenMiniApp,
}));

mock.module("../adapters/open-apps-surface-ref", () => ({
  requestOpenAppDetail,
  requestOpenAppsOverview: () => true,
  setOpenAppsOverviewDispatcher: () => {},
  setOpenAppDetailDispatcher: () => {},
}));

const { AppsOverviewSurface } = await import("./apps-overview-surface");
const { firstPartyAppVisual } = await import("./first-party-app-visuals");

function cardIds(view: ReturnType<typeof render>): string[] {
  return view
    .getAllByTestId(/^apps-overview-card-/)
    .map((el) => el.getAttribute("data-testid")!.replace("apps-overview-card-", ""));
}

/** happy-dom does not propagate fireEvent.change to controlled text/search inputs. */
function typeInControlledInput(input: HTMLInputElement, value: string): void {
  const propsKey = Object.keys(input).find((k) => k.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props not found on input element");
  const props = (input as HTMLInputElement & Record<string, unknown>)[propsKey] as {
    onChange: (e: { target: { value: string } }) => void;
  };
  props.onChange({ target: { value } });
}

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  installedAppsState = { kind: "loading" };
  requestOpenMiniApp.mockClear();
  requestOpenAppDetail.mockClear();
  reload.mockClear();
  setMiniAppEnabled.mockClear();
  onClose.mockClear();
});

describe("AppsOverviewSurface", () => {
  test("renders grid cards for ready apps", () => {
    installedAppsState = { kind: "ready", apps: [sampleApp, paintApp, notesApp] };
    const view = render(<AppsOverviewSurface onClose={onClose} />);

    expect(view.getByTestId("apps-overview-grid")).toBeTruthy();
    expect(view.getByTestId("apps-overview-card-sample-app")).toBeTruthy();
    expect(view.getByTestId("apps-overview-card-paint")).toBeTruthy();
    expect(view.getByTestId("apps-overview-card-notes")).toBeTruthy();
  });

  test("uses the shared first-party icon and keeps a letter fallback for other apps", () => {
    installedAppsState = { kind: "ready", apps: [sheetsApp, slidesApp, paintApp] };
    const view = render(<AppsOverviewSurface onClose={onClose} />);

    const sheetsIcon = view.getByTestId("apps-overview-card-nautilo-spreadsheet").querySelector("img");
    expect(sheetsIcon?.getAttribute("src")).toBe("/apps/office/sheets.svg");
    expect(sheetsIcon?.getAttribute("aria-hidden")).toBe("true");
    expect(
      view.getByTestId("apps-overview-card-nautilo-presentation").querySelector("img")?.getAttribute("src"),
    ).toBe("/apps/office/slides.svg");
    expect(view.getByLabelText("Paint Lite icon")).toBeTruthy();

    fireEvent.error(sheetsIcon!);
    expect(view.getByLabelText("Sheets icon")).toBeTruthy();

    installedAppsState = { kind: "ready", apps: [writerApp] };
    view.rerender(<AppsOverviewSurface onClose={onClose} />);
    expect(
      view.getByTestId("apps-overview-card-nautilo-writer").querySelector("img")?.getAttribute("src"),
    ).toBe("/apps/office/writer.svg");
  });

  test("does not resolve inherited object keys as first-party app visuals", () => {
    expect(firstPartyAppVisual("toString")).toBeUndefined();
    expect(firstPartyAppVisual("constructor")).toBeUndefined();
  });

  test("search input filters visible cards", async () => {
    installedAppsState = { kind: "ready", apps: [sampleApp, paintApp] };
    const view = render(<AppsOverviewSurface onClose={onClose} />);

    await act(async () => {
      typeInControlledInput(
        view.getByTestId("apps-overview-search") as HTMLInputElement,
        "drawing",
      );
    });
    expect(cardIds(view)).toEqual(["paint"]);
    expect(view.queryByTestId("apps-overview-card-sample-app")).toBeNull();
  });

  test("sort select reorders cards", async () => {
    installedAppsState = { kind: "ready", apps: [sampleApp, paintApp] };
    const view = render(<AppsOverviewSurface onClose={onClose} />);

    expect(cardIds(view)).toEqual(["paint", "sample-app"]);

    await act(async () => {
      fireEvent.change(view.getByTestId("apps-overview-sort"), { target: { value: "name-desc" } });
    });
    expect(cardIds(view)).toEqual(["sample-app", "paint"]);

    await act(async () => {
      fireEvent.change(view.getByTestId("apps-overview-sort"), { target: { value: "newest" } });
    });
    expect(cardIds(view)).toEqual(["paint", "sample-app"]);
  });

  test("launch button calls requestOpenMiniApp for ready apps", () => {
    installedAppsState = { kind: "ready", apps: [sampleApp] };
    const view = render(<AppsOverviewSurface onClose={onClose} />);

    fireEvent.click(view.getByTestId("apps-overview-launch-sample-app"));
    expect(requestOpenMiniApp).toHaveBeenCalledWith("sample-app");
  });

  test("details button calls requestOpenAppDetail", () => {
    installedAppsState = { kind: "ready", apps: [sampleApp] };
    const view = render(<AppsOverviewSurface onClose={onClose} />);

    fireEvent.click(view.getByTestId("apps-overview-details-sample-app"));
    expect(requestOpenAppDetail).toHaveBeenCalledWith("sample-app");
  });

  test("omits unavailable install while toggle is actionable", () => {
    installedAppsState = { kind: "ready", apps: [sampleApp] };
    const view = render(<AppsOverviewSurface onClose={onClose} />);

    expect(view.queryByTestId("apps-overview-install")).toBeNull();
    expect(view.getByTestId("apps-overview-toggle-sample-app")).toHaveProperty("disabled", false);
  });

  test("uses the app enabled flag, disables launch, and enables a disabled app", async () => {
    const disabledApp = { ...sampleApp, enabled: false };
    installedAppsState = { kind: "ready", apps: [disabledApp] };
    const view = render(<AppsOverviewSurface onClose={onClose} />);

    expect(view.getByText("⊘ Disabled")).toBeTruthy();
    expect(view.getByTestId("apps-overview-launch-sample-app")).toHaveProperty("disabled", true);
    expect(view.getByTestId("apps-overview-toggle-sample-app").getAttribute("aria-label")).toBe("Enable Sample App");

    await act(async () => {
      fireEvent.click(view.getByTestId("apps-overview-toggle-sample-app"));
    });
    expect(setMiniAppEnabled).toHaveBeenCalledWith("sample-app", true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("disables an enabled app through the lifecycle API", async () => {
    installedAppsState = { kind: "ready", apps: [sampleApp] };
    const view = render(<AppsOverviewSurface onClose={onClose} />);

    await act(async () => {
      fireEvent.click(view.getByTestId("apps-overview-toggle-sample-app"));
    });
    expect(setMiniAppEnabled).toHaveBeenCalledWith("sample-app", false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("reports a toggle failure without pretending the app was enabled", async () => {
    const disabledApp = { ...sampleApp, enabled: false };
    installedAppsState = { kind: "ready", apps: [disabledApp] };
    setMiniAppEnabled.mockRejectedValueOnce(new Error("denied"));
    const view = render(<AppsOverviewSurface onClose={onClose} />);

    await act(async () => {
      fireEvent.click(view.getByTestId("apps-overview-toggle-sample-app"));
    });
    expect(view.getByRole("alert").textContent).toBe("Could not update this app. Try again.");
    expect(view.getByText("⊘ Disabled")).toBeTruthy();
  });
});
