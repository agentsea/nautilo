import { describe, expect, test } from "bun:test";
import { createConversationNavigationController } from "../../src/components/conversation-navigation";
import { createRoomMessageRouteIntentConsumer } from "../../src/routes/room-route";

function controlledPromise<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("cross-chat result navigation", () => {
  test("consumes a loaded target once and delegates focus-free landing to D430", async () => {
    const replaced: string[] = [];
    const focused: boolean[] = [];
    const completed: number[] = [];
    const consumer = createRoomMessageRouteIntentConsumer();
    const controller = createConversationNavigationController({
      getActiveRoomId: () => "room-a",
      materializeById: () => true,
      loadHistoryAround: async () => {
        throw new Error("loaded targets must not hydrate history");
      },
      waitForCommit: async () => {},
      scrollAndFocus: async (_messageId, focusTarget) => {
        focused.push(focusTarget);
        return true;
      },
      onState: () => {},
      onCompleted: (messageId) => completed.push(messageId),
    });
    const args = {
      locationKey: "first-selection",
      pathname: "/rooms/room-a",
      search: "?messageId=42",
      activeRoomId: "room-a",
      replaceRoute: (path: string) => replaced.push(path),
      jumpToMessage: controller.jumpToMessage,
    };

    await expect(consumer.consume(args)).resolves.toBe("consumed");
    await expect(consumer.consume(args)).resolves.toBe("already-consumed");

    expect(replaced).toEqual(["/rooms/room-a"]);
    expect(focused).toEqual([false]);
    expect(completed).toEqual([42]);
  });

  test("hydrates an unloaded target through the existing around loader", async () => {
    const materializations: string[] = [];
    const hydrated: string[] = [];
    const consumer = createRoomMessageRouteIntentConsumer();
    const controller = createConversationNavigationController({
      getActiveRoomId: () => "room-b",
      materializeById: (messageId) => {
        materializations.push(messageId);
        return materializations.length > 1;
      },
      loadHistoryAround: async (messageId) => {
        hydrated.push(messageId);
        return true;
      },
      waitForCommit: async () => {},
      scrollAndFocus: async () => true,
      onState: () => {},
      onCompleted: () => {},
    });

    await expect(consumer.consume({
      locationKey: "unloaded",
      pathname: "/rooms/room-b",
      search: "?messageId=73",
      activeRoomId: "room-b",
      replaceRoute: () => {},
      jumpToMessage: controller.jumpToMessage,
    })).resolves.toBe("consumed");

    expect(hydrated).toEqual(["73"]);
    expect(materializations).toEqual(["73", "73"]);
  });

  test("defers until the route Room is active and supports same-Room reselection", async () => {
    const jumped: number[] = [];
    const replaced: string[] = [];
    const consumer = createRoomMessageRouteIntentConsumer();
    const base = {
      pathname: "/rooms/room-a",
      search: "?messageId=9",
      replaceRoute: (path: string) => replaced.push(path),
      jumpToMessage: async (messageId: number) => {
        jumped.push(messageId);
      },
    };

    await expect(consumer.consume({
      ...base,
      locationKey: "selection-1",
      activeRoomId: "room-b",
    })).resolves.toBe("deferred");
    await expect(consumer.consume({
      ...base,
      locationKey: "selection-1",
      activeRoomId: "room-a",
    })).resolves.toBe("consumed");
    await expect(consumer.consume({
      ...base,
      locationKey: "selection-2",
      activeRoomId: "room-a",
    })).resolves.toBe("consumed");

    expect(jumped).toEqual([9, 9]);
    expect(replaced).toEqual(["/rooms/room-a", "/rooms/room-a"]);
  });

  test("consumes invalid or inaccessible targets without retaining or disclosing them", async () => {
    const replaced: string[] = [];
    let jumpCount = 0;
    const consumer = createRoomMessageRouteIntentConsumer();

    await expect(consumer.consume({
      locationKey: "invalid",
      pathname: "/rooms/secret-room",
      search: "?messageId=not-a-number",
      activeRoomId: "secret-room",
      replaceRoute: (path) => replaced.push(path),
      jumpToMessage: async () => {
        jumpCount += 1;
      },
    })).resolves.toBe("invalid");
    await expect(consumer.consume({
      locationKey: "revoked",
      pathname: "/rooms/secret-room",
      search: "?messageId=88",
      activeRoomId: "secret-room",
      replaceRoute: (path) => replaced.push(path),
      jumpToMessage: async () => {
        jumpCount += 1;
        throw new Error("revoked");
      },
    })).resolves.toBe("failed");

    expect(replaced).toEqual(["/rooms/secret-room", "/rooms/secret-room"]);
    expect(jumpCount).toBe(1);
  });

  test("a newer route target supersedes in-flight hydration", async () => {
    const oldHydration = controlledPromise<boolean>();
    const completed: number[] = [];
    const consumer = createRoomMessageRouteIntentConsumer();
    const controller = createConversationNavigationController({
      getActiveRoomId: () => "room-a",
      materializeById: (messageId) => messageId === "2",
      loadHistoryAround: (messageId) => messageId === "1" ? oldHydration.promise : Promise.resolve(true),
      waitForCommit: async () => {},
      scrollAndFocus: async () => true,
      onState: () => {},
      onCompleted: (messageId) => completed.push(messageId),
    });
    const consume = (locationKey: string, messageId: number) => consumer.consume({
      locationKey,
      pathname: "/rooms/room-a",
      search: `?messageId=${messageId}`,
      activeRoomId: "room-a",
      replaceRoute: () => {},
      jumpToMessage: controller.jumpToMessage,
    });

    const first = consume("old", 1);
    await expect(consume("new", 2)).resolves.toBe("consumed");
    oldHydration.resolve(true);
    await expect(first).resolves.toBe("consumed");

    expect(completed).toEqual([2]);
  });
});
