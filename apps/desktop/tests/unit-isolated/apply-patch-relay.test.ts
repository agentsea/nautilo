// Isolated because Bun's process-global Electron module mock is sticky.
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createWorkspaceGuard, type RelayDispatchRequest, type RelaySandboxProfile } from "@nautilo/relay";
import { buildProtectedPathPolicy, type ProtectedPathPolicy } from "@nautilo/security";

mock.module("electron", () => ({ app: { getPath: () => tmpdir() } }));

let makeDispatchHandler: typeof import("../../electron/relay.ts").makeDispatchHandler;
let buildShellBindingSandboxEnvelope: typeof import("../../electron/relay.ts").buildShellBindingSandboxEnvelope;

beforeAll(async () => {
  ({
    makeDispatchHandler,
    buildShellBindingSandboxEnvelope,
  } = await import("../../electron/relay.ts"));
});

const root = mkdtempSync(join(tmpdir(), "d448-relay-root-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const sandboxProfile: RelaySandboxProfile = {
  workspace: root,
  dataDir: root,
  toolsBin: "/owned/tools",
  mode: "desktop-locked",
  securityLevel: "standard",
  failIfNoBackend: true,
  config: { mode: "enabled", writablePaths: [], projectPaths: [], passthroughEnv: [] },
};

test("canonical sandbox envelope exposes both locally resolved apply-patch binary origins", () => {
  const binaries = [
    "/owned/apps/desktop/vendor/apply-patch/darwin-arm64/nautilo-apply-patch",
    "/owned/Nautilo.app/Contents/Resources/tools-apply-patch/darwin-x64/nautilo-apply-patch",
  ];
  for (const binaryPath of binaries) {
    const envelope = buildShellBindingSandboxEnvelope(
      sandboxProfile,
      { readOnlyRoots: [], writableRoots: [root] },
      undefined,
      dirname(binaryPath),
      { workspace: root, protectedFileMaskPath: join(root, ".mask") },
      undefined,
      root,
    );
    // Sandbox toolsBin is ro-bound by bubblewrap and granted file-read by
    // Seatbelt. Both resolver origins therefore expose the fixed binary.
    expect(envelope.toolsBin).toBe(dirname(binaryPath));
  }
});

test("relay uses locally selected Current Folder without consulting filesystem grants", async () => {
  await fs.writeFile(join(root, "old.txt"), "old\n", "utf8");
  let grantResolverCalled = false;
  const handler = makeDispatchHandler(createWorkspaceGuard({ allowedRoots: [root] }), {
    relayId: "relay-1",
    protectedPathPolicy: { descriptors: [], check: () => ({ allowed: true }) } as unknown as ProtectedPathPolicy,
    getLocalWorkspacePath: () => root,
    desktopFilesystemGrantAuthority: async () => {
      grantResolverCalled = true;
      return { ok: true, hasAuthority: true, roots: [root], operation: "create_modify", grantIds: ["grant-1"] };
    },
  });
  const request: RelayDispatchRequest = {
    correlationId: "d448-test",
    toolName: "local-file",
    executionClass: "local-file",
    impact: "destructive",
    approvalObtained: true,
    args: {
      operation: {
        kind: "apply_patch",
        version: 1,
        patch: "*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n@@\n-old\n+new\n*** End Patch",
        routing: { zone: "current", turnId: "turn-1", agentId: "agent-1" },
      },
      expectedCurrentFolder: root,
    },
    sandboxProfile,
  };
  const result = await handler(request);
  expect(grantResolverCalled).toBe(false);
  expect(result).toMatchObject({ status: "error", errorCode: "runtime_unavailable" });
});

test("apply_patch accepts only the live Current Folder and rejects stale or protected roots", async () => {
  const parent = mkdtempSync(join(tmpdir(), "d448-apply-patch-authority-"));
  const safeTarget = join(parent, "safe-target");
  const safeAlias = join(parent, "safe-alias");
  const protectedTarget = join(parent, "protected-target");
  const protectedAlias = join(parent, "protected-alias");
  try {
    await fs.mkdir(safeTarget);
    await fs.mkdir(protectedTarget);
    symlinkSync(safeTarget, safeAlias, "dir");
    symlinkSync(protectedTarget, protectedAlias, "dir");
    const canonicalProtectedTarget = await fs.realpath(protectedTarget);

    const protectedPathPolicy = buildProtectedPathPolicy({
      homeDir: homedir(),
      platform: process.platform,
      extraRoots: [{
        canonicalPath: canonicalProtectedTarget,
        category: "system_auth",
        label: "D448 protected authority fixture",
      }],
    });
    const requestFor = (requestedRoot: string): RelayDispatchRequest => ({
      correlationId: "d448-apply-patch-authority",
      toolName: "local-file",
      executionClass: "local-file",
      impact: "destructive",
      approvalObtained: true,
      args: {
        operation: {
          kind: "apply_patch",
          version: 1,
          patch: "*** Begin Patch\n*** Add File: granted.txt\n+granted\n*** End Patch",
          routing: { zone: "current", turnId: "turn-d448-authority", agentId: "agent-d448-authority" },
        },
        expectedCurrentFolder: requestedRoot,
      },
      sandboxProfile,
    });
    const handlerFor = (selectedRoot: string) => makeDispatchHandler(
      createWorkspaceGuard({ allowedRoots: [safeTarget] }),
      {
        relayId: "relay-d448-authority",
        protectedPathPolicy,
        getLocalWorkspacePath: () => selectedRoot,
      },
    );

    const safe = await handlerFor(safeAlias)(requestFor(safeAlias));
    // Electron is mocked without a packaging signal, so this is the first
    // expected post-authority boundary. No runtime can spawn in this test.
    expect(safe).toMatchObject({ status: "error", errorCode: "runtime_unavailable" });

    const stale = await handlerFor(safeAlias)(requestFor(protectedAlias));
    expect(stale).toMatchObject({ status: "error", errorCode: "stale_context" });

    const directProtected = await handlerFor(protectedTarget)(requestFor(protectedTarget));
    expect(directProtected).toMatchObject({ status: "error", errorCode: "denied_path" });

    const aliasProtected = await handlerFor(protectedAlias)(requestFor(protectedAlias));
    expect(aliasProtected).toMatchObject({ status: "error", errorCode: "denied_path" });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
