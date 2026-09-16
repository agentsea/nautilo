/**
 * D091 Phase 2 — screen 0 of 11: Welcome.
 *
 * The first frame of "The Genie Moment." Orb in idle state,
 * brand mark, headline + subhead, single Continue affordance.
 * No state mutation, no API calls — pure intro.
 *
 * Narrator: none. Welcome stays silent so the immediate next
 * screen (Language) is the first thing the user hears.
 *
 * Naming note: pre-onboarding the agent has no user-chosen name
 * yet, so we refer to her as "your Genie" (the generic species).
 * The user picks the actual name on screen 8 (Name); from that
 * point forward the workbench / settings / system prompts use
 * the chosen name. "Genie" is the default suggestion at the
 * Name step but never the wizard's own copy.
 */

import React, { useCallback } from "react";
import type { ScreenProps } from "./_types";

export function WelcomeScreen({ dispatch }: ScreenProps): React.ReactElement {
  const handleContinue = useCallback(() => {
    dispatch({ type: "NEXT" });
  }, [dispatch]);

  return (
    <div style={styles.root}>
      <h1 style={styles.headline}>Hi, I&apos;m your Genie.</h1>
      <p style={styles.subhead}>
        Let&apos;s get to know each other. This will take about five minutes.
      </p>
      <button type="button" onClick={handleContinue} style={styles.primary}>
        Continue →
      </button>
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
  } as React.CSSProperties,
  headline: {
    margin: 0,
    fontSize: "32px",
    fontWeight: 600,
    letterSpacing: "-0.5px",
  } as React.CSSProperties,
  subhead: {
    margin: "8px 0 24px",
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
