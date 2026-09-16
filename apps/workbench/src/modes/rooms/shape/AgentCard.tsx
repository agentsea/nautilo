import { useCallback, useState } from "react";
import type { ReactElement } from "react";
import type { AgentResponseMode, RoomMemberDto } from "@nautilo/types";
import { apiClient } from "../../../lib/api";
import { useToast } from "../../../components/toast";
import { useProfile } from "../../../hooks/use-profile";
import { useVoiceControls } from "../../../adapters/runtime-contexts";
import { extractSoulEssence } from "../../../components/soul-extract";
import { clampSoulPreview } from "../../../components/soul-preview";
import { MemberFocusAvatar } from "./MemberFocusAvatar";
import { memberTypeSuffix } from "./members-panel-model";
import type { RoomFocusState } from "./use-room-focus";

/**
 * D278 §4.7.4 — a member card in the always-on group-room Members panel.
 *
 * For a **bot**, the whole card is the **single-click focus** control (the
 * primary affordance): click toggles your private focus on that bot. Focus
 * visual states come from `MemberFocusAvatar` + the card accent (focused =
 * accent border; expiring = pulse; ambiguous = dot). **Mode** (active /
 * listening / observe) is a **secondary** per-card dropdown. Humans render
 * presence only (no focus, no mode).
 */
const MODE_LABEL: Record<AgentResponseMode, string> = {
  active: "active",
  mention_only: "listening",
  observe: "observe",
};
const MODE_HELP: Record<AgentResponseMode, string> = {
  active: "Replies to everything",
  mention_only: "Replies when @mentioned or focused",
  observe: "Never replies (reads only)",
};
const MODES: readonly AgentResponseMode[] = ["active", "mention_only", "observe"];

export function AgentCard({
  member,
  roomId,
  focus,
  viewerIsAdmin,
  viewerUserId,
  onModeChanged,
}: {
  readonly member: RoomMemberDto;
  readonly roomId: string;
  readonly focus: RoomFocusState;
  readonly viewerIsAdmin: boolean;
  readonly viewerUserId: string | null;
  readonly onModeChanged?: () => void;
}): ReactElement {
  const toast = useToast();
  const { response } = useProfile();
  const voice = useVoiceControls();
  const [modeBusy, setModeBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const isAgent = member.kind === "agent";
  const suffix = memberTypeSuffix(member);

  const handleMode = useCallback(
    async (next: AgentResponseMode) => {
      if (next === (member.agentResponseMode ?? "active")) return;
      setModeBusy(true);
      try {
        await apiClient.updateRoomMemberMode(roomId, member.actorId, next);
        onModeChanged?.();
      } catch (e) {
        toast.show({
          variant: "error",
          title: "Could not change mode",
          message: e instanceof Error ? e.message : "Unknown error.",
        });
      } finally {
        setModeBusy(false);
      }
    },
    [roomId, member.actorId, member.agentResponseMode, onModeChanged, toast],
  );

  if (!isAgent) {
    return (
      <div
        className="flex items-center gap-2 rounded-lg px-2 py-1.5"
        data-testid="member-card"
        data-kind="user"
      >
        <MemberFocusAvatar member={member} focus={focus} interactive={false} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-xs font-medium text-foreground">{member.displayName}</span>
          <span className="text-[10px] uppercase tracking-wide text-foreground-muted">
            Person · {suffix}
          </span>
        </div>
      </div>
    );
  }

  const isTarget = focus.isTarget(member.actorId);
  const isHeld = focus.isHeld(member.actorId);
  const focusBusy = focus.isBusy(member.actorId);
  const secondsLeft = focus.secondsLeft(member.actorId);
  const fraction = focus.remainingFraction(member.actorId);
  const expiring = focus.isExpiringSoon(member.actorId);
  const mode = member.agentResponseMode ?? "active";
  const cardAccent = isTarget
    ? "border-primary bg-[var(--primary-muted)] shadow-sm"
    : isHeld
      ? "border-border-strong bg-background-element"
      : "border-border/70 bg-background-panel/70 hover:border-border-strong hover:bg-background-element";
  const ownerCue = agentOwnerCue(member, viewerUserId);

  // R2b-lite — soul + voice, scoped to an agent the viewer controls.
  //
  // Voice today is ONE global session (`useVoiceControls`) that plays the
  // viewer's own agent. We surface that toggle on the card of the agent the
  // session actually voices (the viewer's primary/own agent) — flipping it
  // here is the same session as the 1:1 room. `canControlVoice` is the SEAM:
  // when D284 lands per-(room,bot) voice, the parent flips this true per agent
  // and swaps `voice` for a per-agent source — no markup change. Until then,
  // if the viewer can't control an agent's voice, the row is simply hidden
  // (no disabled/"coming soon" state).
  const ownerResponse = response?.viewerRole === "owner" ? response : null;
  const isPrimaryOwn =
    ownerResponse != null && member.displayName === ownerResponse.agent.name;
  const soulPreview = isPrimaryOwn
    ? clampSoulPreview(extractSoulEssence(ownerResponse.agent.soulFile))
    : null;
  const canControlVoice = isPrimaryOwn;
  // Disclosure only when there's something real to show (soul and/or voice).
  const hasDetails = soulPreview != null || canControlVoice;

  return (
    <div
      className={`flex flex-col gap-1 rounded-xl border ${cardAccent}`}
      data-testid="agent-card"
      data-actor-id={member.actorId}
      data-focus-state={isTarget ? "target" : isHeld ? "held" : "none"}
    >
      {/* Top row: single-click focus (flex-1) + a separate disclosure chevron
          (must NOT live inside the focus button, or expanding would also
          toggle focus). */}
      <div className="flex items-stretch">
        <button
          type="button"
          disabled={focusBusy}
          onClick={() => focus.toggle(member.actorId)}
          aria-pressed={isTarget}
          title={isTarget ? `Click to release focus on ${member.displayName}` : `Click to focus ${member.displayName}`}
          data-testid="agent-card-focus"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left disabled:cursor-wait disabled:opacity-60"
        >
          <MemberFocusAvatar member={member} focus={focus} interactive={false} roomId={roomId} />
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex min-w-0 items-baseline gap-1.5">
              <span className="truncate text-xs font-semibold text-foreground">{member.displayName}</span>
              {ownerCue ? (
                <span className="shrink-0 text-[10px] font-medium normal-case tracking-normal text-foreground-muted">
                  {ownerCue}
                </span>
              ) : null}
            </div>
            <span className="text-[10px] uppercase tracking-wide text-foreground-muted/90">
              Agent · {suffix}
              {isTarget ? (
                <span className={expiring ? "ml-1 text-[var(--warning)]" : "ml-1 text-primary"}>
                  · focused{secondsLeft != null ? ` ${secondsLeft}s` : ""} · tap to release
                </span>
              ) : (
                <span className="ml-1 opacity-70">· tap to focus</span>
              )}
            </span>
          </div>
        </button>
        {hasDetails ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-label={expanded ? "Hide soul & voice" : "Show soul & voice"}
            title={expanded ? "Hide soul & voice" : "Show soul & voice"}
            data-testid="agent-card-disclosure"
            className="flex w-6 shrink-0 items-center justify-center rounded text-foreground-muted hover:bg-background hover:text-foreground"
          >
            {expanded ? "⌃" : "⌄"}
          </button>
        ) : null}
      </div>
      {/* Decay bar — visible TTL countdown while focused. */}
      {isTarget && fraction != null ? (
        <div className="mx-2 h-1 overflow-hidden rounded-full bg-background" data-testid="agent-card-decay">
          <div
            className={`h-full rounded-full transition-[width] duration-1000 ease-linear ${
              expiring ? "bg-[var(--warning)] animate-pulse" : "bg-primary"
            }`}
            style={{ width: `${Math.round(fraction * 100)}%` }}
          />
        </div>
      ) : null}
      {/* Secondary: mode control + plain-language meaning. */}
      {viewerIsAdmin ? (
        <div className="flex flex-col gap-0.5 px-2 pb-1.5">
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-foreground-muted">mode</span>
            <select
              value={mode}
              disabled={modeBusy}
              onChange={(e) => void handleMode(e.target.value as AgentResponseMode)}
              data-testid="agent-card-mode"
              className="rounded border border-border bg-background px-1 py-0.5 text-[11px] text-foreground"
            >
              {MODES.map((m) => (
                <option key={m} value={m}>
                  {MODE_LABEL[m]}
                </option>
              ))}
            </select>
          </div>
          <span className="text-[10px] leading-tight text-foreground-muted">{MODE_HELP[mode]}</span>
        </div>
      ) : mode !== "active" ? (
        <div className="px-2 pb-1.5 text-[10px] text-foreground-muted">
          {MODE_LABEL[mode]} — {MODE_HELP[mode]}
        </div>
      ) : null}
      {/* R2b-lite — expanded soul excerpt + voice toggle (controllable agents only). */}
      {expanded && hasDetails ? (
        <div
          className="flex flex-col gap-1.5 border-t border-border px-2 pb-2 pt-1.5"
          data-testid="agent-card-details"
        >
          {soulPreview != null ? (
            <div>
              <span className="text-[10px] uppercase tracking-wide text-foreground-muted">soul</span>
              <p className="mt-0.5 whitespace-pre-line text-[11px] leading-snug text-foreground-muted">
                {soulPreview}
              </p>
            </div>
          ) : null}
          {canControlVoice ? (
            <AgentVoiceRow
              enabled={voice.enabled}
              playing={voice.playing}
              onToggle={voice.toggle}
              onStop={voice.stop}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function agentOwnerCue(member: RoomMemberDto, viewerUserId: string | null): string | null {
  if (member.kind !== "agent") return null;
  if (member.agentOwnerUserId && viewerUserId && member.agentOwnerUserId === viewerUserId) {
    return "your agent";
  }
  const ownerName = member.agentOwnerDisplayName?.trim();
  if (ownerName) return ownerName.endsWith("s") ? `${ownerName}' agent` : `${ownerName}'s agent`;
  const ownerHandle = member.agentOwnerHandle?.trim();
  return ownerHandle ? `@${ownerHandle}` : null;
}

/**
 * R2b-lite — per-agent voice row. Today it binds to the single global voice
 * session (`useVoiceControls`), surfaced only on the card of an agent the
 * viewer controls; flipping it here is the same session as the 1:1 room. This
 * is the SEAM for D284: when per-(room,bot) voice lands, the parent passes a
 * per-agent `enabled`/`onToggle`/`onStop` and renders this row for any agent —
 * no markup change here.
 */
function AgentVoiceRow({
  enabled,
  playing,
  onToggle,
  onStop,
}: {
  readonly enabled: boolean;
  readonly playing: boolean;
  readonly onToggle: () => void;
  readonly onStop: () => void;
}): ReactElement {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] uppercase tracking-wide text-foreground-muted">voice</span>
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={enabled}
        data-testid="agent-card-voice"
        className={`rounded px-2 py-0.5 text-[11px] font-medium ${
          enabled
            ? "bg-online/20 text-online"
            : "bg-background text-foreground-muted hover:text-foreground"
        }`}
      >
        {enabled ? (playing ? "Speaking…" : "On") : "Off"}
      </button>
      {enabled && playing ? (
        <button
          type="button"
          onClick={onStop}
          data-testid="agent-card-voice-stop"
          className="rounded px-2 py-0.5 text-[11px] text-foreground-muted hover:text-foreground"
        >
          Stop
        </button>
      ) : null}
    </div>
  );
}
