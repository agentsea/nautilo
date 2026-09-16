import { describe, expect, test } from "bun:test";
import type { EventFeedRecordInput } from "@nautilo/types";
import { createArtifactEventProducer, type ArtifactEventProducerDeps } from "../../src/event-feed/artifact-producer";

function fixture(overrides: Partial<ArtifactEventProducerDeps> = {}) {
  const recorded: EventFeedRecordInput[] = [];
  const producer = createArtifactEventProducer({
    feed: { recordBestEffort: async input => { recorded.push(input); return { status: "skipped", code: "empty_audience" }; } },
    resolveAuthor: async actor => ({ actorId: actor.kind === "agent" ? "actor-genie" : "actor-a", kind: actor.kind, userId: "a" }),
    resolvePeople: async ids => ids.map(id => id.replace("actor-", "")),
    resolveCreationRoom: async () => "destination-room",
    listHumanUserIdsInRoom: async () => ["a", "b", "c", "c"],
    ...overrides,
  });
  return { producer, recorded };
}
const people = {
  operationId: "operation", artifactId: "artifact-uuid",
  requester: { kind: "human" as const, actorId: "actor-a", userId: "a" },
  target: { kind: "people" as const, personActorIds: ["actor-c"] },
};

describe("Artifact feed projection", () => {
  test("A+B sharing to C records only the explicit person, without a Room or union", async () => {
    const { producer, recorded } = fixture();
    await producer.shared(people);
    expect(recorded).toEqual([{
      key: "operation:artifact.shared:artifact-uuid:person:c", type: "artifact.shared",
      actorId: "actor-a", actorKind: "human", recipientUserIds: ["c"],
      data: { artifactId: "artifact-uuid", destination: { kind: "person", userId: "c" } },
    }]);
  });
  test("multiple selected people each get a private event; Human author is excluded", async () => {
    const { producer, recorded } = fixture();
    await producer.shared({ ...people, target: { kind: "people", personActorIds: ["actor-a", "actor-b", "actor-c", "actor-c"] } });
    expect(recorded.map(event => event.recipientUserIds)).toEqual([["b"], ["c"]]);
  });
  test("Agent sharing includes its owner and Room sharing uses actual members", async () => {
    const { producer, recorded } = fixture();
    await producer.shared({ ...people, requester: { ...people.requester, kind: "agent", agentId: "genie" }, target: { kind: "room", roomId: "target" } });
    expect(recorded[0]).toMatchObject({ actorId: "actor-genie", actorKind: "agent", recipientUserIds: ["a", "b", "c"],
      data: { artifactId: "artifact-uuid", destination: { kind: "room", roomId: "target" } } });
    expect(recorded).toHaveLength(1);
  });
  test("Agent person shares retain the Agent author and include its Human owner; missing Agent never substitutes the Human", async () => {
    const effect = { ...people, requester: { ...people.requester, kind: "agent" as const, agentId: "genie" },
      target: { kind: "people" as const, personActorIds: ["actor-a"] } };
    const { producer, recorded } = fixture();
    await producer.shared(effect);
    expect(recorded[0]).toMatchObject({ actorId: "actor-genie", actorKind: "agent", recipientUserIds: ["a"] });
    const missing = fixture({ resolveAuthor: async () => null });
    await missing.producer.shared(effect);
    expect(missing.recorded).toEqual([]);
  });
  test("creation uses stable internal ID and excludes Human author but not Agent owner", async () => {
    const { producer, recorded } = fixture();
    const base = { artifactInternalId: "id", namespaceId: "namespace", occurrenceKey: "create:id" };
    await producer.created({ ...base, actor: { kind: "human", userId: "a" } });
    await producer.created({ ...base, actor: { kind: "agent", agentId: "genie" } });
    expect(recorded.map(event => event.recipientUserIds)).toEqual([["b", "c"], ["a", "b", "c"]]);
    expect(recorded[0]?.data).toEqual({ artifactId: "id", roomId: "destination-room" });
  });
  test("missing author/Room and failing audience, store or diagnostics never reject business success", async () => {
    for (const override of [
      { resolveAuthor: async () => null },
      { resolveCreationRoom: async () => null },
      { listHumanUserIdsInRoom: async () => { throw new Error("lookup"); } },
      { feed: { recordBestEffort: async () => { throw new Error("store"); } } },
    ] satisfies Partial<ArtifactEventProducerDeps>[]) {
      const { producer, recorded } = fixture({ ...override, warn: () => { throw new Error("logger"); } });
      await producer.created({ artifactInternalId: "id", namespaceId: "namespace", occurrenceKey: "create:id", actor: { kind: "human", userId: "a" } });
      expect(recorded).toHaveLength(0);
    }
  });
});
