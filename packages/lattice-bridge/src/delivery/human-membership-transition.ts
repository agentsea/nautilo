import {
  nautiloActorId,
  productIdIsValid,
} from "../identity/product-ids.ts";
import { translateParticipants } from "../identity/participants.ts";

export type HumanMembershipTransitionKind = "human_add" | "human_remove";
export type HumanMembershipTargetRoomRole = "admin" | "member";

export interface HumanMembershipTransition {
  readonly formatVersion: 1;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly kind: HumanMembershipTransitionKind;
  readonly roomId: string;
  readonly namespaceId: string;
  readonly targetHumanActorId: string;
  readonly oldParticipants: readonly string[];
  readonly oldParticipantDigest: Uint8Array;
  readonly newParticipants: readonly string[];
  readonly newParticipantDigest: Uint8Array;
  readonly oldDomainId: string;
  readonly targetDomainId: string | null;
  readonly targetRoomRole: HumanMembershipTargetRoomRole | null;
  readonly expectedAccessRevision: number;
  readonly expectedBindingHash: Uint8Array;
  readonly bootstrapDeviceId: string | null;
}

const verifiedTransitions = new WeakMap<object, {
  readonly oldParticipantDigest: Uint8Array;
  readonly newParticipantDigest: Uint8Array;
  readonly expectedBindingHash: Uint8Array;
}>();
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

function portable(name: string, value: string): void {
  if (!PORTABLE_ID.test(value)) {
    throw new TypeError(`${name} must be a portable identifier`);
  }
}

function translateHumanSet(
  name: string,
  participants: readonly string[],
): {
  readonly participants: readonly string[];
  readonly digest: Uint8Array;
} {
  const actorIds = participants.map((id) => {
    const translated = nautiloActorId(id);
    if (!translated.ok) {
      throw new TypeError(`${name} is invalid: ${translated.error.message}`);
    }
    return translated.value;
  });
  const translated = translateParticipants(
    actorIds.map((id) => ({
      id,
      actorKind: "user" as const,
    })),
  );
  if (!translated.ok) {
    throw new TypeError(`${name} is invalid: ${translated.error.message}`);
  }
  return {
    participants: translated.value.participants,
    digest: translated.value.participantDigest,
  };
}

function hasOnlyTargetDifference(input: {
  readonly kind: HumanMembershipTransitionKind;
  readonly target: string;
  readonly oldParticipants: readonly string[];
  readonly newParticipants: readonly string[];
}): boolean {
  const oldSet = new Set(input.oldParticipants);
  const newSet = new Set(input.newParticipants);
  if (input.kind === "human_add") {
    return !oldSet.has(input.target)
      && newSet.has(input.target)
      && newSet.size === oldSet.size + 1
      && input.oldParticipants.every((participant) => newSet.has(participant));
  }
  return oldSet.has(input.target)
    && !newSet.has(input.target)
    && oldSet.size === newSet.size + 1
    && input.newParticipants.every((participant) => oldSet.has(participant));
}

export function createHumanMembershipTransition(input: {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly kind: HumanMembershipTransitionKind;
  readonly roomId: string;
  readonly namespaceId: string;
  readonly targetHumanActorId: string;
  readonly oldParticipants: readonly string[];
  readonly newParticipants: readonly string[];
  readonly oldDomainId: string;
  readonly targetDomainId: string | null;
  readonly targetRoomRole: HumanMembershipTargetRoomRole | null;
  readonly expectedAccessRevision: number;
  readonly expectedBindingHash: Uint8Array;
  readonly bootstrapDeviceId: string | null;
}): HumanMembershipTransition {
  portable("Membership operation ID", input.operationId);
  portable("Membership idempotency key", input.idempotencyKey);
  portable("Old Domain ID", input.oldDomainId);
  if (input.targetDomainId !== null) {
    portable("Target Domain ID", input.targetDomainId);
  }
  if (
    !productIdIsValid(input.roomId)
    || !productIdIsValid(input.namespaceId)
    || !productIdIsValid(input.targetHumanActorId)
  ) {
    throw new TypeError(
      "Membership Room, Namespace, and target Human must be canonical UUIDs",
    );
  }
  if (
    input.targetDomainId !== null
    && input.oldDomainId === input.targetDomainId
  ) {
    throw new TypeError(
      "Human membership must move to a different exact-Human-set Domain",
    );
  }
  if (
    !Number.isSafeInteger(input.expectedAccessRevision)
    || input.expectedAccessRevision < 0
  ) {
    throw new RangeError("Membership access revision is invalid");
  }
  if (input.expectedBindingHash.length !== 32) {
    throw new TypeError("Membership expected binding hash must be 32 bytes");
  }
  const oldSet = translateHumanSet("Old Human set", input.oldParticipants);
  const newSet = translateHumanSet("New Human set", input.newParticipants);
  if (!hasOnlyTargetDifference({
    kind: input.kind,
    target: input.targetHumanActorId,
    oldParticipants: oldSet.participants,
    newParticipants: newSet.participants,
  })) {
    throw new TypeError(
      "Human membership must add or remove exactly the target Human",
    );
  }
  if (input.kind === "human_add") {
    if (
      input.targetRoomRole !== "admin"
      && input.targetRoomRole !== "member"
    ) {
      throw new TypeError(
        "Human addition requires an admin or member target Room role",
      );
    }
    if (input.bootstrapDeviceId !== null) {
      portable("Membership bootstrap device ID", input.bootstrapDeviceId);
    }
  } else {
    if (input.targetRoomRole !== null) {
      throw new TypeError("Human removal cannot assign a Room role");
    }
    if (input.bootstrapDeviceId !== null) {
      throw new TypeError("Human removal cannot bind a bootstrap device");
    }
  }
  const transition = Object.freeze({
    formatVersion: 1 as const,
    operationId: input.operationId,
    idempotencyKey: input.idempotencyKey,
    kind: input.kind,
    roomId: input.roomId,
    namespaceId: input.namespaceId,
    targetHumanActorId: input.targetHumanActorId,
    oldParticipants: Object.freeze([...oldSet.participants]),
    oldParticipantDigest: Uint8Array.from(oldSet.digest),
    newParticipants: Object.freeze([...newSet.participants]),
    newParticipantDigest: Uint8Array.from(newSet.digest),
    oldDomainId: input.oldDomainId,
    targetDomainId: input.targetDomainId,
    targetRoomRole: input.targetRoomRole,
    expectedAccessRevision: input.expectedAccessRevision,
    expectedBindingHash: Uint8Array.from(input.expectedBindingHash),
    bootstrapDeviceId: input.bootstrapDeviceId,
  });
  verifiedTransitions.set(transition, {
    oldParticipantDigest: Uint8Array.from(transition.oldParticipantDigest),
    newParticipantDigest: Uint8Array.from(transition.newParticipantDigest),
    expectedBindingHash: Uint8Array.from(transition.expectedBindingHash),
  });
  return transition;
}

export function assertVerifiedHumanMembershipTransition(
  value: HumanMembershipTransition,
): void {
  const snapshot = verifiedTransitions.get(value);
  if (
    snapshot === undefined
    || !snapshot.oldParticipantDigest.every(
      (byte, index) => byte === value.oldParticipantDigest[index],
    )
    || snapshot.oldParticipantDigest.length
      !== value.oldParticipantDigest.length
    || !snapshot.newParticipantDigest.every(
      (byte, index) => byte === value.newParticipantDigest[index],
    )
    || snapshot.newParticipantDigest.length
      !== value.newParticipantDigest.length
    || !snapshot.expectedBindingHash.every(
      (byte, index) => byte === value.expectedBindingHash[index],
    )
    || snapshot.expectedBindingHash.length
      !== value.expectedBindingHash.length
  ) {
    throw new TypeError("Human membership transition is not verified");
  }
}
