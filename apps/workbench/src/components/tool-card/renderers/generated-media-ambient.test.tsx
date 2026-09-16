import "../../../../tests/bun-dom-preload";
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { GeneratedMediaKind } from "@nautilo/generated-media-ui";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type AmbientState = "queued" | "generating" | "downloading" | "saving";

const runtime = {
  create: mock((_container: HTMLElement, _mediaKind: GeneratedMediaKind, _onContextLoss: () => void) => ({
    setState: mock((_state: AmbientState) => undefined),
    setPointer: mock((_x: number, _y: number) => undefined),
    resize: mock(() => undefined),
    setRunning: mock((_running: boolean) => undefined),
    dispose: mock(() => undefined),
  })),
};

let GeneratedMediaAmbientFeedback: (typeof import("./generated-media-ambient"))["GeneratedMediaAmbientFeedback"];
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let reducedMotion = false;
let rafId = 0;
const rafCallbacks = new Map<number, FrameRequestCallback>();
const cancelledFrames: number[] = [];

class TestIntersectionObserver {
  static instances: TestIntersectionObserver[] = [];
  readonly observe = mock((_target: Element) => undefined);
  readonly unobserve = mock((_target: Element) => undefined);
  readonly disconnect = mock(() => undefined);

  constructor(private readonly callback: IntersectionObserverCallback) {
    TestIntersectionObserver.instances.push(this);
  }

  emit(isIntersecting: boolean): void {
    this.callback([{ isIntersecting, target: document.createElement("div") } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

class TestResizeObserver {
  static instances: TestResizeObserver[] = [];
  readonly observe = mock((_target: Element) => undefined);
  readonly disconnect = mock(() => undefined);

  constructor(private readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this);
  }

  emit(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

function latestRuntime() {
  return runtime.create.mock.results.at(-1)?.value as ReturnType<typeof runtime.create> | undefined;
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

async function render(props: { mediaKind?: GeneratedMediaKind; state?: AmbientState; theme?: "light" | "dark" } = {}): Promise<void> {
  container = document.createElement("div");
  if (props.theme) container.dataset.theme = props.theme;
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <GeneratedMediaAmbientFeedback
        mediaKind={props.mediaKind ?? "video"}
        state={props.state ?? "generating"}
      />,
    );
  });
}

async function rerender(props: { mediaKind?: GeneratedMediaKind; state?: AmbientState }): Promise<void> {
  await act(async () => {
    root!.render(<GeneratedMediaAmbientFeedback mediaKind={props.mediaKind ?? "video"} state={props.state ?? "generating"} />);
  });
}

function makeIntersecting(): void {
  const observer = TestIntersectionObserver.instances.at(-1);
  expect(observer).toBeTruthy();
  observer!.emit(true);
}

beforeAll(async () => {
  mock.module("@nautilo/generated-media-ui/runtime", () => ({
    createGeneratedMediaAmbientRuntime: runtime.create,
  }));
  ({ GeneratedMediaAmbientFeedback } = await import("./generated-media-ambient"));
});
beforeEach(() => {
  runtime.create.mockClear();
  TestIntersectionObserver.instances = [];
  TestResizeObserver.instances = [];
  reducedMotion = false;
  rafId = 0;
  rafCallbacks.clear();
  cancelledFrames.length = 0;
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: mock((query: string) => ({ matches: query === "(prefers-reduced-motion: reduce)" && reducedMotion, media: query, addEventListener: mock(() => undefined), removeEventListener: mock(() => undefined) })),
  });
  globalThis.IntersectionObserver = TestIntersectionObserver as unknown as typeof IntersectionObserver;
  globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    rafId += 1;
    rafCallbacks.set(rafId, callback);
    return rafId;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => {
    cancelledFrames.push(id);
    rafCallbacks.delete(id);
  }) as typeof cancelAnimationFrame;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("GeneratedMediaAmbientFeedback", () => {
  test("lazily creates one parameterized scene for video and music without fabricated progress copy", async () => {
    await render({ mediaKind: "video", state: "queued" });
    const ambient = container?.querySelector<HTMLElement>('[data-testid="generated-media-ambient"]');
    const fallback = container?.querySelector<HTMLElement>('[data-testid="generated-media-ambient-fallback"]');
    expect(ambient).not.toBeNull();
    expect(fallback).not.toBeNull();
    expect(ambient?.style.position).toBe("relative");
    expect(ambient?.style.overflow).toBe("hidden");
    expect(ambient?.style.getPropertyValue("--generation-ambient-background")).toBeTruthy();
    expect(ambient?.style.getPropertyValue("--generation-ambient-coral")).toBeTruthy();
    expect(ambient?.style.getPropertyValue("--generation-ambient-cyan")).toBeTruthy();
    expect(ambient?.style.getPropertyValue("--generation-ambient-ink")).toBeTruthy();
    expect(ambient?.style.getPropertyValue("--generation-ambient-frame")).toBeTruthy();
    expect(fallback?.style.position).toBe("absolute");
    expect(fallback?.style.inset).toBe("0");
    expect(container?.textContent).not.toMatch(/illustrative|\d+%|countdown|remaining/i);
    expect(runtime.create).not.toHaveBeenCalled();
    makeIntersecting();
    await flush();
    expect(runtime.create).toHaveBeenCalledWith(expect.any(HTMLElement), "video", expect.any(Function));
    expect(latestRuntime()?.setState).toHaveBeenCalledWith("queued");

    await act(async () => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    await render({ mediaKind: "music", state: "generating" });
    makeIntersecting();
    await flush();
    expect(runtime.create).toHaveBeenLastCalledWith(expect.any(HTMLElement), "music", expect.any(Function));
    expect(latestRuntime()?.setState).toHaveBeenCalledWith("generating");
    await act(async () => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    await render({ mediaKind: "image", state: "generating" });
    makeIntersecting();
    await flush();
    expect(runtime.create).toHaveBeenLastCalledWith(expect.any(HTMLElement), "image", expect.any(Function));
  });

  test("updates canonical state in the existing runtime instead of rebuilding or leaking another loop", async () => {
    await render({ state: "generating" });
    makeIntersecting();
    await flush();
    const scene = latestRuntime();
    expect(scene).toBeTruthy();
    await rerender({ state: "downloading" });
    await flush();
    expect(runtime.create).toHaveBeenCalledTimes(1);
    expect(scene?.setState).toHaveBeenLastCalledWith("downloading");
    expect(scene?.setRunning).toHaveBeenLastCalledWith(true);
    Object.defineProperty(container!, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    });
    await act(async () => {
      container!.dispatchEvent(new window.MouseEvent("pointermove", { bubbles: true, clientX: 75, clientY: 25 }));
    });
    expect(scene?.setPointer).toHaveBeenLastCalledWith(0.5, 0.5);
  });

  test("refreshes the host theme once without observing its own palette writes", async () => {
    await render({ theme: "dark" });
    makeIntersecting();
    await flush();
    const scene = latestRuntime();
    const ambient = container?.querySelector<HTMLElement>('[data-testid="generated-media-ambient"]');
    expect(ambient?.style.getPropertyValue("--generation-ambient-theme")).toBe("dark");
    const resizeCalls = scene?.resize.mock.calls.length ?? 0;
    container!.dataset.theme = "light";
    await flush();
    expect(ambient?.style.getPropertyValue("--generation-ambient-theme")).toBe("light");
    expect(scene?.resize).toHaveBeenCalledTimes(resizeCalls + 1);
    await flush();
    expect(scene?.resize).toHaveBeenCalledTimes(resizeCalls + 1);
  });

  test("follows Workbench's root dark class as well as the embedded app theme", async () => {
    await render();
    const ambient = container?.querySelector<HTMLElement>('[data-testid="generated-media-ambient"]');
    try {
      document.documentElement.classList.add("dark");
      await flush();
      expect(ambient?.style.getPropertyValue("--generation-ambient-theme")).toBe("dark");
      document.documentElement.classList.remove("dark");
      await flush();
      expect(ambient?.style.getPropertyValue("--generation-ambient-theme")).toBe("light");
    } finally { document.documentElement.classList.remove("dark"); }
  });

  test("uses the static fallback and never imports or starts a runtime when reduced motion is requested", async () => {
    reducedMotion = true;
    await render();
    makeIntersecting();
    await flush();
    expect(container?.querySelector('[data-testid="generated-media-ambient-fallback"]')).not.toBeNull();
    expect(container?.querySelector('[data-testid="generated-media-ambient"]')?.style.background).toBe("var(--generation-ambient-background)");
    expect(runtime.create).not.toHaveBeenCalled();
    expect(rafCallbacks).toHaveLength(0);
  });

  test("pauses hidden and offscreen work, then resumes the same scene exactly once", async () => {
    await render();
    makeIntersecting();
    await flush();
    const scene = latestRuntime();
    expect(scene?.setRunning).toHaveBeenLastCalledWith(true);
    TestIntersectionObserver.instances[0].emit(false);
    expect(scene?.setRunning).toHaveBeenLastCalledWith(false);
    TestIntersectionObserver.instances[0].emit(true);
    expect(scene?.setRunning).toHaveBeenLastCalledWith(true);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(scene?.setRunning).toHaveBeenLastCalledWith(false);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(scene?.setRunning).toHaveBeenLastCalledWith(true);
    expect(runtime.create).toHaveBeenCalledTimes(1);
  });

  test("disposes observers and the runtime on unmount, including an import that resolves after unmount", async () => {
    await render();
    makeIntersecting();
    await act(async () => root?.unmount());
    root = null;
    await flush();
    expect(runtime.create).not.toHaveBeenCalled();
    expect(TestIntersectionObserver.instances[0].disconnect).toHaveBeenCalledTimes(1);
    expect(TestResizeObserver.instances[0].disconnect).toHaveBeenCalledTimes(1);

    await render();
    makeIntersecting();
    await flush();
    const scene = latestRuntime();
    await act(async () => root?.unmount());
    root = null;
    expect(scene?.dispose).toHaveBeenCalledTimes(1);
    expect(TestIntersectionObserver.instances.at(-1)?.disconnect).toHaveBeenCalledTimes(1);
    expect(TestResizeObserver.instances.at(-1)?.disconnect).toHaveBeenCalledTimes(1);
  });

  test("falls back safely after canvas context loss without affecting the readable host", async () => {
    await render();
    makeIntersecting();
    await flush();
    const onContextLoss = runtime.create.mock.calls[0][2] as () => void;
    await act(async () => { onContextLoss(); });
    expect(container?.querySelector('[data-testid="generated-media-ambient-fallback"]')).not.toBeNull();
    expect(latestRuntime()?.dispose).toHaveBeenCalledTimes(1);
    expect(container?.querySelector('[data-testid="generated-media-ambient"]')?.getAttribute("aria-hidden")).toBe("true");
  });
});
