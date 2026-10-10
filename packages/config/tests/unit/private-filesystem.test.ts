import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as childProcess from "node:child_process";
import { createPrivateDirectorySync, ensurePrivateDirectory, ensurePrivateDirectorySync, isOwnedFilesystemPathAsync, isPrivateFilesystemPath, secureFilesystemPath, secureFilesystemPathSync, writePrivateFileExclusive, writePrivateFileExclusiveSync } from "../../src/private-filesystem";
import { allowOtherReadersSync } from "../../src/private-filesystem-fixtures";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "nautilo-private-files-"));
  roots.push(root);
  return root;
}

test("private filesystem operations require an explicit absolute target", () => {
  expect(isPrivateFilesystemPath("relative-file")).toBe(false);
  expect(() => secureFilesystemPathSync("relative-file")).toThrow();
  expect(() => createPrivateDirectorySync("relative-directory")).toThrow();
  expect(() => writePrivateFileExclusiveSync("relative-file", Buffer.from("secret"))).toThrow();
});

test("async private filesystem operations reject relative targets before I/O", async () => {
  const results = await Promise.allSettled([
    ensurePrivateDirectory("relative-directory"),
    secureFilesystemPath("relative-file"),
    writePrivateFileExclusive("relative-file", Buffer.from("secret")),
  ]);
  for (const result of results) expect(result).toMatchObject({ status: "rejected", reason: { code: "EINVAL" } });
});

test("creates private directories exclusively and rejects directory aliases", async () => {
  const root = fixture();
  secureFilesystemPathSync(root);
  expect(isPrivateFilesystemPath(root)).toBe(true);
  expect(await isOwnedFilesystemPathAsync(root)).toBe(true);
  const directory = join(root, "private");
  createPrivateDirectorySync(directory);
  expect(isPrivateFilesystemPath(directory)).toBe(true);
  expect(() => createPrivateDirectorySync(directory)).toThrow();
  const alias = join(root, "alias");
  symlinkSync(directory, alias, process.platform === "win32" ? "junction" : "dir");
  expect(isPrivateFilesystemPath(alias)).toBe(false);
  expect(await isOwnedFilesystemPathAsync(alias)).toBe(false);
}, 15_000);

test("publishes private bytes and never overwrites an existing file", () => {
  const path = join(fixture(), "secret café '[value] $.json");
  writePrivateFileExclusiveSync(path, Buffer.from("first"));
  expect(isPrivateFilesystemPath(path)).toBe(true);
  expect(readFileSync(path, "utf8")).toBe("first");
  expect(() => writePrivateFileExclusiveSync(path, Buffer.from("replacement"))).toThrow();
  expect(readFileSync(path, "utf8")).toBe("first");
}, 15_000);

test("creates every missing private ancestor and accepts an existing managed directory", () => {
  const root = fixture();
  const parent = join(root, "parent");
  const child = join(parent, "child");
  ensurePrivateDirectorySync(child);
  expect(isPrivateFilesystemPath(parent)).toBe(true);
  expect(isPrivateFilesystemPath(child)).toBe(true);
  ensurePrivateDirectorySync(child);
  expect(isPrivateFilesystemPath(child)).toBe(true);
}, 15_000);

test.skipIf(process.platform !== "win32")("detects a real Windows ACL granting another identity read access", async () => {
  const path = join(fixture(), "secret.json");
  writePrivateFileExclusiveSync(path, Buffer.from("secret"));
  allowOtherReadersSync(path);
  expect(isPrivateFilesystemPath(path)).toBe(false);
  expect(await isOwnedFilesystemPathAsync(path)).toBe(true);
  secureFilesystemPathSync(path);
  expect(isPrivateFilesystemPath(path)).toBe(true);
}, 15_000);

test("the async writer also runs in the supported Node runtime", () => {
  const path = join(fixture(), "node-secret.json");
  const moduleUrl = new URL("../../src/private-filesystem.ts", import.meta.url).href;
  const script = `import { writePrivateFileExclusive, isPrivateFilesystemPath } from ${JSON.stringify(moduleUrl)};
    await writePrivateFileExclusive(process.argv[1], Buffer.from("node secret"));
    if (!isPrivateFilesystemPath(process.argv[1])) throw new Error("Not private");`;
  const result = spawnSync("node", ["--input-type=module", "-e", script, path], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(path, "utf8")).toBe("node secret");
}, 15_000);

test.skipIf(process.platform !== "win32")("reuses one native worker across private directories, writes and a rejected collision", async () => {
  const root = fixture();
  const previousTmp = process.env["TMP"];
  const previousSecret = process.env["NAUTILO_TEST_SECRET"];
  process.env["TMP"] = root;
  process.env["NAUTILO_TEST_SECRET"] = "must-not-be-inherited";
  const execution = spyOn(childProcess, "spawn");
  try {
    const directory = join(root, "parent", "child");
    await Promise.all([ensurePrivateDirectory(directory), ensurePrivateDirectory(directory)]);
    const first = join(directory, "first.json");
    const second = join(directory, "second.json");
    const writes = await Promise.allSettled([
      writePrivateFileExclusive(first, Buffer.from("first")),
      writePrivateFileExclusive(second, Buffer.from("second")),
      writePrivateFileExclusive(first, Buffer.from("replacement")),
    ]);
    expect(writes.map(result => result.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
    expect(writes[2]).toMatchObject({ status: "rejected", reason: { code: "EEXIST" } });
    await secureFilesystemPath(first);
    expect(readFileSync(first, "utf8")).toBe("first");
    expect(readFileSync(second, "utf8")).toBe("second");
    const calls = execution.mock.calls.filter(([command]) => String(command).endsWith("pwsh.exe"));
    expect(calls).toHaveLength(1);
    const options = calls[0]![2];
    expect(options.env?.["NAUTILO_TEST_SECRET"]).toBeUndefined();
    expect(isPrivateFilesystemPath(directory)).toBe(true);
    expect(isPrivateFilesystemPath(first)).toBe(true);
  } finally {
    execution.mockRestore();
    if (previousTmp === undefined) delete process.env["TMP"]; else process.env["TMP"] = previousTmp;
    if (previousSecret === undefined) delete process.env["NAUTILO_TEST_SECRET"]; else process.env["NAUTILO_TEST_SECRET"] = previousSecret;
  }
}, 15_000);

test.skipIf(process.platform !== "win32").each(["exit", "pipe error"])("rejects pending requests on worker %s and restarts for a new request", async (failureMode) => {
  const root = fixture();
  const previousTmp = process.env["TMP"];
  process.env["TMP"] = root;
  const execution = spyOn(childProcess, "spawn");
  try {
    const first = writePrivateFileExclusive(join(root, "first"), Buffer.from("first"));
    const second = writePrivateFileExclusive(join(root, "second"), Buffer.from("second"));
    const child = execution.mock.results[0]!.value as childProcess.ChildProcess;
    expect(child.pid).toBeNumber();
    if (failureMode === "exit") child.kill();
    else child.stdout!.destroy(new Error("Fixture pipe failure"));
    const failed = await Promise.allSettled([first, second]);
    expect(failed).toHaveLength(2);
    for (const result of failed) expect(result).toMatchObject({ status: "rejected", reason: { code: "EACCES" } });
    const recovered = join(root, "recovered");
    await writePrivateFileExclusive(recovered, Buffer.from("recovered"));
    expect(readFileSync(recovered, "utf8")).toBe("recovered");
    expect(execution.mock.calls.filter(([command]) => String(command).endsWith("pwsh.exe"))).toHaveLength(2);
  } finally {
    execution.mockRestore();
    if (previousTmp === undefined) delete process.env["TMP"]; else process.env["TMP"] = previousTmp;
  }
}, 15_000);

test.skipIf(process.platform !== "win32")("fails closed when the trusted helper executable is missing", async () => {
  const root = fixture();
  const previous = process.env["ProgramW6432"];
  process.env["ProgramW6432"] = root;
  try {
    const error = await writePrivateFileExclusive(join(root, "secret"), Buffer.from("secret"))
      .then(() => null, (failure: unknown) => failure);
    expect(error).toMatchObject({ code: "EACCES" });
  } finally {
    if (previous === undefined) delete process.env["ProgramW6432"]; else process.env["ProgramW6432"] = previous;
  }
}, 15_000);

test.skipIf(process.platform !== "win32")("the native helper does not inherit application secrets", () => {
  const previous = process.env["NAUTILO_TEST_SECRET"];
  process.env["NAUTILO_TEST_SECRET"] = "private-test-value";
  const execution = spyOn(childProcess, "spawnSync");
  try {
    const path = join(fixture(), "private.json");
    writePrivateFileExclusiveSync(path, Buffer.from("payload"));
    expect(isPrivateFilesystemPath(path)).toBe(true);
    const calls = execution.mock.calls.filter(([command]) => String(command).endsWith("pwsh.exe"));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const options = call[2] as childProcess.SpawnSyncOptions;
      expect(options.env).toBeDefined();
      expect(options.env?.["NAUTILO_TEST_SECRET"]).toBeUndefined();
    }
  } finally {
    execution.mockRestore();
    if (previous === undefined) delete process.env["NAUTILO_TEST_SECRET"];
    else process.env["NAUTILO_TEST_SECRET"] = previous;
  }
}, 15_000);
