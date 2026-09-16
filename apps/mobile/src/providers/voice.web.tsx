import { createContext, useContext, useMemo, type ReactNode } from "react";

interface VoiceValue {
  enabled: false;
  toggle: () => void;
  stop: () => void;
  speaking: false;
}

const VoiceContext = createContext<VoiceValue | null>(null);

export function VoiceProvider({ children }: { readonly children: ReactNode }) {
  const value = useMemo<VoiceValue>(() => ({ enabled: false, toggle: () => {}, stop: () => {}, speaking: false }), []);
  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>;
}

export function useVoice(): VoiceValue {
  const value = useContext(VoiceContext);
  if (!value) throw new Error("useVoice must be used within VoiceProvider");
  return value;
}
