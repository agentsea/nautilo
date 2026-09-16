import { describe, expect, test } from "bun:test";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import type { ProtectedMemoryRouteAuthority } from "../../src/routes/protected-memory-composition";
import { assertHumanMemoryRequestBinding } from "../../src/routes/human-memory-request-services";

const envelope: MemoryAccessEnvelope = {
  ownerId: "user", actorId: "actor", agentId: "surrounding-agent", roomId: "room",
  readableNamespaces: ["a", "b"], mutableNamespaces: ["a"],
  writableNamespaces: ["a"], toolPolicy: {},
};
const authority: ProtectedMemoryRouteAuthority = {
  userId: "user", actorId: "actor", agentId: null, memoryMode: "namespace",
  readableNamespaceIds: ["b", "a"], mutableNamespaceIds: ["a"],
  writableNamespaceIds: ["a"], sourceRoomId: "room", scopeId: null,
  originWritableNamespaceId: null,
};
const input = { authority, envelope, serverId: "https://server.invalid",
  policy: { mode: "encrypted_only", shadowBehavior: "strict", revision: 1 } as const };

describe("Human Memory request service binding", () => {
  test("uses the Human principal independently of the surrounding Agent", () => {
    expect(() => assertHumanMemoryRequestBinding(input)).not.toThrow();
    expect(() => assertHumanMemoryRequestBinding({ ...input,
      envelope: { ...envelope, agentId: "different-surrounding-agent" },
    })).not.toThrow();
    expect(() => assertHumanMemoryRequestBinding({ ...input,
      policy: { ...input.policy, mode: "shadow_encryption", shadowBehavior: "fallback" },
    })).not.toThrow();
  });

  test("rejects account, actor, Room and Namespace substitution before acquiring handles", () => {
    const changed: Partial<ProtectedMemoryRouteAuthority>[] = [
      { userId: "other" }, { actorId: "other" }, { agentId: "surrounding-agent" },
      { sourceRoomId: "other" }, { readableNamespaceIds: ["a", "c"] },
      { readableNamespaceIds: ["a", "a"] }, { mutableNamespaceIds: ["a", "b"] },
      { writableNamespaceIds: ["b"] }, { scopeId: "scope" },
      { originWritableNamespaceId: "a" },
    ];
    for (const patch of changed) {
      expect(() => assertHumanMemoryRequestBinding({ ...input,
        authority: { ...authority, ...patch },
      })).toThrow("exact current library authority");
    }
  });

  test("does not route Plaintext or deferred scopes into crypto services", () => {
    expect(() => assertHumanMemoryRequestBinding({ ...input,
      policy: { ...input.policy, mode: "plaintext_only" },
    })).toThrow("exact current library authority");
    expect(() => assertHumanMemoryRequestBinding({ ...input,
      envelope: { memoryMode: "scope", ownerId: "user", actorId: "actor",
        agentId: "agent", roomId: "room", scopeId: "scope", toolPolicy: {} },
    })).toThrow("exact current library authority");
  });
});
