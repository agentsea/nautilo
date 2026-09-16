import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { sha256Hex } from "../../electron/fs-write.ts";
import { registerFsStructuralIpcHandlers } from "../../electron/fs-structural-ipc.ts";

type Handler = (event: { sender: "main" | "foreign" }, args: unknown) => Promise<unknown>;

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "d448-structural-ipc-"));
  const trashRoot = await fs.mkdtemp(path.join(os.tmpdir(), "d448-structural-trash-"));
  const handlers = new Map<string, Handler>();
  const calls: string[] = [];
  registerFsStructuralIpcHandlers({
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener as Handler) },
    assertSender: (event) => {
      calls.push("sender");
      if (event.sender !== "main") throw new Error("foreign sender");
    },
    assertPathInAllowedRoot: (target) => {
      calls.push(`path:${target}`);
      const relative = path.relative(root, path.resolve(target));
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("outside allowed root");
    },
    fs: {
      readFile: (target) => fs.readFile(target),
      writeFile: (target, data) => fs.writeFile(target, data),
      rename: (from, to) => fs.rename(from, to),
      unlink: (target) => fs.unlink(target),
    },
    shell: {
      trashItem: async (target) => {
        calls.push(`trash:${target}`);
        await fs.rename(target, path.join(trashRoot, path.basename(target)));
      },
    },
    createFileExclusive: async (target, bytes) => {
      await fs.writeFile(target, bytes, { flag: "wx" });
    },
    editorSave: {
      saveExistingFile: async (input) => {
        calls.push(`coordinator:${input.path}`);
        return {
          ok: true as const,
          sha256: sha256Hex(Buffer.from(input.content)),
          size: Buffer.byteLength(input.content),
        };
      },
    },
  });
  const invoke = async (channel: string, event: { sender: "main" | "foreign" }, args: unknown) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`missing handler ${channel}`);
    return await handler(event, args);
  };
  return {
    root,
    trashRoot,
    calls,
    handlers,
    invoke,
    cleanup: async () => {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(trashRoot, { recursive: true, force: true });
    },
  };
}

describe("D448 local structural IPC characterization", () => {
  test("keeps explicit create structural while existing updates enter the coordinator facade", async () => {
    const fx = await fixture();
    try {
      expect([...fx.handlers.keys()].sort()).toEqual(["fs:rename", "fs:trash", "fs:writeFile"]);
      const target = path.join(fx.root, "draft.txt");
      const created = await fx.invoke("fs:writeFile", { sender: "main" }, {
        path: target, content: "first", baseSha256: null,
      });
      expect(created).toEqual({ ok: true, sha256: sha256Hex(Buffer.from("first")), size: 5 });
      const updated = await fx.invoke("fs:writeFile", { sender: "main" }, {
        path: target, content: "second", baseSha256: sha256Hex(Buffer.from("first")),
      });
      expect(updated).toEqual({ ok: true, sha256: sha256Hex(Buffer.from("second")), size: 6 });
      expect(fx.calls).toContain(`coordinator:${target}`);
      const conflict = await fx.invoke("fs:writeFile", { sender: "main" }, {
        path: target, content: "agent stale", baseSha256: sha256Hex(Buffer.from("not-first")),
      });
      expect(conflict).toEqual({ ok: false, code: "conflict", currentSha256: sha256Hex(Buffer.from("first")) });
      // The fake coordinator deliberately does not write. This proves the
      // structural handler has no direct existing-file writer to fall back to.
      expect(await fs.readFile(target, "utf8")).toBe("first");

      const renamed = path.join(fx.root, "renamed.txt");
      expect(await fx.invoke("fs:rename", { sender: "main" }, { from: target, to: renamed })).toEqual({ ok: true });
      expect(await fs.readFile(renamed, "utf8")).toBe("first");
      expect(await fx.invoke("fs:trash", { sender: "main" }, { path: renamed })).toEqual({ ok: true });
      await expect(fs.access(renamed)).rejects.toThrow();
      expect(await fs.readFile(path.join(fx.trashRoot, "renamed.txt"), "utf8")).toBe("first");
    } finally {
      await fx.cleanup();
    }
  });

  test("checks sender before policy and leaves forbidden or foreign requests without mutation", async () => {
    const fx = await fixture();
    try {
      const inside = path.join(fx.root, "inside.txt");
      const outside = path.join(os.tmpdir(), `d448-outside-${randomUUID()}.txt`);
      try {
        await fs.writeFile(inside, "human", "utf8");

        await expect(fx.invoke("fs:writeFile", { sender: "foreign" }, {
          path: inside, content: "agent", baseSha256: null,
        })).rejects.toThrow("foreign sender");
        expect(fx.calls).toEqual(["sender"]);
        expect(await fs.readFile(inside, "utf8")).toBe("human");

        fx.calls.length = 0;
        expect(await fx.invoke("fs:writeFile", { sender: "main" }, {
          path: outside, content: "blocked", baseSha256: null,
        })).toEqual({ ok: false, code: "forbidden" });
        expect(fx.calls).toEqual(["sender", `path:${outside}`]);
        await expect(fs.access(outside)).rejects.toThrow();
        expect(await fs.readFile(inside, "utf8")).toBe("human");
      } finally {
        await fs.rm(outside, { force: true });
      }
    } finally {
      await fx.cleanup();
    }
  });
});
