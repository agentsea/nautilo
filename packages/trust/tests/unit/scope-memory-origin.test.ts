import { describe, expect, test } from "bun:test";

import {
  ScopeMemoryOriginError,
  createScopeMemoryEnvelopeWithOrigin,
  type NamespaceMemoryEnvelope,
} from "../../src";

function parentEnvelope(
  writableNamespaces: string[],
): NamespaceMemoryEnvelope {
  return {
    memoryMode: "namespace",
    ownerId: "user-alice",
    actorId: "actor-alice",
    agentId: "agent-genie",
    roomId: "room-ab",
    readableNamespaces: ["namespace-ab", "namespace-abc"],
    mutableNamespaces: ["namespace-ab", "namespace-abc"],
    writableNamespaces,
    toolPolicy: { manage_memory: "allow" },
  };
}

describe("scope Memory origin threading", () => {
  test("captures the parent's one exact current-Room write target", () => {
    expect(createScopeMemoryEnvelopeWithOrigin(
      parentEnvelope(["namespace-ab"]),
      "scope-1",
    )).toEqual({
      memoryMode: "scope",
      ownerId: "user-alice",
      actorId: "actor-alice",
      agentId: "agent-genie",
      roomId: "room-ab",
      scopeId: "scope-1",
      originWritableNamespaceId: "namespace-ab",
      toolPolicy: { manage_memory: "allow" },
    });
  });

  test("does not guess when the parent has zero or multiple write targets", () => {
    expect(() => createScopeMemoryEnvelopeWithOrigin(
      parentEnvelope([]),
      "scope-1",
    )).toThrow(ScopeMemoryOriginError);
    expect(() => createScopeMemoryEnvelopeWithOrigin(
      parentEnvelope(["namespace-a", "namespace-b"]),
      "scope-1",
    )).toThrow(ScopeMemoryOriginError);
  });
});
