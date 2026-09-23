import { describe, expect, test } from "bun:test";
import {
  bindEncryptionDataOperationOwner,
  ClassifiedDataOperationError,
  type LiveShadowEncryptionTransitionPolicy,
} from "@nautilo/lattice-bridge";
import type { VaultRoomHistoryShadowReadResultV1 } from "@nautilo/lattice-bridge/client/browser";
import { consumeRoomHistoryRows } from "./room-history-row-access";
import { restoreSessionMessages } from "./session-rehydrate";

const policies: readonly LiveShadowEncryptionTransitionPolicy[] = [
  { mode: "plaintext_only", shadowBehavior: "fallback" },
  { mode: "shadow_encryption", shadowBehavior: "fallback" },
  { mode: "shadow_encryption", shadowBehavior: "strict" },
  { mode: "encrypted_only", shadowBehavior: "strict" },
];
const rows = [
  { id: "1", role: "assistant", content: "ordinary one", editRevision: 2, toolCalls: '[{"name":"secret","args":{"query":"private"}}]' },
  { id: "2", role: "user", content: "ordinary two", editRevision: 0 },
];
const verified: VaultRoomHistoryShadowReadResultV1["records"][number] = {
  sessionId: "session", messageId: "1", editRevision: 2, status: "verified",
  verification: "signed_representation_authenticated",
  payload: { role: "assistant", content: "verified one" },
};
const waiting: VaultRoomHistoryShadowReadResultV1["records"][number] = {
  sessionId: "session", messageId: "2", editRevision: 0,
  status: "fallback", reason: "retained_key_material_unavailable",
};
function owner(policy: LiveShadowEncryptionTransitionPolicy) {
  return bindEncryptionDataOperationOwner({ policy: {
    resolve: async () => ({ policy, revalidationToken: 1 }),
    revalidate: async () => {},
  } });
}

describe("actual Room row consumption", () => {
  for (const policy of policies) test(`preserves independent rows in ${policy.mode}/${policy.shadowBehavior}`, async () => {
    const result = await consumeRoomHistoryRows(owner(policy), rows, [verified, waiting]);
    const plain = policy.mode === "plaintext_only";
    const ordinaryAllowed = plain || policy.shadowBehavior === "fallback";
    expect(result[0]?.content).toBe(plain ? "ordinary one" : "verified one");
    expect(result[1]?.content).toBe(ordinaryAllowed
      ? "ordinary two" : "Encrypted history is unavailable on this device.");
    if (!plain) expect(result[0]?.toolCalls).toBe("[]");
  });

  test("Fallback never releases an integrity-failed sibling or discards another verified row", async () => {
    const result = await consumeRoomHistoryRows(owner(policies[1]!), rows, [
      verified, { ...waiting, reason: "parity_mismatch" },
    ]);
    expect(result[0]?.content).toBe("verified one");
    expect(result[1]?.content).not.toBe("ordinary two");
    expect(result[1]?.historyUnavailableReason).toBe("integrity");
  });

  test("duplicate, omitted expected and wrong-role results are not ordinary fallback", async () => {
    const invalid = [
      [verified, verified],
      [],
      [{ ...verified, payload: { role: "user" as const, content: "wrong role" } }],
    ];
    for (const results of invalid) {
      const result = await consumeRoomHistoryRows(owner(policies[1]!), [rows[0]!], results, {
        expectedResults: [{ messageId: "1", editRevision: 2 }],
      });
      expect(result[0]?.content).toBe("Encrypted history is unavailable on this device.");
      expect(result[0]?.toolCalls).toBe("[]");
    }
  });

  test("a legitimate ordinary-only selection falls back only in Fallback Shadow", async () => {
    const fallback = await consumeRoomHistoryRows(owner(policies[1]!), [rows[1]!], []);
    const strict = await consumeRoomHistoryRows(owner(policies[2]!), [rows[1]!], []);
    expect(fallback[0]?.content).toBe("ordinary two");
    expect(strict[0]?.content).not.toBe("ordinary two");
  });

  test("exact protected recovery rejects missing verification even in Fallback", async () => {
    await expect(consumeRoomHistoryRows(owner(policies[1]!), [rows[1]!], [waiting], {
      requireVerified: true,
    })).rejects.toBeInstanceOf(ClassifiedDataOperationError);
  });

  test("authority failure rejects the page rather than inventing empty success", async () => {
    await expect(consumeRoomHistoryRows(owner(policies[1]!), rows, [], {
      pageFailure: "authority",
    })).rejects.toBeInstanceOf(ClassifiedDataOperationError);
  });

  test("production protected-row consumption preserves exact tool correlation and error status", async () => {
    const toolCalls = (id: string, name: string, args: Record<string, unknown>) =>
      JSON.stringify([{ id, name, args }]);
    const historyRows = [
      { id: "a-share-1", role: "assistant", content: "", editRevision: 0,
        toolCalls: toolCalls("share-1", "share_memory", {
          mode: "project", proposed_content: "first", target_room_name: "Team",
        }) },
      { id: "a-share-1-resume", role: "assistant", content: "", editRevision: 0,
        toolCalls: toolCalls("share-1", "share_memory", { mode: "project" }) },
      { id: "t-share-1", role: "tool", content: "", editRevision: 0,
        toolName: "share_memory" },
      { id: "a-discover", role: "assistant", content: "", editRevision: 0,
        toolCalls: toolCalls("discover-1", "discover_tools", {
          query: "fresh projection preflight share memory",
        }) },
      { id: "t-discover", role: "tool", content: "", editRevision: 0,
        toolName: "discover_tools" },
      { id: "a-share-2", role: "assistant", content: "", editRevision: 0,
        toolCalls: toolCalls("share-2", "share_memory", {
          mode: "project", proposed_content: "second", target_room_name: "Team",
        }) },
      { id: "a-share-2-resume", role: "assistant", content: "", editRevision: 0,
        toolCalls: toolCalls("share-2", "share_memory", { mode: "project" }) },
      { id: "t-share-2", role: "tool", content: "", editRevision: 0,
        toolName: "share_memory" },
    ];
    const payloads = [
      { role: "assistant" as const, content: "", toolCalls: [{ id: "share-1",
        name: "share_memory", args: { mode: "project", proposed_content: "first",
          target_room_name: "Team" } }] },
      { role: "assistant" as const, content: "", toolCalls: [{ id: "share-1",
        name: "share_memory", args: { mode: "project" } }] },
      { role: "tool" as const, content: JSON.stringify({ error: "stale authority" }),
        toolName: "share_memory", sensitiveMetadata: {
          toolCallId: "share-1", toolStatus: "error",
        } },
      { role: "assistant" as const, content: "", toolCalls: [{ id: "discover-1",
        name: "discover_tools", args: { query: "fresh projection preflight share memory" } }] },
      { role: "tool" as const, content: "found", toolName: "discover_tools",
        sensitiveMetadata: { toolCallId: "discover-1", toolStatus: "success" } },
      { role: "assistant" as const, content: "", toolCalls: [{ id: "share-2",
        name: "share_memory", args: { mode: "project", proposed_content: "second",
          target_room_name: "Team" } }] },
      { role: "assistant" as const, content: "", toolCalls: [{ id: "share-2",
        name: "share_memory", args: { mode: "project" } }] },
      { role: "tool" as const, content: JSON.stringify({ error: "stale again" }),
        toolName: "share_memory", sensitiveMetadata: { toolCallId: "share-2" } },
    ];
    const records = historyRows.map((row, index) => ({
      sessionId: "session",
      messageId: row.id,
      editRevision: 0,
      status: "verified" as const,
      verification: "signed_representation_authenticated" as const,
      payload: payloads[index]!,
    }));

    const consumed = await consumeRoomHistoryRows(
      owner(policies[3]!),
      historyRows,
      records,
      { requireVerified: true },
    );
    const cards = restoreSessionMessages(consumed).map((message) =>
      Array.isArray(message.content) ? message.content[0] : undefined);

    expect(consumed[2]).toMatchObject({
      authenticatedToolCallId: "share-1",
      authenticatedToolStatus: "error",
    });
    expect(cards).toMatchObject([
      { toolCallId: "share-1", toolName: "share_memory", args: {
        mode: "project", proposed_content: "first", target_room_name: "Team",
      }, isError: true },
      { toolCallId: "discover-1", toolName: "discover_tools", args: {
        query: "fresh projection preflight share memory",
      } },
      { toolCallId: "share-2", toolName: "share_memory", args: {
        mode: "project", proposed_content: "second", target_room_name: "Team",
      }, isError: true },
    ]);
  });

  test.each(["fallback", "strict"] as const)("a retained read waiting for current Domain authority obeys %s", async (shadowBehavior) => {
    const pending = { ...waiting, reason: "current_read_authority_unavailable" as const };
    const result = await consumeRoomHistoryRows(owner({ mode: "shadow_encryption", shadowBehavior }), rows, [verified, pending]);
    expect(result[0]?.content).toBe("verified one");
    expect(result[1]?.content).toBe(shadowBehavior === "fallback"
      ? "ordinary two" : "Encrypted history is unavailable on this device.");
    expect(result[1]?.historyUnavailableReason).toBe(shadowBehavior === "fallback" ? undefined : "key_waiting");
    await expect(consumeRoomHistoryRows(owner({ mode: "shadow_encryption", shadowBehavior }), [rows[1]!], [pending], {
      requireVerified: true,
    })).rejects.toMatchObject({ failureClass: "key_waiting" });
  });

  test("verified recovery clears stale unavailable classification", async () => {
    const result = await consumeRoomHistoryRows(owner(policies[2]!), [{
      ...rows[0]!, historyUnavailable: true, historyUnavailableReason: "key_waiting",
    }], [verified]);
    expect(result[0]?.content).toBe("verified one");
    expect(result[0]?.historyUnavailable).toBeUndefined();
    expect(result[0]?.historyUnavailableReason).toBeUndefined();
  });
});


test("ordinary attachment descriptors follow the selected history representation", async () => {
  const attachments = [{ attachmentId: "screen", filename: "screen.png", mimeType: "image/png", sizeBytes: 12 }];
  const row = { id: "2", role: "user", content: "picture", editRevision: 0, attachments };
  const ordinary = await consumeRoomHistoryRows(owner(policies[0]!), [row], []);
  expect(ordinary[0]?.attachments).toEqual(attachments);
  const fallback = await consumeRoomHistoryRows(owner(policies[1]!), [row], [waiting]);
  expect(fallback[0]?.attachments).toEqual(attachments);
  const unavailable = await consumeRoomHistoryRows(owner(policies[2]!), [row], [waiting]);
  expect(unavailable[0]?.attachments).toEqual([]);
  const opened = await consumeRoomHistoryRows(owner(policies[2]!), [row], [{
    sessionId: "session", messageId: "2", editRevision: 0, status: "verified",
    verification: "signed_representation_authenticated",
    payload: { role: "user", content: "verified picture text" },
  }]);
  expect(opened[0]?.attachments).toBeUndefined();
});
