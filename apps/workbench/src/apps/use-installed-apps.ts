import { useContext, useMemo } from "react";
import {
  InstalledAppsContext,
  InstalledAppsProvider,
  type InstalledAppsState,
} from "./installed-apps-provider";

export type { InstalledAppsState };
export { InstalledAppsProvider };

export function useInstalledApps(): InstalledAppsState & { reload: () => void } {
  const ctx = useContext(InstalledAppsContext);
  if (!ctx) {
    throw new Error("useInstalledApps must be used within <InstalledAppsProvider>");
  }
  return useMemo(() => ({ ...ctx.state, reload: ctx.reload }), [ctx.reload, ctx.state]);
}
