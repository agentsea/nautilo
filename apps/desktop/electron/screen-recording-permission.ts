/**
 * Fixed-command bridge to Nautilo's source-owned macOS Screen Recording
 * helper. The only permitted invocation is `--request`; no renderer data,
 * shell, PATH lookup, or arbitrary URL crosses this boundary.
 */

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";

export const SCREEN_RECORDING_PERMISSION_HELPER = "nautilo-screen-recording-permission";
export const SCREEN_RECORDING_PERMISSION_REQUEST_ARGUMENT = "--request";
const SCREEN_RECORDING_PERMISSION_MAX_OUTPUT_BYTES = 128;

export type ScreenRecordingPermissionHelperOptions = Readonly<{
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly resourcesPath: string | null;
  readonly devVendorRoot: string;
  readonly exists?: (path: string) => boolean;
}>;

/** No PATH fallback: only the packaged or development vendor helper may run. */
export function resolveScreenRecordingPermissionHelper(
  options: ScreenRecordingPermissionHelperOptions,
): string | null {
  if (options.platform !== "darwin" || !isAbsolute(options.devVendorRoot)) return null;
  const candidate = options.isPackaged
    ? options.resourcesPath !== null && isAbsolute(options.resourcesPath)
      ? join(options.resourcesPath, "tools-permissions", SCREEN_RECORDING_PERMISSION_HELPER)
      : null
    : join(options.devVendorRoot, "screen-recording-permission", SCREEN_RECORDING_PERMISSION_HELPER);
  if (candidate === null || !(options.exists ?? existsSync)(candidate)) return null;
  return candidate;
}

export type ScreenRecordingPermissionRequestResult =
  | Readonly<{ readonly ok: true; readonly granted: boolean }>
  | Readonly<{ readonly ok: false; readonly code: "unavailable" | "spawn_failed" | "invalid_response" }>;

type SpawnedHelper = Readonly<{
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  once(event: "error" | "close", listener: (value: Error | number | null) => void): unknown;
}>;

export type RequestScreenRecordingPermissionDependencies = Readonly<{
  readonly spawn?: (file: string, args: readonly string[], options: Readonly<{
    readonly shell: false;
    readonly stdio: readonly ["ignore", "pipe", "ignore"];
  }>) => SpawnedHelper;
}>;

function parseResult(stdout: string): boolean | null {
  if (stdout.length > SCREEN_RECORDING_PERMISSION_MAX_OUTPUT_BYTES) return null;
  try {
    const value: unknown = JSON.parse(stdout);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    return keys.length === 1 && keys[0] === "screenRecording" && typeof record["screenRecording"] === "boolean"
      ? record["screenRecording"]
      : null;
  } catch {
    return null;
  }
}

export async function requestScreenRecordingPermission(
  helperPath: string | null,
  dependencies: RequestScreenRecordingPermissionDependencies = {},
): Promise<ScreenRecordingPermissionRequestResult> {
  if (helperPath === null || !isAbsolute(helperPath)) return { ok: false, code: "unavailable" };
  const start = dependencies.spawn ?? ((file, args, options) => spawn(file, [...args], {
    shell: options.shell,
    stdio: [...options.stdio],
  }) as unknown as SpawnedHelper);
  return await new Promise((resolve) => {
    let helper: SpawnedHelper;
    try {
      helper = start(helperPath, [SCREEN_RECORDING_PERMISSION_REQUEST_ARGUMENT], {
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve({ ok: false, code: "spawn_failed" });
      return;
    }
    let output = "";
    let outputTooLarge = false;
    helper.stdout?.on("data", (chunk: Buffer | string) => {
      const next = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (output.length + next.length > SCREEN_RECORDING_PERMISSION_MAX_OUTPUT_BYTES) {
        outputTooLarge = true;
        return;
      }
      output += next;
    });
    helper.once("error", () => resolve({ ok: false, code: "spawn_failed" }));
    helper.once("close", (exitCode) => {
      if (typeof exitCode !== "number" || exitCode !== 0 || outputTooLarge) {
        resolve({ ok: false, code: "invalid_response" });
        return;
      }
      const granted = parseResult(output.trim());
      resolve(granted === null ? { ok: false, code: "invalid_response" } : { ok: true, granted });
    });
  });
}
