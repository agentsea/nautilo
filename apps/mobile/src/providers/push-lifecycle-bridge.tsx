/**
 * Bridges authoritative registry/auth changes into the one D468 lifecycle
 * trigger. It owns no AppState listener and never calls an API client itself.
 *
 * The verified owner id reaches this component only after AuthProvider has
 * persisted it to the per-server SecureStore bundle. That makes the follow-up
 * registration run safe after cold hydration, sign-in, and account switching.
 */
import { useEffect, useMemo, useRef } from "react";

import { pushLifecycleBridgeKey } from "@/lib/push-lifecycle-bridge-key";
import { useAuth } from "@/providers/auth";
import { usePushLifecycle } from "@/providers/push-lifecycle";
import { useServers } from "@/providers/server-registry";

/**
 * This must stay a descendant of both AuthProvider and PushLifecycleProvider.
 * It intentionally schedules one shared coalesced call rather than installing
 * another native listener for auth or registry changes.
 */
export function PushLifecycleBridge() {
  const { servers, activeServer } = useServers();
  const { status, viewer, viewerState } = useAuth();
  const { reconcile } = usePushLifecycle();
  const key = useMemo(() => pushLifecycleBridgeKey({
    registry: servers,
    activeServerId: activeServer?.id ?? null,
    authStatus: status,
    viewerState,
    verifiedUserId: viewerState === "verified" ? viewer?.userId ?? null : null,
  }), [servers, activeServer?.id, status, viewerState, viewer?.userId]);
  const previousKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (previousKeyRef.current === key) return;
    previousKeyRef.current = key;
    void reconcile().catch(() => {});
  }, [key, reconcile]);

  return null;
}
