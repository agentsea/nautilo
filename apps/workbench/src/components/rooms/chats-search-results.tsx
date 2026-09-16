import type { ChatSearchConversationHit, ChatSearchMessageHit } from "@nautilo/types";
import type { ChatsSearchControls } from "../../adapters/runtime-contexts";

const SEARCH_SNIPPET_ENTITIES: Readonly<Record<string, string>> = {
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&amp;": "&",
};

/** Decode exactly the single HTML-escaping pass performed by the search store. */
export function decodeChatSearchSnippetOnce(value: string): string {
  return value.replace(
    /&(?:lt|gt|quot|#39|amp);/g,
    (entity) => SEARCH_SNIPPET_ENTITIES[entity] ?? entity,
  );
}

function formatSearchDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function conversationContext(hit: ChatSearchConversationHit): string {
  const participants = hit.room.roster
    ?.map((member) => member.displayName.trim())
    .filter((name) => name.length > 0)
    .join(" · ");
  if (participants) return participants;
  const count = hit.room.memberCount;
  return `${count} participant${count === 1 ? "" : "s"}`;
}

function messageBreadcrumb(hit: ChatSearchMessageHit): string {
  return hit.parentRoomLabel ? `${hit.parentRoomLabel} › ${hit.roomLabel}` : hit.roomLabel;
}

function resultSummary(search: ChatsSearchControls): string {
  const chatCount = search.conversations.length;
  const messageCount = search.messages.length;
  const chatSuffix = search.conversationsTruncated ? "+" : "";
  const messageSuffix = search.hasMoreOlderMessages ? "+" : "";
  const chatPlural = chatCount === 1 && !search.conversationsTruncated ? "" : "s";
  const messagePlural = messageCount === 1 && !search.hasMoreOlderMessages ? "" : "es";
  return `${chatCount}${chatSuffix} matching chat${chatPlural} · ${messageCount}${messageSuffix} message match${messagePlural} shown`;
}

function ResultsSkeleton() {
  return (
    <div className="space-y-3 px-3 py-4" role="status" aria-busy="true">
      <span className="sr-only">Searching all chats…</span>
      {["conversation", "message-one", "message-two"].map((key) => (
        <div key={key} className="animate-pulse space-y-2" aria-hidden="true">
          <div className="h-3 w-2/5 rounded bg-background-element" />
          <div className="h-3 w-4/5 rounded bg-background-element" />
        </div>
      ))}
    </div>
  );
}

function ConversationRow({
  hit,
  onOpen,
}: {
  hit: ChatSearchConversationHit;
  onOpen: (roomId: string) => void;
}) {
  const activity = hit.room.lastMessageAt ?? hit.room.createdAt;
  return (
    <li>
      <button
        type="button"
        className="w-full border-b border-border/60 px-3 py-2 text-left hover:bg-background-element/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
        onClick={() => onOpen(hit.room.id)}
      >
        <span className="block truncate text-xs font-medium text-foreground">{hit.room.label}</span>
        <span className="mt-0.5 block truncate text-[11px] text-foreground-muted">
          {conversationContext(hit)}
        </span>
        <time className="mt-0.5 block text-[10px] text-foreground-muted/80" dateTime={activity}>
          {formatSearchDate(activity)}
        </time>
      </button>
    </li>
  );
}

function MessageRow({
  hit,
  onOpen,
}: {
  hit: ChatSearchMessageHit;
  onOpen: (roomId: string, messageId: string) => void;
}) {
  const messageId = String(hit.messageId);
  return (
    <li>
      <button
        type="button"
        className="w-full border-b border-border/60 px-3 py-2 text-left hover:bg-background-element/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
        onClick={() => onOpen(hit.roomId, messageId)}
      >
        <span className="block truncate text-[11px] font-medium text-foreground-muted">
          {messageBreadcrumb(hit)}
        </span>
        <span className="mt-0.5 block text-xs leading-5 text-foreground">
          {decodeChatSearchSnippetOnce(hit.snippet)}
        </span>
        <time
          className="mt-0.5 block text-[10px] text-foreground-muted/80"
          dateTime={hit.createdAt}
        >
          {formatSearchDate(hit.createdAt)}
        </time>
      </button>
    </li>
  );
}

export interface ChatsSearchResultsProps {
  search: ChatsSearchControls;
  onOpenConversation: (roomId: string) => void;
  onOpenMessage: (roomId: string, messageId: string) => void;
}

/** Shared Desktop rendering for the server-authorized cross-room search result set. */
export function ChatsSearchResults({
  search,
  onOpenConversation,
  onOpenMessage,
}: ChatsSearchResultsProps) {
  const firstPagePending =
    (search.status === "debouncing" || search.status === "loading") && search.pages.length === 0;
  if (firstPagePending) return <ResultsSkeleton />;

  if (search.status === "invalid") {
    return (
      <div role="alert" className="px-3 py-4 text-xs text-amber-700 dark:text-amber-400">
        {search.error ?? "Enter a valid search."}
      </div>
    );
  }

  if (search.status === "error") {
    return (
      <div role="alert" className="space-y-2 px-3 py-4 text-xs text-amber-700 dark:text-amber-400">
        <p>{search.error ?? "Search is temporarily unavailable."}</p>
        <button
          type="button"
          className="rounded border border-border bg-background px-2 py-1 font-medium text-foreground hover:bg-background-element"
          onClick={() => void search.retry()}
        >
          Try again
        </button>
      </div>
    );
  }

  if (search.status === "empty") {
    return (
      <p className="px-3 py-4 text-xs text-foreground-muted">
        No conversations or messages match this search.
      </p>
    );
  }

  return (
    <div className="min-h-0" aria-busy={search.status === "loading"}>
      <p className="border-b border-border/60 px-3 py-2 text-[11px] text-foreground-muted" role="status">
        {resultSummary(search)}
      </p>
      <section aria-label="Matching chats">
        <h3 className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wide text-foreground-muted">
          Matching chats
        </h3>
        <p className="px-3 pb-1 text-[10px] text-foreground-muted">Chat names or participants</p>
        {search.conversations.length > 0 ? (
          <ul>
            {search.conversations.map((hit) => (
              <ConversationRow key={hit.room.id} hit={hit} onOpen={onOpenConversation} />
            ))}
          </ul>
        ) : (
          <p className="px-3 py-2 text-[11px] text-foreground-muted">
            No chat names or participants match.
          </p>
        )}
        {search.conversationsTruncated ? (
          <p className="px-3 py-2 text-[11px] text-foreground-muted">
            More conversations match. Refine your search to narrow the list.
          </p>
        ) : null}
      </section>

      <section aria-label="Matching messages">
        <h3 className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wide text-foreground-muted">
          Matching messages
        </h3>
        <p className="px-3 pb-1 text-[10px] text-foreground-muted">Text inside your chats</p>
        {search.messages.length > 0 ? (
          <ul>
            {search.messages.map((hit) => (
              <MessageRow
                key={`${hit.roomId}:${hit.messageId}`}
                hit={hit}
                onOpen={onOpenMessage}
              />
            ))}
          </ul>
        ) : (
          <p className="px-3 py-2 text-[11px] text-foreground-muted">No message text matches.</p>
        )}
      </section>

      {search.hasMoreOlderMessages ? (
        <div className="px-3 py-3">
          <button
            type="button"
            className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs font-medium text-foreground hover:bg-background-element disabled:cursor-wait disabled:opacity-60"
            disabled={search.status === "loading"}
            onClick={() => void search.loadOlderMessages()}
          >
            {search.status === "loading" ? "Loading older…" : "Load older"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
