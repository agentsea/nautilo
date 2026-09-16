import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import type {
  ArtifactDto,
  WorkspaceArtifactEvent,
} from "@nautilo/api-client/browser";
import { useRoomNavigation } from "../contexts/room-navigation-context";
import { useAuth } from "../hooks/use-auth";
import { isAuthenticatedHumanViewer } from "../hooks/viewer-authentication";
import { apiClient } from "../lib/api";
import { desktopAPI } from "../lib/desktop";
import { finalizeLocalArtifactSaveMutationEvent } from "../editors/local-artifact-save-mutations";
import {
  isWorkspaceArtifactCommittedMutation,
  workspaceArtifactEventClientMutationId,
  workspaceArtifactEventId,
  workspaceArtifactEventPath,
} from "./workspace-document-mutation-events";

const RECONCILE_DEBOUNCE_MS = 125;
const RECONCILE_MAX_WAIT_MS = 750;
const VISIBILITY_STALE_MS = 30_000;

interface ArtifactState {
  readonly scopeKey: string | null;
  readonly byId: ReadonlyMap<string, ArtifactDto>;
  readonly orderedIds: readonly string[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly successfulListVersion: number;
  readonly lastSuccessfulAt: number | null;
}

export interface WorkspaceArtifactsValue {
  readonly roomId: string | null;
  readonly artifacts: ArtifactDto[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: (reason?: string) => void;
  readonly reconcile: (reason: string) => void;
  readonly updateArtifacts: Dispatch<SetStateAction<ArtifactDto[]>>;
  readonly upsertArtifact: (artifact: ArtifactDto) => void;
  readonly removeArtifacts: (ids: ReadonlySet<string>) => void;
}

interface EventSubscriptionOptions {
  readonly artifactId?: string;
  readonly roomId?: string;
  readonly onReconnect?: () => void | Promise<void>;
}

type ArtifactEventSubscriber = {
  readonly handler: (event: WorkspaceArtifactEvent) => void | Promise<void>;
  readonly artifactId?: string;
  readonly roomId?: string;
  readonly onReconnect?: () => void | Promise<void>;
};

interface WorkspaceArtifactEventHub {
  readonly subscribe: (
    handler: (event: WorkspaceArtifactEvent) => void | Promise<void>,
    options?: EventSubscriptionOptions,
  ) => () => void;
}

const WorkspaceArtifactsContext = createContext<WorkspaceArtifactsValue | null>(null);
const WorkspaceArtifactEventHubContext = createContext<WorkspaceArtifactEventHub | null>(null);

function normalizedState(
  scopeKey: string,
  artifacts: readonly ArtifactDto[],
  previous: ArtifactState,
): ArtifactState {
  const sorted = [...artifacts].sort((left, right) =>
    left.path.localeCompare(right.path, undefined, { sensitivity: "base" }),
  );
  return {
    scopeKey,
    byId: new Map(sorted.map((artifact) => [artifact.id, artifact])),
    orderedIds: sorted.map((artifact) => artifact.id),
    loading: false,
    error: null,
    successfulListVersion: previous.successfulListVersion + 1,
    lastSuccessfulAt: Date.now(),
  };
}

function emptyState(scopeKey: string | null, loading: boolean): ArtifactState {
  return {
    scopeKey,
    byId: new Map(),
    orderedIds: [],
    loading,
    error: null,
    successfulListVersion: 0,
    lastSuccessfulAt: null,
  };
}

function messageForError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() || "Failed to load workspace artifacts.";
}

export function WorkspaceArtifactsProvider({ children }: { readonly children: ReactNode }) {
  const auth = useAuth();
  const { activeRoomId } = useRoomNavigation();
  const roomId = isAuthenticatedHumanViewer(auth.viewer) && activeRoomId
    ? activeRoomId
    : null;
  // The full-room query is the only canonical shared view today. Keep its
  // material dimensions in the key so a future prefix/limit view cannot alias it.
  const scopeKey =
    roomId === null
      ? null
      : `${auth.viewerGeneration}\u0000${roomId}\u0000pathPrefix=\u0000limit=`;
  const [state, setState] = useState<ArtifactState>(() => emptyState(scopeKey, scopeKey !== null));
  const [refreshVersion, setRefreshVersion] = useState(0);
  const currentScopeRef = useRef(scopeKey);
  useLayoutEffect(() => {
    currentScopeRef.current = scopeKey;
  }, [scopeKey]);
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);
  const subscribersRef = useRef(new Set<ArtifactEventSubscriber>());
  const seenCommittedEventsRef = useRef(new Set<string>());
  const conditionalRef = useRef<{ scopeKey: string | null; etag: string | null }>({
    scopeKey,
    etag: null,
  });
  const fetchSerialRef = useRef(0);
  const connectionSerialRef = useRef(0);
  const eventStreamReadyRef = useRef<{
    readonly connectionSerial: number;
    readonly scopeKey: string;
    readonly roomId: string;
  } | null>(null);
  const desktopMutationStreamReadyRef = useRef(false);
  const reconcileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconcileStartedAtRef = useRef<number | null>(null);
  const reconcileBaseVersionRef = useRef(0);
  const reconcileReasonsRef = useRef(new Set<string>());

  const refresh = useCallback((_reason = "explicit") => {
    setRefreshVersion((version) => version + 1);
  }, []);

  const cancelReconciliation = useCallback(() => {
    if (reconcileTimerRef.current) clearTimeout(reconcileTimerRef.current);
    reconcileTimerRef.current = null;
    reconcileStartedAtRef.current = null;
    reconcileReasonsRef.current.clear();
  }, []);

  const reconcile = useCallback(
    (reason: string) => {
      if (currentScopeRef.current === null) return;
      reconcileReasonsRef.current.add(reason);
      const now = Date.now();
      if (reconcileStartedAtRef.current === null) {
        reconcileStartedAtRef.current = now;
        reconcileBaseVersionRef.current = stateRef.current.successfulListVersion;
      }
      if (reconcileTimerRef.current) clearTimeout(reconcileTimerRef.current);
      const elapsed = now - reconcileStartedAtRef.current;
      const delay = Math.max(0, Math.min(RECONCILE_DEBOUNCE_MS, RECONCILE_MAX_WAIT_MS - elapsed));
      reconcileTimerRef.current = setTimeout(() => {
        reconcileTimerRef.current = null;
        reconcileStartedAtRef.current = null;
        const reasons = [...reconcileReasonsRef.current];
        reconcileReasonsRef.current.clear();
        if (
          stateRef.current.successfulListVersion > reconcileBaseVersionRef.current ||
          currentScopeRef.current === null
        ) {
          return;
        }
        refresh(`reconcile:${reasons.join(",")}`);
      }, delay);
    },
    [refresh],
  );

  const updateArtifacts = useCallback<Dispatch<SetStateAction<ArtifactDto[]>>>((updater) => {
    const expectedScope = currentScopeRef.current;
    if (!expectedScope) return;
    setState((previous) => {
      if (previous.scopeKey !== expectedScope) return previous;
      const current = previous.orderedIds.flatMap((id) => {
        const artifact = previous.byId.get(id);
        return artifact ? [artifact] : [];
      });
      const next = typeof updater === "function" ? updater(current) : updater;
      const sorted = [...next].sort((left, right) =>
        left.path.localeCompare(right.path, undefined, { sensitivity: "base" }),
      );
      return {
        ...previous,
        byId: new Map(sorted.map((artifact) => [artifact.id, artifact])),
        orderedIds: sorted.map((artifact) => artifact.id),
      };
    });
  }, []);

  const upsertArtifact = useCallback(
    (artifact: ArtifactDto) => {
      updateArtifacts((previous) => {
        const index = previous.findIndex((candidate) => candidate.id === artifact.id);
        if (index < 0) return [...previous, artifact];
        const next = [...previous];
        next[index] = artifact;
        return next;
      });
    },
    [updateArtifacts],
  );

  const removeArtifacts = useCallback(
    (ids: ReadonlySet<string>) => {
      updateArtifacts((previous) => previous.filter((artifact) => !ids.has(artifact.id)));
    },
    [updateArtifacts],
  );

  useEffect(() => {
    cancelReconciliation();
    const expectedScope = scopeKey;
    const fetchSerial = ++fetchSerialRef.current;
    if (!expectedScope || !roomId) {
      conditionalRef.current = { scopeKey: null, etag: null };
      setState(emptyState(null, false));
      return;
    }
    if (conditionalRef.current.scopeKey !== expectedScope) {
      conditionalRef.current = { scopeKey: expectedScope, etag: null };
    }
    setState((previous) =>
      previous.scopeKey === expectedScope
        ? {
            ...previous,
            loading: previous.lastSuccessfulAt === null,
            error: null,
          }
        : emptyState(expectedScope, true),
    );

    let cancelled = false;
    const abortController = new AbortController();
    // Deferring one microtask prevents React StrictMode's probe mount from
    // creating a second list owner while retaining ordinary first-paint startup.
    queueMicrotask(() => {
      if (cancelled || currentScopeRef.current !== expectedScope) return;
      void (async () => {
        const policy = await apiClient.admin.encryptionTransition.getPolicy({
          signal: abortController.signal,
        });
        if (policy.policy.mode === "plaintext_only") {
          const body = await apiClient.listAllWorkspaceArtifacts({
            roomId,
            signal: abortController.signal,
          });
          return {
            complete: true as const,
            response: { status: 200 as const, body, etag: null },
          };
        }
        let response = await apiClient.listWorkspaceArtifactsConditional({
          roomId,
          ...(conditionalRef.current.etag
            ? { ifNoneMatch: conditionalRef.current.etag }
            : {}),
        });
        if (
          cancelled ||
          fetchSerialRef.current !== fetchSerial ||
          currentScopeRef.current !== expectedScope
        ) {
          return undefined;
        }
        if (
          response.status === 304 &&
          !(
            stateRef.current.scopeKey === expectedScope &&
            stateRef.current.lastSuccessfulAt !== null
          )
        ) {
          response = await apiClient.listWorkspaceArtifactsConditional({ roomId });
          if (response.status === 304) {
            throw new Error("Workspace artifact list returned 304 without a cached body");
          }
        }
        return { complete: false as const, response };
      })()
        .then((result) => {
          if (
            result === undefined ||
            cancelled ||
            fetchSerialRef.current !== fetchSerial ||
            currentScopeRef.current !== expectedScope
          ) {
            return;
          }
          const { complete, response } = result;
          if (response.status === 304) {
            if (response.etag) conditionalRef.current.etag = response.etag;
            setState((previous) =>
              previous.scopeKey === expectedScope && previous.lastSuccessfulAt !== null
                ? {
                    ...previous,
                    loading: false,
                    error: null,
                    successfulListVersion: previous.successfulListVersion + 1,
                    lastSuccessfulAt: Date.now(),
                  }
                : previous,
            );
            return;
          }
          conditionalRef.current = {
            scopeKey: expectedScope,
            etag: complete ? null : response.etag,
          };
          setState((previous) =>
            normalizedState(expectedScope, response.body.artifacts, previous),
          );
        })
        .catch((error: unknown) => {
          if (
            cancelled ||
            fetchSerialRef.current !== fetchSerial ||
            currentScopeRef.current !== expectedScope
          ) {
            return;
          }
          setState((previous) => ({
            ...previous,
            loading: false,
            error: messageForError(error),
          }));
        });
    });
    return () => {
      cancelled = true;
      abortController.abort();
    };
  }, [cancelReconciliation, roomId, scopeKey, refreshVersion]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      const lastSuccessfulAt = stateRef.current.lastSuccessfulAt;
      if (
        lastSuccessfulAt === null ||
        reconcileReasonsRef.current.size > 0 ||
        Date.now() - lastSuccessfulAt >= VISIBILITY_STALE_MS
      ) {
        reconcile("visibility");
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [reconcile]);

  useEffect(() => {
    const expectedScope = scopeKey;
    const connectionSerial = ++connectionSerialRef.current;
    if (!expectedScope || !roomId) return;

    let cancelled = false;
    let opened = false;
    let unsubscribe: (() => void) | null = null;
    queueMicrotask(() => {
      if (
        cancelled ||
        connectionSerialRef.current !== connectionSerial ||
        currentScopeRef.current !== expectedScope
      ) {
        return;
      }
      try {
        unsubscribe = apiClient.subscribeWorkspaceArtifactEvents(
          async (event) => {
            if (
              cancelled ||
              connectionSerialRef.current !== connectionSerial ||
              currentScopeRef.current !== expectedScope
            ) {
              return;
            }
            if (event.type === "document.mutation.committed") {
              const eventKey = `${event.operationId}\u0000${event.revisionGroupId}\u0000${event.sequence}`;
              if (seenCommittedEventsRef.current.has(eventKey)) return;
              seenCommittedEventsRef.current.add(eventKey);
            }

            const eventId = workspaceArtifactEventId(event);
            if (event.type === "deleted") {
              apiClient.revokeWorkspaceArtifactObjectUrl(event.id);
              removeArtifacts(new Set([event.id]));
            } else if (event.type === "renamed") {
              apiClient.revokeWorkspaceArtifactObjectUrl(event.id);
              const found = stateRef.current.byId.has(event.id);
              updateArtifacts((previous) =>
                previous.map((artifact) => {
                  if (artifact.id !== event.id) return artifact;
                  return { ...artifact, path: event.newPath };
                }),
              );
              if (!found) reconcile("rename-missing");
            } else if (event.type === "changed") {
              const found = stateRef.current.byId.has(event.id);
              updateArtifacts((previous) =>
                previous.map((artifact) => {
                  if (artifact.id !== event.id) return artifact;
                  return artifact.path === event.path
                    ? artifact
                    : { ...artifact, path: event.path };
                }),
              );
              reconcile(found ? "changed-metadata" : "changed-or-created");
            } else if (
              event.type === "document.patch.applied" &&
              eventId &&
              typeof event.revision === "number"
            ) {
              updateArtifacts((previous) =>
                previous.map((artifact) =>
                  artifact.id === eventId
                    ? {
                        ...artifact,
                        revision: event.revision as number,
                      }
                    : artifact,
                ),
              );
            } else {
              if (
                isWorkspaceArtifactCommittedMutation(event) &&
                event.mutation === "create"
              ) {
                reconcile("committed-created");
              }
              const committedRevision =
                isWorkspaceArtifactCommittedMutation(event) &&
                event.mutation === "update" &&
                event.after.identity.kind === "workspace_artifact" &&
                event.after.backendVersion.kind === "artifact_revision"
                  ? event.after.backendVersion.revision
                  : null;
              if (
              isWorkspaceArtifactCommittedMutation(event) &&
              eventId &&
              event.mutation === "update" &&
              committedRevision !== null
              ) {
                const path = workspaceArtifactEventPath(event);
                updateArtifacts((previous) =>
                  previous.map((artifact) =>
                    artifact.id === eventId
                      ? {
                          ...artifact,
                          revision: committedRevision,
                          ...(path ? { path } : {}),
                          ...(event.workspaceArtifactMetadata
                            ? { mimeType: event.workspaceArtifactMetadata.afterMimeType }
                            : {}),
                        }
                      : artifact,
                  ),
                );
                // The committed event intentionally carries exact document
                // truth, not list-only metadata such as size/updatedAt.
                reconcile("committed-metadata");
              }
            }

            for (const subscriber of [...subscribersRef.current]) {
              if (subscriber.roomId && subscriber.roomId !== roomId) continue;
              if (subscriber.artifactId && subscriber.artifactId !== eventId) continue;
              await subscriber.handler(event);
            }
            if (event.type === "document.mutation.committed") {
              finalizeLocalArtifactSaveMutationEvent(
                workspaceArtifactEventClientMutationId(event),
              );
            }
          },
          {
            roomId,
            onOpen: (reconnected) => {
              if (cancelled || connectionSerialRef.current !== connectionSerial) return;
              // The server only delivers live events. Its first successful open
              // therefore closes the initial list-to-subscribe gap just as a
              // later open closes a disconnected interval.
              if (!reconnected && opened) return;
              opened = true;
              eventStreamReadyRef.current = { connectionSerial, scopeKey: expectedScope, roomId };
              reconcile(reconnected ? "event-stream-reconnected" : "event-stream-initial-ready");
              for (const subscriber of [...subscribersRef.current]) {
                if (subscriber.roomId && subscriber.roomId !== roomId) continue;
                void subscriber.onReconnect?.();
              }
            },
          },
        );
      } catch {
        // A later credential generation transition retries with a fresh token.
      }
    });

    return () => {
      cancelled = true;
      if (eventStreamReadyRef.current?.connectionSerial === connectionSerial) {
        eventStreamReadyRef.current = null;
      }
      unsubscribe?.();
    };
  }, [
    auth.credentialGeneration,
    reconcile,
    removeArtifacts,
    roomId,
    scopeKey,
    updateArtifacts,
  ]);

  useEffect(() => {
    const mutations = desktopAPI?.documentMutations;
    if (!mutations) return;
    const seen = new Set<string>();
    const unsubscribeReconnect = mutations.onReconnect(async () => {
      desktopMutationStreamReadyRef.current = true;
      for (const subscriber of [...subscribersRef.current]) {
        if (subscriber.artifactId || subscriber.roomId) continue;
        await subscriber.onReconnect?.();
      }
    });
    const unsubscribeCommitted = mutations.onCommitted(async (batch) => {
      if (seen.has(batch.idempotencyKey)) return;
      for (const event of batch.events) {
        for (const subscriber of [...subscribersRef.current]) {
          if (subscriber.artifactId || subscriber.roomId) continue;
          await subscriber.handler(event);
        }
        finalizeLocalArtifactSaveMutationEvent(
          workspaceArtifactEventClientMutationId(event),
        );
      }
      seen.add(batch.idempotencyKey);
    });
    return () => {
      desktopMutationStreamReadyRef.current = false;
      unsubscribeCommitted();
      unsubscribeReconnect();
    };
  }, []);

  useEffect(() => cancelReconciliation, [cancelReconciliation]);

  const visibleState =
    state.scopeKey === scopeKey ? state : emptyState(scopeKey, scopeKey !== null);
  const artifacts = useMemo(
    () =>
      visibleState.orderedIds.flatMap((id) => {
        const artifact = visibleState.byId.get(id);
        return artifact ? [artifact] : [];
      }),
    [visibleState.byId, visibleState.orderedIds],
  );
  const value = useMemo<WorkspaceArtifactsValue>(
    () => ({
      roomId,
      artifacts,
      loading: visibleState.loading,
      error: visibleState.error,
      refresh,
      reconcile,
      updateArtifacts,
      upsertArtifact,
      removeArtifacts,
    }),
    [
      artifacts,
      reconcile,
      refresh,
      removeArtifacts,
      roomId,
      updateArtifacts,
      upsertArtifact,
      visibleState.error,
      visibleState.loading,
    ],
  );
  const subscribe = useCallback<WorkspaceArtifactEventHub["subscribe"]>(
    (handler, options = {}) => {
      const subscriber: ArtifactEventSubscriber = {
        handler,
        ...(options.artifactId ? { artifactId: options.artifactId } : {}),
        ...(options.roomId ? { roomId: options.roomId } : {}),
        ...(options.onReconnect ? { onReconnect: options.onReconnect } : {}),
      };
      subscribersRef.current.add(subscriber);
      const ready = eventStreamReadyRef.current;
      const desktopReady =
        desktopMutationStreamReadyRef.current &&
        !subscriber.artifactId &&
        !subscriber.roomId;
      const workspaceReady =
        ready !== null &&
        ready.scopeKey === currentScopeRef.current &&
        (!subscriber.roomId || subscriber.roomId === ready.roomId);
      if (desktopReady || workspaceReady) {
        queueMicrotask(() => {
          if (subscribersRef.current.has(subscriber)) {
            void subscriber.onReconnect?.();
          }
        });
      }
      return () => subscribersRef.current.delete(subscriber);
    },
    [],
  );
  const eventHub = useMemo<WorkspaceArtifactEventHub>(() => ({ subscribe }), [subscribe]);

  return (
    <WorkspaceArtifactsContext.Provider value={value}>
      <WorkspaceArtifactEventHubContext.Provider value={eventHub}>
        {children}
      </WorkspaceArtifactEventHubContext.Provider>
    </WorkspaceArtifactsContext.Provider>
  );
}

export function useWorkspaceArtifacts(): WorkspaceArtifactsValue {
  const value = useContext(WorkspaceArtifactsContext);
  if (!value) {
    throw new Error("useWorkspaceArtifacts must be used within <WorkspaceArtifactsProvider>");
  }
  return value;
}

export function useWorkspaceArtifactEventHub(): WorkspaceArtifactEventHub["subscribe"] {
  const value = useContext(WorkspaceArtifactEventHubContext);
  if (!value) {
    throw new Error(
      "useWorkspaceArtifactEventHub must be used within <WorkspaceArtifactsProvider>",
    );
  }
  return value.subscribe;
}
