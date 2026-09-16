import "../bun-dom-preload";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const showToast = mock(() => undefined);

mock.module("../../src/components/toast", () => ({
  useToast: () => ({ show: showToast, dismiss: () => undefined }),
}));
mock.module("../../src/components/server-upgrade-notice", () => ({
  hasPendingServerUpgradeNotice: () => false,
}));

const { RECONNECT_RECONCILED_EVENT, ReconnectToast } = await import(
  "../../src/components/reconnect-toast"
);
const {
  applyMaintenanceStatus,
  resetMaintenanceNoticeForTest,
} = await import("../../src/components/maintenance-notice-state");

beforeEach(() => {
  resetMaintenanceNoticeForTest();
  showToast.mockClear();
});

afterEach(() => {
  cleanup();
  resetMaintenanceNoticeForTest();
});

describe("ReconnectToast maintenance suppression", () => {
  test.each(["draining", "applying"] as const)(
    "%s suppresses the generic reconnect toast",
    (state) => {
      render(<ReconnectToast />);
      applyMaintenanceStatus({ state });

      window.dispatchEvent(new window.Event(RECONNECT_RECONCILED_EVENT));

      expect(showToast).not.toHaveBeenCalled();
    },
  );

  test("shows a reconnect toast for an ordinary recovery", () => {
    render(<ReconnectToast />);

    window.dispatchEvent(new window.Event(RECONNECT_RECONCILED_EVENT));

    expect(showToast).toHaveBeenCalledWith({
      variant: "success",
      title: "Reconnected",
      message: "Caught up.",
      duration: 2_000,
    });
  });
});
