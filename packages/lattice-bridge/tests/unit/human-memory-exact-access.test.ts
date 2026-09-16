import { describe, expect, test } from "bun:test";

import {
  deriveHumanMemoryExactAccessChange,
  targetAfterAuthorizedViewDeletion,
  type HumanMemoryExactAccessAuthority,
} from "../../src/server/memory/human-memory-exact-access.ts";

const A = "10000000-0000-4000-8000-000000000001";
const B = "10000000-0000-4000-8000-000000000002";
const C = "10000000-0000-4000-8000-000000000003";

function authority(
  overrides: Partial<HumanMemoryExactAccessAuthority> = {},
): HumanMemoryExactAccessAuthority {
  return {
    userId: "user-1",
    subjectHumanId: "human-1",
    actorId: "actor-1",
    agentId: null,
    readableNamespaceIds: [A, B, C],
    mutableNamespaceIds: [A, B, C],
    writableNamespaceIds: [A, B, C],
    ...overrides,
  };
}

describe("exact Human Memory access-set derivation", () => {
  test("canonicalizes current/target and derives exact add/remove sets", () => {
    expect(deriveHumanMemoryExactAccessChange({
      authority: authority(),
      currentNamespaceIds: [B, A],
      proposedTargetNamespaceIds: [C, B],
    })).toEqual({
      status: "changed",
      currentNamespaceIds: [A, B],
      targetNamespaceIds: [B, C],
      addedNamespaceIds: [C],
      removedNamespaceIds: [A],
    });
  });

  test("returns unchanged before any durable operation is required", () => {
    expect(deriveHumanMemoryExactAccessChange({
      authority: authority(),
      currentNamespaceIds: [B, A],
      proposedTargetNamespaceIds: [A, B],
    })).toEqual({
      status: "unchanged",
      currentNamespaceIds: [A, B],
      targetNamespaceIds: [A, B],
      addedNamespaceIds: [],
      removedNamespaceIds: [],
    });
  });

  test("allows empty targets and preserves inaccessible attachments", () => {
    expect(targetAfterAuthorizedViewDeletion({
      currentNamespaceIds: [C, A, B],
      readableNamespaceIds: [B, A],
    })).toEqual([C]);
    const deletingView = deriveHumanMemoryExactAccessChange({
      authority: authority({
        readableNamespaceIds: [A, B],
        mutableNamespaceIds: [A, B],
        writableNamespaceIds: [A, B],
      }),
      currentNamespaceIds: [A, B, C],
      proposedTargetNamespaceIds: [C],
    });
    expect(deletingView).toMatchObject({
      status: "changed",
      targetNamespaceIds: [C],
      removedNamespaceIds: [A, B],
    });

    expect(deriveHumanMemoryExactAccessChange({
      authority: authority(),
      currentNamespaceIds: [A],
      proposedTargetNamespaceIds: [],
    })).toMatchObject({
      status: "changed",
      targetNamespaceIds: [],
      removedNamespaceIds: [A],
    });
  });

  test("fails closed on unauthorized add/remove and malformed sets", () => {
    expect(() => deriveHumanMemoryExactAccessChange({
      authority: authority({
        readableNamespaceIds: [C],
        writableNamespaceIds: [A, B, C],
      }),
      currentNamespaceIds: [A],
      proposedTargetNamespaceIds: [A, C],
    })).toThrow("read authority");
    expect(deriveHumanMemoryExactAccessChange({
      authority: authority({ writableNamespaceIds: [A] }),
      currentNamespaceIds: [A],
      proposedTargetNamespaceIds: [A, B],
    })).toMatchObject({ addedNamespaceIds: [B] });
    expect(() => deriveHumanMemoryExactAccessChange({
      authority: authority({ mutableNamespaceIds: [A], writableNamespaceIds: [A] }),
      currentNamespaceIds: [A],
      proposedTargetNamespaceIds: [A, B],
    })).toThrow("add authority");
    expect(() => deriveHumanMemoryExactAccessChange({
      authority: authority({ mutableNamespaceIds: [A] }),
      currentNamespaceIds: [A, B],
      proposedTargetNamespaceIds: [A],
    })).toThrow("remove authority");
    expect(() => deriveHumanMemoryExactAccessChange({
      authority: authority(),
      currentNamespaceIds: [A, A],
      proposedTargetNamespaceIds: [A],
    })).toThrow("duplicate");
    expect(() => deriveHumanMemoryExactAccessChange({
      authority: authority(),
      currentNamespaceIds: [A],
      proposedTargetNamespaceIds: ["cosmos"],
    })).toThrow("canonical UUID");
  });
});
