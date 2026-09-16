/**
 * D091 Phase 2 — wizard orchestrator.
 *
 * Reducer-driven 12-screen flow with first-run / re-trigger
 * mode awareness. Owns:
 *   - the wizard's reducer state via `useWizardState`
 *   - one-shot HYDRATE on mount: getServerUrl + loadExistingProfile
 *     + listKeys + getConfigFlags → dispatch HYDRATE
 *   - per-screen orb-state mapping (drives `OrbCanvas`'s uIntensity)
 *   - per-screen narrator-audio manifest mapping
 *   - the cancel surface (closing the wizard window)
 *
 * Each screen receives (state, dispatch, serverUrl, api) via the
 * shared `ScreenProps` contract. Screens dispatch NEXT/BACK; the
 * reducer applies skip rules (Owner skipped on re-trigger;
 * Compiling skipped when no material field changed since hydration).
 *
 * Until HYDRATE fires we render <HydrationGate /> — just the orb +
 * brand. Without this, a renderer mounting briefly with INITIAL
 * state then re-rendering with hydrated state would flash a
 * first-run welcome at re-trigger users.
 */

import React, { useEffect, useMemo, useState } from "react";
import { OrbCanvas } from "./components/OrbCanvas";
import { ProgressDots } from "./components/ProgressDots";
import { NarratorAudio } from "./components/NarratorAudio";
import { useOrb } from "./hooks/useOrb";
import {
  useWizardState,
} from "./hooks/useWizardState";
import { AvatarScreen } from "./screens/AvatarScreen";
import { CompilingScreen } from "./screens/CompilingScreen";
import { NameScreen } from "./screens/NameScreen";
import { PersonalityScreen } from "./screens/PersonalityScreen";
import { PrivacyScreen } from "./screens/PrivacyScreen";
import { RevealScreen } from "./screens/RevealScreen";
import { VoiceScreen } from "./screens/VoiceScreen";
import { WelcomeScreen } from "./screens/WelcomeScreen";
import { WorkLifeScreen } from "./screens/WorkLifeScreen";
import {
  screenForOnboardingStartAt,
  type OnboardingAPI,
  type OnboardingConfigFlags,
  type OnboardingStartAt,
  type OrbState,
  type ProfileSnapshot,
  type ScreenId,
} from "./types";
import { useGenieCustomizationStyles } from "./styles";

// ---------------------------------------------------------------------------
// Screen → orb state map.
// ---------------------------------------------------------------------------

const SCREEN_ORB_STATE: Record<ScreenId, OrbState> = {
  0: "idle", // Welcome
  1: "idle", // Language
  2: "idle", // Privacy
  3: "idle", // WorkLife
  4: "idle", // Reserved: human setup removed from Genie onboarding
  5: "idle", // Personality
  6: "idle", // Name
  7: "compiling", // Compiling
  8: "idle", // Avatar
  9: "speaking", // Voice (during preview playback)
  10: "speaking", // Reveal (greets, then RevealScreen sets "hidden" pre-close)
};

// ---------------------------------------------------------------------------
// Screen → narrator audio manifest key map.
//
// The legacy audio manifest (packages/server/src/onboarding/audio/<lang>/)
// has files keyed by 1-based screen number from the OLD wizard ordering.
// D091 inserted, and D125 later removed, human owner setup from this wizard.
// Screen IDs no longer 1:1-match the old manifest names, so this map is the
// canonical re-binding.
// ---------------------------------------------------------------------------

const SCREEN_NARRATOR_KEY: Record<ScreenId, string | null> = {
  0: null,
  1: null, // Language screen skipped; UI language remains English for now.
  2: "02-privacy.mp3",
  3: "03-domain.mp3",
  4: null, // Reserved; navigation skips it.
  5: "04-personality.mp3",
  6: "07-name.mp3",
  7: "05-compiling.mp3",
  8: "06-avatar.mp3",
  9: "08-voice.mp3",
  10: null, // Reveal plays greeting via previewVoice IPC, not narrator track
};

// ---------------------------------------------------------------------------
// App component
// ---------------------------------------------------------------------------

type HydrationStatus =
  | { kind: "pending" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

export interface GenieCustomizationAppProps {
  /** Host-provided transport and lifecycle port; never read from a global. */
  api: OnboardingAPI | undefined;
}

export type HydrationPreparation =
  | {
      ok: true;
      serverUrl: string;
      profile: ProfileSnapshot | null;
      flags: OnboardingConfigFlags;
      startAt: OnboardingStartAt | null;
    }
  | { ok: false; error: string };

/** Hydration is authoritative: a profile read failure must never resemble a blank profile. */
export async function prepareOnboardingHydration(
  api: OnboardingAPI,
): Promise<HydrationPreparation> {
  try {
    const [serverUrl, profileRes, flagsRes, startAt] = await Promise.all([
      api.getServerUrl(),
      api.loadExistingProfile(),
      api.getConfigFlags(),
      api.getStartAt(),
    ]);
    if (!profileRes.ok) return { ok: false, error: profileRes.error };
    return {
      ok: true,
      serverUrl,
      profile: profileRes.data,
      flags: flagsRes.ok
        ? flagsRes.data
        : { avatarGenAvail: false, motherEasterEgg: false },
      startAt,
    };
  } catch {
    return { ok: false, error: "Couldn’t load your Genie profile. Please try again." };
  }
}

export function GenieCustomizationApp({ api }: GenieCustomizationAppProps): React.ReactElement {
  useGenieCustomizationStyles();
  const { state, dispatch } = useWizardState();
  const { orbState, setOrbState } = useOrb("idle");
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [hydration, setHydration] = useState<HydrationStatus>({ kind: "pending" });
  const [startAt, setStartAt] = useState<OnboardingStartAt | null>(null);
  const [personalitySaving, setPersonalitySaving] = useState(false);
  const [personalityStartedAt, setPersonalityStartedAt] = useState<number | null>(null);
  const [personalitySaveError, setPersonalitySaveError] = useState<string | null>(null);
  const [soulPreview, setSoulPreview] = useState("");
  const [soulStreaming, setSoulStreaming] = useState(false);
  const [soulStreamError, setSoulStreamError] = useState<string | null>(null);
  const [avatarSaving, setAvatarSaving] = useState(false);
  const [avatarSaveError, setAvatarSaveError] = useState<string | null>(null);

  // One-shot hydration: server URL + profile + keys + flags. Dispatched
  // as a single HYDRATE so screens see consistent state on first paint.
  useEffect(() => {
    if (!api) return;
    void (async () => {
      const prepared = await prepareOnboardingHydration(api);
      if (!prepared.ok) {
        setHydration({ kind: "error", message: prepared.error });
        return;
      }
      setServerUrl(prepared.serverUrl);
      setStartAt(prepared.startAt);
      dispatch({ type: "HYDRATE", profile: prepared.profile, flags: prepared.flags });
      const startScreen = screenForOnboardingStartAt(prepared.startAt);
      if (startScreen !== null) dispatch({ type: "JUMP", screen: startScreen });
      setHydration({ kind: "ready" });
    })();
  }, [api, dispatch]);

  // Screen change → push the matching orb state. Targeted soul regeneration
  // uses the compiling orb so a long one-screen flow does not look frozen.
  useEffect(() => {
    if (startAt === "personality" && personalitySaving) {
      setOrbState("compiling");
      return;
    }
    setOrbState(SCREEN_ORB_STATE[state.screen]);
  }, [personalitySaving, startAt, state.screen, setOrbState]);

  const narratorKey = SCREEN_NARRATOR_KEY[state.screen];

  const handlePersonalityOnlyContinue = useMemo(() => {
    if (startAt !== "personality") return undefined;
    return async () => {
      if (!api) return;
      setPersonalitySaving(true);
      setPersonalityStartedAt(Date.now());
      setPersonalitySaveError(null);
      setSoulPreview("");
      setSoulStreaming(false);
      setSoulStreamError(null);
      const unsubscribe = api.onSoulGenerationEvent?.((event) => {
        if (event.type === "started") {
          setSoulStreaming(true);
          return;
        }
        if (event.type === "delta") {
          setSoulPreview((current) => current + event.text);
          return;
        }
        if (event.type === "completed") {
          setSoulPreview(event.soulFile);
          setSoulStreaming(false);
          return;
        }
        setSoulStreamError(event.error);
        if (event.fallback) setSoulPreview(event.fallback);
        setSoulStreaming(false);
      });
      let res;
      try {
        res = await api.generateSoul({
          name: state.name || undefined,
          language: state.language,
          workLifeMode: state.workLifeChoice ?? undefined,
          privacySpectrum: state.privacySlider,
          personalityPrompt: state.personalityPrompt || undefined,
          motherAnswer: state.motherAnswer || undefined,
        });
      } finally {
        unsubscribe?.();
      }
      if (!res.ok) {
        setPersonalitySaving(false);
        setPersonalityStartedAt(null);
        setPersonalitySaveError(res.error);
        return;
      }
      const save = await api.putProfile({
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
        soulFile: res.data.soulFile,
        onboardingCompleted: true,
      });
      setPersonalitySaving(false);
      setPersonalityStartedAt(null);
      if (!save.ok) {
        setPersonalitySaveError(save.error);
        return;
      }
      await api.complete();
    };
  }, [api, startAt, state]);

  const handleAvatarOnlyContinue = useMemo(() => {
    if (startAt !== "avatar") return undefined;
    return async () => {
      if (!api) return;
      if (state.avatarChoice === null) {
        setAvatarSaveError("Pick an avatar first.");
        return;
      }
      setAvatarSaving(true);
      setAvatarSaveError(null);
      const save = await api.putProfile({
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
        soulFile: state.soulFile,
        onboardingCompleted: true,
      });
      setAvatarSaving(false);
      if (!save.ok) {
        setAvatarSaveError(save.error);
        return;
      }
      await api.complete();
    };
  }, [api, startAt, state]);

  const screenProps = useMemo(
    () => ({
      state,
      dispatch,
      serverUrl,
      api,
      onPersonalityContinue: handlePersonalityOnlyContinue,
      personalityContinueLabel:
        startAt === "personality" ? "Regenerate soul →" : undefined,
      personalityBusy: personalitySaving,
      personalityStartedAt,
      personalityError: personalitySaveError,
      soulPreview,
      soulStreaming,
      soulStreamError,
      onAvatarContinue: handleAvatarOnlyContinue,
      avatarContinueLabel: startAt === "avatar" ? "Save look →" : undefined,
      avatarBusy: avatarSaving,
      avatarError: avatarSaveError,
    }),
    [
      state,
      dispatch,
      serverUrl,
      api,
      handlePersonalityOnlyContinue,
      handleAvatarOnlyContinue,
      startAt,
      personalitySaving,
      personalityStartedAt,
      personalitySaveError,
      soulPreview,
      soulStreaming,
      soulStreamError,
      avatarSaving,
      avatarSaveError,
    ],
  );

  const orbSize = state.screen === 10 ? 240 : 180;
  const effectiveHydration: HydrationStatus = api
    ? hydration
    : {
        kind: "error",
        message: "Onboarding IPC bridge not available. Restart the app.",
      };

  return (
    <div className="genie-customization-host">
      <div style={styles.root}>
      <div style={styles.brand}>NAUTILO</div>

      <OrbCanvas orbState={orbState} size={orbSize} />

      {effectiveHydration.kind === "ready" && serverUrl && (
        <NarratorAudio
          manifestKey={narratorKey}
          language={state.language}
          serverUrl={serverUrl}
        />
      )}

      <div style={styles.screenSlot}>
        {effectiveHydration.kind === "pending" && (
          <div style={styles.gateHint}>Loading…</div>
        )}
        {effectiveHydration.kind === "error" && (
          <div style={styles.gateError}>
            <div>Couldn&apos;t open the wizard.</div>
            <div style={styles.gateErrorDetail}>{effectiveHydration.message}</div>
          </div>
        )}
        {effectiveHydration.kind === "ready" && renderScreen(state.screen, screenProps)}
      </div>

        {effectiveHydration.kind === "ready" && (
          <ProgressDots currentScreen={state.screen} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screen registry
// ---------------------------------------------------------------------------

type ScreenPropsArg = {
  state: ReturnType<typeof useWizardState>["state"];
  dispatch: ReturnType<typeof useWizardState>["dispatch"];
  serverUrl: string | null;
  api: OnboardingAPI | undefined;
};

function renderScreen(
  screen: ScreenId,
  props: ScreenPropsArg,
): React.ReactElement {
  switch (screen) {
    case 0:
      return <WelcomeScreen {...props} />;
    case 1:
      return <SkippedLanguageScreen {...props} />;
    case 2:
      return <PrivacyScreen {...props} />;
    case 3:
      return <WorkLifeScreen {...props} />;
    case 4:
      return <SkippedHumanSetupScreen {...props} />;
    case 5:
      return <PersonalityScreen {...props} />;
    case 6:
      return <NameScreen {...props} />;
    case 7:
      return <CompilingScreen {...props} />;
    case 8:
      return <AvatarScreen {...props} />;
    case 9:
      return <VoiceScreen {...props} />;
    case 10:
      return <RevealScreen {...props} />;
  }
}

function SkippedHumanSetupScreen({ dispatch }: ScreenPropsArg): React.ReactElement {
  useEffect(() => {
    dispatch({ type: "NEXT" });
  }, [dispatch]);
  return <div style={styles.gateHint}>Continuing…</div>;
}

function SkippedLanguageScreen({ dispatch }: ScreenPropsArg): React.ReactElement {
  useEffect(() => {
    dispatch({ type: "NEXT" });
  }, [dispatch]);
  return <div style={styles.gateHint}>Continuing…</div>;
}

// ---------------------------------------------------------------------------
// Welcome screen copy is intentionally generic. HYDRATE now gates
// downstream substeps from viewer flags rather than a client-side
// first-run/re-trigger mode discriminator, and WelcomeScreen renders
// before those flags are available. Per-entry-point copy can land
// later if product wants it.
// ---------------------------------------------------------------------------

const styles = {
  root: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "20px",
    padding: "32px 24px",
    width: "100%",
    maxWidth: "640px",
    // Vertically center when there's room, but degrade to top-anchored +
    // scrollable when the content is taller than the window (prevents the
    // top from being clipped — see #root overflow-y: auto in index.html).
    margin: "auto 0",
  } as React.CSSProperties,
  brand: {
    fontSize: "11px",
    letterSpacing: "5px",
    color: "var(--text-muted)",
    fontWeight: 600,
  } as React.CSSProperties,
  screenSlot: {
    flex: 1,
    width: "100%",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "320px",
  } as React.CSSProperties,
  gateHint: {
    fontSize: "13px",
    color: "var(--text-muted)",
  } as React.CSSProperties,
  gateError: {
    textAlign: "center" as const,
    color: "var(--error)",
    fontSize: "13px",
  } as React.CSSProperties,
  gateErrorDetail: {
    marginTop: "8px",
    fontSize: "11px",
    color: "var(--text-muted)",
  } as React.CSSProperties,
};
