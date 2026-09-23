/**
 * D210 — composer @-mention typeahead adapter.
 *
 * Wires room members (humans + agents) into assistant-ui's
 * `ComposerPrimitive.Unstable_MentionRoot` so typing `@` in the composer
 * pops a member picker. Agent selections remain readable `@<handle>` text for
 * D128 routing. Human selections use an opaque draft directive keyed by stable
 * user id; the send projection emits readable text plus the structured
 * `mentionedHumanUserIds` field consumed by M233 classification.
 *
 * Resource directives and Human mention directives are parsed independently.
 * Plain Human `@handle` text stays an ordinary editor text node; the send-time
 * projection resolves exact tokens against the current Room roster.
 *
 * Why custom serialize: Agent routing still needs D128-compatible plaintext,
 * while Human notification intent must survive handle changes and must not be
 * inferred from message content. The opaque directive exists only in drafts;
 * persisted message content remains readable.
 */

import {
  useEffect,
  useMemo,
  useRef,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import {
  ComposerPrimitive,
  unstable_useTriggerPopoverRootContextOptional,
} from "@assistant-ui/react";
import {
  LexicalComposerInput,
  type LexicalComposerInputProps,
} from "@assistant-ui/react-lexical";
import type {
  Unstable_TriggerAdapter,
  Unstable_TriggerCategory,
  Unstable_TriggerItem,
  Unstable_DirectiveFormatter,
  Unstable_DirectiveSegment,
} from "@assistant-ui/core";
import type { RoomMemberDto } from "@nautilo/types";
import { UserAvatar } from "../avatar/UserAvatar";
import { memberTypeSuffix } from "../../modes/rooms/shape/members-panel-model";
import { sortMembersForMentionPicker } from "./mention-recency";
import { hasFocusedResource } from "../../adapters/composer-focused-resources-ref";
import {
  parseResourceDirectiveSegments,
  serializeResourceDirective,
} from "./resource-directives";
import {
  humanMentionDirectivesToPlainText,
  parseEveryoneMentionDirectiveSegments,
  parseHumanMentionDirectiveSegments,
  serializeEveryoneMentionDirective,
  serializeHumanMentionDirective,
} from "./human-mention-directives";

const NO_CATEGORIES: readonly Unstable_TriggerCategory[] = [];
export const EVERYONE_MENTION_ITEM_ID = "__room_everyone__";

export function shouldCaptureComposerSubmit(input: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  pickerOpen: boolean;
}): boolean {
  return (
    input.key === "Enter" &&
    !input.shiftKey &&
    !input.isComposing &&
    !input.pickerOpen
  );
}
const EMPTY_LAST_SPOKE: ReadonlyMap<string, number> = new Map();

/**
 * Builds an Unstable_MentionAdapter from a room's member list. Hides
 * the viewer themselves from the suggestions (mentioning yourself is
 * pointless and clutters the popover in 1:1 rooms).
 *
 * Design decision: NO categories. assistant-ui's TriggerPopoverResource
 * shows category list (not items) when query is empty AND categories
 * exist. We want a flat single-pane picker that shows immediately on
 * bare `@` — same UX as Slack/Discord. Returning empty categories
 * forces the resource into search-mode-from-empty-query, which calls
 * `search("")` and renders flat items via `<MentionItems>` directly.
 *
 * Stack-32 polish: items are ranked by recent room participation
 * (`lastSpokeAtMs` bridged from the runtime thread), then alphabetical.
 * Search filters the ranked list preserving order; ≤8 results.
 */
export function useMentionAdapterForRoom(
  members: readonly RoomMemberDto[],
  viewerActorId: string | undefined,
  canMentionEveryone: boolean,
  lastSpokeAtMs?: ReadonlyMap<string, number>,
): Unstable_TriggerAdapter {
  return useMemo(() => {
    const allRanked = mentionItemsForRoom(
      members,
      viewerActorId,
      canMentionEveryone,
      lastSpokeAtMs ?? EMPTY_LAST_SPOKE,
    );

    return {
      categories: () => NO_CATEGORIES,
      categoryItems: () => [],
      search: (query: string) => {
        const q = query.trim().toLowerCase();
        if (!q) return allRanked;
        const match = (item: Unstable_TriggerItem): boolean =>
          item.id.toLowerCase().startsWith(q) ||
          item.label.toLowerCase().includes(q) ||
          item.description?.toLowerCase().includes(q) === true;
        return allRanked.filter(match).slice(0, 8);
      },
    };
  }, [members, viewerActorId, canMentionEveryone, lastSpokeAtMs]);
}

export function mentionItemsForRoom(
  members: readonly RoomMemberDto[],
  viewerActorId: string | undefined,
  canMentionEveryone: boolean,
  lastSpokeAtMs: ReadonlyMap<string, number> = EMPTY_LAST_SPOKE,
): Unstable_TriggerItem[] {
  const eligible = members.filter((member) => {
    if (member.actorId === viewerActorId) return false;
    if (member.kind === "user" && !member.userId) return false;
    const handle = mentionHandleForMember(member);
    if (member.kind === "agent" && handle.toLowerCase() === "everyone") return false;
    return handle.length > 0;
  });
  const everyone = canMentionEveryone ? [{
    id: EVERYONE_MENTION_ITEM_ID,
    type: "user",
    label: "everyone",
    description: "Notify everyone in this room",
  } satisfies Unstable_TriggerItem] : [];
  return [...everyone, ...sortMembersForMentionPicker(eligible, lastSpokeAtMs).map(memberToTriggerItem)];
}

/** Handle-keyed lookup for rendering suggestion rows (avatar + H/G suffix). */
export function buildMemberByHandle(
  members: readonly RoomMemberDto[],
): ReadonlyMap<string, RoomMemberDto> {
  const map = new Map<string, RoomMemberDto>();
  for (const m of members) {
    const handle = mentionHandleForMember(m);
    if (handle.length > 0) map.set(handle, m);
    if (m.kind === "user" && m.userId) map.set(m.userId, m);
  }
  return map;
}

export function MentionAgentAvatar({ displayName }: { displayName: string }): ReactElement {
  const initial = displayName.trim().charAt(0).toUpperCase() || "G";
  return (
    <span
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-background-element text-xs font-medium text-foreground-muted"
      aria-hidden
      data-testid="mention-agent-avatar"
    >
      {initial}
    </span>
  );
}

/**
 * D210 Stack-32 — avatar row for a mention suggestion: UserAvatar for humans,
 * Genie initials shell for agents, plus the §4.7.4 `(H)` / `(G)` suffix.
 */
export function MentionSuggestionRow({
  item,
  member,
}: {
  item: Unstable_TriggerItem;
  member: RoomMemberDto | undefined;
}): ReactElement {
  if (item.id === EVERYONE_MENTION_ITEM_ID && member === undefined) {
    return (
      <div className="min-w-0 flex-1">
        <span className="font-medium text-foreground">@everyone</span>
        <span className="ml-1.5 text-xs text-foreground-muted">— Notify everyone in this room</span>
      </div>
    );
  }
  const suffix = member ? memberTypeSuffix(member) : item.type === "agent" ? "G" : "H";

  return (
    <>
      {member?.kind === "user" && typeof member.userId === "string" && member.userId.length > 0 ? (
        <UserAvatar userId={member.userId} size={24} displayName={member.displayName} />
      ) : (
        <MentionAgentAvatar displayName={member?.displayName ?? item.label} />
      )}
      <div className="min-w-0 flex-1">
        <span className="font-medium text-foreground">
          {member?.displayName ?? item.label}
        </span>
        <span className="ml-1.5 text-xs text-foreground-muted">
          @{member ? mentionHandleForMember(member) : item.label}
        </span>
      </div>
      <span
        className="shrink-0 text-[10px] uppercase tracking-wide text-foreground-muted"
        data-testid="mention-type-suffix"
      >
        ({suffix})
      </span>
    </>
  );
}

/** Shared production room-member mention surface for every room composer. */
export function RoomMentionTriggerPopover({
  adapter,
  memberByHandle,
}: {
  adapter: Unstable_TriggerAdapter;
  memberByHandle: ReadonlyMap<string, RoomMemberDto>;
}): ReactElement {
  return (
    <ComposerPrimitive.Unstable_TriggerPopover
      char="@"
      adapter={adapter}
      className="absolute bottom-full left-0 z-50 mb-2 max-h-64 w-72 max-w-full overflow-y-auto rounded-lg border border-border bg-background py-1 shadow-lg"
    >
      <ComposerPrimitive.Unstable_TriggerPopover.Directive formatter={mentionAtHandleFormatter} />
      <ComposerPrimitive.Unstable_TriggerPopoverItems>
        {(items) => (
          <>
            {items.length === 0 ? (
              <div className="px-3 py-2 text-xs text-foreground-muted">No matching members.</div>
            ) : (
              items.map((item) => (
                <ComposerPrimitive.Unstable_TriggerPopoverItem
                  key={item.id}
                  item={item}
                  className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm outline-none transition-colors hover:bg-[var(--primary-muted)] focus:bg-[var(--primary-muted)] data-[highlighted]:bg-[var(--primary-muted)]"
                  onMouseDown={(event) => event.preventDefault()}
                >
                  <MentionSuggestionRow item={item} member={memberByHandle.get(item.id)} />
                </ComposerPrimitive.Unstable_TriggerPopoverItem>
              ))
            )}
          </>
        )}
      </ComposerPrimitive.Unstable_TriggerPopoverItems>
    </ComposerPrimitive.Unstable_TriggerPopover>
  );
}

/** Production Lexical composer input with keyboard selection for open triggers. */
export function MentionAwareLexicalComposerInput(
  props: LexicalComposerInputProps,
): ReactElement {
  const triggerRoot = unstable_useTriggerPopoverRootContextOptional();
  const {
    "aria-label": ariaLabel,
    onCopyCapture,
    onKeyDown,
    spellCheck,
    ...rest
  } = props;
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    applyLexicalComposerAccessibility(rootRef.current, ariaLabel);
  }, [ariaLabel]);

  return (
    <LexicalComposerInput
      ref={rootRef}
      {...rest}
      aria-label={ariaLabel}
      // D519 — Composer text is DOM-owned, so spellcheck belongs to the
      // browser/OS. Keep the intent explicit for every consumer of this shared
      // boundary while allowing a future deliberate caller opt-out.
      spellCheck={spellCheck ?? true}
      unstable_focusOnRunStart={false}
      onCopyCapture={(event: ClipboardEvent<HTMLDivElement>) => {
        onCopyCapture?.(event);
        if (event.defaultPrevented) return;

        // Lexical's source text intentionally contains the stable Human id so
        // drafts survive handle changes. Its default clipboard serialization
        // would expose that opaque token even though the chip says `@handle`.
        // Plaintext-only copy also keeps data-directive-id out of copied HTML.
        const selection = event.currentTarget.ownerDocument
          .getSelection()
          ?.toString();
        if (!selection) return;
        event.preventDefault();
        event.stopPropagation();
        event.clipboardData.setData(
          "text/plain",
          humanMentionDirectivesToPlainText(selection),
        );
      }}
      onKeyDownCapture={(event: KeyboardEvent<HTMLDivElement>) => {
        const openTrigger = Array.from(triggerRoot?.getTriggers().values() ?? []).find(
          (trigger) => trigger.resource.open && trigger.resource.items.length > 0,
        );
        if (shouldCaptureComposerSubmit({
          key: event.key,
          shiftKey: event.shiftKey,
          isComposing: event.nativeEvent.isComposing,
          pickerOpen: Boolean(openTrigger),
        })) {
          // M230 — intercept before Lexical's paragraph command. The outer
          // submit handler still owns whether sending is currently allowed.
          event.preventDefault();
          event.stopPropagation();
          onKeyDown?.(event);
        }
      }}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        const openTrigger = Array.from(triggerRoot?.getTriggers().values() ?? []).find(
          (trigger) => trigger.resource.open && trigger.resource.items.length > 0,
        );
        if (event.key === "Tab" && openTrigger) {
          event.preventDefault();
          openTrigger.resource.selectItem(
            openTrigger.resource.items[openTrigger.resource.highlightedIndex] ??
              openTrigger.resource.items[0],
          );
          return;
        }
        // An open picker owns Enter; selecting a suggestion must never send.
        if (event.key === "Enter" && openTrigger) return;
        onKeyDown?.(event);
      }}
    />
  );
}

export function applyLexicalComposerAccessibility(
  root: HTMLElement | null,
  ariaLabel: string | undefined,
): void {
  const input = root?.querySelector<HTMLElement>(
    ".aui-lexical-input[contenteditable='true']",
  );
  if (!input || !ariaLabel) return;
  input.setAttribute("role", "textbox");
  input.setAttribute("aria-label", ariaLabel);
  input.setAttribute("aria-multiline", "true");
}

/**
 * Directive formatter for D210/D379: serialize a picker-selected item to
 * plain `@<handle> ` text (with a trailing space so the next character
 * the user types continues a fresh word, matching the regex's word-
 * boundary requirement). Parsing recognizes plain `@handle` / `/name`
 * tokens so Lexical can rebuild directive chips from restored drafts while
 * `getTextContent()` still sends plain text.
 */
export const mentionAtHandleFormatter: Unstable_DirectiveFormatter = {
  serialize(item) {
    return serializePlainDirective(item);
  },
  parse(text) {
    return parsePlainDirectives(text);
  },
};

function serializePlainDirective(item: Unstable_TriggerItem): string {
  if (item.id === EVERYONE_MENTION_ITEM_ID && item.label === "everyone") {
    return `${serializeEveryoneMentionDirective()} `;
  }
  // Focused-resource chips retain their opaque entry id in Lexical, but that
  // id is strictly client-local. Preserve the directive so submit projection
  // can emit the public filename while the parallel focusedResources payload
  // carries the resolvable reference.
  if (item.type === "resource") {
    return `${serializeResourceDirective(item.id, item.label)} `;
  }
  if (item.type === "user") {
    return `${serializeHumanMentionDirective(item.id, item.label)} `;
  }
  return item.type === "command" ? `/${item.id} ` : `@${item.id} `;
}

function parsePlainDirectives(text: string): Unstable_DirectiveSegment[] {
  const everyoneSegments = parseEveryoneMentionDirectiveSegments(text);
  if (everyoneSegments) {
    return everyoneSegments.flatMap((segment) =>
      segment.kind === "text" ? parsePlainDirectives(segment.text) : [segment],
    );
  }
  const humanSegments = parseHumanMentionDirectiveSegments(text);
  if (humanSegments) {
    return humanSegments.flatMap((segment) =>
      segment.kind === "text" ? parsePlainDirectives(segment.text) : [segment],
    );
  }
  const resourceSegments = parseResourceDirectiveSegments(text, hasFocusedResource);
  if (resourceSegments) {
    return resourceSegments.flatMap((segment) =>
      segment.kind === "text" ? parseNonResourcePlainDirectives(segment.text) : [segment],
    );
  }
  return parseNonResourcePlainDirectives(text);
}

function parseNonResourcePlainDirectives(text: string): Unstable_DirectiveSegment[] {
  const segments: Unstable_DirectiveSegment[] = [];
  // Only slash commands are reconstructed as editor directives. Plain Human
  // `@handle` text remains a text node and is resolved against the current
  // Room roster only by the send-time projection.
  const directiveRe = /(^|\s)(\/)([A-Za-z0-9_-]+)(?=$|\s)/g;
  let cursor = 0;
  for (const match of text.matchAll(directiveRe)) {
    const prefix = match[1] ?? "";
    const marker = match[2];
    const id = match[3];
    if (!marker || !id) continue;

    const directiveStart = match.index + prefix.length;
    if (directiveStart > cursor) {
      segments.push({ kind: "text", text: text.slice(cursor, directiveStart) });
    }
    segments.push({
      kind: "mention",
      id,
      label: id,
      type: "command",
    });
    cursor = directiveStart + marker.length + id.length;
  }
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments.length > 0 ? segments : [{ kind: "text", text }];
}

export function mentionHandleForMember(m: RoomMemberDto): string {
  const canonical = m.handle?.trim();
  if (canonical) return canonical;
  return slugifyHandle(m.displayName);
}

function slugifyHandle(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function memberToTriggerItem(m: RoomMemberDto): Unstable_TriggerItem {
  const handle = mentionHandleForMember(m);
  return {
    id: m.kind === "user" ? m.userId! : handle,
    type: m.kind === "agent" ? "agent" : "user",
    label: m.kind === "user" ? handle : m.displayName,
    description: m.displayName,
  };
}
