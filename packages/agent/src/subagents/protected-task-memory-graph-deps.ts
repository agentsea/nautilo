import type {
  ProtectedAgentMemoryAccessPort,
  ProtectedAgentMemoryProjectionPort,
  ProtectedAgentMemoryRepository,
  ProtectedAgentMemorySearchPort,
} from "@nautilo/lattice-bridge";
import {
  isNamespaceMemoryEnvelope,
  isScopeMemoryEnvelope,
  type MemoryAccessEnvelope,
  type NamespaceMemoryEnvelope,
  type ScopeMemoryEnvelope,
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
  access?: ProtectedAgentMemoryAccessPort;
  projection?: ProtectedAgentMemoryProjectionPort;
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
  if (handoff?.access !== undefined) {
    requiredMethod(handoff.access, "change", "access port");
  }
  if (handoff?.projection !== undefined) {
    for (const method of ["prepare", "publish"] as const) {
      requiredMethod(handoff.projection, method, "projection port");
    }
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
  expected: BoundMemoryAccessEnvelope,
): boolean {
  if (current === null || current === undefined
    || !sameStrings(Object.keys(current).sort(), Object.keys(expected).sort())
    || current.memoryMode !== expected.memoryMode
    || current.ownerId !== expected.ownerId
  ) return false;
  if (current.actorId !== expected.actorId
    || current.agentId !== expected.agentId
    || current.roomId !== expected.roomId
    || !sameToolPolicy(current.toolPolicy, expected.toolPolicy)) return false;
  if (isNamespaceMemoryEnvelope(expected)) {
    return isNamespaceMemoryEnvelope(current)
      && sameStrings(current.readableNamespaces, expected.readableNamespaces)
      && sameStrings(current.mutableNamespaces, expected.mutableNamespaces)
      && sameStrings(current.writableNamespaces, expected.writableNamespaces);
  }
  if (!isScopeMemoryEnvelope(current)) return false;
  const currentOrigin = Object.hasOwn(current, "originWritableNamespaceId")
    ? (current as ScopeMemoryEnvelopeWithOptionalOrigin)
      .originWritableNamespaceId
    : undefined;
  const expectedOrigin = Object.hasOwn(expected, "originWritableNamespaceId")
    ? expected.originWritableNamespaceId
    : undefined;
  return current.scopeId === expected.scopeId
    && currentOrigin === expectedOrigin;
}

type ScopeMemoryEnvelopeWithOptionalOrigin = ScopeMemoryEnvelope & Readonly<{
  originWritableNamespaceId?: string;
}>;

type BoundMemoryAccessEnvelope =
  | NamespaceMemoryEnvelope
  | ScopeMemoryEnvelopeWithOptionalOrigin;

const NAMESPACE_ENVELOPE_KEYS = Object.freeze([
  "actorId",
  "agentId",
  "mutableNamespaces",
  "ownerId",
  "readableNamespaces",
  "roomId",
  "toolPolicy",
  "writableNamespaces",
]);

const SCOPE_ENVELOPE_KEYS = Object.freeze([
  "actorId",
  "agentId",
  "memoryMode",
  "ownerId",
  "roomId",
  "scopeId",
  "toolPolicy",
]);

function cloneEnvelope(
  envelope: MemoryAccessEnvelope,
): BoundMemoryAccessEnvelope {
  if (isNamespaceMemoryEnvelope(envelope)) {
    const hasMemoryMode = Object.hasOwn(envelope, "memoryMode");
    const expectedKeys = hasMemoryMode
      ? [...NAMESPACE_ENVELOPE_KEYS, "memoryMode"].sort()
      : NAMESPACE_ENVELOPE_KEYS;
    if (!sameStrings(Object.keys(envelope).sort(), expectedKeys)) {
      throw new TypeError("Protected Task Memory envelope shape changed");
    }
    return Object.freeze({
      ...(hasMemoryMode ? { memoryMode: envelope.memoryMode } : {}),
      ownerId: envelope.ownerId,
      actorId: envelope.actorId,
      agentId: envelope.agentId,
      roomId: envelope.roomId,
      readableNamespaces: Object.freeze([...envelope.readableNamespaces]),
      mutableNamespaces: Object.freeze([...envelope.mutableNamespaces]),
      writableNamespaces: Object.freeze([...envelope.writableNamespaces]),
      toolPolicy: Object.freeze({ ...envelope.toolPolicy }),
    }) as NamespaceMemoryEnvelope;
  }
  if (!isScopeMemoryEnvelope(envelope)) {
    throw new TypeError("Protected Task Memory envelope shape changed");
  }
  const withOrigin = envelope as ScopeMemoryEnvelopeWithOptionalOrigin;
  const hasOrigin = Object.hasOwn(envelope, "originWritableNamespaceId");
  const expectedKeys = hasOrigin
    ? [...SCOPE_ENVELOPE_KEYS, "originWritableNamespaceId"].sort()
    : SCOPE_ENVELOPE_KEYS;
  if (!sameStrings(Object.keys(envelope).sort(), expectedKeys)) {
    throw new TypeError("Protected Task Memory envelope shape changed");
  }
  return Object.freeze({
    memoryMode: envelope.memoryMode,
    ownerId: envelope.ownerId,
    actorId: envelope.actorId,
    agentId: envelope.agentId,
    roomId: envelope.roomId,
    scopeId: envelope.scopeId,
    ...(hasOrigin
      ? { originWritableNamespaceId: withOrigin.originWritableNamespaceId }
      : {}),
    toolPolicy: Object.freeze({ ...envelope.toolPolicy }),
  }) as ScopeMemoryEnvelopeWithOptionalOrigin;
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
    ...(handoff.access === undefined ? {} : { access: handoff.access }),
    ...(handoff.projection === undefined
      ? {}
      : { projection: handoff.projection }),
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
    ...(!("access" in boundHandoff) ? {} : {
      protectedMemoryAccessPortForState: (state: NautiloState) => {
        assertCurrent(state);
        return boundHandoff.access;
      },
    }),
    ...(!("projection" in boundHandoff) ? {} : {
      protectedMemoryProjectionPortForState: (state: NautiloState) => {
        assertCurrent(state);
        return boundHandoff.projection;
      },
    }),
    fullEncryptionOnlyForState: (state: NautiloState) => {
      assertCurrent(state);
      return boundHandoff.fullEncryptionOnly;
    },
  });
}
