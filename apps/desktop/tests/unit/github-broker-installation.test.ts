import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitHubInstallation, githubInstallationPathModeAllowed } from "../../electron/github-broker/installation";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "github-installation-")));
  const bin = join(root, "runtime", "gh");
  const home = join(root, "home");
  await mkdir(join(root, "runtime"), { mode: 0o700 });
  await mkdir(home, { mode: 0o700 });
  const bytes = "fake trusted executable, never executed";
  await writeFile(bin, bytes, { mode: 0o700 });
  let current = true;
  let roots: string[] = [];
  const make = () => createGitHubInstallation({ executable: bin, homeDir: home,
    executableSha256: createHash("sha256").update(bytes).digest("hex"),
    authority: async () => ({ writableRoots: roots, isCurrent: () => current }),
  });
  return { root, bin, home, bytes, make, setRoots: (next: string[]) => { roots = next; },
    revoke: () => { current = false; }, cleanup: () => rm(root, { recursive: true, force: true }) };
}
async function fails(work: Promise<unknown>) {
  expect(await work.then(() => null, error => error instanceof Error ? error.message : "unexpected")).toBe("GITHUB_INSTALLATION_UNAVAILABLE");
}

describe("GitHub installation custody", () => {
  test("accepts the exact macOS admin-owned Applications parent, not arbitrary writable parents", () => {
    const normal = { uid: 0, gid: 80, mode: 0o40775, directory: true };
    expect(githubInstallationPathModeAllowed("/Applications", normal, 501)).toBe(true);
    for (const [path, info] of [
      ["/untrusted", normal], ["/Applications", { ...normal, uid: 502 }],
      ["/Applications", { ...normal, gid: 20 }], ["/Applications", { ...normal, mode: 0o40777 }],
      ["/Applications", { ...normal, directory: false }],
    ] as const) expect(githubInstallationPathModeAllowed(path, info, 501)).toBe(false);
  });
  test("allows a missing default config for first sign-in with a closed environment", async () => {
    const f = await fixture();
    try {
      const installation = f.make();
      const invocation = await installation.verify();
      expect(invocation.executable).toBe(f.bin);
      expect(invocation.env.GH_CONFIG_DIR).toBe(join(f.home, ".config", "gh"));
      expect(invocation.env).not.toHaveProperty("GH_TOKEN");
      expect(invocation.env).not.toHaveProperty("GITHUB_TOKEN");
      expect(invocation.isCurrent()).toBe(true);
      await mkdir(join(f.home, ".config", "gh"), { recursive: true, mode: 0o700 });
      await writeFile(join(f.home, ".config", "gh", "hosts.yml"), "synthetic config", { mode: 0o600 });
      expect((await installation.verify()).isCurrent()).toBe(true);
      installation.retire();
      expect(invocation.isCurrent()).toBe(false);
      await fails(installation.verify());
    } finally { await f.cleanup(); }
  });
  test("replacement by identical bytes cannot repin an admitted inode", async () => {
    const f = await fixture();
    try {
      const installation = f.make();
      await installation.verify();
      await writeFile(`${f.bin}.new`, f.bytes, { mode: 0o700 });
      await rename(`${f.bin}.new`, f.bin);
      await fails(installation.verify());
      await fails(installation.verify());
    } finally { await f.cleanup(); }
  });
  test("rejects content changes and hard-linked executables", async () => {
    for (const attack of ["bytes", "link"] as const) {
      const f = await fixture();
      try {
        const installation = f.make();
        if (attack === "bytes") await writeFile(f.bin, "changed");
        else await link(f.bin, `${f.bin}.alias`);
        await fails(installation.verify());
      } finally { await f.cleanup(); }
    }
  });
  test("rejects both canonical and symlink writable ancestors", async () => {
    for (const alias of [false, true]) {
      const f = await fixture();
      try {
        if (alias) await symlink(join(f.root, "runtime"), join(f.root, "writable-alias"));
        f.setRoots([join(f.root, alias ? "writable-alias" : "runtime")]);
        await fails(f.make().verify());
      } finally { await f.cleanup(); }
    }
  });
  test("rejects config symlinks, hard links, writable ancestors and unsafe permissions", async () => {
    for (const attack of ["symlink", "hardlink", "grant", "permissions"] as const) {
      const f = await fixture();
      try {
        const config = join(f.home, ".config", "gh");
        await mkdir(config, { recursive: true, mode: 0o700 });
        const hosts = join(config, "hosts.yml");
        await writeFile(hosts, "synthetic", { mode: 0o600 });
        if (attack === "symlink") {
          await rename(config, `${config}-target`);
          await symlink(`${config}-target`, config);
        } else if (attack === "hardlink") await link(hosts, join(f.root, "alias"));
        else if (attack === "grant") f.setRoots([join(f.home, ".config")]);
        else await chmod(config, 0o777);
        await fails(f.make().verify());
      } finally { await f.cleanup(); }
    }
  });
  test("authority revocation invalidates an already verified invocation", async () => {
    const f = await fixture();
    try {
      const installation = f.make();
      const invocation = await installation.verify();
      f.revoke();
      expect(invocation.isCurrent()).toBe(false);
      await fails(installation.verify());
    } finally { await f.cleanup(); }
  });
});

test("unsafe authority can be reduced without silently repinning the runtime", async () => {
  const f = await fixture();
  try {
    const installation = f.make();
    await installation.verify();
    f.setRoots([join(f.root, "runtime")]);
    await fails(installation.verify());
    f.setRoots([]);
    expect((await installation.verify()).executable).toBe(f.bin);
    await writeFile(`${f.bin}.new`, f.bytes, { mode: 0o700 });
    await rename(`${f.bin}.new`, f.bin);
    await fails(installation.verify());
  } finally { await f.cleanup(); }
});

test("ordinary Development tool-install roots do not overlap the bundled runtime", async () => {
  const f = await fixture();
  try {
    const homebrew = join(f.root, "homebrew");
    await mkdir(homebrew, { mode: 0o700 });
    f.setRoots([homebrew, join(f.root, "not-yet-created-install-root")]);
    expect((await f.make().verify()).executable).toBe(f.bin);
  } finally { await f.cleanup(); }
});

test("config permission repair preserves the same immutable executable pin", async () => {
  const f = await fixture();
  try {
    const installation = f.make(); await installation.verify();
    const config = join(f.home, ".config", "gh");
    await mkdir(config, { recursive: true, mode: 0o700 });
    await chmod(config, 0o777);
    await fails(installation.verify());
    await chmod(config, 0o700);
    expect((await installation.verify()).executable).toBe(f.bin);
  } finally { await f.cleanup(); }
});
