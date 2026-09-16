import { describe, expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildSshHostKeyArgs,
  buildSshArgs,
  createRemoteExec,
  expandTilde,
  shellQuote,
  runLocal,
} from "../../src/remote-exec.ts";
import type { ComposeDriverProfile } from "../../src/types.ts";

const remoteProfile: ComposeDriverProfile = {
  name: "do-droplet",
  transport: "remote",
  lifecycle: "compose",
  from_source: true,
  ssh: { host: "1.2.3.4", user: "root" },
};

describe("shellQuote", () => {
  test("empty string becomes quoted empty", () => {
    expect(shellQuote("")).toBe("''");
  });

  test("safe chars pass through unchanged", () => {
    expect(shellQuote("abc_-.:/=@%+")).toBe("abc_-.:/=@%+");
  });

  test("spaces get quoted", () => {
    expect(shellQuote("a b")).toBe("'a b'");
  });

  test("single quotes are escaped", () => {
    expect(shellQuote("foo'bar")).toBe("'foo'\\''bar'");
  });

  test("dollar and semicolon get quoted", () => {
    expect(shellQuote("$")).toBe("'$'");
    expect(shellQuote(";")).toBe("';'");
  });

  test("&& gets quoted", () => {
    expect(shellQuote("&&")).toBe("'&&'");
  });

  test("round-trip form for foo", () => {
    expect(shellQuote("foo")).toBe("foo");
    expect(shellQuote("'foo'")).toBe("''\\''foo'\\'''");
  });
});

test("real child receives exact private input without placing it in argv or inherited output", async () => {
  const secret = "synthetic-restore-secret-'$()\nsecond-line";
  const script = `const input = await Bun.stdin.text(); console.log(JSON.stringify({
    digest: new Bun.CryptoHasher("sha256").update(input).digest("hex"), argv: process.argv
  }));`;
  const args = ["-e", script];
  const result = await runLocal(process.execPath, args, { stdin: secret, stdio: "inherit" });
  expect(result.code).toBe(0);
  const observed = JSON.parse(result.stdout) as { digest: string; argv: string[] };
  expect(observed.digest).toBe(createHash("sha256").update(secret).digest("hex"));
  expect(result.stdout).not.toContain(secret);
  expect(result.stderr).toBe("");
  expect(args.join(" ")).not.toContain(secret);
  expect(buildSshArgs(remoteProfile.ssh!, process.execPath, args).join(" ")).not.toContain(secret);
});

test("a signal-terminated private-input process cannot report success", async () => {
  const result = await runLocal(process.execPath, ["-e", 'await Bun.stdin.text(); process.kill(process.pid, "SIGTERM");'], {
    stdin: "synthetic-private-input", stdio: "pipe",
  });
  expect(result.code).not.toBe(0);
  expect(result.stdout).toBe("");
});

test("SSH execution forwards private stdin while its real child argv contains only the remote command", async () => {
  const root = mkdtempSync(join(tmpdir(), "restore-private-stdin-"));
  const secret = "synthetic-ssh-restore-secret-'$()\n";
  try {
    writeFileSync(join(root, "ssh"), `#!${process.execPath}\nconst input = await Bun.stdin.text();
console.log(JSON.stringify({ digest: new Bun.CryptoHasher("sha256").update(input).digest("hex"), argv: process.argv }));\n`, { mode: 0o700 });
    const exec = createRemoteExec(remoteProfile);
    const result = await exec("sh", ["-c", "psql -X -v ON_ERROR_STOP=1 -f -"], {
      stdio: "pipe", stdin: secret, env: { ...process.env, PATH: `${root}:${process.env["PATH"] ?? ""}`, DOCKER_HOST: "" },
    });
    expect(result.code).toBe(0);
    const observed = JSON.parse(result.stdout) as { digest: string; argv: string[] };
    expect(observed.digest).toBe(createHash("sha256").update(secret).digest("hex"));
    expect(observed.argv.join(" ")).toContain("psql -X -v ON_ERROR_STOP=1 -f -");
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).toBe("");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

describe("expandTilde", () => {
  test("~/foo expands to homedir/foo", () => {
    expect(expandTilde("~/foo")).toBe(homedir() + "/foo");
  });
});

describe("buildSshArgs", () => {
  test("builds argv for docker compose ps with filter", () => {
    expect(
      buildSshArgs(remoteProfile.ssh!, "docker", [
        "compose",
        "ps",
        "--filter",
        "status=running",
      ]),
    ).toEqual([
      "-p",
      "22",
      "-o",
      "BatchMode=yes",
      "-o",
      "ServerAliveInterval=30",
      "root@1.2.3.4",
      "--",
      "docker compose ps --filter status=running",
    ]);
  });

  test("identity_file ~/foo expands in -i", () => {
    const args = buildSshArgs(
      { host: "h", user: "u", identity_file: "~/foo" },
      "echo",
      ["hi"],
    );
    expect(args).toContain("-i");
    expect(args[args.indexOf("-i") + 1]).toBe(homedir() + "/foo");
  });

  test("known_hosts_file enables strict host-key checking", () => {
    const args = buildSshArgs(
      {
        host: "h",
        user: "u",
        known_hosts_file: "~/.nautilo/known_hosts/prod",
      },
      "echo",
      ["hi"],
    );
    expect(args).toContain(`UserKnownHostsFile=${homedir()}/.nautilo/known_hosts/prod`);
    expect(args).toContain("StrictHostKeyChecking=yes");
  });

  test("profiles without known_hosts_file retain no explicit host-key flags", () => {
    expect(buildSshHostKeyArgs({ host: "h", user: "u" })).toEqual([]);
  });
});

describe("createRemoteExec", () => {
  test("throws when transport is not remote", () => {
    expect(() =>
      createRemoteExec({ name: "x", transport: "local", lifecycle: "compose" }),
    ).toThrow(/createRemoteExec requires transport="remote"/);
  });

  test("throws when ssh block is missing", () => {
    expect(() =>
      createRemoteExec({ name: "x", transport: "remote", lifecycle: "compose" }),
    ).toThrow(/createRemoteExec requires transport="remote"/);
  });
});
