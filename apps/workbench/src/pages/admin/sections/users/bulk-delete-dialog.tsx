import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type AdminUserRow,
  type OwnedSharedRoom,
} from "@nautilo/api-client/browser";
import { apiClient } from "../../../../lib/api";
import { Button } from "../../../settings/ui";
import { canOffboard, formatUserIdentity, friendlyOffboardFailure } from "./user-helpers";

/**
 * D298 — bulk delete with mixed guard states. Classifies the selection into
 * ready / needs-resolution / can't-delete, never silently dropping blocked
 * rows. Shared-room owners are resolved via ownership transfer (per room)
 * before they become deletable. Confirm only deletes the ready set.
 */

interface UserPlan {
  user: AdminUserRow;
  /** Shared rooms (owned, with other members) still blocking this user. */
  blockingRooms: OwnedSharedRoom[];
}

type LoadState = "loading" | "ready" | { error: string };

function confirmPhrase(n: number): string {
  return `delete ${n} user${n === 1 ? "" : "s"}`;
}

export function BulkDeleteDialog({
  users,
  onClose,
  onDone,
}: {
  readonly users: AdminUserRow[];
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const [load, setLoad] = useState<LoadState>("loading");
  const [plans, setPlans] = useState<UserPlan[]>([]);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /** Friendly per-user failures from the last delete attempt (e.g. last owner). */
  const [failures, setFailures] = useState<string[]>([]);

  const federated = useMemo(() => users.filter((u) => !canOffboard(u)), [users]);
  const localUsers = useMemo(() => users.filter(canOffboard), [users]);

  const refreshPlans = useCallback(async () => {
    setLoad("loading");
    try {
      const built = await Promise.all(
        localUsers.map(async (user) => {
          const { rooms } = await apiClient.admin.users.ownedSharedRooms(user.id);
          return { user, blockingRooms: rooms } satisfies UserPlan;
        }),
      );
      setPlans(built);
      setLoad("ready");
    } catch (e) {
      setLoad({ error: e instanceof Error ? e.message : "Failed to inspect users." });
    }
  }, [localUsers]);

  useEffect(() => {
    void refreshPlans();
  }, [refreshPlans]);

  const ready = plans.filter((p) => p.blockingRooms.length === 0);
  const needsResolution = plans.filter((p) => p.blockingRooms.length > 0);
  const readyCount = ready.length;

  const transfer = async (roomId: string, newOwnerUserId: string) => {
    setActionError(null);
    setBusy(true);
    try {
      await apiClient.admin.rooms.transferOwner(roomId, newOwnerUserId);
      await refreshPlans();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Transfer failed.");
    } finally {
      setBusy(false);
    }
  };

  const archive = async (roomId: string) => {
    setActionError(null);
    setBusy(true);
    try {
      await apiClient.admin.rooms.archive(roomId);
      await refreshPlans();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Archive failed.");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (confirm !== confirmPhrase(readyCount) || readyCount === 0) return;
    setBusy(true);
    setActionError(null);
    setFailures([]);
    const fails: string[] = [];
    for (const p of ready) {
      try {
        await apiClient.admin.users.delete(p.user.id);
      } catch (e) {
        fails.push(friendlyOffboardFailure(e, formatUserIdentity(p.user), "delete"));
      }
    }
    setBusy(false);
    if (fails.length > 0) {
      setFailures(fails);
      await refreshPlans();
      return;
    }
    onDone();
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Delete users"
      data-testid="bulk-delete-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-lg border border-border bg-background-panel p-5 shadow-xl">
        <h3 className="text-sm font-semibold">
          Delete {users.length} member{users.length === 1 ? "" : "s"}?
        </h3>

        {load === "loading" ? (
          <p className="mt-3 text-sm text-foreground-muted">Inspecting members…</p>
        ) : typeof load === "object" ? (
          <p className="mt-3 text-sm text-[var(--error)]">{load.error}</p>
        ) : (
          <div className="mt-4 space-y-4">
            {readyCount > 0 ? (
              <section>
                <h4 className="text-xs font-semibold text-[var(--success,#16a34a)]">
                  Ready to delete ({readyCount})
                </h4>
                <ul className="mt-1 space-y-0.5">
                  {ready.map((p) => (
                    <li key={p.user.id} className="text-sm">
                      ✓ {formatUserIdentity(p.user)}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {needsResolution.length > 0 ? (
              <section>
                <h4 className="text-xs font-semibold text-[var(--warning,#d97706)]">
                  Needs resolution ({needsResolution.length})
                </h4>
                <div className="mt-1 space-y-3">
                  {needsResolution.map((p) => (
                    <div
                      key={p.user.id}
                      className="rounded-md border border-border/60 bg-background-element/40 p-2"
                    >
                      <div className="text-sm">
                        ⚠ {formatUserIdentity(p.user)} owns{" "}
                        {p.blockingRooms.length} shared room
                        {p.blockingRooms.length === 1 ? "" : "s"}
                      </div>
                      <ul className="mt-2 space-y-2">
                        {p.blockingRooms.map((room) => (
                          <RoomTransferRow
                            key={room.roomId}
                            room={room}
                            disabled={busy}
                            onTransfer={(newOwner) => void transfer(room.roomId, newOwner)}
                            onArchive={() => void archive(room.roomId)}
                          />
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {federated.length > 0 ? (
              <section>
                <h4 className="text-xs font-semibold text-foreground-muted">
                  Can&apos;t delete ({federated.length})
                </h4>
                <ul className="mt-1 space-y-0.5">
                  {federated.map((u) => (
                    <li key={u.id} className="text-sm text-foreground-muted">
                      ✕ {formatUserIdentity(u)} — federated (home server owns it)
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {failures.length > 0 ? (
              <section role="alert">
                <h4 className="text-xs font-semibold text-[var(--error)]">
                  Couldn&apos;t delete ({failures.length})
                </h4>
                <ul className="mt-1 space-y-0.5">
                  {failures.map((f, i) => (
                    <li key={i} className="text-sm text-[var(--error)]">
                      ✕ {f}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {readyCount > 0 ? (
              <div className="border-t border-border/60 pt-3">
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-foreground-muted">
                  <span>Type</span>
                  <code className="rounded-md border border-primary/40 bg-primary/10 px-1.5 py-0.5 font-mono text-xs font-semibold text-primary">
                    {confirmPhrase(readyCount)}
                  </code>
                  <span>to confirm:</span>
                </div>
                <input
                  type="text"
                  aria-label={`Type ${confirmPhrase(readyCount)} to confirm`}
                  data-testid="bulk-delete-confirm"
                  value={confirm}
                  onChange={(e) => {
                    setConfirm(e.target.value);
                    if (failures.length > 0) setFailures([]);
                  }}
                  className="mt-1.5 w-full rounded-md border border-border bg-background-element px-2 py-1.5 text-sm"
                />
                <p className="mt-1 text-[11px] text-foreground-dim">
                  Proceeds with the {readyCount} ready member
                  {readyCount === 1 ? "" : "s"}; skips the rest.
                </p>
              </div>
            ) : (
              <p className="text-xs text-foreground-muted">
                No members are ready to delete. Resolve the blockers above first.
              </p>
            )}

            {actionError ? (
              <p className="text-xs text-[var(--error)]" role="alert">
                {actionError}
              </p>
            ) : null}
          </div>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <button
            type="button"
            data-testid="bulk-delete-submit"
            onClick={() => void handleDelete()}
            disabled={busy || readyCount === 0 || confirm !== confirmPhrase(readyCount)}
            className="rounded-md bg-[var(--error)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Working…" : `Delete ${readyCount} permanently`}
          </button>
        </div>
      </div>
    </div>
  );
}

function RoomTransferRow({
  room,
  disabled,
  onTransfer,
  onArchive,
}: {
  readonly room: OwnedSharedRoom;
  readonly disabled: boolean;
  readonly onTransfer: (newOwnerUserId: string) => void;
  readonly onArchive: () => void;
}) {
  const [pick, setPick] = useState("");
  const noEligible = room.eligibleNewOwners.length === 0;
  return (
    <li className="flex flex-wrap items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-xs">{room.label}</span>
      {noEligible ? (
        <span className="text-[11px] text-foreground-muted">
          No eligible member to transfer to — archive instead.
        </span>
      ) : (
        <>
          <select
            aria-label={`Transfer ${room.label} to`}
            value={pick}
            disabled={disabled}
            onChange={(e) => setPick(e.target.value)}
            className="rounded border border-border bg-background-element px-1.5 py-1 text-xs"
          >
            <option value="">Pick member…</option>
            {room.eligibleNewOwners.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.handle ? `@${m.handle}` : m.displayName}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={disabled || pick === ""}
            onClick={() => onTransfer(pick)}
            className="rounded bg-primary px-2 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            Transfer
          </button>
        </>
      )}
      <button
        type="button"
        disabled={disabled}
        onClick={onArchive}
        className="rounded bg-primary px-2 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
      >
        Archive
      </button>
    </li>
  );
}
