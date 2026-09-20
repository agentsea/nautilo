import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname } from "expo-router";
import { VoicePlayer } from "@/lib/voice-player";
import { VoiceStreamPlayer } from "@/lib/voice-stream-player";
import { activeRoomIdFromPathname, shouldPlayRoomVoiceAudio } from "@/lib/voice-room-routing";
import { appLifecycle } from "@/platform/app-lifecycle";
import { useRealtime } from "@/providers/realtime";
import { nativePcmSink } from "../../modules/nautilo-voice-pcm";

interface VoiceValue {
  enabled: boolean;
  toggle: () => void;
  stop: () => void;
  speaking: boolean;
}
const VoiceContext = createContext<VoiceValue | null>(null);

export function VoiceProvider({ children }: { children: ReactNode }) {
  const { subscribe, subscribeVoice, send, connectionState, openRevision } = useRealtime();
  const roomId = activeRoomIdFromPathname(usePathname());
  const [enabled, setEnabled] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [foreground, setForeground] = useState(appLifecycle.currentState() === "active");
  const legacy = useRef<VoicePlayer | null>(null);
  const stream = useRef<VoiceStreamPlayer | null>(null);
  const legacyTurn = useRef<string | undefined>(undefined);
  const active = useRef({ enabled, foreground, roomId, connectionState });
  active.current = { enabled, foreground, roomId, connectionState };

  const stopLocal = useCallback(() => {
    legacy.current?.stop(); stream.current?.stop(); legacyTurn.current = undefined;
  }, []);

  useEffect(() => {
    const player = new VoicePlayer(setSpeaking);
    legacy.current = player;
    player.setEnabled(active.current.enabled && active.current.foreground);
    const pcm = nativePcmSink ? new VoiceStreamPlayer(nativePcmSink, {
      status: setSpeaking,
      consumed: (streamId, samples) => send({ type: "voice.consumed", streamId, samples }),
      failure: () => { send({ type: "voice.listen", version: 1, roomId: active.current.roomId, enabled: false }); setEnabled(false); },
    }) : null;
    stream.current = pcm;
    const unsubscribe = subscribe(event => {
      const current = active.current;
      if (event.type === "voice.audio" && shouldPlayRoomVoiceAudio({ event, activeRoomId: current.roomId,
        enabled: current.enabled && current.foreground && current.connectionState === "open" })) {
        legacyTurn.current = event.turnId;
        player.handleAudioEvent(event);
      }
    });
    const unsubscribeVoice = subscribeVoice(event => {
      const current = active.current;
      if (event.type === "voice.stream.start") {
        if (!current.enabled || !current.foreground || current.connectionState !== "open" || event.roomId !== current.roomId) return;
        player.stop(); legacyTurn.current = undefined;
      }
      pcm?.handle(event);
    });
    return () => {
      unsubscribe(); unsubscribeVoice(); player.dispose(); pcm?.dispose();
      legacy.current = null; stream.current = null;
    };
  }, [subscribe, subscribeVoice, send]);

  useEffect(() => {
    const sub = appLifecycle.addEventListener("change", state => {
      const visible = state === "active";
      active.current.foreground = visible;
      if (!visible) {
        stopLocal();
        send({ type: "voice.listen", version: 1, roomId: active.current.roomId, enabled: false });
      }
      setForeground(visible);
    });
    return () => sub.remove();
  }, [send, stopLocal]);

  useEffect(() => {
    stopLocal();
    const listening = enabled && foreground && roomId !== null && connectionState === "open";
    legacy.current?.setEnabled(listening);
    if (listening) void legacy.current?.prime();
    send({ type: "voice.listen", version: 1, roomId, enabled: listening });
    return () => { stopLocal(); };
  }, [enabled, foreground, roomId, connectionState, openRevision, send, stopLocal]);

  const toggle = useCallback(() => setEnabled(value => !value), []);
  const stop = useCallback(() => {
    const turnId = stream.current?.turnId ?? legacyTurn.current;
    stopLocal();
    // The realtime client permits an unscoped Stop only for older servers.
    send({ type: "voice.stop", ...(turnId ? { turnId } : {}) });
  }, [send, stopLocal]);
  const value = useMemo(() => ({ enabled, toggle, stop, speaking }), [enabled, toggle, stop, speaking]);
  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>;
}
export function useVoice(): VoiceValue {
  const context = useContext(VoiceContext);
  if (!context) throw new Error("useVoice must be used within VoiceProvider");
  return context;
}
