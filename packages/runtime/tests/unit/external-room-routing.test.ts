import { expect, test } from "bun:test";
import { routeBoundExternalRoomMessage } from "../../src/conductor/conductor";

test("binding routing never infers a different Genie or writes a Human focus", async () => {
  const input = { roomId: "room", boundAgentId: "bound", now: new Date(), members: [
    { kind: "agent" as const, actorId: "actor", agentId: "bound", handle: "bound" },
    { kind: "agent" as const, actorId: "other-actor", agentId: "other", handle: "other" },
  ] };
  expect(await routeBoundExternalRoomMessage({}, input)).toMatchObject({ kind: "wake", source: "binding", botActorIds: ["actor"], writeFocus: false });
  expect(await routeBoundExternalRoomMessage({ loadActiveSilenceForRoom: async () => [
    { botActorId: "actor", kind: "mute" } as never,
  ] }, input)).toMatchObject({ kind: "silent" });
  expect(await routeBoundExternalRoomMessage({}, { ...input, members: [input.members[1]!] })).toMatchObject({ kind: "silent" });
});
