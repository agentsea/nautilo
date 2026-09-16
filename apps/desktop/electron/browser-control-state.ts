import { createHash } from "node:crypto";

export function browserControlStateHasActiveView(value: unknown): boolean {
  return browserControlStateSessionSource(value) !== null;
}

/** Opaque-session derivation input retained only inside Electron main. */
export function browserControlStateSessionSource(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const state = value as {
    activeAppId?: string | null;
    views?: Array<{ appId?: string; cdpUrl?: string | null }>;
  };
  if (!Array.isArray(state.views)) return null;
  const active =
    state.views.find((view) => view.appId === state.activeAppId) ?? state.views[0];
  if (typeof active?.cdpUrl !== "string" || active.cdpUrl.length === 0) return null;
  return active.cdpUrl;
}

/** Stable opaque identity for the exact published embedded Browser view. */
export function browserControlStateSessionId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const state = value as {
    activeAppId?: string | null;
    views?: Array<{ appId?: string; cdpUrl?: string | null }>;
  };
  const source = browserControlStateSessionSource(state);
  if (source === null || !Array.isArray(state.views)) return null;
  const active = state.views.find((view) => view.appId === state.activeAppId)
    ?? state.views[0];
  const appId = String(active?.appId ?? "app").replace(/[^a-z0-9_-]+/gi, "-");
  const hash = createHash("sha1").update(source).digest("hex").slice(0, 8);
  return `nautilo-${appId}-${hash}`;
}
