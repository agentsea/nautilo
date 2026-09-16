import type { LaneLock, ReleaseFn, TryAcquireResult } from "./types";

/** Canonical idle tail — same reference whenever the lane is fully free. */
const IDLE: Promise<void> = Promise.resolve();

/**
 * In-memory lane lock (LOCK_MODE=memory).
 * One foreground job at a time per lane key.
 * Uses Promise chaining so `acquire` waiters wait in order.
 *
 * M074: `tryAcquire` returns immediately when the lane is busy (another
 * holder or queued acquirer ahead). Uses a synchronous `held` flag plus
 * `tail === IDLE` to reject concurrent tryAcquire winners without awaiting.
 */
export class InMemoryLaneLock implements LaneLock {
  private tails = new Map<string, Promise<void>>();
  private held = new Map<string, boolean>();

  async acquire(laneKey: string): Promise<ReleaseFn> {
    const prev = this.tails.get(laneKey) ?? IDLE;
    let release!: ReleaseFn;
    const next = new Promise<void>((resolve) => {
      release = async () => {
        this.held.set(laneKey, false);
        resolve();
        this.tails.set(laneKey, IDLE);
        return Promise.resolve();
      };
    });
    this.tails.set(laneKey, prev.then(() => next));
    await prev;
    this.held.set(laneKey, true);
    return release;
  }

  async tryAcquire(laneKey: string): Promise<TryAcquireResult> {
    if (this.held.get(laneKey)) {
      return { acquired: false, busyKey: laneKey };
    }
    const prev = this.tails.get(laneKey) ?? IDLE;
    if (!Object.is(prev, IDLE)) {
      return { acquired: false, busyKey: laneKey };
    }

    this.held.set(laneKey, true);

    let release!: ReleaseFn;
    const next = new Promise<void>((resolve) => {
      release = async () => {
        this.held.set(laneKey, false);
        resolve();
        this.tails.set(laneKey, IDLE);
        return Promise.resolve();
      };
    });
    this.tails.set(laneKey, prev.then(() => next));
    await prev;
    return { acquired: true, release };
  }
}

export const laneLock = new InMemoryLaneLock();
