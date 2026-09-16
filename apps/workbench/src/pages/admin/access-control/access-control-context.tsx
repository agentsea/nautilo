import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { AccessControlCatalogue } from "@nautilo/api-client";
import type { CapabilitySlug } from "@nautilo/types";
import { useCan } from "../../../hooks/use-can";
import { apiClient } from "../../../lib/api";

type AccessControlContextValue = {
  catalogue: AccessControlCatalogue | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  canDelegate: (capability: string) => boolean;
};

const AccessControlContext = createContext<AccessControlContextValue | null>(null);

export function AccessControlProvider({ children }: { children: React.ReactNode }) {
  const can = useCan();
  const [catalogue, setCatalogue] = useState<AccessControlCatalogue | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setCatalogue(await apiClient.admin.accessControl.getCatalogue());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load the access-control catalogue.");
    } finally {
      setLoading(false);
    }
  }, []);

  const value = useMemo(() => ({
    catalogue,
    loading,
    error,
    refresh,
    canDelegate: (capability: string) => can(capability as CapabilitySlug),
  }), [catalogue, error, loading, refresh, can]);

  return <AccessControlContext.Provider value={value}>{children}</AccessControlContext.Provider>;
}

export function useAccessControl() {
  const value = useContext(AccessControlContext);
  if (!value) throw new Error("useAccessControl must be used within AccessControlProvider");
  return value;
}
