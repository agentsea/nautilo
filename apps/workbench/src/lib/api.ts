import { NautiloApiClient } from "@nautilo/api-client/browser";
import { workbenchFetch } from "./admission-fetch";

/**
 * Singleton API client for the workbench. Uses relative URLs — post-M167
 * the server always serves the SPA single-origin (UI + API + WS share one
 * origin) in every mode, so there is no separate API host.
 */
export const apiClient = new NautiloApiClient("", { fetchImpl: workbenchFetch });

function websocketUrl(): string {
  if (typeof window === "undefined") return "";
  return (
    (window.location.protocol === "https:" ? "wss://" : "ws://") +
    window.location.host +
    "/ws"
  );
}

/**
 * WebSocket URL. SSR-safe (and Bun-test-safe): `useAuth` now
 * imports `apiClient` from this module, so any test that
 * transitively pulls `useAuth` would otherwise fail on
 * module-load with `ReferenceError: window is not defined`.
 * Returns `""` in non-browser contexts; only the browser runtime
 * ever consumes the value.
 */
export const WS_URL: string = websocketUrl();
