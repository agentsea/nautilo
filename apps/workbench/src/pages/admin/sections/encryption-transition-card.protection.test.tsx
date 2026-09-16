import { reapplyHappyDomGlobals } from "../../../../tests/bun-dom-preload";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { CapabilitySlug, StenographerProtectionStatus } from "@nautilo/types";

let mockCaps: CapabilitySlug[] = ["read_server_settings"];
const getEncryptionStatus = mock(
  () => new Promise<never>(() => {}),
);
const getProtectionStatus = mock(async (): Promise<StenographerProtectionStatus> => ({
  dtoVersion: 1,
  generatedAt: "2026-08-12T10:00:00.000Z",
  window: {
    since: "2026-08-11T10:00:00.000Z",
    until: "2026-08-12T10:00:00.000Z",
  },
  queue: {
    current: {
      awaitingRecipient: "0",
      waitingForDevice: "1",
      grantReady: "0",
      claimed: "0",
      running: "0",
      publicationReconciliation: "0",
      oldestWaitingAt: null,
    },
    last24h: {
      protectedCompleted: "2",
      outputRepairCompleted: "3",
      cancelled: "0",
      terminalFailures: "0",
    },
  },
  authorityWait: { extractionRooms: "0", compactionRooms: "0", oldestAt: null },
  plaintextFallback: {
    missingProtection: {
      extractionBatches: "4",
      compactionRollups: "5",
      oldestAt: null,
    },
    last24h: {
      extraction: { device: "0", authority: "0" },
      compaction: { device: "0", authority: "0" },
    },
  },
}));

mock.module("../../../hooks/use-can", () => ({
  useCan: () => (capability: CapabilitySlug) => mockCaps.includes(capability),
}));

mock.module("../../../lib/api", () => ({
  apiClient: {
    admin: {
      encryptionTransition: {
        get: getEncryptionStatus,
        update: mock(async () => {
          throw new Error("not used");
        }),
      },
      stenographerStatus: {
        get: mock(async () => {
          throw new Error("not used");
        }),
        getProtection: getProtectionStatus,
      },
    },
  },
}));

const { EncryptionTransitionCard } = await import("./encryption-transition-card");

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  mockCaps = ["read_server_settings"];
  getEncryptionStatus.mockClear();
  getProtectionStatus.mockClear();
});

describe("EncryptionTransitionCard Stenographer protection feed", () => {
  test("loads protection status through the shared client on its existing refresh", async () => {
    const view = render(<EncryptionTransitionCard />);

    await waitFor(() => {
      expect(getEncryptionStatus).toHaveBeenCalledTimes(1);
      expect(getProtectionStatus).toHaveBeenCalledTimes(1);
    });
    expect(view.getByText("Loading…")).toBeTruthy();
  });
});
