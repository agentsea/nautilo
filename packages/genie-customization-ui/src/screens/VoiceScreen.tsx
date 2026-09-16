/**
 * D091 Phase 2 — screen 10 of 12: Voice.
 *
 * Hydrates the safe voice capability via getVoices. Only a configured
 * provider renders the curated catalog and ▶ preview controls. Clicking
 * preview calls previewVoice (TTS sample using the agent's
 * displayName), plays the returned audio inline, and the orchestrator
 * pushes the orb to "speaking" state during playback.
 *
 * D215 — optional catalog browser for broader multilingual voices;
 * curated grid remains the guided default.
 *
 * Re-trigger: pre-selects the user's existing voice if hydrated.
 *
 * Skip path: [Continue without voice] sets state.voiceSkipped → Reveal
 * suppresses greeting playback while retaining any existing assignment.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { SharedVoiceCatalogModal } from "@nautilo/voice-catalog-ui";
import { isGenieRecustomizeSession } from "../hooks/useWizardState";
import type {
  CatalogVoice,
  VoiceSelection,
} from "../types";
import type { ScreenProps } from "./_types";

const CURATED_SAMPLE_PHRASES: Record<string, string> = {
  en: "Hey - nice to meet you. [laughs] Okay, that sounded dramatic. But seriously, glad you're here.",
  es: "Hola, me alegra conocerte. [laughs] Vale, sonó un poco dramático. Pero en serio, me alegra que estés aquí.",
  fr: "Bonjour, ravi de te rencontrer. [laughs] D'accord, c'était un peu dramatique. Mais sérieusement, je suis content d'être là.",
  de: "Hallo, schön dich kennenzulernen. [laughs] Okay, das klang etwas dramatisch. Aber im Ernst, ich freue mich, hier zu sein.",
  ja: "こんにちは、はじめまして。[laughs] ちょっと大げさに聞こえたかもしれません。でも本当に、ここにいられてうれしいです。",
};

/** Curated row from `GET /api/voices` (includes optional language metadata). */
interface CuratedVoice extends VoiceSelection {
  language?: string | undefined;
  description?: string | undefined;
}

export interface VoiceCatalogState {
  loading: boolean;
  curated: CuratedVoice[];
  error: string | null;
  elevenLabsConfigured: boolean;
}

/** The Voice screen's local rendering state, derived only from the safe
 * hydration response. It deliberately has no "try the provider anyway" path. */
export type VoiceViewState =
  | "loading"
  | "configured"
  | "unconfigured"
  | "runtime-unavailable";

export function voiceViewStateForCatalog(catalog: VoiceCatalogState): VoiceViewState {
  if (catalog.loading) return "loading";
  if (catalog.error) return "runtime-unavailable";
  return catalog.elevenLabsConfigured ? "configured" : "unconfigured";
}

/** Single gate for every call that could reach the configured provider. */
export function canUseVoiceProvider(catalog: VoiceCatalogState): boolean {
  return voiceViewStateForCatalog(catalog) === "configured";
}

const VOICE_UNAVAILABLE_COPY = "Voice is unavailable right now. You can continue without voice.";

function unavailableCopy(viewState: VoiceViewState, hasExistingVoice: boolean): string {
  const retainNote = hasExistingVoice ? " Your current voice will stay unchanged." : "";
  if (viewState === "unconfigured") {
    return `Voice is optional. This Nautilo installation has no voice provider configured.${retainNote}`;
  }
  return `${VOICE_UNAVAILABLE_COPY}${retainNote}`;
}

/**
 * `GET /api/voices` curated entries expose `label` (and `description`);
 * the wizard's persisted shape uses `soulLabel` / `profileVoiceName`.
 */
function normalizeCuratedItem(v: {
  slug: string;
  voiceId: string;
  label?: string;
  soulLabel?: string;
  profileVoiceName?: string;
  previewUrl?: string | undefined;
  language?: string | undefined;
  description?: string | undefined;
}): CuratedVoice {
  const label = v.soulLabel ?? v.label ?? v.profileVoiceName ?? v.slug;
  return {
    slug: v.slug,
    voiceId: v.voiceId,
    profileVoiceName: v.profileVoiceName ?? v.label ?? v.slug,
    soulLabel: label,
    ...(v.previewUrl === undefined ? {} : { previewUrl: v.previewUrl }),
    ...(v.language === undefined ? {} : { language: v.language }),
    ...(v.description === undefined ? {} : { description: v.description }),
  };
}

function curatedLanguageBadge(language: string | undefined): string | null {
  if (!language) return null;
  return language.toUpperCase();
}

function resolveAudioUrl(raw: string, serverUrl: string | null): string {
  if (raw.startsWith("http://") || raw.startsWith("https://") || raw.startsWith("data:")) {
    return raw;
  }
  if (raw.startsWith("/") && serverUrl) return `${serverUrl}${raw}`;
  return raw;
}

function isExternalUrl(raw: string): boolean {
  return raw.startsWith("http://") || raw.startsWith("https://");
}

function samplePhraseForLanguage(language: string | undefined): string | undefined {
  if (!language) return undefined;
  return CURATED_SAMPLE_PHRASES[language.toLowerCase()];
}

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

function slugFromCatalogVoice(v: CatalogVoice): string {
  const fromName = v.name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
  return fromName || v.voiceId;
}

export function catalogVoiceToSelection(v: CatalogVoice): VoiceSelection {
  return {
    slug: slugFromCatalogVoice(v),
    voiceId: v.voiceId,
    profileVoiceName: v.name,
    soulLabel: v.name,
    ...(v.previewUrl === null ? {} : { previewUrl: v.previewUrl }),
  };
}

export function VoiceScreen({
  state,
  dispatch,
  api,
  serverUrl,
}: ScreenProps): React.ReactElement {
  const [catalog, setCatalog] = useState<VoiceCatalogState>({
    loading: true,
    curated: [],
    error: null,
    elevenLabsConfigured: false,
  });
  const isRecustomize = isGenieRecustomizeSession(state);
  /** Re-customize: show current choice first, or open full grid. */
  const [showPicker, setShowPicker] = useState(
    () => !isRecustomize || !state.voiceSelection,
  );
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioObjectUrlRef = useRef<string | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const pendingCatalogAssignmentRef = useRef<{
    voiceId: string;
    resolve: () => void;
    reject: (error: Error) => void;
    timeout: number;
  } | null>(null);

  const loadVoices = useCallback(async () => {
    setCatalog((current) => ({ ...current, loading: true, error: null }));
    if (!api) {
      setCatalog({
        loading: false,
        curated: [],
        error: VOICE_UNAVAILABLE_COPY,
        elevenLabsConfigured: false,
      });
      dispatch({ type: "SET_VOICE_CAPABILITY", capability: "runtime-unavailable" });
      return;
    }
    try {
      const res = await api.getVoices();
      if (res.ok) {
        const capability = res.data.elevenLabsConfigured ? "configured" : "unconfigured";
        setCatalog({
          loading: false,
          curated: res.data.curated.map(normalizeCuratedItem),
          error: null,
          elevenLabsConfigured: res.data.elevenLabsConfigured,
        });
        dispatch({ type: "SET_VOICE_CAPABILITY", capability });
      } else {
        setCatalog({
          loading: false,
          curated: [],
          error: VOICE_UNAVAILABLE_COPY,
          elevenLabsConfigured: false,
        });
        dispatch({ type: "SET_VOICE_CAPABILITY", capability: "runtime-unavailable" });
      }
    } catch {
      setCatalog({
        loading: false,
        curated: [],
        error: VOICE_UNAVAILABLE_COPY,
        elevenLabsConfigured: false,
      });
      dispatch({ type: "SET_VOICE_CAPABILITY", capability: "runtime-unavailable" });
    }
  }, [api, dispatch]);

  // One safe hydration request determines whether any provider operation may
  // be offered. Retrying remains user-initiated and never loops.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadVoices();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadVoices]);

  // Stop any in-flight playback when component unmounts.
  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      if (audioObjectUrlRef.current) URL.revokeObjectURL(audioObjectUrlRef.current);
      const pending = pendingCatalogAssignmentRef.current;
      if (pending) {
        window.clearTimeout(pending.timeout);
        pendingCatalogAssignmentRef.current = null;
      }
    };
  }, []);

  // The shared catalog closes only after the reducer has committed the exact
  // selected voice. Returning an already-resolved Promise here allowed the
  // modal to disappear before React had applied the selection update.
  useEffect(() => {
    const pending = pendingCatalogAssignmentRef.current;
    if (!pending || state.voiceSelection?.voiceId !== pending.voiceId) return;
    window.clearTimeout(pending.timeout);
    pendingCatalogAssignmentRef.current = null;
    pending.resolve();
  }, [state.voiceSelection?.voiceId]);

  const playAudioUrl = useCallback((voiceId: string, audioUrl: string) => {
    audioRef.current?.pause();
    if (audioObjectUrlRef.current) {
      URL.revokeObjectURL(audioObjectUrlRef.current);
      audioObjectUrlRef.current = null;
    }
    setPreviewError(null);
    setPlayingId(voiceId);
    void (async () => {
      try {
        const playable = playableAudioUrl(audioUrl);
        if (playable.revoke) audioObjectUrlRef.current = playable.url;
        const audio = new Audio(playable.url);
        audioRef.current = audio;
        const cleanupPlayableUrl = () => {
          if (playable.revoke && audioObjectUrlRef.current === playable.url) {
            URL.revokeObjectURL(playable.url);
            audioObjectUrlRef.current = null;
          }
        };
        audio.onended = () => {
          cleanupPlayableUrl();
          setPlayingId(null);
        };
        audio.onerror = () => {
          cleanupPlayableUrl();
          setPlayingId(null);
          setPreviewError("Could not play this voice preview.");
        };
        await audio.play();
      } catch {
        setPlayingId(null);
        setPreviewError("Could not play this voice preview.");
      }
    })();
  }, []);

  const markRuntimeUnavailable = useCallback(() => {
    setCatalog((current) => ({
      ...current,
      loading: false,
      error: VOICE_UNAVAILABLE_COPY,
    }));
    setCatalogOpen(false);
    dispatch({ type: "SET_VOICE_CAPABILITY", capability: "runtime-unavailable" });
  }, [dispatch]);

  const viewState = voiceViewStateForCatalog(catalog);
  const providerAvailable =
    canUseVoiceProvider(catalog) && state.voiceCapability === "configured";

  const handlePreview = useCallback(
    async (voice: VoiceSelection) => {
      if (!providerAvailable) return;
      audioRef.current?.pause();
      setPreviewError(null);
      setPlayingId(voice.voiceId);
      let failure: string | null = null;

      const rawPreviewUrl = voice.previewUrl ?? null;
      let audioUrl: string | null =
        rawPreviewUrl && !isExternalUrl(rawPreviewUrl) ?
          resolveAudioUrl(rawPreviewUrl, serverUrl)
        : null;

      if (!audioUrl && api) {
        const language =
          "language" in voice && typeof voice.language === "string" ?
            voice.language
          : undefined;
        try {
          const res = await api.previewVoice({
            voiceId: voice.voiceId,
            displayName: state.name || "Genie",
            text: samplePhraseForLanguage(language),
          });
          if (res.ok) {
            audioUrl = res.data.audioUrl;
          } else {
            failure = "Could not load this voice preview.";
            setPreviewError(failure);
            markRuntimeUnavailable();
          }
        } catch {
          failure = "Could not load this voice preview.";
          setPreviewError(failure);
          markRuntimeUnavailable();
        }
      }

      if (!audioUrl) {
        setPlayingId(null);
        setPreviewError(failure ?? "No preview is available for this voice.");
        return;
      }
      playAudioUrl(voice.voiceId, audioUrl);
    },
    [api, markRuntimeUnavailable, playAudioUrl, providerAvailable, serverUrl, state.name],
  );

  const handleSelect = useCallback(
    (voice: VoiceSelection) => {
      dispatch({ type: "SET_VOICE", selection: voice });
    },
    [dispatch],
  );

  const handleUseCatalogVoice = useCallback(
    (voice: CatalogVoice): Promise<void> => {
      if (!providerAvailable) {
        return Promise.reject(new Error(VOICE_UNAVAILABLE_COPY));
      }
      audioRef.current?.pause();
      setPlayingId(null);
      const selection = catalogVoiceToSelection(voice);
      const previous = pendingCatalogAssignmentRef.current;
      if (previous) {
        window.clearTimeout(previous.timeout);
        previous.reject(new Error("Choose one voice at a time."));
      }
      return new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          const pending = pendingCatalogAssignmentRef.current;
          if (!pending || pending.voiceId !== selection.voiceId) return;
          pendingCatalogAssignmentRef.current = null;
          reject(new Error("Could not select this voice. Try again."));
        }, 2_000);
        pendingCatalogAssignmentRef.current = {
          voiceId: selection.voiceId,
          resolve,
          reject,
          timeout,
        };
        dispatch({ type: "SET_VOICE", selection });
      });
    },
    [dispatch, providerAvailable],
  );

  const handleSkip = useCallback(() => {
    audioRef.current?.pause();
    dispatch({ type: "SKIP_VOICE" });
    dispatch({ type: "NEXT" });
  }, [dispatch]);
  const handleNext = useCallback(() => {
    audioRef.current?.pause();
    dispatch({ type: "NEXT" });
  }, [dispatch]);
  const handleBack = useCallback(() => {
    audioRef.current?.pause();
    dispatch({ type: "BACK" });
  }, [dispatch]);

  const canContinue = providerAvailable && state.voiceSelection !== null;
  const showCurrent =
    providerAvailable && isRecustomize && state.voiceSelection && !showPicker;
  const selectedVoiceIsCurated =
    state.voiceSelection !== null &&
    catalog.curated.some((voice) => voice.voiceId === state.voiceSelection?.voiceId);
  const hasExistingVoice = state.hydratedSnapshot?.voiceSelection !== null;
  const continueWithoutVoiceLabel = hasExistingVoice
    ? "Continue without changing voice →"
    : "Continue without voice →";

  return (
    <div style={styles.root}>
      <div style={styles.main}>
        <h2 style={styles.headline}>What do I sound like?</h2>
        <p style={styles.subhead}>
          {viewState === "unconfigured" || viewState === "runtime-unavailable"
            ? "You can finish without choosing a voice."
            : showCurrent
            ? "You already have a voice. Keep it or pick a new one."
            : "Tap each one. Pick what feels right."}
        </p>

        {viewState === "loading" && <div style={styles.loading}>Checking voice options…</div>}
        {viewState === "unconfigured" && (
          <div style={styles.unavailable}>{unavailableCopy(viewState, hasExistingVoice)}</div>
        )}
        {viewState === "runtime-unavailable" && (
          <div style={styles.unavailable}>{unavailableCopy(viewState, hasExistingVoice)}</div>
        )}

        {showCurrent && state.voiceSelection && (
          <div style={styles.currentBlock}>
            <div
              style={{
                ...styles.card,
                ...styles.currentCard,
                ...styles.cardSelected,
              }}
            >
              <div style={styles.cardText}>
                <div style={styles.cardName}>{state.voiceSelection.soulLabel}</div>
              </div>
              <div
                role="button"
                aria-label={`Preview ${state.voiceSelection.soulLabel}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void handlePreview(state.voiceSelection!);
                }}
                style={styles.previewButton}
              >
                {playingId === state.voiceSelection.voiceId ? "■" : "▶"}
              </div>
            </div>
            <div style={styles.currentActions}>
              <button type="button" onClick={handleNext} style={styles.primary}>
                Keep this voice
              </button>
              <button
                type="button"
                onClick={() => setShowPicker(true)}
                style={styles.secondary}
              >
                Pick something else
              </button>
            </div>
          </div>
        )}

        {showCurrent && previewError && (
          <div style={styles.previewError}>{previewError}</div>
        )}

        {providerAvailable && showPicker && (
          <>
            {state.voiceSelection && !selectedVoiceIsCurated && (
              <div style={styles.catalogSelection} aria-live="polite">
                <div style={{ ...styles.card, ...styles.cardSelected }}>
                  <div style={styles.cardText}>
                    <div style={styles.cardName}>{state.voiceSelection.soulLabel}</div>
                    <div style={styles.cardDescription}>Selected from the full catalog</div>
                  </div>
                  <div
                    role="button"
                    aria-label={`Preview ${state.voiceSelection.soulLabel}`}
                    onClick={() => void handlePreview(state.voiceSelection!)}
                    style={styles.previewButton}
                  >
                    {playingId === state.voiceSelection.voiceId ? "■" : "▶"}
                  </div>
                </div>
              </div>
            )}
            <div style={styles.grid}>
              {catalog.curated.map((voice) => {
                const selected = state.voiceSelection?.voiceId === voice.voiceId;
                const playing = playingId === voice.voiceId;
                const languageBadge = curatedLanguageBadge(voice.language);
                return (
                  <button
                    key={voice.voiceId}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => handleSelect(voice)}
                    style={{
                      ...styles.card,
                      ...(selected ? styles.cardSelected : null),
                    }}
                  >
                    <div style={styles.cardText}>
                      <div style={styles.cardNameRow}>
                        <span style={styles.cardName}>{voice.soulLabel}</span>
                        {languageBadge && (
                          <span style={styles.languageBadge}>{languageBadge}</span>
                        )}
                      </div>
                      {voice.description && (
                        <div style={styles.cardDescription}>{voice.description}</div>
                      )}
                    </div>
                    <div
                      role="button"
                      aria-label={`Preview ${voice.soulLabel}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        void handlePreview(voice);
                      }}
                      style={styles.previewButton}
                    >
                      {playing ? "■" : "▶"}
                    </div>
                  </button>
                );
              })}
            </div>

            {previewError && <div style={styles.previewError}>{previewError}</div>}

            <div style={styles.escapeHatch}>
              <span style={styles.escapePrompt}>Want another voice or language?</span>
              <button
                type="button"
                onClick={() => setCatalogOpen(true)}
                style={styles.linkButton}
              >
                Browse more voices and languages
              </button>
              <span style={styles.escapeNote}>
                This changes how your Genie speaks, not the app language.
              </span>
            </div>
          </>
        )}
      </div>

      {providerAvailable && (
        <SharedVoiceCatalogModal
        open={catalogOpen}
        onClose={() => setCatalogOpen(false)}
        loadCatalog={async (query) => {
          if (!api || !providerAvailable) throw new Error(VOICE_UNAVAILABLE_COPY);
          try {
            const response = await api.listVoiceCatalog(query);
            if (response.ok) return response.data;
            markRuntimeUnavailable();
            throw new Error(VOICE_UNAVAILABLE_COPY);
          } catch (error) {
            if (!(error instanceof Error) || error.message !== VOICE_UNAVAILABLE_COPY) {
              markRuntimeUnavailable();
            }
            throw new Error(VOICE_UNAVAILABLE_COPY);
          }
        }}
        previewVoice={async (voice, source) => {
          if (!api || !providerAvailable) return null;
          void source;
          try {
            const response = await api.previewVoice({
              voiceId: voice.voiceId,
              displayName: state.name || "Genie",
              text: samplePhraseForLanguage(voice.language),
            });
            if (response.ok) return response.data.audioUrl;
            markRuntimeUnavailable();
            throw new Error("Could not load this voice preview.");
          } catch (error) {
            if (!(error instanceof Error) || error.message !== "Could not load this voice preview.") {
              markRuntimeUnavailable();
            }
            throw new Error("Could not load this voice preview.");
          }
        }}
        assignVoice={(voice) => handleUseCatalogVoice(voice)}
        generatedSampleLabel={() => ({ label: "Generate Genie sample" })}
        />
      )}

      <div style={styles.actions}>
        <button type="button" onClick={handleBack} style={styles.secondary}>
          Back
        </button>
        {viewState === "runtime-unavailable" && (
          <button type="button" onClick={() => void loadVoices()} style={styles.secondary}>
            Retry voice options
          </button>
        )}
        {!showCurrent && viewState !== "loading" && (
          <button
            type="button"
            onClick={handleSkip}
            style={providerAvailable ? styles.secondary : styles.primary}
          >
            {continueWithoutVoiceLabel}
          </button>
        )}
        {providerAvailable && showPicker && (
          <button
            type="button"
            onClick={handleNext}
            disabled={!canContinue}
            style={{
              ...styles.primary,
              opacity: canContinue ? 1 : 0.4,
              cursor: canContinue ? "pointer" : "not-allowed",
            }}
          >
            Continue →
          </button>
        )}
      </div>
    </div>
  );
}

const styles = {
  root: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "8px",
    textAlign: "center",
    maxWidth: "560px",
    width: "100%",
    flex: 1,
    minHeight: 0,
  } as React.CSSProperties,
  main: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "8px",
    width: "100%",
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
  } as React.CSSProperties,
  headline: {
    margin: 0,
    fontSize: "22px",
    fontWeight: 600,
  } as React.CSSProperties,
  subhead: {
    margin: "0 0 6px",
    color: "var(--text-muted)",
    fontSize: "13px",
    lineHeight: 1.35,
  } as React.CSSProperties,
  loading: {
    fontSize: "12px",
    color: "var(--text-muted)",
    margin: "4px 0",
  } as React.CSSProperties,
  error: {
    fontSize: "12px",
    color: "var(--error)",
    margin: "4px 0",
  } as React.CSSProperties,
  unavailable: {
    maxWidth: "440px",
    margin: "8px 0",
    color: "var(--text-muted)",
    fontSize: "13px",
    lineHeight: 1.45,
  } as React.CSSProperties,
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: "6px",
    width: "100%",
  } as React.CSSProperties,
  card: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "6px",
    width: "100%",
    padding: "6px 8px",
    background: "var(--bg-panel)",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-sm)",
    cursor: "pointer",
    color: "var(--text)",
    transition: "border-color 120ms ease",
    textAlign: "left",
    minWidth: 0,
    boxSizing: "border-box",
  } as React.CSSProperties,
  cardSelected: {
    borderColor: "var(--border-active)",
    background: "var(--bg-panel-hover)",
  } as React.CSSProperties,
  catalogSelection: {
    width: "100%",
    marginBottom: "2px",
  } as React.CSSProperties,
  cardText: {
    flex: 1,
    minWidth: 0,
  } as React.CSSProperties,
  cardNameRow: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    minWidth: 0,
  } as React.CSSProperties,
  cardName: {
    fontSize: "12px",
    fontWeight: 600,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } as React.CSSProperties,
  cardDescription: {
    marginTop: "1px",
    fontSize: "10px",
    color: "var(--text-muted)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } as React.CSSProperties,
  languageBadge: {
    flexShrink: 0,
    padding: "1px 4px",
    borderRadius: "3px",
    border: "1px solid var(--border)",
    background: "var(--bg)",
    color: "var(--text-muted)",
    fontSize: "9px",
    fontWeight: 700,
    letterSpacing: "0.03em",
  } as React.CSSProperties,
  previewButton: {
    width: "26px",
    height: "26px",
    borderRadius: "50%",
    background: "var(--bg)",
    border: "1px solid var(--border)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "10px",
    color: "var(--text-muted)",
    cursor: "pointer",
    flexShrink: 0,
  } as React.CSSProperties,
  previewError: {
    width: "100%",
    margin: "-2px 0 2px",
    color: "var(--error)",
    fontSize: "12px",
    textAlign: "center",
  } as React.CSSProperties,
  actions: {
    display: "flex",
    gap: "10px",
    alignItems: "center",
    flexShrink: 0,
    marginTop: "auto",
    paddingTop: "6px",
  } as React.CSSProperties,
  primary: {
    padding: "9px 20px",
    borderRadius: "var(--radius-sm)",
    border: "none",
    background: "var(--accent)",
    color: "var(--on-accent)",
    fontWeight: 600,
    fontSize: "13px",
  } as React.CSSProperties,
  secondary: {
    padding: "9px 16px",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border)",
    background: "var(--bg-panel)",
    color: "var(--text-muted)",
    fontSize: "12px",
    cursor: "pointer",
  } as React.CSSProperties,
  currentBlock: {
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    gap: "10px",
    width: "100%",
  } as React.CSSProperties,
  currentCard: {
    width: "100%",
  } as React.CSSProperties,
  currentActions: {
    display: "flex",
    flexWrap: "wrap",
    gap: "8px",
    alignItems: "center",
    justifyContent: "center",
  } as React.CSSProperties,
  escapeHatch: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "4px",
    width: "100%",
    paddingTop: "2px",
  } as React.CSSProperties,
  escapePrompt: {
    margin: 0,
    fontSize: "12px",
    color: "var(--text-muted)",
  } as React.CSSProperties,
  escapeNote: {
    margin: 0,
    fontSize: "11px",
    color: "var(--text-muted)",
    maxWidth: "420px",
    lineHeight: 1.3,
  } as React.CSSProperties,
  linkButton: {
    padding: "5px 10px",
    borderRadius: "var(--radius-sm)",
    border: "1px dashed var(--border)",
    background: "transparent",
    color: "var(--accent)",
    fontSize: "12px",
    fontWeight: 600,
    cursor: "pointer",
  } as React.CSSProperties,
};
