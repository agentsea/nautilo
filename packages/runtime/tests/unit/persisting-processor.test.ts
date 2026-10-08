import { expect, test } from "bun:test";
import { createPersistingProcessor } from "../../src/executors/persisting-processor";

test("Room processor exposes a foreground rebuild callback", () => {
  const processor = createPersistingProcessor({
    threadId: "thread-1",
    ownerId: "owner-1",
    agentId: "agent-1",
    roomId: "room-1",
    laneKey: "room:room-1:bot:agent-1",
    eventBus: { emit() {} },
  });

  expect(typeof processor.rebuildForegroundContext).toBe("function");
});

test("background processor does not advertise foreground rebuilding", () => {
  const processor = createPersistingProcessor({
    threadId: "task-thread",
    ownerId: "owner-1",
    laneKey: "task-lane",
    eventBus: { emit() {} },
  });

  expect("rebuildForegroundContext" in processor).toBe(false);
});
