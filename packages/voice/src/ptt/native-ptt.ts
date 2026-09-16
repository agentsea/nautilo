import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { warn } from "@nautilo/logger";
import type { PTTCallbacks, PTTStatus, PTTPermission } from "./types";

const BINARY_RELATIVE_PATH = "../../../native/macos-ptt-helper/.build/debug/nautilo-ptt-helper";

function resolveBinaryPath(): string | null {
  const candidates = [
    resolve(import.meta.dirname, BINARY_RELATIVE_PATH),
    resolve(import.meta.dirname, "../../../../native/macos-ptt-helper/.build/debug/nautilo-ptt-helper"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export function isPTTAvailable(): boolean {
  return process.platform === "darwin" && resolveBinaryPath() !== null;
}

export class NativePTTManager {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private callbacks: PTTCallbacks;
  private alive = false;

  constructor(callbacks: PTTCallbacks) {
    this.callbacks = callbacks;
  }

  start(): boolean {
    if (this.alive) return true;

    const binary = resolveBinaryPath();
    if (!binary) {
      warn("[ptt] Binary not found. Run: bun run ptt:build");
      return false;
    }

    try {
      this.proc = Bun.spawn([binary], {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          NAUTILO_PTT_PARENT_PID: String(process.pid),
        },
      });
      this.alive = true;

      void this.readStdout();
      void this.readStderr();

      return true;
    } catch (err) {
      warn(`[ptt] Failed to spawn helper: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  stop(): void {
    this.alive = false;
    if (this.proc) {
      try { this.proc.kill(); } catch { /* best effort */ }
      this.proc = null;
    }
  }

  private async readStdout(): Promise<void> {
    const stdout = this.proc?.stdout;
    if (!stdout || typeof stdout === "number") return;

    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (this.alive) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("TRANSCRIPT\t")) {
            const text = line.slice("TRANSCRIPT\t".length).trim();
            if (text) this.callbacks.onTranscript(text);
          }
        }
      }
    } catch {
      // stream closed
    } finally {
      reader.releaseLock();
    }

    if (this.alive) {
      this.alive = false;
      this.callbacks.onStatus("unavailable");
    }
  }

  private async readStderr(): Promise<void> {
    const stderr = this.proc?.stderr;
    if (!stderr || typeof stderr === "number") return;

    const reader = stderr.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (this.alive) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          this.parseStderrLine(line);
        }
      }
    } catch {
      // stream closed
    } finally {
      reader.releaseLock();
    }
  }

  private parseStderrLine(line: string): void {
    if (line.startsWith("STATUS\t")) {
      const raw = line.slice("STATUS\t".length).trim();
      const statusMap: Record<string, PTTStatus> = {
        "READY": "ready",
        "WAITING_FOR_PERMISSION": "waiting_for_permission",
        "LISTENING": "listening",
        "PROCESSING": "processing",
        "IDLE": "idle",
        "EMPTY": "empty",
      };
      const status = statusMap[raw];
      if (status) this.callbacks.onStatus(status);
    } else if (line.startsWith("PERMISSION\t")) {
      const perm = line.slice("PERMISSION\t".length).trim() as PTTPermission;
      if (perm === "ACCESSIBILITY" || perm === "SPEECH" || perm === "MICROPHONE") {
        this.callbacks.onPermission(perm);
      }
    } else if (line.startsWith("ERROR\t")) {
      const msg = line.slice("ERROR\t".length).trim();
      this.callbacks.onError(msg);
    }
  }
}
