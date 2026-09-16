import { chatItemKey, type ChatItem } from "@/lib/messages";

export type TranscriptWindowState = {
  mode: "latest" | "historical";
  targetMessageId: string | null;
  targetFound: boolean;
  hasOlderGap: boolean;
  hasNewerGap: boolean;
};

export const latestTranscriptWindow: TranscriptWindowState = {
  mode: "latest",
  targetMessageId: null,
  targetFound: false,
  hasOlderGap: false,
  hasNewerGap: false,
};

function compareItems(left: ChatItem, right: ChatItem): number {
  const byTime = left.createdAt.localeCompare(right.createdAt);
  return byTime !== 0 ? byTime : chatItemKey(left).localeCompare(chatItemKey(right));
}

/**
 * Merge an authorized around-message read into the one canonical transcript.
 * Existing rows win so optimistic/streaming identity and live state survive.
 */
export function mergeTranscriptWindow(args: {
  current: readonly ChatItem[];
  hydrated: readonly ChatItem[];
  targetMessageId: string;
  hasOlder: boolean;
  hasNewer: boolean;
}): { items: ChatItem[]; window: TranscriptWindowState } {
  const byKey = new Map<string, ChatItem>();
  for (const item of args.current) byKey.set(chatItemKey(item), item);
  for (const item of args.hydrated) {
    const key = chatItemKey(item);
    if (!byKey.has(key)) byKey.set(key, item);
  }
  const items = [...byKey.values()].sort(compareItems);
  const targetFound = items.some(
    (item) => item.kind === "message" && String(item.id) === args.targetMessageId,
  );
  return {
    items,
    window: {
      mode: "historical",
      targetMessageId: args.targetMessageId,
      targetFound,
      // Gaps are asserted only from the server's explicit around-page flags.
      hasOlderGap: args.hasOlder,
      hasNewerGap: args.hasNewer,
    },
  };
}

export function returnTranscriptToLatest(): TranscriptWindowState {
  return { ...latestTranscriptWindow };
}

/** Preserve the exact historical target across a canonical latest-page reload. */
export function targetToRestoreAfterLatestReload(window: TranscriptWindowState): string | null {
  return window.mode === "historical" ? window.targetMessageId : null;
}
