import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ComputerUseContextScope } from "../../src/native-context-registry.ts";
import type { CuaCheckedContextPort } from "../../src/native-cua-lifecycle.ts";
import { CuaComputerUseAdapter } from "../../src/native-runtime.ts";
import {
  CUA_CAPABILITY_VERSION,
  CUA_CONTRACT_VERSION,
  CUA_DRIVER_VERSION,
  CUA_MCP_PROTOCOL_VERSION,
  CUA_MAX_RAW_CONTROL_PROTOCOL_BYTES,
  CUA_TOOLS_LIST_SCHEMA_VERSION,
  CuaSupervisor,
  cuaLineTransport,
  isPinnedCuaBundleIdentifier,
  validBrowserToolArgs,
  type CuaChild,
  type CuaCaptureFilesystem,
  type CuaCaptureFileStat,
  type CuaCaptureDiagnostic,
  type CuaFilesystem,
} from "../../src/native-cua-supervisor.ts";
import { DESKTOP_VISION_PNG_MAX_BYTES } from "../../src/native-image-contract.ts";

const scope: ComputerUseContextScope = {
  computerUseContextId: "server-context-1", installationEpoch: "epoch-1", grantGeneration: 1,
  provider: "cua", providerGeneration: "provider-generation-1",
  originHumanId: "human-1", originRunId: "run-1", originAgentId: "agent-1", lineageId: "lineage-1",
  serverBindingId: "binding-1", relayId: "relay-1", pairingGeneration: "pairing-1", desktopSessionId: "desktop-1",
};

class Child implements CuaChild {
  pid: number | undefined;
  exited = false;
  stdin = { end: () => { this.stdinEnded = true; } };
  stdinEnded = false;
  kills: string[] = [];
  private listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  private killWaiters = new Map<string, (() => void)[]>();
  constructor(pid: number | undefined = 4242, private readonly exitOnTerm = true) { this.pid = pid; }
  kill(signal?: NodeJS.Signals): boolean {
    const observed = signal ?? "SIGTERM";
    this.kills.push(observed);
    for (const resolve of this.killWaiters.get(observed) ?? []) resolve();
    this.killWaiters.delete(observed);
    if (signal === "SIGTERM" && !this.exitOnTerm) return true;
    this.exited = true;
    this.emit("exit", 0, signal);
    return true;
  }
  once(event: "exit" | "error", listener: (...args: unknown[]) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  removeListener(event: "exit" | "error", listener: (...args: unknown[]) => void): void {
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener));
  }
  unexpectedExit(): void {
    this.exited = true;
    this.emit("exit", 1, "SIGTERM");
  }
  unexpectedError(): void {
    this.emit("error", new Error("unexpected child failure"));
  }
  untilKilled(signal: NodeJS.Signals): Promise<void> {
    if (this.kills.includes(signal)) return Promise.resolve();
    return new Promise((resolve) => this.killWaiters.set(signal, [...(this.killWaiters.get(signal) ?? []), resolve]));
  }
  private emit(event: "exit" | "error", ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

function filesystem(): { fs: CuaFilesystem; removed: string[]; replaceSocket: () => void } {
  let socketCreated = false;
  let replaced = false;
  const removed: string[] = [];
  return {
    fs: {
      async lstat(path) {
        if (path === "/private/runtime") return { kind: "directory", mode: 0o700, uid: 501, device: 1n, inode: 2n };
        if (!socketCreated) return null;
        return { kind: "socket", mode: 0o600, uid: 501, device: 1n, inode: replaced ? 99n : 3n };
      },
      async unlink(path) { removed.push(path); },
    },
    removed,
    replaceSocket() { socketCreated = true; replaced = true; },
  };
}

function metadata(pid = 4242, overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    result: {
      driver_version: CUA_DRIVER_VERSION,
      contract_version: CUA_CONTRACT_VERSION,
      tools_list_schema_version: CUA_TOOLS_LIST_SCHEMA_VERSION,
      capability_version: CUA_CAPABILITY_VERSION,
      mcp_protocol_version: CUA_MCP_PROTOCOL_VERSION,
      pid,
      embedded: true,
      host_bundle_id: "com.nautilo.desktop",
      ...overrides,
    },
  };
}

function toolResult(structuredContent: Record<string, unknown> = {}, isError = false) {
  return { ok: true, result: { content: [], isError, structuredContent } };
}

/** Literal pinned v0.19.3 read-only embedded-host permission envelope. */
function embeddedPermissionReport(options: {
  accessibility?: boolean;
  screenRecording?: boolean;
  pid?: number;
  executable?: string;
  hostBundleId?: string;
  source?: Record<string, unknown>;
  extra?: Record<string, unknown>;
} = {}) {
  return {
    accessibility: options.accessibility ?? true,
    screen_recording: options.screenRecording ?? true,
    screen_recording_capturable: null,
    direct_capture_status: "not_checked",
    direct_capture_error: null,
    source: options.source ?? {
      attribution: "host",
      host_bundle_id: options.hostBundleId ?? "com.nautilo.desktop",
      embedded: true,
      direct_runtime: false,
      pid: options.pid ?? 4242,
      responsible_ppid: 4000,
      executable: options.executable ?? "/app/cua-driver",
      disclaim_env: false,
      note: "Embedded mode: these booleans reflect the HOST app's TCC grant.",
    },
    ...options.extra,
  };
}

type HealthStatus = "pass" | "fail" | "skip";

function healthCheck(name: string, status: HealthStatus, options: { data?: Record<string, unknown> } = {}) {
  return {
    name,
    status,
    message: `${name} ${status}`,
    ...(status === "fail" ? { hint: `resolve ${name}` } : {}),
    ...(options.data === undefined ? {} : { data: options.data }),
  };
}

/** Literal pinned v0.19.3 macOS report; embedded bundle identity is non-core. */
function embeddedHealthReport(overrides: Partial<Record<string, HealthStatus>> = {}) {
  const statuses = {
    binary_version: "pass",
    platform_supported: "pass",
    session_active: "pass",
    bundle_identity: "fail",
    tcc_accessibility: "pass",
    tcc_screen_recording: "pass",
    ax_capability: "pass",
    screen_capture_capability: "skip",
    ...overrides,
  } satisfies Record<string, HealthStatus>;
  const checks = Object.entries(statuses).map(([name, status]) => healthCheck(name, status,
    name === "platform_supported" ? { data: { os_version: "26.5.2", architecture: "arm64" } }
      : name === "bundle_identity" ? { data: { bundle_identifier: "com.nautilo.desktop", executable_path: "/app/cua-driver" } }
        : {}));
  const failures = Object.entries(statuses).filter(([, status]) => status === "fail").map(([name]) => name);
  const overall = failures.some((name) => ["binary_version", "platform_supported", "session_active"].includes(name))
    ? "failed" : failures.length > 0 ? "degraded" : "ok";
  return { schema_version: "1", platform: "darwin", driver_version: CUA_DRIVER_VERSION, overall, checks };
}

function pinnedToolResult(structuredContent: Record<string, unknown>) {
  return { ok: true, result: { content: [{ type: "text", text: "pinned diagnostic summary" }], structuredContent } };
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 0 ? crc >>> 1 : (crc >>> 1) ^ 0xedb88320;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data = new Uint8Array()): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const output = new Uint8Array(12 + data.length);
  new DataView(output.buffer).setUint32(0, data.length);
  output.set(typeBytes, 4); output.set(data, 8);
  new DataView(output.buffer).setUint32(8 + data.length, crc32(output.subarray(4, 8 + data.length)));
  return output;
}

function capturePng(pad = 0): Uint8Array {
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks = [
    pngChunk("IHDR", new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])),
    pngChunk("IDAT", new Uint8Array([0x78, 1, 1, 5, 0, 250, 255, 0, 0, 0, 0, 0, 0, 5, 0, 1])),
    ...(pad === 0 ? [] : [pngChunk("raNd", new Uint8Array(pad))]), pngChunk("IEND"),
  ];
  const result = new Uint8Array(signature.length + chunks.reduce((size, chunk) => size + chunk.length, 0));
  result.set(signature); let offset = signature.length;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

function captureHarness(options: { bytes?: Uint8Array; result?: (path: string) => unknown; windowResult?: (path: string) => unknown; clickResult?: unknown; permissionResult?: Record<string, unknown>; healthResult?: Record<string, unknown>; replace?: boolean; unlinkFails?: boolean; closeFails?: boolean; readFails?: boolean; stat?: Partial<CuaCaptureFileStat>; random?: () => Uint8Array; onRead?: () => Promise<void>; onUnlink?: () => Promise<void>; onWindowCall?: (request: Record<string, unknown>, signal?: AbortSignal) => Promise<void>; onDesktopCall?: (request: Record<string, unknown>, signal?: AbortSignal) => Promise<void>; onClickCall?: (request: Record<string, unknown>, signal?: AbortSignal) => Promise<void>; onCaptureDiagnostic?: (event: CuaCaptureDiagnostic) => void } = {}) {
  const child = new Child(); let socket = false; let exists = true; let opened: string | null = null; let unlinked = false; let randomCalls = 0; const requests: Record<string, unknown>[] = [];
  const bytes = options.bytes ?? capturePng();
  const stat = { kind: "file" as const, mode: 0o600, uid: 501n, device: 7n, inode: 8n, nlink: 1n };
  const captureFilesystem: CuaCaptureFilesystem = {
    async open(path, flags) {
      expect(flags).toBe("wx+"); opened = path; exists = true;
      return {
        async stat() { return { ...stat, ...options.stat }; },
        async read(buffer, offset, length, position) { await options.onRead?.(); if (options.readFails) throw new Error("read"); const chunk = bytes.subarray(position, position + length); buffer.set(chunk, offset); return { bytesRead: chunk.length }; },
        async close() { if (options.closeFails) throw new Error("close"); },
      };
    },
    async lstat() { return exists ? options.replace ? { ...stat, inode: 99n } : stat : null; },
    async unlink() { await options.onUnlink?.(); if (options.unlinkFails) throw new Error("unlink"); exists = false; unlinked = true; },
  };
  const supervisor = new CuaSupervisor({
    binaryPath: "/app/cua-driver", runtimeDir: "/private/runtime", expectedUid: 501,
    ...(options.onCaptureDiagnostic === undefined ? {} : { onCaptureDiagnostic: options.onCaptureDiagnostic }),
    randomBytes: () => randomCalls++ === 0 ? new Uint8Array(24).fill(9) : options.random?.() ?? new Uint8Array(24).fill(9), captureFilesystem, spawn: () => child,
    filesystem: { async lstat(path) { return path === "/private/runtime" ? { kind: "directory", mode: 0o700, uid: 501, device: 1n, inode: 2n } : socket ? { kind: "socket", mode: 0o600, uid: 501, device: 1n, inode: 3n } : null; }, async unlink() {} },
    async transport(_socket, request, signal) {
      requests.push(request as Record<string, unknown>);
      if (request.method === "metadata") { socket = true; return metadata(); }
      if (request.name === "check_permissions") return pinnedToolResult(options.permissionResult ?? embeddedPermissionReport());
      if (request.name === "health_report") return pinnedToolResult(options.healthResult ?? embeddedHealthReport());
      if (request.name === "get_desktop_state") {
        await options.onDesktopCall?.(request as Record<string, unknown>, signal);
        const path = (request.args as Record<string, unknown>)["screenshot_out_file"];
        if (typeof path !== "string") throw new Error("missing path");
        return options.result?.(path) ?? { ok: true, result: { content: [{ type: "text", text: "captured" }], structuredContent: { platform: "macos", display: "primary", screenshot_width: 1, screenshot_height: 1, screen_width: 1, screen_height: 1, scale_factor: 1, screenshot_mime_type: "image/png", screenshot_file_path: path } } };
      }
      if (request.name === "get_window_state") {
        await options.onWindowCall?.(request as Record<string, unknown>, signal);
        const path = (request.args as Record<string, unknown>)["screenshot_out_file"];
        if (typeof path !== "string") return toolResult({
          _note: "fixture", window_id: (request.args as Record<string, unknown>)["window_id"],
          pid: (request.args as Record<string, unknown>)["pid"], element_count: 0, total_element_count: 0,
          returned_element_count: 0, elements_complete: false, tree_markdown: "", elements: [],
        });
        return options.windowResult?.(path) ?? { ok: true, result: {
          content: [{ type: "text", text: "window captured" }],
          structuredContent: {
            _note: "fixture", window_id: 90, pid: 42, element_count: 0, total_element_count: 0,
            returned_element_count: 0, elements_complete: false, tree_markdown: "", elements: [],
            screenshot_width: 1, screenshot_height: 1, screenshot_mime_type: "image/png",
            window_bounds: { x: 0, y: 0, width: 1, height: 1 }, screenshot_scale: 1,
            screenshot_frame_valid: true, screenshot_file_path: path,
          },
        } };
      }
      if (request.name === "click") {
        await options.onClickCall?.(request as Record<string, unknown>, signal);
        return options.clickResult ?? {
        ok: true,
        result: {
          content: [{ type: "text", text: "clicked" }],
          structuredContent: { effect: "unverifiable", route: "global_input", delivery: { mode: "not_applicable" } },
        },
        };
      }
      return toolResult({});
    },
  });
  return { supervisor, child, opened: () => opened, unlinked: () => unlinked, requests };
}

describe("D516 embedded Cua supervisor", () => {
  test("contains literal private CFBundle identifiers without rejecting real numeric or underscore segments", () => {
    const atBoundary = `com.${"a".repeat(2044)}`;
    const overBoundary = `com.${"a".repeat(2045)}`;
    expect(atBoundary).toHaveLength(2048);
    expect(overBoundary).toHaveLength(2049);
    expect(isPinnedCuaBundleIdentifier(atBoundary)).toBe(true);
    expect(isPinnedCuaBundleIdentifier(overBoundary)).toBe(false);
    expect(isPinnedCuaBundleIdentifier("com.1password.1password")).toBe(true);
    // Literal Apple inventory row emitted by pinned Cua list_apps on macOS.
    expect(isPinnedCuaBundleIdentifier("com.apple.Image_Capture")).toBe(true);
  });

  test("accepts the literal pinned embedded-host health contract and only its reviewed bundle degradation", async () => {
    const accepted = captureHarness();
    await expect(accepted.supervisor.refreshHealth()).resolves.toMatchObject({
      ok: true,
      health: { permission: "ready", health: "ready" },
      healthFreshness: "fresh",
    });
    expect(accepted.supervisor.existingHealthyGeneration()).toMatch(/^cua_/);

    for (const healthResult of [
      embeddedHealthReport({ binary_version: "fail" }),
      embeddedHealthReport({ tcc_accessibility: "fail" }),
      embeddedHealthReport({ screen_capture_capability: "fail" }),
    ]) {
      const rejected = captureHarness({ healthResult });
      await expect(rejected.supervisor.ensureRunning()).resolves.toMatchObject({
        ok: true,
        health: { health: "degraded" },
      });
      expect(rejected.supervisor.existingHealthyGeneration()).toBeNull();
      // This test is about readiness classification, not the separately
      // covered two-second live-child shutdown grace. Simulate normal child
      // exit so cleanup does not consume that grace three times.
      rejected.child.unexpectedExit();
      await rejected.supervisor.shutdown();
    }
  });

  test("fences malformed, widened, or wrongly attributed pinned diagnostic envelopes", async () => {
    const wrongSource = embeddedPermissionReport({
      source: {
        attribution: "driver-daemon", host_bundle_id: "com.nautilo.desktop", embedded: true,
        direct_runtime: false, pid: 4242, responsible_ppid: 4000, executable: "/app/cua-driver",
        disclaim_env: false, note: "wrong owner",
      },
    });
    const widenedPermission = embeddedPermissionReport({ extra: { input_monitoring: true } });
    for (const permissionResult of [wrongSource, widenedPermission]) {
      const rejected = captureHarness({ permissionResult });
      await expect(rejected.supervisor.ensureRunning()).resolves.toEqual({ ok: false, code: "permission_check_failed" });
      expect(rejected.supervisor.existingHealthyGeneration()).toBeNull();
    }

    const shorthand = { status: "ok" };
    const mismatchedRollup = { ...embeddedHealthReport(), overall: "ok" };
    const widenedHealth = { ...embeddedHealthReport(), diagnostic: "provider-only" };
    for (const healthResult of [shorthand, mismatchedRollup, widenedHealth]) {
      const rejected = captureHarness({ healthResult });
      await expect(rejected.supervisor.ensureRunning()).resolves.toEqual({ ok: false, code: "health_check_failed" });
      expect(rejected.supervisor.existingHealthyGeneration()).toBeNull();
    }
  });

  test("performs only the exact pinned desktop click and retains its successful lease", async () => {
    const harness = captureHarness();
    const ready = await harness.supervisor.refreshHealth();
    if (!ready.ok) throw new Error("expected healthy");
    const clicked = await harness.supervisor.clickDesktop(scope, ready.generation, 100.5, 200.25);
    expect(clicked).toEqual({
      ok: true,
      generation: ready.generation,
      sessionId: expect.stringMatching(/^cua_session_/),
      effect: "unverifiable",
      route: "global_input",
      delivery: "not_applicable",
    });
    const request = harness.requests.find((candidate) => candidate.name === "click");
    expect(request).toEqual({
      method: "call",
      name: "click",
      args: { x: 100.5, y: 200.25, scope: "desktop" },
      session_id: clicked.ok ? clicked.sessionId : "",
    });
    expect(harness.requests.filter((candidate) => candidate.name === "end_session")).toHaveLength(0);
    if (clicked.ok) await harness.supervisor.endContextLease(scope, clicked.generation, clicked.sessionId);
    expect(harness.requests.filter((candidate) => candidate.name === "end_session")).toHaveLength(1);
  });

  test("rejects pre-session coordinates and fences any non-pinned post-boundary click result", async () => {
    const harness = captureHarness();
    const ready = await harness.supervisor.refreshHealth();
    if (!ready.ok) throw new Error("expected healthy");
    await expect(harness.supervisor.clickDesktop(scope, ready.generation, -1, 0))
      .resolves.toEqual({ ok: false, code: "invalid_configuration", stage: "session" });
    expect(harness.requests.some((candidate) => candidate.name === "click")).toBe(false);

    const malformed = captureHarness({
      clickResult: { ok: true, result: { content: [{ type: "text", text: "clicked" }], structuredContent: { effect: "confirmed", route: "global_input", delivery: { mode: "foreground" } } } },
    });
    const ready2 = await malformed.supervisor.refreshHealth();
    if (!ready2.ok) throw new Error("expected healthy");
    await expect(malformed.supervisor.clickDesktop(scope, ready2.generation, 1, 2))
      .resolves.toEqual({ ok: false, code: "context_fenced", stage: "tool" });
    expect(malformed.supervisor.existingHealthyGeneration()).toBeNull();
    expect(malformed.requests.filter((candidate) => candidate.name === "end_session")).toHaveLength(1);
  });

  test("passes desktop pointer options unchanged and rejects invalid input before dispatch", async () => {
    const harness = captureHarness();
    const ready = await harness.supervisor.refreshHealth();
    if (!ready.ok) throw new Error("expected healthy");
    for (const button of ["left", "right", "middle"] as const) {
      const clicked = await harness.supervisor.clickDesktop(scope, ready.generation, 12, 24, undefined, {
        button, count: 3, modifiers: ["cmd", "shift"],
      });
      expect(clicked.ok).toBe(true);
      expect(harness.requests.filter((candidate) => candidate.name === "click").at(-1)?.args).toEqual({
        x: 12, y: 24, scope: "desktop", button, count: 3, modifier: ["cmd", "shift"],
      });
      if (clicked.ok) await harness.supervisor.endContextLease(scope, clicked.generation, clicked.sessionId);
    }
    const before = harness.requests.length;
    for (const count of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(harness.supervisor.clickDesktop(scope, ready.generation, 12, 24, undefined, { count }))
        .resolves.toEqual({ ok: false, code: "invalid_configuration", stage: "session" });
    }
    expect(harness.requests).toHaveLength(before);
  });

  test("checks desktop dispatch authority after session setup and releases the lease on refusal", async () => {
    for (const cancelDuringCheck of [false, true]) {
      const harness = captureHarness();
      const ready = await harness.supervisor.refreshHealth();
      if (!ready.ok) throw new Error("expected healthy");
      const abort = new AbortController();
      const entered = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<boolean>();
      const pending = harness.supervisor.clickDesktop(scope, ready.generation, 12, 24, abort.signal, { modifiers: ["cmd"] }, async () => {
        expect(harness.requests.some((request) => request.name === "start_session")).toBe(true);
        entered.resolve();
        return finish.promise;
      });
      await entered.promise;
      if (cancelDuringCheck) abort.abort();
      finish.resolve(cancelDuringCheck);
      await expect(pending).resolves.toMatchObject({ ok: false, code: cancelDuringCheck ? "cancelled" : "context_fenced" });
      await harness.supervisor.awaitOutstandingOperations(scope, ready.generation, abort.signal);
      expect(harness.requests.filter((request) => request.name === "click")).toHaveLength(0);
      expect(harness.requests.filter((request) => request.name === "end_session")).toHaveLength(1);
      expect(harness.supervisor.existingHealthyGeneration()).toBe(ready.generation);
    }
  });

  test("captures only the pinned flat file ToolResult through a wx+ retained descriptor and returns no path or text", async () => {
    const harness = captureHarness();
    const ready = await harness.supervisor.refreshHealth();
    if (!ready.ok) throw new Error("expected healthy");
    const result = await harness.supervisor.captureDesktopState(scope, ready.generation);
    expect(result).toMatchObject({ ok: true, nativeWidth: 1, nativeHeight: 1, screenWidth: 1, screenHeight: 1, scaleFactor: 1 });
    expect(harness.opened()).toMatch(/^\/private\/runtime\/capture_[A-Za-z0-9_-]{32}\.png$/);
    expect(harness.unlinked()).toBe(true);
    expect(JSON.stringify(result)).not.toContain("/private/runtime");
    expect(JSON.stringify(result)).not.toContain("captured");
    if (result.ok) await harness.supervisor.endContextLease(scope, result.generation, result.sessionId);
  });

  test("captures an exact window through the owned file and returns only path-free metadata plus PNG bytes", async () => {
    const harness = captureHarness();
    const ready = await harness.supervisor.refreshHealth();
    if (!ready.ok) throw new Error("expected healthy");
    const captured = await harness.supervisor.captureWindowState(scope, ready.generation, 42, 90, undefined, { maxElements: 5_000, maxDepth: 40 });
    expect(captured).toMatchObject({ ok: true, result: { isError: false }, png: expect.any(Uint8Array) });
    expect(JSON.stringify(captured)).not.toContain("/private/runtime");
    expect(JSON.stringify(captured)).not.toContain("screenshot_file_path");
    const request = harness.requests.find((candidate) => candidate.name === "get_window_state");
    expect(request).toEqual({
      method: "call",
      name: "get_window_state",
      args: {
        pid: 42, window_id: 90, include_screenshot: true, max_elements: 5_000, max_depth: 40,
        screenshot_out_file: harness.opened(),
      },
      session_id: captured.ok ? captured.sessionId : "",
    });
    expect(harness.unlinked()).toBe(true);
    if (captured.ok) await harness.supervisor.endContextLease(scope, captured.generation, captured.sessionId);
  });

  test("keeps a checked generation for truthful window capture-unavailable metadata", async () => {
    const harness = captureHarness({ windowResult: () => ({ ok: true, result: {
      content: [{ type: "text", text: "capture unavailable" }],
      structuredContent: {
        _note: "fixture", window_id: 90, pid: 42, element_count: 0, total_element_count: 0,
        returned_element_count: 0, elements_complete: false, tree_markdown: "", elements: [],
        degraded: true, degraded_reason: "ax_window_unresolved: fixture", screenshot_frame_valid: false,
        screenshot_error: { code: "px_capture_unavailable", reason: "fixture", suggestion: "focus", window_id: 90 },
      },
    } }) });
    const ready = await harness.supervisor.refreshHealth();
    if (!ready.ok) throw new Error("expected healthy");
    const captured = await harness.supervisor.captureWindowState(scope, ready.generation, 42, 90);
    expect(captured).toMatchObject({ ok: true, png: null });
    expect(harness.supervisor.existingHealthyGeneration()).toBe(ready.generation);
    if (captured.ok) await harness.supervisor.endContextLease(scope, captured.generation, captured.sessionId);
  });

  test("reports malformed pinned output as a provider fact, and fences replacement identity, cleanup uncertainty, and over-cap files without leaking provider fields", async () => {
    // A response-shape mismatch is provider incompatibility: the operation
    // fails without being misclassified as an authority breach. Retaining the
    // checked generation here is not a readiness claim; PR-B owns route
    // withdrawal/degradation after protocol incompatibility.
    const hostile = captureHarness({ result: (path) => ({ ok: true, result: { content: [{ type: "image", data: "base64", mimeType: "image/png" }], structuredContent: { platform: "macos", display: "primary", screenshot_width: 1, screenshot_height: 1, screen_width: 1, screen_height: 1, scale_factor: 1, screenshot_mime_type: "image/png", screenshot_file_path: path } } }) });
    const r1 = await hostile.supervisor.refreshHealth(); if (!r1.ok) throw new Error("ready");
    await expect(hostile.supervisor.captureDesktopState(scope, r1.generation)).resolves.toEqual({ ok: false, code: "provider_malformed" });
    expect(hostile.supervisor.existingHealthyGeneration()).toBe(r1.generation);
    const replaced = captureHarness({ replace: true }); const r2 = await replaced.supervisor.refreshHealth(); if (!r2.ok) throw new Error("ready");
    await expect(replaced.supervisor.captureDesktopState(scope, r2.generation)).resolves.toEqual({ ok: false, code: "context_fenced" });
    expect(replaced.unlinked()).toBe(false);
    const overCap = capturePng(DESKTOP_VISION_PNG_MAX_BYTES - capturePng().length - 12 + 1);
    const capped = captureHarness({ bytes: overCap }); const r3 = await capped.supervisor.refreshHealth(); if (!r3.ok) throw new Error("ready");
    await expect(capped.supervisor.captureDesktopState(scope, r3.generation)).resolves.toEqual({ ok: false, code: "image_too_large" });
    expect(capped.supervisor.existingHealthyGeneration()).toBe(r3.generation);
    const cleanup = captureHarness({ unlinkFails: true }); const r4 = await cleanup.supervisor.refreshHealth(); if (!r4.ok) throw new Error("ready");
    await expect(cleanup.supervisor.captureDesktopState(scope, r4.generation)).resolves.toEqual({ ok: false, code: "context_fenced" });
    expect(cleanup.supervisor.existingHealthyGeneration()).toBeNull();
  });

  test("cannot publish a capture when cancellation lands during retained-fd read or awaited cleanup", async () => {
    let releaseRead: (() => void) | null = null; let readStarted: (() => void) | null = null;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const readSeen = new Promise<void>((resolve) => { readStarted = resolve; });
    const first = captureHarness({ onRead: async () => { readStarted?.(); await readGate; } });
    const ready = await first.supervisor.refreshHealth(); if (!ready.ok) throw new Error("ready");
    const abort = new AbortController(); const pending = first.supervisor.captureDesktopState(scope, ready.generation, abort.signal);
    await readSeen; abort.abort(); releaseRead?.();
    await expect(pending).resolves.toEqual({ ok: false, code: "cancelled" });

    let releaseUnlink: (() => void) | null = null; let unlinkStarted: (() => void) | null = null;
    const unlinkGate = new Promise<void>((resolve) => { releaseUnlink = resolve; });
    const unlinkSeen = new Promise<void>((resolve) => { unlinkStarted = resolve; });
    const second = captureHarness({ onUnlink: async () => { unlinkStarted?.(); await unlinkGate; } });
    const ready2 = await second.supervisor.refreshHealth(); if (!ready2.ok) throw new Error("ready");
    const abort2 = new AbortController(); const pending2 = second.supervisor.captureDesktopState(scope, ready2.generation, abort2.signal);
    await unlinkSeen; abort2.abort(); releaseUnlink?.();
    await expect(pending2).resolves.toEqual({ ok: false, code: "cancelled" });

    let releaseDeath: (() => void) | null = null; let deathStarted: (() => void) | null = null;
    const deathGate = new Promise<void>((resolve) => { releaseDeath = resolve; });
    const deathSeen = new Promise<void>((resolve) => { deathStarted = resolve; });
    const third = captureHarness({ onRead: async () => { deathStarted?.(); await deathGate; } });
    const ready3 = await third.supervisor.refreshHealth(); if (!ready3.ok) throw new Error("ready");
    const pending3 = third.supervisor.captureDesktopState(scope, ready3.generation);
    await deathSeen; third.child.unexpectedExit(); releaseDeath?.();
    await expect(pending3).resolves.toEqual({ ok: false, code: "stale_generation" });
  });

  test("drains cancelled desktop capture, exact-window capture, and desktop click through raw settlement", async () => {
    const exercise = async (kind: "desktop" | "window" | "click") => {
      const gate = Promise.withResolvers<void>();
      const dispatched = Promise.withResolvers<AbortSignal | undefined>();
      const callback = async (_request: Record<string, unknown>, signal?: AbortSignal) => {
        dispatched.resolve(signal);
        await gate.promise;
      };
      const harness = captureHarness({
        ...(kind === "desktop" ? { onDesktopCall: callback } : {}),
        ...(kind === "window" ? { onWindowCall: callback } : {}),
        ...(kind === "click" ? { onClickCall: callback } : {}),
      });
      const ready = await harness.supervisor.refreshHealth();
      if (!ready.ok) throw new Error("expected ready supervisor");
      const abort = new AbortController();
      const pending = kind === "desktop"
        ? harness.supervisor.captureDesktopState(scope, ready.generation, abort.signal)
        : kind === "window"
          ? harness.supervisor.captureWindowState(scope, ready.generation, 42, 90, abort.signal)
          : harness.supervisor.clickDesktop(scope, ready.generation, 10, 20, abort.signal);
      expect(await dispatched.promise).toBeUndefined();
      abort.abort();
      await expect(pending).resolves.toMatchObject({ ok: false, code: "cancelled" });
      let drained = false;
      const drain = harness.supervisor.awaitOutstandingOperations(scope, ready.generation, abort.signal)
        .then(() => { drained = true; });
      await Promise.resolve();
      expect(drained).toBe(false);
      gate.resolve();
      await drain;
      expect(drained).toBe(true);
      if (kind !== "click") expect(harness.unlinked()).toBe(true);
      harness.child.unexpectedExit();
      await harness.supervisor.shutdown();
    };
    await exercise("desktop");
    await exercise("window");
    await exercise("click");
  });

  test("serializes daemon-global exact-window reads through cancellation and across capture", async () => {
    const arrivals: number[] = [];
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const harness = captureHarness({
      onWindowCall: async (request) => {
        const windowId = (request.args as Record<string, unknown>)["window_id"] as number;
        arrivals.push(windowId);
        if (windowId === 90) await gates[arrivals.filter((candidate) => candidate === 90).length - 1]!.promise;
      },
    });
    const ready = await harness.supervisor.refreshHealth();
    if (!ready.ok) throw new Error("expected ready supervisor");
    const cancelled = new AbortController();
    const first = harness.supervisor.getWindowState(scope, ready.generation, 42, 90, undefined, cancelled.signal);
    while (arrivals.length < 1) await Promise.resolve();
    cancelled.abort();
    await expect(first).resolves.toEqual({ ok: false, code: "cancelled", stage: "tool" });
    let firstDrained = false;
    const firstDrain = harness.supervisor.awaitOutstandingOperations(scope, ready.generation, cancelled.signal)
      .then(() => { firstDrained = true; });
    await Promise.resolve();
    expect(firstDrained).toBe(false);

    const secondScope = { ...scope, computerUseContextId: "server-context-2" };
    const second = harness.supervisor.callContextTool(secondScope, ready.generation, "get_window_state", {
      pid: 42, window_id: 90, include_screenshot: false,
    });
    const capture = harness.supervisor.captureWindowState(scope, ready.generation, 42, 90);
    const independent = harness.supervisor.getWindowState(scope, ready.generation, 42, 91);
    while (!arrivals.includes(91)) await Promise.resolve();
    expect(arrivals).toEqual([90, 91]);
    const independentResult = await independent;
    if (!independentResult.ok) throw new Error("expected independent window read");

    gates[0]!.resolve();
    await firstDrain;
    expect(firstDrained).toBe(true);
    while (arrivals.filter((candidate) => candidate === 90).length < 2) await Promise.resolve();
    expect(arrivals).toEqual([90, 91, 90]);
    gates[1]!.resolve();
    const secondResult = await second;
    if (!secondResult.ok) throw new Error("expected second read");
    while (arrivals.filter((candidate) => candidate === 90).length < 3) await Promise.resolve();
    expect(arrivals).toEqual([90, 91, 90, 90]);
    gates[2]!.resolve();
    const captureResult = await capture;
    if (!captureResult.ok) throw new Error("expected serialized capture");

    await Promise.all([
      harness.supervisor.endContextLease(scope, independentResult.generation, independentResult.sessionId),
      harness.supervisor.endContextLease(secondScope, secondResult.generation, secondResult.sessionId),
      harness.supervisor.endContextLease(scope, captureResult.generation, captureResult.sessionId),
    ]);
    await harness.supervisor.shutdown();
  });

  test("never dispatches queued window reads after their active generation is fenced", async () => {
    const gate = Promise.withResolvers<void>();
    let dispatched = 0;
    const harness = captureHarness({
      onWindowCall: async () => {
        dispatched += 1;
        if (dispatched === 1) await gate.promise;
      },
    });
    const ready = await harness.supervisor.refreshHealth();
    if (!ready.ok) throw new Error("expected ready supervisor");
    const first = harness.supervisor.getWindowState(scope, ready.generation, 42, 90);
    while (dispatched < 1) await Promise.resolve();
    const queued = harness.supervisor.getWindowState(scope, ready.generation, 42, 90);
    harness.child.unexpectedExit();
    gate.resolve();
    await expect(first).resolves.toEqual({ ok: false, code: "stale_generation", stage: "tool" });
    await expect(queued).resolves.toMatchObject({ ok: false });
    expect(dispatched).toBe(1);
    await harness.supervisor.shutdown();
  });

  test("releases a successful read lease when cancellation wins the delivery microtask", async () => {
    let armed = false;
    const listeners = new Set<() => void>();
    const signal = {
      get aborted() {
        if (armed) {
          armed = false;
          for (const listener of listeners) listener();
        }
        // Model the exact race: the direct call's final abort sample was
        // already false, while its synchronous getter delivered cancellation
        // to the outer caller before the successful value's `.then` ran.
        return false;
      },
      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        if (type === "abort") listeners.add(typeof listener === "function" ? () => listener(new Event("abort")) : () => listener.handleEvent(new Event("abort")));
      },
      removeEventListener() {},
    } as unknown as AbortSignal;
    const harness = captureHarness({ onWindowCall: async () => { armed = true; } });
    const ready = await harness.supervisor.refreshHealth();
    if (!ready.ok) throw new Error("expected ready supervisor");
    await expect(harness.supervisor.getWindowState(scope, ready.generation, 42, 90, undefined, signal))
      .resolves.toEqual({ ok: false, code: "cancelled", stage: "tool" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.requests.filter((request) => request.name === "get_window_state")).toHaveLength(1);
    expect(harness.requests.filter((request) => request.name === "end_session")).toHaveLength(1);
    await harness.supervisor.shutdown();
  });

  test("discards a successful window capture when cancellation wins its delivery microtask", async () => {
    let armed = false;
    const listeners = new Set<() => void>();
    const signal = {
      get aborted() {
        if (armed) {
          armed = false;
          for (const listener of listeners) listener();
        }
        return false;
      },
      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        if (type === "abort") listeners.add(typeof listener === "function" ? () => listener(new Event("abort")) : () => listener.handleEvent(new Event("abort")));
      },
      removeEventListener() {},
    } as unknown as AbortSignal;
    const harness = captureHarness({ onWindowCall: async () => { armed = true; } });
    const ready = await harness.supervisor.refreshHealth();
    if (!ready.ok) throw new Error("expected ready supervisor");
    await expect(harness.supervisor.captureWindowState(scope, ready.generation, 42, 90, signal))
      .resolves.toEqual({ ok: false, code: "cancelled" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.unlinked()).toBe(true);
    expect(harness.requests.filter((request) => request.name === "get_window_state")).toHaveLength(1);
    expect(harness.requests.filter((request) => request.name === "end_session")).toHaveLength(1);
    await harness.supervisor.shutdown();
  });

  test("a daemon echoing a mismatched capture path fails one operation with a named path_equality predicate", async () => {
    // Regression pin for the 2026-08-14 live failure: the runtime directory
    // lived under /tmp (a Darwin symlink into /private), the daemon echoed
    // the canonical spelling, and the exact-equality predicate failed. The
    // supervisor must report the exact predicate content-free and must NOT
    // misclassify the provider failure as a Human authority revocation.
    const diagnostics: CuaCaptureDiagnostic[] = [];
    const echoCanonical = captureHarness({
      onCaptureDiagnostic: (event) => diagnostics.push(event),
      result: (path) => ({ ok: true, result: { content: [{ type: "text", text: "captured" }], structuredContent: {
        platform: "macos", display: "primary", screenshot_width: 1, screenshot_height: 1,
        screen_width: 1, screen_height: 1, scale_factor: 1, screenshot_mime_type: "image/png",
        screenshot_file_path: `/private/tmp-alias${path}`,
      } } }),
    });
    const ready = await echoCanonical.supervisor.refreshHealth(); if (!ready.ok) throw new Error("ready");
    await expect(echoCanonical.supervisor.captureDesktopState(scope, ready.generation)).resolves.toEqual({ ok: false, code: "provider_malformed" });
    expect(echoCanonical.supervisor.existingHealthyGeneration()).toBe(ready.generation);
    const malformed = diagnostics.find((event) => event.code === "provider_malformed");
    expect(malformed?.predicate).toBe("path_equality");
    expect(malformed?.stage).toBe("provider_result");
    // The diagnostic stays content-free: it carries no provider fields.
    expect(JSON.stringify(diagnostics)).not.toContain("/private/tmp-alias");
    // This test intentionally makes no readiness/route assertion. The
    // automatic readiness response to repeated malformed provider output is
    // PR-B work, not a durable-authority decision in this supervisor.
    const recovered = await echoCanonical.supervisor.refreshHealth();
    expect(recovered.ok).toBe(true);
  });

  test("classifies every non-pinned result shape as provider_malformed and still fences hostile retained-file stat", async () => {
    const shaped: Array<(path: string) => unknown> = [
      (path) => ({ ok: true, result: { isError: false, content: [{ type: "text", text: "x" }], structuredContent: { platform: "macos", display: "primary", screenshot_width: 1, screenshot_height: 1, screen_width: 1, screen_height: 1, scale_factor: 1, screenshot_mime_type: "image/png", screenshot_file_path: path } } }),
      (path) => ({ ok: true, result: { content: [{ type: "text", text: "x" }], structuredContent: { platform: "macos", display: "primary", screenshot: { width: 1 }, screenshot_width: 1, screenshot_height: 1, screen_width: 1, screen_height: 1, scale_factor: 1, screenshot_mime_type: "image/png", screenshot_file_path: path } } }),
      (path) => ({ ok: true, result: { content: [{ type: "text", text: "x" }], structuredContent: { platform: "macos", display: "primary", screenshot_width: 1, screenshot_height: 1, screen_width: 1, screen_height: 1, scale_factor: 1, screenshot_mime_type: "image/png", screenshot_file_path: `${path}.other` } } }),
    ];
    for (const result of shaped) {
      const h = captureHarness({ result }); const ready = await h.supervisor.refreshHealth(); if (!ready.ok) throw new Error("ready");
      await expect(h.supervisor.captureDesktopState(scope, ready.generation)).resolves.toEqual({ ok: false, code: "provider_malformed" });
      // Provider incompatibility never revokes the checked generation.
      expect(h.supervisor.existingHealthyGeneration()).toBe(ready.generation);
    }
    for (const stat of [{ mode: 0o644 }, { uid: 999n }, { nlink: 2n }, { kind: "symlink" as const }, { inode: 0n }]) {
      const h = captureHarness({ stat }); const ready = await h.supervisor.refreshHealth(); if (!ready.ok) throw new Error("ready");
      await expect(h.supervisor.captureDesktopState(scope, ready.generation)).resolves.toEqual({ ok: false, code: "context_fenced" });
      expect(h.supervisor.existingHealthyGeneration()).toBeNull();
    }
  });

  test("keeps exact capture args/session and lease counts, while invalid PNG, dimensions, RNG, and read/close failures fence", async () => {
    const h = captureHarness(); const ready = await h.supervisor.refreshHealth(); if (!ready.ok) throw new Error("ready");
    const one = await h.supervisor.captureDesktopState(scope, ready.generation); const two = await h.supervisor.captureDesktopState(scope, ready.generation);
    if (!one.ok || !two.ok) throw new Error("capture");
    const calls = h.requests.filter((request) => request.name === "get_desktop_state");
    expect(calls).toHaveLength(2); expect(calls[0]?.args).toEqual({ screenshot_out_file: h.opened() }); expect(calls[0]?.session_id).toBe(one.sessionId);
    await h.supervisor.endContextLease(scope, one.generation, one.sessionId);
    expect(h.requests.filter((request) => request.name === "end_session")).toHaveLength(0);
    await h.supervisor.endContextLease(scope, two.generation, two.sessionId);
    expect(h.requests.filter((request) => request.name === "end_session")).toHaveLength(1);
    const cases = [
      captureHarness({ bytes: new Uint8Array([1, 2, 3]) }), captureHarness({ result: (path) => ({ ok: true, result: { content: [{ type: "text", text: "x" }], structuredContent: { platform: "macos", display: "primary", screenshot_width: 2, screenshot_height: 1, screen_width: 1, screen_height: 1, scale_factor: 1, screenshot_mime_type: "image/png", screenshot_file_path: path } } }) }),
      captureHarness({ random: () => { throw new Error("rng"); } }), captureHarness({ readFails: true }), captureHarness({ closeFails: true }),
    ];
    for (const candidate of cases) {
      const r = await candidate.supervisor.refreshHealth(); if (!r.ok) throw new Error("ready");
      const output = await candidate.supervisor.captureDesktopState(scope, r.generation);
      expect(output.ok).toBe(false);
    }
    const invalidNonce = captureHarness({ random: () => new Uint8Array(1) }); const nonceReady = await invalidNonce.supervisor.refreshHealth(); if (!nonceReady.ok) throw new Error("ready");
    await expect(invalidNonce.supervisor.captureDesktopState(scope, nonceReady.generation)).resolves.toEqual({ ok: false, code: "invalid_configuration" });
    expect(invalidNonce.supervisor.existingHealthyGeneration()).toBe(nonceReady.generation);
    const stale = captureHarness(); const staleReady = await stale.supervisor.refreshHealth(); if (!staleReady.ok) throw new Error("ready");
    await expect(stale.supervisor.captureDesktopState(scope, "cua_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")).resolves.toEqual({ ok: false, code: "context_fenced" });
    expect(stale.opened()).toBeNull();
  });
  test("coalesces start, uses the exact closed launch contract, attests metadata, and starts a host-derived session", async () => {
    const child = new Child();
    const launches: unknown[] = [];
    let socketCreated = false;
    const calls: Record<string, unknown>[] = [];
    const supervisor = new CuaSupervisor({
      binaryPath: "/Applications/Nautilo.app/Contents/Resources/cua-driver",
      runtimeDir: "/private/runtime",
      userHomePath: "/Users/tester",
      expectedUid: 501,
      hostBundleId: "com.example.cua-host-fixture",
      randomBytes: () => new Uint8Array(24).fill(7),
      filesystem: {
        async lstat(path) {
          if (path === "/private/runtime") return { kind: "directory", mode: 0o700, uid: 501, device: 1n, inode: 2n };
          if (path === "/Users/tester") return { kind: "directory", mode: 0o700, uid: 501, device: 1n, inode: 4n };
          return socketCreated ? { kind: "socket", mode: 0o600, uid: 501, device: 1n, inode: 3n } : null;
        },
        async unlink() {},
      },
      spawn(binary, args, options) { launches.push({ binary, args, options }); return child; },
      async transport(_socket, request) {
        calls.push(request as Record<string, unknown>);
        if (request.method === "metadata") {
          socketCreated = true;
          return metadata(4242, { host_bundle_id: "com.example.cua-host-fixture" });
        }
        if (request.name === "check_permissions") return pinnedToolResult(embeddedPermissionReport({
          executable: "/Applications/Nautilo.app/Contents/Resources/cua-driver",
          hostBundleId: "com.example.cua-host-fixture",
        }));
        if (request.name === "health_report") return pinnedToolResult(embeddedHealthReport());
        return toolResult({ status: "ok" });
      },
    });

    const [first, second] = await Promise.all([supervisor.startContext(scope), supervisor.startContext(scope)]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ ok: true, generation: expect.stringMatching(/^cua_[A-Za-z0-9_-]{32}$/), sessionId: expect.stringMatching(/^cua_session_[A-Za-z0-9_-]{43}$/), health: { permission: "ready", health: "ready" } });
    expect(launches).toEqual([{
      binary: "/Applications/Nautilo.app/Contents/Resources/cua-driver",
      args: ["serve", "--embedded", "--parent-liveness-stdio", "--socket", "/private/runtime/cua_BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH.sock", "--host-bundle-id", "com.example.cua-host-fixture", "--permission-mode", "standard", "--grant", "existing-profile", "--no-permissions-gate"],
      options: {
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          HOME: "/Users/tester",
          CUA_DRIVER_EMBEDDED: "1", CUA_DRIVER_HOST_BUNDLE_ID: "com.example.cua-host-fixture",
          CUA_DRIVER_PARENT_LIVENESS_STDIN: "1", CUA_DRIVER_RS_TELEMETRY_ENABLED: "false", CUA_DRIVER_RS_UPDATE_CHECK: "false",
        }, shell: false, stdio: ["pipe", "ignore", "ignore"],
      },
    }]);
    expect(calls[0]).toEqual({ method: "metadata" });
    expect(calls.filter((call) => call.name === "start_session")).toEqual([
      {
        method: "call",
        name: "start_session",
        args: { session: expect.stringMatching(/^cua_session_[A-Za-z0-9_-]{43}$/), capture_scope: "auto" },
        session_id: expect.stringMatching(/^cua_session_[A-Za-z0-9_-]{43}$/),
      },
    ]);
    expect(calls.filter((call) => call.name === "set_agent_cursor_motion")).toEqual([
      {
        method: "call",
        name: "set_agent_cursor_motion",
        args: {
          session: expect.stringMatching(/^cua_session_[A-Za-z0-9_-]{43}$/),
          glide_duration_ms: 120,
          dwell_after_click_ms: 0,
        },
        session_id: expect.stringMatching(/^cua_session_[A-Za-z0-9_-]{43}$/),
      },
    ]);
    expect(JSON.stringify(first)).not.toContain(scope.computerUseContextId);
  });

  test("reports normalized health before any invocation and keeps distinct context sessions isolated on one generation", async () => {
    const child = new Child();
    let socketCreated = false;
    const calls: Record<string, unknown>[] = [];
    const supervisor = new CuaSupervisor({
      binaryPath: "/app/cua-driver", runtimeDir: "/private/runtime", expectedUid: 501, randomBytes: () => new Uint8Array(24).fill(6),
      filesystem: {
        async lstat(path) {
          if (path === "/private/runtime") return { kind: "directory", mode: 0o700, uid: 501, device: 1n, inode: 2n };
          return socketCreated ? { kind: "socket", mode: 0o600, uid: 501, device: 1n, inode: 3n } : null;
        },
        async unlink() {},
      },
      spawn: () => child,
      async transport(_socket, request) {
        calls.push(request as Record<string, unknown>);
        if (request.method === "metadata") { socketCreated = true; return metadata(); }
        if (request.name === "check_permissions") return pinnedToolResult(embeddedPermissionReport());
        if (request.name === "health_report") return pinnedToolResult(embeddedHealthReport());
        return toolResult({ status: "ok" });
      },
    });
    const ready = await supervisor.ensureRunning();
    if (!ready.ok) throw new Error("expected running daemon");
    expect(calls.map((call) => call.name)).toEqual([undefined, "check_permissions", "health_report"]);
    const other = { ...scope, computerUseContextId: "server-context-2", originRunId: "run-2" };
    const [first, second] = await Promise.all([supervisor.startContext(scope), supervisor.startContext(other)]);
    if (!first.ok || !second.ok) throw new Error("expected context sessions");
    expect(first.generation).toBe(ready.generation);
    expect(second.generation).toBe(ready.generation);
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(calls.filter((call) => call.name === "start_session")).toHaveLength(2);
    await supervisor.endContext(scope);
    expect(calls.at(-1)).toEqual({ method: "call", name: "end_session", args: { session: first.sessionId } });
    await expect(supervisor.ensureRunning()).resolves.toEqual(ready);
    await supervisor.shutdown();
    expect(calls.at(-1)).toEqual({ method: "call", name: "end_session", args: { session: second.sessionId } });
  });

  test("invalidates only an unexpectedly dead generation, never reuses stale sessions, and ignores late old-child events", async () => {
    const children: Child[] = [];
    const sockets = new Set<string>();
    let random = 0;
    const starts: Record<string, unknown>[] = [];
    const supervisor = new CuaSupervisor({
      binaryPath: "/app/cua-driver", runtimeDir: "/private/runtime", expectedUid: 501,
      randomBytes: () => new Uint8Array(24).fill(++random),
      filesystem: {
        async lstat(path) {
          if (path === "/private/runtime") return { kind: "directory", mode: 0o700, uid: 501, device: 1n, inode: 2n };
          return sockets.has(path) ? { kind: "socket", mode: 0o600, uid: 501, device: 1n, inode: 3n } : null;
        },
        async unlink(path) { sockets.delete(path); },
      },
      spawn: () => {
        const child = new Child(4_242 + children.length);
        children.push(child);
        return child;
      },
      async transport(socketPath, request) {
        if (request.method === "metadata") { sockets.add(socketPath); return metadata(children.at(-1)!.pid); }
        if (request.name === "check_permissions") return pinnedToolResult(embeddedPermissionReport({ pid: children.at(-1)!.pid }));
        if (request.name === "health_report") return pinnedToolResult(embeddedHealthReport());
        if (request.name === "start_session") starts.push(request as Record<string, unknown>);
        return toolResult({ status: "ok" });
      },
    });
    const first = await supervisor.startContext(scope);
    if (!first.ok) throw new Error("expected first session");
    children[0]!.unexpectedExit();
    await Promise.resolve();
    const second = await supervisor.startContext(scope);
    if (!second.ok) throw new Error("expected fresh generation");
    expect(children).toHaveLength(2);
    expect(second.generation).not.toBe(first.generation);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(starts).toHaveLength(2);
    children[0]!.unexpectedError();
    await expect(supervisor.ensureRunning()).resolves.toMatchObject({ ok: true, generation: second.generation });
  });

  test("cleans context-start bookkeeping when death lands at the capture-to-start seam", async () => {
    const children: Child[] = [];
    const sockets = new Set<string>();
    let random = 0;
    let killAtSeam = true;
    let sessionStarts = 0;
    const supervisor = new CuaSupervisor({
      binaryPath: "/app/cua-driver", runtimeDir: "/private/runtime", expectedUid: 501,
      randomBytes: () => new Uint8Array(24).fill(++random),
      beforeContextStart: () => {
        if (killAtSeam) {
          killAtSeam = false;
          children[0]!.unexpectedExit();
        }
      },
      filesystem: {
        async lstat(path) {
          if (path === "/private/runtime") return { kind: "directory", mode: 0o700, uid: 501, device: 1n, inode: 2n };
          return sockets.has(path) ? { kind: "socket", mode: 0o600, uid: 501, device: 1n, inode: 3n } : null;
        },
        async unlink(path) { sockets.delete(path); },
      },
      spawn: () => {
        const child = new Child(5_000 + children.length);
        children.push(child);
        return child;
      },
      async transport(socketPath, request) {
        if (request.method === "metadata") { sockets.add(socketPath); return metadata(children.at(-1)!.pid); }
        if (request.name === "check_permissions") return pinnedToolResult(embeddedPermissionReport({ pid: children.at(-1)!.pid }));
        if (request.name === "health_report") return pinnedToolResult(embeddedHealthReport());
        if (request.name === "start_session") sessionStarts += 1;
        return toolResult({ status: "ok" });
      },
    });
    await expect(supervisor.startContext(scope)).resolves.toEqual({ ok: false, code: "stale_generation" });
    await Promise.resolve();
    await expect(supervisor.startContext(scope)).resolves.toMatchObject({ ok: true, generation: expect.stringMatching(/^cua_/) });
    expect(children).toHaveLength(2);
    expect(sessionStarts).toBe(1);
  });

  test("unexpected child error reaps a still-live child without letting old errors kill a fresh generation", async () => {
    const children: Child[] = [];
    const sockets = new Set<string>();
    const supervisor = new CuaSupervisor({
      binaryPath: "/app/cua-driver", runtimeDir: "/private/runtime", expectedUid: 501, randomBytes: () => new Uint8Array(24).fill(children.length + 1),
      filesystem: {
        async lstat(path) {
          if (path === "/private/runtime") return { kind: "directory", mode: 0o700, uid: 501, device: 1n, inode: 2n };
          return sockets.has(path) ? { kind: "socket", mode: 0o600, uid: 501, device: 1n, inode: 3n } : null;
        },
        async unlink(path) { sockets.delete(path); },
      },
      spawn: () => {
        const child = new Child(6_000 + children.length, children.length !== 0);
        children.push(child);
        return child;
      },
      async transport(socketPath, request) {
        if (request.method === "metadata") { sockets.add(socketPath); return metadata(children.at(-1)!.pid); }
        if (request.name === "check_permissions") return pinnedToolResult(embeddedPermissionReport({ pid: children.at(-1)!.pid }));
        if (request.name === "health_report") return pinnedToolResult(embeddedHealthReport());
        return toolResult({ status: "ok" });
      },
    });
    await supervisor.ensureRunning();
    const reaped = children[0]!.untilKilled("SIGKILL");
    children[0]!.unexpectedError();
    await reaped;
    // Reaping owns the no-overlap fence through inode-safe cleanup, so wait
    // until its finalizer releases that fence before requesting a replacement.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(children[0]!.kills).toEqual(["SIGKILL"]);
    const fresh = await supervisor.ensureRunning();
    if (!fresh.ok) throw new Error("expected fresh generation after error");
    children[0]!.unexpectedError();
    await expect(supervisor.ensureRunning()).resolves.toEqual(fresh);
  });

  test("initiator cancellation aborts the actual context start and ends any raced session", async () => {
    const child = new Child();
    let socketCreated = false;
    let holdStart!: () => void;
    let firstStart = true;
    const startedCall = new Promise<void>((resolve) => { holdStart = resolve; });
    let sawEnd!: () => void;
    const endedCall = new Promise<void>((resolve) => { sawEnd = resolve; });
    const calls: Record<string, unknown>[] = [];
    const supervisor = new CuaSupervisor({
      binaryPath: "/app/cua-driver", runtimeDir: "/private/runtime", expectedUid: 501, randomBytes: () => new Uint8Array(24).fill(10),
      filesystem: {
        async lstat(path) {
          if (path === "/private/runtime") return { kind: "directory", mode: 0o700, uid: 501, device: 1n, inode: 2n };
          return socketCreated ? { kind: "socket", mode: 0o600, uid: 501, device: 1n, inode: 3n } : null;
        },
        async unlink() {},
      },
      spawn: () => child,
      async transport(_socket, request) {
        calls.push(request as Record<string, unknown>);
        if (request.method === "metadata") { socketCreated = true; return metadata(); }
        if (request.name === "check_permissions") return pinnedToolResult(embeddedPermissionReport());
        if (request.name === "health_report") return pinnedToolResult(embeddedHealthReport());
        if (request.name === "end_session") { sawEnd(); return toolResult({ status: "ok" }); }
        if (request.name === "start_session") {
          if (firstStart) {
            firstStart = false;
            holdStart();
            return new Promise(() => {});
          }
          return toolResult({ status: "ok" });
        }
        return toolResult({ status: "ok" });
      },
    });
    await supervisor.ensureRunning();
    const controller = new AbortController();
    const starting = supervisor.startContext(scope, controller.signal);
    await startedCall;
    controller.abort();
    await expect(starting).resolves.toEqual({ ok: false, code: "cancelled" });
    await endedCall;
    expect(calls.at(-1)).toMatchObject({ method: "call", name: "end_session" });
    await expect(supervisor.startContext(scope)).resolves.toMatchObject({ ok: true, generation: expect.any(String) });
  });

  test("rejects an unattested daemon without leaking its raw error or accepting a non-socket endpoint", async () => {
    const child = new Child();
    let socketCreated = false;
    const supervisor = new CuaSupervisor({
      binaryPath: "/app/cua-driver", runtimeDir: "/private/runtime", expectedUid: 501, randomBytes: () => new Uint8Array(24),
      filesystem: {
        async lstat(path) {
          if (path === "/private/runtime") return { kind: "directory", mode: 0o700, uid: 501, device: 1n, inode: 2n };
          return socketCreated ? { kind: "file", mode: 0o600, uid: 501, device: 1n, inode: 3n } : null;
        },
        async unlink() { throw new Error("must not unlink an unsafe path"); },
      },
      spawn: () => child,
      async transport() { socketCreated = true; return metadata(4242, { contract_version: "attacker-provided" }); },
    });
    await expect(supervisor.ensureRunning()).resolves.toEqual({ ok: false, code: "attestation_failed" });
    expect(child.stdinEnded).toBe(true);
    expect(child.kills).toEqual(["SIGKILL"]);
  });

  test("fails closed when a daemon-success envelope contains an error ToolResult", async () => {
    for (const failingTool of ["check_permissions", "start_session"] as const) {
      const child = new Child();
      let socketCreated = false;
      const supervisor = new CuaSupervisor({
        binaryPath: "/app/cua-driver", runtimeDir: "/private/runtime", expectedUid: 501, randomBytes: () => new Uint8Array(24).fill(9),
        filesystem: {
          async lstat(path) {
            if (path === "/private/runtime") return { kind: "directory", mode: 0o700, uid: 501, device: 1n, inode: 2n };
            return socketCreated ? { kind: "socket", mode: 0o600, uid: 501, device: 1n, inode: 3n } : null;
          },
          async unlink() {},
        },
        spawn: () => child,
        async transport(_socket, request) {
          if (request.method === "metadata") { socketCreated = true; return metadata(); }
          if (request.name === failingTool) return toolResult({}, true);
          if (request.name === "check_permissions") return pinnedToolResult(embeddedPermissionReport());
          if (request.name === "health_report") return pinnedToolResult(embeddedHealthReport());
          return toolResult({ status: "ok" });
        },
      });
      await expect(supervisor.startContext(scope)).resolves.toEqual({
        ok: false,
        code: failingTool === "check_permissions" ? "permission_check_failed" : "session_start_failed",
      });
      expect(child.kills).toEqual(failingTool === "check_permissions" ? ["SIGKILL"] : []);
    }
  });

  test.each(["provider", "transport", "cancelled", "stale_generation", "socket_before", "socket_after", "socket_replaced"] as const)("isolates cosmetic motion failure without suppressing lifecycle fences (%s)", async (failure) => {
    const child = new Child();
    let socketCreated = false;
    let sessionStarted = false;
    let sessionSocketReads = 0;
    const calls: Record<string, unknown>[] = [];
    const supervisor = new CuaSupervisor({
      binaryPath: "/app/cua-driver", runtimeDir: "/private/runtime", expectedUid: 501,
      randomBytes: () => new Uint8Array(24).fill(19),
      filesystem: {
        async lstat(path) {
          if (path === "/private/runtime") return { kind: "directory", mode: 0o700, uid: 501, device: 1n, inode: 2n };
          if (sessionStarted) {
            sessionSocketReads += 1;
            // First read is start_session's post-RPC attestation; the next
            // two surround the optional motion RPC.
            if ((failure === "socket_before" && sessionSocketReads === 2)
              || (failure === "socket_after" && sessionSocketReads === 3)) throw new Error("socket stat failed");
            if (failure === "socket_replaced" && sessionSocketReads >= 3) return { kind: "socket", mode: 0o600, uid: 501, device: 1n, inode: 99n };
          }
          return socketCreated ? { kind: "socket", mode: 0o600, uid: 501, device: 1n, inode: 3n } : null;
        },
        async unlink() {},
      },
      spawn: () => child,
      async transport(_socket, request) {
        calls.push(request as Record<string, unknown>);
        if (request.method === "metadata") {
          socketCreated = true;
          return metadata();
        }
        if (request.name === "check_permissions") return pinnedToolResult(embeddedPermissionReport());
        if (request.name === "health_report") return pinnedToolResult(embeddedHealthReport());
        if (request.name === "start_session") sessionStarted = true;
        if (request.name === "set_agent_cursor_motion") {
          if (failure === "cancelled") throw Object.assign(new Error("cancelled"), { name: "AbortError" });
          if (failure === "stale_generation") child.unexpectedExit();
          if (failure === "transport") throw new Error("optional cursor RPC failed");
          return toolResult({}, true);
        }
        return toolResult({ status: "ok" });
      },
    });

    const result = await supervisor.startContext(scope);
    if (failure === "cancelled" || failure === "stale_generation") {
      // Child invalidation aborts pending session creation immediately too.
      expect(result).toEqual({ ok: false, code: "cancelled" });
      if (failure === "stale_generation") expect(supervisor.existingHealthyGeneration()).toBeNull();
    } else if (failure === "socket_before" || failure === "socket_after" || failure === "socket_replaced") {
      expect(result).toEqual({ ok: false, code: "session_start_failed" });
      if (failure === "socket_replaced") {
        expect(calls.filter((call) => call.name === "end_session")).toHaveLength(0);
      }
    } else {
      expect(result).toMatchObject({ ok: true });
      // A live lease reuses the configured session; optional setup is not
      // repeated for every call acquiring that same context.
      await expect(supervisor.startContext(scope)).resolves.toMatchObject(result);
      expect(calls.filter((call) => call.name === "start_session")).toHaveLength(1);
    }
    expect(calls.filter((call) => call.name === "set_agent_cursor_motion")).toHaveLength(failure === "socket_before" ? 0 : 1);
    await supervisor.shutdown();
  });

  test("refuses an inode-replaced socket for context teardown and cleanup", async () => {
    const child = new Child();
    let socketCreated = false;
    let replaced = false;
    const calls: Record<string, unknown>[] = [];
    const removed: string[] = [];
    const supervisor = new CuaSupervisor({
      binaryPath: "/app/cua-driver", runtimeDir: "/private/runtime", expectedUid: 501, randomBytes: () => new Uint8Array(24).fill(3),
      filesystem: {
        async lstat(path) {
          if (path === "/private/runtime") return { kind: "directory", mode: 0o700, uid: 501, device: 1n, inode: 2n };
          return socketCreated ? { kind: "socket", mode: 0o600, uid: 501, device: 1n, inode: replaced ? 99n : 3n } : null;
        },
        async unlink(path) { removed.push(path); },
      },
      spawn: () => child,
      async transport(_socket, request) {
        calls.push(request as Record<string, unknown>);
        if (request.method === "metadata") { socketCreated = true; return metadata(); }
        if (request.name === "check_permissions") return pinnedToolResult(embeddedPermissionReport());
        if (request.name === "health_report") return pinnedToolResult(embeddedHealthReport());
        return toolResult({ status: "ok" });
      },
    });
    const started = await supervisor.startContext(scope);
    if (!started.ok) throw new Error("expected started supervisor");
    replaced = true;
    await supervisor.endContext(scope);
    expect(calls.at(-1)).not.toEqual({ method: "call", name: "end_session", args: { session: started.sessionId } });
    expect(child.stdinEnded).toBe(false);
    expect(child.kills).toEqual([]);
    expect(removed).toEqual([]);
  });

  test("adapter commits retain the real supervisor session across ordinary calls and replacement", async () => {
    const child = new Child();
    let socketCreated = false;
    const calls: Record<string, unknown>[] = [];
    const supervisor = new CuaSupervisor({
      binaryPath: "/app/cua-driver", runtimeDir: "/private/runtime", expectedUid: 501,
      randomBytes: () => new Uint8Array(24).fill(5),
      filesystem: {
        async lstat(path) {
          if (path === "/private/runtime") return { kind: "directory", mode: 0o700, uid: 501, device: 1n, inode: 2n };
          return socketCreated ? { kind: "socket", mode: 0o600, uid: 501, device: 1n, inode: 3n } : null;
        },
        async unlink() {},
      },
      spawn: () => child,
      async transport(_socket, request) {
        calls.push(request as Record<string, unknown>);
        if (request.method === "metadata") { socketCreated = true; return metadata(); }
        if (request.name === "check_permissions") return pinnedToolResult(embeddedPermissionReport());
        if (request.name === "health_report") return pinnedToolResult(embeddedHealthReport());
        if (request.name === "list_apps") return toolResult({ apps: [
          { pid: 77, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: true, running: true },
        ] });
        if (request.name === "launch_app") return toolResult({
          pid: 77, bundle_id: "com.apple.TextEdit", name: "TextEdit",
          launch_state: { requested: true, process_running: true, window_ready: true },
          windows: [{ window_id: 500, pid: 77, app_name: "TextEdit", title: "Fixture",
            bounds: { x: 1, y: 2, width: 800, height: 600 }, layer: 0, z_index: 0,
            is_on_screen: true, current_space_id: 1, on_current_space: true, space_ids: [1] }],
        });
        if (request.name === "get_window_state") return toolResult({
          pid: 77, window_id: 500, element_count: 0, total_element_count: 0,
          returned_element_count: 0, elements_complete: false, elements: [], tree_markdown: "Fixture", _note: "Fixture",
        });
        return toolResult({ status: "ok" });
      },
    });
    const ready = await supervisor.ensureRunning();
    if (!ready.ok) throw new Error("expected ready supervisor");
    const generation = ready.generation;
    const port: CuaCheckedContextPort = {
      generation,
      callContextTool: (scope, name, args, signal, dispatch) => supervisor.callContextTool(scope, generation, name, args, signal, dispatch),
      startBrowserContext: (scope, signal) => supervisor.startBrowserContext(scope, generation, signal),
      callBrowserTool: (scope, session, name, args, signal) => supervisor.callBrowserTool(scope, generation, session, name, args, signal),
      launchApplication: (scope, bundle, signal) => supervisor.launchApplication(scope, generation, bundle, signal),
      getWindowState: (scope, pid, window, query, signal, effort) => supervisor.getWindowState(scope, generation, pid, window, query, signal, effort),
      captureWindowState: (scope, pid, window, signal, effort) => supervisor.captureWindowState(scope, generation, pid, window, signal, effort),
      captureDesktopState: (scope, signal) => supervisor.captureDesktopState(scope, generation, signal),
      awaitOutstandingOperations: (scope, signal) => supervisor.awaitOutstandingOperations(scope, generation, signal),
      clickDesktop: (scope, x, y, signal, options, onProviderDispatch) => supervisor.clickDesktop(scope, generation, x, y, signal, options, onProviderDispatch),
      endContextLease: (scope, generation, session) => supervisor.endContextLease(scope, generation, session),
    };
    const adapter = new CuaComputerUseAdapter({ port });
    try {
      const launch = await adapter.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } });
      if (!launch.ok || launch.receipt.window === null) throw new Error("expected attributed window");
      await expect(adapter.observeWindowState({ scope, target: launch.receipt.window })).resolves.toMatchObject({ ok: true });
      await expect(adapter.launchApp({ scope, operation: { kind: "launch_app", app: { name: "TextEdit" } } })).resolves.toMatchObject({ ok: true });
      expect(calls.filter((call) => call.name === "start_session")).toHaveLength(1);
      expect(calls.filter((call) => call.name === "set_agent_cursor_motion")).toHaveLength(1);
      expect(calls.filter((call) => call.name === "end_session")).toHaveLength(0);
      await adapter.close();
      // endContextLease initiates the exact asynchronous transport cleanup.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(calls.filter((call) => call.name === "end_session")).toHaveLength(1);
    } finally {
      await adapter.close();
      await supervisor.shutdown();
    }
  });

  test("ends the exact context-derived session before a normal generation shutdown", async () => {
    const child = new Child();
    let socketCreated = false;
    const calls: Record<string, unknown>[] = [];
    const supervisor = new CuaSupervisor({
      binaryPath: "/app/cua-driver", runtimeDir: "/private/runtime", expectedUid: 501, randomBytes: () => new Uint8Array(24).fill(5),
      filesystem: {
        async lstat(path) {
          if (path === "/private/runtime") return { kind: "directory", mode: 0o700, uid: 501, device: 1n, inode: 2n };
          return socketCreated ? { kind: "socket", mode: 0o600, uid: 501, device: 1n, inode: 3n } : null;
        },
        async unlink() {},
      },
      spawn: () => child,
      async transport(_socket, request) {
        calls.push(request as Record<string, unknown>);
        if (request.method === "metadata") { socketCreated = true; return metadata(); }
        if (request.name === "check_permissions") return pinnedToolResult(embeddedPermissionReport());
        if (request.name === "health_report") return pinnedToolResult(embeddedHealthReport());
        return toolResult({ status: "ok" });
      },
    });
    const started = await supervisor.startContext(scope);
    if (!started.ok) throw new Error("expected started supervisor");
    await supervisor.endContext(scope);
    expect(calls.at(-1)).toEqual({ method: "call", name: "end_session", args: { session: started.sessionId } });
  });

  test("fails closed before spawn for a non-private runtime directory or a collision", async () => {
    let launches = 0;
    const unsafe = new CuaSupervisor({
      binaryPath: "/app/cua-driver", runtimeDir: "/private/runtime", expectedUid: 501,
      filesystem: { async lstat() { return { kind: "directory", mode: 0o755, uid: 501, device: 1n, inode: 2n }; }, async unlink() {} },
      spawn: () => { launches += 1; return new Child(); },
    });
    await expect(unsafe.ensureRunning()).resolves.toEqual({ ok: false, code: "runtime_directory_unsafe" });
    expect(launches).toBe(0);
  });

  test("shutdown aborts global startup and reaps an unready generation", async () => {
    const child = new Child();
    let socketCreated = false;
    const removed: string[] = [];
    let metadataStarted!: () => void;
    const sawMetadata = new Promise<void>((resolve) => { metadataStarted = resolve; });
    const supervisor = new CuaSupervisor({
      binaryPath: "/app/cua-driver", runtimeDir: "/private/runtime", expectedUid: 501, randomBytes: () => new Uint8Array(24).fill(8),
      filesystem: {
        async lstat(path) {
          if (path === "/private/runtime") return { kind: "directory", mode: 0o700, uid: 501, device: 1n, inode: 2n };
          return socketCreated ? { kind: "socket", mode: 0o600, uid: 501, device: 1n, inode: 3n } : null;
        },
        async unlink(path) { removed.push(path); },
      },
      spawn: () => child,
      async transport(_socket, request) {
        if (request.method !== "metadata") return toolResult();
        socketCreated = true;
        metadataStarted();
        // The injected transport deliberately ignores cancellation. The
        // supervisor must still make shutdown prompt and reap its child.
        return new Promise(() => {});
      },
    });
    const starting = supervisor.ensureRunning();
    await sawMetadata;
    await expect(supervisor.shutdown()).resolves.toBeUndefined();
    await expect(starting).resolves.toEqual({ ok: false, code: "cancelled" });
    expect(child.stdinEnded).toBe(true);
    expect(child.kills).toEqual(["SIGKILL"]);
    expect(removed).toHaveLength(1);
  });

  test("rejects foreign runtime/socket owners and never signals a pidless failed spawn", async () => {
    let launches = 0;
    const foreignRuntime = new CuaSupervisor({
      binaryPath: "/app/cua-driver", runtimeDir: "/private/runtime", expectedUid: 501,
      filesystem: { async lstat() { return { kind: "directory", mode: 0o700, uid: 502, device: 1n, inode: 2n }; }, async unlink() {} },
      spawn: () => { launches += 1; return new Child(); },
    });
    await expect(foreignRuntime.ensureRunning()).resolves.toEqual({ ok: false, code: "runtime_directory_unsafe" });
    expect(launches).toBe(0);

    const pidless = new Child();
    pidless.pid = undefined;
    const pidlessSupervisor = new CuaSupervisor({
      binaryPath: "/app/cua-driver", runtimeDir: "/private/runtime", expectedUid: 501,
      filesystem: { async lstat(path) { return path === "/private/runtime" ? { kind: "directory", mode: 0o700, uid: 501, device: 1n, inode: 2n } : null; }, async unlink() {} },
      spawn: () => pidless,
    });
    await expect(pidlessSupervisor.ensureRunning()).resolves.toEqual({ ok: false, code: "spawn_failed" });
    expect(pidless.kills).toEqual([]);
  });

  test("rejects a socket owned by another uid after metadata without signaling an untrusted endpoint", async () => {
    const child = new Child();
    let socketCreated = false;
    const supervisor = new CuaSupervisor({
      binaryPath: "/app/cua-driver", runtimeDir: "/private/runtime", expectedUid: 501,
      filesystem: {
        async lstat(path) {
          if (path === "/private/runtime") return { kind: "directory", mode: 0o700, uid: 501, device: 1n, inode: 2n };
          return socketCreated ? { kind: "socket", mode: 0o600, uid: 502, device: 1n, inode: 3n } : null;
        },
        async unlink() { throw new Error("foreign socket must not be unlinked"); },
      },
      spawn: () => child,
      async transport(_socket, request) { if (request.method === "metadata") { socketCreated = true; return metadata(); } return toolResult(); },
    });
    await expect(supervisor.ensureRunning()).resolves.toEqual({ ok: false, code: "attestation_failed" });
    expect(child.kills).toEqual(["SIGKILL"]);
  });

  test("fences concurrent startup while shutdown owns a running child", async () => {
    const child = new Child(4242, false);
    let socketCreated = false;
    let launches = 0;
    const supervisor = new CuaSupervisor({
      binaryPath: "/app/cua-driver", runtimeDir: "/private/runtime", expectedUid: 501,
      filesystem: {
        async lstat(path) {
          if (path === "/private/runtime") return { kind: "directory", mode: 0o700, uid: 501, device: 1n, inode: 2n };
          return socketCreated ? { kind: "socket", mode: 0o600, uid: 501, device: 1n, inode: 3n } : null;
        },
        async unlink() {},
      },
      spawn: () => { launches += 1; return child; },
      async transport(_socket, request) {
        if (request.method === "metadata") { socketCreated = true; return metadata(); }
        if (request.name === "check_permissions") return pinnedToolResult(embeddedPermissionReport());
        if (request.name === "health_report") return pinnedToolResult(embeddedHealthReport());
        return toolResult({ status: "ok" });
      },
    });
    await expect(supervisor.ensureRunning()).resolves.toMatchObject({ ok: true });
    const stopping = supervisor.shutdown();
    await expect(supervisor.ensureRunning()).resolves.toEqual({ ok: false, code: "context_fenced" });
    await expect(supervisor.startContext(scope)).resolves.toEqual({ ok: false, code: "context_fenced" });
    expect(launches).toBe(1);
    // This intentionally consumes the upstream 2s running-child grace before
    // the test double receives SIGKILL; it is not a product test timeout.
    await stopping;
    expect(child.kills).toEqual(["SIGKILL"]);
  });

  test("drops local session authority immediately when end_session is silent and never reuses its id", async () => {
    const child = new Child();
    let socketCreated = false;
    const calls: Record<string, unknown>[] = [];
    const supervisor = new CuaSupervisor({
      binaryPath: "/app/cua-driver", runtimeDir: "/private/runtime", expectedUid: 501,
      filesystem: {
        async lstat(path) {
          if (path === "/private/runtime") return { kind: "directory", mode: 0o700, uid: 501, device: 1n, inode: 2n };
          return socketCreated ? { kind: "socket", mode: 0o600, uid: 501, device: 1n, inode: 3n } : null;
        },
        async unlink() {},
      },
      spawn: () => child,
      async transport(_socket, request) {
        calls.push(request as Record<string, unknown>);
        if (request.method === "metadata") { socketCreated = true; return metadata(); }
        if (request.name === "check_permissions") return pinnedToolResult(embeddedPermissionReport());
        if (request.name === "health_report") return pinnedToolResult(embeddedHealthReport());
        if (request.name === "end_session") return new Promise(() => {});
        return toolResult({ status: "ok" });
      },
    });
    const first = await supervisor.startContext(scope);
    if (!first.ok) throw new Error("expected first session");
    await expect(supervisor.endContext(scope)).resolves.toBeUndefined();
    const second = await supervisor.startContext(scope);
    if (!second.ok) throw new Error("expected second session");
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(calls.filter((call) => call.name === "start_session").map((call) => (call.args as { session: string }).session)).toEqual([first.sessionId, second.sessionId]);
    expect(calls.filter((call) => call.name === "end_session").map((call) => (call.args as { session: string }).session)).toEqual([first.sessionId]);
  });

  test("fails shutdown closed when SIGKILL is refused while the child remains live", async () => {
    const child = new Child(4242, false);
    child.kill = () => false;
    let socketCreated = false;
    let launches = 0;
    const supervisor = new CuaSupervisor({
      binaryPath: "/app/cua-driver", runtimeDir: "/private/runtime", expectedUid: 501,
      filesystem: {
        async lstat(path) {
          if (path === "/private/runtime") return { kind: "directory", mode: 0o700, uid: 501, device: 1n, inode: 2n };
          return socketCreated ? { kind: "socket", mode: 0o600, uid: 501, device: 1n, inode: 3n } : null;
        },
        async unlink() {},
      },
      spawn: () => { launches += 1; return child; },
      async transport(_socket, request) {
        if (request.method === "metadata") { socketCreated = true; return metadata(); }
        if (request.name === "check_permissions") return pinnedToolResult(embeddedPermissionReport());
        if (request.name === "health_report") return pinnedToolResult(embeddedHealthReport());
        return toolResult({ status: "ok" });
      },
    });
    await expect(supervisor.ensureRunning()).resolves.toMatchObject({ ok: true });
    // Intentional upstream 2s grace before the refused SIGKILL is observed.
    await expect(supervisor.shutdown()).rejects.toThrow(/refused SIGKILL/);
    await expect(supervisor.ensureRunning()).resolves.toEqual({ ok: false, code: "context_fenced" });
    expect(launches).toBe(1);
  });

  test("fails shutdown closed when SIGKILL throws while the child remains live", async () => {
    const child = new Child(4242, false);
    child.kill = () => { throw new Error("kill syscall failed"); };
    let socketCreated = false;
    let launches = 0;
    const supervisor = new CuaSupervisor({
      binaryPath: "/app/cua-driver", runtimeDir: "/private/runtime", expectedUid: 501,
      filesystem: {
        async lstat(path) {
          if (path === "/private/runtime") return { kind: "directory", mode: 0o700, uid: 501, device: 1n, inode: 2n };
          return socketCreated ? { kind: "socket", mode: 0o600, uid: 501, device: 1n, inode: 3n } : null;
        },
        async unlink() {},
      },
      spawn: () => { launches += 1; return child; },
      async transport(_socket, request) {
        if (request.method === "metadata") { socketCreated = true; return metadata(); }
        if (request.name === "check_permissions") return pinnedToolResult(embeddedPermissionReport());
        if (request.name === "health_report") return pinnedToolResult(embeddedHealthReport());
        return toolResult({ status: "ok" });
      },
    });
    await expect(supervisor.ensureRunning()).resolves.toMatchObject({ ok: true });
    // Intentional upstream 2s grace before the throwing SIGKILL path.
    await expect(supervisor.shutdown()).rejects.toThrow(/kill syscall failed/);
    await expect(supervisor.ensureRunning()).resolves.toEqual({ ok: false, code: "context_fenced" });
    expect(launches).toBe(1);
  });

  test("permanently fences a failed startup teardown that cannot reap its child", async () => {
    const child = new Child(4242, false);
    child.kill = () => false;
    let socketCreated = false;
    let launches = 0;
    const supervisor = new CuaSupervisor({
      binaryPath: "/app/cua-driver", runtimeDir: "/private/runtime", expectedUid: 501,
      filesystem: {
        async lstat(path) {
          if (path === "/private/runtime") return { kind: "directory", mode: 0o700, uid: 501, device: 1n, inode: 2n };
          return socketCreated ? { kind: "socket", mode: 0o600, uid: 501, device: 1n, inode: 3n } : null;
        },
        async unlink() {},
      },
      spawn: () => { launches += 1; return child; },
      async transport(_socket, request) {
        if (request.method === "metadata") {
          socketCreated = true;
          return metadata(4242, { contract_version: "wrong-contract" });
        }
        return toolResult();
      },
    });
    // This is the distinct upstream 250ms failed-start cleanup grace.
    await expect(supervisor.ensureRunning()).resolves.toEqual({ ok: false, code: "attestation_failed" });
    await expect(supervisor.ensureRunning()).resolves.toEqual({ ok: false, code: "context_fenced" });
    expect(launches).toBe(1);
  });

  test("does not SIGKILL a child that exits from liveness EOF during the upstream grace", async () => {
    const child = new Child(4242, false);
    child.stdin.end = () => { child.stdinEnded = true; queueMicrotask(() => child.unexpectedExit()); };
    let socketCreated = false;
    const supervisor = new CuaSupervisor({
      binaryPath: "/app/cua-driver", runtimeDir: "/private/runtime", expectedUid: 501,
      filesystem: {
        async lstat(path) {
          if (path === "/private/runtime") return { kind: "directory", mode: 0o700, uid: 501, device: 1n, inode: 2n };
          return socketCreated ? { kind: "socket", mode: 0o600, uid: 501, device: 1n, inode: 3n } : null;
        },
        async unlink() {},
      },
      spawn: () => child,
      async transport(_socket, request) {
        if (request.method === "metadata") { socketCreated = true; return metadata(); }
        if (request.name === "check_permissions") return pinnedToolResult(embeddedPermissionReport());
        if (request.name === "health_report") return pinnedToolResult(embeddedHealthReport());
        return toolResult({ status: "ok" });
      },
    });
    await supervisor.ensureRunning();
    await supervisor.shutdown();
    expect(child.stdinEnded).toBe(true);
    expect(child.kills).toEqual([]);
  });

  test("fresh health reflects drift and a child exit before publication is fenced", async () => {
    const child = new Child();
    let socketCreated = false;
    let degraded = false;
    let socketReplaced = false;
    const supervisor = new CuaSupervisor({
      binaryPath: "/app/cua-driver", runtimeDir: "/private/runtime", expectedUid: 501,
      filesystem: {
        async lstat(path) {
          if (path === "/private/runtime") return { kind: "directory", mode: 0o700, uid: 501, device: 1n, inode: 2n };
          return socketCreated ? {
            kind: "socket", mode: 0o600, uid: 501,
            device: 9_007_199_254_740_992n,
            // This differs by exactly one and is intentionally above the
            // Number-safe range: identity must remain bigint-exact.
            inode: socketReplaced ? 9_007_199_254_740_994n : 9_007_199_254_740_993n,
          } : null;
        },
        async unlink() {},
      },
      spawn: () => child,
      async transport(_socket, request) {
        if (request.method === "metadata") { socketCreated = true; return metadata(); }
        if (request.name === "check_permissions") return pinnedToolResult(embeddedPermissionReport({
          accessibility: !degraded,
          screenRecording: !degraded,
        }));
        if (request.name === "health_report") return pinnedToolResult(embeddedHealthReport(degraded ? {
          tcc_accessibility: "fail",
          tcc_screen_recording: "fail",
          ax_capability: "fail",
        } : {}));
        return toolResult({ status: "ok" });
      },
    });
    await expect(supervisor.ensureRunning()).resolves.toMatchObject({ ok: true, healthFreshness: "startup_cached" });
    degraded = true;
    await expect(supervisor.refreshHealth()).resolves.toEqual(expect.objectContaining({ ok: true, healthFreshness: "fresh", health: { permission: "unavailable", health: "degraded" } }));
    child.stdin.end = () => { child.stdinEnded = true; queueMicrotask(() => child.unexpectedExit()); };
    socketReplaced = true;
    await expect(supervisor.refreshHealth()).resolves.toEqual({ ok: false, code: "permission_check_failed" });
    expect(child.stdinEnded).toBe(true);

    const racingChild = new Child();
    let racingSocket = false;
    const racing = new CuaSupervisor({
      binaryPath: "/app/cua-driver", runtimeDir: "/private/runtime", expectedUid: 501,
      filesystem: { async lstat(path) { return path === "/private/runtime" ? { kind: "directory", mode: 0o700, uid: 501, device: 1n, inode: 2n } : racingSocket ? { kind: "socket", mode: 0o600, uid: 501, device: 1n, inode: 3n } : null; }, async unlink() {} },
      spawn: () => racingChild,
      async transport(_socket, request) { if (request.method === "metadata") { racingSocket = true; racingChild.unexpectedExit(); return metadata(); } return toolResult(); },
    });
    await expect(racing.ensureRunning()).resolves.toEqual({ ok: false, code: "stale_generation" });
  });

  test("uses only an explicit checked generation for adapter calls, injects its host session at the envelope, and fences malformed tool output", async () => {
    const child = new Child();
    let socketCreated = false;
    const calls: Record<string, unknown>[] = [];
    let malformed = false;
    const supervisor = new CuaSupervisor({
      binaryPath: "/app/cua-driver", runtimeDir: "/private/runtime", expectedUid: 501,
      filesystem: {
        async lstat(path) {
          if (path === "/private/runtime") return { kind: "directory", mode: 0o700, uid: 501, device: 1n, inode: 2n };
          return socketCreated ? { kind: "socket", mode: 0o600, uid: 501, device: 1n, inode: 3n } : null;
        },
        async unlink() {},
      },
      spawn: () => child,
      async transport(_socket, request) {
        calls.push(request as Record<string, unknown>);
        if (request.method === "metadata") { socketCreated = true; return metadata(); }
        if (request.name === "check_permissions") return pinnedToolResult(embeddedPermissionReport());
        if (request.name === "health_report") return pinnedToolResult(embeddedHealthReport());
        if (request.name === "list_apps" && malformed) return { ok: true, result: { content: [{ type: "text" }] } };
        return toolResult({ apps: [] });
      },
    });
    const checked = await supervisor.refreshHealth();
    if (!checked.ok) throw new Error("expected explicit checked generation");
    await expect(supervisor.callContextTool(scope, "other-generation", "list_apps", {}))
      .resolves.toEqual({ ok: false, code: "context_fenced", stage: "session" });

    const listed = await supervisor.callContextTool(scope, checked.generation, "list_apps", {});
    if (!listed.ok) throw new Error("expected list_apps result");
    const listCall = calls.at(-1)!;
    expect(listCall).toEqual({
      method: "call",
      name: "list_apps",
      args: {},
      session_id: listed.sessionId,
    });
    expect((listCall.args as Record<string, unknown>)["session"]).toBeUndefined();
    expect((listCall.args as Record<string, unknown>)["session_id"]).toBeUndefined();
    expect((listCall.args as Record<string, unknown>)["_session_id"]).toBeUndefined();
    await supervisor.endContextLease(scope, listed.generation, listed.sessionId);

    const appWindows = await supervisor.callContextTool(scope, checked.generation, "list_windows", { pid: 42 });
    if (!appWindows.ok) throw new Error("expected exact pid-filtered window seam");
    expect(calls.at(-1)).toEqual({ method: "call", name: "list_windows", args: { pid: 42 }, session_id: appWindows.sessionId });
    await supervisor.endContextLease(scope, appWindows.generation, appWindows.sessionId);

    // The checked seam accepts only adapter-canonical input. It must reject
    // broad daemon key aliases, widened text arguments, and non-XOR verify
    // predicates before a provider session/tool call can be made.
    const beforeInvalid = calls.length;
    for (const delay of [-1, 201, 0.5, null, undefined, "30"]) {
      await expect(supervisor.callContextTool(scope, checked.generation, "type_text", {
        scope: "desktop", text: "x", delay_ms: delay,
      })).resolves.toEqual({ ok: false, code: "invalid_configuration", stage: "tool" });
    }
    for (const extra of [{ x: 1, y: 2 }, { pid: 42 }, { delivery_mode: "background" }]) {
      await expect(supervisor.callContextTool(scope, checked.generation, "press_key", {
        scope: "desktop", key: "return", modifiers: [], ...extra,
      })).resolves.toEqual({ ok: false, code: "invalid_configuration", stage: "tool" });
    }
    await expect(supervisor.getWindowState(scope, checked.generation, 42, 90, undefined, undefined, { maxElements: 0 }))
      .resolves.toEqual({ ok: false, code: "invalid_configuration", stage: "tool" });
    await expect(supervisor.captureWindowState(scope, checked.generation, 42, 90, undefined, { maxDepth: -1 }))
      .resolves.toEqual({ ok: false, code: "invalid_configuration" });
    for (const malformed of [null, true, 4, "bad", [], {}, { maxElements: undefined }, { maxDepth: undefined },
      { maxElements: 1, maxDepth: undefined }, { maxDepth: 1.5 }, { maxElements: Number.MAX_SAFE_INTEGER + 1 }, { unknown: 1 }]) {
      // Deliberately exercise unchecked JS callers at the private port seam,
      // not just the public schema which already refuses these values.
      const effort = malformed as unknown as NonNullable<Parameters<CuaSupervisor["captureWindowState"]>[5]>;
      await expect(supervisor.getWindowState(scope, checked.generation, 42, 90, undefined, undefined, effort))
        .resolves.toEqual({ ok: false, code: "invalid_configuration", stage: "tool" });
      await expect(supervisor.captureWindowState(scope, checked.generation, 42, 90, undefined, effort))
        .resolves.toEqual({ ok: false, code: "invalid_configuration" });
    }
    expect(calls).toHaveLength(beforeInvalid);
    await expect(supervisor.callContextTool(scope, checked.generation, "type_text", {
      pid: 42, window_id: 90, scope: "window", delivery_mode: "background", text: "x", extra: true,
    })).resolves.toEqual({ ok: false, code: "invalid_configuration", stage: "tool" });
    await expect(supervisor.callContextTool(scope, checked.generation, "set_value", {
      pid: 42, window_id: 90, element_token: "private-token", value: "private value", delivery_mode: "background",
    })).resolves.toEqual({ ok: false, code: "invalid_configuration", stage: "tool" });
    await expect(supervisor.callContextTool(scope, checked.generation, "scroll", {
      pid: 42, window_id: 90, element_token: "private-token", direction: "left", amount: 5, delivery_mode: "background",
    })).resolves.toEqual({ ok: false, code: "invalid_configuration", stage: "tool" });
    await expect(supervisor.callContextTool(scope, checked.generation, "scroll", {
      pid: 42, window_id: 90, element_token: "private-token", direction: "up", amount: 0, by: "line", delivery_mode: "background",
    })).resolves.toEqual({ ok: false, code: "invalid_configuration", stage: "tool" });
    await expect(supervisor.callContextTool(scope, checked.generation, "scroll", {
      pid: 42, window_id: 90, element_token: "private-token", direction: "down", amount: 51, by: "page", delivery_mode: "background",
    })).resolves.toEqual({ ok: false, code: "invalid_configuration", stage: "tool" });
    await expect(supervisor.callContextTool(scope, checked.generation, "scroll", {
      pid: 42, window_id: 90, x: -1, y: 2, direction: "right", amount: 1, by: "line", delivery_mode: "background",
    })).resolves.toEqual({ ok: false, code: "invalid_configuration", stage: "tool" });
    await expect(supervisor.callContextTool(scope, checked.generation, "click", {
      pid: 42, window_id: 90, element_token: "private-token", delivery_mode: "invalid",
    })).resolves.toEqual({ ok: false, code: "invalid_configuration", stage: "tool" });
    await expect(supervisor.callContextTool(scope, checked.generation, "click", {
      pid: 42, window_id: 90, element_token: "private-token", delivery_mode: "background", action: "arbitrary_native_action",
    })).resolves.toEqual({ ok: false, code: "invalid_configuration", stage: "tool" });
    await expect(supervisor.callContextTool(scope, checked.generation, "click", {
      pid: 42, window_id: 90, element_token: "private-token", delivery_mode: "background", x: 1, y: 2,
    })).resolves.toEqual({ ok: false, code: "invalid_configuration", stage: "tool" });
    await expect(supervisor.callContextTool(scope, checked.generation, "right_click", {
      pid: 42, window_id: 90, element_token: "private-token", delivery_mode: "invalid",
    })).resolves.toEqual({ ok: false, code: "invalid_configuration", stage: "tool" });
    await expect(supervisor.callContextTool(scope, checked.generation, "right_click", {
      pid: 42, window_id: 90, element_token: "private-token", delivery_mode: "background", modifier: ["ctrl"],
    })).resolves.toEqual({ ok: false, code: "invalid_configuration", stage: "tool" });
    await expect(supervisor.callContextTool(scope, checked.generation, "right_click", {
      pid: 42, window_id: 90, element_token: "private-token", delivery_mode: "background", x: 1, y: 2,
    })).resolves.toEqual({ ok: false, code: "invalid_configuration", stage: "tool" });
    await expect(supervisor.callContextTool(scope, checked.generation, "double_click", {
      pid: 42, window_id: 90, element_token: "private-token", delivery_mode: "invalid",
    })).resolves.toEqual({ ok: false, code: "invalid_configuration", stage: "tool" });
    await expect(supervisor.callContextTool(scope, checked.generation, "double_click", {
      pid: 42, window_id: 90, element_token: "private-token", delivery_mode: "background", x: 1, y: 2,
    })).resolves.toEqual({ ok: false, code: "invalid_configuration", stage: "tool" });
    await expect(supervisor.callContextTool(scope, checked.generation, "drag", {
      pid: 42, window_id: 90, from_x: 248, from_y: 776, to_x: 720, to_y: 776,
      duration_ms: 10_001, steps: 30, button: "left", delivery_mode: "foreground",
    })).resolves.toEqual({ ok: false, code: "invalid_configuration", stage: "tool" });
    await expect(supervisor.callContextTool(scope, checked.generation, "drag", {
      pid: 42, window_id: 90, from_x: 248, from_y: 776, to_x: 720, to_y: 776,
      duration_ms: 700, steps: 201, button: "left", delivery_mode: "background",
    })).resolves.toEqual({ ok: false, code: "invalid_configuration", stage: "tool" });
    await expect(supervisor.callContextTool(scope, checked.generation, "press_key", {
      pid: 42, window_id: 90, scope: "window", delivery_mode: "background", key: "ENTER", modifiers: ["alt"],
    })).resolves.toEqual({ ok: false, code: "invalid_configuration", stage: "tool" });
    await expect(supervisor.callContextTool(scope, checked.generation, "verify_state", {
      pid: 42, window_id: 90, timeout_ms: 0, stable_samples: 1, include_screenshot: false,
      expect: [{ window: { exists: true }, element: { selector: { role: "AXTextField" } } }],
    })).resolves.toEqual({ ok: false, code: "invalid_configuration", stage: "tool" });
    await expect(supervisor.callContextTool(scope, checked.generation, "launch_app", {
      bundle_id: "com.apple.TextEdit", name: "TextEdit",
    })).resolves.toEqual({ ok: false, code: "invalid_configuration", stage: "tool" });
    await expect(supervisor.callContextTool(scope, checked.generation, "get_window_state", {
      pid: 42, window_id: 90, include_screenshot: false, max_elements: 0,
    })).resolves.toEqual({ ok: false, code: "invalid_configuration", stage: "tool" });
    await expect(supervisor.callContextTool(scope, checked.generation, "get_window_state", {
      pid: 42, window_id: 90, include_screenshot: false, max_elements: 2_000, max_depth: 25, query: " fixture ",
    })).resolves.toEqual({ ok: false, code: "invalid_configuration", stage: "tool" });
    await expect(supervisor.callContextTool(scope, checked.generation, "list_windows", {
      pid: 42, on_screen_only: true,
    })).resolves.toEqual({ ok: false, code: "invalid_configuration", stage: "tool" });
    await expect(supervisor.callContextTool(scope, checked.generation, "invoke_menu", {
      pid: 42, window_id: 90, path: Array.from({ length: 17 }, () => "New"),
    })).resolves.toEqual({ ok: false, code: "invalid_configuration", stage: "tool" });
    expect(calls).toHaveLength(beforeInvalid);

    for (const [name, args] of [
      ["hotkey", { pid: 42, window_id: 90, scope: "window", keys: ["cmd", "shift", "s"], delivery_mode: "background" }],
      ["hotkey", { pid: 42, window_id: 90, element_token: "private-token", keys: ["cmd", "a"], delivery_mode: "foreground" }],
      ["hotkey", { pid: 42, window_id: 90, x: 12, y: 24, keys: ["ctrl", "left"], delivery_mode: "background" }],
      ["hotkey", { scope: "desktop", keys: ["cmd", "shift", "s"] }],
      ["click", { pid: 42, window_id: 90, element_token: "private-token", button: "right", modifier: ["shift"], delivery_mode: "foreground" }],
      ["press_key", { pid: 42, window_id: 90, element_token: "private-token", key: "=", modifiers: ["cmd", "shift"], delivery_mode: "foreground" }],
      ["type_text", { pid: 42, window_id: 90, element_token: "private-token", text: "text", delivery_mode: "foreground" }],
      ["scroll", { pid: 42, window_id: 90, element_token: "private-token", direction: "left", amount: 50, by: "page", delivery_mode: "foreground" }],
      ["scroll", { pid: 42, window_id: 90, x: 2, y: 3, direction: "up", amount: 1, by: "line", delivery_mode: "foreground" }],
      ["scroll", { scope: "desktop", x: 2, y: 3, direction: "down", amount: 3, by: "line" }],
      ["drag", { pid: 42, window_id: 90, from_x: 10, from_y: 20, to_x: 30, to_y: 40, delivery_mode: "foreground" }],
      ["drag", { pid: 42, window_id: 90, from_x: 10, from_y: 20, to_x: 30, to_y: 40, duration_ms: 0, steps: 1, button: "middle", modifier: ["option"], delivery_mode: "background" }],
      ["drag", { scope: "desktop", from_x: 10, from_y: 20, to_x: 30, to_y: 40, duration_ms: 10_000, steps: 200, button: "right", modifier: ["cmd", "shift"] }],
      ["click", { pid: 42, window_id: 90, x: 12, y: 24, delivery_mode: "background" }],
      ...["press", "show_menu", "pick", "confirm", "cancel", "open"].map((action) =>
        ["click", { pid: 42, window_id: 90, element_token: "private-token", delivery_mode: "background", action }] as const),
      ["click", { pid: 42, window_id: 90, x: 12, y: 24, delivery_mode: "foreground", button: "middle", count: 3, modifier: ["cmd", "shift"] }],
      ["click", { pid: 42, window_id: 90, x: 12, y: 24, delivery_mode: "background", button: "right", count: 2 }],
      ["type_text", { pid: 42, window_id: 90, x: 12, y: 24, text: "one exact pixel write", delivery_mode: "background" }],
      ["type_text", { scope: "desktop", text: "focused input", delay_ms: 0 }],
      ["type_text", { pid: 42, window_id: 90, scope: "window", text: "paced input", delay_ms: 200, delivery_mode: "foreground" }],
      ["press_key", { scope: "desktop", key: "tab", modifiers: ["cmd"] }],
      ["move_cursor", { scope: "desktop", x: 12, y: 24 }],
      ["press_key", { pid: 42, window_id: 90, x: 12, y: 24, key: "return", modifiers: ["shift"], delivery_mode: "background" }],
      ["invoke_menu", { pid: 42, window_id: 90, path: ["View", "as List"] }],
      ["set_window_frame", { pid: 42, window_id: 90, x: -100, y: 20, width: 900, height: 700 }],
    ] as const) {
      const admitted = await supervisor.callContextTool(scope, checked.generation, name, args);
      if (!admitted.ok) throw new Error(`expected exact ${name} arguments`);
      expect(calls.at(-1)).toEqual({ method: "call", name, args, session_id: admitted.sessionId });
      await supervisor.endContextLease(scope, admitted.generation, admitted.sessionId);
    }

    const launched = await supervisor.launchApplication(scope, checked.generation, "com.apple.TextEdit");
    const beforeInvalidHotkeys = calls.length;
    for (const args of [
      { scope: "desktop", keys: ["cmd", "a"], key: "b" },
      { scope: "desktop", keys: ["cmd", "a"], modifiers: [] },
      { scope: "desktop", keys: ["cmd", "a"], pid: 42 },
      { scope: "desktop", keys: ["cmd", "a", "b"] },
      { scope: "desktop", keys: ["cmd", "shift"] },
      { pid: 42, window_id: 90, element_token: "private-token", x: 1, y: 2, keys: ["cmd", "a"], delivery_mode: "foreground" },
    ]) {
      await expect(supervisor.callContextTool(scope, checked.generation, "hotkey", args)).resolves.toEqual({ ok: false, code: "invalid_configuration", stage: "tool" });
    }
    expect(calls).toHaveLength(beforeInvalidHotkeys);
    if (!launched.ok) throw new Error("expected named launch seam");
    expect(calls.at(-1)).toEqual({ method: "call", name: "launch_app", args: { bundle_id: "com.apple.TextEdit" }, session_id: launched.sessionId });
    await supervisor.endContextLease(scope, launched.generation, launched.sessionId);
    const windowState = await supervisor.getWindowState(scope, checked.generation, 42, 90);
    if (!windowState.ok) throw new Error("expected named state seam");
    expect(calls.at(-1)).toEqual({ method: "call", name: "get_window_state", args: { pid: 42, window_id: 90, include_screenshot: false }, session_id: windowState.sessionId });
    await supervisor.endContextLease(scope, windowState.generation, windowState.sessionId);
    const queriedState = await supervisor.getWindowState(scope, checked.generation, 42, 90, "fixture", undefined, { maxElements: 9_000, maxDepth: 60 });
    if (!queriedState.ok) throw new Error("expected named semantic-query seam");
    expect(calls.at(-1)).toEqual({
      method: "call", name: "get_window_state",
      args: { pid: 42, window_id: 90, include_screenshot: false, max_elements: 9_000, max_depth: 60 },
      session_id: queriedState.sessionId,
    });
    await supervisor.endContextLease(scope, queriedState.generation, queriedState.sessionId);
    const depthOnlyState = await supervisor.getWindowState(scope, checked.generation, 42, 90, "fixture", undefined, { maxDepth: 80 });
    if (!depthOnlyState.ok) throw new Error("expected one-field traversal effort");
    expect(calls.at(-1)).toEqual({
      method: "call", name: "get_window_state",
      args: { pid: 42, window_id: 90, include_screenshot: false, max_depth: 80 },
      session_id: depthOnlyState.sessionId,
    });
    await supervisor.endContextLease(scope, depthOnlyState.generation, depthOnlyState.sessionId);
    // Provider tokens are opaque and already contained by the raw control
    // frame. A local 4K string ceiling must not reject a valid Cua token.
    const longElementToken = `private-${"t".repeat(5_000)}`;
    const setValue = await supervisor.callContextTool(scope, checked.generation, "set_value", {
      pid: 42, window_id: 90, element_token: longElementToken, value: "private value",
    });
    if (!setValue.ok) throw new Error("expected exact semantic set_value seam");
    expect(calls.at(-1)).toEqual({
      method: "call", name: "set_value",
      args: { pid: 42, window_id: 90, element_token: longElementToken, value: "private value" },
      session_id: setValue.sessionId,
    });
    await supervisor.endContextLease(scope, setValue.generation, setValue.sessionId);
    const manyPredicates = Array.from({ length: 9 }, () => ({ window: { exists: true } }));
    const verifiedMany = await supervisor.callContextTool(scope, checked.generation, "verify_state", {
      pid: 42, window_id: 90, expect: manyPredicates, timeout_ms: 2_000, stable_samples: 2, include_screenshot: false,
    });
    if (!verifiedMany.ok) throw new Error("expected complete caller-authored verification predicate set");
    expect(calls.at(-1)).toEqual({
      method: "call", name: "verify_state",
      args: { pid: 42, window_id: 90, expect: manyPredicates, timeout_ms: 2_000, stable_samples: 2, include_screenshot: false },
      session_id: verifiedMany.sessionId,
    });
    await supervisor.endContextLease(scope, verifiedMany.generation, verifiedMany.sessionId);
    for (const [direction, amount, by] of [
      ["up", 1, "line"],
      ["down", 50, "page"],
      ["left", 2, "line"],
      ["right", 3, "page"],
    ] as const) {
      const scrolled = await supervisor.callContextTool(scope, checked.generation, "scroll", {
        pid: 42, window_id: 90, element_token: "private-token", direction, amount, by, delivery_mode: "background",
      });
      if (!scrolled.ok) throw new Error(`expected exact semantic ${direction} scroll seam`);
      expect(calls.at(-1)).toEqual({
        method: "call", name: "scroll",
        args: { pid: 42, window_id: 90, element_token: "private-token", direction, amount, by, delivery_mode: "background" },
        session_id: scrolled.sessionId,
      });
      await supervisor.endContextLease(scope, scrolled.generation, scrolled.sessionId);
    }
    const coordinateScroll = await supervisor.callContextTool(scope, checked.generation, "scroll", {
      pid: 42, window_id: 90, x: 120, y: 45, direction: "right", amount: 2, by: "line", delivery_mode: "background",
    });
    if (!coordinateScroll.ok) throw new Error("expected exact coordinate scroll seam");
    expect(calls.at(-1)).toEqual({
      method: "call", name: "scroll",
      args: { pid: 42, window_id: 90, x: 120, y: 45, direction: "right", amount: 2, by: "line", delivery_mode: "background" },
      session_id: coordinateScroll.sessionId,
    });
    await supervisor.endContextLease(scope, coordinateScroll.generation, coordinateScroll.sessionId);
    const clicked = await supervisor.callContextTool(scope, checked.generation, "click", {
      pid: 42, window_id: 90, element_token: "private-token", delivery_mode: "background",
    });
    if (!clicked.ok) throw new Error("expected exact semantic click seam");
    expect(calls.at(-1)).toEqual({
      method: "call", name: "click",
      args: { pid: 42, window_id: 90, element_token: "private-token", delivery_mode: "background" },
      session_id: clicked.sessionId,
    });
    await supervisor.endContextLease(scope, clicked.generation, clicked.sessionId);
    const rightClicked = await supervisor.callContextTool(scope, checked.generation, "right_click", {
      pid: 42, window_id: 90, element_token: "private-token", delivery_mode: "background",
    });
    if (!rightClicked.ok) throw new Error("expected exact semantic right-click seam");
    expect(calls.at(-1)).toEqual({
      method: "call", name: "right_click",
      args: { pid: 42, window_id: 90, element_token: "private-token", delivery_mode: "background" },
      session_id: rightClicked.sessionId,
    });
    await supervisor.endContextLease(scope, rightClicked.generation, rightClicked.sessionId);
    const doubleClicked = await supervisor.callContextTool(scope, checked.generation, "double_click", {
      pid: 42, window_id: 90, element_token: "private-token", delivery_mode: "background",
    });
    if (!doubleClicked.ok) throw new Error("expected exact semantic double-click seam");
    expect(calls.at(-1)).toEqual({
      method: "call", name: "double_click",
      args: { pid: 42, window_id: 90, element_token: "private-token", delivery_mode: "background" },
      session_id: doubleClicked.sessionId,
    });
    await supervisor.endContextLease(scope, doubleClicked.generation, doubleClicked.sessionId);
    const dragged = await supervisor.callContextTool(scope, checked.generation, "drag", {
      pid: 42, window_id: 90, from_x: 248, from_y: 776, to_x: 720, to_y: 776,
      duration_ms: 700, steps: 30, button: "left", delivery_mode: "foreground",
    });
    if (!dragged.ok) throw new Error("expected exact qualified drag seam");
    expect(calls.at(-1)).toEqual({
      method: "call", name: "drag",
      args: {
        pid: 42, window_id: 90, from_x: 248, from_y: 776, to_x: 720, to_y: 776,
        duration_ms: 700, steps: 30, button: "left", delivery_mode: "foreground",
      },
      session_id: dragged.sessionId,
    });
    await supervisor.endContextLease(scope, dragged.generation, dragged.sessionId);
    const dragCallsBeforeFence = calls.filter((call) => call.name === "drag").length;
    await expect(supervisor.callContextTool(scope, checked.generation, "drag", {
      pid: 42, window_id: 90, from_x: 248, from_y: 776, to_x: 720, to_y: 776,
      duration_ms: 700, steps: 30, button: "left", delivery_mode: "foreground",
    }, undefined, async () => false)).resolves.toEqual({ ok: false, code: "context_fenced", stage: "tool" });
    expect(calls.filter((call) => call.name === "drag")).toHaveLength(dragCallsBeforeFence);

    const cancelledDuringDispatchCheck = new AbortController();
    await expect(supervisor.callContextTool(scope, checked.generation, "drag", {
      pid: 42, window_id: 90, from_x: 248, from_y: 776, to_x: 720, to_y: 776,
      duration_ms: 700, steps: 30, button: "left", delivery_mode: "foreground",
    }, cancelledDuringDispatchCheck.signal, async () => {
      cancelledDuringDispatchCheck.abort();
      return true;
    })).resolves.toEqual({ ok: false, code: "cancelled", stage: "tool" });
    expect(calls.filter((call) => call.name === "drag")).toHaveLength(dragCallsBeforeFence);

    malformed = true;
    await expect(supervisor.callContextTool(scope, checked.generation, "list_apps", {}))
      .resolves.toEqual({ ok: false, code: "context_fenced", stage: "tool" });
    await expect(supervisor.startContextExisting(scope, checked.generation))
      .resolves.toEqual({ ok: false, code: "context_fenced" });
  });

  test("releases its exact session lease when an adapter tool is aborted after session start", async () => {
    const child = new Child();
    let socketCreated = false;
    let toolStarted: (() => void) | null = null;
    const toolStarting = new Promise<void>((resolve) => { toolStarted = resolve; });
    let endSession: ((request: Record<string, unknown>) => void) | null = null;
    const endSessionCalled = new Promise<Record<string, unknown>>((resolve) => { endSession = resolve; });
    const rawTool = Promise.withResolvers<unknown>();
    const rawBrowserTool = Promise.withResolvers<unknown>();
    const browserStarted = Promise.withResolvers<void>();
    let providerSignal: AbortSignal | undefined;
    const supervisor = new CuaSupervisor({
      binaryPath: "/app/cua-driver", runtimeDir: "/private/runtime", expectedUid: 501,
      filesystem: {
        async lstat(path) {
          if (path === "/private/runtime") return { kind: "directory", mode: 0o700, uid: 501, device: 1n, inode: 2n };
          return socketCreated ? { kind: "socket", mode: 0o600, uid: 501, device: 1n, inode: 3n } : null;
        },
        async unlink() {},
      },
      spawn: () => child,
      async transport(_socket, request, signal) {
        if (request.method === "metadata") { socketCreated = true; return metadata(); }
        if (request.name === "check_permissions") return pinnedToolResult(embeddedPermissionReport());
        if (request.name === "health_report") return pinnedToolResult(embeddedHealthReport());
        if (request.name === "list_apps") {
          providerSignal = signal;
          toolStarted?.();
          return await rawTool.promise;
        }
        if (request.name === "bring_to_front") {
          providerSignal = signal;
          browserStarted.resolve();
          return await rawBrowserTool.promise;
        }
        if (request.name === "end_session") {
          endSession?.(request as Record<string, unknown>);
          return toolResult({ ended: true });
        }
        return toolResult({ started: true });
      },
    });
    const checked = await supervisor.refreshHealth();
    if (!checked.ok) throw new Error("expected explicit checked generation");
    const controller = new AbortController();
    const calling = supervisor.callContextTool(scope, checked.generation, "list_apps", {}, controller.signal);
    await toolStarting;
    controller.abort();
    await expect(calling).resolves.toEqual({ ok: false, code: "cancelled", stage: "tool" });
    expect(providerSignal).toBeUndefined();
    let drained = false;
    const drain = supervisor.awaitOutstandingOperations(scope, checked.generation, controller.signal)
      .then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    const unrelatedSignal = new AbortController().signal;
    await expect(supervisor.awaitOutstandingOperations(scope, checked.generation, unrelatedSignal)).resolves.toBeUndefined();
    rawTool.resolve(toolResult({ apps: [] }));
    await drain;
    expect(drained).toBe(true);
    await expect(endSessionCalled).resolves.toMatchObject({
      method: "call", name: "end_session", args: { session: expect.any(String) },
    });

    const browserContext = await supervisor.startBrowserContext(scope, checked.generation);
    if (!browserContext.ok) throw new Error("expected browser context");
    const browserAbort = new AbortController();
    const browserCall = supervisor.callBrowserTool(scope, checked.generation, browserContext.sessionId,
      "bring_to_front", { pid: 42, window_id: 90 }, browserAbort.signal);
    await browserStarted.promise;
    browserAbort.abort();
    await expect(browserCall).resolves.toEqual({ ok: false, code: "cancelled", stage: "tool" });
    expect(providerSignal).toBeUndefined();
    let browserDrained = false;
    const browserDrain = supervisor.awaitOutstandingOperations(scope, checked.generation, browserAbort.signal)
      .then(() => { browserDrained = true; });
    await Promise.resolve();
    expect(browserDrained).toBe(false);
    rawBrowserTool.resolve(toolResult({ fronted: true }));
    await browserDrain;
    expect(browserDrained).toBe(true);
    await supervisor.endContextLease(scope, browserContext.generation, browserContext.sessionId);
  });

  test("bounds line-delimited JSON responses and rejects EOF before the terminating newline", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-cua-supervisor-"));
    const socketPath = join(root, "driver.sock");
    const exercise = async (write: (socket: net.Socket) => void, matcher: RegExp) => {
      const server = net.createServer(write);
      await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
      try {
        await expect(cuaLineTransport(socketPath, { method: "metadata" })).rejects.toThrow(matcher);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    };
    try {
      await exercise((socket) => socket.end(Buffer.alloc(CUA_MAX_RAW_CONTROL_PROTOCOL_BYTES + 1)), /exceeds maximum size/);
      await exercise((socket) => socket.end('{"ok":true}'), /closed before a complete response line/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("admits only the fixed retained-session new-tab composition shapes", () => {
    const session = "private-session";
    expect(validBrowserToolArgs("bring_to_front", { pid: 42, window_id: 77 }, session)).toBe(true);
    expect(validBrowserToolArgs("list_windows", { pid: 42 }, session)).toBe(true);
    expect(validBrowserToolArgs("hotkey", {
      pid: 42, window_id: 77, keys: ["cmd", "t"], delivery_mode: "foreground", session,
    }, session)).toBe(true);
    expect(validBrowserToolArgs("hotkey", {
      pid: 42, window_id: 77, keys: ["cmd", "l"], delivery_mode: "foreground", session,
    }, session)).toBe(true);
    expect(validBrowserToolArgs("type_text", {
      pid: 42, window_id: 77, text: `about:blank#nautilo-${"a".repeat(43)}`, delivery_mode: "foreground", session,
    }, session)).toBe(true);
    expect(validBrowserToolArgs("type_text", {
      pid: 42, window_id: 77, text: "chrome://inspect/#remote-debugging", delivery_mode: "foreground", session,
    }, session)).toBe(false);
    expect(validBrowserToolArgs("press_key", {
      pid: 42, window_id: 77, key: "return", modifiers: [], delivery_mode: "foreground", session,
    }, session)).toBe(true);

    expect(validBrowserToolArgs("hotkey", {
      pid: 42, window_id: 77, keys: ["cmd", "n"], delivery_mode: "foreground", session,
    }, session)).toBe(false);
    expect(validBrowserToolArgs("type_text", {
      pid: 42, window_id: 77, text: "https://example.com", delivery_mode: "foreground", session,
    }, session)).toBe(false);
    expect(validBrowserToolArgs("press_key", {
      pid: 42, window_id: 77, key: "return", modifiers: [], delivery_mode: "foreground", session: "other",
    }, session)).toBe(false);
    expect(validBrowserToolArgs("hotkey", { keys: ["cmd", "l"], scope: "desktop", session }, session)).toBe(false);
    expect(validBrowserToolArgs("bring_to_front", { pid: 42, window_id: 77, session }, session)).toBe(false);
  });
});
