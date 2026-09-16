/**
 * D336 — embedded SaaS browser automation (agent-browser) shared relay logic.
 *
 * Pure, dependency-free mapping from a `browser_*` tool call to an
 * `agent-browser` CLI argv array. Lives in `@nautilo/relay` so the Electron
 * relay and (future) headless `nautilo-relay` share one implementation.
 *
 * SECURITY: the relay runs `agent-browser` via an argv array (never
 * `/bin/sh -c`), as an explicit sandbox-exempt execution class. This module
 * only builds argv; it does no spawning and no shell interpolation.
 */

/** The fixed set of browser tools supported in D336 Phase 2. */
export const BROWSER_TOOLS = [
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_press",
  "browser_read",
  "browser_read_page",
  "browser_screenshot",
  "browser_mouse",
  "browser_get",
  "browser_scroll",
  "browser_back",
  "browser_open",
  "browser_forward",
  "browser_reload",
  "browser_hover",
  "browser_double_click",
  "browser_drag",
  "browser_select",
  "browser_set_checked",
  "browser_scroll_into_view",
  "browser_wait",
] as const;

export type BrowserToolName = (typeof BROWSER_TOOLS)[number];

export function isBrowserTool(name: string): name is BrowserToolName {
  return (BROWSER_TOOLS as readonly string[]).includes(name);
}

function requireStringArg(
  args: Record<string, unknown>,
  key: string,
  toolName: string,
): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${toolName} requires a non-empty string \`${key}\` argument`);
  }
  return value;
}

function requireHttpUrlArg(args: Record<string, unknown>, toolName: string): string {
  const value = requireStringArg(args, "url", toolName);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${toolName} requires an absolute HTTP or HTTPS \`url\``);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${toolName} requires an absolute HTTP or HTTPS \`url\``);
  }
  return value;
}

/** Accept both `@e12` and bare `e12`; agent-browser refs require the `@`. */
function normalizeBrowserRef(ref: string): string {
  return /^e\d+$/i.test(ref) ? `@${ref}` : ref;
}

const BROWSER_GET_WHAT = new Set(["box", "value", "attr", "html", "title", "url"]);

export const browserArgvPrefix = (cfgPath: string, session: string) =>
  ["--config", cfgPath, "--provider", "nautilo-browser", "--session", session] as const;

/**
 * Prefix for a server-owned, already-attached CDP browser.
 *
 * The CDP capability is deliberately absent here: callers must pass it through
 * `AGENT_BROWSER_CDP` in the process environment.  In particular, Connected
 * Website control must not use the `browseruse` provider shortcut; that
 * shortcut creates a different, unowned Browser Use browser.
 */
export const browserCdpArgvPrefix = (session: string) =>
  ["--session", session] as const;

/** Eval argv returning `{w,h,dpr}` for screenshot→mouse coordinate mapping. */
export function agentBrowserViewportEvalArgv(cfgPath: string, session: string): string[] {
  const prefix = browserArgvPrefix(cfgPath, session);
  return [...prefix, "eval", "({w:innerWidth,h:innerHeight,dpr:devicePixelRatio})"];
}

/** Convert image-pixel coords from a vision screenshot to CSS viewport pixels. */
export function browserImageCoordsToCss(
  x: number,
  y: number,
  scale: number,
): { cssX: number; cssY: number } {
  const safeScale = scale > 0 && Number.isFinite(scale) ? scale : 1;
  return { cssX: Math.round(x / safeScale), cssY: Math.round(y / safeScale) };
}

export const BROWSER_EMPTY_DOM_TEXT_HINT =
  "[no DOM text returned — element may be canvas-rendered (e.g. Google Docs body); use browser_screenshot + browser_mouse instead]";

/**
 * Map a `browser_*` tool call to an `agent-browser` argv (excluding the
 * binary path itself). `cfgPath` is the generated provider config JSON;
 * `session` is the agent-browser session id (defaults to `"default"` in the
 * dispatch handler when the tool omits it).
 *
 * `browser_screenshot` requires `_capturePath` (injected by the relay handler).
 * `browser_mouse` is handled separately via {@link agentBrowserMouseClickArgvs}.
 * `browser_scroll` is handled separately via {@link agentBrowserScrollArgvs}.
 */
export function agentBrowserArgv(
  toolName: string,
  args: Record<string, unknown>,
  cfgPath: string,
  session: string,
): string[] {
  return agentBrowserArgvWithPrefix(toolName, args, browserArgvPrefix(cfgPath, session));
}

/**
 * Map the existing semantic browser controls for a server-owned CDP session.
 *
 * This intentionally emits neither `--cdp`, `--provider`, nor a config path.
 * `agent-browser` reads the validated CDP capability from `AGENT_BROWSER_CDP`;
 * putting a bearer URL in argv would expose it in process inspection and logs.
 */
export function agentBrowserCdpArgv(
  toolName: string,
  args: Record<string, unknown>,
  session: string,
): string[] {
  return agentBrowserArgvWithPrefix(toolName, args, browserCdpArgvPrefix(session));
}

function agentBrowserArgvWithPrefix(
  toolName: string,
  args: Record<string, unknown>,
  prefix: readonly string[],
): string[] {
  switch (toolName) {
    case "browser_snapshot":
      return [...prefix, "snapshot"];
    case "browser_click": {
      const ref = normalizeBrowserRef(requireStringArg(args, "ref", toolName));
      return [...prefix, "click", ref];
    }
    case "browser_type": {
      const ref = normalizeBrowserRef(requireStringArg(args, "ref", toolName));
      const text = requireStringArg(args, "text", toolName);
      const verb = args["clear"] === true ? "fill" : "type";
      return [...prefix, verb, ref, text];
    }
    case "browser_press": {
      const key = requireStringArg(args, "key", toolName);
      return [...prefix, "press", key];
    }
    case "browser_back":
      return [...prefix, "back"];
    case "browser_open":
      return [...prefix, "open", requireHttpUrlArg(args, toolName)];
    case "browser_forward":
      return [...prefix, "forward"];
    case "browser_reload":
      return [...prefix, "reload"];
    case "browser_hover": {
      const ref = normalizeBrowserRef(requireStringArg(args, "ref", toolName));
      return [...prefix, "hover", ref];
    }
    case "browser_double_click": {
      const ref = normalizeBrowserRef(requireStringArg(args, "ref", toolName));
      return [...prefix, "dblclick", ref];
    }
    case "browser_drag": {
      const from = normalizeBrowserRef(requireStringArg(args, "from", toolName));
      const to = normalizeBrowserRef(requireStringArg(args, "to", toolName));
      return [...prefix, "drag", from, to];
    }
    case "browser_select": {
      const ref = normalizeBrowserRef(requireStringArg(args, "ref", toolName));
      const values = args["values"];
      if (
        !Array.isArray(values) ||
        values.length === 0 ||
        values.some((value) => typeof value !== "string" || value.length === 0)
      ) {
        throw new Error(`${toolName} requires a non-empty string array \`values\``);
      }
      return [...prefix, "select", ref, ...(values as string[])];
    }
    case "browser_set_checked": {
      const ref = normalizeBrowserRef(requireStringArg(args, "ref", toolName));
      const checked = args["checked"];
      if (typeof checked !== "boolean") {
        throw new Error(`${toolName} requires a boolean \`checked\` argument`);
      }
      return [...prefix, checked ? "check" : "uncheck", ref];
    }
    case "browser_scroll_into_view": {
      const ref = normalizeBrowserRef(requireStringArg(args, "ref", toolName));
      return [...prefix, "scrollintoview", ref];
    }
    case "browser_wait": {
      const ref = args["ref"];
      const milliseconds = args["milliseconds"];
      const hasRef = typeof ref === "string" && ref.length > 0;
      const hasMilliseconds =
        typeof milliseconds === "number" &&
        Number.isInteger(milliseconds) &&
        milliseconds >= 0 &&
        milliseconds <= 30_000;
      if (hasRef === hasMilliseconds) {
        throw new Error(
          `${toolName} requires exactly one of a non-empty \`ref\` or integer \`milliseconds\` from 0 to 30000`,
        );
      }
      return hasRef
        ? [...prefix, "is", "visible", normalizeBrowserRef(ref)]
        : [...prefix, "wait", String(milliseconds)];
    }
    case "browser_read": {
      const ref = normalizeBrowserRef(requireStringArg(args, "ref", toolName));
      return [...prefix, "get", "text", ref];
    }
    case "browser_screenshot": {
      const capturePath = requireStringArg(args, "_capturePath", toolName);
      return [...prefix, "screenshot", capturePath];
    }
    case "browser_get": {
      const what = requireStringArg(args, "what", toolName);
      if (!BROWSER_GET_WHAT.has(what)) {
        throw new Error(
          `${toolName} requires \`what\` to be one of: box, value, attr, html, title, url`,
        );
      }
      const argv: string[] = [...prefix, "get", what];
      const ref = args["ref"];
      if (typeof ref === "string" && ref.length > 0) {
        argv.push(normalizeBrowserRef(ref));
      }
      const name = args["name"];
      if (typeof name === "string" && name.length > 0) {
        argv.push(name);
      }
      return argv;
    }
    default:
      throw new Error(`Unknown browser tool: ${toolName}`);
  }
}

/**
 * Trusted coordinate click: move → down → up (agent-browser has no single click verb).
 */
export function agentBrowserMouseClickArgvs(
  cfgPath: string,
  session: string,
  x: number,
  y: number,
): readonly [string[], string[], string[]] {
  const prefix = browserArgvPrefix(cfgPath, session);
  return [
    [...prefix, "mouse", "move", String(x), String(y)],
    [...prefix, "mouse", "down", "left"],
    [...prefix, "mouse", "up", "left"],
  ];
}

const BROWSER_SCROLL_DIRECTIONS = new Set(["up", "down", "left", "right"]);

/**
 * Wheel-based scroll for canvas apps (e.g. Google Docs) whose content scrolls
 * inside an internal container — window `scroll` is a no-op there.
 *
 * Primary path (`up`/`down`): move to viewport center then emit a vertical
 * CDP mouse-wheel event via `mouse wheel <deltaY>`.
 *
 * Horizontal (`left`/`right`) falls back to legacy `scroll <dir> <amount>` —
 * agent-browser wheel is vertical-only in the primary argv shape we use; horizontal
 * scroll support is limited.
 */
export function agentBrowserScrollArgvs(
  cfgPath: string,
  session: string,
  direction: string,
  amount: number,
  centerX: number,
  centerY: number,
): string[][] {
  if (!BROWSER_SCROLL_DIRECTIONS.has(direction)) {
    throw new Error(
      `browser_scroll requires \`direction\` to be one of: up, down, left, right`,
    );
  }
  const prefix = browserArgvPrefix(cfgPath, session);
  if (direction === "left" || direction === "right") {
    return [[...prefix, "scroll", direction, String(amount)]];
  }
  const delta = direction === "up" ? -amount : amount;
  return [
    [...prefix, "mouse", "move", String(centerX), String(centerY)],
    [...prefix, "mouse", "wheel", String(delta)],
  ];
}
