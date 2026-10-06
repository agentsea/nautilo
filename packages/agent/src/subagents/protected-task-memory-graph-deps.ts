import type {
  ProtectedAgentMemoryAccessPort,
  ProtectedAgentMemoryProjectionPort,
  ProtectedAgentMemoryRepository,
  ProtectedAgentMemorySearchPort,
} from "@nautilo/lattice-bridge";
import {
  isNamespaceMemoryEnvelope,
  type MemoryAccessEnvelope,
  type NamespaceMemoryEnvelope,
} from "@nautilo/trust";

import type { NautiloGraphDeps } from "../agent/graph";
import type { NautiloState } from "../agent/state";

export type ProtectedTaskMemoryGraphIdentity = Readonly<{
  taskId: string;
  taskRunId: string;
  graphThreadId: string;
  ownerId: string;
  causalHumanUserId: string;
  agentId: string;
  roomId: string;
  callingRoomId: string;
  turnId: string;
  approvalLaneKey: string;
  actorRole: string;
  envelope: MemoryAccessEnvelope;
}>;

/** Runtime-only ports opened by one accepted protected Task grant. */
export type ProtectedTaskMemoryGraphHandoff = Readonly<{
  search: ProtectedAgentMemorySearchPort;
  repository: ProtectedAgentMemoryRepository;
  access: ProtectedAgentMemoryAccessPort;
  projection: ProtectedAgentMemoryProjectionPort;
  /** Trusted policy-owner decision. This adapter never derives a mode. */
  fullEncryptionOnly: boolean;
}>;

export type ProtectedTaskMemoryGraphDeps = Readonly<Pick<
  NautiloGraphDeps,
  | "fullEncryptionOnlyForState"
  | "protectedMemorySearchForState"
  | "protectedMemoryRepositoryForState"
  | "protectedMemoryAccessPortForState"
  | "protectedMemoryProjectionPortForState"
>>;

type NoProtectedTaskMemoryGraphDeps = Readonly<Record<string, never>>;

function requiredIdentity(value: unknown, name: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Protected Task Memory handoff requires ${name}`);
  }
}

function requiredMethod(
  value: unknown,
  method: string,
  owner: string,
): void {
  if (
    typeof value !== "object"
    || value === null
    || typeof (value as Record<string, unknown>)[method] !== "function"
  ) {
    throw new TypeError(`Protected Task Memory ${owner} is unavailable`);
  }
}

function validateHandoff(handoff: ProtectedTaskMemoryGraphHandoff): void {
  requiredMethod(handoff?.search, "search", "search port");
  for (const method of ["search", "save", "replace", "setTier"] as const) {
    requiredMethod(handoff?.repository, method, "repository");
  }
  requiredMethod(handoff?.access, "change", "access port");
  for (const method of ["prepare", "publish"] as const) {
    requiredMethod(handoff?.projection, method, "projection port");
  }
  if (typeof handoff?.fullEncryptionOnly !== "boolean") {
    throw new TypeError(
      "Protected Task Memory policy selection is unavailable",
    );
  }
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameToolPolicy(
  left: MemoryAccessEnvelope["toolPolicy"],
  right: MemoryAccessEnvelope["toolPolicy"],
): boolean {
  const leftEntries = Object.entries(left).sort(([leftName], [rightName]) =>
    leftName.localeCompare(rightName)
  );
  const rightEntries = Object.entries(right).sort(([leftName], [rightName]) =>
    leftName.localeCompare(rightName)
  );
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([name, access], index) => {
      const candidate = rightEntries[index];
      return candidate?.[0] === name && candidate[1] === access;
    });
}

function sameEnvelope(
  current: MemoryAccessEnvelope | null | undefined,
  expected: NamespaceMemoryEnvelope,
): boolean {
  return isNamespaceMemoryEnvelope(current)
    && sameStrings(
      Object.keys(current).sort(),
      Object.keys(expected).sort(),
    )
    && current.memoryMode === expected.memoryMode
    && current.ownerId === expected.ownerId
    && current.actorId === expected.actorId
    && current.agentId === expected.agentId
    && current.roomId === expected.roomId
    && sameStrings(current.readableNamespaces, expected.readableNamespaces)
    && sameStrings(current.mutableNamespaces, expected.mutableNamespaces)
    && sameStrings(current.writableNamespaces, expected.writableNamespaces)
    && sameToolPolicy(current.toolPolicy, expected.toolPolicy);
}

function cloneEnvelope(
  envelope: MemoryAccessEnvelope,
): NamespaceMemoryEnvelope {
  if (!isNamespaceMemoryEnvelope(envelope)) {
    throw new TypeError(
      "Protected Task Scope Memory graph handoff is unavailable",
    );
  }
  return Object.freeze({
    ...envelope,
    readableNamespaces: Object.freeze([...envelope.readableNamespaces]),
    mutableNamespaces: Object.freeze([...envelope.mutableNamespaces]),
    writableNamespaces: Object.freeze([...envelope.writableNamespaces]),
    toolPolicy: Object.freeze({ ...envelope.toolPolicy }),
  }) as NamespaceMemoryEnvelope;
}

/**
 * Bind process-local Memory ports to one exact protected native Task graph.
 * An absent handoff is the unchanged ordinary/Plain graph composition.
 */
export function createProtectedTaskMemoryGraphDeps(
  identity: ProtectedTaskMemoryGraphIdentity,
  handoff?: ProtectedTaskMemoryGraphHandoff,
): ProtectedTaskMemoryGraphDeps | NoProtectedTaskMemoryGraphDeps {
  if (handoff === undefined) return Object.freeze({});
  validateHandoff(handoff);
  const boundHandoff = Object.freeze({
    search: handoff.search,
    repository: handoff.repository,
    access: handoff.access,
    projection: handoff.projection,
    fullEncryptionOnly: handoff.fullEncryptionOnly,
  });
  for (const [name, value] of [
    ["Task", identity.taskId],
    ["TaskRun", identity.taskRunId],
    ["graph thread", identity.graphThreadId],
    ["owner", identity.ownerId],
    ["causal Human", identity.causalHumanUserId],
    ["Agent", identity.agentId],
    ["execution Room", identity.roomId],
    ["turn", identity.turnId],
    ["approval lane", identity.approvalLaneKey],
    ["actor role", identity.actorRole],
  ] as const) {
    requiredIdentity(value, name);
  }
  const envelope = cloneEnvelope(identity.envelope);
  if (
    envelope.ownerId !== identity.causalHumanUserId
    || envelope.agentId !== identity.agentId
  ) {
    throw new TypeError("Protected Task Memory envelope identity changed");
  }
  const expected = Object.freeze({ ...identity, envelope });

  const assertCurrent = (state: NautiloState): void => {
    if (
      state.taskRun !== true
      || state.subagentRun !== true
      || state.trustedExecutionEntrypoint !== "background.task"
      || state.currentTaskId !== expected.taskId
      || state.currentTaskRunId !== expected.taskRunId
      || state.currentThreadId !== expected.graphThreadId
      || state.langgraphThreadId !== expected.graphThreadId
      || state.userId !== expected.ownerId
      || state.causalHumanUserId !== expected.causalHumanUserId
      || state.agentId !== expected.agentId
      || state.roomId !== expected.roomId
      || state.callingRoomId !== expected.callingRoomId
      || state.turnId !== expected.turnId
      || state.approvalLaneKey !== expected.approvalLaneKey
      || state.actorRole !== expected.actorRole
      || state.verifiedOrdinaryOrigin !== null
      || state.memoryBrief !== ""
      || state.memoryDelta !== ""
      || !sameEnvelope(state.memoryAccessEnvelope, expected.envelope)
    ) {
      throw new TypeError("Protected Task Memory graph identity changed");
    }
  };

  return Object.freeze({
    protectedMemorySearchForState: (state: NautiloState) => {
      assertCurrent(state);
      return boundHandoff.search;
    },
    protectedMemoryRepositoryForState: (state: NautiloState) => {
      assertCurrent(state);
      return boundHandoff.repository;
    },
    protectedMemoryAccessPortForState: (state: NautiloState) => {
      assertCurrent(state);
      return boundHandoff.access;
    },
    protectedMemoryProjectionPortForState: (state: NautiloState) => {
      assertCurrent(state);
      return boundHandoff.projection;
    },
    fullEncryptionOnlyForState: (state: NautiloState) => {
      assertCurrent(state);
      return boundHandoff.fullEncryptionOnly;
    },
  });
}
