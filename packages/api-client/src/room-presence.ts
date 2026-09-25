import type { RoomPresenceResponse } from "@nautilo/types";

/** Roster freshness policy; this timer exists only while its client surface is active. */
const ROOM_PRESENCE_REFRESH_MS = 15_000;

/** One visible roster owns one cancellable request and one refresh timer. */
export function createRoomPresencePoller(options: {
  load: (signal: AbortSignal) => Promise<RoomPresenceResponse>;
  onChange: (snapshot: RoomPresenceResponse | null) => void;
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}): { setActive(active: boolean): void; refresh(): void; dispose(): void } {
  const schedule = options.setTimer ?? setTimeout;
  const cancel = options.clearTimer ?? clearTimeout;
  let active = false;
  let disposed = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: AbortController | undefined;

  function invalidate(): void {
    generation++;
    if (timer !== undefined) cancel(timer);
    timer = undefined;
    pending?.abort();
    pending = undefined;
  }

  async function read(): Promise<void> {
    if (!active || disposed || pending) return;
    const current = generation;
    const controller = new AbortController();
    pending = controller;
    try {
      const snapshot = await options.load(controller.signal);
      if (!disposed && active && current === generation) options.onChange(snapshot);
    } catch {
      if (!disposed && active && current === generation) options.onChange(null);
    } finally {
      if (!disposed && active && current === generation) {
        pending = undefined;
        timer = schedule(() => { timer = undefined; void read(); }, ROOM_PRESENCE_REFRESH_MS);
      }
    }
  }

  return {
    setActive(next) {
      if (disposed || next === active) return;
      active = next;
      invalidate();
      options.onChange(null);
      if (active) void read();
    },
    refresh() {
      if (disposed || !active) return;
      invalidate();
      options.onChange(null);
      void read();
    },
    dispose() {
      disposed = true;
      active = false;
      invalidate();
    },
  };
}
