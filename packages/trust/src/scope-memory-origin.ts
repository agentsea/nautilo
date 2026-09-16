import type {
  NamespaceMemoryEnvelope,
  ScopeMemoryEnvelope,
} from "./types";

export class ScopeMemoryOriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeMemoryOriginError";
  }
}

export type ScopeMemoryEnvelopeWithOrigin = ScopeMemoryEnvelope & Readonly<{
  readonly originWritableNamespaceId: string;
}>;

export function createScopeMemoryEnvelopeWithOrigin(
  parent: NamespaceMemoryEnvelope,
  scopeId: string,
): ScopeMemoryEnvelopeWithOrigin {
  const normalizedScopeId = scopeId.trim();
  if (normalizedScopeId.length === 0) {
    throw new ScopeMemoryOriginError("scope id must not be empty");
  }

  if (parent.writableNamespaces.length !== 1) {
    throw new ScopeMemoryOriginError(
      "scope Memory origin requires exactly one parent write target",
    );
  }

  const originWritableNamespaceId = parent.writableNamespaces[0]?.trim() ?? "";
  if (originWritableNamespaceId.length === 0) {
    throw new ScopeMemoryOriginError(
      "scope Memory origin namespace must not be empty",
    );
  }

  return {
    memoryMode: "scope",
    ownerId: parent.ownerId,
    actorId: parent.actorId,
    agentId: parent.agentId,
    roomId: parent.roomId,
    scopeId: normalizedScopeId,
    originWritableNamespaceId,
    toolPolicy: { ...parent.toolPolicy },
  };
}
