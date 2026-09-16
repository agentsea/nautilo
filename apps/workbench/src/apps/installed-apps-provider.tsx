import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { PublicMiniAppDto } from "@nautilo/api-client/browser";
import { useAuth } from "../hooks/use-auth";
import { apiClient } from "../lib/api";

export type InstalledAppsState =
  | { kind: "loading" }
  | { kind: "ready"; apps: PublicMiniAppDto[] }
  | { kind: "error"; message: string };

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const trimmed = raw.trim();
  return trimmed || "Failed to load apps.";
}

function isTransientNetworkError(err: unknown): boolean {
  const message = errorMessage(err).toLowerCase();
  return (
    err instanceof TypeError ||
    message.includes("failed to fetch") ||
    message.includes("network") ||
    message.includes("load failed")
  );
}

const TRANSIENT_RETRY_DELAYS_MS = [500, 1000, 2000, 4000];

interface InstalledAppsContextValue {
  readonly state: InstalledAppsState;
  readonly reload: () => void;
}

export const InstalledAppsContext = createContext<InstalledAppsContextValue | null>(null);

export function InstalledAppsProvider({ children }: { readonly children: ReactNode }) {
  const auth = useAuth();
  const [state, setState] = useState<InstalledAppsState>({ kind: "loading" });
  const [refreshKey, setRefreshKey] = useState(0);
  const fetchSeqRef = useRef(0);
  const cacheRef = useRef<{
    viewerGeneration: number;
    apps: PublicMiniAppDto[] | null;
    etag: string | null;
  }>({
    viewerGeneration: auth.viewerGeneration,
    apps: null,
    etag: null,
  });
  const viewerGenerationRef = useRef(auth.viewerGeneration);
  viewerGenerationRef.current = auth.viewerGeneration;

  const reload = useCallback(() => setRefreshKey((key) => key + 1), []);

  useEffect(() => {
    if (!auth.viewer.isVerified) {
      fetchSeqRef.current += 1;
      cacheRef.current = {
        viewerGeneration: auth.viewerGeneration,
        apps: null,
        etag: null,
      };
      setState({ kind: "loading" });
      return;
    }

    const viewerGeneration = auth.viewerGeneration;
    if (cacheRef.current.viewerGeneration !== viewerGeneration) {
      cacheRef.current = { viewerGeneration, apps: null, etag: null };
    }
    const fetchId = ++fetchSeqRef.current;
    setState({ kind: "loading" });

    let cancelled = false;

    const isStale = (): boolean =>
      cancelled ||
      fetchSeqRef.current !== fetchId ||
      viewerGenerationRef.current !== viewerGeneration;

    void (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          let response = await apiClient.listMiniAppsConditional(
            cacheRef.current.etag
              ? { ifNoneMatch: cacheRef.current.etag }
              : undefined,
          );
          if (isStale()) return;
          if (response.status === 304 && cacheRef.current.apps === null) {
            response = await apiClient.listMiniAppsConditional();
            if (response.status === 304) {
              throw new Error("App list returned 304 without a cached body");
            }
          }
          if (isStale()) return;
          if (response.status === 304) {
            if (response.etag) cacheRef.current.etag = response.etag;
            setState({ kind: "ready", apps: cacheRef.current.apps! });
            return;
          }
          const { apps } = response.body;
          cacheRef.current = {
            viewerGeneration,
            apps,
            etag: response.etag,
          };
          setState({ kind: "ready", apps });
          return;
        } catch (err) {
          const delay = TRANSIENT_RETRY_DELAYS_MS[attempt];
          if (isTransientNetworkError(err) && delay !== undefined) {
            await new Promise((resolve) => setTimeout(resolve, delay));
            if (isStale()) return;
            continue;
          }
          if (isStale()) return;
          setState({ kind: "error", message: errorMessage(err) });
          return;
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [auth.viewer.isVerified, auth.viewerGeneration, refreshKey]);

  const value = useMemo<InstalledAppsContextValue>(
    () => ({ state, reload }),
    [state, reload],
  );

  return (
    <InstalledAppsContext.Provider value={value}>{children}</InstalledAppsContext.Provider>
  );
}
