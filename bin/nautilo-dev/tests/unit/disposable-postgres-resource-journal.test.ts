import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  advanceDisposablePostgresStableReadiness,
  expectedDisposablePostgresResourcePaths,
  hasDisposablePostgresNormalPostgresReadyLog,
  measureDisposablePostgresOwnedFilesystemBytes,
  parseDisposablePostgresDockerBytes,
  parseDisposablePostgresLoopbackMappedPort,
  parseDisposablePostgresOwnedDockerDiskReport,
  readDisposablePostgresResourceJournal,
  type DisposablePostgresResourceJournal,
} from "../integration/helpers/disposable-postgres-resource-journal";

const runId = `disposable-accept-${randomBytes(6).toString("hex")}`;
const expected = expectedDisposablePostgresResourcePaths(runId);
const journal: DisposablePostgresResourceJournal = {
  version: 1, runId, ownerPid: process.pid, createdAt: new Date().toISOString(),
  image: { reference: "postgres:16", id: `sha256:${"a".repeat(64)}`, policy: "reuse-only-never-remove" },
  resources: expected.resources, processes: [],
  measurements: {
    beforeOwnedDockerBytes: 0, peakOwnedDockerBytes: null, afterOwnedDockerBytes: null,
    beforeOwnedFilesystemBytes: 0, peakOwnedFilesystemBytes: null, afterOwnedFilesystemBytes: null,
  },
};

afterAll(() => {
  rmSync(expected.journalPath, { force: true });
  rmSync(expected.resources.filesRoot, { recursive: true, force: true });
});

describe("Disposable PostgreSQL exact-resource journal (Docker-free)", () => {
  test("parses emitted SI and IEC byte units and rejects unknown evidence", () => {
    expect(parseDisposablePostgresDockerBytes("63B")).toBe(63);
    expect(parseDisposablePostgresDockerBytes("76.8MB")).toBe(76_800_000);
    expect(parseDisposablePostgresDockerBytes("1.5GiB")).toBe(1_610_612_736);
    expect(() => parseDisposablePostgresDockerBytes("N/A")).toThrow("Unrecognized Docker byte measurement");
  });

  test("does not admit the temporary init server as normal PostgreSQL readiness", () => {
    const ready = "database system is ready to accept connections";
    const initialized = "PostgreSQL init process complete; ready for start up.";
    expect(hasDisposablePostgresNormalPostgresReadyLog(ready)).toBe(false);
    expect(hasDisposablePostgresNormalPostgresReadyLog(`${ready}\n${initialized}`)).toBe(false);
    expect(hasDisposablePostgresNormalPostgresReadyLog(`${ready}\n${initialized}\n${ready}`)).toBe(true);
  });

  test("requires consecutive host probes and resets readiness after a refused probe", () => {
    expect(advanceDisposablePostgresStableReadiness(0, true)).toEqual({ consecutiveSuccesses: 1, ready: false });
    expect(advanceDisposablePostgresStableReadiness(1, false)).toEqual({ consecutiveSuccesses: 0, ready: false });
    expect(advanceDisposablePostgresStableReadiness(1, true)).toEqual({ consecutiveSuccesses: 2, ready: true });
    expect(() => advanceDisposablePostgresStableReadiness(0, true, 1)).toThrow("Invalid Disposable PostgreSQL stable-readiness state");
  });

  test("accepts only one explicit loopback port mapping so restart refresh cannot drift authority", () => {
    expect(parseDisposablePostgresLoopbackMappedPort("127.0.0.1:64219\n")).toBe(64219);
    expect(() => parseDisposablePostgresLoopbackMappedPort("0.0.0.0:64219\n")).toThrow("Invalid Disposable PostgreSQL loopback mapped port");
    expect(() => parseDisposablePostgresLoopbackMappedPort("127.0.0.1:1\n127.0.0.1:2\n")).toThrow("exactly one mapped port");
  });

  test("counts only exact owned rows and fails closed on report drift", () => {
    const report = JSON.stringify({
      Containers: [
        { Names: expected.resources.container, Size: "1.2MB" },
        { Names: `${expected.resources.container}-foreign`, Size: "9GB" },
      ],
      Volumes: [{ Name: expected.resources.volume, Size: "2MiB" }],
      Images: [], BuildCache: [],
    });
    expect(parseDisposablePostgresOwnedDockerDiskReport(report, journal)).toBe(3_297_152);
    expect(() => parseDisposablePostgresOwnedDockerDiskReport(JSON.stringify({ Containers: {}, Volumes: [] }), journal))
      .toThrow("Unsupported Docker disk report shape");
    expect(() => parseDisposablePostgresOwnedDockerDiskReport(JSON.stringify({ Containers: [], Volumes: [{ Name: expected.resources.volume, Size: "unknown" }] }), journal))
      .toThrow("Unrecognized Docker byte measurement");
  });

  test("measures exact owned files without following symlinks", () => {
    mkdirSync(expected.resources.filesRoot, { recursive: true, mode: 0o700 });
    writeFileSync(`${expected.resources.filesRoot}/evidence.bin`, "12345", { mode: 0o600 });
    expect(measureDisposablePostgresOwnedFilesystemBytes(journal)).toBe(5);
    rmSync(expected.resources.filesRoot, { recursive: true, force: true });
  });

  test("rejects a journal whose recursive target is not bound to the run ID", () => {
    mkdirSync(dirname(expected.journalPath), { recursive: true, mode: 0o700 });
    chmodSync(dirname(expected.journalPath), 0o700);
    writeFileSync(expected.journalPath, JSON.stringify({ ...journal, resources: { ...journal.resources, filesRoot: "/" } }), { mode: 0o600 });
    expect(() => readDisposablePostgresResourceJournal(expected.journalPath)).toThrow("not bound to its run ID");
  });
});
