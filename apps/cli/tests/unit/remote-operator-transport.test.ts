import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { SshProfile } from "@nautilo/compose-driver";
import type { ResolvedInstance } from "@nautilo/config";
import {
  buildSshLocalFetch,
  resolveRemoteLoopbackBaseUrl,
} from "../../src/lib/remote-operator-transport.ts";

const ssh: SshProfile = { host: "203.0.113.7", user: "root", port: 22 };
const composeProjectName = "nautilo-prod";

/** A minimal fake ChildProcess whose stdio we control synchronously. */
function fakeChild(opts: {
  respond: (args: string[], stdin: string | undefined) => { stdout: string; stderr: string; code: number };
}): { spawnFn: (cmd: string, args: string[], so: SpawnOptions) => ChildProcess; calls: { args: string[]; stdin?: string }[] } {
  const calls: { args: string[]; stdin?: string }[] = [];
  const spawnFn = (_cmd: string, args: string[], _so: SpawnOptions): ChildProcess => {
    calls.push({ args });
    const child = new EventEmitter() as ChildProcess;
    child.stdin = new PassThrough() as ChildProcess["stdin"];
    child.stdout = new PassThrough() as ChildProcess["stdout"];
    child.stderr = new PassThrough() as ChildProcess["stderr"];
    let stdinData = "";
    (child.stdin as PassThrough).on("data", (c: Buffer) => {
      stdinData += c.toString("utf8");
    });
    (child.stdin as PassThrough).on("end", () => {
      calls[calls.length - 1]!.stdin = stdinData;
      const { stdout, stderr, code } = opts.respond(args, stdinData);
      (child.stdout as PassThrough).end(stdout);
      (child.stderr as PassThrough).end(stderr);
      // emit close asynchronously so the await collects first
      queueMicrotask(() => child.emit("close", code));
    });
    return child;
  };
  return { spawnFn, calls };
}

const inst: ResolvedInstance = {
  instanceId: "prod",
  server: { port: 4001, url: "http://localhost:4001" },
  workbench: { port: 5173, url: "http://localhost:5173" },
  db: {
    postgresHostPort: 6434,
    neonProxyPort: 6445,
    directConnection: "postgres://nautilo:pw@127.0.0.1:6434/nautilo",
  },
  logto: { dbPort: 6432, corePort: 4301, adminPort: 4302 },
  compose: { projectName: "nautilo-prod" },
  hostname: { federated: "", mdns: "", tlsSan: "", caddyAuthHost: "", caddyAuthAdminHost: "" },
} as unknown as ResolvedInstance;

describe("resolveRemoteLoopbackBaseUrl (D427 3.1.1)", () => {
  test("returns the server-container loopback URL", () => {
    expect(resolveRemoteLoopbackBaseUrl(ssh, inst)).toBe("http://127.0.0.1:3001");
  });

  test("throws when ssh.host is missing", () => {
    expect(() =>
      resolveRemoteLoopbackBaseUrl({ host: undefined as unknown as string, user: "root" } as SshProfile, inst),
    ).toThrow(/missing ssh\.host/);
  });
});

describe("buildSshLocalFetch (D427 3.1.1)", () => {
  test("GET: runs ssh <target> -- Bun fetch against the loopback URL and returns status + body", async () => {
    const { spawnFn, calls } = fakeChild({
      respond: (args) => {
        // The remote command is shell-quoted by buildSshArgs; assert Bun + URL present.
        const joined = args.join(" ");
        expect(joined).toContain("bun -e");
        expect(joined).not.toContain("docker exec -i \"$container\" curl");
        expect(joined).toContain("http://127.0.0.1:3001/api/operator/maintenance/status");
        expect(joined).toContain(" GET ");
        return { stdout: '{"state":"normal"}\n200', stderr: "", code: 0 };
      },
    });
    const fetchFn = buildSshLocalFetch({ ssh, composeProjectName, spawnFn });
    const res = await fetchFn("http://127.0.0.1:3001/api/operator/maintenance/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "normal" });
    // The ssh target is wired from the profile.
    expect(calls[0]!.args).toContain("root@203.0.113.7");
    expect(calls[0]!.args.join(" ")).toContain(
      "label=com.docker.compose.project=nautilo-prod",
    );
    expect(calls[0]!.args.join(" ")).toContain("docker exec -i");
  });

  test("POST with JSON body: sends method, content-type header, and body on stdin", async () => {
    const { spawnFn } = fakeChild({
      respond: (args, stdin) => {
        const joined = args.join(" ");
        expect(joined).toContain(" POST ");
        expect(joined).toContain("content-type");
        expect(joined).toContain("application/json");
        expect(stdin).toBe('{"hardMs":1800000}');
        return { stdout: '{"state":"draining"}\n200', stderr: "", code: 0 };
      },
    });
    const fetchFn = buildSshLocalFetch({ ssh, composeProjectName, spawnFn });
    const res = await fetchFn("http://127.0.0.1:3001/api/operator/maintenance/enter", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hardMs: 1800000 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "draining" });
  });

  test("non-2xx response: status is parsed from the trailer and body preserved", async () => {
    const { spawnFn } = fakeChild({
      respond: () => ({ stdout: "forbidden\n403", stderr: "", code: 0 }),
    });
    const fetchFn = buildSshLocalFetch({ ssh, composeProjectName, spawnFn });
    const res = await fetchFn("http://127.0.0.1:3001/api/operator/maintenance/enter", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
    expect(res.ok).toBe(false);
    expect(await res.text()).toBe("forbidden");
  });

  test("ssh/container-probe failure: throws a TypeError so the drain maps it to a network error", async () => {
    const { spawnFn } = fakeChild({
      respond: () => ({ stdout: "", stderr: "ssh: connect to host: Connection refused", code: 255 }),
    });
    const fetchFn = buildSshLocalFetch({ ssh, composeProjectName, spawnFn });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(
      fetchFn("http://127.0.0.1:3001/api/operator/maintenance/status"),
    ).rejects.toThrow(/ssh-local fetch.*Connection refused/);
  });

  test("BatchMode=yes is enforced on the ssh invocation (no interactive prompts)", () => {
    const { spawnFn, calls } = fakeChild({
      respond: () => ({ stdout: '{"state":"normal"}\n200', stderr: "", code: 0 }),
    });
    const fetchFn = buildSshLocalFetch({ ssh, composeProjectName, spawnFn });
    void fetchFn("http://127.0.0.1:3001/api/operator/maintenance/status");
    expect(calls[0]!.args).toContain("BatchMode=yes");
  });
});
