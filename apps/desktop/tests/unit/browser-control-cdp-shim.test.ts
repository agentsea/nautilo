import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import WebSocket from "ws";
import type { WebContents } from "electron";
import { startBrowserControlCdpShim } from "../../electron/browser-control-cdp-shim";

class FakeDebugger extends EventEmitter {
  attached = false;
  detached = false;
  commands: Array<{ method: string; params: unknown; sessionId?: string }> = [];

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
    this.commands.push({ method, params, sessionId });
    if (method === "Boom.fail") throw new Error("boom");
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

function wsNextJson(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once("message", (data) => {
      resolve(JSON.parse(data.toString("utf8")) as Record<string, unknown>);
    });
  });
}

function wsJsonBuffer(ws: WebSocket): () => Promise<Record<string, unknown>> {
  const queue: Array<Record<string, unknown>> = [];
  let resolveNext: ((value: Record<string, unknown>) => void) | null = null;
  ws.on("message", (data) => {
    const parsed = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
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

describe("browser-control CDP shim", () => {
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

  test("routes text, keyboard, and mouse input through the adopted guest, never CDP", async () => {
    const debug = new FakeDebugger();
    const events: string[] = [];
    const shim = await startBrowserControlCdpShim({
      webContents: {
        debugger: debug,
        insertText: async (text: string) => events.push(`insertText:${text}`),
        sendInputEvent: async (event: Electron.KeyboardInputEvent | Electron.MouseInputEvent) => {
          if ("keyCode" in event) {
            events.push(`sendInputEvent:${event.type}:${event.keyCode}:${event.modifiers?.join(",")}`);
          } else {
            events.push(`sendInputEvent:${event.type}:${event.x},${event.y}:${event.button ?? "none"}:${event.clickCount ?? 0}`);
          }
        },
      } as unknown as WebContents,
    });
    const ws = await wsOpen(shim.url);
    const nextMessage = wsJsonBuffer(ws);

    // `fill` and `press` issue these commands. Forwarding either to CDP lets
    // Electron route it to the host's focused composer instead of this guest.
    ws.send(JSON.stringify({ id: 3, method: "Input.insertText", params: { text: "search" } }));
    expect(await nextMessage()).toEqual({
      id: 3,
      result: {},
    });
    ws.send(JSON.stringify({ id: 4, method: "Input.dispatchKeyEvent", params: { type: "rawKeyDown", key: "Enter", modifiers: 10 } }));
    expect(await nextMessage()).toEqual({
      id: 4,
      result: {},
    });
    ws.send(JSON.stringify({ id: 5, method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: "Enter", modifiers: 10 } }));
    expect(await nextMessage()).toEqual({
      id: 5,
      result: {},
    });
    ws.send(JSON.stringify({ id: 6, method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 320.4, y: 240.6, button: "none" } }));
    expect(await nextMessage()).toEqual({
      id: 6,
      result: {},
    });
    ws.send(JSON.stringify({ id: 7, method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 320.4, y: 240.6, button: "left", clickCount: 1 } }));
    expect(await nextMessage()).toEqual({
      id: 7,
      result: {},
    });
    ws.send(JSON.stringify({ id: 8, method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", x: 320.4, y: 240.6, button: "left", clickCount: 1 } }));
    expect(await nextMessage()).toEqual({
      id: 8,
      result: {},
    });
    expect(events).toEqual([
      "insertText:search",
      "sendInputEvent:rawKeyDown:Enter:control,shift",
      "sendInputEvent:keyUp:Enter:control,shift",
      "sendInputEvent:mouseMove:320,241:none:0",
      "sendInputEvent:mouseDown:320,241:left:1",
      "sendInputEvent:mouseUp:320,241:left:1",
    ]);
    expect(debug.commands).toEqual([]);

    ws.close();
    shim.close();
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
  // release() → close()) used to crash the main process because isAttached()
  // throws "Object has been destroyed". close() must be a no-op on the
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
    // from isAttached(), so prove we never reach it.
    destroyed = true;
    debug.isAttached = () => {
      throw new Error("Object has been destroyed");
    };

    expect(() => shim.close()).not.toThrow();
    expect(debug.detached).toBe(false);
  });

  // Regression: the contents can race to destroyed between the isDestroyed()
  // check and the debugger calls. close() must swallow that throw too.
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
