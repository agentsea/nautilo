import * as externalContext from "../../src/executors/external-room-context";
import * as authoredContext from "../../src/executors/foreground-authored-context";
import { forkLanggraphExecutor } from "../../src/executors/fork-langgraph-executor";
import { describe, expect, test, spyOn } from "bun:test";
import type { ForkRunMetadata } from "../../src/fork/fork-metadata";
import { externalRoomExecutionInput, assertForkRoomContextAllowed } from "../../src/executors/external-room-context";
import { loadForegroundAuthoredContext } from "../../src/executors/foreground-authored-context";
import { memoryReviewAdmission } from "../../src/memory-review/admission";
import type { NamespaceMemoryEnvelope } from "@nautilo/trust";

const envelope = (roomId: string): NamespaceMemoryEnvelope => ({ ownerId: "sponsor", actorId: "human", agentId: "genie", roomId,
  readableNamespaces: ["private", "namespace-a", "namespace-b"], mutableNamespaces: ["private"], writableNamespaces: ["private"], toolPolicy: { file: "allow" } });
const dependencies = {
  policy: async (roomId: string) => ({ roomId, namespaceId: `namespace-${roomId}` }),
  assertTextMode: async () => {},
  assertAccess: async () => {},
};
const input = (roomId: string) => ({ roomId, ownerId: "sponsor", agentId: "genie", threadId: "shared-private-checkpoint",
  message: "Hello", memoryAccessEnvelope: envelope(roomId), currentFolder: "private-folder", roomRoster: [{ displayName: "private identity" }] });

describe("external room runtime admission", () => {
  test("the same Human and Genie cannot share namespaces or checkpoints between rooms", async () => {
    const first = await externalRoomExecutionInput(input("a"), dependencies);
    const second = await externalRoomExecutionInput(input("b"), dependencies);
    expect(first.input["memoryAccessEnvelope"]).toMatchObject({ externalContext: true, readableNamespaces: ["namespace-a"], writableNamespaces: ["namespace-a"] });
    expect(second.input["memoryAccessEnvelope"]).toMatchObject({ externalContext: true, readableNamespaces: ["namespace-b"] });
    expect(first.input["threadId"]).toBe("room:a:bot:genie");
    expect(second.input["threadId"]).toBe("room:b:bot:genie");
    expect(first.input["currentFolder"]).toBe("");
    expect(first.input["roomRoster"]).toEqual([]);
    expect(envelope("a").readableNamespaces).toContain("private");
  });
  test("canonical policy wins over client flags and protected mode has no fallback", async () => {
    expect((await externalRoomExecutionInput({ ...input("a"), externalContext: false }, dependencies)).externalContext).toBe(true);
    expect((await externalRoomExecutionInput({ ...input("a"), externalContext: true }, { ...dependencies, policy: async () => null })).externalContext).toBe(false);
    await rejects(externalRoomExecutionInput(input("a"), { ...dependencies, assertTextMode: async () => { throw new Error("protected-mode"); } }), "protected-mode");
  });
  test("attachments and private Task report-backs fail visibly before context loading", async () => {
    await rejects(externalRoomExecutionInput({ ...input("a"), artifactRefs: [{ id: "private" }] }, dependencies), "external_room_text_only");
    await rejects(externalRoomExecutionInput({ ...input("a"), metadata: { originatedBy: "task" } }, dependencies), "external_room_delegation_unavailable");
    await rejects(externalRoomExecutionInput({ ...input("a"), memoryAccessEnvelope: envelope("b") }, dependencies), "external_room_authority_mismatch");
  });
  test("private Soul and Skills loaders are never invoked", async () => {
    const forbidden = async (): Promise<never> => { throw new Error("private-context-read"); };
    expect(await loadForegroundAuthoredContext({ agentId: "genie", ownerId: "sponsor", isGuest: false, externalContext: true }, {
      getExecutionConfigByAgentId: forbidden, resolveEnabledBodies: forbidden,
    })).toEqual({
      profile: null,
      soulFile: "",
      soulSourceReceipt: null,
      modelInputDependencies: [],
      skills: [],
    });
  });
  test("automatic memory review does not reserve external conversation sources", async () => {
    expect(await memoryReviewAdmission({ ...envelope("a"), externalContext: true }, "checkpoint", {
      threadId: "thread", transcriptOwnerId: "sponsor", turnId: "turn", input: { humanAlreadyPersisted: true, currentMessageId: 1 },
    })).toEqual({});
  });
});

async function rejects(promise: Promise<unknown>, message: string): Promise<void> {
  const error: unknown = await promise.then(() => null, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(message);
}

test("fork admission checks destination, source transcript and unpersisted source checkpoint Rooms", async () => {
  const externalRoom = "10000000-0000-4000-8000-000000000001";
  const fork: ForkRunMetadata = { mode: "fork", parentThreadId: "opaque-parent", transcriptThreadId: "opaque-parent",
    checkpointThreadId: "opaque-fork", forkThreadId: "opaque-fork", sequence: 1, pendingTurns: [] };
  let canonicalReads = 0;
  const deps = {
    policy: async (roomId: string) => roomId === externalRoom ? { roomId, namespaceId: "external-namespace" } : null,
    roomIdsForThreads: async (ids: readonly string[]) => {
      canonicalReads++;
      expect(ids).toContain("opaque-parent");
      return [externalRoom];
    },
  };
  await rejects(assertForkRoomContextAllowed(input("ordinary"), fork, deps), "external_room_delegation_unavailable");
  expect(canonicalReads).toBe(1);
  await rejects(assertForkRoomContextAllowed(input(externalRoom), fork, deps), "external_room_delegation_unavailable");
  expect(canonicalReads).toBe(1);
  await rejects(assertForkRoomContextAllowed(input("ordinary"), { ...fork,
    checkpointThreadId: `room:${externalRoom}:bot:genie:fork:turn:nonce` }, deps), "external_room_delegation_unavailable");
  expect(canonicalReads).toBe(1);
  await rejects(assertForkRoomContextAllowed({ ...input("ordinary"), subthreadParentRoomId: externalRoom }, fork, deps), "external_room_delegation_unavailable");
  await assertForkRoomContextAllowed(input("ordinary"), fork, { ...deps, roomIdsForThreads: async () => ["ordinary"] });
});

test("the actual fork executor rejects before authored context or model work", async () => {
  let authoredReads = 0;
  const authored = spyOn(authoredContext, "loadForegroundAuthoredContext").mockImplementation(async () => {
    authoredReads++;
    throw new Error("private-context-canary");
  });
  const guard = spyOn(externalContext, "assertForkRoomContextAllowed").mockImplementation(async () => {
    throw new Error("external_room_delegation_unavailable");
  });
  try {
    const execution = forkLanggraphExecutor({ forkRun: { mode: "fork" } }, "job", null, new AbortController().signal);
    await rejects(execution.next(), "external_room_delegation_unavailable");
    expect(guard).toHaveBeenCalledTimes(1);
    expect(authoredReads).toBe(0);
  } finally { guard.mockRestore(); authored.mockRestore(); }
});
