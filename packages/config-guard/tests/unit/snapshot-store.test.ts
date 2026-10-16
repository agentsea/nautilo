import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { isPrivateFilesystemPath } from "@nautilo/config/private-filesystem";
import { allowOtherReaders } from "@nautilo/config/private-filesystem-fixtures";
import {
  createSnapshot,
  listSnapshots,
  pruneSnapshots,
  readSnapshotEnv,
  snapshotOperationsSummary,
  updateSnapshotMeta,
} from "../../src/snapshot-store";

describe("snapshot-store", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  test("createSnapshot writes .env and .meta.json", async () => {
    dir = await mkdtemp(join(tmpdir(), "cg-sn-"));
    await allowOtherReaders(dir);
    expect(isPrivateFilesystemPath(dir)).toBe(false);
    const id = await createSnapshot(
      dir,
      "A=1\n",
      snapshotOperationsSummary("test", "reason", [{ type: "set", key: "A" }]),
    );
    expect(id.length).toBeGreaterThan(10);
    const envContent = await readFile(join(dir, `${id}.env`), "utf-8");
    expect(envContent).toBe("A=1\n");
    const metaRaw = await readFile(join(dir, `${id}.meta.json`), "utf-8");
    const meta = JSON.parse(metaRaw) as { result: string; actor: string };
    expect(meta.result).toBe("pending");
    expect(meta.actor).toBe("test");
    for (const path of [dir, join(dir, `${id}.env`), join(dir, `${id}.meta.json`)]) {
      expect(isPrivateFilesystemPath(path)).toBe(true);
    }
    if (process.platform !== "win32") {
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      expect((await stat(join(dir, `${id}.env`))).mode & 0o777).toBe(0o600);
      expect((await stat(join(dir, `${id}.meta.json`))).mode & 0o777).toBe(0o600);
    }
  });

  test("createSnapshot and updateSnapshotMeta accept a relative snapshot directory", async () => {
    const local = await mkdtemp(join(process.cwd(), ".cg-sn-relative-"));
    try {
      const snapshotDir = relative(process.cwd(), join(local, "config-snapshots"));
      expect(isAbsolute(snapshotDir)).toBe(false);
      const id = await createSnapshot(
        snapshotDir,
        "R=1\n",
        snapshotOperationsSummary("test", "relative", [{ type: "set", key: "R" }]),
      );
      await updateSnapshotMeta(snapshotDir, id, { result: "applied" });
      expect(await readSnapshotEnv(snapshotDir, id)).toBe("R=1\n");
      const absoluteDir = join(local, "config-snapshots");
      const meta = JSON.parse(await readFile(join(absoluteDir, `${id}.meta.json`), "utf-8")) as { result: string };
      expect(meta.result).toBe("applied");
      for (const path of [absoluteDir, join(absoluteDir, `${id}.env`), join(absoluteDir, `${id}.meta.json`)]) {
        expect(isPrivateFilesystemPath(path)).toBe(true);
      }
    } finally {
      await rm(local, { recursive: true, force: true });
    }
  });

  test("readSnapshotEnv returns snapshot body", async () => {
    dir = await mkdtemp(join(tmpdir(), "cg-sn-"));
    const id = await createSnapshot(
      dir,
      "X=y\n",
      snapshotOperationsSummary("test", "r", [{ type: "set", key: "X" }]),
    );
    const body = await readSnapshotEnv(dir, id);
    expect(body).toBe("X=y\n");
  });

  test("updateSnapshotMeta patches result", async () => {
    dir = await mkdtemp(join(tmpdir(), "cg-sn-"));
    const id = await createSnapshot(
      dir,
      "",
      snapshotOperationsSummary("test", "r", []),
    );
    await allowOtherReaders(join(dir, `${id}.meta.json`));
    expect(isPrivateFilesystemPath(join(dir, `${id}.meta.json`))).toBe(false);
    await updateSnapshotMeta(dir, id, { result: "applied" });
    const metaRaw = await readFile(join(dir, `${id}.meta.json`), "utf-8");
    const meta = JSON.parse(metaRaw) as { result: string };
    expect(meta.result).toBe("applied");
    expect(isPrivateFilesystemPath(join(dir, `${id}.meta.json`))).toBe(true);
    if (process.platform !== "win32") expect((await stat(join(dir, `${id}.meta.json`))).mode & 0o777).toBe(0o600);
  });

  test("listSnapshots returns sorted metas", async () => {
    dir = await mkdtemp(join(tmpdir(), "cg-sn-"));
    await createSnapshot(dir, "a", snapshotOperationsSummary("test", "r", []));
    await new Promise((r) => setTimeout(r, 5));
    await createSnapshot(dir, "b", snapshotOperationsSummary("test", "r2", []));
    const list = await listSnapshots(dir);
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list[list.length - 1]!.timestamp >= list[list.length - 2]!.timestamp).toBe(true);
  });

  test("pruneSnapshots removes oldest beyond maxCount", async () => {
    dir = await mkdtemp(join(tmpdir(), "cg-sn-"));
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        await createSnapshot(
          dir,
          `v=${i}\n`,
          snapshotOperationsSummary("test", `op${i}`, []),
        ),
      );
      await new Promise((r) => setTimeout(r, 3));
    }
    const pruned = await pruneSnapshots(dir, 2);
    expect(pruned).toBeGreaterThan(0);
    const remaining = await listSnapshots(dir);
    expect(remaining.length).toBeLessThanOrEqual(2);
  });
});
