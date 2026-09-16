import { describe, expect, test } from "bun:test";
import type { DocumentIdentity } from "@nautilo/types";
import {
  validateDocumentCommitPlan,
  type HashBytes,
} from "../../src/plan-validation";

const workspaceA = {
  kind: "workspace_artifact",
  artifactId: "7d3bef58-16f0-4c6f-8ee7-137b28d8bfd6",
  logicalPath: "notes/a.md",
} as const;
const workspaceB = { ...workspaceA, logicalPath: "notes/b.md" } as const;
const preconditionWorkspace = {
  ...workspaceA,
  artifactId: "cc4d92f7-6686-4e72-9cea-3b344206dd44",
  logicalPath: "notes/source.docx",
} as const;
const overwriteDestination = {
  ...workspaceB,
  artifactId: "bb4d92f7-6686-4e72-9cea-3b344206dd44",
} as const;
const localA = {
  kind: "local_file",
  relayId: "relay-1",
  canonicalPath: "/Users/test/notes/a.md",
} as const;

const hashBytes: HashBytes = (bytes) =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

function sha(bytes: Uint8Array): string {
  return hashBytes(bytes) as string;
}

function snapshot(identity: DocumentIdentity, bytes: Uint8Array) {
  const digest = sha(bytes);
  return {
    identity,
    expectedVersion:
      identity.kind === "workspace_artifact"
        ? {
            identity,
            backendVersion: { kind: "artifact_revision" as const, revision: 4 },
            sha256: digest,
          }
        : {
            identity,
            backendVersion: { kind: "local_sha" as const, sha256: digest },
            sha256: digest,
          },
    bytes,
  };
}

function postImage(identity: DocumentIdentity, bytes: Uint8Array) {
  return { identity, sha256: sha(bytes), bytes };
}

function plan(entries: unknown[]) {
  return {
    operationId: "operation-1",
    actor: { kind: "agent", agentId: "agent-1" },
    entries,
  };
}

describe("D448 commit plan byte validation", () => {
  test("hashes read-only preconditions while leaving them outside mutation entries", async () => {
    const input = plan([
      { kind: "create", after: postImage(workspaceB, new Uint8Array([1])) },
    ]);
    const precondition = snapshot(preconditionWorkspace, new Uint8Array([9]));
    const valid = await validateDocumentCommitPlan({
      ...input,
      preconditions: [precondition],
    }, "workspace", hashBytes);
    expect(valid.kind).toBe("valid");

    const invalid = await validateDocumentCommitPlan({
      ...input,
      preconditions: [{ ...precondition, bytes: new Uint8Array([8]) }],
    }, "workspace", hashBytes);
    expect(invalid).toMatchObject({
      kind: "invalid",
      code: "hash_mismatch",
      diagnostics: [{ path: ["preconditions", 0, "expectedVersion", "sha256"] }],
    });
  });

  test("accepts a Workspace plan only after hashing every snapshot and post-image", async () => {
    const before = new Uint8Array([1]);
    const displaced = new Uint8Array([2]);
    const after = new Uint8Array([3]);
    const seen: Uint8Array[] = [];

    const result = await validateDocumentCommitPlan(
      plan([
        {
          kind: "move",
          source: snapshot(workspaceA, before),
          destinationBefore: snapshot(overwriteDestination, displaced),
          after: postImage(workspaceB, after),
        },
      ]),
      "workspace",
      (bytes) => {
        seen.push(bytes);
        return hashBytes(bytes);
      },
    );

    expect(result.kind).toBe("valid");
    expect(seen).toEqual([before, displaced, after]);
  });

  test("accepts all four entry kinds for the Desktop backend", async () => {
    const identities = [0, 1, 2, 3, 4].map((index) => ({
      ...localA,
      canonicalPath: `/Users/test/notes/${index}.md`,
    }));
    const result = await validateDocumentCommitPlan(
      plan([
        { kind: "create", after: postImage(identities[0]!, new Uint8Array([1])) },
        {
          kind: "update",
          before: snapshot(identities[1]!, new Uint8Array([2])),
          after: postImage(identities[1]!, new Uint8Array([3])),
        },
        {
          kind: "move",
          source: snapshot(identities[2]!, new Uint8Array([4])),
          after: postImage(identities[3]!, new Uint8Array([5])),
        },
        {
          kind: "delete",
          before: snapshot(identities[4]!, new Uint8Array([6])),
        },
      ]),
      "desktop",
      hashBytes,
    );

    expect(result.kind).toBe("valid");
  });

  test("rejects backend mismatch before invoking the hash function", async () => {
    let hashCalls = 0;
    const result = await validateDocumentCommitPlan(
      plan([
        {
          kind: "create",
          after: postImage(localA, new Uint8Array([1])),
        },
      ]),
      "workspace",
      () => {
        hashCalls += 1;
        return "a".repeat(64);
      },
    );

    expect(result).toMatchObject({
      kind: "invalid",
      code: "backend_mismatch",
      diagnostics: [{ code: "backend_mismatch", path: ["entries", 0] }],
    });
    expect(hashCalls).toBe(0);
  });

  test("reports every mismatched snapshot and post-image with exact paths", async () => {
    const result = await validateDocumentCommitPlan(
      plan([
        {
          kind: "update",
          before: {
            ...snapshot(workspaceA, new Uint8Array([1])),
            bytes: new Uint8Array([9]),
          },
          after: {
            ...postImage(workspaceA, new Uint8Array([2])),
            bytes: new Uint8Array([8]),
          },
        },
      ]),
      "workspace",
      hashBytes,
    );

    expect(result).toMatchObject({
      kind: "invalid",
      code: "hash_mismatch",
      diagnostics: [
        {
          code: "hash_mismatch",
          path: ["entries", 0, "before", "expectedVersion", "sha256"],
        },
        {
          code: "hash_mismatch",
          path: ["entries", 0, "after", "sha256"],
        },
      ],
    });
  });

  test("returns structured schema and hashing failures", async () => {
    const malformed = await validateDocumentCommitPlan(
      { operationId: "", entries: [] },
      "workspace",
      hashBytes,
    );
    expect(malformed.kind).toBe("invalid");
    if (malformed.kind !== "invalid") throw new Error("expected invalid plan");
    expect(malformed.code).toBe("invalid_plan");
    expect(malformed.diagnostics[0]).toMatchObject({ code: "schema_invalid" });

    const invalidHash = await validateDocumentCommitPlan(
      plan([
        {
          kind: "create",
          after: postImage(workspaceA, new Uint8Array([1])),
        },
      ]),
      "workspace",
      () => "NOT-A-SHA",
    );
    expect(invalidHash).toMatchObject({
      kind: "invalid",
      code: "hash_failure",
      diagnostics: [{ code: "hash_invalid", actual: "NOT-A-SHA" }],
    });

    const thrown = await validateDocumentCommitPlan(
      plan([
        {
          kind: "create",
          after: postImage(workspaceA, new Uint8Array([1])),
        },
      ]),
      "workspace",
      () => {
        throw new Error("digest unavailable");
      },
    );
    expect(thrown).toMatchObject({
      kind: "invalid",
      code: "hash_failure",
      diagnostics: [{ code: "hash_failure", message: "digest unavailable" }],
    });
  });

  test("does not impose a byte-count ceiling", async () => {
    const largeBytes = new Uint8Array(16 * 1024 * 1024 + 7);
    largeBytes[largeBytes.length - 1] = 1;
    const result = await validateDocumentCommitPlan(
      plan([{ kind: "create", after: postImage(workspaceA, largeBytes) }]),
      "workspace",
      hashBytes,
    );

    expect(result.kind).toBe("valid");
  });
});
