import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

import {
  defaultStagingRoot,
  localInstanceRootDir,
  remoteInstanceRootDir,
  resolveRemoteBaseDir,
} from "../../src/instance-paths.ts";
import type { SshProfile } from "../../src/types.ts";

describe("remoteInstanceRootDir", () => {
  test("defaults to /opt/nautilo", () => {
    expect(remoteInstanceRootDir({})).toBe("/opt/nautilo");
  });

  test("strips trailing slash on remote_path", () => {
    expect(remoteInstanceRootDir({ remote_path: "/srv/x/" })).toBe("/srv/x");
  });

  test("appends instance_id suffix", () => {
    expect(remoteInstanceRootDir({ instance_id: "prod" })).toBe("/opt/nautilo-prod");
  });

  test("combines remote_path and instance_id", () => {
    expect(
      remoteInstanceRootDir({ remote_path: "/srv/x", instance_id: "prod" }),
    ).toBe("/srv/x-prod");
  });
});

describe("localInstanceRootDir", () => {
  test("default instance", () => {
    const home = resolve("home", "me");
    expect(localInstanceRootDir(home, "")).toBe(join(home, ".nautilo"));
  });

  test("suffixed instance", () => {
    const home = resolve("home", "me");
    expect(localInstanceRootDir(home, "prod")).toBe(join(home, ".nautilo-prod"));
  });
});

describe("defaultStagingRoot", () => {
  test("under local instance root", () => {
    const home = resolve("home", "me");
    expect(defaultStagingRoot({ home, instance_id: "prod" })).toBe(
      join(home, ".nautilo-prod", ".remote-staging"),
    );
  });
});

describe("resolveRemoteBaseDir", () => {
  const baseSsh: SshProfile = { host: "1.2.3.4", user: "alice", port: 22 };

  test("root user defaults to /opt/nautilo without probing", () => {
    let probed = false;
    const result = resolveRemoteBaseDir(
      { ...baseSsh, user: "root" },
      {
        runProbe: () => {
          probed = true;
          return { code: 0, stdout: "/root", stderr: "" };
        },
      },
    );
    expect(result).toBe("/opt/nautilo");
    expect(probed).toBe(false);
  });

  test("non-root user probes $HOME and appends /nautilo", () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const result = resolveRemoteBaseDir(baseSsh, {
      runProbe: (cmd, args) => {
        calls.push({ cmd, args });
        return { code: 0, stdout: "/Users/alice\n", stderr: "" };
      },
    });
    expect(result).toBe("/Users/alice/nautilo");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe("ssh");
    expect(calls[0]!.args).toContain("alice@1.2.3.4");
    expect(calls[0]!.args).toContain("pwd");
  });

  test("probe failure throws actionable error", () => {
    expect(() =>
      resolveRemoteBaseDir(baseSsh, {
        runProbe: () => ({ code: 255, stdout: "", stderr: "Permission denied" }),
      }),
    ).toThrow(/could not probe remote \$HOME/);
  });

  test("non-absolute pwd output rejected", () => {
    expect(() =>
      resolveRemoteBaseDir(baseSsh, {
        runProbe: () => ({ code: 0, stdout: "alice\n", stderr: "" }),
      }),
    ).toThrow(/non-absolute path/);
  });
});
