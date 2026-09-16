import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { AccessControlCatalogue, AccessControlMutationOperation, EffectiveAccessResponse } from "@nautilo/api-client";
import type { AdminUserRow } from "@nautilo/api-client/browser";
import { apiClient } from "../../../lib/api";
import { formatUserIdentity, PAGE_LIMIT, userRoleLabel } from "../sections/users/user-helpers";
import { ProvenanceDrawer } from "./provenance-drawer";
import { CreateSharedAccessDialog } from "./create-shared-access-dialog";
import { ManageAccessDrawer } from "./manage-access-drawer";
import { useCan } from "../../../hooks/use-can";
import { useAuth } from "../../../hooks/use-auth";

function capitalize(value: string | null): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "None";
}

export function UsersTab({ userId, refreshKey = 0, onReview, previewPending = false, canCreateSharedAccessExisting = false, canCreateSharedAccessNew = false }: { userId?: string; refreshKey?: number; onReview?: (operation: AccessControlMutationOperation) => void; previewPending?: boolean; canCreateSharedAccessExisting?: boolean; canCreateSharedAccessNew?: boolean }) {
  const navigate = useNavigate();
  const can = useCan();
  const auth = useAuth();
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [loadingMoreUsers, setLoadingMoreUsers] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [access, setAccess] = useState<EffectiveAccessResponse | null>(null);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [loadingAccess, setLoadingAccess] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [catalogue, setCatalogue] = useState<AccessControlCatalogue | null>(null);
  const [manageError, setManageError] = useState<string | null>(null);
  const usersGeneration = useRef(0);
  const selectedUserId = useRef(userId);
  selectedUserId.current = userId;

  useEffect(() => {
    const generation = ++usersGeneration.current;
    setLoadingUsers(true);
    setLoadingMoreUsers(false);
    setListError(null);
    setNextCursor(null);
    void apiClient.admin.users.list({ limit: PAGE_LIMIT, includeFederated: true })
      .then((result) => {
        if (generation === usersGeneration.current) {
          setUsers(result.users);
          setNextCursor(result.nextCursor);
        }
      })
      .catch((error: unknown) => {
        if (generation === usersGeneration.current) setListError(error instanceof Error ? error.message : "Could not load users.");
      })
      .finally(() => { if (generation === usersGeneration.current) setLoadingUsers(false); });
  }, [refreshKey]);
  const loadMoreUsers = () => {
    if (!nextCursor || loadingUsers || loadingMoreUsers) return;
    const generation = usersGeneration.current;
    const cursor = nextCursor;
    setLoadingMoreUsers(true);
    setListError(null);
    void apiClient.admin.users.list({ cursor, limit: PAGE_LIMIT, includeFederated: true })
      .then((result) => {
        if (generation === usersGeneration.current) {
          setUsers((current) => {
            const ids = new Set(current.map((user) => user.id));
            return [...current, ...result.users.filter((user) => !ids.has(user.id))];
          });
          setNextCursor(result.nextCursor);
        }
      })
      .catch((error: unknown) => {
        if (generation === usersGeneration.current) setListError(error instanceof Error ? error.message : "Could not load more users.");
      })
      .finally(() => { if (generation === usersGeneration.current) setLoadingMoreUsers(false); });
  };

  const loadAccess = useCallback(async (id: string) => {
    setLoadingAccess(true);
    setAccessError(null);
    setDrawerOpen(false);
    try {
      const response = await apiClient.admin.accessControl.getEffectiveAccess(id);
      if (selectedUserId.current === id) setAccess(response);
    } catch (error) {
      if (selectedUserId.current === id) {
        setAccess(null);
        setAccessError(error instanceof Error ? error.message : "Could not load effective access.");
      }
    } finally {
      if (selectedUserId.current === id) setLoadingAccess(false);
    }
  }, []);
  const openManage = async () => {
    const openingUserId = selectedUserId.current;
    if (!openingUserId) return;
    setManageError(null);
    try {
      const loadedCatalogue = await apiClient.admin.accessControl.getCatalogue();
      if (selectedUserId.current === openingUserId) {
        setCatalogue(loadedCatalogue);
        setManageOpen(true);
      }
    } catch (error) {
      if (selectedUserId.current === openingUserId) {
        setManageError(error instanceof Error ? error.message : "Could not load Groups for access management.");
      }
    }
  };

  useEffect(() => {
    setAccess(null);
    setAccessError(null);
    setLoadingAccess(Boolean(userId));
    setDrawerOpen(false);
    setManageOpen(false);
    setCreateOpen(false);
    setManageError(null);
    if (!userId) {
      return;
    }
    void loadAccess(userId);
  }, [loadAccess, refreshKey, userId]);

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[20rem_minmax(0,1fr)]">
      <aside
        aria-label="Users"
        className="flex min-h-0 flex-col border-b border-border lg:border-b-0 lg:border-r"
      >
        <div className="border-b border-border px-4 py-3">
          <h2 className="font-semibold">Users</h2>
          <p className="mt-1 text-xs text-foreground-muted">Read-only directory and effective access.</p>
        </div>
        {loadingUsers ? <p className="p-4 text-sm text-foreground-muted">Loading users…</p> : null}
        {listError ? <p role="alert" className="p-4 text-sm text-[var(--error)]">{listError}</p> : null}
        <ul className="max-h-72 min-h-0 overflow-y-auto lg:max-h-none lg:flex-1">
          {users.map((user) => (
            <li key={user.id}>
              <Link
                to={`/admin/access-control/users/${encodeURIComponent(user.id)}`}
                aria-current={user.id === userId ? "true" : undefined}
                className={`block px-4 py-3 hover:bg-background-element ${user.id === userId ? "bg-background-element" : ""}`}
              >
                <span className="block truncate text-sm font-medium">{formatUserIdentity(user)}</span>
                <span className="block truncate text-xs text-foreground-muted">{user.displayName} · {userRoleLabel(user)}</span>
              </Link>
            </li>
          ))}
        </ul>
        {nextCursor ? <div className="border-t border-border p-3"><button type="button" onClick={loadMoreUsers} disabled={loadingUsers || loadingMoreUsers} className="w-full rounded border border-border px-3 py-1.5 text-sm disabled:opacity-50">{loadingMoreUsers ? "Loading more users…" : "Load more users"}</button></div> : null}
      </aside>
      <section aria-live="polite" className="min-w-0 overflow-y-auto p-6">
        {!userId ? <p className="text-sm text-foreground-muted">Select a Human to inspect their effective access.</p> : null}
        {loadingAccess ? <p className="text-sm text-foreground-muted">Loading effective access…</p> : null}
        {accessError ? <p role="alert" className="text-sm text-[var(--error)]">{accessError}</p> : null}
        {access && access.user.id === userId ? (
          <>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold">{access.user.displayName}</h2>
                <p className="mt-1 text-sm text-foreground-muted">
                  {access.user.handle ? `@${access.user.handle}` : "Human"}{access.user.server ? `@${access.user.server}` : ""}
                </p>
                <p className="mt-4 text-sm">Canonical ladder: <strong>{capitalize(access.highestRole)}</strong></p>
              </div>
              <div className="flex gap-2">{onReview ? <button type="button" disabled={previewPending} onClick={() => { void openManage(); }} className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-[var(--on-primary)] disabled:opacity-50">Manage access</button> : null}<button type="button" onClick={() => { void navigate("/admin/access-control"); }} className="rounded border border-border px-3 py-1.5 text-sm hover:bg-background-element">Clear selection</button></div>
            </div>
            {manageError ? <p role="alert" className="mt-3 text-sm text-[var(--error)]">{manageError}</p> : null}
            <AccessSources access={access} onRemove={onReview ? (groupId) => onReview({ kind: "membership.remove", groupId, userId: access.user.id }) : undefined} />
            <section className="mt-6" aria-labelledby="effective-access-title">
              <h3 id="effective-access-title" className="font-semibold">Effective access</h3>
              <ul className="mt-3 divide-y divide-border rounded-md border border-border">
                {access.capabilities.map((capability) => (
                  <li key={capability.slug} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                    <span className="font-mono text-sm">{capability.slug}</span>
                    <span className={capability.granted ? "text-[var(--success)]" : "text-foreground-muted"}>
                      {capability.granted ? "Granted" : "Not granted"}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
            <section className="mt-6 rounded-md border border-border p-4">
              <h3 className="font-semibold">Custom contributions</h3>
              {access.groupRoleFacts.some((fact) => !fact.groupIsSystem || !fact.roleIsSystem) ? (
                <ul className="mt-2 text-sm text-foreground-muted">
                  {access.groupRoleFacts.filter((fact) => !fact.groupIsSystem || !fact.roleIsSystem).map((fact) => (
                    <li key={`${fact.groupId}-${fact.roleSlug}`}>{fact.groupLabel} → {fact.roleLabel}</li>
                  ))}
                </ul>
              ) : <p className="mt-1 text-sm text-foreground-muted">No custom Group or Role contributions.</p>}
            </section>
            <button type="button" onClick={() => setDrawerOpen(true)} className="mt-6 rounded bg-primary px-3 py-1.5 text-sm font-medium text-[var(--on-primary)] hover:bg-primary-hover">
              Why does {access.user.displayName} have this access?
            </button>
            {drawerOpen ? <ProvenanceDrawer access={access} onClose={() => setDrawerOpen(false)} /> : null}
            {manageOpen && catalogue && onReview ? <ManageAccessDrawer access={access} catalogue={catalogue} viewerCapabilities={auth.viewer.capabilities} canCreateSharedAccessExisting={canCreateSharedAccessExisting} canCreateSharedAccessNew={canCreateSharedAccessNew} previewPending={previewPending} onClose={() => setManageOpen(false)} onReview={(operation) => { setManageOpen(false); onReview(operation); }} onCreateSharedAccess={() => { setManageOpen(false); setCreateOpen(true); }} /> : null}
            {createOpen && catalogue && onReview ? <CreateSharedAccessDialog catalogue={catalogue} canCreateExisting={canCreateSharedAccessExisting} canCreateNew={canCreateSharedAccessNew} canDelegate={(capability) => can(capability as never)} previewPending={previewPending} onClose={() => setCreateOpen(false)} onReview={(operation) => { setCreateOpen(false); onReview(operation); }} /> : null}
          </>
        ) : null}
      </section>
    </div>
  );
}

function AccessSources({ access, onRemove }: { access: EffectiveAccessResponse; onRemove?: (groupId: string) => void }) {
  const groups = access.groups.map((group) => ({ group, roles: access.groupRoleFacts.filter((fact) => fact.groupId === group.id) }));
  const render = (title: string, rows: typeof groups) => <section className="mt-6" aria-label={title}><h3 className="font-semibold">Access sources</h3><h4 className="mt-3 text-sm font-medium text-foreground-muted">{title}</h4>{rows.length ? <ul className="mt-2 divide-y divide-border rounded-md border border-border">{rows.map(({ group, roles }) => <li key={group.id} className="flex items-center justify-between gap-3 px-3 py-2"><div><p className="text-sm font-medium">{group.label}</p><p className="mt-1 text-xs text-foreground-muted">→ {roles.map((role) => role.roleLabel).join(", ") || "No Permission sets"}</p></div>{onRemove ? <button type="button" onClick={() => onRemove(group.id)} className="rounded border border-border px-2 py-1 text-xs">Remove</button> : null}</li>)}</ul> : <p className="mt-1 text-sm text-foreground-muted">None.</p>}</section>;
  return <>{render("Standard access", groups.filter(({ group }) => group.isSystem))}{render("Additional access", groups.filter(({ group }) => !group.isSystem))}</>;
}
