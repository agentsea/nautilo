/**
 * Hosted first-owner claims arrive in a URL fragment. Fragments are not sent
 * in HTTP requests, but must still be removed before the route mounts or any
 * client telemetry/navigation observer can see them.
 */
import { HANDLE_RE } from "@nautilo/types";

export const OWNER_CLAIM_STORAGE_KEY = "nautilo.ownerClaimHandoff.v1";

/**
 * A claim capability may request one of Nautilo's two code-owned endings.
 * This is deliberately not a URL: the controller never gets to redirect a
 * browser to an arbitrary destination after it has been trusted with a
 * first-owner capability.
 */
export const OWNER_CLAIM_FINISH_MODES = ["guide", "product"] as const;
export type OwnerClaimFinishMode = (typeof OWNER_CLAIM_FINISH_MODES)[number];

const STRICT_MODE_CAPTURE_WINDOW_MS = 1_000;
// Match the existing canonical mintInviteToken(): 24 random bytes encoded as
// 32 base64url characters after the `inv_` prefix.
const CLAIM_RE = /^inv_[A-Za-z0-9_-]{32}$/;

export interface OwnerClaimHandoff {
  readonly version: 1;
  readonly claim: string;
  readonly finish: OwnerClaimFinishMode;
  readonly state: string;
  readonly handle: string;
  readonly stage: "preview" | "awaiting-signup" | "awaiting-bind" | "profile";
  readonly startedAt: string;
}

export type OwnerClaimFragmentResult =
  | { readonly outcome: "absent" }
  | { readonly outcome: "invalid" }
  | { readonly outcome: "stored" }
  | { readonly outcome: "storage-unavailable" };

/** Minimal browser surface, kept DOM-library-free for cross-package tests. */
export interface OwnerClaimFragmentBrowser {
  readonly location: { readonly hash: string; readonly pathname: string; readonly search: string };
  readonly history: {
    readonly state: unknown;
    replaceState(state: unknown, title: string, url?: string): void;
  };
}

// React development StrictMode may construct the route twice before it
// commits. Fragment capture has to remain synchronous (before effects or
// telemetry), so retain only the redacted outcome briefly for that second
// construction. The capability itself remains exclusively in sessionStorage.
let recentFragmentCapture:
  | { readonly location: string; readonly at: number; readonly result: OwnerClaimFragmentResult }
  | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStage(value: unknown): value is OwnerClaimHandoff["stage"] {
  return value === "preview" || value === "awaiting-signup" || value === "awaiting-bind" || value === "profile";
}

function isOwnerClaimFinishMode(value: unknown): value is OwnerClaimFinishMode {
  return value === "guide" || value === "product";
}

function parse(raw: string): OwnerClaimHandoff | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)
    || parsed["version"] !== 1
    || typeof parsed["claim"] !== "string"
    || !CLAIM_RE.test(parsed["claim"])
    || typeof parsed["state"] !== "string"
    || typeof parsed["handle"] !== "string"
    || !isStage(parsed["stage"])
    || typeof parsed["startedAt"] !== "string"
    // v1 handoffs written before D508 have no finish field. Their safe,
    // deliberate transition default is the Server Guide. A supplied value is
    // strict: unknown values (including URL-shaped values) invalidate the
    // complete handoff rather than silently becoming a redirect mechanism.
    || (parsed["finish"] !== undefined && !isOwnerClaimFinishMode(parsed["finish"]))) {
    return null;
  }
  // Browser retention is not authority to expire or extend a hosted claim.
  // The server evaluates its own expiry at preview/bind/completion; a local
  // timer would create a false expired state after a valid paused setup.
  const startedAt = Date.parse(parsed["startedAt"]);
  if (!Number.isFinite(startedAt)) return null;
  return {
    version: 1,
    claim: parsed["claim"],
    finish: parsed["finish"] === undefined ? "guide" : parsed["finish"],
    state: parsed["state"],
    handle: parsed["handle"],
    stage: parsed["stage"],
    startedAt: parsed["startedAt"],
  };
}

function sessionStore(): Storage | undefined {
  return typeof sessionStorage === "undefined" ? undefined : sessionStorage;
}

function erase(): void {
  try {
    sessionStore()?.removeItem(OWNER_CLAIM_STORAGE_KEY);
  } catch {
    // A blocked browser store means there is no durable handoff to remove.
  }
}

/** Claim state is session-only: no localStorage fallback is permitted. */
export function readOwnerClaimHandoff(): OwnerClaimHandoff | null {
  try {
    const raw = sessionStore()?.getItem(OWNER_CLAIM_STORAGE_KEY);
    if (raw === null || raw === undefined || raw.length === 0) return null;
    const handoff = parse(raw);
    if (handoff === null) erase();
    return handoff;
  } catch {
    return null;
  }
}

export function writeOwnerClaimHandoff(handoff: OwnerClaimHandoff): boolean {
  if (parse(JSON.stringify(handoff)) === null) return false;
  try {
    const storage = sessionStore();
    if (storage === undefined) return false;
    const serialized = JSON.stringify(handoff);
    storage.setItem(OWNER_CLAIM_STORAGE_KEY, serialized);
    return storage.getItem(OWNER_CLAIM_STORAGE_KEY) === serialized;
  } catch {
    return false;
  }
}

export function clearOwnerClaimHandoff(): void {
  recentFragmentCapture = undefined;
  erase();
}

function currentBrowser(): OwnerClaimFragmentBrowser | undefined {
  const browserWindow = (globalThis as {
    window?: { location: OwnerClaimFragmentBrowser["location"]; history: OwnerClaimFragmentBrowser["history"] };
  }).window;
  return browserWindow === undefined ? undefined : browserWindow;
}

/**
 * Parse once, then synchronously remove the complete fragment before storing
 * the claim in sessionStorage. It deliberately never exposes the raw hash to
 * callers, logs, navigation state, or localStorage.
 */
export function consumeOwnerClaimFragment(
  browser = currentBrowser(),
): OwnerClaimFragmentResult {
  if (browser === undefined) return { outcome: "absent" };
  const hash = browser.location.hash;
  const location = `${browser.location.pathname}${browser.location.search}`;
  if (hash.length === 0) {
    if (
      recentFragmentCapture &&
      recentFragmentCapture.location === location &&
      Date.now() - recentFragmentCapture.at <= STRICT_MODE_CAPTURE_WINDOW_MS
    ) {
      return recentFragmentCapture.result;
    }
    return { outcome: "absent" };
  }

  let claim: string | undefined;
  let finish: OwnerClaimFinishMode = "guide";
  let handle = "";
  try {
    const values = new URLSearchParams(hash.slice(1));
    const candidate = values.get("claim");
    const requestedFinish = values.get("finish");
    const requestedHandle = values.get("handle");
    const hasOnlyKnownKeys = Array.from(values.keys()).every(
      (key) => key === "claim" || key === "finish" || key === "handle",
    );
    if (
      candidate !== null
      && values.size >= 1
      && values.size <= 3
      && hasOnlyKnownKeys
      && values.getAll("claim").length === 1
      && values.getAll("finish").length <= 1
      && values.getAll("handle").length <= 1
      && CLAIM_RE.test(candidate)
      && (requestedFinish === null || isOwnerClaimFinishMode(requestedFinish))
      && (requestedHandle === null || HANDLE_RE.test(requestedHandle))
    ) {
      claim = candidate;
      finish = requestedFinish ?? "guide";
      handle = requestedHandle ?? "";
    }
  } catch {
    claim = undefined;
  }

  // Preserve ordinary same-origin pathname/query state, but no hash. Calling
  // replaceState even for malformed values prevents a failed claim from being
  // leaked to subsequent route/telemetry code.
  try {
    browser.history.replaceState(browser.history.state, "", location);
  } catch {
    const result = { outcome: "storage-unavailable" } as const;
    recentFragmentCapture = { location, at: Date.now(), result };
    return result;
  }
  if (claim === undefined) {
    // A malformed fragment must not leave a previous claim available for a
    // later accidental `/claim` visit in this browser session.
    clearOwnerClaimHandoff();
    const result = { outcome: "invalid" } as const;
    recentFragmentCapture = { location, at: Date.now(), result };
    return result;
  }

  const stored = writeOwnerClaimHandoff({
    version: 1,
    claim,
    finish,
    state: "",
    handle,
    stage: "preview",
    startedAt: new Date().toISOString(),
  });
  const result = stored
    ? ({ outcome: "stored" } as const)
    : ({ outcome: "storage-unavailable" } as const);
  recentFragmentCapture = { location, at: Date.now(), result };
  return result;
}
