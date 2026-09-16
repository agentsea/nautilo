import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createWorkspaceGuard,
  LOCAL_FILE_EXECUTION_UNSUPPORTED,
  type RelayDispatchRequest,
} from "@nautilo/relay";
import { canonicalize } from "@nautilo/sandbox";

import { makeDispatchHandler } from "../../src/index";

function mkTmp(prefix: string): string {
  return canonicalize(mkdtempSync(join(tmpdir(), prefix)));
}

function mkLocalFileRequest(overrides: Partial<RelayDispatchRequest> = {}): RelayDispatchRequest {
  return {
    correlationId: "relay-local-file-test",
    toolName: "local-file",
    args: {
      operation: {
        kind: "file",
        command: "read",
        zone: "current",
        args: { path: "notes.md" },
      },
      allowedRoots: ["/tmp/current"],
    },
    impact: "read-only",
    approvalObtained: false,
    allowedRoots: ["/tmp/current"],
    executionClass: "local-file",
    ...overrides,
  };
}

describe("headless relay local-file rejection (M206 Slice A)", () => {
  test("rejects executionClass local-file with LOCAL_FILE_EXECUTION_UNSUPPORTED", async () => {
    const workspace = mkTmp("relay-bin-local-file-");
    const guard = createWorkspaceGuard({ workspaceRoot: workspace });
    const handler = makeDispatchHandler(guard, { isProduction: false });

    const result = await handler(mkLocalFileRequest());

    expect(result.status).toBe("error");
    expect(result.errorCode).toBe(LOCAL_FILE_EXECUTION_UNSUPPORTED);
    expect(result.error).toContain("desktop app");
  });

  test("rejects any desktopFilesystemGrantRequest with DESKTOP_LOCAL_GRANT_REQUIRED (fs)", async () => {
    const workspace = mkTmp("relay-bin-d418-fs-");
    const guard = createWorkspaceGuard({ workspaceRoot: workspace });
    const handler = makeDispatchHandler(guard, { isProduction: false });

    const result = await handler({
      correlationId: "relay-d418-fs",
      toolName: "fs",
      executionClass: "fs",
      impact: "read-only",
      approvalObtained: true,
      allowedRoots: [workspace],
      desktopFilesystemGrantRequest: {
        version: 1,
        grantIds: ["g1"],
        requestedRoot: workspace,
        operation: "read",
        subject: { userId: "u", instanceId: "i", relayId: "r", agentScope: "a" },
        policy: { policyVersion: 1, lifetime: "durable" },
      },
      args: { op: "readFile", path: `${workspace}/x.txt`, allowedRoots: [workspace] },
    });

    expect(result.status).toBe("error");
    expect(result.errorCode).toBe("DESKTOP_LOCAL_GRANT_REQUIRED");
    expect(result.error).toContain("desktop app");
  });

  test("rejects a desktopFilesystemGrantRequest before local-file handling", async () => {
    const workspace = mkTmp("relay-bin-d418-lf-");
    const guard = createWorkspaceGuard({ workspaceRoot: workspace });
    const handler = makeDispatchHandler(guard, { isProduction: false });

    const result = await handler(
      mkLocalFileRequest({
        desktopFilesystemGrantRequest: {
          version: 1,
          grantIds: ["g1"],
          requestedRoot: "/tmp/current",
          operation: "read",
          subject: { userId: "u", instanceId: "i", relayId: "r", agentScope: "a" },
          policy: { policyVersion: 1, lifetime: "durable" },
        },
      }),
    );

    expect(result.status).toBe("error");
    expect(result.errorCode).toBe("DESKTOP_LOCAL_GRANT_REQUIRED");
  });

  test("rejects the D417 fixed media operation with desktop guidance", async () => {
    const workspace = mkTmp("relay-bin-media-extract-");
    const guard = createWorkspaceGuard({ workspaceRoot: workspace });
    const handler = makeDispatchHandler(guard, { isProduction: false });

    const result = await handler({
      correlationId: "relay-media-extract-test",
      toolName: "extract_audio_from_video",
      args: { sourceBase64: "AAAA", outputFormat: "m4a" },
      impact: "high",
      approvalObtained: true,
    });

    expect(result.status).toBe("error");
    expect(result.errorCode).toBe(LOCAL_FILE_EXECUTION_UNSUPPORTED);
    expect(result.error).toContain("not supported by the headless relay");
    expect(result.error).toContain("desktop app");
  });

  test("rejects every D417 chunk transport operation with desktop guidance", async () => {
    const workspace = mkTmp("relay-bin-media-chunks-");
    const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: workspace }), { isProduction: false });
    for (const toolName of [
      "media_extract_start",
      "media_extract_chunk",
      "media_extract_finish",
      "media_extract_output_chunk",
    ]) {
      const result = await handler({
        correlationId: `relay-${toolName}`,
        toolName,
        args: { sessionId: "00000000-0000-4000-8000-000000000001" },
        impact: "high",
        approvalObtained: true,
      });
      expect(result.status).toBe("error");
      expect(result.errorCode).toBe(LOCAL_FILE_EXECUTION_UNSUPPORTED);
      expect(result.error).toContain("not supported by the headless relay");
      expect(result.error).toContain("desktop app");
    }
  });
});
