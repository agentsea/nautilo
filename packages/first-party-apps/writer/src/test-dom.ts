/**
 * Minimal happy-dom bootstrap + canvas shims for Writer editor tests.
 */
import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost/" });

export function installWriterTestDom(): void {
  win.document.body.replaceChildren();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).window = win;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).document = win.document;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).DOMParser = win.DOMParser;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).URL = win.URL;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).Blob = win.Blob;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).navigator = win.navigator;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).HTMLElement = win.HTMLElement;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).Node = win.Node;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).MutationObserver = win.MutationObserver;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = win.ResizeObserver;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).MouseEvent = win.MouseEvent;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).KeyboardEvent = win.KeyboardEvent;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 0) as unknown as number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);

  installCanvasMock();
}

function installCanvasMock(): void {
  const ctx = {
    canvas: null as unknown as HTMLCanvasElement,
    fillStyle: "",
    strokeStyle: "",
    font: "12px sans-serif",
    textBaseline: "alphabetic",
    lineWidth: 1,
    globalAlpha: 1,
    save: () => {},
    restore: () => {},
    scale: () => {},
    translate: () => {},
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    fill: () => {},
    fillRect: () => {},
    strokeRect: () => {},
    clearRect: () => {},
    setLineDash: () => {},
    measureText: (text: string) => ({
      width: Math.max(1, text.length * 7),
      actualBoundingBoxAscent: 10,
      actualBoundingBoxDescent: 2,
    }),
    fillText: () => {},
    drawImage: () => {},
  };

  const canvasProto = win.HTMLCanvasElement.prototype as unknown as {
    getContext: (type: string) => unknown;
  };
  canvasProto.getContext = function getContext(type: string) {
    if (type !== "2d") return null;
    ctx.canvas = this as unknown as HTMLCanvasElement;
    return ctx;
  };
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
