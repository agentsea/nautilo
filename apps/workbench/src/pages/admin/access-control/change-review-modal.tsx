import { useEffect, useRef, useState } from "react";
import type { AccessControlMutationOperation, PreviewMutationResponse } from "@nautilo/api-client";
import { ApiError } from "@nautilo/api-client/browser";
import { apiClient } from "../../../lib/api";

function actionLabel(operation: AccessControlMutationOperation): string {
  switch (operation.kind) {
    case "role.create": return `Create custom role “${operation.label}”`;
    case "role.rename": return "Rename custom role";
    case "role.set_capabilities": return "Set custom role capabilities";
    case "role.delete": return "Delete custom role";
    case "group.create": return `Create custom group “${operation.label}”`;
    case "group.rename": return "Rename custom group";
    case "group.set_roles": return "Set custom group roles";
    case "group.transfer_owner": return "Transfer custom group ownership";
    case "group.delete": return "Delete custom group";
    case "membership.add": return "Add group member";
    case "membership.remove": return "Remove group member";
    case "shared_access.create": return `Create shared access for “${operation.group.label}”`;
    case "shared_access.assign_existing": return `Create shared access for “${operation.group.label}” with an existing Permission set`;
  }
}

export function ChangeReviewModal({
  preview,
  onClose,
  onApplied,
  onRepreview,
  previewPending = false,
}: {
  preview: PreviewMutationResponse;
  onClose: () => void;
  onApplied: (auditRecorded: boolean | undefined) => Promise<void>;
  onRepreview?: (operation: AccessControlMutationOperation) => void;
  previewPending?: boolean;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState("");
  const destructive = preview.operation.kind.endsWith(".delete");
  const canApply = preview.ok && !stale && (!destructive || confirmDelete === "DELETE") && !applying;

  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!applying) onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(document.querySelectorAll<HTMLElement>(
        '[role="dialog"] button:not([disabled]), [role="dialog"] input:not([disabled])',
      ));
      if (focusable.length < 2) { event.preventDefault(); closeRef.current?.focus(); return; }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); previousFocus.current?.focus(); };
  }, [applying, onClose]);

  const apply = async () => {
    setApplying(true);
    setError(null);
    try {
      const result = await apiClient.admin.accessControl.applyChange(preview.operation, preview.fingerprint);
      await onApplied(result.auditRecorded);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        setStale(true);
        setError("This preview is stale because access-control state changed. Re-preview the change before applying.");
      } else {
        setError(cause instanceof Error ? cause.message : "Could not apply this change.");
      }
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="change-review-title" className="max-h-full w-full max-w-2xl overflow-y-auto rounded-md border border-border bg-background-panel p-6 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div><h2 id="change-review-title" className="text-lg font-semibold">Review change</h2><p className="mt-1 text-sm text-foreground-muted">{actionLabel(preview.operation)}</p></div>
          <button ref={closeRef} type="button" aria-label="Close review" disabled={applying} onClick={onClose} className="rounded p-2 hover:bg-background-element disabled:opacity-50">×</button>
        </div>
        <section className="mt-5 space-y-3 text-sm">
          <Delta label="Requested bundle added" values={preview.authorityDelta?.added ?? []} />
          <Delta label="Requested bundle unchanged" values={preview.authorityDelta?.unchanged ?? []} />
          <Delta label="Requested bundle removed" values={preview.authorityDelta?.removed ?? []} />
          {preview.affectedUserDelta ? <EffectiveDelta delta={preview.affectedUserDelta} /> : null}
          {preview.affectedUserDeltas?.map((delta) => <EffectiveDelta key={delta.userId} delta={delta} />)}
          <div><h3 className="font-medium">Server checks</h3><ul className="mt-1 space-y-1">{preview.checks.map((check) => <li key={check.code} className={check.passed ? "text-[var(--success)]" : "text-[var(--error)]"}>{check.passed ? "Pass" : "Blocked"} · {check.code}{check.detail ? ` — ${check.detail}` : ""}</li>)}</ul></div>
          {preview.deletionConsequence ? <div><h3 className="font-medium">Deletion consequences</h3><p className="text-foreground-muted">{preview.deletionConsequence.membersRemoved ?? 0} membership rows, {preview.deletionConsequence.groupRolesRemoved ?? preview.deletionConsequence.roleAssignmentsRemoved ?? 0} role assignments, and {preview.deletionConsequence.roleCapabilitiesRemoved ?? 0} capability edges will be removed.</p></div> : null}
          <div><h3 className="font-medium">Redacted audit preview</h3><p className="font-mono text-xs text-foreground-muted">{preview.auditPreview.kind} · actor={preview.auditPreview.actorId ?? "system"}</p></div>
          {!preview.ok ? <p role="alert" className="font-medium text-[var(--error)]">The server rejected this preview. Confirm and apply is disabled.</p> : null}
          {destructive ? <label className="block rounded border border-[var(--error)] p-3">Type <strong>DELETE</strong> to confirm this destructive action.<input aria-label="Type DELETE to confirm" value={confirmDelete} onInput={(event) => setConfirmDelete(event.currentTarget.value)} className="mt-2 block w-full rounded border border-border bg-background px-2 py-1" /></label> : null}
          {applying ? <p role="status" className="text-foreground-muted">Applying change…</p> : null}
          {error ? <p role="alert" className="font-medium text-[var(--error)]">{error}</p> : null}
        </section>
        <div className="mt-6 flex justify-end gap-2"><button type="button" disabled={applying} onClick={onClose} className="rounded border border-border px-3 py-1.5 text-sm disabled:opacity-50">Cancel</button>{stale && onRepreview ? <button type="button" disabled={previewPending} onClick={() => onRepreview(preview.operation)} className="rounded border border-border px-3 py-1.5 text-sm disabled:opacity-50">{previewPending ? "Re-previewing…" : "Re-preview change"}</button> : null}<button type="button" disabled={!canApply} onClick={() => { void apply(); }} className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-[var(--on-primary)] disabled:cursor-not-allowed disabled:opacity-50">Confirm and apply</button></div>
      </div>
    </div>
  );
}

function Delta({ label, values }: { label: string; values: readonly string[] }) {
  return <div><h3 className="font-medium">{label}</h3><p className="mt-1 font-mono text-xs text-foreground-muted">{values.length ? values.join(", ") : "None"}</p></div>;
}

function EffectiveDelta({ delta }: { delta: { userId: string; added: readonly string[]; removed: readonly string[]; unchanged?: readonly string[] } }) {
  return <section className="rounded border border-border p-3"><h3 className="font-medium">Human {delta.userId}&apos;s true effective change</h3><Delta label="Added" values={delta.added} /><Delta label="Unchanged" values={delta.unchanged ?? []} /><Delta label="Removed" values={delta.removed} /></section>;
}
