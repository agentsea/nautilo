import { describe, expect, test } from "bun:test";
import type { ServerEvent } from "@nautilo/types";
import {
  shouldRefreshRoomCatalogueForEvent,
  shouldRefreshRoomCatalogueOnRecovery,
} from "./room-catalogue-refresh";

const chatsSource = await Bun.file(
  new URL("../app/(drawer)/(tabs)/index.tsx", import.meta.url),
).text();

describe("mobile Room catalogue convergence", () => {
  test("refreshes for canonical catalogue and compatible membership events", () => {
    expect(
      shouldRefreshRoomCatalogueForEvent({ type: "room.catalog.changed" }),
    ).toBe(true);
    expect(
      shouldRefreshRoomCatalogueForEvent({
        type: "room_members_changed",
        roomId: "room-1",
        event: {
          kind: "member_added",
          actorId: "actor-1",
          actorKind: "user",
          displayName: "Human",
        },
      }),
    ).toBe(true);
  });

  test("does not turn unrelated realtime events into catalogue reads", () => {
    expect(
      shouldRefreshRoomCatalogueForEvent({
        type: "typing.ping",
        roomId: "room-1",
        userId: "user-1",
        displayName: "Human",
      } satisfies ServerEvent),
    ).toBe(false);
  });

  test("rehydrates only when a recovery revision advances", () => {
    expect(shouldRefreshRoomCatalogueOnRecovery(0, 0)).toBe(false);
    expect(shouldRefreshRoomCatalogueOnRecovery(0, 1)).toBe(true);
    expect(shouldRefreshRoomCatalogueOnRecovery(1, 1)).toBe(false);
    expect(shouldRefreshRoomCatalogueOnRecovery(2, 1)).toBe(false);
  });

  test("the Chats route refreshes on focus and wires realtime recovery", () => {
    expect(chatsSource).toContain("useFocusEffect(useCallback(() => {");
    expect(chatsSource).toContain("shouldRefreshRoomCatalogueOnRecovery(");
    expect(chatsSource).toContain("shouldRefreshRoomCatalogueForEvent(event)");
  });
});
