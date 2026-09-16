import { describe, expect, test } from "bun:test";
import { preflightApplyPatch } from "../../src/tools/apply-patch/preflight";
import { stageWorkspaceApplyPatch, type ApplyPatchWorkspaceTreePort, type WorkspaceArtifactSnapshot } from "../../src/tools/apply-patch/workspace-staging";

type Tree = Map<string, Uint8Array>;
const summary = preflightApplyPatch("*** Begin Patch\n*** Update File: src/a.txt\n@@\n-before\n+after\n*** Add File: docs/new.txt\n+new\n*** End Patch");
if (!summary.ok) throw new Error("fixture must preflight");
const encode = (value: string) => new TextEncoder().encode(value);

describe("D448 workspace staging", () => {
  test("copies only authorized logical text into the private tree", async () => {
    const read: string[] = [];
    const written: string[] = [];
    const tree: ApplyPatchWorkspaceTreePort<Tree> = {
      create: async () => new Map(),
      writeFile: async (target, path, value) => { written.push(path); target.set(path, value); },
      readFile: async (target, path) => target.get(path) ?? null,
      cleanup: async () => {},
    };
    const result = await stageWorkspaceApplyPatch({
      preflight: summary.summary,
      artifacts: { readAuthorized: async (path): Promise<WorkspaceArtifactSnapshot | null> => {
        read.push(path);
        return path === "src/a.txt" ? { logicalPath: path, artifactId: "uuid-a", revision: 2, bytes: encode("before\n") } : null;
      } },
      tree,
    });
    expect(result).toMatchObject({ ok: true });
    expect(read).toEqual(["src/a.txt", "docs/new.txt"]);
    expect(written).toEqual(["src/a.txt"]);
  });

  test("rejects missing and binary sources before private-tree creation", async () => {
    let created = 0;
    const tree: ApplyPatchWorkspaceTreePort<Tree> = {
      create: async () => { created += 1; return new Map(); },
      writeFile: async () => {},
      readFile: async () => null,
      cleanup: async () => {},
    };
    const missing = await stageWorkspaceApplyPatch({ preflight: summary.summary, artifacts: { readAuthorized: async () => null }, tree });
    expect(missing).toMatchObject({ ok: false, error: { code: "stale_context", path: "src/a.txt" } });
    expect(created).toBe(0);
    const binary = await stageWorkspaceApplyPatch({
      preflight: summary.summary,
      artifacts: { readAuthorized: async (path) => path === "src/a.txt" ? { logicalPath: path, artifactId: "x", revision: 1, bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) } : null },
      tree,
    });
    expect(binary).toMatchObject({ ok: false, error: { code: "unsupported_encoding_or_type" } });
    expect(created).toBe(0);
  });

});
