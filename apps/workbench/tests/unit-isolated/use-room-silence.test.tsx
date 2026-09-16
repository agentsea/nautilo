import "../bun-dom-preload";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const getRoomSilence = mock(async () => ({
  silence: null,
  canManage: false,
}));
const showToast = mock(() => undefined);

mock.module("../../src/lib/api", () => ({
  apiClient: { getRoomSilence },
}));
mock.module("../../src/components/toast", () => ({
  useToast: () => ({ show: showToast, dismiss: () => undefined, _current: null }),
}));

const { useRoomSilence } = await import("../../src/modes/rooms/shape/use-room-silence");
const {
  applyMaintenanceStatus,
  resetMaintenanceNoticeForTest,
} = await import("../../src/components/maintenance-notice-state");

beforeEach(() => {
  resetMaintenanceNoticeForTest();
  getRoomSilence.mockClear();
  getRoomSilence.mockResolvedValue({ silence: null, canManage: false });
  showToast.mockClear();
});

afterEach(() => {
  cleanup();
  resetMaintenanceNoticeForTest();
});

describe("useRoomSilence maintenance recovery", () => {
  test.each(["draining", "applying"] as const)(
    "%s maintenance skips silence polling and error toasts",
    (state) => {
      applyMaintenanceStatus({ state });

      const view = renderHook(() => useRoomSilence("room-1"));

      expect(getRoomSilence).not.toHaveBeenCalled();
      expect(showToast).not.toHaveBeenCalled();
      view.unmount();
    },
  );

  test("refreshes retained state when maintenance returns to normal", async () => {
    applyMaintenanceStatus({ state: "draining" });
    getRoomSilence.mockResolvedValue({
      silence: {
        id: "silence-1",
        kind: "mute",
        botActorId: null,
        botDisplayName: null,
        setByDisplayName: "Room admin",
        expiresAt: "2026-08-01T12:30:00.000Z",
      },
      canManage: true,
    });

    const { result } = renderHook(() => useRoomSilence("room-1"));
    expect(result.current.silence).toBeNull();

    act(() => applyMaintenanceStatus({ state: "normal" }));

    await waitFor(() => expect(getRoomSilence).toHaveBeenCalledWith("room-1"));
    await waitFor(() => expect(result.current.silence?.id).toBe("silence-1"));
    expect(result.current.canManage).toBe(true);
    expect(showToast).not.toHaveBeenCalled();
  });

  test("suppresses a load failure when maintenance begins mid-request", async () => {
    let rejectRequest: ((reason?: unknown) => void) | null = null;
    getRoomSilence.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectRequest = reject;
        }),
    );

    renderHook(() => useRoomSilence("room-1"));
    await waitFor(() => expect(getRoomSilence).toHaveBeenCalledWith("room-1"));

    act(() => applyMaintenanceStatus({ state: "applying" }));
    await act(async () => {
      rejectRequest?.(new Error("Server is restarting"));
    });

    expect(showToast).not.toHaveBeenCalled();
  });

  test("keeps ordinary silence-state load failures visible", async () => {
    getRoomSilence.mockRejectedValue(new Error("Request failed"));

    renderHook(() => useRoomSilence("room-1"));

    await waitFor(() => expect(showToast).toHaveBeenCalledTimes(1));
    expect(showToast).toHaveBeenCalledWith({
      variant: "error",
      title: "Could not load silence state",
      message: "Request failed",
    });
  });
});
