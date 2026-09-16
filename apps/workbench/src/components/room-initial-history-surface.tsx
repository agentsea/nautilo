import type { RoomInitialHydrationState } from "../adapters/room-initial-hydration";

export type RoomInitialHistorySurfaceMode =
  | "none"
  | "skeletons"
  | "syncing"
  | "waiting-for-authority"
  | "retry-without-cache"
  | "retry-with-cache"
  | "access-terminal";

/**
 * Projects the runtime-owned initial-history state into one truthful transcript
 * surface. A state for a previous Room deliberately behaves like a cache miss:
 * it must never disclose (or replace) the newly selected Room's transcript.
 */
export function selectRoomInitialHistorySurface(
  state: RoomInitialHydrationState | null,
  activeRoomId: string | null,
): RoomInitialHistorySurfaceMode {
  if (activeRoomId === null) return "none";
  // The active Room can change before its layout context has supplied a state.
  // Treat that first paint as a cache miss, never as an empty transcript.
  if (state === null) return "skeletons";
  if (state.scope.roomId !== activeRoomId) return "skeletons";

  switch (state.kind) {
    case "unresolved":
      return "skeletons";
    case "syncing":
      return "syncing";
    case "waiting-for-authority":
      return "waiting-for-authority";
    case "recoverable-error":
      return state.retainsCachedFrame ? "retry-with-cache" : "retry-without-cache";
    case "access-terminal-error":
      return "access-terminal";
    case "ready":
    case "empty":
      return "none";
  }
}

export interface RoomInitialHistorySurfaceProps {
  readonly state: RoomInitialHydrationState | null;
  readonly activeRoomId: string | null;
  readonly onRetry: () => void;
}

/**
 * Desktop-only presentation for the first history frame of a selected Room.
 *
 * This component neither reads context nor owns messages: the transcript stays
 * visible while syncing a cache hit, while an unresolved cache miss gets an
 * intentionally anonymous message-shaped placeholder at its bottom edge.
 */
export function RoomInitialHistorySurface({
  state,
  activeRoomId,
  onRetry,
}: RoomInitialHistorySurfaceProps) {
  const mode = selectRoomInitialHistorySurface(state, activeRoomId);

  switch (mode) {
    case "skeletons":
      return <InitialHistorySkeletons />;
    case "syncing":
      return <SyncDisclosure>Syncing latest</SyncDisclosure>;
    case "waiting-for-authority":
      return <SyncDisclosure>Waiting for secure message access</SyncDisclosure>;
    case "retry-without-cache":
      return <RetrySurface onRetry={onRetry} />;
    case "retry-with-cache":
      return (
        <SyncDisclosure>
          Couldn&apos;t sync latest messages. <RetryButton onRetry={onRetry} />
        </SyncDisclosure>
      );
    case "access-terminal":
      return state?.kind === "access-terminal-error"
        ? <AccessTerminalSurface state={state} />
        : null;
    case "none":
      return null;
  }
}

function InitialHistorySkeletons() {
  return (
    <div className="flex min-h-full flex-col justify-end px-4 pb-4" data-testid="room-initial-history-skeletons">
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        Loading messages
      </p>
      <div aria-hidden="true" className="flex flex-col gap-3">
        <div className="h-12 w-[62%] max-w-xl rounded-2xl bg-background-element/80 motion-safe:animate-pulse motion-reduce:animate-none" />
        <div className="ml-auto h-10 w-[46%] max-w-md rounded-2xl bg-background-element/80 motion-safe:animate-pulse motion-reduce:animate-none" />
        <div className="h-16 w-[71%] max-w-2xl rounded-2xl bg-background-element/80 motion-safe:animate-pulse motion-reduce:animate-none" />
        <div className="ml-auto h-10 w-[38%] max-w-sm rounded-2xl bg-background-element/80 motion-safe:animate-pulse motion-reduce:animate-none" />
      </div>
    </div>
  );
}

function SyncDisclosure({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center text-xs text-foreground-muted" role="status" aria-live="polite" aria-atomic="true">
      {children}
    </div>
  );
}

function RetrySurface({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <div className="flex min-h-full flex-col justify-end px-4 pb-4">
      <div className="flex max-w-md items-center justify-between gap-3 rounded-lg border border-border bg-background-panel px-3 py-2 text-sm text-foreground-muted" role="alert">
        <span>Couldn&apos;t load messages.</span>
        <RetryButton onRetry={onRetry} />
      </div>
    </div>
  );
}

function AccessTerminalSurface({
  state,
}: {
  readonly state: Extract<RoomInitialHydrationState, { kind: "access-terminal-error" }>;
}) {
  const message = state.reason === "not-found"
    ? "This chat is no longer available."
    : "You no longer have access to this chat.";

  return (
    <div className="flex min-h-full flex-col justify-end px-4 pb-4">
      <div className="max-w-md rounded-lg border border-border bg-background-panel px-3 py-2 text-sm text-foreground-muted" role="alert">
        {message}
      </div>
    </div>
  );
}

function RetryButton({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <button
      className="pointer-events-auto shrink-0 rounded px-2 py-1 text-xs font-medium text-foreground underline underline-offset-2 hover:bg-background-element focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background-panel"
      onClick={onRetry}
      type="button"
    >
      Retry
    </button>
  );
}
