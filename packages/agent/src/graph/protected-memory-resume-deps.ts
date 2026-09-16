import type { NautiloGraphDeps } from "../agent/graph";
import type { NautiloState } from "../agent/state";
import type { ProtectedAgentMemoryAccessPort } from "../tools/memory/protected-memory-ports";
import {
  bindProtectedProjectionReference,
  type ProtectedProjectionSnapshot,
} from "../tools/memory/projection-sharing";
import { protectedMemoryAuthorityFromEnvelope } from
  "../tools/memory/protected-memory-authority";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Content-free marker that preserves conditional enrollPin interrupt order. */
export function identityEnrollmentToolCallIds(
  checkpoint: unknown,
): readonly string[] {
  const root = record(checkpoint);
  const tasks = root?.["tasks"];
  if (!Array.isArray(tasks)) throw new Error("Memory resume checkpoint unavailable");
  const enrollmentInterrupts: Record<string, unknown>[] = [];
  for (const task of tasks) {
    const interrupts = record(task)?.["interrupts"];
    if (!Array.isArray(interrupts)) continue;
    for (const candidate of interrupts) {
      const value = record(record(candidate)?.["value"]);
      if (value?.["type"] === "identity_challenge"
        && value["mode"] === "enrollPin") enrollmentInterrupts.push(value);
    }
  }
  if (enrollmentInterrupts.length === 0) return [];
  if (enrollmentInterrupts.length !== 1) {
    throw new Error("Memory identity resume checkpoint is ambiguous");
  }
  const ids = enrollmentInterrupts[0]!["enrollmentToolCallIds"];
  if (ids === undefined) {
    // Upgrade compatibility for checkpoints parked before the exact batch field
    // existed. The marker remains content-free and can only preserve interrupt
    // order; it grants no approval or protected custody.
    const messages = record(root?.["values"])?.["messages"];
    const current = Array.isArray(messages)
      ? (messages as unknown[]).slice().reverse().map(record).find((message) =>
          Array.isArray(message?.["tool_calls"])
        )
      : undefined;
    const legacyCalls = current?.["tool_calls"];
    if (!Array.isArray(legacyCalls) || legacyCalls.length === 0) {
      throw new Error("Memory identity resume tool state unavailable");
    }
    const legacyIds = legacyCalls.map((candidate) => record(candidate)?.["id"]);
    if (legacyIds.some((id) => typeof id !== "string" || id.length === 0)
      || new Set(legacyIds).size !== legacyIds.length) {
      throw new Error("Memory identity resume tool identity unavailable");
    }
    return Object.freeze([...(legacyIds as string[])].sort());
  }
  if (
    !Array.isArray(ids)
    || ids.length === 0
    || ids.some((id) => typeof id !== "string" || id.length === 0)
    || new Set(ids).size !== ids.length
  ) throw new Error("Memory identity resume tool identity unavailable");
  return Object.freeze([...(ids as string[])].sort());
}

/** A resumed interrupt must not approve a newly prepared audience or content. */
export function bindProtectedMemoryResumeDeps(input: NautiloGraphDeps): {
  deps: NautiloGraphDeps;
  bindCheckpoint(checkpoint: unknown): void;
  restoreCheckpoint(checkpoint: unknown): Promise<void>;
  restoreIdentityCheckpoint(checkpoint: unknown): Promise<void>;
} {
  const expected = new Map<string, string | null>();
  const pendingProjectionIds = new Set<string>();
  const ports = new WeakMap<ProtectedAgentMemoryAccessPort, ProtectedAgentMemoryAccessPort>();
  let bound = false;
  const bindCheckpoint = (checkpoint: unknown): void => {
    if (bound) throw new Error("Memory resume checkpoint already bound");
    const tasks = record(checkpoint)?.["tasks"];
    if (!Array.isArray(tasks)) throw new Error("Memory resume checkpoint unavailable");
    for (const task of tasks) {
      const interrupts = record(task)?.["interrupts"];
      if (!Array.isArray(interrupts)) continue;
      for (const interrupt of interrupts) {
        const value = record(record(interrupt)?.["value"]);
        if (value?.["type"] !== "approval_ask" && value?.["type"] !== "prove_it_challenge") continue;
        const tools = value["tools"];
        if (!Array.isArray(tools)) throw new Error("Memory resume approval tools unavailable");
        for (const candidate of tools) {
          const tool = record(candidate);
          if (tool?.["name"] !== "share_memory") continue;
          const id = tool["id"];
          if (typeof id !== "string" || id.length === 0) {
            throw new Error("Memory resume tool identity unavailable");
          }
          if (record(tool["args"])?.["mode"] === "project") {
            if (pendingProjectionIds.has(id)) {
              throw new Error("Memory resume projection identity unavailable");
            }
            pendingProjectionIds.add(id);
            continue;
          }
          if (expected.has(id)) throw new Error("Memory resume tool identity unavailable");
          const digest = record(tool["shareMemoryPreview"])?.["protectedApprovalDigest"];
          expected.set(id, typeof digest === "string" ? digest : null);
        }
      }
    }
    if ([...expected.values()].some((digest) => digest !== null)
      && input.protectedMemoryAccessPortForState === undefined) {
      throw new Error("Protected Memory approval requires fresh authorized custody");
    }
    bound = true;
  };

  const restoreBoundProjectionCheckpoint = async (
    checkpoint: unknown,
  ): Promise<void> => {
    if (pendingProjectionIds.size === 0) return;

    const values = record(record(checkpoint)?.["values"]);
    const snapshots = values?.["projectionSnapshots"];
    if (!values || !Array.isArray(snapshots)) {
      throw new Error("Protected Memory projection checkpoint unavailable");
    }
    const byToolCallId = new Map<string, Record<string, unknown>>();
    for (const candidate of snapshots) {
      const snapshot = record(candidate);
      const toolCallId = snapshot?.["toolCallId"];
      if (typeof toolCallId !== "string" || !pendingProjectionIds.has(toolCallId)) {
        continue;
      }
      if (byToolCallId.has(toolCallId)) {
        throw new Error("Memory resume projection checkpoint is malformed");
      }
      byToolCallId.set(toolCallId, snapshot!);
    }
    if ([...pendingProjectionIds].some((id) => !byToolCallId.has(id))) {
      throw new Error("Memory resume projection checkpoint is incomplete");
    }

    const protectedSnapshots = new Map<string, ProtectedProjectionSnapshot>();
    let hasLegacySnapshot = false;
    for (const [toolCallId, snapshot] of byToolCallId) {
      const reference = record(snapshot["reference"]);
      const protectedLike = snapshot["kind"] === "protected"
        || Object.hasOwn(snapshot, "kind")
        || (reference !== undefined && Object.hasOwn(reference, "sealedPreparation"));
      if (!protectedLike) {
        hasLegacySnapshot = true;
        continue;
      }
      if (snapshot["kind"] !== "protected") {
        throw new Error("Protected Memory projection checkpoint is malformed");
      }
      protectedSnapshots.set(toolCallId, snapshot as ProtectedProjectionSnapshot);
    }

    const state = values as NautiloState;
    const port = input.protectedMemoryProjectionPortForState?.(state);
    if (
      hasLegacySnapshot
      && (port !== undefined || input.fullEncryptionOnlyForState?.(state) === true)
    ) {
      throw new Error("Legacy projection approval cannot enter protected execution");
    }
    if (protectedSnapshots.size === 0) return;
    if (hasLegacySnapshot) {
      throw new Error("Mixed protected and legacy projection approval is unavailable");
    }
    if (values["taskRun"] === true || values["subagentRun"] === true) {
      throw new Error("Protected Memory projection requires foreground authority");
    }
    const userId = values["userId"];
    const envelope = record(values["memoryAccessEnvelope"]);
    const actorId = envelope?.["actorId"];
    const agentId = envelope?.["agentId"];
    if (
      typeof userId !== "string" || userId.length === 0
      || typeof actorId !== "string" || actorId.length === 0
      || typeof agentId !== "string" || agentId.length === 0
      || envelope?.["ownerId"] !== userId
    ) {
      throw new Error("Protected Memory projection identity unavailable");
    }
    const authority = protectedMemoryAuthorityFromEnvelope(
      values["memoryAccessEnvelope"] as NautiloState["memoryAccessEnvelope"],
    );
    if (
      authority === null
      || authority.subjectUserId !== userId
      || authority.agentId !== agentId
    ) {
      throw new Error("Protected Memory projection authority unavailable");
    }

    for (const [toolCallId, candidate] of protectedSnapshots) {
      const snapshot = record(candidate)!;
      const reference = record(snapshot["reference"]);
      const now = Date.now();
      if (
        reference?.["referenceVersion"] !== 1
        || typeof reference["referenceId"] !== "string"
        || reference["referenceId"].length === 0
        || reference["toolCallId"] !== toolCallId
        || reference["requesterUserId"] !== userId
        || reference["requesterActorId"] !== actorId
        || reference["agentId"] !== agentId
        || typeof reference["createdAt"] !== "number"
        || !Number.isFinite(reference["createdAt"])
        || reference["createdAt"] > now
        || typeof reference["expiresAt"] !== "number"
        || !Number.isFinite(reference["expiresAt"])
        || typeof reference["sealedPreparation"] !== "string"
        || reference["sealedPreparation"].length === 0
        || snapshot["requesterUserId"] !== userId
        || snapshot["requesterActorId"] !== actorId
        || snapshot["agentId"] !== agentId
      ) {
        throw new Error("Protected Memory projection approval is stale");
      }
      if (reference["expiresAt"] <= now) {
        // This runs before restoring or publishing any pending projection.
        // Keep expiry distinct from integrity errors and provider failures.
        throw new Error("protected_memory_approval_expired");
      }
    }

    if (port?.restore === undefined) {
      throw new Error("Protected Memory projection requires fresh authorized custody");
    }
    const restored = await Promise.all([...protectedSnapshots].map(async ([, snapshot]) => {
      const result = await port.restore!({ authority, reference: snapshot.reference });
      if (
        result.status !== "success"
        || typeof result.value.proposedContent !== "string"
        || typeof result.value.roomLabel !== "string"
        || result.value.roomLabel.length === 0
        || !Number.isSafeInteger(result.value.memberCount)
        || result.value.memberCount < 0
      ) {
        throw new Error("Protected Memory projection could not be restored");
      }
      return { snapshot, preview: result.value };
    }));
    for (const item of restored) {
      bindProtectedProjectionReference(item.snapshot.reference, item.preview);
    }
  };

  const restoreCheckpoint = async (checkpoint: unknown): Promise<void> => {
    bindCheckpoint(checkpoint);
    await restoreBoundProjectionCheckpoint(checkpoint);
  };

  const restoreIdentityCheckpoint = async (checkpoint: unknown): Promise<void> => {
    if (bound) throw new Error("Memory resume checkpoint already bound");
    const root = record(checkpoint);
    const tasks = root?.["tasks"];
    if (!Array.isArray(tasks)) throw new Error("Memory resume checkpoint unavailable");
    const identityInterrupts: Record<string, unknown>[] = [];
    for (const task of tasks) {
      const interrupts = record(task)?.["interrupts"];
      if (!Array.isArray(interrupts)) continue;
      for (const candidate of interrupts) {
        const value = record(record(candidate)?.["value"]);
        if (value?.["type"] === "identity_challenge") identityInterrupts.push(value);
      }
    }
    if (identityInterrupts.length !== 1) {
      throw new Error("Memory identity resume checkpoint unavailable");
    }
    const identityInterrupt = identityInterrupts[0]!;

    const values = record(root?.["values"]);
    if (!values) throw new Error("Memory identity resume state unavailable");
    const messages = values["messages"];
    const lastMessage = Array.isArray(messages)
      ? (messages as unknown[]).slice().reverse().map(record).find((message) =>
          Array.isArray(message?.["tool_calls"])
        )
      : undefined;
    // Generic verify_identity checkpoints need not carry a pending tool batch.
    // Only the concrete calls on the current model message are candidates for
    // protected preparation recovery.
    const toolCalls = Array.isArray(lastMessage?.["tool_calls"])
      ? lastMessage["tool_calls"] as unknown[]
      : [];
    const shareModes = new Map<string, "attach" | "project">();
    for (const candidate of toolCalls) {
      const tool = record(candidate);
      if (tool?.["name"] !== "share_memory") continue;
      const id = tool["id"];
      if (typeof id !== "string" || id.length === 0 || shareModes.has(id)) {
        throw new Error("Memory identity resume tool identity unavailable");
      }
      shareModes.set(id, record(tool["args"])?.["mode"] === "project"
        ? "project" : "attach");
    }
    const enrollmentIds = identityInterrupt["mode"] !== "enrollPin"
      ? []
      : [...identityEnrollmentToolCallIds(checkpoint)];
    const protectedValue = identityInterrupt["protectedMemoryTools"];
    const enrollmentPending = identityInterrupt["mode"] === "enrollPin";
    const protectedEntries = protectedValue === undefined
      ? []
      : Array.isArray(protectedValue)
        ? protectedValue.map(record)
        : null;
    if (
      enrollmentIds.some((id) => typeof id !== "string" || id.length === 0)
      || new Set(enrollmentIds).size !== enrollmentIds.length
      || protectedEntries === null
    ) throw new Error("Memory identity resume protected tool identity unavailable");
    const protectedKeys = new Set<string>();
    const snapshots = values["projectionSnapshots"];
    const protectedSnapshotIds = new Set<string>();
    if (Array.isArray(snapshots)) {
      for (const candidate of snapshots) {
        const snapshot = record(candidate);
        const id = snapshot?.["toolCallId"];
        if (
          !enrollmentPending
          || snapshot?.["kind"] !== "protected"
          || typeof id !== "string"
          || shareModes.get(id) !== "project"
        ) continue;
        if (protectedSnapshotIds.has(id)) {
          throw new Error("Memory identity resume projection checkpoint is malformed");
        }
        protectedSnapshotIds.add(id);
      }
    }
    for (const entry of protectedEntries) {
      const id = entry?.["toolCallId"];
      const mode = entry?.["mode"];
      const key = `${String(id)}\0${String(mode)}`;
      if (
        typeof id !== "string" || id.length === 0
        || (mode !== "attach" && mode !== "project")
        || protectedKeys.has(key)
        || shareModes.get(id) !== mode
        || (mode === "project" && !protectedSnapshotIds.has(id))
      ) throw new Error("Memory identity resume protected tool identity unavailable");
      protectedKeys.add(key);
      if (mode === "project") pendingProjectionIds.add(id);
    }
    for (const id of protectedSnapshotIds) {
      if (protectedValue === undefined) {
        // Legacy enrollPin checkpoints predate the explicit obligation field;
        // their protected projection snapshot is itself sufficient evidence.
        pendingProjectionIds.add(id);
      } else if (!protectedKeys.has(`${id}\0project`)) {
        throw new Error("Memory identity resume protected tool identity unavailable");
      }
    }
    bound = true;

    const state = values as NautiloState;
    const accessPort = input.protectedMemoryAccessPortForState?.(state);
    if (
      protectedEntries.some((entry) => entry?.["mode"] === "attach")
      && accessPort === undefined
    ) {
      throw new Error("Protected Memory identity resume requires fresh authorized custody");
    }
    await restoreBoundProjectionCheckpoint(checkpoint);
  };

  return {
    bindCheckpoint,
    restoreCheckpoint,
    restoreIdentityCheckpoint,
    deps: {
      ...input,
      protectedMemoryAccessPortForState: (state) => {
        const port = input.protectedMemoryAccessPortForState?.(state);
        if (port === undefined) {
          if ([...expected.values()].some((digest) => digest !== null)) {
            throw new Error("Protected Memory approval requires fresh authorized custody");
          }
          return undefined;
        }
        const existing = ports.get(port);
        if (existing !== undefined) return existing;
        const accepted = new Map<string, string>();
        const wrapped: ProtectedAgentMemoryAccessPort = {
          async prepareApproval(request) {
            accepted.delete(request.toolCallId);
            if (!bound || port.prepareApproval === undefined) return {
              status: "unavailable", reason: "authorization_required",
            };
            const result = await port.prepareApproval(request);
            if (result.status === "success" && (
              result.value.reference.referenceVersion !== 1
              || result.value.reference.toolCallId !== request.toolCallId
              || result.value.reference.requesterUserId !== request.authority.subjectUserId
              || result.value.reference.agentId !== request.authority.agentId
              || (expected.has(request.toolCallId)
                && expected.get(request.toolCallId) !== result.value.reference.referenceId)
            )) {
              return { status: "unavailable", reason: "stale_revision" };
            }
            if (result.status === "success") accepted.set(request.toolCallId, result.value.reference.referenceId);
            return result;
          },
          change: (request) => {
            const reference = request.approvalReference;
            if (reference === undefined || accepted.get(reference.toolCallId) !== reference.referenceId) {
              return Promise.resolve({ status: "unavailable", reason: "authorization_required" });
            }
            return port.change(request);
          },
        };
        ports.set(port, wrapped);
        return wrapped;
      },
    },
  };
}
