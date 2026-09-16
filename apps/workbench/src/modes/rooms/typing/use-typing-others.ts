import { useEffect, useState } from "react";
import { TYPING_DECAY_MS } from "@nautilo/types";
import { subscribeTypingCommitted, subscribeTypingPing } from "./typing-bus";

export interface TypingOther {
  userId: string;
  displayName: string;
  lastPingAt: number;
}

/**
 * Stack-3 Phase 6b — track who else (other than the local user) is
 * currently typing in `roomId`.
 *
 * Maintains a `userId → {displayName, lastPingAt}` map populated from
 * inbound `nautilo:typing-ping` window events (dispatched by the
 * runtime adapter when the server fans out a `typing.ping` over WS).
 * Entries auto-expire {@link TYPING_DECAY_MS} after their last ping
 * via a 1s sweep timer. Returns the active set as an array sorted by
 * arrival order (most-recently-pinged last) so the UI can render
 * "Alice and Bob are typing…" deterministically.
 *
 * Self-pings never reach this hook because the server's
 * {@link publishTypingPing} excludes the sender's socket.
 *
 * Returns an empty array when `roomId` is null.
 */
export function useTypingOthers(roomId: string | null): TypingOther[] {
  const [others, setOthers] = useState<TypingOther[]>([]);

  useEffect(() => {
    if (!roomId) {
      setOthers([]);
      return;
    }

    // D441 — clear rendered state at the start of the new-room effect
    // run. The previous effect's cleanup already unsubscribed the old
    // listener, but the React state still holds room A's `others` array
    // until a room-B ping/flush arrives. Resetting here makes an A→B
    // room switch yield `[]` on the very next render, before any room-B
    // ping arrives (the confirmed A→B stale-typing bug).
    setOthers([]);

    const map = new Map<string, TypingOther>();

    const flush = (): void => {
      setOthers(Array.from(map.values()).sort((a, b) => a.lastPingAt - b.lastPingAt));
    };

    const unsubscribe = subscribeTypingPing((detail) => {
      if (detail.roomId !== roomId) return;
      map.set(detail.userId, {
        userId: detail.userId,
        displayName: detail.displayName,
        lastPingAt: Date.now(),
      });
      flush();
    });
    const unsubscribeCommitted = subscribeTypingCommitted((detail) => {
      if (detail.roomId !== roomId || !map.delete(detail.userId)) return;
      flush();
    });

    const sweep = window.setInterval(() => {
      const cutoff = Date.now() - TYPING_DECAY_MS;
      let mutated = false;
      for (const [userId, entry] of map) {
        if (entry.lastPingAt < cutoff) {
          map.delete(userId);
          mutated = true;
        }
      }
      if (mutated) flush();
    }, 1000);

    return () => {
      unsubscribe();
      unsubscribeCommitted();
      window.clearInterval(sweep);
    };
  }, [roomId]);

  return others;
}
