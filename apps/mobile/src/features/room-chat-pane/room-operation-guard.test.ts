import { describe, expect, test } from "bun:test";

import { createRoomOperationGuard } from "./room-operation-guard";

const roomA = { serverId: "server-a", viewerId: "human-a", roomId: "room-a" };
const roomB = { serverId: "server-a", viewerId: "human-a", roomId: "room-b" };

describe("room operation guard", () => {
  test("rejects a late operation after the active Room changes", () => {
    const guard = createRoomOperationGuard();
    guard.activate(roomA);
    const fromA = guard.begin();

    guard.activate(roomB);
    const fromB = guard.begin();

    expect(guard.isCurrent(fromA)).toBe(false);
    expect(guard.isCurrent(fromB)).toBe(true);
  });

  test("admits only one synchronous send lease for the exact active scope", () => {
    const guard = createRoomOperationGuard();
    guard.activate(roomA);
    const first = guard.begin();
    const second = guard.begin();

    expect(guard.acquireSend(first)).toBe(true);
    expect(guard.acquireSend(second)).toBe(false);
    guard.releaseSend(first);
    expect(guard.acquireSend(second)).toBe(true);
  });

  test("scope replacement immediately permits B and stale A cannot release B", () => {
    const guard = createRoomOperationGuard();
    guard.activate(roomA);
    const fromA = guard.begin();
    expect(guard.acquireSend(fromA)).toBe(true);

    guard.activate(roomB);
    const fromB = guard.begin();
    expect(guard.acquireSend(fromB)).toBe(true);

    guard.releaseSend(fromA);
    expect(guard.acquireSend(guard.begin())).toBe(false);
    guard.releaseSend(fromB);
    expect(guard.acquireSend(guard.begin())).toBe(true);
  });

  test("paginates once synchronously and releases that exact lease", () => {
    const guard = createRoomOperationGuard();
    guard.activate(roomA);
    const first = guard.begin();
    const second = guard.begin();

    expect(guard.acquirePaging(first)).toBe(true);
    expect(guard.acquirePaging(second)).toBe(false);
    guard.releasePaging(first);
    expect(guard.acquirePaging(second)).toBe(true);
  });

  test("scope replacement clears A paging while stale A cannot release B", () => {
    const guard = createRoomOperationGuard();
    guard.activate(roomA);
    const fromA = guard.begin();
    expect(guard.acquirePaging(fromA)).toBe(true);

    guard.activate(roomB);
    const fromB = guard.begin();
    expect(guard.acquirePaging(fromB)).toBe(true);

    guard.releasePaging(fromA);
    expect(guard.isCurrentPaging(fromB)).toBe(true);
    expect(guard.acquirePaging(guard.begin())).toBe(false);
  });

  test("initial history is latest-wins within one exact scope", () => {
    const guard = createRoomOperationGuard();
    guard.activate(roomA);
    const earlier = guard.beginInitialHistory();
    const later = guard.beginInitialHistory();

    expect(guard.isCurrentInitialHistory(earlier)).toBe(false);
    expect(guard.isCurrentInitialHistory(later)).toBe(true);
  });
});
