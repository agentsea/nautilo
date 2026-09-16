/**
 * D091 Phase 2 — wizard progress indicator.
 *
 * Renders N small dots, one per screen, with the current screen
 * highlighted. Pure presentational — no state, no animation
 * dependencies. Click-to-jump is intentionally NOT supported here
 * (orchestrator decides which screens are reachable; the dots
 * surface progress, not navigation).
 *
 * Visual: small filled circles (4px) for inactive screens, larger
 * filled circles (8px, accent-colored) for the active screen, and
 * empty hollow circles for skipped screens (currently unused —
 * the wizard's flow is linear, but the prop exists so a future
 * branch path can mark skipped screens visibly).
 */

import React from "react";
import type { ScreenId } from "../types";
import { TOTAL_SCREENS } from "../types";

interface ProgressDotsProps {
  /** Current screen index (0..TOTAL_SCREENS-1). */
  currentScreen: ScreenId;
  /** Optional set of screen indices to render as "skipped" (hollow
   *  rather than filled). Defaults to no skipped screens. */
  skipped?: ReadonlySet<number>;
  /** Optional last-screen cap. Some screens (e.g. RevealScreen 11)
   *  hide the dots entirely; the orchestrator can pass a cap < total
   *  to render only the first N dots. Defaults to TOTAL_SCREENS. */
  total?: number;
}

export function ProgressDots({
  currentScreen,
  skipped,
  total = TOTAL_SCREENS,
}: ProgressDotsProps): React.ReactElement {
  const dots: React.ReactElement[] = [];
  for (let i = 0; i < total; i++) {
    const isActive = i === currentScreen;
    const isSkipped = skipped?.has(i) ?? false;
    dots.push(
      <span
        key={i}
        aria-hidden
        style={{
          ...styles.dot,
          ...(isActive ? styles.dotActive : null),
          ...(isSkipped ? styles.dotSkipped : null),
        }}
      />,
    );
  }
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total - 1}
      aria-valuenow={currentScreen}
      aria-label={`Onboarding progress, step ${currentScreen + 1} of ${total}`}
      style={styles.row}
    >
      {dots}
    </div>
  );
}

const styles = {
  row: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "8px 0",
  } as React.CSSProperties,
  dot: {
    width: "4px",
    height: "4px",
    borderRadius: "50%",
    background: "var(--text-muted)",
    transition: "all 200ms ease",
  } as React.CSSProperties,
  dotActive: {
    width: "8px",
    height: "8px",
    background: "var(--accent)",
  } as React.CSSProperties,
  dotSkipped: {
    background: "transparent",
    boxShadow: "inset 0 0 0 1px var(--border)",
  } as React.CSSProperties,
};
