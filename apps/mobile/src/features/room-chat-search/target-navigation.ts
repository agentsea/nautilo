import {
  mergeTranscriptWindow,
  type TranscriptWindowState,
} from "./transcript-window";
import type { ChatItem } from "@/lib/messages";
import type { RoomMessagesAroundPage } from "@nautilo/types";

export type TranscriptTargetNavigator = {
  setScope(scopeKey: string | null): void;
  activate(messageId: string): Promise<boolean>;
  /** Invalidate an in-flight target without changing the active Room scope. */
  cancel(): void;
  dispose(): void;
};

/** Pure coordinator for loaded-target avoidance, coalescing, and stale reads. */
export function createTranscriptTargetNavigator(args: {
  getItems(): readonly ChatItem[];
  fetchAround(messageId: string): Promise<RoomMessagesAroundPage>;
  hydrate(page: RoomMessagesAroundPage): Promise<readonly ChatItem[]>;
  apply(items: readonly ChatItem[], window: TranscriptWindowState): void;
  focus(messageId: string): void;
  fail(message: string): void;
}): TranscriptTargetNavigator {
  let disposed = false;
  let scopeKey: string | null = null;
  let generation = 0;
  let inFlight: { key: string; promise: Promise<boolean> } | null = null;

  return {
    setScope(next) {
      if (disposed || next === scopeKey) return;
      scopeKey = next;
      generation += 1;
      inFlight = null;
    },
    activate(messageId) {
      if (disposed || !scopeKey || !messageId) return Promise.resolve(false);
      const current = args.getItems();
      const loaded = current.some(
        (item) => item.kind === "message" && String(item.id) === messageId,
      );
      if (loaded) {
        const merged = mergeTranscriptWindow({
          current,
          hydrated: [],
          targetMessageId: messageId,
          hasOlder: false,
          hasNewer: false,
        });
        args.apply(merged.items, merged.window);
        args.focus(messageId);
        return Promise.resolve(true);
      }
      const key = `${scopeKey}:${messageId}`;
      if (inFlight?.key === key) return inFlight.promise;
      const requestGeneration = generation;
      const promise = (async (): Promise<boolean> => {
        try {
          const page = await args.fetchAround(messageId);
          const hydrated = await args.hydrate(page);
          if (disposed || requestGeneration !== generation) return false;
          const merged = mergeTranscriptWindow({
            current: args.getItems(),
            hydrated,
            targetMessageId: messageId,
            hasOlder: page.hasOlder,
            hasNewer: page.hasNewer,
          });
          args.apply(merged.items, merged.window);
          if (!merged.window.targetFound) {
            args.fail("That message is no longer available.");
            return false;
          }
          args.focus(messageId);
          return true;
        } catch {
          if (disposed || requestGeneration !== generation) return false;
          args.fail("Could not open that message. Try again.");
          return false;
        } finally {
          if (inFlight?.key === key) inFlight = null;
        }
      })();
      inFlight = { key, promise };
      return promise;
    },
    cancel() {
      if (disposed) return;
      generation += 1;
      inFlight = null;
    },
    dispose() {
      disposed = true;
      generation += 1;
      inFlight = null;
      scopeKey = null;
    },
  };
}
