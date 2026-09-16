/**
 * M106 — modal used by the workbench sign-in surface so a signed-out
 * user can type / paste an invite token or URL and jump to the redeem
 * wizard. Standalone so multiple sign-in surfaces can reuse it.
 */
import { useState } from "react";
import { PreAuthShell } from "./pre-auth-shell";

function parseInviteToken(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^inv_[A-Za-z0-9_-]+$/.test(trimmed)) return trimmed;
  const pathMatch = trimmed.match(/(?:^|\/)(redeem|invite)\/(inv_[A-Za-z0-9_-]+)/);
  if (pathMatch) return pathMatch[2] ?? null;
  const schemeMatch = trimmed.match(/^nautilo:\/\/invite\/(inv_[A-Za-z0-9_-]+)/i);
  if (schemeMatch) return schemeMatch[1] ?? null;
  return null;
}

interface Props {
  onClose: () => void;
  onNavigateInvite: (token: string) => void;
}

export function InvitePasteModal({ onClose, onNavigateInvite }: Props) {
  const [raw, setRaw] = useState("");
  const [error, setError] = useState("");
  return (
    <div
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <PreAuthShell
        scrim="modal"
        title="Invite"
        subtitle="Paste your invite token or URL"
        onClose={onClose}
      >
        <div className="text-left">
          <label className="mt-3 block text-xs font-medium text-foreground-muted">
            <span className="sr-only">Paste your invite token or URL</span>
            <input
              type="text"
              autoComplete="off"
              value={raw}
              onChange={(e) => {
                setRaw(e.target.value);
                setError("");
              }}
              className="mt-2 w-full rounded-md border border-border bg-background-element px-3 py-2 text-foreground placeholder:text-foreground-disabled focus:border-border-interactive focus:outline-none"
            />
          </label>
          {error ? <p className="mt-2 text-sm text-error">{error}</p> : null}
          <div className="mt-5 flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-md border border-border px-3 py-2 text-sm text-foreground-muted hover:bg-background-element"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                const token = parseInviteToken(raw);
                if (!token) {
                  setError(
                    "We couldn't read an invite token from that. Paste the full link.",
                  );
                  return;
                }
                onNavigateInvite(token);
                onClose();
              }}
              className="flex-1 rounded-md bg-primary px-3 py-2 text-sm text-[var(--on-primary)] hover:bg-primary-hover"
            >
              Continue
            </button>
          </div>
        </div>
      </PreAuthShell>
    </div>
  );
}
