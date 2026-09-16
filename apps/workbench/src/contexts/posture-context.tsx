import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { SecurityPostureResponse } from "@nautilo/api-client/browser";
import { apiClient } from "../lib/api";
import { useAuth } from "../hooks/use-auth";
import {
  addAuthTransitionListener,
  shouldIgnoreCredentialOnlyTransition,
} from "../lib/auth-transition";

export type SecurityPosture = SecurityPostureResponse;

export interface PostureContextValue {
  readonly posture: SecurityPosture | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
}

const PostureContext = createContext<PostureContextValue | null>(null);

export function PostureProvider({ children }: { readonly children: ReactNode }) {
  const auth = useAuth();
  const [posture, setPosture] = useState<SecurityPosture | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshInflightRef = useRef<Promise<void> | null>(null);
  const lastProcessedViewerGenerationRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    if (!auth.viewer.isVerified) {
      setPosture(null);
      setError(null);
      setLoading(false);
      return;
    }
    if (refreshInflightRef.current) return refreshInflightRef.current;
    const run = async (): Promise<void> => {
      const token = await auth.session.getAccessToken();
      if (!token) {
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const next = await apiClient.getSecurityPosture();
        setPosture(next);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    };
    const promise = run().finally(() => {
      if (refreshInflightRef.current === promise) refreshInflightRef.current = null;
    });
    refreshInflightRef.current = promise;
    return promise;
  }, [auth.session, auth.viewer.isVerified]);

  useEffect(() => {
    if (!auth.viewer.isVerified) {
      setPosture(null);
      setError(null);
      setLoading(false);
      return;
    }
    void refresh();
  }, [auth.viewer.isVerified, auth.viewerGeneration, refresh]);

  useEffect(() => {
    const onPolicyChanged = (): void => {
      void refresh();
    };
    window.addEventListener("nautilo:policy-changed", onPolicyChanged);
    return () => window.removeEventListener("nautilo:policy-changed", onPolicyChanged);
  }, [refresh]);

  useEffect(() => {
    const removeAuthListener = addAuthTransitionListener((detail) => {
      if (
        shouldIgnoreCredentialOnlyTransition(
          lastProcessedViewerGenerationRef.current,
          detail,
        )
      ) {
        return;
      }
      lastProcessedViewerGenerationRef.current = detail.viewerGeneration;
      void refresh();
    });
    return removeAuthListener;
  }, [refresh]);

  const value = useMemo<PostureContextValue>(
    () => ({ posture, loading, error, refresh }),
    [posture, loading, error, refresh],
  );

  return <PostureContext.Provider value={value}>{children}</PostureContext.Provider>;
}

export function usePosture(): PostureContextValue {
  const ctx = useContext(PostureContext);
  if (!ctx) throw new Error("usePosture must be used within <PostureProvider>");
  return ctx;
}
