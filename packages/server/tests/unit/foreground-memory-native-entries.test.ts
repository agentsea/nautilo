import { describe, expect, test } from "bun:test";
import { createForegroundMemoryProjectionPort, resolveForegroundMemoryNativeEntries } from
  "../../src/routes/foreground-memory-repository";

const NS = "10000000-0000-4000-8000-000000000001";

describe("foreground Memory native entry resolution", () => {
  test("rejects projection assembly outside an exact foreground namespace identity", async () => {
    let message = "";
    try {
      await createForegroundMemoryProjectionPort({
        envelope: { memoryMode: "scope", ownerId: "user", agentId: "agent",
          actorId: "actor", roomId: "room", scopeId: "scope",
          toolPolicy: {} } as never,
        policy: { mode: "encrypted_only", shadowBehavior: "strict", revision: 1 },
        wakeEffectRecovery() {},
        domain: { subjectUserId: "user", agentId: "agent" } as never,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("projection identity");
  });

  test("selects the exact historical envelope coordinate, not the current head", async () => {
    const calls: unknown[] = [];
    const result = await resolveForegroundMemoryNativeEntries({
      inspectNamespaceGenerationAuthorityMetadata: async (input) => {
        calls.push(input);
        return { status: "ready" as const, namespaceId: NS,
          currentGeneration: 4, retainedGenerations: [
            { generation: 0, accessRevision: 2,
              headDigest: new Uint8Array(32).fill(1),
              publicationDigest: new Uint8Array(32).fill(1),
              publicationSetDigest: new Uint8Array(32).fill(1),
              audienceFingerprint: new Uint8Array(32).fill(1) },
            { generation: 4, accessRevision: 7,
              headDigest: new Uint8Array(32).fill(2),
              publicationDigest: new Uint8Array(32).fill(2),
              publicationSetDigest: new Uint8Array(32).fill(2),
              audienceFingerprint: new Uint8Array(32).fill(2) },
          ] };
      },
    }, [{ namespaceId: NS, generation: 0, accessRevision: 2,
      envelopeHash: new Uint8Array(32).fill(3) }]);
    expect(calls).toEqual([{ namespaceId: NS, keyClass: "ai",
      requested: [{ generation: 0, accessRevision: 2 }] }]);
    expect(result?.[0]?.keyGeneration).toBe(0);
    expect(result?.[0]?.headDigest[0]).toBe(1);
  });

  test("does not manufacture an entry when exact metadata is absent", async () => {
    const result = await resolveForegroundMemoryNativeEntries({
      inspectNamespaceGenerationAuthorityMetadata: async () => ({
        status: "ready" as const, namespaceId: NS, currentGeneration: 4,
        retainedGenerations: [],
      }),
    }, [{ namespaceId: NS, generation: 0, accessRevision: 2,
      envelopeHash: new Uint8Array(32).fill(3) }]);
    expect(result).toBeNull();
  });
});
