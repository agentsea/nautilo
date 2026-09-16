/**
 * Shared screen-capture helpers for relay vision results (browser screenshot
 * today; desktop `see` may adopt this module in a follow-up).
 */

import type { RelayDispatchResult } from "@nautilo/relay";
import * as fsSync from "node:fs";
import * as path from "node:path";

export function captureFilePath(dir: string, prefix: string): string {
  fsSync.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${prefix}${Date.now()}.png`);
}

export function visionResultFromPng(options: {
  path: string;
  text: string;
  kind: string;
  maxBytes: number;
}): RelayDispatchResult {
  const { path: capturePath, text, kind, maxBytes } = options;
  try {
    const pngBytes = fsSync.readFileSync(capturePath);
    if (pngBytes.length > maxBytes) {
      return {
        status: "error",
        error:
          `Vision screenshot exceeds ${maxBytes} byte cap (${pngBytes.length} bytes); ` +
          "use coordinate-free controls or a smaller capture region instead.",
      };
    }
    return {
      status: "ok",
      result: {
        kind,
        text,
        image: {
          mime: "image/png",
          base64: pngBytes.toString("base64"),
        },
      },
    };
  } catch (err) {
    return {
      status: "error",
      error:
        err instanceof Error
          ? `Failed to read vision screenshot: ${err.message}`
          : "Failed to read vision screenshot",
    };
  }
}

export function pruneCaptures(dir: string, prefix: string, maxAgeMs: number): void {
  try {
    fsSync.mkdirSync(dir, { recursive: true });
    const now = Date.now();
    for (const name of fsSync.readdirSync(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith(".png")) continue;
      const filePath = path.join(dir, name);
      try {
        const stat = fsSync.statSync(filePath);
        if (now - stat.mtimeMs > maxAgeMs) {
          fsSync.rmSync(filePath, { force: true });
        }
      } catch {
        // best-effort per file
      }
    }
  } catch {
    // Screenshot GC is best-effort; never block automation on cleanup.
  }
}
