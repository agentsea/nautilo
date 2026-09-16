// D401 P2 — push-to-talk STT: record via expo-audio, upload to POST /api/stt.
import { File } from "expo-file-system";
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from "expo-audio";
import { useCallback, useRef, useState } from "react";

import { getApiClient } from "@/lib/api";
import { interruptMediaForRecording } from "@/lib/media-playback-interruption";

export function useVoiceInput(baseUrl: string | undefined): {
  isRecording: boolean;
  startRecording: () => Promise<void>;
  stopAndTranscribe: () => Promise<string | null>;
  cancelRecording: () => Promise<void>;
} {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recordingRef = useRef(false);
  const [isRecording, setIsRecording] = useState(false);

  const startRecording = useCallback(async () => {
    if (!baseUrl || recordingRef.current) return;
    const perm = await requestRecordingPermissionsAsync();
    if (!perm.granted) return;
    try {
      interruptMediaForRecording();
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      recordingRef.current = true;
      setIsRecording(true);
    } catch {
      recordingRef.current = false;
      setIsRecording(false);
    }
  }, [baseUrl, recorder]);

  const stopAndTranscribe = useCallback(async (): Promise<string | null> => {
    if (!baseUrl || !recordingRef.current) return null;
    recordingRef.current = false;
    setIsRecording(false);
    try {
      await recorder.stop();
      // Hand the audio session back to playback so TTS afterward is clean —
      // leaving record mode routes media through the earpiece/comms path
      // (silent or garbled). Force normal speaker playback.
      try {
        await setAudioModeAsync({
          allowsRecording: false,
          shouldRouteThroughEarpiece: false,
        });
      } catch {
        // best-effort
      }
      const uri = recorder.uri;
      if (!uri) return null;
      const file = new File(uri) as unknown as Blob;
      const res = await getApiClient(baseUrl).transcribeAudio(file, "recording.m4a");
      // Drop non-speech markers the STT engine emits for silence/noise —
      // e.g. "[pause]", "[BLANK_AUDIO]", "(silence)", "[inaudible]". These
      // appear when the mic captured nothing (common on emulators without
      // host-audio passthrough); inserting them just clutters the draft.
      const cleaned = res.text
        .replace(/[[(][^\])]*[\])]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      return cleaned.length > 0 ? cleaned : null;
    } catch {
      return null;
    }
  }, [baseUrl, recorder]);

  const cancelRecording = useCallback(async (): Promise<void> => {
    if (!recordingRef.current) return;
    recordingRef.current = false;
    setIsRecording(false);
    try {
      await recorder.stop();
    } catch {
      // discard — nothing is uploaded on cancel
    }
    try {
      await setAudioModeAsync({
        allowsRecording: false,
        shouldRouteThroughEarpiece: false,
      });
    } catch {
      // best-effort — restore playback routing
    }
  }, [recorder]);

  return {
    isRecording,
    startRecording,
    stopAndTranscribe,
    cancelRecording,
  };
}
