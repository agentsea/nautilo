import { describe, expect, test } from "bun:test";
import {
  BROWSER_EMPTY_DOM_TEXT_HINT,
  createWorkspaceGuard,
  type BrowserPageReadResult,
  type RelayDispatchRequest,
  type RelayDispatchResult,
} from "@nautilo/relay";

import {
  BrowserPageSnapshotStore,
  type BrowserPageSnapshotOwnerBinding,
} from "../../electron/browser-page-snapshot-store.ts";
import {
  createInteractiveBrowserDispatchHandler,
  type InteractiveBrowserDispatchPorts,
} from "../../electron/relay-dispatch/interactive-browser.ts";
import { FIXED_DESKTOP_DISPATCH_NOT_HANDLED } from "../../electron/relay-dispatch/router.ts";

const guard = createWorkspaceGuard({ workspaceRoot: "/tmp" });

function request(
  toolName: string,
  args: Record<string, unknown> = {},
  overrides: Partial<RelayDispatchRequest> = {},
): RelayDispatchRequest {
  return {
    correlationId: "interactive-browser",
    toolName,
    args,
    impact: "read-only",
    approvalObtained: true,
    executionClass: "browser",
    ...overrides,
  };
}

function ports(
  overrides: Partial<InteractiveBrowserDispatchPorts> = {},
): InteractiveBrowserDispatchPorts {
  return {
    resolveBinary: () => "/managed/agent-browser",
    binaryInstallHint: () => "install managed agent-browser",
    ensureConfig: () => "/owned/browser-config.json",
    sessionFor: () => "browser-session",
    hasPublishedView: () => true,
    waitForPublishedView: async () => true,
    getCoordinateScale: () => undefined,
    setCoordinateScale: () => {},
    exec: async () => ({ stdout: "ok", stderr: "" }),
    pruneCaptures: () => {},
    capturePath: () => "/owned/browser-shot.png",
    readCapturePng: () => Buffer.alloc(24),
    captureDimensions: () => ({ width: 1000, height: 800 }),
    visionFromPng: (_path, text) => ({ status: "ok", result: { text } }),
    ...overrides,
  };
}

function page(content: string): BrowserPageReadResult {
  return {
    targetRole: "interactive",
    finalUrl: "https://example.com",
    title: "Interactive",
    content,
    blocks: [],
    totalCharacters: content.length,
    totalCharactersCapped: false,
    totalBytes: Buffer.byteLength(content),
    estimatedTokens: Math.ceil(content.length / 4),
    offsetCharacters: 0,
    nextOffsetCharacters: content.length,
    returnedCharacters: content.length,
    remainingCharacters: 0,
    eof: true,
    truncated: false,
    contextClamped: false,
    extraction: {
      method: "mozilla-readability-turndown-v1",
      root: "article",
      iframeCount: 0,
    },
    timing: { readiness: "complete" },
    quality: "complete",
    challenge: { detected: false, confidence: "none", signals: [] },
    failure: "none",
    diagnostics: [],
  };
}

describe("createInteractiveBrowserDispatchHandler", () => {
  test("declines nonmatches and handles an unknown browser-class request", async () => {
    const handler = createInteractiveBrowserDispatchHandler(ports({
      resolveBinary: () => {
        throw new Error("unknown and nonmatching requests must not resolve a binary");
      },
    }));
    expect(await handler({
      request: request("other", {}, { executionClass: undefined }),
      signal: undefined,
      guard,
    })).toBe(FIXED_DESKTOP_DISPATCH_NOT_HANDLED);
    expect(await handler({
      request: request("browser_future_operation"),
      signal: undefined,
      guard,
    })).toEqual({
      handled: true,
      result: {
        status: "error",
        error: "Unknown browser tool: browser_future_operation",
      },
    });
  });

  test("enforces a required live session before immutable continuation work", async () => {
    let binaryCalls = 0;
    const handler = createInteractiveBrowserDispatchHandler(ports({
      hasPublishedView: () => false,
      resolveBinary: () => {
        binaryCalls += 1;
        return "/managed/agent-browser";
      },
    }));
    expect(await handler({
      request: request("browser_snapshot", { _requiredSession: "required-session" }),
      signal: undefined,
      guard,
    })).toEqual({
      handled: true,
      result: {
        status: "error",
        error:
          "the embedded Browser session bound to this Task continuation is no longer active",
      },
    });
    expect(binaryCalls).toBe(0);
  });

  test("serves retained continuation and snapshot reads before active-target or binary work", async () => {
    const store = new BrowserPageSnapshotStore();
    const owner: BrowserPageSnapshotOwnerBinding = {
      instanceId: "instance-1",
      userId: "user-1",
      relayId: "relay-1",
      desktopSessionId: "desktop-1",
    };
    const created = store.create(owner, page("alpha needle omega"));
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("expected snapshot");
    let binaryCalls = 0;
    const handler = createInteractiveBrowserDispatchHandler(ports({
      snapshotStore: store,
      hasPublishedView: () => false,
      resolveBinary: () => {
        binaryCalls += 1;
        return "/managed/agent-browser";
      },
    }));
    const bindings = {
      browserPageOwnerBinding: owner,
      browserPageSnapshotReferencePublication: true,
    } as const;

    expect(await handler({
      request: request("browser_read_page", {
        continuation: {
          version: 1,
          reference: created.snapshot.reference,
          offsetCharacters: 0,
          mode: "page",
        },
      }, bindings),
      signal: undefined,
      guard,
    })).toMatchObject({
      handled: true,
      result: {
        status: "ok",
        result: {
          targetRole: "interactive",
          pageReference: { reference: created.snapshot.reference },
        },
      },
    });
    expect(await handler({
      request: request("browser_read_page", {
        snapshot: {
          version: 1,
          operation: "find",
          reference: created.snapshot.reference,
          query: "needle",
        },
      }, bindings),
      signal: undefined,
      guard,
    })).toMatchObject({
      handled: true,
      result: {
        status: "ok",
        result: { operation: "find", totalMatches: 1 },
      },
    });
    expect(binaryCalls).toBe(0);
    store.close();
  });

  test("preserves cold-open URL validation and exact manager acknowledgement", async () => {
    const readiness: unknown[] = [];
    const executions: unknown[] = [];
    let waitCalls = 0;
    const handler = createInteractiveBrowserDispatchHandler(ports({
      hasPublishedView: () => false,
      ensureBrowserSurface: async (input) => {
        readiness.push(input);
        return { ok: true };
      },
      waitForPublishedView: async () => {
        waitCalls += 1;
        return false;
      },
      exec: async (binary, argv, options) => {
        executions.push({ binary, argv, options });
        return { stdout: "opened", stderr: "" };
      },
    }));

    expect(await handler({
      request: request("browser_open", { url: "https://example.com/path" }),
      signal: undefined,
      guard,
    })).toEqual({
      handled: true,
      result: { status: "ok", result: "opened" },
    });
    expect(readiness).toEqual([{
      url: "https://example.com/path",
      timeoutMs: 30_000,
    }]);
    expect(waitCalls).toBe(0);
    expect(executions).toEqual([{
      binary: "/managed/agent-browser",
      argv: [
        "--config", "/owned/browser-config.json",
        "--provider", "nautilo-browser",
        "--session", "browser-session",
        "open", "https://example.com/path",
      ],
      options: { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
    }]);

    expect(await handler({
      request: request("browser_open", { url: "file:///tmp/private" }),
      signal: undefined,
      guard,
    })).toMatchObject({
      handled: true,
      result: {
        status: "error",
        error: "browser_open requires an absolute HTTP or HTTPS `url`",
      },
    });
    expect(readiness).toHaveLength(1);
  });

  test("uses native navigation and verifies that the published view remains controllable", async () => {
    const navigation: unknown[] = [];
    let remainsControllable = false;
    const handler = createInteractiveBrowserDispatchHandler(ports({
      controlBrowserNavigation: async (input) => {
        navigation.push(input);
        return { ok: true };
      },
      waitForPublishedView: async () => remainsControllable,
      exec: async () => {
        throw new Error("native navigation must not invoke agent-browser");
      },
    }));
    expect(await handler({
      request: request("browser_back"),
      signal: undefined,
      guard,
    })).toMatchObject({
      handled: true,
      result: {
        status: "error",
        error: "browser_back completed but the embedded Browser did not remain controllable",
      },
    });
    remainsControllable = true;
    expect(await handler({
      request: request("browser_reload"),
      signal: undefined,
      guard,
    })).toEqual({
      handled: true,
      result: { status: "ok", result: "Browser reload completed" },
    });
    expect(navigation).toEqual([{ action: "back" }, { action: "reload" }]);
  });

  test("preserves argv, bounded execution, empty-DOM guidance, and timeout mapping without adding a signal", async () => {
    const executions: Array<{ argv: string[]; options: Record<string, unknown> }> = [];
    let mode: "success" | "empty" | "timeout" = "success";
    const handler = createInteractiveBrowserDispatchHandler(ports({
      exec: async (_binary, argv, options) => {
        executions.push({ argv, options });
        if (mode === "timeout") {
          throw Object.assign(new Error("timeout"), { killed: true });
        }
        return { stdout: mode === "empty" ? "" : " clicked \n", stderr: "" };
      },
    }));

    expect(await handler({
      request: request("browser_click", { ref: "e2" }),
      signal: new AbortController().signal,
      guard,
    })).toEqual({ handled: true, result: { status: "ok", result: "clicked" } });
    mode = "empty";
    expect(await handler({
      request: request("browser_read", { ref: "e3" }),
      signal: new AbortController().signal,
      guard,
    })).toEqual({
      handled: true,
      result: { status: "ok", result: BROWSER_EMPTY_DOM_TEXT_HINT },
    });
    mode = "timeout";
    expect(await handler({
      request: request("browser_click", { ref: "e4" }),
      signal: new AbortController().signal,
      guard,
    })).toEqual({
      handled: true,
      result: { status: "error", error: "browser_click timed out after 30000ms" },
    });
    expect(executions[0]?.argv).toEqual([
      "--config", "/owned/browser-config.json",
      "--provider", "nautilo-browser",
      "--session", "browser-session",
      "click", "@e2",
    ]);
    for (const execution of executions) {
      expect(execution.options).toEqual({
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
      });
    }
  });

  test("captures screenshot geometry and reuses its scale for image-coordinate clicks", async () => {
    const executions: string[][] = [];
    const scales = new Map<string, number>();
    let pruneCalls = 0;
    let visionInput: { path: string; text: string } | undefined;
    const visionResult: RelayDispatchResult = {
      status: "ok",
      result: { kind: "browser_screenshot_vision" },
    };
    const handler = createInteractiveBrowserDispatchHandler(ports({
      getCoordinateScale: (session) => scales.get(session),
      setCoordinateScale: (session, scale) => {
        scales.set(session, scale);
      },
      pruneCaptures: () => {
        pruneCalls += 1;
      },
      exec: async (_binary, argv) => {
        executions.push(argv);
        return {
          stdout: argv.includes("eval")
            ? JSON.stringify({ w: 500, h: 400, dpr: 2 })
            : "",
          stderr: "",
        };
      },
      visionFromPng: (path, text) => {
        visionInput = { path, text };
        return visionResult;
      },
    }));

    expect(await handler({
      request: request("browser_screenshot"),
      signal: undefined,
      guard,
    })).toEqual({ handled: true, result: visionResult });
    expect(pruneCalls).toBe(1);
    expect(scales.get("browser-session")).toBe(2);
    expect(visionInput).toEqual({
      path: "/owned/browser-shot.png",
      text:
        "Browser app surface screenshot captured. Use this image to read canvas-rendered content " +
        "(e.g. Google Docs) and browser_mouse to click pixel coordinates from what you see in this image.\n" +
        "viewport_css=500x400 image_px=1000x800 dpr=2 scale=2.000",
    });

    executions.splice(0);
    expect(await handler({
      request: request("browser_mouse", { x: 200, y: 100 }),
      signal: undefined,
      guard,
    })).toEqual({
      handled: true,
      result: {
        status: "ok",
        result: "Clicked at css(100,50) from image(200,100) space=image scale=2.000",
      },
    });
    expect(executions.map((argv) => argv.slice(-3))).toEqual([
      ["move", "100", "50"],
      ["mouse", "down", "left"],
      ["mouse", "up", "left"],
    ]);
  });

  test("retries browser_wait against the same session until the element is visible", async () => {
    const executions: Array<{ argv: string[]; options: Record<string, unknown> }> = [];
    const handler = createInteractiveBrowserDispatchHandler(ports({
      exec: async (_binary, argv, options) => {
        executions.push({ argv, options });
        return { stdout: executions.length === 1 ? "false" : "true", stderr: "" };
      },
    }));

    expect(await handler({
      request: request("browser_wait", { ref: "e9" }),
      signal: new AbortController().signal,
      guard,
    })).toEqual({
      handled: true,
      result: { status: "ok", result: "Element e9 is visible" },
    });
    expect(executions).toHaveLength(2);
    expect(executions[0]?.argv).toEqual(executions[1]?.argv);
    for (const execution of executions) {
      expect(execution.options).toEqual({ timeout: 30_000, maxBuffer: 1024 * 1024 });
    }
  });
});
