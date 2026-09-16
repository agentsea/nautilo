/**
 * D091 Phase 2 — screen 7 of 11: Name.
 *
 * Single text input that drives `state.name`. Default to "Genie"
 * (the generic species, not a specific picked name) if user
 * submits blank. No API. Re-trigger: pre-filled from existing
 * profile name.
 *
 * This screen must stay before CompilingScreen because the name is a soul
 * generation input. Putting it afterward caused a second, hidden generation
 * on Reveal and made the final save appear to hang for roughly 30 seconds.
 *
 * Naming note: pre-onboarding the agent's default identity is
 * "Genie" — the default; the operator may set any name via the
 * setup-template override. The wizard's neutral default is the
 * species name.
 */

import React, { useCallback } from "react";
import type { ScreenProps } from "./_types";

export function NameScreen({
  state,
  dispatch,
}: ScreenProps): React.ReactElement {
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      dispatch({ type: "SET_NAME", value: e.target.value });
    },
    [dispatch],
  );
  const handleNext = useCallback(() => {
    if (!state.name.trim()) {
      dispatch({ type: "SET_NAME", value: "Genie" });
    }
    dispatch({ type: "NEXT" });
  }, [dispatch, state.name]);
  const handleBack = useCallback(() => dispatch({ type: "BACK" }), [dispatch]);

  return (
    <div style={styles.root}>
      <h2 style={styles.headline}>I need a name.</h2>
      <p style={styles.subhead}>
        Pick something. Or leave it blank — I&apos;ll stay Genie.
      </p>

      <input
        type="text"
        value={state.name}
        onChange={handleChange}
        placeholder="Genie"
        autoFocus
        spellCheck={false}
        autoComplete="off"
        style={styles.input}
      />

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
    maxWidth: "440px",
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
  input: {
    width: "100%",
    maxWidth: "320px",
    padding: "12px 16px",
    fontSize: "16px",
    background: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-sm)",
    color: "var(--text)",
    outline: "none",
    textAlign: "center" as const,
    marginBottom: "24px",
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
