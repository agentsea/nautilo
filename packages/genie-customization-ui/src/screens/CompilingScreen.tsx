/**
 * D091 Phase 2 — screen 8 of 12: Compiling.
 *
 * Calls `generateSoul` with the collected personality fields.
 * The LLM can take 30s+; the user should not block on that. The
 * screen auto-advances at **most** `MAX_COMPILE_DISPLAY_MS` (7s) or
 * **immediately** when the request succeeds, whichever comes first.
 * If the user leaves before the model returns, `FINISH_COMPILE` still
 * updates `soulFile` in the background so Reveal can save when ready.
 * Shows retry on error. Orb is in "compiling" state (orchestrator).
 *
 * Re-trigger optimization: the orchestrator's reducer skips this
 * screen entirely when `shouldRunCompile` returns false (i.e. the
 * user didn't change personality / privacy / work-life / name
 * since hydration). When skipped, the existing `state.soulFile`
 * carries forward to the final profile write unchanged.
 *
 * Stale-response guard: each START_COMPILE bumps
 * `state.compilingGeneration`. The IPC response check that this
 * screen issues only applies the result if the generation matches
 * — guards against a JUMP-back-then-restart racing a stale
 * in-flight response onto fresher state.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { ScreenProps } from "./_types";

/** Upper bound for how long the user stays on this screen (see D091). */
const MAX_COMPILE_DISPLAY_MS = 7_000;

export function CompilingScreen({
  state,
  dispatch,
  api,
}: ScreenProps): React.ReactElement {
  // Tick animation for the dots row. Cleared on unmount.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (state.compilingPhase !== "running") return;
    const t = setInterval(() => setTick((x) => x + 1), 400);
    return () => clearInterval(t);
  }, [state.compilingPhase]);

  // Stale-soul guard: compare in-flight myGen to latest reducer gen (JUMP/restart).
  const latestGenRef = useRef(state.compilingGeneration);
  useEffect(() => {
    latestGenRef.current = state.compilingGeneration;
  }, [state.compilingGeneration]);

  // Kick off the compile request on mount + on RESTART_COMPILE.
  // We track the generation captured at request-fire time and
  // only apply the result if state.compilingGeneration still
  // matches at response-time.
  const startedGenerationRef = useRef<number | null>(null);
  useEffect(() => {
    if (state.compilingPhase !== "idle") return;
    if (!api) return;
    dispatch({ type: "START_COMPILE" });
  }, [state.compilingPhase, dispatch, api]);

  // Fire `generateSoul` in parallel with a 7s display cap. Advance
  // on first of: request success, or max wait — soul may still be
  // generating when the user is already on a later step.
  useEffect(() => {
    if (state.compilingPhase !== "running") return;
    if (startedGenerationRef.current === state.compilingGeneration) return;
    startedGenerationRef.current = state.compilingGeneration;
    if (!api) return;
    const myGen = state.compilingGeneration;
    let maxTimer: ReturnType<typeof setTimeout> | null = null;
    let didAdvance = false;
    const advance = (defer: boolean) => {
      if (didAdvance) return;
      if (myGen !== latestGenRef.current) return;
      didAdvance = true;
      if (maxTimer) clearTimeout(maxTimer);
      if (defer) dispatch({ type: "DEFER_COMPILE", generation: myGen });
      dispatch({ type: "NEXT" });
    };
    maxTimer = setTimeout(() => advance(true), MAX_COMPILE_DISPLAY_MS);

    void (async () => {
      const res = await api.generateSoul({
        name: state.name || undefined,
        language: state.language,
        workLifeMode: state.workLifeChoice ?? undefined,
        privacySpectrum: state.privacySlider,
        personalityPrompt: state.personalityPrompt || undefined,
        motherAnswer: state.motherAnswer || undefined,
      });
      if (maxTimer) {
        clearTimeout(maxTimer);
        maxTimer = null;
      }
      if (myGen !== latestGenRef.current) return;
      if (res.ok) {
        dispatch({
          type: "FINISH_COMPILE",
          generation: myGen,
          soulFile: res.data.soulFile,
        });
        advance(false);
        return;
      }
      const isAuthError = res.error.includes("401");
      dispatch({
        type: "ERROR_COMPILE",
        generation: myGen,
        message: isAuthError
          ? "Your session needs to be re-verified. Close this wizard, send a message in the main app to enter your PIN, then re-open the wizard."
          : res.error,
      });
    })();

    return () => {
      if (maxTimer) clearTimeout(maxTimer);
    };
  }, [
    state.compilingPhase,
    state.compilingGeneration,
    state.name,
    state.language,
    state.workLifeChoice,
    state.privacySlider,
    state.personalityPrompt,
    state.motherAnswer,
    dispatch,
    api,
  ]);

  const handleRetry = useCallback(() => {
    dispatch({ type: "RESTART_COMPILE" });
  }, [dispatch]);
  const handleBack = useCallback(() => {
    if (state.compilingPhase === "error") {
      dispatch({ type: "RESTART_COMPILE" });
    }
    dispatch({ type: "BACK" });
  }, [dispatch, state.compilingPhase]);

  return (
    <div style={styles.root}>
      <h2 style={styles.headline}>
        {state.compilingPhase === "error"
          ? "Hmm, that didn't work."
          : "Putting myself together…"}
      </h2>
      <p style={styles.subhead}>
        {state.compilingPhase === "error"
          ? state.errors["compile.soul"] ?? "Try again?"
          : "This usually takes a few seconds."}
      </p>

      {state.compilingPhase !== "error" && (
        <div style={styles.dotsRow} aria-hidden>
          {[0, 1, 2, 3, 4, 5, 6].map((i) => (
            <span
              key={i}
              style={{
                ...styles.dot,
                opacity: ((tick + i) % 7) / 7,
              }}
            />
          ))}
        </div>
      )}

      {state.compilingPhase === "error" && (
        <div style={styles.actions}>
          <button type="button" onClick={handleBack} style={styles.secondary}>
            Back
          </button>
          <button type="button" onClick={handleRetry} style={styles.primary}>
            Try again →
          </button>
        </div>
      )}
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
    maxWidth: "480px",
    width: "100%",
  } as React.CSSProperties,
  headline: {
    margin: 0,
    fontSize: "22px",
    fontWeight: 600,
  } as React.CSSProperties,
  subhead: {
    margin: "4px 0 24px",
    color: "var(--text-muted)",
    fontSize: "14px",
    maxWidth: "320px",
  } as React.CSSProperties,
  dotsRow: {
    display: "flex",
    gap: "8px",
    marginTop: "16px",
  } as React.CSSProperties,
  dot: {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    background: "var(--accent)",
    transition: "opacity 200ms ease",
  } as React.CSSProperties,
  actions: {
    display: "flex",
    gap: "12px",
    alignItems: "center",
    marginTop: "16px",
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
