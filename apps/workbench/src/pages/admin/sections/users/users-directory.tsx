import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button } from "../../../settings/ui";
import type { AdminUserRow } from "./user-helpers";
import {
  USER_STATUS_GLYPH,
  USER_STATUS_LABEL,
  formatUserIdentity,
  userRoleLabel,
  userStatus,
  VIRTUALIZE_THRESHOLD,
} from "./user-helpers";

const ROW_HEIGHT_PX = 56;

function StatusBadge({ user }: { readonly user: AdminUserRow }) {
  const status = userStatus(user);
  const tone =
    status === "active"
      ? "text-[var(--success,#16a34a)]"
      : status === "disabled"
        ? "text-foreground-muted"
        : "text-[var(--info,#3b82f6)]";
  return (
    <span
      data-testid={`user-status-${status}`}
      title={USER_STATUS_LABEL[status]}
      className={`inline-flex shrink-0 items-center gap-1 text-xs ${tone}`}
    >
      <span aria-hidden="true">{USER_STATUS_GLYPH[status]}</span>
      {USER_STATUS_LABEL[status]}
    </span>
  );
}

function UserRow({
  user,
  selected,
  checked,
  onSelect,
  onToggleCheck,
}: {
  readonly user: AdminUserRow;
  readonly selected: boolean;
  readonly checked: boolean;
  readonly onSelect: (id: string) => void;
  readonly onToggleCheck: (id: string) => void;
}) {
  return (
    <div
      aria-current={selected ? "true" : undefined}
      className={[
        "flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors",
        selected
          ? "bg-background-element ring-2 ring-inset ring-primary"
          : "hover:bg-background-element/60",
      ].join(" ")}
    >
      <input
        type="checkbox"
        aria-label={`Select ${formatUserIdentity(user)}`}
        data-testid={`user-check-${user.id}`}
        checked={checked}
        onChange={() => onToggleCheck(user.id)}
        className="shrink-0"
      />
      <button
        type="button"
        data-testid={`user-row-${user.id}`}
        onClick={() => onSelect(user.id)}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">
            {formatUserIdentity(user)}
          </span>
          <span className="block truncate text-xs text-foreground-muted">
            {user.displayName} · {userRoleLabel(user)}
          </span>
        </span>
        <StatusBadge user={user} />
      </button>
    </div>
  );
}

export function UsersDirectory({
  users,
  selectedId,
  selectedIds,
  loading,
  loadingMore,
  listError,
  hasMore,
  onSelect,
  onToggleCheck,
  onToggleAll,
  onLoadMore,
  onRefresh,
}: {
  readonly users: AdminUserRow[];
  readonly selectedId: string | null;
  readonly selectedIds: ReadonlySet<string>;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly listError: string | null;
  readonly hasMore: boolean;
  readonly onSelect: (id: string) => void;
  readonly onToggleCheck: (id: string) => void;
  readonly onToggleAll: () => void;
  readonly onLoadMore: () => void;
  readonly onRefresh: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const useVirtual = users.length > VIRTUALIZE_THRESHOLD;
  const allChecked = users.length > 0 && users.every((u) => selectedIds.has(u.id));

  const virtualizer = useVirtualizer({
    count: users.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: 12,
    getItemKey: (index) => users[index]?.id ?? index,
  });

  return (
    <div data-testid="users-directory">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={onRefresh} disabled={loading}>
          Refresh
        </Button>
        {hasMore ? (
          <Button
            variant="secondary"
            onClick={onLoadMore}
            loading={loadingMore}
            disabled={loading || loadingMore}
          >
            Load more
          </Button>
        ) : null}
        <span className="text-xs text-foreground-dim">
          {users.length} user{users.length === 1 ? "" : "s"}
          {useVirtual ? " · virtualized" : ""}
        </span>
      </div>

      {loading ? (
        <p className="text-sm text-foreground-muted">Loading users…</p>
      ) : listError ? (
        <p className="text-sm text-[var(--error)]">{listError}</p>
      ) : users.length === 0 ? (
        <p className="text-sm text-foreground-muted">
          No users on this server yet. Invites minted from Settings → Members
          create accounts here after redemption.
        </p>
      ) : (
        <div className="rounded-md border border-border/60">
          <div className="flex items-center gap-3 border-b border-border/60 bg-background-panel px-3 py-2">
            <input
              type="checkbox"
              aria-label="Select all users on this page"
              data-testid="user-check-all"
              checked={allChecked}
              onChange={onToggleAll}
              className="shrink-0"
            />
            <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
              Member
            </span>
          </div>
          <div ref={scrollRef} className="max-h-80 overflow-y-auto">
            {useVirtual ? (
              <div
                style={{
                  height: `${virtualizer.getTotalSize()}px`,
                  width: "100%",
                  position: "relative",
                }}
              >
                {virtualizer.getVirtualItems().map((item) => {
                  const user = users[item.index];
                  if (!user) return null;
                  return (
                    <div
                      key={user.id}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        height: `${item.size}px`,
                        transform: `translateY(${item.start}px)`,
                      }}
                    >
                      <UserRow
                        user={user}
                        selected={selectedId === user.id}
                        checked={selectedIds.has(user.id)}
                        onSelect={onSelect}
                        onToggleCheck={onToggleCheck}
                      />
                    </div>
                  );
                })}
              </div>
            ) : (
              <ul className="divide-y divide-border/60">
                {users.map((user) => (
                  <li key={user.id}>
                    <UserRow
                      user={user}
                      selected={selectedId === user.id}
                      checked={selectedIds.has(user.id)}
                      onSelect={onSelect}
                      onToggleCheck={onToggleCheck}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
