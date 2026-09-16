import { useEffect, useRef } from "react";
import type { ArtifactDto } from "@nautilo/api-client/browser";
import { Bell, CheckCheck, FilePlus2, LogIn, LogOut, RefreshCw, Share2 } from "lucide-react";
import { useEventFeed } from "./event-feed-context";
import { presentEventFeedItem } from "./event-feed-presentation";

function timeLabel(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.valueOf())) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function EventFeedPanel({
  onOpenRoom,
  onOpenArtifact,
}: {
  onOpenRoom: (roomId: string) => void;
  onOpenArtifact: (artifact: ArtifactDto) => void;
}) {
  const feed = useEventFeed();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = feed.scrollTop;
  }, [feed.scrollTop]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex rounded-md bg-background-element p-0.5" aria-label="Event view">
          {(["all", "unread"] as const).map((filter) => (
            <button
              key={filter}
              type="button"
              aria-pressed={feed.filter === filter}
              onClick={() => feed.setFilter(filter)}
              className={`rounded px-2.5 py-1 text-xs font-medium ${
                feed.filter === filter
                  ? "bg-background text-foreground shadow-sm"
                  : "text-foreground-muted hover:text-foreground"
              }`}
            >
              {filter === "all" ? "All" : "Unread"}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => void feed.markAllRead()}
          disabled={feed.markingAllRead || feed.busyEventIds.size > 0 || feed.unreadCount === 0 || feed.unreadCount === null}
          className="rounded px-2 py-1 text-xs text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          <CheckCheck className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
          {feed.markingAllRead ? "Marking…" : "Mark all as read"}
        </button>
      </div>

      <div className="flex shrink-0 gap-1 border-b border-border px-3 py-2" aria-label="Event category">
        {(["all", "membership", "artifacts"] as const).map((category) => (
          <button
            key={category}
            type="button"
            aria-pressed={feed.category === category}
            onClick={() => feed.setCategory(category)}
            className={`rounded px-2.5 py-1 text-xs font-medium ${
              feed.category === category
                ? "bg-[var(--primary-muted)] text-foreground"
                : "text-foreground-muted hover:bg-background-element hover:text-foreground"
            }`}
          >
            {category === "all" ? "All categories" : category === "membership" ? "Membership" : "Artifacts"}
          </button>
        ))}
      </div>

      {!feed.connected ? (
        <div className="shrink-0 border-b border-border bg-background-element px-3 py-2 text-xs text-foreground-muted" role="status">
          Disconnected. Showing the last available Events; changes will refresh after reconnecting.
        </div>
      ) : null}

      {feed.mutationFailure ? (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-error/30 bg-error/10 px-3 py-2 text-xs text-foreground" role="alert">
          <span>{feed.mutationFailure.message}</span>
          <button
            type="button"
            className="rounded px-2 py-1 font-medium hover:bg-error/10"
            onClick={() => void feed.mutationFailure?.retry()}
          >
            Retry
          </button>
        </div>
      ) : null}

      {feed.pendingNewEvents ? (
        <button
          type="button"
          onClick={feed.showPendingNewEvents}
          className="mx-3 mt-2 shrink-0 rounded-md bg-[var(--primary-muted)] px-3 py-2 text-xs font-medium text-foreground"
        >
          New Events available
        </button>
      ) : null}

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto"
        aria-busy={feed.loading || feed.refreshing}
        onScroll={(event) => feed.setScrollTop(event.currentTarget.scrollTop)}
      >
        {feed.loading ? (
          <div className="flex h-full items-center justify-center p-6 text-sm text-foreground-muted" role="status">
            <RefreshCw className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> Loading Events…
          </div>
        ) : feed.error && feed.events.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <Bell className="h-6 w-6 text-foreground-muted" aria-hidden="true" />
            <p className="text-sm text-foreground">Events are unavailable.</p>
            <p className="text-xs text-foreground-muted">{feed.error}</p>
            <button
              type="button"
              onClick={() => void feed.refresh()}
              className="rounded-md bg-[var(--primary-muted)] px-3 py-1.5 text-xs font-medium text-foreground"
            >
              Retry
            </button>
          </div>
        ) : feed.events.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <CheckCheck className="h-6 w-6 text-foreground-muted" aria-hidden="true" />
            <p className="text-sm text-foreground">
              {feed.filter === "unread" ? "You're caught up." : "No Events yet."}
            </p>
            <p className="text-xs text-foreground-muted">
              {feed.filter === "unread"
                ? "Read Events remain available in All."
                : feed.category === "membership"
                  ? "Room membership changes will appear here."
                  : feed.category === "artifacts"
                    ? "Artifact additions and shares will appear here."
                    : "Room membership and Artifact changes will appear here."}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border" aria-label="Events">
            {feed.events.map((event) => {
              const presentation = presentEventFeedItem({
                event,
                humansById: feed.humansById,
                roomsById: feed.roomsById,
                artifactsById: feed.artifactsById,
                viewerActorId: feed.viewerActorId,
              });
              const unread = event.readAt === null;
              const busy = feed.busyEventIds.has(event.id);
              const Icon = event.type === "room.member_left"
                ? LogOut
                : event.type === "room.member_joined"
                  ? LogIn
                  : event.type === "artifact.added"
                    ? FilePlus2
                    : event.type === "artifact.shared"
                      ? Share2
                      : Bell;
              return (
                <li key={event.id} className={`px-3 py-3 ${unread ? "bg-[var(--primary-muted)]/35" : "bg-background"}`}>
                  <div className="flex items-start gap-2.5">
                    <span className="mt-0.5 rounded-full bg-background-element p-1.5 text-foreground-muted">
                      <Icon className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <p className={`text-sm ${unread ? "font-medium text-foreground" : "text-foreground-muted"}`}>
                          {presentation.text}
                        </p>
                        {unread ? <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent" aria-label="Unread" /> : null}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-foreground-muted">
                        <span>{presentation.kindLabel}</span>
                        <time dateTime={event.createdAt}>{timeLabel(event.createdAt)}</time>
                        {presentation.artifactId && presentation.artifactLabel ? (
                          <button
                            type="button"
                            className="font-medium text-foreground hover:underline"
                            onClick={() => void feed.reauthorizeArtifact(presentation.artifactId!).then((artifact) => {
                              if (artifact) onOpenArtifact(artifact);
                            })}
                          >
                            Open {presentation.artifactLabel}
                          </button>
                        ) : presentation.artifactUnavailable ? (
                          <span>Artifact unavailable</span>
                        ) : null}
                        {presentation.roomId && presentation.roomLabel ? (
                          <button
                            type="button"
                            className="font-medium text-foreground hover:underline"
                            onClick={() => onOpenRoom(presentation.roomId!)}
                          >
                            Open {presentation.roomLabel}
                          </button>
                        ) : presentation.roomUnavailable ? (
                          <span>Room unavailable</span>
                        ) : null}
                        <button
                          type="button"
                          disabled={busy || feed.busyEventIds.size > 0 || feed.markingAllRead}
                          onClick={() => void feed.setReadState(event.id, unread)}
                          className="ml-auto rounded px-1.5 py-0.5 font-medium text-foreground hover:bg-background-element disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {busy ? "Saving…" : unread ? "Mark read" : "Mark unread"}
                        </button>
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {feed.error && feed.events.length > 0 ? (
          <div className="m-3 rounded-md border border-border bg-background-element p-3 text-xs text-foreground-muted" role="status">
            <p>{feed.stale ? "These Events may be out of date." : "Could not finish refreshing Events."}</p>
            <button type="button" onClick={() => void feed.refresh()} className="mt-2 font-medium text-foreground hover:underline">
              Retry
            </button>
          </div>
        ) : null}

        {feed.nextCursor ? (
          <div className="p-3 text-center">
            <button
              type="button"
              disabled={feed.loadingMore}
              onClick={() => void feed.loadMore()}
              className="rounded-md border border-border bg-background-element px-3 py-1.5 text-xs font-medium text-foreground hover:bg-[var(--primary-muted)] disabled:opacity-40"
            >
              {feed.loadingMore ? "Loading…" : "Load older Events"}
            </button>
          </div>
        ) : feed.events.length > 0 ? (
          <p className="p-3 text-center text-xs text-foreground-muted">Beginning of Events</p>
        ) : null}
      </div>
    </div>
  );
}
