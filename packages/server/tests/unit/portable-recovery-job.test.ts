import { describe, expect, test } from "bun:test";
import {
  runPortableRecoveryJob,
  type PortableRecoveryChild,
  type PortableRecoveryFilesystem,
  type PortableRecoveryObjectStore,
  type PortableRecoveryProcessRunner,
} from "../../src/maintenance/portable-recovery-job";
import { PORTABLE_RECOVERY_MEMBERS, writePortableRecovery } from "../../src/maintenance/portable-recovery-container";

const encoder = new TextEncoder();
const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const env = {
  s3Endpoint: "https://s3.example.test", s3Region: "test", s3Bucket: "test-bucket", s3AccessKeyId: "access", s3SecretAccessKey: "secret",
  key, sourceReleaseId: "release-test", appDatabaseUrl: "postgres://app:pa%3Ass@app-db:5432/nautilo", logtoDatabaseUrl: "postgres://logto:pw@logto-db:5432/logto_nautilo",
} as const;

async function* bytes(value: string): AsyncIterable<Uint8Array> { yield encoder.encode(value); }
function child(value = ""): PortableRecoveryChild { return { stdout: bytes(value), completed: Promise.resolve() }; }

interface FakeFilesystem extends PortableRecoveryFilesystem {
  simulateHardKillAfterFirstPromotion(): void;
  writtenBytes(): readonly Uint8Array[];
}

function fakeFs(events: string[], failPromotionOnce = false): FakeFilesystem {
  const files = new Map<string, Uint8Array>();
  const written: Uint8Array[] = [];
  const directories = new Set(["/volume"]);
  let promotionFailed = false;
  return {
    root: "/volume",
    exists: async (path) => files.has(path) || directories.has(path),
    lstat: async (path) => ({ isDirectory: directories.has(path), isFile: files.has(path), isSymbolicLink: false, isSocket: false, isBlockDevice: false, isCharacterDevice: false, isFIFO: false }),
    readdir: async (path) => [...directories, ...files.keys()].filter((candidate) => candidate.startsWith(`${path}/`) && !candidate.slice(path.length + 1).includes("/")).map((candidate) => candidate.slice(path.length + 1)),
    mkdir: async (path) => { directories.add(path); events.push(`mkdir:${path}`); },
    mkdtemp: async (path) => path,
    chmod: async () => undefined,
    writeFile: async (path, value) => { files.set(path, value); written.push(value); events.push(`write:${path}`); },
    appendFile: async (path, value) => { const old = files.get(path) ?? new Uint8Array(); const joined = new Uint8Array(old.length + value.length); joined.set(old); joined.set(value, old.length); files.set(path, joined); },
    readFile: async (path) => files.get(path) ?? new Uint8Array(),
    rename: async (from, to) => { if (failPromotionOnce && !promotionFailed && from.includes("/roots/media/media") && to === "/volume/media") { promotionFailed = true; throw new Error("interrupted promotion"); } const content = files.get(from); if (content !== undefined) { files.delete(from); files.set(to, content); } if (directories.delete(from)) directories.add(to); events.push(`rename:${from}:${to}`); },
    remove: async (path) => { for (const key of [...files.keys()]) if (key === path || key.startsWith(`${path}/`)) files.delete(key); for (const key of [...directories]) if (key === path || key.startsWith(`${path}/`)) directories.delete(key); events.push(`remove:${path}`); },
    removeEmptyDirectory: async (path) => { directories.delete(path); events.push(`rmdir:${path}`); },
    syncFile: async (path) => { events.push(`sync:${path}`); },
    syncDirectory: async (path) => { events.push(`syncdir:${path}`); },
    simulateHardKillAfterFirstPromotion: () => {
      directories.add("/volume/artifacts");
      files.set("/volume/artifacts/persisted-after-kill", encoder.encode("partial"));
      for (const path of [...directories]) if (path.startsWith("/volume/.portable-recovery/op/object/roots/artifacts")) directories.delete(path);
    },
    writtenBytes: () => written,
  };
}

const APP_RESTORE_TOC = [
  "; Archive created at 2026-08-16 00:00:00 UTC",
  "3; 3079 18488 EXTENSION - pg_trgm ",
  "6831; 0 0 COMMENT - EXTENSION pg_trgm ",
  "2; 3079 16388 EXTENSION - vector ",
  "6832; 0 0 COMMENT - EXTENSION vector ",
  "100; 1259 20000 TABLE public profiles nautilo",
  "",
].join("\n");

function runner(events: string[], appRestoreToc = APP_RESTORE_TOC): PortableRecoveryProcessRunner {
  return {
    start: async (input) => {
      events.push(`${input.command}:${input.args.join("|")}`);
      expect(input.args.join(" ")).not.toContain("postgres://");
      expect(input.args.join(" ")).not.toContain("pa:ss");
      expect(input.env["PGPASSFILE"] ?? "").not.toContain("pa:ss");
      if (input.command === "tar" && input.args.includes("--list")) {
        const archive = input.args.at(-1) ?? "";
        const root = archive.includes("media.tar") ? "media" : archive.includes("apps.tar") ? "apps" : "artifacts";
        return child(`drwxr-xr-x 0/0               0 1970-01-01 00:00:00 ${root}/\n-rw-r--r-- 0/0               0 1970-01-01 00:00:00 ${root}/file with spaces\n`);
      }
      if (input.command === "pg_restore" && input.args.includes("--list")) return child(appRestoreToc);
      return child();
    },
  };
}

async function sealedBundle(): Promise<{ readonly body: Uint8Array; readonly receipt: { readonly ciphertextSha256: string; readonly ciphertextBytes: number } }> {
  const writer = writePortableRecovery({ key, nonceSeed: new Uint8Array(32).fill(7), sourceRelease: "release-test", members: PORTABLE_RECOVERY_MEMBERS.map((name) => ({ name, chunks: bytes("") })) });
  const chunks: Uint8Array[] = [];
  for await (const chunk of writer.stream) chunks.push(chunk);
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const body = new Uint8Array(length); let at = 0;
  for (const chunk of chunks) { body.set(chunk, at); at += chunk.length; }
  return { body, receipt: await writer.completion };
}

function restoreEnvironment(ciphertextSha256: string) {
  return { ...env, expectedCiphertextSha256: ciphertextSha256 };
}

describe("portable recovery image job", () => {
  test("rejects a symlink or FIFO source root before its tar child can start", async () => {
    for (const unsafe of ["isSymbolicLink", "isFIFO"] as const) {
      const events: string[] = [];
      const base = fakeFs(events);
      const fs: PortableRecoveryFilesystem = {
        ...base,
        exists: async (path) => path === "/volume/artifacts" || base.exists(path),
        lstat: async (path) => path === "/volume/artifacts"
          ? { isDirectory: false, isFile: false, isSymbolicLink: unsafe === "isSymbolicLink", isSocket: false, isBlockDevice: false, isCharacterDevice: false, isFIFO: unsafe === "isFIFO" }
          : base.lstat(path),
      };
      const storage: PortableRecoveryObjectStore = { publish: async () => { throw new Error("must not publish"); }, download: async () => { throw new Error("not used"); } };
      // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's rejection matcher must settle before the causal assertion below.
      await expect(runPortableRecoveryJob({ direction: "export", operationId: "op", objectId: "object", environment: env, fs, runner: runner(events), storage, assertFreshTarget: { assertFresh: async () => undefined } })).rejects.toMatchObject({ code: "UNSAFE_VOLUME" });
      expect(events.filter((event) => event.startsWith("tar:"))).toEqual([]);
    }
  });

  test("rejects an invalid source release before runner or object storage use", async () => {
    const events: string[] = [];
    let published = false;
    const storage: PortableRecoveryObjectStore = { publish: async () => { published = true; throw new Error("not used"); }, download: async () => { throw new Error("not used"); } };
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's rejection matcher must settle before the causal assertion below.
    await expect(runPortableRecoveryJob({ direction: "export", operationId: "op", objectId: "object", environment: { ...env, sourceReleaseId: "not safe" }, fs: fakeFs(events), runner: runner(events), storage, assertFreshTarget: { assertFresh: async () => undefined } })).rejects.toMatchObject({ code: "INVALID_ENVIRONMENT" });
    expect(events).toEqual([]);
    expect(published).toBeFalse();
  });

  test("writes escaped pgpass authority without leaking it into child args or env", async () => {
    const events: string[] = [];
    const fs = fakeFs(events);
    const databaseUrl = "postgres://app:one%3Atwo%5Cthree@app-db:5432/nautilo";
    const storage: PortableRecoveryObjectStore = {
      publish: async ({ bundle, receipt }) => { for await (const _chunk of bundle) { /* consume */ } const done = await receipt; return { format: "nautilo-recovery-v1", version: 1, operationId: "op", objectId: "object", sourceReleaseId: "release-test", completedAt: new Date(0).toISOString(), ...done }; },
      download: async () => { throw new Error("not used"); },
    };
    await runPortableRecoveryJob({ direction: "export", operationId: "op", objectId: "object", environment: { ...env, appDatabaseUrl: databaseUrl }, fs, runner: runner(events), storage, assertFreshTarget: { assertFresh: async () => undefined } });
    const pgpass = fs.writtenBytes().map((value) => new TextDecoder().decode(value)).find((value) => value.includes("app-db"));
    expect(pgpass).toBe("app-db:5432:nautilo:app:one\\:two\\\\three\n");
    expect(events.join("\n")).not.toContain("one:two");
    expect(events.join("\n")).not.toContain("postgres://");
  });

  test("exports fixed members sequentially and never passes DB authority in child argv", async () => {
    const events: string[] = [];
    const storage: PortableRecoveryObjectStore = {
      publish: async ({ bundle, receipt }) => {
        for await (const _chunk of bundle) { /* consume stream */ }
        const done = await receipt;
        return { format: "nautilo-recovery-v1", version: 1, operationId: "op", objectId: "object", sourceReleaseId: "release-test", completedAt: new Date(0).toISOString(), ...done };
      },
      download: async () => { throw new Error("not used"); },
    };
    await runPortableRecoveryJob({ direction: "export", operationId: "op", objectId: "object", environment: env, fs: fakeFs(events), runner: runner(events), storage, assertFreshTarget: { assertFresh: async () => undefined }, random: () => new Uint8Array(32).fill(3) });
    const children = events.filter((entry) => /^(pg_dump(?:16)?|tar):/.test(entry));
    expect(children.map((entry) => entry.split(":")[0])).toEqual(["pg_dump", "pg_dump16", "tar", "tar", "tar"]);
    expect(children.filter((entry) => entry.startsWith("pg_dump:"))).toEqual([
      "pg_dump:--format=custom|--no-owner|--no-privileges",
    ]);
    expect(children.filter((entry) => entry.startsWith("pg_dump16:"))).toEqual([
      "pg_dump16:--format=custom|--no-owner|--no-privileges",
    ]);
  });

  test("verifies sealed source before DB mutation, then repairs app and Logto before promotion", async () => {
    const events: string[] = [];
    const sealed = await sealedBundle();
    const storage: PortableRecoveryObjectStore = {
      publish: async () => { throw new Error("not used"); },
      download: async () => ({ descriptor: { format: "nautilo-recovery-v1", version: 1, operationId: "op", objectId: "object", sourceReleaseId: "release-test", completedAt: new Date(0).toISOString(), ...sealed.receipt }, body: bytesFrom(sealed.body) }),
    };
    await runPortableRecoveryJob({ direction: "restore", operationId: "op", objectId: "object", environment: restoreEnvironment(sealed.receipt.ciphertextSha256), fs: fakeFs(events), runner: runner(events), storage, assertFreshTarget: { assertFresh: async () => { events.push("fresh"); } } });
    const pg = events.filter((entry) => /^(pg_restore|pg_restore16|psql|psql16):/.test(entry));
    expect(pg[0]).toContain("psql:");
    expect(pg[0]).toContain("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    expect(pg[1]).toContain("pg_restore:--list|");
    expect(pg[2]).toContain("pg_restore:--single-transaction|--exit-on-error");
    expect(pg[2]).toContain("--no-owner|--no-privileges|--role=nautilo|--use-list|");
    expect(pg[3]).toContain("psql:");
    expect(pg[4]).toContain("pg_restore16:");
    expect(pg[4]).toContain("--no-owner|--no-privileges|--role=logto|--dbname");
    expect(pg.slice(5).every((entry) => entry.startsWith("psql16:"))).toBeTrue();
    expect(pg.slice(5)).toHaveLength(2);
    expect(events.findIndex((entry) => entry.startsWith("rename:") && entry.includes("/roots/"))).toBeGreaterThan(events.findIndex((entry) => entry.startsWith("psql:")));
  });

  test("rejects an unreviewed app extension before role-scoped restore", async () => {
    const events: string[] = [];
    const sealed = await sealedBundle();
    const storage: PortableRecoveryObjectStore = {
      publish: async () => { throw new Error("not used"); },
      download: async () => ({ descriptor: { format: "nautilo-recovery-v1", version: 1, operationId: "op", objectId: "object", sourceReleaseId: "release-test", completedAt: new Date(0).toISOString(), ...sealed.receipt }, body: bytesFrom(sealed.body) }),
    };
    const hostileToc = APP_RESTORE_TOC.replace("EXTENSION - vector", "EXTENSION - hostile_extension");
    let failure: unknown;
    try {
      await runPortableRecoveryJob({ direction: "restore", operationId: "op", objectId: "object", environment: restoreEnvironment(sealed.receipt.ciphertextSha256), fs: fakeFs(events), runner: runner(events, hostileToc), storage, assertFreshTarget: { assertFresh: async () => undefined } });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "VERIFICATION_FAILED" });
    expect(events.filter((entry) => entry.startsWith("pg_restore:--single-transaction"))).toEqual([]);
  });

  test("rejects a descriptor source-release mismatch before the fresh precondition or child process", async () => {
    const events: string[] = [];
    const storage: PortableRecoveryObjectStore = {
      publish: async () => { throw new Error("not used"); },
      download: async () => ({ descriptor: { format: "nautilo-recovery-v1", version: 1, operationId: "op", objectId: "object", sourceReleaseId: "wrong", completedAt: new Date(0).toISOString(), ciphertextSha256: "a".repeat(64), ciphertextBytes: 1 }, body: bytes("") }),
    };
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's rejection matcher must settle before the causal assertion below.
    await expect(runPortableRecoveryJob({ direction: "restore", operationId: "op", objectId: "object", environment: restoreEnvironment("b".repeat(64)), fs: fakeFs(events), runner: runner(events), storage, assertFreshTarget: { assertFresh: async () => { events.push("fresh"); } } })).rejects.toMatchObject({ code: "VERIFICATION_FAILED" });
    expect(events).toEqual(["fresh", "fresh"]);
  });

  test("retains a durable verified stage and completes the same operation after promotion interruption", async () => {
    const events: string[] = [];
    const sealed = await sealedBundle();
    const descriptor = { format: "nautilo-recovery-v1" as const, version: 1 as const, operationId: "op", objectId: "object", sourceReleaseId: "release-test", completedAt: new Date(0).toISOString(), ...sealed.receipt };
    const storage: PortableRecoveryObjectStore = {
      publish: async () => { throw new Error("not used"); },
      observe: async () => ({ state: "complete", descriptor }),
      download: async () => ({ descriptor, body: bytesFrom(sealed.body) }),
    };
    const fs = fakeFs(events, true);
    let fresh = 0;
    const input = { direction: "restore" as const, operationId: "op", objectId: "object", environment: restoreEnvironment(sealed.receipt.ciphertextSha256), fs, runner: runner(events), storage, assertFreshTarget: { assertFresh: async () => { fresh += 1; } } };
    try {
      await runPortableRecoveryJob(input);
      throw new Error("expected promotion failure");
    } catch (cause) {
      expect(cause).toMatchObject({ code: "PROMOTION_FAILED" });
    }
    await runPortableRecoveryJob(input);
    expect(fresh).toBe(2);
    expect(events.filter((entry) => entry === "syncdir:/volume/.portable-recovery/op/object").length).toBeGreaterThan(0);
    expect(events.filter((entry) => entry === "rename:/volume/.portable-recovery/op/object/roots/apps/apps:/volume/apps").length).toBe(1);
  });

  test("reconstructs a verified stage after a hard kill leaves a nonempty promoted root", async () => {
    const events: string[] = [];
    const sealed = await sealedBundle();
    const descriptor = { format: "nautilo-recovery-v1" as const, version: 1 as const, operationId: "op", objectId: "object", sourceReleaseId: "release-test", completedAt: new Date(0).toISOString(), ...sealed.receipt };
    const storage: PortableRecoveryObjectStore = { publish: async () => { throw new Error("not used"); }, observe: async () => ({ state: "complete", descriptor }), download: async () => ({ descriptor, body: bytesFrom(sealed.body) }) };
    const fs = fakeFs(events, true);
    let fresh = 0;
    const input = { direction: "restore" as const, operationId: "op", objectId: "object", environment: restoreEnvironment(sealed.receipt.ciphertextSha256), fs, runner: runner(events), storage, assertFreshTarget: { assertFresh: async () => { fresh += 1; } } };
    try { await runPortableRecoveryJob(input); } catch { /* simulates a job interrupted during promotion. */ }
    fs.simulateHardKillAfterFirstPromotion();
    await runPortableRecoveryJob(input);
    expect(fresh).toBe(2);
    expect(events).toContain("remove:/volume/artifacts");
    expect(events).toContain("remove:/volume/.portable-recovery/op/object/roots");
  });

  test("publishes success only after promotions are durable and then makes retry an immediate success", async () => {
    const events: string[] = [];
    const sealed = await sealedBundle();
    const descriptor = { format: "nautilo-recovery-v1" as const, version: 1 as const, operationId: "op", objectId: "object", sourceReleaseId: "release-test", completedAt: new Date(0).toISOString(), ...sealed.receipt };
    const storage: PortableRecoveryObjectStore = { publish: async () => { throw new Error("not used"); }, observe: async () => ({ state: "complete", descriptor }), download: async () => ({ descriptor, body: bytesFrom(sealed.body) }) };
    const fs = fakeFs(events);
    let fresh = 0;
    const input = { direction: "restore" as const, operationId: "op", objectId: "object", environment: restoreEnvironment(sealed.receipt.ciphertextSha256), fs, runner: runner(events), storage, assertFreshTarget: { assertFresh: async () => { fresh += 1; } } };
    await runPortableRecoveryJob(input);
    const successWrite = events.indexOf("write:/volume/.portable-recovery-success/op/object.json.next");
    expect(successWrite).toBeGreaterThan(events.lastIndexOf("syncdir:/volume/artifacts"));
    expect(events.indexOf("remove:/volume/.portable-recovery/op/object")).toBeGreaterThan(successWrite);
    const afterFirst = events.length;
    await runPortableRecoveryJob(input);
    expect(fresh).toBe(2);
    expect(events.slice(afterFirst).filter((entry) => /^(pg_restore|psql|tar):/.test(entry))).toEqual([]);
  });

  test("never takes a success-marker shortcut for a wrong source release or descriptor identity", async () => {
    const events: string[] = [];
    const sealed = await sealedBundle();
    const descriptor = { format: "nautilo-recovery-v1" as const, version: 1 as const, operationId: "op", objectId: "object", sourceReleaseId: "release-test", completedAt: new Date(0).toISOString(), ...sealed.receipt };
    const fs = fakeFs(events);
    const input = { direction: "restore" as const, operationId: "op", objectId: "object", environment: restoreEnvironment(sealed.receipt.ciphertextSha256), fs, runner: runner(events), assertFreshTarget: { assertFresh: async () => undefined } };
    const goodStorage: PortableRecoveryObjectStore = { publish: async () => { throw new Error("not used"); }, observe: async () => ({ state: "complete", descriptor }), download: async () => ({ descriptor, body: bytesFrom(sealed.body) }) };
    await runPortableRecoveryJob({ ...input, storage: goodStorage });
    for (const hostileDescriptor of [
      { ...descriptor, sourceReleaseId: "wrong-release" },
      { ...descriptor, objectId: "wrong-object" },
    ]) {
      const storage: PortableRecoveryObjectStore = { publish: async () => { throw new Error("not used"); }, observe: async () => ({ state: "complete", descriptor: hostileDescriptor }), download: async () => { throw new Error("must not download"); } };
      // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's matcher settles the rejection before continuing the adversarial loop.
      await expect(runPortableRecoveryJob({ ...input, storage })).rejects.toMatchObject({ code: "VERIFICATION_FAILED" });
    }
  });
});

async function* bytesFrom(value: Uint8Array): AsyncIterable<Uint8Array> { yield value; }
