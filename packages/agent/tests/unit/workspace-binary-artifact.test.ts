import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import * as artifactStore from "../../src/tools/file/artifact-store";
import {
  createWorkspaceBinaryArtifact,
  createWorkspaceBinaryArtifactFromStream,
} from "../../src/tools/file/workspace-binary-artifact";

describe("workspace binary artifact exclusive create", () => {
  let directory: string;
  let physicalPath: string;
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

  beforeEach(async () => {
    directory = await fsp.mkdtemp(path.join(os.tmpdir(), "workspace-binary-"));
    physicalPath = path.join(directory, "artifact.bin");
    const factsSpy = spyOn(artifactStore, "envelopeFactsForArtifacts").mockReturnValue({
      ok: true,
      facts: {
        userId: "user-1",
        agentId: "agent-1",
        readableNamespaces: ["ns-1"],
        mutableNamespaces: ["ns-1"],
        writableNamespaces: ["ns-1"],
      },
    } as ReturnType<typeof artifactStore.envelopeFactsForArtifacts>);
    restores.push(() => factsSpy.mockRestore());
    const resolveSpy = spyOn(artifactStore, "resolveWorkspaceArtifact").mockResolvedValue({
      ok: true,
      artifact: null,
      physicalPath,
      artifactId: "artifact-1",
      storageUri: `file://${physicalPath}`,
      logicalPath: "deck.pptx",
    });
    restores.push(() => resolveSpy.mockRestore());
    const applySpy = spyOn(artifactStore, "applyWorkspaceArtifactRowChange").mockResolvedValue({
      internalId: "row-1",
      artifactId: "artifact-1",
      path: "deck.pptx",
      revision: 1,
      previousRevision: null,
    });
    restores.push(() => applySpy.mockRestore());
  });

  afterEach(async () => {
    for (const restore of restores.splice(0)) restore();
    await fsp.rm(directory, { recursive: true, force: true });
  });

  test("buffer creates publish one winner without replacing its bytes", async () => {
    const results = await Promise.all([
      createWorkspaceBinaryArtifact({
        envelope,
        actor: { kind: "agent", agentId: "agent-1" },
        logicalPath: "deck.pptx",
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        bytes: Buffer.from("first"),
      }),
      createWorkspaceBinaryArtifact({
        envelope,
        actor: { kind: "agent", agentId: "agent-1" },
        logicalPath: "deck.pptx",
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        bytes: Buffer.from("second"),
      }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const failure = results.find((result) => !result.ok);
    expect(failure).toMatchObject({ ok: false, code: "EXISTS" });
    expect(["first", "second"]).toContain(await fsp.readFile(physicalPath, "utf8"));
    expect((await fsp.readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("stream creates use the same exclusive publication", async () => {
    async function* chunks(value: string): AsyncGenerator<Uint8Array> {
      yield Buffer.from(value);
    }
    const results = await Promise.all([
      createWorkspaceBinaryArtifactFromStream({
        envelope,
        actor: { kind: "agent", agentId: "agent-1" },
        logicalPath: "deck.pptx",
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        chunks: chunks("stream first"),
      }),
      createWorkspaceBinaryArtifactFromStream({
        envelope,
        actor: { kind: "agent", agentId: "agent-1" },
        logicalPath: "deck.pptx",
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        chunks: chunks("stream second"),
      }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const failure = results.find((result) => !result.ok);
    expect(failure).toMatchObject({ ok: false, code: "EXISTS" });
    expect(["stream first", "stream second"]).toContain(
      await fsp.readFile(physicalPath, "utf8"),
    );
    expect((await fsp.readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
