import "../../../../tests/bun-dom-preload";
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ToolRendererProps } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiStub = {
  listWorkspaceArtifacts: mock(async () => ({ artifacts: [{
    id: "internal-media-1",
    artifactId: "media-1",
    path: "generated-media/renamed.mp4",
    mimeType: "video/mp4",
  }] })),
  getWorkspaceArtifactBytes: mock(async () => new Blob(["video bytes"], { type: "video/mp4" })),
  getMediaGenerationStatus: mock(async (_receiptId: string, _opts: { roomId: string; signal?: AbortSignal }) => queuedStatus()),
};
const requestOpenFile = mock(() => true);
let activeRoomId: string | null = "room-1";
const ambientProps: Array<{ mediaKind: "video" | "music"; state: "queued" | "generating" | "downloading" | "saving" }> = [];

let renderer: (typeof import("./generated-media"))["generatedMediaRenderer"];
let root: Root | null = null;
let container: HTMLDivElement | null = null;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const readyEnvelope = {
  kind: "generated_media",
  version: 1,
  receiptId: "mg_1234567890abcdef",
  queueStarted: true,
  mediaKind: "video",
  state: "ready",
  model: "seedance-2-5-text-to-video-basic",
  promptSummary: "A bright sailboat crossing calm water.",
  settings: { durationSeconds: 5, resolution: "720p" },
  artifact: {
    artifactId: "media-1",
    path: "generated-media/sailboat.mp4",
    zone: "workspace",
    mime: "video/mp4",
    bytes: 1_024,
  },
  recoveryActions: [],
};

function queuedStatus(revision = 1) {
  return {
    dtoVersion: 1 as const,
    receiptId: readyEnvelope.receiptId,
    revision,
    mediaKind: "video" as const,
    state: "queued" as const,
    modelId: readyEnvelope.model,
    settings: { durationSeconds: 5, resolution: "720p" },
    progress: { phase: "queued" as const },
    recoveryActions: [],
  };
}

function generatingStatus(revision: number, elapsedSeconds: number) {
  return {
    ...queuedStatus(revision),
    state: "generating" as const,
    progress: { phase: "generating" as const, elapsedSeconds, estimatedSeconds: 145 },
  };
}

function readyStatus(revision = 2) {
  return {
    ...queuedStatus(revision),
    state: "ready" as const,
    progress: undefined,
    artifact: readyEnvelope.artifact,
  };
}

beforeAll(async () => {
  mock.module("../../../lib/api", () => ({ apiClient: apiStub }));
  mock.module("../../../contexts/room-navigation-context", () => ({
    useRoomNavigation: () => ({ activeRoomId }),
  }));
  mock.module("../../../adapters/open-file-ref", () => ({ requestOpenFile }));
  mock.module("./generated-media-ambient", () => ({
    GeneratedMediaAmbientFeedback: (props: { mediaKind: "video" | "music"; state: "queued" | "generating" | "downloading" | "saving" }) => {
      ambientProps.push(props);
      return <div data-testid="generated-media-ambient" data-media-kind={props.mediaKind} data-ambient-state={props.state} aria-hidden="true" />;
    },
  }));
  ({ generatedMediaRenderer: renderer } = await import("./generated-media"));
});

beforeEach(() => {
  apiStub.listWorkspaceArtifacts.mockClear();
  apiStub.getWorkspaceArtifactBytes.mockClear();
  apiStub.getMediaGenerationStatus.mockClear();
  apiStub.getMediaGenerationStatus.mockImplementation(async () => queuedStatus());
  activeRoomId = "room-1";
  ambientProps.length = 0;
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  requestOpenFile.mockClear();
  URL.createObjectURL = mock(() => "blob:generated-media");
  URL.revokeObjectURL = mock(() => undefined);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function render(resultText: string): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const props: ToolRendererProps = {
    args: {}, result: undefined, state: "success", event: undefined, resultText, resultTruncated: false,
  };
  await act(async () => { root!.render(<renderer.ExpandedBody {...props} />); });
  await act(async () => { await Promise.resolve(); });
}

async function rerender(resultText: string): Promise<void> {
  const props: ToolRendererProps = {
    args: {}, result: undefined, state: "success", event: undefined, resultText, resultTruncated: false,
  };
  await act(async () => { root!.render(<renderer.ExpandedBody {...props} />); });
  await act(async () => { await Promise.resolve(); });
}

describe("generatedMediaRenderer", () => {
  test("auto-expands and plays only authenticated Workspace bytes", async () => {
    await render(JSON.stringify(readyEnvelope));
    expect(container?.querySelector('[data-testid="generated-media-expanded"]')).not.toBeNull();
    expect(container?.querySelector('[data-testid="generated-media-video"]')).not.toBeNull();
    expect(container?.textContent).toContain("Workspace/generated-media/renamed.mp4");
    expect(container?.textContent).toContain("video/mp4 · 1 KB");
    expect(apiStub.listWorkspaceArtifacts).toHaveBeenCalledWith({
      pathPrefix: "generated-media/", roomId: "room-1",
    });
    expect(apiStub.getWorkspaceArtifactBytes).toHaveBeenCalledWith("internal-media-1", { roomId: "room-1" });
    expect(renderer.autoExpandOnResult).toBe(true);
  });

  test("shows loading until authenticated bytes resolve, then becomes ready", async () => {
    const pending = deferred<Blob>();
    apiStub.getWorkspaceArtifactBytes.mockImplementationOnce(() => pending.promise);
    await render(JSON.stringify(readyEnvelope));
    expect(container?.textContent).toContain("Loading the saved Workspace artifact…");
    expect(container?.querySelector('[data-testid="generated-media-video"]')).toBeNull();
    pending.resolve(new Blob(["video bytes"], { type: "video/mp4" }));
    await act(async () => { await Promise.resolve(); });
    expect(container?.querySelector('[data-testid="generated-media-video"]')).not.toBeNull();
  });

  test("shows a playback error and can retry the same authenticated artifact", async () => {
    apiStub.getWorkspaceArtifactBytes.mockImplementationOnce(async () => {
      throw new Error("artifact temporarily unavailable");
    });
    await render(JSON.stringify(readyEnvelope));
    expect(container?.textContent).toContain("Saved media playback is unavailable.");
    const retry = Array.from(container!.querySelectorAll("button"))
      .find((button) => button.textContent === "Retry playback");
    expect(retry).toBeTruthy();
    await act(async () => { retry!.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
    expect(apiStub.getWorkspaceArtifactBytes).toHaveBeenCalledTimes(2);
    expect(container?.querySelector('[data-testid="generated-media-video"]')).not.toBeNull();
  });

  test("does not bind a same-path artifact with a different external artifact id", async () => {
    apiStub.listWorkspaceArtifacts.mockImplementationOnce(async () => ({ artifacts: [{
      id: "wrong-internal-id",
      artifactId: "different-media",
      path: readyEnvelope.artifact.path,
      mimeType: "video/mp4",
    }] }));
    await render(JSON.stringify(readyEnvelope));
    expect(container?.textContent).toContain("The saved artifact is not currently available to this Workspace.");
    expect(apiStub.getWorkspaceArtifactBytes).not.toHaveBeenCalled();
    const open = Array.from(container!.querySelectorAll("button")).find((button) => button.textContent === "Open");
    expect(open).toBeTruthy();
    expect((open as HTMLButtonElement).disabled).toBe(true);
  });

  test("opens the canonical resolved Workspace artifact", async () => {
    await render(JSON.stringify(readyEnvelope));
    const open = Array.from(container!.querySelectorAll("button")).find((button) => button.textContent === "Open");
    expect(open).toBeTruthy();
    await act(async () => { open!.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
    expect(requestOpenFile).toHaveBeenCalledWith(expect.objectContaining({
      kind: "artifact", id: "internal-media-1", path: "generated-media/renamed.mp4", roomId: "room-1",
    }));
    expect(open?.tagName).toBe("BUTTON");
    open?.focus();
    expect(document.activeElement).toBe(open);
  });

  test("renders an accessible native audio player for ready audio", async () => {
    apiStub.listWorkspaceArtifacts.mockImplementationOnce(async () => ({ artifacts: [{
      id: "internal-audio-1",
      artifactId: "audio-1",
      path: "generated-media/renamed.mp3",
      mimeType: "audio/mpeg",
    }] }));
    apiStub.getWorkspaceArtifactBytes.mockImplementationOnce(async () => new Blob(["audio bytes"], { type: "audio/mpeg" }));
    await render(JSON.stringify({
      ...readyEnvelope,
      mediaKind: "audio",
      artifact: { ...readyEnvelope.artifact, artifactId: "audio-1", path: "generated-media/song.mp3", mime: "audio/mpeg", bytes: 2_048 },
    }));
    const audio = container?.querySelector('[data-testid="generated-media-audio"]');
    expect(audio).not.toBeNull();
    expect(audio?.getAttribute("controls")).not.toBeNull();
    expect(audio?.getAttribute("aria-label")).toContain("Play generated audio");
    expect(container?.textContent).toContain("audio/mpeg · 2 KB");
  });

  test("mounts ambient feedback for active media and maps audio to music", async () => {
    activeRoomId = null;
    await render(JSON.stringify({ ...readyEnvelope, state: "saving", artifact: undefined }));
    expect(container?.querySelector('[data-testid="generated-media-ambient"]')?.getAttribute("data-ambient-state")).toBe("saving");
    expect(ambientProps).toContainEqual({ mediaKind: "video", state: "saving" });

    await rerender(JSON.stringify({
      ...readyEnvelope,
      mediaKind: "audio",
      state: "downloading",
      artifact: undefined,
    }));
    expect(container?.querySelector('[data-testid="generated-media-ambient"]')?.getAttribute("data-media-kind")).toBe("music");
    expect(ambientProps).toContainEqual({ mediaKind: "music", state: "downloading" });
  });

  test("does not echo malformed topology or provider URLs", async () => {
    await render(JSON.stringify({ ...readyEnvelope, queueId: "https://provider.example/queue" }));
    expect(container?.querySelector('[data-testid="generated-media-unavailable"]')).not.toBeNull();
    expect(container?.textContent).not.toContain("provider.example");
    expect(apiStub.getWorkspaceArtifactBytes).not.toHaveBeenCalled();
  });

  test("labels unknown results and fresh work honestly", async () => {
    await render(JSON.stringify({
      ...readyEnvelope,
      queueStarted: null,
      state: "unknown",
      artifact: undefined,
      failure: { code: "ADMISSION_UNKNOWN", message: "Check status before starting another generation." },
      recoveryActions: [{ actionId: "fresh-1", kind: "fresh_generation", label: "Start fresh", newSpend: true }],
    }));
    expect(container?.textContent).toContain("Nautilo will not start another paid generation automatically.");
    expect(container?.textContent).toContain("new paid generation");
    expect(container?.textContent).toContain("new spend approval");
  });

  test("shows elapsed time and typical time without a countdown or percentage", async () => {
    activeRoomId = null;
    await render(JSON.stringify({
      ...readyEnvelope,
      state: "generating",
      artifact: undefined,
      progress: {
        elapsedSeconds: 72,
        estimatedSeconds: 145,
        message: "50% complete · 2m remaining",
      },
    }));
    expect(container?.textContent).toContain("Generation is active.");
    expect(container?.querySelector('[data-testid="generated-media-timing"]')?.textContent)
      .toContain("1m 12s elapsed · Typical time: about 2m 25s");
    expect(container?.textContent).not.toContain("50% complete");
    expect(container?.textContent).not.toContain("remaining");
    expect(container?.textContent).not.toContain("estimate");
  });

  test("advances the generating elapsed display between provider observations and resets on the next one", async () => {
    activeRoomId = null;
    const originalNow = Date.now;
    const originalSetInterval = window.setInterval;
    const originalClearInterval = window.clearInterval;
    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    let now = 10_000;
    let intervalCallback: (() => void) | null = null;
    const clearInterval = mock((_id: number) => undefined);
    Date.now = () => now;
    window.setInterval = ((callback: TimerHandler, _milliseconds?: number) => {
      intervalCallback = callback as () => void;
      return 1;
    }) as typeof window.setInterval;
    window.clearInterval = clearInterval as unknown as typeof window.clearInterval;
    try {
      await render(JSON.stringify({
        ...readyEnvelope,
        state: "generating",
        artifact: undefined,
        progress: { elapsedSeconds: 18, estimatedSeconds: 145 },
      }));
      expect(container?.querySelector('[data-testid="generated-media-timing"]')?.textContent).toContain("18s elapsed");

      now += 2_000;
      await act(async () => { intervalCallback?.(); });
      expect(container?.querySelector('[data-testid="generated-media-timing"]')?.textContent).toContain("20s elapsed");

      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
      now += 3_000;
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
      now += 1_000;
      await act(async () => { intervalCallback?.(); });
      expect(container?.querySelector('[data-testid="generated-media-timing"]')?.textContent).toContain("21s elapsed");

      await rerender(JSON.stringify({
        ...readyEnvelope,
        state: "generating",
        artifact: undefined,
        progress: { elapsedSeconds: 10, estimatedSeconds: 145 },
      }));
      expect(container?.querySelector('[data-testid="generated-media-timing"]')?.textContent).toContain("10s elapsed");

      now += 1_000;
      await act(async () => { intervalCallback?.(); });
      expect(container?.querySelector('[data-testid="generated-media-timing"]')?.textContent).toContain("11s elapsed");

      const hide = Array.from(container!.querySelectorAll("button"))
        .find((button) => button.textContent === "Hide progress");
      await act(async () => { hide!.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
      expect(clearInterval).toHaveBeenCalledWith(1);
      expect(container?.querySelector('[data-testid="generated-media-timing"]')).toBeNull();
    } finally {
      Date.now = originalNow;
      window.setInterval = originalSetInterval;
      window.clearInterval = originalClearInterval;
      if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
    }
  });

  test("keeps the local elapsed anchor through equal status revisions and reanchors on a newer revision", async () => {
    const originalNow = Date.now;
    const originalSetInterval = window.setInterval;
    const originalClearInterval = window.clearInterval;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let now = 10_000;
    let intervalCallback: (() => void) | null = null;
    let pollCallback: (() => void) | null = null;
    Date.now = () => now;
    window.setInterval = ((callback: TimerHandler, _milliseconds?: number) => {
      intervalCallback = callback as () => void;
      return 1;
    }) as typeof window.setInterval;
    window.clearInterval = mock((_id: number) => undefined) as unknown as typeof window.clearInterval;
    globalThis.setTimeout = ((callback: TimerHandler, _milliseconds?: number) => {
      pollCallback = callback as () => void;
      return 2 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof globalThis.setTimeout;
    globalThis.clearTimeout = mock((_id: number) => undefined) as unknown as typeof globalThis.clearTimeout;
    apiStub.getMediaGenerationStatus
      .mockImplementationOnce(async () => generatingStatus(1, 18))
      .mockImplementationOnce(async () => generatingStatus(1, 18))
      .mockImplementationOnce(async () => generatingStatus(2, 10));
    try {
      await render(JSON.stringify({ ...readyEnvelope, state: "queued", artifact: undefined }));
      expect(container?.querySelector('[data-testid="generated-media-timing"]')?.textContent).toContain("18s elapsed");

      now += 1_000;
      await act(async () => { intervalCallback?.(); });
      expect(container?.querySelector('[data-testid="generated-media-timing"]')?.textContent).toContain("19s elapsed");

      now += 1_000;
      await act(async () => {
        pollCallback?.();
        await Promise.resolve();
        await Promise.resolve();
      });
      now += 1_000;
      await act(async () => { intervalCallback?.(); });
      expect(container?.querySelector('[data-testid="generated-media-timing"]')?.textContent).toContain("21s elapsed");

      now += 1_000;
      await act(async () => {
        pollCallback?.();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(container?.querySelector('[data-testid="generated-media-timing"]')?.textContent).toContain("10s elapsed");

      now += 1_000;
      await act(async () => { intervalCallback?.(); });
      expect(container?.querySelector('[data-testid="generated-media-timing"]')?.textContent).toContain("11s elapsed");
      await act(async () => root?.unmount());
      root = null;
    } finally {
      Date.now = originalNow;
      window.setInterval = originalSetInterval;
      window.clearInterval = originalClearInterval;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  test("uses explicit submitted, active, download, and save lifecycle copy", async () => {
    activeRoomId = null;
    const active = { ...readyEnvelope, artifact: undefined };
    await render(JSON.stringify({ ...active, queueStarted: null, state: "submitting" }));
    expect(container?.textContent).toContain("Submitted to Venice. Awaiting acknowledgement");
    await rerender(JSON.stringify({ ...active, state: "queued" }));
    expect(container?.textContent).toContain("Submitted to Venice. Checking progress…");
    await rerender(JSON.stringify({ ...active, state: "generating" }));
    expect(container?.textContent).toContain("Generation is active.");
    await rerender(JSON.stringify({ ...active, state: "downloading" }));
    expect(container?.textContent).toContain("Generation finished—downloading securely.");
    await rerender(JSON.stringify({ ...active, state: "saving" }));
    expect(container?.textContent).toContain("Saving to Workspace…");
  });

  test("explains a run exceeding its typical time without implying it is stuck", async () => {
    activeRoomId = null;
    await render(JSON.stringify({
      ...readyEnvelope,
      state: "generating",
      artifact: undefined,
      progress: { elapsedSeconds: 146, estimatedSeconds: 145 },
    }));
    expect(container?.textContent).toContain(
      "This run is taking longer than typical, but Venice still reports it active.",
    );
  });

  test("can hide local progress without implying the paid generation was cancelled", async () => {
    activeRoomId = null;
    await render(JSON.stringify({
      ...readyEnvelope,
      state: "queued",
      artifact: undefined,
    }));
    const hide = Array.from(container!.querySelectorAll("button"))
      .find((button) => button.textContent === "Hide progress");
    expect(hide).toBeTruthy();
    await act(async () => { hide!.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
    expect(container?.textContent).toContain("Generation continues in the background.");
    expect(container?.textContent).not.toContain("Cancelled");
    expect(container?.querySelector('[data-testid="generated-media-ambient"]')).toBeNull();
    expect(container?.querySelector('[data-testid="generated-media-visual-slot"]')).toBeNull();
    const show = Array.from(container!.querySelectorAll("button"))
      .find((button) => button.textContent === "Show progress");
    expect(show).toBeTruthy();
    await act(async () => { show!.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
    expect(container?.textContent).toContain("Submitted to Venice. Checking progress…");
    expect(container?.querySelector('[data-testid="generated-media-ambient"]')).not.toBeNull();
  });

  test("polls a validated scoped receipt from queued to ready", async () => {
    apiStub.getMediaGenerationStatus
      .mockImplementationOnce(async () => queuedStatus(1))
      .mockImplementationOnce(async () => readyStatus(2));
    await render(JSON.stringify({ ...readyEnvelope, state: "queued", artifact: undefined }));
    const activeStatus = container?.querySelector('section[aria-live="polite"]');
    const visualSlot = container?.querySelector('[data-testid="generated-media-visual-slot"]');
    expect(activeStatus?.getAttribute("aria-busy")).toBe("true");
    expect(visualSlot).not.toBeNull();
    expect(container?.querySelector('[data-testid="generated-media-ambient"]')).not.toBeNull();
    expect(ambientProps).toContainEqual({ mediaKind: "video", state: "queued" });
    expect(apiStub.getMediaGenerationStatus).toHaveBeenCalledWith(
      readyEnvelope.receiptId,
      expect.objectContaining({ roomId: "room-1", signal: expect.any(AbortSignal) }),
    );
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container?.textContent).toContain("Ready");
    expect(container?.querySelector('section[aria-live="polite"]')?.getAttribute("aria-busy")).toBe("false");
    expect(container?.querySelector('[data-testid="generated-media-progress-spinner"]')).toBeNull();
    expect(container?.querySelector('[data-testid="generated-media-ambient"]')).toBeNull();
    expect(container?.querySelector('[data-testid="generated-media-video"]')).not.toBeNull();
    expect(container?.querySelector('[data-testid="generated-media-visual-slot"]')).toBe(visualSlot);
    expect(container?.textContent).toContain("Workspace/generated-media/renamed.mp4");
    expect(apiStub.getMediaGenerationStatus).toHaveBeenCalledTimes(2);
  });

  test("suppresses a stale response and retains the newer safe card", async () => {
    apiStub.getMediaGenerationStatus
      .mockImplementationOnce(async () => ({
        ...queuedStatus(5),
        state: "generating" as const,
        progress: { phase: "generating" as const, message: "Generation is in progress." },
      }))
      .mockImplementationOnce(async () => readyStatus(4));
    await render(JSON.stringify({ ...readyEnvelope, state: "queued", artifact: undefined }));
    expect(container?.textContent).toContain("Generating");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container?.textContent).toContain("Generating");
    expect(apiStub.listWorkspaceArtifacts).not.toHaveBeenCalled();
  });

  test("aborts an in-flight status request on unmount", async () => {
    const pending = deferred<ReturnType<typeof queuedStatus>>();
    let observedSignal: AbortSignal | undefined;
    apiStub.getMediaGenerationStatus.mockImplementationOnce((_receiptId, opts) => {
      observedSignal = opts.signal;
      return pending.promise;
    });
    await render(JSON.stringify({ ...readyEnvelope, state: "queued", artifact: undefined }));
    expect(observedSignal?.aborted).toBe(false);
    await act(async () => root?.unmount());
    expect(observedSignal?.aborted).toBe(true);
    root = null;
  });

  test("keeps the current safe state through 404 and 503 status failures", async () => {
    apiStub.getMediaGenerationStatus
      .mockImplementationOnce(async () => { throw Object.assign(new Error("not found"), { status: 404 }); })
      .mockImplementationOnce(async () => { throw Object.assign(new Error("unavailable"), { status: 503 }); });
    await render(JSON.stringify({ ...readyEnvelope, state: "queued", artifact: undefined }));
    expect(container?.textContent).toContain("Queued");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container?.textContent).toContain("Queued");
    expect(container?.textContent).not.toContain("not found");
    expect(container?.textContent).not.toContain("unavailable");
    expect(apiStub.listWorkspaceArtifacts).not.toHaveBeenCalled();
  });

  test("does not poll without an active Room or after a terminal result", async () => {
    activeRoomId = null;
    await render(JSON.stringify({ ...readyEnvelope, state: "queued", artifact: undefined }));
    expect(apiStub.getMediaGenerationStatus).not.toHaveBeenCalled();
    await act(async () => root?.unmount());
    root = null;
    activeRoomId = "room-1";
    await render(JSON.stringify(readyEnvelope));
    expect(apiStub.getMediaGenerationStatus).not.toHaveBeenCalled();
    await act(async () => root?.unmount());
    root = null;
    await render(JSON.stringify({
      ...readyEnvelope,
      receiptId: undefined,
      queueStarted: false,
      state: "failed",
      artifact: undefined,
      failure: { code: "APPROVAL_STALE", message: "Request a fresh exact quote." },
    }));
    expect(apiStub.getMediaGenerationStatus).not.toHaveBeenCalled();
  });

  test("does not fetch or create a Blob URL when the resolved MIME family disagrees", async () => {
    apiStub.listWorkspaceArtifacts.mockImplementationOnce(async () => ({ artifacts: [{
      id: "internal-media-1",
      artifactId: "media-1",
      path: "generated-media/renamed.mp3",
      mimeType: "audio/mpeg",
    }] }));
    await render(JSON.stringify(readyEnvelope));
    expect(container?.textContent).toContain("incompatible media type");
    expect(container?.querySelector('[data-testid="generated-media-video"]')).toBeNull();
    expect(apiStub.getWorkspaceArtifactBytes).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  test("reuses its Object URL while the same artifact card rerenders", async () => {
    await render(JSON.stringify(readyEnvelope));
    await rerender(JSON.stringify(readyEnvelope));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    await act(async () => root?.unmount());
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    root = null;
  });

  test("revokes its Blob URL when the card unmounts", async () => {
    await render(JSON.stringify(readyEnvelope));
    await act(async () => root?.unmount());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:generated-media");
    root = null;
  });
});
