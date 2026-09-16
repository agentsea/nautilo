/**
 * M188 Phase 3 — child-process worker for deployed mini-app agent tools.
 *
 * Invoked by `app-tool-runner.ts` with a JSON invoke payload on stdin.
 * Host API calls are proxied to the parent over line-delimited JSON.
 */

import { fileURLToPath } from "node:url";
import type { AppToolPlatformFailure } from "./app-tool-types";

export const APP_TOOL_WORKER_SCRIPT = fileURLToPath(new URL("./app-tool-worker.ts", import.meta.url));

export type WorkerInvokePayload = {
  bundlePath: string;
  modulePath: string;
  handler: string;
  args: unknown;
  platformGate?: {
    kind: "live_review";
    sessionSentinel: string;
    nonce: string;
  };
};

export type WorkerLine =
  | { type: "rpc"; id: number; method: string; args: unknown[] }
  | { type: "result"; ok: true; value: unknown }
  | { type: "result"; ok: false; error: string }
  | { type: "platform-failure"; nonce: string; failure: AppToolPlatformFailure };

export type ParentLine =
  | { type: "rpc-res"; id: number; ok: true; value: unknown }
  | { type: "rpc-res"; id: number; ok: false; error: string };

const stdoutWrite = process.stdout.write.bind(process.stdout);
const stdinByteStream = Bun.stdin.stream();

function stripAmbientGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  for (const key of ["process", "Bun", "fetch", "WebSocket"]) {
    try {
      delete g[key];
    } catch {
      try {
        g[key] = undefined;
      } catch {
        /* best effort */
      }
    }
  }
}

function resolveHandler(mod: Record<string, unknown>, handlerPath: string): (...args: unknown[]) => unknown {
  const parts = handlerPath.split(".");
  let current: unknown = mod;
  for (const part of parts) {
    if (current == null || typeof current !== "object") {
      throw new Error(`handler not found: ${handlerPath}`);
    }
    current = (current as Record<string, unknown>)[part];
  }
  if (typeof current !== "function") {
    throw new Error(`handler is not a function: ${handlerPath}`);
  }
  return current as (...args: unknown[]) => unknown;
}

function writeLine(line: WorkerLine): void {
  stdoutWrite(`${JSON.stringify(line)}\n`);
}

function createNautiloAppProxy(
  rpc: (method: string, args: unknown[]) => Promise<unknown>,
): Record<string, unknown> {
  const call = (method: string) => (...args: unknown[]) => rpc(method, args);
  return {
    assets: {
      inspect: call("assets.inspect"),
      read: call("assets.read"),
    },
    templates: {
      list: call("templates.list"),
      read: call("templates.read"),
      save: call("templates.save"),
      remove: call("templates.remove"),
    },
    session: { command: call("session.command") },
    document: {
      createFromAction: call("document.createFromAction"),
      read: call("document.read"),
      stat: call("document.stat"),
      write: call("document.write"),
      writeBound: call("document.writeBound"),
      createDocument: call("document.createDocument"),
      createRasterFromSvg: call("document.createRasterFromSvg"),
    },
    state: {
      get: call("state.get"),
      set: call("state.set"),
    },
    office: {
      run: call("office.run"),
    },
  };
}

class StdinLineReader {
  private readonly reader = stdinByteStream.getReader();
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private closed = false;

  async readLine(): Promise<string | null> {
    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex >= 0) {
        const line = this.buffer.slice(0, newlineIndex);
        this.buffer = this.buffer.slice(newlineIndex + 1);
        return line;
      }
      if (this.closed) {
        if (this.buffer.length === 0) return null;
        const tail = this.buffer;
        this.buffer = "";
        return tail;
      }
      const { value, done } = await this.reader.read();
      if (done) {
        this.closed = true;
        continue;
      }
      if (value) {
        this.buffer += this.decoder.decode(value, { stream: true });
      }
    }
  }

  close(): void {
    this.reader.releaseLock();
  }
}

async function runWorker(payload: WorkerInvokePayload, lineReader: StdinLineReader): Promise<void> {
  stripAmbientGlobals();

  if (
    payload.platformGate?.kind === "live_review" &&
    (
      !payload.args ||
      typeof payload.args !== "object" ||
      Array.isArray(payload.args) ||
      (payload.args as Record<string, unknown>)["sessionToken"] !== payload.platformGate.sessionSentinel
    )
  ) {
    writeLine({
      type: "platform-failure",
      nonce: payload.platformGate.nonce,
      failure: {
        kind: "live_review",
        code: "live_review_session_sentinel_mismatch",
        status: "session_closed",
      },
    });
    return;
  }

  const bundle = (await import(payload.bundlePath)) as {
    __nautiloAppToolModules?: Record<string, Record<string, unknown>>;
  };

  const modules = bundle.__nautiloAppToolModules;
  if (!modules) {
    throw new Error("Agent tool bundle is missing __nautiloAppToolModules export.");
  }

  const mod = modules[payload.modulePath];
  if (!mod) {
    throw new Error(`Module not found in agent tool bundle: ${payload.modulePath}`);
  }

  let rpcId = 0;
  const pendingRpc = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();

  const rpc = async (method: string, args: unknown[]): Promise<unknown> => {
    const id = ++rpcId;
    writeLine({ type: "rpc", id, method, args });
    return await new Promise((resolve, reject) => {
      pendingRpc.set(id, { resolve, reject });
    });
  };

  const pumpStdin = async (): Promise<void> => {
    while (true) {
      const line = await lineReader.readLine();
      if (line === null) break;
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const parsed = JSON.parse(trimmed) as ParentLine;
      if (parsed.type !== "rpc-res") continue;
      const pending = pendingRpc.get(parsed.id);
      if (!pending) continue;
      pendingRpc.delete(parsed.id);
      if (parsed.ok) pending.resolve(parsed.value);
      else pending.reject(new Error(parsed.error));
    }
  };

  const stdinTask = pumpStdin();
  const handler = resolveHandler(mod, payload.handler);
  const nautiloApp = createNautiloAppProxy(rpc);
  try {
    const result = await handler(payload.args, { nautiloApp });
    if (pendingRpc.size > 0) {
      await stdinTask;
      if (pendingRpc.size > 0) {
        throw new Error("Worker exited with pending host RPC calls.");
      }
    }
    writeLine({ type: "result", ok: true, value: result });
  } catch (err) {
    if (pendingRpc.size > 0) {
      await stdinTask.catch(() => undefined);
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const lineReader = new StdinLineReader();
  try {
    const firstLine = await lineReader.readLine();
    if (!firstLine || firstLine.trim().length === 0) {
      writeLine({ type: "result", ok: false, error: "Missing invoke payload." });
      return;
    }

    let payload: WorkerInvokePayload;
    try {
      payload = JSON.parse(firstLine) as WorkerInvokePayload;
    } catch {
      writeLine({ type: "result", ok: false, error: "Invalid invoke payload JSON." });
      return;
    }

    try {
      await runWorker(payload, lineReader);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeLine({ type: "result", ok: false, error: message });
    }
  } finally {
    lineReader.close();
  }
}

if (import.meta.main) {
  void main();
}
