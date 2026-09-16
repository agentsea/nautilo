import { createHash, randomBytes } from "node:crypto";
import { spawn as spawnChild } from "node:child_process";
import { lstat, open as openFile, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import net from "node:net";
import type { Writable } from "node:stream";
import { CUA_DRAG_MAX_DURATION_MS, CUA_DRAG_MAX_STEPS, CUA_MACOS_KEY_PATTERN, CUA_TYPE_TEXT_MAX_DELAY_MS, normalizeCuaMacosHotkey } from "@nautilo/computer-use-contracts/native";
import type { ComputerUseContextScope } from "./native-context-registry.js";
import { DESKTOP_VISION_PNG_MAX_BYTES, parseBoundedPngDimensions } from "./native-image-contract.js";

/** Values read from the signed stable 0.23.2 embedded daemon during CUA-LAB-0098. */
export const CUA_DRIVER_VERSION = "0.23.2";
export const CUA_CONTRACT_VERSION = "0.7.0";
export const CUA_TOOLS_LIST_SCHEMA_VERSION = "1";
export const CUA_CAPABILITY_VERSION = "1";
export const CUA_MCP_PROTOCOL_VERSION = "2025-06-18";
/** Matches the upstream `cua-driver stop` shutdown wait. This is never an action or startup deadline. */
const CUA_UPSTREAM_SHUTDOWN_GRACE_MS = 2_000;
/** Pinned `embedded.rs::terminate_startup_child` liveness-only teardown grace. */
const CUA_UPSTREAM_STARTUP_TEARDOWN_GRACE_MS = 250;
/** Upstream's `cua-driver stop` socket-poll cadence; retry cadence only, never a startup deadline. */
const CUA_UPSTREAM_SOCKET_RETRY_INTERVAL_MS = 50;
/**
 * Metadata/control containment before JSON parsing. Binary screenshots use
 * the owned-file handoff and the separate decoded-image contract below.
 */
export const CUA_MAX_RAW_CONTROL_PROTOCOL_BYTES = 16 * 1024 * 1024;

export type CuaWindowTraversalEffort = Readonly<{
  maxElements?: number;
  maxDepth?: number;
}>;

const DEFAULT_HOST_BUNDLE_ID = "com.nautilo.desktop";

export interface CuaChild {
  readonly pid: number | undefined;
  readonly stdin: Pick<Writable, "end"> | null;
  /** Node's exit state; a non-null value means startup cannot continue. */
  readonly exitCode?: number | null;
  /** Test-double compatibility only; production children use `exitCode`. */
  readonly exited: boolean | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit" | "error", listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: "exit" | "error", listener: (...args: unknown[]) => void): unknown;
}

export interface CuaSpawnOptions {
  readonly env: Readonly<Record<string, string>>;
  readonly shell: false;
  readonly stdio: readonly ["pipe", "ignore", "ignore"];
}

export type CuaSpawn = (binary: string, args: readonly string[], options: CuaSpawnOptions) => CuaChild;

export interface CuaSocketStat {
  readonly kind: "socket" | "directory" | "file" | "symlink" | "other";
  readonly mode: number;
  readonly uid: number;
  readonly device: bigint;
  readonly inode: bigint;
}

export interface CuaFilesystem {
  lstat(path: string): Promise<CuaSocketStat | null>;
  unlink(path: string): Promise<void>;
}

/** Narrow, file-descriptor based seam for the private capture hand-off. */
export interface CuaCaptureFileStat {
  readonly kind: "file" | "directory" | "symlink" | "other";
  readonly mode: number;
  readonly uid: bigint;
  readonly device: bigint;
  readonly inode: bigint;
  readonly nlink: bigint;
}

export interface CuaCaptureFileHandle {
  stat(): Promise<CuaCaptureFileStat>;
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ readonly bytesRead: number }>;
  close(): Promise<void>;
}

export interface CuaCaptureFilesystem {
  open(path: string, flags: "wx+", mode: number): Promise<CuaCaptureFileHandle>;
  lstat(path: string): Promise<CuaCaptureFileStat | null>;
  unlink(path: string): Promise<void>;
}

/** One exact line-delimited JSON request/response exchange. No action deadline is imposed here. */
export type CuaLineTransport = (
  socketPath: string,
  request: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
) => Promise<unknown>;

export interface CuaSupervisorOptions {
  /** Exact packaged executable path. PATH lookup and dev fallbacks are forbidden. */
  readonly binaryPath: string;
  /** Existing, private (0700) host runtime directory. */
  readonly runtimeDir: string;
  /** Build-bound identity of the responsible host app. Never read from the child or model. */
  readonly hostBundleId?: string;
  /** Current user's validated home; required for existing-profile browser discovery. */
  readonly userHomePath?: string;
  readonly spawn?: CuaSpawn;
  readonly filesystem?: CuaFilesystem;
  readonly transport?: CuaLineTransport;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  /** Narrow lifecycle seam used to prove child-death ordering in isolation. */
  readonly beforeContextStart?: () => void;
  /** Narrow test seam; production derives this from the current macOS user. */
  readonly expectedUid?: number;
  /** Test seam only; production reads and removes only the retained descriptor. */
  readonly captureFilesystem?: CuaCaptureFilesystem;
  /** Content-free capture-stage diagnostics. Paths, bytes, provider text, and authority IDs are forbidden. */
  readonly onCaptureDiagnostic?: (event: CuaCaptureDiagnostic) => void;
}

export type CuaCaptureDiagnostic = Readonly<{
  stage:
    | "runtime_identity"
    | "nonce"
    | "open"
    | "initial_identity"
    | "provider_call"
    | "provider_result"
    | "post_write_identity"
    | "read"
    | "size"
    | "png"
    | "dimensions"
    | "completion"
    | "cleanup";
  code: "invalid_configuration" | "cancelled" | "stale_generation" | "context_fenced" | "image_too_large" | "provider_malformed";
  /**
   * Names the exact value predicate a provider response failed. Fixed
   * category identifiers only — never a value, path, or byte from the
   * response.
   */
  predicate?: CuaCaptureValuePredicate;
}>;

export type CuaSupervisorFailureCode =
  | "invalid_configuration"
  | "runtime_directory_unsafe"
  | "socket_collision"
  | "socket_unsafe"
  | "spawn_failed"
  | "attestation_failed"
  | "permission_check_failed"
  | "health_check_failed"
  | "session_start_failed"
  | "cancelled"
  | "stale_generation"
  | "context_fenced";

export type CuaDesktopCaptureFailureCode = CuaSupervisorFailureCode | "image_too_large" | "provider_malformed";

/**
 * D516 — content-free names for the individual desktop-state value checks.
 * A failed predicate is a provider-compatibility fact, never an authority
 * event: it must not destroy the checked generation or imply the Human
 * revoked anything.
 */
export type CuaCaptureValuePredicate =
  | "envelope"
  | "content_block"
  | "structured_keys"
  | "platform"
  | "display"
  | "screen_width"
  | "screen_height"
  | "scale_factor"
  | "screenshot_width"
  | "screenshot_height"
  | "mime"
  | "path_equality"
  | "png_parse"
  | "png_dimensions";

export type CuaSupervisorResult =
  | { readonly ok: true; readonly generation: string; readonly health: CuaSupervisorHealth; readonly healthFreshness: "startup_cached" | "fresh" }
  | { readonly ok: false; readonly code: CuaSupervisorFailureCode };

export type CuaContextStartResult =
  | { readonly ok: true; readonly generation: string; readonly sessionId: string; readonly health: CuaSupervisorHealth }
  | { readonly ok: false; readonly code: CuaSupervisorFailureCode };

/**
 * The semantic adapter may call only this reviewed, pinned Cua subset.  This
 * is deliberately not a generic daemon RPC escape hatch: every argument
 * shape below is rechecked at the generation boundary.
 */
export type CuaContextToolName =
  | "list_apps"
  | "list_windows"
  /** Host-resolved bundle launch only; no Cua name/URL/argv controls cross this seam. */
  | "launch_app"
  /** Exact host-resolved window state. Generic calls keep screenshots disabled. */
  | "get_window_state"
  | "bring_to_front"
  /** Exact app-menu path against one opaque window; see CUA-LAB-0049. */
  | "invoke_menu"
  | "set_window_frame"
  | "type_text"
  | "set_value"
  /** Literal CUA-LAB-0108 background scroll through a fresh AX token or window PNG point. */
  | "scroll"
  /** Exact background AXPress against one private element token. */
  | "click"
  /** Exact background context-menu request against one private element token. */
  | "right_click"
  | "double_click"
  | "drag"
  | "move_cursor"
  | "press_key"
  | "hotkey"
  | "verify_state";

/**
 * Browser primitives admitted only through a Host-owned, already-open Cua
 * context session. `start_session`/`end_session` remain supervisor lifecycle
 * operations and can never arrive through this seam.
 */
export type CuaBrowserToolName =
  | "browser_prepare"
  | "get_browser_state"
  | "browser_navigate"
  | "browser_click"
  | "browser_type"
  | "browser_pointer"
  | "browser_dialog"
  /** Host-private exact-window composition primitives; never public tools. */
  | "list_windows"
  | "bring_to_front"
  | "hotkey"
  | "type_text"
  | "press_key";

/** A checked daemon ToolResult, retained only for the semantic adapter parser. */
export interface CuaContextToolResult {
  readonly content: readonly Readonly<Record<string, unknown>>[];
  readonly isError: boolean;
  readonly structuredContent: Readonly<Record<string, unknown>> | null;
}

/**
 * `session` is deliberately not an adapter argument.  The supervisor creates
 * it from the full server-issued context before it calls any listed tool.
 */
export type CuaContextToolCallResult =
  | { readonly ok: true; readonly generation: string; readonly sessionId: string; readonly result: CuaContextToolResult }
  | { readonly ok: false; readonly code: CuaSupervisorFailureCode; readonly stage: "session" | "tool" };

/** Path-free image result. The caller releases this exact session lease. */
export type CuaDesktopCaptureResult =
  | {
    readonly ok: true;
    readonly generation: string;
    readonly sessionId: string;
    readonly png: Uint8Array;
    readonly nativeWidth: number;
    readonly nativeHeight: number;
    readonly screenWidth: number;
    readonly screenHeight: number;
    readonly scaleFactor: number;
  }
  | { readonly ok: false; readonly code: CuaDesktopCaptureFailureCode };

/** Path-free exact-window capture. The caller releases this exact session lease. */
export type CuaWindowCaptureResult =
  | {
    readonly ok: true;
    readonly generation: string;
    readonly sessionId: string;
    readonly result: CuaContextToolResult;
    /** Null only for a truthful Cua capture-unavailable or tool-refusal result. */
    readonly png: Uint8Array | null;
  }
  | { readonly ok: false; readonly code: CuaDesktopCaptureFailureCode };

/** Public pointer choices translated to Cua's private wire vocabulary. */
export type CuaPixelClickOptions = Readonly<{
  button?: "left" | "right" | "middle";
  count?: number;
  modifiers?: readonly ("cmd" | "shift" | "option" | "alt" | "ctrl")[];
}>;

export function cuaPixelClickArguments(options: CuaPixelClickOptions): Readonly<Record<string, unknown>> {
  return {
    ...(options.button === undefined ? {} : { button: options.button }),
    ...(options.count === undefined ? {} : { count: options.count }),
    ...(options.modifiers === undefined ? {} : { modifier: [...options.modifiers] }),
  };
}

/** Exact closed projection emitted by the pinned desktop-scope click. */
export type CuaDesktopClickResult =
  | {
    readonly ok: true;
    readonly generation: string;
    readonly sessionId: string;
    readonly effect: "unverifiable";
    readonly route: "global_input";
    readonly delivery: "not_applicable";
  }
  | { readonly ok: false; readonly code: CuaSupervisorFailureCode; readonly stage: "session" | "tool" };

/** Content-free provider health: detailed driver diagnostics never cross this seam. */
export interface CuaSupervisorHealth {
  readonly permission: "ready" | "unavailable";
  readonly health: "ready" | "degraded";
}

interface ActiveGeneration {
  readonly number: number;
  readonly opaqueId: string;
  readonly socketPath: string;
  readonly child: CuaChild;
  readonly socketIdentity: CuaSocketStat;
  readonly runtimeIdentity: CuaSocketStat;
  readonly health: CuaSupervisorHealth;
}

interface ActiveContextSession {
  readonly generation: number;
  readonly sessionId: string;
  readonly leases: number;
}

// Direct signed-Cua 0.23.2 qualification proves these per-session values are
// applied and read back exactly. A short fixed glide keeps the visible agent
// cursor legible without making long paths wait on the default speed curve;
// the click result itself already provides the action boundary, so no extra
// visual dwell is needed.
const CUA_CURSOR_GLIDE_DURATION_MS = 120;
const CUA_CURSOR_DWELL_AFTER_CLICK_MS = 0;

interface SpawnObservation {
  failed(): boolean;
  publish(generation: ActiveGeneration): void;
}

interface DaemonMetadata {
  readonly driver_version: unknown;
  readonly contract_version: unknown;
  readonly tools_list_schema_version: unknown;
  readonly capability_version: unknown;
  readonly mcp_protocol_version: unknown;
  readonly pid: unknown;
  readonly embedded: unknown;
  readonly host_bundle_id: unknown;
}

function defaultSpawn(binary: string, args: readonly string[], options: CuaSpawnOptions): CuaChild {
  return spawnChild(binary, [...args], { ...options, stdio: [...options.stdio] }) as unknown as CuaChild;
}

function mode(stat: { readonly mode: number | bigint }): number {
  return Number(stat.mode) & 0o777;
}

const defaultFilesystem: CuaFilesystem = {
  async lstat(path) {
    try {
      const stat = await lstat(path, { bigint: true });
      return {
        kind: stat.isSymbolicLink() ? "symlink" : stat.isSocket() ? "socket" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
        mode: mode(stat),
        uid: Number(stat.uid),
        device: stat.dev,
        inode: stat.ino,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
  unlink,
};

function captureStat(stat: Awaited<ReturnType<typeof lstat>>): CuaCaptureFileStat {
  return {
    kind: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "other",
    mode: mode(stat), uid: BigInt(stat.uid), device: BigInt(stat.dev), inode: BigInt(stat.ino), nlink: BigInt(stat.nlink),
  };
}

const defaultCaptureFilesystem: CuaCaptureFilesystem = {
  async open(path, flags, fileMode) {
    const handle = await openFile(path, flags, fileMode);
    return {
      async stat() { return captureStat(await handle.stat({ bigint: true })); },
      async read(buffer, offset, length, position) {
        return handle.read(buffer, offset, length, position);
      },
      async close() { await handle.close(); },
    };
  },
  async lstat(path) {
    try { return captureStat(await lstat(path, { bigint: true })); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  },
  unlink,
};

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(aborted());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(aborted());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function cuaLineTransport(socketPath: string, request: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(aborted());
    const socket = net.createConnection(socketPath);
    let pending = Buffer.alloc(0);
    let settled = false;
    const done = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const onAbort = () => done(aborted());
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("error", (error) => done(error));
    socket.once("close", () => done(new Error("cua protocol closed before a complete response line")));
    socket.on("data", (chunk: Buffer) => {
      const newline = chunk.indexOf(0x0a);
      const responseBytes = pending.byteLength + (newline < 0 ? chunk.byteLength : newline);
      if (responseBytes > CUA_MAX_RAW_CONTROL_PROTOCOL_BYTES) return done(new Error("cua protocol response exceeds maximum size"));
      if (newline < 0) {
        // The size check above proves this bounded copy cannot retain an
        // attacker-provided over-limit chunk.
        pending = Buffer.concat([pending, chunk]);
        return;
      }
      const line = (pending.byteLength === 0 ? chunk.subarray(0, newline) : Buffer.concat([pending, chunk.subarray(0, newline)])).toString("utf8");
      try {
        done(undefined, JSON.parse(line));
      } catch {
        done(new Error("cua protocol returned invalid JSON"));
      }
    });
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
  });
}

function aborted(): Error {
  const error = new Error("cua supervisor operation cancelled");
  error.name = "AbortError";
  return error;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function object(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
}

/** Daemon metadata is a direct payload, unlike a `call` ToolResult. */
function daemonResult(value: unknown): unknown {
  const envelope = object(value);
  return envelope?.["ok"] === true && "result" in envelope ? envelope["result"] : null;
}

/**
 * `invoke_daemon_tool` nests the complete MCP ToolResult under the successful
 * daemon response. An outer `ok` never turns an `isError` tool call into a
 * successful supervisor step.
 */
function successfulToolResult(value: unknown): Readonly<Record<string, unknown>> | null {
  const result = object(daemonResult(value));
  if (result === null || !Array.isArray(result["content"]) || result["isError"] === true) return null;
  return result;
}

/**
 * Preserve a tool refusal for the semantic adapter to normalize, but reject
 * malformed daemon envelopes before any provider data can cross that seam.
 */
function checkedToolResult(value: unknown): CuaContextToolResult | null {
  const result = object(daemonResult(value));
  if (result === null || !Array.isArray(result["content"]) || (result["isError"] !== undefined && typeof result["isError"] !== "boolean")) {
    return null;
  }
  const content: Readonly<Record<string, unknown>>[] = [];
  for (const entry of result["content"]) {
    const block = object(entry);
    if (block === null || typeof block["type"] !== "string") return null;
    if (block["type"] === "text" && typeof block["text"] !== "string") return null;
    if (block["type"] === "image" && (typeof block["data"] !== "string" || typeof block["mimeType"] !== "string")) return null;
    content.push(block);
  }
  const structured = result["structuredContent"];
  if (structured !== undefined && object(structured) === null) return null;
  return {
    content,
    isError: result["isError"] === true,
    structuredContent: structured === undefined ? null : object(structured),
  };
}

function isExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validVerifyBounds(value: unknown): boolean {
  const bounds = object(value);
  if (bounds === null || !Object.keys(bounds).every((key) => ["height", "tolerance_px", "width", "x", "y"].includes(key))
    || !["x", "y", "width", "height"].every((key) => key in bounds)) return false;
  return ["x", "y", "width", "height"].every((key) =>
    typeof bounds[key] === "number" && Number.isFinite(bounds[key])
  ) && (bounds["tolerance_px"] === undefined || (typeof bounds["tolerance_px"] === "number" && Number.isFinite(bounds["tolerance_px"])
    && bounds["tolerance_px"] >= 0 && bounds["tolerance_px"] <= 100));
}

function validVerifyWindow(value: unknown): boolean {
  const window = object(value);
  if (window === null || Object.keys(window).length === 0
    || !Object.keys(window).every((key) => key === "exists" || key === "bounds")) return false;
  return (window["exists"] === undefined || typeof window["exists"] === "boolean")
    && (window["bounds"] === undefined || validVerifyBounds(window["bounds"]));
}

function validVerifyElement(value: unknown): boolean {
  const element = object(value);
  if (element === null || !Object.keys(element).every((key) => ["selector", "exists", "value_equals", "enabled", "selected"].includes(key))) return false;
  const selector = object(element["selector"]);
  if (selector === null || !Object.keys(selector).every((key) => key === "role" || key === "label_contains")
    || Object.keys(selector).length === 0
    || (selector["role"] !== undefined && (typeof selector["role"] !== "string" || selector["role"].length === 0))
    || (selector["label_contains"] !== undefined && (typeof selector["label_contains"] !== "string" || selector["label_contains"].length === 0))) return false;
  return (element["exists"] === undefined || element["exists"] === true)
    && (element["value_equals"] === undefined || typeof element["value_equals"] === "string")
    && (element["enabled"] === undefined || typeof element["enabled"] === "boolean")
    && (element["selected"] === undefined || typeof element["selected"] === "boolean");
}

function validVerifyPredicate(value: unknown): boolean {
  const predicate = object(value);
  return predicate !== null && Object.keys(predicate).length === 1
    && Object.keys(predicate).every((key) => key === "window" || key === "element")
    && (predicate["window"] === undefined || validVerifyWindow(predicate["window"]))
    && (predicate["element"] === undefined || validVerifyElement(predicate["element"]));
}

// Shared source-derived key vocabulary; the adapter canonicalizes modifier aliases.
const CUA_MACOS_SEMANTIC_MODIFIERS = new Set(["cmd", "shift", "option", "ctrl", "fn"]);
const CUA_POINTER_MODIFIERS = new Set(["cmd", "shift", "option", "alt", "ctrl"]);
const CUA_NATIVE_CLICK_ACTIONS = new Set(["press", "show_menu", "pick", "confirm", "cancel", "open"]);

function validPixelClickOptions(args: Readonly<Record<string, unknown>>): boolean {
  return (args["button"] === undefined || typeof args["button"] === "string" && ["left", "right", "middle"].includes(args["button"]))
    && (args["count"] === undefined || typeof args["count"] === "number" && Number.isSafeInteger(args["count"]) && args["count"] > 0)
    && (args["modifier"] === undefined || Array.isArray(args["modifier"])
      && args["modifier"].every((modifier) => typeof modifier === "string" && CUA_POINTER_MODIFIERS.has(modifier)));
}

/** Shared host-side containment for pinned Cua bundle identifiers. */
/** Shared private-provider identifier containment; public labels remain 256. */
const CUA_BUNDLE_ID_MAX_CODE_UNITS = 2048;

export function isPinnedCuaBundleIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= CUA_BUNDLE_ID_MAX_CODE_UNITS
    // Cua returns the host's literal CFBundleIdentifier. Real macOS inventory
    // includes numeric segment starts (com.1password.1password) and even an
    // Apple-owned underscore (com.apple.Image_Capture), so rejecting either
    // makes one unrelated installed app poison the complete list_apps result.
    && /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(value);
}

/**
 * These are intentionally named rather than folded into a permissive generic
 * record predicate.  They are the only Cua launch/window-state shapes the
 * checked generation can emit; semantic-name lookup and native ids both stay
 * on the host side of this boundary.
 */
function validLaunchApplicationArgs(args: Readonly<Record<string, unknown>>): boolean {
  return isExactKeys(args, ["bundle_id"]) && isPinnedCuaBundleIdentifier(args["bundle_id"]);
}

function validGetWindowStateArgs(args: Readonly<Record<string, unknown>>): boolean {
  const keys = ["include_screenshot", "pid", "window_id"];
  if (Object.hasOwn(args, "max_elements")) keys.push("max_elements");
  if (Object.hasOwn(args, "max_depth")) keys.push("max_depth");
  return isExactKeys(args, keys)
    && typeof args["pid"] === "number" && Number.isSafeInteger(args["pid"]) && args["pid"] > 0
    && typeof args["window_id"] === "number" && Number.isSafeInteger(args["window_id"]) && args["window_id"] > 0
    && typeof args["include_screenshot"] === "boolean"
    && (!Object.hasOwn(args, "max_elements")
      || typeof args["max_elements"] === "number" && Number.isSafeInteger(args["max_elements"]) && args["max_elements"] > 0)
    && (!Object.hasOwn(args, "max_depth")
      || typeof args["max_depth"] === "number" && Number.isSafeInteger(args["max_depth"]) && args["max_depth"] > 0);
}

function windowTraversalArgs(effort?: CuaWindowTraversalEffort): Readonly<Record<string, number>> {
  return {
    ...(effort?.maxElements === undefined || !Object.hasOwn(effort, "maxElements") ? {} : { max_elements: effort.maxElements }),
    ...(effort?.maxDepth === undefined || !Object.hasOwn(effort, "maxDepth") ? {} : { max_depth: effort.maxDepth }),
  };
}

function validWindowTraversalEffort(effort: unknown): boolean {
  if (effort === undefined) return true;
  const value = object(effort);
  if (value === null) return false;
  const keys = Object.keys(value);
  return keys.length >= 1
    && keys.every((key) => key === "maxElements" || key === "maxDepth")
    && keys.every((key) => positiveSafe(value[key]));
}

/** Pinned list_windows accepts only the exact optional pid filter we need. */
function validListWindowsArgs(args: Readonly<Record<string, unknown>>): boolean {
  return isExactKeys(args, []) || (isExactKeys(args, ["pid"])
    && typeof args["pid"] === "number" && Number.isSafeInteger(args["pid"]) && args["pid"] > 0);
}

function hasSafeNativeMenuLabelCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 31 || codePoint === 127 || codePoint === 0x2028 || codePoint === 0x2029) return false;
  }
  return true;
}

function validContextToolArgs(name: CuaContextToolName, args: Readonly<Record<string, unknown>>): boolean {
  if (name === "hotkey") {
    const { keys, ...destination } = args;
    if (Object.hasOwn(destination, "key") || Object.hasOwn(destination, "modifiers")) return false;
    if (!Array.isArray(keys) || !keys.every((key): key is string => typeof key === "string")) return false;
    const chord = normalizeCuaMacosHotkey(keys);
    // Same exact keyboard destinations, not a second per-tool target whitelist.
    return chord !== null && validContextToolArgs("press_key", { ...destination, ...chord });
  }
  if (name === "move_cursor") return isExactKeys(args, ["scope", "x", "y"]) && args["scope"] === "desktop"
    && typeof args["x"] === "number" && Number.isFinite(args["x"]) && args["x"] >= 0
    && typeof args["y"] === "number" && Number.isFinite(args["y"]) && args["y"] >= 0;
  // Validate optional synthesis pacing once, then check the same destination
  // grammar. AX delivery can ignore pacing; never clamp a caller's request.
  if (name === "type_text" && "delay_ms" in args) {
    const { delay_ms: delay, ...withoutDelay } = args;
    return typeof delay === "number" && Number.isInteger(delay) && delay >= 0 && delay <= CUA_TYPE_TEXT_MAX_DELAY_MS
      && validContextToolArgs(name, withoutDelay);
  }
  if (args["scope"] === "desktop" && name === "type_text") {
    return isExactKeys(args, ["scope", "text"]) && typeof args["text"] === "string";
  }
  if (args["scope"] === "desktop" && name === "press_key") {
    return isExactKeys(args, ["key", "modifiers", "scope"])
      && typeof args["key"] === "string" && CUA_MACOS_KEY_PATTERN.test(args["key"])
      && Array.isArray(args["modifiers"]) && args["modifiers"].every((modifier) => typeof modifier === "string" && CUA_MACOS_SEMANTIC_MODIFIERS.has(modifier))
      && new Set(args["modifiers"] as readonly string[]).size === args["modifiers"].length;
  }
  if (name === "list_apps") return isExactKeys(args, []);
  if (name === "list_windows") return validListWindowsArgs(args);
  if (name === "launch_app") return validLaunchApplicationArgs(args);
  if (name === "get_window_state") return validGetWindowStateArgs(args);
  if (name === "bring_to_front") return isExactKeys(args, ["pid", "window_id"])
    && typeof args["pid"] === "number" && Number.isSafeInteger(args["pid"]) && args["pid"] > 0
    && typeof args["window_id"] === "number" && Number.isSafeInteger(args["window_id"]) && args["window_id"] > 0;
  if (name === "invoke_menu") return isExactKeys(args, ["path", "pid", "window_id"])
    && typeof args["pid"] === "number" && Number.isSafeInteger(args["pid"]) && args["pid"] > 0
    && typeof args["window_id"] === "number" && Number.isSafeInteger(args["window_id"]) && args["window_id"] > 0
    // Bounds mirror Cua's live schema exactly; native identifiers and
    // dispatch remain Host-private for both generic menu actions and the
    // verified create-window composition.
    && Array.isArray(args["path"])
    && args["path"].length >= 1
    && args["path"].length <= 16
    && args["path"].every((segment) => typeof segment === "string"
      && segment.length >= 1
      && segment.length <= 200
      && segment.trim() === segment
      && hasSafeNativeMenuLabelCharacters(segment));
  if (name === "set_window_frame") return isExactKeys(args, ["height", "pid", "width", "window_id", "x", "y"])
    && typeof args["pid"] === "number" && Number.isSafeInteger(args["pid"]) && args["pid"] > 0
    && typeof args["window_id"] === "number" && Number.isSafeInteger(args["window_id"]) && args["window_id"] > 0
    && typeof args["x"] === "number" && Number.isFinite(args["x"])
    && typeof args["y"] === "number" && Number.isFinite(args["y"])
    && typeof args["width"] === "number" && Number.isFinite(args["width"]) && args["width"] > 0
    && typeof args["height"] === "number" && Number.isFinite(args["height"]) && args["height"] > 0;
  // CUA-LAB-0049's element route is deliberately distinct from historical
  // window-scoped Word/basic input.  The exact Cua token stays host-private;
  // it is never a semantic target reference or receipt field.
  if (name === "type_text") return (
    isExactKeys(args, ["delivery_mode", "element_token", "pid", "text", "window_id"])
    && typeof args["element_token"] === "string" && args["element_token"].length > 0
    && typeof args["text"] === "string"
    && typeof args["pid"] === "number" && Number.isSafeInteger(args["pid"]) && args["pid"] > 0
    && typeof args["window_id"] === "number" && Number.isSafeInteger(args["window_id"]) && args["window_id"] > 0
    && (args["delivery_mode"] === "background" || args["delivery_mode"] === "foreground")
  ) || (
    isExactKeys(args, ["delivery_mode", "pid", "scope", "text", "window_id"])
    && typeof args["text"] === "string"
    && typeof args["pid"] === "number" && Number.isSafeInteger(args["pid"]) && args["pid"] > 0
    && typeof args["window_id"] === "number" && Number.isSafeInteger(args["window_id"]) && args["window_id"] > 0
    && args["scope"] === "window"
    && (args["delivery_mode"] === "background" || args["delivery_mode"] === "foreground")
  ) || (
    isExactKeys(args, ["delivery_mode", "pid", "text", "window_id", "x", "y"])
    && typeof args["text"] === "string"
    && typeof args["pid"] === "number" && Number.isSafeInteger(args["pid"]) && args["pid"] > 0
    && typeof args["window_id"] === "number" && Number.isSafeInteger(args["window_id"]) && args["window_id"] > 0
    && typeof args["x"] === "number" && Number.isFinite(args["x"]) && args["x"] >= 0
    && typeof args["y"] === "number" && Number.isFinite(args["y"]) && args["y"] >= 0
    && (args["delivery_mode"] === "background" || args["delivery_mode"] === "foreground")
  );
  if (name === "set_value") return isExactKeys(args, ["element_token", "pid", "value", "window_id"])
    && typeof args["element_token"] === "string" && args["element_token"].length > 0
    && typeof args["value"] === "string"
    && typeof args["pid"] === "number" && Number.isSafeInteger(args["pid"]) && args["pid"] > 0
    && typeof args["window_id"] === "number" && Number.isSafeInteger(args["window_id"]) && args["window_id"] > 0;
  if (name === "scroll") {
    const shared = (args["direction"] === "up" || args["direction"] === "down" || args["direction"] === "left" || args["direction"] === "right")
      && typeof args["amount"] === "number" && Number.isSafeInteger(args["amount"]) && args["amount"] >= 1 && args["amount"] <= 50
      && (args["by"] === "line" || args["by"] === "page");
    const point = typeof args["x"] === "number" && Number.isFinite(args["x"]) && args["x"] >= 0
      && typeof args["y"] === "number" && Number.isFinite(args["y"]) && args["y"] >= 0;
    if (args["scope"] === "desktop") return shared && point
      && isExactKeys(args, ["amount", "by", "direction", "scope", "x", "y"]);
    return shared
      && typeof args["pid"] === "number" && Number.isSafeInteger(args["pid"]) && args["pid"] > 0
      && typeof args["window_id"] === "number" && Number.isSafeInteger(args["window_id"]) && args["window_id"] > 0
      && (args["delivery_mode"] === "background" || args["delivery_mode"] === "foreground") && (
      (isExactKeys(args, ["amount", "by", "delivery_mode", "direction", "element_token", "pid", "window_id"])
        && typeof args["element_token"] === "string" && args["element_token"].length > 0)
      || (isExactKeys(args, ["amount", "by", "delivery_mode", "direction", "pid", "window_id", "x", "y"])
        && point)
    );
  }
  if (name === "click" || name === "right_click" || name === "double_click") {
    const shared = typeof args["pid"] === "number" && Number.isSafeInteger(args["pid"]) && args["pid"] > 0
      && typeof args["window_id"] === "number" && Number.isSafeInteger(args["window_id"]) && args["window_id"] > 0
      && (args["delivery_mode"] === "background" || args["delivery_mode"] === "foreground");
    return shared && (
      (isExactKeys(args, ["delivery_mode", "element_token", "pid", "window_id", ...["action", "button", "modifier"].filter((key) => args[key] !== undefined)])
        && validPixelClickOptions(args)
        && (name === "click" || args["button"] === undefined && args["modifier"] === undefined)
        && (args["action"] === undefined || name === "click" && typeof args["action"] === "string" && CUA_NATIVE_CLICK_ACTIONS.has(args["action"]))
        && typeof args["element_token"] === "string" && args["element_token"].length > 0)
      || (name === "click" && isExactKeys(args, ["delivery_mode", "pid", "window_id", "x", "y", ...["button", "count", "modifier"].filter((key) => args[key] !== undefined)])
        && validPixelClickOptions(args)
        && typeof args["x"] === "number" && Number.isFinite(args["x"]) && args["x"] >= 0
        && typeof args["y"] === "number" && Number.isFinite(args["y"]) && args["y"] >= 0)
    );
  }
  if (name === "drag") {
    const desktop = args["scope"] === "desktop";
    const keys = ["from_x", "from_y", "to_x", "to_y", ...(desktop ? ["scope"] : ["pid", "window_id", "delivery_mode"]),
      ...["duration_ms", "steps", "button", "modifier"].filter((key) => args[key] !== undefined)];
    return isExactKeys(args, keys)
      && (desktop || typeof args["pid"] === "number" && Number.isSafeInteger(args["pid"]) && args["pid"] > 0
        && typeof args["window_id"] === "number" && Number.isSafeInteger(args["window_id"]) && args["window_id"] > 0
        && (args["delivery_mode"] === "foreground" || args["delivery_mode"] === "background"))
      && ["from_x", "from_y", "to_x", "to_y"].every((key) => typeof args[key] === "number" && Number.isFinite(args[key]) && args[key] >= 0)
      && validPixelClickOptions(args)
      && (args["duration_ms"] === undefined || typeof args["duration_ms"] === "number" && Number.isSafeInteger(args["duration_ms"]) && args["duration_ms"] >= 0 && args["duration_ms"] <= CUA_DRAG_MAX_DURATION_MS)
      && (args["steps"] === undefined || typeof args["steps"] === "number" && Number.isSafeInteger(args["steps"]) && args["steps"] >= 1 && args["steps"] <= CUA_DRAG_MAX_STEPS);
  }
  if (name === "press_key") return ((isExactKeys(args, ["delivery_mode", "key", "modifiers", "pid", "scope", "window_id"]) && args["scope"] === "window"
      || isExactKeys(args, ["delivery_mode", "element_token", "key", "modifiers", "pid", "window_id"])
        && typeof args["element_token"] === "string" && args["element_token"].length > 0)
    && typeof args["key"] === "string" && CUA_MACOS_KEY_PATTERN.test(args["key"])
    && Array.isArray(args["modifiers"]) && args["modifiers"].every((modifier) => typeof modifier === "string" && CUA_MACOS_SEMANTIC_MODIFIERS.has(modifier))
    && new Set(args["modifiers"] as readonly string[]).size === args["modifiers"].length
    && typeof args["pid"] === "number" && Number.isSafeInteger(args["pid"]) && args["pid"] > 0
    && typeof args["window_id"] === "number" && Number.isSafeInteger(args["window_id"]) && args["window_id"] > 0
    && (args["delivery_mode"] === "background" || args["delivery_mode"] === "foreground"))
    || (isExactKeys(args, ["delivery_mode", "key", "modifiers", "pid", "window_id", "x", "y"])
      && typeof args["key"] === "string" && CUA_MACOS_KEY_PATTERN.test(args["key"])
      && Array.isArray(args["modifiers"]) && args["modifiers"].every((modifier) => typeof modifier === "string" && CUA_MACOS_SEMANTIC_MODIFIERS.has(modifier))
      && new Set(args["modifiers"] as readonly string[]).size === args["modifiers"].length
      && typeof args["pid"] === "number" && Number.isSafeInteger(args["pid"]) && args["pid"] > 0
      && typeof args["window_id"] === "number" && Number.isSafeInteger(args["window_id"]) && args["window_id"] > 0
      && typeof args["x"] === "number" && Number.isFinite(args["x"]) && args["x"] >= 0
      && typeof args["y"] === "number" && Number.isFinite(args["y"]) && args["y"] >= 0
      && (args["delivery_mode"] === "background" || args["delivery_mode"] === "foreground"));
  // The qualified handoff fixes two stable samples within two seconds; the
  // model never chooses provider scheduling, screenshots, or sessions.
  return isExactKeys(args, ["expect", "include_screenshot", "pid", "stable_samples", "timeout_ms", "window_id"])
    && typeof args["pid"] === "number" && Number.isSafeInteger(args["pid"]) && args["pid"] > 0
    && typeof args["window_id"] === "number" && Number.isSafeInteger(args["window_id"]) && args["window_id"] > 0
    && Array.isArray(args["expect"]) && args["expect"].length >= 1
    && args["expect"].every(validVerifyPredicate)
    && args["timeout_ms"] === 2_000 && args["stable_samples"] === 2 && args["include_screenshot"] === false;
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Exact signed-0.23.2 browser shapes used by the Host contracts and live lab. */
export function validBrowserToolArgs(
  name: CuaBrowserToolName,
  args: Readonly<Record<string, unknown>>,
  expectedSessionId: string,
): boolean {
  if (name === "bring_to_front") {
    return isExactKeys(args, ["pid", "window_id"])
      && typeof args["pid"] === "number" && Number.isSafeInteger(args["pid"]) && args["pid"] > 0
      && typeof args["window_id"] === "number" && Number.isSafeInteger(args["window_id"]) && args["window_id"] > 0;
  }
  if (name === "list_windows") {
    return isExactKeys(args, ["pid"])
      && typeof args["pid"] === "number" && Number.isSafeInteger(args["pid"]) && args["pid"] > 0;
  }
  if (!nonemptyString(args["session"]) || args["session"] !== expectedSessionId) return false;
  if (name === "hotkey") {
    if (isExactKeys(args, ["delivery_mode", "keys", "pid", "session", "window_id"])) {
      return args["delivery_mode"] === "foreground"
        && Array.isArray(args["keys"]) && args["keys"].length === 2
        && args["keys"][0] === "cmd" && (args["keys"][1] === "t" || args["keys"][1] === "l")
        && typeof args["pid"] === "number" && Number.isSafeInteger(args["pid"]) && args["pid"] > 0
        && typeof args["window_id"] === "number" && Number.isSafeInteger(args["window_id"]) && args["window_id"] > 0;
    }
    return false;
  }
  if (name === "type_text") {
    return isExactKeys(args, ["delivery_mode", "pid", "session", "text", "window_id"])
      && args["delivery_mode"] === "foreground"
      && typeof args["pid"] === "number" && Number.isSafeInteger(args["pid"]) && args["pid"] > 0
      && typeof args["window_id"] === "number" && Number.isSafeInteger(args["window_id"]) && args["window_id"] > 0
      && typeof args["text"] === "string"
      && /^about:blank#nautilo-[a-z0-9_-]{43}$/u.test(args["text"]);
  }
  if (name === "press_key") {
    return isExactKeys(args, ["delivery_mode", "key", "modifiers", "pid", "session", "window_id"])
      && args["key"] === "return" && args["delivery_mode"] === "foreground"
      && typeof args["pid"] === "number" && Number.isSafeInteger(args["pid"]) && args["pid"] > 0
      && typeof args["window_id"] === "number" && Number.isSafeInteger(args["window_id"]) && args["window_id"] > 0
      && Array.isArray(args["modifiers"]) && args["modifiers"].length === 0;
  }
  if (name === "browser_prepare") {
    const strategy = typeof args["strategy"] === "object" && args["strategy"] !== null && !Array.isArray(args["strategy"])
      ? args["strategy"] as Readonly<Record<string, unknown>> : null;
    return isExactKeys(args, ["pid", "session", "strategy", "window_id"])
      && typeof args["pid"] === "number" && Number.isSafeInteger(args["pid"]) && args["pid"] > 0
      && typeof args["window_id"] === "number" && Number.isSafeInteger(args["window_id"]) && args["window_id"] > 0
      && strategy !== null && isExactKeys(strategy, ["kind"]) && strategy["kind"] === "existing_profile";
  }
  if (name === "get_browser_state") {
    if (isExactKeys(args, ["pid", "session", "window_id"])) {
      return typeof args["pid"] === "number" && Number.isSafeInteger(args["pid"]) && args["pid"] > 0
        && typeof args["window_id"] === "number" && Number.isSafeInteger(args["window_id"]) && args["window_id"] > 0;
    }
    const allowed = new Set(["continuation", "query", "scope_ref", "session", "snapshot_format", "tab_id", "target_id"]);
    return Object.keys(args).every((key) => allowed.has(key))
      && ["session", "snapshot_format", "tab_id", "target_id"].every((key) => Object.hasOwn(args, key))
      && args["snapshot_format"] === "semantic_v2"
      && nonemptyString(args["target_id"])
      && nonemptyString(args["tab_id"])
      && (args["query"] === undefined || nonemptyString(args["query"]))
      && (args["scope_ref"] === undefined || nonemptyString(args["scope_ref"]))
      && (args["continuation"] === undefined || nonemptyString(args["continuation"]));
  }
  if (name === "browser_navigate") {
    if (!isExactKeys(args, ["session", "tab_id", "target_id", "url"])
      || !nonemptyString(args["target_id"])
      || !nonemptyString(args["tab_id"])
      || !nonemptyString(args["url"])) return false;
    try {
      const url = new URL(args["url"]);
      return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "about:";
    } catch { return false; }
  }
  if (name === "browser_click") {
    return isExactKeys(args, ["input_route", "ref", "session", "tab_id", "target_id"])
      && nonemptyString(args["target_id"])
      && nonemptyString(args["tab_id"])
      && nonemptyString(args["ref"])
      && (args["input_route"] === "trusted" || args["input_route"] === "dom_event");
  }
  if (name === "browser_type") return isExactKeys(args, ["mode", "ref", "replace", "session", "tab_id", "target_id", "text"])
    && nonemptyString(args["target_id"])
    && nonemptyString(args["tab_id"])
    && nonemptyString(args["ref"])
    && typeof args["text"] === "string"
    && (args["mode"] === "insert_text" || args["mode"] === "keystrokes")
    && typeof args["replace"] === "boolean";
  if (name === "browser_pointer") {
    if (!nonemptyString(args["target_id"]) || !nonemptyString(args["tab_id"])
      || !nonemptyString(args["ref"]) || !["hover", "right_click", "double_click", "scroll", "drag"].includes(String(args["action"]))
      || (args["input_route"] !== "trusted" && args["input_route"] !== "dom_event")) return false;
    if (args["action"] === "scroll") return isExactKeys(args, ["action", "delta_x", "delta_y", "input_route", "ref", "session", "tab_id", "target_id"])
      && typeof args["delta_x"] === "number" && Number.isFinite(args["delta_x"])
      && typeof args["delta_y"] === "number" && Number.isFinite(args["delta_y"])
      && (args["delta_x"] !== 0 || args["delta_y"] !== 0);
    if (args["action"] === "drag") return isExactKeys(args, ["action", "destination_ref", "input_route", "ref", "session", "tab_id", "target_id"])
      && nonemptyString(args["destination_ref"]);
    return isExactKeys(args, ["action", "input_route", "ref", "session", "tab_id", "target_id"]);
  }
  if (!nonemptyString(args["target_id"]) || !nonemptyString(args["tab_id"])
    || !["inspect", "accept", "dismiss"].includes(String(args["action"]))) return false;
  if (args["action"] === "inspect") return isExactKeys(args, ["action", "session", "tab_id", "target_id"]);
  if (!nonemptyString(args["dialog_id"])
    || (args["delivery_mode"] !== "background" && args["delivery_mode"] !== "foreground")) return false;
  if (args["action"] === "accept" && args["prompt_text"] !== undefined) {
    return isExactKeys(args, ["action", "delivery_mode", "dialog_id", "prompt_text", "session", "tab_id", "target_id"])
      && typeof args["prompt_text"] === "string";
  }
  return isExactKeys(args, ["action", "delivery_mode", "dialog_id", "session", "tab_id", "target_id"]);
}

type DesktopCaptureFacts = Readonly<{
  nativeWidth: number;
  nativeHeight: number;
  screenWidth: number;
  screenHeight: number;
  scaleFactor: number;
}>;

function positiveSafe(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function positiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * The pinned desktop-state ToolResult is intentionally narrower than a
 * generic provider ToolResult. Cua writes pixels to our already-open file;
 * no image block, base64, alternate path, or provider diagnostic is allowed
 * across this boundary.
 */
type DesktopCaptureParse =
  | Readonly<{ ok: true; facts: DesktopCaptureFacts }>
  | Readonly<{ ok: false; predicate: CuaCaptureValuePredicate }>;

function desktopCaptureFacts(value: unknown, expectedPath: string): DesktopCaptureParse {
  const mismatch = (predicate: CuaCaptureValuePredicate): DesktopCaptureParse => ({ ok: false, predicate });
  const result = object(daemonResult(value));
  if (result === null || !isExactKeys(result, ["content", "structuredContent"]) || !Array.isArray(result["content"])
    || result["content"].length !== 1) return mismatch("envelope");
  const content = object(result["content"][0]);
  if (content === null || !isExactKeys(content, ["text", "type"]) || content["type"] !== "text" || typeof content["text"] !== "string") return mismatch("content_block");
  const structured = object(result["structuredContent"]);
  if (structured === null || !isExactKeys(structured, [
    "display", "platform", "scale_factor", "screen_height", "screen_width", "screenshot_file_path",
    "screenshot_height", "screenshot_mime_type", "screenshot_width",
  ])) return mismatch("structured_keys");
  if (structured["platform"] !== "macos") return mismatch("platform");
  if (structured["display"] !== "primary") return mismatch("display");
  if (!positiveSafe(structured["screen_width"])) return mismatch("screen_width");
  if (!positiveSafe(structured["screen_height"])) return mismatch("screen_height");
  if (!positiveFinite(structured["scale_factor"])) return mismatch("scale_factor");
  if (!positiveSafe(structured["screenshot_width"])) return mismatch("screenshot_width");
  if (!positiveSafe(structured["screenshot_height"])) return mismatch("screenshot_height");
  if (structured["screenshot_mime_type"] !== "image/png") return mismatch("mime");
  if (structured["screenshot_file_path"] !== expectedPath) return mismatch("path_equality");
  return {
    ok: true,
    facts: {
      nativeWidth: structured["screenshot_width"], nativeHeight: structured["screenshot_height"],
      screenWidth: structured["screen_width"], screenHeight: structured["screen_height"], scaleFactor: structured["scale_factor"],
    },
  };
}

type WindowCaptureParse =
  | Readonly<{
    ok: true;
    tool: CuaContextToolResult;
    image: Readonly<{ width: number; height: number }> | null;
  }>
  | Readonly<{ ok: false; predicate: CuaCaptureValuePredicate }>;

/**
 * Validate only the file-handoff facts here; the semantic adapter retains
 * ownership of the full get_window_state contract. The private pathname is
 * removed before the checked result leaves this supervisor.
 */
function windowCaptureFacts(value: unknown, expectedPath: string): WindowCaptureParse {
  const mismatch = (predicate: CuaCaptureValuePredicate): WindowCaptureParse => ({ ok: false, predicate });
  const tool = checkedToolResult(value);
  if (tool === null) return mismatch("envelope");
  if (tool.content.length !== 1 || tool.content[0]?.["type"] !== "text") return mismatch("content_block");
  const structured = tool.structuredContent;
  if (structured === null) return tool.isError
    ? { ok: true, tool, image: null }
    : mismatch("structured_keys");
  if (tool.isError) {
    if (Object.hasOwn(structured, "screenshot_file_path")) return mismatch("path_equality");
    return { ok: true, tool, image: null };
  }
  if (structured["screenshot_frame_valid"] === false) {
    if (Object.hasOwn(structured, "screenshot_file_path")) return mismatch("path_equality");
    return { ok: true, tool, image: null };
  }
  if (structured["screenshot_frame_valid"] !== true) return mismatch("structured_keys");
  if (structured["screenshot_file_path"] !== expectedPath) return mismatch("path_equality");
  if (structured["screenshot_mime_type"] !== "image/png") return mismatch("mime");
  if (!positiveSafe(structured["screenshot_width"])) return mismatch("screenshot_width");
  if (!positiveSafe(structured["screenshot_height"])) return mismatch("screenshot_height");
  const sanitized = { ...structured };
  delete sanitized["screenshot_file_path"];
  return {
    ok: true,
    tool: { ...tool, structuredContent: sanitized },
    image: { width: structured["screenshot_width"], height: structured["screenshot_height"] },
  };
}

function desktopClickFacts(value: unknown): Readonly<{
  effect: "unverifiable";
  route: "global_input";
  delivery: "not_applicable";
}> | null {
  const result = object(daemonResult(value));
  if (result === null || !isExactKeys(result, ["content", "structuredContent"]) || !Array.isArray(result["content"])
    || result["content"].length !== 1) return null;
  const content = object(result["content"][0]);
  if (content === null || !isExactKeys(content, ["text", "type"]) || content["type"] !== "text" || typeof content["text"] !== "string") return null;
  const structured = object(result["structuredContent"]);
  const delivery = structured === null ? null : object(structured["delivery"]);
  if (structured === null || !isExactKeys(structured, ["delivery", "effect", "route"])
    || structured["effect"] !== "unverifiable" || structured["route"] !== "global_input"
    || delivery === null || !isExactKeys(delivery, ["mode"]) || delivery["mode"] !== "not_applicable") return null;
  return { effect: "unverifiable", route: "global_input", delivery: "not_applicable" };
}

function sameCaptureIdentity(left: CuaCaptureFileStat, right: CuaCaptureFileStat): boolean {
  return left.kind === "file" && right.kind === "file" && left.uid === right.uid && left.mode === right.mode
    && left.device === right.device && left.inode === right.inode && left.nlink === right.nlink;
}

function safeCaptureIdentity(stat: CuaCaptureFileStat, expectedUid: number): boolean {
  return stat.kind === "file" && stat.uid === BigInt(expectedUid) && stat.mode === 0o600 && stat.nlink === 1n;
}

function sameRuntimeIdentity(left: CuaSocketStat, right: CuaSocketStat | null, expectedUid: number): boolean {
  return right?.kind === "directory" && right.mode === 0o700 && right.uid === expectedUid
    && left.kind === "directory" && left.device === right.device && left.inode === right.inode;
}

function successfulStructuredContent(value: unknown): Readonly<Record<string, unknown>> | null {
  const tool = successfulToolResult(value);
  return tool === null ? null : object(tool["structuredContent"]);
}

const CUA_MACOS_HEALTH_CHECKS = [
  "binary_version",
  "platform_supported",
  "session_active",
  "bundle_identity",
  "tcc_accessibility",
  "tcc_screen_recording",
  "ax_capability",
  "screen_capture_capability",
] as const;

type CuaHealthCheckName = typeof CUA_MACOS_HEALTH_CHECKS[number];
type CuaHealthCheckStatus = "pass" | "fail" | "skip";

function validHealthData(value: unknown): boolean {
  const data = object(value);
  if (data === null) return false;
  const allowed = new Set([
    "architecture", "bundle_identifier", "display_count", "error_detail", "executable_path", "os_version",
  ]);
  if (Object.keys(data).some((key) => !allowed.has(key))) return false;
  for (const key of ["architecture", "bundle_identifier", "error_detail", "executable_path", "os_version"] as const) {
    if (key in data && (typeof data[key] !== "string" || data[key].length === 0)) return false;
  }
  return !("display_count" in data)
    || typeof data["display_count"] === "number" && Number.isSafeInteger(data["display_count"]) && data["display_count"] >= 0;
}

function healthCheckStatus(value: unknown, expectedName: CuaHealthCheckName): CuaHealthCheckStatus | null {
  const entry = object(value);
  if (entry === null || typeof entry["message"] !== "string" || entry["message"].length === 0
    || entry["name"] !== expectedName || !["pass", "fail", "skip"].includes(String(entry["status"]))) return null;
  const status = entry["status"] as CuaHealthCheckStatus;
  const expectedKeys = ["message", "name", "status"];
  if (status === "fail") {
    if (typeof entry["hint"] !== "string" || entry["hint"].length === 0) return null;
    expectedKeys.push("hint");
  } else if ("hint" in entry) {
    return null;
  }
  if ("data" in entry) {
    if (!validHealthData(entry["data"])) return null;
    expectedKeys.push("data");
  }
  return isExactKeys(entry, expectedKeys) ? status : null;
}

/**
 * Parse the pinned schema_version=1 macOS report. The standalone
 * bundle_identity diagnostic is non-core upstream and is expected to fail
 * when the exact embedded child runs in Nautilo's responsibility chain.
 * Every other failure remains unavailable, and malformed/widened bytes fence.
 */
function safeStatus(value: unknown): "ready" | "degraded" | null {
  const report = object(value);
  if (report === null || !isExactKeys(report, ["checks", "driver_version", "overall", "platform", "schema_version"])
    || report["schema_version"] !== "1" || report["platform"] !== "darwin"
    || report["driver_version"] !== CUA_DRIVER_VERSION || !Array.isArray(report["checks"])
    || report["checks"].length !== CUA_MACOS_HEALTH_CHECKS.length) return null;
  const statuses = new Map<CuaHealthCheckName, CuaHealthCheckStatus>();
  for (const [index, name] of CUA_MACOS_HEALTH_CHECKS.entries()) {
    const status = healthCheckStatus(report["checks"][index], name);
    if (status === null) return null;
    statuses.set(name, status);
  }
  const failures = CUA_MACOS_HEALTH_CHECKS.filter((name) => statuses.get(name) === "fail");
  const coreFailed = failures.some((name) => name === "binary_version" || name === "platform_supported" || name === "session_active");
  const expectedOverall = coreFailed ? "failed" : failures.length > 0 ? "degraded" : "ok";
  if (report["overall"] !== expectedOverall) return null;
  const embeddedReady = statuses.get("binary_version") === "pass"
    && statuses.get("platform_supported") === "pass"
    && statuses.get("session_active") === "pass"
    && (statuses.get("bundle_identity") === "pass" || statuses.get("bundle_identity") === "fail")
    && statuses.get("tcc_accessibility") === "pass"
    && statuses.get("tcc_screen_recording") === "pass"
    && statuses.get("ax_capability") === "pass"
    && statuses.get("screen_capture_capability") === "skip"
    && failures.every((name) => name === "bundle_identity");
  return embeddedReady ? "ready" : "degraded";
}

function permissionStatus(
  value: unknown,
  expectedPid: number,
  expectedExecutable: string,
  expectedHostBundleId: string,
): "ready" | "unavailable" | null {
  const permission = object(value);
  if (permission === null || !isExactKeys(permission, [
    "accessibility", "direct_capture_error", "direct_capture_status", "screen_recording",
    "screen_recording_capturable", "source",
  ]) || typeof permission["accessibility"] !== "boolean" || typeof permission["screen_recording"] !== "boolean"
    || permission["screen_recording_capturable"] !== null || permission["direct_capture_status"] !== "not_checked"
    || permission["direct_capture_error"] !== null) return null;
  const source = object(permission["source"]);
  if (source === null || !isExactKeys(source, [
    "attribution", "direct_runtime", "disclaim_env", "embedded", "executable", "host_bundle_id",
    "note", "pid", "responsible_ppid",
  ]) || source["attribution"] !== "host" || source["host_bundle_id"] !== expectedHostBundleId
    || source["embedded"] !== true || source["direct_runtime"] !== false || source["disclaim_env"] !== false
    || source["pid"] !== expectedPid || source["executable"] !== expectedExecutable
    || typeof source["responsible_ppid"] !== "number" || !Number.isSafeInteger(source["responsible_ppid"])
    || source["responsible_ppid"] <= 0 || typeof source["note"] !== "string" || source["note"].length === 0) return null;
  return permission["accessibility"] && permission["screen_recording"] ? "ready" : "unavailable";
}

function contextKey(scope: ComputerUseContextScope): string {
  // Server-issued scope only: no model supplied strings participate in the
  // session identity. The raw identifiers never leave the host process.
  return createHash("sha256").update(JSON.stringify([
    scope.computerUseContextId, scope.installationEpoch, scope.grantGeneration,
    scope.provider, scope.providerGeneration, scope.originHumanId,
    scope.originRunId, scope.originAgentId, scope.lineageId, scope.serverBindingId,
    scope.relayId, scope.pairingGeneration, scope.desktopSessionId,
  ])).digest("base64url");
}

function equalIdentity(left: CuaSocketStat, right: CuaSocketStat): boolean {
  return left.kind === "socket" && right.kind === "socket" && left.device === right.device && left.inode === right.inode;
}

function childExited(child: CuaChild): boolean {
  return child.exited === true || child.exitCode !== undefined && child.exitCode !== null;
}

function linkAbort(source: AbortSignal | undefined, target: AbortController): () => void {
  if (source === undefined) return () => {};
  if (source.aborted) {
    target.abort();
    return () => {};
  }
  const onAbort = () => target.abort();
  source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
}

/**
 * Owns one embedded Cua daemon generation. Electron main may admit only the
 * exact generation established by an explicit Connections Check; constructing
 * this supervisor alone never makes Cua available to agents.
 */
export class CuaSupervisor {
  private readonly options: Required<Pick<CuaSupervisorOptions, "hostBundleId" | "spawn" | "filesystem" | "captureFilesystem" | "transport" | "randomBytes" | "sleep" | "beforeContextStart" | "onCaptureDiagnostic">> & CuaSupervisorOptions;
  private generation = 0;
  private active: ActiveGeneration | null = null;
  private starting: Promise<CuaSupervisorResult> | null = null;
  private startingAbort: AbortController | null = null;
  private readonly sessions = new Map<string, ActiveContextSession>();
  private readonly startingSessions = new Map<string, Promise<CuaContextStartResult>>();
  private readonly startingSessionAborts = new Map<string, AbortController>();
  private readonly startingSessionGenerations = new Map<string, number>();
  /** Cua's AX cache is daemon-global and keyed only by native pid/window. */
  private readonly windowReadLanes = new Map<string, Promise<void>>();
  private readonly outstandingOperations = new Map<string, Map<AbortSignal | undefined, Set<Promise<void>>>>();
  private sessionIncarnation = 0;
  private readonly expectedUid: number;
  private stopping: Promise<void> | null = null;
  private reaping: Promise<void> | null = null;
  private readonly invalidationListeners = new Set<() => void>();
  /** A failed force-kill leaves process ownership unknown; never overlap it. */
  private reapFailed = false;

  constructor(options: CuaSupervisorOptions) {
    this.options = {
      ...options,
      hostBundleId: options.hostBundleId ?? DEFAULT_HOST_BUNDLE_ID,
      spawn: options.spawn ?? defaultSpawn,
      filesystem: options.filesystem ?? defaultFilesystem,
      captureFilesystem: options.captureFilesystem ?? defaultCaptureFilesystem,
      transport: options.transport ?? cuaLineTransport,
      randomBytes: options.randomBytes ?? randomBytes,
      sleep: options.sleep ?? defaultSleep,
      beforeContextStart: options.beforeContextStart ?? (() => {}),
      onCaptureDiagnostic: options.onCaptureDiagnostic ?? (() => {}),
    };
    const uid = options.expectedUid ?? process.getuid?.();
    if (typeof uid !== "number" || !Number.isSafeInteger(uid) || uid < 0) throw new Error("cua supervisor requires a current-user uid");
    if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(this.options.hostBundleId) || this.options.hostBundleId.length > 255) {
      throw new Error("cua supervisor requires a valid build-bound host bundle id");
    }
    this.expectedUid = uid;
  }

  /** Coalesces global daemon startup and establishes no model or authority session. */
  ensureRunning(signal?: AbortSignal): Promise<CuaSupervisorResult> {
    if (signal?.aborted) return Promise.resolve({ ok: false, code: "cancelled" });
    if (this.stopping !== null || this.reaping !== null || this.reapFailed) return Promise.resolve({ ok: false, code: "context_fenced" });
    if (this.active !== null) return Promise.resolve({ ok: true, generation: this.active.opaqueId, health: this.active.health, healthFreshness: "startup_cached" });
    if (this.starting !== null) return this.forCaller(this.starting, signal);
    const startupAbort = new AbortController();
    const start = this.begin(startupAbort.signal);
    this.startingAbort = startupAbort;
    this.starting = start;
    const pending = this.starting.finally(() => {
      if (this.starting === pending) {
        this.starting = null;
        this.startingAbort = null;
      }
    });
    this.starting = pending;
    return this.forCaller(pending, signal);
  }

  /** Fresh, on-demand health; unlike ensureRunning's startup-cached status, this revalidates the exact live endpoint. */
  async refreshHealth(signal?: AbortSignal): Promise<CuaSupervisorResult> {
    const cached = await this.ensureRunning(signal);
    if (!cached.ok) return cached;
    const active = this.active;
    if (active === null || active.opaqueId !== cached.generation) return { ok: false, code: "stale_generation" };
    try {
      const permissions = successfulStructuredContent(await this.callOwned(active.socketPath, active.socketIdentity, {
        method: "call", name: "check_permissions", args: { prompt: false, probe_direct_capture: false },
      }, signal));
      const report = successfulStructuredContent(await this.callOwned(active.socketPath, active.socketIdentity, {
        method: "call", name: "health_report", args: {},
      }, signal));
      const spawnedPid = active.child.pid;
      const permission = permissions === null || typeof spawnedPid !== "number"
        ? null
        : permissionStatus(permissions, spawnedPid, this.options.binaryPath, this.options.hostBundleId);
      const status = report === null ? null : safeStatus(report);
      if (permission === null || status === null || this.active?.number !== active.number) {
        this.invalidateGeneration(active, true);
        return { ok: false, code: permission === null ? "permission_check_failed" : "health_check_failed" };
      }
      const health: CuaSupervisorHealth = { permission, health: status };
      this.active = { ...active, health };
      return { ok: true, generation: active.opaqueId, health, healthFreshness: "fresh" };
    } catch {
      this.invalidateGeneration(active, true);
      return { ok: false, code: "health_check_failed" };
    }
  }

  /** Read-only generation snapshot; this never refreshes, starts, or restarts. */
  existingHealthyGeneration(): string | null {
    const active = this.active;
    return active !== null && active.health.permission === "ready" && active.health.health === "ready"
      ? active.opaqueId
      : null;
  }

  /** Main lifecycle uses this to discard its readiness-checked token on child loss. */
  subscribeInvalidation(listener: () => void): () => void {
    this.invalidationListeners.add(listener);
    return () => this.invalidationListeners.delete(listener);
  }

  /** Starts one exact context-derived session on the shared, already-attested daemon generation. */
  async startContext(scope: ComputerUseContextScope, signal?: AbortSignal): Promise<CuaContextStartResult> {
    const ready = await this.refreshHealth(signal);
    if (!ready.ok) return ready;
    const active = this.active;
    if (active === null || active.opaqueId !== ready.generation) return { ok: false, code: "stale_generation" };
    return this.startContextOnActive(scope, active, ready, signal);
  }

  /**
   * Opens a host-derived session only on the already health-attested active
   * generation.  This deliberately does not refresh health, start a child,
   * or restart a lost child: Electron's explicit Connections Check owns those
   * transitions and route admission observes its result separately.
   */
  startContextExisting(
    scope: ComputerUseContextScope,
    expectedGeneration: string,
    signal?: AbortSignal,
  ): Promise<CuaContextStartResult> {
    if (signal?.aborted) return Promise.resolve({ ok: false, code: "cancelled" });
    if (this.stopping !== null || this.reaping !== null || this.reapFailed) {
      return Promise.resolve({ ok: false, code: "context_fenced" });
    }
    const active = this.active;
    if (active === null || active.opaqueId !== expectedGeneration
      || active.health.permission !== "ready" || active.health.health !== "ready") {
      return Promise.resolve({ ok: false, code: "context_fenced" });
    }
    return this.startContextOnActive(scope, active, {
      ok: true,
      generation: active.opaqueId,
      health: active.health,
      healthFreshness: "startup_cached",
    }, signal);
  }

  private async startContextOnActive(
    scope: ComputerUseContextScope,
    activeGeneration: ActiveGeneration,
    ready: Extract<CuaSupervisorResult, { readonly ok: true }>,
    signal?: AbortSignal,
  ): Promise<CuaContextStartResult> {
    const key = contextKey(scope);
    const existing = this.sessions.get(key);
    if (existing !== undefined && existing.generation === activeGeneration.number) {
      this.sessions.set(key, { ...existing, leases: existing.leases + 1 });
      return { ok: true, generation: ready.generation, sessionId: existing.sessionId, health: ready.health };
    }
    const pending = this.startingSessions.get(key);
    if (pending !== undefined) return this.acquireStartingContext(key, pending, signal);
    // Capture before creating the promise/map entries. `beginContext` receives
    // this exact generation and will fail closed if child death lands at the
    // following narrow seam; its finally remains installed either way.
    const sessionAbort = new AbortController();
    const unlinkInitiatorAbort = linkAbort(signal, sessionAbort);
    this.options.beforeContextStart();
    const start = this.beginContext(key, ready, activeGeneration, sessionAbort.signal);
    this.startingSessions.set(key, start);
    this.startingSessionAborts.set(key, sessionAbort);
    this.startingSessionGenerations.set(key, activeGeneration.number);
    const settled = start.finally(() => {
      if (this.startingSessions.get(key) === settled) {
        this.startingSessions.delete(key);
        this.startingSessionAborts.delete(key);
        this.startingSessionGenerations.delete(key);
      }
      unlinkInitiatorAbort();
    });
    this.startingSessions.set(key, settled);
    return this.forContextCaller(settled, signal);
  }

  /**
   * Calls one reviewed tool through the exact socket inode previously
   * attested for an existing healthy generation.  It is intentionally not a
   * generic daemon RPC escape hatch.
   */
  callContextTool(
    scope: ComputerUseContextScope,
    expectedGeneration: string,
    name: CuaContextToolName,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    onProviderDispatch?: () => boolean | Promise<boolean>,
  ): Promise<CuaContextToolCallResult> {
    if (!validContextToolArgs(name, args)) return Promise.resolve({ ok: false, code: "invalid_configuration", stage: "tool" });
    if (name === "get_window_state") {
      const pid = args["pid"] as number;
      const windowId = args["window_id"] as number;
      return this.serializeWindowRead(scope, expectedGeneration, pid, windowId, signal,
        () => this.callContextToolDirect(scope, expectedGeneration, name, args, signal, onProviderDispatch, true),
        () => ({ ok: false, code: "cancelled", stage: "tool" }),
        async (abandoned) => {
          if (abandoned.ok) await this.endContextLease(scope, abandoned.generation, abandoned.sessionId);
        });
    }
    const internal = this.callContextToolDirect(scope, expectedGeneration, name, args, signal, onProviderDispatch, true);
    const delivery = Promise.withResolvers<void>();
    this.trackOutstandingOperation(scope, expectedGeneration, signal, Promise.all([internal, delivery.promise]));
    return this.forToolCaller(internal, signal, async (abandoned) => {
      if (abandoned.ok) await this.endContextLease(scope, abandoned.generation, abandoned.sessionId);
    }, delivery.resolve);
  }

  private async callContextToolDirect(
    scope: ComputerUseContextScope,
    expectedGeneration: string,
    name: CuaContextToolName,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    onProviderDispatch: (() => boolean | Promise<boolean>) | undefined,
    drainAfterDispatch: boolean,
  ): Promise<CuaContextToolCallResult> {
    const started = await this.startContextExisting(scope, expectedGeneration, signal);
    if (!started.ok) return { ok: false, code: started.code, stage: "session" };
    const releaseLease = () => this.endContextLease(scope, started.generation, started.sessionId);
    const active = this.active;
    if (active === null || active.opaqueId !== started.generation) {
      await releaseLease();
      return { ok: false, code: "stale_generation", stage: "tool" };
    }
    try {
      if (signal?.aborted || this.active?.number !== active.number || this.active.opaqueId !== started.generation) {
        await releaseLease();
        return { ok: false, code: signal?.aborted ? "cancelled" : "stale_generation", stage: "tool" };
      }
      // This is the last host-side linearization point before the owned
      // transport call.  It lets a one-shot semantic authority be consumed
      // only after session/generation/abort checks have all succeeded.
      if (onProviderDispatch !== undefined && !await onProviderDispatch()) {
        await releaseLease();
        return { ok: false, code: "context_fenced", stage: "tool" };
      }
      // The callback may itself perform an awaited host-side safety check
      // (the drag path samples the persistent Human-input epoch here).  Do
      // not let cancellation or generation replacement during that await
      // leak across the actual provider transport boundary.
      if (signal?.aborted || this.active?.number !== active.number || this.active.opaqueId !== started.generation) {
        await releaseLease();
        return { ok: false, code: signal?.aborted ? "cancelled" : "stale_generation", stage: "tool" };
      }
      const tool = checkedToolResult(await this.callOwned(active.socketPath, active.socketIdentity, {
        method: "call", name, args, session_id: started.sessionId,
      }, signal, { drainAfterDispatch }));
      if (tool === null) {
        await releaseLease();
        this.invalidateGeneration(active, true);
        return { ok: false, code: "context_fenced", stage: "tool" };
      }
      if (signal?.aborted || this.active?.number !== active.number || this.active.opaqueId !== started.generation) {
        await releaseLease();
        return { ok: false, code: signal?.aborted ? "cancelled" : "stale_generation", stage: "tool" };
      }
      return { ok: true, generation: started.generation, sessionId: started.sessionId, result: tool };
    } catch (error) {
      await releaseLease();
      if (!isAbort(error)) this.invalidateGeneration(active, true);
      return { ok: false, code: isAbort(error) ? "cancelled" : "context_fenced", stage: "tool" };
    }
  }

  private serializeWindowRead<T>(
    scope: ComputerUseContextScope,
    expectedGeneration: string,
    pid: number,
    windowId: number,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
    cancelled: () => T,
    discardAbandoned: (value: T) => void | Promise<void>,
  ): Promise<T> {
    const key = `${expectedGeneration}:${pid}:${windowId}`;
    const prior = this.windowReadLanes.get(key) ?? Promise.resolve();
    const internal = prior.catch(() => undefined).then(operation);
    const drained = internal.then(() => undefined, () => undefined);
    this.windowReadLanes.set(key, drained);
    void drained.then(() => {
      if (this.windowReadLanes.get(key) === drained) this.windowReadLanes.delete(key);
    });
    if (signal === undefined) {
      this.trackOutstandingOperation(scope, expectedGeneration, signal, internal);
      return internal;
    }
    const delivery = Promise.withResolvers<void>();
    this.trackOutstandingOperation(scope, expectedGeneration, signal, Promise.all([internal, delivery.promise]));
    return new Promise<T>((resolve, reject) => {
      let callerCancelled = false;
      const discard = async (value: T): Promise<void> => {
        await Promise.resolve(discardAbandoned(value)).catch(() => undefined);
      };
      if (signal.aborted) {
        callerCancelled = true;
        void internal.then(discard, () => undefined).finally(delivery.resolve);
        resolve(cancelled());
        return;
      }
      const onAbort = () => {
        callerCancelled = true;
        resolve(cancelled());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void internal.then((value) => {
        signal.removeEventListener("abort", onAbort);
        if (callerCancelled) {
          void discard(value).finally(delivery.resolve);
          return;
        }
        delivery.resolve();
        resolve(value);
      }, (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        delivery.resolve();
        reject(error instanceof Error ? error : new Error("window read failed"));
      });
    });
  }

  private outstandingKey(scope: ComputerUseContextScope, expectedGeneration: string): string {
    return `${expectedGeneration}:${contextKey(scope)}`;
  }

  private trackOutstandingOperation(scope: ComputerUseContextScope, expectedGeneration: string, requestSignal: AbortSignal | undefined, operation: Promise<unknown>): void {
    const key = this.outstandingKey(scope, expectedGeneration);
    const drained = operation.then(() => undefined, () => undefined);
    const byRequest = this.outstandingOperations.get(key) ?? new Map<AbortSignal | undefined, Set<Promise<void>>>();
    const pending = byRequest.get(requestSignal) ?? new Set<Promise<void>>();
    pending.add(drained);
    byRequest.set(requestSignal, pending);
    this.outstandingOperations.set(key, byRequest);
    void drained.then(() => {
      pending.delete(drained);
      if (pending.size === 0 && byRequest.get(requestSignal) === pending) byRequest.delete(requestSignal);
      if (byRequest.size === 0 && this.outstandingOperations.get(key) === byRequest) this.outstandingOperations.delete(key);
    });
  }

  async awaitOutstandingOperations(scope: ComputerUseContextScope, expectedGeneration: string, requestSignal?: AbortSignal): Promise<void> {
    const key = this.outstandingKey(scope, expectedGeneration);
    const pending = this.outstandingOperations.get(key)?.get(requestSignal);
    if (pending === undefined || pending.size === 0) return;
    await Promise.all([...pending]);
  }

  /**
   * Open one retained Host-derived lease for a browser contract. The caller
   * must release this exact generation/session pair; browser calls below do
   * not mint independent or model-named Cua sessions.
   */
  startBrowserContext(
    scope: ComputerUseContextScope,
    expectedGeneration: string,
    signal?: AbortSignal,
  ): Promise<CuaContextStartResult> {
    return this.startContextExisting(scope, expectedGeneration, signal);
  }

  /**
   * Call one reviewed browser primitive through an already-retained context.
   * The supplied `session` field must equal the supervisor-minted session ID;
   * the raw provider route remains bound to the checked socket inode.
   */
  callBrowserTool(
    scope: ComputerUseContextScope,
    expectedGeneration: string,
    sessionId: string,
    name: CuaBrowserToolName,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<CuaContextToolCallResult> {
    if (!validBrowserToolArgs(name, args, sessionId)) {
      return Promise.resolve({ ok: false, code: "invalid_configuration", stage: "tool" });
    }
    if (signal?.aborted) return Promise.resolve({ ok: false, code: "cancelled", stage: "tool" });
    const internal = this.callBrowserToolDirect(scope, expectedGeneration, sessionId, name, args, signal);
    const delivery = Promise.withResolvers<void>();
    this.trackOutstandingOperation(scope, expectedGeneration, signal, Promise.all([internal, delivery.promise]));
    return this.forToolCaller(internal, signal, undefined, delivery.resolve);
  }

  private async callBrowserToolDirect(
    scope: ComputerUseContextScope,
    expectedGeneration: string,
    sessionId: string,
    name: CuaBrowserToolName,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<CuaContextToolCallResult> {
    const active = this.active;
    const session = this.sessions.get(contextKey(scope));
    if (active === null || active.opaqueId !== expectedGeneration
      || active.health.permission !== "ready" || active.health.health !== "ready"
      || session === undefined || session.generation !== active.number
      || session.sessionId !== sessionId || session.leases < 1) {
      return { ok: false, code: "context_fenced", stage: "session" };
    }
    try {
      const tool = checkedToolResult(await this.callOwned(active.socketPath, active.socketIdentity, {
        method: "call", name, args, session_id: sessionId,
      }, signal, { drainAfterDispatch: true }));
      if (tool === null) {
        this.invalidateGeneration(active, true);
        return { ok: false, code: "context_fenced", stage: "tool" };
      }
      if (signal?.aborted || this.active?.number !== active.number
        || this.active.opaqueId !== expectedGeneration) {
        return { ok: false, code: signal?.aborted ? "cancelled" : "stale_generation", stage: "tool" };
      }
      return { ok: true, generation: expectedGeneration, sessionId, result: tool };
    } catch (error) {
      if (!isAbort(error)) this.invalidateGeneration(active, true);
      return { ok: false, code: isAbort(error) ? "cancelled" : "context_fenced", stage: "tool" };
    }
  }

  /** Named checked-generation seam: the only permissible Cua launch payload. */
  launchApplication(
    scope: ComputerUseContextScope,
    expectedGeneration: string,
    bundleId: string,
    signal?: AbortSignal,
  ): Promise<CuaContextToolCallResult> {
    return this.callContextTool(scope, expectedGeneration, "launch_app", { bundle_id: bundleId }, signal);
  }

  /** Named checked-generation seam: host-resolved window, never capture config. */
  getWindowState(
    scope: ComputerUseContextScope,
    expectedGeneration: string,
    pid: number,
    windowId: number,
    query?: string,
    signal?: AbortSignal,
    effort?: CuaWindowTraversalEffort,
  ): Promise<CuaContextToolCallResult> {
    // Cua's provider-side query projects only indexed/actionable rows. Static
    // text remains in its stable tree_markdown surface, so semantic search
    // takes one bounded full snapshot and the Host performs the private
    // projection. This avoids both false absence and a second provider read.
    void query;
    if (!validWindowTraversalEffort(effort)) {
      return Promise.resolve({ ok: false, code: "invalid_configuration", stage: "tool" });
    }
    return this.callContextTool(scope, expectedGeneration, "get_window_state", {
      pid, window_id: windowId, include_screenshot: false,
      ...windowTraversalArgs(effort),
    }, signal);
  }

  /**
   * Exact-window pixels use the same owned-file handoff as desktop capture.
   * The Cua control response therefore contains metadata only; PNG bytes can
   * never trip or widen the bounded line-delimited JSON transport.
   */
  captureWindowState(
    scope: ComputerUseContextScope,
    expectedGeneration: string,
    pid: number,
    windowId: number,
    signal?: AbortSignal,
    effort?: CuaWindowTraversalEffort,
  ): Promise<CuaWindowCaptureResult> {
    if (!positiveSafe(pid) || !positiveSafe(windowId)) return Promise.resolve({ ok: false, code: "invalid_configuration" });
    if (!validWindowTraversalEffort(effort)) return Promise.resolve({ ok: false, code: "invalid_configuration" });
    if (signal?.aborted) return Promise.resolve({ ok: false, code: "cancelled" });
    return this.serializeWindowRead(scope, expectedGeneration, pid, windowId, signal,
      () => this.captureWindowStateDirect(scope, expectedGeneration, pid, windowId, signal, effort),
      () => ({ ok: false, code: "cancelled" }),
      async (abandoned) => {
        if (!abandoned.ok) return;
        abandoned.png?.fill(0);
        await this.endContextLease(scope, abandoned.generation, abandoned.sessionId);
      });
  }

  private async captureWindowStateDirect(
    scope: ComputerUseContextScope,
    expectedGeneration: string,
    pid: number,
    windowId: number,
    signal?: AbortSignal,
    effort?: CuaWindowTraversalEffort,
  ): Promise<CuaWindowCaptureResult> {
    const started = await this.startContextExisting(scope, expectedGeneration, signal);
    if (!started.ok) return { ok: false, code: started.code };
    const releaseLease = () => this.endContextLease(scope, started.generation, started.sessionId);
    const active = this.active;
    if (active === null || active.opaqueId !== started.generation) {
      await releaseLease();
      return { ok: false, code: "stale_generation" };
    }
    let handle: CuaCaptureFileHandle | null = null;
    let owned: CuaCaptureFileStat | null = null;
    let path: string | null = null;
    let mustInvalidate = false;
    let result: CuaWindowCaptureResult | null = null;
    let stage: CuaCaptureDiagnostic["stage"] = "runtime_identity";
    const diagnose = (code: CuaCaptureDiagnostic["code"], predicate?: CuaCaptureValuePredicate): void => {
      try { this.options.onCaptureDiagnostic({ stage, code, ...(predicate === undefined ? {} : { predicate }) }); }
      catch { /* diagnostics cannot affect authority */ }
    };
    try {
      capture: {
        const runtime = await this.options.filesystem.lstat(this.options.runtimeDir);
        if (!sameRuntimeIdentity(active.runtimeIdentity, runtime, this.expectedUid)) {
          diagnose("context_fenced");
          mustInvalidate = true;
          result = { ok: false, code: "context_fenced" };
          break capture;
        }
        stage = "nonce";
        const nonce = this.options.randomBytes(24);
        if (nonce.byteLength !== 24) {
          diagnose("invalid_configuration");
          result = { ok: false, code: "invalid_configuration" };
          break capture;
        }
        path = join(this.options.runtimeDir, `capture_${Buffer.from(nonce).toString("base64url")}.png`);
        stage = "open";
        handle = await this.options.captureFilesystem.open(path, "wx+", 0o600);
        stage = "initial_identity";
        owned = await handle.stat();
        if (!safeCaptureIdentity(owned, this.expectedUid)) {
          diagnose("context_fenced");
          mustInvalidate = true;
          result = { ok: false, code: "context_fenced" };
          break capture;
        }
        if (signal?.aborted) {
          diagnose("cancelled");
          result = { ok: false, code: "cancelled" };
          break capture;
        }
        stage = "provider_call";
        const raw = await this.callOwned(active.socketPath, active.socketIdentity, {
          method: "call",
          name: "get_window_state",
          args: {
            pid,
            window_id: windowId,
            include_screenshot: true,
            ...windowTraversalArgs(effort),
            screenshot_out_file: path,
          },
          session_id: started.sessionId,
        }, signal, { drainAfterDispatch: true });
        if (signal?.aborted || this.active?.number !== active.number || this.active.opaqueId !== started.generation) {
          diagnose(signal?.aborted ? "cancelled" : "stale_generation");
          result = { ok: false, code: signal?.aborted ? "cancelled" : "stale_generation" };
          break capture;
        }
        stage = "post_write_identity";
        const afterWrite = await handle.stat();
        const atPath = await this.options.captureFilesystem.lstat(path);
        if (!safeCaptureIdentity(afterWrite, this.expectedUid) || !sameCaptureIdentity(owned, afterWrite)
          || atPath === null || !sameCaptureIdentity(owned, atPath)) {
          diagnose("context_fenced");
          mustInvalidate = true;
          result = { ok: false, code: "context_fenced" };
          break capture;
        }
        stage = "provider_result";
        const parsed = windowCaptureFacts(raw, path);
        if (!parsed.ok) {
          diagnose("provider_malformed", parsed.predicate);
          result = { ok: false, code: "provider_malformed" };
          break capture;
        }
        if (parsed.image === null) {
          result = {
            ok: true,
            generation: started.generation,
            sessionId: started.sessionId,
            result: parsed.tool,
            png: null,
          };
          break capture;
        }
        stage = "read";
        const bounded = new Uint8Array(DESKTOP_VISION_PNG_MAX_BYTES + 1);
        let offset = 0;
        for (;;) {
          const { bytesRead } = await handle.read(bounded, offset, bounded.length - offset, offset);
          if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > bounded.length - offset) {
            diagnose("context_fenced");
            mustInvalidate = true;
            result = { ok: false, code: "context_fenced" };
            break capture;
          }
          offset += bytesRead;
          if (bytesRead === 0 || offset === bounded.length) break;
        }
        if (offset > DESKTOP_VISION_PNG_MAX_BYTES) {
          stage = "size";
          diagnose("image_too_large");
          result = { ok: false, code: "image_too_large" };
          break capture;
        }
        const png = bounded.slice(0, offset);
        stage = "png";
        const dimensions = parseBoundedPngDimensions(png);
        if ("kind" in dimensions || dimensions.width !== parsed.image.width || dimensions.height !== parsed.image.height) {
          stage = "kind" in dimensions ? "png" : "dimensions";
          diagnose("provider_malformed", "kind" in dimensions ? "png_parse" : "png_dimensions");
          result = { ok: false, code: "provider_malformed" };
          break capture;
        }
        if (signal?.aborted || this.active?.number !== active.number || this.active.opaqueId !== started.generation) {
          stage = "completion";
          diagnose(signal?.aborted ? "cancelled" : "stale_generation");
          result = { ok: false, code: signal?.aborted ? "cancelled" : "stale_generation" };
          break capture;
        }
        result = {
          ok: true,
          generation: started.generation,
          sessionId: started.sessionId,
          result: parsed.tool,
          png: png.slice(),
        };
      }
    } catch (error) {
      diagnose(isAbort(error) ? "cancelled" : "context_fenced");
      if (!isAbort(error)) mustInvalidate = true;
      result = { ok: false, code: isAbort(error) ? "cancelled" : "context_fenced" };
    } finally {
      const cleanupSafe = await this.cleanupCapture(path, handle, owned, active);
      if (!cleanupSafe) {
        stage = "cleanup";
        diagnose("context_fenced");
        mustInvalidate = true;
      }
      if (mustInvalidate) this.invalidateGeneration(active, true);
      if (!cleanupSafe) result = { ok: false, code: "context_fenced" };
      if (result?.ok === true && (signal?.aborted || this.active?.number !== active.number || this.active.opaqueId !== started.generation)) {
        result = { ok: false, code: signal?.aborted ? "cancelled" : "stale_generation" };
      }
      if (result?.ok !== true) await releaseLease();
    }
    return result ?? { ok: false, code: "context_fenced" };
  }

  /**
   * Capture through a one-shot, host-owned pathname while retaining the file
   * descriptor throughout. This is deliberately separate from the reviewed
   * semantic-tool allowlist: it cannot become a generic Cua RPC.
   */
  captureDesktopState(
    scope: ComputerUseContextScope,
    expectedGeneration: string,
    signal?: AbortSignal,
  ): Promise<CuaDesktopCaptureResult> {
    if (signal?.aborted) return Promise.resolve({ ok: false, code: "cancelled" });
    const internal = this.captureDesktopStateDirect(scope, expectedGeneration, signal);
    const delivery = Promise.withResolvers<void>();
    this.trackOutstandingOperation(scope, expectedGeneration, signal, Promise.all([internal, delivery.promise]));
    return this.forOperationCaller(internal, signal, () => ({ ok: false, code: "cancelled" }), async (abandoned) => {
      if (!abandoned.ok) return;
      abandoned.png.fill(0);
      await this.endContextLease(scope, abandoned.generation, abandoned.sessionId);
    }, delivery.resolve);
  }

  private async captureDesktopStateDirect(
    scope: ComputerUseContextScope,
    expectedGeneration: string,
    signal?: AbortSignal,
  ): Promise<CuaDesktopCaptureResult> {
    const started = await this.startContextExisting(scope, expectedGeneration, signal);
    if (!started.ok) return { ok: false, code: started.code };
    const releaseLease = () => this.endContextLease(scope, started.generation, started.sessionId);
    const active = this.active;
    if (active === null || active.opaqueId !== started.generation) {
      await releaseLease();
      return { ok: false, code: "stale_generation" };
    }
    let handle: CuaCaptureFileHandle | null = null;
    let owned: CuaCaptureFileStat | null = null;
    let path: string | null = null;
    let mustInvalidate = false;
    let result: CuaDesktopCaptureResult | null = null;
    let stage: CuaCaptureDiagnostic["stage"] = "runtime_identity";
    const diagnose = (
      code: CuaCaptureDiagnostic["code"],
      predicate?: CuaCaptureValuePredicate,
    ): void => {
      try {
        this.options.onCaptureDiagnostic({
          stage,
          code,
          ...(predicate === undefined ? {} : { predicate }),
        });
      } catch { /* diagnostics cannot affect authority */ }
    };
    try {
      capture: {
      const runtime = await this.options.filesystem.lstat(this.options.runtimeDir);
      if (!sameRuntimeIdentity(active.runtimeIdentity, runtime, this.expectedUid)) {
        diagnose("context_fenced");
        mustInvalidate = true;
        result = { ok: false, code: "context_fenced" };
        break capture;
      }
      stage = "nonce";
      const nonce = this.options.randomBytes(24);
      if (nonce.byteLength !== 24) {
        diagnose("invalid_configuration");
        result = { ok: false, code: "invalid_configuration" };
        break capture;
      }
      path = join(this.options.runtimeDir, `capture_${Buffer.from(nonce).toString("base64url")}.png`);
      // wx prevents an attacker-selected existing leaf, and the parent was
      // attested 0700/current-UID before this supervisor was created.
      stage = "open";
      handle = await this.options.captureFilesystem.open(path, "wx+", 0o600);
      stage = "initial_identity";
      owned = await handle.stat();
      if (!safeCaptureIdentity(owned, this.expectedUid)) {
        diagnose("context_fenced");
        mustInvalidate = true;
        result = { ok: false, code: "context_fenced" };
        break capture;
      }
      if (signal?.aborted) {
        diagnose("cancelled");
        result = { ok: false, code: "cancelled" };
        break capture;
      }
      stage = "provider_call";
      const raw = await this.callOwned(active.socketPath, active.socketIdentity, {
        method: "call", name: "get_desktop_state", args: { screenshot_out_file: path }, session_id: started.sessionId,
      }, signal, { drainAfterDispatch: true });
      if (signal?.aborted || this.active?.number !== active.number || this.active.opaqueId !== started.generation) {
        diagnose(signal?.aborted ? "cancelled" : "stale_generation");
        result = { ok: false, code: signal?.aborted ? "cancelled" : "stale_generation" };
        break capture;
      }
      stage = "post_write_identity";
      const afterWrite = await handle.stat();
      const atPath = await this.options.captureFilesystem.lstat(path);
      if (!safeCaptureIdentity(afterWrite, this.expectedUid) || !sameCaptureIdentity(owned, afterWrite)
        || atPath === null || !sameCaptureIdentity(owned, atPath)) {
        diagnose("context_fenced");
        mustInvalidate = true;
        result = { ok: false, code: "context_fenced" };
        break capture;
      }
      stage = "provider_result";
      const parsed = desktopCaptureFacts(raw, path);
      if (!parsed.ok) {
        // A schema/value mismatch in the provider response is a provider
        // compatibility fact. Fail this one operation without inferring that
        // the Human revoked authority. This supervisor does not decide
        // readiness or route advertisement; PR-B owns readiness degradation.
        diagnose("provider_malformed", parsed.predicate);
        result = { ok: false, code: "provider_malformed" };
        break capture;
      }
      const facts = parsed.facts;
      stage = "read";
      const bounded = new Uint8Array(DESKTOP_VISION_PNG_MAX_BYTES + 1);
      let offset = 0;
      for (;;) {
        const { bytesRead } = await handle.read(bounded, offset, bounded.length - offset, offset);
        if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > bounded.length - offset) {
          diagnose("context_fenced");
          mustInvalidate = true;
          result = { ok: false, code: "context_fenced" };
          break capture;
        }
        offset += bytesRead;
        if (bytesRead === 0 || offset === bounded.length) break;
      }
      if (offset > DESKTOP_VISION_PNG_MAX_BYTES) {
        stage = "size";
        diagnose("image_too_large");
        result = { ok: false, code: "image_too_large" };
        break capture;
      }
      const png = bounded.slice(0, offset);
      stage = "png";
      const dimensions = parseBoundedPngDimensions(png);
      if ("kind" in dimensions || dimensions.width !== facts.nativeWidth || dimensions.height !== facts.nativeHeight) {
        // The capture file's identity (inode, owner, mode) was attested above;
        // bytes that fail to parse as PNG or contradict the provider's own
        // claimed dimensions are provider output problems, not an authority
        // breach. Fail the operation, keep the generation.
        stage = "kind" in dimensions ? "png" : "dimensions";
        diagnose("provider_malformed", "kind" in dimensions ? "png_parse" : "png_dimensions");
        result = { ok: false, code: "provider_malformed" };
        break capture;
      }
      if (signal?.aborted || this.active?.number !== active.number || this.active.opaqueId !== started.generation) {
        stage = "completion";
        diagnose(signal?.aborted ? "cancelled" : "stale_generation");
        result = { ok: false, code: signal?.aborted ? "cancelled" : "stale_generation" };
        break capture;
      }
      // Make a second defensive copy: neither the bounded read buffer nor a
      // descriptor/path escapes this supervisor.
      result = {
        ok: true, generation: started.generation, sessionId: started.sessionId, png: png.slice(),
        nativeWidth: facts.nativeWidth, nativeHeight: facts.nativeHeight,
        screenWidth: facts.screenWidth, screenHeight: facts.screenHeight, scaleFactor: facts.scaleFactor,
      };
      }
    } catch (error) {
      diagnose(isAbort(error) ? "cancelled" : "context_fenced");
      if (!isAbort(error)) mustInvalidate = true;
      result = { ok: false, code: isAbort(error) ? "cancelled" : "context_fenced" };
    } finally {
      const cleanupSafe = await this.cleanupCapture(path, handle, owned, active);
      if (!cleanupSafe) {
        stage = "cleanup";
        diagnose("context_fenced");
        mustInvalidate = true;
      }
      if (mustInvalidate) this.invalidateGeneration(active, true);
      // A success is deliberately withheld until descriptor close and exact
      // owned-leaf removal are both complete.
      if (!cleanupSafe) {
        result = { ok: false, code: "context_fenced" };
      }
      if (result?.ok === true && (signal?.aborted || this.active?.number !== active.number || this.active.opaqueId !== started.generation)) {
        const code = signal?.aborted ? "cancelled" : "stale_generation";
        result = { ok: false, code };
      }
      if (result?.ok !== true) await releaseLease();
    }
    return result ?? { ok: false, code: "context_fenced" };
  }

  /** One exact screen-absolute pointer operation on an existing checked generation. */
  clickDesktop(
    scope: ComputerUseContextScope,
    expectedGeneration: string,
    x: number,
    y: number,
    signal?: AbortSignal,
    options: CuaPixelClickOptions = {},
    onProviderDispatch?: () => boolean | Promise<boolean>,
  ): Promise<CuaDesktopClickResult> {
    if (!Number.isFinite(x) || x < 0 || !Number.isFinite(y) || y < 0 || !validPixelClickOptions(cuaPixelClickArguments(options))) {
      return Promise.resolve({ ok: false, code: "invalid_configuration", stage: "session" });
    }
    if (signal?.aborted) return Promise.resolve({ ok: false, code: "cancelled", stage: "session" });
    const internal = this.clickDesktopDirect(scope, expectedGeneration, x, y, signal, options, onProviderDispatch);
    const delivery = Promise.withResolvers<void>();
    this.trackOutstandingOperation(scope, expectedGeneration, signal, Promise.all([internal, delivery.promise]));
    return this.forOperationCaller(internal, signal, () => ({ ok: false, code: "cancelled", stage: "tool" }), async (abandoned) => {
      if (abandoned.ok) await this.endContextLease(scope, abandoned.generation, abandoned.sessionId);
    }, delivery.resolve);
  }

  private async clickDesktopDirect(
    scope: ComputerUseContextScope,
    expectedGeneration: string,
    x: number,
    y: number,
    signal?: AbortSignal,
    options: CuaPixelClickOptions = {},
    onProviderDispatch?: () => boolean | Promise<boolean>,
  ): Promise<CuaDesktopClickResult> {
    const started = await this.startContextExisting(scope, expectedGeneration, signal);
    if (!started.ok) return { ok: false, code: started.code, stage: "session" };
    const releaseLease = () => this.endContextLease(scope, started.generation, started.sessionId);
    const active = this.active;
    if (active === null || active.opaqueId !== started.generation) {
      await releaseLease();
      return { ok: false, code: "stale_generation", stage: "session" };
    }
    try {
      if (signal?.aborted || onProviderDispatch !== undefined && !await onProviderDispatch()
        || signal?.aborted || this.active?.number !== active.number || this.active.opaqueId !== started.generation) {
        await releaseLease();
        return { ok: false, code: signal?.aborted ? "cancelled" : "context_fenced", stage: "session" };
      }
      const facts = desktopClickFacts(await this.callOwned(active.socketPath, active.socketIdentity, {
        method: "call",
        name: "click",
        args: { x, y, scope: "desktop", ...cuaPixelClickArguments(options) },
        session_id: started.sessionId,
      }, signal, { drainAfterDispatch: true }));
      if (facts === null) {
        await releaseLease();
        this.invalidateGeneration(active, true);
        return { ok: false, code: "context_fenced", stage: "tool" };
      }
      if (signal?.aborted || this.active?.number !== active.number || this.active.opaqueId !== started.generation) {
        await releaseLease();
        return { ok: false, code: signal?.aborted ? "cancelled" : "stale_generation", stage: "tool" };
      }
      return { ok: true, generation: started.generation, sessionId: started.sessionId, ...facts };
    } catch (error) {
      await releaseLease();
      if (!isAbort(error)) this.invalidateGeneration(active, true);
      return { ok: false, code: isAbort(error) ? "cancelled" : "context_fenced", stage: "tool" };
    }
  }

  /**
   * Reject an observed replacement before removal. A same-UID pinned daemon
   * remains inside the documented lstat→unlink host trust boundary; any
   * mismatch or cleanup uncertainty fences its generation.
   */
  private async cleanupCapture(
    path: string | null,
    handle: CuaCaptureFileHandle | null,
    owned: CuaCaptureFileStat | null,
    active: ActiveGeneration,
  ): Promise<boolean> {
    // A rejected/throwing nonce has not acquired any resource. It is the sole
    // no-resource cleanup state; a path without an owned descriptor fences.
    if (path === null && handle === null && owned === null) return true;
    let safe = handle !== null && owned !== null;
    try {
      if (handle !== null && owned !== null && path !== null) {
        const retained = await handle.stat();
        const current = await this.options.captureFilesystem.lstat(path);
        if (!sameCaptureIdentity(owned, retained) || !safeCaptureIdentity(retained, this.expectedUid)) safe = false;
        if (current === null) {
          // The only acceptable already-unlinked state retains the exact owned
          // inode and a still-live generation; we then only need to close it.
          if (!sameCaptureIdentity(owned, retained) || this.active?.number !== active.number) safe = false;
        } else if (!sameCaptureIdentity(owned, current)) {
          safe = false;
        } else {
          await this.options.captureFilesystem.unlink(path);
        }
      }
    } catch {
      safe = false;
    }
    try { await handle?.close(); } catch { safe = false; }
    return safe;
  }

  /** Ends and removes only the matching context-derived session; the daemon stays ready for other contexts. */
  endContext(scope: ComputerUseContextScope): Promise<void> {
    const key = contextKey(scope);
    const pending = this.startingSessions.get(key);
    if (pending !== undefined) {
      this.startingSessionAborts.get(key)?.abort();
      // Do not let a silent daemon transport make local authority revocation
      // wait. The distinct incarnation below prevents a late old cleanup from
      // ever ending a newly opened session for this same context.
      this.startingSessions.delete(key);
      this.startingSessionAborts.delete(key);
      this.startingSessionGenerations.delete(key);
    }
    const session = this.sessions.get(key);
    const active = this.active;
    if (session === undefined || active === null || session.generation !== active.number) return Promise.resolve();
    this.sessions.delete(key);
    this.bestEffortEndSession(active, session.sessionId);
    return Promise.resolve();
  }

  /**
   * Release only the session lease this exact caller obtained. A late cleanup
   * cannot end a newer generation or another in-flight invocation's session.
   */
  endContextLease(scope: ComputerUseContextScope, generation: string, sessionId: string): Promise<void> {
    const key = contextKey(scope);
    const session = this.sessions.get(key);
    const active = this.active;
    if (session === undefined || active === null || active.opaqueId !== generation
      || session.generation !== active.number || session.sessionId !== sessionId) return Promise.resolve();
    if (session.leases > 1) {
      this.sessions.set(key, { ...session, leases: session.leases - 1 });
      return Promise.resolve();
    }
    this.sessions.delete(key);
    this.bestEffortEndSession(active, session.sessionId);
    return Promise.resolve();
  }

  /** Explicit host shutdown: 2s running grace; failed startup uses its distinct upstream 250ms teardown grace. */
  shutdown(): Promise<void> {
    if (this.stopping !== null) return this.stopping;
    const pending = this.stopInternal().finally(() => {
      if (this.stopping === pending) this.stopping = null;
    });
    this.stopping = pending;
    return pending;
  }

  private async stopInternal(): Promise<void> {
    if (this.reapFailed) throw new Error("cua child cleanup previously failed; shutdown remains fenced");
    this.generation += 1;
    const starting = this.starting;
    this.startingAbort?.abort();
    for (const controller of this.startingSessionAborts.values()) controller.abort();
    const current = this.active;
    this.active = null;
    if (current !== null) this.notifyInvalidation();
    if (current !== null) {
      const sessions = [...this.sessions.values()].filter((session) => session.generation === current.number);
      this.sessions.clear();
      // Tool cleanup is advisory and concurrent. It may be silent forever, so
      // it cannot delay closing the parent-liveness pipe or reaping the child.
      for (const session of sessions) this.bestEffortEndSession(current, session.sessionId);
      try {
        await this.terminateRunningChild(current.child);
      } catch (error) {
        // A caller cannot safely start another daemon when the child we own
        // might still be live. Preserve that fence even though shutdown
        // surfaces the cleanup failure to its caller.
        this.reapFailed = true;
        throw error;
      }
      await this.removeOwnedSocket(current.socketPath, current.socketIdentity);
    }
    // A starting child has no active generation yet. Its finally block owns
    // reap/cleanup; waiting here prevents shutdown from returning an orphan.
    if (starting !== null) await starting;
  }

  private async begin(signal?: AbortSignal): Promise<CuaSupervisorResult> {
    const number = ++this.generation;
    const operationAbort = new AbortController();
    const unlinkCallerAbort = linkAbort(signal, operationAbort);
    let child: CuaChild | null = null;
    let childObserved: SpawnObservation | null = null;
    let confirmedSpawn = false;
    let socketPath: string | null = null;
    let socketIdentity: CuaSocketStat | null = null;
    try {
      if (!isAbsolute(this.options.binaryPath) || !isAbsolute(this.options.runtimeDir)) return { ok: false, code: "invalid_configuration" };
      const runtime = await this.options.filesystem.lstat(this.options.runtimeDir);
      if (runtime?.kind !== "directory" || runtime.mode !== 0o700 || runtime.uid !== this.expectedUid) return { ok: false, code: "runtime_directory_unsafe" };
      const userHome = this.options.userHomePath;
      if (userHome !== undefined) {
        if (!isAbsolute(userHome)) return { ok: false, code: "invalid_configuration" };
        const home = await this.options.filesystem.lstat(userHome);
        if (home?.kind !== "directory" || home.uid !== this.expectedUid) return { ok: false, code: "invalid_configuration" };
      }
      const opaqueId = this.options.randomBytes(24);
      if (opaqueId.byteLength !== 24) return { ok: false, code: "invalid_configuration" };
      const generationId = `cua_${Buffer.from(opaqueId).toString("base64url")}`;
      socketPath = join(this.options.runtimeDir, `${generationId}.sock`);
      if (await this.options.filesystem.lstat(socketPath) !== null) return { ok: false, code: "socket_collision" };
      child = this.options.spawn(this.options.binaryPath, [
        "serve", "--embedded", "--parent-liveness-stdio", "--socket", socketPath,
        "--host-bundle-id", this.options.hostBundleId, "--permission-mode", "standard", "--grant", "existing-profile", "--no-permissions-gate",
      ], {
        // Equivalent to Rust Command::env_clear. The fixed system PATH and the
        // independently UID-attested current-user home are the sole runtime
        // inputs: Cua needs that home to find an existing Chromium profile.
        // Proxy, user secret, debug, telemetry, and update inheritance remain absent.
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          ...(userHome === undefined ? {} : { HOME: userHome }),
          CUA_DRIVER_EMBEDDED: "1",
          CUA_DRIVER_HOST_BUNDLE_ID: this.options.hostBundleId,
          CUA_DRIVER_PARENT_LIVENESS_STDIN: "1",
          CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
          CUA_DRIVER_RS_UPDATE_CHECK: "false",
        },
        shell: false,
        stdio: ["pipe", "ignore", "ignore"],
      });
      childObserved = this.observeChild(child, () => operationAbort.abort());
      const spawnedPid = child.pid;
      if (typeof spawnedPid !== "number" || !Number.isSafeInteger(spawnedPid) || spawnedPid <= 0 || child.stdin === null || childObserved.failed()) return { ok: false, code: "spawn_failed" };
      confirmedSpawn = true;
      const metadata = await this.waitForMetadata(socketPath, child, operationAbort.signal, () => childObserved?.failed() === true);
      socketIdentity = await this.options.filesystem.lstat(socketPath);
      if (childObserved.failed()) return { ok: false, code: "stale_generation" };
      if (!this.attested(metadata, spawnedPid) || socketIdentity === null || socketIdentity.kind !== "socket" || socketIdentity.mode !== 0o600 || socketIdentity.uid !== this.expectedUid) {
        return { ok: false, code: "attestation_failed" };
      }
      const permissions = successfulStructuredContent(await this.callOwned(socketPath, socketIdentity, {
        method: "call", name: "check_permissions", args: { prompt: false, probe_direct_capture: false },
      }, operationAbort.signal));
      if (childObserved.failed()) return { ok: false, code: "stale_generation" };
      if (permissions === null) return { ok: false, code: "permission_check_failed" };
      const report = successfulStructuredContent(await this.callOwned(socketPath, socketIdentity, { method: "call", name: "health_report", args: {} }, operationAbort.signal));
      if (childObserved.failed()) return { ok: false, code: "stale_generation" };
      if (report === null) return { ok: false, code: "health_check_failed" };
      if (childObserved.failed() || number !== this.generation || signal?.aborted) return { ok: false, code: signal?.aborted ? "cancelled" : "stale_generation" };
      const permission = permissionStatus(permissions, spawnedPid, this.options.binaryPath, this.options.hostBundleId);
      if (permission === null) return { ok: false, code: "permission_check_failed" };
      const status = safeStatus(report);
      if (status === null) return { ok: false, code: "health_check_failed" };
      const health: CuaSupervisorHealth = { permission, health: status };
      this.active = { number, opaqueId: generationId, socketPath, child, socketIdentity, runtimeIdentity: runtime, health };
      childObserved.publish(this.active);
      return this.active?.number === number ? { ok: true, generation: generationId, health, healthFreshness: "startup_cached" } : { ok: false, code: "stale_generation" };
    } catch (error) {
      return { ok: false, code: childObserved?.failed() ? "stale_generation" : isAbort(error) ? "cancelled" : child === null ? "spawn_failed" : "attestation_failed" };
    } finally {
      if (this.active?.number !== number && child !== null && confirmedSpawn) {
        try {
          await this.terminateStartupChild(child);
        } catch {
          // A startup child that refuses reaping is as unsafe to overlap as a
          // live running child whose error path could not be reaped.
          this.reapFailed = true;
        }
        if (socketPath !== null) {
          const cleanupIdentity = socketIdentity ?? await this.options.filesystem.lstat(socketPath);
          if (cleanupIdentity?.kind === "socket" && cleanupIdentity.mode === 0o600) {
            await this.removeOwnedSocket(socketPath, cleanupIdentity);
          }
        }
      }
      unlinkCallerAbort();
    }
  }

  private async beginContext(
    key: string,
    ready: Extract<CuaSupervisorResult, { readonly ok: true }>,
    expectedGeneration: ActiveGeneration,
    signal?: AbortSignal,
  ): Promise<CuaContextStartResult> {
    const active = this.active;
    if (active === null || active.number !== expectedGeneration.number || active.opaqueId !== ready.generation) return { ok: false, code: "stale_generation" };
    const incarnation = ++this.sessionIncarnation;
    const sessionId = `cua_session_${createHash("sha256").update(`${key}\u0000${active.opaqueId}\u0000${incarnation}`).digest("base64url")}`;
    try {
      const started = successfulToolResult(await this.callOwned(active.socketPath, active.socketIdentity, {
        method: "call", name: "start_session", args: { session: sessionId, capture_scope: "auto" }, session_id: sessionId,
      }, signal));
      if (started === null) return { ok: false, code: signal?.aborted ? "cancelled" : "session_start_failed" };
      // Cosmetic only: ask the pinned driver for the directly qualified faster
      // motion, but never make Computer Use availability depend on animation.
      // The next generation/version qualification will catch contract drift.
      const motion = await this.callOwned(active.socketPath, active.socketIdentity, {
        method: "call", name: "set_agent_cursor_motion",
        args: {
          session: sessionId,
          glide_duration_ms: CUA_CURSOR_GLIDE_DURATION_MS,
          dwell_after_click_ms: CUA_CURSOR_DWELL_AFTER_CLICK_MS,
        },
        session_id: sessionId,
      }, signal, { tolerateTransportFailure: true });
      // A cosmetic failure is optional; failure to attest the exact socket is
      // not. Never publish a session after either identity check failed.
      if (motion === null) throw new Error("cua session socket attestation failed");
      if (signal?.aborted || this.active?.number !== active.number || this.active.opaqueId !== ready.generation) {
        this.bestEffortEndSession(active, sessionId);
        return { ok: false, code: signal?.aborted ? "cancelled" : "stale_generation" };
      }
      this.sessions.set(key, { generation: active.number, sessionId, leases: 1 });
      return { ok: true, generation: ready.generation, sessionId, health: ready.health };
    } catch (error) {
      this.bestEffortEndSession(active, sessionId);
      return { ok: false, code: isAbort(error) ? "cancelled" : "session_start_failed" };
    }
  }

  private async acquireStartingContext(
    key: string,
    pending: Promise<CuaContextStartResult>,
    signal?: AbortSignal,
  ): Promise<CuaContextStartResult> {
    const started = await this.forContextCaller(pending, signal);
    if (!started.ok) return started;
    const session = this.sessions.get(key);
    const active = this.active;
    if (session === undefined || active === null || active.opaqueId !== started.generation
      || session.generation !== active.number || session.sessionId !== started.sessionId) {
      return { ok: false, code: "stale_generation" };
    }
    this.sessions.set(key, { ...session, leases: session.leases + 1 });
    return started;
  }

  /** Attach before PID validation so a one-shot spawn failure cannot be lost. */
  private observeChild(child: CuaChild, onFailure?: () => void): SpawnObservation {
    let failure: "exit" | "error" | null = null;
    let published: ActiveGeneration | null = null;
    const observed = (kind: "exit" | "error") => {
      failure = kind;
      onFailure?.();
      if (published !== null) this.invalidateGeneration(published, kind === "error");
    };
    child.once("exit", () => observed("exit"));
    child.once("error", () => observed("error"));
    return {
      failed: () => failure !== null,
      publish: (generation) => {
        published = generation;
        if (failure !== null) this.invalidateGeneration(generation, failure === "error");
      },
    };
  }

  /** Unexpected child death invalidates only the generation that owned it. */
  private invalidateGeneration(generation: ActiveGeneration, reap: boolean): void {
      if (this.active?.number !== generation.number) return;
      this.active = null;
      this.notifyInvalidation();
      for (const [key, session] of this.sessions) {
        if (session.generation === generation.number) this.sessions.delete(key);
      }
      for (const [key, pendingGeneration] of this.startingSessionGenerations) {
        if (pendingGeneration === generation.number) this.startingSessionAborts.get(key)?.abort();
      }
      if (reap) {
        const reaping = this.terminateRunningChild(generation.child)
          .then(() => this.removeOwnedSocket(generation.socketPath, generation.socketIdentity))
          .catch(() => { this.reapFailed = true; });
        const pending = reaping.finally(() => {
          if (this.reaping === pending) this.reaping = null;
        });
        this.reaping = pending;
      } else {
        void this.removeOwnedSocket(generation.socketPath, generation.socketIdentity);
      }
  }

  private notifyInvalidation(): void {
    for (const listener of this.invalidationListeners) {
      try { listener(); } catch { /* lifecycle notification cannot block containment */ }
    }
  }

  private async waitForMetadata(
    socketPath: string,
    child: CuaChild,
    signal?: AbortSignal,
    observedFailure?: () => boolean,
  ): Promise<unknown> {
    // This is a retry cadence, deliberately not a startup deadline. A slow
    // signed host remains `starting` until it is cancelled or its child exits.
    for (;;) {
      if (signal?.aborted) throw aborted();
      if (childExited(child) || observedFailure?.()) throw new Error("cua child failed during startup");
      try {
        return await this.call(socketPath, { method: "metadata" }, signal);
      } catch (error) {
        if (isAbort(error)) throw error;
        await this.options.sleep(CUA_UPSTREAM_SOCKET_RETRY_INTERVAL_MS, signal);
      }
    }
  }

  private attested(value: unknown, pid: number): value is Readonly<{ result: DaemonMetadata }> {
    const result = daemonResult(value);
    const metadata = object(result) as DaemonMetadata | null;
    return metadata !== null
      && metadata.driver_version === CUA_DRIVER_VERSION
      && metadata.contract_version === CUA_CONTRACT_VERSION
      && metadata.tools_list_schema_version === CUA_TOOLS_LIST_SCHEMA_VERSION
      && metadata.capability_version === CUA_CAPABILITY_VERSION
      && metadata.mcp_protocol_version === CUA_MCP_PROTOCOL_VERSION
      && metadata.pid === pid
      && metadata.embedded === true
      && metadata.host_bundle_id === this.options.hostBundleId;
  }

  private call(socketPath: string, request: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown> {
    const operation = this.options.transport(socketPath, request, signal);
    if (signal === undefined) return operation;
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(aborted());
      const onAbort = () => reject(aborted());
      signal.addEventListener("abort", onAbort, { once: true });
      void operation.then((value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      }, (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error("cua transport failed"));
      });
    });
  }

  /** Bind each post-attestation request to the exact inode the generation proved. */
  private async callOwned(
    socketPath: string,
    identity: CuaSocketStat,
    request: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    options: Readonly<{ tolerateTransportFailure?: boolean; drainAfterDispatch?: boolean }> = {},
  ): Promise<unknown> {
    const before = await this.options.filesystem.lstat(socketPath);
    if (before === null || before.mode !== 0o600 || before.uid !== this.expectedUid || !equalIdentity(before, identity)) return null;
    if (options.drainAfterDispatch && signal?.aborted) throw aborted();
    let response: unknown;
    try {
      response = await this.call(socketPath, request, options.drainAfterDispatch ? undefined : signal);
    } catch (error) {
      if (!options.tolerateTransportFailure || isAbort(error)) throw error;
      // Only optional transport errors are tolerated. Both filesystem checks
      // remain outside this catch, and a changed socket still returns null.
      response = {};
    }
    const after = await this.options.filesystem.lstat(socketPath);
    return after !== null && after.mode === 0o600 && after.uid === this.expectedUid && equalIdentity(after, identity) ? response : null;
  }

  /** Advisory daemon cleanup; local authority is removed before this call. */
  private bestEffortEndSession(active: ActiveGeneration, sessionId: string): void {
    void this.callOwned(active.socketPath, active.socketIdentity, {
      method: "call", name: "end_session", args: { session: sessionId },
    }).catch(() => {});
  }

  private forCaller(result: Promise<CuaSupervisorResult>, signal?: AbortSignal): Promise<CuaSupervisorResult> {
    if (signal === undefined) return result;
    return new Promise((resolve) => {
      if (signal.aborted) return resolve({ ok: false, code: "cancelled" });
      const onAbort = () => resolve({ ok: false, code: "cancelled" });
      signal.addEventListener("abort", onAbort, { once: true });
      void result.then((value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      }, () => {
        signal.removeEventListener("abort", onAbort);
        resolve({ ok: false, code: "attestation_failed" });
      });
    });
  }

  private forToolCaller(
    result: Promise<CuaContextToolCallResult>,
    signal?: AbortSignal,
    discardAbandoned: (value: CuaContextToolCallResult) => void | Promise<void> = () => {},
    onDeliverySettled: () => void = () => {},
  ): Promise<CuaContextToolCallResult> {
    if (signal === undefined) return result.finally(onDeliverySettled);
    return new Promise((resolve) => {
      let callerCancelled = false;
      if (signal.aborted) {
        callerCancelled = true;
        void result.then((value) => Promise.resolve(discardAbandoned(value)).catch(() => undefined), () => undefined)
          .finally(onDeliverySettled);
        resolve({ ok: false, code: "cancelled", stage: "tool" });
        return;
      }
      const onAbort = () => {
        callerCancelled = true;
        resolve({ ok: false, code: "cancelled", stage: "tool" });
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void result.then((value) => {
        signal.removeEventListener("abort", onAbort);
        if (callerCancelled) {
          void Promise.resolve(discardAbandoned(value)).catch(() => undefined).finally(onDeliverySettled);
        } else {
          onDeliverySettled();
          resolve(value);
        }
      }, () => {
        signal.removeEventListener("abort", onAbort);
        onDeliverySettled();
        resolve({ ok: false, code: "context_fenced", stage: "tool" });
      });
    });
  }

  private forOperationCaller<T>(
    result: Promise<T>,
    signal: AbortSignal | undefined,
    cancelled: () => T,
    discardAbandoned: (value: T) => void | Promise<void>,
    onDeliverySettled: () => void,
  ): Promise<T> {
    if (signal === undefined) return result.finally(onDeliverySettled);
    return new Promise<T>((resolve, reject) => {
      let callerCancelled = false;
      if (signal.aborted) {
        callerCancelled = true;
        void result.then((value) => Promise.resolve(discardAbandoned(value)).catch(() => undefined), () => undefined)
          .finally(onDeliverySettled);
        resolve(cancelled());
        return;
      }
      const onAbort = () => {
        callerCancelled = true;
        resolve(cancelled());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void result.then((value) => {
        signal.removeEventListener("abort", onAbort);
        if (callerCancelled) {
          void Promise.resolve(discardAbandoned(value)).catch(() => undefined).finally(onDeliverySettled);
        } else {
          onDeliverySettled();
          resolve(value);
        }
      }, (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        onDeliverySettled();
        reject(error instanceof Error ? error : new Error("Cua operation failed"));
      });
    });
  }

  private forContextCaller(result: Promise<CuaContextStartResult>, signal?: AbortSignal): Promise<CuaContextStartResult> {
    if (signal === undefined) return result;
    return new Promise((resolve) => {
      if (signal.aborted) return resolve({ ok: false, code: "cancelled" });
      const onAbort = () => resolve({ ok: false, code: "cancelled" });
      signal.addEventListener("abort", onAbort, { once: true });
      void result.then((value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      }, () => {
        signal.removeEventListener("abort", onAbort);
        resolve({ ok: false, code: "session_start_failed" });
      });
    });
  }

  private async exitsWithinGrace(child: CuaChild, graceMs: number): Promise<boolean> {
    if (childExited(child)) return true;
    return new Promise((resolve) => {
      let settled = false;
      const done = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener?.("exit", onExit);
        resolve(value);
      };
      const onExit = () => done(true);
      const timer = setTimeout(() => done(false), graceMs);
      child.once("exit", onExit);
    });
  }

  private async awaitExit(child: CuaChild): Promise<void> {
    if (childExited(child)) return;
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }

  /** Pinned `finish_stop`: liveness EOF, 2s graceful exit, then SIGKILL and reap. */
  private async terminateRunningChild(child: CuaChild): Promise<void> {
    child.stdin?.end();
    if (await this.exitsWithinGrace(child, CUA_UPSTREAM_SHUTDOWN_GRACE_MS)) return;
    if (childExited(child)) return;
    try {
      if (!child.kill("SIGKILL") && !childExited(child)) throw new Error("cua child refused SIGKILL; cleanup incomplete");
    } catch (error) {
      if (!childExited(child)) throw error;
    }
    await this.awaitExit(child);
  }

  /** Pinned `terminate_startup_child`: liveness EOF, 250ms teardown grace, then kill/reap. */
  private async terminateStartupChild(child: CuaChild): Promise<void> {
    child.stdin?.end();
    if (await this.exitsWithinGrace(child, CUA_UPSTREAM_STARTUP_TEARDOWN_GRACE_MS)) return;
    if (childExited(child)) return;
    try {
      if (!child.kill("SIGKILL") && !childExited(child)) throw new Error("cua startup child refused SIGKILL; cleanup incomplete");
    } catch (error) {
      if (!childExited(child)) throw error;
    }
    await this.awaitExit(child);
  }

  private async removeOwnedSocket(path: string, identity: CuaSocketStat): Promise<void> {
    try {
      const current = await this.options.filesystem.lstat(path);
      if (current !== null && current.uid === this.expectedUid && equalIdentity(current, identity)) await this.options.filesystem.unlink(path);
    } catch {
      // Cleanup must never unlink a path whose inode/device cannot be proven.
    }
  }
}
