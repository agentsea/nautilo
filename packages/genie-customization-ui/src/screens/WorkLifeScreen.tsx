/**
 * D091 Phase 2 — screen 4 of 12: Work / Life.
 *
 * Three-button radio (Work / Life / Both). Persists to
 * `state.workLifeChoice`. No API. Continue requires a selection
 * in first-run; in re-trigger the previous choice is pre-selected
 * so Continue is always enabled.
 */

import React, { useCallback } from "react";
import type { WorkLifeChoice } from "../types";
import { isGenieRecustomizeSession } from "../hooks/useWizardState";
import type { ScreenProps } from "./_types";

const OPTIONS: { value: WorkLifeChoice; label: string; sub: string }[] = [
  {
    value: "work",
    label: "Work",
    sub: "Email, research, documents.",
  },
  {
    value: "life",
    label: "Life",
    sub: "Lights, music, errands.",
  },
  {
    value: "both",
    label: "Both",
    sub: "I want it all.",
  },
];

export function WorkLifeScreen({
  state,
  dispatch,
}: ScreenProps): React.ReactElement {
  const handleSelect = useCallback(
    (choice: WorkLifeChoice) => {
      dispatch({ type: "SET_WORK_LIFE", choice });
    },
    [dispatch],
  );
  const handleNext = useCallback(() => dispatch({ type: "NEXT" }), [dispatch]);
  const handleBack = useCallback(() => dispatch({ type: "BACK" }), [dispatch]);

  const canContinue = isGenieRecustomizeSession(state) || state.workLifeChoice !== null;

  return (
    <div style={styles.root}>
      <h2 style={styles.headline}>Where do you want me?</h2>
      <p style={styles.subhead}>You can change this later in settings.</p>

      <div style={styles.row}>
        {OPTIONS.map((opt) => {
          const selected = state.workLifeChoice === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => handleSelect(opt.value)}
              style={{
                ...styles.option,
                ...(selected ? styles.optionSelected : null),
              }}
            >
              <div style={styles.optionLabel}>{opt.label}</div>
              <div style={styles.optionSub}>{opt.sub}</div>
            </button>
          );
        })}
      </div>

      <div style={styles.actions}>
        <button type="button" onClick={handleBack} style={styles.secondary}>
          Back
        </button>
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
  row: {
    display: "flex",
    gap: "12px",
    justifyContent: "center",
    marginBottom: "24px",
    flexWrap: "wrap" as const,
  } as React.CSSProperties,
  option: {
    flex: "0 0 150px",
    padding: "16px 12px",
    borderRadius: "var(--radius-md)",
    border: "1px solid var(--border)",
    background: "var(--bg-panel)",
    color: "var(--text)",
    cursor: "pointer",
    transition: "border-color 120ms ease, background 120ms ease",
    textAlign: "center" as const,
  } as React.CSSProperties,
  optionSelected: {
    borderColor: "var(--border-active)",
    background: "var(--bg-panel-hover)",
  } as React.CSSProperties,
  optionLabel: {
    fontSize: "15px",
    fontWeight: 600,
    marginBottom: "6px",
  } as React.CSSProperties,
  optionSub: {
    fontSize: "12px",
    color: "var(--text-muted)",
    lineHeight: 1.4,
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
