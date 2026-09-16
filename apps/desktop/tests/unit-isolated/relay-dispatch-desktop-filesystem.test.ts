import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceGuard, type RelayDispatchRequest } from "@nautilo/relay";

import {
  deriveDesktopFilesystemAccessOperation,
  deriveDesktopFilesystemAccessOperations,
  dispatchFilesystem,
  fsChangeFromDispatch,
  preflightApplyPatch,
  prepareDesktopFilesystemAuthority,
} from "../../electron/relay-dispatch/desktop-filesystem.ts";
import { FIXED_DESKTOP_DISPATCH_NOT_HANDLED } from "../../electron/relay-dispatch/router.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nautilo-d565-desktop-filesystem-"));
  temporaryRoots.push(root);
  return root;
}

function request(
  overrides: Partial<RelayDispatchRequest> = {},
): RelayDispatchRequest {
  return {
    correlationId: "d565-desktop-filesystem",
    toolName: "other",
    args: {},
    impact: "read-only",
    approvalObtained: true,
    ...overrides,
  };
}

function applyPatchRequest(overrides: Partial<RelayDispatchRequest> = {}): RelayDispatchRequest {
  return request({
    toolName: "local-file",
    executionClass: "local-file",
    impact: "destructive",
    args: {
      operation: {
        kind: "apply_patch",
        version: 1,
        patch: "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch",
        routing: { zone: "current", turnId: "turn-1", agentId: "agent-1" },
      },
      expectedCurrentFolder: "/tmp/current",
    },
    ...overrides,
  });
}

describe("relay desktop filesystem dispatch", () => {
  test("derives scalar and complete structural access operations", () => {
    expect(deriveDesktopFilesystemAccessOperation(request({
      toolName: "fs",
      executionClass: "fs",
      args: { op: "writeFileAtomic", path: "/tmp/a" },
    }))).toBe("create_modify");
    expect(deriveDesktopFilesystemAccessOperation(request({
      toolName: "local-file",
      executionClass: "local-file",
      args: { operation: { kind: "office", operation: { subkind: "officecli", command: "view" } } },
    }))).toBe("read");
    expect(deriveDesktopFilesystemAccessOperations(request({
      toolName: "local-file",
      executionClass: "local-file",
      args: { operation: { kind: "file", command: "move" } },
    }))).toEqual(["read", "create_modify", "delete"]);
    expect(deriveDesktopFilesystemAccessOperation(request({
      toolName: "fs",
      executionClass: "fs",
      args: { op: "unknown", path: "/tmp/a" },
    }))).toBeNull();
  });

  test("preflights apply_patch with historic approval, grant, then parser refusal precedence", () => {
    const malformed = applyPatchRequest({
      approvalObtained: false,
      args: {
        operation: {
          kind: "apply_patch",
          version: 1,
          patch: "not a patch",
          routing: { zone: "current", turnId: "turn-1", agentId: "agent-1" },
        },
        expectedCurrentFolder: "/tmp/current",
      },
    });
    expect(preflightApplyPatch(malformed)).toEqual({
      ok: false,
      result: {
        status: "error",
        errorCode: "APPLY_PATCH_APPROVAL_REQUIRED",
        error: "apply_patch requires approvalObtained=true from server",
      },
    });

    const grantBearing = {
      ...malformed,
      approvalObtained: true,
      desktopFilesystemGrantRequest: {
        version: 1 as const,
        grantIds: ["grant-1"],
        requestedRoot: "/tmp/current",
        operation: "create_modify" as const,
        subject: { userId: "user", instanceId: "instance", relayId: "relay", agentScope: "scope" },
        policy: { policyVersion: 1, lifetime: "session" as const },
      },
    };
    expect(preflightApplyPatch(grantBearing)).toEqual({
      ok: false,
      result: {
        status: "error",
        errorCode: "invalid_request",
        error: "Current Folder apply_patch does not accept a Desktop Filesystem Grant",
      },
    });

    const parserFailure = preflightApplyPatch({
      ...malformed,
      approvalObtained: true,
    });
    expect(parserFailure).toMatchObject({
      ok: false,
      result: { status: "error", errorCode: "parse_error" },
    });
  });

  test("does not invoke a grant resolver for no-envelope or Current Folder apply_patch requests", async () => {
    let resolverCalls = 0;
    const resolver = async () => {
      resolverCalls += 1;
      return { ok: false as const, code: "REVOKED" as const };
    };
    expect(await prepareDesktopFilesystemAuthority({
      request: request(),
      baseRoots: ["/tmp/base"],
      resolver,
    })).toEqual({ ok: true, authority: undefined });

    const preflight = preflightApplyPatch(applyPatchRequest());
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;
    expect(await prepareDesktopFilesystemAuthority({
      request: applyPatchRequest(),
      baseRoots: ["/tmp/base"],
      resolver,
      applyPatchPreparation: preflight.preparation,
    })).toEqual({ ok: true, authority: undefined });
    expect(resolverCalls).toBe(0);
  });

  test("passes only derived operations and baseline metadata to the live resolver", async () => {
    const root = "/tmp/validated-root";
    const grantRequest = request({
      toolName: "local-file",
      executionClass: "local-file",
      args: { operation: { kind: "file", command: "move" } },
      desktopFilesystemGrantRequest: {
        version: 1,
        grantIds: ["grant-1"],
        requestedRoot: root,
        operation: "create_modify",
        requiredOperations: ["read", "create_modify", "delete"],
        subject: { userId: "user", instanceId: "instance", relayId: "relay", agentScope: "scope" },
        policy: { policyVersion: 1, lifetime: "session" },
      },
    });
    const inputs: unknown[] = [];
    expect(await prepareDesktopFilesystemAuthority({
      request: grantRequest,
      baseRoots: ["/tmp/base-a", "/tmp/base-b"],
      resolver: async (input) => {
        inputs.push(input);
        return {
          ok: true,
          hasAuthority: true,
          roots: [root],
          operation: "create_modify",
          grantIds: ["grant-1"],
        };
      },
    })).toEqual({ ok: true, authority: { roots: [root] } });
    expect(inputs).toEqual([expect.objectContaining({
      concreteOperation: "create_modify",
      concreteOperations: ["read", "create_modify", "delete"],
      baselineAuthorities: [
        { id: "baseline:/tmp/base-a", root: "/tmp/base-a", access: ["read", "create_modify", "delete"] },
        { id: "baseline:/tmp/base-b", root: "/tmp/base-b", access: ["read", "create_modify", "delete"] },
      ],
    })]);
  });

  test("declines non-fs requests and emits a receipt only after a successful mutation", async () => {
    const root = temporaryRoot();
    const target = join(root, "created.txt");
    const guard = createWorkspaceGuard({ workspaceRoot: root });
    const events: unknown[] = [];
    expect(await dispatchFilesystem({
      request: request({ toolName: "fs", args: { op: "stat", path: root } }),
      guard,
      authority: undefined,
      onFsChange: (event) => events.push(event),
    })).toBe(FIXED_DESKTOP_DISPATCH_NOT_HANDLED);

    const write = request({
      toolName: "fs",
      executionClass: "fs",
      impact: "destructive",
      args: {
        op: "writeFileAtomic",
        path: target,
        dataBase64: Buffer.from("created").toString("base64"),
        allowedRoots: [root],
      },
    });
    expect(await dispatchFilesystem({
      request: write,
      guard,
      authority: undefined,
      onFsChange: (event) => events.push(event),
    })).toMatchObject({ handled: true, result: { status: "ok", result: { ok: true } } });
    expect(events).toEqual([{
      rootPath: root,
      path: root,
      changedPath: target,
      source: "relay",
      op: "writeFileAtomic",
      reloadRequired: true,
    }]);

    writeFileSync(target, "created");
    const read = await dispatchFilesystem({
      request: request({
        toolName: "fs",
        executionClass: "fs",
        args: { op: "readFile", path: target, allowedRoots: [root] },
      }),
      guard,
      authority: undefined,
      onFsChange: (event) => events.push(event),
    });
    expect(read).toMatchObject({ handled: true, result: { status: "ok", result: { ok: true } } });
    expect(events).toHaveLength(1);
    expect(fsChangeFromDispatch(write)).toMatchObject({ changedPath: target });
  });
});
