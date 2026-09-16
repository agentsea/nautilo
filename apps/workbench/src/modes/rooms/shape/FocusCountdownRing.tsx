import type { ReactElement } from "react";

/**
 * D299 — subtle focus TTL indicator on bot avatars. A thin conic ring shows
 * remaining window; when expiring soon, a small seconds label appears.
 */
export function FocusCountdownRing({
  remainingFraction,
  expiringSoon,
  secondsLeft,
}: {
  readonly remainingFraction: number;
  readonly expiringSoon: boolean;
  readonly secondsLeft: number | null;
}): ReactElement {
  const pct = Math.max(0, Math.min(100, remainingFraction * 100));
  return (
    <>
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-full opacity-60"
        style={{
          background: `conic-gradient(var(--color-primary, hsl(var(--primary))) ${pct}%, transparent ${pct}%)`,
          WebkitMask: "radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px))",
          mask: "radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px))",
        }}
      />
      {expiringSoon && secondsLeft != null ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-center justify-center text-[8px] font-semibold leading-none text-primary"
        >
          {secondsLeft}
        </span>
      ) : null}
    </>
  );
}
