import { getSharedDirectDb, sessions, inArray, isNotNull, and } from "@nautilo/db";
import type { ForkRunMetadata } from "../fork/fork-metadata";
import { restrictExternalRoomEnvelope, externalRoomExecutionDependencies,
  type ExternalRoomExecutionDependencies, type MemoryAccessEnvelope } from "@nautilo/trust";
import { getCurrentExternalRoomExecution } from "../external-room-execution";
import { botThreadId } from "../conductor/thread-id";

/** Resolve the permanent room boundary before reading any model context. */
export async function externalRoomExecutionInput(
  input: Record<string, unknown>,
  deps: ExternalRoomExecutionDependencies = externalRoomExecutionDependencies,
): Promise<{ input: Record<string, unknown>; externalContext: boolean }> {
  const envelope = input["memoryAccessEnvelope"] as MemoryAccessEnvelope | undefined;
  const roomId = typeof input["roomId"] === "string" ? input["roomId"] : envelope?.roomId ?? "";
  const policy = await deps.policy(roomId);
  if (!policy) {
    if (envelope?.externalContext === true) throw new Error("external_room_authority_unavailable");
    return { input, externalContext: false };
  }
  await deps.assertTextMode();
  if (!envelope || envelope.roomId !== policy.roomId || envelope.ownerId !== input["ownerId"]
    || envelope.agentId !== input["agentId"]) throw new Error("external_room_authority_mismatch");
  await deps.assertAccess(policy, envelope);
  const metadata = input["metadata"] as Record<string, unknown> | undefined;
  if (input["taskReportBackContinuation"] || metadata?.["originatedBy"] === "task"
    || input["currentTaskId"] || input["taskRun"] || input["subagentRun"]) {
    throw new Error("external_room_delegation_unavailable");
  }
  for (const name of ["attachmentTextBlocks", "multimodalImages", "retainedAttachmentIds", "artifactRefs", "focusedResources"]) {
    const value = input[name];
    if (value !== undefined && (!Array.isArray(value) || value.length > 0)) {
      throw new Error("external_room_text_only");
    }
  }
  const execution = getCurrentExternalRoomExecution();
  return {
    externalContext: true,
    input: {
      ...input,
      memoryAccessEnvelope: restrictExternalRoomEnvelope(envelope, policy.namespaceId),
      threadId: execution?.operatorControl
        ? `room:${roomId}:operator:${execution.reference.receiptId}`
        : botThreadId(roomId, envelope.agentId),
      roomRoster: [], currentFolder: "", currentFolderRelayId: "", workspacePath: "",
      activeMiniApp: null, liveMiniAppSession: null, verifiedOrdinaryOrigin: null,
      voiceMode: false, autoApprove: false, redirectAllowed: false,
      taskReportBackContinuation: null,
    },
  };
}

export interface ExternalRoomForkDependencies {
  policy: typeof externalRoomExecutionDependencies.policy;
  roomIdsForThreads(threadIds: readonly string[]): Promise<readonly string[]>;
}

const externalRoomForkDependencies: ExternalRoomForkDependencies = {
  policy: externalRoomExecutionDependencies.policy,
  async roomIdsForThreads(threadIds) {
    if (threadIds.length === 0) return [];
    // Content-free canonical source lookup. Do not filter by destination owner:
    // that would hide a foreign source thread instead of fencing its audience.
    const rows = await getSharedDirectDb().select({ roomId: sessions.roomId }).from(sessions)
      .where(and(inArray(sessions.threadId, [...threadIds]), isNotNull(sessions.roomId)));
    return rows.flatMap((row) => row.roomId ? [row.roomId] : []);
  },
};

/** Forks cannot cross either side of the external audience boundary. */
export async function assertForkRoomContextAllowed(
  input: Record<string, unknown>,
  fork: ForkRunMetadata,
  deps: ExternalRoomForkDependencies = externalRoomForkDependencies,
): Promise<void> {
  const envelope = input["memoryAccessEnvelope"] as MemoryAccessEnvelope | undefined;
  if (envelope?.externalContext === true) throw new Error("external_room_delegation_unavailable");
  const roomIds = new Set<string>();
  for (const value of [input["roomId"], input["subthreadRoomId"], input["subthreadParentRoomId"], envelope?.roomId]) {
    if (typeof value === "string" && value) roomIds.add(value);
  }
  const threadIds = [fork.parentThreadId, fork.transcriptThreadId, fork.checkpointThreadId, fork.forkThreadId];
  if (threadIds.some((value) => typeof value !== "string" || !value)) throw new Error("fork_room_authority_unavailable");
  // An external Room's first checkpoint can predate its first transcript row.
  // Its runtime-owned canonical thread still identifies the Room to re-read.
  for (const threadId of threadIds) {
    const match = /^room:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?::|$)/iu.exec(threadId);
    if (match?.[1]) roomIds.add(match[1]);
  }
  for (const roomId of roomIds) {
    if (await deps.policy(roomId)) throw new Error("external_room_delegation_unavailable");
  }
  for (const roomId of await deps.roomIdsForThreads([...new Set(threadIds)])) {
    if (!roomIds.has(roomId) && await deps.policy(roomId)) throw new Error("external_room_delegation_unavailable");
  }
}
