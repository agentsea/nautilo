import { expect, test } from "bun:test";
import { restrictExternalRoomEnvelope } from "../../src/external-room-policy";
import type { NamespaceMemoryEnvelope } from "../../src/types";

test("external restriction narrows every namespace dimension without mutating the Human envelope", () => {
  const ordinary: NamespaceMemoryEnvelope = { ownerId: "human", actorId: "actor", agentId: "genie", roomId: "room",
    readableNamespaces: ["personal", "other-room"], mutableNamespaces: ["personal"], writableNamespaces: ["personal"],
    toolPolicy: { exec_command: "allow", search_memory: "allow", task: "require_prove_it" } };
  const external = restrictExternalRoomEnvelope(ordinary, "bound-room");
  expect(external.readableNamespaces).toEqual(["bound-room"]);
  expect(external.mutableNamespaces).toEqual(["bound-room"]);
  expect(external.writableNamespaces).toEqual(["bound-room"]);
  expect(Object.values(external.toolPolicy)).toEqual(["forbidden", "forbidden", "forbidden"]);
  expect(external.ownerId).toBe("human");
  expect(ordinary.readableNamespaces).toEqual(["personal", "other-room"]);
  expect(() => restrictExternalRoomEnvelope({ ...ordinary, memoryMode: "scope", scopeId: "private-scope" }, "bound-room")).toThrow("external_room_scope_unavailable");
});
