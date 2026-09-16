// D401 P1 — VoiceProvider: session-local TTS playback toggle + WS wiring.
//
// Subscribes to `voice.audio` and drives the RN VoicePlayer. Session-local
// (in-memory, resets on reload), mirroring the desktop session toggle. On
// disable/stop it halts local playback AND sends WS `voice.stop` to abort
// in-flight server synthesis.
//
// Foreground turns request synthesis with `voiceMode: true`; D570 peer
// report-backs are also eligible but carry an origin Room. This provider
// admits audio only while that exact Room is visible and local voice is on.
// Must sit INSIDE RealtimeProvider (needs subscribe/send).
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname } from "expo-router";

import { VoicePlayer } from "@/lib/voice-player";
import {
  activeRoomIdFromPathname,
  shouldPlayRoomVoiceAudio,
} from "@/lib/voice-room-routing";
import { useRealtime } from "@/providers/realtime";

interface VoiceValue {
  /** Session voice-playback toggle (device-local; resets on reload). */
  enabled: boolean;
  /** Flip enabled: on → prime the audio session; off → stop + WS voice.stop. */
  toggle: () => void;
  /** Stop current playback, clear the queue, and send WS voice.stop. */
  stop: () => void;
  /** True while audio is actively playing. */
  speaking: boolean;
}

const VoiceContext = createContext<VoiceValue | null>(null);

export function VoiceProvider({ children }: { children: ReactNode }) {
  const { subscribe, send } = useRealtime();
  const activeRoomId = activeRoomIdFromPathname(usePathname());
  const [enabled, setEnabled] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const playerRef = useRef<VoicePlayer | null>(null);
  // Latest `enabled` for the (re)creation effect to seed a fresh player with —
  // the player is imperative + can be recreated (re-subscribe / Fast Refresh),
  // so it must inherit the current toggle state or it silently stays disabled.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const activeRoomIdRef = useRef(activeRoomId);
  activeRoomIdRef.current = activeRoomId;
  const prevEnabledRef = useRef(enabled);

  useEffect(() => {
    const player = new VoicePlayer((playing) => setSpeaking(playing));
    // Seed the freshly-created player with the current toggle state so events
    // aren't dropped as "player disabled" after a re-subscribe / hot reload.
    player.setEnabled(enabledRef.current);
    if (enabledRef.current) void player.prime();
    playerRef.current = player;
    const unsubscribe = subscribe((event) => {
      if (
        event.type === "voice.audio"
        && shouldPlayRoomVoiceAudio({
          event,
          activeRoomId: activeRoomIdRef.current,
          enabled: enabledRef.current,
        })
      ) {
        player.handleAudioEvent(event);
      }
    });
    return () => {
      unsubscribe();
      player.dispose();
      playerRef.current = null;
    };
  }, [subscribe]);

  // Leaving or switching Rooms revokes local foreground playback immediately.
  // Do not send voice.stop: another tab/device may still be in the origin Room.
  useEffect(() => {
    playerRef.current?.stop();
  }, [activeRoomId]);

  // Keep the imperative player in sync with the toggle, and only abort server
  // TTS on a real on→off transition (not on mount).
  useEffect(() => {
    const player = playerRef.current;
    const was = prevEnabledRef.current;
    prevEnabledRef.current = enabled;
    if (!player) return;
    player.setEnabled(enabled);
    if (enabled) void player.prime();
    else if (was) send({ type: "voice.stop" });
  }, [enabled, send]);

  const toggle = useCallback(() => {
    setEnabled((prev) => !prev);
  }, []);

  const stop = useCallback(() => {
    playerRef.current?.stop();
    send({ type: "voice.stop" });
  }, [send]);

  const value = useMemo<VoiceValue>(
    () => ({ enabled, toggle, stop, speaking }),
    [enabled, toggle, stop, speaking],
  );

  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>;
}

export function useVoice(): VoiceValue {
  const ctx = useContext(VoiceContext);
  if (!ctx) throw new Error("useVoice must be used within VoiceProvider");
  return ctx;
}
