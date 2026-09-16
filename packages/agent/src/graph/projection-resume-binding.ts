import { createNautiloGraph } from "../agent/graph";
import { createCheckpointSaver } from "../checkpoints/checkpoint-saver";
import type { EncryptedCheckpointSaver } from "../checkpoints/encrypted-checkpoint-saver";
import { getPolicyResolver } from "@nautilo/trust";

/**
 * The only resume authority exposed to the server for a D476 projection.
 * It deliberately returns no projection data beyond the initiating principals.
 */
export type ProjectionResumeBinding =
  | { readonly kind: "none" }
  | {
      readonly kind: "bound";
      readonly requesterUserId: string;
      readonly requesterActorId: string;
    }
  | { readonly kind: "malformed" };

export interface ProjectionCheckpointReadable {
  getState(
    config: { configurable: { thread_id: string } },
  ): Promise<unknown>;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function isProjectionTool(tool: unknown): tool is UnknownRecord {
  if (!isRecord(tool) || tool["name"] !== "share_memory" || !isRecord(tool["args"])) {
    return false;
  }
  return tool["args"]["mode"] === "project" &&
    typeof tool["id"] === "string" && tool["id"].length > 0;
}

/**
 * Return ids for project calls in the currently parked approval interrupt.
 * Snapshots from an already-completed turn are deliberately ignored.
 */
function pendingProjectionToolIds(state: unknown): string[] {
  if (!isRecord(state) || !Array.isArray(state["tasks"])) return [];
  const ids = new Set<string>();
  for (const task of state["tasks"]) {
    if (!isRecord(task) || !Array.isArray(task["interrupts"])) continue;
    for (const interrupt of task["interrupts"]) {
      if (!isRecord(interrupt) || !isRecord(interrupt["value"])) continue;
      const value = interrupt["value"];
      if (
        value["type"] !== "prove_it_challenge" &&
        value["type"] !== "approval_ask"
      ) {
        continue;
      }
      if (!Array.isArray(value["tools"])) continue;
      for (const tool of value["tools"]) {
        if (isProjectionTool(tool)) {
          const id = tool["id"];
          if (typeof id === "string") ids.add(id);
        }
      }
    }
  }
  return [...ids];
}

function snapshotBinding(snapshot: unknown): {
  readonly toolCallId: string;
  readonly requesterUserId: string;
  readonly requesterActorId: string;
} | null {
  if (!isRecord(snapshot)) return null;
  const toolCallId = snapshot["toolCallId"];
  const requesterUserId = snapshot["requesterUserId"];
  const requesterActorId = snapshot["requesterActorId"];
  if (
    typeof toolCallId !== "string" || toolCallId.length === 0 ||
    typeof requesterUserId !== "string" || requesterUserId.length === 0 ||
    typeof requesterActorId !== "string" || requesterActorId.length === 0
  ) {
    return null;
  }
  return { toolCallId, requesterUserId, requesterActorId };
}

/**
 * Interpret checkpoint-private state without exposing projection text, source
 * ids, room ids, or creation keys. A malformed active projection is a hard
 * denial; an absent projection leaves all legacy resumes untouched.
 */
export function projectionResumeBindingFromCheckpoint(
  state: unknown,
): ProjectionResumeBinding {
  const projectionToolIds = pendingProjectionToolIds(state);
  if (projectionToolIds.length === 0) return { kind: "none" };
  if (!isRecord(state) || !isRecord(state["values"]) || !Array.isArray(state["values"]["projectionSnapshots"])) {
    return { kind: "malformed" };
  }

  const bindings = new Map<string, ReturnType<typeof snapshotBinding>>();
  for (const snapshot of state["values"]["projectionSnapshots"]) {
    const binding = snapshotBinding(snapshot);
    if (!binding) return { kind: "malformed" };
    if (bindings.has(binding.toolCallId)) return { kind: "malformed" };
    bindings.set(binding.toolCallId, binding);
  }

  const active = projectionToolIds.map((id) => bindings.get(id));
  if (active.some((binding) => binding === undefined || binding === null)) {
    return { kind: "malformed" };
  }
  const first = active[0]!;
  if (
    active.some((binding) =>
      binding!.requesterUserId !== first.requesterUserId ||
      binding!.requesterActorId !== first.requesterActorId,
    )
  ) {
    return { kind: "malformed" };
  }
  return {
    kind: "bound",
    requesterUserId: first.requesterUserId,
    requesterActorId: first.requesterActorId,
  };
}

/**
 * Production checkpoint reader. A missing checkpoint has no active projection
 * to bind; malformed checkpoint content is handled by the pure reader above.
 * Checkpointer failures fail closed: a caller cannot resume an approval when
 * the private state used to establish its initiator binding is unavailable.
 */
export async function readProjectionResumeBindingForThread(
  threadId: string,
  invocationCheckpointSaver?: EncryptedCheckpointSaver,
): Promise<ProjectionResumeBinding> {
  try {
    const graph = createNautiloGraph(
      invocationCheckpointSaver ?? createCheckpointSaver(),
      getPolicyResolver(),
    );
    const state = await graph.getState({
      configurable: { thread_id: threadId },
    });
    return projectionResumeBindingFromCheckpoint(state);
  } catch {
    return { kind: "malformed" };
  }
}
