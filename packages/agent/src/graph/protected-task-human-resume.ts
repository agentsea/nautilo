import { Command } from "@langchain/langgraph";
import type { ApprovalReplyVerb } from "@nautilo/types";
import type { MemoryAccessEnvelope } from "@nautilo/trust";

import type { NautiloState } from "../agent/state";
import { identityEnrollmentToolCallIds } from "./protected-memory-resume-deps";
import {
  interruptValueToServerEvent,
  isRetiredBrokerApprovalInterrupt,
  protectedTaskInterruptCoordinates,
} from "./interrupt-mapping";

export type ProtectedTaskHumanResumeBindingV1 =
  | Readonly<{
      kind: "approval";
      interruptId: string;
      requestId: string;
      verb: ApprovalReplyVerb;
    }>
  | Readonly<{
      kind: "prove_it";
      interruptId: string;
      approved: boolean;
    }>
  | Readonly<{
      kind: "identity";
      interruptId: string;
      requestId?: string;
      verified: true;
    }>
  | Readonly<{
      kind: "await_reply";
      interruptId: string;
      reply: string;
      fromUserId: string;
    }>;

export type ProtectedTaskHumanResumeContextV1 = Readonly<{
  taskId: string;
  taskRunId: string;
  graphThreadId: string;
  ownerId: string;
  causalHumanUserId: string;
  agentId: string;
  roomId: string;
  callingRoomId: string;
  actorRole: string;
  approvalLaneKey: string;
  memoryAccessEnvelope: MemoryAccessEnvelope;
  relayCapabilities: NautiloState["relayCapabilities"];
}>;

type ProtectedTaskGraphState = Readonly<{
  values?: unknown;
  tasks?: readonly unknown[];
}> | undefined;

const BINDING_KEYS = Object.freeze({
  approval: ["interruptId", "kind", "requestId", "verb"].sort(),
  prove_it: ["approved", "interruptId", "kind"].sort(),
  identityWithRequest: [
    "interruptId",
    "kind",
    "requestId",
    "verified",
  ].sort(),
  identityWithoutRequest: ["interruptId", "kind", "verified"].sort(),
  await_reply: ["fromUserId", "interruptId", "kind", "reply"].sort(),
});

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).sort().join(",") === keys.join(",");
}

function exactBinding(binding: ProtectedTaskHumanResumeBindingV1): void {
  const value = record(binding);
  if (!value || !nonEmpty(value["interruptId"])) {
    throw new TypeError("Protected Task Human resume binding is invalid");
  }
  if (binding.kind === "approval") {
    if (!exactKeys(value, BINDING_KEYS.approval)
      || !nonEmpty(binding.requestId)
      || (binding.verb !== "once" && binding.verb !== "room"
        && binding.verb !== "always" && binding.verb !== "deny")) {
      throw new TypeError("Protected Task Human resume binding is invalid");
    }
    return;
  }
  if (binding.kind === "prove_it") {
    if (!exactKeys(value, BINDING_KEYS.prove_it)
      || typeof binding.approved !== "boolean") {
      throw new TypeError("Protected Task Human resume binding is invalid");
    }
    return;
  }
  if (binding.kind === "identity") {
    const keys = binding.requestId === undefined
      ? BINDING_KEYS.identityWithoutRequest
      : BINDING_KEYS.identityWithRequest;
    if (!exactKeys(value, keys)
      || (binding.requestId !== undefined && !nonEmpty(binding.requestId))
      || binding.verified !== true) {
      throw new TypeError("Protected Task Human resume binding is invalid");
    }
    return;
  }
  if (binding.kind === "await_reply") {
    if (!exactKeys(value, BINDING_KEYS.await_reply)
      || !nonEmpty(binding.reply)
      || !nonEmpty(binding.fromUserId)) {
      throw new TypeError("Protected Task Human resume binding is invalid");
    }
    return;
  }
  throw new TypeError("Protected Task Human resume binding is invalid");
}

function assertGraphIdentity(
  state: ProtectedTaskGraphState,
  context: ProtectedTaskHumanResumeContextV1,
): Partial<NautiloState> {
  const values = record(state?.values) as Partial<NautiloState> | undefined;
  if (!values
    || values.taskRun !== true
    || values.subagentRun !== true
    || values.trustedExecutionEntrypoint !== "background.task"
    || values.currentTaskId !== context.taskId
    || values.currentTaskRunId !== context.taskRunId
    || values.currentThreadId !== context.graphThreadId
    || values.langgraphThreadId !== context.graphThreadId
    || values.turnId !== context.taskRunId
    || values.userId !== context.ownerId
    || values.causalHumanUserId !== context.causalHumanUserId
    || values.agentId !== context.agentId
    || values.roomId !== context.roomId
    || values.callingRoomId !== context.callingRoomId
    || values.actorRole !== context.actorRole
    || values.approvalLaneKey !== context.approvalLaneKey
    || context.memoryAccessEnvelope.ownerId !== context.causalHumanUserId
    || context.memoryAccessEnvelope.agentId !== context.agentId
    || context.memoryAccessEnvelope.roomId !== context.roomId) {
    throw new TypeError(
      "Protected Task Human resume requires the exact parked graph identity",
    );
  }
  return values;
}

function interruptValue(
  state: ProtectedTaskGraphState,
  interruptId: string,
): Record<string, unknown> {
  const matches: Record<string, unknown>[] = [];
  for (const candidateTask of state?.tasks ?? []) {
    const task = record(candidateTask);
    const interrupts = task?.["interrupts"];
    if (!Array.isArray(interrupts)) continue;
    for (const candidate of interrupts) {
      const interrupt = record(candidate);
      if (interrupt?.["id"] !== interruptId) continue;
      const value = record(interrupt["value"]);
      if (!value) {
        throw new TypeError("Protected Task Human interrupt is malformed");
      }
      matches.push(value);
    }
  }
  if (matches.length !== 1) {
    throw new TypeError(
      "Protected Task Human resume requires one exact pending interrupt",
    );
  }
  return matches[0]!;
}

function exactPendingInterrupt(
  state: ProtectedTaskGraphState,
  binding: ProtectedTaskHumanResumeBindingV1,
): Record<string, unknown> {
  const coordinate = protectedTaskInterruptCoordinates({
    tasks: (state?.tasks ?? []).map(candidate => record(candidate) ?? {}),
  })
    .filter(candidate => candidate.id === binding.interruptId);
  if (coordinate.length !== 1 || coordinate[0]!.kind !== binding.kind) {
    throw new TypeError(
      "Protected Task Human resume does not match the pending interrupt",
    );
  }
  const requestId = "requestId" in binding ? binding.requestId : undefined;
  if (coordinate[0]!.requestId !== requestId) {
    throw new TypeError(
      "Protected Task Human resume does not match the pending request",
    );
  }
  return interruptValue(state, binding.interruptId);
}

function approvalPayload(
  value: Record<string, unknown>,
  binding: Extract<ProtectedTaskHumanResumeBindingV1, { kind: "approval" }>,
  context: ProtectedTaskHumanResumeContextV1,
): Record<string, unknown> {
  const event = interruptValueToServerEvent(
    value,
    context.graphThreadId,
    context.approvalLaneKey,
  );
  if (event?.type !== "approval.ask"
    || event.approvalId !== binding.requestId) {
    throw new TypeError(
      "Protected Task Human approval does not match the pending request",
    );
  }
  if ((isRetiredBrokerApprovalInterrupt(value)
    || binding.requestId.startsWith("github-publish:"))
    && binding.verb !== "deny") {
    throw new TypeError(
      "Protected Task Human retired broker approval is no longer available",
    );
  }
  if (!event.allowedVerbs.includes(binding.verb)) {
    throw new TypeError(
      "Protected Task Human approval does not match the pending request",
    );
  }
  const specialCount = [
    event.localMcpInstall,
    event.mediaGeneration,
    event.structuredSsh,
  ].filter(candidate => candidate !== undefined).length;
  if (specialCount > 1) {
    throw new TypeError("Protected Task Human approval is ambiguous");
  }
  return Object.freeze({
    approved: binding.verb !== "deny",
    verb: binding.verb,
    ...(event.localMcpInstall === undefined ? {} : {
      localMcpInstallApprovalId: event.approvalId,
      localMcpInstallDigest: event.localMcpInstall.digest,
      localMcpInstallLaneKey: context.approvalLaneKey,
    }),
    ...(event.mediaGeneration === undefined ? {} : {
      mediaGenerationApprovalId: event.approvalId,
      mediaGenerationDigest: event.mediaGeneration.digest,
      mediaGenerationQuoteDigest: event.mediaGeneration.quoteDigest,
      mediaGenerationLaneKey: context.approvalLaneKey,
      mediaGenerationRevision: event.mediaGeneration.revision,
    }),
    ...(event.structuredSsh === undefined ? {} : {
      structuredSshApprovalId: event.structuredSsh.preparationId,
    }),
  });
}

function resumePayload(
  value: Record<string, unknown>,
  binding: ProtectedTaskHumanResumeBindingV1,
  context: ProtectedTaskHumanResumeContextV1,
): Record<string, unknown> {
  if (binding.kind === "approval") {
    return approvalPayload(value, binding, context);
  }
  if (binding.kind === "prove_it") {
    return Object.freeze({ approved: binding.approved });
  }
  if (binding.kind === "identity") {
    return Object.freeze({ verified: true });
  }
  const awaitingFromUserIds = value["awaitingFromUserIds"];
  if (value["type"] !== "await_human_reply"
    || value["taskId"] !== context.taskId
    || value["taskRunId"] !== context.taskRunId
    || value["ownerId"] !== context.ownerId
    || value["targetRoomId"] !== context.roomId
    || !Array.isArray(awaitingFromUserIds)
    || !awaitingFromUserIds.every(candidate => nonEmpty(candidate))
    || !awaitingFromUserIds.includes(binding.fromUserId)) {
    throw new TypeError(
      "Protected Task Human reply does not match the pending request",
    );
  }
  return Object.freeze({ reply: binding.reply, fromUserId: binding.fromUserId });
}

/**
 * Re-enter one exact Human interrupt on the original protected Task graph.
 * The reply is interrupt-keyed, while authority-bearing state is replaced by
 * values reconstructed from the fresh segment grant before the resumed node
 * may continue. No messages or prior node output are rebuilt.
 */
export function createProtectedTaskHumanResumeCommandV1(
  state: ProtectedTaskGraphState,
  binding: ProtectedTaskHumanResumeBindingV1,
  context: ProtectedTaskHumanResumeContextV1,
): Command<unknown, Partial<NautiloState>, never> {
  exactBinding(binding);
  assertGraphIdentity(state, context);
  const value = exactPendingInterrupt(state, binding);
  const payload = resumePayload(value, binding, context);
  const enrollmentToolCallIds = binding.kind === "identity"
    ? identityEnrollmentToolCallIds(state)
    : [];
  return new Command<unknown, Partial<NautiloState>, never>({
    resume: Object.freeze({ [binding.interruptId]: payload }),
    update: {
      memoryAccessEnvelope: structuredClone(context.memoryAccessEnvelope),
      // An explicit empty map revokes capabilities when the fresh segment has
      // no Relay. An `undefined` update may be treated as no channel write by
      // LangGraph and would leave the checkpoint's prior capabilities live.
      relayCapabilities: Object.freeze({
        ...(context.relayCapabilities ?? {}),
      }),
      ...(enrollmentToolCallIds.length === 0 ? {} : {
        identityEnrollmentToolCallIds: [...enrollmentToolCallIds],
      }),
    },
  });
}
