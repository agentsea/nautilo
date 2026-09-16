import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createServerDirectBrowserDirectoryAuthority,
  ServerDirectBrowserDirectoryAuthorityError,
} from "../../src/connected-web-accounts/direct-browser-directory-authority";
import { directBrowserHarnessSession } from "../../src/connected-web-accounts/direct-browser-router";
import { directBrowserPrivateRoot } from "../../src/connected-web-accounts/operation-direct-production";

const cleanup: string[] = [];
const uid = process.getuid?.();
if (uid === undefined) throw new Error("directory authority tests require a POSIX uid");

async function tempRoot(prefix = "d-"): Promise<string> {
  const root = await mkdtemp(join(await realpath("/tmp"), prefix));
  cleanup.push(root);
  return root;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

afterEach(async () => {
  while (cleanup.length > 0) {
    await rm(cleanup.pop()!, { recursive: true, force: true });
  }
});

const allocation = {
  ownerUserId: "owner-private",
  accountId: "account-private",
  operationId: "operation-private",
  controlEpoch: 5,
  harnessSession: `direct-5-${"a".repeat(32)}`,
};

describe("D568 direct browser directory authority", () => {
  test("keeps the production macOS router socket path within sockaddr_un", () => {
    const rootDirectory = directBrowserPrivateRoot("isolated-test-clone", "darwin");
    const harnessSession = directBrowserHarnessSession({
      operationId: "operation-with-a-realistically-long-opaque-identifier",
      accountId: "account-with-a-realistically-long-opaque-identifier",
      controlEpoch: Number.MAX_SAFE_INTEGER,
    });
    const socketPath = join(
      rootDirectory,
      `o-${"a".repeat(24)}`,
      "s",
      `${harnessSession}.sock`,
    );

    expect(harnessSession).toMatch(/^d-[a-f0-9]{32}$/);
    expect(Buffer.byteLength(socketPath, "utf8")).toBeLessThanOrEqual(103);
  });

  test("derives recoverable private directories from every authority axis within the Unix socket budget", async () => {
    const rootDirectory = await tempRoot();
    const options = { rootDirectory, instanceIdentity: "instance-private", expectedUid: uid };
    const firstAuthority = createServerDirectBrowserDirectoryAuthority(options);
    const first = await firstAuthority.allocate(allocation);
    const recovered = await createServerDirectBrowserDirectoryAuthority(options).allocate(allocation);

    expect(recovered).toEqual(first);
    expect(Buffer.byteLength(join(first.socketDirectory, `${allocation.harnessSession}.sock`), "utf8")).toBeLessThanOrEqual(103);
    expect(JSON.stringify(first)).not.toContain(allocation.ownerUserId);
    expect(JSON.stringify(first)).not.toContain(allocation.accountId);
    expect(JSON.stringify(first)).not.toContain(allocation.operationId);

    const operationRoot = dirname(first.socketDirectory);
    for (const directory of [rootDirectory, operationRoot, first.socketDirectory, first.homeDirectory]) {
      const info = await lstat(directory);
      expect(info.isDirectory()).toBe(true);
      expect(info.isSymbolicLink()).toBe(false);
      expect(info.mode & 0o777).toBe(0o700);
      expect(info.uid).toBe(uid);
    }

    const variants = [
      { ...allocation, accountId: "account-other" },
      { ...allocation, operationId: "operation-other" },
      { ...allocation, controlEpoch: 6 },
      { ...allocation, harnessSession: `direct-5-${"b".repeat(32)}` },
    ];
    for (const variant of variants) {
      expect((await firstAuthority.allocate(variant)).socketDirectory).not.toBe(first.socketDirectory);
    }
    const otherInstance = createServerDirectBrowserDirectoryAuthority({
      ...options,
      instanceIdentity: "instance-other",
    });
    expect((await otherInstance.allocate(allocation)).socketDirectory).not.toBe(first.socketDirectory);
  });

  test("releases the exact derived root across authority reconstruction and remains idempotent", async () => {
    const rootDirectory = await tempRoot();
    const options = { rootDirectory, instanceIdentity: "instance-private", expectedUid: uid };
    const directories = await createServerDirectBrowserDirectoryAuthority(options).allocate(allocation);
    const operationRoot = dirname(directories.socketDirectory);
    const recoveredAuthority = createServerDirectBrowserDirectoryAuthority(options);

    await recoveredAuthority.release(directories);
    expect(await lstat(operationRoot).catch(() => null)).toBeNull();
    await recoveredAuthority.release(directories);
  });

  test("rejects release outside its root, mismatched pairs, permissive directories, and symlinks", async () => {
    const rootDirectory = await tempRoot();
    const authority = createServerDirectBrowserDirectoryAuthority({
      rootDirectory,
      instanceIdentity: "instance-private",
      expectedUid: uid,
    });
    const directories = await authority.allocate(allocation);
    const outside = await tempRoot("x-");
    const fakeRoot = join(outside, `o-${"f".repeat(24)}`);
    await mkdir(join(fakeRoot, "s"), { recursive: true, mode: 0o700 });
    await mkdir(join(fakeRoot, "h"), { mode: 0o700 });

    expect(await rejection(authority.release({
      socketDirectory: join(fakeRoot, "s"),
      homeDirectory: join(fakeRoot, "h"),
    }))).toBeInstanceOf(ServerDirectBrowserDirectoryAuthorityError);
    expect((await lstat(fakeRoot)).isDirectory()).toBe(true);

    expect(await rejection(authority.release({
      socketDirectory: directories.socketDirectory,
      homeDirectory: join(fakeRoot, "h"),
    }))).toBeInstanceOf(ServerDirectBrowserDirectoryAuthorityError);

    await chmod(directories.homeDirectory, 0o755);
    expect(await rejection(authority.release(directories))).toBeInstanceOf(ServerDirectBrowserDirectoryAuthorityError);
    await chmod(directories.homeDirectory, 0o700);

    await rm(directories.socketDirectory, { recursive: true });
    await symlink(outside, directories.socketDirectory);
    expect(await rejection(authority.release(directories))).toBeInstanceOf(ServerDirectBrowserDirectoryAuthorityError);
    expect((await lstat(outside)).isDirectory()).toBe(true);
  });

  test("fails closed for a symlink root and for a root that cannot fit session.sock", async () => {
    const parent = await tempRoot();
    const actualRoot = join(parent, "actual");
    const linkedRoot = join(parent, "linked");
    await mkdir(actualRoot, { mode: 0o700 });
    await symlink(actualRoot, linkedRoot);
    const linkedAuthority = createServerDirectBrowserDirectoryAuthority({
      rootDirectory: linkedRoot,
      instanceIdentity: "instance-private",
      expectedUid: uid,
    });
    expect(await rejection(linkedAuthority.allocate(allocation))).toBeInstanceOf(ServerDirectBrowserDirectoryAuthorityError);

    const longRoot = join(parent, "x".repeat(60));
    await mkdir(longRoot, { mode: 0o700 });
    const longAuthority = createServerDirectBrowserDirectoryAuthority({
      rootDirectory: longRoot,
      instanceIdentity: "instance-private",
      expectedUid: uid,
    });
    expect(await rejection(longAuthority.allocate(allocation))).toMatchObject({ code: "socket_path_too_long" });
  });
});

test("recovery finds older exact epochs after cleanup rotations without touching another owner or allocating empty generations", async () => {
  const rootDirectory = await tempRoot();
  const authority = createServerDirectBrowserDirectoryAuthority({ rootDirectory, instanceIdentity: "instance", expectedUid: uid });
  const original = { ...allocation, controlEpoch: 3 };
  const old = await authority.allocate({ ...original, harnessSession: directBrowserHarnessSession(original) });
  const foreign = await authority.allocate({ ...original, ownerUserId: "another-owner", harnessSession: directBrowserHarnessSession(original) });
  const found = [];
  for await (const directories of authority.forRecovery!({ ...original, controlEpoch: 5 })) found.push(directories);
  expect(found).toEqual([old]);
  expect(await readdir(rootDirectory)).toHaveLength(2);
  await authority.release(old);
  expect(await lstat(foreign.socketDirectory).then((info) => info.isDirectory())).toBe(true);
  const empty = [];
  for await (const directories of authority.forRecovery!({ ...original, controlEpoch: 5 })) empty.push(directories);
  expect(empty).toEqual([]);
  expect(await readdir(rootDirectory)).toHaveLength(1);
});
