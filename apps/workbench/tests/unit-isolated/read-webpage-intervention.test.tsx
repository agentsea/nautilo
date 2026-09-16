import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";

const presentMock = mock(async () => ({ ok: true as const }));
const alternateMock = mock(async () => ({ ok: true as const }));
const cancelMock = mock(async () => ({ ok: true as const }));

mock.module("../../src/lib/desktop", () => ({
  isDesktop: true,
  desktopAPI: {
    browserResearch: {
      present: presentMock,
      alternate: alternateMock,
      cancel: cancelMock,
      getActiveIntervention: async () => null,
      onIntervention: () => () => undefined,
    },
  },
}));

const { readWebpageRenderer } =
  await import("../../src/components/tool-card/renderers/read-webpage");

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
  presentMock.mockClear();
  alternateMock.mockClear();
  cancelMock.mockClear();
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("read_webpage verification handoff", () => {
  test("presents the exact pending intervention and waits for automatic completion", async () => {
    const view = render(
      createElement(readWebpageRenderer.ExpandedBody, {
        args: { url: "https://example.com/challenge" },
        result: undefined,
        state: "blocked",
        event: {
          toolCallId: "tool-1",
          toolName: "read_webpage",
          args: { url: "https://example.com/challenge" },
          status: "running",
          startedAt: Date.now(),
          laneKey: "room:room-1",
          browserResearchIntervention: intervention,
        },
        resultText: undefined,
        resultTruncated: false,
      }),
    );

    await act(async () => {
      fireEvent.click(
        view.getByRole("button", { name: "Complete verification" }),
      );
    });
    await waitFor(() =>
      expect(presentMock).toHaveBeenCalledWith(intervention.id),
    );
    expect(
      view.getByText(/Genie continues automatically when it clears/),
    ).toBeTruthy();
    expect(view.queryByRole("button", { name: /done|continue/i })).toBeNull();
    expect(presentMock).toHaveBeenCalledTimes(1);
    expect(alternateMock).not.toHaveBeenCalled();
    expect(cancelMock).not.toHaveBeenCalled();
  });

  test("lets the Human choose another source or stop without inventing a Done action", async () => {
    const renderIntervention = () =>
      render(
        createElement(readWebpageRenderer.ExpandedBody, {
          args: { url: "https://example.com/challenge" },
          result: undefined,
          state: "blocked",
          event: {
            toolCallId: "tool-1",
            toolName: "read_webpage",
            args: { url: "https://example.com/challenge" },
            status: "running",
            startedAt: Date.now(),
            laneKey: "room:room-1",
            browserResearchIntervention: intervention,
          },
          resultText: undefined,
          resultTruncated: false,
        }),
      );

    const alternate = renderIntervention();
    await act(async () => {
      fireEvent.click(alternate.getByRole("button", { name: "Try another source" }));
    });
    await waitFor(() => expect(alternateMock).toHaveBeenCalledWith(intervention.id));
    expect(alternate.queryByRole("button", { name: /Done|continue/i })).toBeNull();

    alternate.unmount();
    const cancelled = renderIntervention();
    await act(async () => {
      fireEvent.click(cancelled.getByRole("button", { name: "Stop research" }));
    });
    await waitFor(() => expect(cancelMock).toHaveBeenCalledWith(intervention.id));
    expect(cancelled.queryByRole("button", { name: /Done|continue/i })).toBeNull();
  });
});
