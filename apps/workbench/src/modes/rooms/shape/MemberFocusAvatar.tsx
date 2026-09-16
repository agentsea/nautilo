import { type ReactElement } from "react";
import type { AvatarRef } from "@nautilo/types";
import { AuthenticatedAvatar } from "../../../components/avatar/authenticated-image";
import { UserAvatar } from "../../../components/avatar/UserAvatar";
import type { RoomFocusState } from "./use-room-focus";
import { FocusCountdownRing } from "./FocusCountdownRing";
import { focusTooltipLabel } from "./focus-reason";

/**
 * D278 §4.7.4 — the shared focus-ring avatar. Used by BOTH the members drawer
 * (`MemberRow`) and the compact column (`MembersColumn`) so the two stay in
 * sync ("one component, two modes").
 *
 * Bot-only focus (Conversational Focus): the single routing target gets the
 * ring (pulses when expiring); a held-but-ambiguous bot gets a subtle dot;
 * humans render a plain avatar. Tap a bot to open/clear focus.
 */
export interface AvatarMember {
  readonly actorId: string;
  readonly displayName: string;
  readonly kind: "user" | "agent";
  readonly userId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly agentAvatar?: AvatarRef | null | undefined;
}

export function MemberFocusAvatar({
  member,
  focus,
  size = "md",
  interactive = true,
  roomId,
}: {
  readonly member: AvatarMember;
  readonly focus: RoomFocusState;
  readonly size?: "md" | "sm";
  readonly roomId?: string | null;
  /**
   * When false, render the ring/dot visuals only (a `<span>`, no button/onClick)
   * — for use inside a larger clickable region (e.g. an AgentCard) so we don't
   * nest a button in a button. Default true (compact column taps the avatar).
   */
  readonly interactive?: boolean;
}): ReactElement {
  const dim = size === "sm" ? "h-8 w-8" : "h-7 w-7";
  const sizePx = size === "sm" ? 32 : 28;
  const base = `flex ${dim} shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-background-element text-xs font-medium text-foreground-muted`;
  const initial = member.displayName.charAt(0).toUpperCase();
  const avatarSrc =
    member.kind === "agent"
      ? agentAvatarUrl({
          roomId,
          agentId: member.agentId,
          avatar: member.agentAvatar,
        })
      : null;
  const inner = member.kind === "user" && member.userId ? (
    <UserAvatar userId={member.userId} displayName={member.displayName} size={sizePx} />
  ) : avatarSrc != null ? (
      <AuthenticatedAvatar src={avatarSrc} alt={member.displayName} fallback={initial} />
    ) : (
      initial
    );

  if (member.kind !== "agent") {
    return (
      <span className={base} aria-hidden title={member.displayName}>
        {inner}
      </span>
    );
  }

  const isTarget = focus.isTarget(member.actorId);
  const isHeld = focus.isHeld(member.actorId);
  const expiringSoon = focus.isExpiringSoon(member.actorId);
  const busy = focus.isBusy(member.actorId);
  const remainingFraction = focus.remainingFraction(member.actorId);
  const secondsLeft = focus.secondsLeft(member.actorId);
  const focused = remainingFraction != null;
  const tooltip = focusTooltipLabel(member.displayName, focus.reasonFor(member.actorId));
  const ringClass = isTarget
    ? `ring-2 ring-primary ring-offset-1 ring-offset-background-panel${expiringSoon ? " animate-pulse" : ""}`
    : "";

  if (!interactive) {
    return (
      <span
        className={`relative ${base} ${ringClass}`}
        aria-hidden
        title={tooltip}
        data-focus-state={isTarget ? "target" : isHeld ? "held" : "none"}
      >
        {inner}
        {focused ? (
          <FocusCountdownRing
            remainingFraction={remainingFraction}
            expiringSoon={expiringSoon}
            secondsLeft={secondsLeft}
          />
        ) : null}
        {isHeld ? (
          <span
            aria-hidden
            className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-background-panel bg-primary/70"
          />
        ) : null}
      </span>
    );
  }

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => focus.toggle(member.actorId)}
      title={tooltip}
      aria-label={
        isTarget ? `Clear focus on ${member.displayName}` : `Focus on ${member.displayName}`
      }
      data-testid="member-focus-ring"
      data-actor-id={member.actorId}
      data-focus-state={isTarget ? "target" : isHeld ? "held" : "none"}
      className={`relative ${base} disabled:cursor-wait disabled:opacity-50 ${ringClass}`}
    >
      {inner}
      {focused ? (
        <FocusCountdownRing
          remainingFraction={remainingFraction}
          expiringSoon={expiringSoon}
          secondsLeft={secondsLeft}
        />
      ) : null}
      {isHeld ? (
        <span
          aria-hidden
          className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-background-panel bg-primary/70"
        />
      ) : null}
    </button>
  );
}

function avatarVersion(avatar: AvatarRef | null | undefined): string | null {
  if (!avatar) return null;
  if (avatar.kind === "preset") return avatar.id;
  return avatar.blobId;
}

function agentAvatarUrl(args: {
  roomId: string | null | undefined;
  agentId: string | undefined;
  avatar: AvatarRef | null | undefined;
}): string | null {
  if (!args.roomId || !args.agentId) return null;
  const params = new URLSearchParams();
  const version = avatarVersion(args.avatar);
  if (version) params.set("v", version);
  const query = params.toString();
  return `/api/rooms/${encodeURIComponent(args.roomId)}/agents/${encodeURIComponent(args.agentId)}/avatar${query ? `?${query}` : ""}`;
}
