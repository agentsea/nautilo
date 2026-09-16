// D369 Phase 1 — ServerRegistryProvider: the app's multi-server state.
// Holds paired servers + the active one; probes + persists via server-store;
// binds the api-client to the active server. Auth (tokens) lands in Phase 2.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { getApiClient, probeServer } from "@/lib/api";
import {
  activateInviteServer as activateExactInviteServer,
  resolveInviteServer as resolveExactInviteServer,
  type ActivateInviteServerInput,
  type InviteServerActivation,
  type InviteServerResolution,
  type ResolveInviteServerInput,
} from "@/features/invite-redemption/invite-server-resolution";
import { clearViewerCache } from "@/lib/viewer-cache";
import { clearInboundShareReceiptForServer } from "@/lib/inbound-share-custody";
import { clearPendingShareForServer } from "@/lib/pending-share";
import {
  loadRegistry,
  removeServer as removeServerRecord,
  serverIdFromUrl,
  setActiveServer,
  upsertServer,
  type ServerRecord,
} from "@/lib/server-store";

interface ServerRegistryValue {
  servers: ServerRecord[];
  activeServer: ServerRecord | null;
  loading: boolean;
  /** Probe + add a server by URL; returns error string on failure, null on success. */
  addServer: (rawUrl: string) => Promise<string | null>;
  switchTo: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** Exact-origin invite orchestration. It never previews or accepts a bearer. */
  resolveInviteServer: (
    input: ResolveInviteServerInput,
    isCurrent: (ref: ResolveInviteServerInput["ref"]) => boolean,
  ) => Promise<InviteServerResolution>;
  activateInviteServer: (
    input: ActivateInviteServerInput,
    isCurrent: (ref: ActivateInviteServerInput["ref"]) => boolean,
  ) => Promise<InviteServerActivation>;
}

const ServerRegistryContext = createContext<ServerRegistryValue | null>(null);

export function ServerRegistryProvider({ children }: { children: React.ReactNode }) {
  const [servers, setServers] = useState<ServerRecord[]>([]);
  const [activeServer, setActive] = useState<ServerRecord | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const reg = await loadRegistry();
    setServers(reg.servers);
    const active = reg.activeId
      ? (reg.servers.find((server) => server.id === reg.activeId) ?? null)
      : null;
    setActive(active);
    if (active) getApiClient(active.serverUrl); // rebind client to active
  }, []);

  useEffect(() => {
    void refresh().finally(() => setLoading(false));
  }, [refresh]);

  const addServer = useCallback<ServerRegistryValue["addServer"]>(
    async (rawUrl) => {
      const probe = await probeServer(rawUrl);
      if (!probe.ok) return probe.error;
      // Persist the origin that actually answered. Keeping the Human's bare
      // input here made later authenticated clients lose the proven scheme.
      await upsertServer({ serverUrl: probe.serverUrl, displayName: probe.displayName });
      await refresh();
      return null;
    },
    [refresh],
  );

  const switchTo = useCallback<ServerRegistryValue["switchTo"]>(
    async (id) => {
      await setActiveServer(id);
      await refresh();
    },
    [refresh],
  );

  const remove = useCallback<ServerRegistryValue["remove"]>(
    async (id) => {
      // Scoped receipts must not remain actionable after their exact server is
      // disconnected. Unclaimed signed-out Shares intentionally remain for
      // their short OAuth recovery window; they contain no server association.
      // SecureStore cleanup is best effort: a keychain outage must not trap a
      // user on a server they explicitly removed. The registry deletion is the
      // authority boundary; normal intake requires a currently registered
      // server and therefore fails closed until stale device custody can be
      // cleared on a later launch.
      await Promise.allSettled([
        clearPendingShareForServer(id),
        clearInboundShareReceiptForServer(id),
      ]);
      await clearViewerCache(id);
      await removeServerRecord(id);
      await refresh();
    },
    [refresh],
  );

  const resolveInviteServer = useCallback<ServerRegistryValue["resolveInviteServer"]>(
    async (input, isCurrent) => resolveExactInviteServer(input, {
      serverIdFromUrl,
      probeServer,
      loadRegistry,
      upsertServer,
      setActiveServer,
      refresh,
      isCurrent,
    }),
    [refresh],
  );

  const activateInviteServer = useCallback<ServerRegistryValue["activateInviteServer"]>(
    async (input, isCurrent) => activateExactInviteServer(input, {
      serverIdFromUrl,
      probeServer,
      loadRegistry,
      upsertServer,
      setActiveServer,
      refresh,
      isCurrent,
    }),
    [refresh],
  );

  const value = useMemo<ServerRegistryValue>(
    () => ({
      servers,
      activeServer,
      loading,
      addServer,
      switchTo,
      remove,
      resolveInviteServer,
      activateInviteServer,
    }),
    [servers, activeServer, loading, addServer, switchTo, remove, resolveInviteServer, activateInviteServer],
  );

  return (
    <ServerRegistryContext.Provider value={value}>{children}</ServerRegistryContext.Provider>
  );
}

export function useServers(): ServerRegistryValue {
  const ctx = useContext(ServerRegistryContext);
  if (!ctx) throw new Error("useServers must be used within ServerRegistryProvider");
  return ctx;
}
