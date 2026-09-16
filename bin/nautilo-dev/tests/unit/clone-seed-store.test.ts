import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CloneSeedBusyError,
  CloneSeedFreshnessError,
  cloneSeedPaths,
  readCurrentCloneSeed,
  refreshCloneSeed,
  withCloneSeedRefreshLock,
} from "../../src/lib/clone-seed-store";
import {
  describeBackupArtifact,
  verifyFullBackupDirectory,
  writeManifestFile,
  type DevFullBackupManifestV2,
  type VerifiedFullBackup,
} from "../../src/lib/full-dev-backup";

const roots: string[] = [];
const SHA = "a".repeat(64);
const COMMIT = "b".repeat(40);
const TIME = "2026-08-03T00:00:00.000Z";

async function makeBackup(root: string, name: string, createdAt = TIME): Promise<VerifiedFullBackup> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const file of ["database.sql.gz", "logto.sql.gz", "dot-env", "home.tar.gz"]) {
    await writeFile(join(dir, file), `${name}:${file}`, { mode: 0o600 });
  }
  const manifest: DevFullBackupManifestV2 = {
    formatVersion: 2,
    name,
    createdAt,
    sourceInstanceId: "source",
    sourceDeploymentMode: "dev-multi-instance",
    capture: { consistency: "quiesced", nautiloWriterStopped: true, logtoWriterStopped: true },
    artifacts: {
      nautiloDatabase: await describeBackupArtifact(dir, "database.sql.gz"),
      logtoDatabase: await describeBackupArtifact(dir, "logto.sql.gz"),
      instanceEnv: await describeBackupArtifact(dir, "dot-env"),
      nautiloHome: await describeBackupArtifact(dir, "home.tar.gz"),
    },
    drizzle: { lastAppliedIndex: 0, entries: [{ index: 0, tag: "first", createdAt: 1, sha256: SHA }] },
    postgres: { nautiloMajor: 17, logtoMajor: 16 },
    rowAnchors: { users: 1 },
    complete: true,
    cloneEligible: true,
    backupMode: "dump",
  };
  await writeManifestFile(dir, manifest);
  return verifyFullBackupDirectory(dir);
}

function provenance(lastAppliedIndex = 0) {
  return {
    checkoutCommitSha: COMMIT,
    lineage: { appliedMigrationCount: lastAppliedIndex + 1, lastAppliedIndex, sha256: SHA },
  } as const;
}

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "nautilo-clone-seed-"));
  roots.push(value);
  return value;
}

async function publish(store: string, backup: VerifiedFullBackup, generation = "seed-12345678"): Promise<void> {
  await refreshCloneSeed({
    root: store,
    capture: async () => backup,
    provenance: provenance(),
    generation: () => generation,
    now: () => new Date(TIME),
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("canonical clone-seed store", () => {
  test("publishes only a complete owner-only verified seed and supports concurrent readers", async () => {
    const fixture = await root();
    const store = join(fixture, "seed-store");
    const backup = await makeBackup(fixture, "source-a");
    await publish(store, backup);
    const readers = await Promise.all(Array.from({ length: 12 }, () => readCurrentCloneSeed({ root: store })));
    expect(readers.every((reader) => reader?.backup.manifest.name === "source-a")).toBe(true);
    const seed = readers[0];
    if (seed === null || seed === undefined) throw new Error("seed missing");
    expect((await stat(seed.directory)).mode & 0o077).toBe(0);
    expect((await stat(join(seed.directory, "operation.json"))).mode & 0o077).toBe(0);
    expect(JSON.parse(await readFile(join(cloneSeedPaths(store).currentPointer), "utf8"))).toMatchObject({ formatVersion: 1 });
  });

  test("rejects artifact hash drift and operation evidence drift instead of serving a corrupted seed", async () => {
    const fixture = await root();
    const store = join(fixture, "seed-store");
    const backup = await makeBackup(fixture, "source-a");
    await publish(store, backup);
    const seed = await readCurrentCloneSeed({ root: store });
    if (seed === null) throw new Error("seed missing");
    const artifact = join(seed.directory, "backup", "source-a", "dot-env");
    const original = await readFile(artifact, "utf8");
    await writeFile(artifact, `${original.slice(0, -1)}x`);
    expect(readCurrentCloneSeed({ root: store })).rejects.toThrow("hash mismatch");
  });

  test("enforces stale/future timestamps and requested lineage when reusing a seed", async () => {
    const fixture = await root();
    const store = join(fixture, "seed-store");
    const backup = await makeBackup(fixture, "source-a", TIME);
    await publish(store, backup);
    expect(readCurrentCloneSeed({
      root: store,
      now: new Date("2026-08-03T00:00:01.000Z"),
      maxAgeMs: 100,
    })).rejects.toThrow("stale");
    expect(readCurrentCloneSeed({
      root: store,
      now: new Date("2026-08-02T23:59:59.000Z"),
      maxAgeMs: 1_000,
    })).rejects.toThrow("future");
    expect(readCurrentCloneSeed({
      root: store,
      expectedLineage: provenance(1).lineage,
    })).rejects.toBeInstanceOf(CloneSeedFreshnessError);
  });

  test("fails disk preflight before copying and leaves no authoritative pointer", async () => {
    const fixture = await root();
    const store = join(fixture, "seed-store");
    const backup = await makeBackup(fixture, "source-a");
    expect(refreshCloneSeed({
      root: store,
      capture: async () => backup,
      provenance: provenance(),
      generation: () => "seed-12345678",
      diskSpace: async () => ({ bavail: 0, bsize: 1 }),
    })).rejects.toThrow("Insufficient free disk space");
    expect(readCurrentCloneSeed({ root: store })).resolves.toBeNull();
  });

  test("uses an immediate bounded lock rather than queueing a second worktree", async () => {
    const fixture = await root();
    let release: (() => void) | undefined;
    let confirmAcquired: (() => void) | undefined;
    const acquired = new Promise<void>((resolvePromise) => { confirmAcquired = resolvePromise; });
    const held = withCloneSeedRefreshLock(fixture, () => {
      confirmAcquired?.();
      return new Promise<void>((resolvePromise) => { release = resolvePromise; });
    });
    await acquired;
    expect(withCloneSeedRefreshLock(fixture, async () => undefined)).rejects.toBeInstanceOf(CloneSeedBusyError);
    release?.();
    await held;
  });

  test("recovers only a lock whose recorded owner process is demonstrably gone", async () => {
    const fixture = await root();
    const paths = cloneSeedPaths(fixture);
    await mkdir(fixture, { recursive: true, mode: 0o700 });
    await writeFile(paths.lock, `${JSON.stringify({ pid: 2_147_483_647, startedAt: TIME })}\n`, { mode: 0o600 });
    const recovered = await withCloneSeedRefreshLock(fixture, async () => "recovered");
    expect(recovered).toBe("recovered");
    await writeFile(paths.lock, "not-a-lock", { mode: 0o600 });
    expect(withCloneSeedRefreshLock(fixture, async () => undefined)).rejects.toThrow("cannot be proved stale");
  });

  test("an interruption before pointer publication retains the prior current seed", async () => {
    const fixture = await root();
    const store = join(fixture, "seed-store");
    await publish(store, await makeBackup(fixture, "source-a"));
    const next = await makeBackup(fixture, "source-b");
    expect(refreshCloneSeed({
      root: store,
      capture: async () => next,
      provenance: provenance(),
      generation: () => "seed-abcdefgh",
      now: () => new Date(TIME),
      beforePublish: async () => { throw new Error("simulated interruption"); },
    })).rejects.toThrow("simulated interruption");
    expect((await readCurrentCloneSeed({ root: store }))?.backup.manifest.name).toBe("source-a");
    expect(readFile(cloneSeedPaths(store).failureRecord, "utf8")).resolves.toContain("seed-publication-failed");
  });

  test("a final-path verification failure cannot replace the prior current pointer", async () => {
    const fixture = await root();
    const store = join(fixture, "seed-store");
    await publish(store, await makeBackup(fixture, "source-a"));
    const next = await makeBackup(fixture, "source-b");
    expect(refreshCloneSeed({
      root: store,
      capture: async () => next,
      provenance: provenance(),
      generation: () => "seed-abcdefgh",
      now: () => new Date(TIME),
      verify: async (directory) => {
        if (directory.includes(`${join("generations", "seed-abcdefgh")}/`)) {
          throw new Error("final path verification failed");
        }
        return verifyFullBackupDirectory(directory);
      },
    })).rejects.toThrow("final path verification failed");
    expect((await readCurrentCloneSeed({ root: store }))?.backup.manifest.name).toBe("source-a");
  });

  test("a post-pointer interruption leaves the new verified current seed readable", async () => {
    const fixture = await root();
    const store = join(fixture, "seed-store");
    await publish(store, await makeBackup(fixture, "source-a"));
    const next = await makeBackup(fixture, "source-b");
    expect(refreshCloneSeed({
      root: store,
      capture: async () => next,
      provenance: provenance(),
      generation: () => "seed-abcdefgh",
      now: () => new Date(TIME),
      afterPublish: async () => { throw new Error("after pointer"); },
    })).resolves.toMatchObject({ backup: { manifest: { name: "source-b" } } });
    expect((await readCurrentCloneSeed({ root: store }))?.backup.manifest.name).toBe("source-b");
  });

  test("a later refresh removes hard-kill staging and renamed-but-unpublished generations", async () => {
    const fixture = await root();
    const store = join(fixture, "seed-store");
    await publish(store, await makeBackup(fixture, "source-a"));
    const paths = cloneSeedPaths(store);
    await mkdir(join(paths.generations, ".staging-seed-abcdefgh"), { mode: 0o700 });
    await mkdir(join(paths.generations, "seed-ijklmnop"), { mode: 0o700 });
    await publish(store, await makeBackup(fixture, "source-b"), "seed-qrstuvwx");
    expect((await readdir(paths.generations)).filter((entry) => !entry.startsWith(".")).sort())
      .toEqual(["seed-12345678", "seed-qrstuvwx"]);
    expect((await readCurrentCloneSeed({ root: store }))?.backup.manifest.name).toBe("source-b");
  });

  test("a missing pointer target stops before touching an otherwise safe orphan", async () => {
    const fixture = await root();
    const store = join(fixture, "seed-store");
    const paths = cloneSeedPaths(store);
    await mkdir(paths.generations, { recursive: true, mode: 0o700 });
    await mkdir(join(paths.generations, "seed-abcdefgh"), { mode: 0o700 });
    await writeFile(paths.currentPointer, `${JSON.stringify({ formatVersion: 1, generation: "seed-missing" })}\n`, { mode: 0o600 });
    const backup = await makeBackup(fixture, "source-a");
    expect(refreshCloneSeed({
      root: store,
      capture: async () => backup,
      provenance: provenance(),
      generation: () => "seed-ijklmnop",
      now: () => new Date(TIME),
    })).rejects.toThrow("pointer references a missing");
    expect(await readdir(paths.generations)).toEqual(["seed-abcdefgh"]);
  });

  test("keeps exactly current plus one previous across repeated success and a failed refresh", async () => {
    const fixture = await root();
    const store = join(fixture, "seed-store");
    const first = await makeBackup(fixture, "source-a");
    const second = await makeBackup(fixture, "source-b");
    const third = await makeBackup(fixture, "source-c");
    await publish(store, first, "seed-12345678");
    await publish(store, second, "seed-abcdefgh");
    await publish(store, third, "seed-ijklmnop");
    expect((await readdir(cloneSeedPaths(store).generations)).filter((entry) => !entry.startsWith(".")).sort()).toEqual(["seed-abcdefgh", "seed-ijklmnop"]);
    expect(refreshCloneSeed({
      root: store,
      capture: async () => first,
      provenance: provenance(),
      generation: () => "seed-qrstuvwx",
      now: () => new Date(TIME),
      copy: async () => { throw new Error("copy failed"); },
    })).rejects.toThrow("copy failed");
    expect((await readdir(cloneSeedPaths(store).generations)).filter((entry) => !entry.startsWith(".")).sort()).toEqual(["seed-abcdefgh", "seed-ijklmnop"]);
    expect((await readCurrentCloneSeed({ root: store }))?.backup.manifest.name).toBe("source-c");
  });
});
