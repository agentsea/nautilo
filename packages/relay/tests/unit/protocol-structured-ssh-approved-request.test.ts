import { describe, expect, test } from "bun:test";
import {
  canonicalRelaySshApprovedRequestJsonV1,
  computeRelaySshApprovedRequestDigestV1,
  parseRelaySshApprovedRequestV1,
  RELAY_SSH_APPROVED_REQUEST_MAX_ARGV_ENTRIES,
  RELAY_SSH_APPROVED_REQUEST_VERSION,
  RELAY_SSH_DISPATCH_BINDING_VERSION,
  parseRelaySshDispatchBinding,
  type RelaySshApprovedAuthRequestV1,
  type RelaySshApprovedCopyDownloadRequestV1,
  type RelaySshApprovedCopyUploadRequestV1,
  type RelaySshApprovedExecRequestV1,
  type RelaySshDispatchBindingV1,
} from "../../src/index";

const AUTH: RelaySshApprovedAuthRequestV1 = {
  version: RELAY_SSH_APPROVED_REQUEST_VERSION,
  toolCallId: "tool-call-1",
  toolName: "structured_ssh_auth",
  args: { destination: { connection: "build" } },
};

const EXEC: RelaySshApprovedExecRequestV1 = {
  version: RELAY_SSH_APPROVED_REQUEST_VERSION,
  toolCallId: "tool-call-1",
  toolName: "structured_ssh_exec",
  args: {
    destination: { host: "build.example.test", user: "deploy", port: 2222 },
    program: "printf",
    argv: ["", "a\"b", "c\\d", "雪", "🧬", "\u0001"],
    timeoutSeconds: 300,
  },
};

const COPY_UPLOAD: RelaySshApprovedCopyUploadRequestV1 = {
  version: RELAY_SSH_APPROVED_REQUEST_VERSION,
  toolCallId: "tool-call-copy",
  toolName: "structured_ssh_copy_upload",
  args: {
    destination: { host: "build.example.test", user: "deploy" },
    localPath: "artifacts/release.tar",
    remotePath: "/tmp/release.tar",
    timeoutSeconds: 300,
  },
};

const COPY_DOWNLOAD: RelaySshApprovedCopyDownloadRequestV1 = {
  version: RELAY_SSH_APPROVED_REQUEST_VERSION,
  toolCallId: "tool-call-copy",
  toolName: "structured_ssh_copy_download",
  args: {
    destination: { connection: "build" },
    remotePath: "/tmp/result.tar",
    localPath: "artifacts/result.tar",
    timeoutSeconds: 300,
  },
};

const BINDING: RelaySshDispatchBindingV1 = {
  version: RELAY_SSH_DISPATCH_BINDING_VERSION,
  admissionId: "admission-1",
  toolCallId: "tool-call-1",
  approvedRequestDigest: "a".repeat(64),
  operation: "exec",
  preparationId: "ssh-preparation-1",
  subject: {
    userId: "user-1",
    actorId: "actor-1",
    actorRole: "owner",
    agentId: "agent-1",
    executionEntrypoint: "foreground.main",
    instanceId: "instance-1",
    relayId: "relay-1",
    relaySessionId: "relay-session-1",
    desktopSessionId: "desktop-1",
    pairingGenerationRef: "pairing-1",
    capabilityRevision: 7,
  },
};

describe("D500 canonical structured SSH approved request", () => {
  test("rebuilds auth and pins its canonical JSON and SHA-256 vector", () => {
    expect(parseRelaySshApprovedRequestV1(AUTH)).toEqual({ ok: true, request: AUTH });
    expect(canonicalRelaySshApprovedRequestJsonV1(AUTH)).toBe(
      "{\"version\":3,\"toolCallId\":\"tool-call-1\",\"toolName\":\"structured_ssh_auth\",\"args\":{\"destination\":{\"connection\":\"build\"}}}",
    );
    expect(computeRelaySshApprovedRequestDigestV1(AUTH)).toBe(
      "3d44e4eefdb5994750a1437fefe5df2947c49258c770d62c05cf3d74175e19ef",
    );
  });

  test("pins Unicode and escaping without normalization and ignores input key order", () => {
    const reordered = {
      args: { timeoutSeconds: EXEC.args.timeoutSeconds, argv: [...EXEC.args.argv], program: EXEC.args.program, destination: { ...EXEC.args.destination } },
      toolName: EXEC.toolName,
      toolCallId: EXEC.toolCallId,
      version: EXEC.version,
    };
    const parsed = parseRelaySshApprovedRequestV1(reordered);
    expect(parsed).toEqual({ ok: true, request: EXEC });
    expect(canonicalRelaySshApprovedRequestJsonV1(EXEC)).toBe(
      "{\"version\":3,\"toolCallId\":\"tool-call-1\",\"toolName\":\"structured_ssh_exec\",\"args\":{\"destination\":{\"host\":\"build.example.test\",\"user\":\"deploy\",\"port\":2222},\"program\":\"printf\",\"argv\":[\"\",\"a\\\"b\",\"c\\\\d\",\"雪\",\"🧬\",\"\\u0001\"],\"timeoutSeconds\":300}}",
    );
    expect(computeRelaySshApprovedRequestDigestV1(EXEC)).toBe(
      "2998fa0875a9e14285b9f89c6f240ef68873496cdc76d150415a2b51cea477c2",
    );
    reordered.args.argv[0] = "changed-after-parse";
    expect(parsed).toEqual({ ok: true, request: EXEC });
    expect(canonicalRelaySshApprovedRequestJsonV1(parsed.ok ? parsed.request : EXEC)).toBe(
      canonicalRelaySshApprovedRequestJsonV1(EXEC),
    );
  });

  test("rejects extra or missing keys at every object boundary", () => {
    for (const malformed of [
      { ...AUTH, extra: true },
      { version: 1, toolCallId: AUTH.toolCallId, toolName: AUTH.toolName },
      { ...AUTH, args: { ...AUTH.args, extra: true } },
      { ...AUTH, args: { destination: { ...AUTH.args.destination, grantRef: "must-not-cross" } } },
      { ...AUTH, args: { destination: { connection: "build", host: "build.example.test", user: "deploy" } } },
      { ...EXEC, args: { ...EXEC.args, destination: { host: "build.example.test" } } },
      { ...EXEC, args: { program: EXEC.args.program } },
      { ...EXEC, args: { ...EXEC.args, remoteShellCommand: "must-not-exist" } },
    ]) {
      expect(parseRelaySshApprovedRequestV1(malformed)).toMatchObject({ ok: false });
    }
  });

  test("rejects wrong versions, tools, and argument shapes", () => {
    for (const malformed of [
      { ...AUTH, version: 1 },
      { ...AUTH, toolCallId: "bad id" },
      { ...AUTH, toolName: "ssh" },
      { ...AUTH, args: { destination: { host: "build.example.test" }, program: "printf", argv: [] } },
      { ...EXEC, args: { ...EXEC.args, argv: "not-an-array" } },
      { ...EXEC, args: { ...EXEC.args, destination: { ...EXEC.args.destination, identityPath: "/private/key" } } },
    ]) {
      expect(parseRelaySshApprovedRequestV1(malformed)).toMatchObject({ ok: false });
    }
  });

  test("enforces program and argv byte bounds while preserving POSIX argument data", () => {
    expect(parseRelaySshApprovedRequestV1({
      ...EXEC,
      args: { ...EXEC.args, program: "é".repeat(128) },
    })).toMatchObject({ ok: true });
    for (const program of ["", "-version", "ok\0bad", "ok\rbad", "ok\nbad", "ok\u0001bad", "ok\u0080bad", "\ud800", "\udc00", "é".repeat(129)]) {
      expect(parseRelaySshApprovedRequestV1({ ...EXEC, args: { ...EXEC.args, program } })).toMatchObject({ ok: false });
    }
    expect(parseRelaySshApprovedRequestV1({
      ...EXEC,
      args: { ...EXEC.args, argv: ["", "é".repeat(512), "%{http_code}\n", "line-1\r\nline-2"] },
    })).toMatchObject({ ok: true });
    for (const argv of [["ok\0bad"], ["\ud800"], ["\udc00"], ["é".repeat(513)], Array.from({ length: RELAY_SSH_APPROVED_REQUEST_MAX_ARGV_ENTRIES + 1 }, () => "x")]) {
      expect(parseRelaySshApprovedRequestV1({ ...EXEC, args: { ...EXEC.args, argv } })).toMatchObject({ ok: false });
    }
  });

  test("caps the canonical wire payload without claiming the broker command limit", () => {
    const escapedControl = "\u0001".repeat(1024);
    expect(parseRelaySshApprovedRequestV1({
      ...EXEC,
      args: {
        ...EXEC.args,
        argv: Array.from({ length: RELAY_SSH_APPROVED_REQUEST_MAX_ARGV_ENTRIES }, () => escapedControl),
      },
    })).toMatchObject({ ok: false });
  });

  test("changes the digest for the approved tool call, destination, tool, and arguments", () => {
    const changedToolCall: RelaySshApprovedAuthRequestV1 = { ...AUTH, toolCallId: "tool-call-2" };
    const changedArgs: RelaySshApprovedExecRequestV1 = { ...EXEC, args: { ...EXEC.args, argv: ["changed"] } };
    const changedDestination: RelaySshApprovedExecRequestV1 = {
      ...EXEC,
      args: { ...EXEC.args, destination: { host: "other.example.test", user: "deploy", port: 2222 } },
    };
    expect(computeRelaySshApprovedRequestDigestV1(AUTH)).not.toBe(
      computeRelaySshApprovedRequestDigestV1(changedToolCall),
    );
    expect(computeRelaySshApprovedRequestDigestV1(AUTH)).not.toBe(
      computeRelaySshApprovedRequestDigestV1(changedArgs),
    );
    expect(computeRelaySshApprovedRequestDigestV1(EXEC)).not.toBe(
      computeRelaySshApprovedRequestDigestV1(changedDestination),
    );
    expect(computeRelaySshApprovedRequestDigestV1(AUTH)).not.toBe(
      computeRelaySshApprovedRequestDigestV1({ ...EXEC, args: { ...EXEC.args, argv: [] } }),
    );
  });

  test("binds the exact timeout budget and reviewed long-operation reason", () => {
    const long = {
      ...EXEC,
      args: { ...EXEC.args, timeoutSeconds: 7_200, timeoutReason: "Database migration and verification" },
    };
    expect(parseRelaySshApprovedRequestV1(long)).toEqual({ ok: true, request: long });
    expect(canonicalRelaySshApprovedRequestJsonV1(long)).toContain('"timeoutSeconds":7200,"timeoutReason":"Database migration and verification"');
    expect(computeRelaySshApprovedRequestDigestV1(long)).not.toBe(computeRelaySshApprovedRequestDigestV1(EXEC));
    expect(computeRelaySshApprovedRequestDigestV1(long)).not.toBe(computeRelaySshApprovedRequestDigestV1({
      ...long,
      args: { ...long.args, timeoutReason: "Different reviewed operation" },
    }));
    for (const malformed of [
      { ...EXEC, args: { ...EXEC.args, timeoutSeconds: 0 } },
      { ...EXEC, args: { ...EXEC.args, timeoutSeconds: 14_401 } },
      { ...EXEC, args: { ...EXEC.args, timeoutSeconds: 1_801 } },
      { ...EXEC, args: { ...EXEC.args, timeoutSeconds: 300, timeoutReason: "not allowed here" } },
      { ...EXEC, args: { ...EXEC.args, timeoutSeconds: 1_801, timeoutReason: "too short" } },
    ]) expect(parseRelaySshApprovedRequestV1(malformed)).toMatchObject({ ok: false });
  });

  test("keeps named and ad hoc variants distinct in canonical JSON and digest", () => {
    const named: RelaySshApprovedAuthRequestV1 = { ...AUTH, args: { destination: { connection: "build" } } };
    const adHoc: RelaySshApprovedAuthRequestV1 = {
      ...AUTH,
      args: { destination: { host: "build.example.test", user: "deploy", port: 22 } },
    };
    expect(parseRelaySshApprovedRequestV1(named)).toEqual({ ok: true, request: named });
    expect(parseRelaySshApprovedRequestV1(adHoc)).toEqual({ ok: true, request: adHoc });
    expect(canonicalRelaySshApprovedRequestJsonV1(named)).not.toBe(canonicalRelaySshApprovedRequestJsonV1(adHoc));
    expect(computeRelaySshApprovedRequestDigestV1(named)).not.toBe(computeRelaySshApprovedRequestDigestV1(adHoc));
  });

  test("binds copy direction and both literal endpoints into the canonical digest", () => {
    expect(parseRelaySshApprovedRequestV1(COPY_UPLOAD)).toEqual({ ok: true, request: COPY_UPLOAD });
    expect(parseRelaySshApprovedRequestV1(COPY_DOWNLOAD)).toEqual({ ok: true, request: COPY_DOWNLOAD });
    expect(canonicalRelaySshApprovedRequestJsonV1(COPY_UPLOAD)).toBe(
      '{"version":3,"toolCallId":"tool-call-copy","toolName":"structured_ssh_copy_upload","args":{"destination":{"host":"build.example.test","user":"deploy"},"localPath":"artifacts/release.tar","remotePath":"/tmp/release.tar","timeoutSeconds":300}}',
    );
    const uploadDigest = computeRelaySshApprovedRequestDigestV1(COPY_UPLOAD);
    expect(uploadDigest).not.toBe(computeRelaySshApprovedRequestDigestV1(COPY_DOWNLOAD));
    expect(uploadDigest).not.toBe(computeRelaySshApprovedRequestDigestV1({
      ...COPY_UPLOAD,
      args: { ...COPY_UPLOAD.args, remotePath: "/tmp/other.tar" },
    }));
    expect(uploadDigest).not.toBe(computeRelaySshApprovedRequestDigestV1({
      ...COPY_UPLOAD,
      args: { ...COPY_UPLOAD.args, localPath: "artifacts/other.tar" },
    }));
    expect(uploadDigest).not.toBe(computeRelaySshApprovedRequestDigestV1({
      ...COPY_UPLOAD,
      args: { ...COPY_UPLOAD.args, destination: { host: "other.example.test", user: "deploy" } },
    }));
  });

  test("rejects copy traversal, option injection, shell syntax, controls, and authority smuggling", () => {
    for (const remotePath of [
      "../secret",
      "/tmp/../secret",
      "-O",
      "/tmp/$(touch-pwned)",
      "/tmp/a b",
      "/tmp/a:b",
      "/tmp/a\nb",
    ]) {
      expect(parseRelaySshApprovedRequestV1({
        ...COPY_UPLOAD,
        args: { ...COPY_UPLOAD.args, remotePath },
      })).toMatchObject({ ok: false });
    }
    for (const malformed of [
      { ...COPY_UPLOAD, args: { ...COPY_UPLOAD.args, localPath: "/absolute/file" } },
      { ...COPY_UPLOAD, args: { ...COPY_UPLOAD.args, localPath: "C:\\workspace\\release.tar" } },
      { ...COPY_UPLOAD, args: { ...COPY_UPLOAD.args, localPath: "../escape" } },
      { ...COPY_UPLOAD, args: { ...COPY_UPLOAD.args, localPath: "tmp/a\0b" } },
      { ...COPY_UPLOAD, args: { ...COPY_UPLOAD.args, destination: { host: "other.example.test", sshOptions: ["-oProxyCommand"] } } },
      { ...COPY_DOWNLOAD, args: { ...COPY_DOWNLOAD.args, grantRef: "ssh-grant-forged" } },
    ]) {
      expect(parseRelaySshApprovedRequestV1(malformed)).toMatchObject({ ok: false });
    }
  });

  test("does not normalize composed and decomposed Unicode before digesting", () => {
    const composed: RelaySshApprovedExecRequestV1 = {
      ...EXEC,
      args: { ...EXEC.args, argv: ["é"] },
    };
    const decomposed: RelaySshApprovedExecRequestV1 = {
      ...EXEC,
      args: { ...EXEC.args, argv: ["e\u0301"] },
    };
    expect(canonicalRelaySshApprovedRequestJsonV1(composed)).not.toBe(
      canonicalRelaySshApprovedRequestJsonV1(decomposed),
    );
    expect(computeRelaySshApprovedRequestDigestV1(composed)).not.toBe(
      computeRelaySshApprovedRequestDigestV1(decomposed),
    );
  });

  test("public canonicalization and hashing reject malformed runtime values", () => {
    for (const malformed of [
      null,
      { ...AUTH, toolName: "not-ssh" },
      { ...EXEC, args: { program: EXEC.args.program } },
      { ...AUTH, args: { remoteShellCommand: "unsafe" } },
    ]) {
      expect(() => canonicalRelaySshApprovedRequestJsonV1(malformed)).toThrow(
        "invalid structured SSH approved request",
      );
      expect(() => computeRelaySshApprovedRequestDigestV1(malformed)).toThrow(
        "invalid structured SSH approved request",
      );
    }
  });

  test("retains the existing strict SSH binding parser boundary", () => {
    expect(parseRelaySshDispatchBinding(BINDING)).toEqual({ ok: true, binding: BINDING });
    expect(parseRelaySshDispatchBinding({ ...BINDING, unexpected: true })).toMatchObject({ ok: false });
    const { approvedRequestDigest: _removed, ...missingDigest } = BINDING;
    expect(parseRelaySshDispatchBinding(missingDigest)).toMatchObject({ ok: false });
  });
});
