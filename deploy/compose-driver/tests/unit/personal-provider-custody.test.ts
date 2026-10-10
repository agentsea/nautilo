/* eslint-disable @typescript-eslint/await-thenable -- Bun's expect().resolves/rejects is thenable, but the rule cannot infer that. */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import {
  PERSONAL_PROVIDER_CUSTODY_ENV,
  serializePersonalProviderCustody,
  type PersonalProviderCustody,
} from "@nautilo/operator-secrets";

import {
  assertPersonalProviderCustodyHealth,
  assertPersonalProviderRestoreCustody,
  buildAssertRemoteRestoreCustodyScript,
  buildEnsureRemotePersonalProviderCustodyScript,
  buildMergeRemoteCanonicalCustodyScript,
  buildPersonalProviderCustodyBackupEvidence,
  ensurePersonalProviderCustody,
  parseConnectedPersonalProviderCredentialEvidence,
  parseRemoteRestoreCustodyKeyId,
  readPersonalProviderCredentialEvidenceFromDump,
  readPersonalProviderCustodyFromEnv,
  setPersonalProviderCustodyInEnv,
  type EnsurePersonalProviderCustodyDeps,
} from "../../src/personal-provider-custody.ts";

const custody: PersonalProviderCustody = {
  formatVersion: 1,
  keyId: "123e4567-e89b-42d3-a456-426614174000",
  keyHex: "ab".repeat(32),
};
const lostKeyId = "223e4567-e89b-42d3-a456-426614174000";
const resetCustody: PersonalProviderCustody = {
  ...custody,
  resetFromKeyId: lostKeyId,
};

const createdPaths: string[] = [];
// These cases execute Linux-host durability operations, including sync on
// files and directories. Git Bash cannot provide the same fsync semantics.
const posixDurabilityTest = process.platform === "win32" ? test.skip : test;

afterEach(() => {
  for (const path of createdPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function fakeDeps(initial: string) {
  let raw = initial;
  const writeInstanceEnv = mock(async (_root: string, next: string) => {
    raw = next;
  });
  const deps: EnsurePersonalProviderCustodyDeps = {
    withProvisioningLock: async (_root, operation) => operation(),
    readInstanceEnv: async () => raw,
    writeInstanceEnv,
    createCustody: () => custody,
  };
  return { deps, writeInstanceEnv, raw: () => raw };
}

function dumpPath(sql: string): string {
  const root = mkdtempSync(join(tmpdir(), "nautilo-custody-dump-"));
  createdPaths.push(root);
  const path = join(root, "nautilo.sql.gz");
  writeFileSync(path, gzipSync(sql));
  return path;
}

describe("Compose personal provider custody", () => {
  test("reuses valid canonical custody without consulting the database", async () => {
    const initial = `${PERSONAL_PROVIDER_CUSTODY_ENV}=${serializePersonalProviderCustody(custody)}\n`;
    const { deps, writeInstanceEnv } = fakeDeps(initial);
    const inspectDatabase = mock(async () => ({ state: "rows" as const, keyIds: [custody.keyId] }));

    await expect(
      ensurePersonalProviderCustody(
        { instanceRootDir: "/instance", inspectDatabase },
        deps,
      ),
    ).resolves.toEqual(custody);
    expect(inspectDatabase).not.toHaveBeenCalled();
    expect(writeInstanceEnv).not.toHaveBeenCalled();
  });

  test("provisions once only after authoritative empty-database evidence", async () => {
    const { deps, writeInstanceEnv, raw } = fakeDeps("LOGTO_ENDPOINT=http://localhost\n");
    const inspectDatabase = mock(async () => ({ state: "empty" as const }));

    await expect(
      ensurePersonalProviderCustody(
        { instanceRootDir: "/instance", inspectDatabase },
        deps,
      ),
    ).resolves.toEqual(custody);
    expect(inspectDatabase).toHaveBeenCalledTimes(1);
    expect(writeInstanceEnv).toHaveBeenCalledTimes(1);
    expect(readPersonalProviderCustodyFromEnv(raw())).toEqual(custody);
  });

  test("does not turn credential rows or malformed custody into empty state", async () => {
    const missing = fakeDeps("");
    await expect(
      ensurePersonalProviderCustody(
        {
          instanceRootDir: "/instance",
          inspectDatabase: async () => ({ state: "rows", keyIds: [custody.keyId] }),
        },
        missing.deps,
      ),
    ).rejects.toThrow(/encrypted credentials exist/);
    expect(missing.writeInstanceEnv).not.toHaveBeenCalled();

    const malformed = fakeDeps(`${PERSONAL_PROVIDER_CUSTODY_ENV}=broken\n`);
    const inspectDatabase = mock(async () => ({ state: "empty" as const }));
    await expect(
      ensurePersonalProviderCustody(
        { instanceRootDir: "/instance", inspectDatabase },
        malformed.deps,
      ),
    ).rejects.toThrow(/custody_invalid/);
    expect(inspectDatabase).not.toHaveBeenCalled();
    expect(malformed.writeInstanceEnv).not.toHaveBeenCalled();
  });

  test("canonical env replacement removes duplicates and serializes one atomic value", () => {
    const raw = `A=1\n${PERSONAL_PROVIDER_CUSTODY_ENV}=old\n${PERSONAL_PROVIDER_CUSTODY_ENV}=older\n`;
    const updated = setPersonalProviderCustodyInEnv(raw, custody);
    expect(updated.match(new RegExp(`^${PERSONAL_PROVIDER_CUSTODY_ENV}=`, "gm"))).toHaveLength(1);
    expect(readPersonalProviderCustodyFromEnv(updated)).toEqual(custody);
  });

  test("parses table absence, empty tables, and row key identities from plain dumps", async () => {
    await expect(
      readPersonalProviderCredentialEvidenceFromDump(dumpPath("-- old schema\n")),
    ).resolves.toEqual({ state: "table-absent" });

    const header =
      "CREATE TABLE public.personal_provider_credentials (\n" +
      "    id uuid NOT NULL\n" +
      ");\n" +
      "COPY public.personal_provider_credentials (id, key_id) FROM stdin;\n";
    await expect(
      readPersonalProviderCredentialEvidenceFromDump(dumpPath(`${header}\\.\n`)),
    ).resolves.toEqual({ state: "empty" });
    await expect(
      readPersonalProviderCredentialEvidenceFromDump(
        dumpPath(`${header}record-id\t${custody.keyId}\n\\.\n`),
      ),
    ).resolves.toEqual({ state: "rows", keyIds: [custody.keyId] });
  });

  test("dump inspection rejects custom format, corrupt gzip, and truncated COPY data", async () => {
    await expect(
      readPersonalProviderCredentialEvidenceFromDump(dumpPath("PGDMP\u0001custom")),
    ).rejects.toThrow(/plain-format/);

    const corruptRoot = mkdtempSync(join(tmpdir(), "nautilo-custody-corrupt-"));
    createdPaths.push(corruptRoot);
    const corruptPath = join(corruptRoot, "nautilo.sql.gz");
    writeFileSync(corruptPath, "not gzip");
    await expect(
      readPersonalProviderCredentialEvidenceFromDump(corruptPath),
    ).rejects.toThrow();

    await expect(
      readPersonalProviderCredentialEvidenceFromDump(
        dumpPath(
          "CREATE TABLE public.personal_provider_credentials (\n" +
          "    id uuid NOT NULL\n" +
          ");\n" +
          "COPY public.personal_provider_credentials (id, key_id) FROM stdin;\n" +
          `record-id\t${custody.keyId}\n`,
        ),
      ),
    ).rejects.toThrow(/truncated/);
  });

  test("restore accepts matching custody and refuses missing or wrong custody", () => {
    const database = { state: "rows" as const, keyIds: [custody.keyId] };
    const env = `${PERSONAL_PROVIDER_CUSTODY_ENV}=${serializePersonalProviderCustody(custody)}\n`;
    const recorded = buildPersonalProviderCustodyBackupEvidence(database, env);
    expect(() =>
      assertPersonalProviderRestoreCustody({ database, instanceEnvRaw: env, recorded }),
    ).not.toThrow();
    expect(() =>
      assertPersonalProviderRestoreCustody({ database, instanceEnvRaw: undefined }),
    ).toThrow(/require matching custody/);
    expect(() =>
      assertPersonalProviderRestoreCustody({
        database,
        instanceEnvRaw: `${PERSONAL_PROVIDER_CUSTODY_ENV}=${serializePersonalProviderCustody({
          ...custody,
          keyId: "223e4567-e89b-42d3-a456-426614174000",
        })}\n`,
      }),
    ).toThrow(/does not match/);
  });

  test("connected evidence parser fails closed on missing, malformed, or inconsistent output", () => {
    expect(parseConnectedPersonalProviderCredentialEvidence("__NAUTILO_PERSONAL_PROVIDER_TABLE_ABSENT__\n"))
      .toEqual({ state: "table-absent" });
    expect(parseConnectedPersonalProviderCredentialEvidence('{"rowCount":0,"keyIds":[]}\n'))
      .toEqual({ state: "empty" });
    expect(() => parseConnectedPersonalProviderCredentialEvidence("\n")).toThrow(/no evidence/);
    expect(() =>
      parseConnectedPersonalProviderCredentialEvidence('{"rowCount":1,"keyIds":[]}\n'),
    ).toThrow(/incomplete/);
  });

  test("remote scripts keep secret bytes out of source and compare only opaque key identity", () => {
    const ensureScript = buildEnsureRemotePersonalProviderCustodyScript({
      canonicalInstanceEnvPath: "/srv/runtime-config/instance.env",
      serverEnvPath: "/srv/deploy.server.env",
      psqlCommand: "docker exec app-postgres psql",
    });
    expect(ensureScript).toContain("/proc/sys/kernel/random/uuid");
    expect(ensureScript).toContain("personal_provider_credentials");
    expect(ensureScript).not.toContain(custody.keyHex);

    const restoreScript = buildAssertRemoteRestoreCustodyScript({
      canonicalInstanceEnvPath: "/srv/runtime-config/instance.env",
      database: { state: "rows", keyIds: [custody.keyId] },
    });
    expect(restoreScript).toContain(custody.keyId);
    expect(restoreScript).not.toContain(custody.keyHex);
    const mergeScript = buildMergeRemoteCanonicalCustodyScript({
      canonicalInstanceEnvPath: "/srv/runtime-config/instance.env",
      incomingInstanceEnvPath: "/srv/runtime-config/instance.env.incoming",
      serverEnvPath: "/srv/deploy.server.env",
      incomingServerEnvPath: "/srv/deploy.server.env.incoming",
    });
    for (const script of [ensureScript, restoreScript, mergeScript]) {
      const syntax = Bun.spawnSync({ cmd: ["sh", "-n"], stdin: Buffer.from(script) });
      expect(syntax.exitCode, syntax.stderr.toString()).toBe(0);
    }
  });

  posixDurabilityTest("remote ensure accepts quoted legacy custody and preserves canonical bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "nautilo-custody-shell-"));
    createdPaths.push(root);
    const canonical = join(root, "instance.env");
    const server = join(root, "server.env");
    const serialized = serializePersonalProviderCustody(custody);
    const original = `A=1\n${PERSONAL_PROVIDER_CUSTODY_ENV}='${serialized}'\n`;
    writeFileSync(canonical, original);
    writeFileSync(server, `${PERSONAL_PROVIDER_CUSTODY_ENV}=stale\nB=2\n`);
    const script = buildEnsureRemotePersonalProviderCustodyScript({
      canonicalInstanceEnvPath: canonical,
      serverEnvPath: server,
      psqlCommand: "false",
    });

    const result = Bun.spawnSync({ cmd: ["sh", "-c", script] });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    await expect(Bun.file(canonical).text()).resolves.toBe(original);
    await expect(Bun.file(server).text()).resolves.toBe(
      `B=2\n${PERSONAL_PROVIDER_CUSTODY_ENV}=${serialized}\n`,
    );
  });

  posixDurabilityTest("remote ensure preserves and projects canonical disaster-reset custody", async () => {
    const root = mkdtempSync(join(tmpdir(), "nautilo-custody-reset-shell-"));
    createdPaths.push(root);
    const canonical = join(root, "instance.env");
    const server = join(root, "server.env");
    const serialized = serializePersonalProviderCustody(resetCustody);
    writeFileSync(canonical, `${PERSONAL_PROVIDER_CUSTODY_ENV}=${serialized}\n`);
    writeFileSync(server, "SERVER=1\n");
    const script = buildEnsureRemotePersonalProviderCustodyScript({
      canonicalInstanceEnvPath: canonical,
      serverEnvPath: server,
      psqlCommand: "false",
    });

    const result = Bun.spawnSync({ cmd: ["sh", "-c", script] });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    await expect(Bun.file(canonical).text()).resolves.toBe(
      `${PERSONAL_PROVIDER_CUSTODY_ENV}=${serialized}\n`,
    );
    await expect(Bun.file(server).text()).resolves.toBe(
      `SERVER=1\n${PERSONAL_PROVIDER_CUSTODY_ENV}=${serialized}\n`,
    );
  });

  posixDurabilityTest("remote ensure preserves invalid canonical custody and blanks only its runtime projection", async () => {
    for (const [name, configured] of [
      ["duplicate", `${PERSONAL_PROVIDER_CUSTODY_ENV}=${serializePersonalProviderCustody(custody)}\n${PERSONAL_PROVIDER_CUSTODY_ENV}=${serializePersonalProviderCustody(custody)}\n`],
      ["malformed", `${PERSONAL_PROVIDER_CUSTODY_ENV}=broken\n`],
    ] as const) {
      const root = mkdtempSync(join(tmpdir(), `nautilo-custody-${name}-`));
      createdPaths.push(root);
      const canonical = join(root, "instance.env");
      const server = join(root, "server.env");
      writeFileSync(canonical, configured);
      writeFileSync(server, "SERVER_ORIGINAL=1\n");
      const script = buildEnsureRemotePersonalProviderCustodyScript({
        canonicalInstanceEnvPath: canonical,
        serverEnvPath: server,
        psqlCommand: "false",
      });

      const result = Bun.spawnSync({ cmd: ["sh", "-c", script] });
      expect(result.exitCode).not.toBe(0);
      await expect(Bun.file(canonical).text()).resolves.toBe(configured);
      await expect(Bun.file(server).text()).resolves.toBe(
        `SERVER_ORIGINAL=1\n${PERSONAL_PROVIDER_CUSTODY_ENV}=\n`,
      );
    }
  });

  posixDurabilityTest("remote ensure blocks a stale runtime projection when canonical custody is unreadable", async () => {
    const root = mkdtempSync(join(tmpdir(), "nautilo-custody-unreadable-"));
    createdPaths.push(root);
    const canonical = join(root, "instance.env");
    const server = join(root, "server.env");
    mkdirSync(canonical);
    writeFileSync(
      server,
      `${PERSONAL_PROVIDER_CUSTODY_ENV}=${serializePersonalProviderCustody(custody)}\nSERVER_ORIGINAL=1\n`,
    );
    const script = buildEnsureRemotePersonalProviderCustodyScript({
      canonicalInstanceEnvPath: canonical,
      serverEnvPath: server,
      psqlCommand: "false",
    });

    const result = Bun.spawnSync({ cmd: ["sh", "-c", script] });
    expect(result.exitCode).not.toBe(0);
    await expect(Bun.file(server).text()).resolves.toBe(
      `SERVER_ORIGINAL=1\n${PERSONAL_PROVIDER_CUSTODY_ENV}=\n`,
    );
  });

  posixDurabilityTest("remote first-install merge accepts missing custody and keeps projection blocked", async () => {
    const root = mkdtempSync(join(tmpdir(), "nautilo-custody-merge-missing-"));
    createdPaths.push(root);
    const canonical = join(root, "instance.env");
    const incoming = join(root, "instance.env.incoming");
    const server = join(root, "server.env");
    const incomingServer = join(root, "server.env.incoming");
    writeFileSync(canonical, "CANONICAL=1\n");
    writeFileSync(incoming, "INCOMING=1\n");
    writeFileSync(incomingServer, `${PERSONAL_PROVIDER_CUSTODY_ENV}=stale\nSERVER=1\n`);
    const script = buildMergeRemoteCanonicalCustodyScript({
      canonicalInstanceEnvPath: canonical,
      incomingInstanceEnvPath: incoming,
      serverEnvPath: server,
      incomingServerEnvPath: incomingServer,
    });

    const result = Bun.spawnSync({ cmd: ["sh", "-c", script] });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    await expect(Bun.file(canonical).text()).resolves.toBe("INCOMING=1\n");
    await expect(Bun.file(server).text()).resolves.toBe(
      `SERVER=1\n${PERSONAL_PROVIDER_CUSTODY_ENV}=\n`,
    );
  });

  test("restore identity script accepts quoted custody and rejects duplicates", () => {
    const root = mkdtempSync(join(tmpdir(), "nautilo-custody-restore-shell-"));
    createdPaths.push(root);
    const canonical = join(root, "instance.env");
    const serialized = serializePersonalProviderCustody(custody);
    const build = () => buildAssertRemoteRestoreCustodyScript({
      canonicalInstanceEnvPath: canonical,
      database: { state: "rows", keyIds: [custody.keyId] },
    });

    writeFileSync(canonical, `${PERSONAL_PROVIDER_CUSTODY_ENV}='${serialized}'\n`);
    expect(Bun.spawnSync({ cmd: ["sh", "-c", build()] }).exitCode).toBe(0);
    writeFileSync(
      canonical,
      `${PERSONAL_PROVIDER_CUSTODY_ENV}=${serialized}\n${PERSONAL_PROVIDER_CUSTODY_ENV}=${serialized}\n`,
    );
    expect(Bun.spawnSync({ cmd: ["sh", "-c", build()] }).exitCode).not.toBe(0);
  });

  test("remote restore preflight admits only current and retained lost-key rows", () => {
    const root = mkdtempSync(join(tmpdir(), "nautilo-custody-reset-restore-shell-"));
    createdPaths.push(root);
    const canonical = join(root, "instance.env");
    writeFileSync(
      canonical,
      `${PERSONAL_PROVIDER_CUSTODY_ENV}=${serializePersonalProviderCustody(resetCustody)}\n`,
    );
    const accepted = buildAssertRemoteRestoreCustodyScript({
      canonicalInstanceEnvPath: canonical,
      database: { state: "rows", keyIds: [lostKeyId, custody.keyId] },
    });
    const acceptedResult = Bun.spawnSync({ cmd: ["sh", "-c", accepted] });
    expect(acceptedResult.exitCode, acceptedResult.stderr.toString()).toBe(0);
    expect(parseRemoteRestoreCustodyKeyId(acceptedResult.stdout.toString())).toBe(
      custody.keyId,
    );

    const unrelated = buildAssertRemoteRestoreCustodyScript({
      canonicalInstanceEnvPath: canonical,
      database: {
        state: "rows",
        keyIds: ["323e4567-e89b-42d3-a456-426614174000"],
      },
    });
    expect(Bun.spawnSync({ cmd: ["sh", "-c", unrelated] }).exitCode).not.toBe(0);
  });

  posixDurabilityTest("remote config merge preserves disaster-reset custody", async () => {
    const root = mkdtempSync(join(tmpdir(), "nautilo-custody-reset-merge-"));
    createdPaths.push(root);
    const canonical = join(root, "instance.env");
    const incoming = join(root, "instance.env.incoming");
    const server = join(root, "server.env");
    const incomingServer = join(root, "server.env.incoming");
    const serialized = serializePersonalProviderCustody(resetCustody);
    writeFileSync(canonical, `${PERSONAL_PROVIDER_CUSTODY_ENV}=${serialized}\nCANONICAL=1\n`);
    writeFileSync(incoming, "INCOMING=1\n");
    writeFileSync(incomingServer, "SERVER=1\n");
    const script = buildMergeRemoteCanonicalCustodyScript({
      canonicalInstanceEnvPath: canonical,
      incomingInstanceEnvPath: incoming,
      serverEnvPath: server,
      incomingServerEnvPath: incomingServer,
    });

    const result = Bun.spawnSync({ cmd: ["sh", "-c", script] });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    await expect(Bun.file(canonical).text()).resolves.toBe(
      `INCOMING=1\n${PERSONAL_PROVIDER_CUSTODY_ENV}=${serialized}\n`,
    );
    await expect(Bun.file(server).text()).resolves.toBe(
      `SERVER=1\n${PERSONAL_PROVIDER_CUSTODY_ENV}=${serialized}\n`,
    );
  });

  test("post-restore health evidence requires ready authenticated rows and matching identity", () => {
    expect(
      assertPersonalProviderCustodyHealth(
        JSON.stringify({ status: "ready", recordsExist: true, keyId: custody.keyId }),
        custody.keyId,
      ),
    ).toEqual({ status: "ready", recordsExist: true, keyId: custody.keyId });
    for (const raw of [
      "not-json",
      JSON.stringify({ status: "unavailable", recordsExist: true, keyId: custody.keyId }),
      JSON.stringify({ status: "ready", recordsExist: false, keyId: custody.keyId }),
      JSON.stringify({
        status: "ready",
        recordsExist: true,
        keyId: "223e4567-e89b-42d3-a456-426614174000",
      }),
    ]) {
      expect(() => assertPersonalProviderCustodyHealth(raw, custody.keyId)).toThrow(
        /custody verification failed/,
      );
    }
  });
});
