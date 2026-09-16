import "../bun-dom-preload";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

let response = groupedResponse();
const listGroupedRelayDevices = mock(async () => response);
const revokeGroupedRelayDevice = mock(async () => ({ affectedPairingCount: 2 }));
const cleanupHistoricalRelayPairings = mock(async () => ({ affectedPairingCount: 22 }));
const getResearchStatus = mock(async () => ({
  desktopReaderAvailable: true,
  keylessSearchAvailable: false,
}));

mock.module("../../src/hooks/use-auth", () => ({
  useAuth: () => ({ viewer: { isVerified: true } }),
}));

mock.module("../../src/hooks/use-can", () => ({
  useCan: () => (capability: string) => capability === "use_research_tools",
}));

mock.module("../../src/lib/api", () => ({
  apiClient: {
    listGroupedRelayDevices,
    revokeGroupedRelayDevice,
    cleanupHistoricalRelayPairings,
    getResearchStatus,
  },
}));

const { WorkComputersSection } = await import("../../src/pages/settings/sections/devices-section");

function groupedResponse(options?: {
  devices?: Array<Record<string, unknown>>;
  historicalCount?: number;
}) {
  return {
    contractVersion: 2 as const,
    devices: options?.devices ?? [{
      deviceManagementId: "opaque-device-management-id-not-for-display",
      label: "Ada's MacBook",
      pairingCount: 2,
      firstPairedAt: "2026-07-01T09:00:00.000Z",
      lastSeenAt: "2026-07-29T10:00:00.000Z",
      profiles: ["Developer", "Personal", "Archive", "Fourth profile"],
      capabilities: ["shell", "filesystem", "network"],
    }],
    historical: {
      pairingCount: options?.historicalCount ?? 22,
      oldestPairedAt: "2025-01-01T09:00:00.000Z",
      latestSeenAt: "2026-01-01T09:00:00.000Z",
    },
  };
}

beforeEach(() => {
  cleanup();
  response = groupedResponse();
  listGroupedRelayDevices.mockClear();
  revokeGroupedRelayDevice.mockClear();
  cleanupHistoricalRelayPairings.mockClear();
  getResearchStatus.mockClear();
  listGroupedRelayDevices.mockImplementation(async () => response);
  revokeGroupedRelayDevice.mockImplementation(async () => ({ affectedPairingCount: 2 }));
  cleanupHistoricalRelayPairings.mockImplementation(async () => ({ affectedPairingCount: 22 }));
});

afterAll(() => {
  mock.restore();
});

describe("WorkComputersSection", () => {
  test("renders one grouped device row and one bounded historical summary", async () => {
    const view = render(<WorkComputersSection />);

    await waitFor(() => expect(view.getByText("Ada's MacBook")).toBeTruthy());

    expect(view.container.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(view.getByText("Historical pairings (22)")).toBeTruthy();
    expect(view.queryByText("Fourth profile")).toBeNull();
    expect(view.getByText("+1 more")).toBeTruthy();
    expect(view.container.textContent).not.toContain("opaque-device-management-id-not-for-display");
  });

  test("keeps same-label grouped devices separate without rendering management identifiers", async () => {
    response = groupedResponse({
      historicalCount: 0,
      devices: [
        {
          deviceManagementId: "opaque-management-a",
          label: "Shared workstation",
          pairingCount: 1,
          firstPairedAt: "2026-07-01T09:00:00.000Z",
          lastSeenAt: null,
          profiles: ["Personal"],
          capabilities: [],
        },
        {
          deviceManagementId: "opaque-management-b",
          label: "Shared workstation",
          pairingCount: 3,
          firstPairedAt: "2026-07-02T09:00:00.000Z",
          lastSeenAt: "2026-07-29T10:00:00.000Z",
          profiles: ["Work"],
          capabilities: [],
        },
      ],
    });
    const view = render(<WorkComputersSection />);

    await waitFor(() => expect(view.container.querySelectorAll("tbody tr")).toHaveLength(2));

    expect(view.getAllByText("Shared workstation")).toHaveLength(2);
    expect(view.container.textContent).not.toContain("opaque-management-a");
    expect(view.container.textContent).not.toContain("opaque-management-b");
  });

  test("confirms the named device and exact pairing count, then refreshes server truth", async () => {
    response = groupedResponse({ historicalCount: 0 });
    const view = render(<WorkComputersSection />);
    await view.findByRole("button", { name: "Revoke Ada's MacBook" });

    fireEvent.click(view.getByRole("button", { name: "Revoke Ada's MacBook" }));
    expect(view.getByText("Revoke Ada's MacBook? This revokes exactly 2 pairings currently associated with this device.")).toBeTruthy();

    response = groupedResponse({ devices: [], historicalCount: 0 });
    fireEvent.click(view.getByRole("button", { name: "Confirm revoke" }));

    await waitFor(() => expect(revokeGroupedRelayDevice).toHaveBeenCalledWith(
      "opaque-device-management-id-not-for-display",
      2,
    ));
    await waitFor(() => expect(listGroupedRelayDevices).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(view.getByText(/No devices paired yet/)).toBeTruthy());
  });

  test("uses the exact eligible historical count and reconciles a stale cleanup failure", async () => {
    const stale = Object.assign(new Error("stale"), { status: 409 });
    cleanupHistoricalRelayPairings.mockImplementation(async () => { throw stale; });
    const view = render(<WorkComputersSection />);
    await view.findByRole("button", { name: "Clean up historical pairings" });

    fireEvent.click(view.getByRole("button", { name: "Clean up historical pairings" }));
    expect(view.getByText("Remove exactly 22 eligible historical pairings? Older clients still using one will need to pair again.")).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Confirm cleanup" }));
    await waitFor(() => expect(cleanupHistoricalRelayPairings).toHaveBeenCalledWith(22));
    await waitFor(() => expect(listGroupedRelayDevices).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(view.getByText(/Pairings changed before this action completed/)).toBeTruthy());
    expect(view.getByText("Historical pairings (22)")).toBeTruthy();
  });

  test("loads the authenticated Human's fleet without a tool-capability gate", async () => {
    const view = render(<WorkComputersSection />);

    await waitFor(() => expect(view.getByText("Ada's MacBook")).toBeTruthy());
    expect(listGroupedRelayDevices).toHaveBeenCalledTimes(1);
  });

  test("shows caller-scoped research availability beneath work computers", async () => {
    const view = render(<WorkComputersSection />);

    expect(await view.findByText("Page reader available")).toBeTruthy();
    expect(view.getByText("Keyless search unavailable")).toBeTruthy();
    expect(getResearchStatus).toHaveBeenCalledTimes(1);
  });

  test("shows an explicit compatibility state for an older server instead of v1 rows", async () => {
    listGroupedRelayDevices.mockImplementation(async () => {
      throw Object.assign(new Error("not found"), { status: 404 });
    });
    const view = render(<WorkComputersSection />);

    await waitFor(() => expect(view.getByText(/does not support truthful physical-device management yet/)).toBeTruthy());
    expect(view.queryByText("Ada's MacBook")).toBeNull();
  });
});
