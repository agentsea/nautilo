import { useCallback, useEffect, useRef, useState } from "react";
import { isDesktop, desktopAPI } from "../lib/desktop";
import { formatSttHttpError } from "../lib/speech-stt-error";
import { workbenchFetch } from "../lib/admission-fetch";

interface SpeechRecognitionHook {
  isSupported: boolean;
  isListening: boolean;
  isTranscribing: boolean;
  transcript: string;
  /**
   * Most recent mic-permission denial reason from the desktop shell.
   * `null` while things are working or on browser workbench. Consumers
   * can surface this as a toast / inline hint alongside an "Open
   * System Settings" action.
   */
  permissionError: string | null;
  /**
   * Last server-side STT failure (`/api/stt`). Cleared when a new
   * recording starts. Distinct from mic TCC / getUserMedia errors.
   */
  sttError: string | null;
  startListening: () => void;
  stopListening: () => void;
  warmUp: () => void;
  coolDown: () => void;
}

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

async function transcribeViaServer(
  blob: Blob,
  onResult: (text: string) => void,
  onDone: () => void,
  onSttError: (message: string) => void,
) {
  try {
    const form = new FormData();
    const ext = blob.type.includes("mp4") ? "m4a" : "webm";
    form.append("audio", blob, `recording.${ext}`);

    const response = await workbenchFetch("/api/stt", {
      method: "POST",
      body: form,
    });

    if (response.ok) {
      const data = (await response.json()) as { text?: string };
      if (typeof data.text === "string" && data.text.length > 0) {
        onResult(data.text);
      } else {
        onSttError("Transcription returned no text.");
      }
    } else {
      const msg = await formatSttHttpError(response);
      console.error("[speech] STT API error:", response.status, msg);
      onSttError(msg);
    }
  } catch (err) {
    console.error("[speech] STT error:", err);
    onSttError(
      err instanceof Error ? err.message : "Transcription request failed.",
    );
  }
  onDone();
}

function checkMediaSupport(): boolean {
  if (typeof window === "undefined") return false;
  return typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}

function getSupportedMimeType(): string {
  const types = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg", "audio/mp4"];
  for (const type of types) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "audio/webm";
}

export function useSpeechRecognition(): SpeechRecognitionHook {
  const [isSupported, setIsSupported] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [sttError, setSttError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const warmStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    setIsSupported(checkMediaSupport());
  }, []);

  useEffect(() => {
    return () => {
      mediaRecorderRef.current?.stop();
      warmStreamRef.current?.getTracks().forEach((t) => t.stop());
      warmStreamRef.current = null;
    };
  }, []);

  const warmUp = useCallback(() => {
    if (warmStreamRef.current?.active) return;
    warmStreamRef.current = null;
    if (!navigator.mediaDevices?.getUserMedia) return;

    // Desktop: only warm if the user has previously granted access.
    // Otherwise warm-up would trigger the TCC prompt at page load, which
    // is hostile — we only want to prompt on an explicit mic tap.
    if (isDesktop && desktopAPI) {
      void desktopAPI.media.getMicStatus().then((status) => {
        if (status !== "granted") return;
        navigator.mediaDevices
          .getUserMedia({ audio: true })
          .then((stream) => {
            warmStreamRef.current = stream;
          })
          .catch((err) => {
            console.warn("[speech] Mic warm-up failed:", err);
          });
      });
      return;
    }

    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        warmStreamRef.current = stream;
      })
      .catch((err) => {
        console.warn("[speech] Mic warm-up failed:", err);
      });
  }, []);

  const coolDown = useCallback(() => {
    warmStreamRef.current?.getTracks().forEach((t) => t.stop());
    warmStreamRef.current = null;
  }, []);

  const startListening = useCallback(() => {
    setTranscript("");
    setPermissionError(null);
    setSttError(null);

    const beginRecording = (stream: MediaStream) => {
      const recorder = new MediaRecorder(stream, {
        mimeType: getSupportedMimeType(),
      });
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        if (stream !== warmStreamRef.current) {
          stream.getTracks().forEach((t) => t.stop());
        }

        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        if (blob.size > 0) {
          setIsListening(false);
          setIsTranscribing(true);
          void transcribeViaServer(
            blob,
            (text) => setTranscript(text),
            () => setIsTranscribing(false),
            (msg) => setSttError(msg),
          );
        } else {
          setIsListening(false);
        }
      };

      recorder.start();
      setIsListening(true);
    };

    if (warmStreamRef.current?.active) {
      beginRecording(warmStreamRef.current);
      return;
    }

    warmStreamRef.current = null;

    if (!navigator.mediaDevices?.getUserMedia) {
      console.warn("[speech] getUserMedia not available");
      setPermissionError("Microphone is not available in this browser.");
      return;
    }

    // D057 2a.5 — desktop preflight. In a packaged Electron build,
    // getUserMedia rejects silently if TCC hasn't granted mic access.
    // Ask macOS explicitly first so we get a real status we can surface.
    void ensureDesktopMicPermission().then((result) => {
      if (!result.ok) {
        setPermissionError(result.reason);
        return;
      }
      navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((stream) => {
          beginRecording(stream);
        })
        .catch((err) => {
          console.error("[speech] Mic access denied:", err);
          setPermissionError(
            err instanceof Error
              ? err.message
              : "Microphone access was denied.",
          );
        });
    });
  }, []);

  const stopListening = useCallback(() => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    } else {
      setIsListening(false);
    }
  }, []);

  return {
    isSupported,
    isListening,
    isTranscribing,
    transcript,
    permissionError,
    sttError,
    startListening,
    stopListening,
    warmUp,
    coolDown,
  };
}
