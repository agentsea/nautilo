import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import type { RoomConductorMode, RoomMemberDto } from "@nautilo/types";
import { EXPLORER_ROOM_MANAGE_EVENT } from "../explorer/sections/shared/ExplorerRow";
import { apiClient } from "../../../lib/api";
import { useToast } from "../../../components/toast";
import { useRoomFocusContext } from "./room-focus-context";
import { sortMembersByTalking } from "./members-panel-model";
import { AgentCard } from "./AgentCard";
import { MemberFocusAvatar } from "./MemberFocusAvatar";
import type { MembersPanelView } from "./use-members-panel-view";
import { formatSilenceCountdown, useRoomSilence } from "./use-room-silence";
import { useConductorRoutingDeciding } from "./conductor-routing-status";
import { SubagentDock } from "../subagents/SubagentDock";

/**
 * D278 §4.7.4 — the always-on group-room Members / Agent-Manager panel.
 *
 * Rendered as the right panel for Human-only rooms and group rooms so their
 * participant roster and management entry remain reachable. A direct
 * 1-Human + 1-Agent chat keeps the richer §5.2 Agent soul panel. Rooms with
 * Agents also expose focus, conductor, and silence controls; Human-only rooms
 * keep those Agent-specific controls absent. Sorted recent-talking → admin →
 * alpha. Reuses the shipped `useRoomFocus` + `members-panel-model` +
 * `MemberFocusAvatar`.
 *
 * Collapse ladder (Option 2) is owned by `useMembersPanelView` in the shell;
 * this component renders the `full` and `rail` states and exposes the
 * directional controls. The `hidden` state is the shell's edge strip — this
 * component is simply not mounted then.
 *
 * (Deep management — add/remove, permissions, audit — stays in the modal
 * `MembersPanel`.)
 */
const EMPTY_LAST_SPOKE: ReadonlyMap<string, number> = new Map();
const SILENCE_DURATIONS = [
  { label: "15m", value: 15 * 60 * 1000 },
  { label: "30m", value: 30 * 60 * 1000 },
  { label: "1h", value: 60 * 60 * 1000 },
  { label: "4h", value: 4 * 60 * 60 * 1000 },
] as const;

export function MembersManagerPanel({
  roomId,
  roomLabel,
  members,
  conductorMode,
  viewerActorId,
  lastSpokeAtMs,
  view,
  onSetView,
}: {
  readonly roomId: string;
  readonly roomLabel: string;
  readonly members: readonly RoomMemberDto[];
  readonly conductorMode: RoomConductorMode;
  readonly viewerActorId: string;
  readonly lastSpokeAtMs?: ReadonlyMap<string, number>;
  /** Which rendered state — `hidden` is handled by the shell (not mounted). */
  readonly view: "full" | "rail";
  /** Step the collapse ladder (full ⟷ rail ⟷ hidden). */
  readonly onSetView: (next: MembersPanelView) => void;
}): ReactElement {
  const toast = useToast();
  const focus = useRoomFocusContext();
  const roomSilence = useRoomSilence(roomId);
  const [silenceDurationMs, setSilenceDurationMs] = useState(
    SILENCE_DURATIONS[1].value,
  );
  const [localConductorMode, setLocalConductorMode] =
    useState<RoomConductorMode>(conductorMode);
  const [conductorModeBusy, setConductorModeBusy] = useState(false);
  const [memberSearch, setMemberSearch] = useState("");
  const [agentsOnly, setAgentsOnly] = useState(false);
  const routingDeciding = useConductorRoutingDeciding(roomId, viewerActorId || null);

  useEffect(() => {
    setLocalConductorMode(conductorMode);
  }, [conductorMode]);

  const agentCount = members.filter((m) => m.kind === "agent").length;
  const hasAgents = agentCount > 0;
  const showSilence = roomSilence.canManage && agentCount >= 1;
  const activeSilenceCountdown =
    roomSilence.silence != null
      ? formatSilenceCountdown(roomSilence.silence, roomSilence.now)
      : null;
  const activeSilenceKind = activeSilenceCountdown ? roomSilence.silence?.kind : null;

  const viewerIsAdmin = useMemo(
    () => members.some((m) => m.actorId === viewerActorId && m.roomRole === "admin"),
    [members, viewerActorId],
  );
  const viewerUserId =
    members.find((m) => m.actorId === viewerActorId && m.kind === "user")?.userId ?? null;

  const sorted = useMemo(
    () => sortMembersByTalking(members, lastSpokeAtMs ?? EMPTY_LAST_SPOKE),
    [members, lastSpokeAtMs],
  );
  const filteredMembers = useMemo(() => {
    const query = memberSearch.trim().toLocaleLowerCase();
    return sorted.filter((member) => {
      if (agentsOnly && member.kind !== "agent") return false;
      if (!query) return true;
      return [
        member.displayName,
        member.handle,
        member.agentOwnerDisplayName,
        member.agentOwnerHandle,
      ].some((value) => value?.toLocaleLowerCase().includes(query));
    });
  }, [agentsOnly, memberSearch, sorted]);

  // Mode change refetches membership via the existing room-members event bus.
  const onModeChanged = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent("nautilo:room-members-changed", { detail: { roomId } }),
    );
  }, [roomId]);

  const onConductorModeChanged = useCallback(
    async (next: RoomConductorMode) => {
      if (next === localConductorMode) return;
      setConductorModeBusy(true);
      try {
        await apiClient.setRoomConductorMode(roomId, next);
        setLocalConductorMode(next);
        onModeChanged();
        toast.show({
          variant: "success",
          title: next === "advanced" ? "Smart routing on" : "Smart routing off",
          message:
            next === "advanced"
              ? "First-contact routing will use the Floor Manager."
              : "@mentions, replies, and focus still work.",
        });
      } catch (error) {
        toast.show({
          variant: "error",
          title: "Could not change smart routing",
          message: error instanceof Error ? error.message : "Unknown error.",
        });
      } finally {
        setConductorModeBusy(false);
      }
    },
    [localConductorMode, onModeChanged, roomId, toast],
  );

  // Rail (~48px): avatar-only column. Two tiny chevrons — direction follows the
  // app convention for a right-docked panel: ‹ = expand (bring back / more),
  // › = collapse (send away / less). So ‹ → full, › → hidden.
  if (view === "rail") {
    return (
      <section
        className="flex h-full w-full flex-col items-center gap-1.5 overflow-y-auto py-1.5"
        aria-label={`Members (${members.length})`}
        data-testid="members-manager-panel"
        data-view="rail"
      >
        <button
          type="button"
          onClick={() => onSetView("full")}
          title="Expand members panel"
          aria-label="Expand members panel"
          data-testid="members-rail-expand"
          className="rounded px-1 text-foreground-muted hover:bg-background hover:text-foreground"
        >
          ‹
        </button>
        <button
          type="button"
          onClick={() => onSetView("hidden")}
          title="Hide members panel"
          aria-label="Hide members panel"
          data-testid="members-rail-hide"
          className="rounded px-1 text-foreground-muted hover:bg-background hover:text-foreground"
        >
          ›
        </button>
        <span className="my-0.5 h-px w-6 bg-border" aria-hidden />
        {hasAgents ? (
          <span
            className={[
              "rounded border px-1 py-0.5 text-[9px] uppercase tracking-wide",
              routingDeciding
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-border text-foreground-muted",
            ].join(" ")}
            title={
              routingDeciding
                ? "Smart routing is deciding who should reply"
                : `Smart routing ${localConductorMode === "advanced" ? "on" : "off"}`
            }
            data-testid="members-rail-conductor-mode"
          >
            {routingDeciding ? "R" : localConductorMode === "advanced" ? "On" : "Off"}
          </span>
        ) : null}
        {sorted.map((m) => (
          <MemberFocusAvatar key={m.actorId} member={m} focus={focus} size="sm" roomId={roomId} />
        ))}
        <SubagentDock className="mt-auto w-full" />
      </section>
    );
  }

  // Full: agent cards. Collapse chevron sits top-LEFT (matching the shell's
  // ContextPanelCollapseChevron muscle memory) and points › = collapse to rail.
  return (
    <section
      className="flex h-full min-h-0 flex-col gap-1 overflow-hidden p-2"
      aria-label={`Members (${members.length})`}
      data-testid="members-manager-panel"
      data-view="full"
    >
      <header className="flex items-center gap-1 py-1 pl-1 pr-2">
        <button
          type="button"
          onClick={() => onSetView("rail")}
          title="Minimize members panel"
          aria-label="Minimize members panel"
          data-testid="members-panel-minimize"
          className="flex h-5 w-5 items-center justify-center rounded text-sm text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground"
        >
          ›
        </button>
        <div className="min-w-0 flex-1">
          {roomLabel ? (
            <div className="truncate text-xs font-semibold text-foreground">{roomLabel}</div>
          ) : null}
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-foreground-muted">
              Members {members.length}
            </span>
            <button
              type="button"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent(EXPLORER_ROOM_MANAGE_EVENT, {
                    detail: { roomId, label: roomLabel, focus: "members" },
                  }),
                )
              }
              aria-label="Manage members"
              title="Manage members"
              data-testid="members-panel-manage"
              className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground"
            >
              Manage
            </button>
          </div>
        </div>
      </header>
      {hasAgents ? (
        <div
          className="shrink-0 rounded border border-border/80 px-2 py-1.5"
          data-testid="members-manager-conductor-mode"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-foreground">Smart routing</span>
            <span className="text-[10px] text-foreground-muted">
              {localConductorMode === "advanced" ? "On" : "Off"}
            </span>
          </div>
          {roomSilence.canManage ? (
            <fieldset
              className="mt-1.5 flex gap-1.5 border-0 p-0"
              disabled={conductorModeBusy}
            >
              {(
                [
                  { mode: "advanced", label: "On" },
                  { mode: "standard", label: "Off" },
                ] as const
              ).map(({ mode, label }) => {
                const active = localConductorMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    disabled={conductorModeBusy}
                    aria-pressed={active}
                    onClick={() => void onConductorModeChanged(mode)}
                    data-testid={`manager-conductor-${mode}`}
                    className={[
                      "flex-1 rounded border px-2 py-1 text-left text-[11px] hover:bg-background-element disabled:opacity-50",
                      active
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border bg-background text-foreground",
                    ].join(" ")}
                  >
                    {label}
                  </button>
                );
              })}
            </fieldset>
          ) : null}
          <p className="mt-1 text-[10px] text-foreground-muted">
            Off keeps @mentions, replies, and focus; only smart first-contact routing is disabled.
          </p>
          <div
            className={[
              "mt-1 flex items-center justify-between rounded px-1.5 py-1 text-[10px]",
              routingDeciding
                ? "bg-primary/10 text-primary"
                : "bg-background text-foreground-muted",
            ].join(" ")}
            role="status"
            aria-live="polite"
            data-testid="members-manager-routing-status"
          >
            <span>Routing</span>
            <span>{routingDeciding ? "deciding…" : "idle"}</span>
          </div>
        </div>
      ) : null}
      {showSilence ? (
        <div
          className="shrink-0 rounded border border-border/80 px-2 py-1.5"
          data-testid="members-panel-silence"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-foreground">Bot silence</span>
            <label className="flex items-center gap-1.5 text-[10px] text-foreground-muted">
              Duration
              <select
                data-testid="panel-silence-duration"
                value={silenceDurationMs}
                disabled={roomSilence.busy || activeSilenceKind !== null}
                onChange={(event) => setSilenceDurationMs(Number(event.target.value))}
                className="rounded border border-border bg-background px-1.5 py-0.5 text-[11px] text-foreground disabled:opacity-60"
              >
                {SILENCE_DURATIONS.map((duration) => (
                  <option key={duration.value} value={duration.value}>
                    {duration.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="mt-1.5 flex gap-1.5">
            <button
              type="button"
              data-testid="panel-silence-mute"
              disabled={roomSilence.busy}
              onClick={() =>
                activeSilenceKind === "mute"
                  ? roomSilence.clear()
                  : roomSilence.start("mute", silenceDurationMs)
              }
              className={[
                "flex-1 rounded border px-2 py-1 text-left text-[11px] hover:bg-background-element disabled:opacity-50",
                activeSilenceKind === "mute"
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border bg-background text-foreground",
              ].join(" ")}
              aria-pressed={activeSilenceKind === "mute"}
              title="Mute: bots stay quiet but still keep context"
            >
              {activeSilenceKind === "mute" && activeSilenceCountdown
                ? `Muted · ${activeSilenceCountdown}`
                : "Mute"}
            </button>
            <button
              type="button"
              data-testid="panel-silence-deaf"
              disabled={roomSilence.busy}
              onClick={() =>
                activeSilenceKind === "deaf"
                  ? roomSilence.clear()
                  : roomSilence.start("deaf", silenceDurationMs)
              }
              className={[
                "flex-1 rounded border px-2 py-1 text-left text-[11px] hover:bg-background-element disabled:opacity-50",
                activeSilenceKind === "deaf"
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border bg-background text-foreground",
              ].join(" ")}
              aria-pressed={activeSilenceKind === "deaf"}
              title="Deafen: bots miss messages sent during this window"
            >
              {activeSilenceKind === "deaf" && activeSilenceCountdown
                ? `Deafened · ${activeSilenceCountdown}`
                : "Deafen"}
            </button>
          </div>
          <p className="mt-1 text-[10px] text-foreground-muted">
            {activeSilenceKind === "deaf"
              ? "Bots miss messages during this window. Press again to clear."
              : activeSilenceKind === "mute"
                ? "Bots stay quiet but keep context. Press again to clear."
                : "Mute = quiet. Deafen = bots miss messages."}
          </p>
        </div>
      ) : null}
      <div
        className="flex shrink-0 items-center gap-1.5"
        data-testid="members-panel-roster-controls"
      >
        <label className="min-w-0 flex-1">
          <span className="sr-only">Search members</span>
          <input
            type="search"
            value={memberSearch}
            onChange={(event) => setMemberSearch(event.target.value)}
            placeholder="Search members"
            aria-label="Search members"
            data-testid="members-panel-search"
            className="w-full rounded border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-foreground-muted"
          />
        </label>
        <button
          type="button"
          aria-pressed={agentsOnly}
          onClick={() => setAgentsOnly((current) => !current)}
          data-testid="members-panel-agents-only"
          className={[
            "shrink-0 rounded border px-2 py-1 text-[11px] font-medium",
            agentsOnly
              ? "border-primary bg-primary/10 text-foreground"
              : "border-border bg-background text-foreground-muted hover:bg-background-element hover:text-foreground",
          ].join(" ")}
        >
          Agents only
        </button>
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        data-testid="members-panel-roster"
        aria-label="Member roster"
      >
        {filteredMembers.length > 0 ? (
          <ul className="flex flex-col gap-0.5">
            {filteredMembers.map((m) => (
              <li key={m.actorId}>
                <AgentCard
                  member={m}
                  roomId={roomId}
                  focus={focus}
                  viewerIsAdmin={viewerIsAdmin}
                  viewerUserId={viewerUserId}
                  onModeChanged={onModeChanged}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p
            className="px-1 py-2 text-xs text-foreground-muted"
            data-testid="members-panel-empty"
          >
            No members match.
          </p>
        )}
      </div>
      <SubagentDock />
    </section>
  );
}
