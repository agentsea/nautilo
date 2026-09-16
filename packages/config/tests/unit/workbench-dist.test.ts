import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDefaultWorkbenchDist } from "../../src/workbench-dist";

describe("resolveDefaultWorkbenchDist", () => {
  let tmpRoot: string;

  afterEach(() => {
    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = "";
    }
  });

  test("returns dist path when index.html exists", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "nautilo-wbench-dist-"));
    const dist = join(tmpRoot, "apps/workbench/dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html>");

    expect(resolveDefaultWorkbenchDist(tmpRoot)).toBe(dist);
  });

  test("returns null when dist exists without index.html", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "nautilo-wbench-dist-"));
    const dist = join(tmpRoot, "apps/workbench/dist");
    mkdirSync(dist, { recursive: true });

    expect(resolveDefaultWorkbenchDist(tmpRoot)).toBeNull();
  });

  test("returns null when apps/workbench/dist is missing", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "nautilo-wbench-dist-"));

    expect(resolveDefaultWorkbenchDist(tmpRoot)).toBeNull();
  });
});
