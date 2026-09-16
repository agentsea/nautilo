import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Sandbox } from "@nautilo/sandbox";
import { createGuardedNodeAdapter } from "../../electron/local-file-history/file-adapter";
import { resolvePathArg } from "../../electron/local-file-dispatch/commands";
import { executeLocalSearchOperation } from "../../electron/local-file-dispatch/search";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("D446 Desktop native-search adapter", () => {
  test("reuses zone resolution and maps native paths back to current-zone identities", async () => {
    root = await mkdtemp(join(tmpdir(), "d446-local-search-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "index.ts"), "export const value = 1;\n");
    const adapter = createGuardedNodeAdapter({ allowedRoots: [root] });
    const sandbox = await Sandbox.create({
      config: { mode: "disabled", writablePaths: [], projectPaths: [], passthroughEnv: [] },
      workspace: root,
      dataDir: root,
      toolsBin: root,
      detectBackendOverride: () => Promise.resolve({ kind: "none" }),
    });
    try {
      const result = await executeLocalSearchOperation(
        {
          kind: "search",
          command: "glob",
          zone: "current",
          args: {
            path: ".",
            pattern: "**/*.ts",
            limit: 1000,
            includeIgnored: false,
            hidden: "include",
          },
          routing: {},
        },
        {
          adapter,
          allowedRoots: [root],
          routing: {
            ownerId: "owner",
            agentId: "agent",
            currentFolder: root,
            workspaceRoot: "/unused",
          },
          sandbox,
          binaryPath: "/managed/rg",
          engineVersion: "15.1.0",
          execute: async (input) => {
            input.onStdoutChunk(Buffer.from("src/index.ts\0"));
            return {
              exitCode: 0,
              stderr: "",
              timedOut: false,
              aborted: false,
              stoppedEarly: false,
            };
          },
        },
      );
      expect(result).toMatchObject({
        ok: true,
        command: "glob",
        entries: [{ relativePath: "src/index.ts", path: "src/index.ts" }],
      });
      if (!result.ok || result.command !== "glob") throw new Error("expected successful glob");
      const reusablePath = result.entries[0]?.path;
      expect(reusablePath).toBe("src/index.ts");
      const resolved = await resolvePathArg("current", { path: reusablePath }, {
        adapter,
        allowedRoots: [root],
        routing: { ownerId: "owner", agentId: "agent", currentFolder: root, workspaceRoot: "/unused" },
      });
      expect(resolved).toMatchObject({ ok: true });
      if (!resolved.ok) throw new Error("expected reusable guarded path");
      expect(Buffer.from(await adapter.readFile(resolved.canonical)).toString("utf8")).toContain("value = 1");
    } finally {
      await sandbox.close();
    }
  });

  test("searches an exact Current Folder file without widening to its directory", async () => {
    root = await mkdtemp(join(tmpdir(), "d446-local-search-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "job.ts"), "hasDocumentAccess(userId, documentId);\n");
    const adapter = createGuardedNodeAdapter({ allowedRoots: [root] });
    const sandbox = await Sandbox.create({
      config: { mode: "disabled", writablePaths: [], projectPaths: [], passthroughEnv: [] },
      workspace: root,
      dataDir: root,
      toolsBin: root,
      detectBackendOverride: () => Promise.resolve({ kind: "none" }),
    });
    let observedCwd = "";
    let observedTarget = "";
    try {
      const result = await executeLocalSearchOperation(
        {
          kind: "search",
          command: "grep",
          zone: "current",
          args: {
            path: "src/job.ts",
            query: "hasDocumentAccess",
            limit: 200,
            includeIgnored: false,
            hidden: "include",
            caseMode: "smart",
          },
          routing: {},
        },
        {
          adapter,
          allowedRoots: [root],
          routing: {
            ownerId: "owner",
            agentId: "agent",
            currentFolder: root,
            workspaceRoot: "/unused",
          },
          sandbox,
          binaryPath: "/managed/rg",
          engineVersion: "15.1.0",
          execute: async (input) => {
            observedCwd = input.cwd;
            observedTarget = input.argv.at(-1) ?? "";
            input.onStdoutChunk(Buffer.from(`${JSON.stringify({
              type: "match",
              data: {
                path: { text: "job.ts" },
                lines: { text: "hasDocumentAccess(userId, documentId);\n" },
                line_number: 1,
                submatches: [{ match: { text: "hasDocumentAccess" }, start: 0, end: 17 }],
              },
            })}\n`));
            return { exitCode: 0, stderr: "", timedOut: false, aborted: false, stoppedEarly: false };
          },
        },
      );
      expect(observedCwd).toBe(await realpath(join(root, "src")));
      expect(observedTarget).toBe("job.ts");
      expect(result).toMatchObject({
        ok: true,
        command: "grep",
        matches: [{ relativePath: "src/job.ts", path: "src/job.ts", line: 1 }],
      });
    } finally {
      await sandbox.close();
    }
  });
});
