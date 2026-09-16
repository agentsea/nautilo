import { describe, expect, test } from "bun:test";
import {
  assertVerifiedHumanMembershipTransition,
  createHumanMembershipTransition,
  type HumanMembershipTransition,
} from "../../src/index.ts";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const CHARLIE = "33333333-3333-4333-8333-333333333333";
const ROOM = "44444444-4444-4444-8444-444444444444";
const NAMESPACE = "55555555-5555-4555-8555-555555555555";

function transition(
  overrides: Partial<Parameters<typeof createHumanMembershipTransition>[0]> =
    {},
): HumanMembershipTransition {
  return createHumanMembershipTransition({
    operationId: "membership_operation_1",
    idempotencyKey: "membership/request-1",
    kind: "human_add",
    roomId: ROOM,
    namespaceId: NAMESPACE,
    targetHumanActorId: CHARLIE,
    oldParticipants: [BOB, ALICE],
    newParticipants: [CHARLIE, ALICE, BOB],
    oldDomainId: "domain_alice_bob",
    targetDomainId: "domain_alice_bob_charlie",
    targetRoomRole: "member",
    expectedAccessRevision: 7,
    expectedBindingHash: new Uint8Array(32).fill(0x31),
    bootstrapDeviceId: "device_charlie_browser",
    ...overrides,
  });
}

describe("Human membership transition", () => {
  test("canonicalizes an exact one-Human add and binds its bootstrap device", () => {
    const value = transition();
    expect(value.oldParticipants).toEqual([ALICE, BOB]);
    expect(value.newParticipants).toEqual([ALICE, BOB, CHARLIE]);
    expect(value.oldParticipantDigest).toHaveLength(32);
    expect(value.newParticipantDigest).toHaveLength(32);
    expect(value.bootstrapDeviceId).toBe("device_charlie_browser");
    expect(value.targetRoomRole).toBe("member");
    expect(() => assertVerifiedHumanMembershipTransition(value)).not.toThrow();
  });

  test("permits unresolved target Domains for additions and removals", () => {
    const unresolved = transition({
      targetDomainId: null,
      bootstrapDeviceId: null,
    });
    expect(unresolved.targetDomainId).toBeNull();
    expect(unresolved.bootstrapDeviceId).toBeNull();
    expect(() => assertVerifiedHumanMembershipTransition(unresolved))
      .not.toThrow();

    const removal = transition({
      kind: "human_remove",
      targetHumanActorId: BOB,
      oldParticipants: [ALICE, BOB, CHARLIE],
      newParticipants: [ALICE, CHARLIE],
      targetDomainId: null,
      targetRoomRole: null,
      bootstrapDeviceId: null,
    });
    expect(removal.targetDomainId).toBeNull();
    expect(() => assertVerifiedHumanMembershipTransition(removal))
      .not.toThrow();
  });

  test("binds additions to a Room role and forbids one on removals", () => {
    expect(transition({ targetRoomRole: "admin" }).targetRoomRole)
      .toBe("admin");
    expect(() => transition({ targetRoomRole: null }))
      .toThrow("Room role");
    expect(() => transition({
      targetRoomRole: "owner" as "member",
    })).toThrow("Room role");
    expect(() => transition({
      kind: "human_remove",
      targetHumanActorId: BOB,
      oldParticipants: [ALICE, BOB, CHARLIE],
      newParticipants: [ALICE, CHARLIE],
      oldDomainId: "domain_alice_bob_charlie",
      targetDomainId: "domain_alice_charlie",
      targetRoomRole: "member",
      bootstrapDeviceId: null,
    })).toThrow("cannot assign a Room role");
  });

  test("requires remove to delete exactly the target and forbids a bootstrap device", () => {
    const value = transition({
      kind: "human_remove",
      targetHumanActorId: BOB,
      oldParticipants: [ALICE, BOB, CHARLIE],
      newParticipants: [ALICE, CHARLIE],
      oldDomainId: "domain_alice_bob_charlie",
      targetDomainId: "domain_alice_charlie",
      targetRoomRole: null,
      bootstrapDeviceId: null,
    });
    expect(value.newParticipants).toEqual([ALICE, CHARLIE]);
    expect(() => assertVerifiedHumanMembershipTransition(value)).not.toThrow();
  });

  test("rejects substitutions, multiple-set changes, and verification look-alikes", () => {
    expect(() => transition({
      newParticipants: [ALICE, CHARLIE],
    })).toThrow("exactly the target Human");
    expect(() => transition({
      oldDomainId: "domain_same",
      targetDomainId: "domain_same",
    })).toThrow("different exact-Human-set Domain");
    expect(() => transition({
      expectedBindingHash: new Uint8Array(31),
    })).toThrow("binding hash");
    expect(() =>
      assertVerifiedHumanMembershipTransition(structuredClone(transition()))
    ).toThrow("not verified");
    const mutated = transition();
    mutated.expectedBindingHash[0] =
      mutated.expectedBindingHash[0]! ^ 1;
    expect(() => assertVerifiedHumanMembershipTransition(mutated))
      .toThrow("not verified");
  });
});
