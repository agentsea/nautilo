/**
 * D091 Phase 2 — screen 3 of 12: Privacy.
 *
 * Single 0–100 slider that drives `state.privacySlider`, persisted
 * as `privacySpectrum` on the final profile write. Two-end labels
 * make the spectrum direction explicit. No API calls.
 *
 * Re-trigger: slider position pre-set via the HYDRATE action in
 * the reducer; user sees their existing value and can adjust.
 */

import React, { useCallback } from "react";
import type { ScreenProps } from "./_types";

const LABELS: Record<number, string> = {
  0: "Closed book",
  25: "Reserved",
  50: "Open",
  75: "Forthcoming",
  100: "Open book",
};

function nearestLabel(value: number): string {
  // Snap to the nearest labeled tick for the sub-display under the slider.
  let bestKey = 0;
  let bestDist = Infinity;
  for (const k of Object.keys(LABELS).map(Number)) {
    const dist = Math.abs(k - value);
    if (dist < bestDist) {
      bestDist = dist;
      bestKey = k;
    }
  }
  const label = LABELS[bestKey];
  return label ?? "";
}

export function PrivacyScreen({
  state,
  dispatch,
}: ScreenProps): React.ReactElement {
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = Number(e.target.value);
      if (!Number.isNaN(value)) dispatch({ type: "SET_PRIVACY", value });
    },
    [dispatch],
  );
  const handleNext = useCallback(() => dispatch({ type: "NEXT" }), [dispatch]);
  const handleBack = useCallback(() => dispatch({ type: "BACK" }), [dispatch]);

  return (
    <div style={styles.root}>
      <h2 style={styles.headline}>How private are you?</h2>
      <p style={styles.subhead}>
        I&apos;ll keep this in mind for what to remember and how to ask.
      </p>

      <div style={styles.sliderBlock}>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={state.privacySlider}
          onChange={handleChange}
          aria-label="Privacy preference"
          style={styles.slider}
        />
        <div style={styles.endsRow}>
          <span>Closed book</span>
          <span>Open book</span>
        </div>
        <div style={styles.currentLabel}>
          {nearestLabel(state.privacySlider)} · {state.privacySlider}
        </div>
      </div>

      <div style={styles.actions}>
        <button type="button" onClick={handleBack} style={styles.secondary}>
          Back
        </button>
        <button type="button" onClick={handleNext} style={styles.primary}>
          Continue →
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
    maxWidth: "520px",
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
  sliderBlock: {
    width: "100%",
    maxWidth: "400px",
    marginBottom: "24px",
  } as React.CSSProperties,
  slider: {
    width: "100%",
    accentColor: "var(--accent)",
  } as React.CSSProperties,
  endsRow: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: "12px",
    color: "var(--text-muted)",
    marginTop: "8px",
  } as React.CSSProperties,
  currentLabel: {
    marginTop: "12px",
    fontSize: "13px",
    color: "var(--accent)",
    fontWeight: 600,
  } as React.CSSProperties,
  actions: {
    display: "flex",
    gap: "12px",
    alignItems: "center",
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
};
