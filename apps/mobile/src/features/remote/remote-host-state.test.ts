import { describe, expect, test } from "bun:test";
import type {
  RemoteHost,
  RemoteHostPresenceEvent,
} from "@nautilo/api-client/browser";
import {
  createRemoteHostState,
  reduceRemoteHostState,
} from "./remote-host-state";

const HOST_ID = "445e9ba2-b7f9-4771-8ebc-ebdd41918a7b";

function host(overrides: Partial<RemoteHost> = {}): RemoteHost {
  return {
    remoteHostId: HOST_ID,
    label: "Writer’s Mac",
    connected: true,
    readiness: "compatible_online",
    lastSeenAt: "2026-07-27T12:00:00.000Z",
    ...overrides,
  };
}

function connected(
  overrides: Partial<RemoteHostPresenceEvent> = {},
): RemoteHostPresenceEvent {
  return {
    type: "remote.host.connected",
    eventId: "stream-a:1",
    remoteHostId: HOST_ID,
    streamId: "stream-a",
    sequence: 1,
    snapshotRevision: 1,
    host: host(),
    ...overrides,
  } as RemoteHostPresenceEvent;
}

describe("remote host reconciliation", () => {
  test("an authoritative snapshot replaces stale hosts and stream epoch", () => {
    const initial = reduceRemoteHostState(createRemoteHostState("srv_a"), {
      type: "snapshot",
      serverId: "srv_a",
      snapshot: {
        hosts: [host({ label: "Old" })],
        cursor: {
          streamId: "old-stream",
          sequence: 9,
          snapshotRevision: 4,
        },
      },
    });
    const replaced = reduceRemoteHostState(initial, {
      type: "snapshot",
      serverId: "srv_a",
      snapshot: {
        hosts: [host({ label: "Current" })],
        cursor: {
          streamId: "new-stream",
          sequence: 0,
          snapshotRevision: 0,
        },
      },
    });
    expect(replaced.hosts).toEqual([host({ label: "Current" })]);
    expect(replaced.cursor?.streamId).toBe("new-stream");
  });

  test("applies contiguous events once and ignores duplicate/out-of-order delivery", () => {
    const snapshot = reduceRemoteHostState(createRemoteHostState("srv_a"), {
      type: "snapshot",
      serverId: "srv_a",
      snapshot: {
        hosts: [],
        cursor: {
          streamId: "stream-a",
          sequence: 0,
          snapshotRevision: 0,
        },
      },
    });
    const once = reduceRemoteHostState(snapshot, {
      type: "event",
      serverId: "srv_a",
      event: connected(),
    });
    expect(once.hosts).toEqual([host()]);
    expect(reduceRemoteHostState(once, {
      type: "event",
      serverId: "srv_a",
      event: connected(),
    })).toBe(once);

    const gap = reduceRemoteHostState(once, {
      type: "event",
      serverId: "srv_a",
      event: connected({
        eventId: "stream-a:3",
        sequence: 3,
        snapshotRevision: 3,
      }),
    });
    expect(gap.needsResume).toBe(true);
    expect(gap.hosts).toEqual([host()]);
  });

  test("disconnect is honest and revoke removes the host projection", () => {
    const ready = reduceRemoteHostState(createRemoteHostState("srv_a"), {
      type: "snapshot",
      serverId: "srv_a",
      snapshot: {
        hosts: [host()],
        cursor: {
          streamId: "stream-a",
          sequence: 1,
          snapshotRevision: 1,
        },
      },
    });
    const offline = reduceRemoteHostState(ready, {
      type: "event",
      serverId: "srv_a",
      event: {
        type: "remote.host.disconnected",
        eventId: "stream-a:2",
        remoteHostId: HOST_ID,
        streamId: "stream-a",
        sequence: 2,
        snapshotRevision: 2,
        terminalReason: "offline",
      },
    });
    expect(offline.hosts[0]).toMatchObject({
      connected: false,
      readiness: "offline",
    });
    const revoked = reduceRemoteHostState(offline, {
      type: "event",
      serverId: "srv_a",
      event: {
        type: "remote.host.revoked",
        eventId: "stream-a:3",
        remoteHostId: HOST_ID,
        streamId: "stream-a",
        sequence: 3,
        snapshotRevision: 3,
        terminalReason: "revoked",
      },
    });
    expect(revoked.hosts).toEqual([]);
  });

  test("events from another selected server are ignored", () => {
    const initial = createRemoteHostState("srv_a");
    const next = reduceRemoteHostState(initial, {
      type: "event",
      serverId: "srv_b",
      event: connected(),
    });
    expect(next).toBe(initial);
  });

  test("another phone's contiguous event advances the cursor without adding its host", () => {
    const snapshot = reduceRemoteHostState(createRemoteHostState("srv_a"), {
      type: "snapshot",
      serverId: "srv_a",
      snapshot: {
        hosts: [host()],
        cursor: { streamId: "stream-a", sequence: 0, snapshotRevision: 0 },
      },
    });
    const next = reduceRemoteHostState(snapshot, {
      type: "event",
      serverId: "srv_a",
      event: connected({
        eventId: "stream-a:1-other-phone",
        remoteHostId: "00000000-0000-4000-8000-000000000099",
        host: host({ remoteHostId: "00000000-0000-4000-8000-000000000099" }),
      }),
      includeHost: false,
    });
    expect(next.hosts).toEqual([host()]);
    expect(next.cursor?.sequence).toBe(1);
    expect(next.needsResume).toBe(false);
  });
});
