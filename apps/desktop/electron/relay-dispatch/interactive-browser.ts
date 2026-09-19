import { randomUUID } from "node:crypto";
import {
  agentBrowserArgv,
  agentBrowserSnapshotJsonArgv,
  browserArgvPrefix,
  browserToolMayMutate,
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
import { browserObservationSettleExpression } from "../browser-observation-settle.ts";
import {
  FIXED_DESKTOP_DISPATCH_NOT_HANDLED,
  type FixedDesktopDispatchHandler,
  type FixedDesktopDispatchContext,
  type DesktopDispatchDecision,
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
  if (error instanceof BrowserDispatchFailure) {
    return { status: "error", errorCode: error.code, error: error.message };
  }
  const detail = error as {
    readonly code?: string;
    readonly cmd?: string;
    readonly signal?: string;
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
  // Node embeds the full command (including arguments) in exec errors. Keep
  // browser diagnostics, not that wrapper, in the model-visible handoff.
  const commandPrefix = detail.cmd ? `Command failed: ${detail.cmd}` : undefined;
  const processMessage = commandPrefix && detail.message?.startsWith(commandPrefix)
    ? detail.message.slice(commandPrefix.length).trim()
    : detail.message?.startsWith("Command failed:") ? undefined : detail.message;
  const message = detail.stderr?.trim() || detail.stdout?.trim() || processMessage
    || [detail.code, detail.signal].filter(Boolean).join(" ");
  if (detail.killed) {
    return {
      status: "error",
      error: `${request.toolName} timed out after ${BROWSER_EXEC_TIMEOUT_MS}ms${message ? `\n${message}` : ""}`,
    };
  }
  return { status: "error", error: message || `${request.toolName} failed` };
}

interface BrowserObservation {
  version: 1;
  snapshot: string;
  refs: Record<string, { role: string; name: string }>;
  pageUrl: string;
  browserSessionId: string;
  observationId: string;
}

class BrowserDispatchFailure extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function parseBrowserSnapshot(stdout: string, session: string): BrowserObservation {
  const envelope: unknown = JSON.parse(stdout);
  const object = (value: unknown): Record<string, unknown> | null => value !== null
    && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const response = object(envelope);
  const data = response?.["success"] === true ? object(response["data"]) : null;
  const rawRefs = object(data?.["refs"]);
  if (typeof data?.["snapshot"] !== "string" || typeof data["origin"] !== "string" || !rawRefs) {
    throw new Error("Invalid agent-browser snapshot envelope");
  }
  const pageUrl = new URL(data["origin"]).href;
  const refs: BrowserObservation["refs"] = {};
  for (const [key, raw] of Object.entries(rawRefs).sort(([a], [b]) => a.localeCompare(b))) {
    const ref = object(raw);
    if (!/^e\d+$/.test(key) || typeof ref?.["role"] !== "string" || !ref["role"].trim()
      || typeof ref["name"] !== "string") throw new Error("Invalid agent-browser reference");
    refs[key] = { role: ref["role"], name: ref["name"] };
  }
  return { version: 1, snapshot: data["snapshot"], refs, pageUrl, browserSessionId: session, observationId: randomUUID() };
}

function browserFailure(code: string, error: string): DesktopDispatchDecision {
  return { handled: true, result: { status: "error", errorCode: code, error } };
}

/** Fixed interactive-browser adapter over Electron-owned BrowserView ports. */
export function createInteractiveBrowserDispatchHandler(
  ports: InteractiveBrowserDispatchPorts,
): FixedDesktopDispatchHandler {
  let latestObservation: BrowserObservation | null = null;
  let settleSession: string | null = null;
  let tail: Promise<void> = Promise.resolve();
  const execute = async ({ request, signal }: FixedDesktopDispatchContext, markMutation: () => void): Promise<DesktopDispatchDecision> => {
    const assertLive = () => {
      if (signal?.aborted) throw new BrowserDispatchFailure("browser_cancelled", "Browser operation cancelled before the next action.");
      const required = request.args["_requiredSession"];
      if (typeof required === "string" && (!ports.hasPublishedView() || ports.sessionFor({}) !== required)) {
        throw new BrowserDispatchFailure("browser_authority_lost", "The bound embedded Browser session is no longer active. Reobserve before acting.");
      }
    };
    assertLive();
    const exec: InteractiveBrowserDispatchPorts["exec"] = async (binary, argv, options) => {
      assertLive();
      if (browserToolMayMutate(request.toolName)) markMutation();
      const result = await ports.exec(binary, argv, { ...options, ...(signal ? { signal } : {}) });
      assertLive();
      return result;
    };
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

    const requiredObservationId = typeof request.args["_requiredObservationId"] === "string"
      ? request.args["_requiredObservationId"] : null;
    const boundObservation = requiredObservationId === null ? null : latestObservation;
    if (requiredObservationId !== null && (!boundObservation || boundObservation.observationId !== requiredObservationId)) {
      return browserFailure("browser_observation_stale", "The browser observation was consumed or superseded. Take a fresh snapshot before choosing an action.");
    }
    if (boundObservation && !browserToolMayMutate(request.toolName)) {
      return browserFailure("browser_authority_lost", "This action is outside the admitted routine browser contract.");
    }
    // Every mutation attempt consumes the observation, including ordinary Genie actions.
    if (browserToolMayMutate(request.toolName) || request.toolName === "browser_snapshot") latestObservation = null;

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
      assertLive();
      markMutation();
      const readiness = await ports.ensureBrowserSurface({
        url: url.href,
        timeoutMs: BROWSER_EXEC_TIMEOUT_MS,
      });
      if (!readiness.ok) {
        return { handled: true, result: { status: "error", error: readiness.error } };
      }
    }

    const session =
      requiredSession ??
      ports.sessionFor(request.toolName === "browser_read_page" ? {} : request.args);

    const readSnapshot = async (): Promise<BrowserObservation> => {
      assertLive();
      if (settleSession !== null) {
        const pendingSession = settleSession;
        settleSession = null;
        if (pendingSession === session) {
          const { stdout } = await ports.exec(binary, [
            ...browserArgvPrefix(configPath, session), "eval",
            browserObservationSettleExpression(BROWSER_EXEC_TIMEOUT_MS),
          ], { timeout: BROWSER_EXEC_TIMEOUT_MS, maxBuffer: 1024 * 1024, ...(signal ? { signal } : {}) });
          assertLive();
          const settled: unknown = JSON.parse(stdout);
          if (settled === null || typeof settled !== "object" || !("ready" in settled) || settled.ready !== true) {
            throw new BrowserDispatchFailure("browser_observation_invalid", "The browser did not settle before observation: the document, focused control or open autocomplete response remained pending. Inspect fresh browser state before continuing.");
          }
        }
      }
      const { stdout } = await ports.exec(binary, agentBrowserSnapshotJsonArgv(configPath, session), {
        timeout: BROWSER_EXEC_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, ...(signal ? { signal } : {}),
      });
      assertLive();
      if (!ports.hasPublishedView() || ports.sessionFor({}) !== session) {
        throw new BrowserDispatchFailure("browser_authority_lost", "The embedded Browser changed during observation. Observe the current session again.");
      }
      try { return parseBrowserSnapshot(stdout, session); } catch {
        throw new BrowserDispatchFailure("browser_observation_invalid", "The browser did not return a complete structured observation. Return to the Genie for inspection.");
      }
    };
    if (request.toolName === "browser_snapshot") {
      const observation = await readSnapshot();
      latestObservation = observation;
      return { handled: true, result: { status: "ok", result: observation } };
    }
    if (boundObservation !== null) {
      if (requiredSession !== boundObservation.browserSessionId || session !== boundObservation.browserSessionId
        || !browserToolMayMutate(request.toolName)) {
        return browserFailure("browser_authority_lost", "The proposed action no longer matches its browser session.");
      }
      // The queue serializes snapshot/ref-map replacement and the following mutation.
      // This proves AX/URL equivalence, not DOM identity or immunity to in-page JavaScript races.
      const fresh = await readSnapshot();
      if (fresh.pageUrl !== boundObservation.pageUrl || fresh.snapshot !== boundObservation.snapshot
        || JSON.stringify(fresh.refs) !== JSON.stringify(boundObservation.refs)) {
        return browserFailure("browser_observation_stale", "The browser changed since the decision. Take a fresh snapshot; the proposed action was not executed.");
      }
      assertLive();
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
      assertLive();
      markMutation();
      const navigation = await ports.controlBrowserNavigation({ action: navigationAction });
      assertLive();
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
      assertLive();
      return {
        handled: true,
        result: { status: "ok", result: `Browser ${navigationAction} completed` },
      };
    }

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
            exec,
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
        await exec(binary, argv, {
          timeout: BROWSER_EXEC_TIMEOUT_MS,
          maxBuffer: 8 * 1024 * 1024,
        });
        const png = ports.readCapturePng(capturePath);
        const { width: imageWidth, height: imageHeight } = ports.captureDimensions(png);
        let css = { w: 0, h: 0, dpr: 1 };
        let scale = 1;
        try {
          const evaluation = agentBrowserViewportEvalArgv(configPath, session);
          const { stdout } = await exec(binary, evaluation, {
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
            const { stdout } = await exec(binary, evaluation, {
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
          await exec(binary, argv, {
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
          const { stdout } = await exec(binary, evaluation, {
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
          await exec(binary, argv, {
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
          const { stdout } = await exec(binary, argv, {
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
        await new Promise<void>((resolve, reject) => {
          const cancel = () => { clearTimeout(timer); reject(new BrowserDispatchFailure("browser_cancelled", "Browser wait cancelled.")); };
          const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(); }, 100);
          signal?.addEventListener("abort", cancel, { once: true });
          if (signal?.aborted) cancel();
        });
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
      const { stdout } = await exec(binary, argv, {
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
  return (context) => {
    if (context.request.executionClass !== "browser" && !isBrowserTool(context.request.toolName)) {
      return Promise.resolve(FIXED_DESKTOP_DISPATCH_NOT_HANDLED);
    }
    const run = async (): Promise<DesktopDispatchDecision> => {
      let mutationAttempted = false;
      let outcome: DesktopDispatchDecision;
      try { outcome = await execute(context, () => {
        mutationAttempted = true;
        settleSession = ports.sessionFor({});
      }); }
      catch (error) {
        outcome = error instanceof BrowserDispatchFailure
          ? browserFailure(error.code, error.message)
          : { handled: true, result: browserExecError(context.request, error, ports.binaryInstallHint) };
      }
      if (!mutationAttempted && context.signal?.aborted && outcome.handled && outcome.result.status === "error") {
        return browserFailure("browser_cancelled", "Browser operation cancelled before the next action.");
      }
      if (mutationAttempted && outcome.handled && outcome.result.status === "error") {
        const causeCode = outcome.result.errorCode ? ` (${outcome.result.errorCode})` : "";
        return {
          handled: true,
          result: {
            ...outcome.result,
            errorCode: "browser_outcome_unknown",
            error: `${context.request.toolName} may have taken effect. Do not replay it blindly. Obtain a fresh observation and inspect the result before deciding how to recover.\nUnderlying browser error${causeCode}: ${outcome.result.error}`,
          },
        };
      }
      return outcome;
    };
    // One queue covers all browser calls, including ordinary observation/read/action traffic.
    const pending = tail.then(run, run);
    tail = pending.then(() => undefined, () => undefined);
    return pending;
  };
}
