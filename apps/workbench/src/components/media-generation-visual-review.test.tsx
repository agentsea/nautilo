import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { MediaGenerationApproval } from "@nautilo/types";
import { apiClient } from "../lib/api";
import { friendlyReferenceName, generationPrice, loadApprovalReference, MediaGenerationVisualReview } from "./media-generation-visual-review";

const bytes = new TextEncoder().encode("reference bytes").buffer;
const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const reference = { index: 1, artifactId: "public-image", label: "70e34034-61df-4abd-b8f7-5428433ecbad.png", content: { sha256: hash, sizeBytes: bytes.byteLength, mimeType: "image/png" } };
const audioReference = { ...reference, artifactId: "public-audio", label: "mg_internal.wav", durationSeconds: 2.75, content: { ...reference.content, mimeType: "audio/wav" } };
const approval: MediaGenerationApproval = {
  version: "media-generation-approval-v1", digest: "a".repeat(64), quoteDigest: "b".repeat(64), revision: 1, expiresAt: "2099-01-01T00:00:00Z",
  preview: { mediaKind: "video", model: "seedance-2-5-reference-to-video-basic", settings: { durationSeconds: 4, resolution: "480p", aspectRatio: "16:9", audio: false },
    referenceImages: [reference], referenceVideos: [{ ...reference, artifactId: "public-video", label: "mg_internal.mp4", durationSeconds: 4.042, content: { ...reference.content, mimeType: "video/mp4" } }],
    referenceAudios: [audioReference],
    prompt: { characterCount: 24, summary: "Internal compiled prompt", truncated: true }, quote: { currency: "USD", amountMicros: 930_000, display: "USD 0.930000" }, spendNotice: "Approving starts paid generation." },
};
let win: Window;
const previous: Record<string, unknown> = {};
beforeAll(() => {
  win = new Window();
  for (const key of ["window", "document", "navigator", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) previous[key] = (globalThis as Record<string, unknown>)[key];
  Object.assign(globalThis, { window: win, document: win.document, navigator: win.navigator, HTMLElement: win.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
});
afterAll(async () => { await win.happyDOM.cancelAsync(); win.close(); for (const [key, value] of Object.entries(previous)) {
  if (value === undefined) delete (globalThis as Record<string, unknown>)[key]; else (globalThis as Record<string, unknown>)[key] = value;
} });

function mockArtifacts() {
  const list = spyOn(apiClient, "getWorkspaceArtifactByPublicId").mockImplementation(async id => {
    const ref = [reference, approval.preview.referenceVideos![0]!, audioReference].find(item => item.artifactId === id);
    return ref ? { id: `db-${ref.artifactId}`, artifactId: ref.artifactId, size: ref.content!.sizeBytes, mimeType: ref.content!.mimeType } as NonNullable<Awaited<ReturnType<typeof apiClient.getWorkspaceArtifactByPublicId>>> : null;
  });
  const read = spyOn(apiClient, "getWorkspaceArtifactBytesArrayBuffer").mockResolvedValue(bytes);
  return { list, read, restore: () => { list.mockRestore(); read.mockRestore(); } };
}

test("only authenticated room-scoped bytes matching the exact quote can become a preview", async () => {
  const mocks = mockArtifacts();
  try {
    const signal = new AbortController().signal;
    expect((await loadApprovalReference(reference, "room-1", signal)).size).toBe(bytes.byteLength);
    expect(mocks.list).toHaveBeenCalledWith("public-image", { roomId: "room-1", signal });
    expect(mocks.read).toHaveBeenCalledWith("db-public-image", { roomId: "room-1", signal, expectedBytes: bytes.byteLength, maxBytes: bytes.byteLength });
    await expect(loadApprovalReference({ ...reference, content: { ...reference.content, sha256: "f".repeat(64) } }, "room-1", signal)).rejects.toThrow("changed");
    await expect(loadApprovalReference({ ...reference, content: undefined }, "room-1", signal)).rejects.toThrow("older approval");
    await expect(loadApprovalReference({ ...reference, artifactId: "missing" }, "room-1", signal)).rejects.toThrow("unavailable");
    const aborted = new AbortController(); aborted.abort();
    await expect(loadApprovalReference(reference, "room-1", aborted.signal)).rejects.toThrow("Cancelled");
  } finally { mocks.restore(); }
});

test("human review shows image, playable video and exact-byte audio, friendly names, duration, full prompt and price; cleans up media", async () => {
  const mocks = mockArtifacts();
  const revoke = spyOn(URL, "revokeObjectURL");
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(<MediaGenerationVisualReview approval={approval} roomId="room-1" presentation={{ sceneName: "Scene 2", prompt: "Keep the blue sphere turning slowly.", continuation: { artifactId: "public-video", sceneName: "Opening" }, referenceNames: { "public-video": "Opening", "public-image": "Blue sphere", "public-audio": "Whisper guide" } }} technicalDetails={<p>Internal diagnostics</p>} />);
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(host.querySelector('img[alt="Blue sphere"]')?.getAttribute("src")).toStartWith("blob:");
    expect(host.querySelector('video[aria-label="Preview Opening"]')?.hasAttribute("controls")).toBe(true);
    expect(host.querySelector('audio[aria-label="Preview Whisper guide"]')?.hasAttribute("controls")).toBe(true);
    expect(host.textContent).toContain("Audio reference · 2.75 sec");
    expect(host.textContent).toContain("Continuing from Opening");
    expect(host.textContent).toContain("Keep the blue sphere turning slowly.");
    expect(host.textContent).toContain("$0.93");
    expect(host.textContent).not.toContain("mg_internal");
    expect(host.textContent).not.toContain("70e34034");
    expect(host.querySelector("details")?.open).toBe(false);
    await act(async () => root.unmount());
    expect(revoke).toHaveBeenCalledTimes(3);
  } finally { if (host.isConnected) host.remove(); revoke.mockRestore(); mocks.restore(); }
});

test("storage labels stay out of the main review and sub-cent prices stay exact", () => {
  expect(friendlyReferenceName(reference.label, "Image reference 1")).toBe("Image reference 1");
  expect(friendlyReferenceName("mg_internal.mp4", "Video reference 1")).toBe("Video reference 1");
  expect(friendlyReferenceName("Ocean sunset.mp4", "Video reference 1")).toBe("Ocean sunset.mp4");
  expect(generationPrice({ ...approval, preview: { ...approval.preview, quote: { ...approval.preview.quote, amountMicros: 930_001 } } })).toBe("$0.930001");
});
