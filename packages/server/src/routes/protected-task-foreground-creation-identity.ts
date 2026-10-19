import { createHash } from "node:crypto";
import type { TaskCreationInvocationProvenance, TaskToolRuntime } from "@nautilo/agent";
import { encodeTaskPayloadV1, fingerprintTaskOperationalMetadataV1 } from "@nautilo/lattice-bridge";
import type { ProtectedTaskCreationPlanV1, TaskCreateInput } from "@nautilo/runtime";
import { assertProtectedTaskOperationalMetadataProjectionV1, classifyProtectedTaskMetadataV1 } from "@nautilo/types";

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function trustedForegroundEffectDigest(input: Readonly<{
  invocation: TaskCreationInvocationProvenance | null;
  requestorId: string;
  agentId: string;
  callingRoomId: string | null;
}>): Readonly<{ effectDigest: string; timeReferenceMs: number }> {
  const { invocation } = input;
  const effect = invocation?.effect;
  if (invocation === null || effect === undefined || (invocation.entrypoint !== "foreground.main"
    && invocation.entrypoint !== "foreground.fork")
    || invocation.ownerId !== input.requestorId || invocation.roomId !== input.callingRoomId
    || !effect.turnId || !effect.toolCallId || !Number.isSafeInteger(effect.timeReferenceMs)
    || effect.timeReferenceMs < 0) throw new TypeError("Protected Task operation needs its trusted checkpointed tool effect");
  return Object.freeze({
    effectDigest: createHash("sha256").update("nautilo/task-foreground-effect/v1\0")
      .update(JSON.stringify([invocation.ownerId, invocation.roomId, input.agentId,
        invocation.entrypoint, effect.turnId, effect.toolCallId])).digest("hex"),
    timeReferenceMs: effect.timeReferenceMs,
  });
}

/** Only the trusted invocation boundary supplies the checkpointed tool effect.
 * Renewed grants and fresh ciphertext never change this creation identity. */
export function protectedTaskForegroundCreationIdentity(input: Readonly<{
  invocation: TaskCreationInvocationProvenance | null;
  prepared: Pick<ProtectedTaskCreationPlanV1, "canonicalTaskIdentity" | "payload" | "operationalMetadata">;
  candidate: TaskCreateInput;
}>) {
  const { invocation, prepared, candidate: c } = input;
  const { effectDigest, timeReferenceMs } = trustedForegroundEffectDigest({ invocation,
    requestorId: c.requestorId, agentId: c.agentId, callingRoomId: c.callingRoomId ?? null });
  assertProtectedTaskOperationalMetadataProjectionV1(prepared.operationalMetadata);
  const payload = encodeTaskPayloadV1(prepared.payload);
  const metadata = fingerprintTaskOperationalMetadataV1(prepared.operationalMetadata);
  try {
    const operational = {
      ...prepared.canonicalTaskIdentity, preset: c.preset ?? "task",
      scheduleKind: c.scheduleKind ?? "now", runAt: c.runAt?.toISOString() ?? null,
      cron: c.cron ?? null, timezone: c.timezone ?? "UTC", callingRoomId: c.callingRoomId ?? null,
      targetChat: c.targetChat ?? "orphan", targetChatHandle: c.targetChatHandle ?? null,
      targetRoomId: c.targetRoomId ?? null, resultDelivery: c.resultDelivery ?? "wake",
      targetUserIds: c.targetUserIds ?? [], useScope: c.useScope ?? false, scopeId: c.scopeId ?? null,
      toolsMode: c.toolsMode ?? "auto", toolsWhitelist: c.toolsWhitelist ?? [],
      awaitResponse: c.awaitResponse ?? false, selectionProfile: c.selectionProfile ?? "balanced",
      selectionSpec: c.selectionSpec ?? null, requestedModelId: c.requestedModelId ?? null,
      timeLimitSeconds: c.timeLimitSeconds ?? null, parentTaskId: c.parentTaskId ?? null,
      depth: c.depth ?? 0, timeReferenceMs,
    };
    const digest = createHash("sha256").update("nautilo/task-foreground-definition/v1\0")
      .update(effectDigest).update(JSON.stringify(canonical(operational))).update(payload).update(metadata).digest();
    const workDescriptorDigest = Uint8Array.from(digest);
    // RFC 9562 custom-name UUID: no randomized ciphertext or transient grant fields.
    digest[6] = (digest[6]! & 0x0f) | 0x80;
    digest[8] = (digest[8]! & 0x3f) | 0x80;
    const hex = digest.subarray(0, 16).toString("hex");
    digest.fill(0);
    return Object.freeze({ taskId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
      operationId: `task-foreground-effect:${effectDigest}`, scheduleReference: new Date(timeReferenceMs),
      workDescriptorDigest });
  } finally { payload.fill(0); metadata.fill(0); }
}

/** Stable private publication identity for one trusted foreground Task edit.
 * The Task coordinate prevents one captured tool effect from crossing Tasks. */
export function protectedTaskForegroundUpdateIdentity(input: Readonly<{
  invocation: TaskCreationInvocationProvenance | null;
  taskId: string;
  requestorId: string;
  agentId: string;
  callingRoomId: string | null;
  source?: Readonly<{ contentRevision: number; mutationVersion: string }>;
  request?: Parameters<NonNullable<TaskToolRuntime["updateProtectedTask"]>>[0];
}>): Readonly<{ operationId: string; workDescriptorDigest: Uint8Array }> {
  const { effectDigest } = trustedForegroundEffectDigest(input);
  const digest = createHash("sha256").update("nautilo/task-foreground-update/v1\0")
    .update(effectDigest).update("\0").update(input.taskId).digest("hex");
  const workDescriptorDigest = Uint8Array.from(createHash("sha256")
    .update("nautilo/task-foreground-update-work/v1\0")
    .update(JSON.stringify([digest, input.source?.contentRevision ?? null,
      input.source?.mutationVersion ?? null, canonical(input.request ?? null)])).digest());
  return Object.freeze({ operationId: `task-foreground-update:${digest}`, workDescriptorDigest });
}

/** Discover the exact lock coordinate before holding any Room locks. The
 * real protected admission must still prove this same source before writing. */
export function protectedTaskForegroundCreationCandidateIdentity(input: Readonly<{
  invocation: TaskCreationInvocationProvenance | null; candidate: TaskCreateInput;
}>) {
  const metadata = classifyProtectedTaskMetadataV1(input.candidate.metadata ?? {});
  if (metadata.status !== "supported") throw new TypeError("Protected Task creation metadata is unsupported");
  return protectedTaskForegroundCreationIdentity({ ...input, prepared: {
    canonicalTaskIdentity: { ownerId: input.candidate.requestorId, requestorId: input.candidate.requestorId,
      agentId: input.candidate.agentId },
    payload: { formatVersion: 1, prompt: input.candidate.prompt, expectedOutput: input.candidate.expectedOutput ?? null,
      protectedMetadata: metadata.protectedContent }, operationalMetadata: metadata.operational,
  } });
}
