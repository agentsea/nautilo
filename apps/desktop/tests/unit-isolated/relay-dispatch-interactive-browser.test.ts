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
    getVisualObservation: () => undefined,
    setVisualObservation: () => {},
    deleteVisualObservation: () => {},
    exec: async () => ({ stdout: "ok", stderr: "" }),
    pruneCaptures: () => {},
    capturePath: () => "/owned/browser-shot.png",
    removeCapture: () => {},
    readCapturePng: () => Buffer.alloc(24),
    captureDimensions: () => ({ width: 1000, height: 800 }),
    extractVisualObservation: async () => ({
      recognitionMode: "hybrid", durationMs: 1, globalDurationMs: 1, cropDurationMs: 0,
      cropRequestCount: 0, text: [], rectangles: [], contours: [], contourCount: 0,
    }),
    visionFromPng: (_path, text) => ({ status: "ok", result: { text } }),
    ...overrides,
  };
}

function browserSnapshotJson({
  snapshot = "- button Continue [ref=e2]",
  refs = { e2: { role: "button", name: "Continue" } },
  origin = "https://example.com/",
}: {
  readonly snapshot?: string;
  readonly refs?: Record<string, { readonly role: string; readonly name: string }>;
  readonly origin?: string;
} = {}): string {
  return JSON.stringify({ success: true, data: { snapshot, refs, origin } });
}

function observationId(decision: { readonly result: RelayDispatchResult }): string {
  const value = decision.result.status === "ok" ? decision.result.result : undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected a structured browser observation");
  }
  const id = (value as Record<string, unknown>)["observationId"];
  if (typeof id !== "string") throw new Error("expected a browser observation id");
  return id;
}

function visualExtraction(
  text: readonly { readonly text: string; readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } }[],
): import("../../electron/browser-visual-observation.ts").BrowserVisualExtraction {
  return {
    recognitionMode: "hybrid",
    durationMs: 1,
    globalDurationMs: 1,
    cropDurationMs: 0,
    cropRequestCount: 0,
    text: text.map((item) => ({ ...item, confidence: 1 })),
    rectangles: [],
    contours: [],
    contourCount: 0,
  };
}

function opaqueVisualTarget(
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const point = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  const horizontal = point.x < 1000 / 3 ? "left" : point.x > 2000 / 3 ? "right" : "center";
  const vertical = point.y < 600 / 3 ? "upper" : point.y > 1200 / 3 ? "lower" : "middle";
  const position = horizontal === "center" && vertical === "middle"
    ? "center area"
    : `${vertical}-${horizontal} area`;
  return {
    version: 1,
    visualRef: "v1",
    role: "visible text",
    name: "Canvas choice",
    interaction: "unknown",
    context: `OCR text box; ${position}`,
    sources: ["ocr"],
    confidence: 1,
    point,
    box,
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
  test("adds local extraction only for server-owned visual screenshot requests", async () => {
    let extractionCalls = 0;
    let published: unknown;
    let storedObservationId: string | undefined;
    const handler = createInteractiveBrowserDispatchHandler(ports({
      exec: async (_binary, argv) => ({
        stdout: argv.includes("eval")
          ? JSON.stringify({ w: 500, h: 200, dpr: 2, url: "https://example.com/canvas" })
          : "",
      }),
      readCapturePng: () => Buffer.from("stable-png"),
      captureDimensions: () => ({ width: 1000, height: 600 }),
      extractVisualObservation: async () => {
        extractionCalls += 1;
        return {
          recognitionMode: "hybrid", durationMs: 4, globalDurationMs: 3, cropDurationMs: 1,
          cropRequestCount: 1,
          text: [{ text: "Eight", confidence: 1, box: { x: 100, y: 120, width: 40, height: 20 } }],
          rectangles: [], contours: [], contourCount: 0,
        };
      },
      setVisualObservation: (_session, binding) => { storedObservationId = binding.observationId; },
      visionFromPng: (_path, _text, visualObservation) => {
        published = visualObservation;
        return { status: "ok", result: { kind: "browser_screenshot_vision", visualObservation } };
      },
    }));

    expect(((await handler({
      request: request("browser_screenshot", { _visualObservation: true }), signal: undefined, guard,
    })) as { result: RelayDispatchResult }).result.status).toBe("ok");
    expect(extractionCalls).toBe(1);
    expect(published).toMatchObject({
      version: 1,
      pageUrl: "https://example.com/canvas",
      browserSessionId: "browser-session",
      image: { width: 1000, height: 600 },
      viewport: { cssWidth: 500, cssHeight: 200, dpr: 2 },
      extraction: { recognitionMode: "hybrid", text: [{ text: "Eight" }] },
    });
    expect(storedObservationId).toBe((published as { observationId: string }).observationId);

    await handler({ request: request("browser_screenshot"), signal: undefined, guard });
    expect(extractionCalls).toBe(1);
  });

  test("revalidates a one-shot visual observation and uses independent x/y scales", async () => {
    let binding: import("../../electron/browser-visual-observation.ts").BrowserVisualObservationBinding | undefined;
    const executions: string[][] = [];
    let removedRecaptures = 0;
    const png = Buffer.from("unchanged-pixels");
    const targetBox = { x: 140, y: 135, width: 120, height: 30 };
    const handler = createInteractiveBrowserDispatchHandler(ports({
      getVisualObservation: () => binding,
      setVisualObservation: (_session, value) => { binding = value; },
      deleteVisualObservation: () => { binding = undefined; },
      exec: async (_binary, argv) => {
        executions.push(argv);
        return { stdout: argv.includes("eval")
          ? JSON.stringify({ w: 500, h: 200, dpr: 2, url: "https://example.com/canvas" }) : "" };
      },
      readCapturePng: () => png,
      captureDimensions: () => ({ width: 1000, height: 600 }),
      extractVisualObservation: async () => visualExtraction([{ text: "Canvas choice", box: targetBox }]),
      removeCapture: () => { removedRecaptures += 1; },
      visionFromPng: (_path, _text, visualObservation) => ({
        status: "ok", result: { kind: "browser_screenshot_vision", visualObservation },
      }),
    }));
    const screenshot = (await handler({
      request: request("browser_screenshot", { _visualObservation: true }), signal: undefined, guard,
    })) as { result: RelayDispatchResult };
    const result = screenshot.result.status === "ok" ? screenshot.result.result as {
      visualObservation: { observationId: string };
    } : null;
    const id = result!.visualObservation.observationId;
    executions.splice(0);
    const clicked = await handler({
      request: request("browser_mouse", {
        x: 200, y: 150, space: "image",
        _visualTarget: opaqueVisualTarget(targetBox),
        _requiredSession: "browser-session", _requiredObservationId: id,
      }),
      signal: undefined, guard,
    });
    expect(clicked).toMatchObject({ result: { status: "ok", result: "Clicked resolved visual target v1" } });
    expect(executions.some((argv) => argv.slice(-3).join(" ") === "move 100 50")).toBe(true);
    expect(binding).toBeUndefined();
    expect(removedRecaptures).toBe(1);
  });

  test("atomically focuses and types from a fresh visual observation", async () => {
    let binding: import("../../electron/browser-visual-observation.ts").BrowserVisualObservationBinding | undefined;
    const executions: string[][] = [];
    let removedRecaptures = 0;
    const png = Buffer.from("unchanged-type-pixels");
    const targetBox = { x: 140, y: 135, width: 120, height: 30 };
    const handler = createInteractiveBrowserDispatchHandler(ports({
      getVisualObservation: () => binding,
      setVisualObservation: (_session, value) => { binding = value; },
      deleteVisualObservation: () => { binding = undefined; },
      exec: async (_binary, argv) => {
        executions.push(argv);
        return { stdout: argv.includes("eval")
          ? JSON.stringify({ w: 500, h: 200, dpr: 2, url: "https://example.com/canvas" })
          : "typed" };
      },
      readCapturePng: () => png,
      captureDimensions: () => ({ width: 1000, height: 600 }),
      extractVisualObservation: async () => visualExtraction([{ text: "Canvas choice", box: targetBox }]),
      removeCapture: () => { removedRecaptures += 1; },
      visionFromPng: (_path, _text, visualObservation) => ({
        status: "ok", result: { kind: "browser_screenshot_vision", visualObservation },
      }),
    }));
    const screenshot = await handler({
      request: request("browser_screenshot", { _visualObservation: true }), signal: undefined, guard,
    });
    const id = ((screenshot.result as { result: { visualObservation: { observationId: string } } })
      .result.visualObservation.observationId);
    executions.splice(0);

    expect(await handler({
      request: request("browser_type", {
        x: 200, y: 150, space: "image", text: "canvas\ntext 🐚", clear: false,
        _visualTarget: opaqueVisualTarget(targetBox),
        _requiredSession: "browser-session", _requiredObservationId: id,
      }),
      signal: undefined,
      guard,
    })).toEqual({ handled: true, result: { status: "ok", result: "typed" } });
    expect(executions.some((argv) => argv.slice(-3).join(" ") === "move 100 50")).toBe(true);
    expect(executions.some((argv) => argv.slice(-3).join(" ") === "keyboard inserttext canvas\ntext 🐚")).toBe(true);
    expect(binding).toBeUndefined();
    expect(removedRecaptures).toBe(1);

    const replacement = await handler({
      request: request("browser_screenshot", { _visualObservation: true }), signal: undefined, guard,
    });
    const replacementId = ((replacement.result as { result: { visualObservation: { observationId: string } } })
      .result.visualObservation.observationId);
    executions.splice(0);
    expect(await handler({
      request: request("browser_type", {
        x: 200, y: 150, space: "image", text: "must not replace", clear: true,
        _visualTarget: opaqueVisualTarget(targetBox),
        _requiredSession: "browser-session", _requiredObservationId: replacementId,
      }),
      signal: undefined,
      guard,
    })).toMatchObject({ result: { status: "error", errorCode: "browser_authority_lost" } });
    expect(executions).toHaveLength(0);
    expect(binding).toBeUndefined();
  });

  test("rejects unbound coordinate typing before browser input", async () => {
    let executions = 0;
    const handler = createInteractiveBrowserDispatchHandler(ports({
      exec: async () => {
        executions += 1;
        return { stdout: "unexpected" };
      },
    }));
    expect(await handler({
      request: request("browser_type", {
        x: 20, y: 30, space: "image", text: "must not type", clear: false,
      }),
      signal: undefined,
      guard,
    })).toMatchObject({ result: { status: "error", errorCode: "browser_observation_stale" } });
    expect(executions).toBe(0);
  });

  test("rejects coordinate typing when its semantic target disappeared", async () => {
    let binding: import("../../electron/browser-visual-observation.ts").BrowserVisualObservationBinding | undefined;
    const executions: string[][] = [];
    const targetBox = { x: 10, y: 20, width: 20, height: 20 };
    let extractionCalls = 0;
    const handler = createInteractiveBrowserDispatchHandler(ports({
      getVisualObservation: () => binding,
      setVisualObservation: (_session, value) => { binding = value; },
      deleteVisualObservation: () => { binding = undefined; },
      exec: async (_binary, argv) => {
        executions.push(argv);
        return { stdout: argv.includes("eval")
          ? JSON.stringify({ w: 500, h: 300, dpr: 2, url: "https://example.com/canvas" }) : "" };
      },
      readCapturePng: () => Buffer.from("pixels-may-change"),
      captureDimensions: () => ({ width: 1000, height: 600 }),
      extractVisualObservation: async () => extractionCalls++ === 0
        ? visualExtraction([{ text: "Canvas choice", box: targetBox }])
        : visualExtraction([]),
      visionFromPng: (_path, _text, visualObservation) => ({
        status: "ok", result: { kind: "browser_screenshot_vision", visualObservation },
      }),
    }));
    const screenshot = await handler({
      request: request("browser_screenshot", { _visualObservation: true }), signal: undefined, guard,
    });
    const id = ((screenshot.result as { result: { visualObservation: { observationId: string } } })
      .result.visualObservation.observationId);
    executions.splice(0);

    expect(await handler({
      request: request("browser_type", {
        x: 20, y: 30, space: "image", text: "must not type", clear: false,
        _visualTarget: opaqueVisualTarget(targetBox),
        _requiredSession: "browser-session", _requiredObservationId: id,
      }),
      signal: undefined,
      guard,
    })).toMatchObject({ result: { status: "error", errorCode: "browser_observation_stale" } });
    expect(executions.some((argv) => argv.includes("mouse") || argv.includes("keyboard"))).toBe(false);
    expect(binding).toBeUndefined();
  });

  test("reports coordinate typing failure after its click as an unknown outcome", async () => {
    let binding: import("../../electron/browser-visual-observation.ts").BrowserVisualObservationBinding | undefined;
    const executions: string[][] = [];
    const png = Buffer.from("stable-type-pixels");
    const targetBox = { x: 10, y: 20, width: 20, height: 20 };
    const handler = createInteractiveBrowserDispatchHandler(ports({
      getVisualObservation: () => binding,
      setVisualObservation: (_session, value) => { binding = value; },
      deleteVisualObservation: () => { binding = undefined; },
      exec: async (_binary, argv) => {
        executions.push(argv);
        if (argv.includes("eval")) {
          return { stdout: JSON.stringify({ w: 500, h: 300, dpr: 2, url: "https://example.com/canvas" }) };
        }
        if (argv.includes("keyboard")) throw new Error("keyboard delivery failed");
        return { stdout: "" };
      },
      readCapturePng: () => png,
      captureDimensions: () => ({ width: 1000, height: 600 }),
      extractVisualObservation: async () => visualExtraction([{ text: "Canvas choice", box: targetBox }]),
      visionFromPng: (_path, _text, visualObservation) => ({
        status: "ok", result: { kind: "browser_screenshot_vision", visualObservation },
      }),
    }));
    const screenshot = await handler({
      request: request("browser_screenshot", { _visualObservation: true }), signal: undefined, guard,
    });
    const id = ((screenshot.result as { result: { visualObservation: { observationId: string } } })
      .result.visualObservation.observationId);
    executions.splice(0);

    expect(await handler({
      request: request("browser_type", {
        x: 20, y: 30, space: "image", text: "uncertain", clear: false,
        _visualTarget: opaqueVisualTarget(targetBox),
        _requiredSession: "browser-session", _requiredObservationId: id,
      }),
      signal: undefined,
      guard,
    })).toMatchObject({
      result: {
        status: "error",
        errorCode: "browser_outcome_unknown",
        error: expect.stringContaining("keyboard delivery failed") as unknown,
      },
    });
    expect(executions.some((argv) => argv.includes("mouse"))).toBe(true);
    expect(binding).toBeUndefined();
  });

  test("a later ordinary mutation supersedes an unused visual observation", async () => {
    let binding: import("../../electron/browser-visual-observation.ts").BrowserVisualObservationBinding | undefined;
    const handler = createInteractiveBrowserDispatchHandler(ports({
      getVisualObservation: () => binding,
      setVisualObservation: (_session, value) => { binding = value; },
      deleteVisualObservation: () => { binding = undefined; },
      exec: async (_binary, argv) => ({ stdout: argv.includes("eval")
        ? JSON.stringify({ w: 500, h: 300, dpr: 2, url: "https://example.com/canvas" }) : "" }),
      readCapturePng: () => Buffer.from("pixels"),
      captureDimensions: () => ({ width: 1000, height: 600 }),
      visionFromPng: (_path, _text, visualObservation) => ({
        status: "ok", result: { kind: "browser_screenshot_vision", visualObservation },
      }),
    }));
    await handler({
      request: request("browser_screenshot", { _visualObservation: true }), signal: undefined, guard,
    });
    expect(binding).toBeDefined();
    await handler({ request: request("browser_press", { key: "Escape" }), signal: undefined, guard });
    expect(binding).toBeUndefined();
  });

  test("accepts unrelated pixel changes when the semantic target remains available", async () => {
    let binding: import("../../electron/browser-visual-observation.ts").BrowserVisualObservationBinding | undefined;
    let png = Buffer.from("initial-pixels");
    const executions: string[][] = [];
    const targetBox = { x: 10, y: 20, width: 20, height: 20 };
    const handler = createInteractiveBrowserDispatchHandler(ports({
      getVisualObservation: () => binding,
      setVisualObservation: (_session, value) => { binding = value; },
      deleteVisualObservation: () => { binding = undefined; },
      exec: async (_binary, argv) => {
        executions.push(argv);
        return { stdout: argv.includes("eval")
          ? JSON.stringify({ w: 500, h: 300, dpr: 2, url: "https://example.com/canvas" }) : "" };
      },
      readCapturePng: () => png,
      captureDimensions: () => ({ width: 1000, height: 600 }),
      extractVisualObservation: async () => visualExtraction([{ text: "Canvas choice", box: targetBox }]),
      visionFromPng: (_path, _text, visualObservation) => ({
        status: "ok", result: { kind: "browser_screenshot_vision", visualObservation },
      }),
    }));
    const screenshot = await handler({
      request: request("browser_screenshot", { _visualObservation: true }), signal: undefined, guard,
    });
    const id = ((screenshot.result as { result: { visualObservation: { observationId: string } } })
      .result.visualObservation.observationId);
    png = Buffer.from("changed-pixels");
    executions.splice(0);
    expect(await handler({
      request: request("browser_mouse", {
        x: 20, y: 30, space: "image",
        _visualTarget: opaqueVisualTarget(targetBox),
        _requiredSession: "browser-session", _requiredObservationId: id,
      }), signal: undefined, guard,
    })).toMatchObject({ result: { status: "ok", result: "Clicked resolved visual target v1" } });
    expect(executions.some((argv) => argv.includes("mouse"))).toBe(true);
    expect(binding).toBeUndefined();
  });

  test("re-grounds a moved semantic target and clicks its fresh coordinates", async () => {
    let binding: import("../../electron/browser-visual-observation.ts").BrowserVisualObservationBinding | undefined;
    const executions: string[][] = [];
    const originalBox = { x: 100, y: 80, width: 120, height: 30 };
    const movedBox = { x: 300, y: 200, width: 120, height: 30 };
    let extractionCalls = 0;
    const handler = createInteractiveBrowserDispatchHandler(ports({
      getVisualObservation: () => binding,
      setVisualObservation: (_session, value) => { binding = value; },
      deleteVisualObservation: () => { binding = undefined; },
      exec: async (_binary, argv) => {
        executions.push(argv);
        return { stdout: argv.includes("eval")
          ? JSON.stringify({ w: 500, h: 300, dpr: 2, url: "https://example.com/canvas" }) : "" };
      },
      readCapturePng: () => Buffer.from(extractionCalls === 0 ? "initial" : "animated-and-moved"),
      captureDimensions: () => ({ width: 1000, height: 600 }),
      extractVisualObservation: async () => visualExtraction([{
        text: "Canvas choice",
        box: extractionCalls++ === 0 ? originalBox : movedBox,
      }]),
      visionFromPng: (_path, _text, visualObservation) => ({
        status: "ok", result: { kind: "browser_screenshot_vision", visualObservation },
      }),
    }));
    const screenshot = await handler({
      request: request("browser_screenshot", { _visualObservation: true }), signal: undefined, guard,
    });
    const id = ((screenshot.result as { result: { visualObservation: { observationId: string } } })
      .result.visualObservation.observationId);
    executions.splice(0);

    expect(await handler({
      request: request("browser_mouse", {
        x: 160, y: 95, space: "image",
        _visualTarget: opaqueVisualTarget(originalBox),
        _requiredSession: "browser-session", _requiredObservationId: id,
      }), signal: undefined, guard,
    })).toMatchObject({ result: { status: "ok", result: "Clicked resolved visual target v1" } });
    expect(executions.some((argv) => argv.slice(-3).join(" ") === "move 180 108")).toBe(true);
  });

  test("rejects an ambiguously repeated semantic target before browser input", async () => {
    let binding: import("../../electron/browser-visual-observation.ts").BrowserVisualObservationBinding | undefined;
    const executions: string[][] = [];
    const originalBox = { x: 490, y: 90, width: 20, height: 20 };
    let extractionCalls = 0;
    const handler = createInteractiveBrowserDispatchHandler(ports({
      getVisualObservation: () => binding,
      setVisualObservation: (_session, value) => { binding = value; },
      deleteVisualObservation: () => { binding = undefined; },
      exec: async (_binary, argv) => {
        executions.push(argv);
        return { stdout: argv.includes("eval")
          ? JSON.stringify({ w: 500, h: 300, dpr: 2, url: "https://example.com/canvas" }) : "" };
      },
      readCapturePng: () => Buffer.from("pixels"),
      captureDimensions: () => ({ width: 1000, height: 600 }),
      extractVisualObservation: async () => extractionCalls++ === 0
        ? visualExtraction([{ text: "Canvas choice", box: originalBox }])
        : visualExtraction([
          { text: "Canvas choice", box: { x: 400, y: 90, width: 20, height: 20 } },
          { text: "Canvas choice", box: { x: 585, y: 90, width: 20, height: 20 } },
        ]),
      visionFromPng: (_path, _text, visualObservation) => ({
        status: "ok", result: { kind: "browser_screenshot_vision", visualObservation },
      }),
    }));
    const screenshot = await handler({
      request: request("browser_screenshot", { _visualObservation: true }), signal: undefined, guard,
    });
    const id = ((screenshot.result as { result: { visualObservation: { observationId: string } } })
      .result.visualObservation.observationId);
    executions.splice(0);

    expect(await handler({
      request: request("browser_mouse", {
        x: 500, y: 100, space: "image",
        _visualTarget: opaqueVisualTarget(originalBox, { context: "original context no longer present" }),
        _requiredSession: "browser-session", _requiredObservationId: id,
      }), signal: undefined, guard,
    })).toMatchObject({ result: { status: "error", errorCode: "browser_observation_stale" } });
    expect(executions.some((argv) => argv.includes("mouse"))).toBe(false);
    expect(binding).toBeUndefined();
  });

  test("visual scroll and press tolerate unrelated pixel changes", async () => {
    let binding: import("../../electron/browser-visual-observation.ts").BrowserVisualObservationBinding | undefined;
    let png = Buffer.from("first-frame");
    let screenshotCommands = 0;
    const handler = createInteractiveBrowserDispatchHandler(ports({
      getVisualObservation: () => binding,
      setVisualObservation: (_session, value) => { binding = value; },
      deleteVisualObservation: () => { binding = undefined; },
      exec: async (_binary, argv) => {
        if (argv.includes("screenshot")) screenshotCommands += 1;
        return { stdout: argv.includes("eval")
          ? JSON.stringify({ w: 500, h: 300, dpr: 2, url: "https://example.com/canvas" }) : "ok" };
      },
      readCapturePng: () => png,
      captureDimensions: () => ({ width: 1000, height: 600 }),
      extractVisualObservation: async () => visualExtraction([]),
      visionFromPng: (_path, _text, visualObservation) => ({
        status: "ok", result: { kind: "browser_screenshot_vision", visualObservation },
      }),
    }));

    const scrollObservation = await handler({
      request: request("browser_screenshot", { _visualObservation: true }), signal: undefined, guard,
    });
    const scrollId = ((scrollObservation.result as { result: { visualObservation: { observationId: string } } })
      .result.visualObservation.observationId);
    png = Buffer.from("animated-second-frame");
    expect(await handler({
      request: request("browser_scroll", {
        direction: "down",
        _requiredSession: "browser-session", _requiredObservationId: scrollId,
      }), signal: undefined, guard,
    })).toMatchObject({ result: { status: "ok", result: "Scrolled down 600" } });

    const pressObservation = await handler({
      request: request("browser_screenshot", { _visualObservation: true }), signal: undefined, guard,
    });
    const pressId = ((pressObservation.result as { result: { visualObservation: { observationId: string } } })
      .result.visualObservation.observationId);
    png = Buffer.from("animated-third-frame");
    expect(await handler({
      request: request("browser_press", {
        key: "ArrowDown",
        _requiredSession: "browser-session", _requiredObservationId: pressId,
      }), signal: undefined, guard,
    })).toMatchObject({ result: { status: "ok" } });
    expect(screenshotCommands).toBe(2);
  });

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

  test("reports lost authority before a required-session continuation can run", async () => {
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
    })).toMatchObject({
      handled: true,
      result: {
        status: "error",
        errorCode: "browser_authority_lost",
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
      result: { status: "ok", result: { navigation: { execution: "executed", result: "opened" }, observationFailure: expect.objectContaining({ code: "browser_observation_invalid" }) as unknown } },
    });
    expect(readiness).toEqual([{
      url: "https://example.com/path",
      timeoutMs: 30_000,
    }]);
    expect(waitCalls).toBe(0);
    expect(executions.slice(0, 1)).toEqual([{
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
        errorCode: "browser_outcome_unknown",
      },
    });
    remainsControllable = true;
    expect(await handler({
      request: request("browser_reload"),
      signal: undefined,
      guard,
    })).toEqual({
      handled: true,
      result: { status: "ok", result: { navigation: { execution: "executed", result: "Browser reload completed" }, observationFailure: expect.objectContaining({ code: "browser_observation_invalid" }) as unknown } },
    });
    expect(navigation).toEqual([{ action: "back" }, { action: "reload" }]);
  });

  test.each([
    { stderr: "locator.click: element is covered by a dialog\nCall log: waiting for element to receive pointer events", message: "Command failed" },
    { stderr: "", stdout: "Target closed while clicking", message: "Command failed" },
    { message: "Browser connection closed during dispatch" },
  ])("preserves the underlying mutation diagnostic in an uncertain outcome: %j", async (detail) => {
    let executions = 0;
    const handler = createInteractiveBrowserDispatchHandler(ports({
      exec: async () => {
        executions += 1;
        throw Object.assign(new Error(detail.message), detail);
      },
    }));
    const diagnostic = detail.stderr || ("stdout" in detail ? detail.stdout : undefined) || detail.message;
    expect(await handler({ request: request("browser_click", { ref: "e4" }), signal: undefined, guard })).toEqual({
      handled: true,
      result: {
        status: "error",
        errorCode: "browser_outcome_unknown",
        error: `browser_click may have taken effect. Do not replay it blindly. Obtain a fresh observation and inspect the result before deciding how to recover.\nUnderlying browser error: ${diagnostic}`,
      },
    });
    expect(executions).toBe(1);
  });

  test("reports a timeout without exposing the process command arguments", async () => {
    const cmd = "agent-browser eval private-argument-canary";
    const handler = createInteractiveBrowserDispatchHandler(ports({
      exec: async () => {
        throw Object.assign(new Error(`Command failed: ${cmd}\n`), {
          cmd, killed: true, signal: "SIGTERM", stdout: "", stderr: "",
        });
      },
    }));
    expect(await handler({ request: request("browser_read", { ref: "e5" }), signal: undefined, guard })).toEqual({
      handled: true,
      result: { status: "error", error: "browser_read timed out after 30000ms\nSIGTERM" },
    });
  });

  test("passes every enclosing signal to exec, maps read timeouts, and marks mutation failures unknown", async () => {
    const executions: Array<{ argv: string[]; options: Record<string, unknown> }> = [];
    let mode: "success" | "empty" | "timeout" = "success";
    const handler = createInteractiveBrowserDispatchHandler(ports({
      exec: async (_binary, argv, options) => {
        executions.push({ argv, options });
        if (mode === "timeout") {
          throw Object.assign(new Error("timeout"), { killed: true, stderr: "locator: waiting for element to receive pointer events" });
        }
        return { stdout: mode === "empty" ? "" : " clicked \n", stderr: "" };
      },
    }));

    const clickSignal = new AbortController();
    const emptyReadSignal = new AbortController();
    const mutationTimeoutSignal = new AbortController();
    const readTimeoutSignal = new AbortController();

    expect(await handler({
      request: request("browser_click", { ref: "e2" }),
      signal: clickSignal.signal,
      guard,
    })).toEqual({ handled: true, result: { status: "ok", result: "clicked" } });
    mode = "empty";
    expect(await handler({
      request: request("browser_read", { ref: "e3" }),
      signal: emptyReadSignal.signal,
      guard,
    })).toEqual({
      handled: true,
      result: { status: "ok", result: BROWSER_EMPTY_DOM_TEXT_HINT },
    });
    mode = "timeout";
    expect(await handler({
      request: request("browser_click", { ref: "e4" }),
      signal: mutationTimeoutSignal.signal,
      guard,
    })).toMatchObject({
      handled: true,
      result: {
        status: "error", errorCode: "browser_outcome_unknown",
        error: expect.stringContaining("Underlying browser error: browser_click timed out after 30000ms\nlocator: waiting for element to receive pointer events") as unknown,
      },
    });
    expect(await handler({
      request: request("browser_read", { ref: "e5" }),
      signal: readTimeoutSignal.signal,
      guard,
    })).toEqual({
      handled: true,
      result: { status: "error", error: "browser_read timed out after 30000ms\nlocator: waiting for element to receive pointer events" },
    });
    expect(executions[0]?.argv).toEqual([
      "--config", "/owned/browser-config.json",
      "--provider", "nautilo-browser",
      "--session", "browser-session",
      "click", "@e2",
    ]);
    expect(executions.map((execution) => execution.options)).toEqual([
      { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, signal: clickSignal.signal },
      { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, signal: emptyReadSignal.signal },
      { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, signal: mutationTimeoutSignal.signal },
      { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, signal: readTimeoutSignal.signal },
    ]);
  });

  test("reobserves the exact bound snapshot before clicking", async () => {
    const executions: string[][] = [];
    const handler = createInteractiveBrowserDispatchHandler(ports({
      exec: async (_binary, argv) => {
        executions.push(argv);
        return {
          stdout: argv.includes("--json") ? browserSnapshotJson() : "clicked",
          stderr: "",
        };
      },
    }));

    const snapshot = await handler({
      request: request("browser_snapshot"),
      signal: undefined,
      guard,
    });
    const id = observationId(snapshot);

    expect(await handler({
      request: request("browser_click", {
        ref: "e2",
        _requiredSession: "browser-session",
        _requiredObservationId: id,
      }),
      signal: undefined,
      guard,
    })).toEqual({ handled: true, result: { status: "ok", result: "clicked" } });
    expect(executions).toEqual([
      [
        "--config", "/owned/browser-config.json", "--provider", "nautilo-browser",
        "--session", "browser-session", "--json", "snapshot",
      ],
      [
        "--config", "/owned/browser-config.json", "--provider", "nautilo-browser",
        "--session", "browser-session", "--json", "snapshot",
      ],
      [
        "--config", "/owned/browser-config.json", "--provider", "nautilo-browser",
        "--session", "browser-session", "click", "@e2",
      ],
    ]);
  });

  test("reobserves before delivering an exact bound keyboard combination", async () => {
    const executions: string[][] = [];
    const handler = createInteractiveBrowserDispatchHandler(ports({
      exec: async (_binary, argv) => {
        executions.push(argv);
        return { stdout: argv.at(-1) === "snapshot" ? browserSnapshotJson() : "pressed", stderr: "" };
      },
    }));
    const snapshot = await handler({ request: request("browser_snapshot"), signal: undefined, guard });

    expect(await handler({
      request: request("browser_press", {
        key: "Meta+Shift+P",
        ref: "@e2",
        _requiredSession: "browser-session",
        _requiredObservationId: observationId(snapshot),
      }),
      signal: undefined,
      guard,
    })).toEqual({ handled: true, result: { status: "ok", result: "pressed" } });
    expect(executions).toEqual([
      [
        "--config", "/owned/browser-config.json", "--provider", "nautilo-browser",
        "--session", "browser-session", "--json", "snapshot",
      ],
      [
        "--config", "/owned/browser-config.json", "--provider", "nautilo-browser",
        "--session", "browser-session", "--json", "snapshot",
      ],
      [
        "--config", "/owned/browser-config.json", "--provider", "nautilo-browser",
        "--session", "browser-session", "--json", "batch", "--bail",
        "focus '@e2'", "press 'Meta+Shift+P'",
      ],
    ]);
  });

  test("treats a failed targeted keyboard batch as an uncertain mutation", async () => {
    const handler = createInteractiveBrowserDispatchHandler(ports({
      exec: async (_binary, argv) => {
        if (argv.includes("snapshot")) return { stdout: browserSnapshotJson(), stderr: "" };
        throw Object.assign(new Error("batch failed"), { stderr: "focus subcommand failed" });
      },
    }));
    const snapshot = await handler({ request: request("browser_snapshot"), signal: undefined, guard });

    expect(await handler({
      request: request("browser_press", {
        key: "Enter",
        ref: "@e2",
        _requiredSession: "browser-session",
        _requiredObservationId: observationId(snapshot),
      }),
      signal: undefined,
      guard,
    })).toMatchObject({
      result: {
        status: "error",
        errorCode: "browser_outcome_unknown",
        error: expect.stringContaining("focus subcommand failed") as unknown,
      },
    });
  });

  test("prevents a bound key when its observation became stale", async () => {
    let snapshotCalls = 0;
    let keyCalls = 0;
    const handler = createInteractiveBrowserDispatchHandler(ports({
      exec: async (_binary, argv) => {
        if (argv.includes("--json")) {
          snapshotCalls += 1;
          return { stdout: browserSnapshotJson({ snapshot: snapshotCalls === 1 ? "before" : "after" }), stderr: "" };
        }
        keyCalls += 1;
        return { stdout: "must not run", stderr: "" };
      },
    }));
    const snapshot = await handler({ request: request("browser_snapshot"), signal: undefined, guard });

    expect(await handler({
      request: request("browser_press", {
        key: "Enter",
        _requiredSession: "browser-session",
        _requiredObservationId: observationId(snapshot),
      }),
      signal: undefined,
      guard,
    })).toMatchObject({ result: { status: "error", errorCode: "browser_observation_stale" } });
    expect(keyCalls).toBe(0);
  });

  test("consumes a bound observation after one keyboard mutation", async () => {
    const keys: string[] = [];
    const handler = createInteractiveBrowserDispatchHandler(ports({
      exec: async (_binary, argv) => {
        if (argv.includes("--json")) return { stdout: browserSnapshotJson(), stderr: "" };
        keys.push(argv.at(-1) ?? "");
        return { stdout: "pressed", stderr: "" };
      },
    }));
    const snapshot = await handler({ request: request("browser_snapshot"), signal: undefined, guard });
    const bound = {
      _requiredSession: "browser-session",
      _requiredObservationId: observationId(snapshot),
    };

    expect(await handler({
      request: request("browser_press", { key: "ArrowDown", ...bound }), signal: undefined, guard,
    })).toMatchObject({ result: { status: "ok" } });
    expect(await handler({
      request: request("browser_press", { key: "Enter", ...bound }), signal: undefined, guard,
    })).toMatchObject({ result: { status: "error", errorCode: "browser_observation_stale" } });
    expect(keys).toEqual(["ArrowDown"]);
  });

  test("checks bound navigation freshness before native navigation", async () => {
    let snapshotCalls = 0;
    const navigation: unknown[] = [];
    const handler = createInteractiveBrowserDispatchHandler(ports({
      exec: async (_binary, argv) => {
        if (!argv.includes("--json")) throw new Error("stale navigation must not run agent-browser actions");
        snapshotCalls += 1;
        return { stdout: browserSnapshotJson({ snapshot: snapshotCalls === 1 ? "before" : "after" }), stderr: "" };
      },
      controlBrowserNavigation: async (input) => {
        navigation.push(input);
        return { ok: true };
      },
    }));
    const snapshot = await handler({ request: request("browser_snapshot"), signal: undefined, guard });

    expect(await handler({
      request: request("browser_back", {
        _requiredSession: "browser-session",
        _requiredObservationId: observationId(snapshot),
      }),
      signal: undefined,
      guard,
    })).toMatchObject({ result: { status: "error", errorCode: "browser_observation_stale" } });
    expect(navigation).toEqual([]);
  });

  test("settles after successful bound native navigation before the next observation", async () => {
    const sequence: string[] = [];
    const handler = createInteractiveBrowserDispatchHandler(ports({
      exec: async (_binary, argv) => {
        if (argv.includes("eval")) {
          sequence.push("settle");
          return { stdout: JSON.stringify({ ready: true }), stderr: "" };
        }
        if (argv.includes("--json")) {
          sequence.push("snapshot");
          return { stdout: browserSnapshotJson(), stderr: "" };
        }
        throw new Error("native navigation must not run an agent-browser action");
      },
      controlBrowserNavigation: async ({ action }) => {
        sequence.push(action);
        return { ok: true };
      },
      waitForPublishedView: async () => true,
    }));
    const snapshot = await handler({ request: request("browser_snapshot"), signal: undefined, guard });

    expect(await handler({
      request: request("browser_back", {
        _requiredSession: "browser-session",
        _requiredObservationId: observationId(snapshot),
      }),
      signal: undefined,
      guard,
    })).toMatchObject({ handled: true, result: { status: "ok", result: { navigation: { execution: "executed", result: "Browser back completed" }, observation: { browserSessionId: "browser-session" } } } });
    expect(await handler({ request: request("browser_snapshot"), signal: undefined, guard })).toMatchObject({
      result: { status: "ok" },
    });
    expect(sequence).toEqual(["snapshot", "snapshot", "back", "settle", "snapshot", "snapshot"]);
  });

  test("rejects a bound action when its AX snapshot or URL changed", async () => {
    for (const changed of [
      { snapshot: "- button Different [ref=e2]" },
      { origin: "https://example.com/other" },
    ]) {
      let snapshotCalls = 0;
      let actionCalls = 0;
      const handler = createInteractiveBrowserDispatchHandler(ports({
        exec: async (_binary, argv) => {
          if (argv.includes("--json")) {
            snapshotCalls += 1;
            return {
              stdout: snapshotCalls === 1 ? browserSnapshotJson() : browserSnapshotJson(changed),
              stderr: "",
            };
          }
          actionCalls += 1;
          return { stdout: "action must not run", stderr: "" };
        },
      }));
      const snapshot = await handler({
        request: request("browser_snapshot"),
        signal: undefined,
        guard,
      });

      expect(await handler({
        request: request("browser_click", {
          ref: "e2",
          _requiredSession: "browser-session",
          _requiredObservationId: observationId(snapshot),
        }),
        signal: undefined,
        guard,
      })).toMatchObject({
        handled: true,
        result: { status: "error", errorCode: "browser_observation_stale" },
      });
      expect(actionCalls).toBe(0);
    }
  });

  test("rejects superseded and consumed observations without another action", async () => {
    let snapshotNumber = 0;
    const actionTools: string[] = [];
    const handler = createInteractiveBrowserDispatchHandler(ports({
      exec: async (_binary, argv) => {
        if (argv.includes("--json")) {
          snapshotNumber += 1;
          return { stdout: browserSnapshotJson({ snapshot: `snapshot-${snapshotNumber}` }), stderr: "" };
        }
        actionTools.push(argv.at(-2) ?? "");
        return { stdout: "done", stderr: "" };
      },
    }));
    const first = await handler({ request: request("browser_snapshot"), signal: undefined, guard });
    const second = await handler({ request: request("browser_snapshot"), signal: undefined, guard });

    expect(await handler({
      request: request("browser_click", {
        ref: "e2",
        _requiredSession: "browser-session",
        _requiredObservationId: observationId(first),
      }),
      signal: undefined,
      guard,
    })).toMatchObject({ result: { errorCode: "browser_observation_stale" } });

    expect(await handler({
      request: request("browser_click", { ref: "e2" }),
      signal: undefined,
      guard,
    })).toEqual({ handled: true, result: { status: "ok", result: "done" } });

    expect(await handler({
      request: request("browser_click", {
        ref: "e2",
        _requiredSession: "browser-session",
        _requiredObservationId: observationId(second),
      }),
      signal: undefined,
      guard,
    })).toMatchObject({ result: { errorCode: "browser_observation_stale" } });
    expect(actionTools).toEqual(["click"]);
  });

  test("serializes concurrent bound actions so one observation permits only the first action", async () => {
    const actionTools: string[] = [];
    const handler = createInteractiveBrowserDispatchHandler(ports({
      exec: async (_binary, argv) => {
        if (argv.includes("--json")) return { stdout: browserSnapshotJson(), stderr: "" };
        actionTools.push(argv.at(-2) ?? "");
        return { stdout: "done", stderr: "" };
      },
    }));
    const snapshot = await handler({ request: request("browser_snapshot"), signal: undefined, guard });
    const bound = {
      _requiredSession: "browser-session",
      _requiredObservationId: observationId(snapshot),
    };
    const first = handler({
      request: request("browser_click", { ref: "e2", ...bound }),
      signal: undefined,
      guard,
    });
    const second = handler({
      request: request("browser_type", { ref: "e2", text: "hello", ...bound }),
      signal: undefined,
      guard,
    });

    expect(await first).toEqual({ handled: true, result: { status: "ok", result: "done" } });
    expect(await second).toMatchObject({ result: { errorCode: "browser_observation_stale" } });
    expect(actionTools).toEqual(["click"]);
  });

  test("keeps an interleaved snapshot behind a bound compare-and-action sequence", async () => {
    let snapshotCalls = 0;
    let markCompareStarted!: () => void;
    let releaseCompare!: () => void;
    const compareStarted = new Promise<void>((resolve) => { markCompareStarted = resolve; });
    const compareReleased = new Promise<void>((resolve) => { releaseCompare = resolve; });
    const sequence: string[] = [];
    const handler = createInteractiveBrowserDispatchHandler(ports({
      exec: async (_binary, argv) => {
        if (argv.includes("eval")) {
          sequence.push("settle");
          return { stdout: JSON.stringify({ ready: true }), stderr: "" };
        }
        if (argv.includes("--json")) {
          snapshotCalls += 1;
          sequence.push(`snapshot-${snapshotCalls}`);
          if (snapshotCalls === 2) {
            markCompareStarted();
            await compareReleased;
          }
          return { stdout: browserSnapshotJson(), stderr: "" };
        }
        sequence.push(argv.at(-2) ?? "action");
        return { stdout: "done", stderr: "" };
      },
    }));
    const snapshot = await handler({ request: request("browser_snapshot"), signal: undefined, guard });
    const action = handler({
      request: request("browser_click", {
        ref: "e2",
        _requiredSession: "browser-session",
        _requiredObservationId: observationId(snapshot),
      }),
      signal: undefined,
      guard,
    });
    await compareStarted;
    const interleavedSnapshot = handler({
      request: request("browser_snapshot"),
      signal: undefined,
      guard,
    });
    releaseCompare();

    expect(await action).toEqual({ handled: true, result: { status: "ok", result: "done" } });
    expect(await interleavedSnapshot).toMatchObject({
      handled: true,
      result: { status: "ok" },
    });
    expect(sequence).toEqual(["snapshot-1", "snapshot-2", "click", "settle", "snapshot-3"]);
  });

  test.each(["pending", "cancelled"] as const)("reports %s settling without replaying the previous action", async (mode) => {
    const controller = new AbortController();
    let actions = 0;
    let snapshots = 0;
    const handler = createInteractiveBrowserDispatchHandler(ports({
      exec: async (_binary, argv, options) => {
        if (argv.includes("eval")) {
          expect(options.signal).toBe(controller.signal);
          if (mode === "cancelled") controller.abort();
          return { stdout: JSON.stringify({ ready: false }), stderr: "" };
        }
        if (argv.includes("--json")) {
          snapshots += 1;
          return { stdout: browserSnapshotJson(), stderr: "" };
        }
        actions += 1;
        return { stdout: "clicked", stderr: "" };
      },
    }));
    await handler({ request: request("browser_click", { ref: "e2" }), signal: controller.signal, guard });
    const result = await handler({ request: request("browser_snapshot"), signal: controller.signal, guard });
    expect(result).toMatchObject({ result: {
      status: "error",
      errorCode: mode === "cancelled" ? "browser_cancelled" : "browser_observation_invalid",
    } });
    expect(actions).toBe(1);
    expect(snapshots).toBe(0);
  });

  test("cancels before dispatch and reports an unknown outcome when abort follows a mutation start", async () => {
    let preabortedExecCalls = 0;
    const preaborted = new AbortController();
    preaborted.abort();
    const preabortedHandler = createInteractiveBrowserDispatchHandler(ports({
      exec: async () => {
        preabortedExecCalls += 1;
        return { stdout: "must not run", stderr: "" };
      },
    }));
    expect(await preabortedHandler({
      request: request("browser_click", { ref: "e2" }),
      signal: preaborted.signal,
      guard,
    })).toMatchObject({ result: { status: "error", errorCode: "browser_cancelled" } });
    expect(preabortedExecCalls).toBe(0);

    const afterStart = new AbortController();
    let actionCalls = 0;
    const afterStartHandler = createInteractiveBrowserDispatchHandler(ports({
      exec: async (_binary, _argv, options) => {
        actionCalls += 1;
        expect(options.signal).toBe(afterStart.signal);
        afterStart.abort();
        throw new Error("aborted while browser action was running");
      },
    }));
    expect(await afterStartHandler({
      request: request("browser_click", { ref: "e2" }),
      signal: afterStart.signal,
      guard,
    })).toMatchObject({ result: { status: "error", errorCode: "browser_outcome_unknown" } });
    expect(actionCalls).toBe(1);
  });

  test("reports an unknown outcome when a bound click loses its session during a successful exec", async () => {
    let activeSession = "browser-session";
    let markActionStarted!: () => void;
    let releaseAction!: () => void;
    const actionStarted = new Promise<void>((resolve) => { markActionStarted = resolve; });
    const actionReleased = new Promise<void>((resolve) => { releaseAction = resolve; });
    let actionCalls = 0;
    const handler = createInteractiveBrowserDispatchHandler(ports({
      sessionFor: () => activeSession,
      exec: async (_binary, argv) => {
        if (argv.includes("--json")) return { stdout: browserSnapshotJson(), stderr: "" };
        actionCalls += 1;
        markActionStarted();
        await actionReleased;
        return { stdout: "clicked", stderr: "" };
      },
    }));
    const snapshot = await handler({ request: request("browser_snapshot"), signal: undefined, guard });
    const pending = handler({
      request: request("browser_click", {
        ref: "e2",
        _requiredSession: "browser-session",
        _requiredObservationId: observationId(snapshot),
      }),
      signal: undefined,
      guard,
    });
    await actionStarted;
    activeSession = "replacement-session";
    releaseAction();

    expect(await pending).toMatchObject({
      result: {
        status: "error", errorCode: "browser_outcome_unknown",
        error: expect.stringContaining("Underlying browser error (browser_authority_lost): The bound embedded Browser session is no longer active.") as unknown,
      },
    });
    expect(actionCalls).toBe(1);
  });

  test("reports an unknown outcome when a bound type is cancelled during a successful exec", async () => {
    let markActionStarted!: () => void;
    let releaseAction!: () => void;
    const actionStarted = new Promise<void>((resolve) => { markActionStarted = resolve; });
    const actionReleased = new Promise<void>((resolve) => { releaseAction = resolve; });
    const controller = new AbortController();
    let actionCalls = 0;
    const handler = createInteractiveBrowserDispatchHandler(ports({
      exec: async (_binary, argv, options) => {
        if (argv.includes("--json")) return { stdout: browserSnapshotJson(), stderr: "" };
        actionCalls += 1;
        expect(options.signal).toBe(controller.signal);
        markActionStarted();
        await actionReleased;
        return { stdout: "typed", stderr: "" };
      },
    }));
    const snapshot = await handler({ request: request("browser_snapshot"), signal: undefined, guard });
    const pending = handler({
      request: request("browser_type", {
        ref: "e2",
        text: "hello",
        _requiredSession: "browser-session",
        _requiredObservationId: observationId(snapshot),
      }),
      signal: controller.signal,
      guard,
    });
    await actionStarted;
    controller.abort();
    releaseAction();

    expect(await pending).toMatchObject({
      result: {
        status: "error", errorCode: "browser_outcome_unknown",
        error: expect.stringContaining("Underlying browser error (browser_cancelled): Browser operation cancelled before the next action.") as unknown,
      },
    });
    expect(actionCalls).toBe(1);
  });

  test("loses browser authority when the session changes while a snapshot is pending", async () => {
    let activeSession = "browser-session";
    let releaseSnapshot!: () => void;
    let markSnapshotStarted!: () => void;
    const snapshotStarted = new Promise<void>((resolve) => { markSnapshotStarted = resolve; });
    const snapshotReleased = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    const handler = createInteractiveBrowserDispatchHandler(ports({
      sessionFor: () => activeSession,
      exec: async (_binary, argv) => {
        expect(argv).toContain("--json");
        markSnapshotStarted();
        await snapshotReleased;
        return { stdout: browserSnapshotJson(), stderr: "" };
      },
    }));
    const pending = handler({
      request: request("browser_snapshot", { _requiredSession: "browser-session" }),
      signal: undefined,
      guard,
    });
    await snapshotStarted;
    activeSession = "replacement-session";
    releaseSnapshot();

    expect(await pending).toMatchObject({
      result: { status: "error", errorCode: "browser_authority_lost" },
    });
  });

  test("captures screenshot geometry and reuses its scale for image-coordinate clicks", async () => {
    const executions: string[][] = [];
    const scales = new Map<string, { readonly x: number; readonly y: number }>();
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
    expect(scales.get("browser-session")).toEqual({ x: 2, y: 2 });
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
    const controller = new AbortController();
    const handler = createInteractiveBrowserDispatchHandler(ports({
      exec: async (_binary, argv, options) => {
        executions.push({ argv, options });
        return { stdout: executions.length === 1 ? "false" : "true", stderr: "" };
      },
    }));

    expect(await handler({
      request: request("browser_wait", { ref: "e9" }),
      signal: controller.signal,
      guard,
    })).toEqual({
      handled: true,
      result: { status: "ok", result: "Element e9 is visible" },
    });
    expect(executions).toHaveLength(2);
    expect(executions[0]?.argv).toEqual(executions[1]?.argv);
    for (const execution of executions) {
      expect(execution.options).toEqual({
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        signal: controller.signal,
      });
    }
  });
});

test("navigation supplies fresh refs immediately and admits a read against that exact observation", async () => {
  const commands: string[][] = [];
  const handler = createInteractiveBrowserDispatchHandler(ports({ exec: async (_binary, argv) => {
    commands.push([...argv]);
    if (argv.includes("eval")) return { stdout: JSON.stringify({ ready: true }) };
    if (argv.includes("snapshot")) return { stdout: browserSnapshotJson() };
    return { stdout: argv.includes("open") ? "opened" : "Exact product information" };
  } }));
  const opened = await handler({ request: request("browser_open", { url: "https://example.com" }), signal: undefined, guard });
  expect(opened).toMatchObject({ result: { status: "ok", result: { navigation: { execution: "executed" }, observation: { refs: { e2: { name: "Continue" } } } } } });
  const result = (opened.result as { result: { observation: { observationId: string } } }).result;
  const read = await handler({ request: request("browser_read", { ref: "@e2", _requiredSession: "browser-session", _requiredObservationId: result.observation.observationId }), signal: undefined, guard });
  expect(read).toMatchObject({ result: { status: "ok", result: "Exact product information" } });
  expect(commands.filter(argv => argv.includes("open"))).toHaveLength(1);
});

test("post-navigation observation failure reports completed navigation without replaying it", async () => {
  let opens = 0;
  const handler = createInteractiveBrowserDispatchHandler(ports({ exec: async (_binary, argv) => {
    if (argv.includes("open")) { opens++; return { stdout: "opened" }; }
    throw new Error("Page observation transport unavailable");
  } }));
  expect(await handler({ request: request("browser_open", { url: "https://example.com" }), signal: undefined, guard })).toMatchObject({
    result: { status: "ok", result: { navigation: { execution: "executed" }, observationFailure: {
      code: "browser_observation_invalid", detail: "Page observation transport unavailable", recovery: expect.stringContaining("do not repeat navigation") as unknown,
    } } },
  });
  expect(opens).toBe(1);
});
