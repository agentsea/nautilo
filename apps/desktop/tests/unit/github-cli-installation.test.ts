import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createGitHubCliInstallation,
  githubCliInstallationPathModeAllowed,
} from "../../electron/github-cli-installation";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "github-installation-")));
  const bin = join(root, "runtime", "gh");
  await mkdir(dirname(bin), { mode: 0o700 });
  const bytes = "fake trusted executable, never executed";
  await writeFile(bin, bytes, { mode: 0o700 });
  let current = true;
  const environment = {
    HOME: join(root, "home"),
    PATH: `/native/bin:${dirname(bin)}`,
    GH_CONFIG_DIR: join(root, "custom-gh"),
    GH_HOST: "enterprise.example",
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    SSH_AUTH_SOCK: join(root, "agent.sock"),
  };
  const make = () => createGitHubCliInstallation({
    executable: bin,
    executableSha256: createHash("sha256").update(bytes).digest("hex"),
    environment,
    isCurrent: () => current,
  });
  return {
    root,
    bin,
    bytes,
    environment,
    make,
    revoke: () => { current = false; },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function fails(work: Promise<unknown>) {
  expect(await work.then(
    () => null,
    error => error instanceof Error ? error.message : "unexpected",
  )).toBe("GITHUB_INSTALLATION_UNAVAILABLE");
}

// A verified installation requires POSIX ownership and mode checks; Windows
// refuses GitHub CLI custody before verification.
const posixInstallationTest = process.platform === "win32" ? test.skip : test;

describe("GitHub CLI installation", () => {
  test("accepts the exact macOS admin-owned Applications parent", () => {
    const normal = { uid: 0, gid: 80, mode: 0o40775, directory: true };
    expect(githubCliInstallationPathModeAllowed("/Applications", normal, 501)).toBe(true);
    for (const [path, info] of [
      ["/untrusted", normal],
      ["/Applications", { ...normal, uid: 502 }],
      ["/Applications", { ...normal, gid: 20 }],
      ["/Applications", { ...normal, mode: 0o40777 }],
      ["/Applications", { ...normal, directory: false }],
    ] as const) {
      expect(githubCliInstallationPathModeAllowed(path, info, 501)).toBe(false);
    }
  });

  posixInstallationTest("preserves the trusted native environment without inspecting GitHub config", async () => {
    const f = await fixture();
    try {
      await mkdir(f.environment.GH_CONFIG_DIR, { recursive: true, mode: 0o777 });
      const installation = f.make();
      const invocation = await installation.verify();
      expect(invocation.executable).toBe(f.bin);
      expect(invocation.executableDirectory).toBe(dirname(f.bin));
      expect(invocation.env).toEqual(f.environment);
      expect(invocation.env).not.toBe(f.environment);
      expect(invocation.isCurrent()).toBe(true);
      installation.retire();
      expect(invocation.isCurrent()).toBe(false);
      await fails(installation.verify());
    } finally {
      await f.cleanup();
    }
  });

  posixInstallationTest("replacement by identical bytes cannot repin an admitted inode", async () => {
    const f = await fixture();
    try {
      const installation = f.make();
      await installation.verify();
      await writeFile(`${f.bin}.new`, f.bytes, { mode: 0o700 });
      await rename(`${f.bin}.new`, f.bin);
      await fails(installation.verify());
      await fails(installation.verify());
    } finally {
      await f.cleanup();
    }
  });

  test("rejects content changes and hard-linked executables", async () => {
    for (const attack of ["bytes", "link"] as const) {
      const f = await fixture();
      try {
        const installation = f.make();
        if (attack === "bytes") await writeFile(f.bin, "changed");
        else await link(f.bin, `${f.bin}.alias`);
        await fails(installation.verify());
      } finally {
        await f.cleanup();
      }
    }
  });

  posixInstallationTest("authority revocation invalidates an already verified invocation", async () => {
    const f = await fixture();
    try {
      const installation = f.make();
      const invocation = await installation.verify();
      f.revoke();
      expect(invocation.isCurrent()).toBe(false);
      await fails(installation.verify());
    } finally {
      await f.cleanup();
    }
  });
});
