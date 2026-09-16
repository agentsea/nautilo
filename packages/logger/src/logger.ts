/**
 * Shared logger for nautilo packages.
 *
 * Supports two output modes:
 * - "stderr" (default): writes to process.stderr via console.error
 * - "file": writes to a log file for callers that need quiet stderr
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogOutput = "stderr" | "file" | "silent";

let currentLogLevel: LogLevel = "info";
let currentOutput: LogOutput = "stderr";
let logFilePath: string | null = null;

const SEVERITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// D082 PR B — per-turn correlation id.
//
// A "turn" is the full flow triggered by one user message: chat route →
// graph → tools → (optional interrupt + client reply) → resume → tool
// lifecycle events. Threading a single `turnId` through every log line
// in that flow makes `grep 'turn=<id>' nautilo-server.log` reconstruct
// the full timeline without timestamp gymnastics.
//
// AsyncLocalStorage is the idiomatic Node.js propagation mechanism:
// the store binds to the current async chain and flows through
// await boundaries, promise chains, async generators, and
// fire-and-forget `void x.finally()` spawns. Callers wrap a body
// with `runWithTurn(turnId, fn)` and every `log() / warn() /
// debug() / error()` inside that body's async chain automatically
// picks up the `[turn=<id>]` prefix — no explicit threading
// through function signatures.
const turnContext = new AsyncLocalStorage<{ turnId: string }>();

export function runWithTurn<T>(turnId: string, fn: () => T): T {
  return turnContext.run({ turnId }, fn);
}

export function getCurrentTurnId(): string | undefined {
  return turnContext.getStore()?.turnId;
}

function turnPrefix(): string {
  const ctx = turnContext.getStore();
  return ctx ? `[turn=${ctx.turnId}] ` : "";
}

export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

export function setLogOutput(output: LogOutput, filePath?: string): void {
  currentOutput = output;
  if (output === "file" && filePath) {
    logFilePath = filePath;
    try {
      mkdirSync(dirname(filePath), { recursive: true });
    } catch {
      // best effort
    }
  }
}

function shouldLog(level: LogLevel): boolean {
  return SEVERITY[level] >= SEVERITY[currentLogLevel];
}

function emit(level: LogLevel, prefix: string, args: unknown[]): void {
  if (!shouldLog(level)) return;

  if (currentOutput === "silent") return;

  const message = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  const turnBit = turnPrefix();
  const line = `${turnBit}${prefix ? `${prefix} ${message}` : message}`;

  if (currentOutput === "file" && logFilePath) {
    try {
      const timestamp = new Date().toISOString();
      appendFileSync(logFilePath, `[${timestamp}] ${line}\n`);
    } catch {
      // best effort
    }
    return;
  }

  console.error(line);
}

export function debug(...args: unknown[]): void {
  emit("debug", "[DEBUG]", args);
}

export function log(...args: unknown[]): void {
  emit("info", "", args);
}

export function warn(...args: unknown[]): void {
  emit("warn", "[WARN]", args);
}

export function error(...args: unknown[]): void {
  emit("error", "[ERROR]", args);
}
