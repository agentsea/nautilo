import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import {
  activateInviteServer as activateExactInviteServer,
  resolveInviteServer as resolveExactInviteServer,
  type ActivateInviteServerInput,
  type InviteServerActivation,
  type InviteServerResolution,
  type ResolveInviteServerInput,
} from "@/features/invite-redemption/invite-server-resolution";
import { getApiClient, probeServer } from "@/lib/api";
import {
  loadRegistry,
  removeServer as removeServerRecord,
  serverIdFromUrl,
  setActiveServer,
  upsertServer,
  type ServerRecord,
} from "@/lib/server-store.web";

interface ServerRegistryValue {
  servers: ServerRecord[];
  activeServer: ServerRecord | null;
  loading: boolean;
  addServer: (rawUrl: string) => Promise<string | null>;
  switchTo: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
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
    const registry = await loadRegistry();
    setServers([...registry.servers]);
    const active = registry.activeId
      ? registry.servers.find((server) => server.id === registry.activeId) ?? null
      : null;
    setActive(active);
    if (active) getApiClient(active.serverUrl);
  }, []);

  useEffect(() => { void refresh().finally(() => setLoading(false)); }, [refresh]);

  const addServer = useCallback(async (rawUrl: string) => {
    let candidate: URL;
    try { candidate = new URL(rawUrl); } catch { return "Enter a valid server URL."; }
    if (typeof location === "undefined" || candidate.origin !== location.origin) {
      return "Mobile Web connects only to its current serving origin.";
    }
    const probe = await probeServer(candidate.origin);
    if (!probe.ok) return probe.error;
    await upsertServer({ serverUrl: candidate.origin, displayName: probe.displayName });
    await refresh();
    return null;
  }, [refresh]);

  const switchTo = useCallback(async (id: string) => {
    await setActiveServer(id);
    await refresh();
  }, [refresh]);

  const remove = useCallback(async (id: string) => {
    await removeServerRecord(id);
    await refresh();
  }, [refresh]);

  const resolveInviteServer = useCallback<ServerRegistryValue["resolveInviteServer"]>(
    (input, isCurrent) => resolveExactInviteServer(input, {
      serverIdFromUrl, probeServer, loadRegistry, upsertServer, setActiveServer, refresh, isCurrent,
    }),
    [refresh],
  );
  const activateInviteServer = useCallback<ServerRegistryValue["activateInviteServer"]>(
    (input, isCurrent) => activateExactInviteServer(input, {
      serverIdFromUrl, probeServer, loadRegistry, upsertServer, setActiveServer, refresh, isCurrent,
    }),
    [refresh],
  );

  const value = useMemo<ServerRegistryValue>(() => ({
    servers, activeServer, loading, addServer, switchTo, remove,
    resolveInviteServer, activateInviteServer,
  }), [servers, activeServer, loading, addServer, switchTo, remove, resolveInviteServer, activateInviteServer]);

  return <ServerRegistryContext.Provider value={value}>{children}</ServerRegistryContext.Provider>;
}

export function useServers(): ServerRegistryValue {
  const value = useContext(ServerRegistryContext);
  if (!value) throw new Error("useServers must be used within ServerRegistryProvider");
  return value;
}
