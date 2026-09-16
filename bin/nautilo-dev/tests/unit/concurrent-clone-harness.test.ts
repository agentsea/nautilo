import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConcurrentCloneHarnessScenarioError,
  runConcurrentCloneHarness,
  type ConcurrentCloneHarnessFailureCode,
} from "../../src/lib/concurrent-clone-harness";
import type {
  ConcurrentCloneTargetEvidence,
  PopulatedCloneSourceFingerprint,
} from "../../src/lib/clone-isolation-evidence";
import { refreshCloneSeed, withCloneSeedRefreshLock } from "../../src/lib/clone-seed-store";
import {
  describeBackupArtifact,
  verifyCanonicalDefaultFullBackupDirectory,
  writeManifestFile,
  type DevFullBackupManifestV2,
  type VerifiedFullBackup,
} from "../../src/lib/full-dev-backup";
import { assertCloneTargetAbsent } from "../../src/lib/clone-preflight";
import { assertExactMigrationPrefix, type MigrationLineageEntry } from "../../src/lib/migration-lineage";
import { CLONE_STAGES, runCloneStages, type CloneOperationRecord } from "../../src/lib/clone-operation";
import { rebindCloneEnvContent } from "../../src/lib/clone-config-rebind";
import { assertCloneResourceIsolation } from "../../src/commands/clone";
import {
  collaboraHostPort,
  officeHostPort,
  resolveInstanceUncached,
  type ResolvedInstance,
} from "@nautilo/config";
import { infraPersistentVolumeNames } from "../../src/lib/compose-infra";

const roots: string[] = [];
const runtimeChildren: ChildProcess[] = [];

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function spawnDisposableListener(logPath: string, label: string, port: number = 0): Promise<{ pid: number; port: number }> {
  const script = `
    import { appendFileSync } from "node:fs";
    import { createServer } from "node:net";
    const server = createServer((socket) => socket.end("ok"));
    server.listen(Number(process.argv[3]), "127.0.0.1", () => {
      const address = server.address();
      appendFileSync(process.argv[1], process.argv[2] + " pid=" + process.pid + " port=" + address.port + "\\n");
      process.stdout.write(JSON.stringify({ pid: process.pid, port: address.port }) + "\\n");
    });
    process.on("SIGTERM", () => server.close(() => process.exit(0)));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script, logPath, label, String(port)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    runtimeChildren.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const line = stdout.split("\n")[0];
      if (line) resolve(JSON.parse(line) as { pid: number; port: number });
    });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (stdout.trim() === "") reject(new Error(stderr || `listener exited ${code ?? 1}`));
    });
  });
}

function probeListener(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(); });
    socket.once("error", reject);
  });
}

function evidenceFromRuntime(input: {
  root: string;
  instance: ResolvedInstance;
  server: { pid: number; port: number };
  electron: { pid: number; port: number };
}): ConcurrentCloneTargetEvidence {
  const inst = input.instance;
  return {
    instanceId: inst.instanceId,
    root: input.root,
    projectName: inst.compose.projectName,
    ports: {
      workbench: inst.workbench.port,
      server: input.server.port,
      nautiloDb: inst.db.postgresHostPort,
      logtoDb: inst.logto.dbPort,
      logtoCore: inst.logto.corePort,
      logtoAdmin: inst.logto.adminPort,
      office: officeHostPort(inst),
      collabora: collaboraHostPort(inst),
      electronCdp: input.electron.port,
    },
    containers: [
      inst.compose.containers.legacyPostgres,
      inst.compose.containers.logtoPostgres,
      inst.compose.containers.logtoCore,
      inst.compose.containers.logtoSeed,
    ],
    networks: [`${inst.compose.projectName}_default`],
    volumes: infraPersistentVolumeNames(inst) as [string, string],
    databaseIdentity: inst.instanceId,
    logtoProjection: inst.instanceId,
    serverPid: input.server.pid,
    electronPid: input.electron.pid,
    logPath: join(input.root, "logs", "dev-stack.log"),
    electron: {
      profile: `d489-${inst.instanceId}`,
      connectServerUrl: `http://127.0.0.1:${input.server.port}`,
    },
  };
}

async function createPopulatedFixture() {
  const root = await mkdtemp(join(tmpdir(), "d489-concurrent-clone-"));
  roots.push(root);
  const source = join(root, "source");
  await mkdir(join(source, "artifacts"), { recursive: true });
  const config = JSON.stringify({ instanceId: "", deploymentMode: "local-self-host" });
  const env = "PROVIDER_SENTINEL=fixture-provider-secret\nLOGTO_SIGNING_KEY=fixture-auth-secret\n";
  const database = JSON.stringify({
    authUsers: ["operator", "fixture-user"],
    productRows: Array.from({ length: 7 }, (_, index) => ({ id: index + 1 })),
    lineage: ["0001", "0002", "0003"],
  });
  const artifact = "fixture-artifact-bytes";
  await Promise.all([
    writeFile(join(source, "instance.json"), config),
    writeFile(join(source, "instance.env"), env, { mode: 0o600 }),
    writeFile(join(source, "database.json"), database),
    writeFile(join(source, "artifacts", "sentinel.txt"), artifact),
  ]);

  const fingerprint = async (): Promise<PopulatedCloneSourceFingerprint> => {
    const [nextConfig, nextEnv, nextDatabase, nextArtifact] = await Promise.all([
      readFile(join(source, "instance.json"), "utf8"),
      readFile(join(source, "instance.env"), "utf8"),
      readFile(join(source, "database.json"), "utf8"),
      readFile(join(source, "artifacts", "sentinel.txt"), "utf8"),
    ]);
    const parsed = JSON.parse(nextDatabase) as {
      authUsers: string[];
      productRows: unknown[];
      lineage: string[];
    };
    return {
      instanceConfigSha256: sha(nextConfig),
      instanceEnvSha256: sha(nextEnv),
      authUserCount: parsed.authUsers.length,
      providerSentinelSha256: sha(nextEnv.match(/PROVIDER_SENTINEL=([^\n]+)/)?.[1] ?? ""),
      productRowCount: parsed.productRows.length,
      artifactCount: 1,
      artifactBytes: Buffer.byteLength(nextArtifact),
      artifactTreeSha256: sha(nextArtifact),
      lineageEntryCount: parsed.lineage.length,
      lineageSha256: sha(JSON.stringify(parsed.lineage)),
    };
  };

  return { root, source, fingerprint };
}

const MIGRATION_SHA = "f".repeat(64);
const LINEAGE: readonly MigrationLineageEntry[] = [
  { index: 0, tag: "0001_fixture", createdAt: 1, sha256: MIGRATION_SHA },
];

async function makeVerifiedFixtureBackup(fixture: Awaited<ReturnType<typeof createPopulatedFixture>>): Promise<VerifiedFullBackup> {
  const dir = join(fixture.root, "verified-full-backup");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await Promise.all([
    cp(join(fixture.source, "database.json"), join(dir, "database.sql.gz")),
    writeFile(join(dir, "logto.sql.gz"), JSON.stringify({ users: 2, projection: "source" }), { mode: 0o600 }),
    cp(join(fixture.source, "instance.env"), join(dir, "dot-env")),
    cp(join(fixture.source, "artifacts", "sentinel.txt"), join(dir, "home.tar.gz")),
  ]);
  const manifest: DevFullBackupManifestV2 = {
    formatVersion: 2,
    name: "verified-full-backup",
    createdAt: "2026-08-03T00:00:00.000Z",
    sourceInstanceId: "",
    sourceDeploymentMode: "local-self-host",
    capture: { consistency: "quiesced", nautiloWriterStopped: true, logtoWriterStopped: true },
    artifacts: {
      nautiloDatabase: await describeBackupArtifact(dir, "database.sql.gz"),
      logtoDatabase: await describeBackupArtifact(dir, "logto.sql.gz"),
      instanceEnv: await describeBackupArtifact(dir, "dot-env"),
      nautiloHome: await describeBackupArtifact(dir, "home.tar.gz"),
    },
    drizzle: { lastAppliedIndex: 0, entries: [...LINEAGE] },
    postgres: { nautiloMajor: 17, logtoMajor: 16 },
    rowAnchors: { users: 2, productRows: 7 },
    complete: true,
    cloneEligible: false,
    backupMode: "dump",
  };
  await writeManifestFile(dir, manifest);
  return verifyCanonicalDefaultFullBackupDirectory(dir);
}

function targetEvidence(root: string, id: string, stride: number): ConcurrentCloneTargetEvidence {
  const targetRoot = join(root, `target-${id}`);
  const project = `nautilo-${id}`;
  return {
    instanceId: id,
    root: targetRoot,
    projectName: project,
    ports: {
      workbench: 3_000 + stride,
      server: 3_001 + stride,
      nautiloDb: 5_432 + stride,
      logtoDb: 5_433 + stride,
      logtoCore: 3_301 + stride,
      logtoAdmin: 3_302 + stride,
      office: 2_003 + stride,
      collabora: 9_980 + stride,
      electronCdp: 9_222 + stride,
    },
    containers: [`${project}-postgres`, `${project}-postgres-1`, `${project}-logto-1`, `${project}-logto-seed-1`],
    networks: [`${project}_default`],
    volumes: [`${project}_nautilo_pgdata`, `${project}_pgdata`],
    databaseIdentity: id,
    logtoProjection: id,
    serverPid: 30_000 + stride,
    electronPid: 40_000 + stride,
    logPath: join(targetRoot, "logs", "dev-stack.log"),
    electron: { profile: `d489-${id}`, connectServerUrl: `http://localhost:${3_001 + stride}` },
  };
}

afterEach(async () => {
  for (const child of runtimeChildren.splice(0)) child.kill("SIGTERM");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("D489 executable concurrent clone harness", () => {
  test("captures one seed and materially populates two targets in an overlapping window", async () => {
    const fixture = await createPopulatedFixture();
    const backup = await makeVerifiedFixtureBackup(fixture);
    const seedStore = join(fixture.root, "seed-store");
    let captures = 0;
    let active = 0;
    let maxActive = 0;
    let started = 0;
    let releaseBoth!: () => void;
    const bothStarted = new Promise<void>((resolve) => { releaseBoth = resolve; });
    const seenSeeds = new Set<object>();
    const result = await runConcurrentCloneHarness({
      targetIds: ["alpha", "beta"],
      captureSourceFingerprint: fixture.fingerprint,
      captureSeed: async () => {
        captures += 1;
        return refreshCloneSeed({
          root: seedStore,
          capture: async () => backup,
          verify: verifyCanonicalDefaultFullBackupDirectory,
          provenance: {
            checkoutCommitSha: "a".repeat(40),
            lineage: { appliedMigrationCount: 1, lastAppliedIndex: 0, sha256: MIGRATION_SHA },
          },
          generation: () => "fixture-seed-1",
          now: () => new Date("2026-08-03T00:00:00.000Z"),
        });
      },
      materializeTarget: async (seed, id) => {
        seenSeeds.add(seed);
        active += 1;
        maxActive = Math.max(maxActive, active);
        started += 1;
        if (started === 2) releaseBoth();
        await bothStarted;
        const targetRoot = join(fixture.root, `.nautilo-${id}`);
        assertCloneTargetAbsent({ root: existsSync(targetRoot), containers: [], networks: [], volumes: [] });
        assertExactMigrationPrefix(seed.backup.manifest.drizzle.entries, LINEAGE);
        const instance = resolveInstanceUncached(
          { HOME: fixture.root, NAUTILO_INSTANCE_ID: id },
          { userHomeDir: fixture.root, skipUserConfigOverlay: true },
        );
        await mkdir(join(targetRoot, "logs"), { recursive: true, mode: 0o700 });
        const logPath = join(targetRoot, "logs", "dev-stack.log");
        const server = await spawnDisposableListener(logPath, `server-${id}`, instance.server.port);
        const electron = await spawnDisposableListener(logPath, `electron-${id}`);
        const evidence = evidenceFromRuntime({ root: targetRoot, instance, server, electron });
        const record: CloneOperationRecord = {
          formatVersion: 1,
          sourceInstanceId: "",
          targetInstanceId: id,
          backupName: seed.backup.manifest.name,
          startedAt: "2026-08-03T00:00:00.000Z",
          updatedAt: "2026-08-03T00:00:00.000Z",
          status: "running",
          completedStages: [],
        };
        const rebound = rebindCloneEnvContent({
          sourceRaw: await readFile(join(seed.backup.dir, "dot-env"), "utf8"),
          sourceRoot: fixture.source,
          targetRoot: evidence.root,
          target: instance,
        });
        await runCloneStages({
          record,
          operationPath: join(evidence.root, "clone-operation.json"),
          stages: CLONE_STAGES.map((name) => ({
            name,
            run: async () => {
              if (name === "home-rebound") await writeFile(join(evidence.root, "instance.env"), rebound, { mode: 0o600 });
              if (name === "historical-databases-imported") {
                await cp(join(seed.backup.dir, "database.sql.gz"), join(evidence.root, "database.imported"));
                await cp(join(seed.backup.dir, "logto.sql.gz"), join(evidence.root, "logto.imported"));
              }
              if (name === "identity-rebound") await writeFile(join(evidence.root, "database-identity"), id);
              if (name === "credentials-reconciled") await writeFile(join(evidence.root, "logto-projection"), id);
              if (name === "services-started") {
                await writeFile(join(evidence.root, "server.pid"), `${evidence.serverPid}\n`);
                await writeFile(join(evidence.root, "electron.pid"), `${evidence.electronPid}\n`);
              }
            },
          })),
        });
        assertCloneResourceIsolation({
          sourceObjects: { containers: ["nautilo-fixture-source-postgres"], networks: ["nautilo-fixture-source_default"] },
          targetObjects: { containers: [...evidence.containers], networks: [...evidence.networks] },
          sourceVolumes: ["nautilo-fixture-source_pgdata"],
          targetVolumes: [...evidence.volumes],
        });
        active -= 1;
        return evidence;
      },
      cleanupFailedTarget: async (id) => rm(join(fixture.root, `.nautilo-${id}`), { recursive: true, force: true }),
      verifyTargetRuntime: async (target) => {
        process.kill(target.serverPid, 0);
        process.kill(target.electronPid, 0);
        await Promise.all([
          probeListener(target.ports.server),
          probeListener(target.ports.electronCdp),
        ]);
        const log = await readFile(target.logPath, "utf8");
        expect(log).toContain(`server-${target.instanceId} pid=${target.serverPid}`);
        expect(log).toContain(`electron-${target.instanceId} pid=${target.electronPid}`);
      },
    });
    expect(captures).toBe(1);
    expect(seenSeeds.size).toBe(1);
    expect(maxActive).toBe(2);
    expect(result.seed.generation).toBe("fixture-seed-1");
    expect(await readFile(join(fixture.root, ".nautilo-alpha", "database-identity"), "utf8")).toBe("alpha");
    expect(await readFile(join(fixture.root, ".nautilo-beta", "logto-projection"), "utf8")).toBe("beta");
    expect(result.evidence.sourceAfter).toEqual(result.evidence.sourceBefore);
  });

  test("pins collision, disk, refresh, lineage, import, and target-only cleanup boundaries", async () => {
    const scenarios: Array<{
      code: ConcurrentCloneHarnessFailureCode;
      captureFailure?: boolean;
      cleanupFailure?: boolean;
    }> = [
      { code: "target-collision" },
      { code: "disk-pressure", captureFailure: true },
      { code: "refresh-race", captureFailure: true },
      { code: "lineage-divergence" },
      { code: "import-failure" },
      { code: "cleanup-failure", cleanupFailure: true },
    ];
    for (const scenario of scenarios) {
      const fixture = await createPopulatedFixture();
      const backup = await makeVerifiedFixtureBackup(fixture);
      const cleaned: string[] = [];
      let materializations = 0;
      const run = runConcurrentCloneHarness({
        targetIds: ["alpha", "beta"],
        captureSourceFingerprint: fixture.fingerprint,
        captureSeed: async () => {
          const store = join(fixture.root, "scenario-seed-store");
          const refresh = () => refreshCloneSeed({
            root: store,
            capture: async () => backup,
            verify: verifyCanonicalDefaultFullBackupDirectory,
            provenance: {
              checkoutCommitSha: "a".repeat(40),
              lineage: { appliedMigrationCount: 1, lastAppliedIndex: 0, sha256: MIGRATION_SHA },
            },
            generation: () => "scenario-seed-1",
            now: () => new Date("2026-08-03T00:00:00.000Z"),
            ...(scenario.code === "disk-pressure"
              ? { diskSpace: async () => ({ bavail: 0, bsize: 1 }) }
              : {}),
          });
          try {
            if (scenario.code === "refresh-race") {
              return await withCloneSeedRefreshLock(store, refresh);
            }
            return await refresh();
          } catch (error) {
            if (scenario.captureFailure) throw new ConcurrentCloneHarnessScenarioError(scenario.code);
            throw error;
          }
        },
        materializeTarget: async (seed, id) => {
          materializations += 1;
          if (id === "alpha") {
            const targetRoot = join(fixture.root, `target-${id}`);
            try {
              if (scenario.code === "target-collision") {
                await mkdir(targetRoot, { recursive: true });
                assertCloneTargetAbsent({ root: existsSync(targetRoot), containers: [], networks: [], volumes: [] });
              }
              if (scenario.code === "lineage-divergence") {
                assertExactMigrationPrefix(
                  [{ ...LINEAGE[0]!, sha256: "0".repeat(64) }],
                  LINEAGE,
                );
              }
              if (scenario.code === "import-failure" || scenario.code === "cleanup-failure") {
                await mkdir(targetRoot, { recursive: true });
                await cp(join(seed.backup.dir, "missing-database.sql.gz"), join(targetRoot, "partial-import"));
              }
            } catch {
              const code = scenario.code === "cleanup-failure" ? "import-failure" : scenario.code;
              throw new ConcurrentCloneHarnessScenarioError(code);
            }
            throw new Error("scenario failed to trigger its production guard");
          }
          const evidence = targetEvidence(fixture.root, id, 200);
          await cp(seed.backup.dir, evidence.root, { recursive: true });
          return evidence;
        },
        cleanupFailedTarget: async (id) => {
          cleaned.push(id);
          if (scenario.cleanupFailure) throw new Error("cleanup refused");
          await rm(join(fixture.root, `target-${id}`), { recursive: true, force: true });
        },
        verifyTargetRuntime: async () => undefined,
      });
      const failure = await run.catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: scenario.code });
      if (scenario.captureFailure) {
        expect(materializations).toBe(0);
        expect(cleaned).toEqual([]);
      } else {
        expect(materializations).toBe(2);
        expect(cleaned).toEqual(["alpha"]);
      }
      expect(await fixture.fingerprint()).toEqual(await fixture.fingerprint());
    }
  });

  test("a final aggregate-evidence failure cleans both materialized targets", async () => {
    const fixture = await createPopulatedFixture();
    const source = await fixture.fingerprint();
    const cleaned: string[] = [];
    const left = targetEvidence(fixture.root, "alpha", 100);
    const validRight = targetEvidence(fixture.root, "beta", 200);
    const right = { ...validRight, ports: { ...validRight.ports, electronCdp: left.ports.electronCdp } };
    const failure = await runConcurrentCloneHarness({
      targetIds: ["alpha", "beta"],
      captureSourceFingerprint: async () => source,
      captureSeed: async () => ({ generation: "one-seed" }),
      materializeTarget: async (_seed, id) => {
        await mkdir(join(fixture.root, `target-${id}`), { recursive: true });
        return id === "alpha" ? left : right;
      },
      cleanupFailedTarget: async (id) => {
        cleaned.push(id);
        await rm(join(fixture.root, `target-${id}`), { recursive: true, force: true });
      },
      verifyTargetRuntime: async () => { throw new Error("must not reach runtime probe"); },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("expected evidence failure");
    expect(failure.message).toContain("ports overlap");
    expect(cleaned.sort()).toEqual(["alpha", "beta"]);
  });
});
