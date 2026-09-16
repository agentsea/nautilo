import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import type { OrdinaryContentAccessForState } from "@nautilo/agent";
import type { ContentAccessAdmission, ContentAccessCommand, ContentAccessPreparation,
  ContentAccessReceipt } from "@nautilo/trust";
import * as trust from "@nautilo/trust";
import * as db from "@nautilo/db";

let mode = "plaintext_only";
mock.module("../../src/lib/strict-shadow-policy", () => ({ currentStrictShadowPolicy: async () => ({ mode }) }));
mock.module("@nautilo/agent", () => ({ collapseWhitespaceShareApprovalSnippet: (content: string) => content.slice(0, 140) }));
mock.module("@nautilo/trust", () => ({ ...trust,
  findActorByHandle: async () => ({ kind: "user", actorId: "target-actor", displayName: "Recipient" }),
  envelopeReadableNamespaces: () => ["source-namespace"],
  isScopeMemoryEnvelope: () => false,
}));
mock.module("@nautilo/db", () => ({ ...db,
  getSharedDirectDb: () => ({}),
  findArtifactInternalIdByPublicId: async () => "internal-artifact",
}));
const { createAgentContentAccessForState } = await import("../../src/content-access/agent");
afterAll(() => mock.restore());
beforeEach(() => { mode = "plaintext_only"; });

const state = {
  userId: "user", agentId: "agent", roomId: "source-room",
  memoryAccessEnvelope: { actorId: "actor", agentId: "agent", roomId: "source-room" },
  messages: [{ id: "assistant", tool_calls: [{ id: "call", args: { sensitivity: "normal", message_to_peer: "Please review this file." } }] }],
} as unknown as Parameters<OrdinaryContentAccessForState>[0];
const input = {
  execution: { graphThreadId: "graph", laneKey: "lane", turnId: "turn", assistantMessageId: "assistant",
    toolCallId: "call", toolName: "ask_peer", callDigest: "digest" },
  intent: { toolName: "ask_peer" as const, objects: [{ kind: "artifact" as const, id: "external-artifact" }],
    target: { kind: "person" as const, handle: "recipient" } },
  operationIds: ["operation"], approvalContext: "checked-policy",
};

function fixture() {
  const prepare = mock(async (_admission: ContentAccessAdmission, command: ContentAccessCommand): Promise<ContentAccessPreparation> => ({
    outcome: "prepared", command, previewToken: "private-token", expiresAt: 123,
    preview: { humanActorIds: ["actor", "other-source-human", "target-actor"], people: [
      { actorId: "actor", displayName: "Requester", userHandle: null },
      { actorId: "other-source-human", displayName: "Room member", userHandle: null },
      { actorId: "target-actor", displayName: "Recipient", userHandle: "recipient" },
    ], publicRoom: false, skippedAttachmentCount: 0 },
    display: { kind: "artifact", path: "signed-current-path.txt", mimeType: "text/plain", size: 12 },
  }));
  const commit = mock(async (_admission: ContentAccessAdmission, command: ContentAccessCommand, _token: string): Promise<ContentAccessReceipt> => ({
    operationId: command.operationId, outcome: "applied", stateChanged: true, originalStateChanged: true,
    replayed: false, attachedCount: 1, detachedCount: 0, skippedCount: 0,
  }));
  const verifyPreparedGrantForContact = mock(async () => true);
  return { prepare, commit, verifyPreparedGrantForContact,
    select: createAgentContentAccessForState({ prepare, commit, verifyPreparedGrantForContact }) };
}

test("canonical mode selects ordinary only positively; absent exact Agent/Room context has no port", async () => {
  const f = fixture();
  for (const encrypted of ["shadow_encryption", "encrypted_only"]) {
    mode = encrypted;
    expect(await f.select(state)).toEqual({ mode: "unchanged" });
  }
  mode = "plaintext_only";
  expect(await f.select({ ...state, roomId: "other-room" })).toEqual({ mode: "plaintext_only" });
  expect(f.prepare).not.toHaveBeenCalled();
});

test("prepares exact internal identity and uses signed-snapshot metadata, not the earlier lookup", async () => {
  const f = fixture();
  const selection = await f.select(state);
  if (selection.mode !== "plaintext_only" || !selection.port) throw new Error("Expected ordinary port");
  const prepared = await selection.port.prepare(input);
  if (prepared.status !== "prepared") throw new Error("Expected preparation");
  expect(f.prepare.mock.calls[0]).toEqual([{ principal: { kind: "agent", userId: "user", actorId: "actor",
    agentId: "agent", sourceRoomId: "source-room" }, audienceContract: "invoking_room", approvalContext: "checked-policy" },
  { operationId: "operation", object: { kind: "artifact", id: "internal-artifact" },
    change: { kind: "grant_people", selectedActorIds: ["target-actor"] } }]);
  expect(prepared.operations[0]?.artifact?.path).toBe("signed-current-path.txt");
  expect(prepared.preview.args["audience"]).toContain("3 people");
  expect(prepared.preview.args["message_to_peer"]).toBe("Please review this file.");
  expect(JSON.stringify(prepared.preview)).not.toContain("private-token");
  expect(JSON.stringify(prepared.preview)).not.toContain("internal-artifact");
  const operation = prepared.operations[0]!;
  await selection.port.commit(operation);
  expect(f.commit.mock.calls[0]?.[2]).toBe("private-token");
  const denied = await selection.port.commit({ ...operation,
    admission: { ...operation.admission, principal: { ...operation.admission.principal, userId: "different-human" } } });
  expect(denied.outcome).toBe("denied");
  expect(f.commit).toHaveBeenCalledTimes(1);
});

test("batch preparation count mismatch never calls coordinator", async () => {
  const f = fixture();
  const selection = await f.select(state);
  if (selection.mode !== "plaintext_only" || !selection.port) throw new Error("Expected ordinary port");
  expect((await selection.port.prepare({ ...input, operationIds: [] })).status).toBe("error");
  expect(f.prepare).not.toHaveBeenCalled();
});

test("approval uses current prepared person labels and rejects same-size batch audience drift", async () => {
  const f = fixture();
  const selection = await f.select(state);
  if (selection.mode !== "plaintext_only" || !selection.port) throw new Error("Expected ordinary port");
  const template = await f.prepare({} as ContentAccessAdmission, { operationId: "operation",
    object: { kind: "artifact", id: "internal-artifact" }, change: { kind: "grant_people", selectedActorIds: ["target-actor"] } });
  const current = { ...template, preview: { ...template.preview, people: template.preview.people.map((person) =>
    person.actorId === "target-actor" ? { ...person, displayName: "Current recipient name" } : person) } };
  f.prepare.mockImplementationOnce(async () => current);
  const prepared = await selection.port.prepare(input);
  if (prepared.status !== "prepared") throw new Error("Expected preparation");
  expect(prepared.preview.args["target"]).toBe("Current recipient name");
  f.prepare.mockImplementationOnce(async () => template);
  f.prepare.mockImplementationOnce(async () => ({ ...template, preview: {
    ...template.preview, humanActorIds: ["actor", "replacement-source-human", "target-actor"],
    people: template.preview.people.map((person) => person.actorId === "other-source-human"
      ? { ...person, actorId: "replacement-source-human" } : person),
  } }));
  const rejected = await selection.port.prepare({ ...input, operationIds: ["first", "second"],
    intent: { ...input.intent, objects: [...input.intent.objects, { kind: "artifact", id: "second-artifact" }] } });
  expect(rejected.status).toBe("error");
  expect(f.commit).not.toHaveBeenCalled();
});

test("Memory approval keeps only a bounded snippet, never raw content in the saved operation", async () => {
  const f = fixture();
  f.prepare.mockImplementation(async (_admission, command) => ({ outcome: "prepared", command,
    previewToken: "private-token", expiresAt: 123,
    preview: { humanActorIds: ["actor", "target-actor"], people: [
      { actorId: "actor", displayName: "Requester", userHandle: null },
      { actorId: "target-actor", displayName: "Recipient", userHandle: "recipient" },
    ], publicRoom: false, skippedAttachmentCount: 0 },
    display: { kind: "memory", content: "private-source-text ".repeat(100), type: "note" },
  }));
  const selection = await f.select(state);
  if (selection.mode !== "plaintext_only" || !selection.port) throw new Error("Expected ordinary port");
  const prepared = await selection.port.prepare({ ...input, intent: { ...input.intent,
    toolName: "share_memory", objects: [{ kind: "memory", id: "memory" }] } });
  if (prepared.status !== "prepared") throw new Error("Expected preparation");
  expect(JSON.stringify(prepared.operations)).not.toContain("private-source-text");
  expect(prepared.preview.shareMemoryPreview?.memoryContentSnippet.length).toBe(140);
});
