import { useCallback, useEffect, useRef, useState } from "react";
import type { AccessControlHumanRow, AccessControlMutationOperation } from "@nautilo/api-client";
import { apiClient } from "../../../lib/api";
import { useCan } from "../../../hooks/use-can";
import { useAuth } from "../../../hooks/use-auth";
import { useAccessControl } from "./access-control-context";
import {
  canManageGroupMembership,
  isCommunityEnrollmentTarget,
  missingGroupMembershipCapabilities,
} from "./group-membership-authority";

const slugify = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function GroupsTab({ onReview, refreshKey = 0, previewPending = false }: { onReview: (operation: AccessControlMutationOperation) => void; refreshKey?: number; previewPending?: boolean }) {
  const { catalogue, loading, error, refresh } = useAccessControl();
  const can = useCan();
  const auth = useAuth();
  const canManageMembers = can("manage_members");
  const canManageGroups = can("manage_groups");
  const [users, setUsers] = useState<readonly AccessControlHumanRow[]>([]);
  const [members, setMembers] = useState<Array<{ userId: string; displayName: string; handle: string }>>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [ownerUserId, setOwnerUserId] = useState("");
  const [roleSlugs, setRoleSlugs] = useState<string[]>([]);
  const [memberUserId, setMemberUserId] = useState("");
  const [membersError, setMembersError] = useState<string | null>(null);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState<string | null>(null);
  const humansGeneration = useRef(0);
  const rosterGeneration = useRef(0);
  const rosterAbort = useRef<AbortController | null>(null);
  useEffect(() => { if (!catalogue && refresh) void refresh(); }, [catalogue, refresh]);
  const loadHumans = useCallback(async () => {
    const generation = ++humansGeneration.current;
    setUsersLoading(true);
    setUsersError(null);
    try {
      const value = await apiClient.admin.accessControl.listHumans();
      if (generation === humansGeneration.current) setUsers(value);
    } catch (cause) {
      if (generation === humansGeneration.current) {
        setUsersError(cause instanceof Error ? cause.message : "Could not load Humans.");
      }
    } finally {
      if (generation === humansGeneration.current) setUsersLoading(false);
    }
  }, []);
  useEffect(() => {
    if (canManageMembers || canManageGroups) void loadHumans();
  }, [canManageGroups, canManageMembers, loadHumans]);
  const selected = catalogue?.groups.find((group) => group.id === selectedId) ?? null;
  const editingGroup = catalogue?.groups.find((group) => group.id === editingGroupId) ?? null;
  const canManageSelectedMembership = Boolean(
    catalogue && selected && canManageGroupMembership(
      catalogue,
      selected,
      auth.viewer.capabilities,
    ),
  );
  const selectedMissingCapabilities = catalogue && selected
    ? missingGroupMembershipCapabilities(catalogue, selected, auth.viewer.capabilities)
    : [];
  const communityEnrollmentUnavailable = Boolean(
    selected && isCommunityEnrollmentTarget(selected),
  );
  const canAddSelectedMembership = canManageSelectedMembership && !communityEnrollmentUnavailable;
  useEffect(() => {
    rosterAbort.current?.abort();
    const generation = ++rosterGeneration.current;
    setMembers([]);
    setMembersError(null);
    if (!selectedId || !canManageMembers) return;
    const controller = new AbortController();
    rosterAbort.current = controller;
    void apiClient.groups.listGroupMembers(selectedId).then((value) => {
      if (!controller.signal.aborted && generation === rosterGeneration.current) setMembers(value.members);
    }).catch((cause) => {
      if (!controller.signal.aborted && generation === rosterGeneration.current) {
        setMembersError(cause instanceof Error ? cause.message : "Could not load members.");
      }
    });
    return () => controller.abort();
  }, [canManageMembers, refreshKey, selectedId]);
  if (loading || !catalogue && !error) return <p className="p-6 text-sm text-foreground-muted">Loading groups…</p>;
  if (error || !catalogue) return <p role="alert" className="p-6 text-sm text-[var(--error)]">{error ?? "Could not load groups."}</p>;
  const system = catalogue.groups.filter((group) => group.isSystem);
  const custom = catalogue.groups.filter((group) => !group.isSystem);
  const resetEditor = () => { setCreating(false); setEditorOpen(false); setEditingGroupId(null); setLabel(""); setOwnerUserId(""); setRoleSlugs([]); };
  const selectGroup = (id: string) => { resetEditor(); setSelectedId(id); };
  const openEditor = (group?: typeof catalogue.groups[number]) => { setCreating(!group); setEditorOpen(true); setSelectedId(group?.id ?? null); setEditingGroupId(group?.id ?? null); setLabel(group?.label ?? ""); setOwnerUserId(group?.ownerId ?? ""); setRoleSlugs([...group?.roleSlugs ?? []]); };
  const toggleRole = (slug: string) => setRoleSlugs((current) => current.includes(slug) ? current.filter((item) => item !== slug) : [...current, slug]);
  return <section id="access-control-groups-panel" role="tabpanel" aria-labelledby="access-control-tab-groups" className="min-h-0 flex-1 overflow-y-auto p-6">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">Groups</h2><p className="mt-1 text-sm text-foreground-muted">Custom groups carry custom Permission sets and are not part of the canonical ladder.</p></div><button type="button" disabled={previewPending} onClick={() => openEditor()} className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-[var(--on-primary)] disabled:opacity-50">New custom group</button></div>
    <GroupList title="System — protected definitions" groups={system} onSelect={selectGroup} />
    <GroupList title="Custom — user-managed, orthogonal to ladder" groups={custom} onSelect={selectGroup} />
    {selected ? <aside className="mt-6 rounded border border-border p-4"><h3 className="font-semibold">{selected.label}</h3>{selected.isSystem ? <p className="mt-1 text-sm text-foreground-muted">Protected system-managed definition. Its type and Permission set assignment cannot be edited or deleted.</p> : null}<p className="mt-2 text-sm">Permission sets: <span className="font-mono">{selected.roleSlugs.join(", ") || "None"}</span></p>{canManageMembers ? <section className="mt-4"><h4 className="font-medium">Members ({selected.memberCount})</h4>{!canManageSelectedMembership ? <p className="mt-1 text-sm text-foreground-muted">Membership changes require the target Group bundle: {selectedMissingCapabilities.join(", ")}.</p> : null}{communityEnrollmentUnavailable ? <p className="mt-1 text-sm text-foreground-muted">Community enrollment is unavailable until personal-key chat launches. Existing memberships can still be removed.</p> : null}{membersError ? <p role="alert" className="text-sm text-[var(--error)]">{membersError}</p> : null}<ul className="mt-2 space-y-1 text-sm">{members.map((member) => <li key={member.userId} className="flex items-center justify-between gap-2">{member.displayName}{member.handle ? ` (@${member.handle})` : ""}<button type="button" disabled={previewPending || !canManageSelectedMembership} onClick={() => onReview({ kind: "membership.remove", groupId: selected.id, userId: member.userId })} className="rounded border border-border px-2 py-1 text-xs disabled:opacity-50">Review removal</button></li>)}</ul>{usersError ? <div className="mt-3 text-sm"><p role="alert" className="text-[var(--error)]">Could not load Humans: {usersError}</p><button type="button" onClick={() => void loadHumans()} disabled={usersLoading} className="mt-1 rounded border border-border px-2 py-1 text-xs disabled:opacity-50">{usersLoading ? "Retrying…" : "Retry loading Humans"}</button></div> : null}<div className="mt-3 flex gap-2"><select aria-label="Member to add" disabled={previewPending || !canAddSelectedMembership || usersLoading || Boolean(usersError && users.length === 0)} value={memberUserId} onChange={(event) => setMemberUserId(event.target.value)} className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm"><option value="">Select Human</option>{users.filter((user) => !members.some((member) => member.userId === user.userId)).map((user) => <option key={user.userId} value={user.userId}>{user.displayName}{user.handle ? ` (@${user.handle})` : ""}</option>)}</select><button type="button" disabled={previewPending || !canAddSelectedMembership || !memberUserId || usersLoading || Boolean(usersError && users.length === 0)} onClick={() => onReview({ kind: "membership.add", groupId: selected.id, userId: memberUserId })} className="rounded border border-border px-2 py-1 text-sm disabled:opacity-50">Review add</button></div></section> : <p className="mt-4 text-sm text-foreground-muted">Membership management requires manage_members.</p>}{!selected.isSystem ? <div className="mt-4 flex gap-2"><button type="button" disabled={previewPending} onClick={() => openEditor(selected)} className="rounded border border-border px-3 py-1.5 text-sm disabled:opacity-50">Edit definition</button><button type="button" disabled={previewPending} onClick={() => onReview({ kind: "group.delete", groupId: selected.id })} className="rounded border border-[var(--error)] px-3 py-1.5 text-sm text-[var(--error)] disabled:opacity-50">Delete…</button></div> : null}</aside> : null}
    {editorOpen && (creating || editingGroup) ? <aside className="mt-6 rounded border border-border p-4"><h3 className="font-semibold">{creating ? "New custom group" : `Edit ${editingGroup!.label}`}</h3><label className="mt-3 block text-sm">Label<input disabled={previewPending} value={label} onChange={(event) => setLabel(event.target.value)} className="mt-1 block w-full rounded border border-border bg-background px-2 py-1.5" /></label>{creating ? <p className="mt-1 text-xs text-foreground-muted">Group type: custom:{slugify(label) || "derived-from-label"}</p> : null}{usersError ? <div className="mt-3 text-sm"><p role="alert" className="text-[var(--error)]">Could not load Humans: {usersError}</p><button type="button" onClick={() => void loadHumans()} disabled={usersLoading} className="mt-1 rounded border border-border px-2 py-1 text-xs disabled:opacity-50">{usersLoading ? "Retrying…" : "Retry loading Humans"}</button></div> : null}<label className="mt-3 block text-sm">Owner<select disabled={previewPending || usersLoading || Boolean(usersError && users.length === 0)} value={ownerUserId} onChange={(event) => setOwnerUserId(event.target.value)} className="mt-1 block w-full rounded border border-border bg-background px-2 py-1.5"><option value="">Select owner</option>{users.map((user) => <option key={user.userId} value={user.userId}>{user.displayName}</option>)}</select></label><fieldset className="mt-4"><legend className="font-medium">Custom roles</legend>{catalogue.roles.filter((role) => !role.isSystem).map((role) => <label key={role.id} className="mt-2 flex gap-2 text-sm"><input type="checkbox" checked={roleSlugs.includes(role.slug)} disabled={previewPending} onChange={() => toggleRole(role.slug)} />{role.label} <span className="font-mono text-xs text-foreground-muted">{role.slug}</span></label>)}</fieldset><div className="mt-5 flex flex-wrap gap-2"><button type="button" disabled={previewPending || !label.trim() || (creating && (!ownerUserId || usersLoading || Boolean(usersError && users.length === 0)))} onClick={() => onReview(creating ? { kind: "group.create", label: label.trim(), groupType: `custom:${slugify(label)}`, ownerUserId, roleSlugs } : { kind: "group.set_roles", groupId: editingGroup!.id, roleSlugs })} className="rounded bg-primary px-3 py-1.5 text-sm text-[var(--on-primary)] disabled:opacity-50">Review change</button>{!creating ? <><button type="button" disabled={previewPending || !label.trim()} onClick={() => onReview({ kind: "group.rename", groupId: editingGroup!.id, label: label.trim() })} className="rounded border border-border px-3 py-1.5 text-sm disabled:opacity-50">Review rename</button><button type="button" disabled={previewPending || !ownerUserId || usersLoading || Boolean(usersError && users.length === 0)} onClick={() => onReview({ kind: "group.transfer_owner", groupId: editingGroup!.id, newOwnerUserId: ownerUserId })} className="rounded border border-border px-3 py-1.5 text-sm disabled:opacity-50">Review ownership transfer</button></> : null}</div></aside> : null}
  </section>;
}

function GroupList({ title, groups, onSelect }: { title: string; groups: { id: string; label: string; type: string; roleSlugs: readonly string[]; memberCount: number }[]; onSelect: (id: string) => void }) { return <section className="mt-6"><h3 className="text-sm font-semibold uppercase text-foreground-muted">{title}</h3><ul className="mt-2 divide-y divide-border rounded-md border border-border">{groups.map((group) => <li key={group.id}><button type="button" onClick={() => onSelect(group.id)} className="w-full px-3 py-3 text-left hover:bg-background-element"><span className="font-medium">{group.label}</span><span className="ml-2 font-mono text-xs text-foreground-muted">{group.type}</span><p className="mt-1 text-xs text-foreground-muted">{group.memberCount} members · {group.roleSlugs.join(", ") || "no roles"}</p></button></li>)}</ul></section>; }
