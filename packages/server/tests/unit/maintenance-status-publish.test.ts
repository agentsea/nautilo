/**
 * D420 (Wave 3 task 3.2.1) — unit tests for the payload-free
 * `maintenance.status` realtime event: the typed event shape, the WS
 * broadcaster's global fan-out + no-leak contract, and the
 * `withMaintenanceStatusPublishing` controller wrapper that drives
 * broadcasts on every durable state change (operator mutations + expiry
 * recovery observed on read) while suppressing same-state reads.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { WebSocket as WsWebSocket } from "ws";
import { setLogOutput } from "@nautilo/logger";
import {
  addClient,
  buildMaintenanceStatusEvent,
  publishMaintenanceStatus,
} from "../../src/realtime/ws-publisher";
import {
  withMaintenanceStatusPublishing,
  type MaintenanceControllerSeam,
  type MaintenanceStatusPublisher,
} from "../../src/routes/operator-release";
import type { MaintenanceSnapshot } from "@nautilo/db";

const NOW = new Date("2026-07-14T12:00:00.000Z");
const LEASE = new Date("2026-07-14T12:05:00.000Z");
const HARD = new Date("2026-07-14T12:30:00.000Z");

function snap(
  over: Partial<{
    state: "normal" | "draining" | "applying";
    operationId: string | null;
    leaseExpiresAt: Date | null;
    hardExpiresAt: Date | null;
  }> = {},
): MaintenanceSnapshot {
  return {
    singletonKey: "upgrade",
    state: over.state ?? "draining",
    operationId: over.operationId !== undefined ? over.operationId : "op-123",
    leaseExpiresAt: over.leaseExpiresAt !== undefined ? over.leaseExpiresAt : LEASE,
    hardExpiresAt: over.hardExpiresAt !== undefined ? over.hardExpiresAt : HARD,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

interface MockWs {
  readyState: number;
  sent: string[];
  OPEN: number;
  CLOSING: number;
  CLOSED: number;
  CONNECTING: number;
  send(payload: string): void;
  on(): void;
  [k: string]: unknown;
}

function makeClient(): MockWs {
  return {
    readyState: 1,
    sent: [],
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
    CONNECTING: 0,
    send(payload: string) {
      this.sent.push(payload);
    },
    on() {
      /* close listener */
    },
  };
}

beforeEach(() => {
  setLogOutput("silent");
});

afterEach(() => {
  setLogOutput("silent");
});

describe("buildMaintenanceStatusEvent — typed payload-free shape", () => {
  test("active lease carries state/operation/ISO expiry only", () => {
    const ev = buildMaintenanceStatusEvent(snap());
    expect(ev).toEqual({
      type: "maintenance.status",
      state: "draining",
      operationId: "op-123",
      leaseExpiresAt: LEASE.toISOString(),
      hardExpiresAt: HARD.toISOString(),
    });
  });

  test("normal lease carries null expiries and no operation", () => {
    const ev = buildMaintenanceStatusEvent(
      snap({
        state: "normal",
        operationId: null,
        leaseExpiresAt: null,
        hardExpiresAt: null,
      }),
    );
    expect(ev).toEqual({
      type: "maintenance.status",
      state: "normal",
      operationId: null,
      leaseExpiresAt: null,
      hardExpiresAt: null,
    });
  });

  test("never carries work counts, job ids, prompts, room/lane, or user payload", () => {
    const ev = buildMaintenanceStatusEvent(snap());
    const json = JSON.stringify(ev);
    for (const forbidden of [
      "work",
      "runningForegroundJobs",
      "queuedTurns",
      "acceptedWork",
      "jobId",
      "prompt",
      "laneKey",
      "roomId",
      "userId",
      "actorId",
    ]) {
      expect(json).not.toContain(forbidden);
    }
  });
});

describe("publishMaintenanceStatus — global WS fan-out", () => {
  test("delivered to every authenticated socket regardless of room/user scope", () => {
    const ownerClient = makeClient();
    const peerClient = makeClient();
    addClient(ownerClient as unknown as WsWebSocket, {
      userId: "owner-uid-maint",
      actorId: "owner-actor",
      roomIds: new Set(["11111111-1111-4111-8111-111111111111"]),
    });
    addClient(peerClient as unknown as WsWebSocket, {
      userId: "peer-uid-maint",
      actorId: "peer-actor",
      // Different room subscription — maintenance is server-wide, must still arrive.
      roomIds: new Set(["22222222-2222-4222-8222-222222222222"]),
    });

    publishMaintenanceStatus(snap({ state: "applying", operationId: "op-apply" }));

    const ownerFrame = JSON.parse(ownerClient.sent.at(-1)!) as Record<string, unknown>;
    const peerFrame = JSON.parse(peerClient.sent.at(-1)!) as Record<string, unknown>;
    expect(ownerFrame).toMatchObject({ type: "maintenance.status", state: "applying" });
    expect(peerFrame).toMatchObject({ type: "maintenance.status", state: "applying" });
    // Payload-free: no work/job/prompt/user fields on the wire.
    const wire = JSON.stringify(ownerFrame);
    expect(wire).not.toContain("work");
    expect(wire).not.toContain("jobId");
    expect(wire).not.toContain("prompt");
  });
});

/**
 * Stub controller that returns scripted snapshots per op, so the wrapper's
 * broadcast-on-change + duplicate-suppression logic is deterministic without
 * a DB.
 */
interface ScriptedController extends MaintenanceControllerSeam {
  setNext(snapshot: MaintenanceSnapshot): void;
}

function makeScriptedController(initial: MaintenanceSnapshot): ScriptedController {
  let next = initial;
  return {
    setNext(snapshot) {
      next = snapshot;
    },
    async getState() {
      return next;
    },
    async enterDraining(_opts) {
      return next; // caller scripts the value via setNext
    },
    async transitionApplying(_operationId) {
      return next;
    },
    async renewLease(_operationId, _opts) {
      return next;
    },
    async complete(_operationId) {
      return next;
    },
    async cancel(_operationId) {
      return next;
    },
  };
}

describe("withMaintenanceStatusPublishing — broadcast on durable change", () => {
  test("first read broadcasts the initial snapshot", async () => {
    const ctrl = makeScriptedController(snap({ state: "normal", operationId: null, leaseExpiresAt: null, hardExpiresAt: null }));
    const publish = mock<MaintenanceStatusPublisher>(() => {});
    const wrapped = withMaintenanceStatusPublishing(ctrl, publish);

    await wrapped.getState();

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]![0]).toMatchObject({ state: "normal" });
  });

  test("enterDraining / transitionApplying / complete / cancel / renewLease each broadcast", async () => {
    const ctrl = makeScriptedController(
      snap({ state: "normal", operationId: null, leaseExpiresAt: null, hardExpiresAt: null }),
    );
    const publish = mock<MaintenanceStatusPublisher>(() => {});
    const wrapped = withMaintenanceStatusPublishing(ctrl, publish);

    // Prime last-known so the first mutation is a real change, not the
    // initial-seen broadcast.
    await wrapped.getState();
    publish.mockReset();

    ctrl.setNext(snap({ state: "draining", operationId: "op-1" }));
    await wrapped.enterDraining({ operationId: "op-1" });
    ctrl.setNext(snap({ state: "applying", operationId: "op-1" }));
    await wrapped.transitionApplying("op-1");
    // renewLease changes leaseExpiresAt → broadcast (lease is a public field).
    ctrl.setNext(
      snap({ state: "applying", operationId: "op-1", leaseExpiresAt: new Date("2026-07-14T12:06:30.000Z") }),
    );
    await wrapped.renewLease("op-1", {});
    ctrl.setNext(
      snap({ state: "normal", operationId: null, leaseExpiresAt: null, hardExpiresAt: null }),
    );
    await wrapped.complete("op-1");
    ctrl.setNext(snap({ state: "draining", operationId: "op-2" }));
    await wrapped.cancel("op-2");

    const states = publish.mock.calls.map((c) => c[0].state);
    expect(states).toEqual(["draining", "applying", "applying", "normal", "draining"]);
    // renewLease broadcast carried the moved lease expiry.
    const renewCall = publish.mock.calls[2]![0];
    expect(renewCall.leaseExpiresAt?.toISOString()).toBe("2026-07-14T12:06:30.000Z");
  });

  test("same-state reads are suppressed (no polling firehose)", async () => {
    const ctrl = makeScriptedController(
      snap({ state: "normal", operationId: null, leaseExpiresAt: null, hardExpiresAt: null }),
    );
    const publish = mock<MaintenanceStatusPublisher>(() => {});
    const wrapped = withMaintenanceStatusPublishing(ctrl, publish);

    await wrapped.getState(); // initial → 1 broadcast
    await wrapped.getState(); // same normal → suppressed
    await wrapped.getState(); // same normal → suppressed

    expect(publish).toHaveBeenCalledTimes(1);
  });

  test("expiry recovery observed on getState broadcasts the return to normal", async () => {
    // Boot into an abandoned applying lease; the wrapper's first getState
    // observes applying and broadcasts it.
    const ctrl = makeScriptedController(snap({ state: "applying", operationId: "op-dead" }));
    const publish = mock<MaintenanceStatusPublisher>(() => {});
    const wrapped = withMaintenanceStatusPublishing(ctrl, publish);

    await wrapped.getState();
    expect(publish.mock.calls[0]![0].state).toBe("applying");

    // The underlying controller auto-recovers on the next read (R10 hard
    // expiry). The wrapper observes the change and broadcasts `normal` —
    // the live expiry-recovery signal a connected client would otherwise miss.
    ctrl.setNext(
      snap({ state: "normal", operationId: null, leaseExpiresAt: null, hardExpiresAt: null }),
    );
    await wrapped.getState();
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1]![0].state).toBe("normal");
  });

  test("a refused mutation (throws) does not broadcast and does not update last-known", async () => {
    const throwing: MaintenanceControllerSeam = {
      async getState() {
        return snap({ state: "normal", operationId: null, leaseExpiresAt: null, hardExpiresAt: null });
      },
      async enterDraining() {
        throw new Error("in_progress");
      },
      async transitionApplying() {
        return snap({ state: "applying" });
      },
      async renewLease() {
        return snap({});
      },
      async complete() {
        return snap({ state: "normal", operationId: null, leaseExpiresAt: null, hardExpiresAt: null });
      },
      async cancel() {
        return snap({ state: "normal", operationId: null, leaseExpiresAt: null, hardExpiresAt: null });
      },
    };
    const publish = mock<MaintenanceStatusPublisher>(() => {});
    const wrapped = withMaintenanceStatusPublishing(throwing, publish);

    await wrapped.getState(); // initial normal → 1 broadcast
    publish.mockReset();

    let threw: unknown = null;
    try {
      await wrapped.enterDraining({});
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(Error);
    expect((threw as Error).message).toContain("in_progress");
    expect(publish).not.toHaveBeenCalled();
  });
});
