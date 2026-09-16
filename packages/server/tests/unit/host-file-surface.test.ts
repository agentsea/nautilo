import { describe, expect, test } from "bun:test";
import {
  HOST_FILE_MAX_PREVIEW_BYTES,
  decodeHostFileCursor,
  encodeHostFileCursor,
  listHostFiles,
  normalizeHostFileRelativePath,
  readHostFilePreview,
} from "../../src/remote-control/host-file-surface";

const ROOT = "/Users/alice/Documents/Nautilo";

function dispatcher(input: { rootMissing?: boolean; previewBytes?: number } = {}) {
  const calls: Array<{ path: string; allowedRoots: string[]; opts?: Record<string, unknown> }> = [];
  return {
    calls,
    async fsDispatch(_relayId: string, request: { op: string; path: string; allowedRoots: string[]; opts?: Record<string, unknown> }) {
      calls.push({
        path: request.path,
        allowedRoots: request.allowedRoots,
        ...(request.opts !== undefined ? { opts: request.opts } : {}),
      });
      if (request.op === "stat" && request.path === ROOT && input.rootMissing) {
        return { ok: false as const, code: "ENOENT", message: "gone" };
      }
      if (request.op === "stat") {
        return {
          ok: true as const,
          stat: {
            size: 0, mtimeMs: 1, birthtimeMs: 1, mode: 0o755,
            isFile: false, isDirectory: true, isSymbolicLink: false, isFIFO: false, isSocket: false,
          },
        };
      }
      if (request.op === "readdir") {
        const all = [
          { name: "a", dir: true, file: false, symlink: false },
          { name: "z.md", dir: false, file: true, symlink: false },
          { name: "../bad", dir: false, file: true, symlink: false },
        ];
        const afterName = typeof request.opts?.["afterName"] === "string"
          ? request.opts["afterName"]
          : null;
        const limit = Number(request.opts?.["maxEntries"] ?? all.length);
        const remaining = afterName === null
          ? all
          : all.filter((entry) => entry.name > afterName);
        return {
          ok: true as const,
          entries: remaining.slice(0, limit),
          ...(limit < remaining.length ? { truncated: true } : {}),
        };
      }
      if (request.op === "lstat") {
        return {
          ok: true as const,
          stat: {
            size: input.previewBytes ?? 5, mtimeMs: 1, birthtimeMs: 1, mode: 0o644,
            isFile: true, isDirectory: false, isSymbolicLink: false, isFIFO: false, isSocket: false,
          },
        };
      }
      return { ok: true as const, dataBase64: Buffer.from("hello").toString("base64") };
    },
  };
}

describe("D458 host file surface", () => {
  test("normalizes only root-relative paths and uses opaque bounded cursors", () => {
    expect(normalizeHostFileRelativePath("nested/../notes.md")).toBe("notes.md");
    expect(normalizeHostFileRelativePath("")).toBe("");
    expect(normalizeHostFileRelativePath("/Users/alice/secret")).toBeNull();
    expect(normalizeHostFileRelativePath("../../secret")).toBeNull();
    const cursor = encodeHostFileCursor("notes.md");
    expect(cursor).not.toBeNull();
    expect(decodeHostFileCursor(cursor!)).toBe("notes.md");
    expect(decodeHostFileCursor("not a cursor")).toBeNull();
  });

  test("pages sorted safe child entries and sends exactly one root to every relay call", async () => {
    const dispatch = dispatcher();
    const result = await listHostFiles({
      dispatch,
      relayId: "private-relay-id",
      root: ROOT,
      relativePath: "",
      afterName: undefined,
      limit: 1,
      includeHidden: false,
      query: "",
    });
    expect(result).toEqual({
      ok: true,
      value: {
        entries: [{ name: "a", path: "a", isDirectory: true, isFile: false, isSymbolicLink: false }],
        nextCursor: encodeHostFileCursor("a"),
      },
    });
    expect(dispatch.calls.every((call) => call.allowedRoots.length === 1 && call.allowedRoots[0] === ROOT)).toBe(true);
    expect(dispatch.calls[1]?.opts).toEqual({ withFileTypes: true, maxEntries: 1, includeHidden: false, nameQuery: "" });

    const second = await listHostFiles({
      dispatch,
      relayId: "private-relay-id",
      root: ROOT,
      relativePath: "",
      afterName: "a",
      limit: 1,
      includeHidden: false,
      query: "",
    });
    expect(second).toEqual({
      ok: true,
      value: {
        entries: [{ name: "z.md", path: "z.md", isDirectory: false, isFile: true, isSymbolicLink: false }],
      nextCursor: null,
      },
    });
    expect(dispatch.calls[3]?.opts).toEqual({ withFileTypes: true, maxEntries: 1, includeHidden: false, nameQuery: "", afterName: "a" });
  });

  test("reports a stale root distinctly and refuses oversized previews before read", async () => {
    const missing = dispatcher({ rootMissing: true });
    expect(await listHostFiles({
      dispatch: missing, relayId: "relay", root: ROOT, relativePath: "", afterName: undefined, limit: 10,
      includeHidden: false, query: "",
    })).toEqual({ ok: false, error: "root_stale" });
    const oversized = dispatcher({ previewBytes: HOST_FILE_MAX_PREVIEW_BYTES + 1 });
    expect(await readHostFilePreview({
      dispatch: oversized, relayId: "relay", root: ROOT, relativePath: "notes.md",
    })).toEqual({ ok: false, error: "too_large" });
    expect(oversized.calls.some((call) => call.path.endsWith("notes.md"))).toBe(true);
    expect(oversized.calls).toHaveLength(2);
  });
});
