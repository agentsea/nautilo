import type { WebContents } from "electron";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";

export interface BrowserControlCdpShimOptions {
  webContents: WebContents;
}

export interface BrowserControlCdpShimHandle {
  readonly url: string;
  close(): void;
}

interface CdpCommand {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

type TargetBoundInputResult =
  | { handled: false }
  | { handled: true; result: Record<string, never> };

function keyboardModifiers(
  params: Record<string, unknown>,
): NonNullable<Electron.InputEvent["modifiers"]> {
  const cdpModifiers = typeof params["modifiers"] === "number" ? params["modifiers"] : 0;
  const modifiers: NonNullable<Electron.InputEvent["modifiers"]> = [];
  if (cdpModifiers & 1) modifiers.push("alt");
  if (cdpModifiers & 2) modifiers.push("control");
  if (cdpModifiers & 4) modifiers.push("meta");
  if (cdpModifiers & 8) modifiers.push("shift");
  if (params["autoRepeat"] === true) modifiers.push("isautorepeat");
  if (params["isKeypad"] === true) modifiers.push("iskeypad");
  return modifiers;
}

function keyboardInputEvent(params: Record<string, unknown>): Electron.KeyboardInputEvent | null {
  const type = params["type"];
  if (type !== "rawKeyDown" && type !== "keyDown" && type !== "keyUp" && type !== "char") {
    return null;
  }
  const keyCode =
    typeof params["key"] === "string" && params["key"].length > 0
      ? params["key"]
      : typeof params["code"] === "string" && params["code"].length > 0
        ? params["code"]
        : null;
  if (!keyCode) return null;
  return { type, keyCode, modifiers: keyboardModifiers(params) };
}

function mouseInputEvent(
  params: Record<string, unknown>,
): Electron.MouseInputEvent | Electron.MouseWheelInputEvent | null {
  const cdpType = params["type"];
  const type = cdpType === "mouseMoved"
    ? "mouseMove"
    : cdpType === "mousePressed"
      ? "mouseDown"
      : cdpType === "mouseReleased"
        ? "mouseUp"
        : cdpType === "mouseWheel"
          ? "mouseWheel"
          : null;
  const x = params["x"];
  const y = params["y"];
  if (type === null || typeof x !== "number" || !Number.isFinite(x) ||
    typeof y !== "number" || !Number.isFinite(y)) return null;

  const button = params["button"];
  const base: Electron.MouseInputEvent = {
    type,
    x: Math.round(x),
    y: Math.round(y),
    modifiers: keyboardModifiers(params),
    ...(button === "left" || button === "middle" || button === "right" ? { button } : {}),
    ...(typeof params["clickCount"] === "number" && Number.isFinite(params["clickCount"])
      ? { clickCount: Math.max(0, Math.round(params["clickCount"])) }
      : {}),
  };
  if (type !== "mouseWheel") return base;
  return {
    ...base,
    type,
    ...(typeof params["deltaX"] === "number" && Number.isFinite(params["deltaX"])
      ? { deltaX: params["deltaX"] }
      : {}),
    ...(typeof params["deltaY"] === "number" && Number.isFinite(params["deltaY"])
      ? { deltaY: params["deltaY"] }
      : {}),
  };
}

/**
 * CDP Input commands are global to Electron's focused native renderer even
 * when issued through a guest debugger. Route agent-browser's text, key, and
 * pointer operations through the adopted guest WebContents instead, so they
 * cannot reach the Workbench chat composer and hidden research targets remain
 * independently actionable.
 */
async function handleTargetBoundInput(
  webContents: WebContents,
  command: CdpCommand,
): Promise<TargetBoundInputResult> {
  const params = command.params ?? {};
  if (command.method === "Input.insertText" && typeof params["text"] === "string") {
    await webContents.insertText(params["text"]);
    return { handled: true, result: {} };
  }
  if (command.method === "Input.dispatchKeyEvent") {
    const event = keyboardInputEvent(params);
    if (event) {
      webContents.sendInputEvent(event);
      return { handled: true, result: {} };
    }
  }
  if (command.method === "Input.dispatchMouseEvent") {
    const event = mouseInputEvent(params);
    if (event) {
      webContents.sendInputEvent(event);
      return { handled: true, result: {} };
    }
  }
  return { handled: false };
}

function rawDataToUtf8(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.concat(data).toString("utf8");
}

export async function startBrowserControlCdpShim(
  options: BrowserControlCdpShimOptions,
): Promise<BrowserControlCdpShimHandle> {
  const { webContents } = options;
  if (!webContents.debugger.isAttached()) {
    webContents.debugger.attach("1.3");
  }

  const token = randomBytes(18).toString("base64url");
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    path: `/${token}`,
  });
  const clients = new Set<WebSocket>();

  const onDebuggerMessage = (
    _event: Electron.Event,
    method: string,
    params?: unknown,
    sessionId?: string,
  ) => {
    const payload: Record<string, unknown> = { method, params: params ?? {} };
    if (sessionId) payload["sessionId"] = sessionId;
    const encoded = JSON.stringify(payload);
    for (const client of clients) {
      try {
        client.send(encoded);
      } catch {
        clients.delete(client);
      }
    }
  };
  webContents.debugger.on("message", onDebuggerMessage);

  server.on("connection", (socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    socket.on("message", (data) => {
      void handleCommand(webContents, socket, data);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const address = server.address() as AddressInfo;
  const url = `ws://127.0.0.1:${address.port}/${token}`;
  return {
    url,
    close() {
      // Always tear down our own resources first — these are independent of the
      // guest webContents lifecycle.
      for (const client of clients) client.close();
      clients.clear();
      server.close();

      // The guest webContents may already be destroyed (a full-page guest swap
      // fires `destroyed` → BrowserControlManager.release() → close()). Touching
      // `.debugger` on a destroyed webContents — including `isAttached()` — throws
      // "Object has been destroyed", which previously escaped the `detach()`
      // try/catch as an unhandled main-process exception and killed the
      // browserControl IPC handler mid-flow. Electron tears the debugger down
      // with the contents, so there is nothing to detach in that case.
      const isDestroyed =
        typeof webContents.isDestroyed === "function" && webContents.isDestroyed();
      if (isDestroyed) return;

      // Even when not yet destroyed, the contents can race to destroyed between
      // this check and the calls below, so guard the whole debugger interaction.
      try {
        webContents.debugger.off("message", onDebuggerMessage);
        if (webContents.debugger.isAttached()) {
          webContents.debugger.detach();
        }
      } catch {
        // Best effort during app teardown.
      }
    },
  };
}

async function handleCommand(
  webContents: WebContents,
  socket: WebSocket,
  data: RawData,
): Promise<void> {
  let command: CdpCommand;
  try {
    command = JSON.parse(rawDataToUtf8(data)) as CdpCommand;
  } catch {
    return;
  }

  if (typeof command.id !== "number" || typeof command.method !== "string") {
    if (typeof command.id === "number") {
      socket.send(JSON.stringify({
        id: command.id,
        error: { code: -32600, message: "Invalid CDP command envelope" },
      }));
    }
    return;
  }

  try {
    const targetBound = await handleTargetBoundInput(webContents, command);
    if (targetBound.handled) {
      socket.send(JSON.stringify({ id: command.id, result: targetBound.result }));
      return;
    }
    const result = await webContents.debugger.sendCommand(
      command.method,
      command.params ?? {},
      command.sessionId,
    ) as unknown;
    socket.send(JSON.stringify({ id: command.id, result: result ?? {} }));
  } catch (error) {
    socket.send(JSON.stringify({
      id: command.id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      },
    }));
  }
}
