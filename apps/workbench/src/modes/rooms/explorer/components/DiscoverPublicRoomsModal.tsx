import { RoomNotOpenError } from "@nautilo/api-client/browser";
import type { RoomSummaryDto } from "@nautilo/types";
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useToast } from "../../../../components/toast";
import { apiClient } from "../../../../lib/api";

function formatActiveAge(raw: string | null | undefined, nowMs: number): string {
  if (!raw) return "quiet";
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return "quiet";
  const diffMs = Math.max(0, nowMs - ms);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  if (diffMs < minute) return "active now";
  if (diffMs < hour) return `active ${Math.floor(diffMs / minute)}m`;
  if (diffMs < day) return `active ${Math.floor(diffMs / hour)}h`;
  if (diffMs < week) return `active ${Math.floor(diffMs / day)}d`;
  return `active ${Math.floor(diffMs / week)}w`;
}

function roomDisplayLabel(label: string): string {
  return label.startsWith("#") ? label : `# ${label}`;
}

function memberCopy(count: number): string {
  return `${count} member${count === 1 ? "" : "s"}`;
}

export function DiscoverPublicRoomsModal({
  onClose,
  onJoined,
}: {
  onClose: () => void;
  onJoined: (roomId: string) => void;
}): ReactElement {
  const toast = useToast();
  const [rooms, setRooms] = useState<readonly RoomSummaryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [joinedIds, setJoinedIds] = useState<ReadonlySet<string>>(new Set());
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const nowMs = useMemo(() => Date.now(), []);

  const loadRooms = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const body = await apiClient.listDiscoverableRooms();
      setRooms(body.rooms);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load public rooms.");
      setRooms([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRooms();
  }, [loadRooms]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rooms;
    return rooms.filter((r) => r.label.toLowerCase().includes(q));
  }, [query, rooms]);

  const handleJoin = useCallback(
    async (room: RoomSummaryDto) => {
      if (joinedIds.has(room.id) || joiningId === room.id) return;
      setJoiningId(room.id);
      try {
        await apiClient.joinOpenRoom(room.id);
        setJoinedIds((prev) => new Set([...prev, room.id]));
        onJoined(room.id);
      } catch (e) {
        if (e instanceof RoomNotOpenError) {
          toast.show({
            variant: "error",
            message: "This room is no longer public",
          });
          setRooms((prev) => prev.filter((r) => r.id !== room.id));
          return;
        }
        toast.show({
          variant: "error",
          message: `Couldn't join ${roomDisplayLabel(room.label)} — try again`,
        });
      } finally {
        setJoiningId(null);
      }
    },
    [joinedIds, joiningId, onJoined, toast],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="discover-public-rooms-title"
        className="flex max-h-[min(640px,90vh)] w-full max-w-lg flex-col rounded-lg border border-border bg-background-panel shadow-lg"
      >
        <div className="border-b border-border px-4 py-3">
          <h2 id="discover-public-rooms-title" className="text-sm font-semibold text-foreground">
            Public rooms on this server
          </h2>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
          <div className="flex items-center gap-2">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none ring-primary focus:ring-1"
              aria-label="Search public rooms"
            />
            {!loading ? (
              <span className="shrink-0 text-[11px] text-foreground-muted tabular-nums">
                {rooms.length} room{rooms.length === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>
          {loading ? (
            <p className="text-xs text-foreground-muted" aria-busy="true">
              Loading public rooms…
            </p>
          ) : error ? (
            <p className="text-xs text-amber-700 dark:text-amber-400" role="alert">
              {error}
            </p>
          ) : filtered.length === 0 ? (
            <p className="text-xs text-foreground-muted">
              {query.trim() ? "No matches." : "No public rooms on this server yet."}
            </p>
          ) : (
            <ul className="min-h-0 divide-y divide-border rounded border border-border bg-background text-xs">
              {filtered.map((room) => {
                const joined = joinedIds.has(room.id);
                const joining = joiningId === room.id;
                const activity = formatActiveAge(room.lastMessageAt ?? room.createdAt, nowMs);
                return (
                  <li key={room.id} className="flex items-center gap-2 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-foreground">
                        {roomDisplayLabel(room.label)}
                      </div>
                      <div className="truncate text-foreground-muted">
                        {memberCopy(room.memberCount)} · {activity}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={joined || joining}
                      className="shrink-0 rounded border border-border bg-background px-2 py-1 text-[11px] font-medium hover:bg-background-element disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={() => void handleJoin(room)}
                    >
                      {joined ? "Joined" : joining ? "Joining…" : "Join"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="border-t border-border px-4 py-3">
          <p className="mb-3 text-[11px] text-foreground-muted">
            Anyone on this server can find and join these rooms.
          </p>
          <div className="flex justify-end">
            <button
              type="button"
              className="rounded border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-background-element"
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
