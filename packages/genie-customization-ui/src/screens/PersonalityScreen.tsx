/**
 * D091 Phase 2 — screen 6 of 12: Personality.
 *
 * Free-text prompt + (conditional, gated on flags.motherEasterEgg)
 * a hidden second textarea for the "mother answer" easter egg.
 * Persists to `state.personalityPrompt` + `state.motherAnswer`.
 *
 * Re-trigger: textareas pre-filled with existing values.
 *
 * Material change detection: the next-screen Compiling is skipped
 * when none of (personalityPrompt, privacySlider, workLifeChoice,
 * name) differ from the hydrated baseline. Editing this textarea
 * counts as material; un-editing it back to the hydrated value
 * means Compiling stays skipped.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { ScreenProps } from "./_types";

function soulGenerationStatus(elapsedMs: number): {
  readonly headline: string;
  readonly detail: string;
  readonly button: string;
} {
  if (elapsedMs >= 15_000) {
    return {
      headline: "Still working — this can take up to a minute…",
      detail:
        "Longer soul files take time. Nautilo is still using your instructions as the main signal.",
      button: "Still working…",
    };
  }
  if (elapsedMs >= 5_000) {
    return {
      headline: "Shaping the soul…",
      detail:
        "Turning your words into tone, boundaries, defaults, and continuity.",
      button: "Shaping soul…",
    };
  }
  return {
    headline: "Regenerating…",
    detail:
      "Using your instructions as the main signal. This can take 30–60 seconds.",
    button: "Regenerating…",
  };
}

export function PersonalityScreen({
  state,
  dispatch,
  api,
  onPersonalityContinue,
  personalityContinueLabel = "Continue →",
  personalityBusy = false,
  personalityStartedAt = null,
  personalityError = null,
  soulPreview = "",
  soulStreaming = false,
  soulStreamError = null,
}: ScreenProps): React.ReactElement {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!personalityBusy || personalityStartedAt === null) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [personalityBusy, personalityStartedAt]);

  const generationStatus = useMemo(() => {
    if (!personalityBusy || personalityStartedAt === null) return null;
    return soulGenerationStatus(Math.max(0, now - personalityStartedAt));
  }, [now, personalityBusy, personalityStartedAt]);

  const handlePromptChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      dispatch({ type: "SET_PERSONALITY", value: e.target.value });
    },
    [dispatch],
  );
  const handleMotherChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      dispatch({ type: "SET_MOTHER_ANSWER", value: e.target.value });
    },
    [dispatch],
  );
  const handleNext = useCallback(() => {
    if (onPersonalityContinue) {
      void onPersonalityContinue();
      return;
    }
    dispatch({ type: "NEXT" });
  }, [dispatch, onPersonalityContinue]);
  const isTargetedFlow = Boolean(onPersonalityContinue);
  const handleBack = useCallback(() => {
    if (isTargetedFlow) {
      if (
        personalityBusy &&
        !window.confirm("Soul regeneration is still running. Close anyway?")
      ) {
        return;
      }
      void api?.cancel();
      return;
    }
    dispatch({ type: "BACK" });
  }, [api, dispatch, isTargetedFlow, personalityBusy]);

  return (
    <div style={styles.root}>
      <h2 style={styles.headline}>How would you like me to be?</h2>
      <p style={styles.subhead}>
        Just say it in your own words. There&apos;s no wrong answer.
      </p>

      <textarea
        value={state.personalityPrompt}
        onChange={handlePromptChange}
        placeholder="Warm, direct, makes me laugh, doesn't mince words..."
        rows={5}
        spellCheck={true}
        disabled={personalityBusy}
        style={{
          ...styles.textarea,
          ...(personalityBusy ? styles.disabledField : null),
        }}
      />

      {state.flags.motherEasterEgg && (
        <div style={styles.motherBlock}>
          <label htmlFor="mother-answer" style={styles.motherLabel}>
            Tell me about your mother.{" "}
            <span style={styles.optional}>(optional)</span>
          </label>
          <textarea
            id="mother-answer"
            value={state.motherAnswer}
            onChange={handleMotherChange}
            rows={3}
            disabled={personalityBusy}
            style={{
              ...styles.textarea,
              ...(personalityBusy ? styles.disabledField : null),
            }}
          />
        </div>
      )}
      {isTargetedFlow ? (
        <div
          style={{
            ...styles.statusBlock,
            ...(personalityBusy ? styles.statusBlockBusy : null),
          }}
          aria-live="polite"
        >
          <div style={styles.statusHeadline}>
            {generationStatus?.headline ?? "Ready to regenerate the soul."}
          </div>
          <div style={styles.statusDetail}>
            {generationStatus?.detail ??
              "Your instructions will be used as the main signal for the new soul file."}
          </div>
        </div>
      ) : null}
      {isTargetedFlow && (personalityBusy || soulPreview) ? (
        <div style={styles.previewPanel} aria-live="polite">
          <div style={styles.previewHeader}>
            <span>
              {soulPreview
                ? soulStreaming || personalityBusy
                  ? "Soul file writing…"
                  : "Soul file preview"
                : "Waiting for first words…"}
            </span>
            {soulStreaming || personalityBusy ? (
              <span style={styles.previewPulse}>writing</span>
            ) : null}
          </div>
          <pre style={styles.previewText}>
            {soulPreview || "The soul file will appear here as Nautilo writes it."}
            {soulStreaming || personalityBusy ? "▌" : ""}
          </pre>
        </div>
      ) : null}
      {soulStreamError ? (
        <p style={styles.error}>Streaming fell back: {soulStreamError}</p>
      ) : null}
      {personalityError ? (
        <p style={styles.error}>{personalityError}</p>
      ) : null}

      <div style={styles.actions}>
        <button type="button" onClick={handleBack} style={styles.secondary}>
          {personalityBusy ? "Cancel…" : isTargetedFlow ? "Cancel" : "Back"}
        </button>
        <button
          type="button"
          onClick={handleNext}
          style={{
            ...styles.primary,
            ...(personalityBusy ? styles.disabled : null),
          }}
          disabled={personalityBusy}
        >
          {personalityBusy
            ? generationStatus?.button ?? "Regenerating…"
            : personalityContinueLabel}
        </button>
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
    maxWidth: "560px",
    maxHeight: "100%",
    minHeight: 0,
    width: "100%",
  } as React.CSSProperties,
  headline: {
    margin: 0,
    fontSize: "24px",
    fontWeight: 600,
    letterSpacing: "-0.3px",
  } as React.CSSProperties,
  subhead: {
    margin: "4px 0 24px",
    color: "var(--text-muted)",
    fontSize: "14px",
  } as React.CSSProperties,
  textarea: {
    width: "100%",
    padding: "12px 14px",
    fontSize: "14px",
    background: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-sm)",
    color: "var(--text)",
    outline: "none",
    fontFamily: "inherit",
    resize: "vertical" as const,
    marginBottom: "16px",
  } as React.CSSProperties,
  disabledField: {
    opacity: 0.68,
    cursor: "wait",
  } as React.CSSProperties,
  statusBlock: {
    width: "100%",
    boxSizing: "border-box" as const,
    margin: "-4px 0 6px",
    padding: "10px 12px",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border)",
    background: "var(--bg-panel)",
    textAlign: "left" as const,
  } as React.CSSProperties,
  statusBlockBusy: {
    borderColor: "var(--border-active)",
    boxShadow: "0 0 22px rgba(155, 125, 255, 0.14)",
  } as React.CSSProperties,
  statusHeadline: {
    fontSize: "13px",
    fontWeight: 600,
    color: "var(--text)",
  } as React.CSSProperties,
  statusDetail: {
    marginTop: "4px",
    fontSize: "12px",
    lineHeight: 1.45,
    color: "var(--text-muted)",
  } as React.CSSProperties,
  previewPanel: {
    width: "100%",
    boxSizing: "border-box" as const,
    flex: "0 1 auto",
    maxHeight: "min(170px, 22vh)",
    overflow: "hidden",
    margin: "4px 0 8px",
    border: "1px solid var(--border-active)",
    borderRadius: "var(--radius-sm)",
    background: "rgba(10, 13, 28, 0.72)",
    boxShadow: "0 16px 48px rgba(0, 0, 0, 0.22)",
    textAlign: "left" as const,
  } as React.CSSProperties,
  previewHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    padding: "9px 12px",
    borderBottom: "1px solid var(--border)",
    color: "var(--text)",
    fontSize: "12px",
    fontWeight: 600,
  } as React.CSSProperties,
  previewPulse: {
    color: "var(--accent)",
    fontSize: "11px",
    textTransform: "uppercase" as const,
    letterSpacing: "0.08em",
  } as React.CSSProperties,
  previewText: {
    maxHeight: "min(118px, calc(22vh - 52px))",
    overflowY: "auto" as const,
    margin: 0,
    padding: "12px",
    whiteSpace: "pre-wrap" as const,
    color: "var(--text-muted)",
    fontSize: "12px",
    lineHeight: 1.45,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  } as React.CSSProperties,
  motherBlock: {
    width: "100%",
    marginTop: "8px",
    textAlign: "left" as const,
  } as React.CSSProperties,
  motherLabel: {
    display: "block",
    fontSize: "13px",
    color: "var(--text-muted)",
    marginBottom: "6px",
  } as React.CSSProperties,
  optional: {
    fontStyle: "italic" as const,
    opacity: 0.7,
  } as React.CSSProperties,
  actions: {
    display: "flex",
    flexShrink: 0,
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
  disabled: {
    opacity: 0.65,
    cursor: "not-allowed",
  } as React.CSSProperties,
  error: {
    color: "var(--danger)",
    fontSize: "13px",
    margin: "4px 0",
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
};
