import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RelayFsRequest, RelayFsResult } from "@nautilo/relay";
import {
  LocalFileBackend,
  RelayFileBackend,
} from "../../src/tools/file/backend";

function tmpRoot(): string {
  return path.join(
    os.tmpdir(),
    `nautilo-file-backend-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

async function expectErrno(
  op: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await op;
    throw new Error(`expected ${code}`);
  } catch (err) {
    expect((err as NodeJS.ErrnoException).code).toBe(code);
  }
}

describe("LocalFileBackend", () => {
  let root: string;
  let backend: LocalFileBackend;

  beforeEach(async () => {
    root = tmpRoot();
    await fsp.mkdir(root, { recursive: true });
    backend = new LocalFileBackend();
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  test("matches node fs semantics for read/write/stat/list", async () => {
    const nested = path.join(root, "a", "b");
    const file = path.join(nested, "hello.txt");

    await backend.mkdir(nested, { recursive: true });
    await backend.writeFileAtomic(file, Buffer.from("hello"));

    expect(await backend.readFile(file)).toEqual(Buffer.from("hello"));

    const entries = await backend.readdir(nested, { withFileTypes: true });
    expect(entries.map((e) => e.name)).toEqual(["hello.txt"]);
    expect(entries[0]?.isFile()).toBe(true);

    const stat = await backend.stat(file);
    expect(stat.size).toBe(5);
    expect(stat.isFile()).toBe(true);
    expect(await backend.realpath(file)).toBe(await fsp.realpath(file));
  });

  test("throws Node-shaped errno errors", async () => {
    const missing = path.join(root, "missing.txt");
    await expectErrno(backend.readFile(missing), "ENOENT");
  });
});

describe("RelayFileBackend", () => {
  const relayId = "relay-1";
  const allowedRoots = ["/Users/example/project"];

  function fakeBackend(resultFor: (req: RelayFsRequest) => RelayFsResult) {
    const requests: RelayFsRequest[] = [];
    const backend = new RelayFileBackend(
      {
        async fsDispatch(id, req) {
          expect(id).toBe(relayId);
          requests.push(req);
          return resultFor(req);
        },
      },
      relayId,
      allowedRoots,
    );
    return { backend, requests };
  }

  test("sends fsDispatch envelope and decodes read bytes", async () => {
    const { backend, requests } = fakeBackend((req) => {
      expect(req.op).toBe("readFile");
      expect(req.allowedRoots).toEqual(allowedRoots);
      return {
        ok: true,
        dataBase64: Buffer.from("from relay").toString("base64"),
      };
    });

    expect(await backend.readFile("/Users/example/project/a.txt")).toEqual(
      Buffer.from("from relay"),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe("/Users/example/project/a.txt");
  });

  test("round-trips write payloads as base64", async () => {
    const { backend, requests } = fakeBackend((req) => {
      expect(req.op).toBe("writeFileAtomic");
      return { ok: true };
    });

    await backend.writeFileAtomic(
      "/Users/example/project/a.txt",
      Buffer.from("payload"),
    );

    expect(Buffer.from(requests[0]?.dataBase64 ?? "", "base64").toString()).toBe(
      "payload",
    );
  });

  test("maps relay errno result to Node-shaped thrown error", async () => {
    const { backend } = fakeBackend(() => ({
      ok: false,
      code: "ENOENT",
      message: "missing on relay",
    }));

    await expectErrno(
      backend.readFile("/Users/example/project/missing.txt"),
      "ENOENT",
    );
  });

  test("maps stat and readdir wire shapes to fs-like objects", async () => {
    const { backend } = fakeBackend((req) => {
      if (req.op === "readdir") {
        return {
          ok: true,
          entries: [{ name: "a.txt", file: true, dir: false, symlink: false }],
        };
      }
      return {
        ok: true,
        stat: {
          size: 7,
          mtimeMs: 1000,
          birthtimeMs: 500,
          mode: 0o644,
          isFile: true,
          isDirectory: false,
          isSymbolicLink: false,
          isFIFO: false,
          isSocket: false,
        },
      };
    });

    const entries = await backend.readdir("/Users/example/project");
    expect(entries[0]?.name).toBe("a.txt");
    expect(entries[0]?.isFile()).toBe(true);

    const stat = await backend.stat("/Users/example/project/a.txt");
    expect(stat.size).toBe(7);
    expect(stat.mtime.toISOString()).toBe(new Date(1000).toISOString());
    expect(stat.isFile()).toBe(true);
  });
});
