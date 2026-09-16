import { describe, expect, test } from "bun:test";
import {
  exactHumanSetsMatch,
  nautiloActorId,
  nautiloDeviceId,
  nautiloGroupId,
  nautiloNamespaceId,
  nautiloRoomId,
  nautiloUserId,
  translateHumanParticipant,
  translateNamespaceDomainCoordinates,
  translateNamespaceId,
  translateParticipants,
  type NautiloActorId,
  type TranslationResult,
} from "../../src/index.ts";

const ALICE = "00000000-0000-4000-8000-00000000000a";
const BOB = "00000000-0000-4000-8000-00000000000b";
const CAROL = "00000000-0000-4000-8000-00000000000c";
const NAMESPACE = "10000000-0000-4000-8000-000000000001";

function valueOf<T>(result: TranslationResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("Nautilo product IDs", () => {
  test.each([
    ["Actor", nautiloActorId],
    ["User", nautiloUserId],
    ["Room", nautiloRoomId],
    ["Group", nautiloGroupId],
    ["Device", nautiloDeviceId],
    ["Namespace", nautiloNamespaceId],
  ] as const)("brands a canonical %s UUID without changing it", (_, parse) => {
    const result = parse(ALICE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(String(result.value)).toBe(ALICE);
  });

  test.each([
    "",
    "alice",
    " 00000000-0000-4000-8000-00000000000a",
    "00000000-0000-4000-8000-00000000000A",
    "00000000-0000-4000-8000-00000000000a ",
    "0000000000004000800000000000000a",
  ])("rejects malformed or noncanonical product ID %p", (input) => {
    expect(nautiloActorId(input)).toMatchObject({
      ok: false,
      error: { code: "invalid_product_id", value: input },
    });
  });
});

describe("Human Actor translation", () => {
  test("accepts an Actor row explicitly identified with actorKind user", () => {
    const id = valueOf(nautiloActorId(ALICE));
    const result = translateHumanParticipant({ id, actorKind: "user" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(String(result.value)).toBe(ALICE);
  });

  test.each([
    {
      fact: {
        id: valueOf(nautiloActorId(ALICE)),
        actorKind: "agent" as const,
      },
      entityKind: "agent-actor",
    },
    {
      fact: { id: valueOf(nautiloUserId(ALICE)), entityKind: "user" as const },
      entityKind: "user",
    },
    {
      fact: { id: valueOf(nautiloRoomId(ALICE)), entityKind: "room" as const },
      entityKind: "room",
    },
    {
      fact: { id: valueOf(nautiloGroupId(ALICE)), entityKind: "group" as const },
      entityKind: "group",
    },
    {
      fact: {
        id: valueOf(nautiloDeviceId(ALICE)),
        entityKind: "device" as const,
      },
      entityKind: "device",
    },
    {
      fact: {
        id: valueOf(nautiloNamespaceId(NAMESPACE)),
        entityKind: "namespace" as const,
      },
      entityKind: "namespace",
    },
  ])("rejects $entityKind as a Human Actor", ({ fact, entityKind }) => {
    expect(translateHumanParticipant(fact)).toMatchObject({
      ok: false,
      error: { code: "not_human_actor", entityKind },
    });
  });

  test("rejects the virtual cosmos marker as a participant", () => {
    expect(
      translateHumanParticipant({ entityKind: "cosmos" }),
    ).toMatchObject({
      ok: false,
      error: { code: "cosmos_not_human", entityKind: "cosmos" },
    });
  });

  test("revalidates a forged brand at the translation boundary", () => {
    expect(
      translateHumanParticipant({
        id: "not-a-uuid" as NautiloActorId,
        actorKind: "user",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_product_id", entityKind: "human-actor" },
    });
  });

  test.each([
    null,
    {},
    { id: ALICE },
    { id: ALICE, actorKind: "human" },
    { id: ALICE, actorKind: "user", entityKind: "user" },
    { entityKind: "cosmos", id: ALICE },
  ])("fails closed for malformed identity fact %p", (fact) => {
    expect(
      translateHumanParticipant(fact as never),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_identity_fact" },
    });
  });
});

describe("exact Human participant sets", () => {
  const human = (id: string) => ({
    id: valueOf(nautiloActorId(id)),
    actorKind: "user" as const,
  });

  test("sorts using the crypto canonical ordering and preserves exact IDs", () => {
    const result = translateParticipants([human(CAROL), human(ALICE), human(BOB)]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.participants.map(String)).toEqual([ALICE, BOB, CAROL]);
    expect(result.value.participantDigest).toBeInstanceOf(Uint8Array);
    expect(result.value.participantDigest).toHaveLength(32);
  });

  test("rejects empty and duplicate sets but accepts populated public rooms", () => {
    expect(translateParticipants(null as never)).toMatchObject({
      ok: false,
      error: { code: "invalid_participant_set" },
    });
    expect(translateParticipants([])).toMatchObject({
      ok: false,
      error: { code: "empty_participant_set" },
    });
    expect(translateParticipants([human(ALICE), human(ALICE)])).toMatchObject({
      ok: false,
      error: { code: "duplicate_participant" },
    });
    const publicRoom = Array.from(
      { length: 500 },
      (_, index) =>
        human(`00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`),
    );
    const translated = translateParticipants(publicRoom);
    expect(translated.ok).toBe(true);
    if (!translated.ok) return;
    expect(translated.value.participants).toHaveLength(500);
    expect(translated.value.participantDigest).toHaveLength(32);
  });

  test("never treats digest equality as exact-participant equality", () => {
    const ab = valueOf(translateParticipants([human(ALICE), human(BOB)]));
    const ac = valueOf(translateParticipants([human(ALICE), human(CAROL)]));
    const substituted = {
      participants: ac.participants,
      participantDigest: ab.participantDigest,
    };
    expect(exactHumanSetsMatch(ab, substituted)).toBe(false);
  });

  test("preserves Namespace identity and supplies coordinates, not a Domain ID", () => {
    const namespace = valueOf(nautiloNamespaceId(NAMESPACE));
    const translatedNamespace = translateNamespaceId(namespace);
    expect(translatedNamespace.ok).toBe(true);
    if (!translatedNamespace.ok) return;
    expect(String(translatedNamespace.value)).toBe(NAMESPACE);
    const coordinates = valueOf(
      translateNamespaceDomainCoordinates({
        namespaceId: namespace,
        participants: [human(BOB), human(ALICE)],
      }),
    );
    expect(String(coordinates.productNamespaceId)).toBe(NAMESPACE);
    expect(String(coordinates.namespaceId)).toBe(NAMESPACE);
    expect(coordinates.exactHumanSet.participants.map(String)).toEqual([
      ALICE,
      BOB,
    ]);
    expect("domainId" in coordinates).toBe(false);
  });

  test("recognizes shared exact-Human-set coordinates across Namespaces", () => {
    const first = valueOf(
      translateNamespaceDomainCoordinates({
        namespaceId: valueOf(nautiloNamespaceId(NAMESPACE)),
        participants: [human(ALICE), human(BOB)],
      }),
    );
    const second = valueOf(
      translateNamespaceDomainCoordinates({
        namespaceId: valueOf(
          nautiloNamespaceId("10000000-0000-4000-8000-000000000002"),
        ),
        participants: [human(BOB), human(ALICE)],
      }),
    );
    expect(first.namespaceId).not.toBe(second.namespaceId);
    expect(
      exactHumanSetsMatch(first.exactHumanSet, second.exactHumanSet),
    ).toBe(true);
  });

  test.each([
    null,
    {},
    { namespaceId: NAMESPACE },
    { namespaceId: NAMESPACE, participants: [], extra: true },
  ])("fails closed for malformed Namespace Domain input %p", (input) => {
    expect(
      translateNamespaceDomainCoordinates(input as never),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_namespace_domain_input" },
    });
  });
});
