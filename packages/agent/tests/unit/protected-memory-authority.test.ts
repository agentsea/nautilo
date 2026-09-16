import { describe, expect, test } from "bun:test";
import type { MemoryAccessEnvelope } from "@nautilo/trust";

import { protectedMemoryAuthorityFromEnvelope } from
  "../../src/tools/memory/protected-memory-authority";

const NAMESPACE_A = "30000000-0000-4000-8000-000000000001";
const NAMESPACE_B = "30000000-0000-4000-8000-000000000002";

function envelope(
  readableNamespaces: readonly string[],
  mutableNamespaces: readonly string[],
): MemoryAccessEnvelope {
  return {
    ownerId: "10000000-0000-4000-8000-000000000001",
    actorId: "10000000-0000-4000-8000-000000000002",
    agentId: "10000000-0000-4000-8000-000000000003",
    roomId: "10000000-0000-4000-8000-000000000004",
    readableNamespaces: [...readableNamespaces],
    mutableNamespaces: [...mutableNamespaces],
    writableNamespaces: [NAMESPACE_A],
    toolPolicy: {},
  };
}

describe("protected Memory authority", () => {
  test("canonicalizes an envelope's Namespace sets for the protected product boundary", () => {
    const authority = protectedMemoryAuthorityFromEnvelope(envelope(
      [NAMESPACE_B, NAMESPACE_A],
      [NAMESPACE_B, NAMESPACE_A],
    ));

    expect(authority).toMatchObject({
      mode: "namespace",
      readableNamespaceIds: [NAMESPACE_A, NAMESPACE_B],
      mutableNamespaceIds: [NAMESPACE_A, NAMESPACE_B],
    });
  });
});
