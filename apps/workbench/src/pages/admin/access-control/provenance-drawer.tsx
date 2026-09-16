import { useEffect, useRef } from "react";
import type { EffectiveAccessResponse } from "@nautilo/api-client";

export function ProvenanceDrawer({
  access,
  onClose,
  subject = access.user.displayName,
}: {
  access: EffectiveAccessResponse;
  onClose: () => void;
  subject?: string;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        document.querySelectorAll<HTMLElement>('[role="dialog"] button:not([disabled]), [role="dialog"] [href], [role="dialog"] input:not([disabled])'),
      );
      if (focusable.length < 2) {
        event.preventDefault();
        closeRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previousFocus.current?.focus();
    };
  }, [onClose]);

  const customFacts = access.groupRoleFacts.filter((fact) => !fact.groupIsSystem || !fact.roleIsSystem);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40">
      <button type="button" aria-label="Close provenance" className="flex-1" onClick={onClose} />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="provenance-title"
        className="h-full w-full max-w-xl overflow-y-auto border-l border-border bg-background-panel p-6 shadow-xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="provenance-title" className="text-lg font-semibold">Why does {subject} have this access?</h2>
            <p className="mt-1 text-sm text-foreground-muted">Every resolved Group → Role → capability path.</p>
          </div>
          <button ref={closeRef} type="button" aria-label="Close provenance drawer" onClick={onClose} className="rounded p-2 hover:bg-background-element">×</button>
        </div>
        <div className="mt-6 space-y-4">
          {access.capabilities.map((capability) => (
            <section key={capability.slug} className="rounded-md border border-border p-3">
              <h3 className="font-mono text-sm font-medium">{capability.slug}</h3>
              <p className="mt-1 text-xs text-foreground-muted">
                {capability.granted ? "Granted" : "Not granted"}
              </p>
              {capability.provenance.length ? (
                <ul className="mt-2 space-y-2 text-sm">
                  {capability.provenance.map((path) => (
                    <li key={`${path.groupId}-${path.roleSlug}`} className="text-foreground-muted">
                      ← {path.roleLabel} ({path.roleIsSystem ? "built-in role" : "custom role"})
                      <br />← {path.groupLabel} ({path.groupIsSystem ? "system-managed group" : "custom group"})
                    </li>
                  ))}
                </ul>
              ) : <p className="mt-2 text-sm text-foreground-muted">No Group → Role → capability path resolves this access.</p>}
            </section>
          ))}
          <section className="rounded-md border border-border p-3">
            <h3 className="font-medium">Custom contributions</h3>
            {customFacts.length ? (
              <ul className="mt-2 space-y-1 text-sm text-foreground-muted">
                {customFacts.map((fact) => <li key={`${fact.groupId}-${fact.roleSlug}`}>{fact.groupLabel} → {fact.roleLabel}</li>)}
              </ul>
            ) : <p className="mt-1 text-sm text-foreground-muted">None. This person has no custom Group or Role contributions.</p>}
          </section>
        </div>
      </aside>
    </div>
  );
}
