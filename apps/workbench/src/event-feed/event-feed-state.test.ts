import { describe, expect, test } from "bun:test";
import type { EventFeedItem } from "@nautilo/types";
import { reconcileEventFeedPages } from "./event-feed-state";

function artifactEvent(input: {
  id: string;
  createdAt: string;
  actorDisplayName: string | null;
}): EventFeedItem {
  return {
    ...input,
    type: "artifact.shared",
    actorKind: "human",
    actorId: "11111111-1111-4111-8111-111111111111",
    data: {
      artifactId: "22222222-2222-4222-8222-222222222222",
      destination: { kind: "person", userId: "33333333-3333-4333-8333-333333333333" },
    },
    readAt: null,
  };
}

describe("event-feed state", () => {
  test("does not retain an actor label for an older row outside the refreshed authority window", () => {
    const retained = artifactEvent({
      id: "44444444-4444-4444-8444-444444444444",
      createdAt: "2026-09-09T08:00:00.000Z",
      actorDisplayName: "Previously visible person",
    });
    const refreshed = artifactEvent({
      id: "55555555-5555-4555-8555-555555555555",
      createdAt: "2026-09-09T09:00:00.000Z",
      actorDisplayName: null,
    });

    const result = reconcileEventFeedPages([retained], [refreshed]);

    expect(result.events[0]?.actorDisplayName).toBeNull();
  });
});
