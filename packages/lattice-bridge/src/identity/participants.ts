import {
  canonicalizeParticipants,
  humanId,
  participantDigest,
  type HumanId,
} from "@nautilo/lattice-crypto";
import {
  productIdIsValid,
  type NautiloActorId,
  type NautiloDeviceId,
  type NautiloGroupId,
  type NautiloNamespaceId,
  type NautiloRoomId,
  type NautiloUserId,
  type TranslationFailure,
  type TranslationResult,
} from "./product-ids.ts";

export interface HumanActorFact {
  readonly id: NautiloActorId;
  readonly actorKind: "user";
}

export interface AgentActorFact {
  readonly id: NautiloActorId;
  readonly actorKind: "agent";
}

export interface UserIdentityFact {
  readonly id: NautiloUserId;
  readonly entityKind: "user";
}

export interface RoomIdentityFact {
  readonly id: NautiloRoomId;
  readonly entityKind: "room";
}

export interface GroupIdentityFact {
  readonly id: NautiloGroupId;
  readonly entityKind: "group";
}

export interface DeviceIdentityFact {
  readonly id: NautiloDeviceId;
  readonly entityKind: "device";
}

export interface NamespaceIdentityFact {
  readonly id: NautiloNamespaceId;
  readonly entityKind: "namespace";
}

export interface CosmosIdentityFact {
  readonly entityKind: "cosmos";
}

export type ProductParticipantFact =
  | HumanActorFact
  | AgentActorFact
  | UserIdentityFact
  | RoomIdentityFact
  | GroupIdentityFact
  | DeviceIdentityFact
  | NamespaceIdentityFact
  | CosmosIdentityFact;

export interface ExactHumanSet {
  readonly participants: readonly HumanId[];
  readonly participantDigest: Uint8Array;
}

function failure(error: TranslationFailure): TranslationResult<never> {
  return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length
    && actual.every((key) => keys.includes(key));
}

function participantFactIsValid(
  value: unknown,
): value is ProductParticipantFact {
  if (!isRecord(value)) return false;
  if (
    value["entityKind"] === "cosmos"
    && hasExactKeys(value, ["entityKind"])
  ) {
    return true;
  }
  if (
    (value["actorKind"] === "user" || value["actorKind"] === "agent")
    && hasExactKeys(value, ["id", "actorKind"])
  ) {
    return true;
  }
  return (
    value["entityKind"] === "user"
    || value["entityKind"] === "room"
    || value["entityKind"] === "group"
    || value["entityKind"] === "device"
    || value["entityKind"] === "namespace"
  ) && hasExactKeys(value, ["id", "entityKind"]);
}

function participantEntityKind(fact: ProductParticipantFact): string {
  if ("actorKind" in fact) {
    return fact.actorKind === "user" ? "human-actor" : "agent-actor";
  }
  return fact.entityKind;
}

function translateHumanParticipantValue(
  fact: unknown,
): TranslationResult<HumanId> {
  if (!participantFactIsValid(fact)) {
    return failure({
      code: "invalid_identity_fact",
      message: "A participant must be one exact, explicitly typed product fact",
      value: fact,
    });
  }
  const entityKind = participantEntityKind(fact);
  if (!("id" in fact)) {
    return failure({
      code: "cosmos_not_human",
      message: "The virtual cosmos marker cannot be a Crypto Domain participant",
      entityKind,
    });
  }
  if (!productIdIsValid(fact.id)) {
    return failure({
      code: "invalid_product_id",
      message: "A participant ID must be a canonical lowercase UUID",
      entityKind,
      value: fact.id,
    });
  }
  if (!("actorKind" in fact) || fact.actorKind !== "user") {
    return failure({
      code: "not_human_actor",
      message: `${entityKind} is not a Nautilo Human Actor`,
      entityKind,
    });
  }
  return { ok: true, value: humanId(fact.id) };
}

export function translateHumanParticipant(
  fact: ProductParticipantFact,
): TranslationResult<HumanId> {
  return translateHumanParticipantValue(fact);
}

export function translateParticipants(
  facts: readonly ProductParticipantFact[],
): TranslationResult<ExactHumanSet>;
export function translateParticipants(
  facts: unknown,
): TranslationResult<ExactHumanSet> {
  if (!Array.isArray(facts)) {
    return failure({
      code: "invalid_participant_set",
      message: "Crypto Domain participants must be an array of product facts",
      value: facts,
    });
  }
  if (facts.length === 0) {
    return failure({
      code: "empty_participant_set",
      message: "A Crypto Domain requires at least one Human Actor",
    });
  }
  const translated: HumanId[] = [];
  for (const [inputIndex, fact] of (facts as readonly unknown[]).entries()) {
    const result = translateHumanParticipantValue(fact);
    if (!result.ok) {
      return failure({ ...result.error, inputIndex });
    }
    translated.push(result.value);
  }

  const seen = new Set<string>();
  for (const participant of translated) {
    if (seen.has(participant)) {
      return failure({
        code: "duplicate_participant",
        message: "A Crypto Domain Human set cannot contain duplicate Actors",
        value: participant,
      });
    }
    seen.add(participant);
  }

  const participants = canonicalizeParticipants(translated);
  return {
    ok: true,
    value: {
      participants,
      participantDigest: participantDigest(participants),
    },
  };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

/**
 * Digest equality is only a quick rejection. Exact canonical participants are
 * always compared before two product scopes may share a Crypto Domain.
 */
export function exactHumanSetsMatch(
  left: ExactHumanSet,
  right: ExactHumanSet,
): boolean {
  return equalBytes(left.participantDigest, right.participantDigest)
    && left.participants.length === right.participants.length
    && left.participants.every(
      (participant, index) => participant === right.participants[index],
    );
}
