import {
  remoteHostPresenceEventSchema,
  remoteHostSnapshotEventSchema,
  type RemoteHost,
} from "@nautilo/api-client/browser";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useAuth } from "@/providers/auth";
import { useRealtime } from "@/providers/realtime";
import { useServers } from "@/providers/server-registry";
import {
  loadActiveComputer,
  resolveActiveComputer,
  saveActiveComputer,
} from "./active-computer";
import { getControllerDeviceLabel } from "./controller-device-label-runtime";
import { prepareRemoteOrdinaryRequestProof } from "./controller-ordinary-proof";
import {
  consumeRemoteManualPairing,
  consumeRemoteQrPairing,
  remoteErrorMessage,
  runSameServerRemoteRequest,
  type RemoteServerTarget,
} from "./remote-api";
import {
  createRemoteHostState,
  reduceRemoteHostState,
  type RemoteHostAction,
  type RemoteHostState,
} from "./remote-host-state";

export type RemoteOperationResult =
  | { ok: true }
  | { ok: false; message: string };

interface RemoteHostsValue {
  readonly server: RemoteServerTarget | null;
  readonly hosts: readonly RemoteHost[];
  readonly phoneLabel: string;
  readonly loading: boolean;
  readonly error: string | null;
  readonly activeHostId: string | null;
  readonly setActiveHost: (remoteHostId: string) => Promise<void>;
  readonly refresh: () => Promise<void>;
  readonly pairQr: (input: {
    challengeId: string;
    secret: string;
    ceremonyContext: string;
  }) => Promise<RemoteOperationResult>;
  readonly pairManual: (
    manualCode: string,
  ) => Promise<RemoteOperationResult>;
  readonly renamePhone: (label: string) => Promise<RemoteOperationResult>;
  readonly revoke: (
    remoteHostId: string,
  ) => Promise<RemoteOperationResult>;
}

const RemoteHostsContext = createContext<RemoteHostsValue | null>(null);

export function RemoteHostsProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { activeServer } = useServers();
  const { status } = useAuth();
  const { openRevision, recoveryRevision, send, subscribe } = useRealtime();
  const target = useMemo<RemoteServerTarget | null>(
    () =>
      activeServer
        ? {
            id: activeServer.id,
            serverUrl: activeServer.serverUrl,
            displayName: activeServer.displayName,
          }
        : null,
    [activeServer],
  );
  const targetRef = useRef(target);
  targetRef.current = target;
  const [hostState, setHostState] = useState<RemoteHostState>(() =>
    createRemoteHostState(target?.id ?? ""),
  );
  const hostStateRef = useRef(hostState);
  hostStateRef.current = hostState;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [controllerLabel, setControllerLabel] = useState<string | null>(null);
  const [activeHostId, setActiveHostId] = useState<string | null>(null);
  const [activePreferenceServerId, setActivePreferenceServerId] = useState<string | null>(null);
  const allowedHostIdsRef = useRef<Set<string> | null>(null);

  const apply = useCallback(
    (action: RemoteHostAction): RemoteHostState => {
      const next = reduceRemoteHostState(hostStateRef.current, action);
      hostStateRef.current = next;
      setHostState(next);
      return next;
    },
    [],
  );

  const refreshTarget = useCallback(
    async (captured: RemoteServerTarget): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const mobileOriginProof = await prepareRemoteOrdinaryRequestProof({
          serverId: captured.id,
          method: "GET",
          path: "/api/remote/hosts",
          body: null,
        });
        if (!mobileOriginProof) {
          if (targetRef.current?.id !== captured.id) return;
          allowedHostIdsRef.current = new Set();
          setControllerLabel(null);
          apply({
            type: "snapshot",
            serverId: captured.id,
            snapshot: {
              hosts: [],
              cursor: {
                streamId: `unpaired:${captured.id}`,
                sequence: 0,
                snapshotRevision: 0,
              },
            },
          });
          return;
        }
        const snapshot = await runSameServerRemoteRequest(captured, (client) =>
          client.listRemoteHosts({ mobileOriginProof }),
        );
        if (targetRef.current?.id !== captured.id) return;
        allowedHostIdsRef.current = new Set(
          snapshot.hosts.map((host) => host.remoteHostId),
        );
        setControllerLabel(snapshot.controllerLabel);
        apply({ type: "snapshot", serverId: captured.id, snapshot });
      } catch (caught) {
        if (targetRef.current?.id !== captured.id) return;
        setError(remoteErrorMessage(caught, captured.displayName));
      } finally {
        if (targetRef.current?.id === captured.id) setLoading(false);
      }
    },
    [apply],
  );

  const refresh = useCallback(async () => {
    const captured = targetRef.current;
    if (!captured || status !== "signed-in") return;
    await refreshTarget(captured);
  }, [refreshTarget, status]);

  useEffect(() => {
    const serverId = target?.id ?? "";
    const reset = createRemoteHostState(serverId);
    hostStateRef.current = reset;
    setHostState(reset);
    setError(null);
    setLoading(false);
    setControllerLabel(null);
    allowedHostIdsRef.current = null;
    setActiveHostId(null);
    setActivePreferenceServerId(null);
    if (target) {
      void loadActiveComputer(target.id).then((stored) => {
        if (targetRef.current?.id !== target.id) return;
        setActiveHostId(stored);
        setActivePreferenceServerId(target.id);
      }).catch(() => {
        if (targetRef.current?.id !== target.id) return;
        setActivePreferenceServerId(target.id);
      });
    }
    if (target && status === "signed-in") void refreshTarget(target);
  }, [target, status, refreshTarget]);

  useEffect(() => {
    if (!target || activePreferenceServerId !== target.id) return;
    const resolved = resolveActiveComputer(
      activeHostId,
      hostState.hosts.map((host) => host.remoteHostId),
    );
    if (resolved === activeHostId) return;
    setActiveHostId(resolved);
    void saveActiveComputer(target.id, resolved).catch(() => {});
  }, [activeHostId, activePreferenceServerId, hostState.hosts, target]);

  const setActiveHost = useCallback(async (remoteHostId: string): Promise<void> => {
    const captured = targetRef.current;
    if (!captured) return;
    await saveActiveComputer(captured.id, remoteHostId);
    if (targetRef.current?.id === captured.id) setActiveHostId(remoteHostId);
  }, []);

  useEffect(
    () =>
      subscribe((rawEvent) => {
        const captured = targetRef.current;
        if (!captured) return;
        const snapshot = remoteHostSnapshotEventSchema.safeParse(rawEvent);
        const presence = remoteHostPresenceEventSchema.safeParse(rawEvent);
        const allowedHostIds = allowedHostIdsRef.current;
        if (allowedHostIds === null) return;
        const event = snapshot.success
          ? {
              ...snapshot.data,
              hosts: snapshot.data.hosts.filter((host) =>
                allowedHostIds.has(host.remoteHostId),
              ),
            }
          : presence.success
            ? presence.data
            : null;
        if (!event) return;
        const previous = hostStateRef.current;
        const next = apply({
          type: "event",
          serverId: captured.id,
          event,
          includeHost:
            event.type === "remote.host.snapshot" ||
            allowedHostIds.has(event.remoteHostId),
        });
        if (!previous.needsResume && next.needsResume) {
          send({ type: "remote.host.resume", cursor: next.cursor });
        }
      }),
    [apply, send, subscribe],
  );

  useEffect(() => {
    if (openRevision === 0 || !target || status !== "signed-in") return;
    // Resume the live suffix on every successful open. The scope effect owns
    // the initial REST snapshot; a separate reconnect effect catches up after
    // a real transport gap.
    send({
      type: "remote.host.resume",
      cursor:
        hostStateRef.current.serverId === target.id
          ? hostStateRef.current.cursor
          : null,
    });
  }, [openRevision, target, status, send]);

  useEffect(() => {
    if (recoveryRevision === 0 || !target || status !== "signed-in") return;
    void refreshTarget(target);
  }, [recoveryRevision, target, status, refreshTarget]);

  const pairQr = useCallback<RemoteHostsValue["pairQr"]>(
    async (input) => {
      const captured = targetRef.current;
      if (!captured) return { ok: false, message: "Select a server first." };
      try {
        const response = await consumeRemoteQrPairing(captured, input);
        if (targetRef.current?.id === captured.id) await refreshTarget(captured);
        await saveActiveComputer(captured.id, response.bindingId);
        if (targetRef.current?.id === captured.id) setActiveHostId(response.bindingId);
        return { ok: true };
      } catch (caught) {
        return {
          ok: false,
          message: remoteErrorMessage(caught, captured.displayName),
        };
      }
    },
    [refreshTarget],
  );

  const pairManual = useCallback<RemoteHostsValue["pairManual"]>(
    async (manualCode) => {
      const captured = targetRef.current;
      if (!captured) return { ok: false, message: "Select a server first." };
      try {
        const response = await consumeRemoteManualPairing(captured, manualCode);
        if (targetRef.current?.id === captured.id) await refreshTarget(captured);
        await saveActiveComputer(captured.id, response.bindingId);
        if (targetRef.current?.id === captured.id) setActiveHostId(response.bindingId);
        return { ok: true };
      } catch (caught) {
        return {
          ok: false,
          message: remoteErrorMessage(caught, captured.displayName),
        };
      }
    },
    [refreshTarget],
  );

  const renamePhone = useCallback<RemoteHostsValue["renamePhone"]>(
    async (label) => {
      const captured = targetRef.current;
      if (!captured) return { ok: false, message: "Select a server first." };
      const bindingId = hostStateRef.current.hosts[0]?.remoteHostId;
      if (!bindingId) return { ok: false, message: "Pair this phone first." };
      try {
        await runSameServerRemoteRequest(captured, (client) =>
          client.renameRemoteController(bindingId, { label }),
        );
        if (targetRef.current?.id === captured.id) await refreshTarget(captured);
        return { ok: true };
      } catch (caught) {
        return {
          ok: false,
          message: remoteErrorMessage(caught, captured.displayName),
        };
      }
    },
    [refreshTarget],
  );

  const revoke = useCallback<RemoteHostsValue["revoke"]>(
    async (remoteHostId) => {
      const captured = targetRef.current;
      if (!captured) return { ok: false, message: "Select a server first." };
      try {
        await runSameServerRemoteRequest(captured, (client) =>
          client.revokeRemoteController(remoteHostId),
        );
        if (targetRef.current?.id === captured.id) await refreshTarget(captured);
        return { ok: true };
      } catch (caught) {
        return {
          ok: false,
          message: remoteErrorMessage(caught, captured.displayName),
        };
      }
    },
    [refreshTarget],
  );

  const value = useMemo<RemoteHostsValue>(
    () => ({
      server: target,
      hosts: hostState.hosts,
      phoneLabel: controllerLabel ?? getControllerDeviceLabel(),
      loading,
      error,
      activeHostId,
      setActiveHost,
      refresh,
      pairQr,
      pairManual,
      renamePhone,
      revoke,
    }),
    [
      target,
      hostState.hosts,
      controllerLabel,
      loading,
      error,
      activeHostId,
      setActiveHost,
      refresh,
      pairQr,
      pairManual,
      renamePhone,
      revoke,
    ],
  );

  return (
    <RemoteHostsContext.Provider value={value}>
      {children}
    </RemoteHostsContext.Provider>
  );
}

export function useRemoteHosts(): RemoteHostsValue {
  const value = useContext(RemoteHostsContext);
  if (!value) {
    throw new Error("useRemoteHosts must be used within RemoteHostsProvider");
  }
  return value;
}
