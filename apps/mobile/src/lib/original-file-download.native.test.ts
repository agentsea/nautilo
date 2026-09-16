/* eslint-disable @typescript-eslint/await-thenable -- Bun async rejection matchers are typed as void. */
import { beforeEach, expect, mock, test } from "bun:test";

let sequence = 0;
const directories = new Map<string, boolean>();
const files = new Map<string, { size: number; exists: boolean }>();
const calls: Array<{ url: string; uri: string; token: string }> = [];
let download: (uri: string, signal: AbortSignal) => Promise<void>;
let cleanupThrows = false;
mock.module("expo-crypto", () => ({ randomUUID: () => `operation-${++sequence}` }));
mock.module("expo-file-system", () => ({
  Paths: { cache: "file:///cache" },
  Directory: class {
    uri: string;
    constructor(...parts: string[]) { this.uri = parts.join("/"); }
    create() { directories.set(this.uri, true); }
    get exists() { return directories.get(this.uri) === true; }
    delete() {
      if (cleanupThrows) throw new Error("synthetic cleanup failure");
      directories.set(this.uri, false);
    }
  },
  File: class {
    uri: string;
    constructor(dir: { uri: string }, name: string) { this.uri = `${dir.uri}/${name}`; }
    get exists() { return files.get(this.uri)?.exists ?? false; }
    get size() { return files.get(this.uri)?.size ?? 0; }
    static async downloadFileAsync(url: string, destination: { uri: string }, options: { signal: AbortSignal; headers: { Authorization: string } }) {
      calls.push({ url, uri: destination.uri, token: options.headers.Authorization });
      await download(destination.uri, options.signal);
    }
  },
}));
const { downloadOriginalFile } = await import("./original-file-download.native");
beforeEach(() => {
  directories.clear(); files.clear(); calls.length = 0; sequence = 0;
  cleanupThrows = false;
  download = async (uri) => { files.set(uri, { size: 4, exists: true }); };
});
const input = (signal = new AbortController().signal) => ({
  url: "https://files.example/api/workspace/artifacts/one/bytes", token: "test-token", filename: "report.html", signal,
});

test("preserves filename in a distinct private directory for each operation", async () => {
  const first = await downloadOriginalFile(input());
  const second = await downloadOriginalFile(input());
  expect(first.fileUri).toEndWith("/report.html");
  expect(first.fileUri).not.toBe(second.fileUri);
  expect(first.size).toBe(4);
  expect(calls[0]?.token).toBe("Bearer test-token");
  first.cleanup(); first.cleanup();
  expect(directories.get("file:///cache/nautilo-exports/operation-1")).toBe(false);
  expect(directories.get("file:///cache/nautilo-exports/operation-2")).toBe(true);
});

test("works with React Native's signal surface without throwIfAborted", async () => {
  const signal = { aborted: false, addEventListener() {}, removeEventListener() {} } as unknown as AbortSignal;
  const original = await downloadOriginalFile(input(signal));
  expect(original.size).toBe(4);
  original.cleanup();
});

test("download failure removes only its owned partial directory", async () => {
  download = async () => { throw new Error("HTTP 403"); };
  await expect(downloadOriginalFile(input())).rejects.toThrow("HTTP 403");
  expect([...directories.values()]).toEqual([false]);
});

test("download failure reports when its temporary directory cannot be removed", async () => {
  download = async () => { throw new Error("HTTP 403"); };
  cleanupThrows = true;
  await expect(downloadOriginalFile(input())).rejects.toMatchObject({ code: "ERR_EXPORT_TEMP_CLEANUP" });
});

test("pre-cancelled operation creates no file or request", async () => {
  const controller = new AbortController(); controller.abort();
  await expect(downloadOriginalFile(input(controller.signal))).rejects.toThrow();
  expect(calls).toHaveLength(0);
  expect(directories.size).toBe(0);
});

test("cancellation during native completion discards the downloaded file", async () => {
  const controller = new AbortController();
  download = async (uri) => { files.set(uri, { size: 4, exists: true }); controller.abort(); };
  await expect(downloadOriginalFile(input(controller.signal))).rejects.toThrow();
  expect([...directories.values()]).toEqual([false]);
});

test("a native completion without an actual file is not success", async () => {
  download = async () => {};
  await expect(downloadOriginalFile(input())).rejects.toThrow("did not finish");
  expect([...directories.values()]).toEqual([false]);
});

test("unsafe basename cannot escape the private export directory", async () => {
  await expect(downloadOriginalFile({ ...input(), filename: "../secret" })).rejects.toThrow("Invalid export filename");
  expect(calls).toHaveLength(0);
});
