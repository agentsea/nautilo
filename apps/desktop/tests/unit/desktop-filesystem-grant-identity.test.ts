import { describe, expect, test } from "bun:test";

import {
  captureDesktopFilesystemGrantRootIdentity,
  revalidateDesktopFilesystemGrantRootIdentity,
  type DesktopFilesystemGrantFilesystem,
  type DesktopFilesystemGrantRootStat,
} from "../../electron/desktop-filesystem-grants/identity";

function stat(
  options: { directory?: boolean; symlink?: boolean; device?: number; inode?: number } = {},
): DesktopFilesystemGrantRootStat {
  return {
    isDirectory: () => options.directory ?? true,
    isSymbolicLink: () => options.symlink ?? false,
    ...(options.device === undefined ? {} : { dev: options.device }),
    ...(options.inode === undefined ? {} : { ino: options.inode }),
  };
}

function filesystem(
  entries: Record<string, { lstat?: DesktopFilesystemGrantRootStat; stat?: DesktopFilesystemGrantRootStat; realpath?: string }>,
): DesktopFilesystemGrantFilesystem {
  const entry = (root: string) => {
    const value = entries[root];
    if (!value) throw new Error(`ENOENT: ${root}`);
    return value;
  };
  return {
    async lstat(root) {
      const value = entry(root).lstat;
      if (!value) throw new Error(`ENOENT: ${root}`);
      return value;
    },
    async stat(root) {
      const value = entry(root).stat;
      if (!value) throw new Error(`ENOENT: ${root}`);
      return value;
    },
    async realpath(root) {
      const value = entry(root).realpath;
      if (!value) throw new Error(`ENOENT: ${root}`);
      return value;
    },
  };
}

function expectRejected(
  result: Awaited<ReturnType<typeof captureDesktopFilesystemGrantRootIdentity>>,
  code: string,
) {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe(code);
}

describe("Desktop Filesystem Grant filesystem identity", () => {
  test("captures an existing direct directory and canonicalizes /var through realpath", async () => {
    const fs = filesystem({
      "/var/approved": {
        lstat: stat({ device: 10, inode: 20 }),
        stat: stat({ device: 10, inode: 20 }),
        realpath: "/private/var/approved",
      },
      "/private/var/approved": { stat: stat({ device: 10, inode: 20 }) },
    });

    const result = await captureDesktopFilesystemGrantRootIdentity("/var/approved", fs);

    expect(result).toEqual({
      ok: true,
      canonicalRoot: "/private/var/approved",
      filesystemIdentity: { realRoot: "/private/var/approved", device: 10, inode: 20 },
    });
  });

  test("rejects relative, missing, direct symlink, and non-directory selections", async () => {
    expectRejected(await captureDesktopFilesystemGrantRootIdentity("relative", filesystem({})), "invalid_root");
    expectRejected(await captureDesktopFilesystemGrantRootIdentity("/missing", filesystem({})), "root_missing");
    expectRejected(
      await captureDesktopFilesystemGrantRootIdentity(
        "/link",
        filesystem({ "/link": { lstat: stat({ symlink: true, directory: false }) } }),
      ),
      "root_symlink",
    );
    expectRejected(
      await captureDesktopFilesystemGrantRootIdentity(
        "/file",
        filesystem({ "/file": { lstat: stat({ directory: false }) } }),
      ),
      "root_not_directory",
    );
  });

  test("rejects lstat/stat replacement while capturing", async () => {
    const fs = filesystem({
      "/approved": {
        lstat: stat({ device: 10, inode: 20 }),
        stat: stat({ device: 10, inode: 21 }),
        realpath: "/approved",
      },
    });

    expectRejected(await captureDesktopFilesystemGrantRootIdentity("/approved", fs), "root_identity_changed");
  });

  test("revalidates the saved canonical root and detects device/inode changes", async () => {
    const saved = { realRoot: "/private/var/approved", device: 10, inode: 20 };
    const unchanged = filesystem({
      "/private/var/approved": {
        lstat: stat({ device: 10, inode: 20 }),
        stat: stat({ device: 10, inode: 20 }),
        realpath: "/private/var/approved",
      },
    });
    const changed = filesystem({
      "/private/var/approved": {
        lstat: stat({ device: 10, inode: 21 }),
        stat: stat({ device: 10, inode: 21 }),
        realpath: "/private/var/approved",
      },
    });

    expect((await revalidateDesktopFilesystemGrantRootIdentity(saved, unchanged)).ok).toBe(true);
    const result = await revalidateDesktopFilesystemGrantRootIdentity(saved, changed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("root_identity_changed");
  });
});
