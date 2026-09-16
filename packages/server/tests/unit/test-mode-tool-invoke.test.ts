/**
 * Unit tests for the tool-invoke test-mode route (/api/test/tool-invoke).
 *
 * D063 Phase 6 — exercises the full pipeline (validateBeforeExecution →
 * zone-resolver → realpath-containment → handler) against a scoped
 * workspace root. Asserts both OUTCOME and LAYER so tests can detect
 * gate-order drift (one layer masking another's bug).
 *
 * Motivating cases re-tested here as unit coverage; the VM smoke
 * matrix (FILE-01..06) will run the same scenarios end-to-end.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, writeFile, symlink, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStorageZones,
  ensureDirectoryTree,
  fromRuntimeConfig,
  resolveNautiloRuntimePaths,
} from "@nautilo/config";
import { resetArtifactStorage, setArtifactStorage } from "@nautilo/agent";
import { testModeRoutes } from "../../src/routes/test-mode";
import {
  validateInvocationRequest,
  classifyHandlerError,
  expandHome,
  type ToolInvocationResponse,
} from "../../src/routes/test-mode-tool-invoke";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";

const TEST_TOKEN = "test-token-0123456789abcdef";

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  testModeRoutes(app, { enabled: true, token: TEST_TOKEN });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

function auth(): Record<string, string> {
  return { authorization: `Bearer ${TEST_TOKEN}` };
}

function parseBody<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

// ---------------------------------------------------------------------------
// Pure-function coverage
// ---------------------------------------------------------------------------

describe("validateInvocationRequest", () => {
  test("accepts a valid request", () => {
    const r = validateInvocationRequest({
      tool: "file",
      args: { command: "read", zone: "workspace", path: "a.txt" },
      securityLevel: "standard",
    });
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.tool).toBe("file");
      expect(r.securityLevel).toBe("standard");
    }
  });

  test("defaults securityLevel to standard when omitted", () => {
    const r = validateInvocationRequest({
      tool: "file",
      args: { command: "read", zone: "workspace", path: "a.txt" },
    });
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.securityLevel).toBe("standard");
    }
  });

  test("rejects missing tool", () => {
    const r = validateInvocationRequest({ args: {} });
    expect("error" in r).toBe(true);
  });

  test("rejects non-object args", () => {
    const r = validateInvocationRequest({ tool: "file", args: "oops" });
    expect("error" in r).toBe(true);
  });

  test("rejects unknown securityLevel", () => {
    const r = validateInvocationRequest({
      tool: "file",
      args: {},
      securityLevel: "banana",
    });
    expect("error" in r).toBe(true);
  });

  test("accepts D103 deployment/network posture overrides", () => {
    const r = validateInvocationRequest({
      tool: "run_shell",
      args: { command: "/usr/bin/curl https://example.com" },
      deploymentMode: "server",
      networkPolicy: { mode: "isolated" },
    });
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.deploymentMode).toBe("server");
      expect(r.networkPolicy).toEqual({ mode: "isolated" });
    }
  });

  test("rejects invalid D103 network posture override", () => {
    const r = validateInvocationRequest({
      tool: "run_shell",
      args: { command: "/usr/bin/curl https://example.com" },
      networkPolicy: { mode: "isolated", allow: [] },
    });
    expect("error" in r).toBe(true);
  });

  test("rejects non-object body", () => {
    expect("error" in validateInvocationRequest(null)).toBe(true);
    expect("error" in validateInvocationRequest("string")).toBe(true);
    expect("error" in validateInvocationRequest([])).toBe(true);
  });

  test("expands ~ in workspaceRoot", () => {
    const r = validateInvocationRequest({
      tool: "file",
      args: {},
      workspaceRoot: "~/smoke-ws",
    });
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.workspaceRoot).toBe(pathJoin(homedir(), "smoke-ws"));
    }
  });

  test("expands ~ in currentFolder", () => {
    const r = validateInvocationRequest({
      tool: "file",
      args: {},
      currentFolder: "~/my-cwd",
    });
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.currentFolder).toBe(pathJoin(homedir(), "my-cwd"));
    }
  });

  test("falls back to NAUTILO_SMOKE_WORKSPACE_ROOT env var", () => {
    const prior = process.env["NAUTILO_SMOKE_WORKSPACE_ROOT"];
    try {
      process.env["NAUTILO_SMOKE_WORKSPACE_ROOT"] = "/tmp/smoke-env";
      const r = validateInvocationRequest({ tool: "file", args: {} });
      expect("error" in r).toBe(false);
      if (!("error" in r)) {
        expect(r.workspaceRoot).toBe("/tmp/smoke-env");
      }
    } finally {
      if (prior === undefined) delete process.env["NAUTILO_SMOKE_WORKSPACE_ROOT"];
      else process.env["NAUTILO_SMOKE_WORKSPACE_ROOT"] = prior;
    }
  });

  test("request-provided workspaceRoot beats env var", () => {
    const prior = process.env["NAUTILO_SMOKE_WORKSPACE_ROOT"];
    try {
      process.env["NAUTILO_SMOKE_WORKSPACE_ROOT"] = "/tmp/env-loses";
      const r = validateInvocationRequest({
        tool: "file",
        args: {},
        workspaceRoot: "/tmp/request-wins",
      });
      expect("error" in r).toBe(false);
      if (!("error" in r)) {
        expect(r.workspaceRoot).toBe("/tmp/request-wins");
      }
    } finally {
      if (prior === undefined) delete process.env["NAUTILO_SMOKE_WORKSPACE_ROOT"];
      else process.env["NAUTILO_SMOKE_WORKSPACE_ROOT"] = prior;
    }
  });
});

describe("expandHome", () => {
  test("'~' alone → homedir", () => {
    expect(expandHome("~")).toBe(homedir());
  });
  test("'~/foo' → $HOME/foo", () => {
    expect(expandHome("~/foo")).toBe(pathJoin(homedir(), "foo"));
  });
  test("'~/foo/bar' → $HOME/foo/bar", () => {
    expect(expandHome("~/foo/bar")).toBe(pathJoin(homedir(), "foo/bar"));
  });
  test("absolute path passes through", () => {
    expect(expandHome("/abs/path")).toBe("/abs/path");
  });
  test("relative path passes through", () => {
    expect(expandHome("rel/path")).toBe("rel/path");
  });
  test("username-prefixed tilde NOT expanded (~user/foo stays literal)", () => {
    // We only handle the `~` / `~/…` forms; `~user/…` is shell-specific
    // and ambiguous across platforms. Passing through is correct.
    expect(expandHome("~alice/foo")).toBe("~alice/foo");
  });
  test("undefined/empty pass through", () => {
    expect(expandHome(undefined)).toBeUndefined();
    expect(expandHome("")).toBe("");
  });
});

describe("classifyHandlerError", () => {
  // Reason strings below are the CANONICAL shapes emitted by
  // packages/agent/src/tools/file/zones.ts. Keep them in sync — a
  // rewording at the emit site without a matching test update here
  // silently wrecks layer classification for the FILE-* matrix.

  test("'path escapes zone via symlink (...)' → realpath-containment", () => {
    const r = classifyHandlerError(
      new Error("path escapes zone via symlink (/ws/hijack -> /etc/passwd)"),
    );
    expect(r.layerHit).toBe("realpath-containment");
  });

  test("'parent directory escapes zone via symlink (...)' → realpath-containment", () => {
    const r = classifyHandlerError(
      new Error("parent directory escapes zone via symlink (/ws/dir -> /home/me/.ssh)"),
    );
    expect(r.layerHit).toBe("realpath-containment");
  });

  // NEGATIVE BOUNDARY: resolveZone's textual-traversal error shares the
  // substring "escapes zone" with assertRealpathContained but NEVER
  // contains "via symlink". It MUST classify as zone-resolver, not
  // realpath-containment. A regression here would mask the B-1-class
  // drift this module exists to detect.
  test("'resolved path escapes zone root (...)' → zone-resolver (not realpath)", () => {
    const r = classifyHandlerError(
      new Error("resolved path escapes zone root (/tmp/evil not under /tmp/ws)"),
    );
    expect(r.layerHit).toBe("zone-resolver");
  });

  test("'unknown zone' → zone-resolver", () => {
    const r = classifyHandlerError(new Error('unknown zone "banana"'));
    expect(r.layerHit).toBe("zone-resolver");
  });

  test("'workspace root is not set' → zone-resolver", () => {
    const r = classifyHandlerError(
      new Error("Workspace root is not set. This is a boot-order bug; server should have initialized it."),
    );
    expect(r.layerHit).toBe("zone-resolver");
  });

  test("'zone root is not set' → zone-resolver", () => {
    const r = classifyHandlerError(new Error("zone root is not set (boot-order bug)"));
    expect(r.layerHit).toBe("zone-resolver");
  });

  test("generic error → handler", () => {
    const r = classifyHandlerError(new Error("EACCES: permission denied"));
    expect(r.layerHit).toBe("handler");
  });

  test("non-Error value handled", () => {
    const r = classifyHandlerError("plain string");
    expect(r.layerHit).toBe("handler");
    expect(r.reason).toBe("plain string");
  });
});

// ---------------------------------------------------------------------------
// Route coverage — HTTP-level via Fastify inject
// ---------------------------------------------------------------------------

describe("POST /api/test/tool-invoke", () => {
  // Isolated workspace per test — created before, removed after
  let workspace: string;
  let outsideDir: string;
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "nautilo-test-invoke-"));
    outsideDir = await mkdtemp(join(tmpdir(), "nautilo-test-outside-"));
  });
  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });

  test("returns 404 without token (route invisible)", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/test/tool-invoke",
      payload: { tool: "file", args: {} },
    });
    expect(r.statusCode).toBe(404);
  });

  test("returns 400 on malformed body", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/test/tool-invoke",
      headers: auth(),
      payload: { tool: "", args: {} },
    });
    expect(r.statusCode).toBe(400);
  });

  test("returns 400 on unknown securityLevel", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/test/tool-invoke",
      headers: auth(),
      payload: {
        tool: "file",
        args: { command: "read", zone: "workspace", path: "a.txt" },
        securityLevel: "super-extra-paranoid",
      },
    });
    expect(r.statusCode).toBe(400);
  });

  test("unknown tool → blocked with layerHit=unknown", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/test/tool-invoke",
      headers: auth(),
      payload: {
        tool: "made_up_tool",
        args: {},
        workspaceRoot: workspace,
      },
    });
    expect(r.statusCode).toBe(200);
    const body = parseBody<ToolInvocationResponse>(r.body);
    expect(body.blocked).toBe(true);
    expect(body.layerHit).toBe("unknown");
  });

  // ---------------------------------------------------------------------
  // D073 / Sprint 2 G5 — execute_artifact lives on the cloud branch.
  //
  // The unit-level route harness may inherit artifact storage from
  // nearby package initializers, so this test asserts the stable
  // signal instead: dispatch reached execute_artifact (handler layer)
  // rather than the unknown-tool path.
  //
  // End-to-end execute_artifact behavior (script runs, sandbox
  // contains, etc.) is covered by:
  //   - Host: packages/agent/tests/integration/execute-artifact.test.ts
  //   - VM:   scripts/security-test-env/expected-outcomes.json
  //           EXEC-LINUX-* / EXEC-MACOS-* matrix rows.
  // ---------------------------------------------------------------------
  test("execute_artifact reaches the cloud factory", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/test/tool-invoke",
      headers: auth(),
      payload: {
        tool: "execute_artifact",
        args: { path: "smoke/print.py", zone: "home" },
        securityLevel: "standard",
      },
    });
    expect(r.statusCode).toBe(200);
    const body = parseBody<ToolInvocationResponse>(r.body);
    // Dispatch landed in the handler; classifier didn't get a
    // zone/realpath flavor so layerHit stays "handler". Either a
    // missing-storage or missing-artifact diagnostic proves the
    // factory was registered. An unsupported factory would have
    // returned layerHit=unknown before reaching execute_artifact.
    expect(body.blocked).toBe(true);
    expect(body.layerHit).toBe("handler");
    expect(body.reason).toMatch(/not initialised|artifact not found/);
  });

  test("returns the complete cloud-handler result beyond the former 10,000-character crop", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-test-cloud-result-"));
    const paths = resolveNautiloRuntimePaths({
      config: fromRuntimeConfig({}),
      env: {},
      userHomeDir: root,
    });
    const sentinel = "COMPLETE-CLOUD-RESULT-SENTINEL";
    const longOutput = `${"x".repeat(10_000)}${sentinel}`;
    const priorBudget = process.env["NAUTILO_SANDBOX_INLINE_OUTPUT_BYTES"];

    await ensureDirectoryTree(paths);
    setArtifactStorage(createStorageZones(paths));
    await writeFile(join(paths.rootDir, "home", "long-output.txt"), longOutput);
    await writeFile(
      join(paths.rootDir, "home", "long-output.sh"),
      "#!/bin/sh\ncat long-output.txt\n",
    );
    process.env["NAUTILO_SANDBOX_INLINE_OUTPUT_BYTES"] = String(
      Buffer.byteLength(longOutput, "utf8") + 1024,
    );
    try {
      const r = await app.inject({
        method: "POST",
        url: "/api/test/tool-invoke",
        headers: auth(),
        payload: {
          tool: "execute_artifact",
          args: { path: "long-output.sh", zone: "home" },
          securityLevel: "standard",
        },
      });

      expect(r.statusCode).toBe(200);
      const body = parseBody<ToolInvocationResponse>(r.body);
      expect(body).toMatchObject({ blocked: false, layerHit: "handler" });
      expect(body.result).toContain(sentinel);
    } finally {
      resetArtifactStorage();
      if (priorBudget === undefined) {
        delete process.env["NAUTILO_SANDBOX_INLINE_OUTPUT_BYTES"];
      } else {
        process.env["NAUTILO_SANDBOX_INLINE_OUTPUT_BYTES"] = priorBudget;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------
  // B-1 regression: absolute-zone file.read must hit validate-before-execution
  // ---------------------------------------------------------------------
  test("B-1: file({read, absolute, /etc/passwd}) blocked at validate-before-execution", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/test/tool-invoke",
      headers: auth(),
      payload: {
        tool: "file",
        args: { command: "read", zone: "absolute", path: "/etc/passwd" },
        securityLevel: "standard",
        workspaceRoot: workspace,
      },
    });
    expect(r.statusCode).toBe(200);
    const body = parseBody<ToolInvocationResponse>(r.body);
    expect(body.blocked).toBe(true);
    expect(body.layerHit).toBe("validate-before-execution");
    expect(body.reason).toBeDefined();
  });

  test("B-1: file({read, absolute, ~/.ssh/id_rsa}) blocked at validate-before-execution", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/test/tool-invoke",
      headers: auth(),
      payload: {
        tool: "file",
        args: { command: "read", zone: "absolute", path: "~/.ssh/id_rsa" },
        securityLevel: "standard",
        workspaceRoot: workspace,
      },
    });
    expect(r.statusCode).toBe(200);
    const body = parseBody<ToolInvocationResponse>(r.body);
    expect(body.blocked).toBe(true);
    expect(body.layerHit).toBe("validate-before-execution");
  });

  // ---------------------------------------------------------------------
  // M174 regression: current/absolute zones require a v2 relay
  // ---------------------------------------------------------------------
  // This unit harness does not wire a relay registry into the file-tool
  // cloud factory. Post-M174 that means `zone:"current"` fails with the
  // explicit connect-your-relay message BEFORE local realpath containment
  // or handler logic can touch the server's temp filesystem. Lower-level
  // agent tests still cover realpath containment through the local backend.
  test("M174: file({read, current, <symlink-out>}) fails closed without relay", async () => {
    const outsideFile = join(outsideDir, "secret.txt");
    await writeFile(outsideFile, "SECRET SENTINEL");
    const symlinkInside = join(workspace, "innocent.txt");
    await symlink(outsideFile, symlinkInside);

    const r = await app.inject({
      method: "POST",
      url: "/api/test/tool-invoke",
      headers: auth(),
      payload: {
        tool: "file",
        args: { command: "read", zone: "current", path: "innocent.txt" },
        securityLevel: "standard",
        currentFolder: workspace,
      },
    });
    expect(r.statusCode).toBe(200);
    const body = parseBody<ToolInvocationResponse>(r.body);
    expect(body.blocked).toBe(true);
    expect(body.layerHit).toBe("zone-resolver");
    expect(body.reason).toContain("LOCAL_FILE_EXECUTION_UNSUPPORTED");
    expect(body.reason).toContain("Nautilo desktop app");
    expect(body.result ?? "").not.toContain("SECRET SENTINEL");
  });

  test("M174: file({write, current, <symlink-out>}) fails closed without relay", async () => {
    const outsideFile = join(outsideDir, "target.txt");
    await writeFile(outsideFile, "original content");
    const symlinkInside = join(workspace, "trap.txt");
    await symlink(outsideFile, symlinkInside);

    const r = await app.inject({
      method: "POST",
      url: "/api/test/tool-invoke",
      headers: auth(),
      payload: {
        tool: "file",
        args: {
          command: "write",
          zone: "current",
          path: "trap.txt",
          content: "PWNED",
          mode: "overwrite",
        },
        securityLevel: "standard",
        currentFolder: workspace,
      },
    });
    expect(r.statusCode).toBe(200);
    const body = parseBody<ToolInvocationResponse>(r.body);
    expect(body.blocked).toBe(true);
    expect(body.layerHit).toBe("zone-resolver");
    expect(body.reason).toContain("LOCAL_FILE_EXECUTION_UNSUPPORTED");
    expect(body.reason).toContain("Nautilo desktop app");
  });

  // ---------------------------------------------------------------------
  // No-relay route behavior — current zone never falls back to server disk
  // ---------------------------------------------------------------------
  test("M174: file({read, current, <in-tree>}) returns no-relay error", async () => {
    const p = join(workspace, "hello.txt");
    await writeFile(p, "hello world");
    const r = await app.inject({
      method: "POST",
      url: "/api/test/tool-invoke",
      headers: auth(),
      payload: {
        tool: "file",
        args: { command: "read", zone: "current", path: "hello.txt" },
        securityLevel: "standard",
        currentFolder: workspace,
      },
    });
    expect(r.statusCode).toBe(200);
    const body = parseBody<ToolInvocationResponse>(r.body);
    expect(body.blocked).toBe(true);
    expect(body.layerHit).toBe("zone-resolver");
    expect(body.reason).toContain("LOCAL_FILE_EXECUTION_UNSUPPORTED");
    expect(body.reason).toContain("Nautilo desktop app");
    expect(body.result ?? "").not.toContain("hello world");
  });

  test("M174: file({list, current}) returns no-relay error", async () => {
    await writeFile(join(workspace, "a.txt"), "a");
    await mkdir(join(workspace, "sub"));
    const r = await app.inject({
      method: "POST",
      url: "/api/test/tool-invoke",
      headers: auth(),
      payload: {
        tool: "file",
        args: { command: "list", zone: "current", path: "." },
        securityLevel: "standard",
        currentFolder: workspace,
      },
    });
    expect(r.statusCode).toBe(200);
    const body = parseBody<ToolInvocationResponse>(r.body);
    expect(body.blocked).toBe(true);
    expect(body.layerHit).toBe("zone-resolver");
    expect(body.reason).toContain("LOCAL_FILE_EXECUTION_UNSUPPORTED");
    expect(body.reason).toContain("Nautilo desktop app");
    expect(body.result ?? "").not.toContain("a.txt");
  });
});

// ---------------------------------------------------------------------------
// D060 Sprint 2 G2 — relay-dispatch branch
// ---------------------------------------------------------------------------
//
// These tests exercise the run_shell path through a MOCK relay
// registry. The registry is a tiny hand-rolled stub that records the
// dispatch argument + returns a canned response. End-to-end VM-level
// coverage lives in the SANDBOX-LINUX-* smoke matrix (D063 follow-up);
// unit tests here assert the ENVELOPE construction + capability
// lookup + error branches the endpoint wires.

import type { RelayCapabilities, RelayDispatchResult, RelaySandboxProfile } from "@nautilo/relay";
// Using the narrow RelayRegistryLike interface the endpoint depends
// on — mock implements exactly the methods the endpoint consumes,
// no casts required.
import type { RelayRegistryLike } from "../../src/routes/test-mode-tool-invoke";

interface MockDispatchCall {
  readonly relayId: string;
  readonly toolName: string;
  readonly sandboxProfile?: RelaySandboxProfile | undefined;
  readonly args: Record<string, unknown>;
}

class MockRelayRegistry implements RelayRegistryLike {
  readonly calls: MockDispatchCall[] = [];
  readonly caps = new Map<string, RelayCapabilities>();
  readonly userRelays = new Map<string, string[]>(); // userId -> [relayId]
  dispatchResponse: RelayDispatchResult = {
    status: "ok",
    result: "shell output",
  };

  register(userId: string, relayId: string, caps: RelayCapabilities): void {
    this.caps.set(relayId, caps);
    const list = this.userRelays.get(userId) ?? [];
    list.push(relayId);
    this.userRelays.set(userId, list);
  }

  findByCapabilityForUser(cap: string, userId: string): string[] {
    const list = this.userRelays.get(userId) ?? [];
    return list.filter((rid) => {
      const c = this.caps.get(rid);
      if (!c) return false;
      const flag = c[cap as keyof RelayCapabilities];
      return flag === true;
    });
  }

  getCapabilities(relayId: string): RelayCapabilities | null {
    return this.caps.get(relayId) ?? null;
  }

  dispatch(
    relayId: string,
    request: {
      toolName: string;
      args: Record<string, unknown>;
      impact: "read-only" | "low" | "high" | "destructive";
      approvalObtained: boolean;
      allowedRoots?: string[] | undefined;
      sandboxProfile?: RelaySandboxProfile | undefined;
      timeout?: number | undefined;
    },
  ): Promise<RelayDispatchResult> {
    this.calls.push({
      relayId,
      toolName: request.toolName,
      ...(request.sandboxProfile !== undefined
        ? { sandboxProfile: request.sandboxProfile }
        : {}),
      args: request.args,
    });
    return Promise.resolve(this.dispatchResponse);
  }
}

describe("POST /api/test/tool-invoke — relay-dispatch branch (G2)", () => {
  const USER_ID = "@owner@nautilo.local";
  const RELAY_ID = "test-relay-01";
  let relayApp: FastifyInstance;
  let mockRegistry: MockRelayRegistry;

  beforeAll(async () => {
    mockRegistry = new MockRelayRegistry();
    mockRegistry.register(USER_ID, RELAY_ID, {
      profile: "desktop-agent",
      canRunShell: true,
      canReadWorkspace: true,
      canWriteWorkspace: true,
      workspaceRoot: "/home/nautilotest/workspace",
      allowedRoots: ["/home/nautilotest/workspace"],
      dataDir: "/home/nautilotest/.nautilo",
      toolsBin: "/home/nautilotest/.bun/bin",
      userHome: "/home/nautilotest",
    });

    relayApp = Fastify({ logger: false });
    testModeRoutes(relayApp, {
      enabled: true,
      token: TEST_TOKEN,
      relayRegistry: mockRegistry,
    });
    await relayApp.ready();
  });

  afterAll(async () => {
    await relayApp.close();
  });

  beforeEach(() => {
    mockRegistry.calls.length = 0;
    mockRegistry.dispatchResponse = {
      status: "ok",
      result: "shell output",
    };
  });

  test("happy path: run_shell dispatches with a well-formed sandboxProfile", async () => {
    const r = await relayApp.inject({
      method: "POST",
      url: "/api/test/tool-invoke",
      headers: auth(),
      payload: {
        tool: "run_shell",
        args: { command: "/bin/echo hello" },
        securityLevel: "standard",
      },
    });
    expect(r.statusCode).toBe(200);
    const body = parseBody<ToolInvocationResponse>(r.body);
    expect(body.blocked).toBe(false);
    expect(body.result).toContain("shell output");

    expect(mockRegistry.calls).toHaveLength(1);
    const call = mockRegistry.calls[0]!;
    expect(call.toolName).toBe("run_shell");
    expect(call.relayId).toBe(RELAY_ID);
    expect(call.sandboxProfile).toBeDefined();
    const profile = call.sandboxProfile!;
    // Envelope has the relay\u0027s reported paths threaded through.
    expect(profile.workspace).toBe("/home/nautilotest/workspace");
    expect(profile.dataDir).toBe("/home/nautilotest/.nautilo");
    expect(profile.toolsBin).toBe("/home/nautilotest/.bun/bin");
    // securityLevel / mode come from server posture (test-mode default).
    expect(typeof profile.securityLevel).toBe("string");
    expect(typeof profile.mode).toBe("string");
    // failIfNoBackend is the paranoid-contract field (G5.4 SEC-1 lock).
    expect(typeof profile.failIfNoBackend).toBe("boolean");
  });

  test("isolated paired UUID is the default while an explicit actor remains authoritative", async () => {
    const pairedUser = "c7d9b8b8-2c33-4e80-9498-65f32c18b38a";
    const registry = new MockRelayRegistry();
    registry.register(pairedUser, "paired-relay", mockRegistry.getCapabilities(RELAY_ID)!);
    const pairedApp = Fastify({ logger: false });
    testModeRoutes(pairedApp, {
      enabled: true, token: TEST_TOKEN, relayRegistry: registry, defaultRelayUserId: pairedUser,
    });
    try {
      const accepted = await pairedApp.inject({
        method: "POST", url: "/api/test/tool-invoke", headers: auth(),
        payload: { tool: "run_shell", args: { command: "/bin/echo hello" } },
      });
      expect(parseBody<ToolInvocationResponse>(accepted.body).blocked).toBe(false);
      expect(registry.calls[0]?.relayId).toBe("paired-relay");
      expect(registry.calls[0]?.sandboxProfile).toBeDefined();
      const otherActor = await pairedApp.inject({
        method: "POST", url: "/api/test/tool-invoke", headers: auth(),
        payload: { tool: "run_shell", actor: "another-user", args: { command: "/bin/echo hello" } },
      });
      expect(parseBody<ToolInvocationResponse>(otherActor.body).blocked).toBe(true);
      expect(registry.calls).toHaveLength(1);
    } finally { await pairedApp.close(); }
  });

  test("returns the complete relay result beyond the former 10,000-character crop", async () => {
    const sentinel = "COMPLETE-RESULT-SENTINEL";
    const completeResult = `${"x".repeat(10_000)}${sentinel}`;
    mockRegistry.dispatchResponse = { status: "ok", result: completeResult };

    const r = await relayApp.inject({
      method: "POST",
      url: "/api/test/tool-invoke",
      headers: auth(),
      payload: { tool: "run_shell", args: { command: "/bin/echo hello" } },
    });

    expect(r.statusCode).toBe(200);
    const body = parseBody<ToolInvocationResponse>(r.body);
    expect(body).toMatchObject({ blocked: false, result: completeResult, layerHit: "handler" });
    expect(body.result).toContain(sentinel);
  });

  test("D103 posture overrides ride the relay sandboxProfile", async () => {
    const r = await relayApp.inject({
      method: "POST",
      url: "/api/test/tool-invoke",
      headers: auth(),
      payload: {
        tool: "run_shell",
        args: { command: "/usr/bin/curl https://example.com" },
        deploymentMode: "server",
        networkPolicy: { mode: "isolated" },
      },
    });
    expect(r.statusCode).toBe(200);
    expect(mockRegistry.calls).toHaveLength(1);
    const profile = mockRegistry.calls[0]!.sandboxProfile!;
    expect(profile.mode).toBe("server");
    expect(profile.config.networkPolicy).toEqual({ mode: "isolated" });
  });

  test("no relay with capability → blocked with layerHit=unknown + instructive error", async () => {
    // Empty registry (no relays registered at all).
    const emptyRegistry = new MockRelayRegistry();
    const isolatedApp = Fastify({ logger: false });
    testModeRoutes(isolatedApp, {
      enabled: true,
      token: TEST_TOKEN,
      relayRegistry: emptyRegistry,
    });
    await isolatedApp.ready();

    const r = await isolatedApp.inject({
      method: "POST",
      url: "/api/test/tool-invoke",
      headers: auth(),
      payload: {
        tool: "run_shell",
        args: { command: "/bin/echo hi" },
      },
    });
    expect(r.statusCode).toBe(200);
    const body = parseBody<ToolInvocationResponse>(r.body);
    expect(body.blocked).toBe(true);
    expect(body.layerHit).toBe("unknown");
    expect(body.reason).toContain("no relay with capability");
    expect(body.reason).toContain("canRunShell");
    await isolatedApp.close();
  });

  test("relay-registry-null (test-mode standalone) → blocked with clear guidance", async () => {
    const noRegistryApp = Fastify({ logger: false });
    testModeRoutes(noRegistryApp, {
      enabled: true,
      token: TEST_TOKEN,
      // No relayRegistry passed — simulates running just the test-mode
      // server without relay infra (e.g. a unit-test harness).
    });
    await noRegistryApp.ready();

    const r = await noRegistryApp.inject({
      method: "POST",
      url: "/api/test/tool-invoke",
      headers: auth(),
      payload: { tool: "run_shell", args: { command: "/bin/echo hi" } },
    });
    const body = parseBody<ToolInvocationResponse>(r.body);
    expect(body.blocked).toBe(true);
    expect(body.layerHit).toBe("unknown");
    expect(body.reason).toContain("relayRegistry");
    await noRegistryApp.close();
  });

  test("relay dispatch returns status=error → blocked with layerHit=handler", async () => {
    mockRegistry.dispatchResponse = {
      status: "error",
      error: "bwrap: command not found",
    };
    const r = await relayApp.inject({
      method: "POST",
      url: "/api/test/tool-invoke",
      headers: auth(),
      payload: { tool: "run_shell", args: { command: "/bin/echo hi" } },
    });
    const body = parseBody<ToolInvocationResponse>(r.body);
    expect(body.blocked).toBe(true);
    expect(body.layerHit).toBe("handler");
    expect(body.reason).toContain("bwrap: command not found");
  });

  test("relay with missing dataDir → envelope unbuildable → clear error", async () => {
    // Register a relay that forgot to report dataDir. buildRelaySandboxProfile
    // returns null in that case; our endpoint surfaces the specific reason.
    const partialRegistry = new MockRelayRegistry();
    partialRegistry.register(USER_ID, "partial-relay", {
      profile: "desktop-agent",
      canRunShell: true,
      workspaceRoot: "/tmp/ws",
      allowedRoots: ["/tmp/ws"],
      // dataDir intentionally missing
      toolsBin: "/usr/local/bin",
    });
    const partialApp = Fastify({ logger: false });
    testModeRoutes(partialApp, {
      enabled: true,
      token: TEST_TOKEN,
      relayRegistry: partialRegistry,
    });
    await partialApp.ready();

    const r = await partialApp.inject({
      method: "POST",
      url: "/api/test/tool-invoke",
      headers: auth(),
      payload: { tool: "run_shell", args: { command: "/bin/echo hi" } },
    });
    const body = parseBody<ToolInvocationResponse>(r.body);
    expect(body.blocked).toBe(true);
    expect(body.layerHit).toBe("unknown");
    expect(body.reason).toContain("sandboxProfile");
    await partialApp.close();
  });
});
