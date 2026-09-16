import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeBackupArtifact,
  discoverVerifiedFullBackups,
  parseFullBackupManifest,
  verifyFullBackupDirectory,
  writeManifestFile,
  type DevFullBackupManifestV2,
} from "../../src/lib/full-dev-backup";
import { dumpPostgresDatabaseGzip } from "../../src/lib/postgres-archive";
import { resolvePrivateSaveSource } from "../../src/commands/save";

const roots: string[] = [];

async function makeBackup(
  snapshotsDir: string,
  input: {
    name: string;
    createdAt: string;
    source?: string;
    eligible?: boolean;
    writersRunning?: boolean;
  },
): Promise<string> {
  const dir = join(snapshotsDir, input.name);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const file of ["database.sql.gz", "logto.sql.gz", "dot-env", "home.tar.gz"]) {
    await writeFile(join(dir, file), `${input.name}:${file}`, { mode: 0o600 });
  }
  const artifacts = {
    nautiloDatabase: await describeBackupArtifact(dir, "database.sql.gz"),
    logtoDatabase: await describeBackupArtifact(dir, "logto.sql.gz"),
    instanceEnv: await describeBackupArtifact(dir, "dot-env"),
    nautiloHome: await describeBackupArtifact(dir, "home.tar.gz"),
  };
  const manifest: DevFullBackupManifestV2 = {
    formatVersion: 2,
    name: input.name,
    createdAt: input.createdAt,
    sourceInstanceId: input.source ?? "qa-source",
    sourceDeploymentMode: "dev-multi-instance",
    capture: {
      consistency: "quiesced",
      nautiloWriterStopped: input.writersRunning ?? true,
      logtoWriterStopped: input.writersRunning ?? true,
    },
    artifacts,
    drizzle: {
      lastAppliedIndex: 0,
      entries: [
        {
          index: 0,
          tag: "0000_first",
          createdAt: 100,
          sha256: "a".repeat(64),
        },
      ],
    },
    postgres: { nautiloMajor: 17, logtoMajor: 17 },
    rowAnchors: { "nautilo.users": 2, "logto.users": 2 },
    complete: true,
    cloneEligible: input.eligible ?? true,
    backupMode: "dump",
  };
  await writeManifestFile(dir, manifest);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("full development backup manifest", () => {
  test("canonical seed capture resolves root, env, and containers from its private default environment", () => {
    const privateEnv = {
      ...process.env,
      HOME: "/tmp/nautilo-private-home",
      NAUTILO_INSTANCE_ID: "",
    };
    const source = resolvePrivateSaveSource(privateEnv);
    expect(source.root).toBe("/tmp/nautilo-private-home/.nautilo");
    expect(source.envPath).toBe("/tmp/nautilo-private-home/.nautilo/instance.env");
    expect(source.instance.instanceId).toBe("");
    expect(source.instance.compose.containers.legacyPostgres).toBe("nautilo-postgres");
    expect(source.instance.compose.containers.logtoPostgres).toBe("nautilo-postgres-1");
  });

  test("rejects unsafe database identifiers before starting a dump", () => {
    expect(
      dumpPostgresDatabaseGzip({
        container: "unused",
        database: "nautilo; DROP DATABASE nautilo",
        outputPath: "/unused",
      }),
    ).rejects.toThrow("must be identifiers");
  });

  test("rejects malformed manifests rather than inferring completeness", () => {
    expect(() => parseFullBackupManifest({ formatVersion: 2 })).toThrow(
      "Invalid full-backup manifest",
    );
  });

  test("verifies every artifact hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-full-backup-"));
    roots.push(root);
    const dir = await makeBackup(root, {
      name: "good",
      createdAt: "2026-08-02T10:00:00.000Z",
    });
    expect(verifyFullBackupDirectory(dir)).resolves.toMatchObject({
      manifest: { name: "good" },
    });
    await writeFile(join(dir, "dot-env"), "bad!:dot-env");
    expect(verifyFullBackupDirectory(dir)).rejects.toThrow("hash mismatch");
  });

  test("keeps a quiesced named dump cloneable when no source writers were running", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-full-backup-"));
    roots.push(root);
    const dir = await makeBackup(root, {
      name: "no-server",
      createdAt: "2026-08-02T10:00:00.000Z",
      writersRunning: false,
    });
    expect((await verifyFullBackupDirectory(dir)).manifest.name).toBe("no-server");
  });

  test("discovers only clone-eligible source backups newest first", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-full-backups-"));
    roots.push(root);
    await makeBackup(root, {
      name: "old",
      createdAt: "2026-08-01T10:00:00.000Z",
    });
    await makeBackup(root, {
      name: "new",
      createdAt: "2026-08-02T10:00:00.000Z",
    });
    await makeBackup(root, {
      name: "wrong-source",
      createdAt: "2026-08-03T10:00:00.000Z",
      source: "sigma",
    });
    await makeBackup(root, {
      name: "recovery-only",
      createdAt: "2026-08-04T10:00:00.000Z",
      eligible: false,
    });
    expect((await discoverVerifiedFullBackups(root, "qa-source")).map((b) => b.manifest.name))
      .toEqual(["new", "old"]);
  });
});
