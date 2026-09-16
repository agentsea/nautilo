/**
 * Pure helper extracted from `first-run/index.tsx` so it can be unit-tested
 * without instantiating the React entrypoint (which calls `document.getElementById`
 * at module scope and is therefore not importable from `bun:test`).
 *
 * Maps the discriminated `UrlProbeFailReason` union from `electron/preflight.ts`
 * to a short human-readable string the picker renders inline next to the URL
 * input. Kept here (not in `electron/preflight.ts`) because the renderer bundle
 * is loaded under a strict CSP and we don't want to drag the main-process
 * preflight module into the renderer just to share the type names.
 */

export type UrlProbeFailReason =
  | "invalid-url"
  | "timeout"
  | "network-error"
  | "tls-error"
  | "bad-status"
  | "not-nautilo";

export function humanizeFailReason(r: UrlProbeFailReason): string {
  switch (r) {
    case "invalid-url":
      return "Not a valid URL";
    case "timeout":
      return "Server didn't respond in time";
    case "network-error":
      return "Couldn't reach the server";
    case "tls-error":
      return "TLS/certificate error";
    case "bad-status":
      return "Server returned an unexpected status";
    case "not-nautilo":
      return "Reachable, but this doesn't look like Nautilo";
  }
}
