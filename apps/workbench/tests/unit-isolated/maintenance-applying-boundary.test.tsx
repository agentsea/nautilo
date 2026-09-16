import "../bun-dom-preload";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";

let reloadCount = 0;

mock.module(
  new URL("../../../../assets/brand/nautilo-logo_v1_logo_only_transparent.png?inline", import.meta.url).pathname + "?inline",
  () => ({ default: "data:image/png;base64,nautilo-brand-mark" }),
);

mock.module("../../src/lib/api", () => ({
  apiClient: {
    getHealth: async () => ({ maintenanceState: "normal" as const }),
  },
}));

mock.module("../../src/lib/desktop", () => ({
  desktopAPI: {
    workbench: {
      reload: async () => {
        reloadCount += 1;
      },
    },
  },
  canSwitchDesktopServer: () => false,
  canSwitchDesktopServerInProcess: () => false,
}));

const { RoomComposerDraftProvider } = await import(
  "../../src/contexts/room-composer-draft-context"
);
const { MaintenanceApplyingBoundary } = await import(
  "../../src/components/maintenance-applying-gate"
);
const { applyMaintenanceStatus, resetMaintenanceNoticeForTest } = await import(
  "../../src/components/maintenance-notice-state"
);

afterEach(() => {
  cleanup();
  resetMaintenanceNoticeForTest();
  reloadCount = 0;
});

describe("MaintenanceApplyingBoundary", () => {
  test("reloads directly when a background renderer's health probe proves normal", async () => {
    applyMaintenanceStatus({ state: "applying" });

    render(
      <RoomComposerDraftProvider>
        <MaintenanceApplyingBoundary>
          <div>Workbench</div>
        </MaintenanceApplyingBoundary>
      </RoomComposerDraftProvider>,
    );

    await waitFor(() => expect(reloadCount).toBe(1));
    expect(localStorage.getItem(`nautilo:maintenance-applying:${window.location.origin}`)).toBe(
      "reloading",
    );
  });
});
