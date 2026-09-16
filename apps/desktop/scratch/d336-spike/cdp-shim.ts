import type { WebContents } from "electron";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

export interface CdpShimOptions {
  webContents: WebContents;
  port: number;
  token: string;
}

interface CdpCommand {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export interface CdpShimHandle {
  readonly url: string;
  close(): void;
}

export async function startCdpShim(options: CdpShimOptions): Promise<CdpShimHandle> {
  const { webContents, port, token } = options;

  if (!webContents.debugger.isAttached()) {
    webContents.debugger.attach("1.3");
  }

  const server = new WebSocketServer({
    host: "127.0.0.1",
    port,
    path: `/${token}`,
  });

  const clients = new Set<WebSocket>();
  const onDebuggerMessage = (
    _event: Electron.Event,
    method: string,
    params?: unknown,
    sessionId?: string,
  ) => {
    const payload: Record<string, unknown> = {
      method,
      params: params ?? {},
    };
    if (sessionId) payload["sessionId"] = sessionId;
    const encoded = JSON.stringify(payload);
    for (const client of clients) {
      if (client.readyState === client.OPEN) client.send(encoded);
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

  const url = `ws://127.0.0.1:${port}/${token}`;
  return {
    url,
    close() {
      webContents.debugger.off("message", onDebuggerMessage);
      for (const client of clients) client.close();
      clients.clear();
      server.close();
      if (webContents.debugger.isAttached()) {
        try {
          webContents.debugger.detach();
        } catch {
          // Detach is best-effort during app teardown.
        }
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
    command = JSON.parse(data.toString("utf8")) as CdpCommand;
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
    const result = await webContents.debugger.sendCommand(
      command.method,
      command.params ?? {},
      command.sessionId,
    );
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
