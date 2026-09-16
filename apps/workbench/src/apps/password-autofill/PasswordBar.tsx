/**
 * D403 (ISSUE-D403) Phase 3 — embedded-browser Save/Autofill bar.
 *
 * A compact, gesture-only bar rendered in the SaaS surface chrome (overlaid at
 * the top of the guest webview). It offers to SAVE a submitted credential and
 * to AUTOFILL a saved one, driven entirely by explicit clicks.
 *
 * SECURITY (R6, non-negotiable): the plaintext password NEVER reaches this
 * component / the React tree. This bar handles only non-secret metadata:
 *   - Save: it receives an origin + username (via `onPendingSave`) and, on the
 *     human's click, tells main to commit the credential main already staged
 *     (addressed by the guest webContents id). It never sees the password.
 *   - Fill: it receives id + username matches (via `lookup`) and, on the human's
 *     click, asks main to deliver the secret DIRECTLY to the guest webContents.
 *     The secret is never returned here.
 *
 * Everything is filtered by this surface's own guest `webContentsId`, so
 * multiple open panels never cross-wire.
 */
import { useEffect, useState } from "react";
import { KeyRound, Save, X } from "lucide-react";
import {
  desktopAPI,
  type PasswordLookupMatch,
} from "../../lib/desktop";

export interface PasswordBarProps {
  /**
   * This surface's live guest webContents id, or null before the guest has
   * attached. The bar stays dormant until it's a real id.
   */
  webContentsId: number | null;
  /**
   * The origin the surface is currently showing (derived from the live URL).
   * The Save offer is keyed by origin and shown only while it matches — so it
   * survives the post-submit navigation and hides when the user leaves the site.
   */
  currentOrigin: string | null;
}

interface PendingSaveState {
  origin: string;
  username: string;
  kind: "new" | "update";
}

interface AutofillState {
  origin: string;
  matches: PasswordLookupMatch[];
}

export function PasswordBar({ webContentsId, currentOrigin }: PasswordBarProps) {
  const passwords = desktopAPI?.passwords;
  const [pendingSave, setPendingSave] = useState<PendingSaveState | null>(null);
  const [autofill, setAutofill] = useState<AutofillState | null>(null);
  // One-time attention pulse when a bar first appears — grabs the eye (the
  // neutral bar blended into the chrome) then settles so it isn't permanent
  // motion noise.
  const [pulse, setPulse] = useState(false);

  // Autofill is per-page: clear it when the guest swaps (the new page re-detects
  // and re-offers). The SAVE offer is intentionally NOT cleared here — it's
  // origin-keyed and must survive the post-submit navigation / webContents swap
  // (matching how Chrome/Firefox hold a provisional credential across the login
  // navigation). It's shown only while `currentOrigin` matches (see `showSave`).
  useEffect(() => {
    setAutofill(null);
  }, [webContentsId]);

  useEffect(() => {
    if (!passwords || webContentsId === null) return;

    const offForm = passwords.onFormDetected((notice) => {
      if (notice.webContentsId !== webContentsId) return;
      const origin = notice.form.frameOrigin;
      void passwords
        .lookup(origin)
        .then((result) => {
          if (result.matches.length > 0) {
            setAutofill({ origin, matches: result.matches });
          }
        })
        .catch(() => {
          /* lookup failures are non-fatal; simply offer nothing */
        });
    });

    const offPending = passwords.onPendingSave((notice) => {
      // No webContentsId filter: the offer is origin-keyed and is gated at
      // render time by `showSave` (origin must match the surface's current URL).
      setPendingSave({
        origin: notice.origin,
        username: notice.username,
        kind: notice.kind,
      });
      // A fresh save offer supersedes any lingering autofill offer.
      setAutofill(null);
    });

    return () => {
      offForm();
      offPending();
    };
  }, [passwords, webContentsId]);

  // Race-proof autofill on attach/navigation: PULL the last detected form from
  // main. The one-shot `onFormDetected` push can fire before this panel's
  // listener is ready on a cold start (restored page loads from cache and emits
  // first), which would silently drop the offer. If a form is present for the
  // current origin and there are saved matches, offer autofill.
  useEffect(() => {
    if (!passwords || webContentsId === null || currentOrigin === null) return;
    let cancelled = false;
    void passwords
      .getDetectedForm(webContentsId)
      .then((form) => {
        if (cancelled || !form || form.frameOrigin !== currentOrigin) return;
        return passwords.lookup(currentOrigin).then((result) => {
          if (cancelled || result.matches.length === 0) return;
          setAutofill({ origin: currentOrigin, matches: result.matches });
        });
      })
      .catch(() => {
        /* pull failures are non-fatal; the live push remains the primary path */
      });
    return () => {
      cancelled = true;
    };
  }, [passwords, webContentsId, currentOrigin]);

  // The Save offer shows only while the surface's current origin matches the
  // staged origin — so it re-appears on the page the user lands on after submit,
  // and hides (without discarding) if they navigate to a different site.
  const showSave =
    pendingSave !== null &&
    currentOrigin !== null &&
    pendingSave.origin === currentOrigin;
  const showFill = !showSave && autofill !== null;
  const barVisible = showSave || showFill;

  // Fire a one-time attention pulse whenever a bar transitions into view.
  useEffect(() => {
    if (!barVisible) return;
    setPulse(true);
    const t = setTimeout(() => setPulse(false), 1200);
    return () => clearTimeout(t);
  }, [barVisible]);

  if (!passwords || webContentsId === null) return null;
  if (!barVisible) return null;

  const barClass = `flex min-w-0 items-center gap-2 border-b border-black/10 bg-primary px-3 py-2 text-[var(--on-primary)] shadow-md${
    pulse ? " animate-pulse" : ""
  }`;

  const handleSave = () => {
    if (!pendingSave) return;
    void passwords.commitSave(pendingSave.origin).catch(() => {});
    setPendingSave(null);
  };
  const handleDismissSave = () => {
    if (pendingSave) {
      void passwords.dismissSave(pendingSave.origin).catch(() => {});
    }
    setPendingSave(null);
  };
  const handleFill = (id: string) => {
    if (webContentsId === null) return;
    void passwords.applyFill({ webContentsId, id }).catch(() => {});
    setAutofill(null);
  };
  const handleDismissFill = () => setAutofill(null);

  return (
    <div
      className="pointer-events-auto absolute inset-x-0 top-0 z-10 flex flex-col gap-px"
      data-testid="password-bar"
    >
      {showSave && pendingSave ? (
        <div className={barClass} data-testid="password-save-bar">
          <Save
            aria-hidden="true"
            className="h-4 w-4 shrink-0 text-[var(--on-primary)]"
          />
          <span className="min-w-0 flex-1 truncate text-xs text-[var(--on-primary)]">
            {pendingSave.kind === "update" ? "Update password" : "Save password"}
            {pendingSave.username ? (
              <>
                {" for "}
                <span className="font-semibold">{pendingSave.username}</span>
              </>
            ) : null}
            {" on "}
            <span className="font-semibold">
              {originLabel(pendingSave.origin)}
            </span>
            ?
          </span>
          <button
            type="button"
            className="rounded bg-[var(--on-primary)] px-2 py-1 text-xs font-semibold text-primary hover:opacity-90"
            onClick={handleSave}
          >
            {pendingSave.kind === "update" ? "Update" : "Save"}
          </button>
          <button
            type="button"
            aria-label="Dismiss save prompt"
            title="Dismiss"
            className="rounded p-1 text-[var(--on-primary)] opacity-80 hover:bg-black/10 hover:opacity-100"
            onClick={handleDismissSave}
          >
            <X aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}

      {showFill && autofill ? (
        <div className={barClass} data-testid="password-autofill-bar">
          <KeyRound
            aria-hidden="true"
            className="h-4 w-4 shrink-0 text-[var(--on-primary)]"
          />
          <span className="shrink-0 text-xs font-medium text-[var(--on-primary)] opacity-90">
            Autofill:
          </span>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {autofill.matches.map((match) => (
              <button
                key={match.id}
                type="button"
                className="max-w-full truncate rounded bg-[var(--on-primary)] px-2 py-1 text-xs font-semibold text-primary hover:opacity-90"
                title={`Fill ${match.username || "(no username)"}`}
                onClick={() => handleFill(match.id)}
              >
                {match.username || "(no username)"}
              </button>
            ))}
          </div>
          <button
            type="button"
            aria-label="Dismiss autofill prompt"
            title="Dismiss"
            className="rounded p-1 text-[var(--on-primary)] opacity-80 hover:bg-black/10 hover:opacity-100"
            onClick={handleDismissFill}
          >
            <X aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Trim the scheme for a compact origin label (keeps host[:port]). */
function originLabel(origin: string): string {
  return origin.replace(/^https?:\/\//, "");
}
