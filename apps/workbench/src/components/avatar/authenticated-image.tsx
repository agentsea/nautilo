/**
 * D300 follow-up — single authenticated-avatar fetch + cache for the workbench.
 *
 * Every avatar served by Nautilo's media routes (`/api/rooms/:id/agents/:id/avatar`,
 * `/api/users/:id/avatar`, `/api/profile/avatar`) is **Bearer-auth gated** — a
 * plain `<img src>` sends no `Authorization` header and 401s. Before this module
 * the workbench had four divergent ways to deal with that: the members panel and
 * `UserAvatar` each fetched-then-blob'd with their own cache, `profile-context`
 * did its own fetch, and the transcript bubble used a raw `<img>` (which broke
 * for room-scoped agent avatars). This centralizes the fetch + object-URL cache
 * so there is exactly one implementation.
 *
 * Contract:
 *  - `fetchAvatarObjectUrl(src, token)` — the one fetch+Bearer→blob primitive.
 *    Detects the server SHELL fallback (an inline SVG) and reports it as a
 *    distinct `shell` result so callers render initials instead of the glyph.
 *  - `useAuthenticatedImage(src)` — URL-keyed object-URL cache + inflight dedupe
 *    + `blob:`/`data:` passthrough (the viewer-profile fallback src is already a
 *    renderable URL) + `nautilo:user-avatar-changed` invalidation.
 *  - `<AuthenticatedAvatar src fallback />` — renders the resolved `<img>` or the
 *    caller's fallback node (initials) while loading / on shell / on failure.
 *
 * Versioned agent avatar URLs carry `?v=<blobId>` (content-addressed), so an
 * avatar change yields a new URL → a fresh cache key automatically; only the
 * unversioned `/api/users/:id/avatar` needs the explicit invalidation event.
 */

import {
  useEffect,
  useReducer,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { workbenchFetch } from "../../lib/admission-fetch";
import { apiClient } from "../../lib/api";

/** The server SHELL fallback SVG carries this aria-label; used to detect it. */
const SHELL_DETECT_BYTES = "Genie shell avatar";

export type AvatarFetchResult =
  | { kind: "image"; objectUrl: string }
  | { kind: "shell" }
  | { kind: "none" };

const objectUrlCache = new Map<string, string>();
const inflight = new Map<string, Promise<AvatarFetchResult>>();
const subscribers = new Set<() => void>();
let listenersInstalled = false;

function isDirectlyRenderable(src: string): boolean {
  return src.startsWith("blob:") || src.startsWith("data:");
}

/**
 * The single fetch+Bearer→blob→object-URL primitive. Returns a `shell` result
 * when the server served its SHELL fallback so callers can render initials.
 * Never throws — network/auth failures collapse to `{ kind: "none" }`.
 */
export async function fetchAvatarObjectUrl(
  src: string,
  token: string | null,
): Promise<AvatarFetchResult> {
  if (!token) return { kind: "none" };
  try {
    const res = await workbenchFetch(src, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return { kind: "none" };
    const blob = await res.blob();
    if (blob.type.startsWith("image/svg")) {
      const text = await blob.text();
      if (text.includes(SHELL_DETECT_BYTES)) return { kind: "shell" };
      return {
        kind: "image",
        objectUrl: URL.createObjectURL(new Blob([text], { type: "image/svg+xml" })),
      };
    }
    return { kind: "image", objectUrl: URL.createObjectURL(blob) };
  } catch {
    return { kind: "none" };
  }
}

async function resolveToken(): Promise<string | null> {
  const provider = apiClient.getTokenProvider();
  return provider ? await provider() : apiClient.getToken();
}

/** Drop cached object URLs whose key contains `substr`, then re-render subscribers. */
function invalidateBySubstring(substr: string): void {
  for (const [key, url] of objectUrlCache) {
    if (key.includes(substr)) {
      URL.revokeObjectURL(url);
      objectUrlCache.delete(key);
    }
  }
  for (const notify of subscribers) notify();
}

function ensureGlobalListeners(): void {
  if (listenersInstalled || typeof window === "undefined") return;
  listenersInstalled = true;
  // D206 — a user avatar change invalidates that user's (unversioned) URL.
  window.addEventListener("nautilo:user-avatar-changed", (ev: Event) => {
    const userId = (ev as CustomEvent<{ userId?: string }>).detail?.userId;
    invalidateBySubstring(
      userId ? `/users/${encodeURIComponent(userId)}/avatar` : "/users/",
    );
  });
}

export interface AvatarResolution {
  objectUrl: string | null;
  isShell: boolean;
  loading: boolean;
}

function initialResolution(
  src: string | null | undefined,
  direct: string | null,
): AvatarResolution {
  if (!src) return { objectUrl: null, isShell: false, loading: false };
  if (direct) return { objectUrl: direct, isShell: false, loading: false };
  const cached = objectUrlCache.get(src);
  return { objectUrl: cached ?? null, isShell: false, loading: cached == null };
}

/**
 * Resolve an auth-gated avatar `src` to a renderable object URL. `blob:`/`data:`
 * sources pass through unchanged (no fetch). Results are cached by URL and
 * deduped across concurrent callers; a `nautilo:user-avatar-changed` event
 * invalidates the matching entry.
 */
export function useAuthenticatedImage(src: string | null | undefined): AvatarResolution {
  const direct = src && isDirectlyRenderable(src) ? src : null;
  const [tick, force] = useReducer((n: number) => n + 1, 0);
  const [state, setState] = useState<AvatarResolution>(() =>
    initialResolution(src, direct),
  );

  useEffect(() => {
    ensureGlobalListeners();
    subscribers.add(force);
    return () => {
      subscribers.delete(force);
    };
  }, [force]);

  useEffect(() => {
    if (!src) {
      setState({ objectUrl: null, isShell: false, loading: false });
      return;
    }
    if (direct) {
      setState({ objectUrl: direct, isShell: false, loading: false });
      return;
    }
    const cached = objectUrlCache.get(src);
    if (cached) {
      setState({ objectUrl: cached, isShell: false, loading: false });
      return;
    }

    setState({ objectUrl: null, isShell: false, loading: true });
    let cancelled = false;
    const existing = inflight.get(src);
    const promise =
      existing ??
      (async () => {
        const token = await resolveToken();
        const result = await fetchAvatarObjectUrl(src, token);
        if (result.kind === "image") objectUrlCache.set(src, result.objectUrl);
        return result;
      })();
    if (!existing) inflight.set(src, promise);

    void promise.then((result) => {
      inflight.delete(src);
      if (cancelled) return;
      if (result.kind === "image") {
        setState({ objectUrl: result.objectUrl, isShell: false, loading: false });
      } else if (result.kind === "shell") {
        setState({ objectUrl: null, isShell: true, loading: false });
      } else {
        setState({ objectUrl: null, isShell: false, loading: false });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [src, direct, tick]);

  return state;
}

/**
 * Drop-in authenticated avatar `<img>`. Renders `fallback` (typically initials)
 * while loading, when the server served SHELL, or on any fetch failure.
 */
export function AuthenticatedAvatar({
  src,
  alt,
  fallback,
  className,
}: {
  readonly src: string | null | undefined;
  readonly alt: string;
  readonly fallback: ReactNode;
  readonly className?: string;
}): ReactElement {
  const { objectUrl } = useAuthenticatedImage(src);
  if (!objectUrl) return <>{fallback}</>;
  return (
    <img
      src={objectUrl}
      alt={alt}
      className={className ?? "h-full w-full object-cover"}
      loading="lazy"
    />
  );
}
