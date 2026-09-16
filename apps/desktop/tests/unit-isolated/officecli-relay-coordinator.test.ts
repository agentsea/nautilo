import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { OfficeCliRunResult } from "@nautilo/config/officecli";
import { createWorkspaceGuard, type RelayDispatchRequest } from "@nautilo/relay";
import {
  deriveDesktopFilesystemAccessOperation,
  type DesktopFilesystemGrantAuthorityResolveInput,
} from "../../electron/relay-dispatch/desktop-filesystem.ts";
import type { DesktopOfficeCliCoordinatorCommitInput } from "../../electron/relay-dispatch/local-file.ts";

const historyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "officecli-relay-history-"));

mock.module("electron", () => ({
  app: {
    getPath: () => historyRoot,
    isPackaged: false,
  },
}));

let makeDispatchHandler: typeof import("../../electron/relay.ts").makeDispatchHandler;

beforeAll(async () => {
  ({
    makeDispatchHandler,
  } = await import("../../electron/relay.ts"));
});

afterAll(async () => {
  await fs.rm(historyRoot, { recursive: true, force: true });
});

const RELAY_ID = "relay-officecli-d418";
const OWNER_ID = "00000000-0000-4000-8000-000000000711";
const AGENT_ID = "00000000-0000-4000-8000-000000000712";
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function request(root: string): RelayDispatchRequest {
  return {
    correlationId: "officecli-relay-coordinator",
    toolName: "local-file",
    executionClass: "local-file",
    impact: "destructive",
    approvalObtained: true,
    allowedRoots: [root],
    desktopFilesystemGrantRequest: {
      version: 1,
      grantIds: ["grant-officecli"],
      requestedRoot: root,
      operation: "create_modify",
      subject: {
        userId: OWNER_ID,
        instanceId: "nautilo-dev",
        relayId: RELAY_ID,
        agentScope: "desktop-agent",
      },
      policy: { policyVersion: 1, lifetime: "session" },
    },
    args: {
      operation: {
        kind: "office",
        operation: {
          subkind: "officecli",
          zone: "current",
          command: "create",
          payload: {
            out: "generated.docx",
            commands: [],
          },
          _routing: {
            ownerId: OWNER_ID,
            agentId: AGENT_ID,
            turnId: "turn-officecli-relay",
            currentFolder: root,
            workspaceRoot: "",
          },
        },
      },
      allowedRoots: [root],
    },
  };
}

function stagedOfficeRunner(
  generated: Uint8Array,
  stagedPaths: string[],
): (argv: readonly string[]) => Promise<OfficeCliRunResult> {
  return async (argv) => {
    const stagedPath = argv[1];
    if (typeof stagedPath === "string") {
      stagedPaths.push(stagedPath);
      await fs.writeFile(stagedPath, generated);
    }
    return { stdout: JSON.stringify({ ok: true }), stderr: "", exitCode: 0 };
  };
}

function admitted(root: string) {
  return {
    ok: true as const,
    hasAuthority: true as const,
    roots: [root],
    operation: "create_modify" as const,
    grantIds: ["grant-officecli"],
  };
}

describe("OfficeCLI relay coordinator reauthorization", () => {
  test("revocation after staging denies the coordinator callback with zero target writes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "officecli-relay-denied-"));
    const target = path.join(root, "generated.docx");
    const generated = Buffer.concat([ZIP_MAGIC, Buffer.from("generated-after-initial-admission")]);
    const authorityInputs: DesktopFilesystemGrantAuthorityResolveInput[] = [];
    const stagedPaths: string[] = [];
    let commitCalls = 0;
    try {
      const relayRequest = request(root);
      expect(deriveDesktopFilesystemAccessOperation(relayRequest)).toBe("create_modify");
      const handler = makeDispatchHandler(
        createWorkspaceGuard({ allowedRoots: [root] }),
        {
          relayId: RELAY_ID,
          officeRun: stagedOfficeRunner(generated, stagedPaths),
          desktopFilesystemGrantAuthority: async (input) => {
            authorityInputs.push(input);
            return authorityInputs.length === 1
              ? admitted(root)
              : { ok: false as const, code: "REVOKED" as const };
          },
          commitDesktopOfficeCli: async (input) => {
            commitCalls += 1;
            await input.reauthorize();
            throw new Error("revoked authority must stop before commit");
          },
        },
      );

      const result = await handler(relayRequest);
      expect(result.status).toBe("ok");
      expect(result.result).toMatchObject({ ok: false });
      const failure = result.result as { readonly message?: unknown };
      expect(failure.message).toContain("REVOKED");
      expect(commitCalls).toBe(1);
      expect(authorityInputs).toHaveLength(2);
      expect(authorityInputs.map((input) => input.concreteOperation))
        .toEqual(["create_modify", "create_modify"]);
      expect(stagedPaths.length).toBeGreaterThan(0);
      expect(stagedPaths.every((stagedPath) => stagedPath !== target)).toBe(true);
      let targetExists = true;
      try {
        await fs.access(target);
      } catch {
        targetExists = false;
      }
      expect(targetExists).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("successful second reauthorization reaches the coordinator result without desktop filesystem authority", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "officecli-relay-success-"));
    const target = path.join(root, "generated.docx");
    const generated = Buffer.concat([ZIP_MAGIC, Buffer.from("generated-after-reauthorization")]);
    const authorityInputs: DesktopFilesystemGrantAuthorityResolveInput[] = [];
    const stagedPaths: string[] = [];
    let committed: DesktopOfficeCliCoordinatorCommitInput | undefined;
    try {
      const relayRequest = request(root);
      expect(relayRequest.workstationShellBinding).toBeUndefined();
      const handler = makeDispatchHandler(
        createWorkspaceGuard({ allowedRoots: [root] }),
        {
          relayId: RELAY_ID,
          officeRun: stagedOfficeRunner(generated, stagedPaths),
          desktopFilesystemGrantAuthority: async (input) => {
            authorityInputs.push(input);
            return admitted(root);
          },
          commitDesktopOfficeCli: async (input) => {
            committed = input;
            await input.reauthorize();
            await fs.writeFile(input.targetPath, input.after);
            return {
              ok: true,
              operationId: "officecli-relay-operation",
              revisionGroupId: "officecli-relay-group",
              revisionId: "officecli-relay-revision",
              sha256: "a".repeat(64),
              byteLength: input.after.byteLength,
            };
          },
        },
      );

      const result = await handler(relayRequest);
      expect(result.status).toBe("ok");
      expect(result.result).toMatchObject({
        ok: true,
        result: {
          applied: true,
          operationId: "officecli-relay-operation",
          revisionGroupId: "officecli-relay-group",
          revisionId: "officecli-relay-revision",
        },
      });
      expect(authorityInputs).toHaveLength(2);
      expect(authorityInputs.map((input) => input.concreteOperation))
        .toEqual(["create_modify", "create_modify"]);
      expect(committed).toBeDefined();
      expect(committed?.agentId).toBe(AGENT_ID);
      expect(committed?.turnId).toBe("turn-officecli-relay");
      expect(Buffer.from(await fs.readFile(target))).toEqual(generated);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
