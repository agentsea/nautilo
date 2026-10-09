import { createHash } from "node:crypto";
import type { ToolCall } from "@langchain/core/messages/tool";
import type { ShareMemoryApprovalPreview } from "@nautilo/types";
import {
  describeProtectedMemoryUnavailable,
  type ProtectedAgentMemoryAccessApprovalPreview,
  type ProtectedAgentMemoryAccessApprovalReference,
  type ProtectedAgentMemoryAccessPort,
} from "@nautilo/lattice-bridge";

import type { NautiloState } from "../../agent/state";
import {
  collapseWhitespaceShareApprovalSnippet,
  normalizeShareTargetHandle,
  resolveLocalShareTargetByHandle,
  resolveShareApprovalTargetRoomPreview,
} from "../../post-model/share-approval-preview";
import { protectedMemoryAuthorityFromEnvelope } from "./protected-memory-authority";
import {
  protectedMemoryToolOperationId,
  ProtectedMemoryToolUnavailableError,
} from "./protected-memory-ports";
import { isProjectionLikeShareCall } from "./projection-sharing";
import { parseShareMemoryInput } from "./share-memory";

export type ProtectedMemoryAccessSnapshot = Readonly<{
  snapshotVersion: 1;
  kind: "protected_task_access";
  toolCallId: string;
  requesterUserId: string;
  requesterActorId: string;
  agentId: string;
  requestDigest: string;
  reference: ProtectedAgentMemoryAccessApprovalReference;
}>;

export type ProtectedMemoryAccessPreflightResult = Readonly<{
  snapshots: readonly ProtectedMemoryAccessSnapshot[];
  rejectedToolCallIds: readonly string[];
  messages: readonly Readonly<{ toolCallId: string; content: string }>[];
}>;

type PreviewCacheBinding = Readonly<{
  toolCallId: string;
  requesterUserId: string;
  requesterActorId: string;
  agentId: string;
  requestDigest: string;
  referenceVersion: 1;
  referenceId: string;
  createdAt: number;
  sealedPreparation: string;
}>;

type PreviewCacheEntry = Readonly<{
  binding: PreviewCacheBinding;
  preview: ShareMemoryApprovalPreview;
}>;

const previewsByPort = new WeakMap<
  ProtectedAgentMemoryAccessPort,
  Map<string, PreviewCacheEntry>
>();

/** Retain previews only for the active preflight or resumed approval batch. */
export function beginProtectedMemoryAccessPreviewBatch(
  port: ProtectedAgentMemoryAccessPort,
): void {
  previewsByPort.set(port, new Map<string, PreviewCacheEntry>());
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

function validTaskReference(
  reference: ProtectedAgentMemoryAccessApprovalReference,
): boolean {
  const referenceRecord = record(reference);
  const continuation = record(reference.taskContinuation);
  return referenceRecord !== null
    && exactKeys(referenceRecord, [
      "agentId",
      "referenceId",
      "referenceVersion",
      "requesterUserId",
      "taskContinuation",
      "toolCallId",
    ])
    && reference.referenceVersion === 1
    && reference.referenceId.length > 0
    && reference.toolCallId.length > 0
    && reference.requesterUserId.length > 0
    && reference.agentId.length > 0
    && continuation !== null
    && exactKeys(continuation, [
      "createdAt",
      "kind",
      "requesterActorId",
      "sealedPreparation",
    ])
    && reference.taskContinuation?.kind === "protected_task_v1"
    && reference.taskContinuation.requesterActorId.length > 0
    && Number.isSafeInteger(reference.taskContinuation.createdAt)
    && reference.taskContinuation.createdAt >= 0
    && reference.taskContinuation.createdAt <= Date.now()
    && reference.taskContinuation.sealedPreparation.length > 0;
}

function taskRequester(
  state: NautiloState,
): Readonly<{
  authority: NonNullable<ReturnType<typeof protectedMemoryAuthorityFromEnvelope>>;
  requesterActorId: string;
}> | null {
  const authority = protectedMemoryAuthorityFromEnvelope(state.memoryAccessEnvelope);
  if (
    authority === null
    || state.taskRun !== true
    || state.subagentRun !== true
    || state.trustedExecutionEntrypoint !== "background.task"
    || !state.currentTaskId
    || !state.currentTaskRunId
    || !state.currentThreadId
    || state.currentThreadId !== state.langgraphThreadId
    || !state.memoryAccessEnvelope?.actorId
    || state.causalHumanUserId !== authority.subjectUserId
  ) return null;
  return Object.freeze({
    authority,
    requesterActorId: state.memoryAccessEnvelope.actorId,
  });
}

function exactSnapshot(
  state: NautiloState,
  snapshot: ProtectedMemoryAccessSnapshot,
  call: ToolCall,
): boolean {
  const requester = taskRequester(state);
  const digest = protectedMemoryAccessRequestDigest(call);
  return requester !== null
    && digest !== null
    && snapshot.snapshotVersion === 1
    && snapshot.kind === "protected_task_access"
    && snapshot.toolCallId === call.id
    && snapshot.requestDigest === digest
    && snapshot.requesterUserId === requester.authority.subjectUserId
    && snapshot.requesterActorId === requester.requesterActorId
    && snapshot.agentId === requester.authority.agentId
    && snapshot.reference.toolCallId === snapshot.toolCallId
    && snapshot.reference.requesterUserId === snapshot.requesterUserId
    && snapshot.reference.agentId === snapshot.agentId
    && snapshot.reference.taskContinuation?.requesterActorId
      === snapshot.requesterActorId
    && validTaskReference(snapshot.reference);
}

/** Content-free checkpoint binding for the exact attach request. */
export function protectedMemoryAccessRequestDigest(
  call: Pick<ToolCall, "id" | "name" | "args">,
): string | null {
  if (call.name !== "share_memory" || typeof call.id !== "string") return null;
  const parsed = parseShareMemoryInput(call.args);
  if (
    !parsed.ok
    || parsed.value.mode === "project"
    || parsed.value.target_handle === undefined
  ) return null;
  const handle = normalizeShareTargetHandle(parsed.value.target_handle);
  if (!handle) return null;
  const operationId = protectedMemoryToolOperationId({
    requestId: call.id,
    action: "grant_user",
    subjectId: parsed.value.memory_id,
  });
  return createHash("sha256").update(JSON.stringify({
    domain: "nautilo/protected-task-memory-access-request/v1",
    operationId,
    toolCallId: call.id,
    memoryId: parsed.value.memory_id,
    action: { kind: "grant_user", userHandle: handle },
    sensitivity: parsed.value.sensitivity,
  }), "utf8").digest("hex");
}

async function publicPreview(
  preview: ProtectedAgentMemoryAccessApprovalPreview,
  requesterUserId: string,
  agentId: string,
  rawHandle: string,
  sensitivity: "normal" | "sensitive",
): Promise<ShareMemoryApprovalPreview> {
  const handle = normalizeShareTargetHandle(rawHandle);
  const target = await resolveLocalShareTargetByHandle(handle);
  const room = await resolveShareApprovalTargetRoomPreview({
    agentId,
    requesterUserId,
    handle,
    rosterRow: target
      ? { userId: target.userId, displayName: target.displayName }
      : null,
  });
  return Object.freeze({
    protectedApprovalDigest: "",
    memoryContentSnippet: collapseWhitespaceShareApprovalSnippet(
      preview.content,
    ),
    memoryType: preview.type,
    targetHandle: handle,
    targetDisplayName: room.targetDisplayName,
    roomLabel: room.roomLabel,
    wouldCreate: room.wouldCreate,
    sensitivity,
  });
}

function bindPreview(
  port: ProtectedAgentMemoryAccessPort,
  snapshot: ProtectedMemoryAccessSnapshot,
  preview: ShareMemoryApprovalPreview,
): void {
  if (snapshot.reference.taskContinuation === undefined
    || !exactSnapshotReference(snapshot)) {
    throw new TypeError("Protected Task Memory access reference is invalid");
  }
  const previews = previewsByPort.get(port)
    ?? new Map<string, PreviewCacheEntry>();
  previewsByPort.set(port, previews);
  const continuation = snapshot.reference.taskContinuation;
  previews.set(snapshot.reference.referenceId, Object.freeze({
    binding: Object.freeze({
      toolCallId: snapshot.toolCallId,
      requesterUserId: snapshot.requesterUserId,
      requesterActorId: snapshot.requesterActorId,
      agentId: snapshot.agentId,
      requestDigest: snapshot.requestDigest,
      referenceVersion: snapshot.reference.referenceVersion,
      referenceId: snapshot.reference.referenceId,
      createdAt: continuation.createdAt,
      sealedPreparation: continuation.sealedPreparation,
    }),
    preview: Object.freeze({
      ...preview,
      protectedApprovalDigest: snapshot.reference.referenceId,
    }),
  }));
}

function samePreviewBinding(
  snapshot: ProtectedMemoryAccessSnapshot,
  binding: PreviewCacheBinding,
): boolean {
  const continuation = snapshot.reference.taskContinuation;
  return continuation?.kind === "protected_task_v1"
    && binding.toolCallId === snapshot.toolCallId
    && binding.requesterUserId === snapshot.requesterUserId
    && binding.requesterActorId === snapshot.requesterActorId
    && binding.agentId === snapshot.agentId
    && binding.requestDigest === snapshot.requestDigest
    && binding.referenceVersion === snapshot.reference.referenceVersion
    && binding.referenceId === snapshot.reference.referenceId
    && binding.createdAt === continuation.createdAt
    && binding.sealedPreparation === continuation.sealedPreparation;
}

/**
 * A categorical denial replays the already-authenticated checkpoint only far
 * enough for LangGraph to consume the matching interrupt. It must not require
 * the source Memory or recipient to remain readable, because no effect can
 * follow that denial.
 */
export function bindDeniedProtectedMemoryAccessSnapshot(
  state: NautiloState,
  call: ToolCall,
  snapshot: ProtectedMemoryAccessSnapshot,
  candidate: unknown,
  port: ProtectedAgentMemoryAccessPort,
): void {
  const parsed = parseShareMemoryInput(call.args);
  const preview = record(candidate);
  const expectedKeys = [
    "memoryContentSnippet",
    "memoryType",
    "protectedApprovalDigest",
    "roomLabel",
    "sensitivity",
    "targetDisplayName",
    "targetHandle",
    "wouldCreate",
  ];
  if (
    !exactSnapshot(state, snapshot, call)
    || !parsed.ok
    || parsed.value.mode === "project"
    || parsed.value.target_handle === undefined
    || preview === null
    || !exactKeys(preview, expectedKeys)
    || preview["protectedApprovalDigest"] !== snapshot.reference.referenceId
    || typeof preview["memoryContentSnippet"] !== "string"
    || (preview["memoryType"] !== null
      && typeof preview["memoryType"] !== "string")
    || preview["targetHandle"]
      !== normalizeShareTargetHandle(parsed.value.target_handle)
    || typeof preview["targetDisplayName"] !== "string"
    || (preview["roomLabel"] !== null
      && typeof preview["roomLabel"] !== "string")
    || typeof preview["wouldCreate"] !== "boolean"
    || preview["sensitivity"] !== parsed.value.sensitivity
  ) {
    throw new TypeError("Protected Task Memory denial checkpoint is invalid");
  }
  bindPreview(port, snapshot, Object.freeze({
    protectedApprovalDigest: preview["protectedApprovalDigest"],
    memoryContentSnippet: preview["memoryContentSnippet"],
    memoryType: preview["memoryType"],
    targetHandle: preview["targetHandle"],
    targetDisplayName: preview["targetDisplayName"],
    roomLabel: preview["roomLabel"],
    wouldCreate: preview["wouldCreate"],
    sensitivity: preview["sensitivity"],
  } as ShareMemoryApprovalPreview));
}

function exactSnapshotReference(snapshot: ProtectedMemoryAccessSnapshot): boolean {
  return /^[0-9a-f]{64}$/u.test(snapshot.requestDigest)
    && snapshot.reference.toolCallId === snapshot.toolCallId
    && snapshot.reference.requesterUserId === snapshot.requesterUserId
    && snapshot.reference.agentId === snapshot.agentId
    && snapshot.reference.taskContinuation?.requesterActorId
      === snapshot.requesterActorId
    && validTaskReference(snapshot.reference);
}

export function findProtectedMemoryAccessSnapshot(
  state: Pick<NautiloState, "protectedMemoryAccessSnapshots">,
  call: Pick<ToolCall, "id" | "name" | "args">,
): ProtectedMemoryAccessSnapshot | null {
  const digest = protectedMemoryAccessRequestDigest(call);
  if (digest === null) return null;
  return state.protectedMemoryAccessSnapshots?.find(snapshot =>
    snapshot.toolCallId === call.id && snapshot.requestDigest === digest
  ) ?? null;
}

export function protectedMemoryAccessApprovalPreview(
  snapshot: ProtectedMemoryAccessSnapshot,
  port: ProtectedAgentMemoryAccessPort,
): ShareMemoryApprovalPreview | null {
  if (snapshot.reference.taskContinuation === undefined
    || !exactSnapshotReference(snapshot)) return null;
  const cached = previewsByPort.get(port)?.get(snapshot.reference.referenceId);
  return cached !== undefined && samePreviewBinding(snapshot, cached.binding)
    ? cached.preview
    : null;
}

async function prepareCall(
  state: NautiloState,
  call: ToolCall,
  port: ProtectedAgentMemoryAccessPort,
): Promise<Readonly<{
  snapshot: ProtectedMemoryAccessSnapshot;
  preview: ShareMemoryApprovalPreview;
}> | null> {
  const toolCallId = typeof call.id === "string" ? call.id : "";
  const parsed = parseShareMemoryInput(call.args);
  const requester = taskRequester(state);
  if (
    !toolCallId
    || !parsed.ok
    || parsed.value.mode === "project"
    || parsed.value.target_handle === undefined
    || requester === null
    || port.prepareApproval === undefined
    || port.restoreApproval === undefined
  ) return null;
  const handle = normalizeShareTargetHandle(parsed.value.target_handle);
  if (!handle) return null;
  const prepared = await port.prepareApproval({
    operationId: protectedMemoryToolOperationId({
      requestId: toolCallId,
      action: "grant_user",
      subjectId: parsed.value.memory_id,
    }),
    toolCallId,
    authority: requester.authority,
    memoryId: parsed.value.memory_id,
    action: { kind: "grant_user", userHandle: handle },
  });
  if (prepared.status === "unavailable") {
    throw new ProtectedMemoryToolUnavailableError(prepared.reason);
  }
  const reference = prepared.value.reference;
  if (
    reference.toolCallId !== toolCallId
    || reference.requesterUserId !== requester.authority.subjectUserId
    || reference.agentId !== requester.authority.agentId
    || reference.taskContinuation?.requesterActorId
      !== requester.requesterActorId
    || !validTaskReference(reference)
  ) throw new TypeError("Protected Task Memory access preview was substituted");
  const snapshot = Object.freeze({
    snapshotVersion: 1 as const,
    kind: "protected_task_access" as const,
    toolCallId,
    requesterUserId: reference.requesterUserId,
    requesterActorId: requester.requesterActorId,
    agentId: reference.agentId,
    requestDigest: protectedMemoryAccessRequestDigest(call)!,
    reference,
  });
  const preview = await publicPreview(
    prepared.value.preview,
    reference.requesterUserId,
    reference.agentId,
    handle,
    parsed.value.sensitivity,
  );
  bindPreview(port, snapshot, preview);
  return Object.freeze({ snapshot, preview });
}

export async function preflightProtectedMemoryAccessShareCalls(
  state: NautiloState,
  toolCalls: readonly ToolCall[],
  port: ProtectedAgentMemoryAccessPort,
): Promise<ProtectedMemoryAccessPreflightResult> {
  beginProtectedMemoryAccessPreviewBatch(port);
  const snapshots: ProtectedMemoryAccessSnapshot[] = [];
  const rejectedToolCallIds: string[] = [];
  const messages: Array<{ toolCallId: string; content: string }> = [];
  const siblingIdCounts = new Map<string, number>();
  for (const call of toolCalls) {
    if (typeof call.id !== "string" || call.id.length === 0) continue;
    siblingIdCounts.set(call.id, (siblingIdCounts.get(call.id) ?? 0) + 1);
  }
  const rejectedAmbiguousIds = new Set<string>();
  for (const call of toolCalls) {
    if (call.name !== "share_memory" || isProjectionLikeShareCall(call)) continue;
    const toolCallId = typeof call.id === "string" ? call.id : "";
    if (!toolCallId) continue;
    if ((siblingIdCounts.get(toolCallId) ?? 0) > 1) {
      if (!rejectedAmbiguousIds.has(toolCallId)) {
        rejectedAmbiguousIds.add(toolCallId);
        rejectedToolCallIds.push(toolCallId);
        messages.push({
          toolCallId,
          content: "Cannot share Memory: the tool-call identity is ambiguous. Start a fresh request; no sharing operation was executed.",
        });
      }
      continue;
    }
    try {
      const prepared = await prepareCall(state, call, port);
      if (prepared === null) {
        throw new TypeError("current protected authorization is unavailable");
      }
      snapshots.push(prepared.snapshot);
    } catch (error) {
      rejectedToolCallIds.push(toolCallId);
      messages.push({
        toolCallId,
        content: `Cannot share Memory: ${
          error instanceof ProtectedMemoryToolUnavailableError
            ? describeProtectedMemoryUnavailable(error.reason)
            : "protected preparation failed"
        }. No sharing operation was executed.`,
      });
    }
  }
  return Object.freeze({ snapshots, rejectedToolCallIds, messages });
}

export async function restoreProtectedMemoryAccessSnapshot(
  state: NautiloState,
  call: ToolCall,
  snapshot: ProtectedMemoryAccessSnapshot,
  port: ProtectedAgentMemoryAccessPort,
): Promise<void> {
  const parsed = parseShareMemoryInput(call.args);
  if (
    !exactSnapshot(state, snapshot, call)
    || !parsed.ok
    || parsed.value.mode === "project"
    || parsed.value.target_handle === undefined
    || port.restoreApproval === undefined
  ) throw new TypeError("Protected Task Memory access checkpoint is invalid");
  const requester = taskRequester(state);
  if (requester === null) {
    throw new TypeError("Protected Task Memory access authority is unavailable");
  }
  const restored = await port.restoreApproval({
    authority: requester.authority,
    reference: snapshot.reference,
    memoryId: parsed.value.memory_id,
    action: {
      kind: "grant_user",
      userHandle: normalizeShareTargetHandle(parsed.value.target_handle),
    },
  });
  if (restored.status === "unavailable") {
    throw new TypeError("Protected Task Memory access approval is unavailable");
  }
  const preview = await publicPreview(
    restored.value,
    snapshot.requesterUserId,
    snapshot.agentId,
    parsed.value.target_handle,
    parsed.value.sensitivity,
  );
  bindPreview(port, snapshot, preview);
}
