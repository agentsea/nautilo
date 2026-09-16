/**
 * M180 / D448 — executable fs:writeFile registration checks (no Electron runtime).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "../../electron/fs-write";
import {
  createCompatibilityFileExclusively,
  publishCompatibilityFileExclusively,
  registerFsStructuralIpcHandlers,
} from "../../electron/fs-structural-ipc";
import { normalizeStaticSource } from "./static-source";

const desktopRoot = join(import.meta.dir, "../..");

describe("fs:writeFile IPC wiring", () => {
  test("registered handler checks sender first and applies SHA-CAS atomically", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "fs-write-ipc-"));
    const handlers = new Map<string, (event: { main: boolean }, args: unknown) => Promise<unknown>>();
    const order: string[] = [];
    try {
      registerFsStructuralIpcHandlers({
        ipcMain: { handle: (channel, listener) => handlers.set(channel, listener as (event: { main: boolean }, args: unknown) => Promise<unknown>) },
        assertSender: (event) => {
          order.push("sender");
          if (!event.main) throw new Error("foreign sender");
        },
        assertPathInAllowedRoot: (target) => {
          order.push("path");
          if (!target.startsWith(root)) throw new Error("outside root");
        },
        fs: { readFile: fs.readFile, writeFile: fs.writeFile, rename: fs.rename, unlink: fs.unlink },
        shell: { trashItem: async () => {} },
        createFileExclusive: async (target, bytes) => {
          await fs.writeFile(target, bytes, { flag: "wx" });
        },
        editorSave: {
          saveExistingFile: async (input) => ({
            ok: true as const,
            sha256: sha256Hex(Buffer.from(input.content)),
            size: Buffer.byteLength(input.content),
          }),
        },
      });
      const write = handlers.get("fs:writeFile");
      if (!write) throw new Error("fs:writeFile was not registered");
      const target = join(root, "draft.txt");
      expect(write({ main: false }, { path: target, content: "blocked", baseSha256: null })).rejects.toThrow("foreign sender");
      expect(order).toEqual(["sender"]);

      order.length = 0;
      expect(await write({ main: true }, { path: target, content: "one", baseSha256: null })).toEqual({
        ok: true, sha256: sha256Hex(Buffer.from("one")), size: 3,
      });
      expect(order).toEqual(["sender", "path"]);
      expect(await write({ main: true }, {
        path: target, content: "stale", baseSha256: sha256Hex(Buffer.from("not-one")),
      })).toEqual({ ok: false, code: "conflict", currentSha256: sha256Hex(Buffer.from("one")) });
      // The coordinator fake above deliberately never writes: an existing
      // update cannot reach the legacy atomic writer through this facade.
      expect(await fs.readFile(target, "utf8")).toBe("one");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("preload exposes fs.writeFile invoking fs:writeFile", () => {
    const preload = normalizeStaticSource(
      readFileSync(join(desktopRoot, "electron/preload.ts"), "utf-8"),
    );
    expect(preload).toContain("writeFile:");
    expect(preload).toContain('ipcRenderer.invoke("fs:writeFile"');
    expect(preload).toContain("baseSha256: opts?.baseSha256 ?? null");
  });

  test("preload validates the full batch and acknowledges only after every listener accepts it", () => {
    const preload = normalizeStaticSource(
      readFileSync(join(desktopRoot, "electron/preload.ts"), "utf-8"),
    );
    const noListenerGuard = preload.indexOf("documentMutationListeners.size === 0");
    const sharedValidation = preload.indexOf("validateAtomicDocumentMutationEventBatchEnvelope(raw)");
    const listenerAcceptance = preload.indexOf("await Promise.all([...documentMutationListeners]");
    const acknowledgement = preload.indexOf('ipcRenderer.send("document:mutationAck"');
    const noAckCatch = preload.indexOf("// Deliberately no ack.");
    expect(noListenerGuard).toBeGreaterThan(-1);
    expect(sharedValidation).toBeGreaterThan(noListenerGuard);
    expect(listenerAcceptance).toBeGreaterThan(sharedValidation);
    expect(acknowledgement).toBeGreaterThan(listenerAcceptance);
    expect(noAckCatch).toBeGreaterThan(acknowledgement);
  });

  test("active renderer epoch awaits reconnect consumers before readiness", () => {
    const preload = normalizeStaticSource(
      readFileSync(join(desktopRoot, "electron/preload.ts"), "utf-8"),
    );
    const main = normalizeStaticSource(
      readFileSync(join(desktopRoot, "electron/main.ts"), "utf-8"),
    );
    expect(preload).toContain("documentMutationReconnectListeners");
    expect(preload).toContain("await Promise.all(");
    expect(preload).toContain('ipcRenderer.send("document:mutationReady", {epoch})');
    expect(main).toContain("documentMutationRendererEpochs");
    expect(main).toContain("if (epoch !== documentMutationRendererEpoch(rendererId)) return;");
  });

  test("in-place Workbench navigation preserves document-mutation readiness", () => {
    const main = normalizeStaticSource(
      readFileSync(join(desktopRoot, "electron/main.ts"), "utf-8"),
    );
    expect(main).toContain("if (!isMainFrame || isInPlace) return;");
    expect(main).toContain('sender.on("did-start-navigation", onDidStartNavigation)');
    expect(main).toContain(
      'sender.removeListener("did-start-navigation", onDidStartNavigation)',
    );
  });

  test("main returns trusted canonical local identity from fs stat", () => {
    const main = normalizeStaticSource(
      readFileSync(join(desktopRoot, "electron/main.ts"), "utf-8"),
    );
    expect(main).toContain("dynamicDocumentMutationFileAdapter.canonicalize(args.path)");
    expect(main).toContain("documentIdentity: relayId");
    expect(main).toContain("{kind: \"local_file\" as const, relayId, canonicalPath}");
  });

  test("workbench desktop types expose fs.writeFile", () => {
    const desktop = readFileSync(
      join(desktopRoot, "../workbench/src/lib/desktop.ts"),
      "utf-8",
    );
    expect(desktop).toContain("export type FsWriteFileResult");
    expect(desktop).toContain("writeFile:");
    expect(desktop).toContain('code: "forbidden" | "conflict" | "too_large" | "error"');
  });

  test("an unreadable existing path is an error, never compatibility-create", async () => {
    const handlers = new Map<string, (event: { main: boolean }, args: unknown) => Promise<unknown>>();
    let directWrites = 0;
    let coordinatorWrites = 0;
    registerFsStructuralIpcHandlers({
      ipcMain: { handle: (channel, listener) => handlers.set(channel, listener as (event: { main: boolean }, args: unknown) => Promise<unknown>) },
      assertSender: () => {},
      assertPathInAllowedRoot: () => {},
      fs: {
        readFile: async () => {
          const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
          throw error;
        },
        writeFile: async () => { directWrites += 1; },
        rename: async () => { directWrites += 1; },
        unlink: async () => {},
      },
    shell: { trashItem: async () => {} },
    createFileExclusive: async (target, bytes) => {
      await fs.writeFile(target, bytes, { flag: "wx" });
    },
      editorSave: {
        saveExistingFile: async () => {
          coordinatorWrites += 1;
          return { ok: true as const, sha256: "a".repeat(64), size: 1 };
        },
      },
    });
    const write = handlers.get("fs:writeFile");
    if (!write) throw new Error("fs:writeFile was not registered");
    expect(await write({ main: true }, { path: "/allowed/unreadable.md", content: "x", baseSha256: null }))
      .toMatchObject({ ok: false, code: "error" });
    expect(directWrites).toBe(0);
    expect(coordinatorWrites).toBe(0);
  });

  test("exclusive create rejects a symlinked parent that resolves outside the allowed root", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "fs-create-root-"));
    const outside = await fs.mkdtemp(join(tmpdir(), "fs-create-outside-"));
    try {
      const canonicalRoot = await fs.realpath(root);
      const linkedParent = join(root, "linked");
      await fs.symlink(outside, linkedParent, "dir");
      expect(createCompatibilityFileExclusively(
        join(linkedParent, "escape.md"),
        Buffer.from("blocked"),
        (candidate) => {
          if (candidate !== canonicalRoot && !candidate.startsWith(`${canonicalRoot}/`)) {
            throw new Error("outside root");
          }
        },
      )).rejects.toThrow("outside root");
      expect(fs.access(join(outside, "escape.md"))).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  test("exclusive create materializes missing nested parents inside the allowed root", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "fs-create-nested-root-"));
    try {
      const canonicalRoot = await fs.realpath(root);
      const target = join(root, "missing", "nested", "created.md");
      await createCompatibilityFileExclusively(
        target,
        Buffer.from("nested\n"),
        (candidate) => {
          if (candidate !== canonicalRoot && !candidate.startsWith(`${canonicalRoot}/`)) {
            throw new Error("outside root");
          }
        },
      );
      expect(await fs.readFile(target, "utf8")).toBe("nested\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("exclusive create falls back safely when the mounted folder does not support hard links", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "fs-create-no-hardlinks-"));
    const temporary = join(root, ".staged.tmp");
    const target = join(root, "created.md");
    try {
      const bytes = Buffer.from("created on a mounted folder\n");
      await fs.writeFile(temporary, bytes);
      await publishCompatibilityFileExclusively(temporary, target, bytes, {
        link: async () => {
          throw Object.assign(new Error("hard links unsupported"), { code: "ENOTSUP" });
        },
        open: fs.open,
        lstat: fs.lstat,
        rm: fs.rm,
      });
      expect(await fs.readFile(target, "utf8")).toBe("created on a mounted folder\n");

      await expect(publishCompatibilityFileExclusively(temporary, target, bytes, {
        link: async () => {
          throw Object.assign(new Error("hard links unsupported"), { code: "ENOTSUP" });
        },
        open: fs.open,
        lstat: fs.lstat,
        rm: fs.rm,
      })).rejects.toMatchObject({ code: "EEXIST" });
      expect(await fs.readFile(target, "utf8")).toBe("created on a mounted folder\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("a concurrent compatibility creator wins without overwrite and returns its current SHA", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "fs-create-race-"));
    const handlers = new Map<string, (event: object, args: unknown) => Promise<unknown>>();
    const target = join(root, "race.md");
    let reads = 0;
    try {
      registerFsStructuralIpcHandlers({
        ipcMain: {
          handle: (channel, listener) =>
            handlers.set(channel, listener as (event: object, args: unknown) => Promise<unknown>),
        },
        assertSender: () => {},
        assertPathInAllowedRoot: () => {},
        fs: {
          readFile: async (candidate) => {
            reads += 1;
            if (reads === 1) {
              throw Object.assign(new Error("missing"), { code: "ENOENT" });
            }
            return await fs.readFile(candidate);
          },
          writeFile: fs.writeFile,
          rename: fs.rename,
          unlink: fs.unlink,
        },
        shell: { trashItem: async () => {} },
        createFileExclusive: async (target, bytes) => {
          await fs.writeFile(target, bytes, { flag: "wx" });
        },
        createFileExclusive: async () => {
          await fs.writeFile(target, "concurrent human");
          throw Object.assign(new Error("already exists"), { code: "EEXIST" });
        },
      });
      const write = handlers.get("fs:writeFile");
      if (!write) throw new Error("fs:writeFile was not registered");
      expect(await write({}, { path: target, content: "agent candidate", baseSha256: null }))
        .toEqual({
          ok: false,
          code: "conflict",
          currentSha256: sha256Hex(Buffer.from("concurrent human")),
        });
      expect(await fs.readFile(target, "utf8")).toBe("concurrent human");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
