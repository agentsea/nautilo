/**
 * D091 Phase 2 — screen 9 of 12: Avatar.
 *
 * Two avatar sources: presets (curated grid) and DALL·E generation
 * (conditional on `state.flags.avatarGenAvail`).
 *
 * Re-trigger UX: existing avatar displayed at top with a "Keep
 * this one" / "Pick something else" toggle. The latter reveals the
 * full first-run picker below.
 *
 * Preset thumbnails are served by the Nautilo server from
 * `/api/onboarding/images/avatars/*.webp`.
 */

import React, { useCallback, useMemo, useState } from "react";
import { isGenieRecustomizeSession } from "../hooks/useWizardState";
import type { ScreenProps } from "./_types";
import type { AvatarSelectionTarget } from "../types";

/**
 * Resolve a stored avatar URL to a fetchable URL inside the wizard.
 *
 * Why: the wizard's HTML loads from `file://`, so a server-relative
 * path like `/api/onboarding/images/avatars/avatar-03.webp` would
 * resolve as `file:///api/...` and 404. Server-relative paths need
 * the server URL prepended; absolute (`http://`, `https://`,
 * `data:`, `blob:`) URLs pass through unchanged so generated avatar
 * previews work without modification.
 */
export function resolveAvatarSrc(
  raw: string | null,
  serverUrl: string | null,
): string | undefined {
  if (!raw) return undefined;
  if (
    raw.startsWith("http://") ||
    raw.startsWith("https://") ||
    raw.startsWith("data:") ||
    raw.startsWith("blob:")
  ) {
    return raw;
  }
  if (raw.startsWith("/") && serverUrl) {
    return `${serverUrl}${raw}`;
  }
  // Relative path with no server URL yet — defer rendering.
  return undefined;
}

const PRESET_AVATARS = [
  "/api/onboarding/images/avatars/avatar-01.webp",
  "/api/onboarding/images/avatars/avatar-02.webp",
  "/api/onboarding/images/avatars/avatar-03.webp",
  "/api/onboarding/images/avatars/avatar-04.webp",
  "/api/onboarding/images/avatars/avatar-05.webp",
  "/api/onboarding/images/avatars/avatar-06.webp",
  "/api/onboarding/images/avatars/avatar-07.webp",
  "/api/onboarding/images/avatars/avatar-09.webp",
  "/api/onboarding/images/avatars/avatar-10.webp",
  "/api/onboarding/images/avatars/avatar-11.webp",
  "/api/onboarding/images/avatars/avatar-12.webp",
  "/api/onboarding/images/avatars/avatar-13.webp",
  "/api/onboarding/images/avatars/avatar-14.webp",
  "/api/onboarding/images/avatars/avatar-15.webp",
  "/api/onboarding/images/avatars/avatar-16.webp",
  "/api/onboarding/images/avatars/avatar-17.webp",
  "/api/onboarding/images/avatars/avatar-18.webp",
  "/api/onboarding/images/avatars/avatar-19.webp",
  "/api/onboarding/images/avatars/avatar-20.webp",
  "/api/onboarding/images/avatars/avatar-21.webp",
  "/api/onboarding/images/avatars/avatar-22.webp",
  "/api/onboarding/images/avatars/avatar-23.webp",
  "/api/onboarding/images/avatars/avatar-24.webp",
  "/api/onboarding/images/avatars/avatar-25.webp",
  "/api/onboarding/images/avatars/avatar-26.webp",
  "/api/onboarding/images/avatars/avatar-27.webp",
  "/api/onboarding/images/avatars/avatar-28.webp",
  "/api/onboarding/images/avatars/avatar-29.webp",
  "/api/onboarding/images/avatars/avatar-30.webp",
  "/api/onboarding/images/avatars/avatar-31.webp",
  "/api/onboarding/images/avatars/avatar-32.webp",
  "/api/onboarding/images/avatars/avatar-33.webp",
  "/api/onboarding/images/avatars/avatar-34.webp",
  "/api/onboarding/images/avatars/avatar-35.webp",
  "/api/onboarding/images/avatars/avatar-36.webp",
  "/api/onboarding/images/avatars/avatar-37.webp",
  "/api/onboarding/images/avatars/avatar-38.webp",
  "/api/onboarding/images/avatars/avatar-39.webp",
  "/api/onboarding/images/avatars/avatar-40.webp",
  "/api/onboarding/images/avatars/avatar-41.webp",
];

const AVATAR_PAGE_SIZE = 8;

function shuffle<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

export function AvatarScreen({
  state,
  dispatch,
  api,
  serverUrl,
  onAvatarContinue,
  avatarContinueLabel = "Continue →",
  avatarBusy = false,
  avatarError = null,
}: ScreenProps): React.ReactElement {
  const isRecustomize = isGenieRecustomizeSession(state);
  const [showPicker, setShowPicker] = useState(!isRecustomize);
  const [avatarOrder, setAvatarOrder] = useState<string[]>(() => PRESET_AVATARS);
  const [avatarPage, setAvatarPage] = useState(0);
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [generatePrompt, setGeneratePrompt] = useState("");
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const [generatedTarget, setGeneratedTarget] = useState<AvatarSelectionTarget | null>(null);
  const [generatedPartialIndex, setGeneratedPartialIndex] = useState<number | null>(null);
  const [loadedGeneratedUrl, setLoadedGeneratedUrl] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [currentLoadFailed, setCurrentLoadFailed] = useState(false);

  const pageCount = Math.max(1, Math.ceil(avatarOrder.length / AVATAR_PAGE_SIZE));
  const pagedAvatars = useMemo(() => {
    const start = avatarPage * AVATAR_PAGE_SIZE;
    return avatarOrder.slice(start, start + AVATAR_PAGE_SIZE);
  }, [avatarOrder, avatarPage]);

  const handleSelectPreset = useCallback(
    (url: string) => {
      const presetId = /\/(avatar-[0-9]{2})\.webp$/.exec(url)?.[1];
      if (!presetId) return;
      dispatch({
        type: "SET_AVATAR",
        source: "preset",
        url,
        target: { kind: "preset", presetId },
      });
    },
    [dispatch],
  );

  const handleGenerate = useCallback(async () => {
    if (!api || generating) return;
    if (!state.flags.avatarGenAvail) {
      setGenError("Image generation needs a compatible provider configured on the server.");
      return;
    }
    const prompt = generatePrompt.trim();
    if (!prompt) {
      setGenError("Describe what your Genie should look like.");
      return;
    }
    setGenerating(true);
    setGenError(null);
    setGeneratedUrl(null);
    setGeneratedTarget(null);
    setGeneratedPartialIndex(null);
    setLoadedGeneratedUrl(null);
    const unsubscribe = api.onAvatarGenerationEvent?.((event) => {
      if (event.type === "partial") {
        setGeneratedUrl(event.avatarUrl);
        setGeneratedPartialIndex(event.partialImageIndex + 1);
        return;
      }
      if (event.type === "completed") {
        setGeneratedUrl(event.avatarUrl);
        setGeneratedTarget(event.target);
        setGeneratedPartialIndex(null);
        return;
      }
      setGenError(event.detail ?? event.error);
    });
    try {
      const res = await api.generateAvatar({ prompt });
      if (res.ok) {
        setGeneratedUrl(res.data.avatarUrl);
        setGeneratedTarget(res.data.target);
        setGeneratedPartialIndex(null);
      } else {
        setGenError(res.error);
      }
    } finally {
      unsubscribe?.();
      setGenerating(false);
    }
  }, [api, generatePrompt, generating, state.flags.avatarGenAvail]);

  const generatedPreviewLoaded =
    generatedUrl !== null && loadedGeneratedUrl === generatedUrl;

  const handleUseGenerated = useCallback(() => {
    if (!generatedUrl || !generatedTarget || !generatedPreviewLoaded) return;
    dispatch({
      type: "SET_AVATAR",
      source: "generated",
      url: generatedUrl,
      target: generatedTarget,
    });
    setCurrentLoadFailed(false);
    setShowGenerateModal(false);
  }, [dispatch, generatedPreviewLoaded, generatedTarget, generatedUrl]);

  const handleShuffle = useCallback(() => {
    setAvatarOrder(shuffle(PRESET_AVATARS));
    setAvatarPage(0);
  }, []);

  const handleNext = useCallback(() => {
    if (onAvatarContinue) {
      void onAvatarContinue();
      return;
    }
    dispatch({ type: "NEXT" });
  }, [dispatch, onAvatarContinue]);
  const handleBack = useCallback(() => {
    if (onAvatarContinue) {
      void api?.cancel();
      return;
    }
    const hydratedSnapshot = state.hydratedSnapshot;
    const existingAvatar = hydratedSnapshot?.avatarChoice;
    if (isRecustomize && showPicker && existingAvatar && hydratedSnapshot) {
      dispatch({
        type: "SET_AVATAR",
        source: hydratedSnapshot.avatarSource ?? "preset",
        url: existingAvatar,
        avatar: hydratedSnapshot.avatarRef,
        target: null,
      });
      setShowPicker(false);
      return;
    }
    dispatch({ type: "BACK" });
  }, [api, dispatch, isRecustomize, onAvatarContinue, showPicker, state.hydratedSnapshot]);

  const canContinue = state.avatarChoice !== null;
  const showCurrent = isRecustomize && state.avatarChoice && !showPicker;
  const currentSrc = resolveAvatarSrc(state.avatarChoice, serverUrl);
  const isTargetedFlow = Boolean(onAvatarContinue);

  return (
    <div style={styles.root}>
      <h2 style={styles.headline}>What do you look like?</h2>
      <p style={styles.subhead}>Pick one. Or make your own.</p>

      {showCurrent && (
        <div style={styles.currentBlock}>
          {currentSrc && !currentLoadFailed ? (
            <img
              src={currentSrc}
              alt="Current"
              style={styles.currentImg}
              onError={() => setCurrentLoadFailed(true)}
            />
          ) : (
            <div style={styles.currentMissing} role="img" aria-label="Avatar unavailable">
              ?
            </div>
          )}
          {currentLoadFailed && (
            <div style={styles.currentMissingHint}>
              Couldn&apos;t load your current avatar. Pick a new one.
            </div>
          )}
          <div style={styles.currentActions}>
            <button
              type="button"
              onClick={handleNext}
              disabled={currentLoadFailed || avatarBusy}
              style={{
                ...styles.primary,
                opacity: currentLoadFailed || avatarBusy ? 0.4 : 1,
                cursor:
                  currentLoadFailed || avatarBusy ? "not-allowed" : "pointer",
              }}
            >
              {avatarBusy ? "Saving…" : "Keep this one"}
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

      {showPicker && currentSrc && (
        <div style={styles.pickBlock}>
          <div style={styles.pickLabel}>Your pick</div>
          <img
            src={currentSrc}
            alt="Selected avatar"
            style={styles.pickImg}
            onError={() => setCurrentLoadFailed(true)}
          />
          {state.avatarSource === "generated" && (
            <div style={styles.pickHint}>Generated — pick another below to change it.</div>
          )}
        </div>
      )}

      {showPicker && (
        <>
          <div style={styles.presetGrid}>
            {pagedAvatars.map((url, idx) => {
              const src = resolveAvatarSrc(url, serverUrl);
              const selected =
                state.avatarSource === "preset" && state.avatarChoice === url;
              const absoluteIdx = avatarPage * AVATAR_PAGE_SIZE + idx + 1;
              return (
                <button
                  key={url}
                  type="button"
                  onClick={() => handleSelectPreset(url)}
                  aria-label={`Preset ${absoluteIdx}`}
                  style={{
                    ...styles.presetButton,
                    borderColor: selected
                      ? "var(--border-active)"
                      : "var(--border)",
                  }}
                >
                  {src ? (
                    <img src={src} alt="" style={styles.presetImg} />
                  ) : (
                    <span style={styles.presetIdx}>{absoluteIdx}</span>
                  )}
                </button>
              );
            })}
          </div>

          <div style={styles.pagerRow}>
            <button
              type="button"
              onClick={() => setAvatarPage((p) => Math.max(0, p - 1))}
              disabled={avatarPage === 0}
              style={{
                ...styles.tinyButton,
                opacity: avatarPage === 0 ? 0.4 : 1,
                cursor: avatarPage === 0 ? "not-allowed" : "pointer",
              }}
            >
              Previous
            </button>
            <div style={styles.pageLabel}>
              {avatarPage + 1} of {pageCount}
            </div>
            <button
              type="button"
              onClick={() => setAvatarPage((p) => Math.min(pageCount - 1, p + 1))}
              disabled={avatarPage >= pageCount - 1}
              style={{
                ...styles.tinyButton,
                opacity: avatarPage >= pageCount - 1 ? 0.4 : 1,
                cursor: avatarPage >= pageCount - 1 ? "not-allowed" : "pointer",
              }}
            >
              Next
            </button>
            <button
              type="button"
              onClick={handleShuffle}
              style={styles.tinyButton}
            >
              Shuffle
            </button>
          </div>

          <div style={styles.altRow}>
            <button
              type="button"
              onClick={() => {
                setGenError(null);
                setGeneratedUrl(null);
                setGeneratedTarget(null);
                setGeneratedPartialIndex(null);
                setLoadedGeneratedUrl(null);
                setShowGenerateModal(true);
              }}
              disabled={generating || !state.flags.avatarGenAvail}
              title={
                state.flags.avatarGenAvail
                  ? undefined
                  : "Image generation needs a compatible provider configured on the server."
              }
              style={{
                ...styles.genButton,
                opacity: generating || !state.flags.avatarGenAvail ? 0.5 : 1,
                cursor:
                  generating
                    ? "wait"
                    : state.flags.avatarGenAvail
                      ? "pointer"
                      : "not-allowed",
              }}
            >
              Generate one for me
            </button>
          </div>
          {genError && <div style={styles.error}>{genError}</div>}
        </>
      )}

      {avatarError ? <div style={styles.error}>{avatarError}</div> : null}

      {showGenerateModal && (
        <div style={styles.modalBackdrop}>
          <div style={styles.modal} role="dialog" aria-modal="true">
            <h3 style={styles.modalTitle}>Generate an avatar</h3>
            <p style={styles.modalCopy}>
              Describe the look. Nautilo will add profile-avatar guidance in the background.
            </p>
            <textarea
              value={generatePrompt}
              onChange={(e) => setGeneratePrompt(e.target.value)}
              placeholder="A wise blue dragon in a soft painterly style..."
              autoFocus
              style={styles.promptBox}
            />
            <div style={styles.generatedPreviewSlot}>
              {generatedUrl ? (
                <div style={styles.generatedPreviewFrame}>
                  {generating ? <span style={styles.previewRing} aria-hidden /> : null}
                  <img
                    src={resolveAvatarSrc(generatedUrl, serverUrl)}
                    alt="Generated avatar preview"
                    style={styles.generatedPreview}
                    onLoad={() => setLoadedGeneratedUrl(generatedUrl)}
                    onError={() => {
                      setLoadedGeneratedUrl(null);
                      setGenError("Generated image could not be loaded. Try again.");
                    }}
                  />
                </div>
              ) : generating ? (
                <div style={styles.generatedPreviewFrame} aria-live="polite">
                  <span style={styles.previewRing} aria-hidden />
                  <div style={styles.latentCloud} aria-hidden>
                    <span style={{ ...styles.latentBlob, ...styles.latentBlobOne }} />
                    <span style={{ ...styles.latentBlob, ...styles.latentBlobTwo }} />
                    <span style={{ ...styles.latentBlob, ...styles.latentBlobThree }} />
                    <span style={styles.latentCore} />
                  </div>
                </div>
              ) : (
                <div style={styles.previewPlaceholder}>
                  Generated preview appears here.
                </div>
              )}
            </div>
            {generating ? (
              <div style={styles.previewStatus}>
                {generatedUrl
                  ? generatedPartialIndex === null
                    ? "Refining…"
                    : `Refining preview ${generatedPartialIndex}/3…`
                  : "Sketching first preview…"}
              </div>
            ) : null}
            {genError && <div style={styles.error}>{genError}</div>}
            <div style={styles.modalActions}>
              <button
                type="button"
                onClick={() => {
                  setShowGenerateModal(false);
                  setGenError(null);
                }}
                style={styles.secondary}
              >
                Cancel
              </button>
              {generatedUrl && generatedTarget && (
                <button
                  type="button"
                  onClick={handleUseGenerated}
                  disabled={!generatedPreviewLoaded}
                  style={{
                    ...styles.primary,
                    opacity: generatedPreviewLoaded ? 1 : 0.4,
                    cursor: generatedPreviewLoaded ? "pointer" : "not-allowed",
                  }}
                >
                  Use this
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  void handleGenerate();
                }}
                disabled={generating}
                style={{
                  ...styles.primary,
                  opacity: generating ? 0.6 : 1,
                  cursor: generating ? "wait" : "pointer",
                }}
              >
                {generating ? "Generating…" : generatedUrl ? "Try again" : "Generate"}
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={styles.actions}>
        <button type="button" onClick={handleBack} style={styles.secondary}>
          {isTargetedFlow ? "Cancel" : "Back"}
        </button>
        {!showCurrent && (
          <button
            type="button"
            onClick={handleNext}
            disabled={!canContinue || avatarBusy}
            style={{
              ...styles.primary,
              opacity: canContinue && !avatarBusy ? 1 : 0.4,
              cursor: canContinue && !avatarBusy ? "pointer" : "not-allowed",
            }}
          >
            {avatarBusy ? "Saving…" : avatarContinueLabel}
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
    gap: "12px",
    textAlign: "center",
    maxWidth: "520px",
    width: "100%",
  } as React.CSSProperties,
  headline: {
    margin: 0,
    fontSize: "24px",
    fontWeight: 600,
  } as React.CSSProperties,
  subhead: {
    margin: "4px 0 16px",
    color: "var(--text-muted)",
    fontSize: "14px",
  } as React.CSSProperties,
  currentBlock: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    gap: "16px",
    marginBottom: "16px",
  } as React.CSSProperties,
  pickBlock: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    gap: "6px",
    marginBottom: "14px",
  } as React.CSSProperties,
  pickLabel: {
    fontSize: "11px",
    letterSpacing: "1px",
    textTransform: "uppercase" as const,
    color: "var(--text-muted)",
  } as React.CSSProperties,
  pickImg: {
    width: "84px",
    height: "84px",
    borderRadius: "50%",
    objectFit: "cover" as const,
    border: "2px solid var(--border-active)",
  } as React.CSSProperties,
  pickHint: {
    fontSize: "11px",
    color: "var(--text-muted)",
  } as React.CSSProperties,
  currentImg: {
    width: "120px",
    height: "120px",
    borderRadius: "50%",
    objectFit: "cover" as const,
    border: "1px solid var(--border)",
  } as React.CSSProperties,
  currentMissing: {
    width: "120px",
    height: "120px",
    borderRadius: "50%",
    border: "1px dashed var(--border)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "32px",
    color: "var(--text-muted)",
    background: "var(--bg-panel)",
  } as React.CSSProperties,
  currentMissingHint: {
    fontSize: "12px",
    color: "var(--error)",
  } as React.CSSProperties,
  currentActions: {
    display: "flex",
    gap: "12px",
  } as React.CSSProperties,
  presetGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(4, 64px)",
    gap: "12px",
    marginBottom: "10px",
  } as React.CSSProperties,
  presetButton: {
    width: "64px",
    height: "64px",
    borderRadius: "50%",
    border: "2px solid var(--border)",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    overflow: "hidden",
    background: "var(--bg-panel)",
  } as React.CSSProperties,
  presetImg: {
    width: "100%",
    height: "100%",
    objectFit: "cover" as const,
    borderRadius: "50%",
    display: "block",
  } as React.CSSProperties,
  presetIdx: {
    fontSize: "20px",
    fontWeight: 700,
    color: "white",
  } as React.CSSProperties,
  pagerRow: {
    display: "flex",
    gap: "8px",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: "14px",
  } as React.CSSProperties,
  tinyButton: {
    padding: "6px 10px",
    background: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-sm)",
    color: "var(--text-muted)",
    fontSize: "11px",
    cursor: "pointer",
  } as React.CSSProperties,
  pageLabel: {
    color: "var(--text-muted)",
    fontSize: "11px",
    minWidth: "42px",
  } as React.CSSProperties,
  altRow: {
    display: "flex",
    gap: "12px",
    alignItems: "center",
    marginBottom: "16px",
  } as React.CSSProperties,
  genButton: {
    padding: "8px 14px",
    background: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-sm)",
    fontSize: "12px",
    color: "var(--text-muted)",
  } as React.CSSProperties,
  error: {
    fontSize: "12px",
    color: "var(--error)",
    marginBottom: "8px",
  } as React.CSSProperties,
  actions: {
    display: "flex",
    gap: "12px",
    alignItems: "center",
    marginTop: "8px",
  } as React.CSSProperties,
  primary: {
    padding: "10px 22px",
    borderRadius: "var(--radius-sm)",
    border: "none",
    background: "var(--accent)",
    color: "var(--on-accent)",
    fontWeight: 600,
    fontSize: "14px",
    cursor: "pointer",
  } as React.CSSProperties,
  secondary: {
    padding: "10px 18px",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border)",
    background: "var(--bg-panel)",
    color: "var(--text-muted)",
    fontSize: "13px",
    cursor: "pointer",
  } as React.CSSProperties,
  modalBackdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 10,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(5, 7, 13, 0.72)",
    backdropFilter: "blur(8px)",
  } as React.CSSProperties,
  modal: {
    width: "min(480px, calc(100vw - 48px))",
    maxHeight: "calc(100vh - 80px)",
    overflowY: "auto",
    padding: "22px",
    borderRadius: "var(--radius-lg)",
    border: "1px solid var(--border)",
    background: "var(--bg)",
    boxShadow: "0 24px 80px rgba(0, 0, 0, 0.45)",
  } as React.CSSProperties,
  modalTitle: {
    margin: "0 0 8px",
    fontSize: "18px",
    fontWeight: 600,
  } as React.CSSProperties,
  modalCopy: {
    margin: "0 0 14px",
    color: "var(--text-muted)",
    fontSize: "13px",
    lineHeight: 1.5,
  } as React.CSSProperties,
  promptBox: {
    width: "100%",
    minHeight: "96px",
    resize: "vertical" as const,
    boxSizing: "border-box" as const,
    padding: "12px",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border)",
    background: "var(--bg-panel)",
    color: "var(--text)",
    font: "inherit",
    outline: "none",
  } as React.CSSProperties,
  generatedPreview: {
    width: "128px",
    height: "128px",
    objectFit: "cover" as const,
    borderRadius: "50%",
    display: "block",
  } as React.CSSProperties,
  generatedPreviewFrame: {
    position: "relative" as const,
    width: "132px",
    height: "132px",
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  } as React.CSSProperties,
  previewRing: {
    position: "absolute" as const,
    inset: 0,
    borderRadius: "50%",
    border: "2px solid rgba(150, 120, 255, 0.25)",
    borderTopColor: "var(--accent)",
    borderRightColor: "var(--accent)",
    animation: "genie-customization-spin 900ms linear infinite",
  } as React.CSSProperties,
  latentCloud: {
    position: "relative" as const,
    width: "118px",
    height: "118px",
    borderRadius: "50%",
    overflow: "hidden",
    background:
      "radial-gradient(circle at 50% 50%, rgba(155, 125, 255, 0.18), rgba(20, 24, 45, 0.92) 62%, rgba(8, 10, 20, 0.98))",
    filter: "saturate(1.25)",
    animation: "genie-customization-spin 8s linear infinite",
  } as React.CSSProperties,
  latentBlob: {
    position: "absolute" as const,
    display: "block",
    borderRadius: "999px",
    filter: "blur(13px)",
    mixBlendMode: "screen" as const,
  } as React.CSSProperties,
  latentBlobOne: {
    width: "78px",
    height: "58px",
    left: "8px",
    top: "18px",
    background: "rgba(157, 105, 255, 0.42)",
  } as React.CSSProperties,
  latentBlobTwo: {
    width: "58px",
    height: "74px",
    right: "12px",
    top: "22px",
    background: "rgba(62, 109, 255, 0.32)",
  } as React.CSSProperties,
  latentBlobThree: {
    width: "70px",
    height: "44px",
    left: "24px",
    bottom: "12px",
    background: "rgba(232, 88, 190, 0.24)",
  } as React.CSSProperties,
  latentCore: {
    position: "absolute" as const,
    inset: "34px",
    display: "block",
    borderRadius: "50%",
    background:
      "radial-gradient(circle, rgba(247, 241, 255, 0.16), rgba(127, 96, 255, 0.08) 48%, transparent 70%)",
    boxShadow: "0 0 34px rgba(155, 125, 255, 0.28)",
  } as React.CSSProperties,
  generatedPreviewSlot: {
    width: "148px",
    height: "148px",
    margin: "16px auto 0",
    borderRadius: "50%",
    border: "1px solid var(--border)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
    color: "var(--text-muted)",
    fontSize: "12px",
    lineHeight: 1.4,
    overflow: "hidden",
  } as React.CSSProperties,
  previewPlaceholder: {
    maxWidth: "96px",
  } as React.CSSProperties,
  previewStatus: {
    marginTop: "8px",
    fontSize: "12px",
    color: "var(--text-muted)",
  } as React.CSSProperties,
  generateProgress: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "10px",
  } as React.CSSProperties,
  spinner: {
    width: "22px",
    height: "22px",
    borderRadius: "50%",
    border: "2px solid var(--border)",
    borderTopColor: "var(--accent)",
    animation: "genie-customization-spin 800ms linear infinite",
  } as React.CSSProperties,
  modalActions: {
    display: "flex",
    gap: "10px",
    alignItems: "center",
    justifyContent: "flex-end",
    flexWrap: "wrap" as const,
    marginTop: "16px",
  } as React.CSSProperties,
};
