/**
 * D091 Phase 2 — screen 11 of 12: Reveal.
 *
 * Final screen. Three things in sequence:
 *   1. Assemble the profile-write payload from state.
 *   2. PUT /api/profile (sets onboardingCompleted: true).
 *   3. Greet the user via TTS preview using their chosen voice.
 *      Only attempted for a newly selected voice while the provider is
 *      currently configured.
 *
 * After the greeting (or skip-greeting path), [Done] dispatches
 * onboarding:complete which closes the wizard window and lets
 * boot() proceed to the workbench (first-run) or the workbench
 * window unhides (re-trigger).
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  isGenieRecustomizeSession,
  usableNewVoiceSelection,
} from "../hooks/useWizardState";
import { persistRevealProfile } from "./reveal-persistence";
import type { ProfileWrite } from "../types";
import type { ScreenProps } from "./_types";

// M087 — auto-detect the user's IANA timezone for persistence on the
// onboarding profile write. Falls back to "UTC" if the runtime can't
// resolve one (the server validates + drops invalid values anyway).
function detectIanaTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

type RevealPhase =
  | "writing"
  | "greeting"
  | "ready"
  | "completing"
  | "error";

function playableAudioUrl(rawUrl: string): { url: string; revoke: boolean } {
  if (!rawUrl.startsWith("data:")) return { url: rawUrl, revoke: false };
  const [meta = "", base64 = ""] = rawUrl.split(",", 2);
  const mime = /^data:([^;]+)/.exec(meta)?.[1] ?? "audio/mpeg";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: mime });
  return { url: URL.createObjectURL(blob), revoke: true };
}

function buildSoulInput(state: ScreenProps["state"]) {
  return {
    name: state.name || undefined,
    language: state.language,
    workLifeMode: state.workLifeChoice ?? undefined,
    privacySpectrum: state.privacySlider,
    personalityPrompt: state.personalityPrompt || undefined,
    motherAnswer: state.motherAnswer || undefined,
  };
}

/**
 * Test seam for non-linear flows that reach Reveal without having started soul
 * generation. Reveal may enqueue the work, but final profile persistence never
 * waits for the model request.
 */
export function shouldStartSoulGenerationAtReveal(state: ScreenProps["state"]): boolean {
  return state.compilingPhase === "idle" && state.soulFile === null;
}

export function RevealScreen({
  state,
  api,
}: ScreenProps): React.ReactElement {
  const [phase, setPhase] = useState<RevealPhase>("writing");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [greetingAudioUrl, setGreetingAudioUrl] = useState<string | null>(null);
  const lateSoulStartedRef = useRef(false);
  const profileWriteStartedRef = useRef(false);

  const isRecustomize = isGenieRecustomizeSession(state);

  const newlyUsableVoice = usableNewVoiceSelection(state);

  // Step 1 + 2: write profile, then optionally greet.
  useEffect(() => {
    if (phase !== "writing") return;
    if (!api) return;
    // The model request can take a minute or more. Desktop owns it after IPC
    // dispatch and persists the result when it finishes, even if this window
    // has already closed. Never turn that background work into a save blocker.
    if (shouldStartSoulGenerationAtReveal(state) && !lateSoulStartedRef.current) {
      lateSoulStartedRef.current = true;
      void api.generateSoul(buildSoulInput(state)).catch(() => undefined);
    }
    if (profileWriteStartedRef.current) return;
    if (!state.voiceSelection && !state.voiceSkipped) {
      // A null voice is valid only when the user explicitly skipped voice.
      queueMicrotask(() => {
        setPhase("error");
        setError("No voice selection on profile write — this is a bug.");
      });
      return;
    }
    const payload: ProfileWrite = {
      name: state.name || "Genie",
      language: state.language,
      workLifeMode: state.workLifeChoice,
      privacySpectrum: state.privacySlider,
      personalityPrompt: state.personalityPrompt || null,
      motherAnswer: state.motherAnswer || null,
      voiceId: null,
      voiceName: null,
      avatarTarget: state.avatarTarget,
      avatarUrl: state.avatarChoice,
      ...(state.soulFile !== null ? { soulFile: state.soulFile } : {}),
      onboardingCompleted: true,
      // M087 — auto-detected IANA timezone; server persists to users.timezone.
      timezone: detectIanaTimezone(),
    };
    profileWriteStartedRef.current = true;
    void (async () => {
      const res = await persistRevealProfile(api, payload, newlyUsableVoice);
      if (!res.ok) {
        profileWriteStartedRef.current = false;
        setError(res.error);
        setPhase("error");
        return;
      }
      setNotice(res.notice);
      if (res.voice === "assigned") {
        setGreetingAudioUrl(res.greetingAudioUrl);
        setPhase("greeting");
      } else {
        setPhase("ready");
      }
    })();
  }, [phase, api, state, newlyUsableVoice]);

  // Step 2.5: greeting playback.
  useEffect(() => {
    if (phase !== "greeting" || !greetingAudioUrl) return;
    (() => {
      try {
        const playable = playableAudioUrl(greetingAudioUrl);
        const audio = new Audio(playable.url);
        audio.onended = () => setPhase("ready");
        audio.onerror = () => {
          if (playable.revoke) URL.revokeObjectURL(playable.url);
          setPhase("ready");
        };
        void audio.play().catch(() => {
          if (playable.revoke) URL.revokeObjectURL(playable.url);
          setPhase("ready");
        });
        if (playable.revoke) audio.onended = () => {
          URL.revokeObjectURL(playable.url);
          setPhase("ready");
        };
      } catch {
        setPhase("ready");
      }
    })();
  }, [phase, greetingAudioUrl]);

  const handleDone = useCallback(async () => {
    if (!api || phase !== "ready") return;
    setPhase("completing");
    await api.complete();
    // Window closes; this component unmounts. No further state to set.
  }, [api, phase]);

  const isFirstCustomization = !isRecustomize;
  const greeting = isFirstCustomization
    ? `Hi, I'm ${state.name || "Genie"}.`
    : `Updated.`;
  const sub = isFirstCustomization
    ? "Nice to meet you. Let's get to work."
    : "Talk to you in a sec.";

  return (
    <div style={styles.root}>
      {phase === "error" ? (
        <>
          <h2 style={styles.headline}>Hmm, that didn&apos;t save.</h2>
          <p style={styles.subhead}>{error}</p>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setPhase("writing");
            }}
            style={styles.primary}
          >
            Try again →
          </button>
        </>
      ) : (
        <>
          <h2 style={styles.headline}>
            {phase === "writing" ? "Saving…" : greeting}
          </h2>
          {phase !== "writing" && (
            <p style={styles.subhead}>{notice ?? sub}</p>
          )}
          {phase === "ready" && (
            <button
              type="button"
              onClick={() => {
                void handleDone();
              }}
              style={styles.primary}
              autoFocus
            >
              Done →
            </button>
          )}
          {phase === "completing" && (
            <div style={styles.subhead}>Closing…</div>
          )}
        </>
      )}
    </div>
  );
}

const styles = {
  root: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "16px",
    textAlign: "center",
    maxWidth: "440px",
    width: "100%",
  } as React.CSSProperties,
  headline: {
    margin: 0,
    fontSize: "32px",
    fontWeight: 600,
    letterSpacing: "-0.5px",
  } as React.CSSProperties,
  subhead: {
    margin: "8px 0 16px",
    color: "var(--text-muted)",
    fontSize: "15px",
    lineHeight: 1.5,
  } as React.CSSProperties,
  primary: {
    padding: "12px 28px",
    borderRadius: "var(--radius-sm)",
    border: "none",
    background: "var(--accent)",
    color: "var(--on-accent)",
    fontWeight: 600,
    fontSize: "14px",
    cursor: "pointer",
  } as React.CSSProperties,
};
