import "../../../../tests/bun-dom-preload";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import type { NotificationLevel } from "@nautilo/types";
import type { DesktopNotificationDeliveryStatus } from "../../../lib/desktop";

const setDefaultNotificationLevel = mock(
  async (_level: NotificationLevel) => true,
);
let mutation = { busy: false, error: null as string | null };
let defaultLevel: NotificationLevel = "direct";
let deliveryStatus: DesktopNotificationDeliveryStatus = {
  state: "supported",
};
let statusListener:
  | ((status: DesktopNotificationDeliveryStatus) => void)
  | null = null;
const openSystemSettings = mock(async () => ({ ok: true }));

mock.module("../../../hooks/use-auth", () => ({
  useAuth: () => ({ viewer: { isVerified: true } }),
}));
mock.module("../../../notifications/notification-state-context", () => ({
  useNotificationState: () => ({
    snapshot: {
      preferences: { defaultLevel, roomOverrides: [] },
    },
    error: null,
    defaultPreferenceMutation: mutation,
    setDefaultNotificationLevel,
  }),
}));
mock.module("../../../lib/desktop", () => ({
  desktopAPI: {
    platform: "darwin",
    notifications: {
      getDeliveryStatus: async () => deliveryStatus,
      openSystemSettings,
      onDeliveryStatusChange(
        listener: (status: DesktopNotificationDeliveryStatus) => void,
      ) {
        statusListener = listener;
        return () => {
          statusListener = null;
        };
      },
    },
  },
}));

const { NotificationsSection } = await import("./notifications-section");

describe("Settings notification preferences", () => {
  afterEach(cleanup);

  beforeEach(() => {
    defaultLevel = "direct";
    mutation = { busy: false, error: null };
    deliveryStatus = { state: "supported" };
    statusListener = null;
    setDefaultNotificationLevel.mockClear();
    openSystemSettings.mockReset();
    openSystemSettings.mockImplementation(async () => ({ ok: true }));
  });

  test("renders the locked labels and explanatory boundary", () => {
    const view = render(<NotificationsSection />);
    const select = view.getByLabelText("Default") as HTMLSelectElement;
    expect(select.value).toBe("direct");
    expect(view.getByText("Nothing")).toBeTruthy();
    expect(view.getByText("Directed messages")).toBeTruthy();
    expect(view.getByText("All messages")).toBeTruthy();
    expect(
      view.getByText(/does not mark messages read or silence Agents and Genies/),
    ).toBeTruthy();
  });

  test("submits the account default without locally replacing server state", () => {
    const view = render(<NotificationsSection />);
    const select = view.getByLabelText("Default") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "all" } });
    expect(setDefaultNotificationLevel).toHaveBeenCalledWith("all");
    expect(select.value).toBe("direct");
  });

  test("disables the control and exposes an actionable mutation error", () => {
    mutation = { busy: true, error: "offline" };
    const view = render(<NotificationsSection />);
    expect(
      (view.getByLabelText("Default") as HTMLSelectElement).disabled,
    ).toBe(true);
    expect(view.getByRole("alert").textContent).toContain(
      "offline. Try again.",
    );
  });

  test("shows truthful native status and a fixed recovery action", async () => {
    deliveryStatus = { state: "delivery-failed" };
    const view = render(<NotificationsSection />);
    await waitFor(() =>
      expect(
        view.getByText(/could not complete the last native notification/),
      ).toBeTruthy(),
    );
    expect(
      view.getByText(/System Settings → Notifications → Nautilo/),
    ).toBeTruthy();
    fireEvent.click(
      view.getByRole("button", { name: "Open notification settings" }),
    );
    expect(openSystemSettings).toHaveBeenCalledTimes(1);

    act(() => statusListener?.({ state: "supported" }));
    await waitFor(() =>
      expect(
        view.getByText(/macOS controls whether they are displayed/),
      ).toBeTruthy(),
    );
  });
});
