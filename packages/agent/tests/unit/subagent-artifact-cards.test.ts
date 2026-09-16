import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as db from "@nautilo/db";
import { authorAssistantArtifactCards } from "../../src/subagents/scope-subagent/run";

describe("D570 ask_peer assistant Artifact cards", () => {
  const restores: Array<() => void> = [];

  afterEach(() => {
    while (restores.length) restores.pop()!();
  });

  test("fails closed before DB work for an invalid assistant message id", async () => {
    const room = spyOn(db, "getRoomNamespaceId").mockResolvedValue("ns-dm");
    restores.push(() => room.mockRestore());
    expect(await authorAssistantArtifactCards({
      messageId: "not-a-message",
      roomId: "room-dm",
      externalArtifactIds: ["doc-1"],
    })).toBeUndefined();
    expect(room).not.toHaveBeenCalled();
  });

  test("records and hydrates only ids attached to the exact peer DM namespace", async () => {
    const room = spyOn(db, "getRoomNamespaceId").mockResolvedValue("ns-dm");
    restores.push(() => room.mockRestore());
    const resolve = spyOn(db, "findArtifactInternalIdsForCanonicalNamespace")
      .mockResolvedValue(new Map([["doc-1", "internal-1"]]));
    restores.push(() => resolve.mockRestore());
    const record = spyOn(db, "recordMessageArtifacts").mockResolvedValue();
    restores.push(() => record.mockRestore());
    const hydratedRef = {
      artifactInternalId: "internal-1",
      roomId: "room-dm",
      basename: "plan.md",
      mimeType: "text/markdown",
      sizeBytes: 42,
    };
    const hydrate = spyOn(db, "hydrateMessageArtifacts")
      .mockResolvedValue(new Map([[17, [hydratedRef]]]));
    restores.push(() => hydrate.mockRestore());

    expect(await authorAssistantArtifactCards({
      messageId: "17",
      roomId: "room-dm",
      externalArtifactIds: ["doc-1", "missing", "doc-1"],
    })).toEqual([hydratedRef]);
    expect(resolve).toHaveBeenCalledWith({
      externalArtifactIds: ["doc-1", "missing", "doc-1"],
      canonicalRoomNamespaceId: "ns-dm",
    });
    expect(record).toHaveBeenCalledWith({
      messageId: 17,
      artifactInternalIds: ["internal-1"],
    });
    expect(hydrate).toHaveBeenCalledWith({
      messageIds: [17],
      canonicalRoomNamespaceId: "ns-dm",
      roomId: "room-dm",
    });
  });
});
