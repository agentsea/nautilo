import { describe, expect, test } from "bun:test";
import {
  RemoteHostPresenceStream,
} from "../../src/remote-control/host-presence-stream";
import type { RemoteHostProjection } from "@nautilo/types";
import {
  remoteHostPresenceEventSchema,
  remoteHostSnapshotResponseSchema,
} from "@nautilo/api-client";
import {
  createRelayGenerationInvalidator,
  isFrameBoundToRegisteredRelay,
} from "../../src/realtime/relay-endpoint";

const host = (overrides: Partial<RemoteHostProjection> = {}): RemoteHostProjection => ({
  remoteHostId: "445e9ba2-b7f9-4771-8ebc-ebdd41918a7b",
  label: "Writer's Mac",
  connected: true,
  readiness: "compatible_online",
  lastSeenAt: "2026-07-27T12:00:00.000Z",
  ...overrides,
});

describe("D458 remote host presence stream", () => {
  test("publishes ordered display-safe deltas to the owner only and replays a contiguous suffix", async () => {
    let projected: readonly RemoteHostProjection[] = [host()];
    const sent: Array<{ userId: string; frame: unknown }> = [];
    const stream = new RemoteHostPresenceStream({
      streamId: "process-a",
      projector: { projectForUser: async () => projected },
      publishToUser: (userId, frame) => sent.push({ userId, frame }),
    });

    const first = await stream.reconcileUser("owner");
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      type: "remote.host.connected",
      eventId: "process-a:1",
      remoteHostId: host().remoteHostId,
      streamId: "process-a",
      sequence: 1,
      snapshotRevision: 1,
      host: host(),
    });
    expect(remoteHostPresenceEventSchema.safeParse(first[0]).success).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.userId).toBe("owner");
    // No recipient/relay/internal fields can exist in a frame projection.
    expect(JSON.stringify(first[0])).not.toContain("relayId");
    expect(JSON.stringify(first[0])).not.toContain("userId");
    expect(JSON.stringify(first[0])).not.toContain("pairingGeneration");

    projected = [host({ label: "Writer Mac", lastSeenAt: "2026-07-27T12:01:00.000Z" })];
    await stream.reconcileUser("owner");
    const replay = await stream.resumeForUser("owner", {
      streamId: "process-a",
      sequence: 1,
      snapshotRevision: 1,
    });
    expect(replay).toHaveLength(1);
    expect(replay[0]).toMatchObject({ type: "remote.host.updated", sequence: 2 });
  });

  test("gap, expired ring, and a prior process stream id return snapshots", async () => {
    let now = 1_000;
    let projected: readonly RemoteHostProjection[] = [host()];
    const stream = new RemoteHostPresenceStream({
      streamId: "process-a",
      now: () => now,
      retentionMs: 10,
      projector: { projectForUser: async () => projected },
      publishToUser: () => {},
    });
    await stream.reconcileUser("owner");
    projected = [host({ label: "new label" })];
    now += 20;
    await stream.reconcileUser("owner");

    const expired = await stream.resumeForUser("owner", {
      streamId: "process-a",
      sequence: 0,
      snapshotRevision: 0,
    });
    expect(expired[0]).toMatchObject({
      type: "remote.host.snapshot",
      cursor: { streamId: "process-a", sequence: 2, snapshotRevision: 2 },
      hosts: [host({ label: "new label" })],
    });
    if (expired[0]?.type === "remote.host.snapshot") {
      expect(
        remoteHostSnapshotResponseSchema.safeParse({
          hosts: expired[0].hosts,
          cursor: expired[0].cursor,
        }).success,
      ).toBe(true);
    }
    const restarted = await stream.resumeForUser("owner", {
      streamId: "process-before-restart",
      sequence: 2,
      snapshotRevision: 2,
    });
    expect(restarted[0]).toMatchObject({
      type: "remote.host.snapshot",
      cursor: { streamId: "process-a", sequence: 2, snapshotRevision: 2 },
    });
  });

  test("authoritative REST snapshot exposes the same full host and real cursor", async () => {
    const stream = new RemoteHostPresenceStream({
      streamId: "process-a",
      projector: { projectForUser: async () => [host()] },
      publishToUser: () => {},
    });
    const snapshot = await stream.authoritativeSnapshotForUser("owner");
    expect(snapshot).toEqual({
      hosts: [host()],
      cursor: { streamId: "process-a", sequence: 1, snapshotRevision: 1 },
    });
    expect(remoteHostSnapshotResponseSchema.safeParse(snapshot).success).toBe(true);
  });

  test("ready loss emits the canonical controlled terminal reason and one new revision", async () => {
    let projected: readonly RemoteHostProjection[] = [host()];
    const stream = new RemoteHostPresenceStream({
      streamId: "process-a",
      projector: { projectForUser: async () => projected },
      publishToUser: () => {},
    });
    await stream.reconcileUser("owner");
    projected = [
      host({
        connected: false,
        readiness: "identity_conflict",
      }),
    ];
    const events = await stream.reconcileUser("owner");
    expect(events).toEqual([
      {
        type: "remote.host.disconnected",
        eventId: "process-a:2",
        remoteHostId: host().remoteHostId,
        streamId: "process-a",
        sequence: 2,
        snapshotRevision: 2,
        terminalReason: "identity_conflict",
      },
    ]);
    expect(remoteHostPresenceEventSchema.safeParse(events[0]).success).toBe(true);
    const snapshot = await stream.authoritativeSnapshotForUser("owner");
    expect(snapshot.cursor).toEqual({
      streamId: "process-a",
      sequence: 2,
      snapshotRevision: 2,
    });
    expect(snapshot.hosts[0]).toMatchObject({
      remoteHostId: host().remoteHostId,
      connected: false,
      readiness: "identity_conflict",
    });
  });

  test("revocation invalidates before reconciliation and emits a viewer-safe revoked removal", async () => {
    let projected: readonly RemoteHostProjection[] = [host()];
    const invalidated: string[][] = [];
    const stream = new RemoteHostPresenceStream({
      streamId: "process-a",
      projector: {
        projectForUser: async () => projected,
        invalidatePairingGenerations: async ({ pairingGenerationIds }) => {
          invalidated.push([...pairingGenerationIds]);
          projected = [];
        },
      },
      publishToUser: () => {},
    });
    await stream.reconcileUser("owner");
    const frames = await stream.invalidatePairingGenerations({
      userId: "owner",
      pairingGenerationIds: ["internal-generation"],
    });
    expect(invalidated).toEqual([["internal-generation"]]);
    expect(frames[0]).toMatchObject({
      type: "remote.host.revoked",
      eventId: "process-a:2",
      remoteHostId: host().remoteHostId,
      sequence: 2,
      snapshotRevision: 2,
      terminalReason: "revoked",
    });
    expect(remoteHostPresenceEventSchema.safeParse(frames[0]).success).toBe(true);
    expect(JSON.stringify(frames[0])).not.toContain("internal-generation");
  });

  test("an explicit binding revoke marks only that exact removal as revoked", async () => {
    const revokedHost = host();
    const coincidentOfflineHost = host({
      remoteHostId: "545e9ba2-b7f9-4771-8ebc-ebdd41918a7b",
      label: "Other Mac",
    });
    let projected: readonly RemoteHostProjection[] = [
      revokedHost,
      coincidentOfflineHost,
    ];
    const stream = new RemoteHostPresenceStream({
      streamId: "process-a",
      projector: { projectForUser: async () => projected },
      publishToUser: () => {},
    });
    await stream.reconcileUser("owner");

    projected = [];
    const events = await stream.revokeRemoteHost({
      userId: "owner",
      remoteHostId: revokedHost.remoteHostId,
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "remote.host.revoked",
        remoteHostId: revokedHost.remoteHostId,
        terminalReason: "revoked",
      }),
      expect.objectContaining({
        type: "remote.host.disconnected",
        remoteHostId: coincidentOfflineHost.remoteHostId,
        terminalReason: "offline",
      }),
    ]);
  });

  test("a queued or in-flight user survives tiny-cache pressure without a second epoch", async () => {
    let releaseFirstProjection!: () => void;
    const firstProjectionGate = new Promise<void>((resolve) => {
      releaseFirstProjection = resolve;
    });
    let reportFirstProjectionStarted!: () => void;
    const firstProjectionStarted = new Promise<void>((resolve) => {
      reportFirstProjectionStarted = resolve;
    });
    let ownerProjectionCount = 0;
    const stream = new RemoteHostPresenceStream({
      userCacheLimit: 1,
      projector: {
        projectForUser: async (userId) => {
          if (userId === "owner" && ownerProjectionCount++ === 0) {
            reportFirstProjectionStarted();
            await firstProjectionGate;
          }
          return [host()];
        },
      },
      publishToUser: () => {},
    });

    const first = stream.authoritativeSnapshotForUser("owner");
    await firstProjectionStarted;
    const queued = stream.authoritativeSnapshotForUser("owner");
    await stream.authoritativeSnapshotForUser("other");
    const third = stream.authoritativeSnapshotForUser("owner");
    releaseFirstProjection();

    const snapshots = await Promise.all([first, queued, third]);
    expect(new Set(snapshots.map((snapshot) => snapshot.cursor.streamId)).size).toBe(1);
    expect(snapshots.map((snapshot) => snapshot.cursor.sequence)).toEqual([1, 1, 1]);
  });
});

describe("D458 relay frame identity barrier", () => {
  test("heartbeat/disconnect frames cannot name another relay", () => {
    expect(isFrameBoundToRegisteredRelay("relay-owner", "relay-owner")).toBe(true);
    expect(isFrameBoundToRegisteredRelay("relay-owner", "relay-victim")).toBe(false);
    expect(isFrameBoundToRegisteredRelay(null, "relay-victim")).toBe(false);
  });

  test("generation revocation invalidates authority then evicts only matching live relay ids", async () => {
    const order: string[] = [];
    const invalidator = createRelayGenerationInvalidator({
      registry: {
        snapshotForUser: (userId) => {
          expect(userId).toBe("owner");
          return [
            { relayId: "relay-revoked", pairingGeneration: "generation-old" },
            { relayId: "relay-current", pairingGeneration: "generation-current" },
          ];
        },
        unregister: async (relayId) => {
          order.push(`unregister:${relayId}`);
        },
      },
      invalidateAuthorityAndPresence: async ({ pairingGenerationIds }) => {
        expect(pairingGenerationIds).toEqual(["generation-old"]);
        order.push("invalidate");
      },
    });
    await invalidator.invalidatePairingGenerations({
      userId: "owner",
      pairingGenerationIds: ["generation-old"],
    });
    expect(order).toEqual(["invalidate", "unregister:relay-revoked"]);
  });

  test("revoked live generations are evicted even when reconciliation fails", async () => {
    const evicted: string[] = [];
    const invalidator = createRelayGenerationInvalidator({
      registry: {
        snapshotForUser: () => [
          { relayId: "relay-revoked", pairingGeneration: "generation-old" },
        ],
        unregister: async (relayId) => {
          evicted.push(relayId);
        },
      },
      invalidateAuthorityAndPresence: async () => {
        throw new Error("projection unavailable");
      },
    });
    let rejection: unknown;
    try {
      await invalidator.invalidatePairingGenerations({
        userId: "owner",
        pairingGenerationIds: ["generation-old"],
      });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe("projection unavailable");
    expect(evicted).toEqual(["relay-revoked"]);
  });
});
