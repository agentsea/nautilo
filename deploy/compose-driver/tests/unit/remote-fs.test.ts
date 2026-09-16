import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { ExecFn } from "../../src/ComposeDriver.ts";
import { createRemoteFs } from "../../src/remote-fs.ts";
import type { ComposeDriverProfile } from "../../src/types.ts";

const remoteRoot = "/opt/nautilo-prod";
const profile: ComposeDriverProfile = {
  name: "remote-test",
  transport: "remote",
  lifecycle: "compose",
  from_source: true,
  ssh: {
    host: "1.2.3.4",
    user: "deploy",
    identity_file: "~/.ssh/id_ed25519",
    known_hosts_file: "~/.nautilo/known_hosts/prod",
  },
};

type RecordedCall = { cmd: string; args: string[] };

let stagingRoot: string;
let calls: RecordedCall[];
let exec: ExecFn;

afterEach(() => {
  if (stagingRoot && existsSync(stagingRoot)) {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
});

function makeFs() {
  stagingRoot = mkdtempSync(join(tmpdir(), "remote-fs-test-"));
  calls = [];
  exec = async (cmd, args) => {
    calls.push({ cmd, args });
    return { code: 0, stdout: "", stderr: "" };
  };
  return createRemoteFs(profile, {
    stagingRoot,
    remoteInstanceRoot: remoteRoot,
    exec,
  });
}

describe("createRemoteFs", () => {
  test("writeFile lands under stagingRoot with parent dirs", async () => {
    const fs = makeFs();
    const abs = join(remoteRoot, "instance.env");
    await fs.writeFile(abs, "KEY=val\n");
    const staged = join(stagingRoot, "instance.env");
    expect(existsSync(staged)).toBe(true);
    expect(await readFile(staged, "utf8")).toBe("KEY=val\n");
  });

  test("toLocalStagingPath maps remote-root paths to local staging", () => {
    const fs = makeFs();
    expect(fs.toLocalStagingPath(remoteRoot)).toBe(stagingRoot);
    expect(fs.toLocalStagingPath(join(remoteRoot, "deploy.compose.env"))).toBe(
      join(stagingRoot, "deploy.compose.env"),
    );
    expect(fs.toLocalStagingPath("/etc/foo")).toBe(join(stagingRoot, "__abs__", "etc/foo"));
  });

  test("mkdir creates staged directory", async () => {
    const fs = makeFs();
    const abs = join(remoteRoot, "data", "subdir");
    await fs.mkdir(abs, { recursive: true });
    expect(existsSync(join(stagingRoot, "data", "subdir"))).toBe(true);
  });

  test("readFile reads staged file when present", async () => {
    const fs = makeFs();
    const abs = join(remoteRoot, "cached.txt");
    const staged = join(stagingRoot, "cached.txt");
    await writeFile(staged, "cached", "utf8");
    const data = await fs.readFile(abs, "utf8");
    expect(data).toBe("cached");
    expect(calls).toHaveLength(0);
  });

  test("readFile falls back to ssh cat when not staged", async () => {
    makeFs();
    const abs = join(remoteRoot, "instance.env");
    calls.length = 0;
    exec = async (cmd, args) => {
      calls.push({ cmd, args });
      return { code: 0, stdout: "REMOTE=1\n", stderr: "" };
    };
    const fs2 = createRemoteFs(profile, {
      stagingRoot,
      remoteInstanceRoot: remoteRoot,
      exec,
    });
    const data = await fs2.readFile(abs, "utf8");
    expect(data).toBe("REMOTE=1\n");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe("ssh");
    expect(calls[0]!.args).toContain(`UserKnownHostsFile=${homedir()}/.nautilo/known_hosts/prod`);
    expect(calls[0]!.args).toContain("StrictHostKeyChecking=yes");
    expect(calls[0]!.args.at(-1)).toBe(`cat ${abs}`);
  });

  test("rm calls ssh rm -rf and does not touch staging", async () => {
    const fs = makeFs();
    const abs = join(remoteRoot, "to-delete");
    const staged = join(stagingRoot, "to-delete");
    await writeFile(staged, "x", "utf8");
    await fs.rm(abs);
    expect(existsSync(staged)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe("ssh");
    expect(calls[0]!.args.at(-1)).toBe(`rm -rf ${abs}`);
  });

  test("writeFileAtomically writes remotely then excludes the path from rsync", async () => {
    const fs = makeFs();
    const manifest = join(remoteRoot, "deployment-manifest.json");
    await fs.writeFileAtomically(manifest, '{"version":2}\n', 0o600);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe("ssh");
    const command = calls[0]!.args.at(-1)!;
    expect(command).toContain("base64 -d >");
    expect(command).toContain("chmod 600");
    expect(command).toContain(`mv -f --`);
    expect(command).toContain(manifest);
    expect(existsSync(join(stagingRoot, "deployment-manifest.json"))).toBe(false);

    await fs.syncToRemote();
    const rsync = calls[2]!.args;
    expect(rsync).toContain("--exclude");
    expect(rsync).toContain("deployment-manifest.json");
  });

  test("syncToRemote runs mkdir then rsync", async () => {
    const fs = makeFs();
    await fs.syncToRemote();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.cmd).toBe("ssh");
    expect(calls[0]!.args.at(-1)).toBe(`mkdir -p ${remoteRoot}`);
    expect(calls[1]!.cmd).toBe("rsync");
    const rsync = calls[1]!.args;
    expect(rsync[0]).toBe("-az");
    expect(rsync[1]).toBe("--no-owner");
    expect(rsync[2]).toBe("--no-group");
    expect(rsync[3]).toBe("--delete");
    expect(rsync[4]).toBe("-e");
    expect(rsync[5]).toBe(
      `ssh -p 22 -o BatchMode=yes -o UserKnownHostsFile=${homedir()}/.nautilo/known_hosts/prod -o StrictHostKeyChecking=yes -i ${homedir()}/.ssh/id_ed25519`,
    );
    expect(rsync[6]).toBe(stagingRoot.replace(/\/$/, "") + "/");
    expect(rsync[7]).toBe(`deploy@1.2.3.4:${remoteRoot}/`);
  });
});
