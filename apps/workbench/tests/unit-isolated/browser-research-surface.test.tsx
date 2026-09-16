import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";

const attachSurfaceMock = mock(async () => true);
const detachSurfaceMock = mock(async () => true);
let verificationClearedHandler: ((payload: { id: string }) => void) | null =
  null;

mock.module("../../src/lib/desktop", () => ({
  desktopAPI: {
    browserResearch: {
      attachSurface: attachSurfaceMock,
      detachSurface: detachSurfaceMock,
      alternate: async () => ({ ok: true as const }),
      cancel: async () => ({ ok: true as const }),
      onVerificationCleared: (handler: (payload: { id: string }) => void) => {
        verificationClearedHandler = handler;
        return () => {
          verificationClearedHandler = null;
        };
      },
    },
  },
}));

const { BrowserResearchSurface } =
  await import("../../src/apps/browser-research-surface");

const intervention = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  toolCallId: "tool-1",
  laneKey: "room:room-1",
  state: "awaiting_choice" as const,
  host: "example.com",
  reason: "human-verification" as const,
  expiresAt: "2026-08-08T22:00:00.000Z",
};

beforeEach(() => {
  reapplyHappyDomGlobals();
  globalThis.ResizeObserver = class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  attachSurfaceMock.mockClear();
  detachSurfaceMock.mockClear();
  verificationClearedHandler = null;
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("BrowserResearchSurface", () => {
  test("automatically acknowledges cleared verification until the original tool settles", async () => {
    const onClose = mock(() => undefined);
    const view = render(
      createElement(BrowserResearchSurface, { intervention, onClose }),
    );

    expect(view.queryByRole("button", { name: /Done|continue/i })).toBeNull();
    expect(
      view.getByText("Genie continues automatically when verification clears."),
    ).toBeTruthy();

    act(() => {
      verificationClearedHandler?.({ id: intervention.id });
    });

    expect(
      view.getByText("Verification complete — Genie is checking the page…"),
    ).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  test("Close pauses the temporary Browser without claiming verification or ending research", async () => {
    const onClose = mock(() => undefined);
    const view = render(
      createElement(BrowserResearchSurface, { intervention, onClose }),
    );

    fireEvent.click(view.getByRole("button", { name: "Close" }));

    await waitFor(() =>
      expect(detachSurfaceMock).toHaveBeenCalledWith(intervention.id),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(view.queryByText(/Verification complete/i)).toBeNull();
  });
});
