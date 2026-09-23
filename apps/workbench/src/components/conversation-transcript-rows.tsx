import { useCallback, useLayoutEffect, useMemo, type ComponentProps, type ReactNode, type Ref, type RefObject } from "react";
import { ThreadPrimitive, useAuiState } from "@assistant-ui/react";
import { TranscriptWindow, type TranscriptWindowHandle } from "./transcript-window";
import { deriveTranscriptSync } from "./conversation-transcript-sync";
import { conversationViewportScopeKey, shouldConversationTranscriptFollowTail } from "./conversation-viewport";
import { messageDayStarts, validMessageSentAt } from "./message-timestamp";

/** The same synchronized, virtualized transcript for Room and detached views. */
export function ConversationTranscriptRows({ components, roomId, viewportRef, handleRef, followIntent, viewportVisitId, onTranscriptCommit }: {
  components: ComponentProps<typeof ThreadPrimitive.Unstable_MessageById>["components"];
  roomId: string | null;
  viewportRef: RefObject<HTMLElement | null>;
  handleRef?: Ref<TranscriptWindowHandle>;
  followIntent?: boolean;
  viewportVisitId?: number;
  onTranscriptCommit?: (scopeKey: string, visitId: number, messageIds: readonly string[]) => void;
}) {
  const messages = useAuiState((s) => s.thread.messages);
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const followingLiveEdge = shouldConversationTranscriptFollowTail(followIntent);

  const { count, keys } = useMemo(
    () => deriveTranscriptSync(messages),
    [messages],
  );
  useLayoutEffect(() => {
    onTranscriptCommit?.(conversationViewportScopeKey(roomId), viewportVisitId ?? 0, keys);
  }, [keys, onTranscriptCommit, roomId, viewportVisitId]);
  const getItemKey = useCallback(
    (index: number): string => keys[index] ?? String(index),
    [keys],
  );

  const dayStarts = useMemo(() => messageDayStarts(messages.map((message) => message.metadata.custom?.sentAt)), [messages]);
  const renderItem = useCallback(
    (index: number, id: string): ReactNode => {
      const sentAt = messages[index]?.metadata.custom?.sentAt;
      const date = validMessageSentAt(sentAt);
      const showDay = date && dayStarts.has(index);
      return <>
        {showDay && <div className="mx-2 my-4 flex items-center gap-3 text-[11px] text-foreground-muted" aria-label="Message date">
          <span className="h-px flex-1 bg-border" /><time dateTime={date.toISOString()}>{date.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "long", day: "numeric" })}</time><span className="h-px flex-1 bg-border" />
        </div>}
        <ThreadPrimitive.Unstable_MessageById messageId={id} components={components} />
      </>;
    },
    [components, messages, dayStarts],
  );

  return (
    <TranscriptWindow
      count={count}
      getItemKey={getItemKey}
      renderItem={renderItem}
      viewportRef={viewportRef}
      isRunning={isRunning}
      followingLiveEdge={followingLiveEdge}
      resetKey={roomId}
      handleRef={handleRef}
    />
  );
}
