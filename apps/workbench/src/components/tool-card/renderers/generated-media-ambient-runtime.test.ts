import "../../../../tests/bun-dom-preload";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createGeneratedMediaAmbientRuntime } from "./generated-media-ambient-runtime";

type MockContext = CanvasRenderingContext2D & { calls: Map<string, unknown[][]> };
let contexts: MockContext[] = [], provideContext = true, frameId = 0;
const pendingFrames = new Map<number, FrameRequestCallback>();
const cancelledFrames: number[] = [];
const calls = (context: MockContext, method: string) => context.calls.get(method) ?? [];

function makeContext(): MockContext {
  const recorded = new Map<string, unknown[][]>();
  const record = (name: string, args: unknown[]) => recorded.set(name, [...(recorded.get(name) ?? []), args]);
  const gradient = { addColorStop: mock((...args: unknown[]) => record("addColorStop", args)) };
  const methods = new Set(["arc", "beginPath", "clearRect", "clip", "fill", "fillRect", "lineTo", "moveTo", "restore", "rotate", "roundRect", "save", "scale", "setTransform", "stroke", "translate"]);
  return new Proxy({ calls: recorded } as unknown as MockContext, {
    get(target, property) {
      if (property === "createRadialGradient") return (...args: unknown[]) => { record("createRadialGradient", args); return gradient; };
      if (typeof property === "string" && methods.has(property)) return (...args: unknown[]) => record(property, args);
      return Reflect.get(target, property);
    },
    set(target, property, value) {
      if (typeof property === "string") record(`set:${property}`, [value]);
      return Reflect.set(target, property, value);
    },
  });
}

function makeContainer(width = 640, height = 260): HTMLDivElement {
  const element = document.createElement("div");
  Object.defineProperties(element, { clientWidth: { configurable: true, get: () => width }, clientHeight: { configurable: true, get: () => height } });
  document.body.appendChild(element);
  return element;
}
function runNextFrame(now: number): void {
  const entry = pendingFrames.entries().next().value as [number, FrameRequestCallback] | undefined;
  if (!entry) throw new Error("No animation frame is pending.");
  pendingFrames.delete(entry[0]); entry[1](now);
}

beforeEach(() => {
  contexts = []; provideContext = true; frameId = 0; pendingFrames.clear(); cancelledFrames.length = 0;
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 4 });
  window.HTMLCanvasElement.prototype.getContext = function getContext(type: string) {
    if (type !== "2d" || !provideContext) return null;
    const context = makeContext(); contexts.push(context); return context;
  } as typeof window.HTMLCanvasElement.prototype.getContext;
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => { const id = ++frameId; pendingFrames.set(id, callback); return id; }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => { cancelledFrames.push(id); pendingFrames.delete(id); }) as typeof cancelAnimationFrame;
});

describe("createGeneratedMediaAmbientRuntime", () => {
  test("caps DPR, owns one RAF, pauses elapsed time, and tears down idempotently", () => {
    const host = makeContainer(200, 100);
    const runtime = createGeneratedMediaAmbientRuntime(host, "video", () => undefined);
    const canvas = host.querySelector("canvas")!, context = contexts[0]!;
    expect([canvas.width, canvas.height]).toEqual([300, 150]);
    expect(calls(context, "setTransform").at(-1)).toEqual([1.5, 0, 0, 1.5, 0, 0]);
    runtime.setRunning(true); runtime.setRunning(true);
    expect(pendingFrames.size).toBe(1);
    runNextFrame(100); runNextFrame(200); runtime.setRunning(false);
    expect(pendingFrames.size).toBe(0);
    runtime.setRunning(true);
    const before = calls(context, "lineTo").length; runNextFrame(10_000);
    const resumed = calls(context, "lineTo").slice(before, before + 20);
    runtime.setRunning(false); runtime.setRunning(true);
    const secondBefore = calls(context, "lineTo").length; runNextFrame(50_000);
    expect(calls(context, "lineTo").slice(secondBefore, secondBefore + 20)).toEqual(resumed);
    runtime.dispose(); runtime.dispose();
    expect(cancelledFrames.length).toBeGreaterThan(0);
    expect(host.contains(canvas)).toBe(false);
    expect([canvas.width, canvas.height]).toEqual([0, 0]);
    expect(pendingFrames.size).toBe(0);
    host.remove();
  });

  test("context loss stops motion, calls back once, and removes its listener on dispose", () => {
    const host = makeContainer(200, 100); let losses = 0;
    const runtime = createGeneratedMediaAmbientRuntime(host, "music", () => { losses += 1; });
    const canvas = host.querySelector("canvas")!;
    runtime.setRunning(true);
    const loss = new Event("contextlost", { cancelable: true }); canvas.dispatchEvent(loss);
    expect(loss.defaultPrevented).toBe(true); expect(losses).toBe(1); expect(pendingFrames.size).toBe(0);
    runtime.setRunning(true); expect(pendingFrames.size).toBe(0);
    runtime.dispose(); canvas.dispatchEvent(new Event("contextlost", { cancelable: true }));
    expect(losses).toBe(1); host.remove();
  });

  test("missing 2D context throws without attaching a canvas", () => {
    provideContext = false; const host = makeContainer();
    expect(() => createGeneratedMediaAmbientRuntime(host, "image", () => undefined)).toThrow("canvas context is unavailable");
    expect(host.querySelector("canvas")).toBeNull(); host.remove();
  });

  test("state, pointer, size, and CSS palette changes redraw without starting a loop", () => {
    const host = makeContainer(200, 100);
    host.style.setProperty("--generation-ambient-coral", "rgb(1, 2, 3)");
    const runtime = createGeneratedMediaAmbientRuntime(host, "image", () => undefined), context = contexts[0]!;
    const initialClears = calls(context, "clearRect").length;
    runtime.setState("downloading"); runtime.setPointer(3, -4);
    expect(calls(context, "clearRect").length).toBe(initialClears + 2);
    expect(calls(context, "translate").at(-1)).toEqual([105, 44]);
    expect(pendingFrames.size).toBe(0);
    host.style.setProperty("--generation-ambient-theme", "dark");
    host.style.setProperty("--generation-ambient-background", "rgb(9, 8, 7)");
    runtime.resize();
    expect(calls(context, "set:fillStyle").some(([value]) => value === "rgb(9, 8, 7)")).toBe(true);
    expect(calls(context, "setTransform")).toHaveLength(2);
    runtime.dispose(); host.remove();
  });
});
