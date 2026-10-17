import { afterEach, describe, expect, test } from "bun:test";
import { allowOtherReaders } from "@nautilo/config/private-filesystem-fixtures";
import { mkdtemp, mkdir, readFile, realpath, rename, stat, symlink } from "node:fs/promises";
import { rejects } from "node:assert/strict";
import { isPrivateFilesystemPathAsync, writePrivateFileExclusive } from "@nautilo/config/private-filesystem";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import {
  ProtectedHandoffError,
  readProtectedHandoff,
  reserveProtectedHandoff,
  writeProtectedHandoff,
} from "../../src/lib/protected-handoff.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("protected handoff", () => {
  test("creates one absolute owner-only JSON file", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "nautilo-handoff-")));
    roots.push(root);
    const path = join(root, "invite.json");
    await writeProtectedHandoff(path, { kind: "invite", token: "CANARY" });

    expect(await isPrivateFilesystemPathAsync(path)).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      kind: "invite",
      token: "CANARY",
    });
  });

  test("reads only bounded owner-only regular JSON files", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "nautilo-handoff-")));
    roots.push(root);
    const path = join(root, "credential.json");
    await writeProtectedHandoff(path, { password: "CANARY", pin: "123456" });
    expect(await readProtectedHandoff(path)).toEqual({ password: "CANARY", pin: "123456" });
    await allowOtherReaders(path);
    await rejects(readProtectedHandoff(path), ProtectedHandoffError);
  });

  test("rejects relative/stdout/existing destinations", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "nautilo-handoff-")));
    roots.push(root);
    const path = join(root, "invite.json");
    await writeProtectedHandoff(path, { token: "first" });

    for (const destination of ["relative.json", "-", path]) {
      await rejects(writeProtectedHandoff(destination, { token: "second" }), ProtectedHandoffError);
    }
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ token: "first" });
  });

  test("rejects a symlinked parent and does not create the target", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "nautilo-handoff-")));
    roots.push(root);
    const real = join(root, "real");
    const linked = join(root, "linked");
    await mkdir(real);
    await symlink(real, linked, process.platform === "win32" ? "junction" : "dir");

    await rejects(writeProtectedHandoff(join(linked, "invite.json"), { token: "CANARY" }), ProtectedHandoffError);
    await rejects(stat(join(real, "invite.json")), { code: "ENOENT" });
  });

  test("reserves before mutation and discards an unused destination", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "nautilo-handoff-")));
    roots.push(root);
    const path = join(root, "invite.json");
    const reservation = await reserveProtectedHandoff(path);

    expect(await isPrivateFilesystemPathAsync(path)).toBe(true);
    expect(await readFile(path, "utf8")).toBe("");
    await reservation.discard();
    await rejects(readFile(path, "utf8"), { code: "ENOENT" });
  });

  test.each(["write", "discard"] as const)("%s preserves a replacement at the reserved path", async (action) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "nautilo-handoff-replaced-")));
    roots.push(root);
    const path = join(root, "invite.json");
    const moved = join(root, "original.json");
    const reservation = await reserveProtectedHandoff(path);
    try {
      await rename(path, moved);
      await writePrivateFileExclusive(path, Buffer.from('{"replacement":true}', "utf8"));
      if (action === "write") await rejects(reservation.write({ token: "CANARY" }), ProtectedHandoffError);
      else await reservation.discard();
      expect(await readFile(path, "utf8")).toBe('{"replacement":true}');
      expect(await readFile(moved, "utf8")).toBe("");
    } finally {
      await reservation.discard();
    }
  });

  test("does not discard or overwrite a publication already in progress", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "nautilo-handoff-writing-")));
    roots.push(root);
    const path = join(root, "invite.json");
    const reservation = await reserveProtectedHandoff(path);
    const publication = reservation.write({ token: "first" });
    try {
      await rejects(reservation.discard(), ProtectedHandoffError);
      await rejects(reservation.write({ token: "second" }), ProtectedHandoffError);
      await publication;
      await reservation.discard();
      expect(await readProtectedHandoff(path)).toEqual({ token: "first" });
    } finally {
      await publication.catch(() => undefined);
      await reservation.discard();
    }
  });

  test("refuses a private JSON handoff larger than the read limit", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "nautilo-handoff-large-")));
    roots.push(root);
    const path = join(root, "large.json");
    await writeProtectedHandoff(path, { padding: "x".repeat(1024 * 1024) });
    await rejects(readProtectedHandoff(path), ProtectedHandoffError);
  });
});
