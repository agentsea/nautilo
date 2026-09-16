/**
 * D279 Phase 4 — composer-anchored disambiguation strip for `ask_user`.
 * Single-select listing `options[].handle`; keyboard model aligned with the
 * D210 @-mention popover (↑↓ / Tab / Enter + click; Esc dismiss).
 * D311 — roster-resolve friendly display names (UI-only; no wire changes).
 */

import { useCallback, useEffect, useState, type ReactElement } from "react";
import type { RoomMemberDto } from "@nautilo/types";
import type { AskUserOption } from "./ask-user-state";
import { memberTypeSuffix } from "../../modes/rooms/shape/members-panel-model";
import { MentionAgentAvatar } from "./MentionAdapter";
import { UserAvatar } from "../avatar/UserAvatar";

export interface ResolvedAskUserOptionLabel {
  readonly primary: string | null;
  readonly handle: string;
  readonly suffix: string;
  readonly avatar: "user" | "agent";
}

export function resolveAskUserOptionLabel(
  option: AskUserOption,
  member: RoomMemberDto | undefined,
): ResolvedAskUserOptionLabel {
  const handle = option.handle;
  const displayName = member?.displayName?.trim();
  const primary = displayName && displayName.length > 0 ? displayName : null;
  const suffix = member ? memberTypeSuffix(member) : "G";
  const avatar =
    member?.kind === "user" &&
    typeof member.userId === "string" &&
    member.userId.length > 0
      ? "user"
      : "agent";

  return { primary, handle, suffix, avatar };
}

export interface AskUserPickerProps {
  readonly options: readonly AskUserOption[];
  readonly pendingContent: string | null;
  readonly memberByActorId: ReadonlyMap<string, RoomMemberDto>;
  readonly onPick: (botActorId: string) => void;
  readonly onDismiss: () => void;
}

export function AskUserPicker({
  options,
  memberByActorId,
  onPick,
  onDismiss,
}: AskUserPickerProps): ReactElement | null {
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  useEffect(() => {
    setHighlightedIndex(0);
  }, [options]);

  const pickHighlighted = useCallback(() => {
    const option = options[highlightedIndex];
    if (option) onPick(option.botActorId);
  }, [highlightedIndex, onPick, options]);

  useEffect(() => {
    if (options.length < 2) return;

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onDismiss();
        return;
      }
      if (event.key === "ArrowDown" || (event.key === "Tab" && !event.shiftKey)) {
        event.preventDefault();
        setHighlightedIndex((index) => (index + 1) % options.length);
        return;
      }
      if (event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey)) {
        event.preventDefault();
        setHighlightedIndex((index) => (index - 1 + options.length) % options.length);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        pickHighlighted();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss, options.length, pickHighlighted]);

  if (options.length < 2) return null;

  return (
    <div
      className="mb-2 overflow-hidden rounded-lg border border-border bg-background shadow-lg"
      role="listbox"
      aria-label="ambiguous — who did you mean?"
      data-testid="ask-user-picker"
    >
      <div className="border-b border-border bg-background-element px-3 py-1.5 text-xs text-foreground-muted">
        ambiguous — who did you mean?
        <span className="float-right text-[10px]">Esc dismiss</span>
      </div>
      <ul className="max-h-48 overflow-y-auto py-1">
        {options.map((option, index) => {
          const highlighted = index === highlightedIndex;
          const member = memberByActorId.get(option.botActorId);
          const label = resolveAskUserOptionLabel(option, member);
          return (
          <li key={option.botActorId}>
            <button
              type="button"
              role="option"
              aria-selected={highlighted}
              data-testid="ask-user-option"
              data-bot-actor-id={option.botActorId}
              data-highlighted={highlighted ? "true" : "false"}
              className={`flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm outline-none transition-colors hover:bg-[var(--primary-muted)] focus:bg-[var(--primary-muted)]${highlighted ? " bg-[var(--primary-muted)]" : ""}`}
              onMouseEnter={() => setHighlightedIndex(index)}
              onClick={() => onPick(option.botActorId)}
            >
              {label.avatar === "user" && member ? (
                <UserAvatar
                  userId={member.userId!}
                  size={24}
                  displayName={member.displayName}
                />
              ) : (
                <MentionAgentAvatar displayName={member?.displayName ?? option.handle} />
              )}
              {label.primary ? (
                <div className="min-w-0 flex-1">
                  <span className="font-medium text-foreground">{label.primary}</span>
                  <span className="ml-1.5 text-xs text-foreground-muted">@{label.handle}</span>
                </div>
              ) : (
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                  @{label.handle}
                </span>
              )}
              <span className="shrink-0 text-[10px] uppercase tracking-wide text-foreground-muted">
                ({label.suffix})
              </span>
            </button>
          </li>
          );
        })}
      </ul>
      <div
        className="border-t border-border px-3 py-1.5 text-[11px] text-foreground-muted"
        data-testid="ask-user-pending-hint"
      >
        Optional — pick an assistant to answer, or press Esc to dismiss
      </div>
    </div>
  );
}
