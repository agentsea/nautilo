import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  advanceD489StableReadiness,
  expectedD489ResourcePaths,
  hasD489NormalPostgresReadyLog,
  measureD489OwnedFilesystemBytes,
  parseD489DockerBytes,
  parseD489LoopbackMappedPort,
  parseD489OwnedDockerDiskReport,
  readD489ResourceJournal,
  type D489ResourceJournal,
} from "../integration/helpers/d489-disposable-resource-journal";

const runId = `d489-accept-${randomBytes(6).toString("hex")}`;
const expected = expectedD489ResourcePaths(runId);
const journal: D489ResourceJournal = {
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

describe("D489 disposable exact-resource journal (Docker-free)", () => {
  test("parses emitted SI and IEC byte units and rejects unknown evidence", () => {
    expect(parseD489DockerBytes("63B")).toBe(63);
    expect(parseD489DockerBytes("76.8MB")).toBe(76_800_000);
    expect(parseD489DockerBytes("1.5GiB")).toBe(1_610_612_736);
    expect(() => parseD489DockerBytes("N/A")).toThrow("Unrecognized Docker byte measurement");
  });

  test("does not admit the temporary init server as normal PostgreSQL readiness", () => {
    const ready = "database system is ready to accept connections";
    const initialized = "PostgreSQL init process complete; ready for start up.";
    expect(hasD489NormalPostgresReadyLog(ready)).toBe(false);
    expect(hasD489NormalPostgresReadyLog(`${ready}\n${initialized}`)).toBe(false);
    expect(hasD489NormalPostgresReadyLog(`${ready}\n${initialized}\n${ready}`)).toBe(true);
  });

  test("requires consecutive host probes and resets readiness after a refused probe", () => {
    expect(advanceD489StableReadiness(0, true)).toEqual({ consecutiveSuccesses: 1, ready: false });
    expect(advanceD489StableReadiness(1, false)).toEqual({ consecutiveSuccesses: 0, ready: false });
    expect(advanceD489StableReadiness(1, true)).toEqual({ consecutiveSuccesses: 2, ready: true });
    expect(() => advanceD489StableReadiness(0, true, 1)).toThrow("Invalid D489 stable-readiness state");
  });

  test("accepts only one explicit loopback port mapping so restart refresh cannot drift authority", () => {
    expect(parseD489LoopbackMappedPort("127.0.0.1:64219\n")).toBe(64219);
    expect(() => parseD489LoopbackMappedPort("0.0.0.0:64219\n")).toThrow("Invalid D489 loopback mapped port");
    expect(() => parseD489LoopbackMappedPort("127.0.0.1:1\n127.0.0.1:2\n")).toThrow("exactly one mapped port");
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
    expect(parseD489OwnedDockerDiskReport(report, journal)).toBe(3_297_152);
    expect(() => parseD489OwnedDockerDiskReport(JSON.stringify({ Containers: {}, Volumes: [] }), journal))
      .toThrow("Unsupported Docker disk report shape");
    expect(() => parseD489OwnedDockerDiskReport(JSON.stringify({ Containers: [], Volumes: [{ Name: expected.resources.volume, Size: "unknown" }] }), journal))
      .toThrow("Unrecognized Docker byte measurement");
  });

  test("measures exact owned files without following symlinks", () => {
    mkdirSync(expected.resources.filesRoot, { recursive: true, mode: 0o700 });
    writeFileSync(`${expected.resources.filesRoot}/evidence.bin`, "12345", { mode: 0o600 });
    expect(measureD489OwnedFilesystemBytes(journal)).toBe(5);
    rmSync(expected.resources.filesRoot, { recursive: true, force: true });
  });

  test("rejects a journal whose recursive target is not bound to the run ID", () => {
    mkdirSync(dirname(expected.journalPath), { recursive: true, mode: 0o700 });
    chmodSync(dirname(expected.journalPath), 0o700);
    writeFileSync(expected.journalPath, JSON.stringify({ ...journal, resources: { ...journal.resources, filesRoot: "/" } }), { mode: 0o600 });
    expect(() => readD489ResourceJournal(expected.journalPath)).toThrow("not bound to its run ID");
  });
});
