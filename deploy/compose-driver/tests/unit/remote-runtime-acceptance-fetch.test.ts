import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { SshProfile } from "../../src/types.ts";
import {
  buildRemoteRuntimeAcceptanceTransport,
  REMOTE_SERVER_LOOPBACK_BASE_URL,
  type RemoteRuntimeFetchSpawn,
} from "../../src/remote-runtime-acceptance-fetch.ts";

const ssh: SshProfile = { host: "203.0.113.7", user: "root", port: 22 };
const composeProjectName = "nautilo-prod";

/** A minimal fake ChildProcess whose stdout/stderr we control synchronously. */
function fakeChild(opts: {
  respond: (args: string[]) => { stdout: string; stderr: string; code: number };
}): { spawnFn: RemoteRuntimeFetchSpawn; calls: { args: string[] }[] } {
  const calls: { args: string[] }[] = [];
  const spawnFn: RemoteRuntimeFetchSpawn = (
    _cmd: string,
    args: string[],
    _so: SpawnOptions,
  ): ChildProcess => {
    calls.push({ args });
    const child = new EventEmitter() as ChildProcess;
    child.stdout = new PassThrough() as ChildProcess["stdout"];
    child.stderr = new PassThrough() as ChildProcess["stderr"];
    // emit close asynchronously so the await collects first
    queueMicrotask(() => {
      const { stdout, stderr, code } = opts.respond(args);
      (child.stdout as PassThrough).end(stdout);
      (child.stderr as PassThrough).end(stderr);
      child.emit("close", code);
    });
    return child;
  };
  return { spawnFn, calls };
}

function argsJoined(args: string[]): string {
  return args.join(" ");
}

describe("buildRemoteRuntimeAcceptanceTransport — URL classification", () => {
  test("/health routes to loopback docker exec inside nautilo-server (host port not published)", async () => {
    const { spawnFn, calls } = fakeChild({
      respond: (args) => {
        const joined = argsJoined(args);
        expect(joined).toContain("docker exec -i");
        expect(joined).toContain("bun -e");
        expect(joined).not.toContain("docker exec -i \"$container\" curl");
        expect(joined).toContain(`${REMOTE_SERVER_LOOPBACK_BASE_URL}/health`);
        // Container resolved by Compose project + service labels.
        expect(joined).toContain(
          "label=com.docker.compose.project=nautilo-prod",
        );
        expect(joined).toContain(
          "label=com.docker.compose.service=nautilo-server",
        );
        // The public URL host is NOT replayed — only the path, against loopback.
        expect(joined).not.toContain("upgrade.example.test");
        return { stdout: "ok\n200", stderr: "", code: 0 };
      },
    });
    const transport = buildRemoteRuntimeAcceptanceTransport({
      ssh,
      composeProjectName,
      spawnFn,
    });
    const res = await transport.fetch("https://upgrade.example.test/health");
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    // ssh target wired from the profile.
    expect(calls[0]!.args).toContain("root@203.0.113.7");
  });

  test("/api/setup/status routes to loopback docker exec (identity must come from the target, not public DNS)", async () => {
    const { spawnFn, calls } = fakeChild({
      respond: (args) => {
        const joined = argsJoined(args);
        expect(joined).toContain("docker exec -i");
        expect(joined).toContain(
          `${REMOTE_SERVER_LOOPBACK_BASE_URL}/api/setup/status`,
        );
        expect(joined).not.toContain("upgrade.example.test");
        return {
          stdout: JSON.stringify({ instanceId: "upgrade-fixture" }) + "\n200",
          stderr: "",
          code: 0,
        };
      },
    });
    const transport = buildRemoteRuntimeAcceptanceTransport({
      ssh,
      composeProjectName,
      spawnFn,
    });
    const res = await transport.fetch("https://upgrade.example.test/api/setup/status");
    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text())).toEqual({ instanceId: "upgrade-fixture" });
    expect(calls[0]!.args).toContain("root@203.0.113.7");
  });

  test("HTTPS SPA + OIDC vhost checks use --resolve <hostname>:443:127.0.0.1 -k (target Caddy + correct SNI)", async () => {
    const seen: string[] = [];
    const { spawnFn } = fakeChild({
      respond: (args) => {
        const joined = argsJoined(args);
        seen.push(joined);
        // vhost checks run curl ON the remote host — no docker exec.
        expect(joined).toContain("curl");
        expect(joined).not.toContain("docker exec");
        return { stdout: "<html>spa</html>\n200", stderr: "", code: 0 };
      },
    });
    const transport = buildRemoteRuntimeAcceptanceTransport({
      ssh,
      composeProjectName,
      spawnFn,
    });
    await transport.fetch("https://upgrade.example.test/");
    await transport.fetch(
      "https://auth.upgrade.example.test/oidc/.well-known/openid-configuration",
    );

    const spa = seen[0]!;
    expect(spa).toContain("--resolve");
    expect(spa).toContain("upgrade.example.test:443:127.0.0.1");
    expect(spa).toContain("-k");
    expect(spa).toContain("https://upgrade.example.test/");

    const oidc = seen[1]!;
    expect(oidc).toContain("--resolve");
    expect(oidc).toContain("auth.upgrade.example.test:443:127.0.0.1");
    expect(oidc).toContain("-k");
    expect(oidc).toContain(
      "https://auth.upgrade.example.test/oidc/.well-known/openid-configuration",
    );
  });

  test("LAN HTTP URLs curl direct on the remote host (no --resolve, no docker exec, no operator host network)", async () => {
    const { spawnFn, calls } = fakeChild({
      respond: (args) => {
        const joined = argsJoined(args);
        expect(joined).toContain("curl");
        expect(joined).toContain("http://10.0.0.2:4001/");
        expect(joined).not.toContain("--resolve");
        expect(joined).not.toContain("docker exec");
        return { stdout: "<html>lan</html>\n200", stderr: "", code: 0 };
      },
    });
    const transport = buildRemoteRuntimeAcceptanceTransport({
      ssh,
      composeProjectName,
      spawnFn,
    });
    const res = await transport.fetch("http://10.0.0.2:4001/");
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe("<html>lan</html>");
    expect(calls[0]!.args).toContain("root@203.0.113.7");
  });
});

describe("buildRemoteRuntimeAcceptanceTransport — trailer parsing + fail-closed", () => {
  test("non-2xx status is parsed from the trailer and body preserved (not a throw)", async () => {
    const { spawnFn } = fakeChild({
      respond: () => ({ stdout: "forbidden\n403", stderr: "", code: 0 }),
    });
    const transport = buildRemoteRuntimeAcceptanceTransport({
      ssh,
      composeProjectName,
      spawnFn,
    });
    const res = await transport.fetch("https://upgrade.example.test/health");
    expect(res.status).toBe(403);
    expect(res.ok).toBe(false);
    expect(await res.text()).toBe("forbidden");
  });

  test("ssh/container-probe nonzero exit throws a TypeError so the gate maps it to a network error", async () => {
    const { spawnFn } = fakeChild({
      respond: () => ({
        stdout: "",
        stderr: "ssh: connect to host: Connection refused",
        code: 255,
      }),
    });
    const transport = buildRemoteRuntimeAcceptanceTransport({
      ssh,
      composeProjectName,
      spawnFn,
    });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(
      transport.fetch("https://upgrade.example.test/health"),
    ).rejects.toThrow(/remote-acceptance fetch.*Connection refused/);
  });

  test("missing status trailer fails closed (unparseable / no trailer)", async () => {
    const { spawnFn } = fakeChild({
      respond: () => ({ stdout: "no-trailer-here", stderr: "", code: 0 }),
    });
    const transport = buildRemoteRuntimeAcceptanceTransport({
      ssh,
      composeProjectName,
      spawnFn,
    });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(
      transport.fetch("https://upgrade.example.test/health"),
    ).rejects.toThrow(/remote-acceptance fetch/);
  });

  test("unparseable status trailer fails closed", async () => {
    const { spawnFn } = fakeChild({
      respond: () => ({ stdout: "body\nnot-a-status", stderr: "", code: 0 }),
    });
    const transport = buildRemoteRuntimeAcceptanceTransport({
      ssh,
      composeProjectName,
      spawnFn,
    });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(
      transport.fetch("https://upgrade.example.test/health"),
    ).rejects.toThrow(/unparseable status 'not-a-status'/);
  });

  test("BatchMode=yes is enforced on the ssh invocation (no interactive prompts)", async () => {
    const { spawnFn, calls } = fakeChild({
      respond: () => ({ stdout: "ok\n200", stderr: "", code: 0 }),
    });
    const transport = buildRemoteRuntimeAcceptanceTransport({
      ssh,
      composeProjectName,
      spawnFn,
    });
    void transport.fetch("https://upgrade.example.test/health");
    expect(calls[0]!.args).toContain("BatchMode=yes");
  });
});

describe("buildRemoteRuntimeAcceptanceTransport — pollHealth", () => {
  test("polls /health over loopback until ok", async () => {
    let n = 0;
    const { spawnFn, calls } = fakeChild({
      respond: (args) => {
        const joined = argsJoined(args);
        // pollHealth always routes /health to loopback docker exec.
        expect(joined).toContain("docker exec -i");
        expect(joined).toContain(`${REMOTE_SERVER_LOOPBACK_BASE_URL}/health`);
        n += 1;
        if (n < 3) return { stdout: "no\n503", stderr: "", code: 0 };
        return { stdout: "ok\n200", stderr: "", code: 0 };
      },
    });
    const transport = buildRemoteRuntimeAcceptanceTransport({
      ssh,
      composeProjectName,
      spawnFn,
      serverHealthTimeoutMs: 1000,
      pollIntervalMs: 1,
    });
    await transport.pollHealth("https://upgrade.example.test");
    // The /health URL was probed via loopback at least 3 times (503 → 503 → 200).
    expect(n).toBe(3);
    expect(calls.length).toBe(3);
  });

  test("timeout throws the canonical never-became-ready error", async () => {
    const { spawnFn, calls } = fakeChild({
      respond: () => ({ stdout: "no\n503", stderr: "", code: 0 }),
    });
    const transport = buildRemoteRuntimeAcceptanceTransport({
      ssh,
      composeProjectName,
      spawnFn,
      serverHealthTimeoutMs: 0,
      pollIntervalMs: 1,
    });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(transport.pollHealth("https://upgrade.example.test")).rejects.toThrow(
      /nautilo-server \/health never became ready within 0ms/,
    );
    expect(calls).toHaveLength(1);
  });

  test("pollHealth SSH probe failure throws (fail closed, not a false green)", async () => {
    const { spawnFn } = fakeChild({
      respond: () => ({
        stdout: "",
        stderr: "ssh: connect to host: Connection refused",
        code: 255,
      }),
    });
    const transport = buildRemoteRuntimeAcceptanceTransport({
      ssh,
      composeProjectName,
      spawnFn,
      serverHealthTimeoutMs: 5,
      pollIntervalMs: 1,
    });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(transport.pollHealth("https://upgrade.example.test")).rejects.toThrow(
      /never became ready.*Connection refused/,
    );
  });
});
