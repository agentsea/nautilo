import { afterAll, beforeEach, expect, mock, test } from "bun:test";

const prepare = mock(async () => ({ outcome: "prepared" }));
const commit = mock(async () => ({ outcome: "applied" }));
const executeLegacyHuman = mock(async () => ({ kind: "completed" }));
const verifyPreparedGrantForContact = mock(async () => true);
const invalidate = mock(async (_id: string) => undefined);
mock.module("../../src/lib/workspace-artifact-access-invalidation", () => ({ invalidateWorkspaceArtifactAccess: invalidate }));
const codec = {};
const key = new Uint8Array(32).fill(7);
const resolveKey = mock(() => key);
const createCodec = mock(() => codec);
const createCoordinator = mock(() => ({ prepare, commit, executeLegacyHuman, verifyPreparedGrantForContact }));
mock.module("@nautilo/trust", () => ({
  createContentAccessCoordinator: createCoordinator,
  createContentAccessPreviewCodec: createCodec,
}));
mock.module("../../src/content-access/preview-key", () => ({
  resolveContentAccessPreviewKey: resolveKey,
}));
const { createServerContentAccessRuntime } = await import("../../src/content-access/runtime");
afterAll(() => mock.restore());
beforeEach(() => {
  for (const spy of [prepare, commit, executeLegacyHuman, verifyPreparedGrantForContact, resolveKey, createCodec, createCoordinator, invalidate]) spy.mockClear();
});

test("one lazy instance coordinator serves new and frozen Human adapters", async () => {
  const runtime = createServerContentAccessRuntime();
  expect(resolveKey).not.toHaveBeenCalled();
  const admission = {
    principal: { kind: "human" as const, userId: "user", actorId: "actor", sourceRoomId: "room" },
    audienceContract: "invoking_room" as const, approvalContext: "Human intent",
  };
  const command = {
    operationId: "operation", object: { kind: "memory" as const, id: "memory" },
    change: { kind: "make_private" as const },
  };
  await runtime.prepare(admission, command);
  await runtime.commit(admission, command, "preview");
  await runtime.executeLegacyHuman(admission, command);
  expect(await runtime.verifyPreparedGrantForContact(admission, command, "preview")).toBe(true);
  expect(resolveKey).toHaveBeenCalledTimes(1);
  expect(createCodec).toHaveBeenCalledWith(key);
  expect(createCoordinator).toHaveBeenCalledWith(codec, {});
  expect(prepare).toHaveBeenCalledWith(admission, command);
  expect(commit).toHaveBeenCalledWith(admission, command, "preview");
  expect(executeLegacyHuman).toHaveBeenCalledWith(admission, command);
  expect(verifyPreparedGrantForContact).toHaveBeenCalledWith(admission, command, "preview");
});

test("passes the optional committed-share observer into the lazy coordinator", async () => {
  const observeCommittedArtifactShares = mock(async () => undefined);
  const runtime = createServerContentAccessRuntime({ observeCommittedArtifactShares });
  const admission = {
    principal: { kind: "human" as const, userId: "user", actorId: "actor", sourceRoomId: "room" },
    audienceContract: "invoking_room" as const, approvalContext: "Human intent",
  };
  await runtime.prepare(admission, {
    operationId: "operation", object: { kind: "artifact", id: "artifact" },
    change: { kind: "grant_people", selectedActorIds: ["recipient"] },
  });

  expect(createCoordinator).toHaveBeenCalledWith(codec, { observeCommittedArtifactShares });
});

test("normal refresh follows proven Artifact results, never uncertain failures", async () => {
  const runtime = createServerContentAccessRuntime();
  const admission = { principal: { kind: "human" as const, userId: "user", actorId: "actor", sourceRoomId: "room" },
    audienceContract: "invoking_room" as const, approvalContext: "Human intent" };
  const command = { operationId: "operation", object: { kind: "artifact" as const, id: "artifact" },
    change: { kind: "make_private" as const } };
  for (const outcome of ["applied", "already_applied", "partial"]) {
    commit.mockImplementationOnce(async () => ({ outcome }));
    await runtime.commit(admission, command, "preview");
  }
  expect(invalidate).toHaveBeenCalledTimes(3);
  expect(invalidate).toHaveBeenCalledWith("artifact");
  commit.mockImplementationOnce(async () => ({ outcome: "failed" }));
  await runtime.commit(admission, command, "preview");
  expect(invalidate).toHaveBeenCalledTimes(3);
  executeLegacyHuman.mockImplementationOnce(async () => ({ kind: "completed", receipt: { outcome: "applied" } }));
  await runtime.executeLegacyHuman(admission, command);
  expect(invalidate).toHaveBeenCalledTimes(4);
});
