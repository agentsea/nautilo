import { describe, expect, test } from "bun:test";
import { createHumanMembershipTransition } from "../../src/index.ts";
import {
  HumanMembershipAtomicCoordinator,
  type HumanMembershipAtomicPort,
} from "../../src/server/index.ts";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const CHARLIE = "33333333-3333-4333-8333-333333333333";
const ROOM = "44444444-4444-4444-8444-444444444444";
const NAMESPACE = "55555555-5555-4555-8555-555555555555";

type State = {
  roomHumans: Set<string>;
  cryptoState: "idle" | "removal_admitted" | "active";
};

type Transaction = {
  state: State;
  calls: string[];
};

function cloneState(state: State): State {
  return {
    roomHumans: new Set(state.roomHumans),
    cryptoState: state.cryptoState,
  };
}

async function captureError(action: Promise<unknown>): Promise<Error> {
  try {
    await action;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("Expected action to reject");
}

function harness(input: {
  state?: State;
  failRoomAdd?: boolean;
  failRoomRemove?: boolean;
  activationStatus?: "activated" | "duplicate" | "not_ready" | "stale_state";
  activationRoomId?: string;
}) {
  const state = input.state ?? {
    roomHumans: new Set([ALICE, BOB]),
    cryptoState: "idle",
  };
  const committedCalls: string[] = [];
  const port: HumanMembershipAtomicPort<Transaction> = {
    async transaction(callback) {
      const tx = { state: cloneState(state), calls: [] };
      const result = await callback(tx);
      state.roomHumans = tx.state.roomHumans;
      state.cryptoState = tx.state.cryptoState;
      committedCalls.push(...tx.calls);
      return result;
    },
    lockRoomInTx(tx, roomId) {
      tx.calls.push(`lock:${roomId}`);
      return Promise.resolve();
    },
    admitRemovalCryptoInTx(tx) {
      tx.calls.push("crypto:admit_remove");
      tx.state.cryptoState = "removal_admitted";
      return Promise.resolve({
        status: "admitted" as const,
        state: "preparing_domain" as const,
      });
    },
    activateCryptoInTx(tx, request) {
      tx.calls.push("crypto:activate");
      const duplicate = tx.state.cryptoState === "active";
      const status = input.activationStatus
        ?? (duplicate ? "duplicate" : "activated");
      if (status === "not_ready" || status === "stale_state") {
        return Promise.resolve({ status });
      }
      tx.state.cryptoState = "active";
      return Promise.resolve({
        status,
        kind: request.kind,
        roomId: input.activationRoomId ?? ROOM,
        targetHumanActorId: request.kind === "human_add" ? CHARLIE : BOB,
        targetRoomRole: request.kind === "human_add" ? "member" as const : null,
        namespaceId: NAMESPACE,
        accessRevision: 8,
      });
    },
    addHumanToRoomInTx(tx, request) {
      tx.calls.push("room:add");
      if (input.failRoomAdd) throw new Error("room add failed");
      tx.state.roomHumans.add(request.targetHumanActorId);
      return Promise.resolve();
    },
    removeHumanFromRoomInTx(tx, request) {
      tx.calls.push("room:remove");
      if (input.failRoomRemove) throw new Error("room remove failed");
      tx.state.roomHumans.delete(request.targetHumanActorId);
      return Promise.resolve();
    },
    assertHumanRoomStateInTx(tx, request) {
      tx.calls.push(`room:assert:${request.present}`);
      const present = tx.state.roomHumans.has(request.targetHumanActorId);
      if (present !== request.present) throw new Error("Room state mismatch");
      return Promise.resolve();
    },
  };
  return {
    state,
    committedCalls,
    coordinator: new HumanMembershipAtomicCoordinator(port),
  };
}

function removalTransition() {
  return createHumanMembershipTransition({
    operationId: "membership_remove_bob",
    idempotencyKey: "membership/remove-bob",
    kind: "human_remove",
    roomId: ROOM,
    namespaceId: NAMESPACE,
    targetHumanActorId: BOB,
    oldParticipants: [ALICE, BOB],
    newParticipants: [ALICE],
    oldDomainId: "domain_alice_bob",
    targetDomainId: null,
    targetRoomRole: null,
    expectedAccessRevision: 7,
    expectedBindingHash: new Uint8Array(32).fill(0x31),
    bootstrapDeviceId: null,
  });
}

describe("atomic Human membership coordinator", () => {
  test("admits crypto removal and revokes Room access in one transaction", async () => {
    const setup = harness({});
    expect(
      await setup.coordinator.admitRemoval({
        transition: removalTransition(),
        requestedAt: 1_000,
      }),
    ).toEqual({ status: "admitted", state: "preparing_domain" });
    expect(setup.state.cryptoState).toBe("removal_admitted");
    expect(setup.state.roomHumans.has(BOB)).toBe(false);
    expect(setup.committedCalls).toEqual([
      `lock:${ROOM}`,
      "crypto:admit_remove",
      "room:remove",
    ]);
  });

  test("rolls crypto admission back when Room removal fails", async () => {
    const setup = harness({ failRoomRemove: true });
    expect(await captureError(
      setup.coordinator.admitRemoval({
        transition: removalTransition(),
        requestedAt: 1_000,
      }),
    )).toHaveProperty("message", "room remove failed");
    expect(setup.state.cryptoState).toBe("idle");
    expect(setup.state.roomHumans.has(BOB)).toBe(true);
    expect(setup.committedCalls).toEqual([]);
  });

  test("activates crypto before adding a Human and rolls both back together", async () => {
    const setup = harness({});
    const request = {
      operationId: "membership_add_charlie",
      kind: "human_add" as const,
      roomId: ROOM,
      activatedAt: 2_000,
      auditRef: "audit_membership_add",
      outboxId: "outbox_membership_add",
    };
    expect(await setup.coordinator.activate(request)).toEqual({
      status: "activated",
      kind: "human_add",
      roomId: ROOM,
      targetHumanActorId: CHARLIE,
      targetRoomRole: "member",
      namespaceId: NAMESPACE,
      accessRevision: 8,
    });
    expect(setup.state.cryptoState).toBe("active");
    expect(setup.state.roomHumans.has(CHARLIE)).toBe(true);
    expect(setup.committedCalls).toEqual([
      `lock:${ROOM}`,
      "crypto:activate",
      "room:add",
    ]);

    const failing = harness({ failRoomAdd: true });
    expect(await captureError(failing.coordinator.activate(request)))
      .toHaveProperty("message", "room add failed");
    expect(failing.state.cryptoState).toBe("idle");
    expect(failing.state.roomHumans.has(CHARLIE)).toBe(false);
  });

  test("does not repeat product mutation for an exact crypto replay", async () => {
    const setup = harness({
      state: {
        roomHumans: new Set([ALICE, BOB, CHARLIE]),
        cryptoState: "active",
      },
    });
    const original = setup.coordinator;
    const result = await original.activate({
      operationId: "membership_add_charlie",
      kind: "human_add",
      roomId: ROOM,
      activatedAt: 2_000,
      auditRef: "audit_membership_add",
      outboxId: "outbox_membership_add",
    });
    expect(result.status).toBe("duplicate");
    expect(setup.committedCalls).toEqual([
      `lock:${ROOM}`,
      "crypto:activate",
      "room:assert:true",
    ]);
  });

  test("keeps not-ready activation free of product mutations", async () => {
    const setup = harness({ activationStatus: "not_ready" });
    expect(await setup.coordinator.activate({
      operationId: "membership_add_charlie",
      kind: "human_add",
      roomId: ROOM,
      activatedAt: 2_000,
      auditRef: "audit_membership_add",
      outboxId: "outbox_membership_add",
    })).toEqual({ status: "not_ready" });
    expect(setup.state.cryptoState).toBe("idle");
    expect(setup.state.roomHumans.has(CHARLIE)).toBe(false);
    expect(setup.committedCalls).toEqual([
      `lock:${ROOM}`,
      "crypto:activate",
    ]);
  });

  test("rolls back when locked and authoritative Room coordinates differ", async () => {
    const setup = harness({
      activationRoomId: "66666666-6666-4666-8666-666666666666",
    });
    expect(await captureError(setup.coordinator.activate({
      operationId: "membership_add_charlie",
      kind: "human_add",
      roomId: ROOM,
      activatedAt: 2_000,
      auditRef: "audit_membership_add",
      outboxId: "outbox_membership_add",
    }))).toHaveProperty(
      "message",
      "Human membership activation coordinates changed after Room lock",
    );
    expect(setup.state.cryptoState).toBe("idle");
    expect(setup.state.roomHumans.has(CHARLIE)).toBe(false);
  });

  test("requires removal activation to observe the earlier Room revocation", async () => {
    const setup = harness({
      state: {
        roomHumans: new Set([ALICE]),
        cryptoState: "removal_admitted",
      },
    });
    expect(await setup.coordinator.activate({
      operationId: "membership_remove_bob",
      kind: "human_remove",
      roomId: ROOM,
      activatedAt: 2_000,
      auditRef: "audit_membership_remove",
      outboxId: "outbox_membership_remove",
    })).toMatchObject({
      status: "activated",
      kind: "human_remove",
      targetHumanActorId: BOB,
    });
    expect(setup.committedCalls).toEqual([
      `lock:${ROOM}`,
      "crypto:activate",
      "room:assert:false",
    ]);
  });
});
