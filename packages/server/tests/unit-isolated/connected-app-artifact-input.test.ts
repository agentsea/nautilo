import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as agent from "@nautilo/agent";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import {
  ConnectedAppArtifactInputError,
  openWorkspaceArtifactInput,
} from "../../src/connected-apps/artifact-input";

const envelope = {
  memoryMode: "namespace",
  readableNamespaces: ["22222222-2222-4222-8222-222222222222"],
  writableNamespaces: ["22222222-2222-4222-8222-222222222222"],
} as unknown as MemoryAccessEnvelope;

describe("D456 connected-app Room artifact input", () => {
  let root: string;
  const restores: Array<() => void> = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "d456-artifact-input-"));
    const facts = spyOn(agent, "envelopeFactsForArtifacts").mockReturnValue({
      ok: true,
      facts: {
        userId: "11111111-1111-4111-8111-111111111111",
        agentId: "33333333-3333-4333-8333-333333333333",
        readableNamespaces: ["22222222-2222-4222-8222-222222222222"],
        mutableNamespaces: ["22222222-2222-4222-8222-222222222222"],
        writableNamespaces: ["22222222-2222-4222-8222-222222222222"],
      },
    } as ReturnType<typeof agent.envelopeFactsForArtifacts>);
    restores.push(() => facts.mockRestore());
  });

  afterEach(async () => {
    while (restores.length > 0) restores.pop()?.();
    await rm(root, { recursive: true, force: true });
  });

  test("opens and verifies the exact authorized ordinary artifact without exposing its physical path", async () => {
    const physicalPath = join(root, "artifact-A");
    await writeFile(physicalPath, Uint8Array.from([37, 80, 68, 70]));
    const row = artifactRow(physicalPath, 4);
    const resolve = spyOn(agent, "resolveWorkspaceArtifact").mockResolvedValue({
      ok: true,
      artifact: row,
      physicalPath,
      artifactId: row.artifactId,
      storageUri: row.storageUri,
      logicalPath: "brief.pdf",
    } as Awaited<ReturnType<typeof agent.resolveWorkspaceArtifact>>);
    restores.push(() => resolve.mockRestore());

    const source = await openWorkspaceArtifactInput({ envelope, artifactPath: "/brief.pdf" });
    const bytes: number[] = [];
    for await (const chunk of source.chunks) bytes.push(...chunk);
    await source.verify();
    await source.close();

    expect(bytes).toEqual([37, 80, 68, 70]);
    expect(source).toMatchObject({ name: "brief.pdf", mimeType: "application/pdf", sizeBytes: 4 });
    expect(JSON.stringify(source)).not.toContain(physicalPath);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve.mock.calls[0]?.[0]).toMatchObject({ logicalPath: "brief.pdf", intent: "read" });
  });

  test("detects path replacement after staging even when the catalog row is unchanged", async () => {
    const physicalPath = join(root, "artifact-B");
    const replacementPath = join(root, "replacement");
    await writeFile(physicalPath, Uint8Array.from([1, 2, 3, 4]));
    await writeFile(replacementPath, Uint8Array.from([5, 6, 7, 8]));
    const row = artifactRow(physicalPath, 4);
    const resolve = spyOn(agent, "resolveWorkspaceArtifact").mockResolvedValue({
      ok: true,
      artifact: row,
      physicalPath,
      artifactId: row.artifactId,
      storageUri: row.storageUri,
      logicalPath: "moving.bin",
    } as Awaited<ReturnType<typeof agent.resolveWorkspaceArtifact>>);
    restores.push(() => resolve.mockRestore());

    const source = await openWorkspaceArtifactInput({ envelope, artifactPath: "moving.bin" });
    await rename(replacementPath, physicalPath);
    const error = await source.verify().catch((cause: unknown) => cause);
    await source.close();

    expect(error).toEqual(new ConnectedAppArtifactInputError("connected_app_artifact_changed", 409));
  });
});

function artifactRow(physicalPath: string, size: number) {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    agentId: "33333333-3333-4333-8333-333333333333",
    artifactId: "artifact-A",
    path: "brief.pdf",
    mimeType: "application/pdf",
    size,
    storageUri: `file://${physicalPath}`,
    revision: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };
}
