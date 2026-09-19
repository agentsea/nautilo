import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import WebSocket, { type RawData } from "ws";
import type { WebContents } from "electron";
import { startBrowserControlCdpShim as startShim } from "../../electron/browser-control-cdp-shim";

const startBrowserControlCdpShim: typeof startShim = (options) => {
  for (const contents of [options.webContents, options.webContents.hostWebContents]) {
    if (!contents) continue;
    contents.getBackgroundThrottling ??= () => true;
    contents.setBackgroundThrottling ??= () => {};
    contents.isDestroyed ??= () => false;
    contents.capturePage ??= async () => ({ isEmpty: () => false });
  }
  return startShim(options);
};

class FakeDebugger extends EventEmitter {
  attached = false;
  detached = false;
  commands: Array<{ method: string; params: unknown; sessionId?: string }> = [];
  order: string[] | undefined;

  isAttached(): boolean {
    return this.attached;
  }

  attach(): void {
    this.attached = true;
  }

  detach(): void {
    this.detached = true;
    this.attached = false;
  }

  async sendCommand(
    method: string,
    params?: unknown,
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    this.order?.push(`debug:${method}`);
    this.commands.push({ method, params, sessionId });
    if (
      method === "Boom.fail" ||
      (method === "Input.dispatchMouseEvent" &&
        (params as Record<string, unknown> | undefined)?.["fail"] === true)
    ) throw new Error("boom");
    return { ok: true, method };
  }
}

function wsOpen(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function rawDataToUtf8(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.concat(data).toString("utf8");
}

function wsNextJson(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once("message", (data) => {
      resolve(JSON.parse(rawDataToUtf8(data)) as Record<string, unknown>);
    });
  });
}

function wsJsonBuffer(ws: WebSocket): () => Promise<Record<string, unknown>> {
  const queue: Array<Record<string, unknown>> = [];
  let resolveNext: ((value: Record<string, unknown>) => void) | null = null;
  ws.on("message", (data) => {
    const parsed = JSON.parse(rawDataToUtf8(data)) as Record<string, unknown>;
    if (resolveNext) {
      const resolve = resolveNext;
      resolveNext = null;
      resolve(parsed);
    } else {
      queue.push(parsed);
    }
  });
  return () => {
    const next = queue.shift();
    if (next) return Promise.resolve(next);
    return new Promise((resolve) => {
      resolveNext = resolve;
    });
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("browser-control CDP shim", () => {
  test("keeps guest and shared host rendering until their last controller closes", async () => {
    const settings: string[] = [];
    const host = {
      getBackgroundThrottling: () => true,
      setBackgroundThrottling: (value: boolean) => { settings.push(`host:${value}`); },
    };
    const guest = (name: string, throttled: boolean) => ({
      debugger: new FakeDebugger(), hostWebContents: host,
      getBackgroundThrottling: () => throttled,
      setBackgroundThrottling: (value: boolean) => { settings.push(`${name}:${value}`); },
    } as unknown as WebContents);
    const shimA = await startBrowserControlCdpShim({ webContents: guest("A", true) });
    const shimB = await startBrowserControlCdpShim({ webContents: guest("B", false) });
    expect(settings).toEqual(["A:false", "host:false", "B:false"]);
    shimA.close();
    shimA.close();
    expect(settings).toEqual(["A:false", "host:false", "B:false", "A:true"]);
    shimB.close();
    expect(settings).toEqual(["A:false", "host:false", "B:false", "A:true", "B:false", "host:true"]);
  });

  test("captures viewport PNGs without CDP capture or native-window focus", async () => {
    const debug = new FakeDebugger();
    const captures: unknown[] = [];
    const order: string[] = [];
    let fail: "empty" | "error" | null = null;
    const shim = await startBrowserControlCdpShim({ webContents: {
      debugger: debug,
      focus: () => { throw new Error("capture must not focus"); },
      hostWebContents: {
        capturePage: async () => {
          order.push("host frame");
          return { toPNG: () => { throw new Error("host image must not be encoded"); } };
        },
      },
      capturePage: async (...args: unknown[]) => {
        order.push("guest frame");
        captures.push(args);
        if (fail === "error") throw new Error("capture unavailable");
        return { isEmpty: () => fail === "empty", toPNG: () => Buffer.from("png bytes") };
      },
    } as unknown as WebContents });
    const ws = await wsOpen(shim.url);
    const next = wsJsonBuffer(ws);
    try {
      ws.send(JSON.stringify({ id: 1, method: "Page.captureScreenshot", params: { format: "png", fromSurface: true } }));
      expect(await next()).toEqual({ id: 1, result: { data: Buffer.from("png bytes").toString("base64") } });
      expect(captures).toEqual([[undefined, { stayHidden: false }]]);
      expect(order).toEqual(["host frame", "guest frame"]);
      expect(debug.commands).toEqual([]);
      for (const [id, params, sessionId] of [
        [2, { format: "jpeg", quality: 80 }, undefined],
        [3, { clip: { x: 0, y: 0, width: 20, height: 30, scale: 1 } }, undefined],
        [4, { fromSurface: false }, undefined],
        [5, { format: "png" }, "child-session"],
        [8, { format: "png", fromSurface: true, captureBeyondViewport: true }, undefined],
        [9, { format: "png", fromSurface: true, futureOption: true }, undefined],
      ] as const) {
        ws.send(JSON.stringify({ id, method: "Page.captureScreenshot", params, sessionId }));
        expect(await next()).toMatchObject({ id, result: { method: "Page.captureScreenshot" } });
        expect(debug.commands.at(-1)).toEqual({ method: "Page.captureScreenshot", params, sessionId });
      }
      fail = "empty";
      ws.send(JSON.stringify({ id: 6, method: "Page.captureScreenshot" }));
      expect(await next()).toMatchObject({ id: 6, error: { message: "Browser screenshot is unavailable: the browser surface returned an empty frame" } });
      fail = "error";
      ws.send(JSON.stringify({ id: 7, method: "Page.captureScreenshot" }));
      expect(await next()).toMatchObject({ id: 7, error: { message: "capture unavailable" } });
      expect(debug.commands).toHaveLength(6);
    } finally {
      ws.close();
      shim.close();
    }
  });

  test("does not start guest capture when the caller closes during host capture", async () => {
    const hostCapture = deferred<{ toPNG(): Buffer }>();
    const hostCaptureStarted = deferred<void>();
    let guestCaptures = 0;
    let guestEncodes = 0;
    const debug = new FakeDebugger();
    const shim = await startBrowserControlCdpShim({ webContents: {
      debugger: debug,
      hostWebContents: { capturePage: () => {
        hostCaptureStarted.resolve();
        return hostCapture.promise;
      } },
      capturePage: async () => {
        guestCaptures += 1;
        return { isEmpty: () => false, toPNG: () => {
          guestEncodes += 1;
          return Buffer.from("late guest");
        } };
      },
    } as unknown as WebContents });
    const ws = await wsOpen(shim.url);
    ws.send(JSON.stringify({ id: 1, method: "Page.captureScreenshot" }));
    await hostCaptureStarted.promise;
    ws.close();
    await new Promise<void>((resolve) => ws.once("close", () => resolve()));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    hostCapture.resolve({ toPNG: () => Buffer.from("late host") });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(guestCaptures).toBe(0);
    expect(guestEncodes).toBe(0);
    expect(debug.commands).toEqual([]);
    shim.close();
  });

  test("absorbs late guest capture settlement after the caller closes", async () => {
    const guestCapture = deferred<{ isEmpty(): boolean; toPNG(): Buffer }>();
    const guestCaptureStarted = deferred<void>();
    let inspected = 0;
    let encoded = 0;
    const debug = new FakeDebugger();
    const shim = await startBrowserControlCdpShim({ webContents: {
      debugger: debug,
      capturePage: () => {
        guestCaptureStarted.resolve();
        return guestCapture.promise;
      },
    } as unknown as WebContents });
    const ws = await wsOpen(shim.url);
    try {
      ws.send(JSON.stringify({ id: 1, method: "Page.captureScreenshot" }));
      await guestCaptureStarted.promise;
      ws.close();
      await new Promise<void>((resolve) => ws.once("close", () => resolve()));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      guestCapture.resolve({
        isEmpty: () => { inspected += 1; return false; },
        toPNG: () => { encoded += 1; return Buffer.from("late guest"); },
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(inspected).toBe(0);
      expect(encoded).toBe(0);
      expect(debug.commands).toEqual([]);
    } finally {
      shim.close();
    }
  });

  test("restores rendering and its debugger when retaining a host fails", async () => {
    for (const alreadyAttached of [false, true]) {
      const debug = new FakeDebugger();
      debug.attached = alreadyAttached;
      const settings: boolean[] = [];
      const result = await startBrowserControlCdpShim({ webContents: {
        debugger: debug,
        getBackgroundThrottling: () => true,
        setBackgroundThrottling: (value: boolean) => { settings.push(value); },
        hostWebContents: {
          getBackgroundThrottling: () => true,
          setBackgroundThrottling: () => { throw new Error("host retired"); },
        },
      } as unknown as WebContents }).then(() => null, (error: unknown) => error);
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe("host retired");
      expect(settings).toEqual([false, true]);
      expect(debug.detached).toBe(!alreadyAttached);
      expect(debug.listenerCount("message")).toBe(0);
    }
  });

  test("forwards CDP commands to webContents.debugger and replies by id", async () => {
    const debug = new FakeDebugger();
    const shim = await startBrowserControlCdpShim({
      webContents: { debugger: debug } as unknown as WebContents,
    });
    const ws = await wsOpen(shim.url);

    ws.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));
    expect(await wsNextJson(ws)).toEqual({
      id: 1,
      result: { ok: true, method: "Runtime.enable" },
    });
    expect(debug.commands).toEqual([
      { method: "Runtime.enable", params: {}, sessionId: undefined },
    ]);

    ws.close();
    shim.close();
  });

  test("keeps text target-bound while forwarding key and mouse CDP commands unchanged", async () => {
    const debug = new FakeDebugger();
    const insertedText: string[] = [];
    const callOrder: string[] = [];
    debug.order = callOrder;
    let nativeInputCalls = 0;
    const shim = await startBrowserControlCdpShim({
      webContents: {
        debugger: debug,
        insertText: async (text: string) => {
          insertedText.push(text);
          callOrder.push(`insertText:${text}`);
        },
        focus: () => { callOrder.push("focus"); },
        sendInputEvent: () => { nativeInputCalls += 1; },
      } as unknown as WebContents,
    });
    const ws = await wsOpen(shim.url);
    const nextMessage = wsJsonBuffer(ws);

    ws.send(JSON.stringify({ id: 3, method: "Input.insertText", params: { text: "search" } }));
    expect(await nextMessage()).toEqual({
      id: 3,
      result: {},
    });
    ws.send(JSON.stringify({
      id: 4,
      method: "Input.dispatchKeyEvent",
      params: { type: "rawKeyDown", key: "Enter", modifiers: 10, autoRepeat: true },
      sessionId: "guest-key-session",
    }));
    expect(await nextMessage()).toEqual({
      id: 4,
      result: { ok: true, method: "Input.dispatchKeyEvent" },
    });
    ws.send(JSON.stringify({
      id: 5,
      method: "Input.dispatchMouseEvent",
      params: { type: "mousePressed", x: 320.4, y: 240.6, button: "left", clickCount: 1 },
      sessionId: "guest-mouse-session",
    }));
    expect(await nextMessage()).toEqual({
      id: 5,
      result: { ok: true, method: "Input.dispatchMouseEvent" },
    });
    ws.send(JSON.stringify({
      id: 6,
      method: "Input.dispatchMouseEvent",
      params: { type: "mouseReleased", x: 320.4, y: 240.6, button: "left", fail: true },
      sessionId: "guest-error-session",
    }));
    expect(await nextMessage()).toMatchObject({
      id: 6,
      error: { code: -32000, message: "boom" },
    });
    expect(insertedText).toEqual(["search"]);
    expect(nativeInputCalls).toBe(0);
    expect(callOrder).toEqual([
      "insertText:search",
      "focus",
      "debug:Input.dispatchKeyEvent",
      "focus",
      "debug:Input.dispatchMouseEvent",
      "focus",
      "debug:Input.dispatchMouseEvent",
    ]);
    expect(debug.commands).toEqual([
      {
        method: "Input.dispatchKeyEvent",
        params: { type: "rawKeyDown", key: "Enter", modifiers: 10, autoRepeat: true },
        sessionId: "guest-key-session",
      },
      {
        method: "Input.dispatchMouseEvent",
        params: { type: "mousePressed", x: 320.4, y: 240.6, button: "left", clickCount: 1 },
        sessionId: "guest-mouse-session",
      },
      {
        method: "Input.dispatchMouseEvent",
        params: { type: "mouseReleased", x: 320.4, y: 240.6, button: "left", fail: true },
        sessionId: "guest-error-session",
      },
    ]);

    ws.close();
    shim.close();
  });

  test("focuses the matching host webview before forwarding guest CDP input", async () => {
    const debug = new FakeDebugger();
    const callOrder: string[] = [];
    const insertedText: string[] = [];
    const hostScripts: string[] = [];
    debug.order = callOrder;
    let guestFocusCalls = 0;
    const shim = await startBrowserControlCdpShim({
      webContents: {
        id: 74,
        debugger: debug,
        insertText: async (text: string) => {
          insertedText.push(text);
          callOrder.push(`insertText:${text}`);
        },
        focus: () => { guestFocusCalls += 1; },
        hostWebContents: {
          executeJavaScript: async (script: string) => {
            hostScripts.push(script);
            callOrder.push("host-focus");
            return true;
          },
        },
      } as unknown as WebContents,
    });
    const ws = await wsOpen(shim.url);
    const nextMessage = wsJsonBuffer(ws);

    ws.send(JSON.stringify({ id: 11, method: "Input.insertText", params: { text: "search" } }));
    expect(await nextMessage()).toEqual({ id: 11, result: {} });
    ws.send(JSON.stringify({
      id: 12,
      method: "Input.dispatchKeyEvent",
      params: { type: "rawKeyDown", key: "Enter" },
      sessionId: "guest-session",
    }));
    expect(await nextMessage()).toEqual({
      id: 12,
      result: { ok: true, method: "Input.dispatchKeyEvent" },
    });

    expect(hostScripts).toEqual([`(() => {
        for (const view of document.querySelectorAll('webview')) {
          if (view.getWebContentsId() === 74) {
            view.focus();
            return document.activeElement === view;
          }
        }
        return false;
      })()`]);
    expect(callOrder).toEqual([
      "insertText:search",
      "host-focus",
      "debug:Input.dispatchKeyEvent",
    ]);
    expect(insertedText).toEqual(["search"]);
    expect(guestFocusCalls).toBe(0);
    expect(debug.commands).toEqual([{
      method: "Input.dispatchKeyEvent",
      params: { type: "rawKeyDown", key: "Enter" },
      sessionId: "guest-session",
    }]);

    ws.close();
    shim.close();
  });

  test("primes an embedded surface before effect-bearing input without encoding images", async () => {
    const debug = new FakeDebugger();
    const order: string[] = [];
    debug.order = order;
    const shim = await startBrowserControlCdpShim({
      webContents: {
        id: 76,
        debugger: debug,
        capturePage: async () => {
          order.push("guest-frame");
          return { toPNG: () => { throw new Error("input primer must not encode"); } };
        },
        hostWebContents: {
          capturePage: async () => {
            order.push("host-frame");
            return { toPNG: () => { throw new Error("input primer must not encode"); } };
          },
          executeJavaScript: async () => {
            order.push("host-focus");
            return true;
          },
        },
      } as unknown as WebContents,
    });
    const ws = await wsOpen(shim.url);
    try {
      ws.send(JSON.stringify({
        id: 1,
        method: "Input.dispatchMouseEvent",
        params: { type: "mousePressed", x: 4, y: 5, button: "left" },
      }));
      expect(await wsNextJson(ws)).toMatchObject({ id: 1, result: { ok: true } });
      expect(order).toEqual([
        "host-frame", "guest-frame", "host-focus", "debug:Input.dispatchMouseEvent",
      ]);
    } finally {
      ws.close();
      shim.close();
    }
  });

  test("does not prime an embedded surface for observations or mouse movement", async () => {
    const debug = new FakeDebugger();
    let captures = 0;
    const shim = await startBrowserControlCdpShim({
      webContents: {
        id: 77,
        debugger: debug,
        capturePage: async () => { captures += 1; return {}; },
        hostWebContents: {
          capturePage: async () => { captures += 1; return {}; },
          executeJavaScript: async () => true,
        },
      } as unknown as WebContents,
    });
    const ws = await wsOpen(shim.url);
    const next = wsJsonBuffer(ws);
    try {
      ws.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));
      expect(await next()).toMatchObject({ id: 1, result: { ok: true } });
      ws.send(JSON.stringify({
        id: 2,
        method: "Input.dispatchMouseEvent",
        params: { type: "mouseMoved", x: 4, y: 5 },
      }));
      expect(await next()).toMatchObject({ id: 2, result: { ok: true } });
      expect(captures).toBe(0);
    } finally {
      ws.close();
      shim.close();
    }
  });

  test("does not capture the guest or dispatch input after the caller retires during host priming", async () => {
    const debug = new FakeDebugger();
    const hostCapture = deferred<Record<string, never>>();
    const hostStarted = deferred<void>();
    let guestCaptures = 0;
    const shim = await startBrowserControlCdpShim({
      webContents: {
        id: 78,
        debugger: debug,
        capturePage: async () => { guestCaptures += 1; return {}; },
        hostWebContents: {
          capturePage: () => {
            hostStarted.resolve();
            return hostCapture.promise;
          },
          executeJavaScript: async () => true,
        },
      } as unknown as WebContents,
    });
    const ws = await wsOpen(shim.url);
    try {
      ws.send(JSON.stringify({
        id: 1,
        method: "Input.dispatchKeyEvent",
        params: { type: "rawKeyDown", key: "Enter" },
      }));
      await hostStarted.promise;
      ws.close();
      await new Promise<void>((resolve) => ws.once("close", () => resolve()));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      hostCapture.resolve({});
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(guestCaptures).toBe(0);
      expect(debug.commands).toEqual([]);
    } finally {
      shim.close();
    }
  });

  test("rejects guest input before CDP forwarding when host webview focus fails", async () => {
    for (const result of [false, new Error("host focus rejected")]) {
      const debug = new FakeDebugger();
      let guestFocusCalls = 0;
      const shim = await startBrowserControlCdpShim({
        webContents: {
          id: 75,
          debugger: debug,
          focus: () => { guestFocusCalls += 1; },
          hostWebContents: {
            executeJavaScript: async () => {
              if (result instanceof Error) throw result;
              return result;
            },
          },
        } as unknown as WebContents,
      });
      const ws = await wsOpen(shim.url);

      ws.send(JSON.stringify({
        id: 13,
        method: "Input.dispatchMouseEvent",
        params: { type: "mousePressed", x: 1, y: 2, button: "left" },
      }));
      const response = await wsNextJson(ws);
      expect(response).toMatchObject({ id: 13, error: { code: -32000 } });
      expect((response["error"] as { message: string }).message).toContain(
        result instanceof Error ? result.message : "Browser input target is no longer attached",
      );
      expect(debug.commands).toEqual([]);
      expect(guestFocusCalls).toBe(0);

      ws.close();
      shim.close();
    }
  });

  test("serializes focus and input across shims without blocking observations", async () => {
    const order: string[] = [];
    let releaseFocus!: () => void;
    const focusReleased = new Promise<void>((resolve) => { releaseFocus = resolve; });
    let markFocusStarted!: () => void;
    const focusStarted = new Promise<void>((resolve) => { markFocusStarted = resolve; });
    const debugA = new FakeDebugger();
    const debugB = new FakeDebugger();
    debugA.order = order;
    debugB.order = order;
    const shimA = await startBrowserControlCdpShim({
      webContents: {
        id: 80, debugger: debugA,
        hostWebContents: { executeJavaScript: async () => {
          order.push("focus:A");
          markFocusStarted();
          await focusReleased;
          return true;
        } },
      } as unknown as WebContents,
    });
    const shimB = await startBrowserControlCdpShim({
      webContents: {
        id: 81, debugger: debugB,
        hostWebContents: { executeJavaScript: async () => {
          order.push("focus:B");
          return true;
        } },
      } as unknown as WebContents,
    });
    const wsA = await wsOpen(shimA.url);
    const wsB = await wsOpen(shimB.url);
    const nextA = wsJsonBuffer(wsA);
    const nextB = wsJsonBuffer(wsB);
    try {
      wsA.send(JSON.stringify({ id: 1, method: "Input.dispatchKeyEvent", params: { type: "rawKeyDown", key: "Enter" } }));
      await focusStarted;
      wsB.send(JSON.stringify({ id: 2, method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 10, y: 20 } }));
      wsB.send(JSON.stringify({ id: 3, method: "Runtime.enable" }));
      expect(await nextB()).toMatchObject({ id: 3, result: { ok: true } });
      expect(order).toEqual(["focus:A", "debug:Runtime.enable"]);
      releaseFocus();
      expect(await nextA()).toMatchObject({ id: 1, result: { ok: true } });
      expect(await nextB()).toMatchObject({ id: 2, result: { ok: true } });
      expect(order).toEqual([
        "focus:A", "debug:Runtime.enable", "debug:Input.dispatchKeyEvent",
        "focus:B", "debug:Input.dispatchMouseEvent",
      ]);
    } finally {
      releaseFocus();
      wsA.close();
      wsB.close();
      shimA.close();
      shimB.close();
    }
  });

  test("does not dispatch queued input after its target shim is retired", async () => {
    let releaseFocus!: () => void;
    const focusReleased = new Promise<void>((resolve) => { releaseFocus = resolve; });
    let markFocusStarted!: () => void;
    const focusStarted = new Promise<void>((resolve) => { markFocusStarted = resolve; });
    const debugA = new FakeDebugger();
    const debugB = new FakeDebugger();
    let bFocused = false;
    const shimA = await startBrowserControlCdpShim({
      webContents: { debugger: debugA, hostWebContents: { executeJavaScript: async () => {
        markFocusStarted(); await focusReleased; return true;
      } } } as unknown as WebContents,
    });
    const shimB = await startBrowserControlCdpShim({
      webContents: { debugger: debugB, focus: () => { bFocused = true; } } as unknown as WebContents,
    });
    const wsA = await wsOpen(shimA.url);
    const wsB = await wsOpen(shimB.url);
    const nextA = wsJsonBuffer(wsA);
    const nextB = wsJsonBuffer(wsB);
    try {
      wsA.send(JSON.stringify({ id: 1, method: "Input.dispatchKeyEvent", params: { type: "rawKeyDown", key: "Enter" } }));
      await focusStarted;
      wsB.send(JSON.stringify({ id: 2, method: "Input.dispatchMouseEvent" }));
      wsB.send(JSON.stringify({ id: 3, method: "Runtime.enable" }));
      expect(await nextB()).toMatchObject({ id: 3 });
      shimB.close();
      releaseFocus();
      expect(await nextA()).toMatchObject({ id: 1 });
      // A later input on A also proves the queued B command has been drained.
      wsA.send(JSON.stringify({ id: 4, method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: "Enter" } }));
      expect(await nextA()).toMatchObject({ id: 4 });
      expect(bFocused).toBe(false);
      expect(debugB.commands).toEqual([{ method: "Runtime.enable", params: {}, sessionId: undefined }]);
    } finally {
      releaseFocus();
      wsA.close();
      wsB.close();
      shimA.close();
    }
  });

  test("forwards errors and debugger events", async () => {
    const debug = new FakeDebugger();
    const shim = await startBrowserControlCdpShim({
      webContents: { debugger: debug } as unknown as WebContents,
    });
    const ws = await wsOpen(shim.url);
    const nextMessage = wsJsonBuffer(ws);

    ws.send(JSON.stringify({ id: 2, method: "Boom.fail" }));
    const error = await nextMessage();
    expect(error["id"]).toBe(2);
    expect((error["error"] as { message: string }).message).toContain("boom");

    setTimeout(() => {
      debug.emit("message", {}, "Runtime.consoleAPICalled", { type: "log" });
    }, 0);
    expect(await nextMessage()).toEqual({
      method: "Runtime.consoleAPICalled",
      params: { type: "log" },
    });

    ws.close();
    shim.close();
  });

  test("close detaches the debugger", async () => {
    const debug = new FakeDebugger();
    const shim = await startBrowserControlCdpShim({
      webContents: { debugger: debug } as unknown as WebContents,
    });
    expect(debug.attached).toBe(true);
    shim.close();
    expect(debug.detached).toBe(true);
  });

  // Regression: a destroyed guest webContents (guest swap → 'destroyed' →
  // release → close) used to crash the main process because isAttached
  // throws "Object has been destroyed". close must be a no-op on the
  // debugger in that case and never throw.
  test("close is a no-op on a destroyed webContents and does not throw", async () => {
    const debug = new FakeDebugger();
    let destroyed = false;
    const shim = await startBrowserControlCdpShim({
      webContents: {
        debugger: debug,
        isDestroyed: () => destroyed,
      } as unknown as WebContents,
    });
    expect(debug.attached).toBe(true);

    // Simulate the guest being destroyed before teardown; real Electron throws
    // from isAttached, so prove we never reach it.
    destroyed = true;
    debug.isAttached = () => {
      throw new Error("Object has been destroyed");
    };

    expect(() => shim.close()).not.toThrow();
    expect(debug.detached).toBe(false);
  });

  // Regression: the contents can race to destroyed between the isDestroyed
  // check and the debugger calls. close must swallow that throw too.
  test("close swallows a mid-teardown destroy race", async () => {
    const debug = new FakeDebugger();
    const shim = await startBrowserControlCdpShim({
      webContents: {
        debugger: debug,
        isDestroyed: () => false,
      } as unknown as WebContents,
    });

    debug.isAttached = () => {
      throw new Error("Object has been destroyed");
    };

    expect(() => shim.close()).not.toThrow();
  });
});
