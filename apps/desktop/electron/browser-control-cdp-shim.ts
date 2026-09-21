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

// Electron's renderer focus is shared by embedded and research targets. Keep
// our focus-and-input operations ordered across every shim, not just a socket.
let inputTail: Promise<void> = Promise.resolve();

// A guest and its embedding Workbench both need frames while controlled in the
// background. Several guests can share a host; restore its setting only after
// the last controller releases it. This does not activate the native window.
const renderingOwners = new WeakMap<WebContents, { users: number; throttled: boolean }>();

function retainRendering(contents: WebContents): () => void {
  let owner = renderingOwners.get(contents);
  if (!owner) {
    owner = { users: 0, throttled: contents.getBackgroundThrottling() };
    contents.setBackgroundThrottling(false);
    renderingOwners.set(contents, owner);
  }
  owner.users += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    owner.users -= 1;
    if (owner.users !== 0) return;
    renderingOwners.delete(contents);
    if (!contents.isDestroyed()) contents.setBackgroundThrottling(owner.throttled);
  };
}

async function captureViewport(
  contents: WebContents,
  command: CdpCommand,
  socket: WebSocket,
): Promise<{ data: string } | null> {
  const params = command.params ?? {};
  if (command.method !== "Page.captureScreenshot" || command.sessionId
    || (params["format"] !== undefined && params["format"] !== "png")
    || (params["fromSurface"] !== undefined && params["fromSurface"] !== true)
    || Object.keys(params).some((key) => key !== "format" && key !== "fromSurface")) return null;
  // CDP capture can wait forever for an occluded Electron guest's compositor.
  // Electron's capture API owns the temporary capturer lifetime and requests a
  // rendered frame without showing or focusing the native window. Keep clips,
  // alternate formats and child-session requests on their original CDP path.
  // A newly mounted guest also needs its embedder's compositor frame. Request
  // that frame first; discard the host image without encoding or publishing it.
  // Otherwise a cold, occluded Workbench can leave the guest without a surface.
  const image = await captureRenderedSurface(contents, socket);
  requireOpenCaptureCaller(socket);
  if (image.isEmpty()) throw new Error("Browser screenshot is unavailable: the browser surface returned an empty frame");
  requireOpenCaptureCaller(socket);
  return { data: image.toPNG().toString("base64") };
}

async function captureRenderedSurface(contents: WebContents, socket: WebSocket) {
  if (contents.hostWebContents) {
    await whileSocketOpen(
      socket,
      () => contents.hostWebContents!.capturePage(undefined, { stayHidden: false }),
    );
  }
  requireOpenCaptureCaller(socket);
  return whileSocketOpen(
    socket,
    () => contents.capturePage(undefined, { stayHidden: false }),
  );
}

function inputNeedsRenderedSurface(command: CdpCommand): boolean {
  const type = command.params?.["type"];
  if (command.method === "Input.insertText") return true;
  if (command.method === "Input.dispatchKeyEvent") {
    return type === "keyDown" || type === "rawKeyDown" || type === "char";
  }
  if (command.method === "Input.dispatchMouseEvent") {
    return type === "mousePressed" || type === "mouseWheel";
  }
  return false;
}

/** Stop awaiting native capture work when its existing CDP caller retires. */
function requireOpenCaptureCaller(socket: WebSocket): void {
  if (socket.readyState !== WebSocket.OPEN) throw new Error("Browser capture caller retired");
}

function whileSocketOpen<T>(socket: WebSocket, start: () => Promise<T>): Promise<T> {
  requireOpenCaptureCaller(socket);
  let retired: (() => void) | undefined;
  const socketRetired = new Promise<never>((_resolve, reject) => {
    retired = () => reject(new Error("Browser capture caller retired"));
    socket.once("close", retired);
  });
  let pending: Promise<T>;
  try {
    requireOpenCaptureCaller(socket);
    pending = start();
  } catch (error) {
    if (retired) socket.off("close", retired);
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  return Promise.race([pending, socketRetired]).finally(() => {
    if (retired) socket.off("close", retired);
  });
}

async function handleTargetBoundInput(
  webContents: WebContents,
  command: CdpCommand,
  socket: WebSocket,
): Promise<TargetBoundInputResult> {
  const params = command.params ?? {};
  if (webContents.hostWebContents && inputNeedsRenderedSurface(command)) {
    // An occluded guest can retain a stale hit-test surface even with background
    // throttling disabled. Native capture requests a fresh host and guest frame
    // without showing or activating the Electron window; discard both images.
    await captureRenderedSurface(webContents, socket);
    requireOpenCaptureCaller(socket);
  }
  if (command.method === "Input.insertText" && typeof params["text"] === "string") {
    await webContents.insertText(params["text"]);
    return { handled: true, result: {} };
  }
  if (command.method === "Input.dispatchKeyEvent" || command.method === "Input.dispatchMouseEvent") {
    // Embedded guests also need their host DOM element selected: focus on the
    // guest alone leaves CDP keyboard input routed to the Workbench composer.
    const host = webContents.hostWebContents;
    if (host) {
      const focused: unknown = await host.executeJavaScript(`(() => {
        for (const view of document.querySelectorAll('webview')) {
          if (view.getWebContentsId() === ${webContents.id}) {
            view.focus();
            return document.activeElement === view;
          }
        }
        return false;
      })()`);
      if (focused !== true) throw new Error("Browser input target is no longer attached");
    } else {
      webContents.focus();
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
  const attachedHere = !webContents.debugger.isAttached();
  if (attachedHere) {
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

  const releaseRendering: Array<() => void> = [];
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    releaseRendering.push(retainRendering(webContents));
    if (webContents.hostWebContents) releaseRendering.push(retainRendering(webContents.hostWebContents));
  } catch (error) {
    for (const release of releaseRendering.reverse()) release();
    webContents.debugger.off("message", onDebuggerMessage);
    server.close();
    try {
      if (attachedHere && !webContents.isDestroyed() && webContents.debugger.isAttached()) {
        webContents.debugger.detach();
      }
    } catch {
      // Preserve the startup failure if the contents were destroyed during it.
    }
    throw error;
  }

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
      for (const release of releaseRendering) release();

      // The guest webContents may already be destroyed (a full-page guest swap
      // fires `destroyed` → BrowserControlManager.release → close). Touching
      // `.debugger` on a destroyed webContents — including `isAttached` — throws
      // "Object has been destroyed", which previously escaped the `detach`
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
        if (attachedHere && webContents.debugger.isAttached()) {
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

  const method = command.method;
  const execute = async () => {
    // A retired connection must not dispatch input after waiting for another
    // target. Recheck after the asynchronous embedded-host focus operation too.
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      const targetBound = await handleTargetBoundInput(webContents, command, socket);
      if (socket.readyState !== WebSocket.OPEN) return;
      const result = targetBound.handled ? targetBound.result
        : await captureViewport(webContents, command, socket)
          ?? await webContents.debugger.sendCommand(method, command.params ?? {}, command.sessionId) as unknown;
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ id: command.id, result: result ?? {} }));
      }
    } catch (error) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          id: command.id,
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : String(error),
          },
        }));
      }
    }
  };
  if (method === "Input.insertText" || method === "Input.dispatchKeyEvent" || method === "Input.dispatchMouseEvent") {
    const pending = inputTail.then(execute);
    inputTail = pending.catch(() => {});
    await pending;
  } else {
    await execute();
  }
}
