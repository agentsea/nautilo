import { reapplyHappyDomGlobals } from "../../../tests/bun-dom-preload";
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { DesktopUpdateStatus } from "../../lib/desktop";

let currentStatus: DesktopUpdateStatus = { kind: "hidden" };
let statusListener: ((status: DesktopUpdateStatus) => void) | null = null;
let openCalls: unknown[][] = [];
let unsubscribeCalls = 0;

const updatesBridge = {
  getStatus: async (): Promise<DesktopUpdateStatus> => currentStatus,
  onStatus: (handler: (status: DesktopUpdateStatus) => void) => {
    statusListener = handler;
    return () => {
      unsubscribeCalls += 1;
    };
  },
  open: async (...args: unknown[]): Promise<void> => {
    openCalls.push(args);
  },
};

mock.module("../../lib/desktop", () => ({
  desktopAPI: { updates: updatesBridge },
}));
mock.module("../../hooks/use-can", () => ({
  useCan: () => () => false,
}));
mock.module("../../hooks/use-viewer-affordances", () => ({
  useViewerAffordances: () => ({ canToggleSessionSpeech: false }),
}));
mock.module("../../adapters/runtime-contexts", () => ({
  useVoiceControls: () => ({ enabled: false, playing: false, toggle: () => {}, stop: () => {} }),
}));

let NavigationRail: (typeof import("./navigation-rail"))["NavigationRail"];
let useDesktopUpdateStatus: (typeof import("../../hooks/use-desktop-update-status"))["useDesktopUpdateStatus"];

beforeAll(async () => {
  ({ NavigationRail } = await import("./navigation-rail"));
  ({ useDesktopUpdateStatus } = await import("../../hooks/use-desktop-update-status"));
});

beforeEach(() => {
  reapplyHappyDomGlobals();
  currentStatus = { kind: "hidden" };
  statusListener = null;
  openCalls = [];
  unsubscribeCalls = 0;
});

afterAll(() => {
  mock.restore();
});

function UpdateRail() {
  const update = useDesktopUpdateStatus();
  return (
    <MemoryRouter>
      <NavigationRail
        identityLabel="Operator"
        identityRole="owner"
        onAction={() => {}}
        updateStatus={update.status}
        onOpenUpdate={update.open}
      />
    </MemoryRouter>
  );
}

describe("D103 navigation rail update indicator", () => {
  test("stays hidden when the main-process projection is hidden", async () => {
    const view = render(<UpdateRail />);

    await waitFor(() => expect(statusListener).not.toBeNull());
    expect(view.queryByTestId("navigation-rail-update-indicator")).toBeNull();
  });

  test("renders an animated blue circle directly above the footer divider", async () => {
    currentStatus = { kind: "available", version: "1.4.0" };
    const view = render(<UpdateRail />);

    const indicator = await view.findByTestId("navigation-rail-update-indicator");
    const divider = view.getByTestId("navigation-rail-footer-divider");
    expect(indicator.getAttribute("aria-label")).toBe("Update 1.4.0 is available");
    expect(indicator.className).toContain("rounded-full");
    expect(indicator.className).toContain("bg-sky-500");
    expect(indicator.getAttribute("data-update-state")).toBe("available");
    expect(indicator.className).toContain("motion-safe:animate-[pulse_1s_ease-in-out_3]");
    expect(indicator.className).not.toContain("infinite");
    expect(indicator.parentElement?.nextElementSibling).toBe(divider);
  });

  test("reflects pushed download and ready states, then sends a zero-argument open request to main", async () => {
    currentStatus = { kind: "available", version: "1.4.0" };
    const view = render(<UpdateRail />);
    const indicator = await view.findByTestId("navigation-rail-update-indicator");

    act(() => {
      statusListener?.({ kind: "downloading", version: "1.4.0", percent: 48 });
    });
    await waitFor(() => {
      expect(indicator.getAttribute("title")).toBe("Downloading update 1.4.0: 48% complete");
      expect(indicator.getAttribute("data-update-progress")).toBe("48");
      expect(indicator.querySelector("circle[stroke-dashoffset='52']")).not.toBeNull();
    });

    act(() => {
      statusListener?.({ kind: "ready", version: "1.4.0" });
    });
    await waitFor(() => {
      expect(indicator.getAttribute("aria-label")).toBe("Update 1.4.0 is ready to install");
      expect(indicator.getAttribute("title")).toBe("Update 1.4.0 is ready to install");
      expect(indicator.getAttribute("data-update-state")).toBe("ready");
    });

    fireEvent.click(indicator);
    expect(openCalls).toEqual([[]]);
  });

  test("shows a disabled spinner while main prepares the restart", async () => {
    currentStatus = { kind: "installing", version: "1.4.0" };
    const view = render(<UpdateRail />);

    const indicator = await view.findByTestId("navigation-rail-update-indicator");
    expect(indicator.getAttribute("aria-label")).toBe(
      "Installing update 1.4.0; Nautilo will restart",
    );
    expect(indicator.hasAttribute("disabled")).toBe(true);
    expect(indicator.getAttribute("data-update-state")).toBe("installing");
  });

  test("cleans up its status subscription on unmount", async () => {
    const view = render(<UpdateRail />);
    await waitFor(() => expect(statusListener).not.toBeNull());
    view.unmount();
    expect(unsubscribeCalls).toBe(1);
    expect(() => {
      act(() => {
        statusListener?.({ kind: "ready", version: "1.4.0" });
      });
    }).not.toThrow();
  });
});
