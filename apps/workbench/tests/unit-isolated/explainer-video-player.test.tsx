import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useState, type ReactElement } from "react";

type PlayerOptions = {
  autoplay?: boolean;
  controls?: boolean;
  sources?: Array<{ src: string; type: string }>;
};

type MockPlayer = {
  dispose: ReturnType<typeof mock<() => void>>;
  on: ReturnType<typeof mock<(event: string, listener: () => void) => void>>;
};

const playerCalls: Array<{ element: HTMLVideoElement; options: PlayerOptions }> = [];
const players: MockPlayer[] = [];
let errorListener: (() => void) | undefined;
let initializationError: Error | undefined;

const videojsMock = mock((element: HTMLVideoElement, options: PlayerOptions): MockPlayer => {
  if (initializationError) throw initializationError;

  const player: MockPlayer = {
    dispose: mock(() => {}),
    on: mock((event, listener) => {
      if (event === "error") errorListener = listener;
    }),
  };
  playerCalls.push({ element, options });
  players.push(player);
  return player;
});

mock.module("video.js", () => ({
  default: videojsMock,
}));

// The playback-renderer suite replaces the ordinary module ID with a wrapper
// stub. A query-qualified import creates an isolated module instance, keeping
// this test focused on the real player implementation.
const { ExplainerVideoPlayer } = await import(
  "../../src/components/tool-card/renderers/explainer-video-player.tsx?explainer-video-player-test"
);

function player(props: Partial<React.ComponentProps<typeof ExplainerVideoPlayer>> = {}): ReactElement {
  return (
    <ExplainerVideoPlayer
      src="blob:explainer-intro"
      title="Explainer video"
      {...props}
    />
  );
}

beforeEach(() => {
  reapplyHappyDomGlobals();
  playerCalls.length = 0;
  players.length = 0;
  errorListener = undefined;
  initializationError = undefined;
  videojsMock.mockClear();
});

afterEach(() => {
  // Other suites can remove happy-dom globals with `mock.restore()`. Reinstall
  // them before teardown so this file remains safe in the full package run.
  reapplyHappyDomGlobals();
  cleanup();
  document.body.replaceChildren();
});

describe("ExplainerVideoPlayer", () => {
  test("renders a video element and initializes MP4 playback without autoplay", () => {
    const view = render(player());

    const video = view.getByTestId("explainer-video-player");
    expect(video.tagName).toBe("VIDEO");
    expect(video.getAttribute("autoplay")).toBeNull();
    expect(playerCalls).toHaveLength(1);
    expect(playerCalls[0]?.element).toBe(video);
    expect(playerCalls[0]?.options).toMatchObject({
      autoplay: false,
      controls: true,
      sources: [{ src: "blob:explainer-intro", type: "video/mp4" }],
    });
    expect(view.container.textContent).not.toContain("blob:explainer-intro");
  });

  test("always uses the MP4 MIME type for Blob URLs", () => {
    render(player({ src: "blob:explainer-updated" }));

    expect(playerCalls[0]?.options.sources).toEqual([
      { src: "blob:explainer-updated", type: "video/mp4" },
    ]);
  });

  test("keeps video-control interactions from reaching the ToolCard", () => {
    const onCardClick = mock(() => {});
    const onCardKeyDown = mock(() => {});
    const view = render(
      <div onClick={onCardClick} onKeyDown={onCardKeyDown}>
        {player()}
      </div>,
    );

    const video = view.getByTestId("explainer-video-player");
    fireEvent.click(video);
    fireEvent.keyDown(video, { key: " " });

    expect(onCardClick).not.toHaveBeenCalled();
    expect(onCardKeyDown).not.toHaveBeenCalled();
  });

  test("disposes the previous player on source replacement and unmount", () => {
    const view = render(player());
    const firstPlayer = players[0];

    view.rerender(player({ src: "blob:explainer-updated" }));

    expect(firstPlayer?.dispose).toHaveBeenCalledTimes(1);
    expect(players).toHaveLength(2);

    view.unmount();

    expect(players[1]?.dispose).toHaveBeenCalledTimes(1);
  });

  test("shows an accessible fallback when Video.js reports an error without a parent handler", async () => {
    const view = render(player());

    await act(async () => {
      errorListener?.();
    });

    expect(view.getByRole("alert").textContent).toContain("Video playback is unavailable.");
    expect(view.queryByTestId("explainer-video-player")).toBeNull();
  });

  test("notifies the parent when Video.js initialization throws synchronously", () => {
    initializationError = new Error("initialization failed");
    const onPlaybackError = mock(() => {});
    function RetryHarness(): ReactElement {
      const [failed, setFailed] = useState(false);
      if (failed) {
        return (
          <div>
            <p role="alert">Video playback is unavailable.</p>
            <button
              type="button"
              onClick={() => {
                initializationError = undefined;
                setFailed(false);
              }}
            >
              Retry
            </button>
          </div>
        );
      }
      return player({
        onPlaybackError: () => {
          onPlaybackError();
          setFailed(true);
        },
      });
    }

    const view = render(<RetryHarness />);

    expect(onPlaybackError).toHaveBeenCalledTimes(1);
    expect(view.getByRole("alert").textContent).toContain("Video playback is unavailable.");
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    expect(view.getByTestId("explainer-video-player")).not.toBeNull();
  });
});
