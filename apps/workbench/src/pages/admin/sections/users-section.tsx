import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError } from "@nautilo/api-client/browser";
import { apiClient } from "../../../lib/api";
import { useCan } from "../../../hooks/use-can";
import { useAuth } from "../../../hooks/use-auth";
import { UsersDirectory } from "./users/users-directory";
import { UserDetailPanel } from "./users/user-detail-panel";
import { BulkDeleteDialog } from "./users/bulk-delete-dialog";
import {
  canOffboard,
  formatUserIdentity,
  friendlyOffboardFailure,
  PAGE_LIMIT,
  type AdminUserRow,
  type GroupRow,
} from "./users/user-helpers";

export function UsersSection() {
  const can = useCan();
  const { viewer } = useAuth();
  const canManageMembers = can("manage_members");
  const canTransferOwnership = can("manage_server_settings");
  const canManageUncontainedHostCommands = can("manage_uncontained_host_commands");

  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  const [canonicalGroups, setCanonicalGroups] = useState<GroupRow[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [groupsError, setGroupsError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailUser, setDetailUser] = useState<AdminUserRow | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // D298 — multi-select for bulk offboarding.
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [showBulkDelete, setShowBulkDelete] = useState(false);

  const loadGroups = useCallback(async () => {
    setGroupsLoading(true);
    setGroupsError(null);
    try {
      const res = await apiClient.groups.listGroups();
      setCanonicalGroups(res.groups);
    } catch (e) {
      setCanonicalGroups([]);
      setGroupsError(e instanceof Error ? e.message : "Could not load server groups.");
    } finally {
      setGroupsLoading(false);
    }
  }, []);

  const loadUsers = useCallback(async (opts?: { append?: boolean; cursor?: string }) => {
    const append = opts?.append === true;
    if (append) {
      setLoadingMore(true);
    } else {
      setLoading(true);
      setListError(null);
    }
    try {
      const res = await apiClient.admin.users.list({
        limit: PAGE_LIMIT,
        includeFederated: true,
        ...(searchQuery ? { search: searchQuery } : {}),
        ...(opts?.cursor ? { cursor: opts.cursor } : {}),
      });
      setUsers((prev) => (append ? [...prev, ...res.users] : res.users));
      setNextCursor(res.nextCursor);
    } catch (e) {
      const message =
        e instanceof ApiError && e.status === 401
          ? "Sign in to manage users."
          : e instanceof Error
            ? e.message
            : "Could not load users.";
      if (!append) {
        setListError(message);
        setUsers([]);
        setNextCursor(null);
      }
    } finally {
      if (append) setLoadingMore(false);
      else setLoading(false);
    }
  }, [searchQuery]);

  useEffect(() => {
    if (!canManageMembers) {
      setLoading(false);
      return;
    }
    void loadUsers();
    void loadGroups();
  }, [canManageMembers, loadUsers, loadGroups]);

  const clearSelection = useCallback(() => setCheckedIds(new Set()), []);

  const refreshUsers = useCallback(() => {
    setSelectedId(null);
    setDetailUser(null);
    setDetailError(null);
    clearSelection();
    void loadUsers();
    void loadGroups();
  }, [loadUsers, loadGroups, clearSelection]);

  const loadMore = useCallback(() => {
    if (!nextCursor || loadingMore) return;
    void loadUsers({ append: true, cursor: nextCursor });
  }, [loadUsers, loadingMore, nextCursor]);

  const refreshDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    setDetailError(null);
    try {
      const row = await apiClient.admin.users.get(id);
      setDetailUser(row);
    } catch (e) {
      setDetailUser(null);
      setDetailError(e instanceof Error ? e.message : "Could not load user details.");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const onSelectUser = useCallback(
    (id: string) => {
      if (id === selectedId) {
        setSelectedId(null);
        setDetailUser(null);
        setDetailError(null);
        return;
      }
      setSelectedId(id);
      const cached = users.find((u) => u.id === id) ?? null;
      setDetailUser(cached);
      void refreshDetail(id);
    },
    [refreshDetail, users, selectedId],
  );

  const onToggleCheck = useCallback((id: string) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const onToggleAll = useCallback(() => {
    setCheckedIds((prev) =>
      prev.size === users.length ? new Set() : new Set(users.map((u) => u.id)),
    );
  }, [users]);

  const ownersCount = users.filter((u) =>
    u.groups.some((g) => g.type === "owners"),
  ).length;

  const onUserUpdated = useCallback(() => {
    void loadUsers();
    void loadGroups();
    if (selectedId) void refreshDetail(selectedId);
  }, [loadUsers, loadGroups, refreshDetail, selectedId]);

  const selectedUsers = useMemo(
    () => users.filter((u) => checkedIds.has(u.id)),
    [users, checkedIds],
  );

  const bulkDisable = useCallback(async () => {
    setBulkBusy(true);
    setBulkError(null);
    const failures: string[] = [];
    for (const u of selectedUsers) {
      if (!canOffboard(u) || u.disabledAt != null) continue;
      try {
        await apiClient.admin.users.disable(u.id);
      } catch (e) {
        failures.push(friendlyOffboardFailure(e, formatUserIdentity(u), "disable"));
      }
    }
    setBulkBusy(false);
    if (failures.length > 0) {
      // Keep the selection so the bulk bar (and this error) stay visible —
      // otherwise clearing the selection unmounts the bar and the failure
      // looks like a silent refresh. Reload data without dropping selection.
      setBulkError(failures.join(" · "));
      void loadUsers();
      void loadGroups();
      if (selectedId) void refreshDetail(selectedId);
      return;
    }
    refreshUsers();
  }, [selectedUsers, refreshUsers, loadUsers, loadGroups, selectedId, refreshDetail]);

  const bulkEnable = useCallback(async () => {
    setBulkBusy(true);
    setBulkError(null);
    const failures: string[] = [];
    for (const u of selectedUsers) {
      if (!canOffboard(u) || u.disabledAt == null) continue;
      try {
        await apiClient.admin.users.enable(u.id);
      } catch (e) {
        failures.push(
          `${formatUserIdentity(u)} — ${e instanceof Error ? e.message : "couldn't enable"}`,
        );
      }
    }
    setBulkBusy(false);
    if (failures.length > 0) {
      setBulkError(failures.join(" · "));
      void loadUsers();
      void loadGroups();
      if (selectedId) void refreshDetail(selectedId);
      return;
    }
    refreshUsers();
  }, [selectedUsers, refreshUsers, loadUsers, loadGroups, selectedId, refreshDetail]);

  const anyActiveSelected = useMemo(
    () => selectedUsers.some((u) => canOffboard(u) && u.disabledAt == null),
    [selectedUsers],
  );
  const anyDisabledSelected = useMemo(
    () => selectedUsers.some((u) => canOffboard(u) && u.disabledAt != null),
    [selectedUsers],
  );

  return (
    <section
      id="users"
      data-testid="admin-users-section"
      className="rounded-lg border border-border bg-background-panel"
      aria-labelledby="users-title"
    >
      <header className="border-b border-border px-5 py-3">
        <h2 id="users-title" className="text-sm font-semibold">
          Users
        </h2>
        <p className="mt-1 text-xs text-foreground-muted">
          Server-wide user directory. Select a user to manage roles; check
          multiple to disable or delete in bulk.
        </p>
      </header>

      <div className="px-5 py-4">
        {!canManageMembers ? (
          <p className="text-sm text-foreground-muted">
            You don&apos;t have permission to manage server users.
          </p>
        ) : (
          <div className="relative">
            <form
              className="mb-3 flex flex-col gap-2 sm:flex-row"
              role="search"
              onSubmit={(event) => {
                event.preventDefault();
                setSelectedId(null);
                setDetailUser(null);
                setDetailError(null);
                clearSelection();
                setSearchQuery(searchInput.trim());
              }}
            >
              <label className="min-w-0 flex-1">
                <span className="sr-only">Search users</span>
                <input
                  type="search"
                  aria-label="Search users"
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  placeholder="Search by name or handle"
                  className="w-full rounded-md border border-border bg-background-element px-3 py-2 text-sm text-foreground"
                />
              </label>
              <button
                type="submit"
                className="rounded-md border border-border bg-background-element px-3 py-2 text-sm font-medium hover:border-border-strong"
              >
                Search
              </button>
              {searchQuery ? (
                <button
                  type="button"
                  className="rounded-md px-3 py-2 text-sm text-foreground-muted hover:text-foreground"
                  onClick={() => {
                    setSearchInput("");
                    setSearchQuery("");
                  }}
                >
                  Clear
                </button>
              ) : null}
            </form>
            <UsersDirectory
              users={users}
              selectedId={selectedId}
              selectedIds={checkedIds}
              loading={loading}
              loadingMore={loadingMore}
              listError={listError}
              hasMore={nextCursor != null}
              onSelect={onSelectUser}
              onToggleCheck={onToggleCheck}
              onToggleAll={onToggleAll}
              onLoadMore={loadMore}
              onRefresh={refreshUsers}
            />

            {/* D298 — bulk action bar */}
            {checkedIds.size > 0 ? (
              <div
                data-testid="bulk-action-bar"
                className="sticky bottom-2 mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-background-element px-4 py-2 shadow-lg"
              >
                <span className="text-sm font-medium">
                  {checkedIds.size} selected
                </span>
                {anyActiveSelected ? (
                  <button
                    type="button"
                    onClick={() => void bulkDisable()}
                    disabled={bulkBusy}
                    className="rounded-md border border-border px-2.5 py-1 text-sm hover:bg-background-panel disabled:opacity-50"
                  >
                    Disable
                  </button>
                ) : null}
                {anyDisabledSelected ? (
                  <button
                    type="button"
                    onClick={() => void bulkEnable()}
                    disabled={bulkBusy}
                    className="rounded-md border border-border px-2.5 py-1 text-sm hover:bg-background-panel disabled:opacity-50"
                  >
                    Enable
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setShowBulkDelete(true)}
                  disabled={bulkBusy}
                  className="rounded-md border border-[var(--error)] px-2.5 py-1 text-sm text-[var(--error)] hover:bg-background-panel disabled:opacity-50"
                >
                  Delete…
                </button>
                <button
                  type="button"
                  onClick={clearSelection}
                  className="ml-auto text-xs text-foreground-muted hover:text-foreground"
                >
                  ✕ clear
                </button>
                {bulkError ? (
                  <span className="w-full text-xs text-[var(--error)]" role="alert">
                    {bulkError}
                  </span>
                ) : null}
              </div>
            ) : null}

            {/* D298 — single-user detail as a right-side drawer */}
            {selectedId ? (
              <div className="fixed inset-0 z-40 flex justify-end bg-black/30">
                <button
                  type="button"
                  aria-label="Close detail"
                  className="flex-1"
                  onClick={() => onSelectUser(selectedId)}
                />
                <div className="h-full w-full max-w-md overflow-y-auto border-l border-border bg-background-panel p-5 shadow-xl">
                  <div className="mb-3 flex justify-end">
                    <button
                      type="button"
                      aria-label="Close"
                      onClick={() => onSelectUser(selectedId)}
                      className="rounded px-2 py-1 text-sm text-foreground-muted hover:bg-background-element"
                    >
                      ✕
                    </button>
                  </div>
                  <UserDetailPanel
                    user={detailUser}
                    loading={detailLoading && detailUser == null}
                    error={detailError}
                    canManageMembers={canManageMembers}
                    canManageUncontainedHostCommands={canManageUncontainedHostCommands}
                    isOwner={canTransferOwnership}
                    ownersCount={ownersCount}
                    sessionUserId={viewer.sessionUserId}
                    canonicalGroups={canonicalGroups}
                    groupsLoading={groupsLoading}
                    groupsError={groupsError}
                    onUserUpdated={onUserUpdated}
                    onUserDeleted={refreshUsers}
                  />
                </div>
              </div>
            ) : null}

            {showBulkDelete ? (
              <BulkDeleteDialog
                users={selectedUsers}
                onClose={() => setShowBulkDelete(false)}
                onDone={refreshUsers}
              />
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}
