import {
  EncryptedCheckpointSaver,
  InlineCheckpointCellSerializer,
} from "@nautilo/agent";

export function createDormantEncryptedCheckpointSaverForTests(
  logicalThreadId = "room:room-1:bot:agent-1",
): EncryptedCheckpointSaver {
  const serializer = new InlineCheckpointCellSerializer();
  return new EncryptedCheckpointSaver({
    operationStoreFactory: {
      serializer,
      schema: "langchain",
      create: () => {
        throw new Error("checkpoint operation is outside this wiring test");
      },
      end: () => Promise.resolve(),
    },
    crypto: {} as never,
    scope: {
      logicalThreadId,
      namespaceId: "namespace-test-shadow",
      keyClass: "ai",
      expectedAccessRevision: 1,
      expectedPolicyRevision: 1,
      authorizationSession: Object.freeze({ id: "session-test" }),
    },
  });
}
