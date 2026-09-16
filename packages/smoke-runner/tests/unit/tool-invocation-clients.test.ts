/**
 * D063 Phase 6 task 6.2 — tests for VmToolInvocationClient and
 * HttpToolInvocationClient.
 *
 * Both use the same `POST /api/test/tool-invoke` payload shape;
 * they differ only in transport (shell-via-driver vs native fetch).
 * The same request → same response shape invariant is asserted via
 * both paths using a single fake backend.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  HttpToolInvocationClient,
  VmToolInvocationClient,
} from "../../src/nautilo-client.ts";
import type {
  ToolInvocationRequest,
  ToolInvocationResponse,
} from "../../src/types.ts";
import type { VmDriver } from "../../src/driver.ts";
import type { ExecResult } from "../../src/types.ts";

const OK_RESPONSE: ToolInvocationResponse = {
  blocked: true,
  reason: "path escapes zone via symlink",
  layerHit: "realpath-containment",
};

// ---------------------------------------------------------------------------
// HttpToolInvocationClient
// ---------------------------------------------------------------------------

describe("HttpToolInvocationClient", () => {
  const originalFetch = globalThis.fetch;
  let fetchSpy: ReturnType<typeof mock>;

  beforeEach(() => {
    fetchSpy = mock(async (_url: string, _init?: RequestInit) => {
      return new Response(JSON.stringify(OK_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("POSTs to /api/test/tool-invoke with bearer auth + JSON body", async () => {
    const client = new HttpToolInvocationClient({
      baseUrl: "http://localhost:3001",
      token: "test-token-xyz",
    });

    const req: ToolInvocationRequest = {
      tool: "file",
      args: { command: "read", zone: "absolute", path: "/etc/passwd" },
      securityLevel: "standard",
    };
    const resp = await client.toolInvoke(req);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe("http://localhost:3001/api/test/tool-invoke");
    expect(call[1].method).toBe("POST");
    const headers = call[1].headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-token-xyz");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(call[1].body as string) as ToolInvocationRequest).toEqual(req);
    expect(resp).toEqual(OK_RESPONSE);
  });

  test("strips trailing slash from baseUrl", async () => {
    const client = new HttpToolInvocationClient({
      baseUrl: "http://localhost:3001/",
      token: "t",
    });
    await client.toolInvoke({ tool: "file", args: {} });
    const call = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe("http://localhost:3001/api/test/tool-invoke");
  });

  test("throws on non-2xx with descriptive message", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response("token rejected", {
          status: 404,
          headers: { "Content-Type": "text/plain" },
        }),
    ) as unknown as typeof fetch;

    const client = new HttpToolInvocationClient({
      baseUrl: "http://localhost:3001",
      token: "t",
    });
    expect(
      client.toolInvoke({ tool: "file", args: {} }),
    ).rejects.toThrow(/HTTP 404/);
  });
});

// ---------------------------------------------------------------------------
// VmToolInvocationClient
// ---------------------------------------------------------------------------

function makeFakeDriver(exec: (cmd: string) => Promise<ExecResult>): VmDriver {
  return {
    platform: "linux",
    vmName: "fake",
    async info() { return { tool: "lima", version: "0.0.0", vmName: "fake" }; },
    async status() { return "running"; },
    async start() { /* noop */ },
    async stop() { /* noop */ },
    async snapshotTake() { /* noop */ },
    async snapshotRestore() { /* noop */ },
    async snapshotList() { return []; },
    execShell: exec,
    async healthProbe() { return { ok: true, checks: [] }; },
  } as unknown as VmDriver;
}

describe("VmToolInvocationClient", () => {
  test("base64-encodes body and pipes through curl inside the guest", async () => {
    let observedCmd = "";
    const driver = makeFakeDriver(async (cmd) => {
      observedCmd = cmd;
      return {
        stdout: JSON.stringify(OK_RESPONSE),
        stderr: "",
        exitCode: 0,
        durationMs: 5,
        timedOut: false,
      };
    });

    const client = new VmToolInvocationClient(driver, { token: "vmtoken" });
    const req: ToolInvocationRequest = {
      tool: "file",
      args: { command: "read", zone: "workspace", path: "x.txt" },
    };
    const resp = await client.toolInvoke(req);

    // Command shape: echo <b64> | base64 -d | curl --fail-with-body ... http://127.0.0.1:3001/api/test/tool-invoke
    expect(observedCmd).toContain("base64 -d");
    expect(observedCmd).toContain("curl --fail-with-body");
    expect(observedCmd).toContain("Authorization: Bearer vmtoken");
    expect(observedCmd).toContain("http://127.0.0.1:3001/api/test/tool-invoke");
    expect(observedCmd).toContain("Content-Type: application/json");

    // The JSON body should decode correctly — extract the b64 segment
    // and round-trip it through base64 decode.
    const b64Match = /echo ([A-Za-z0-9+/=]+) \| base64/.exec(observedCmd);
    expect(b64Match).not.toBeNull();
    if (b64Match) {
      const decoded = Buffer.from(b64Match[1]!, "base64").toString("utf8");
      expect(JSON.parse(decoded) as ToolInvocationRequest).toEqual(req);
    }

    expect(resp).toEqual(OK_RESPONSE);
  });

  test("custom baseUrl is honored (e.g. non-default port)", async () => {
    let observedCmd = "";
    const driver = makeFakeDriver(async (cmd) => {
      observedCmd = cmd;
      return {
        stdout: JSON.stringify(OK_RESPONSE),
        stderr: "",
        exitCode: 0,
        durationMs: 5,
        timedOut: false,
      };
    });

    const client = new VmToolInvocationClient(driver, {
      baseUrl: "http://127.0.0.1:9999/",
      token: "t",
    });
    await client.toolInvoke({ tool: "file", args: {} });
    expect(observedCmd).toContain("http://127.0.0.1:9999/api/test/tool-invoke");
    // Trailing slash stripped
    expect(observedCmd).not.toContain("9999//api");
  });

  test("throws when curl exits non-zero", async () => {
    const driver = makeFakeDriver(async () => ({
      stdout: "",
      stderr: "curl: (7) Failed to connect",
      exitCode: 7,
      durationMs: 5,
      timedOut: false,
    }));
    const client = new VmToolInvocationClient(driver, { token: "t" });
    expect(
      client.toolInvoke({ tool: "file", args: {} }),
    ).rejects.toThrow(/curl exit 7.*Failed to connect/);
  });
});
