import { reapplyHappyDomGlobals } from "../../../tests/bun-dom-preload";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import type { ConnectedAppCatalogueSummary } from "./connected-app-presentation";
import { ConnectedAppsCatalogueLayout } from "./connected-apps-catalogue";

const DEFAULT_SUMMARIES: Readonly<
  Record<"google" | "notion" | "slack", ConnectedAppCatalogueSummary>
> = {
  google: {
    state: "attention",
    statusLabel: "Reconnect required",
    tone: "warn",
  },
  notion: {
    state: "available",
    statusLabel: "Waiting for administrator",
    tone: "muted",
  },
  slack: {
    state: "available",
    statusLabel: "Not connected",
    tone: "muted",
  },
};

const APPS = [
  {
    id: "google",
    displayName: "Google Workspace",
    shortMark: "G",
    description: "Email, calendars, files, documents, and spreadsheets.",
    searchText: "google workspace gmail email calendar drive files documents docs sheets spreadsheets",
    experimental: false,
    iconUrl: null,
  },
  {
    id: "notion",
    displayName: "Notion",
    shortMark: "N",
    description: "Search and read your workspace, and create pages with your approval.",
    searchText: "notion workspace search pages databases read create documents notes",
    experimental: true,
    iconUrl: null,
  },
  {
    id: "slack",
    displayName: "Slack",
    shortMark: "S",
    description: "List and search conversations, read messages, and post with your approval.",
    searchText: "slack conversations channels messages search read post chat communication",
    experimental: true,
    iconUrl: null,
  },
] as const;

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
});

function renderCatalogue({
  summaries = DEFAULT_SUMMARIES,
  routeHash,
  routeKey,
  onSelectApp,
  onBackToApps,
}: {
  readonly summaries?: Readonly<
    Record<"google" | "notion" | "slack", ConnectedAppCatalogueSummary>
  >;
  readonly routeHash?: string;
  readonly routeKey?: string;
  readonly onSelectApp?: (appId: "google" | "notion" | "slack") => void;
  readonly onBackToApps?: () => void;
} = {}) {
  return render(
    <ConnectedAppsCatalogueLayout
      summaries={summaries}
      routeHash={routeHash}
      routeKey={routeKey}
      onSelectApp={onSelectApp}
      onBackToApps={onBackToApps}
      apps={APPS}
      details={{
        google: <div>Google controller detail</div>,
        notion: <div>Notion controller detail</div>,
        slack: <div>Slack controller detail</div>,
      }}
    />,
  );
}

function typeInControlledInput(input: HTMLInputElement, value: string): void {
  const propsKey = Object.keys(input).find((key) =>
    key.startsWith("__reactProps$"),
  );
  if (!propsKey) throw new Error("React props not found on input element");
  const props = (input as HTMLInputElement & Record<string, unknown>)[
    propsKey
  ] as {
    onChange: (event: { target: { value: string } }) => void;
  };
  props.onChange({ target: { value } });
}

describe("ConnectedAppsCatalogueLayout", () => {
  test("renders a catalog-supplied app without a compiled provider branch", () => {
    const canva = {
      id: "canva",
      displayName: "Canva",
      shortMark: "C",
      description: "Find and manage approved Canva designs.",
      searchText: "canva designs presentations graphics",
      experimental: true,
      iconUrl: null,
    } as const;
    const view = render(
      <ConnectedAppsCatalogueLayout
        apps={[...APPS, canva]}
        summaries={{
          ...DEFAULT_SUMMARIES,
          canva: { state: "available", statusLabel: "Not connected", tone: "muted" },
        }}
        details={{
          google: <div>Google controller detail</div>,
          notion: <div>Notion controller detail</div>,
          slack: <div>Slack controller detail</div>,
          canva: <div>Generic Canva detail</div>,
        }}
      />,
    );
    fireEvent.click(view.getByRole("button", { name: "Canva, Not connected" }));
    expect(view.getByRole("complementary", { name: "Canva connection details" })).toBeTruthy();
    expect(view.getByText("Generic Canva detail")).toBeTruthy();
    expect(view.getAllByText("Pilot").length).toBeGreaterThan(0);
  });

  test("renders stable icon-and-label tiles with detail closed by default", () => {
    const view = renderCatalogue();

    const googleTile = view.getByRole("button", {
      name: "Google Workspace, Reconnect required",
    });
    const notionTile = view.getByRole("button", {
      name: "Notion, Waiting for administrator",
    });
    const slackTile = view.getByRole("button", {
      name: "Slack, Not connected",
    });
    expect(googleTile.hasAttribute("aria-current")).toBe(false);
    expect(notionTile.hasAttribute("aria-current")).toBe(false);
    expect(slackTile.hasAttribute("aria-current")).toBe(false);
    expect(view.getByRole("heading", { name: "Needs attention" })).toBeTruthy();
    expect(
      view.queryByRole("complementary", {
        name: "Google Workspace connection details",
      }),
    ).toBeNull();

    fireEvent.click(googleTile);
    const detail = view.getByRole("complementary", {
      name: "Google Workspace connection details",
    });
    expect(within(detail).getByText("Google controller detail")).toBeTruthy();
    expect(view.queryByText("Notion controller detail")).toBeNull();
  });

  test("searches provider names and admitted capability language", async () => {
    const view = renderCatalogue();

    await act(async () => {
      typeInControlledInput(
        view.getByRole("searchbox", {
          name: "Search apps and capabilities",
        }) as HTMLInputElement,
        "databases",
      );
    });

    await waitFor(() => {
      expect(
        view.getAllByRole("button", {
          name: "Notion, Waiting for administrator",
        }),
      ).toHaveLength(1);
      expect(
        view.queryAllByRole("button", {
          name: "Google Workspace, Reconnect required",
        }),
      ).toHaveLength(0);
    });
  });

  test("filters by connection state and selects the exact provider hash", async () => {
    const onSelectApp = mock((_appId: "google" | "notion") => undefined);
    const summaries = {
      ...DEFAULT_SUMMARIES,
      notion: { state: "connected", statusLabel: "Connected", tone: "ok" },
    } satisfies Record<"google" | "notion", ConnectedAppCatalogueSummary>;
    const view = renderCatalogue({ summaries, onSelectApp });

    fireEvent.click(view.getByRole("button", { name: "Connected" }));
    await waitFor(() => {
      expect(
        view.getAllByRole("button", { name: "Notion, Connected" }),
      ).toHaveLength(1);
      expect(
        view.queryAllByRole("button", {
          name: "Google Workspace, Reconnect required",
        }),
      ).toHaveLength(0);
    });

    fireEvent.click(view.getByRole("button", { name: "Notion, Connected" }));
    expect(onSelectApp).toHaveBeenCalledWith("notion");
    expect(
      view.getByRole("complementary", { name: "Notion connection details" }),
    ).toBeTruthy();
    expect(view.queryByText("Google controller detail")).toBeNull();
    expect(view.getByText("Notion controller detail")).toBeTruthy();
  });

  test("honors an existing provider hash and exposes narrow-layout return", () => {
    const onBackToApps = mock(() => undefined);
    const view = renderCatalogue({
      routeHash: "#notion",
      routeKey: "route-1",
      onBackToApps,
    });

    expect(
      view
        .getByRole("button", { name: "Notion, Waiting for administrator" })
        .getAttribute("aria-current"),
    ).toBe("true");
    fireEvent.click(view.getByRole("button", { name: "Back to apps" }));
    expect(onBackToApps).toHaveBeenCalledTimes(1);
    expect(
      view.queryByRole("complementary", { name: "Notion connection details" }),
    ).toBeNull();
  });

  test("uses a fixed independently scrolling inspector and closes with Escape", () => {
    const onBackToApps = mock(() => undefined);
    const view = renderCatalogue({
      routeHash: "#google",
      routeKey: "route-1",
      onBackToApps,
    });

    const catalogue = view.getByTestId("connected-apps-catalogue");
    const detail = view.getByRole("complementary", {
      name: "Google Workspace connection details",
    });
    expect(catalogue.contains(detail)).toBe(false);
    expect(detail.className).toContain("fixed");
    expect(view.getByTestId("connected-app-detail-scroll").className).toContain(
      "overflow-y-auto",
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onBackToApps).toHaveBeenCalledTimes(1);
    expect(
      view.queryByRole("complementary", {
        name: "Google Workspace connection details",
      }),
    ).toBeNull();
  });
});
