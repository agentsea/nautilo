import { afterEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryAccessEnvelope } from "@nautilo/trust";

type ArtifactRow = {
  id: string;
  path: string;
  storageUri: string;
  revision: number;
};

let lookup: (input: { internalId: string; readableNamespaceIds: string[] }) => Promise<ArtifactRow | null> =
  async () => null;
const realDb = await import("@nautilo/db");
mock.module("@nautilo/db", () => ({
  ...realDb,
  findArtifactByInternalIdForNamespaces: (input: { internalId: string; readableNamespaceIds: string[] }) => lookup(input),
}));

const {
  resolveWorkspaceHumanEditLeaseTarget,
} = await import("../../src/document-mutations/human-edit-lease-targets");

const ARTIFACT_ID = "11111111-1111-4111-8111-111111111111";
const envelope = {
  ownerId: "user-1",
  actorId: "actor-1",
  agentId: "agent-1",
  roomId: "room-1",
  readableNamespaces: ["readable"],
  mutableNamespaces: ["mutable"],
  writableNamespaces: ["mutable"],
} as MemoryAccessEnvelope;

const temporaryDirs: string[] = [];
afterEach(async () => {
  lookup = async () => null;
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("human edit lease target resolution", () => {
  test("derives workspace canonical identity/version from mutable row and bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nautilo-d448-"));
    temporaryDirs.push(dir);
    const file = join(dir, "document.md");
    await writeFile(file, "trusted workspace bytes", "utf8");
    const calls: string[][] = [];
    lookup = async ({ readableNamespaceIds }) => {
      calls.push(readableNamespaceIds);
      return readableNamespaceIds[0] === "mutable"
        ? { id: ARTIFACT_ID, path: "docs/document.md", storageUri: `file://${file}`, revision: 17 }
        : null;
    };

    const result = await resolveWorkspaceHumanEditLeaseTarget({
      envelope,
      candidate: {
        kind: "workspace_artifact",
        artifactInternalId: ARTIFACT_ID,
        logicalPath: "docs/document.md",
      },
    });

    expect(result).toEqual({
      ok: true,
      target: {
        identity: {
          kind: "workspace_artifact",
          artifactId: ARTIFACT_ID,
          logicalPath: "docs/document.md",
        },
        baseVersion: {
          identity: {
            kind: "workspace_artifact",
            artifactId: ARTIFACT_ID,
            logicalPath: "docs/document.md",
          },
          backendVersion: { kind: "artifact_revision", revision: 17 },
          sha256: sha256("trusted workspace bytes"),
        },
        bytes: Buffer.from("trusted workspace bytes"),
      },
    });
    expect(calls).toEqual([["mutable"]]);
  });

  test("distinguishes readable-but-not-mutable and rejects stale logical-path hints", async () => {
    lookup = async ({ readableNamespaceIds }) => {
      if (readableNamespaceIds[0] === "mutable") return null;
      return { id: ARTIFACT_ID, path: "docs/renamed.md", storageUri: "file:///absent", revision: 1 };
    };
    const forbidden = await resolveWorkspaceHumanEditLeaseTarget({
      envelope,
      candidate: { kind: "workspace_artifact", artifactInternalId: ARTIFACT_ID, logicalPath: "docs/old.md" },
    });
    expect(forbidden).toEqual({ ok: false, code: "forbidden" });

    lookup = async () => ({
      id: ARTIFACT_ID,
      path: "docs/renamed.md",
      storageUri: "file:///absent",
      revision: 1,
    });
    const absent = await resolveWorkspaceHumanEditLeaseTarget({
      envelope,
      candidate: { kind: "workspace_artifact", artifactInternalId: ARTIFACT_ID, logicalPath: "docs/old.md" },
    });
    expect(absent).toEqual({ ok: false, code: "not_found" });
  });

});
