import { useCallback, useRef, useState, type ReactElement } from "react";
import { useAuth } from "../../../hooks/use-auth";
import { useCan } from "../../../hooks/use-can";
import { apiClient } from "../../../lib/api";
import {
  SelectablePicker,
  memberKey,
  toSelectableCandidate,
  type SelectableCandidate,
  type SelectedMeta,
} from "./SelectablePicker";

type CreateMember = { kind: "user" | "agent"; id: string };

/**
 * A successful create response is the only authoritative confirmation that
 * every person selected in this dialog actually made it into the room.
 */
function responseMatchesRequestedRoster(
  members: readonly {
    kind: "user" | "agent";
    userId?: string;
    agentId?: string;
  }[],
  requestedMembers: readonly CreateMember[],
  allowExtraMembers: boolean,
): boolean {
  const returnedKeys = members.map((member) => {
    const id = member.kind === "user" ? member.userId : member.agentId;
    return id ? memberKey(member.kind, id) : null;
  });
  const requestedKeys = requestedMembers.map((member) => memberKey(member.kind, member.id));
  if (returnedKeys.some((key) => key === null)) {
    return false;
  }
  const returnedMembers = new Set(returnedKeys);
  const requestedSet = new Set(requestedKeys);
  if (requestedSet.size !== requestedKeys.length || returnedMembers.size !== returnedKeys.length) {
    return false;
  }
  if (!requestedKeys.every((key) => returnedKeys.filter((returned) => returned === key).length === 1)) {
    return false;
  }
  if (allowExtraMembers) return true;
  return (
    returnedKeys.length === requestedKeys.length &&
    requestedKeys.every((key) => returnedMembers.has(key))
  );
}

/**
 * Auto-name a room from the selected members' display names (sourced from the
 * dialog's selected-metadata cache, not a fully-loaded directory) plus the
 * viewer's label. `viewerLabel` is already resolved by the caller.
 */
function deriveRoomLabel(
  viewerLabel: string,
  otherUserNames: readonly string[],
  agentNames: readonly string[],
): string {
  // Pure agent room (just me + Genie etc.) — name after the agents.
  if (otherUserNames.length === 0 && agentNames.length > 0) {
    if (agentNames.length === 1) {
      return `${viewerLabel} · ${agentNames[0] ?? "Agent"}`;
    }
    return `${viewerLabel} · ${agentNames.join(", ")}`;
  }

  // Pure DM (1 other human, no agents) — name after the peer.
  if (otherUserNames.length === 1 && agentNames.length === 0) {
    return otherUserNames[0] ?? "Direct message";
  }

  // Mixed / group — list everyone.
  const all = [...otherUserNames, viewerLabel, ...agentNames].join(", ");
  return all.length > 80 ? `${all.slice(0, 77)}…` : all;
}

export function NewConversationDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (roomId: string) => void;
}): ReactElement {
  const auth = useAuth();
  const can = useCan();
  const canCreateRooms = can("create_rooms") || can("manage_rooms");
  const canCreatePublic = can("manage_rooms");
  const canInvokeAgents = can("invoke_agents");
  const viewerUserId = auth.viewer.sessionUserId;
  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set());
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set());
  // React state keeps the visible picker current; these refs are the submit
  // source of truth. Updating them synchronously means a final picker click
  // cannot be lost when the user immediately presses Create.
  const selectedUsersRef = useRef<ReadonlySet<string>>(new Set());
  const selectedAgentsRef = useRef<ReadonlySet<string>>(new Set());
  // Display metadata for every member ever toggled on, keyed by `memberKey`.
  // Chips + room naming read from here, since server search results change
  // per query and a selected member may not be in the current result set.
  const [selectedMeta, setSelectedMeta] = useState<Map<string, SelectedMeta>>(new Map());
  const selectedMetaRef = useRef<ReadonlyMap<string, SelectedMeta>>(new Map());
  const [customLabel, setCustomLabel] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  // The dialog owns the data source now: server directory search, mapped to
  // picker candidates. The picker owns the query/debounce/ordering.
  const search = useCallback(
    (q: string): Promise<SelectableCandidate[]> =>
      apiClient
        .searchDirectory({ q, kind: "both", limit: 20 })
        .then((rows) => rows.map(toSelectableCandidate)),
    [],
  );

  const handleToggle = useCallback((candidate: SelectableCandidate) => {
    if (candidate.kind === "agent" && !canInvokeAgents) return;
    const key = memberKey(candidate.kind, candidate.id);
    // Cache the candidate's metadata on the way in, so its chip and name
    // survive after the search results move on.
    if (!selectedMetaRef.current.has(key)) {
      const next = new Map(selectedMetaRef.current);
      next.set(key, candidate);
      selectedMetaRef.current = next;
      setSelectedMeta(next);
    }
    if (candidate.kind === "user") {
      const next = new Set(selectedUsersRef.current);
      if (next.has(candidate.id)) next.delete(candidate.id);
      else next.add(candidate.id);
      selectedUsersRef.current = next;
      setSelectedUsers(next);
      return;
    }
    const next = new Set(selectedAgentsRef.current);
    if (next.has(candidate.id)) next.delete(candidate.id);
    else next.add(candidate.id);
    selectedAgentsRef.current = next;
    setSelectedAgents(next);
  }, [canInvokeAgents]);

  const handleSetVisibleSelection = useCallback((
    candidates: readonly SelectableCandidate[],
    selected: boolean,
  ) => {
    const nextUsers = new Set(selectedUsersRef.current);
    const nextAgents = new Set(selectedAgentsRef.current);
    const nextMeta = new Map(selectedMetaRef.current);
    for (const candidate of candidates) {
      if (candidate.actionable === false) continue;
      if (candidate.kind === "agent" && !canInvokeAgents) continue;
      const target = candidate.kind === "user" ? nextUsers : nextAgents;
      if (selected) {
        target.add(candidate.id);
        nextMeta.set(memberKey(candidate.kind, candidate.id), candidate);
      } else {
        target.delete(candidate.id);
      }
    }
    selectedUsersRef.current = nextUsers;
    selectedAgentsRef.current = nextAgents;
    selectedMetaRef.current = nextMeta;
    setSelectedUsers(nextUsers);
    setSelectedAgents(nextAgents);
    setSelectedMeta(nextMeta);
  }, [canInvokeAgents]);

  const handleCreate = useCallback(async () => {
    if (creatingRef.current) return;
    if (!viewerUserId) {
      setError("Sign in to start a conversation.");
      return;
    }
    // Take one immutable-in-practice snapshot for all of the request, naming,
    // and response validation. Never re-read live picker state after this.
    const userIds = [...selectedUsersRef.current].filter((id) => id !== viewerUserId);
    const agentIds = canInvokeAgents ? [...selectedAgentsRef.current] : [];
    if (!isPublic && userIds.length === 0 && agentIds.length === 0) {
      setError("Pick at least one person or agent.");
      return;
    }
    creatingRef.current = true;
    setCreating(true);
    setError(null);
    try {
      const viewerLabel = auth.viewer.label?.trim() || "You";
      const otherUserNames = userIds.map(
        (id) => selectedMetaRef.current.get(memberKey("user", id))?.displayName ?? id,
      );
      const agentNames = agentIds.map(
        (id) => selectedMetaRef.current.get(memberKey("agent", id))?.displayName ?? id,
      );
      const derivedLabel = deriveRoomLabel(viewerLabel, otherUserNames, agentNames);
      const label = customLabel.trim() || derivedLabel;
      const memberIds: CreateMember[] = [
        { kind: "user", id: viewerUserId },
        ...userIds.map((id): CreateMember => ({ kind: "user", id })),
        ...agentIds.map((id): CreateMember => ({ kind: "agent", id })),
      ];
      const isHumanDirect = !isPublic && userIds.length === 1 && agentIds.length === 0;
      if (!isHumanDirect && !canCreateRooms) {
        setError("You can message people directly, but your Server role cannot create shared Rooms.");
        return;
      }
      const detail = await apiClient.createRoom(
        isHumanDirect
          ? { label, directHumanUserId: userIds[0] }
          : {
              label,
              members: memberIds,
              ...(isPublic ? { kind: "open" as const } : {}),
            },
      );
      if (!responseMatchesRequestedRoster(detail.members, memberIds, isPublic)) {
        setError(
          "The server returned a mismatched member roster. This dialog is still open, but do not retry blindly; check your rooms first.",
        );
        return;
      }
      onCreated(detail.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create room.");
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }, [
    auth.viewer.label,
    canCreateRooms,
    canInvokeAgents,
    customLabel,
    isPublic,
    onClose,
    onCreated,
    viewerUserId,
  ]);

  if (!viewerUserId) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="presentation">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="new-conv-title"
          className="w-full max-w-md rounded-lg border border-border bg-background-panel p-4 shadow-lg"
        >
          <h2 id="new-conv-title" className="text-sm font-semibold text-foreground">
            New conversation
          </h2>
          <p className="mt-2 text-xs text-foreground-muted">Sign in to create a conversation.</p>
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              className="rounded border border-border bg-background px-3 py-1 text-xs font-medium hover:bg-background-element"
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Submit-button label adapts to the selection so the user knows
  // exactly what they're about to create.
  const userCount = selectedUsers.size;
  const agentCount = selectedAgents.size;
  const primaryLabel = (() => {
    if (userCount === 0 && agentCount === 0) {
      return isPublic ? "Create public room" : "Pick someone";
    }
    if (userCount === 1 && agentCount === 0) return "Open DM";
    if (userCount === 0 && agentCount === 1) {
      const only = [...selectedAgents][0];
      const name = only ? selectedMeta.get(memberKey("agent", only))?.displayName : undefined;
      return `Open chat with ${name ?? "agent"}`;
    }
    if (userCount === 0 && agentCount > 1) {
      return `Open chat with ${agentCount} agents`;
    }
    if (userCount > 0 && agentCount === 0) {
      return `Create group with ${userCount} ${userCount === 1 ? "person" : "people"}`;
    }
    // Mixed: at least 1 user + 1 agent.
    return `Create chat with ${userCount} ${userCount === 1 ? "person" : "people"} + ${agentCount} ${agentCount === 1 ? "agent" : "agents"}`;
  })();

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
        aria-labelledby="new-conv-title"
        className="flex max-h-[min(640px,90vh)] w-full max-w-md flex-col rounded-lg border border-border bg-background-panel shadow-lg"
      >
        <div className="border-b border-border px-4 py-3">
          <h2 id="new-conv-title" className="text-sm font-semibold text-foreground">
            New conversation
          </h2>
          <p className="mt-1 text-[11px] text-foreground-muted">
            {canInvokeAgents ? "Pick humans, agents, or both." : "Pick people for this conversation."}
          </p>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
          <section className="flex flex-col gap-1.5">
            <label htmlFor="new-conv-name" className="text-[10px] font-semibold uppercase tracking-wide text-foreground-muted">
              Name (optional)
            </label>
            <input
              id="new-conv-name"
              type="text"
              value={customLabel}
              onChange={(e) => setCustomLabel(e.target.value)}
              placeholder="#project-x"
              className="rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none ring-primary focus:ring-1"
            />
            <p className="text-[11px] text-foreground-muted">Leave blank to auto-name from members.</p>
          </section>
          <section className="flex min-h-0 flex-col gap-2">
            <h3 className="text-[10px] font-semibold uppercase tracking-wide text-foreground-muted">
              Members
            </h3>
            <SelectablePicker
              search={search}
              viewerUserId={viewerUserId}
              selectedUserIds={selectedUsers}
              selectedAgentIds={selectedAgents}
              selectedMeta={selectedMeta}
              onToggle={handleToggle}
              onSetVisibleSelection={handleSetVisibleSelection}
            />
          </section>
          <section className="flex flex-col gap-2 rounded border border-border bg-background px-3 py-2">
            <h3 className="text-[10px] font-semibold uppercase tracking-wide text-foreground-muted">
              Discoverability
            </h3>
            <label className="flex cursor-pointer items-start gap-2 text-xs text-foreground">
              <input
                type="radio"
                name="discoverability"
                checked={!isPublic}
                onChange={() => setIsPublic(false)}
                className="mt-0.5"
              />
              <span>Private — only invited members</span>
            </label>
            <label
              className={`flex items-start gap-2 text-xs ${canCreatePublic ? "cursor-pointer text-foreground" : "cursor-not-allowed text-foreground-muted"}`}
              title={canCreatePublic ? undefined : "Only admins can create public rooms"}
            >
              <input
                type="radio"
                name="discoverability"
                checked={isPublic}
                disabled={!canCreatePublic}
                onChange={() => setIsPublic(true)}
                className="mt-0.5"
              />
              <span>Public — anyone on this server can find and join</span>
            </label>
          </section>
          {error ? (
            <p className="text-xs text-amber-700 dark:text-amber-400" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            className="rounded border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-background-element"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={(!isPublic && userCount === 0 && agentCount === 0) || creating}
            className="rounded border border-primary bg-primary px-3 py-1.5 text-xs font-medium text-[var(--on-primary)] disabled:opacity-50"
            onClick={() => void handleCreate()}
          >
            {creating ? "Creating…" : primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
