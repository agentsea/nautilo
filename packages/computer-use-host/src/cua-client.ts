import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import type { ComputerUseHostAuthorityScope } from "@nautilo/computer-use-host-protocol";
import { COMPUTER_USE_HOST_VERSION } from "./version.js";

/** Bounds one private NDJSON response while leaving ample room for future PNG parts. */
const MAX_CUA_MCP_RESPONSE_BYTES = 64 * 1024 * 1024;

export type CuaToolResult = Readonly<{
  isError: boolean;
  structuredContent: Readonly<Record<string, unknown>> | null;
}>;

export interface CuaToolClient {
  callTool(
    name: string,
    argumentsValue: Readonly<Record<string, unknown>>,
    context?: Readonly<{ authority: ComputerUseHostAuthorityScope; signal?: AbortSignal }>,
  ): Promise<CuaToolResult>;
}

type PendingCall = Readonly<{
  resolve(value: unknown): void;
  reject(reason: Error): void;
}>;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * One long-lived MCP transport to the signed Cua proxy. Provider text and image
 * blocks never leave this class; Host adapters consume only checked structured
 * content and mint their own opaque references.
 */
export class CuaMcpStdioClient implements CuaToolClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, PendingCall>();
  #nextId = 1;
  #buffer = "";
  #closed = false;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { this.#accept(chunk); });
    child.stderr.resume();
    child.once("exit", () => { this.#failAll(new Error("cua_mcp_exited")); });
    child.once("error", () => { this.#failAll(new Error("cua_mcp_failed")); });
  }

  static async start(options: Readonly<{
    executable: string;
    socketPath?: string;
    embedded?: boolean;
  }>): Promise<CuaMcpStdioClient> {
    const args = ["mcp"];
    if (options.embedded === true) args.push("--embedded");
    if (options.socketPath !== undefined) args.push("--socket", options.socketPath);
    const child = spawn(options.executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: options.embedded === true
        ? { ...process.env, CUA_DRIVER_EMBEDDED: "1" }
        : process.env,
    });
    const client = new CuaMcpStdioClient(child);
    await client.#request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "nautilo-computer-use-host", version: COMPUTER_USE_HOST_VERSION },
    });
    client.#notify("notifications/initialized", {});
    return client;
  }

  async callTool(name: string, argumentsValue: Readonly<Record<string, unknown>>): Promise<CuaToolResult> {
    const result = record(await this.#request("tools/call", { name, arguments: argumentsValue }));
    if (result === null) throw new Error("cua_mcp_malformed_result");
    const structured = result["structuredContent"];
    return {
      isError: result["isError"] === true,
      structuredContent: structured === undefined || structured === null ? null : record(structured),
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#child.stdin.end();
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#child.kill("SIGTERM");
      await once(this.#child, "exit").catch(() => undefined);
    }
  }

  #notify(method: string, params: Readonly<Record<string, unknown>>): void {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  #request(method: string, params: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("cua_mcp_closed"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  #write(message: Readonly<Record<string, unknown>>): void {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #accept(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) {
        if (Buffer.byteLength(this.#buffer, "utf8") > MAX_CUA_MCP_RESPONSE_BYTES) {
          this.#failAll(new Error("cua_mcp_response_too_large"));
        }
        return;
      }
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length === 0) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_CUA_MCP_RESPONSE_BYTES) {
        this.#failAll(new Error("cua_mcp_response_too_large"));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.#failAll(new Error("cua_mcp_malformed_json"));
        return;
      }
      const message = record(parsed);
      const id = message?.["id"];
      if (message === null || typeof id !== "number" || !Number.isSafeInteger(id)) continue;
      const pending = this.#pending.get(id);
      if (pending === undefined) continue;
      this.#pending.delete(id);
      const error = record(message["error"]);
      if (error !== null) pending.reject(new Error("cua_mcp_rpc_error"));
      else pending.resolve(message["result"]);
    }
  }

  #failAll(error: Error): void {
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill("SIGTERM");
  }
}
