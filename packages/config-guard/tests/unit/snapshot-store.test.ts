import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
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
    await chmod(dir, 0o755);
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
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, `${id}.env`))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, `${id}.meta.json`))).mode & 0o777).toBe(0o600);
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
    await chmod(join(dir, `${id}.meta.json`), 0o644);
    await updateSnapshotMeta(dir, id, { result: "applied" });
    const metaRaw = await readFile(join(dir, `${id}.meta.json`), "utf-8");
    const meta = JSON.parse(metaRaw) as { result: string };
    expect(meta.result).toBe("applied");
    expect((await stat(join(dir, `${id}.meta.json`))).mode & 0o777).toBe(0o600);
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
