import { useEffect, useRef, useState } from "react";
import { isDesktop, desktopAPI } from "../lib/desktop";
import { formatSttHttpError } from "../lib/speech-stt-error";
import { workbenchFetch } from "../lib/admission-fetch";
import { SpeechCapture, type CaptureSnapshot } from "../lib/speech-capture";

/**
 * Desktop-only preflight: resolve TCC mic status, prompt once if never
 * decided, bail with a human-readable reason otherwise. Browser workbench
 * short-circuits through — Chromium handles prompting on getUserMedia.
 *
 * Returns either `{ ok: true }` or `{ ok: false, reason }`.
 */
async function ensureDesktopMicPermission(): Promise<
  { ok: true } | { ok: false; reason: string }
> {
  if (!isDesktop || !desktopAPI) return { ok: true };
  try {
    let status = await desktopAPI.media.getMicStatus();
    if (status === "not-determined") {
      status = await desktopAPI.media.askForMicrophoneAccess();
    }
    if (status === "granted") return { ok: true };
    if (status === "denied") {
      return {
        ok: false,
        reason:
          "Microphone access is denied. Open System Settings → Privacy & Security → Microphone to enable it for Nautilo.",
      };
    }
    if (status === "restricted") {
      return {
        ok: false,
        reason:
          "Microphone access is restricted (parental controls / MDM policy).",
      };
    }
    return { ok: false, reason: "Microphone permission could not be resolved." };
  } catch (err) {
    console.warn("[speech] desktop mic preflight failed:", err);
    // If the desktop IPC is broken somehow, fall through to getUserMedia
    // and let Chromium handle it — same behavior as the browser path.
    return { ok: true };
  }
}

export function createBrowserSpeechCapture(changed: (state: CaptureSnapshot) => void, result: (text: string) => void) {
  return new SpeechCapture({
    permission: async () => {
      const permission = await ensureDesktopMicPermission();
      if (!permission.ok) throw new Error(permission.reason);
    },
    stream: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }),
    recorder: stream => {
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg", "audio/mp4"].find(type => MediaRecorder.isTypeSupported(type));
      return new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    },
    transcribe: async (blob, signal) => {
      const form = new FormData();
      form.append("audio", blob, `recording.${blob.type.includes("mp4") ? "m4a" : "webm"}`);
      const response = await workbenchFetch("/api/stt", { method: "POST", body: form, signal });
      if (!response.ok) throw new Error(await formatSttHttpError(response));
      const data = await response.json() as { text?: string };
      return data.text ?? "";
    },
  }, changed, result);
}

export function useSpeechRecognition() {
  const [snapshot, setSnapshot] = useState<CaptureSnapshot>({ state: "idle", error: null });
  const [transcript, setTranscript] = useState("");
  const capture = useRef<SpeechCapture | null>(null);
  if (!capture.current) capture.current = createBrowserSpeechCapture(setSnapshot, setTranscript);
  const owner = capture.current;
  useEffect(() => () => owner.cancel(), [owner]);
  return {
    isSupported: typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia,
    isListening: snapshot.state === "listening" || snapshot.state === "requesting",
    isTranscribing: snapshot.state === "transcribing",
    transcript,
    permissionError: snapshot.errorKind === "transcription" ? null : snapshot.error,
    sttError: snapshot.errorKind === "transcription" ? snapshot.error : null,
    startListening: () => { setTranscript(""); void owner.start(); },
    stopListening: () => owner.getState().state === "requesting" ? owner.cancel() : owner.finish(),
    cancelListening: owner.cancel,
  };
}
