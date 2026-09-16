import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import type { NamespaceMemoryEnvelope } from "@nautilo/trust";
import { resolveMediaReferenceNamespaces } from "../../src/media-generation/reference-scope";

const actor = { userId: "human", roomId: "project-room", agentId: "genie" };
const human = async () => ({ id: "human-actor" });
const scope = { ownerId: actor.userId, roomId: actor.roomId, namespaceId: "project" };
const envelope: NamespaceMemoryEnvelope = { ownerId: actor.userId, actorId: "human-actor", agentId: actor.agentId,
  roomId: actor.roomId, readableNamespaces: ["project", "import-room"], mutableNamespaces: ["project"],
  writableNamespaces: ["project"], toolPolicy: {} };

test("reference access includes current readable Workspace media without changing the output namespace", async () => {
  expect(await resolveMediaReferenceNamespaces(scope, actor, async actorId => { expect(actorId).toBe("human-actor"); return envelope; }, human)).toEqual(["project", "import-room"]);
  expect(scope.namespaceId).toBe("project");
  expect(await resolveMediaReferenceNamespaces(scope, actor, async () => ({ ...envelope, readableNamespaces: ["project"] }), human)).toEqual(["project"]);
});

test("reference access fails closed for a changed human, Genie, room or write boundary", async () => {
  for (const changed of [{ actorId: "other" }, { ownerId: "other" }, { agentId: "other" }, { roomId: "other" },
    { writableNamespaces: [] }, { writableNamespaces: ["other"] }, { writableNamespaces: ["project", "other"] }]) {
    await assert.rejects(resolveMediaReferenceNamespaces(scope, actor, async () => ({ ...envelope, ...changed }), human), /Reference access changed/);
  }
  await assert.rejects(resolveMediaReferenceNamespaces(scope, { ...actor, userId: "other" }, async actorId => { expect(actorId).toBe("human-actor"); return envelope; }, human), /Reference actor changed/);
});
