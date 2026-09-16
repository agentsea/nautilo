import { describe, expect, test } from "bun:test";
import {
  APPLY_PATCH_PROTOCOL_VERSION,
  RELAY_LOCAL_APPLY_PATCH_VERSION,
  RELAY_APPLY_PATCH_ERROR_CODES,
  RELAY_PROTOCOL_VERSION,
  canRelayExecuteApplyPatch,
  parseRelayLocalApplyPatchRequest,
  parseRelayLocalApplyPatchResult,
  type RelayLocalApplyPatchOperation,
  type RelayLocalApplyPatchRequest,
  type RelayLocalApplyPatchResult,
  type RelayLocalFileOperation,
} from "../../src/protocol";
import type { RelayCapabilities } from "../../src/types";

type Assert<T extends true> = T;
export type LegacyLocalFileOperationExcludesApplyPatch = Assert<
  "apply_patch" extends RelayLocalFileOperation["kind"] ? false : true
>;

const OPERATION: RelayLocalApplyPatchOperation = {
  kind: "apply_patch",
  version: RELAY_LOCAL_APPLY_PATCH_VERSION,
  patch: "*** Begin Patch\n*** Update File: src/example.ts\n@@\n-old\n+new\n*** End Patch\n",
  routing: { zone: "current", turnId: "turn-1", agentId: "agent-1" },
};

const RESULT: RelayLocalApplyPatchResult = {
  status: "applied",
  partial: false,
  rebased: true,
  operationCounts: { add: 0, update: 1, move: 0, delete: 0 },
  pathResults: [
    {
      operation: "update",
      path: "src/example.ts",
      status: "applied",
      bytesTouched: 8,
      revisionId: "rev-1",
    },
  ],
  changedFiles: [
    {
      operation: "update",
      path: "src/example.ts",
      status: "applied",
      bytesTouched: 8,
      revisionId: "rev-1",
    },
  ],
  revisionIds: ["rev-1"],
  unifiedDiff: "-old\n+new\n",
  runtimeVersion: "nautilo.apply_patch/v1",
  turnId: "turn-1",
};

describe("D448 relay protocol v9 apply-patch operation", () => {
  test("advertises v18 while retaining the v4 local-file execution class", () => {
    expect(RELAY_PROTOCOL_VERSION).toBe(20);
    expect(APPLY_PATCH_PROTOCOL_VERSION).toBe(9);
    expect(RELAY_LOCAL_APPLY_PATCH_VERSION).toBe(1);

    const caps: RelayCapabilities = {
      profile: "desktop-agent",
      localFileExecution: true,
      applyPatchExecution: true,
    };
    expect(caps.applyPatchExecution).toBe(true);
    const localOnly: RelayCapabilities = { profile: "desktop-agent", localFileExecution: true };
    expect(localOnly.applyPatchExecution).toBeUndefined();
    expect(canRelayExecuteApplyPatch(9, caps)).toBe(true);
    expect(canRelayExecuteApplyPatch(8, caps)).toBe(false);
    expect(canRelayExecuteApplyPatch(9, localOnly)).toBe(false);
  });

  test("carries one typed local-file operation with logical routing", () => {
    const request: RelayLocalApplyPatchRequest = {
      operation: OPERATION,
      expectedCurrentFolder: "/repo",
    };
    expect(request.operation.kind).toBe("apply_patch");
    expect(parseRelayLocalApplyPatchRequest(request)).toEqual({ ok: true, request });
    expect(Object.keys(OPERATION).sort()).toEqual(["kind", "patch", "routing", "version"]);
    expect(Object.keys(OPERATION.routing).sort()).toEqual(["agentId", "turnId", "zone"]);
    expect(JSON.stringify(request)).not.toMatch(/argv|shell|environment|allowedRoots|workspacePath/i);
  });

  test("fails closed for untrusted fields, physical routing, and invalid text", () => {
    expect(
      parseRelayLocalApplyPatchRequest({ operation: { ...OPERATION, argv: ["apply_patch"] } }),
    ).toMatchObject({ ok: false });
    expect(
      parseRelayLocalApplyPatchRequest({ operation: OPERATION, allowedRoots: ["/server-provided-root"] }),
    ).toMatchObject({ ok: false });
    expect(
      parseRelayLocalApplyPatchRequest({ operation: OPERATION }),
    ).toMatchObject({ ok: false });
    expect(
      parseRelayLocalApplyPatchRequest({
        operation: { ...OPERATION, routing: { ...OPERATION.routing, root: "/private/server/workspace" } },
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseRelayLocalApplyPatchRequest({ operation: { ...OPERATION, patch: "bad\0patch" } }),
    ).toMatchObject({ ok: false });
    expect(
      parseRelayLocalApplyPatchRequest({ operation: { ...OPERATION, routing: { zone: "current", turnId: "turn-1" } } }),
    ).toMatchObject({ ok: false });
    expect(parseRelayLocalApplyPatchRequest({ operation: { ...OPERATION, unexpected: true } })).toMatchObject({ ok: false });
  });

  test("parses only normalized public result mirrors", () => {
    expect(parseRelayLocalApplyPatchResult(RESULT)).toEqual({ ok: true, result: RESULT });
    expect(
      parseRelayLocalApplyPatchResult({
        ...RESULT,
        operationCounts: { ...RESULT.operationCounts, update: 2 },
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseRelayLocalApplyPatchResult({
        ...RESULT,
        changedFiles: [],
      }),
    ).toMatchObject({ ok: false });
    expect(RELAY_APPLY_PATCH_ERROR_CODES).toContain("human_edit_conflict");
    expect(RELAY_APPLY_PATCH_ERROR_CODES).toContain("reapply_required");
  });
});
