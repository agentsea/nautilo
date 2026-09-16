import { expect, mock, test } from "bun:test";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceGuard, type RelayDispatchRequest } from "@nautilo/relay";
import { Sandbox } from "@nautilo/sandbox";
import { executeLocalFileCommand } from "../../../../packages/agent/src/tools/file/local-file-dispatch";
import { setRelayRegistry } from "../../../../packages/agent/src/nodes/tools";
import { InMemoryRelayRegistry } from "../../../../packages/runtime/src/relay-registry";

mock.module("electron", () => ({ app: { getPath: () => tmpdir(), isPackaged: true } }));
const { makeDispatchHandler } = await import("../../electron/relay");

test("native file search crosses Agent, registry and release Desktop with a policy envelope", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "release-search-")));
  const registry = new InMemoryRelayRegistry();
  try {
    // A deterministic native-runtime fixture exercises actual process/output
    // plumbing without depending on a separately installed ripgrep binary.
    const runtime = join(root, "search-fixture");
    const match = JSON.stringify({ type: "match", data: {
      path: { text: "sample.ts" }, lines: { text: "const needle = true;\n" },
      line_number: 1, submatches: [{ match: { text: "needle" }, start: 6, end: 12 }],
    } });
    await writeFile(runtime, `#!/bin/sh\nprintf '%s\\n' '${match}'\n`, { mode: 0o700 });
    await writeFile(join(root, "sample.ts"), "const needle = true;\n");
    let sandboxCalls = 0;
    const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: root }), {
      isProduction: true, relayId: "release-relay",
      createSandbox: async (envelope) => {
        sandboxCalls += 1;
        expect(envelope.workspace).toBe(root);
        expect(envelope.dataDir).toBe(join(root, "data"));
        expect(envelope.toolsBin).toBe(root);
        // Test backend only; production continues using its enforced backend.
        return new Sandbox({ config: { mode: "disabled", writablePaths: [], projectPaths: [], passthroughEnv: [] },
          workspace: root, dataDir: join(root, "data"), toolsBin: root, backend: { kind: "none" } });
      },
      probeRipgrep: async () => ({ ok: true, binaryPath: runtime, version: "fixture" }),
    });
    const dispatches: RelayDispatchRequest[] = [];
    await registry.register("release-relay", "user-1", {
      profile: "desktop-agent", localFileExecution: true, canReadWorkspace: true,
      allowedRoots: [root], workspaceRoot: root, currentFolderRoot: root,
      dataDir: join(root, "data"), toolsBin: root, userHome: root,
    }, (message) => {
      if (message.type !== "relay:dispatch") return;
      dispatches.push(message);
      void handler(message).then((result) => registry.resolveDispatch(message.correlationId, result));
    }, 9);
    setRelayRegistry(registry);
    const result = await executeLocalFileCommand({ command: "grep", zone: "current", path: ".", query: "needle" }, {
      ownerId: "user-1", agentId: "agent-1", approvalObtained: false,
      zoneCtx: { currentFolder: root, workspaceRoot: "/server/workspace" },
    });
    if (typeof result !== "string") throw new Error("expected successful search text");
    expect(result).toContain("sample.ts");
    expect(result).toContain("needle");
    expect(result).not.toContain("Tool error");
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.sandboxProfile).toBeDefined();
    expect(sandboxCalls).toBe(1);
    // Removing the envelope recreates the release-only failure, without running
    // the native search. The guard remains enabled by this fix.
    const refused = await handler({ ...dispatches[0]!, sandboxProfile: undefined });
    expect(refused.status).toBe("error");
    expect(sandboxCalls).toBe(1);
  } finally {
    setRelayRegistry(null);
    await rm(root, { recursive: true, force: true });
  }
});
