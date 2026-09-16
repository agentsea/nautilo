import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareCanonicalDefaultCloneSeed,
  type CanonicalDefaultSourceEvidence,
  type PrepareCanonicalDefaultCloneSeedInput,
} from "../../src/lib/default-clone-seed";
import {
  CloneSeedBusyError,
  cloneSeedPaths,
  readCurrentCloneSeed,
} from "../../src/lib/clone-seed-store";
import {
  describeBackupArtifact,
  verifyCanonicalDefaultFullBackupDirectory,
  writeManifestFile,
  type DevFullBackupManifestV2,
  type VerifiedFullBackup,
} from "../../src/lib/full-dev-backup";

const roots: string[] = [];
const SHA = "a".repeat(64);
const COMMIT = "b".repeat(40);
const TIME = new Date(Date.now() - 1_000).toISOString();

async function makeCanonicalBackup(root: string, name: string, createdAt = TIME): Promise<VerifiedFullBackup> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const file of ["database.sql.gz", "logto.sql.gz", "dot-env", "home.tar.gz"]) {
    await writeFile(join(dir, file), `${name}:${file}`, { mode: 0o600 });
  }
  const manifest: DevFullBackupManifestV2 = {
    formatVersion: 2,
    name,
    createdAt,
    sourceInstanceId: "",
    sourceDeploymentMode: "local-self-host",
    // A stopped server is still a valid quiesced source boundary.
    capture: { consistency: "quiesced", nautiloWriterStopped: false, logtoWriterStopped: false },
    artifacts: {
      nautiloDatabase: await describeBackupArtifact(dir, "database.sql.gz"),
      logtoDatabase: await describeBackupArtifact(dir, "logto.sql.gz"),
      instanceEnv: await describeBackupArtifact(dir, "dot-env"),
      nautiloHome: await describeBackupArtifact(dir, "home.tar.gz"),
    },
    drizzle: { lastAppliedIndex: 0, entries: [{ index: 0, tag: "first", createdAt: 1, sha256: SHA }] },
    postgres: { nautiloMajor: 17, logtoMajor: 16 },
    rowAnchors: { "nautilo.users": 2, "logto.users": 2 },
    complete: true,
    cloneEligible: false,
    backupMode: "dump",
  };
  await writeManifestFile(dir, manifest);
  return verifyCanonicalDefaultFullBackupDirectory(dir);
}

function sourceEvidence(fail = false): CanonicalDefaultSourceEvidence {
  return {
    capture: async () => ({ id: "before" }),
    assertManifestAnchors: async () => undefined,
    assertUnchanged: async () => {
      if (fail) throw new Error("source evidence changed");
    },
  };
}

function input(
  root: string,
  capture: () => Promise<VerifiedFullBackup>,
  evidence = sourceEvidence(),
): PrepareCanonicalDefaultCloneSeedInput {
  return {
    source: { kind: "canonical-default", instanceId: "" as const, root: join(root, ".nautilo") },
    root: join(root, "seed-store"),
    provenance: { checkoutCommitSha: COMMIT, lineage: { appliedMigrationCount: 1, lastAppliedIndex: 0, sha256: SHA } },
    capture,
    sourceEvidence: evidence,
    now: new Date(TIME),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("canonical default seed admission", () => {
  test("admits only explicit empty-ID default backups, including quiesced no-server captures", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-default-seed-"));
    roots.push(root);
    const backup = await makeCanonicalBackup(root, "default-a");
    expect((await prepareCanonicalDefaultCloneSeed(input(root, async () => backup))).freshness).toBe("fresh");
    const literalDefaultError = await prepareCanonicalDefaultCloneSeed({
      ...input(root, async () => backup),
      source: { kind: "named", instanceId: "default", root: join(root, ".nautilo-default") } as never,
    } as PrepareCanonicalDefaultCloneSeedInput).catch((error: unknown) => error);
    expect(literalDefaultError).toBeInstanceOf(Error);
    if (!(literalDefaultError instanceof Error)) throw new Error("expected explicit selector error");
    expect(literalDefaultError.message).toContain("explicit canonical-default");
  });

  test("reports reuse truthfully, refreshes stale data, and refuses a future capture", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-default-seed-"));
    roots.push(root);
    const backup = await makeCanonicalBackup(root, "default-a", TIME);
    let captures = 0;
    const first = await prepareCanonicalDefaultCloneSeed(input(root, async () => { captures += 1; return backup; }));
    expect(first.freshness).toBe("fresh");
    const reused = await prepareCanonicalDefaultCloneSeed(input(root, async () => { captures += 1; return backup; }));
    expect(reused.freshness).toBe("reused");
    expect(captures).toBe(1);
    const refreshedBackup = await makeCanonicalBackup(
      root,
      "default-b",
      new Date(Date.parse(TIME) + 1_000).toISOString(),
    );
    const refreshed = await prepareCanonicalDefaultCloneSeed({
      ...input(root, async () => { captures += 1; return refreshedBackup; }),
      now: new Date(Date.parse(TIME) + 1_000),
      maxAgeMs: 1,
    });
    expect(refreshed.freshness).toBe("fresh");
    const futureError = await prepareCanonicalDefaultCloneSeed({
      ...input(root, async () => backup),
      now: new Date(Date.parse(TIME) - 1_000),
      maxAgeMs: 1_000,
    }).catch((error: unknown) => error);
    expect(futureError).toBeInstanceOf(Error);
    if (!(futureError instanceof Error)) throw new Error("expected future capture error");
    expect(futureError.message).toContain("future");
  });

  test("does not publish a replacement when the source proof fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-default-seed-"));
    roots.push(root);
    const first = await makeCanonicalBackup(root, "default-a");
    const second = await makeCanonicalBackup(root, "default-b");
    await prepareCanonicalDefaultCloneSeed(input(root, async () => first));
    const proofError = await prepareCanonicalDefaultCloneSeed({
      ...input(root, async () => second, sourceEvidence(true)),
      forceRefresh: true,
    }).catch((error: unknown) => error);
    expect(proofError).toMatchObject({ message: "source evidence changed" });
    const current = await readCurrentCloneSeed({
      root: join(root, "seed-store"),
      verify: verifyCanonicalDefaultFullBackupDirectory,
    });
    expect(current?.backup.manifest.name).toBe("default-a");
  });

  test("only the refresh-lock owner cleans the shared capture directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-default-seed-"));
    roots.push(root);
    const backup = await makeCanonicalBackup(root, "default-a");
    const store = join(root, "seed-store");
    let releaseCapture: (() => void) | undefined;
    let confirmCaptureStarted: (() => void) | undefined;
    const captureStarted = new Promise<void>((resolve) => { confirmCaptureStarted = resolve; });
    const cleanupOwners: string[] = [];

    const owner = prepareCanonicalDefaultCloneSeed({
      ...input(root, async () => {
        confirmCaptureStarted?.();
        await new Promise<void>((resolve) => { releaseCapture = resolve; });
        return backup;
      }),
      cleanupCapture: async () => {
        expect(await Bun.file(cloneSeedPaths(store).lock).exists()).toBe(true);
        cleanupOwners.push("owner");
      },
    });
    await captureStarted;

    const contender = await prepareCanonicalDefaultCloneSeed({
      ...input(root, async () => backup),
      cleanupCapture: async () => { cleanupOwners.push("contender"); },
    }).catch((error: unknown) => error);
    expect(contender).toBeInstanceOf(CloneSeedBusyError);
    expect(cleanupOwners).toEqual([]);

    releaseCapture?.();
    await owner;
    expect(cleanupOwners).toEqual(["owner"]);
  });
});
