/**
 * Stack-3 — opt-in happy-dom DOM bootstrap for `bun:test` suites.
 *
 * IMPORTANT: This file is NOT a global preload. Tests that need a
 * DOM (anything using `@testing-library/react`, `renderHook`, or
 * `document` access) MUST import it explicitly at the top of the
 * file. Importing the module triggers the `reapplyHappyDomGlobals()`
 * side effect at the bottom and installs `window` / `document` /
 * `localStorage` / etc. on `globalThis`.
 *
 * Why opt-in instead of global preload:
 *   - Globally setting `window` made every `typeof window !== "undefined"`
 *     guard activate in pre-existing SSR tests. Concrete failures we
 *     hit when the preload was wired into bunfig.toml:
 *       - `tests/unit/sign-in-dialog-layout.test.tsx` —
 *         `LogtoProvider` `useMemo` calls `localStorage` once `window`
 *         is defined; SSR test couldn't survive even with localStorage
 *         polyfilled because subsequent guards expanded.
 *       - `tests/unit/docx-viewer.test.ts` — sanitizer chooses the
 *         DOMPurify path when `typeof window !== "undefined"`;
 *         DOMPurify+happy-dom doesn't strip `<iframe>` correctly.
 *       - `tests/unit/room-tab-strip.test.tsx` — `createPortal` tries
 *         to mount when `document` exists, hitting React SSR's
 *         "Portals are not currently supported" guard.
 *   - All three tests pass on `main` (no preload) and pass under
 *     stack-3 once we revert to opt-in.
 */
import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost/" });

declare global {
  // eslint-disable-next-line no-var
  var __NAUTILO_HAPPY_DOM_WINDOW__: Window | undefined;
}

/** Re-attach happy-dom globals after `mock.restore()` or other test teardown that clears them. */
export function reapplyHappyDomGlobals(): void {
  win.document.body.replaceChildren();
  globalThis.__NAUTILO_HAPPY_DOM_WINDOW__ = win;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).window = win;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).document = win.document;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).navigator = win.navigator;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).HTMLElement = win.HTMLElement;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).Text = win.Text;
  // Keep DOM events in the same realm as the installed window. Happy DOM 20
  // enforces the browser's realm check when EventTarget.dispatchEvent runs.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).Event = win.Event;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).CustomEvent = win.CustomEvent;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).EventTarget = win.EventTarget;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).customElements = win.customElements;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).MutationObserver = win.MutationObserver;
  // Lexical reads computed styles while attaching a contenteditable root.
  // Browser environments expose this on both `window` and the global scope.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).getComputedStyle = win.getComputedStyle.bind(win);
  // Storage + location — Logto's provider (and many auth SDKs) probe
  // `localStorage` inside a useMemo; without these, sign-in-dialog
  // SSR tests throw "ReferenceError: localStorage is not defined" the
  // moment happy-dom installs `window` (because the Logto guard is
  // `typeof window !== 'undefined'`, which now resolves to true).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).localStorage = win.localStorage;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).sessionStorage = win.sessionStorage;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).location = win.location;
}

reapplyHappyDomGlobals();
