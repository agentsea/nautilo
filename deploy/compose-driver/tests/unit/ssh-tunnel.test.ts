import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { openSshTunnel } from "../../src/ssh-tunnel.ts";
import type { SshProfile } from "../../src/types.ts";

const ssh: SshProfile = { host: "1.2.3.4", user: "root", port: 22 };

function fakeChild(): ChildProcess & { killCalls: string[] } {
  const emitter = new EventEmitter() as ChildProcess & { killCalls: string[] };
  emitter.killCalls = [];
  emitter.kill = ((signal?: string) => {
    emitter.killCalls.push(signal ?? "SIGTERM");
    return true;
  }) as ChildProcess["kill"];
  return emitter;
}

describe("openSshTunnel", () => {
  test("resolves when probe succeeds after initial failure", async () => {
    const child = fakeChild();
    let probeCount = 0;
    const handle = await openSshTunnel(
      ssh,
      [{ local: 15432, remoteHost: "127.0.0.1", remote: 5432 }],
      {
        spawnFn: () => child,
        probePort: async () => {
          probeCount++;
          return probeCount >= 2;
        },
        timeoutMs: 5000,
        pollIntervalMs: 10,
      },
    );
    expect(handle).toBeDefined();
    const closePromise = handle.close();
    child.emit("exit", 0, null);
    await closePromise;
    expect(child.killCalls).toContain("SIGTERM");
  });

  test("uses strict host-key checking with a dedicated known_hosts file", async () => {
    const child = fakeChild();
    let spawnArgs: string[] | undefined;
    const handle = await openSshTunnel(
      {
        ...ssh,
        known_hosts_file: "/tmp/known_hosts",
      },
      [{ local: 15432, remoteHost: "127.0.0.1", remote: 5432 }],
      {
        spawnFn: (_cmd, args) => {
          spawnArgs = args;
          return child;
        },
        probePort: async () => true,
      },
    );
    expect(spawnArgs).toContain("UserKnownHostsFile=/tmp/known_hosts");
    expect(spawnArgs).toContain("StrictHostKeyChecking=yes");
    const closePromise = handle.close();
    child.emit("exit", 0, null);
    await closePromise;
  });

  test("rejects when ssh exits early", async () => {
    const child = fakeChild();
    const promise = openSshTunnel(
      ssh,
      [{ local: 15432, remoteHost: "127.0.0.1", remote: 5432 }],
      {
        spawnFn: () => child,
        probePort: async () => false,
        timeoutMs: 5000,
        pollIntervalMs: 10,
      },
    );
    child.emit("exit", 255, null);
    let err: unknown;
    try {
      await promise;
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toMatch(/exited early/);
  });

  test("rejects on timeout and kills child", async () => {
    const child = fakeChild();
    let err: unknown;
    try {
      await openSshTunnel(
        ssh,
        [{ local: 19999, remoteHost: "127.0.0.1", remote: 5432 }],
        {
          spawnFn: () => child,
          probePort: async () => false,
          timeoutMs: 50,
          pollIntervalMs: 10,
        },
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toMatch(/did not bind/);
    expect(child.killCalls.length).toBeGreaterThan(0);
  });
});
