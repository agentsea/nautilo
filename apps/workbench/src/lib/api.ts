import { NautiloApiClient, saveArtifactToDisk } from "@nautilo/api-client/browser";
import { workbenchFetch } from "./admission-fetch";
import { withLiveSessionCleanup } from "./live-session-fetch";

/**
 * Singleton API client for the workbench. Uses relative URLs because
 * the server always serves the SPA single-origin (UI + API + WS share one
 * origin) in every mode, so there is no separate API host.
 */
class WorkbenchApiClient extends NautiloApiClient {
  override async downloadArtifact(id: string, filename: string, opts?: { roomId?: string }): Promise<void> {
    const original = await this.getWorkspaceArtifactBytes(id, opts);
    const { prepareArtifactDownload } = await import("./artifact-download");
    await saveArtifactToDisk(await prepareArtifactDownload(original, filename), filename);
  }
}

export const apiClient = new WorkbenchApiClient("", { fetchImpl: withLiveSessionCleanup(workbenchFetch) });

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
