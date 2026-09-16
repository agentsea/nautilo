import { describe, expect, test } from "bun:test";
import type {
  RemoteHostDisconnectedEvent,
  RemoteHostSnapshotEvent,
  RemoteHostUpdatedEvent,
  ServerEvent,
} from "@nautilo/types";

describe("D458 remote host presence event contract", () => {
  test("updated events are ordered, viewer-safe projections", () => {
    const event = {
      type: "remote.host.updated",
      eventId: "event-2",
      streamId: "presence-stream-a",
      sequence: 2,
      snapshotRevision: 3,
      remoteHostId: "controller-binding-a",
      host: {
        remoteHostId: "controller-binding-a",
        label: "Studio Mac",
        connected: true,
        readiness: "compatible_online",
        lastSeenAt: "2026-07-27T00:00:00.000Z",
      },
    } satisfies RemoteHostUpdatedEvent;
    const asServerEvent: ServerEvent = event;
    expect(asServerEvent.type).toBe("remote.host.updated");
    expect("relayId" in event.host).toBe(false);
    expect("desktopSessionId" in event.host).toBe(false);
  });

  test("disconnect is a controlled terminal reason rather than a leaked relay state", () => {
    const event = {
      type: "remote.host.disconnected",
      eventId: "event-3",
      streamId: "presence-stream-a",
      sequence: 3,
      snapshotRevision: 4,
      remoteHostId: "controller-binding-a",
      terminalReason: "offline",
    } satisfies RemoteHostDisconnectedEvent;
    expect(event.terminalReason).toBe("offline");
    expect("userId" in event).toBe(false);
  });

  test("resume snapshots carry the same full projection and cursor contract", () => {
    const event = {
      type: "remote.host.snapshot",
      hosts: [],
      cursor: {
        streamId: "presence-stream-a",
        sequence: 3,
        snapshotRevision: 4,
      },
    } satisfies RemoteHostSnapshotEvent;
    const asServerEvent: ServerEvent = event;
    expect(asServerEvent.type).toBe("remote.host.snapshot");
  });
});
