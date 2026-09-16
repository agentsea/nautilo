import { createHash, randomUUID } from "node:crypto";
import type { BaseMessage } from "@langchain/core/messages";
import { ToolMessage } from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import {
  findActorByOwnerId,
  envelopeReadableNamespaces,
  findAuthorizedRoomNameCandidates,
  resolveAuthorizedRoomName,
  userHasCapability,
  type ResolvedRoomDestination,
  type RoomChoiceTokenCodec,
} from "@nautilo/trust";
import type { NautiloState } from "../../agent/state";
import {
  executeAtomicProjectionMemory,
  fingerprintProjectionReadableAuthority,
} from "../../store/memory-store";
import { SEARCH_MEMORY_PROVENANCE_HEADER } from "./search-memory";
import { describeProtectedMemoryUnavailable } from "@nautilo/lattice-bridge";
import { loadMemoryRowIfShareable, parseShareMemoryInput } from "./share-memory";
import { protectedMemoryAuthorityFromEnvelope } from "./protected-memory-authority";
import {
  protectedMemoryToolOperationId,
  type ProtectedAgentMemoryProjectionApprovalPreview,
  type ProtectedAgentMemoryProjectionPort,
  type ProtectedAgentMemoryProjectionReference,
} from "./protected-memory-ports";

const PROJECTION_SNAPSHOT_TTL_MS = 10 * 60 * 1_000;

export type ProjectionSourceFingerprint = Readonly<{ id: string; contentHash: string }>;

/** Trusted checkpoint-only data. Never copy this structure into a tool event. */
export type LegacyProjectionSnapshot = Readonly<{
  toolCallId: string;
  requesterUserId: string;
  /** Human Actor that initiated the approval; binds a shared Room resume. */
  requesterActorId: string;
  agentId: string;
  sourceFingerprints: readonly ProjectionSourceFingerprint[];
  /** Original readable envelope: source authority must not widen on resume. */
  readableNamespaceIds?: readonly string[];
  readableAuthorityFingerprint?: string;
  content: string;
  contentHash: string;
  destination: ResolvedRoomDestination;
  audienceFingerprint: string;
  createdAt: number;
  expiresAt: number;
  creationKey: string;
}>;

export type ProtectedProjectionSnapshot = Readonly<{
  kind: "protected";
  toolCallId: string;
  requesterUserId: string;
  requesterActorId: string;
  agentId: string;
  reference: ProtectedAgentMemoryProjectionReference;
}>;

export type ProjectionSnapshot = LegacyProjectionSnapshot
  | ProtectedProjectionSnapshot;

const protectedProjectionPreviewTokens = new Map<string, object>();
const protectedProjectionPreviews = new WeakMap<object, Readonly<{
  reference: ProtectedAgentMemoryProjectionReference;
  preview: ProtectedAgentMemoryProjectionApprovalPreview;
}>>();

function sameProtectedProjectionReference(
  left: ProtectedAgentMemoryProjectionReference,
  right: ProtectedAgentMemoryProjectionReference,
): boolean {
  return left.referenceVersion === right.referenceVersion
    && left.referenceId === right.referenceId
    && left.toolCallId === right.toolCallId
    && left.requesterUserId === right.requesterUserId
    && left.requesterActorId === right.requesterActorId
    && left.agentId === right.agentId
    && left.createdAt === right.createdAt
    && left.expiresAt === right.expiresAt
    && left.sealedPreparation === right.sealedPreparation;
}

function protectedProjectionPreview(
  snapshot: ProtectedProjectionSnapshot,
): ProtectedAgentMemoryProjectionApprovalPreview | undefined {
  const token = protectedProjectionPreviewTokens.get(
    snapshot.reference.referenceId,
  );
  const retained = token === undefined
    ? undefined
    : protectedProjectionPreviews.get(token);
  if (retained === undefined) {
    protectedProjectionPreviewTokens.delete(snapshot.reference.referenceId);
    return undefined;
  }
  if (retained.reference.expiresAt <= Date.now()) {
    protectedProjectionPreviewTokens.delete(snapshot.reference.referenceId);
    return undefined;
  }
  return sameProtectedProjectionReference(retained.reference, snapshot.reference)
    ? retained.preview
    : undefined;
}

export function bindProtectedProjectionReference(
  reference: ProtectedAgentMemoryProjectionReference,
  preview: ProtectedAgentMemoryProjectionApprovalPreview,
): ProtectedProjectionSnapshot {
  for (const [referenceId, token] of protectedProjectionPreviewTokens) {
    const retained = protectedProjectionPreviews.get(token);
    if (retained === undefined || retained.reference.expiresAt <= Date.now()) {
      protectedProjectionPreviewTokens.delete(referenceId);
    }
  }
  const snapshot = Object.freeze({
    kind: "protected" as const,
    toolCallId: reference.toolCallId,
    requesterUserId: reference.requesterUserId,
    requesterActorId: reference.requesterActorId,
    agentId: reference.agentId,
    reference,
  });
  if (
    protectedProjectionPreviewTokens.size < 256
    && !protectedProjectionPreviewTokens.has(reference.referenceId)
  ) {
    const token = Object.freeze({});
    protectedProjectionPreviewTokens.set(reference.referenceId, token);
    protectedProjectionPreviews.set(token, Object.freeze({
      reference,
      preview,
    }));
    const expiry = setTimeout(() => {
      if (protectedProjectionPreviewTokens.get(reference.referenceId) === token) {
        protectedProjectionPreviewTokens.delete(reference.referenceId);
      }
    }, Math.max(0, reference.expiresAt - Date.now()));
    expiry.unref?.();
  }
  return snapshot;
}

function isProtectedProjectionSnapshot(
  snapshot: ProjectionSnapshot,
): snapshot is ProtectedProjectionSnapshot {
  return "kind" in snapshot && snapshot.kind === "protected";
}

export function projectionSnapshotExpiresAt(
  snapshot: ProjectionSnapshot,
): number {
  return isProtectedProjectionSnapshot(snapshot)
    ? snapshot.reference.expiresAt
    : snapshot.expiresAt;
}

export function projectionSnapshotRoomKind(
  snapshot: ProjectionSnapshot,
): ResolvedRoomDestination["kind"] | null {
  return isProtectedProjectionSnapshot(snapshot)
    ? protectedProjectionPreview(snapshot)?.roomKind ?? null
    : snapshot.destination.kind;
}

/** Opaque state-backed choice token; the Room id never reaches a model/UI payload. */
export type ProjectionRoomChoice = Readonly<{
  token: string;
  requesterUserId: string;
  normalizedQuery: string;
  roomId: string;
  expiresAt: number;
}>;

export type ProjectionPreflightResult = Readonly<{
  snapshots: readonly ProjectionSnapshot[];
  choiceMappings: readonly ProjectionRoomChoice[];
  rejectedToolCallIds: readonly string[];
  messages: ReadonlyArray<{ toolCallId: string; content: string }>;
}>;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * `search_memory` predates D476 and returns text, not a typed provenance
 * envelope. Until that tool gains structured result ids, recognize only its
 * own successful, stable numbered-result header grammar. Database
 * readability is still rechecked separately, so a transcript token alone is
 * never authority.
 */
export function sourceIdsFromSuccessfulSearchResults(messages: readonly BaseMessage[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const message of messages.slice(-40)) {
    if (!ToolMessage.isInstance(message) || message.name !== "search_memory") continue;
    if (message.additional_kwargs?.["nautilo_tool_status"] === "error") continue;
    if (typeof message.content !== "string") continue;
    // Do not trust unversioned historical tool content: old checkpoints can
    // contain a Memory body that happens to look like a result header. New
    // search_memory output begins with this exact producer-owned marker.
    const header = new RegExp(`^${SEARCH_MEMORY_PROVENANCE_HEADER} \\(\\d+ results?\\)\\r?\\n`, "u");
    const matchedHeader = header.exec(message.content);
    if (!matchedHeader) continue;
    const resultLines = message.content.slice(matchedHeader[0].length);
    for (const match of resultLines.matchAll(/^\d+\. \[[^\]\r\n]+\] \(id:\s*([^,\s)]+),\s*tier:\s*\d+\)/gmu)) {
      const id = match[1];
      if (id && ids.size < 64) ids.add(id);
    }
  }
  return ids;
}

function projectionCallId(tc: ToolCall): string | null {
  return typeof tc.id === "string" && tc.id.length > 0 ? tc.id : null;
}

/**
 * Treat malformed project attempts as sensitive until preflight rejects them.
 * Otherwise a typo such as `mode: "projec"` could leak source IDs into an
 * approval card or telemetry before schema validation has its say.
 */
export function isProjectionLikeShareCall(tc: { name: string; args: unknown }): boolean {
  if (tc.name !== "share_memory" || typeof tc.args !== "object" || tc.args === null) return false;
  const args = tc.args as Record<string, unknown>;
  const projectOnlyKeys = ["source_memory_ids", "proposed_content", "target_room_name", "room_choice_token"];
  return projectOnlyKeys.some((key) => Object.hasOwn(args, key))
    || (Object.hasOwn(args, "mode") && args["mode"] !== "attach");
}

export function findProjectionSnapshot(
  state: Pick<NautiloState, "projectionSnapshots">,
  tc: { id?: string },
): ProjectionSnapshot | null {
  const id = typeof tc.id === "string" && tc.id.length > 0 ? tc.id : null;
  if (!id) return null;
  return state.projectionSnapshots?.find((snapshot) => snapshot.toolCallId === id) ?? null;
}

/**
 * Preflight is intentionally run as a graph node before approval classification.
 * It turns untrusted model args into a short-lived checkpoint snapshot, or
 * produces a tool response which lets the model request a safe disambiguation.
 */
export async function preflightProjectionShareCalls(
  state: NautiloState,
  toolCalls: readonly ToolCall[],
): Promise<ProjectionPreflightResult> {
  const snapshots: ProjectionSnapshot[] = [];
  const choiceMappings: ProjectionRoomChoice[] = [];
  const rejectedToolCallIds: string[] = [];
  const messages: Array<{ toolCallId: string; content: string }> = [];
  const now = Date.now();
  const retainedChoices = (state.projectionRoomChoices ?? []).filter((choice) => choice.expiresAt > now);

  for (const tc of toolCalls) {
    if (!isProjectionLikeShareCall(tc)) continue;
    const toolCallId = projectionCallId(tc);
    if (!toolCallId) {
      // Tool calls must have an id to bind a checkpoint and approval resume.
      continue;
    }
    if (state.taskRun || state.subagentRun || !state.userId || !state.memoryAccessEnvelope?.agentId) {
      rejectedToolCallIds.push(toolCallId);
      messages.push({ toolCallId, content: "Projected Memory sharing is available only in a foreground signed-in Room conversation." });
      continue;
    }
    const parsed = parseShareMemoryInput(tc.args);
    if (!parsed.ok || parsed.value.mode !== "project") {
      rejectedToolCallIds.push(toolCallId);
      messages.push({ toolCallId, content: "Cannot project Memory: invalid projection share arguments." });
      continue;
    }
    const searchableSourceIds = sourceIdsFromSuccessfulSearchResults(state.messages);
    if (!parsed.value.source_memory_ids.every((memoryId) => searchableSourceIds.has(memoryId))) {
      rejectedToolCallIds.push(toolCallId);
      messages.push({
        toolCallId,
        content: "Cannot project Memory: cite at least one concrete source returned by a successful search_memory call in this conversation.",
      });
      continue;
    }
    const envelope = state.memoryAccessEnvelope;
    const readableNamespaces = envelopeReadableNamespaces(envelope);
    if (readableNamespaces.length === 0 || !envelope.actorId) {
      rejectedToolCallIds.push(toolCallId);
      messages.push({ toolCallId, content: "Cannot project Memory: this Room has no readable Memory authority." });
      continue;
    }
    const requesterActor = await findActorByOwnerId(state.userId);
    if (!requesterActor || requesterActor.id !== envelope.actorId) {
      rejectedToolCallIds.push(toolCallId);
      messages.push({ toolCallId, content: "Cannot project Memory: requester identity does not match this Room authority." });
      continue;
    }

    const sourceRows = await Promise.all(parsed.value.source_memory_ids.map(async (memoryId) => ({
      memoryId,
      row: await loadMemoryRowIfShareable(memoryId, readableNamespaces, envelope.agentId, state.userId),
    })));
    if (sourceRows.some(({ row }) => row === null)) {
      rejectedToolCallIds.push(toolCallId);
      messages.push({ toolCallId, content: "Cannot project Memory: every cited source must be a currently readable Memory from this Room." });
      continue;
    }
    if (sourceRows.some(({ row }) => row?.content === null)) {
      rejectedToolCallIds.push(toolCallId);
      messages.push({
        toolCallId,
        content: "Cannot project Memory: a cited source's ordinary representation is unavailable.",
      });
      continue;
    }

    const codec: RoomChoiceTokenCodec = {
      issue: ({ requesterUserId, normalizedQuery, roomId }) => {
        const token = randomUUID();
        choiceMappings.push({
          token,
          requesterUserId,
          normalizedQuery,
          roomId,
          expiresAt: now + PROJECTION_SNAPSHOT_TTL_MS,
        });
        return token;
      },
      verify: ({ token, requesterUserId, normalizedQuery, candidateRoomIds }) => {
        const match = [...retainedChoices, ...choiceMappings].find((choice) =>
          choice.token === token
          && choice.requesterUserId === requesterUserId
          && choice.normalizedQuery === normalizedQuery
          && choice.expiresAt > now
          && candidateRoomIds.includes(choice.roomId),
        );
        return match?.roomId ?? null;
      },
    };
    const resolution = await resolveAuthorizedRoomName({
      requesterUserId: state.userId,
      requesterActorId: envelope.actorId,
      targetRoomName: parsed.value.target_room_name,
      ...(parsed.value.room_choice_token ? { roomChoiceToken: parsed.value.room_choice_token } : {}),
    }, {
      findAuthorizedRoomNameCandidates,
      userHasCapability,
      choiceTokenCodec: codec,
    });

    if (resolution.status === "needs_disambiguation") {
      rejectedToolCallIds.push(toolCallId);
      const choices = resolution.candidates.map((candidate) =>
        `- ${candidate.label} (${candidate.kind}, ${candidate.memberCount} visible members): choice token ${candidate.choiceToken}`,
      ).join("\n");
      messages.push({
        toolCallId,
        content: `Several accessible Rooms match that name. Ask the Human which audience they mean, then call share_memory again with the same target_room_name and the corresponding room_choice_token:\n${choices}`,
      });
      continue;
    }
    if (resolution.status !== "resolved") {
      rejectedToolCallIds.push(toolCallId);
      messages.push({
        toolCallId,
        content: resolution.status === "forbidden"
          ? "Cannot project Memory: you no longer have permission to manage Memories in the destination Room."
          : "Cannot project Memory: no unique authorized top-level Room matched that name.",
      });
      continue;
    }

    const sourceFingerprints = sourceRows.map(({ memoryId, row }) => {
      if (!row || row.content === null) {
        throw new Error("Projection source ordinary representation is unavailable");
      }
      return { id: memoryId, contentHash: sha256(row.content) };
    });
    snapshots.push({
      toolCallId,
      requesterUserId: state.userId,
      requesterActorId: envelope.actorId,
      agentId: envelope.agentId,
      sourceFingerprints,
      readableNamespaceIds: [...readableNamespaces].sort((left, right) => left.localeCompare(right)),
      readableAuthorityFingerprint: fingerprintProjectionReadableAuthority(readableNamespaces),
      content: parsed.value.proposed_content,
      contentHash: sha256(parsed.value.proposed_content),
      destination: resolution.destination,
      audienceFingerprint: resolution.destination.audienceFingerprint,
      createdAt: now,
      expiresAt: now + PROJECTION_SNAPSHOT_TTL_MS,
      creationKey: `projection:${randomUUID()}`,
    });
  }
  return { snapshots, choiceMappings, rejectedToolCallIds, messages };
}

/**
 * Non-production protected preflight. Legacy source/destination resolution is
 * consumed transiently, then replaced by an opaque content-free reference.
 * Neither source ids nor proposed plaintext enter the returned graph state.
 */
export async function preflightProtectedProjectionShareCalls(
  state: NautiloState,
  toolCalls: readonly ToolCall[],
  port: ProtectedAgentMemoryProjectionPort,
): Promise<ProjectionPreflightResult> {
  const snapshots: ProjectionSnapshot[] = [];
  const rejectedToolCallIds: string[] = [];
  const messages: Array<{ toolCallId: string; content: string }> = [];
  const searchableSourceIds = sourceIdsFromSuccessfulSearchResults(state.messages);
  for (const call of toolCalls) {
    if (!isProjectionLikeShareCall(call)) continue;
    const toolCallId = projectionCallId(call);
    if (toolCallId === null) continue;
    const parsed = parseShareMemoryInput(call.args);
    if (
      !parsed.ok
      || parsed.value.mode !== "project"
      || state.taskRun
      || state.subagentRun
      || !state.userId
      || !state.memoryAccessEnvelope?.actorId
      || !state.memoryAccessEnvelope.agentId
      || !parsed.value.source_memory_ids.every((memoryId) =>
        searchableSourceIds.has(memoryId)
      )
    ) {
      rejectedToolCallIds.push(toolCallId);
      messages.push({
        toolCallId,
        content: "Cannot project Memory: protected projection requires a foreground Human request and concrete sources from search_memory.",
      });
      continue;
    }
    const authority = protectedMemoryAuthorityFromEnvelope(
      state.memoryAccessEnvelope,
    );
    if (!authority) {
      rejectedToolCallIds.push(toolCallId);
      messages.push({
        toolCallId,
        content: "Cannot project Memory: current protected authorization is unavailable.",
      });
      continue;
    }
    let prepared: Awaited<ReturnType<typeof port.prepare>>;
    try {
      // The protected product port binds and returns sources in canonical ID
      // order. Preserve the model-facing duplicate rejection above, then
      // canonicalize the valid set before it enters sealed preparation.
      const sourceMemoryIds = [...parsed.value.source_memory_ids].sort();
      prepared = await port.prepare({
        operationId: protectedMemoryToolOperationId({
          requestId: toolCallId,
          action: "projection_prepare",
          subjectId: `${state.userId}:${state.memoryAccessEnvelope.agentId}`,
        }),
        toolCallId,
        authority,
        requesterActorId: state.memoryAccessEnvelope.actorId,
        sourceMemoryIds,
        proposedContent: parsed.value.proposed_content,
        targetRoomName: parsed.value.target_room_name,
        ...(parsed.value.room_choice_token === undefined
          ? {}
          : { roomChoiceToken: parsed.value.room_choice_token }),
      });
    } catch {
      rejectedToolCallIds.push(toolCallId);
      messages.push({ toolCallId,
        content: "Cannot project Memory: preparation failed before approval. No projection was published; try a fresh request after the sharing error is resolved.",
      });
      continue;
    }
    if (prepared.status === "unavailable") {
      rejectedToolCallIds.push(toolCallId);
      messages.push({
        toolCallId,
        content: `Cannot project Memory: ${describeProtectedMemoryUnavailable(prepared.reason)}. No projection was published.`,
      });
      continue;
    }
    if (prepared.value.kind === "needs_disambiguation") {
      if (
        prepared.value.candidates.length < 1
        || prepared.value.candidates.length > 10
        || prepared.value.candidates.some((candidate) =>
          candidate.choiceToken.length < 1
          || candidate.choiceToken.length > 256
          || candidate.label.length < 1
          || candidate.label.length > 128
          || !Number.isSafeInteger(candidate.memberCount)
          || candidate.memberCount < 0
        )
      ) {
        rejectedToolCallIds.push(toolCallId);
        messages.push({
          toolCallId,
          content: "Cannot project Memory: protected destination choices were invalid.",
        });
        continue;
      }
      rejectedToolCallIds.push(toolCallId);
      const choices = prepared.value.candidates.map((candidate) =>
        `- ${candidate.label} (${candidate.roomKind}, ${candidate.memberCount} visible members): choice token ${candidate.choiceToken}`,
      ).join("\n");
      messages.push({
        toolCallId,
        content: `Several accessible Rooms match that name. Ask the Human which audience they mean, then call share_memory again with the corresponding room_choice_token:\n${choices}`,
      });
      continue;
    }
    const preview = prepared.value.preview;
    const reference = prepared.value.reference;
    const now = Date.now();
    if (
      preview.proposedContent !== parsed.value.proposed_content
      || preview.roomLabel.length < 1
      || preview.roomLabel.length > 128
      || !Number.isSafeInteger(preview.memberCount)
      || preview.memberCount < 0
      || reference.referenceId.length < 1
      || reference.referenceId.length > 256
      || reference.toolCallId !== toolCallId
      || reference.requesterUserId !== state.userId
      || reference.requesterActorId !== state.memoryAccessEnvelope.actorId
      || reference.agentId !== state.memoryAccessEnvelope.agentId
      || reference.createdAt > now
      || reference.expiresAt <= now
      || reference.expiresAt > now + PROJECTION_SNAPSHOT_TTL_MS
    ) {
      rejectedToolCallIds.push(toolCallId);
      messages.push({
        toolCallId,
        content: "Cannot project Memory: protected projection preview was substituted.",
      });
      continue;
    }
    snapshots.push(bindProtectedProjectionReference(
      reference,
      preview,
    ));
  }
  return {
    snapshots,
    choiceMappings: [],
    rejectedToolCallIds,
    messages,
  };
}

/** Explicitly safe view for approval UI/realtime. It intentionally has no source or namespace IDs. */
export function projectionApprovalPreview(snapshot: ProjectionSnapshot) {
  const protectedPreview = isProtectedProjectionSnapshot(snapshot)
    ? protectedProjectionPreview(snapshot)
    : undefined;
  if (isProtectedProjectionSnapshot(snapshot) && protectedPreview === undefined) {
    return null;
  }
  const content = protectedPreview?.proposedContent
    ?? (isProtectedProjectionSnapshot(snapshot) ? "" : snapshot.content);
  const roomLabel = protectedPreview?.roomLabel
    ?? (isProtectedProjectionSnapshot(snapshot) ? "" : snapshot.destination.label);
  const roomKind = protectedPreview?.roomKind
    ?? (isProtectedProjectionSnapshot(snapshot) ? "private" : snapshot.destination.kind);
  const memberCount = protectedPreview?.memberCount
    ?? (isProtectedProjectionSnapshot(snapshot) ? 0 : snapshot.destination.memberCount);
  return {
    // Keep the existing client contract populated for older surfaces. New
    // surfaces use `projection.content` (which is deliberately untruncated).
    memoryContentSnippet: content,
    memoryType: "fact",
    targetHandle: "",
    targetDisplayName: roomLabel,
    roomLabel,
    wouldCreate: false,
    sensitivity: "sensitive" as const,
    projection: {
      mode: "project" as const,
      expiresAt: projectionSnapshotExpiresAt(snapshot),
      content,
      roomLabel,
      roomKind,
      memberCount,
      audienceWarning: roomKind === "open"
        ? "Current and future members of this open Room can retrieve this text. Private source Memories remain private."
        : "Members of this Room can retrieve this text. Private source Memories remain private.",
    },
  };
}

/** Replace raw model args in UI/event payloads. Source IDs are private provenance. */
export function projectionApprovalArgs(snapshot: ProjectionSnapshot): Record<string, unknown> {
  const preview = projectionApprovalPreview(snapshot);
  if (preview === null) return { mode: "project" };
  return {
    mode: "project",
    proposed_content: preview.projection.content,
    target_room_name: preview.projection.roomLabel,
  };
}

/**
 * Revalidates the frozen snapshot at the only write seam, then force-creates
 * the independent destination Memory. Caller must pass the snapshot selected
 * by tool-call id, never a snapshot reconstructed from model args.
 */
export async function executeTrustedProjection(
  snapshot: ProjectionSnapshot,
  state: NautiloState,
  protectedPort?: ProtectedAgentMemoryProjectionPort,
): Promise<
  | { status: "success"; memoryId: string; replayed: boolean; message: string }
  | { status: "stale" | "idempotency_conflict"; message: string }
> {
  const now = Date.now();
  const envelope = state.memoryAccessEnvelope;
  if (isProtectedProjectionSnapshot(snapshot)) {
    const authority = protectedMemoryAuthorityFromEnvelope(envelope);
    if (
      protectedPort === undefined
      || authority === null
      || authority.subjectUserId !== snapshot.requesterUserId
      || state.taskRun
      || state.subagentRun
      || snapshot.reference.expiresAt <= now
      || state.userId !== snapshot.requesterUserId
      || envelope?.actorId !== snapshot.requesterActorId
      || envelope?.agentId !== snapshot.agentId
      || snapshot.reference.toolCallId !== snapshot.toolCallId
      || snapshot.reference.requesterUserId !== snapshot.requesterUserId
      || snapshot.reference.requesterActorId !== snapshot.requesterActorId
      || snapshot.reference.agentId !== snapshot.agentId
    ) {
      return { status: "stale", message: "Protected projected Memory authority is unavailable; run a fresh projection preflight." };
    }
    const result = await protectedPort.publish({
      authority,
      reference: snapshot.reference,
    });
    if (result.status === "unavailable") {
      return { status: "stale", message: `Projected Memory was not published: ${describeProtectedMemoryUnavailable(result.reason)}.` };
    }
    return {
      status: "success",
      memoryId: result.value.memoryId,
      replayed: result.value.status === "replayed",
      message: result.value.status === "replayed"
        ? `Projected Memory was already created in '${result.value.roomLabel}'.`
        : `Created a new projected Memory in '${result.value.roomLabel}'. Private source Memories were not shared.`,
    };
  }
  if (
    state.taskRun
    || state.subagentRun
    || snapshot.expiresAt <= now
    || state.userId !== snapshot.requesterUserId
    || !envelope
    || envelope.agentId !== snapshot.agentId
    || envelope.actorId !== snapshot.requesterActorId
  ) {
    return { status: "stale", message: "Projected Memory approval is stale or no longer belongs to this requester; nothing was created." };
  }
  if (!snapshot.readableNamespaceIds || !snapshot.readableAuthorityFingerprint) {
    // Old checkpoints lack the D476 source-authority binding; do not attempt
    // to upgrade or infer it during resume.
    return { status: "stale", message: "Projected Memory approval is from an older unbound checkpoint; nothing was created." };
  }
  const requesterActor = await findActorByOwnerId(state.userId);
  if (!requesterActor || requesterActor.id !== envelope.actorId) {
    return { status: "stale", message: "Projected Memory authority changed; nothing was created." };
  }
  const result = await executeAtomicProjectionMemory({
    userId: snapshot.requesterUserId,
    agentId: snapshot.agentId,
    requesterActorId: snapshot.requesterActorId,
    sourceFingerprints: snapshot.sourceFingerprints,
    frozenReadableNamespaceIds: snapshot.readableNamespaceIds,
    frozenReadableAuthorityFingerprint: snapshot.readableAuthorityFingerprint,
    currentReadableNamespaceIds: envelopeReadableNamespaces(envelope),
    content: snapshot.content,
    contentHash: snapshot.contentHash,
    roomId: snapshot.destination.roomId,
    namespaceId: snapshot.destination.namespaceId,
    roomLabel: snapshot.destination.label,
    roomKind: snapshot.destination.kind,
    audienceFingerprint: snapshot.audienceFingerprint,
    creationKey: snapshot.creationKey,
    type: "fact",
    importance: 0.8,
    expiresAt: snapshot.expiresAt,
  });
  if (result.status === "created" || result.status === "replayed") {
    return {
      status: "success",
      memoryId: result.memoryId,
      replayed: result.status === "replayed",
      message: result.status === "replayed"
        ? `Projected Memory was already created in '${snapshot.destination.label}'.`
        : `Created a new projected Memory in '${snapshot.destination.label}'. Private source Memories were not shared.`,
    };
  }
  if (result.status === "idempotency_conflict") {
    return { status: "idempotency_conflict", message: "Projected Memory approval conflicts with an existing result; nothing was created." };
  }
  return { status: "stale", message: "Projected Memory approval is stale because its authority, source, or destination changed; nothing was created." };
}
