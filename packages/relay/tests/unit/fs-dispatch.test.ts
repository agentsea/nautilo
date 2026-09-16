import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RELAY_FS_MAX_BYTES } from "../../src/constants";
import { handleFsDispatch } from "../../src/fs-dispatch";
import type {
  RelayDispatchRequest,
  RelayFsRequest,
  RelayFsResult,
} from "../../src/protocol";
import { createWorkspaceGuard } from "../../src/workspace-guard";

function makeRoot(): string {
  return join(
    tmpdir(),
    `fs-dispatch-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

function fsDispatch(
  guard: ReturnType<typeof createWorkspaceGuard>,
  fsReq: RelayFsRequest,
  impact: "read-only" | "destructive" = "read-only",
): Promise<{ status: string; result?: unknown }> {
  const req: RelayDispatchRequest = {
    correlationId: "test",
    toolName: "fs",
    executionClass: "fs",
    impact,
    approvalObtained: true,
    allowedRoots: [...guard.roots],
    args: fsReq as unknown as Record<string, unknown>,
  };
  return handleFsDispatch(req, guard);
}

function resultOf(
  res: { status: string; result?: unknown },
): RelayFsResult {
  expect(res.status).toBe("ok");
  return res.result as RelayFsResult;
}

describe("handleFsDispatch", () => {
  let tempDir: string;
  let guard: ReturnType<typeof createWorkspaceGuard>;

  beforeEach(async () => {
    tempDir = makeRoot();
    await fsp.mkdir(tempDir, { recursive: true });
    guard = createWorkspaceGuard({ workspaceRoot: tempDir });
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  test("readFile round-trips content", async () => {
    const filePath = join(tempDir, "hello.txt");
    const content = "hello relay fs";
    await fsp.writeFile(filePath, content);

    const res = await fsDispatch(guard, {
      op: "readFile",
      path: filePath,
      allowedRoots: [tempDir],
    });
    const result = resultOf(res);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Buffer.from(result.dataBase64 ?? "", "base64").toString()).toBe(
        content,
      );
    }
  });

  test("writeFileAtomic creates file atomically", async () => {
    const filePath = join(tempDir, "atomic.txt");
    const content = "atomic write";
    const dataBase64 = Buffer.from(content).toString("base64");

    const res = await fsDispatch(
      guard,
      {
        op: "writeFileAtomic",
        path: filePath,
        dataBase64,
        allowedRoots: [tempDir],
      },
      "destructive",
    );
    const result = resultOf(res);
    expect(result.ok).toBe(true);
    expect(await fsp.readFile(filePath, "utf8")).toBe(content);
  });

  test("readdir without withFileTypes returns names", async () => {
    await fsp.writeFile(join(tempDir, "a.txt"), "a");
    await fsp.writeFile(join(tempDir, "b.txt"), "b");

    const res = await fsDispatch(guard, {
      op: "readdir",
      path: tempDir,
      allowedRoots: [tempDir],
    });
    const result = resultOf(res);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const names = (result.entries ?? []).map((e) => e.name).sort();
      expect(names).toEqual(["a.txt", "b.txt"]);
      for (const entry of result.entries ?? []) {
        expect(entry.dir).toBe(false);
        expect(entry.file).toBe(false);
        expect(entry.symlink).toBe(false);
      }
    }
  });

  test("readdir with withFileTypes classifies entries", async () => {
    await fsp.writeFile(join(tempDir, "file.txt"), "x");
    await fsp.mkdir(join(tempDir, "subdir"));

    const res = await fsDispatch(guard, {
      op: "readdir",
      path: tempDir,
      opts: { withFileTypes: true },
      allowedRoots: [tempDir],
    });
    const result = resultOf(res);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const file = (result.entries ?? []).find((e) => e.name === "file.txt");
      const dir = (result.entries ?? []).find((e) => e.name === "subdir");
      expect(file?.file).toBe(true);
      expect(file?.dir).toBe(false);
      expect(dir?.dir).toBe(true);
      expect(dir?.file).toBe(false);
    }
  });

  test("readdir applies a typed bounded maxEntries response", async () => {
    await Promise.all([
      fsp.writeFile(join(tempDir, "c.txt"), "c"),
      fsp.writeFile(join(tempDir, "a.txt"), "a"),
      fsp.writeFile(join(tempDir, "b.txt"), "b"),
    ]);

    const first = await fsDispatch(guard, {
      op: "readdir",
      path: tempDir,
      opts: { withFileTypes: true, maxEntries: 2 },
      allowedRoots: [tempDir],
    });
    const firstResult = resultOf(first);
    expect(firstResult.ok).toBe(true);
    if (firstResult.ok) {
      expect(firstResult.entries?.map((entry) => entry.name)).toEqual(["a.txt", "b.txt"]);
      expect(firstResult.truncated).toBe(true);
    }
    const afterName = firstResult.ok ? firstResult.entries?.at(-1)?.name : undefined;
    expect(afterName).toBe("b.txt");
    const second = await fsDispatch(guard, {
      op: "readdir",
      path: tempDir,
      opts: { withFileTypes: true, maxEntries: 2, afterName },
      allowedRoots: [tempDir],
    });
    const secondResult = resultOf(second);
    expect(secondResult.ok).toBe(true);
    if (firstResult.ok && secondResult.ok) {
      expect(secondResult.truncated).toBeUndefined();
      expect([
        ...(firstResult.entries ?? []),
        ...(secondResult.entries ?? []),
      ].map((entry) => entry.name).sort()).toEqual(["a.txt", "b.txt", "c.txt"]);
    }
  });

  test("readdir filters hidden entries and searches before applying the page bound", async () => {
    await Promise.all([
      fsp.writeFile(join(tempDir, ".secret.txt"), "secret"),
      fsp.writeFile(join(tempDir, "notes-alpha.md"), "a"),
      fsp.writeFile(join(tempDir, "notes-beta.md"), "b"),
      fsp.writeFile(join(tempDir, "other.md"), "other"),
    ]);

    const hiddenOff = resultOf(await fsDispatch(guard, {
      op: "readdir",
      path: tempDir,
      opts: { withFileTypes: true, maxEntries: 10, includeHidden: false },
      allowedRoots: [tempDir],
    }));
    expect(hiddenOff.ok && hiddenOff.entries?.some((entry) => entry.name === ".secret.txt")).toBe(false);

    const searched = resultOf(await fsDispatch(guard, {
      op: "readdir",
      path: tempDir,
      opts: { withFileTypes: true, maxEntries: 1, includeHidden: true, nameQuery: "NOTES" },
      allowedRoots: [tempDir],
    }));
    expect(searched.ok && searched.entries?.map((entry) => entry.name)).toEqual(["notes-alpha.md"]);
    expect(searched.ok && searched.truncated).toBe(true);
  });

  test("readdir rejects an invalid maxEntries rather than falling back to an unbounded list", async () => {
    const res = await fsDispatch(guard, {
      op: "readdir",
      path: tempDir,
      opts: { maxEntries: 0 },
      allowedRoots: [tempDir],
    });
    const result = resultOf(res);
    expect(result).toMatchObject({ ok: false, code: "EINVAL" });
  });

  test("readdir rejects an invalid page cursor", async () => {
    const res = await fsDispatch(guard, {
      op: "readdir",
      path: tempDir,
      opts: { maxEntries: 10, afterName: "" },
      allowedRoots: [tempDir],
    });
    expect(resultOf(res)).toMatchObject({ ok: false, code: "EINVAL" });
  });

  test("stat returns file metadata", async () => {
    const filePath = join(tempDir, "stat-me.txt");
    const content = "12345";
    await fsp.writeFile(filePath, content);

    const res = await fsDispatch(guard, {
      op: "stat",
      path: filePath,
      allowedRoots: [tempDir],
    });
    const result = resultOf(res);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stat?.size).toBe(content.length);
      expect(result.stat?.isFile).toBe(true);
      expect(result.stat?.isDirectory).toBe(false);
    }
  });

  test("lstat works on a file", async () => {
    const filePath = join(tempDir, "lstat-me.txt");
    await fsp.writeFile(filePath, "x");

    const res = await fsDispatch(guard, {
      op: "lstat",
      path: filePath,
      allowedRoots: [tempDir],
    });
    const result = resultOf(res);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stat?.isFile).toBe(true);
    }
  });

  test("mkdir recursive creates nested dirs", async () => {
    const nested = join(tempDir, "a", "b", "c");

    const res = await fsDispatch(
      guard,
      {
        op: "mkdir",
        path: nested,
        opts: { recursive: true },
        allowedRoots: [tempDir],
      },
      "destructive",
    );
    const result = resultOf(res);
    expect(result.ok).toBe(true);
    const st = await fsp.stat(nested);
    expect(st.isDirectory()).toBe(true);
  });

  test("rename moves a file", async () => {
    const src = join(tempDir, "old.txt");
    const dest = join(tempDir, "new.txt");
    await fsp.writeFile(src, "move me");

    const res = await fsDispatch(
      guard,
      {
        op: "rename",
        path: src,
        destPath: dest,
        allowedRoots: [tempDir],
      },
      "destructive",
    );
    const result = resultOf(res);
    expect(result.ok).toBe(true);
    expect(await fsp.readFile(dest, "utf8")).toBe("move me");
    try {
      await fsp.stat(src);
      throw new Error("expected ENOENT");
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
  });

  test("unlink removes a file", async () => {
    const filePath = join(tempDir, "delete-me.txt");
    await fsp.writeFile(filePath, "bye");

    const res = await fsDispatch(
      guard,
      {
        op: "unlink",
        path: filePath,
        allowedRoots: [tempDir],
      },
      "destructive",
    );
    const result = resultOf(res);
    expect(result.ok).toBe(true);
    try {
      await fsp.stat(filePath);
      throw new Error("expected ENOENT");
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
  });

  test("rm recursive removes a directory tree", async () => {
    const dir = join(tempDir, "tree");
    await fsp.mkdir(join(dir, "sub"), { recursive: true });
    await fsp.writeFile(join(dir, "sub", "f.txt"), "x");

    const res = await fsDispatch(
      guard,
      {
        op: "rm",
        path: dir,
        opts: { recursive: true, force: true },
        allowedRoots: [tempDir],
      },
      "destructive",
    );
    const result = resultOf(res);
    expect(result.ok).toBe(true);
    try {
      await fsp.stat(dir);
      throw new Error("expected ENOENT");
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
  });

  test("cp copies a file", async () => {
    const src = join(tempDir, "src.txt");
    const dest = join(tempDir, "dest.txt");
    await fsp.writeFile(src, "copy me");

    const res = await fsDispatch(
      guard,
      {
        op: "cp",
        path: src,
        destPath: dest,
        allowedRoots: [tempDir],
      },
      "destructive",
    );
    const result = resultOf(res);
    expect(result.ok).toBe(true);
    expect(await fsp.readFile(dest, "utf8")).toBe("copy me");
  });

  test("realpath resolves an existing path", async () => {
    const filePath = join(tempDir, "real.txt");
    await fsp.writeFile(filePath, "x");

    const res = await fsDispatch(guard, {
      op: "realpath",
      path: filePath,
      allowedRoots: [tempDir],
    });
    const result = resultOf(res);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.realpath).toBe(await fsp.realpath(filePath));
    }
  });

  test("realpath of non-existent path returns null", async () => {
    const missing = join(tempDir, "nope.txt");

    const res = await fsDispatch(guard, {
      op: "realpath",
      path: missing,
      allowedRoots: [tempDir],
    });
    const result = resultOf(res);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.realpath).toBeNull();
    }
  });

  test("jail blocks readFile outside allowed roots", async () => {
    const res = await fsDispatch(guard, {
      op: "readFile",
      path: "/etc/passwd",
      allowedRoots: [tempDir],
    });
    const result = resultOf(res);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("EACCES");
    }
  });

  test("jail blocks traversal escape via readFile", async () => {
    const res = await fsDispatch(guard, {
      op: "readFile",
      path: join(tempDir, "..", "escape.txt"),
      allowedRoots: [tempDir],
    });
    const result = resultOf(res);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("EACCES");
    }
  });

  test("jail blocks rename destPath outside roots", async () => {
    const src = join(tempDir, "inside.txt");
    await fsp.writeFile(src, "x");

    const res = await fsDispatch(
      guard,
      {
        op: "rename",
        path: src,
        destPath: "/tmp/outside-rename.txt",
        allowedRoots: [tempDir],
      },
      "destructive",
    );
    const result = resultOf(res);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("EACCES");
    }
  });

  test("jail blocks cp destPath outside roots", async () => {
    const src = join(tempDir, "inside.txt");
    await fsp.writeFile(src, "x");

    const res = await fsDispatch(
      guard,
      {
        op: "cp",
        path: src,
        destPath: "/tmp/outside-cp.txt",
        allowedRoots: [tempDir],
      },
      "destructive",
    );
    const result = resultOf(res);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("EACCES");
    }
  });

  test("readFile of missing file returns ENOENT", async () => {
    const res = await fsDispatch(guard, {
      op: "readFile",
      path: join(tempDir, "missing.txt"),
      allowedRoots: [tempDir],
    });
    const result = resultOf(res);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("ENOENT");
    }
  });

  test("stat of directory succeeds", async () => {
    const res = await fsDispatch(guard, {
      op: "stat",
      path: tempDir,
      allowedRoots: [tempDir],
    });
    const result = resultOf(res);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stat?.isDirectory).toBe(true);
    }
  });

  test("readFile of directory returns EISDIR or ENOENT-family", async () => {
    const res = await fsDispatch(guard, {
      op: "readFile",
      path: tempDir,
      allowedRoots: [tempDir],
    });
    const result = resultOf(res);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBeDefined();
      expect(["EISDIR", "ENOENT", "EACCES"] as string[]).toContain(
        result.code as string,
      );
    }
  });

  test("writeFileAtomic rejects oversized payload with EFBIG", async () => {
    const oversized = Buffer.alloc(RELAY_FS_MAX_BYTES + 1, 0x41);
    const dataBase64 = oversized.toString("base64");

    const res = await fsDispatch(
      guard,
      {
        op: "writeFileAtomic",
        path: join(tempDir, "big.bin"),
        dataBase64,
        allowedRoots: [tempDir],
      },
      "destructive",
    );
    const result = resultOf(res);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("EFBIG");
    }
  });

  // ── D418 — desktop-filesystem-grant dispatches use validated authority only ────

  function desktopFilesystemGrantRequest(requestedRoot: string) {
    return {
      version: 1 as const,
      grantIds: ["g1"],
      requestedRoot,
      operation: "read" as const,
      subject: { userId: "u", instanceId: "i", relayId: "r", agentScope: "a" },
      policy: { policyVersion: 1, lifetime: "durable" as const },
    };
  }

  test("D418 request without validated authority fails closed (EACCES)", async () => {
    const filePath = join(tempDir, "grant.txt");
    await fsp.writeFile(filePath, "secret");

    const req: RelayDispatchRequest = {
      correlationId: "test",
      toolName: "fs",
      executionClass: "fs",
      impact: "read-only",
      approvalObtained: true,
      allowedRoots: [tempDir],
      desktopFilesystemGrantRequest: desktopFilesystemGrantRequest(tempDir),
      args: { op: "readFile", path: filePath, allowedRoots: [tempDir] },
    };
    // No options.desktopFilesystemAuthority → server envelope alone cannot widen.
    const res = await handleFsDispatch(req, guard);
    const result = resultOf(res);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("EACCES");
      expect(result.message).toContain("locally validated authority");
    }
  });

  test("D418 request with validated authority ignores server allowedRoots", async () => {
    const insideFile = join(tempDir, "inside.txt");
    await fsp.writeFile(insideFile, "inside");

    const outsideDir = makeRoot();
    await fsp.mkdir(outsideDir, { recursive: true });
    const outsideFile = join(outsideDir, "secret.txt");
    await fsp.writeFile(outsideFile, "server-secret");

    try {
      // The server tries to widen via allowedRoots=[outsideDir]; only the
      // validated authority root (tempDir) may reach the fs jail.
      const readInside = await handleFsDispatch(
        {
          correlationId: "test",
          toolName: "fs",
          executionClass: "fs",
          impact: "read-only",
          approvalObtained: true,
          allowedRoots: [outsideDir],
          desktopFilesystemGrantRequest: desktopFilesystemGrantRequest(tempDir),
          args: { op: "readFile", path: insideFile, allowedRoots: [outsideDir] },
        },
        guard,
        { desktopFilesystemAuthority: { roots: [tempDir] } },
      );
      const insideResult = resultOf(readInside);
      expect(insideResult.ok).toBe(true);

      const readOutside = await handleFsDispatch(
        {
          correlationId: "test",
          toolName: "fs",
          executionClass: "fs",
          impact: "read-only",
          approvalObtained: true,
          allowedRoots: [outsideDir],
          desktopFilesystemGrantRequest: desktopFilesystemGrantRequest(tempDir),
          args: { op: "readFile", path: outsideFile, allowedRoots: [outsideDir] },
        },
        guard,
        { desktopFilesystemAuthority: { roots: [tempDir] } },
      );
      const outsideResult = resultOf(readOutside);
      expect(outsideResult.ok).toBe(false);
      if (!outsideResult.ok) {
        expect(outsideResult.code).toBe("EACCES");
      }
    } finally {
      await fsp.rm(outsideDir, { recursive: true, force: true });
    }
  });

  test("absent envelope still unions server allowedRoots (baseline unchanged)", async () => {
    const otherDir = makeRoot();
    await fsp.mkdir(otherDir, { recursive: true });
    const otherFile = join(otherDir, "other.txt");
    await fsp.writeFile(otherFile, "hello");
    try {
      // No desktopFilesystemGrantRequest → established union of baseGuard + fsReq roots.
      const res = await handleFsDispatch(
        {
          correlationId: "test",
          toolName: "fs",
          executionClass: "fs",
          impact: "read-only",
          approvalObtained: true,
          allowedRoots: [otherDir],
          args: { op: "readFile", path: otherFile, allowedRoots: [otherDir] },
        },
        guard,
      );
      const result = resultOf(res);
      expect(result.ok).toBe(true);
    } finally {
      await fsp.rm(otherDir, { recursive: true, force: true });
    }
  });

  test("malformed request returns EINVAL", async () => {
    const req: RelayDispatchRequest = {
      correlationId: "test",
      toolName: "fs",
      executionClass: "fs",
      impact: "read-only",
      approvalObtained: true,
      args: { op: 123 },
    };
    const res = await handleFsDispatch(req, guard);
    const result = resultOf(res);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("EINVAL");
      expect(result.message).toContain("malformed");
    }
  });
});
