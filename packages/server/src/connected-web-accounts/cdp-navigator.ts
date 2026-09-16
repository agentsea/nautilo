import { WebSocket } from "ws";
import type { ConnectedWebAccountNavigator } from "./controller";

const CDP_DISCOVERY_RESPONSE_MAX_CHARS = 16_384;

export interface BrowserUseCdpDiscoveryFetch {
  (input: string | URL, init: RequestInit): Promise<Response>;
}

export interface BrowserUseCdpNavigatorDependencies {
  readonly fetch?: BrowserUseCdpDiscoveryFetch;
  readonly createSocket?: (url: string) => WebSocket;
}

export interface BrowserUseCdpTargetDependencies {
  readonly createSocket?: (url: string) => WebSocket;
}

function expectedCdpHostname(hostname: string): boolean {
  const suffix = ".cdp.browser-use.com";
  const capabilityLabel = hostname.endsWith(suffix)
    ? hostname.slice(0, -suffix.length)
    : "";
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(capabilityLabel);
}

/** Resolve Browser Use's HTTPS CDP discovery capability without exposing it. */
export async function resolveBrowserUseCdpWebSocketUrl(
  cdpUrl: string,
  timeoutMs: number,
  fetchImpl: BrowserUseCdpDiscoveryFetch = globalThis.fetch.bind(globalThis),
): Promise<string> {
  let capability: URL;
  try { capability = new URL(cdpUrl); } catch { throw new Error("navigation unavailable"); }
  if (capability.protocol !== "https:"
    || !expectedCdpHostname(capability.hostname)
    || capability.port.length > 0
    || capability.username.length > 0
    || capability.password.length > 0
    || capability.hash.length > 0) {
    throw new Error("navigation unavailable");
  }

  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(new URL("/json/version", capability), {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("navigation unavailable");
    const raw = await response.text();
    if (raw.length === 0 || raw.length > CDP_DISCOVERY_RESPONSE_MAX_CHARS) throw new Error("navigation unavailable");
    const body = JSON.parse(raw) as { webSocketDebuggerUrl?: unknown };
    if (typeof body.webSocketDebuggerUrl !== "string") throw new Error("navigation unavailable");
    const websocket = new URL(body.webSocketDebuggerUrl);
    if (websocket.protocol !== "wss:"
      || websocket.hostname !== capability.hostname
      || websocket.port.length > 0
      || websocket.username.length > 0
      || websocket.password.length > 0
      || websocket.hash.length > 0) {
      throw new Error("navigation unavailable");
    }
    return websocket.toString();
  } catch {
    throw new Error("navigation unavailable");
  } finally {
    clearTimeout(deadline);
  }
}

async function resolveBrowserUseCdpSocket(
  cdpUrl: string,
  timeoutMs: number,
  fetchImpl: BrowserUseCdpDiscoveryFetch,
): Promise<{ readonly websocketUrl: string; readonly remainingMs: number }> {
  const startedAt = Date.now();
  const websocketUrl = await resolveBrowserUseCdpWebSocketUrl(cdpUrl, timeoutMs, fetchImpl);
  const remainingMs = timeoutMs - (Date.now() - startedAt);
  if (remainingMs <= 0) throw new Error("navigation unavailable");
  return { websocketUrl, remainingMs };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pageTargetId(value: unknown): string | null {
  if (!isRecord(value) || !Array.isArray(value["targetInfos"])) return null;
  const pages = value["targetInfos"].filter((target): target is Record<string, unknown> =>
    isRecord(target) && target["type"] === "page" && typeof target["targetId"] === "string" && target["targetId"].length > 0,
  );
  const target = pages.find((page) => page["url"] === "about:blank") ?? pages[0];
  return typeof target?.["targetId"] === "string" ? target["targetId"] : null;
}

function sessionId(value: unknown): string | null {
  return isRecord(value) && typeof value["sessionId"] === "string" && value["sessionId"].length > 0
    ? value["sessionId"]
    : null;
}

function pageTargets(value: unknown): readonly { readonly targetId: string }[] {
  if (!isRecord(value) || !Array.isArray(value["targetInfos"])) return [];
  return value["targetInfos"].flatMap((target) =>
    isRecord(target)
      && target["type"] === "page"
      && typeof target["targetId"] === "string"
      && target["targetId"].length > 0
      ? [{ targetId: target["targetId"] }]
      : [],
  );
}

const SIGN_IN_INSPECTION_EXPRESSION = `(() => {
  const visible = document.visibilityState === "visible";
  const elementIsVisible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const visibleMatch = (selector) => Array.from(document.querySelectorAll(selector)).some(elementIsVisible);
  const actionText = Array.from(document.querySelectorAll("button, a, input[type=submit], input[type=button], [role=button]"))
    .filter(elementIsVisible)
    .map((element) => String(element.innerText || element.value || element.getAttribute("aria-label") || "").trim().toLowerCase());
  const hasSignOut = actionText.some((text) => /^(?:sign out|log out|logout)$/u.test(text));
  const hasSignInAction = actionText.some((text) => /^(?:sign in|log in|login|use (?:a )?passkey|continue with .+|sign in with .+|log in with .+)$/u.test(text));
  const authPath = /\\/(?:login|log-in|signin|sign-in|auth|sso)(?:\\/|$)/iu.test(location.pathname);
  const credentialInput = visibleMatch('input[type="password"], input[autocomplete="current-password"], input[autocomplete="one-time-code"]');
  const challengeFrame = Array.from(document.querySelectorAll("iframe"))
    .filter(elementIsVisible)
    .some((frame) => /(?:captcha|recaptcha|hcaptcha|turnstile|challenge)/iu.test(String(frame.title || frame.getAttribute("src") || "")));
  return {
    visible,
    atExpectedOrigin: location.origin === ${JSON.stringify("__NAUTILO_EXPECTED_ORIGIN__")},
    authenticationRequired: !hasSignOut && (credentialInput || challengeFrame || hasSignInAction || authPath),
  };
})()`;

interface SignInPageInspection {
  readonly visible: boolean;
  readonly atExpectedOrigin: boolean;
  readonly authenticationRequired: boolean;
}

function signInPageInspection(value: unknown): SignInPageInspection | null {
  if (!isRecord(value) || !isRecord(value["result"]) || !isRecord(value["result"]["value"])) return null;
  const inspection = value["result"]["value"];
  return typeof inspection["visible"] === "boolean"
    && typeof inspection["atExpectedOrigin"] === "boolean"
    && typeof inspection["authenticationRequired"] === "boolean"
    ? {
        visible: inspection["visible"],
        atExpectedOrigin: inspection["atExpectedOrigin"],
        authenticationRequired: inspection["authenticationRequired"],
      }
    : null;
}

/**
 * Browser Use starts each direct-control browser with an initial page. Reuse
 * that page, matching the provider's documented `pages[0].goto(...)` flow,
 * instead of creating a second tab while the live viewer remains on blank.
 */
export async function navigateBrowserUseCdpPage(
  cdpUrl: string,
  targetUrl: string,
  timeoutMs: number,
  dependencies: BrowserUseCdpNavigatorDependencies = {},
): Promise<void> {
  const { websocketUrl, remainingMs } = await resolveBrowserUseCdpSocket(
    cdpUrl,
    timeoutMs,
    dependencies.fetch ?? globalThis.fetch.bind(globalThis),
  );
  await navigateExistingPage(
    websocketUrl,
    targetUrl,
    remainingMs,
    dependencies.createSocket ?? ((url) => new WebSocket(url)),
  );
}

/**
 * Deliberately one-shot navigation used only to land the Human in the target
 * site. It is not an automation loop and closes before any credentials exist.
 */
export const browserUseCdpNavigator: ConnectedWebAccountNavigator = {
  async navigate({ cdpUrl, targetUrl, timeoutMs }) {
    await navigateBrowserUseCdpPage(cdpUrl, targetUrl, timeoutMs);
  },
  async verifySignIn({ cdpUrl, origin, timeoutMs }) {
    return verifyBrowserUseCdpSignIn(cdpUrl, origin, timeoutMs);
  },
};

/**
 * Inspect only boolean page state at the Human's Done boundary. No DOM text,
 * input values, cookies, storage, URLs, or provider coordinates leave this
 * server-side check.
 */
export async function verifyBrowserUseCdpSignIn(
  cdpUrl: string,
  origin: string,
  timeoutMs: number,
  dependencies: BrowserUseCdpNavigatorDependencies = {},
): Promise<{ readonly atExpectedOrigin: boolean; readonly authenticationRequired: boolean }> {
  let expectedOrigin: URL;
  try { expectedOrigin = new URL(origin); } catch { throw new Error("navigation unavailable"); }
  if (expectedOrigin.origin !== origin || (expectedOrigin.protocol !== "https:" && expectedOrigin.protocol !== "http:")) {
    throw new Error("navigation unavailable");
  }
  const { websocketUrl, remainingMs } = await resolveBrowserUseCdpSocket(
    cdpUrl,
    timeoutMs,
    dependencies.fetch ?? globalThis.fetch.bind(globalThis),
  );
  return inspectVisibleSignInPage(
    websocketUrl,
    origin,
    remainingMs,
    dependencies.createSocket ?? ((url) => new WebSocket(url)),
  );
}

function inspectVisibleSignInPage(
  websocketUrl: string,
  origin: string,
  timeoutMs: number,
  createSocket: (url: string) => WebSocket,
): Promise<{ readonly atExpectedOrigin: boolean; readonly authenticationRequired: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = createSocket(websocketUrl);
    let settled = false;
    let nextId = 0;
    let pending: {
      readonly id: number;
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: Error) => void;
    } | null = null;

    const finish = (
      error?: Error,
      result?: { readonly atExpectedOrigin: boolean; readonly authenticationRequired: boolean },
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const active = pending;
      pending = null;
      if (error) active?.reject(error);
      socket.close();
      if (error || result === undefined) reject(error ?? new Error("navigation unavailable"));
      else resolve(result);
    };
    const timeout = setTimeout(() => finish(new Error("navigation unavailable")), timeoutMs);
    const command = (
      method: string,
      params?: Record<string, unknown>,
      commandSessionId?: string,
    ): Promise<unknown> => new Promise((commandResolve, commandReject) => {
      if (settled || pending !== null) {
        commandReject(new Error("navigation unavailable"));
        return;
      }
      const id = ++nextId;
      pending = { id, resolve: commandResolve, reject: commandReject };
      socket.send(JSON.stringify({ id, method, ...(params ? { params } : {}), ...(commandSessionId ? { sessionId: commandSessionId } : {}) }), (error) => {
        if (!error) return;
        const active = pending;
        pending = null;
        active?.reject(new Error("navigation unavailable"));
      });
    });

    socket.once("error", () => finish(new Error("navigation unavailable")));
    socket.once("open", () => {
      void (async () => {
        const targets = pageTargets(await command("Target.getTargets"));
        if (targets.length === 0) throw new Error("navigation unavailable");
        const inspections: SignInPageInspection[] = [];
        for (const target of targets) {
          const attached = await command("Target.attachToTarget", { targetId: target.targetId, flatten: true });
          const attachedSessionId = sessionId(attached);
          if (attachedSessionId === null) throw new Error("navigation unavailable");
          const evaluated = await command("Runtime.evaluate", {
            expression: SIGN_IN_INSPECTION_EXPRESSION.replace(
              JSON.stringify("__NAUTILO_EXPECTED_ORIGIN__"),
              JSON.stringify(origin),
            ),
            returnByValue: true,
            awaitPromise: false,
          }, attachedSessionId);
          const inspection = signInPageInspection(evaluated);
          if (inspection === null) throw new Error("navigation unavailable");
          inspections.push(inspection);
        }
        const visiblePages = inspections.filter((inspection) => inspection.visible);
        if (visiblePages.length !== 1) throw new Error("navigation unavailable");
        const visible = visiblePages[0]!;
        finish(undefined, {
          atExpectedOrigin: visible.atExpectedOrigin,
          authenticationRequired: visible.authenticationRequired,
        });
      })().catch(() => finish(new Error("navigation unavailable")));
    });
    socket.on("message", (data) => {
      try {
        const raw = typeof data === "string"
          ? data
          : Buffer.isBuffer(data)
            ? data.toString("utf8")
            : Array.isArray(data)
              ? Buffer.concat(data).toString("utf8")
              : Buffer.from(data).toString("utf8");
        const message = JSON.parse(raw) as { id?: unknown; error?: unknown; result?: unknown };
        if (pending === null || message.id !== pending.id) return;
        const active = pending;
        pending = null;
        if (message.error === undefined) active.resolve(message.result);
        else active.reject(new Error("navigation unavailable"));
      } catch { finish(new Error("navigation unavailable")); }
    });
  });
}

function navigateExistingPage(
  websocketUrl: string,
  targetUrl: string,
  timeoutMs: number,
  createSocket: (url: string) => WebSocket,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = createSocket(websocketUrl);
    let settled = false;
    let nextId = 0;
    let pending: {
      readonly id: number;
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: Error) => void;
    } | null = null;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const active = pending;
      pending = null;
      if (error) active?.reject(error);
      socket.close();
      if (error) reject(error); else resolve();
    };
    const timeout = setTimeout(() => finish(new Error("navigation unavailable")), timeoutMs);
    const command = (
      method: string,
      params?: Record<string, unknown>,
      commandSessionId?: string,
    ): Promise<unknown> => new Promise<unknown>((commandResolve, commandReject) => {
      if (settled || pending !== null) {
        commandReject(new Error("navigation unavailable"));
        return;
      }
      const id = ++nextId;
      pending = { id, resolve: commandResolve, reject: commandReject };
      socket.send(JSON.stringify({ id, method, ...(params ? { params } : {}), ...(commandSessionId ? { sessionId: commandSessionId } : {}) }), (error) => {
        if (!error) return;
        const active = pending;
        pending = null;
        active?.reject(new Error("navigation unavailable"));
      });
    });

    socket.once("error", () => finish(new Error("navigation unavailable")));
    socket.once("open", () => {
      void (async () => {
        const targets = await command("Target.getTargets");
        const targetId = pageTargetId(targets);
        if (targetId === null) throw new Error("navigation unavailable");
        const attached = await command("Target.attachToTarget", { targetId, flatten: true });
        const attachedSessionId = sessionId(attached);
        if (attachedSessionId === null) throw new Error("navigation unavailable");
        const navigation = await command("Page.navigate", { url: targetUrl }, attachedSessionId);
        if (isRecord(navigation) && typeof navigation["errorText"] === "string" && navigation["errorText"].length > 0) {
          throw new Error("navigation unavailable");
        }
        await command("Page.bringToFront", undefined, attachedSessionId);
        await command("Target.activateTarget", { targetId });
        finish();
      })().catch(() => finish(new Error("navigation unavailable")));
    });
    socket.on("message", (data) => {
      try {
        const raw = typeof data === "string"
          ? data
          : Buffer.isBuffer(data)
            ? data.toString("utf8")
            : Array.isArray(data)
              ? Buffer.concat(data).toString("utf8")
              : Buffer.from(data).toString("utf8");
        const message = JSON.parse(raw) as { id?: unknown; error?: unknown; result?: unknown };
        if (pending === null || message.id !== pending.id) return;
        const active = pending;
        pending = null;
        if (message.error === undefined) active.resolve(message.result);
        else active.reject(new Error("navigation unavailable"));
      } catch { finish(new Error("navigation unavailable")); }
    });
  });
}

/**
 * Resolve the one page target that is already at the connected account's
 * durable origin.  Target identifiers and the browser WebSocket are retained
 * only by the server-side direct-control bootstrap; neither is projected to a
 * Genie or an HTTP client.
 */
export async function findSingleBrowserUsePageTargetAtOrigin(
  websocketUrl: string,
  origin: string,
  timeoutMs: number,
  dependencies: BrowserUseCdpTargetDependencies = {},
): Promise<string> {
  let websocket: URL;
  let allowedOrigin: URL;
  try {
    websocket = new URL(websocketUrl);
    allowedOrigin = new URL(origin);
  } catch {
    throw new Error("navigation unavailable");
  }
  if (websocket.protocol !== "wss:"
    || !expectedCdpHostname(websocket.hostname)
    || websocket.port.length > 0
    || websocket.username.length > 0
    || websocket.password.length > 0
    || websocket.hash.length > 0
    || allowedOrigin.origin !== origin
    || (allowedOrigin.protocol !== "https:" && allowedOrigin.protocol !== "http:")) {
    throw new Error("navigation unavailable");
  }
  const result = await sendCdpWithSocket(
    websocket.toString(),
    { id: 1, method: "Target.getTargets" },
    timeoutMs,
    dependencies.createSocket ?? ((url) => new WebSocket(url)),
  );
  if (!isRecord(result) || !Array.isArray(result["targetInfos"])) {
    throw new Error("navigation unavailable");
  }
  const matches = result["targetInfos"].filter((target): target is Record<string, unknown> => {
    if (!isRecord(target) || target["type"] !== "page"
      || typeof target["targetId"] !== "string" || target["targetId"].length === 0
      || typeof target["url"] !== "string") return false;
    try { return new URL(target["url"]).origin === origin; } catch { return false; }
  });
  if (matches.length !== 1) throw new Error("navigation unavailable");
  return matches[0]!["targetId"] as string;
}

function sendCdpWithSocket(
  cdpUrl: string,
  command: Record<string, unknown>,
  timeoutMs: number,
  createSocket: (url: string) => WebSocket,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const socket = createSocket(cdpUrl);
    let settled = false;
    const finish = (error?: Error, result?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      if (error) reject(error); else resolve(result);
    };
    const timeout = setTimeout(() => finish(new Error("navigation unavailable")), timeoutMs);
    socket.once("error", () => finish(new Error("navigation unavailable")));
    socket.once("open", () => {
      socket.send(JSON.stringify(command), (error) => {
        if (error) finish(new Error("navigation unavailable"));
      });
    });
    socket.on("message", (data) => {
      try {
        const raw = typeof data === "string"
          ? data
          : Buffer.isBuffer(data)
            ? data.toString("utf8")
            : Array.isArray(data)
              ? Buffer.concat(data).toString("utf8")
              : Buffer.from(data).toString("utf8");
        const message = JSON.parse(raw) as { id?: unknown; error?: unknown; result?: unknown };
        if (message.id !== command["id"]) return;
        finish(message.error === undefined ? undefined : new Error("navigation unavailable"), message.result);
      } catch { finish(new Error("navigation unavailable")); }
    });
  });
}
