import { describe, expect, test } from "bun:test";
import {
  createWorkspaceApplyPatchPrivateTreePort,
  createWorkspaceApplyPatchProductionAdapter,
} from "../../src/tools/apply-patch/workspace-production-adapter";

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);

describe("D448 Workspace production adapter", () => {
  test("private materialization roots are temporary and cleanup removes them", async () => {
    const tree = createWorkspaceApplyPatchPrivateTreePort();
    const handle = await tree.create();
    await tree.writeFile(handle, "src/example.ts", encode("export {};\n"));
    expect(handle.root).not.toContain("/artifact-store/");
    const written = await tree.readFile(handle, "src/example.ts");
    expect(written).not.toBeNull();
    expect(decode(written ?? new Uint8Array())).toBe("export {};\n");
    await tree.cleanup(handle);
    expect(await tree.readFile(handle, "src/example.ts")).toBeNull();
  });

  test("rejects logical paths that could escape the invocation-private root", async () => {
    const tree = createWorkspaceApplyPatchPrivateTreePort();
    const handle = await tree.create();
    try {
      let message = "";
      try {
        await tree.writeFile(handle, "../outside.txt", encode("no"));
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("invalid logical path");
    } finally {
      await tree.cleanup(handle);
    }
  });

  test("retains server-owned read and commit ports without creating a writer", () => {
    const artifacts = { readAuthorized: async () => null };
    const commit = {
      reconcileApplied: async () => ({ operations: [] }),
    };
    const adapter = createWorkspaceApplyPatchProductionAdapter({
      ports: { artifacts, commit },
      binaryPath: "/verified/apply-patch",
      runtime: {
        protocol: "1",
        runtimeVersion: "1",
        upstreamRevision: "upstream",
        nautiloExtractionRevision: "extraction",
      },
      sandbox: {} as never,
    });
    expect(adapter.artifacts).toBe(artifacts);
    expect(adapter.commit).toBe(commit);
  });
});
