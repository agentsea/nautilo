import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";

let happyWindow: Window;
const priorGlobals: Record<string, unknown> = {};
let container: HTMLDivElement;
let root: Root;

let VoicePlaybackStopPill: (typeof import("./conversation/VoicePlaybackStopPill"))["VoicePlaybackStopPill"];

beforeAll(async () => {
  happyWindow = new Window({ url: "http://127.0.0.1:3001/" });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  for (const k of ["window", "document", "navigator", "HTMLElement"] as const) {
    priorGlobals[k] = (globalThis as Record<string, unknown>)[k];
  }
  Object.assign(globalThis, {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    HTMLElement: happyWindow.HTMLElement,
  });

  ({ VoicePlaybackStopPill } = await import("./conversation/VoicePlaybackStopPill"));
});

beforeEach(() => {
  container = happyWindow.document.createElement("div");
  happyWindow.document.body.appendChild(container);
  root = createRoot(container);
});

afterAll(() => {
  mock.restore();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  const g = globalThis as Record<string, unknown>;
  for (const key of Object.keys(priorGlobals)) {
    if (priorGlobals[key] === undefined) delete g[key];
    else g[key] = priorGlobals[key];
  }
});

function unmount() {
  act(() => {
    root.unmount();
  });
  container.remove();
}

describe("VoicePlaybackStopPill", () => {
  test("remains available when a reply is buffering between sentences", () => {
    const stopVoice = mock(() => {});
    act(() => {
      root.render(<VoicePlaybackStopPill enabled playing={false} canStop onStop={stopVoice} />);
    });
    const button = container.querySelector<HTMLButtonElement>('[data-testid="voice-playback-stop"]');
    expect(button?.disabled).toBe(false);
    expect(container.textContent).toContain("Speech in progress");
    act(() => { button?.click(); });
    expect(stopVoice).toHaveBeenCalledTimes(1);
    act(() => {
      root.render(<VoicePlaybackStopPill enabled playing={false} canStop={false} onStop={stopVoice} />);
    });
    expect(container.querySelector('[data-testid="voice-playback-stop-pill"]')).toBeNull();
    unmount();
  });

  test("is hidden unless voice playback is active", () => {
    act(() => {
      root.render(<VoicePlaybackStopPill enabled playing={false} onStop={() => {}} />);
    });
    expect(container.querySelector('[data-testid="voice-playback-stop-pill"]')).toBeNull();
    unmount();
  });

  test("stops voice playback without invoking job stop behavior", () => {
    const stopVoice = mock(() => {});
    const stopActiveJobs = mock(() => {});

    act(() => {
      root.render(<VoicePlaybackStopPill enabled playing onStop={stopVoice} />);
    });

    const button = container.querySelector(
      '[data-testid="voice-playback-stop"]',
    ) as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    expect(button?.textContent).toBe("Stop talking");

    act(() => {
      button?.click();
    });

    expect(stopVoice).toHaveBeenCalledTimes(1);
    expect(stopActiveJobs).not.toHaveBeenCalled();
    unmount();
  });
});
