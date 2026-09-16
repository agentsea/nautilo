import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { RemoteHost } from "@nautilo/api-client/browser";

export type RemoteOperationResult = { ok: true } | { ok: false; message: string };

interface RemoteHostsValue {
  readonly server: null;
  readonly hosts: readonly RemoteHost[];
  readonly phoneLabel: string;
  readonly loading: false;
  readonly error: null;
  readonly activeHostId: null;
  readonly setActiveHost: (_remoteHostId: string) => Promise<void>;
  readonly refresh: () => Promise<void>;
  readonly pairQr: (_input: { challengeId: string; secret: string; ceremonyContext: string }) => Promise<RemoteOperationResult>;
  readonly pairManual: (_manualCode: string) => Promise<RemoteOperationResult>;
  readonly renamePhone: (_label: string) => Promise<RemoteOperationResult>;
  readonly revoke: (_remoteHostId: string) => Promise<RemoteOperationResult>;
}

const unavailable = (): RemoteOperationResult => ({
  ok: false,
  message: "Computer control requires the installed Nautilo Mobile app.",
});
const RemoteHostsContext = createContext<RemoteHostsValue | null>(null);

export function RemoteHostsProvider({ children }: { readonly children: ReactNode }) {
  const value = useMemo<RemoteHostsValue>(() => ({
    server: null, hosts: [], phoneLabel: "Browser", loading: false, error: null, activeHostId: null,
    setActiveHost: () => Promise.resolve(), refresh: () => Promise.resolve(), pairQr: () => Promise.resolve(unavailable()),
    pairManual: () => Promise.resolve(unavailable()), renamePhone: () => Promise.resolve(unavailable()), revoke: () => Promise.resolve(unavailable()),
  }), []);
  return <RemoteHostsContext.Provider value={value}>{children}</RemoteHostsContext.Provider>;
}

export function useRemoteHosts(): RemoteHostsValue {
  const value = useContext(RemoteHostsContext);
  if (!value) throw new Error("useRemoteHosts must be used within RemoteHostsProvider");
  return value;
}
