import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot } from "react-dom/client";
import type { MediaGenerationApproval } from "@nautilo/types";
import { VideoGenerationReviewOverlay } from "./video-generation-review-overlay";

const approval = {
  version: "media-generation-approval-v1",
  digest: "a".repeat(64),
  quoteDigest: "b".repeat(64),
  revision: 1,
  expiresAt: "2099-01-01T00:00:00.000Z",
  preview: {
    mediaKind: "video",
    model: "seedance-2-5-text-to-video-basic",
    settings: { durationSeconds: 5 },
    prompt: { characterCount: 24, summary: "A safe prompt summary", truncated: false },
    quote: { currency: "USD", amountMicros: 100_000, display: "USD 0.100000" },
    spendNotice: "Approving starts a paid generation using this exact quote.",
  },
} as MediaGenerationApproval;

let win: Window;
const previous: Record<string, unknown> = {};

beforeAll(() => {
  win = new Window({ url: "http://127.0.0.1:3001/" });
  for (const key of ["window", "document", "navigator", "HTMLElement"] as const) previous[key] = (globalThis as Record<string, unknown>)[key];
  Object.assign(globalThis, { window: win, document: win.document, navigator: win.navigator, HTMLElement: win.HTMLElement });
});

afterAll(async () => {
  // Let React's scheduled cleanup settle before removing its browser globals.
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete (globalThis as Record<string, unknown>)[key];
    else (globalThis as Record<string, unknown>)[key] = value;
  }
  await win.happyDOM.cancelAsync?.();
  win.close();
});

test("offers one generation or cancel, never standing approval controls", async () => {
  const host = win.document.createElement("div");
  win.document.body.appendChild(host);
  let once = 0;
  let cancel = 0;
  const root = createRoot(host as unknown as HTMLElement);
  root.render(<VideoGenerationReviewOverlay approval={approval} onOnce={() => { once += 1; }} onCancel={() => { cancel += 1; }} />);
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(host.querySelector('[data-testid="video-generation-review-overlay"]')).not.toBeNull();
  expect(host.textContent).toContain("Review video generation");
  expect(host.textContent).toContain("Paid video generation");
  expect(host.textContent).toContain("Generate · $0.10");
  expect(host.textContent).not.toContain("Always");
  expect(host.textContent).not.toContain("This room");
  (host.querySelector("button:last-child") as HTMLButtonElement).click();
  (host.querySelector("button:first-of-type") as HTMLButtonElement).click();
  expect(once).toBe(1);
  expect(cancel).toBe(1);
  root.unmount();
  host.remove();
});

describe("VideoGenerationReviewOverlay", () => {
  test("renders nothing without a parent-owned review", () => {
    const host = win.document.createElement("div");
    const root = createRoot(host as unknown as HTMLElement);
    root.render(<VideoGenerationReviewOverlay approval={null} onOnce={() => {}} onCancel={() => {}} />);
    expect(host.textContent).toBe("");
    root.unmount();
  });
});
