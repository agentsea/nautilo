import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  MEMORY_ENCRYPTION_SURFACES,
  validateMemoryEncryptionInventory,
} from "../../src/node/memory-encryption-inventory";

const repositoryRoot = resolve(import.meta.dir, "../../../..");

describe("Wave 12 Memory encryption inventory", () => {
  test("pins every known Memory content boundary", () => {
    expect(MEMORY_ENCRYPTION_SURFACES).toHaveLength(37);
    expect(new Set(MEMORY_ENCRYPTION_SURFACES.map((item) => item.boundary))).toEqual(
      new Set([
        "schema",
        "store",
        "embedding",
        "agent_tool",
        "human_api",
        "client_dto",
        "client_custody",
        "background",
        "portability",
        "scope_authority",
      ]),
    );
    expect(
      new Set(MEMORY_ENCRYPTION_SURFACES.map((item) => item.implementationState)),
    ).toEqual(new Set(["legacy_only", "protected", "typed_unavailable"]));
    expect(
      MEMORY_ENCRYPTION_SURFACES
        .filter((item) => item.implementationState === "protected")
        .every((item) => item.implementationAnchors.length > 0),
    ).toBe(true);
    expect(validateMemoryEncryptionInventory(repositoryRoot)).toEqual([]);
  });

  test("fails closed when a reviewed source anchor moves", () => {
    expect(validateMemoryEncryptionInventory(repositoryRoot, [{
      id: "memory.missing",
      sourcePath: "packages/agent/src/store/memory-store.ts",
      anchor: "missing Wave 12 Memory boundary",
      boundary: "store",
      duties: ["plaintext_read"],
      implementationState: "legacy_only",
      implementationAnchors: [],
    }])).toEqual([
      "missing Memory encryption anchor: packages/agent/src/store/memory-store.ts#missing Wave 12 Memory boundary",
    ]);
  });

  test("rejects a protected claim without a checked implementation anchor", () => {
    expect(validateMemoryEncryptionInventory(repositoryRoot, [{
      id: "memory.unproved-protected",
      sourcePath: "packages/agent/src/store/memory-store.ts",
      anchor: "export async function saveMemory",
      boundary: "store",
      duties: ["protected_write"],
      implementationState: "protected",
      implementationAnchors: [],
    }])).toEqual([
      "protected Memory surface has no implementation anchor: memory.unproved-protected",
    ]);
  });

  test("rejects a protected claim whose semantic implementation anchor moved", () => {
    expect(validateMemoryEncryptionInventory(repositoryRoot, [{
      id: "memory.moved-protected",
      sourcePath: "packages/agent/src/tools/memory/manage-memory.ts",
      anchor: "export function createManageMemoryTool",
      boundary: "agent_tool",
      duties: ["protected_write"],
      implementationState: "protected",
      implementationAnchors: [{
        sourcePath: "packages/agent/src/tools/memory/manage-memory.ts",
        anchor: "missing protected Memory repository branch",
      }],
    }])).toEqual([
      "missing Memory implementation anchor: packages/agent/src/tools/memory/manage-memory.ts#missing protected Memory repository branch",
    ]);
  });

  test("forbids dormant Memory adapters from erasing rollback shadow columns", () => {
    const productAdapters = [
      "packages/lattice-bridge/src/server/memory/postgres-memory-product-store.ts",
      "packages/lattice-bridge/src/server/memory/postgres-agent-memory-product-port.ts",
      "packages/lattice-bridge/src/server/memory/postgres-human-memory-product-update.ts",
    ];

    for (const sourcePath of productAdapters) {
      const source = readFileSync(resolve(repositoryRoot, sourcePath), "utf8");
      expect(source).not.toMatch(/(?:\bSET|,)\s*(?:content|type)\s*=/u);
    }
  });
});
