// D382 Batch 1b — AutoApproveProvider: client-side, session-scoped flag
// (port of desktop D375). When ON, ask-tier approvals (approval.ask)
// auto-resolve client-side via approvalReply("once", …) inside
// AttentionProvider; PIN / prove-it / identity challenges stay gated.
//
// In-memory state only — no persistence across restarts, no server
// posture change. `canToggle` is `true` for v1 (any signed-in user);
// desktop gates on a viewer capability we don't wire yet on mobile.
import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface AutoApproveValue {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  canToggle: boolean;
}

const AutoApproveContext = createContext<AutoApproveValue | null>(null);

export function AutoApproveProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState(false);
  // v1 simplification: any signed-in user may toggle. Desktop gates on a
  // viewer capability (`canToggle`) we don't wire yet on mobile — true
  // for everyone here so the bar always renders.
  const canToggle = true;
  const value = useMemo<AutoApproveValue>(
    () => ({ enabled, setEnabled, canToggle }),
    [enabled, canToggle],
  );
  return (
    <AutoApproveContext.Provider value={value}>
      {children}
    </AutoApproveContext.Provider>
  );
}

export function useAutoApprove(): AutoApproveValue {
  const ctx = useContext(AutoApproveContext);
  if (!ctx) {
    throw new Error("useAutoApprove must be used within AutoApproveProvider");
  }
  return ctx;
}
