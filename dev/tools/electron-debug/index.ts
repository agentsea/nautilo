#!/usr/bin/env node
/**
 * Nautilo Electron Debug — MCP server for inspecting the desktop app.
 *
 * Maintains a persistent CDP connection to accumulate console logs.
 * Eval opens a fresh connection per call (stateless).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import WebSocket from "ws";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { homedir, tmpdir } from "node:os";

const DEFAULT_PORT = 9222;
// D082 PR C — bumped from 500 → 2000. The 500-entry cap was dropping
// events inside ~2-minute busy sessions (voice + tool calls + HMR
// reloads all log heavily). 2000 entries covers ~2-3 minutes of
// voice-heavy activity, which matches the typical debug-cycle
// duration. Memory is fine: ~250 bytes/entry × 2000 = 500 KB ceiling.
const MAX_LOG_BUFFER = 2000;

// ---------------------------------------------------------------------------
// CDP target discovery
// ---------------------------------------------------------------------------

interface CDPTarget {
  id: string;
  title: string;
  url: string;
  type: string;
  webSocketDebuggerUrl: string;
}

async function discoverTargets(port: number): Promise<CDPTarget[]> {
  try {
    const res = await fetch(`http://localhost:${port}/json`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return [];
    return (await res.json()) as CDPTarget[];
  } catch {
    return [];
  }
}

async function findMainTarget(port: number): Promise<CDPTarget | null> {
  const targets = await discoverTargets(port);
  return (
    targets.find((t) => t.type === "page" && !t.url.startsWith("devtools://")) ??
    targets.find((t) => t.type === "page") ??
    targets[0] ??
    null
  );
}

// ---------------------------------------------------------------------------
// Persistent log collector — accumulates console logs over time
// ---------------------------------------------------------------------------

interface LogEntry {
  timestamp: string;
  level: string;
  text: string;
}

let logBuffer: LogEntry[] = [];
let logWs: WebSocket | null = null;
let logConnected = false;

function connectLogCollector(wsUrl: string): void {
  if (logWs && logWs.readyState === WebSocket.OPEN) return;

  logWs = new WebSocket(wsUrl);

  logWs.on("open", () => {
    logConnected = true;
    logWs!.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));
    logWs!.send(JSON.stringify({ id: 2, method: "Console.enable" }));
  });

  logWs.on("message", (data) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(data)) as Record<string, unknown>;
    } catch {
      return;
    }

    const method = msg["method"] as string | undefined;
    const params = msg["params"] as Record<string, unknown> | undefined;
    if (!method || !params) return;

    const ts = new Date().toISOString();

    if (method === "Runtime.consoleAPICalled") {
      const type = (params["type"] as string) ?? "log";
      const args = params["args"] as Array<{ value?: unknown; description?: string; type?: string }> | undefined;
      const text = args?.map((a) => {
        if (a.value !== undefined) return String(a.value);
        if (a.description) return a.description;
        return `[${a.type ?? "unknown"}]`;
      }).join(" ") ?? "";
      logBuffer.push({ timestamp: ts, level: type, text });
    } else if (method === "Runtime.exceptionThrown") {
      const details = params["exceptionDetails"] as { text?: string; exception?: { description?: string } } | undefined;
      logBuffer.push({ timestamp: ts, level: "exception", text: details?.exception?.description ?? details?.text ?? "unknown" });
    }

    if (logBuffer.length > MAX_LOG_BUFFER) {
      logBuffer = logBuffer.slice(-MAX_LOG_BUFFER);
    }
  });

  logWs.on("close", () => { logConnected = false; logWs = null; });
  logWs.on("error", () => { logConnected = false; logWs = null; });
}

// ---------------------------------------------------------------------------
// CDP eval
// ---------------------------------------------------------------------------

let _evalId = 100;

async function cdpEval(
  wsUrl: string,
  expression: string,
): Promise<{ value: unknown; type: string }> {
  const evalId = ++_evalId;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let enableSent = false;
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("CDP eval timeout (10s)"));
    }, 10_000);

    ws.on("open", () => {
      ws.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));
    });

    ws.on("message", (data) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        return;
      }

      if (msg["id"] === 1 && !enableSent) {
        enableSent = true;
        ws.send(
          JSON.stringify({
            id: evalId,
            method: "Runtime.evaluate",
            params: { expression, returnByValue: true, awaitPromise: true },
          }),
        );
        return;
      }

      if (msg["id"] !== evalId) return;
      clearTimeout(timeout);
      ws.close();

      const error = msg["error"] as { message: string } | undefined;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      const outerResult = msg["result"] as Record<string, unknown> | undefined;
      const result = outerResult?.["result"] as
        { type: string; value?: unknown; description?: string; subtype?: string } | undefined;
      const exnDetails = outerResult?.["exceptionDetails"] as
        { exception?: { description?: string }; text?: string } | undefined;

      if (exnDetails) {
        resolve({
          value: exnDetails.exception?.description ?? exnDetails.text ?? "Exception",
          type: "error",
        });
      } else if (result) {
        resolve({ value: result.value ?? result.description ?? null, type: result.type });
      } else {
        resolve({ value: null, type: "undefined" });
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// CDP screenshot — Page.captureScreenshot
// ---------------------------------------------------------------------------

interface ScreenshotParams {
  format?: "png" | "jpeg" | "webp";
  quality?: number;            // 0-100, jpeg/webp only
  fullPage?: boolean;          // captureBeyondViewport
  clip?: { x: number; y: number; width: number; height: number; scale?: number };
}

async function cdpCaptureScreenshot(
  wsUrl: string,
  params: ScreenshotParams,
): Promise<string> {
  const shotId = ++_evalId;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let enableSent = false;

    // Screenshots of large full-page renders can take a few seconds.
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("CDP screenshot timeout (15s)"));
    }, 15_000);

    ws.on("open", () => {
      // Page.enable isn't strictly required for captureScreenshot on most
      // Chromium versions, but asserting it keeps behavior consistent.
      ws.send(JSON.stringify({ id: 1, method: "Page.enable" }));
    });

    ws.on("message", (data) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        return;
      }

      if (msg["id"] === 1 && !enableSent) {
        enableSent = true;
        const cdpParams: Record<string, unknown> = {
          format: params.format ?? "png",
          captureBeyondViewport: params.fullPage === true,
          fromSurface: true,
        };
        if (params.quality !== undefined && params.format !== "png") {
          cdpParams["quality"] = params.quality;
        }
        if (params.clip) {
          cdpParams["clip"] = {
            x: params.clip.x,
            y: params.clip.y,
            width: params.clip.width,
            height: params.clip.height,
            scale: params.clip.scale ?? 1,
          };
        }
        ws.send(
          JSON.stringify({
            id: shotId,
            method: "Page.captureScreenshot",
            params: cdpParams,
          }),
        );
        return;
      }

      if (msg["id"] !== shotId) return;
      clearTimeout(timeout);
      ws.close();

      const error = msg["error"] as { message: string } | undefined;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      const result = msg["result"] as { data?: string } | undefined;
      if (!result?.data) {
        reject(new Error("CDP screenshot returned no data"));
        return;
      }
      resolve(result.data);
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "nautilo-electron-debug",
  version: "0.5.0",
});

server.tool(
  "electron_eval",
  `Evaluate JavaScript in the Nautilo Electron renderer (workbench UI context).

USAGE NOTES:
- Top-level 'await' is NOT supported. Wrap async code in an IIFE:
    GOOD:  (async () => { const r = await fetch('/api/health'); return r.status; })()
    BAD:   await fetch('/api/health')  // SyntaxError
- Promises ARE auto-awaited (awaitPromise: true), so returning a promise works.
- Max 10 seconds per call. Don't await long-running work (setTimeouts > 10s).
- You CAN install persistent hooks (e.g. patching window.WebSocket, window.fetch)
  — they survive across eval calls BUT are wiped on page reload (location.reload()).
- The renderer is the WORKBENCH (React SPA at http://localhost:3000 in dev).
  Not the Electron main process. Use window.nautiloDesktop for desktop bridge API.

PROBING PATTERNS:
- Store results in window.__probeName to accumulate data across eval calls.
- console.log() output is captured by electron_console_logs.
- window.WebSocket / window.fetch can be wrapped to trace network activity.
- WebSocket connections created BEFORE your patch won't be intercepted —
  patch first, THEN trigger page reload OR force reconnection.

RETURN VALUE:
- Prefixed with [type] — 'string', 'number', 'boolean', 'object', 'undefined', 'error'.
- Objects are JSON-serialized. If circular, use JSON.stringify(x) in the expression.`,
  {
    expression: z.string().describe("JavaScript expression. Wrap async in IIFE. No top-level await."),
    port: z.number().optional().describe("CDP port (default 9222)"),
  },
  async ({ expression, port }) => {
    const p = port ?? DEFAULT_PORT;
    const target = await findMainTarget(p);
    if (!target) {
      return { content: [{ type: "text" as const, text: `No Electron app found on port ${p}.` }] };
    }

    // Ensure log collector is connected
    if (!logConnected) connectLogCollector(target.webSocketDebuggerUrl);

    try {
      const result = await cdpEval(target.webSocketDebuggerUrl, expression);
      const display = result.type === "object"
        ? JSON.stringify(result.value, null, 2)
        : String(result.value);
      return { content: [{ type: "text" as const, text: `[${result.type}] ${display}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  },
);

server.tool(
  "electron_console_logs",
  `Read console logs from the Nautilo Electron renderer.

IMPORTANT — HOW LOG COLLECTION WORKS:
- Logs are ACCUMULATED in a persistent buffer from the moment the MCP server
  connected to the app. NOT a time-windowed capture.
- Logs captured before the MCP server connected are NOT available (they're
  lost CDP events). Console messages that appeared during the very first page
  load may be missing.
- Buffer holds up to 2000 entries (oldest dropped first). Bumped
  from 500 by D082 PR C after real sessions were dropping events
  inside ~2 minutes of voice + tool activity.
- Levels captured: log, warn, error, info, debug, exception.

TYPICAL DEBUGGING FLOW:
1. electron_console_logs({ clear: true })  — reset buffer before an action
2. Trigger the action (in the UI, OR via electron_eval)
3. electron_console_logs({ last: 50 })  — see what was logged

TO CAPTURE LOGS FROM PAGE LOAD:
Logs emitted DURING the initial page load (e.g. WebSocket connection errors
that fire synchronously on module init) may not all be captured even without
clearing. If you need them, install a patch via electron_eval BEFORE the event:
  (() => { const o = console.error; console.error = (...a) => { o(...a); /* store */ }; })()
Then trigger a reload with location.reload() and read logs.

FILTERS:
- last: N — most recent N entries only
- level: 'error' — only errors (or 'warn', 'log', 'exception', etc)
- clear: true — reset buffer after reading`,
  {
    last: z.number().optional().describe("Return only the last N entries (default: all)"),
    level: z.string().optional().describe("Filter: log, warn, error, info, debug, exception"),
    clear: z.boolean().optional().describe("Clear the log buffer after reading (default: false)"),
    port: z.number().optional().describe("CDP port (default 9222)"),
  },
  async ({ last, level, clear, port }) => {
    const p = port ?? DEFAULT_PORT;

    // Ensure log collector is connected
    if (!logConnected) {
      const target = await findMainTarget(p);
      if (!target) {
        return { content: [{ type: "text" as const, text: `No Electron app found on port ${p}.` }] };
      }
      connectLogCollector(target.webSocketDebuggerUrl);
      // Wait a moment for connection + initial events
      await new Promise((r) => setTimeout(r, 1000));
    }

    let entries = [...logBuffer];
    if (level) {
      entries = entries.filter((e) => e.level === level);
    }
    if (last) {
      entries = entries.slice(-last);
    }

    const text = entries.length > 0
      ? entries.map((e) => `[${e.timestamp}] [${e.level}] ${e.text}`).join("\n")
      : `(no logs collected — buffer has ${logBuffer.length} total entries, connected: ${logConnected})`;

    if (clear) {
      logBuffer = [];
    }

    return { content: [{ type: "text" as const, text }] };
  },
);

server.tool(
  "electron_list_windows",
  `List all Chrome DevTools Protocol targets (windows, tabs, service workers)
in the running Electron app. Use this first if you're unsure whether the app
is running, or to find a specific window's URL/title.

Target types:
- 'page' — a BrowserWindow (the workbench UI)
- 'iframe' — nested frames
- 'service_worker' — background workers (PWA-related)
- 'shared_worker' — shared workers

If no targets appear, the Electron app isn't running OR wasn't launched with
--remote-debugging-port=9222. The 'dev' script in apps/desktop/package.json
enables this flag by default.`,
  { port: z.number().optional().describe("CDP port (default 9222)") },
  async ({ port }) => {
    const p = port ?? DEFAULT_PORT;
    const targets = await discoverTargets(p);
    if (targets.length === 0) {
      return { content: [{ type: "text" as const, text: `No targets found on port ${p}.` }] };
    }
    const lines = targets.map((t) => `[${t.type}] ${t.title} — ${t.url} (id: ${t.id})`);
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

server.tool(
  "electron_screenshot",
  `Capture a screenshot of the Nautilo Electron renderer (the workbench UI).

Uses Chromium DevTools Protocol Page.captureScreenshot via the same CDP
port as electron_eval / electron_console_logs. The app must be running
with --remote-debugging-port=9222 (\`bun run desktop\` sets this by default).

OUTPUT MODES:
- Default: writes a PNG to a file in the OS temp dir and returns the
  absolute path. The path is stable for the life of the MCP session;
  the caller can attach it to a reply or re-read it. Claude Code / Cursor
  can inline images from disk paths.
- With explicit \`path\`: writes to that path. Directories created as needed.
- With \`returnBase64: true\`: returns a base64 string directly (no disk
  write). Note this can exceed MCP response size limits for large screens.

FORMATS:
- png (default) — lossless, best for UI diff / pixel inspection
- jpeg — smaller file, requires \`quality\` (1–100, default 80)
- webp — good compression, mid-browser support

SCOPE:
- Default: viewport only (what's visible in the BrowserWindow right now)
- \`fullPage: true\`: captures the entire scrollable document (long pages)
- \`clip\`: { x, y, width, height, scale? } captures a specific region

COMMON PATTERNS:
- Verify visual state after a UI change (reload, tab switch, modal open)
- Diff before/after an action — capture twice, pixel-compare externally
- Debug "I don't see the button" — screenshot + inspect
- Attach to bug reports

TIMING:
- ~200ms for a viewport PNG. 1–5s for full-page on heavy pages. 15s max.
- NOT a smooth-animation tool. If you need to capture during an animation,
  use electron_eval to pause the animation first.`,
  {
    path: z.string().optional().describe(
      "Absolute or tilde-expanded output path. Default: OS temp dir with timestamped name.",
    ),
    format: z.enum(["png", "jpeg", "webp"]).optional().describe("Default: png"),
    quality: z.number().int().min(1).max(100).optional().describe(
      "JPEG/WebP quality 1-100. Ignored for PNG. Default: 80.",
    ),
    fullPage: z.boolean().optional().describe(
      "Capture entire scrollable document, not just viewport. Default: false.",
    ),
    clip: z.object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
      scale: z.number().optional(),
    }).optional().describe("Capture a specific region instead of full viewport."),
    returnBase64: z.boolean().optional().describe(
      "Return image as base64 string instead of writing to disk. Default: false.",
    ),
    port: z.number().optional().describe("CDP port (default 9222)"),
  },
  async ({ path, format, quality, fullPage, clip, returnBase64, port }) => {
    const p = port ?? DEFAULT_PORT;
    const target = await findMainTarget(p);
    if (!target) {
      return { content: [{ type: "text" as const, text: `No Electron app found on port ${p}.` }] };
    }

    const screenshotParams: ScreenshotParams = {
      format: format ?? "png",
      fullPage: fullPage === true,
    };
    if (quality !== undefined) screenshotParams.quality = quality;
    if (clip) screenshotParams.clip = clip;

    try {
      const base64 = await cdpCaptureScreenshot(target.webSocketDebuggerUrl, screenshotParams);

      if (returnBase64 === true) {
        const bytes = Math.floor(base64.length * 0.75);
        return {
          content: [{
            type: "text" as const,
            text: `base64 image (${format ?? "png"}, ~${(bytes / 1024).toFixed(1)} KB):\n${base64}`,
          }],
        };
      }

      // Resolve output path
      const ext = format ?? "png";
      const rawPath = path
        ? path.replace(/^~/, homedir())
        : resolvePath(tmpdir(), `nautilo-electron-${Date.now()}.${ext}`);
      const absPath = resolvePath(rawPath);

      try {
        mkdirSync(dirname(absPath), { recursive: true });
      } catch { /* best effort */ }

      const buf = Buffer.from(base64, "base64");
      writeFileSync(absPath, buf);

      return {
        content: [{
          type: "text" as const,
          text: `Screenshot saved: ${absPath} (${(buf.byteLength / 1024).toFixed(1)} KB, ${format ?? "png"}${fullPage ? ", full page" : ", viewport"})`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  },
);

server.tool(
  "electron_enable_panel_diagnostics",
  `Enable Nautilo Workbench panel diagnostics in the Electron renderer.

This is a convenience wrapper around electron_eval for D242-style React/profile
debugging. It appends query flags to the current Workbench URL and reloads:

- panelDiagnostics=1 — enables structured [d242][profile] timing logs
- reactScan=1 — enables the optional React Scan overlay when the loaded
  Workbench bundle includes the debug hook

Use this before reproducing a slow right-side Agent panel load. Then call
electron_collect_panel_diagnostics after the reload or interaction.

Notes:
- Requires an Electron window on the given CDP port.
- React Scan only works when the Workbench build contains the debug hook
  and permits it (normally local Vite/dev sessions).
- This tool clears the MCP console buffer by default so the follow-up trace
  is compact.`,
  {
    port: z.number().optional().describe("CDP port (default 9222)"),
    reactScan: z.boolean().optional().describe("Also set reactScan=1 (default true)"),
    reload: z.boolean().optional().describe("Reload after changing query flags (default true)"),
    clearLogs: z.boolean().optional().describe("Clear collected console logs before reload (default true)"),
  },
  async ({ port, reactScan, reload, clearLogs }) => {
    const p = port ?? DEFAULT_PORT;
    const target = await findMainTarget(p);
    if (!target) {
      return { content: [{ type: "text" as const, text: `No Electron app found on port ${p}.` }] };
    }

    if (!logConnected) connectLogCollector(target.webSocketDebuggerUrl);
    if (clearLogs !== false) logBuffer = [];

    const expression = `(() => {
      const url = new URL(window.location.href);
      url.searchParams.set("panelDiagnostics", "1");
      ${reactScan === false ? "" : 'url.searchParams.set("reactScan", "1");'}
      const next = url.toString();
      const shouldReload = ${reload === false ? "false" : "true"};
      if (shouldReload && next !== window.location.href) {
        window.location.href = next;
      } else if (shouldReload) {
        window.location.reload();
      }
      return { previous: window.location.href, next, reloading: shouldReload };
    })()`;

    try {
      const result = await cdpEval(target.webSocketDebuggerUrl, expression);
      return {
        content: [{
          type: "text" as const,
          text: `[${result.type}] ${JSON.stringify(result.value, null, 2)}`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  },
);

server.tool(
  "electron_collect_panel_diagnostics",
  `Collect a compact D242 right-panel diagnostic snapshot from Electron.

Returns:
- current URL/title
- whether the visible UI still contains "Loading profile"
- right-side panel text when it can be approximated from the DOM
- recent structured [d242][profile] and [d242][react-scan] console lines
- resource timings for profile/auth/health/ws requests visible to the renderer

Typical flow:
1. electron_enable_panel_diagnostics({ clearLogs: true })
2. Reproduce or wait for the panel load
3. electron_collect_panel_diagnostics({ last: 120 })

This tool does not decide the fix; it packages the evidence an agent needs to
separate React render cost from profile JSON, avatar fetch/blob, and WS churn.`,
  {
    port: z.number().optional().describe("CDP port (default 9222)"),
    last: z.number().optional().describe("Recent console lines to inspect (default 120)"),
    includeAllLogs: z.boolean().optional().describe("Include non-D242 logs too (default false)"),
  },
  async ({ port, last, includeAllLogs }) => {
    const p = port ?? DEFAULT_PORT;
    const target = await findMainTarget(p);
    if (!target) {
      return { content: [{ type: "text" as const, text: `No Electron app found on port ${p}.` }] };
    }

    if (!logConnected) {
      connectLogCollector(target.webSocketDebuggerUrl);
      await new Promise((r) => setTimeout(r, 500));
    }

    const expression = `(() => {
      const bodyText = document.body?.innerText ?? "";
      const panels = Array.from(document.querySelectorAll("aside, [data-panel], [data-testid], main, section"))
        .map((el) => (el instanceof HTMLElement ? el.innerText.trim() : ""))
        .filter(Boolean)
        .sort((a, b) => b.length - a.length);
      const resources = performance.getEntriesByType("resource")
        .filter((entry) => /\\/api\\/profile|\\/api\\/auth|\\/health|\\/ws|profile\\/avatar/.test(entry.name))
        .slice(-50)
        .map((entry) => ({
          name: entry.name,
          startTime: Math.round(entry.startTime),
          duration: Math.round(entry.duration),
          transferSize: "transferSize" in entry ? entry.transferSize : 0,
          encodedBodySize: "encodedBodySize" in entry ? entry.encodedBodySize : 0,
          decodedBodySize: "decodedBodySize" in entry ? entry.decodedBodySize : 0,
        }));
      return {
        href: window.location.href,
        title: document.title,
        nowMs: Math.round(performance.now()),
        loadingProfileVisible: bodyText.includes("Loading profile"),
        bodyTextSample: bodyText.slice(0, 1500),
        likelyPanelText: panels[0]?.slice(0, 1500) ?? "",
        resources,
      };
    })()`;

    try {
      const result = await cdpEval(target.webSocketDebuggerUrl, expression);
      let entries = [...logBuffer].slice(-(last ?? 120));
      if (includeAllLogs !== true) {
        entries = entries.filter((entry) => entry.text.includes("[d242]"));
      }
      const logs = entries.map((entry) => `[${entry.timestamp}] [${entry.level}] ${entry.text}`);
      const payload = {
        snapshot: result.value,
        logs,
        logBuffer: { total: logBuffer.length, filtered: logs.length, connected: logConnected },
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server error:", err);
  process.exit(1);
});
