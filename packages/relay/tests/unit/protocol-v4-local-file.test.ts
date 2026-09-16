import { describe, expect, test } from "bun:test";
import {
  RELAY_PROTOCOL_VERSION,
  LOCAL_FILE_PROTOCOL_VERSION,
  MEDIA_EXTRACTION_PROTOCOL_VERSION,
  DESKTOP_FILESYSTEM_GRANT_REQUEST_PROTOCOL_VERSION,
  RELAY_DESKTOP_FILESYSTEM_GRANT_REQUEST_VERSION,
  parseRelayLocalFileSha256,
  type RelayDispatchMessage,
  type RelayLocalFileRequest,
  type RelayLocalFileResult,
  type RelayDesktopFilesystemGrantRequest,
} from "../../src/protocol";
import {
  LOCAL_FILE_EXECUTION_UNSUPPORTED,
  RELAY_FS_MAX_BYTES,
  RELAY_LOCAL_DOCUMENT_MAX_BYTES,
  RELAY_LOCAL_DOCUMENT_CHUNK_BYTES,
} from "../../src/constants";
import type { RelayCapabilities } from "../../src/types";

describe("relay protocol v19 — local-file, media extraction, Desktop Filesystem Grants", () => {
  test("keeps v4 local-file, media v5, v9 Desktop Filesystem Grants, and capability updates v7", () => {
    expect(RELAY_PROTOCOL_VERSION).toBe(20);
    expect(LOCAL_FILE_PROTOCOL_VERSION).toBe(4);
    expect(MEDIA_EXTRACTION_PROTOCOL_VERSION).toBe(5);
    expect(DESKTOP_FILESYSTEM_GRANT_REQUEST_PROTOCOL_VERSION).toBe(9);
  });

  test("local-file dispatch envelope can carry an optional desktopFilesystemGrantRequest", () => {
    const req: RelayLocalFileRequest = {
      operation: {
        kind: "file",
        command: "read",
        zone: "current",
        args: { path: "notes.md" },
      },
      allowedRoots: ["/Users/alice/Projects/demo"],
    };
    const grant: RelayDesktopFilesystemGrantRequest = {
      version: RELAY_DESKTOP_FILESYSTEM_GRANT_REQUEST_VERSION,
      grantIds: ["grant-1"],
      requestedRoot: "/Users/alice/Projects/demo",
      operation: "read",
      subject: {
        userId: "alice",
        instanceId: "instance-A",
        relayId: "relay-1",
        agentScope: "workstation",
      },
      policy: { policyVersion: 2, lifetime: "durable" },
    };
    const msg: RelayDispatchMessage = {
      type: "relay:dispatch",
      correlationId: "relay-1:def",
      toolName: "local-file",
      args: req as unknown as Record<string, unknown>,
      impact: "read-only",
      approvalObtained: false,
      allowedRoots: [...req.allowedRoots],
      executionClass: "local-file",
      desktopFilesystemGrantRequest: grant,
    };
    expect(msg.desktopFilesystemGrantRequest?.grantIds).toEqual(["grant-1"]);
    // Baseline: allowedRoots is never authority for the grant path.
    expect(msg.allowedRoots).toEqual([...req.allowedRoots]);
    // A message without the field remains valid (pre-v6 baseline).
    const baseline: RelayDispatchMessage = { ...msg };
    delete baseline.desktopFilesystemGrantRequest;
    expect(baseline.desktopFilesystemGrantRequest).toBeUndefined();
  });

  test("RelayCapabilities accepts optional localFileExecution and canRunOffice", () => {
    const caps: RelayCapabilities = {
      profile: "desktop-agent",
      localFileExecution: true,
      canRunOffice: true,
    } satisfies RelayCapabilities;
    expect(caps.localFileExecution).toBe(true);
    expect(caps.canRunOffice).toBe(true);
  });

  test("local-file dispatch envelope carries executionClass and typed args", () => {
    const req: RelayLocalFileRequest = {
      operation: {
        kind: "file",
        command: "grep",
        zone: "current",
        args: { path: "notes.md", query: "TODO" },
      },
      allowedRoots: ["/Users/alice/Projects/demo"],
    };
    const msg: RelayDispatchMessage = {
      type: "relay:dispatch",
      correlationId: "relay-1:abc",
      toolName: "local-file",
      args: req as unknown as Record<string, unknown>,
      impact: "read-only",
      approvalObtained: false,
      allowedRoots: [...req.allowedRoots],
      executionClass: "local-file",
    };
    expect(msg.executionClass).toBe("local-file");
    expect(msg.toolName).toBe("local-file");
    expect((msg.args as unknown as RelayLocalFileRequest).operation.kind).toBe("file");
  });

  test("discriminated operation variants cover file, history, and office", () => {
    const fileOp: RelayLocalFileRequest = {
      operation: {
        kind: "file",
        command: "read",
        zone: "absolute",
        args: { path: "/tmp/x.txt" },
      },
      allowedRoots: ["/tmp"],
    };
    const historyOp: RelayLocalFileRequest = {
      operation: {
        kind: "history",
        command: "undo",
        args: { path: "draft.md", zone: "current" },
      },
      allowedRoots: ["/Users/alice/current"],
    };
    const officeOp: RelayLocalFileRequest = {
      operation: {
        kind: "office",
        operation: { command: "view", path: "report.docx", zone: "current" },
      },
      allowedRoots: ["/Users/alice/current"],
    };
    expect(fileOp.operation.kind).toBe("file");
    expect(historyOp.operation.kind).toBe("history");
    expect(officeOp.operation.kind).toBe("office");
  });

  test("RelayLocalFileResult discriminated ok/error shapes", () => {
    const ok: RelayLocalFileResult = { ok: true, result: { matches: [] } };
    const err: RelayLocalFileResult = {
      ok: false,
      code: LOCAL_FILE_EXECUTION_UNSUPPORTED,
      message: "unsupported",
    };
    expect(ok.ok).toBe(true);
    expect(err.ok).toBe(false);
    expect(err.code).toBe(LOCAL_FILE_EXECUTION_UNSUPPORTED);
  });

  test("parseRelayLocalFileSha256 accepts canonical lowercase hex only", () => {
    const canonical = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(parseRelayLocalFileSha256(canonical)).toBe(canonical);
    expect(parseRelayLocalFileSha256(canonical.toUpperCase())).toBe(canonical);
    expect(parseRelayLocalFileSha256(` ${canonical} `)).toBe(canonical);
    expect(parseRelayLocalFileSha256("not-a-sha")).toBeNull();
    expect(parseRelayLocalFileSha256("g".repeat(64))).toBeNull();
  });

  test("RelayFsChangeEvent supports host-only clientMutationId", () => {
    const event = {
      rootPath: "/tmp/root",
      path: "/tmp/root/docs",
      changedPath: "/tmp/root/docs/file.md",
      source: "relay" as const,
      op: "writeFileAtomic" as const,
      clientMutationId: "accept-request-1",
    };
    expect(event.clientMutationId).toBe("accept-request-1");
  });

  test("document transfer operation kind is separate from generic file commands", () => {
    const docOp: RelayLocalFileRequest = {
      operation: {
        kind: "document",
        command: "read_meta",
        zone: "current",
        args: { path: "large.html", sessionId: "11111111-1111-4111-8111-111111111111" },
      },
      allowedRoots: ["/Users/alice/project"],
    };
    expect(docOp.operation.kind).toBe("document");
    if (docOp.operation.kind === "document") {
      expect(docOp.operation.command).toBe("read_meta");
    }
  });

  test("document transport caps stay distinct from generic fs and media limits", () => {
    expect(RELAY_FS_MAX_BYTES).toBe(16 * 1024 * 1024);
    expect(RELAY_LOCAL_DOCUMENT_MAX_BYTES).toBe(50 * 1024 * 1024);
    expect(RELAY_LOCAL_DOCUMENT_CHUNK_BYTES).toBe(1024 * 1024);
    expect(RELAY_LOCAL_DOCUMENT_MAX_BYTES).toBeGreaterThan(RELAY_FS_MAX_BYTES);
  });
});
