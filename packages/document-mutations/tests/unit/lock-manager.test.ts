import { describe, expect, test } from "bun:test";
import type { DocumentCommitPlan, DocumentIdentity } from "@nautilo/types";
import {
  deriveDocumentIdentityLockKeys,
  deriveDocumentLockKeys,
  InMemoryDocumentLockManager,
} from "../../src/lock-manager";

const workspaceA = {
  kind: "workspace_artifact",
  artifactId: "7d3bef58-16f0-4c6f-8ee7-137b28d8bfd6",
  logicalPath: "notes/a.md",
} as const;
const workspaceB = { ...workspaceA, logicalPath: "notes/b.md" } as const;
const localA = {
  kind: "local_file",
  relayId: "relay:one",
  canonicalPath: "/Users/test/notes/a.md",
} as const;

function plan(entries: DocumentCommitPlan["entries"]): DocumentCommitPlan {
  return {
    operationId: "operation-1",
    actor: { kind: "agent", agentId: "agent-1" },
    entries,
  };
}

function postImage(identity: DocumentIdentity) {
  return { identity, sha256: "b".repeat(64), bytes: new Uint8Array([2]) };
}

function snapshot(identity: DocumentIdentity) {
  return {
    identity,
    expectedVersion:
      identity.kind === "workspace_artifact"
        ? {
            identity,
            backendVersion: { kind: "artifact_revision" as const, revision: 1 },
            sha256: "a".repeat(64),
          }
        : {
            identity,
            backendVersion: {
              kind: "local_sha" as const,
              sha256: "a".repeat(64),
            },
            sha256: "a".repeat(64),
          },
    bytes: new Uint8Array([1]),
  };
}

describe("D448 deterministic document lock keys", () => {
  test("locks Workspace artifacts and logical paths independently", () => {
    expect(deriveDocumentIdentityLockKeys(workspaceA)).toEqual([
      "workspace:artifact:7d3bef58-16f0-4c6f-8ee7-137b28d8bfd6",
      "workspace:path:notes/a.md",
    ]);
    expect(
      deriveDocumentIdentityLockKeys({
        ...workspaceA,
        artifactId: "bb4d92f7-6686-4e72-9cea-3b344206dd44",
      }),
    ).toContain("workspace:path:notes/a.md");
    expect(deriveDocumentIdentityLockKeys(localA)).toEqual([
      "local:relay:one:path:/Users/test/notes/a.md",
    ]);
  });

  test("derives sorted, deduplicated keys for every path claimed by a plan", () => {
    const overwriteDestination = {
      ...workspaceB,
      artifactId: "bb4d92f7-6686-4e72-9cea-3b344206dd44",
    } as const;
    const keys = deriveDocumentLockKeys(
      plan([
        {
          kind: "move",
          source: snapshot(workspaceA),
          destinationBefore: snapshot(overwriteDestination),
          after: postImage(workspaceB),
        },
      ]),
    );

    expect(keys).toEqual(
      [
        ...new Set([
          ...deriveDocumentIdentityLockKeys(workspaceA),
          ...deriveDocumentIdentityLockKeys(workspaceB),
          ...deriveDocumentIdentityLockKeys(overwriteDestination),
        ]),
      ].sort(),
    );
  });

  test("locks read-only preconditions without turning them into mutation entries", () => {
    const source = {
      ...workspaceA,
      artifactId: "bb4d92f7-6686-4e72-9cea-3b344206dd44",
      logicalPath: "notes/source.docx",
    } as const;
    const keys = deriveDocumentLockKeys({
      ...plan([{ kind: "create", after: postImage(workspaceB) }]),
      preconditions: [snapshot(source)],
    });

    expect(keys).toEqual([
      ...deriveDocumentIdentityLockKeys(source),
      ...deriveDocumentIdentityLockKeys(workspaceB),
    ].sort());
  });
});

describe("D448 in-memory document lock manager", () => {
  test("sorts and deduplicates requested keys", async () => {
    const manager = new InMemoryDocumentLockManager();
    const lease = await manager.acquire(["z", "a", "z", "m"]);

    expect(lease.keys).toEqual(["a", "m", "z"]);
    lease.release();
    lease.release();
  });

  test("serializes contenders for the same key", async () => {
    const manager = new InMemoryDocumentLockManager();
    const first = await manager.acquire(["document"]);
    let secondAcquired = false;
    const secondPromise = manager.acquire(["document"]).then((lease) => {
      secondAcquired = true;
      return lease;
    });

    await Promise.resolve();
    expect(secondAcquired).toBe(false);
    first.release();

    const second = await secondPromise;
    expect(secondAcquired).toBe(true);
    second.release();
  });

  test("sorted multi-key acquisition avoids opposite-order deadlock", async () => {
    const manager = new InMemoryDocumentLockManager();
    const first = await manager.acquire(["b", "a"]);
    const secondPromise = manager.acquire(["a", "b"]);
    first.release();
    const second = await secondPromise;

    expect(second.keys).toEqual(["a", "b"]);
    second.release();
  });

  test("releases multi-key leases in reverse acquisition order", async () => {
    const manager = new InMemoryDocumentLockManager();
    const combined = await manager.acquire(["a", "b"]);
    const acquisitionOrder: string[] = [];
    const waitingOnA = manager.acquire(["a"]).then((lease) => {
      acquisitionOrder.push("a");
      return lease;
    });
    const waitingOnB = manager.acquire(["b"]).then((lease) => {
      acquisitionOrder.push("b");
      return lease;
    });

    combined.release();
    const [aLease, bLease] = await Promise.all([waitingOnA, waitingOnB]);
    expect(acquisitionOrder).toEqual(["b", "a"]);
    aLease.release();
    bLease.release();
  });
});
