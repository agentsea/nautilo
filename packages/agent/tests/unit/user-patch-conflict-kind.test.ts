import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Artifact } from "@nautilo/db";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import * as artifactStore from "../../src/tools/file/artifact-store";
import { applyWorkspaceArtifactTextPatch } from "../../src/tools/file/user-patch";
import * as workspaceCommands from "../../src/tools/file/workspace-commands";
import { sha256Hex } from "../../src/tools/file/staged-patches";

describe("applyWorkspaceArtifactTextPatch conflict kinds", () => {
  let tmpFile: string;
  const restores: Array<() => void> = [];
  const envelope: MemoryAccessEnvelope = {
    ownerId: "user-1",
    actorId: "actor-1",
    agentId: "agent-1",
    roomId: "room-1",
    readableNamespaces: ["ns-1"],
    mutableNamespaces: ["ns-1"],
    writableNamespaces: ["ns-1"],
    toolPolicy: {},
  };

  const artifact: Artifact = {
    id: "row-1",
    artifactId: "artifact-ext",
    path: "notes.txt",
    storageUri: "file:///unused",
    revision: 1,
    mimeType: "text/plain",
    size: 14,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  beforeEach(async () => {
    tmpFile = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), "user-patch-")), "notes.txt");
    artifact.storageUri = `file://${tmpFile}`;
    await fsp.writeFile(tmpFile, "current text\n");

    const factsSpy = spyOn(artifactStore, "envelopeFactsForArtifacts").mockReturnValue({
      ok: true,
      facts: {
        userId: "user-1",
        agentId: "agent-1",
        mutableNamespaces: ["ns-1"],
        readableNamespaces: ["ns-1"],
        writableNamespaces: ["ns-1"],
      },
    } as ReturnType<typeof artifactStore.envelopeFactsForArtifacts>);
    restores.push(() => factsSpy.mockRestore());
    const namespaceSpy = spyOn(workspaceCommands, "pickMutationNamespaceId").mockResolvedValue("ns-1");
    restores.push(() => namespaceSpy.mockRestore());
    const rowChangeSpy = spyOn(artifactStore, "applyWorkspaceArtifactRowChange").mockResolvedValue({
      internalId: "row-1",
      artifactId: "artifact-ext",
      path: "notes.txt",
      revision: 2,
      previousRevision: 1,
    });
    restores.push(() => rowChangeSpy.mockRestore());
    const emitSpy = spyOn(artifactStore, "emitWorkspaceArtifactDocumentPatchApplied").mockImplementation(
      () => {},
    );
    restores.push(() => emitSpy.mockRestore());
  });

  afterEach(async () => {
    for (const restore of restores.splice(0)) {
      restore();
    }
    await fsp.rm(path.dirname(tmpFile), { recursive: true, force: true });
  });

  test("exact base with missing anchor returns anchor_not_found", async () => {
    const current = "current text\n";
    const currentSha = sha256Hex(Buffer.from(current, "utf8"));

    const result = await applyWorkspaceArtifactTextPatch({
      envelope,
      artifact,
      requestId: "req-1",
      baseRevision: 1,
      baseSha256: currentSha,
      patch: { kind: "anchored_text", oldString: "missing", newString: "x" },
      checkpoint: false,
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      rejection: { kind: "anchor_not_found" },
    });
  });

  test("stale base SHA with missing anchor returns stale_base_unrebaseable", async () => {
    const result = await applyWorkspaceArtifactTextPatch({
      envelope,
      artifact,
      requestId: "req-2",
      baseRevision: 1,
      baseSha256: "stale-sha",
      patch: { kind: "anchored_text", oldString: "missing", newString: "x" },
      checkpoint: false,
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      rejection: { kind: "stale_base_unrebaseable" },
    });
  });

  test("stale base SHA with ambiguous anchor returns anchor_ambiguous", async () => {
    await fsp.writeFile(tmpFile, "dup\ndup\n");

    const result = await applyWorkspaceArtifactTextPatch({
      envelope,
      artifact,
      requestId: "req-3",
      baseRevision: 1,
      baseSha256: "stale-sha",
      patch: { kind: "anchored_text", oldString: "dup", newString: "x" },
      checkpoint: false,
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      rejection: { kind: "anchor_ambiguous" },
    });
  });
});
