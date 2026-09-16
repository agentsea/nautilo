import { useEffect, useMemo, useRef, useState } from "react";
import type { AccessControlCatalogue, AccessControlMutationOperation, EffectiveAccessResponse } from "@nautilo/api-client";
import {
  canManageGroupMembership,
  missingGroupMembershipCapabilities,
} from "./group-membership-authority";

type MembershipOperation = Extract<AccessControlMutationOperation, { kind: "membership.add" | "membership.remove" }>;
type Group = AccessControlCatalogue["groups"][number];

export function ManageAccessDrawer({
  access,
  catalogue,
  onClose,
  onReview,
  onCreateSharedAccess,
  canCreateSharedAccessExisting,
  canCreateSharedAccessNew,
  viewerCapabilities,
  previewPending = false,
}: {
  access: EffectiveAccessResponse;
  catalogue: AccessControlCatalogue;
  onClose: () => void;
  onReview: (operation: AccessControlMutationOperation) => void;
  onCreateSharedAccess: () => void;
  canCreateSharedAccessExisting: boolean;
  canCreateSharedAccessNew: boolean;
  viewerCapabilities: readonly string[];
  previewPending?: boolean;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [pending, setPending] = useState<MembershipOperation | null>(null);
  const memberships = useMemo(() => new Set(access.groups.map((group) => group.id)), [access.groups]);
  const standard = catalogue.groups.filter((group) => group.isSystem);
  const additional = catalogue.groups.filter((group) => !group.isSystem);
  const choose = (group: Group) => {
    if (!canManageGroupMembership(catalogue, group, viewerCapabilities)) return;
    setPending(memberships.has(group.id)
      ? { kind: "membership.remove", groupId: group.id, userId: access.user.id }
      : { kind: "membership.add", groupId: group.id, userId: access.user.id });
  };
  const groupName = pending ? catalogue.groups.find((group) => group.id === pending.groupId)?.label ?? "selected Group" : "";
  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab") return;
      const focusable = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"] button:not([disabled]), [role="dialog"] input:not([disabled])'));
      if (focusable.length < 2) { event.preventDefault(); closeRef.current?.focus(); return; }
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); previousFocus.current?.focus(); };
  }, [onClose]);
  return <div className="fixed inset-0 z-40 flex justify-end bg-black/40">
    <section role="dialog" aria-modal="true" aria-labelledby="manage-access-title" className="h-full w-full max-w-lg overflow-y-auto bg-background-panel p-6 shadow-xl">
      <div className="flex items-start justify-between gap-3">
        <div><h2 id="manage-access-title" className="text-lg font-semibold">Manage {access.user.displayName}&apos;s access</h2><p className="mt-1 text-sm text-foreground-muted">Membership changes are reviewed individually and always grant access through Groups.</p></div>
        <button ref={closeRef} type="button" aria-label="Close manage access" onClick={onClose} className="rounded p-2 hover:bg-background-element">×</button>
      </div>
      <MembershipList title="Standard Groups" groups={standard} memberships={memberships} pending={pending} previewPending={previewPending} catalogue={catalogue} viewerCapabilities={viewerCapabilities} onChoose={choose} />
      <MembershipList title="Additional Groups" groups={additional} memberships={memberships} pending={pending} previewPending={previewPending} catalogue={catalogue} viewerCapabilities={viewerCapabilities} onChoose={choose} />
      {pending ? <div className="mt-5 rounded border border-border p-3 text-sm"><p><strong>{pending.kind === "membership.add" ? "Add" : "Remove"}</strong> {access.user.displayName} {pending.kind === "membership.add" ? "to" : "from"} {groupName}.</p><p className="mt-1 text-foreground-muted">One membership operation will be previewed and reviewed. This does not create a direct-user Permission record.</p><button type="button" disabled={previewPending} onClick={() => onReview(pending)} className="mt-3 rounded bg-primary px-3 py-1.5 text-sm font-medium text-[var(--on-primary)] disabled:opacity-50">Review change</button></div> : null}
      <div className="mt-6 border-t border-border pt-5"><h3 className="font-medium">Need a new shared access pattern?</h3>{canCreateSharedAccessExisting ? <><p className="mt-1 text-sm text-foreground-muted">{canCreateSharedAccessNew ? "Create a Group, new Permission set, and initial members in one reviewed atomic change." : "Create a Group with an existing Permission set and initial members in one reviewed atomic change. Creating a new Permission set requires manage_roles."}</p><button type="button" disabled={previewPending} onClick={onCreateSharedAccess} className="mt-3 rounded border border-border px-3 py-1.5 text-sm disabled:opacity-50">Create shared access</button></> : <p className="mt-1 text-sm text-foreground-muted">Creating shared access requires manage_groups and manage_members.</p>}</div>
    </section>
  </div>;
}

function MembershipList({ title, groups, memberships, pending, previewPending, catalogue, viewerCapabilities, onChoose }: {
  title: string;
  groups: readonly Group[];
  memberships: Set<string>;
  pending: MembershipOperation | null;
  previewPending: boolean;
  catalogue: AccessControlCatalogue;
  viewerCapabilities: readonly string[];
  onChoose: (group: Group) => void;
}) {
  return <fieldset className="mt-6"><legend className="font-medium">{title}</legend><div className="mt-2 space-y-2">{groups.map((group) => {
    const checked = pending?.groupId === group.id ? pending.kind === "membership.add" : memberships.has(group.id);
    const missing = missingGroupMembershipCapabilities(catalogue, group, viewerCapabilities);
    const allowed = canManageGroupMembership(catalogue, group, viewerCapabilities);
    return <label key={group.id} className="flex gap-3 rounded border border-border p-3 text-sm"><input type="checkbox" checked={checked} disabled={previewPending || !allowed} onChange={() => onChoose(group)} /><span><span className="block font-medium">{group.label}</span><span className="font-mono text-xs text-foreground-muted">{group.roleSlugs.join(", ") || "No Permission sets"}</span>{!allowed ? <span className="mt-1 block text-xs text-foreground-muted">{viewerCapabilities.includes("manage_members") ? `Requires the target Group bundle: ${missing.join(", ")}.` : "Requires manage_members."}</span> : null}</span></label>;
  })}</div></fieldset>;
}
