import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { DevicePushNotificationState } from "@/lib/push-permission-policy";
import type { PushReconcileSummary } from "@/lib/push-reconciler";

interface PushLifecycleValue {
  readonly device: DevicePushNotificationState;
  readonly refreshingDevice: false;
  readonly deviceError: string | null;
  readonly refreshDevice: () => Promise<DevicePushNotificationState>;
  readonly requestPermission: () => Promise<DevicePushNotificationState>;
  readonly setBadgeEnabled: (_enabled: boolean) => Promise<DevicePushNotificationState>;
  readonly openSystemSettings: () => Promise<void>;
  readonly reconcile: () => Promise<PushReconcileSummary>;
  readonly refreshBadge: () => Promise<void>;
  readonly refreshAfterAppActive: () => Promise<PushReconcileSummary>;
  readonly activationRevision: 0;
  readonly activationSummary: null;
}

const unavailableDevice: DevicePushNotificationState = Object.freeze({
  permission: "unavailable",
  canRequestPermission: false,
  badge: "unavailable",
  importantChannel: "unavailable",
  alertCapability: "unavailable",
});

function unavailableSummary(): PushReconcileSummary {
  return {
    tombstones: { attempted: 0, cleared: 0, retained: 0 },
    native: "unavailable",
    servers: new Map(),
  };
}

const PushLifecycleContext = createContext<PushLifecycleValue | null>(null);

/** Web v1 never constructs notification, badge, installation, or push workers. */
export function PushLifecycleProvider({ children }: { readonly children: ReactNode }) {
  const value = useMemo<PushLifecycleValue>(() => ({
    device: unavailableDevice,
    refreshingDevice: false,
    deviceError: null,
    refreshDevice: () => Promise.resolve(unavailableDevice),
    requestPermission: () => Promise.resolve(unavailableDevice),
    setBadgeEnabled: () => Promise.resolve(unavailableDevice),
    openSystemSettings: () => Promise.resolve(),
    reconcile: () => Promise.resolve(unavailableSummary()),
    refreshBadge: () => Promise.resolve(),
    refreshAfterAppActive: () => Promise.resolve(unavailableSummary()),
    activationRevision: 0,
    activationSummary: null,
  }), []);
  return <PushLifecycleContext.Provider value={value}>{children}</PushLifecycleContext.Provider>;
}

export function usePushLifecycle(): PushLifecycleValue {
  const value = useContext(PushLifecycleContext);
  if (!value) throw new Error("usePushLifecycle must be used within PushLifecycleProvider");
  return value;
}
