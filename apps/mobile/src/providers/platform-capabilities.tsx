import { createContext, useContext, useMemo, type ReactNode } from "react";

import {
  admitPlatformRoute,
  type MobileCapabilityKey,
  type MobilePlatformCapabilities,
} from "@/platform/capability-contract";
import { platformCapabilities } from "@/platform/capabilities";

const PlatformCapabilitiesContext = createContext<MobilePlatformCapabilities | null>(null);

export function PlatformCapabilitiesProvider({ children }: { readonly children: ReactNode }) {
  return (
    <PlatformCapabilitiesContext.Provider value={platformCapabilities}>
      {children}
    </PlatformCapabilitiesContext.Provider>
  );
}

export function usePlatformCapabilities(): MobilePlatformCapabilities {
  const value = useContext(PlatformCapabilitiesContext);
  if (!value) throw new Error("usePlatformCapabilities must be used within PlatformCapabilitiesProvider");
  return value;
}

export function usePlatformCapability(key: MobileCapabilityKey) {
  return usePlatformCapabilities().decisions[key];
}

export function usePlatformRouteAdmission(pathname: string) {
  const capabilities = usePlatformCapabilities();
  return useMemo(() => admitPlatformRoute(capabilities, pathname), [capabilities, pathname]);
}
