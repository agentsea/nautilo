/**
 * D416 — `play_explainer` ToolCard renderer tests.
 */
import "../bun-dom-preload";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ToolRendererProps } from "../../src/components/tool-card/renderers/types";

type PlayerProps = {
  src: string;
  title: string;
};

const playerCalls: PlayerProps[] = [];
const fetchExplainerMedia = mock((id: string) => fetchImplementation(id));
const createObjectUrl = mock((_blob: Blob) => "blob:explainer");
const revokeObjectUrl = mock((_url: string) => {});
let fetchImplementation: (id: string) => Promise<{ blob: Blob; byteLength: number; format: "mp4" | "webm" }>;

mock.module("../../src/components/tool-card/renderers/explainer-video-player", () => ({
  ExplainerVideoPlayer: (props: PlayerProps) => {
    playerCalls.push({ src: props.src, title: props.title });
    return <div data-testid="mock-explainer-video-player">{props.title}</div>;
  },
}));

mock.module("../../src/lib/api", () => ({
  apiClient: { fetchExplainerMedia },
}));

const {
  explainerPlaybackRenderer,
  formatPlaybackCollapsedSummary,
  parseExplainerPlaybackEnvelope,
} = await import("../../src/components/tool-card/renderers/explainer-playback");
const { getToolRenderer } = await import("../../src/components/tool-card/renderers");

function makeEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    id: "search-memory-basics",
    title: "Search memory basics",
    summary: "Find relevant memories with targeted search terms.",
    description: "A short guide to memory search.",
    tags: ["memory", "search"],
    durationSeconds: 125,
    publishedAt: "2026-07-12",
    captionsAvailable: true,
    format: "mp4",
    requiresApproval: true,
    ...overrides,
  };
}

function renderExpanded(resultText: string, overrides: Partial<ToolRendererProps> = {}) {
  const props: ToolRendererProps = {
    args: { id: "search-memory-basics" },
    result: undefined,
    state: "success",
    event: undefined,
    resultText,
    resultTruncated: false,
    ...overrides,
  };
  return render(<explainerPlaybackRenderer.ExpandedBody {...props} />);
}

beforeEach(() => {
  fetchImplementation = async () => ({ blob: new Blob(["video"]), byteLength: 5, format: "mp4" });
  fetchExplainerMedia.mockClear();
  createObjectUrl.mockClear();
  revokeObjectUrl.mockClear();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });
});

afterEach(() => {
  playerCalls.length = 0;
  cleanup();
  document.body.replaceChildren();
});

describe("play_explainer renderer", () => {
  test("is registered for play_explainer only", () => {
    expect(getToolRenderer("play_explainer")).toBe(explainerPlaybackRenderer);
    expect(getToolRenderer("play_explainer_result")).toBeUndefined();
  });

  test("fetches authenticated media for a valid metadata-only envelope", async () => {
    const envelope = makeEnvelope();
    const raw = JSON.stringify(envelope);
    const view = renderExpanded(raw);

    expect(parseExplainerPlaybackEnvelope(raw)).toEqual(envelope);
    expect(formatPlaybackCollapsedSummary(raw)).toBe(envelope.title);
    expect(fetchExplainerMedia).toHaveBeenCalledWith("search-memory-basics");
    expect(view.getByRole("status").textContent).toContain("Loading explainer video");

    await waitFor(() => expect(playerCalls).toHaveLength(1));
    expect(view.getByTestId("explainer-playback-expanded").textContent).toContain(envelope.summary);
    expect(view.getByTestId("explainer-playback-expanded").textContent).toContain("Captions available");
    expect(playerCalls).toEqual([
      {
        src: "blob:explainer",
        title: "Search memory basics",
      },
    ]);
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
  });

  test("falls back to raw output for malformed envelopes without fetching", () => {
    const raw = JSON.stringify({
      ...makeEnvelope(),
      unexpectedSource: "https://playback.example.test/videos/unsafe.mp4",
    });
    const view = renderExpanded(raw);

    expect(parseExplainerPlaybackEnvelope(raw)).toBeNull();
    expect(view.container.textContent).toContain(raw);
    expect(view.queryByTestId("mock-explainer-video-player")).toBeNull();
    expect(playerCalls).toEqual([]);
    expect(fetchExplainerMedia).not.toHaveBeenCalled();
  });

  test("falls back to raw error output without rendering a player or fetching", () => {
    const raw = "Error: explainer playback could not be resolved";
    const view = renderExpanded(raw, { state: "error" });

    expect(view.container.textContent).toContain(raw);
    expect(view.queryByTestId("mock-explainer-video-player")).toBeNull();
    expect(playerCalls).toEqual([]);
    expect(fetchExplainerMedia).not.toHaveBeenCalled();
  });

  test("shows safe failure copy and retries media fetch", async () => {
    let attempts = 0;
    fetchImplementation = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("provider origin token leaked");
      return { blob: new Blob(["video"]), byteLength: 5, format: "mp4" };
    };
    const view = renderExpanded(JSON.stringify(makeEnvelope()));

    const alert = await view.findByRole("alert");
    expect(alert.textContent).toBe("Explainer video is unavailable.");
    expect(view.container.textContent).not.toContain("provider origin token leaked");

    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(playerCalls).toHaveLength(1));
    expect(fetchExplainerMedia).toHaveBeenCalledTimes(2);
  });

  test("revokes Blob URLs when the result changes or unmounts", async () => {
    createObjectUrl.mockImplementationOnce(() => "blob:first").mockImplementationOnce(() => "blob:second");
    const view = renderExpanded(JSON.stringify(makeEnvelope()));
    await waitFor(() => expect(playerCalls).toHaveLength(1));

    view.rerender(
      <explainerPlaybackRenderer.ExpandedBody
        args={{ id: "new-explainer" }}
        result={undefined}
        state="success"
        event={undefined}
        resultText={JSON.stringify(makeEnvelope({ id: "new-explainer" }))}
        resultTruncated={false}
      />,
    );
    await waitFor(() => expect(playerCalls).toHaveLength(2));
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:first");

    view.unmount();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:second");
  });

  test("revokes a Blob URL created by a late completion after unmount", async () => {
    let resolveMedia: ((value: { blob: Blob; byteLength: number; format: "mp4" }) => void) | undefined;
    fetchImplementation = () =>
      new Promise((resolve) => {
        resolveMedia = resolve;
      });
    createObjectUrl.mockImplementationOnce(() => "blob:late");
    const view = renderExpanded(JSON.stringify(makeEnvelope()));

    view.unmount();
    await act(async () => {
      resolveMedia?.({ blob: new Blob(["late"]), byteLength: 4, format: "mp4" });
      await Promise.resolve();
    });

    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:late");
  });
});
