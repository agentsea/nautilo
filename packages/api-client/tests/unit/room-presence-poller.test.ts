import { describe, expect, test } from "bun:test";
import type { RoomPresenceResponse } from "@nautilo/types";
import { createRoomPresencePoller } from "../../src/room-presence";

const ONLINE: RoomPresenceResponse = { members: [{ actorId: "human", status: "online" }] };
const IDLE: RoomPresenceResponse = { members: [{ actorId: "human", status: "idle" }] };
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

function harness() {
  const reads: Array<{ signal: AbortSignal; resolve: (value: RoomPresenceResponse) => void; reject: (error: Error) => void }> = [];
  const changes: Array<RoomPresenceResponse | null> = [];
  const timers = new Map<number, () => void>();
  let id = 0;
  const poller = createRoomPresencePoller({
    load: (signal) => new Promise((resolve, reject) => reads.push({ signal, resolve, reject })),
    onChange: (snapshot) => changes.push(snapshot),
    setTimer: (fn, ms) => {
      expect(ms).toBe(15_000);
      timers.set(++id, fn);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (handle) => { timers.delete(handle as unknown as number); },
  });
  return { poller, reads, changes, timers, tick: () => {
    const entry = timers.entries().next().value;
    if (!entry) throw new Error("No timer scheduled");
    timers.delete(entry[0]); entry[1]();
  } };
}

describe("visible room presence polling", () => {
  test("loads on entry, serializes reads, clears failed snapshots and recovers", async () => {
    const h = harness();
    expect(h.reads).toHaveLength(0);
    h.poller.setActive(true);
    h.poller.setActive(true);
    expect(h.reads).toHaveLength(1);
    expect(h.timers.size).toBe(0);
    h.reads[0]!.resolve(ONLINE); await settle();
    expect(h.changes.at(-1)).toEqual(ONLINE);
    h.tick();
    h.reads[1]!.reject(new Error("unsupported / denied / disconnected")); await settle();
    expect(h.changes.at(-1)).toBeNull();
    h.tick(); h.reads[2]!.resolve(IDLE); await settle();
    expect(h.changes.at(-1)).toEqual(IDLE);
    h.poller.dispose(); expect(h.timers.size).toBe(0);
  });

  test("background cancels pending work and resume discards late previous responses", async () => {
    const h = harness(); h.poller.setActive(true);
    h.poller.setActive(false);
    expect(h.reads[0]!.signal.aborted).toBe(true);
    expect(h.changes.at(-1)).toBeNull();
    expect(h.timers.size).toBe(0);
    h.poller.setActive(true);
    h.reads[1]!.resolve(IDLE); await settle();
    h.reads[0]!.resolve(ONLINE); await settle();
    expect(h.changes.at(-1)).toEqual(IDLE);
    expect(h.timers.size).toBe(1);
    h.poller.dispose();
  });

  test("membership refresh clears stale labels and aborts an older snapshot", async () => {
    const h = harness(); h.poller.setActive(true);
    h.poller.refresh(); expect(h.reads[0]!.signal.aborted).toBe(true);
    h.reads[1]!.resolve({ members: [] }); await settle();
    h.reads[0]!.resolve(ONLINE); await settle();
    expect(h.changes.at(-1)).toEqual({ members: [] });
    h.poller.dispose();
  });

  test("disposing on room/account/server change prevents any old callback or timer", async () => {
    const old = harness(); old.poller.setActive(true); old.poller.dispose();
    const next = harness(); next.poller.setActive(true);
    next.reads[0]!.resolve(IDLE); await settle();
    old.reads[0]!.resolve(ONLINE); await settle();
    expect(old.changes).toEqual([null]); expect(old.timers.size).toBe(0);
    expect(next.changes.at(-1)).toEqual(IDLE);
    old.poller.refresh(); old.poller.setActive(true);
    expect(old.reads).toHaveLength(1);
    next.poller.dispose();
  });
});
