/** D448 OfficeCLI Workspace producer characterization: private engine, exact commit port. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Artifact } from "@nautilo/db";
import type { OfficeCliRunResult } from "@nautilo/config/officecli";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import { createOfficeCliTool, type CreateOfficeCliToolDeps } from "./officecli";
import {
  setWorkspaceOfficeCliCommitExecution,
  type WorkspaceOfficeCliCommitRequest,
} from "./workspace-runtime-adapter";

const OWNER = "00000000-0000-4000-8000-000000000461";
const AGENT = "00000000-0000-4000-8000-000000000462";
const ROOM = "00000000-0000-4000-8000-000000000463";
const NAMESPACE = "00000000-0000-4000-8000-000000000464";
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const ooxml = (label: string) => Buffer.concat([ZIP_MAGIC, Buffer.from(label)]);

function envelope(): MemoryAccessEnvelope {
  return { ownerId: OWNER, actorId: "00000000-0000-4000-8000-000000000465", agentId: AGENT, roomId: ROOM, readableNamespaces: [NAMESPACE], mutableNamespaces: [NAMESPACE], writableNamespaces: [NAMESPACE], toolPolicy: {} };
}

let root = "";
let artifactPath = "";
let artifact: Artifact;

function context(input: { activeMiniApp?: { targetKind: "artifact"; documentPath: string } | null } = {}) {
  return { ownerId: OWNER, agentId: AGENT, roomId: ROOM, turnId: "turn-d448-officecli", workspacePath: root, currentFolder: root, memoryAccessEnvelope: envelope(), ...(input.activeMiniApp === undefined ? {} : { activeMiniApp: input.activeMiniApp }) };
}

function resolver(): NonNullable<CreateOfficeCliToolDeps["resolveWorkspaceArtifact"]> {
  return (async ({ logicalPath }: { logicalPath: string }) => ({ ok: true as const, artifact, physicalPath: artifactPath, artifactId: artifact.artifactId, storageUri: artifact.storageUri, logicalPath })) as NonNullable<CreateOfficeCliToolDeps["resolveWorkspaceArtifact"]>;
}

function tool(run: NonNullable<CreateOfficeCliToolDeps["run"]>, input: Parameters<typeof context>[0] = {}) {
  return createOfficeCliTool(context(input), { run, resolveWorkspaceArtifact: resolver(), tempDirRoot: root, getOfficeSessionManager: () => ({ hasActiveSession: () => false }) as never });
}

async function invoke(subject: ReturnType<typeof createOfficeCliTool>, out?: string): Promise<string> {
  return String(await subject.invoke({ command: "set", zone: "workspace", path: "reports/quarterly.docx", ...(out === undefined ? {} : { out }), target: "/body/p[1]", props: { text: "Agent post-image" } }));
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "d448-officecli-workspace-"));
  artifactPath = path.join(root, "artifact-storage-without-extension");
  await fs.writeFile(artifactPath, ooxml("human-base"));
  artifact = { id: "00000000-0000-4000-8000-000000000466", artifactId: "d448-officecli-artifact", path: "reports/quarterly.docx", storageUri: `file://${artifactPath}`, revision: 7, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: (await fs.stat(artifactPath)).size, createdAt: new Date(), updatedAt: new Date(), deletedAt: null };
});

afterEach(async () => {
  setWorkspaceOfficeCliCommitExecution(undefined);
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe("D448 Workspace OfficeCLI commit seam", () => {
  test("runs on a private extension-bearing copy and delegates one exact in-place binary plan", async () => {
    const before = await fs.readFile(artifactPath);
    const postImage = ooxml("agent-post-image");
    const requests: WorkspaceOfficeCliCommitRequest[] = [];
    setWorkspaceOfficeCliCommitExecution(async (request) => {
      requests.push(request);
      return {
        ok: true,
        revisionId: "revision-1",
        artifactInternalId: artifact.id,
        artifactId: artifact.artifactId,
      };
    });
    const result = await invoke(tool(async (argv): Promise<OfficeCliRunResult> => {
      expect(argv[1]).not.toBe(artifactPath);
      expect(argv[1]).toEndWith("quarterly.docx");
      expect(await fs.readFile(artifactPath)).toEqual(before);
      await fs.writeFile(argv[1]!, postImage);
      return { stdout: "", stderr: "", exitCode: 0 };
    }));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      outputPath: "reports/quarterly.docx",
      source: {
        artifactInternalId: artifact.id,
        artifactId: artifact.artifactId,
        logicalPath: artifact.path,
        revision: 7,
      },
    });
    expect(Buffer.from(requests[0]!.postImage)).toEqual(postImage);
    expect(result).toContain('"applied":true');
    expect(result).toContain('"revisionId":"revision-1"');
    expect(result).toContain(`"artifactInternalId":"${artifact.id}"`);
    expect(result).toContain(`"artifactId":"${artifact.artifactId}"`);
    // The test port is deliberately non-mutating: OfficeCLI cannot touch live storage.
    expect(await fs.readFile(artifactPath)).toEqual(before);
  });

  test("distinct output delegates the source as a read-only snapshot rather than using a generic copy write", async () => {
    const requests: WorkspaceOfficeCliCommitRequest[] = [];
    const createdId = "00000000-0000-4000-8000-000000000477";
    setWorkspaceOfficeCliCommitExecution(async (request) => {
      requests.push(request);
      return {
        ok: true,
        revisionId: "revision-copy",
        artifactInternalId: createdId,
        artifactId: createdId,
      };
    });
    const result = await invoke(tool(async (argv) => { await fs.writeFile(argv[1]!, ooxml("copy")); return { stdout: "", stderr: "", exitCode: 0 }; }), "reports/copy.docx");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      outputPath: "reports/copy.docx",
      source: {
        artifactInternalId: artifact.id,
        artifactId: artifact.artifactId,
        logicalPath: artifact.path,
      },
    });
    expect(result).toContain(`"artifactInternalId":"${createdId}"`);
    expect(result).toContain(`"artifactId":"${createdId}"`);
  });

  test("runtime failure and active Writer lockout call neither commit port nor live storage", async () => {
    let commits = 0;
    let calls = 0;
    setWorkspaceOfficeCliCommitExecution(async () => {
      commits += 1;
      return {
        ok: true,
        revisionId: "never",
        artifactInternalId: artifact.id,
        artifactId: artifact.artifactId,
      };
    });
    const before = await fs.readFile(artifactPath);
    const failed = await invoke(tool(async () => { calls += 1; return { stdout: "", stderr: "boom", exitCode: 1 }; }));
    expect(failed).toContain("failed");
    const locked = await invoke(tool(async () => { calls += 1; return { stdout: "", stderr: "", exitCode: 0 }; }, { activeMiniApp: { targetKind: "artifact", documentPath: artifact.path } }));
    expect(locked).toContain("refused to mutate");
    expect(calls).toBe(1);
    expect(commits).toBe(0);
    expect(await fs.readFile(artifactPath)).toEqual(before);
  });

  test("does not fall back to the legacy generic Workspace committer when the server port is absent", async () => {
    const before = await fs.readFile(artifactPath);
    const result = await invoke(tool(async (argv) => {
      await fs.writeFile(argv[1]!, ooxml("candidate"));
      return { stdout: "", stderr: "", exitCode: 0 };
    }));
    expect(result).toContain("commit runtime is unavailable");
    expect(await fs.readFile(artifactPath)).toEqual(before);
  });
});
