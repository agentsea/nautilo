import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).toBe('{\n  "stage": "databases"\n}\n');
  });

  test("rejects traversal, symlinks, shared files, and invalid JSON", async () => {
    expect(() => new RailwayLaunchStateStore({ root, path: join(root, "..", "outside.json"), validate })).toThrow();
    const target = join(root, "target.json");
    const linked = join(root, "linked.json");
    await writeFile(target, '{"stage":"x"}', { mode: 0o600 });
    await symlink(target, linked);
    expect(new RailwayLaunchStateStore({ root, path: linked, validate }).read()).rejects.toThrow();
    await rm(linked);
    await chmod(target, 0o644);
    expect(new RailwayLaunchStateStore({ root, path: target, validate }).read()).rejects.toThrow();
    await chmod(target, 0o600);
    await writeFile(target, '{"wrong":true}', { mode: 0o600 });
    expect(new RailwayLaunchStateStore({ root, path: target, validate }).read()).rejects.toThrow();
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
    expect(discoverRailwayLaunchStates({ root, validate, identity })).rejects.toThrow();
    await rm(join(root, "launches", "loose.json"));
    await writeFile(join(root, "launches", "launch-a", "state.json"), '{"stage":"launch-forged"}', { mode: 0o600 });
    expect(discoverRailwayLaunchStates({ root, validate, identity })).rejects.toThrow();
  });
});
