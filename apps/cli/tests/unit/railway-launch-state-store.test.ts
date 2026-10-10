import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { allowOtherReaders } from "@nautilo/config/private-filesystem-fixtures";
import * as crypto from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { rejects } from "node:assert/strict";
import { ensurePrivateDirectory, isPrivateFilesystemPathAsync, secureFilesystemPath, writePrivateFileExclusive } from "@nautilo/config/private-filesystem";

import { discoverRailwayLaunchStates, RailwayLaunchStateStore } from "../../src/lib/railway-launch-state-store.ts";

interface State { readonly stage: string }
const validate = (value: unknown): State => {
  if (typeof value !== "object" || value === null || !("stage" in value)
    || typeof value.stage !== "string" || Object.keys(value).length !== 1) {
    throw new Error("invalid");
  }
  return { stage: value.stage };
};

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "railway-state-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("Railway launch state store", () => {
  test("atomically writes owner-only validated state and reads it", async () => {
    const path = join(root, "launches", "launch-1", "workflow.json");
    const store = new RailwayLaunchStateStore({ root, path, validate });
    await store.write({ stage: "databases" });
    expect(await store.read()).toEqual({ stage: "databases" });
    expect(await isPrivateFilesystemPathAsync(path)).toBe(true);
    expect(await isPrivateFilesystemPathAsync(join(root, "launches"))).toBe(true);
    expect(await readFile(path, "utf8")).toBe('{\n  "stage": "databases"\n}\n');
  });

  test("rejects traversal, symlinks, shared files, and invalid JSON", async () => {
    expect(() => new RailwayLaunchStateStore({ root, path: join(root, "..", "outside.json"), validate })).toThrow();
    const target = join(root, "target.json");
    const linked = join(root, "linked.json");
    await writePrivateFileExclusive(target, Buffer.from('{"stage":"x"}', "utf8"));
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(process.platform === "win32" ? outside : target, linked, process.platform === "win32" ? "junction" : "file");
    await rejects(new RailwayLaunchStateStore({ root, path: linked, validate }).read());
    await rm(linked, { recursive: true });
    await allowOtherReaders(target);
    await rejects(new RailwayLaunchStateStore({ root, path: target, validate }).read());
    await secureFilesystemPath(target);
    await writeFile(target, '{"wrong":true}', { mode: 0o600 });
    await rejects(new RailwayLaunchStateStore({ root, path: target, validate }).read());
  });

  test("discovers every exact saved launch in deterministic order without adopting loose files", async () => {
    for (const launchId of ["launch-b", "launch-a"]) {
      await new RailwayLaunchStateStore({ root, path: join(root, "launches", launchId, "state.json"), validate }).write({ stage: launchId });
    }
    const identity = (state: State) => state.stage;
    expect(await discoverRailwayLaunchStates({ root, validate, identity })).toEqual([
      { launchId: "launch-a", state: { stage: "launch-a" } },
      { launchId: "launch-b", state: { stage: "launch-b" } },
    ]);
    await writeFile(join(root, "launches", "loose.json"), "{}", { mode: 0o600 });
    await rejects(discoverRailwayLaunchStates({ root, validate, identity }));
    await rm(join(root, "launches", "loose.json"));
    await writeFile(join(root, "launches", "launch-a", "state.json"), '{"stage":"launch-forged"}', { mode: 0o600 });
    await rejects(discoverRailwayLaunchStates({ root, validate, identity }));
  });

  test("accepts children of a filesystem root without admitting the root itself", () => {
    const volume = parse(root).root;
    expect(() => new RailwayLaunchStateStore({ root: volume, path: join(volume, "launches", "state.json"), validate })).not.toThrow();
    expect(() => new RailwayLaunchStateStore({ root: volume, path: volume, validate })).toThrow();
  });

  test.each(["read", "write"] as const)("%s rejects an ancestor-directory link before touching outside state", async (operation) => {
    const trusted = join(root, "trusted");
    const outside = join(root, "outside");
    const outsideDirectory = join(outside, "launch-1");
    await ensurePrivateDirectory(trusted);
    await ensurePrivateDirectory(outsideDirectory);
    await symlink(outside, join(trusted, "launches"), process.platform === "win32" ? "junction" : "dir");
    const outsideFile = join(outsideDirectory, "state.json");
    const body = '{"stage":"outside"}';
    if (operation === "read") await writePrivateFileExclusive(outsideFile, Buffer.from(body, "utf8"));
    const store = new RailwayLaunchStateStore({ root: trusted, path: join(trusted, "launches", "launch-1", "state.json"), validate });
    if (operation === "read") {
      await rejects(store.read());
      expect(await readFile(outsideFile, "utf8")).toBe(body);
    } else {
      await rejects(store.write({ stage: "must-not-write" }));
      await rejects(readFile(outsideFile), { code: "ENOENT" });
    }
  });

  test("concurrent writes leave one complete private state and no temporary files", async () => {
    const directory = join(root, "launches", "concurrent");
    const path = join(directory, "state.json");
    const store = new RailwayLaunchStateStore({ root, path, validate });
    const stages = ["first", "second", "third"];
    await Promise.all(stages.map((stage) => store.write({ stage })));
    const saved = await store.read();
    if (!saved) throw new Error("Concurrent writers left no state");
    expect(stages).toContain(saved.stage);
    expect(await isPrivateFilesystemPathAsync(path)).toBe(true);
    expect(await readdir(directory)).toEqual(["state.json"]);
  });

  test("a temporary-file collision preserves both the previous state and the colliding file", async () => {
    const path = join(root, "launches", "collision", "state.json");
    const store = new RailwayLaunchStateStore({ root, path, validate });
    await store.write({ stage: "previous" });
    const id = "00000000-0000-4000-8000-000000000001";
    const temporary = `${path}.${process.pid}.${id}.tmp`;
    await writePrivateFileExclusive(temporary, Buffer.from("unrelated bytes", "utf8"));
    const ids = spyOn(crypto, "randomUUID").mockReturnValue(id);
    try { await rejects(store.write({ stage: "replacement" })); }
    finally { ids.mockRestore(); }
    expect(await store.read()).toEqual({ stage: "previous" });
    expect(await readFile(temporary, "utf8")).toBe("unrelated bytes");
  });
});
