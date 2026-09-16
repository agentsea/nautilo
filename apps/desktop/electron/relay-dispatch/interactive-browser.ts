import {
  agentBrowserArgv,
  agentBrowserMouseClickArgvs,
  agentBrowserScrollArgvs,
  agentBrowserViewportEvalArgv,
  browserImageCoordsToCss,
  BROWSER_EMPTY_DOM_TEXT_HINT,
  isBrowserTool,
  type RelayDispatchRequest,
  type RelayDispatchResult,
} from "@nautilo/relay";

import {
  BROWSER_PAGE_READ_NO_ACTIVE_TARGET_ERROR,
  dispatchBrowserPageContinuation,
  dispatchBrowserPageSnapshotInspection,
  dispatchInteractiveBrowserPageRead,
} from "../browser-page-read-dispatch.ts";
import type { BrowserPageSnapshotStore } from "../browser-page-snapshot-store.ts";
import {
  FIXED_DESKTOP_DISPATCH_NOT_HANDLED,
  type FixedDesktopDispatchHandler,
} from "./router.ts";

const BROWSER_EXEC_TIMEOUT_MS = 30_000;

export interface InteractiveBrowserExecOptions {
  readonly timeout: number;
  readonly maxBuffer: number;
  readonly signal?: AbortSignal | undefined;
}

export interface InteractiveBrowserDispatchPorts {
  readonly resolveBinary: () => string | null;
  readonly binaryInstallHint: () => string;
  readonly ensureConfig: () => string;
  readonly sessionFor: (args: Record<string, unknown>) => string;
  readonly hasPublishedView: () => boolean;
  readonly waitForPublishedView: () => Promise<boolean>;
  readonly ensureBrowserSurface?: ((request: {
    readonly url: string;
    readonly timeoutMs: number;
  }) => Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }>) | undefined;
  readonly controlBrowserNavigation?: ((request: {
    readonly action: "back" | "forward" | "reload";
  }) => Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }>) | undefined;
  readonly snapshotStore?: BrowserPageSnapshotStore | undefined;
  readonly getCoordinateScale: (session: string) => number | undefined;
  readonly setCoordinateScale: (session: string, scale: number) => void;
  readonly exec: (
    binary: string,
    argv: string[],
    options: InteractiveBrowserExecOptions,
  ) => Promise<{ readonly stdout: string; readonly stderr?: string }>;
  readonly pruneCaptures: () => void;
  readonly capturePath: () => string;
  readonly readCapturePng: (path: string) => Buffer;
  readonly captureDimensions: (png: Buffer) => { readonly width: number; readonly height: number };
  readonly visionFromPng: (path: string, text: string) => RelayDispatchResult;
}

function browserExecError(
  request: RelayDispatchRequest,
  error: unknown,
  installHint: () => string,
): RelayDispatchResult {
  const detail = error as {
    readonly code?: string;
    readonly killed?: boolean;
    readonly stdout?: string;
    readonly stderr?: string;
    readonly message?: string;
  };
  if (detail.code === "ENOENT") {
    return {
      status: "error",
      error: `agent-browser is not available. ${installHint()}`,
    };
  }
  if (detail.killed) {
    return {
      status: "error",
      error: `${request.toolName} timed out after ${BROWSER_EXEC_TIMEOUT_MS}ms`,
    };
  }
  const message =
    (detail.stderr ?? detail.stdout ?? "").trim() ||
    detail.message ||
    `${request.toolName} failed`;
  return { status: "error", error: message };
}

/** Fixed interactive-browser adapter over Electron-owned BrowserView ports. */
export function createInteractiveBrowserDispatchHandler(
  ports: InteractiveBrowserDispatchPorts,
): FixedDesktopDispatchHandler {
  return async ({ request }) => {
    if (request.executionClass !== "browser" && !isBrowserTool(request.toolName)) {
      return FIXED_DESKTOP_DISPATCH_NOT_HANDLED;
    }
    if (!isBrowserTool(request.toolName)) {
      return {
        handled: true,
        result: {
          status: "error",
          error: `Unknown browser tool: ${request.toolName}`,
        },
      };
    }

    const requiredSession =
      typeof request.args["_requiredSession"] === "string"
        ? request.args["_requiredSession"]
        : null;
    if (
      requiredSession !== null &&
      (!ports.hasPublishedView() || ports.sessionFor({}) !== requiredSession)
    ) {
      return {
        handled: true,
        result: {
          status: "error",
          error:
            "the embedded Browser session bound to this Task continuation is no longer active",
        },
      };
    }

    if (
      request.toolName === "browser_read_page" &&
      request.args["continuation"] !== undefined
    ) {
      return {
        handled: true,
        result: dispatchBrowserPageContinuation(request.args, {
          ...(ports.snapshotStore === undefined
            ? {}
            : { snapshotStore: ports.snapshotStore }),
          ...(request.browserPageOwnerBinding === undefined
            ? {}
            : { snapshotOwner: request.browserPageOwnerBinding }),
          ...(request.browserPageSnapshotReferencePublication === true
            ? { publishSnapshotReference: true }
            : {}),
          expectedTargetRole: "interactive",
        }),
      };
    }

    if (
      request.toolName === "browser_read_page" &&
      request.args["snapshot"] !== undefined
    ) {
      return {
        handled: true,
        result: dispatchBrowserPageSnapshotInspection(request.args, {
          ...(ports.snapshotStore === undefined
            ? {}
            : { snapshotStore: ports.snapshotStore }),
          ...(request.browserPageOwnerBinding === undefined
            ? {}
            : { snapshotOwner: request.browserPageOwnerBinding }),
          ...(request.browserPageSnapshotReferencePublication === true
            ? { publishSnapshotReference: true }
            : {}),
          expectedTargetRole: "interactive",
        }),
      };
    }

    if (request.toolName === "browser_read_page" && !ports.hasPublishedView()) {
      return {
        handled: true,
        result: { status: "error", error: BROWSER_PAGE_READ_NO_ACTIVE_TARGET_ERROR },
      };
    }

    const binary = ports.resolveBinary();
    if (!binary) {
      return {
        handled: true,
        result: {
          status: "error",
          error: `agent-browser is not available. ${ports.binaryInstallHint()}`,
        },
      };
    }
    const configPath = ports.ensureConfig();

    if (request.toolName === "browser_open" && !ports.hasPublishedView()) {
      const rawUrl = request.args["url"];
      let url: URL;
      try {
        url = new URL(typeof rawUrl === "string" ? rawUrl : "");
      } catch {
        return {
          handled: true,
          result: {
            status: "error",
            error: "browser_open requires an absolute HTTP or HTTPS `url`",
          },
        };
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return {
          handled: true,
          result: {
            status: "error",
            error: "browser_open requires an absolute HTTP or HTTPS `url`",
          },
        };
      }
      if (!ports.ensureBrowserSurface) {
        return {
          handled: true,
          result: {
            status: "error",
            error:
              "browser_open could not ask the active Nautilo window to open its Browser surface",
          },
        };
      }
      const readiness = await ports.ensureBrowserSurface({
        url: url.href,
        timeoutMs: BROWSER_EXEC_TIMEOUT_MS,
      });
      if (!readiness.ok) {
        return { handled: true, result: { status: "error", error: readiness.error } };
      }
    }

    const navigationAction =
      request.toolName === "browser_back"
        ? "back"
        : request.toolName === "browser_forward"
          ? "forward"
          : request.toolName === "browser_reload"
            ? "reload"
            : null;
    if (navigationAction && ports.controlBrowserNavigation) {
      const navigation = await ports.controlBrowserNavigation({ action: navigationAction });
      if (!navigation.ok) {
        return { handled: true, result: { status: "error", error: navigation.error } };
      }
      if (!(await ports.waitForPublishedView())) {
        return {
          handled: true,
          result: {
            status: "error",
            error: `${request.toolName} completed but the embedded Browser did not remain controllable`,
          },
        };
      }
      return {
        handled: true,
        result: { status: "ok", result: `Browser ${navigationAction} completed` },
      };
    }

    const session =
      requiredSession ??
      ports.sessionFor(request.toolName === "browser_read_page" ? {} : request.args);

    if (request.toolName === "browser_read_page") {
      return {
        handled: true,
        result: await dispatchInteractiveBrowserPageRead(
          request.args,
          {
            bin: binary,
            cfgPath: configPath,
            session,
            timeoutMs: BROWSER_EXEC_TIMEOUT_MS,
            maxBuffer: 1024 * 1024,
          },
          {
            hasActiveTarget: ports.hasPublishedView,
            exec: ports.exec,
            ...(ports.snapshotStore === undefined
              ? {}
              : { snapshotStore: ports.snapshotStore }),
            ...(request.browserPageOwnerBinding === undefined
              ? {}
              : { snapshotOwner: request.browserPageOwnerBinding }),
            ...(request.browserPageSnapshotReferencePublication === true
              ? { publishSnapshotReference: true }
              : {}),
          },
        ),
      };
    }

    if (request.toolName === "browser_screenshot") {
      ports.pruneCaptures();
      const capturePath = ports.capturePath();
      let argv: string[];
      try {
        argv = agentBrowserArgv(
          request.toolName,
          { ...request.args, _capturePath: capturePath },
          configPath,
          session,
        );
      } catch (error) {
        return {
          handled: true,
          result: {
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }
      try {
        await ports.exec(binary, argv, {
          timeout: BROWSER_EXEC_TIMEOUT_MS,
          maxBuffer: 8 * 1024 * 1024,
        });
        const png = ports.readCapturePng(capturePath);
        const { width: imageWidth, height: imageHeight } = ports.captureDimensions(png);
        let css = { w: 0, h: 0, dpr: 1 };
        let scale = 1;
        try {
          const evaluation = agentBrowserViewportEvalArgv(configPath, session);
          const { stdout } = await ports.exec(binary, evaluation, {
            timeout: BROWSER_EXEC_TIMEOUT_MS,
            maxBuffer: 1024 * 1024,
          });
          const parsed = JSON.parse(stdout.trim()) as {
            readonly w?: number;
            readonly h?: number;
            readonly dpr?: number;
          };
          css = {
            w: typeof parsed.w === "number" ? parsed.w : 0,
            h: typeof parsed.h === "number" ? parsed.h : 0,
            dpr:
              typeof parsed.dpr === "number" && parsed.dpr > 0 ? parsed.dpr : 1,
          };
          scale = css.w > 0 ? imageWidth / css.w : 1;
        } catch {
          // Viewport evaluation is best effort; scale=1 remains the fallback.
        }
        ports.setCoordinateScale(session, scale);
        const scaleLine =
          `viewport_css=${css.w}x${css.h} image_px=${imageWidth}x${imageHeight} ` +
          `dpr=${css.dpr} scale=${scale.toFixed(3)}`;
        return {
          handled: true,
          result: ports.visionFromPng(
            capturePath,
            "Browser app surface screenshot captured. Use this image to read canvas-rendered content " +
              "(e.g. Google Docs) and browser_mouse to click pixel coordinates from what you see in this image.\n" +
              scaleLine,
          ),
        };
      } catch (error) {
        return {
          handled: true,
          result: browserExecError(request, error, ports.binaryInstallHint),
        };
      }
    }

    if (request.toolName === "browser_mouse") {
      const x = request.args["x"];
      const y = request.args["y"];
      const space = request.args["space"] === "css" ? "css" : "image";
      if (
        typeof x !== "number" ||
        typeof y !== "number" ||
        !Number.isFinite(x) ||
        !Number.isFinite(y)
      ) {
        return {
          handled: true,
          result: {
            status: "error",
            error: "browser_mouse requires finite numeric `x` and `y` coordinates",
          },
        };
      }
      let cssX = x;
      let cssY = y;
      let scaleUsed: number | undefined;
      let scaleNote = "";
      if (space === "image") {
        let scale = ports.getCoordinateScale(session);
        if (scale === undefined) {
          try {
            const evaluation = agentBrowserViewportEvalArgv(configPath, session);
            const { stdout } = await ports.exec(binary, evaluation, {
              timeout: BROWSER_EXEC_TIMEOUT_MS,
              maxBuffer: 1024 * 1024,
            });
            const parsed = JSON.parse(stdout.trim()) as { readonly dpr?: number };
            scale =
              typeof parsed.dpr === "number" &&
              parsed.dpr > 0 &&
              Number.isFinite(parsed.dpr)
                ? parsed.dpr
                : 1;
            scaleNote = "; scale from dpr fallback (re-screenshot for exact scale)";
          } catch {
            scale = 1;
            scaleNote = "; scale=1 fallback (re-screenshot for exact scale)";
          }
        }
        scaleUsed = scale;
        const converted = browserImageCoordsToCss(x, y, scale);
        cssX = converted.cssX;
        cssY = converted.cssY;
      }
      try {
        const commands = agentBrowserMouseClickArgvs(
          configPath,
          session,
          cssX,
          cssY,
        );
        for (const argv of commands) {
          await ports.exec(binary, argv, {
            timeout: BROWSER_EXEC_TIMEOUT_MS,
            maxBuffer: 8 * 1024 * 1024,
          });
        }
        const result =
          space === "css"
            ? `Clicked at css(${cssX},${cssY}) space=css`
            : `Clicked at css(${cssX},${cssY}) from image(${x},${y}) space=image scale=${scaleUsed!.toFixed(3)}${scaleNote}`;
        return { handled: true, result: { status: "ok", result } };
      } catch (error) {
        return {
          handled: true,
          result: browserExecError(request, error, ports.binaryInstallHint),
        };
      }
    }

    if (request.toolName === "browser_scroll") {
      const directionArgument = request.args["direction"];
      if (typeof directionArgument !== "string" || directionArgument.length === 0) {
        return {
          handled: true,
          result: {
            status: "error",
            error: "browser_scroll requires a non-empty string `direction` argument",
          },
        };
      }
      if (!["up", "down", "left", "right"].includes(directionArgument)) {
        return {
          handled: true,
          result: {
            status: "error",
            error:
              "browser_scroll requires `direction` to be one of: up, down, left, right",
          },
        };
      }
      const direction = directionArgument;
      const amountArgument = request.args["amount"];
      const amount =
        typeof amountArgument === "number" && Number.isFinite(amountArgument)
          ? amountArgument
          : 600;
      let centerX = 600;
      let centerY = 400;
      if (direction === "down" || direction === "up") {
        try {
          const evaluation = agentBrowserViewportEvalArgv(configPath, session);
          const { stdout } = await ports.exec(binary, evaluation, {
            timeout: BROWSER_EXEC_TIMEOUT_MS,
            maxBuffer: 1024 * 1024,
          });
          const parsed = JSON.parse(stdout.trim()) as {
            readonly w?: number;
            readonly h?: number;
          };
          const width = typeof parsed.w === "number" && parsed.w > 0 ? parsed.w : 0;
          const height = typeof parsed.h === "number" && parsed.h > 0 ? parsed.h : 0;
          if (width > 0 && height > 0) {
            centerX = Math.round(width / 2);
            centerY = Math.round(height / 2);
          }
        } catch {
          // Viewport evaluation is best effort; fixed fallback center remains.
        }
      }
      let commands: string[][];
      try {
        commands = agentBrowserScrollArgvs(
          configPath,
          session,
          direction,
          amount,
          centerX,
          centerY,
        );
      } catch (error) {
        return {
          handled: true,
          result: {
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }
      try {
        for (const argv of commands) {
          await ports.exec(binary, argv, {
            timeout: BROWSER_EXEC_TIMEOUT_MS,
            maxBuffer: 8 * 1024 * 1024,
          });
        }
        return {
          handled: true,
          result: { status: "ok", result: `Scrolled ${direction} ${amount}` },
        };
      } catch (error) {
        return {
          handled: true,
          result: browserExecError(request, error, ports.binaryInstallHint),
        };
      }
    }

    if (
      request.toolName === "browser_wait" &&
      typeof request.args["ref"] === "string"
    ) {
      let argv: string[];
      try {
        argv = agentBrowserArgv(request.toolName, request.args, configPath, session);
      } catch (error) {
        return {
          handled: true,
          result: {
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }
      const timeoutMs = 10_000;
      const deadline = Date.now() + timeoutMs;
      do {
        try {
          const { stdout } = await ports.exec(binary, argv, {
            timeout: BROWSER_EXEC_TIMEOUT_MS,
            maxBuffer: 1024 * 1024,
          });
          if (stdout.trim() === "true") {
            return {
              handled: true,
              result: {
                status: "ok",
                result: `Element ${request.args["ref"]} is visible`,
              },
            };
          }
        } catch (error) {
          return {
            handled: true,
            result: browserExecError(request, error, ports.binaryInstallHint),
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      return {
        handled: true,
        result: {
          status: "error",
          error: `browser_wait timed out after ${timeoutMs}ms waiting for ${request.args["ref"]}`,
        },
      };
    }

    let argv: string[];
    try {
      argv = agentBrowserArgv(request.toolName, request.args, configPath, session);
    } catch (error) {
      return {
        handled: true,
        result: {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
    try {
      const { stdout } = await ports.exec(binary, argv, {
        timeout: BROWSER_EXEC_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      });
      const trimmed = stdout.trim();
      if (
        (request.toolName === "browser_read" || request.toolName === "browser_get") &&
        trimmed === ""
      ) {
        return {
          handled: true,
          result: { status: "ok", result: BROWSER_EMPTY_DOM_TEXT_HINT },
        };
      }
      return { handled: true, result: { status: "ok", result: trimmed } };
    } catch (error) {
      return {
        handled: true,
        result: browserExecError(request, error, ports.binaryInstallHint),
      };
    }
  };
}
