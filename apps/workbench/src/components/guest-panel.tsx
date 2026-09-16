import { useAuth } from "../hooks/use-auth";

/**
 * Full-panel guest gate.
 *
 * Used by surfaces that show owner-scoped data (ContextPanel,
 * BrowserColumn's Workspace + Files tabs) when the active session
 * is unverified. Mirrors the inline `GuestPlaceholder` in
 * `pages/settings/ui.tsx` but framed for full-panel placement
 * (centered, lock icon, primary sign-in affordance) so
 * a sidebar or tab body that's normally a tree / detail view
 * doesn't render as an empty section.
 *
 * M040 / multi-user TODO: every surface that uses this gate
 * leaks the OWNER's data today (profile name + soul + workspace
 * files). When per-actor profile rows + per-actor workspace
 * scoping ship, the gate goes away — each verified user sees
 * their own data; guests legitimately have nothing to show.
 *
 * `surface` names the gated thing in copy ("Workspace files
 * are locked", "Your assistant's identity is locked"); pass the
 * subject not the verb. `kind` switches copy intensity for
 * credentials-class surfaces vs identifying-only.
 */
export function GuestPanel({
  surface,
  kind = "normal",
  verb = "is",
}: {
  /** Subject of the gate copy. e.g. "Workspace files",
   *  "Your assistant's identity". */
  surface: string;
  /** Agreement helper for plural surfaces, e.g. "Workspace files
   *  are locked". */
  verb?: "is" | "are";
  /** "normal" = identifying info; "credentials" = secrets-class
   *  (provider keys etc.). Drives the copy intensity. */
  kind?: "normal" | "credentials";
}) {
  const auth = useAuth();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div
        aria-hidden="true"
        className="flex h-12 w-12 items-center justify-center rounded-full bg-background-element text-2xl"
      >
        🔒
      </div>
      <h3 className="text-sm font-semibold text-foreground">
        {surface} {verb} locked
      </h3>
      <p className="max-w-[20rem] text-xs leading-relaxed text-foreground-muted">
        {kind === "credentials"
          ? `${surface} contain credentials and are only visible to the verified owner.`
          : `You're signed in as Guest. Sign in with your account to unlock ${surface.toLowerCase()}.`}
      </p>
      <button
        type="button"
        onClick={() => {
          void auth.session.signIn().catch((err) => {
            console.error("[guest-panel] sign-in failed", err);
          });
        }}
        className="mt-1 inline-flex items-center justify-center rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-[var(--on-primary)] transition-colors hover:bg-primary-hover"
      >
        Sign in →
      </button>
    </div>
  );
}
