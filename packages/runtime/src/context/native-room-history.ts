import { createHash } from "node:crypto";
import { HumanMessage } from "@langchain/core/messages";
import { nativeRoomObservation, nativeHistoryProvesNonDelivery, NATIVE_HISTORY_WARNING, ROOM_CONTEXT_MESSAGE_HEADER, type NativeRoomHistoryPort, type NativeRoomHistoryPortForState } from "@nautilo/agent";
import type { RoomHistoryHit } from "../conductor/history-search";
import { formatTranscriptLine } from "../conductor/transcript-format";

/** Never reconstruct Room authority from a model argument or checkpoint alone. */
export function bindNativeRoomHistoryPort(port: NativeRoomHistoryPort,
  binding: { userId: string; agentId: string; roomId: string; turnId: string },
): NativeRoomHistoryPortForState {
  return state => Object.values(binding).every(Boolean) && !state.taskRun && !state.subagentRun
    && state.trustedExecutionEntrypoint === "foreground.main"
    && state.userId === binding.userId && state.agentId === binding.agentId
    && state.roomId === binding.roomId && state.turnId === binding.turnId ? port : undefined;
}

/**
 * Invoked only after the existing Room/Journal/Record selection has finished.
 * Input rows have already passed the invocation's ordinary or protected reader.
 * Exact source-rendered lines establish membership; rendered prose is never
 * parsed as a tool receipt. Nothing is added to the selected history.
 */
export function createNativeRoomHistoryPort(
  canonicalBody: string,
  hits: readonly RoomHistoryHit[],
  signal?: AbortSignal,
): NativeRoomHistoryPort & { close(): void } {
  const sources = new Map<string, NonNullable<ReturnType<typeof nativeRoomObservation>>>();
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  const header = canonicalBody.indexOf(ROOM_CONTEXT_MESSAGE_HEADER);
  const counts = new Map<number, number>();
  for (const hit of hits) counts.set(hit.messageId, (counts.get(hit.messageId) ?? 0) + 1);
  const lines = hits.map(hit => formatTranscriptLine({ displayName: hit.authorDisplayName, handle: hit.handle,
    ts: hit.ts, content: hit.snippet, ...(hit.reactions ? { reactions: hit.reactions } : {}) }));
  const lineCounts = new Map<string, number>();
  for (const line of lines) lineCounts.set(line, (lineCounts.get(line) ?? 0) + 1);
  let turn = 0;
  const turns = hits.map(hit => hit.role === "user" ? ++turn : turn);
  const uncertainTurns = new Set<number>();
  hits.forEach((hit, index) => {
    if (hit.role !== "tool" || hit.toolEvidence?.name !== "computer_do") return;
    try {
      const receipt = JSON.parse(hit.snippet) as { settlement?: unknown };
      if (hit.toolEvidence.status !== "success"
        || (receipt.settlement !== "completed" && !nativeHistoryProvesNonDelivery(receipt))) uncertainTurns.add(turns[index]!);
    } catch { uncertainTurns.add(turns[index]!); }
  });
  hits.forEach((hit, index) => {
    if (header < 0 || counts.get(hit.messageId) !== 1 || uncertainTurns.has(turns[index]!)
      || hit.role !== "tool" || hit.toolEvidence?.name !== "computer_observe" || hit.toolEvidence.status !== "success") return;
    const line = lines[index]!;
    if (lineCounts.get(line) !== 1) return;
    const start = canonicalBody.indexOf(line, header + ROOM_CONTEXT_MESSAGE_HEADER.length);
    const end = start + line.length;
    if (start < 0 || (start > 0 && canonicalBody[start - 1] !== "\n")
      || (end < canonicalBody.length && canonicalBody[end] !== "\n")
      || canonicalBody.indexOf(line) !== start || canonicalBody.indexOf(line, start + 1) !== -1) return;
    const source = nativeRoomObservation(hit.snippet);
    if (!source) return;
    const reference = "room_native_" + createHash("sha256")
      .update(JSON.stringify([hit.messageId, hit.authorActorId, hit.toolEvidence.callId, hit.snippet])).digest("hex");
    const result = source.result;
    const summary = JSON.stringify({ version: 1, historical: true,
      notice: "Historical native control collection omitted from this model view; retrieve exact evidence when needed.",
      warning: NATIVE_HISTORY_WARNING, presentation: source.presentation, evidence: result.evidence,
      completeness: result.completeness, verification: result.verification, outcome: result.outcome,
      controlCollection: { completeness: result.controlCollection!.completeness,
        received: result.controlCollection!.received, omitted: result.controlCollection!.omitted },
      retrieve: { tool: "computer_observe", args: { historyRoomRef: reference } } });
    const replacement = formatTranscriptLine({ displayName: hit.authorDisplayName, handle: hit.handle, ts: hit.ts,
      content: summary, ...(hit.reactions ? { reactions: hit.reactions } : {}) });
    if (replacement.length >= line.length) return;
    sources.set(reference, source);
    edits.push({ start, end, replacement });
  });
  let projected = canonicalBody;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    projected = projected.slice(0, edit.start) + edit.replacement + projected.slice(edit.end);
  }
  let active = true;
  return {
    project(message) {
      if (!active || signal?.aborted || projected === canonicalBody || !HumanMessage.isInstance(message)
        || message.additional_kwargs["nautilo_room_context_budgeted"] !== true || message.content !== canonicalBody) return null;
      return projected;
    },
    read(reference) {
      if (!active || signal?.aborted) return null;
      const source = sources.get(reference);
      return source ? { text: JSON.stringify({ version: 1, historical: true, sourceRoomRef: reference,
        warning: NATIVE_HISTORY_WARNING, observation: source.result }) } : null;
    },
    close() { active = false; sources.clear(); canonicalBody = ""; projected = ""; },
  };
}
