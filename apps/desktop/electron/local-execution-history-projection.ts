type VaultRoomHistoryShadowReadResultV1 = Awaited<ReturnType<import("./foreground-shadow-controller").ElectronForegroundShadowController["reconcileHistory"]>>;
import type { LocalExecutionView } from "./relay-dispatch/local-execution";
import type { LocalExecutionHistoryScope, LocalExecutionHistoryStore } from "./local-execution-history";
import type { RelayLocalExecutionHistoryBindingV1 } from "@nautilo/relay";
import { searchLocalExecutionOutput, type LocalExecutionSearchProgress } from "./local-execution-search";

export interface LocalExecutionHistoryReference { generation: string; executionId: string }
export interface LocalExecutionHistoryOverlay extends LocalExecutionHistoryReference {
  snapshot: LocalExecutionView & { archived: true };
}
export interface VerifiedLocalExecutionHistoryOverlay extends LocalExecutionHistoryOverlay {
  sessionId: string;
  messageId: string;
  editRevision: number;
}

/** Model recovery uses the same sealed capture, with repeatable UTF-8 paging.
 * Current reader identity never replaces the archived execution's owner. */
export async function readLocalExecutionHistoryPage(input: {
  store: Pick<LocalExecutionHistoryStore, "read">;
  scope: LocalExecutionHistoryScope;
  binding: RelayLocalExecutionHistoryBindingV1;
  cursor: number;
  maxBytes: number;
  search?: string;
  isCurrent: () => boolean;
}): Promise<LocalExecutionView & { historical: true; search?: LocalExecutionSearchProgress }> {
  if (!Number.isSafeInteger(input.cursor) || input.cursor < 0 || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 4
    || !input.isCurrent() || input.scope.instanceId !== input.binding.reader.instanceId
    || input.scope.humanUserId !== input.binding.reader.humanUserId || input.scope.relayId !== input.binding.reader.relayId
    || input.scope.pairingGeneration !== input.binding.reader.pairingGeneration) throw new Error("LOCAL_EXECUTION_HISTORY_UNAVAILABLE");
  const record = await input.store.read(input.scope, input.binding.generation, input.binding.executionId);
  if (!record || !input.isCurrent() || record.owner.agentId !== input.binding.reader.agentId
    || record.owner.conversationId !== input.binding.reader.conversationId) throw new Error("LOCAL_EXECUTION_HISTORY_UNAVAILABLE");
  const output = record.snapshot.output;
  const bytes = Buffer.from(output.data, "utf8");
  if (input.cursor > output.produced) throw new Error("LOCAL_EXECUTION_CURSOR_INVALID");
  const search = input.search === undefined ? undefined : searchLocalExecutionOutput({ output: bytes,
    produced: output.produced, cursor: input.cursor, literal: input.search, settled: true });
  const from = search ? search.matchedAt ?? output.produced : Math.max(input.cursor, output.availableFrom);
  if (from < output.produced && (bytes[from - output.availableFrom]! & 0xc0) === 0x80) throw new Error("LOCAL_EXECUTION_CURSOR_INVALID");
  let end = Math.min(output.produced, from + input.maxBytes);
  while (end < output.produced && end > from && (bytes[end - output.availableFrom]! & 0xc0) === 0x80) end -= 1;
  return { ...record.snapshot, generation: record.generation, session_id: record.snapshot.executionId, historical: true,
    ...(search ? { search } : {}),
    output: { ...output, data: bytes.subarray(from - output.availableFrom, end - output.availableFrom).toString("utf8"),
      cursor: from, nextCursor: end, gap: search ? false : input.cursor < output.availableFrom, hasMore: end < output.produced } };
}

export function hasVerifiedLocalExecutionReference(result: VaultRoomHistoryShadowReadResultV1): boolean {
  return result.records.some(record => {
    if (record.status !== "verified" || record.payload.role !== "tool" ||
      !["exec_command", "write_stdin"].includes(record.payload.toolName ?? "")) return false;
    try {
      const value = JSON.parse(record.payload.content) as Record<string, unknown>;
      return typeof value["generation"] === "string" && typeof value["executionId"] === "string" && value["session_id"] === value["executionId"];
    } catch { return false; }
  });
}

/** Compare against a server-resolved graph identity; never derive a Room UUID. */
export function executionBelongsToConversation(conversation: string, graphThreadId: string): boolean {
  return conversation === graphThreadId || [":bot:", ":user:", ":fork:"].some(suffix => conversation.startsWith(`${graphThreadId}${suffix}`));
}

export async function projectLocalExecutionHistory(input: {
  store: Pick<LocalExecutionHistoryStore, "read">;
  scope: LocalExecutionHistoryScope;
  graphThreadId: string;
  references: readonly LocalExecutionHistoryReference[];
  isCurrent: () => boolean;
}): Promise<LocalExecutionHistoryOverlay[]> {
  const overlays: LocalExecutionHistoryOverlay[] = [];
  for (const reference of input.references) {
    if (!input.isCurrent()) return [];
    const record = await input.store.read(input.scope, reference.generation, reference.executionId).catch(() => null);
    if (!record || !executionBelongsToConversation(record.owner.conversationId, input.graphThreadId)) continue;
    overlays.push({ ...reference, snapshot: { ...record.snapshot, generation: record.generation,
      session_id: record.snapshot.executionId, archived: true } });
  }
  return input.isCurrent() ? overlays : [];
}

/** Called only after the existing protected reader verified and acknowledged
 * the original payload. The signed payload/result itself is never changed. */
export async function projectVerifiedLocalExecutionHistory(input: {
  result: VaultRoomHistoryShadowReadResultV1;
  store: Pick<LocalExecutionHistoryStore, "read">;
  scope: LocalExecutionHistoryScope;
  graphThreadId: string;
  isCurrent: () => boolean;
}): Promise<VerifiedLocalExecutionHistoryOverlay[]> {
  const overlays: VerifiedLocalExecutionHistoryOverlay[] = [];
  for (const record of input.result.records) {
    if (record.status !== "verified" || record.payload.role !== "tool" ||
      !["exec_command", "write_stdin"].includes(record.payload.toolName ?? "")) continue;
    let reference: LocalExecutionHistoryReference;
    try {
      const value = JSON.parse(record.payload.content) as Record<string, unknown>;
      if (typeof value["generation"] !== "string" || typeof value["executionId"] !== "string" ||
        value["session_id"] !== value["executionId"]) continue;
      reference = { generation: value["generation"], executionId: value["executionId"] };
    } catch { continue; }
    const projected = await projectLocalExecutionHistory({ ...input, references: [reference] });
    for (const overlay of projected) overlays.push({ ...overlay, sessionId: record.sessionId,
      messageId: record.messageId, editRevision: record.editRevision });
  }
  return input.isCurrent() ? overlays : [];
}
