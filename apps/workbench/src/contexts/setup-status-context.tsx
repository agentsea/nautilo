import { createContext, type ReactNode, useContext } from "react";
import type { SetupStatusResponse } from "@nautilo/api-client/browser";

const SetupStatusContext = createContext<SetupStatusResponse | null>(null);

export function SetupStatusProvider({
  status,
  children,
}: {
  readonly status: SetupStatusResponse;
  readonly children: ReactNode;
}) {
  return (
    <SetupStatusContext.Provider value={status}>
      {children}
    </SetupStatusContext.Provider>
  );
}

/** Latest server-owned setup posture. Null means the posture could not be loaded. */
export function useSetupStatus(): SetupStatusResponse | null {
  return useContext(SetupStatusContext);
}
