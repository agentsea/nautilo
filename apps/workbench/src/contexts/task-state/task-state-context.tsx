import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import type { ServerEvent } from "@nautilo/types";
import { apiClient } from "../../lib/api";
import { useAuth } from "../../hooks/use-auth";
import {
  addAuthTransitionListener,
  shouldIgnoreCredentialOnlyTransition,
} from "../../lib/auth-transition";
import type { WsState } from "../../adapters/runtime-contexts";
import {
  deriveHeartbeat,
  sortRunningSubagents,
} from "../../modes/rooms/subagents/running-subagents-model";
import {
  RunningSubagentsContext,
  type RunningSubagentsSnapshot,
} from "../../adapters/runtime-contexts";
import {
  createTaskStateStore,
  type TaskStateSnapshot,
  type TaskStateStore,
} from "./task-state-store";

/** Bridge surface the runtime WS handler calls into the canonical task store. */
export interface TaskStateBridge {
  applyWsEvent(event: ServerEvent): void;
}

export interface TaskStateContextValue extends TaskStateSnapshot {
  refresh: () => Promise<void>;
  pauseTask: (taskId: string) => Promise<void>;
  unpauseTask: (taskId: string) => Promise<void>;
  stopTask: (taskId: string) => Promise<void>;
  setDashboardPollingEnabled: (enabled: boolean) => void;
}

/**
 * Standalone/SSR surfaces can render a subagent dock without the authenticated
 * runtime boundary. This inert value deliberately owns no fetches, polling, or
 * mutations; the live `TaskStateProvider` remains the sole task-state owner.
 */
const DEFAULT_TASK_STATE: TaskStateContextValue = {
  taskMap: {},
  tasks: [],
  loading: false,
  error: null,
  busyIds: new Set(),
  runningSubagentsMap: {},
  lastSuccessfulAtMs: null,
  refresh: async () => {},
  pauseTask: async () => {},
  unpauseTask: async () => {},
  stopTask: async () => {},
  setDashboardPollingEnabled: () => {},
};

const TaskStateContext = createContext<TaskStateContextValue>(DEFAULT_TASK_STATE);

export function useTaskState(): TaskStateContextValue {
  return useContext(TaskStateContext);
}

export interface TaskStateProviderProps {
  readonly children: ReactNode;
  readonly wsState: WsState;
  readonly bridgeRef: MutableRefObject<TaskStateBridge | null>;
}

export function TaskStateProvider({
  children,
  wsState,
  bridgeRef,
}: TaskStateProviderProps) {
  const auth = useAuth();
  const storeRef = useRef<TaskStateStore | null>(null);
  const lastProcessedViewerGenerationRef = useRef<number | null>(null);
  const prevWsStateRef = useRef<WsState>(wsState);

  if (!storeRef.current) {
    storeRef.current = createTaskStateStore({
      // Include the existing bounded terminal window to discover verified recovery.
      listActiveTasks: () => apiClient.listTasks({ includeTerminal: true }),
      lifecycle: {
        pauseTask: (taskId) => apiClient.pauseTask(taskId),
        unpauseTask: (taskId) => apiClient.unpauseTask(taskId),
        stopTask: (taskId) => apiClient.stopTask(taskId),
      },
    });
  }
  const store = storeRef.current;

  const [snapshot, setSnapshot] = useState<TaskStateSnapshot>(() => store.getSnapshot());

  useEffect(() => store.subscribe(setSnapshot), [store]);

  useEffect(() => {
    bridgeRef.current = {
      applyWsEvent: (event) => store.applyWsEvent(event),
    };
    return () => {
      bridgeRef.current = null;
    };
  }, [bridgeRef, store]);

  const refresh = useCallback(() => store.refresh(), [store]);
  const pauseTask = useCallback((taskId: string) => store.pauseTask(taskId), [store]);
  const unpauseTask = useCallback((taskId: string) => store.unpauseTask(taskId), [store]);
  const stopTask = useCallback((taskId: string) => store.stopTask(taskId), [store]);
  const setDashboardPollingEnabled = useCallback(
    (enabled: boolean) => store.setDashboardPollingEnabled(enabled),
    [store],
  );

  useEffect(() => {
    if (!auth.viewer.isVerified) {
      store.clearForViewerChange();
      return;
    }
    store.clearForViewerChange();
    void store.seed("mount");
  }, [auth.viewer.isVerified, auth.viewerGeneration, store]);

  useEffect(() => {
    const prev = prevWsStateRef.current;
    prevWsStateRef.current = wsState;
    if (!auth.viewer.isVerified) return;
    if (wsState === "open" && prev !== "open") {
      void store.seed("ws-open");
    }
  }, [auth.viewer.isVerified, wsState, store]);

  useEffect(() => {
    const resume = (): void => {
      if (auth.viewer.isVerified) void store.seed("ws-open");
    };
    window.addEventListener("nautilo:admission-resumed", resume);
    return () => window.removeEventListener("nautilo:admission-resumed", resume);
  }, [auth.viewer.isVerified, store]);

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
      store.clearForViewerChange();
      if (auth.viewer.isVerified) {
        void store.seed("mount");
      }
    });
    return removeAuthListener;
  }, [auth.viewer.isVerified, store]);

  const value = useMemo<TaskStateContextValue>(
    () => ({
      ...snapshot,
      refresh,
      pauseTask,
      unpauseTask,
      stopTask,
      setDashboardPollingEnabled,
    }),
    [
      snapshot,
      refresh,
      pauseTask,
      unpauseTask,
      stopTask,
      setDashboardPollingEnabled,
    ],
  );

  return (
    <TaskStateContext.Provider value={value}>{children}</TaskStateContext.Provider>
  );
}

/** Supplies `RunningSubagentsContext` from the canonical task store projection. */
export function RunningSubagentsFromTaskState({
  children,
}: {
  readonly children: ReactNode;
}) {
  const { runningSubagentsMap } = useTaskState();
  const snapshot = useMemo<RunningSubagentsSnapshot>(() => {
    const list = sortRunningSubagents(Object.values(runningSubagentsMap));
    return {
      list,
      heartbeat: deriveHeartbeat(list),
    };
  }, [runningSubagentsMap]);

  return (
    <RunningSubagentsContext.Provider value={snapshot}>
      {children}
    </RunningSubagentsContext.Provider>
  );
}
