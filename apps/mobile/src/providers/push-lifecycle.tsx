/**
 * D468 root lifecycle for native push registration and device permission.
 *
 * It deliberately owns no URL or notification-response listener. The
 * reconciler operates headlessly across the ordinary server registry; this
 * provider only gives the app one bounded activation/reconciliation seam and
 * exposes truthful device-local state to Settings.
 */
import * as Linking from "expo-linking";
import { AppState, type AppStateStatus } from "react-native";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  createPushPermissionPolicy,
  type DevicePushNotificationState,
  type PushPermissionPolicy,
} from "@/lib/push-permission-policy";
import { createMobilePushBadgeReconciler, type MobilePushBadgeReconciler } from "@/lib/push-badge-reconciler";
import {
  createMobilePushReconciler,
  type MobilePushReconciler,
  type PushReconcileSummary,
} from "@/lib/push-reconciler";

interface AppStateAdapter {
  addEventListener(
    event: "change",
    listener: (state: AppStateStatus) => void,
  ): { remove(): void };
}

interface PushLifecycleReconciler {
  start(): void;
  stop(): void;
  trigger(): Promise<PushReconcileSummary>;
}

interface PushLifecycleBadgeReconciler {
  start(): void;
  stop(): void;
  trigger(): Promise<unknown>;
}

export interface PushLifecycleCoordinatorDeps {
  readonly reconciler: PushLifecycleReconciler;
  /** Separate authoritative native-badge projection, sharing this trigger. */
  readonly badgeReconciler?: PushLifecycleBadgeReconciler;
  readonly appState: AppStateAdapter;
  /** Refreshes device permission after returning from system settings. */
  readonly onAppActive: () => Promise<unknown>;
  /** Completion seam for a focused settings surface to reload server status. */
  readonly onActivationComplete?: (summary: PushReconcileSummary) => void;
}

export interface PushLifecycleCoordinator {
  start(): void;
  stop(): void;
  /** Call after an explicit settings action; concurrent calls coalesce. */
  trigger(): Promise<PushReconcileSummary>;
  /** Refresh native permission before server reconciliation, then resolve. */
  activate(): Promise<PushReconcileSummary>;
}

/**
 * Native AppState has no server/auth ownership. Keep it as a small imperative
 * coordinator so its activation and unmount race behavior is unit-testable.
 */
export function createPushLifecycleCoordinator(
  deps: PushLifecycleCoordinatorDeps,
): PushLifecycleCoordinator {
  let started = false;
  let subscription: { remove(): void } | null = null;
  let activeRun: Promise<PushReconcileSummary> | null = null;
  let activationRun: Promise<PushReconcileSummary> | null = null;

  const trigger = (): Promise<PushReconcileSummary> => {
    if (activeRun) return activeRun;
    const next = Promise.all([
      deps.reconciler.trigger(),
      deps.badgeReconciler?.trigger(),
    ]).then(([registration]) => registration);
    activeRun = next;
    const clearActiveRun = () => {
      if (activeRun === next) activeRun = null;
    };
    void next.then(clearActiveRun, clearActiveRun);
    return next;
  };

  const activate = (): Promise<PushReconcileSummary> => {
    if (activationRun) return activationRun;
    const next = (async () => {
      // Returning from system settings changes an OS authority. Observe it
      // before a server binding can be registered/disabled from stale state.
      await deps.onAppActive();
      // An unmount may happen while the native observation is in flight. Do
      // not let that stale activation restart a stopped headless reconciler.
      if (!started) {
        return {
          tombstones: { attempted: 0, cleared: 0, retained: 0 },
          native: "unavailable" as const,
          servers: new Map(),
        };
      }
      const summary = await trigger();
      // Re-observe after reconciliation because Android may have created the
      // canonical channel during this pass. The UI must see that final native
      // authority, not the pre-registration snapshot.
      await deps.onAppActive();
      if (!started) return summary;
      deps.onActivationComplete?.(summary);
      return summary;
    })();
    activationRun = next;
    const clearActivationRun = () => {
      if (activationRun === next) activationRun = null;
    };
    void next.then(clearActivationRun, clearActivationRun);
    return next;
  };

  return {
    start() {
      if (started) return;
      started = true;
      deps.reconciler.start();
      deps.badgeReconciler?.start();
      subscription = deps.appState.addEventListener("change", (state) => {
        if (state !== "active") return;
        void activate().catch(() => {});
      });
    },
    stop() {
      if (!started) return;
      started = false;
      subscription?.remove();
      subscription = null;
      deps.reconciler.stop();
      deps.badgeReconciler?.stop();
    },
    trigger,
    activate,
  };
}

interface PushLifecycleValue {
  readonly device: DevicePushNotificationState | null;
  readonly refreshingDevice: boolean;
  readonly deviceError: string | null;
  /** Observe native state without ever prompting. */
  readonly refreshDevice: () => Promise<DevicePushNotificationState>;
  /** Explicit UI action only; asks the OS when its state permits it. */
  readonly requestPermission: () => Promise<DevicePushNotificationState>;
  /** Device-local preference; turning it off clears an existing numeric badge. */
  readonly setBadgeEnabled: (enabled: boolean) => Promise<DevicePushNotificationState>;
  /** Opens only the operating-system settings surface; no synthetic success. */
  readonly openSystemSettings: () => Promise<void>;
  /** Bounded active/inactive-server registration reconciliation. */
  readonly reconcile: () => Promise<PushReconcileSummary>;
  /** Recompute only the authoritative native badge from canonical unread state. */
  readonly refreshBadge: () => Promise<void>;
  /** Completes native observation followed by registration reconciliation. */
  readonly refreshAfterAppActive: () => Promise<PushReconcileSummary>;
  /** Changes only after a completed AppState activation lifecycle. */
  readonly activationRevision: number;
  /** Registration result paired with the current activation revision. */
  readonly activationSummary: PushReconcileSummary | null;
}

const PushLifecycleContext = createContext<PushLifecycleValue | null>(null);

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "This device could not update notification settings.";
}

interface PushLifecycleProviderProps {
  readonly children: ReactNode;
  /** Test seam only; production uses the real native policy and reconciler. */
  readonly policy?: PushPermissionPolicy;
  /** Test seam only; production uses the real headless multi-server reconciler. */
  readonly reconciler?: MobilePushReconciler;
  /** Test seam only; production uses the real authoritative badge reconciler. */
  readonly badgeReconciler?: MobilePushBadgeReconciler;
}

export function PushLifecycleProvider({
  children,
  policy: suppliedPolicy,
  reconciler: suppliedReconciler,
  badgeReconciler: suppliedBadgeReconciler,
}: PushLifecycleProviderProps) {
  const policyRef = useRef<PushPermissionPolicy | null>(null);
  if (!policyRef.current) policyRef.current = suppliedPolicy ?? createPushPermissionPolicy();
  const reconcilerRef = useRef<MobilePushReconciler | null>(null);
  if (!reconcilerRef.current) reconcilerRef.current = suppliedReconciler ?? createMobilePushReconciler();
  const badgeReconcilerRef = useRef<MobilePushBadgeReconciler | null>(null);
  if (!badgeReconcilerRef.current) {
    badgeReconcilerRef.current = suppliedBadgeReconciler ?? createMobilePushBadgeReconciler();
  }
  const coordinatorRef = useRef<PushLifecycleCoordinator | null>(null);
  const mountedRef = useRef(true);
  const deviceGenerationRef = useRef(0);
  const [device, setDevice] = useState<DevicePushNotificationState | null>(null);
  const [refreshingDevice, setRefreshingDevice] = useState(true);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [activationRevision, setActivationRevision] = useState(0);
  const [activationSummary, setActivationSummary] = useState<PushReconcileSummary | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const applyDeviceOperation = useCallback(async (
    operation: () => Promise<DevicePushNotificationState>,
  ): Promise<DevicePushNotificationState> => {
    const generation = ++deviceGenerationRef.current;
    if (mountedRef.current) {
      setRefreshingDevice(true);
      setDeviceError(null);
    }
    try {
      const next = await operation();
      if (mountedRef.current && deviceGenerationRef.current === generation) setDevice(next);
      return next;
    } catch (error) {
      if (mountedRef.current && deviceGenerationRef.current === generation) {
        setDeviceError(errorMessage(error));
      }
      throw error;
    } finally {
      if (mountedRef.current && deviceGenerationRef.current === generation) setRefreshingDevice(false);
    }
  }, []);

  const refreshDevice = useCallback(
    () => applyDeviceOperation(() => policyRef.current!.refresh()),
    [applyDeviceOperation],
  );
  const reconcile = useCallback(async (): Promise<PushReconcileSummary> => {
    return coordinatorRef.current?.trigger() ?? {
      tombstones: { attempted: 0, cleared: 0, retained: 0 },
      native: "unavailable",
      servers: new Map(),
    };
  }, []);
  const refreshBadge = useCallback(async (): Promise<void> => {
    await badgeReconcilerRef.current!.trigger();
  }, []);
  const refreshAfterAppActive = useCallback(async (): Promise<PushReconcileSummary> => {
    const coordinator = coordinatorRef.current;
    if (coordinator) return coordinator.activate();
    await refreshDevice();
    return reconcile();
  }, [reconcile, refreshDevice]);
  const requestPermission = useCallback(async () => {
    const next = await applyDeviceOperation(() => policyRef.current!.requestPermission());
    // The server never learns a speculative permission intent. Reconcile only
    // after native state is known, and still never surface a background error
    // as a false settings state.
    void reconcile().catch(() => {});
    return next;
  }, [applyDeviceOperation, reconcile]);
  const setBadgeEnabled = useCallback(async (enabled: boolean) => {
    const next = await applyDeviceOperation(() => policyRef.current!.setBadgeEnabled(enabled));
    // Both choices are synchronized to every registered server. Disabling has
    // already cleared native state before this background reconciliation.
    if (next.badge === "enabled" || next.badge === "disabled") {
      void reconcile().catch(() => {});
    }
    return next;
  }, [applyDeviceOperation, reconcile]);
  const openSystemSettings = useCallback(async () => {
    await Linking.openSettings();
  }, []);

  useEffect(() => {
    const coordinator = createPushLifecycleCoordinator({
      reconciler: reconcilerRef.current!,
      badgeReconciler: badgeReconcilerRef.current!,
      appState: AppState,
      onAppActive: refreshDevice,
      onActivationComplete: (summary) => {
        if (!mountedRef.current) return;
        setActivationSummary(summary);
        setActivationRevision((revision) => revision + 1);
      },
    });
    coordinatorRef.current = coordinator;
    coordinator.start();
    void refreshDevice().catch(() => {});
    return () => {
      coordinator.stop();
      if (coordinatorRef.current === coordinator) coordinatorRef.current = null;
    };
  }, [refreshDevice]);

  const value = useMemo<PushLifecycleValue>(() => ({
    device,
    refreshingDevice,
    deviceError,
    refreshDevice,
    requestPermission,
    setBadgeEnabled,
    openSystemSettings,
    reconcile,
    refreshBadge,
    refreshAfterAppActive,
    activationRevision,
    activationSummary,
  }), [
    device,
    refreshingDevice,
    deviceError,
    refreshDevice,
    requestPermission,
    setBadgeEnabled,
    openSystemSettings,
    reconcile,
    refreshBadge,
    refreshAfterAppActive,
    activationRevision,
    activationSummary,
  ]);

  return <PushLifecycleContext.Provider value={value}>{children}</PushLifecycleContext.Provider>;
}

export function usePushLifecycle(): PushLifecycleValue {
  const value = useContext(PushLifecycleContext);
  if (!value) throw new Error("usePushLifecycle must be used within PushLifecycleProvider");
  return value;
}
