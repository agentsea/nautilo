import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";

import { resolveStructuredSshCopyPath } from "../../electron/structured-ssh/copy-confinement.ts";

async function workspaceFixture(): Promise<{ readonly root: string; cleanup(): Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nautilo-structured-ssh-copy-"));
  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

describe("structured SSH copy confinement", () => {
  test("resolves parsed relative upload intent beneath the canonical workspace", async () => {
    const fixture = await workspaceFixture();
    try {
      await fs.mkdir(path.join(fixture.root, "release"));
      await fs.writeFile(path.join(fixture.root, "release", "bundle.tar"), "payload");
      const result = await resolveStructuredSshCopyPath({ operation: "copy-upload", workspaceRoot: fixture.root, localPath: "release/bundle.tar" });
      expect(result).toMatchObject({ ok: true, path: path.join(await fs.realpath(fixture.root), "release", "bundle.tar"), bytes: 7 });
      if (!result.ok) throw new Error("expected confined path");
      expect(await result.validateForLaunch()).toBe(true);
    } finally { await fixture.cleanup(); }
  });

  test("rejects absolute and escaping workspace intent before local file access", async () => {
    const fixture = await workspaceFixture();
    try {
      for (const localPath of ["/private/tmp/file", "../outside", "nested/../../outside", "."]) {
        await expect(resolveStructuredSshCopyPath({ operation: "copy-download", workspaceRoot: fixture.root, localPath })).resolves.toEqual({ ok: false });
      }
    } finally { await fixture.cleanup(); }
  });

  test("keeps download destinations beneath workspaceRoot and refuses symlink escapes", async () => {
    const fixture = await workspaceFixture();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "nautilo-structured-ssh-outside-"));
    try {
      await fs.mkdir(path.join(fixture.root, "result"));
      const download = await resolveStructuredSshCopyPath({ operation: "copy-download", workspaceRoot: fixture.root, localPath: "result/output.tar" });
      expect(download).toMatchObject({ ok: true, path: path.join(await fs.realpath(fixture.root), "result", "output.tar") });
      await fs.symlink(outside, path.join(fixture.root, "escape"));
      await expect(resolveStructuredSshCopyPath({ operation: "copy-download", workspaceRoot: fixture.root, localPath: "escape/output.tar" })).resolves.toEqual({ ok: false });
    } finally { await Promise.all([fixture.cleanup(), fs.rm(outside, { recursive: true, force: true })]); }
  });

  test("allows a new download file directly inside the canonical workspace root", async () => {
    const fixture = await workspaceFixture();
    try {
      const download = await resolveStructuredSshCopyPath({
        operation: "copy-download",
        workspaceRoot: fixture.root,
        localPath: "result.txt",
      });
      expect(download).toMatchObject({
        ok: true,
        path: path.join(await fs.realpath(fixture.root), "result.txt"),
      });
      if (!download.ok) throw new Error("expected root-level confined path");
      expect(await download.validateForLaunch()).toBe(true);
    } finally { await fixture.cleanup(); }
  });
});
