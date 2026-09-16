/* eslint-disable @typescript-eslint/await-thenable -- Bun async rejection matchers are typed as void. */
import { beforeEach, expect, mock, test } from "bun:test";

let sequence = 0;
const directories = new Map<string, boolean>();
const files = new Map<string, { content: string; exists: boolean }>();
const requests: string[] = [];
let download: (uri: string) => Promise<void>;
let textThrows = false;
let deleteThrows = false;

mock.module("expo-crypto", () => ({ randomUUID: () => `operation-${++sequence}` }));
mock.module("expo-file-system", () => ({
  Paths: { cache: "file:///cache" },
  Directory: class {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = parts.map((part) => typeof part === "string" ? part : part.uri).join("/");
    }
    create() { directories.set(this.uri, true); }
    get exists() { return directories.get(this.uri) === true; }
    delete() {
      if (deleteThrows) throw new Error("synthetic delete failure");
      directories.set(this.uri, false);
    }
  },
  File: class {
    uri: string;
    constructor(directory: { uri: string }, name: string) { this.uri = `${directory.uri}/${name}`; }
    async text() {
      if (textThrows) throw new Error("synthetic text failure");
      return files.get(this.uri)?.content ?? "";
    }
    static async downloadFileAsync(url: string, destination: { uri: string }) {
      requests.push(url);
      await download(destination.uri);
    }
  },
}));

const { downloadArtifactBytes, releaseArtifactFileUri } = await import("./artifact-byte-download.native");
const input = (text: boolean) => ({
  url: "https://server.invalid/bytes",
  token: "token",
  cacheName: text ? "document.html" : "image.png",
  text,
});

beforeEach(() => {
  sequence = 0;
  directories.clear();
  files.clear();
  requests.length = 0;
  textThrows = false;
  deleteThrows = false;
  download = async (uri) => { files.set(uri, { content: "document", exists: true }); };
});

test("uses a distinct operation directory and releases only the exact returned binary lease", async () => {
  const first = await downloadArtifactBytes(input(false));
  const second = await downloadArtifactBytes(input(false));
  expect(first.kind).toBe("file");
  expect(second.kind).toBe("file");
  if (first.kind !== "file" || second.kind !== "file") throw new Error("expected binary leases");
  expect(first.fileUri).not.toBe(second.fileUri);

  releaseArtifactFileUri("file:///cache/nautilo-artifacts/operation-1/not-the-owned-file.png");
  expect(directories.get("file:///cache/nautilo-artifacts/operation-1")).toBe(true);
  releaseArtifactFileUri(first.fileUri);
  expect(directories.get("file:///cache/nautilo-artifacts/operation-1")).toBe(false);
  expect(directories.get("file:///cache/nautilo-artifacts/operation-2")).toBe(true);
});

test("decodes text and removes its operation directory before returning content", async () => {
  expect(await downloadArtifactBytes(input(true))).toEqual({ kind: "text", content: "document" });
  expect(directories.get("file:///cache/nautilo-artifacts/operation-1")).toBe(false);
});

test("removes Android-style partial bytes after download or text decoding failure", async () => {
  download = async (uri) => {
    files.set(uri, { content: "partial", exists: true });
    throw new Error("HTTP 503");
  };
  await expect(downloadArtifactBytes(input(false))).rejects.toThrow("HTTP 503");
  expect([...directories.values()]).toEqual([false]);

  download = async (uri) => { files.set(uri, { content: "broken", exists: true }); };
  textThrows = true;
  await expect(downloadArtifactBytes(input(true))).rejects.toThrow("synthetic text failure");
  expect([...directories.values()]).toEqual([false, false]);
});

test("retains failed release ownership for an exact later retry", async () => {
  const result = await downloadArtifactBytes(input(false));
  if (result.kind !== "file") throw new Error("expected binary lease");
  deleteThrows = true;
  releaseArtifactFileUri(result.fileUri);
  expect(directories.get("file:///cache/nautilo-artifacts/operation-1")).toBe(true);
  deleteThrows = false;
  releaseArtifactFileUri(result.fileUri);
  expect(directories.get("file:///cache/nautilo-artifacts/operation-1")).toBe(false);
});

test("rejects a cache name that could escape its owned operation directory", async () => {
  await expect(downloadArtifactBytes({ ...input(false), cacheName: "../secret" })).rejects.toThrow("Invalid artifact cache filename");
  expect(requests).toHaveLength(0);
  expect(directories.size).toBe(0);
});
