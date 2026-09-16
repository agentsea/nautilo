import "../bun-dom-preload";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let wsState: { state: "open" | "closed" } = { state: "open" };
const showToast = mock(() => undefined);
const dismissToast = mock(() => undefined);
let scheduledWarning: (() => void) | null = null;

mock.module("../../src/hooks/use-ws-state", () => ({
  useWsState: () => wsState,
}));
mock.module("../../src/components/toast", () => ({
  useToast: () => ({ show: showToast, dismiss: dismissToast }),
}));

const { ProlongedDisconnectToast } = await import(
  "../../src/components/prolonged-disconnect-toast"
);
const {
  applyMaintenanceStatus,
  resetMaintenanceNoticeForTest,
} = await import("../../src/components/maintenance-notice-state");

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

beforeEach(() => {
  resetMaintenanceNoticeForTest();
  wsState = { state: "open" };
  showToast.mockClear();
  dismissToast.mockClear();
  scheduledWarning = null;
  globalThis.setTimeout = ((callback: TimerHandler) => {
    scheduledWarning = callback as () => void;
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = (() => undefined) as typeof clearTimeout;
});

afterEach(() => {
  cleanup();
  resetMaintenanceNoticeForTest();
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
});

describe("ProlongedDisconnectToast maintenance suppression", () => {
  test.each(["draining", "applying"] as const)(
    "%s suppresses the generic prolonged-disconnect toast",
    (state) => {
      const view = render(<ProlongedDisconnectToast />);
      wsState = { state: "closed" };
      view.rerender(<ProlongedDisconnectToast />);
      expect(scheduledWarning).not.toBeNull();

      act(() => applyMaintenanceStatus({ state }));
      act(() => scheduledWarning?.());

      expect(showToast).not.toHaveBeenCalled();
      view.unmount();
    },
  );

  test("an ordinary disconnect still warns when no maintenance cycle is active", () => {
    const view = render(<ProlongedDisconnectToast />);

    wsState = { state: "closed" };
    view.rerender(<ProlongedDisconnectToast />);
    expect(scheduledWarning).not.toBeNull();

    act(() => scheduledWarning?.());

    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({
        recovery: "connection",
        variant: "warning",
        title: "Connection issues",
        message: "Check your network or the server.",
      }),
    );
    view.unmount();
  });

  test("maintenance dismisses a warning already shown for a prior disconnect", () => {
    const view = render(<ProlongedDisconnectToast />);
    wsState = { state: "closed" };
    view.rerender(<ProlongedDisconnectToast />);
    act(() => scheduledWarning?.());
    expect(showToast).toHaveBeenCalledTimes(1);

    act(() => applyMaintenanceStatus({ state: "applying" }));

    expect(dismissToast).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});
