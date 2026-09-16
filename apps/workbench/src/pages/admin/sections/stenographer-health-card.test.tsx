import { reapplyHappyDomGlobals } from "../../../../tests/bun-dom-preload";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type {
  CapabilitySlug,
  StenographerAdminStatus,
  StenographerProtectionStatus,
} from "@nautilo/types";

let mockCaps: CapabilitySlug[] = ["read_server_settings"];
let statusLoader: () => Promise<StenographerAdminStatus>;
let protectionStatusLoader: () => Promise<StenographerProtectionStatus>;

const getStatusMock = mock(() => statusLoader());
const getProtectionStatusMock = mock(() => protectionStatusLoader());

mock.module("../../../hooks/use-can", () => ({
  useCan: () => (cap: CapabilitySlug) => mockCaps.includes(cap),
}));

mock.module("../../../lib/api", () => ({
  apiClient: {
    admin: {
      stenographerStatus: {
        get: getStatusMock,
        getProtection: getProtectionStatusMock,
      },
    },
  },
}));

const { StenographerHealthCard } = await import("./stenographer-health-card");

function statusFixture(
  health: StenographerAdminStatus["health"] = "healthy",
): StenographerAdminStatus {
  return {
    generatedAt: new Date().toISOString(),
    window: {
      since: new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString(),
      until: new Date().toISOString(),
    },
    health,
    current: {
      eligibleRooms: 4,
      caughtUpRooms: 2,
      accumulatingRooms: 1,
      processingRooms: 0,
      retryingRooms: health === "delayed" ? 1 : 0,
      dueRooms: health === "degraded" ? 1 : 0,
      staleLeases: health === "degraded" ? 1 : 0,
      oldestOverdueMs: health === "degraded" ? 360_000 : 0,
      historicalPendingRooms: 1,
      historicalCompletedRooms: 3,
    },
    last24h: {
      completedExtractionBatches: 12,
      extractionBatchesWithErrors: 2,
      retriedExtractionBatches: 1,
      zeroEventExtractionBatches: 5,
      eventsWritten: 8,
      extractionDurationP50Ms: 500,
      extractionDurationP95Ms: 2_500,
    },
    journal: {
      projectedBodyCodePointsP50: 100,
      projectedBodyCodePointsP95: 400,
      projectedBodyCodePointsMax: 800,
    },
    compaction: {
      awaitingRooms: 1,
      processingRooms: 0,
      retryingRooms: 0,
      staleLeases: 0,
      oldestOverdueMs: 0,
      lastCompletedAt: null,
    },
    recentFailures: [],
  };
}

function protectionStatusFixture(): StenographerProtectionStatus {
  return {
    dtoVersion: 1,
    generatedAt: new Date().toISOString(),
    window: {
      since: new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString(),
      until: new Date().toISOString(),
    },
    queue: {
      current: {
        awaitingRecipient: "2",
        waitingForDevice: "3",
        grantReady: "4",
        claimed: "5",
        running: "6",
        publicationReconciliation: "7",
        oldestWaitingAt: new Date(Date.now() - 60_000).toISOString(),
      },
      last24h: {
        protectedCompleted: "8",
        outputRepairCompleted: "9",
        cancelled: "10",
        terminalFailures: "11",
      },
    },
    authorityWait: {
      extractionRooms: "12",
      compactionRooms: "13",
      oldestAt: new Date(Date.now() - 120_000).toISOString(),
    },
    plaintextFallback: {
      missingProtection: {
        extractionBatches: "14",
        compactionRollups: "15",
        oldestAt: new Date(Date.now() - 180_000).toISOString(),
      },
      last24h: {
        extraction: { device: "16", authority: "17" },
        compaction: { device: "18", authority: "19" },
      },
    },
  };
}

function renderCard() {
  return render(
    <MemoryRouter>
      <StenographerHealthCard />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  mockCaps = ["read_server_settings"];
  statusLoader = async () => statusFixture();
  protectionStatusLoader = async () => protectionStatusFixture();
  getStatusMock.mockClear();
  getProtectionStatusMock.mockClear();
});

describe("StenographerHealthCard", () => {
  test("is hidden without read_server_settings and makes no request", () => {
    mockCaps = [];
    const view = renderCard();

    expect(view.queryByTestId("stenographer-health-card")).toBeNull();
    expect(getStatusMock).not.toHaveBeenCalled();
  });

  test("renders the loading state", async () => {
    statusLoader = () => new Promise<StenographerAdminStatus>(() => {});
    const view = renderCard();

    expect(view.getByText("Loading Stenographer status…")).toBeTruthy();
    expect(getStatusMock).toHaveBeenCalledTimes(1);
  });

  test("renders an empty healthy server without treating quiet time as a warning", async () => {
    statusLoader = async () => {
      const status = statusFixture();
      status.current.eligibleRooms = 0;
      status.current.caughtUpRooms = 0;
      return status;
    };
    const view = renderCard();

    await waitFor(() => {
      expect(view.getByTestId("stenographer-health-pill").textContent).toBe("healthy");
    });
    expect(view.getByText(/No eligible Agent rooms yet/)).toBeTruthy();
    expect(view.queryByText(/warning/i)).toBeNull();
  });

  test.each(["delayed", "degraded"] as const)("renders the %s state", async (health) => {
    statusLoader = async () => statusFixture(health);
    const view = renderCard();

    await waitFor(() => {
      expect(view.getByTestId("stenographer-health-pill").textContent).toBe(health);
    });
    expect(view.getByText("Zero-event (informational)")).toBeTruthy();
    expect(view.getByText("Historical pending")).toBeTruthy();
    expect(view.getByText("Historical complete")).toBeTruthy();
  });

  test("renders a generic request-error state", async () => {
    statusLoader = async () => {
      throw new Error("private provider exception");
    };
    const view = renderCard();

    await waitFor(() => {
      expect(view.getByRole("alert").textContent).toBe(
        "Stenographer status is unavailable.",
      );
    });
    expect(view.container.textContent).not.toContain("private provider");
  });

  test("renders protection waits, completions, and missing fallback outputs without identifiers", async () => {
    protectionStatusLoader = async () =>
      ({
        ...protectionStatusFixture(),
        roomId: "private-room-id",
        transcript: "private transcript",
      }) as StenographerProtectionStatus;
    const view = renderCard();

    await waitFor(() => {
      expect(view.getByTestId("stenographer-protection-status")).toBeTruthy();
    });
    expect(view.getByText("Waiting for a device").nextSibling?.textContent).toBe("3");
    expect(view.getByText("Processed with encryption (24h)").nextSibling?.textContent).toBe(
      "8",
    );
    expect(
      view.getByText("Repaired after plaintext processing (24h)").nextSibling?.textContent,
    ).toBe("9");
    expect(
      view.getByText("Fallback outputs awaiting protection").nextSibling?.textContent,
    ).toContain("14 extraction");
    expect(view.container.textContent).not.toContain("private-room-id");
    expect(view.container.textContent).not.toContain("private transcript");
  });

  test("keeps legacy health visible when protection status is unavailable", async () => {
    protectionStatusLoader = async () => {
      throw new Error("older server");
    };
    const view = renderCard();

    await waitFor(() => {
      expect(view.getByTestId("stenographer-health-pill").textContent).toBe("healthy");
    });
    expect(view.getByTestId("stenographer-protection-unavailable").textContent).toBe(
      "Protection status unavailable.",
    );
    expect(view.queryByRole("alert")).toBeNull();
  });

  test("Refresh performs exactly one additional request", async () => {
    const view = renderCard();
    await waitFor(() => {
      expect(view.getByTestId("stenographer-health-pill")).toBeTruthy();
    });
    expect(getStatusMock).toHaveBeenCalledTimes(1);
    expect(getProtectionStatusMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(view.getByTestId("stenographer-refresh"));
    });

    await waitFor(() => {
      expect(getStatusMock).toHaveBeenCalledTimes(2);
      expect(getProtectionStatusMock).toHaveBeenCalledTimes(2);
    });
  });

  test("shows only typed failure fields and gates the Costs link", async () => {
    mockCaps = ["read_server_settings", "manage_billing"];
    statusLoader = async () =>
      ({
        ...statusFixture("delayed"),
        roomId: "private-room-uuid",
        roomLabel: "Secret planning room",
        eventStatement: "Sensitive decision body",
        messageId: 42,
        toolResult: "private tool output",
        recentFailures: [
          {
            stage: "extraction",
            errorCode: "invalid_output",
            occurredAt: new Date().toISOString(),
            attemptCount: 2,
            modelId: "provider:model",
          },
        ],
      }) as StenographerAdminStatus;
    const view = renderCard();

    await waitFor(() => {
      expect(view.getByTestId("stenographer-recent-failures")).toBeTruthy();
    });
    expect(view.getByText(/invalid output/)).toBeTruthy();
    expect(view.getByText(/attempt 2/)).toBeTruthy();
    expect(view.getByRole("link", { name: "View model costs" }).getAttribute("href")).toBe(
      "/costs",
    );
    expect(view.container.textContent).not.toContain("private-room-uuid");
    expect(view.container.textContent).not.toContain("Secret planning room");
    expect(view.container.textContent).not.toContain("Sensitive decision body");
    expect(view.container.textContent).not.toContain("private tool output");
  });

  test("omits the Costs link without manage_billing", async () => {
    const view = renderCard();
    await waitFor(() => {
      expect(view.getByTestId("stenographer-health-pill")).toBeTruthy();
    });

    expect(view.queryByRole("link", { name: "View model costs" })).toBeNull();
  });
});
