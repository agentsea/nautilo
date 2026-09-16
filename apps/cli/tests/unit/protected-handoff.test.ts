import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, realpath, stat, symlink } from "node:fs/promises";
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

    expect((await stat(path)).mode & 0o777).toBe(0o600);
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
    await chmod(path, 0o644);
    expect(readProtectedHandoff(path)).rejects.toBeInstanceOf(ProtectedHandoffError);
  });

  test("rejects relative/stdout/existing destinations", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "nautilo-handoff-")));
    roots.push(root);
    const path = join(root, "invite.json");
    await writeProtectedHandoff(path, { token: "first" });

    for (const destination of ["relative.json", "-", path]) {
      expect(writeProtectedHandoff(destination, { token: "second" }))
        .rejects.toBeInstanceOf(ProtectedHandoffError);
    }
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ token: "first" });
  });

  test("rejects a symlinked parent and does not create the target", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "nautilo-handoff-")));
    roots.push(root);
    const real = join(root, "real");
    const linked = join(root, "linked");
    await mkdir(real);
    await symlink(real, linked);

    expect(writeProtectedHandoff(join(linked, "invite.json"), { token: "CANARY" }))
      .rejects.toBeInstanceOf(ProtectedHandoffError);
  });

  test("reserves before mutation and discards an unused destination", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "nautilo-handoff-")));
    roots.push(root);
    const path = join(root, "invite.json");
    const reservation = await reserveProtectedHandoff(path);

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).toBe("");
    await reservation.discard();
    expect(readFile(path, "utf8")).rejects.toBeDefined();
  });
});
