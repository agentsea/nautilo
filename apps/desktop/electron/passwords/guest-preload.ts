/**
 * D403 (ISSUE-D403) Phase 1 — guest preload for the embedded-browser
 * `<webview>`.
 *
 * This script runs INSIDE the webview guest (a per-partition sandboxed
 * content-script context), which historically had no preload at all — that
 * absence was the blocker for password save/restore. It is wired to the
 * `<webview>` via the `preload` attribute (path surfaced by main → host
 * renderer; see main.ts `passwords:getGuestPreloadPath` + preload.ts
 * `embeddedBrowserGuestPreloadPath`).
 *
 * P0 proved the injection point + channel. P1 (this file) adds real login-form
 * DETECTION: it scans the document for password inputs, normalizes each field
 * into a DOM-free `FieldDescriptor`, runs the pure `detectLoginForm` scorer,
 * computes live `FieldRect`s, assembles a `DetectedLoginForm`, and fires it to
 * main over `passwords:formDetected` (fire-and-forget). It re-scans on DOM
 * mutations and same-document navigation, debounced. There is no UI, no
 * storage, and no autofill here yet (P2/P3).
 *
 * It still exposes NOTHING to the page's main world (contextIsolation-safe: we
 * never touch `window`-as-global via `contextBridge`/the page realm, so the
 * page's main world — and therefore CDP `Runtime.evaluate` / any agent surface
 * — cannot see the password IPC channel). See ipc.ts for the R6 invariant.
 *
 * SECURITY (R6): web credentials are HUMAN-ONLY. This preload may talk to main
 * over `passwords:*` IPC, but it must never surface credentials (or the IPC
 * bridge) to page scripts, and credentials must never enter agent/LLM context.
 * P1 handles only field *shapes* — no credential values are read or sent.
 */

import { ipcRenderer } from "electron";
import { detectLoginForm, type FieldDescriptor } from "./form-detect";
import type {
  ApplyFillCommand,
  DetectedLoginForm,
  FieldRect,
  PasswordLookupRequest,
  PasswordLookupResult,
  StageSaveRequest,
} from "./types";

// -------------------------------------------------------------------------
// Local ambient DOM declarations.
//
// The desktop electron tsconfig deliberately omits the "dom" lib (main/preload
// are Node-typed, and pulling the whole DOM lib clashes with @types/node's
// globals). This preload runs in the guest and touches a handful of browser
// APIs, so we declare *only those* at module scope. Because this file is a
// module (it has imports), these `declare`s are module-scoped and do NOT leak
// DOM globals into the main/node type world — the same scoped posture P0 used,
// just widened to the few extra APIs P1 needs.
// -------------------------------------------------------------------------

interface GuestDomRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface GuestElement {
  readonly tagName: string;
  readonly id: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  getBoundingClientRect(): GuestDomRect;
}

/** An `<input>` we read from (on submit) or write to (on fill). */
interface GuestInputElement extends GuestElement {
  value: string;
  focus(): void;
  dispatchEvent(event: unknown): boolean;
}

/** Minimal shape of the DOM event we inspect for submit-button clicks. */
interface GuestEvent {
  readonly target:
    | { readonly tagName?: string; getAttribute?(name: string): string | null }
    | null;
}

interface GuestMutationObserver {
  observe(target: unknown, options: { childList: boolean; subtree: boolean }): void;
  disconnect(): void;
}

declare const document: {
  readonly readyState: string;
  addEventListener(type: "DOMContentLoaded", listener: () => void): void;
  addEventListener(
    type: "submit" | "click",
    listener: (event: GuestEvent) => void,
    options?: { capture?: boolean },
  ): void;
  querySelectorAll(selectors: string): ArrayLike<GuestElement>;
  querySelector(selectors: string): GuestInputElement | null;
  getElementById(id: string): GuestInputElement | null;
};
declare const location: { readonly origin: string };
declare const window: {
  addEventListener(type: "popstate" | "hashchange", listener: () => void): void;
};
declare const MutationObserver: {
  new (callback: () => void): GuestMutationObserver;
};
declare const Event: {
  new (type: string, options?: { bubbles?: boolean }): object;
};

// -------------------------------------------------------------------------
// P0 channel proof (kept): a typed round-trip to the main-process credential
// service. Real lookups arrive in P3; P1 only detects and reports form shape.
// -------------------------------------------------------------------------

/**
 * The guest preload's `ipcRenderer` lives in the isolated preload world —
 * reachable by our content script but NOT by the page's main world / CDP.
 */
export function lookupCredentials(
  origin: string,
): Promise<PasswordLookupResult> {
  const req: PasswordLookupRequest = { origin };
  return ipcRenderer.invoke("passwords:lookup", req) as Promise<PasswordLookupResult>;
}

// -------------------------------------------------------------------------
// P1 form detection.
// -------------------------------------------------------------------------

/** Channel used to report a detected login form to main. */
const FORM_DETECTED_CHANNEL = "passwords:formDetected";
/** guest→main: stage a submitted credential (carries the password). */
const STAGE_SAVE_CHANNEL = "passwords:stageSave";
/** main→guest: the one-shot fill value to write into the detected fields. */
const APPLY_FILL_CHANNEL = "passwords:applyFill";
/** Debounce window for re-scans triggered by DOM mutations / navigation. */
const RESCAN_DEBOUNCE_MS = 300;
/** Data attribute used to give id-less fields a stable per-page ref. */
const FIELD_REF_ATTR = "data-nautilo-field-id";

let syntheticIdCounter = 0;
let rescanTimer: ReturnType<typeof setTimeout> | undefined;
/** Last payload we emitted, serialized — used to suppress duplicate emits. */
let lastEmittedJson: string | undefined;
/**
 * The most recently detected login form. Remembered so submit capture and the
 * `applyFill` command know which fields to read from / write to. Field *shapes*
 * only — no credential values are stored here.
 */
let lastDetectedForm: DetectedLoginForm | undefined;

/** Stable-per-page ref for an element: its DOM id, else a synthetic data-attr. */
function refFor(el: GuestElement): string {
  if (el.id !== "") return el.id;
  const existing = el.getAttribute(FIELD_REF_ATTR);
  if (existing !== null && existing !== "") return existing;
  syntheticIdCounter += 1;
  const ref = `nautilo-field-${syntheticIdCounter}`;
  el.setAttribute(FIELD_REF_ATTR, ref);
  return ref;
}

/** True if the element occupies layout space (a cheap visibility proxy). */
function isVisible(rect: GuestDomRect): boolean {
  return rect.width > 0 && rect.height > 0;
}

/** Normalize a live `<input>` into a DOM-free descriptor for the pure scorer. */
function describeField(el: GuestElement, rect: GuestDomRect): FieldDescriptor {
  return {
    fieldId: refFor(el),
    tag: el.tagName.toLowerCase(),
    type: (el.getAttribute("type") ?? "").toLowerCase(),
    autocomplete: (el.getAttribute("autocomplete") ?? "").toLowerCase(),
    name: el.getAttribute("name") ?? "",
    id: el.getAttribute("id") ?? "",
    isVisible: isVisible(rect),
  };
}

function toFieldRect(rect: GuestDomRect): FieldRect {
  return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
}

/**
 * Scan the document, run the pure scorer, and — if a login form is detected —
 * emit a `DetectedLoginForm` to main. Fire-and-forget; the main-side handler is
 * a later phase's job. Deduplicates identical consecutive detections.
 */
function scanAndReport(): void {
  const elements = Array.from(document.querySelectorAll("input"));
  const rectByFieldId = new Map<string, GuestDomRect>();
  const descriptors: FieldDescriptor[] = [];

  for (const el of elements) {
    const rect = el.getBoundingClientRect();
    const descriptor = describeField(el, rect);
    descriptors.push(descriptor);
    rectByFieldId.set(descriptor.fieldId, rect);
  }

  const detection = detectLoginForm(descriptors);
  if (!detection.isLoginForm || detection.passwordFieldId === undefined) {
    return;
  }

  // Rects are ordered [username?, password] so overlay placement (P3) has a
  // deterministic index for each detected field.
  const rects: FieldRect[] = [];
  if (detection.usernameFieldId !== undefined) {
    const usernameRect = rectByFieldId.get(detection.usernameFieldId);
    if (usernameRect !== undefined) rects.push(toFieldRect(usernameRect));
  }
  const passwordRect = rectByFieldId.get(detection.passwordFieldId);
  if (passwordRect !== undefined) rects.push(toFieldRect(passwordRect));

  const form: DetectedLoginForm = {
    formId: `nautilo-login:${detection.passwordFieldId}`,
    passwordFieldId: detection.passwordFieldId,
    frameOrigin: location.origin,
    rects,
  };
  if (detection.usernameFieldId !== undefined) {
    form.usernameFieldId = detection.usernameFieldId;
  }

  // Remember the live form (field refs) for submit-capture and applyFill, even
  // when the emit below is deduped — the refs are what those paths need.
  lastDetectedForm = form;

  const json = JSON.stringify(form);
  if (json === lastEmittedJson) return;
  lastEmittedJson = json;

  ipcRenderer.send(FORM_DETECTED_CHANNEL, form);
}

// -------------------------------------------------------------------------
// P3 save/autofill loop.
//
// SECURITY (R6): the password flows guest ⇄ main ONLY. On submit we read the
// field values and hand them to main via `stageSave`; on `applyFill` main hands
// us a single value which we write into the detected fields. Neither path
// exposes anything to the page's main world or the host renderer.
// -------------------------------------------------------------------------

/** Locate a live field by its stable ref (DOM id first, else synthetic attr). */
function findFieldByRef(ref: string): GuestInputElement | null {
  const byId = document.getElementById(ref);
  if (byId) return byId;
  return document.querySelector(`[${FIELD_REF_ATTR}="${ref}"]`);
}

/**
 * Read the current username/password from the last detected form and stage them
 * with main. No-op unless there's a detected form with a non-empty password
 * (so unrelated button clicks never stage anything).
 */
function stageFromDetectedForm(): void {
  const form = lastDetectedForm;
  if (!form) return;
  const passwordEl = findFieldByRef(form.passwordFieldId);
  if (!passwordEl) return;
  const password = passwordEl.value ?? "";
  if (password === "") return;

  let username = "";
  if (form.usernameFieldId !== undefined) {
    const userEl = findFieldByRef(form.usernameFieldId);
    if (userEl) username = userEl.value ?? "";
  }

  const req: StageSaveRequest = { origin: location.origin, username, password };
  void (ipcRenderer.invoke(STAGE_SAVE_CHANNEL, req) as Promise<unknown>).catch(
    () => {
      /* main rejects only non-human senders; guest is always allowed */
    },
  );
}

/** Write a value into a field and fire input/change so the page registers it. */
function writeField(el: GuestInputElement, value: string): void {
  el.value = value;
  try {
    el.focus();
  } catch {
    /* focus is best-effort */
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Apply a one-shot fill delivered by main into the last detected form. */
function applyFill(cmd: ApplyFillCommand): void {
  const form = lastDetectedForm;
  if (!form) return;
  if (form.usernameFieldId !== undefined && cmd.username !== "") {
    const userEl = findFieldByRef(form.usernameFieldId);
    if (userEl) writeField(userEl, cmd.username);
  }
  const passwordEl = findFieldByRef(form.passwordFieldId);
  if (passwordEl) writeField(passwordEl, cmd.password);
}

/** True for controls that submit a form (real submit or a default button). */
function isSubmitLike(target: GuestEvent["target"]): boolean {
  if (!target) return false;
  const tag = (target.tagName ?? "").toLowerCase();
  const type = (target.getAttribute?.("type") ?? "").toLowerCase();
  if (type === "submit") return true;
  // A <button> with no explicit type defaults to submit inside a form.
  return tag === "button" && type !== "button";
}

/** Debounced re-scan for DOM mutations and same-document navigation. */
function scheduleRescan(): void {
  if (rescanTimer !== undefined) clearTimeout(rescanTimer);
  rescanTimer = setTimeout(scanAndReport, RESCAN_DEBOUNCE_MS);
}

function onReady(): void {
  console.debug("[nautilo-passwords] guest preload active for", location.origin);

  scanAndReport();

  // Re-scan when the DOM changes (SPA route swaps, late-mounted forms, modals).
  // childList+subtree only — we intentionally do NOT observe attributes, so the
  // synthetic-ref `setAttribute` in `refFor` cannot feed back into this loop.
  const observer = new MutationObserver(scheduleRescan);
  observer.observe(document, { childList: true, subtree: true });

  // Same-document navigation (history API / hash) doesn't reload the preload.
  window.addEventListener("popstate", scheduleRescan);
  window.addEventListener("hashchange", scheduleRescan);

  // Capture credential submission. `submit` covers <form> logins (incl. Enter);
  // the capture-phase `click` fallback covers submit buttons on non-<form>
  // logins. Both no-op unless a detected form has a filled password field.
  document.addEventListener("submit", () => stageFromDetectedForm(), {
    capture: true,
  });
  document.addEventListener(
    "click",
    (event) => {
      if (isSubmitLike(event.target)) stageFromDetectedForm();
    },
    { capture: true },
  );

  // main → guest: write the one-shot fill value into the detected fields.
  ipcRenderer.on(APPLY_FILL_CHANNEL, (_e, cmd: ApplyFillCommand) => {
    applyFill(cmd);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", onReady);
} else {
  onReady();
}
