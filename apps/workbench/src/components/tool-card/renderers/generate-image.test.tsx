import "../../../../tests/bun-dom-preload";
import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ambient = mock(({ mediaKind, state }: { mediaKind: string; state: string }) => (
  <div data-testid="generated-media-ambient" data-kind={mediaKind} data-state={state} />
));

let generateImageRenderer: (typeof import("./generate-image"))["generateImageRenderer"];
let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(async () => {
  mock.module("./generated-media-ambient", () => ({ GeneratedMediaAmbientFeedback: ambient }));
  ({ generateImageRenderer } = await import("./generate-image"));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  ambient.mockClear();
});

async function render(state: "pending" | "running" | "success"): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const ExpandedBody = generateImageRenderer.ExpandedBody!;
  await act(async () => {
    root!.render(<ExpandedBody args={{}} result={undefined} resultText={undefined} state={state} />);
  });
}

describe("generate image tool card", () => {
  test("shows the shared image ambient for the real running state and auto-expands it", async () => {
    await render("running");
    expect(generateImageRenderer.autoExpandWhileRunning).toBe(true);
    expect(container?.querySelector('[data-testid="generated-media-ambient"]')?.getAttribute("data-kind")).toBe("image");
    expect(container?.querySelector('[data-testid="generated-media-ambient"]')?.getAttribute("data-state")).toBe("generating");
  });

  test("removes the ambient outside the running state and after a terminal result", async () => {
    await render("pending");
    expect(container?.querySelector('[data-testid="generated-media-ambient"]')).toBeNull();
    await act(async () => {
      const ExpandedBody = generateImageRenderer.ExpandedBody!;
      root!.render(<ExpandedBody args={{}} result={undefined} resultText="done" state="success" />);
    });
    expect(container?.querySelector('[data-testid="generated-media-ambient"]')).toBeNull();
  });
});
