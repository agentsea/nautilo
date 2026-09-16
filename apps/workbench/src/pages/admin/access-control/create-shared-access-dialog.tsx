import { useEffect, useRef, useState } from "react";
import type { AccessControlCatalogue, AccessControlHumanRow, AccessControlMutationOperation } from "@nautilo/api-client";
import { apiClient } from "../../../lib/api";

const slugify = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const NONDELEGABLE = new Set(["manage_server_settings", "manage_server_security"]);

export function createSharedAccessOperation({
  source, groupLabel, roleLabel, capabilities, existingRoleSlug, ownerUserId, memberUserIds,
}: {
  source: "new" | "existing"; groupLabel: string; roleLabel: string; capabilities: string[];
  existingRoleSlug: string; ownerUserId: string; memberUserIds: string[];
}): AccessControlMutationOperation {
  const group = { groupType: `custom:${slugify(groupLabel)}`, label: groupLabel.trim(), ownerUserId };
  return source === "new"
    ? { kind: "shared_access.create", role: { slug: slugify(roleLabel), label: roleLabel.trim(), capabilities }, group, memberUserIds }
    : { kind: "shared_access.assign_existing", roleSlug: existingRoleSlug, group, memberUserIds };
}

export function CreateSharedAccessDialog({
  catalogue,
  canDelegate,
  canCreateExisting,
  canCreateNew,
  previewPending = false,
  onClose,
  onReview,
}: {
  catalogue: AccessControlCatalogue;
  canDelegate: (capability: string) => boolean;
  canCreateExisting: boolean;
  canCreateNew: boolean;
  previewPending?: boolean;
  onClose: () => void;
  onReview: (operation: AccessControlMutationOperation) => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [humans, setHumans] = useState<readonly AccessControlHumanRow[]>([]);
  const [groupLabel, setGroupLabel] = useState("");
  const [permissionSetSource, setPermissionSetSource] = useState<"new" | "existing">(canCreateNew ? "new" : "existing");
  const [existingRoleSlug, setExistingRoleSlug] = useState("");
  const [roleLabel, setRoleLabel] = useState("");
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [ownerUserId, setOwnerUserId] = useState("");
  const [memberUserIds, setMemberUserIds] = useState<string[]>([]);
  const [humansLoading, setHumansLoading] = useState(true);
  const [humansError, setHumansError] = useState<string | null>(null);
  const humansGeneration = useRef(0);
  const loadHumans = async () => {
    const generation = ++humansGeneration.current;
    setHumansLoading(true);
    setHumansError(null);
    try {
      const result = await apiClient.admin.accessControl.listHumans();
      if (generation === humansGeneration.current) setHumans(result);
    } catch (cause) {
      if (generation === humansGeneration.current) {
        setHumansError(cause instanceof Error ? cause.message : "Could not load Humans.");
      }
    } finally {
      if (generation === humansGeneration.current) setHumansLoading(false);
    }
  };
  useEffect(() => { void loadHumans(); }, []);
  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab") return;
      const focusable = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"] button:not([disabled]), [role="dialog"] input:not([disabled]), [role="dialog"] select:not([disabled])'));
      if (focusable.length < 2) { event.preventDefault(); closeRef.current?.focus(); return; }
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); previousFocus.current?.focus(); };
  }, [onClose]);
  const toggle = (value: string) => setCapabilities((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
  const toggleMember = (value: string) => setMemberUserIds((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
  const review = () => {
    onReview(createSharedAccessOperation({ source: permissionSetSource, groupLabel, roleLabel, capabilities, existingRoleSlug, ownerUserId, memberUserIds }));
  };
  return <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"><section role="dialog" aria-modal="true" aria-labelledby="create-shared-access-title" className="max-h-full w-full max-w-2xl overflow-y-auto rounded border border-border bg-background-panel p-6 shadow-xl">
    <div className="flex items-start justify-between gap-3"><div><h2 id="create-shared-access-title" className="text-lg font-semibold">Create shared access</h2><p className="mt-1 text-sm text-foreground-muted">Both paths use one atomic reviewed operation to create the Group, attach a Permission set, and add selected Humans.</p></div><button ref={closeRef} type="button" aria-label="Close create shared access" onClick={onClose} className="rounded p-2 hover:bg-background-element">×</button></div>
    <label className="mt-5 block text-sm">Group name<input aria-label="Group name" disabled={previewPending} value={groupLabel} onChange={(event) => setGroupLabel(event.target.value)} className="mt-1 block w-full rounded border border-border bg-background px-2 py-1.5" /></label>
    <fieldset className="mt-4"><legend className="font-medium">Permission set source</legend><label className="mt-2 flex gap-2 text-sm"><input type="radio" name="permission-set-source" checked={permissionSetSource === "new"} disabled={previewPending || !canCreateNew} onChange={() => setPermissionSetSource("new")} />Create new Permission set</label><label className="mt-2 flex gap-2 text-sm"><input type="radio" name="permission-set-source" checked={permissionSetSource === "existing"} disabled={previewPending || !canCreateExisting} onChange={() => setPermissionSetSource("existing")} />Use existing custom Permission set</label><p className="mt-2 text-xs text-foreground-muted">{permissionSetSource === "new" ? "Creates a new Permission set and Group atomically." : "Creates a Group with the selected existing Permission set atomically."}</p></fieldset>
    {permissionSetSource === "new" ? <><label className="mt-4 block text-sm">Permission set name<input aria-label="Permission set name" disabled={previewPending} value={roleLabel} onChange={(event) => setRoleLabel(event.target.value)} className="mt-1 block w-full rounded border border-border bg-background px-2 py-1.5" /></label><fieldset className="mt-4"><legend className="font-medium">Permissions</legend><p className="mt-1 text-xs text-foreground-muted">Select only from the Permissions catalog; free text is not supported.</p>{catalogue.capabilities.map((capability) => { const disabled = previewPending || NONDELEGABLE.has(capability.slug) || !canDelegate(capability.slug); return <label key={capability.slug} className={`mt-2 flex gap-2 text-sm ${disabled ? "text-foreground-muted" : ""}`}><input type="checkbox" checked={capabilities.includes(capability.slug)} disabled={disabled} onChange={() => toggle(capability.slug)} /><span className="font-mono">{capability.slug}</span></label>; })}</fieldset></> : <label className="mt-4 block text-sm">Existing Permission set<select aria-label="Existing Permission set" disabled={previewPending} value={existingRoleSlug} onChange={(event) => setExistingRoleSlug(event.target.value)} className="mt-1 block w-full rounded border border-border bg-background px-2 py-1.5"><option value="">Select a custom Permission set</option>{catalogue.roles.filter((role) => !role.isSystem).map((role) => <option key={role.id} value={role.slug}>{role.label} ({role.slug})</option>)}</select></label>}
    {humansError ? <div className="mt-4 text-sm"><p role="alert" className="text-[var(--error)]">Could not load Humans: {humansError}</p><button type="button" onClick={() => void loadHumans()} disabled={humansLoading} className="mt-1 rounded border border-border px-2 py-1 text-xs disabled:opacity-50">{humansLoading ? "Retrying…" : "Retry loading Humans"}</button></div> : null}
    <label className="mt-4 block text-sm">Group owner<select aria-label="Group owner" disabled={previewPending || humansLoading || Boolean(humansError && humans.length === 0)} value={ownerUserId} onChange={(event) => setOwnerUserId(event.target.value)} className="mt-1 block w-full rounded border border-border bg-background px-2 py-1.5"><option value="">Select Human</option>{humans.map((human) => <option key={human.userId} value={human.userId}>{human.displayName}</option>)}</select></label>
    <fieldset className="mt-4"><legend className="font-medium">Initial Humans</legend>{humansLoading ? <p className="text-sm text-foreground-muted">Loading Humans…</p> : null}{humans.map((human) => <label key={human.userId} className="mt-2 flex gap-2 text-sm"><input type="checkbox" disabled={previewPending || Boolean(humansError && humans.length === 0)} checked={memberUserIds.includes(human.userId)} onChange={() => toggleMember(human.userId)} />{human.displayName}{human.handle ? ` (@${human.handle})` : ""}</label>)}</fieldset>
    <div className="mt-6 flex justify-end gap-2"><button type="button" onClick={onClose} className="rounded border border-border px-3 py-1.5 text-sm">Cancel</button><button type="button" disabled={previewPending || !(permissionSetSource === "new" ? canCreateNew : canCreateExisting) || !groupLabel.trim() || !(permissionSetSource === "new" ? roleLabel.trim() : existingRoleSlug) || !ownerUserId || !memberUserIds.length || humansLoading || Boolean(humansError && humans.length === 0)} onClick={review} className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-[var(--on-primary)] disabled:opacity-50">Review atomic change</button></div>
  </section></div>;
}
