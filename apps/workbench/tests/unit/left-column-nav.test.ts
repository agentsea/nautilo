import { describe, expect, test } from "bun:test";
import {
  artifactsIconState,
  roomsIconState,
  appsIconState,
  serversToggleIntent,
  SERVERS_PANEL_USEFUL_WIDTH_PX,
  artifactsToggleIntent,
  roomsToggleIntent,
  appsToggleIntent,
  type LeftColumnState,
} from "../../src/components/navigation-rail/left-column-nav";

function state(overrides: Partial<LeftColumnState> = {}): LeftColumnState {
  return {
    panelEligible: true,
    browserMode: "artifacts",
    browserCollapsed: false,
    ...overrides,
  };
}

describe("left-column-nav icon state (3-state)", () => {
  test("artifacts mode, shown → artifacts open, rooms inactive", () => {
    const s = state({ browserMode: "artifacts", browserCollapsed: false });
    expect(artifactsIconState(s)).toBe("open");
    expect(roomsIconState(s)).toBe("inactive");
  });

  test("artifacts mode, collapsed → artifacts collapsed (chevron), rooms inactive", () => {
    const s = state({ browserMode: "artifacts", browserCollapsed: true });
    expect(artifactsIconState(s)).toBe("collapsed");
    expect(roomsIconState(s)).toBe("inactive");
  });

  test("rooms mode, shown → rooms open, artifacts inactive", () => {
    const s = state({ browserMode: "rooms", browserCollapsed: false });
    expect(roomsIconState(s)).toBe("open");
    expect(artifactsIconState(s)).toBe("inactive");
  });

  test("rooms mode, collapsed → rooms collapsed (chevron), artifacts inactive", () => {
    const s = state({ browserMode: "rooms", browserCollapsed: true });
    expect(roomsIconState(s)).toBe("collapsed");
    expect(artifactsIconState(s)).toBe("inactive");
  });

  test("apps mode, shown → apps open, others inactive", () => {
    const s = state({ browserMode: "apps", browserCollapsed: false });
    expect(appsIconState(s)).toBe("open");
    expect(artifactsIconState(s)).toBe("inactive");
    expect(roomsIconState(s)).toBe("inactive");
  });

  test("apps mode, collapsed → apps collapsed (chevron), others inactive", () => {
    const s = state({ browserMode: "apps", browserCollapsed: true });
    expect(appsIconState(s)).toBe("collapsed");
    expect(artifactsIconState(s)).toBe("inactive");
    expect(roomsIconState(s)).toBe("inactive");
  });

  test("route can't host the column → all inactive (no chevron leak on /settings etc.)", () => {
    const s = state({ panelEligible: false, browserMode: "rooms", browserCollapsed: true });
    expect(artifactsIconState(s)).toBe("inactive");
    expect(roomsIconState(s)).toBe("inactive");
    expect(appsIconState(s)).toBe("inactive");
  });
});

describe("left-column-nav toggle intents", () => {
  test("open panel → {} (no-op; hide via panel ‹)", () => {
    expect(artifactsToggleIntent(state({ browserMode: "artifacts" }))).toEqual({});
    expect(roomsToggleIntent(state({ browserMode: "rooms" }))).toEqual({});
    expect(appsToggleIntent(state({ browserMode: "apps" }))).toEqual({});
  });

  test("collapsed same panel → reveal in place (no navigate)", () => {
    expect(artifactsToggleIntent(state({ browserMode: "artifacts", browserCollapsed: true }))).toEqual(
      { browserMode: "artifacts", collapsed: false, navigateHome: false },
    );
  });

  test("switch from the other panel → reveal in place (no navigate)", () => {
    // In rooms mode, clicking Artifacts switches the column to artifacts, in place.
    expect(roomsToggleIntent(state({ browserMode: "artifacts" }))).toEqual({
      browserMode: "rooms",
      collapsed: false,
      navigateHome: false,
    });
    expect(artifactsToggleIntent(state({ browserMode: "rooms" }))).toEqual({
      browserMode: "artifacts",
      collapsed: false,
      navigateHome: false,
    });
  });

  test("on a route that can't host the column → reveal AND navigate home", () => {
    const s = state({ panelEligible: false, browserMode: "rooms" });
    expect(artifactsToggleIntent(s)).toEqual({
      browserMode: "artifacts",
      collapsed: false,
      navigateHome: true,
    });
    expect(appsToggleIntent(s)).toEqual({
      browserMode: "apps",
      collapsed: false,
      navigateHome: true,
    });
  });

  test("switch to apps from another panel → reveal in place (no navigate)", () => {
    expect(appsToggleIntent(state({ browserMode: "artifacts" }))).toEqual({
      browserMode: "apps",
      collapsed: false,
      navigateHome: false,
    });
    expect(artifactsToggleIntent(state({ browserMode: "apps" }))).toEqual({
      browserMode: "artifacts",
      collapsed: false,
      navigateHome: false,
    });
  });

  test("collapsed apps panel → reveal in place (no navigate)", () => {
    expect(appsToggleIntent(state({ browserMode: "apps", browserCollapsed: true }))).toEqual({
      browserMode: "apps",
      collapsed: false,
      navigateHome: false,
    });
  });

  test("servers panel requests enough width for identity, state, and row actions", () => {
    expect(serversToggleIntent(state({ browserMode: "artifacts" }))).toEqual({
      browserMode: "servers",
      collapsed: false,
      navigateHome: false,
      minimumWidthPx: SERVERS_PANEL_USEFUL_WIDTH_PX,
    });
    expect(serversToggleIntent(state({ browserMode: "servers", browserCollapsed: true }))).toEqual({
      browserMode: "servers",
      collapsed: false,
      navigateHome: false,
      minimumWidthPx: SERVERS_PANEL_USEFUL_WIDTH_PX,
    });
    expect(serversToggleIntent(state({ browserMode: "servers", browserCollapsed: false }))).toEqual({});
  });
});
