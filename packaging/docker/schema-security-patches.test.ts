import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

test("the production closure selects patched schema and request parsers", () => {
  for (const filename of ["../../package.json", "runtime-install/package.json"]) {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, filename), "utf8"));
    if (filename === "runtime-install/package.json") expect(manifest.overrides.zod).toBe("4.6.7");
    else expect(manifest.dependencies.zod).toBe("4.6.7");
    expect(manifest.overrides["body-parser"]).toBe("2.4.0");
    expect(manifest.overrides.qs).toBe("6.16.1");
  }
  for (const filename of ["../../bun.lock", "runtime-install/bun.lock"]) {
    const lock = readFileSync(join(import.meta.dir, filename), "utf8");
    expect([filename, lock.includes('"zod@4.6.7"')]).toEqual([filename, true]);
    expect(lock).toContain('"body-parser@2.4.0"');
    expect(lock).not.toContain('"@langchain/core/zod":');
    if (filename === "runtime-install/bun.lock") {
      for (const vulnerable of ["3.24.3", "3.25.76", "4.3.6", "4.4.3"]) expect(lock).not.toContain(`"zod@${vulnerable}"`);
    }
    expect(lock).not.toContain('"body-parser@2.3.0"');
  }
});

test("bounded containers reject oversized input before walking elements", () => {
  let elementsRead = 0;
  const values = Array(100).fill(0);
  Object.defineProperty(values, 0, { get: () => { elementsRead += 1; return 0; } });
  const result = z.array(z.string()).max(1).safeParse(values);
  expect(result.success).toBe(false);
  expect(elementsRead).toBe(0);
  if (!result.success) expect(result.error.issues.map(issue => issue.code)).toEqual(["too_big"]);
});

test("standalone seeded app locks retain the patched shared schema dependency", () => {
  const dockerfile = readFileSync(join(import.meta.dir, "Dockerfile"), "utf8");
  const copiedApps = [...dockerfile.matchAll(/COPY --from=deps \/repo\/packages\/first-party-apps\/([a-z-]+)\/node_modules/g)]
    .map(match => match[1]!);
  expect(copiedApps).toContain("writer");
  expect(copiedApps).toContain("video");
  for (const app of copiedApps) {
    const lock = readFileSync(join(import.meta.dir, "../../packages/first-party-apps", app, "bun.lock"), "utf8");
    if (app === "writer" || app === "video") expect([app, lock.includes('"zod@')]).toEqual([app, true]);
    if (!lock.includes('"zod@')) continue;
    expect([app, lock.includes('"zod@4.6.7"')]).toEqual([app, true]);
    for (const vulnerable of ["3.24.3", "3.25.76", "4.3.6", "4.4.3"]) {
      expect([app, vulnerable, lock.includes(`"zod@${vulnerable}"`)]).toEqual([app, vulnerable, false]);
      expect([app, vulnerable, lock.includes(`"zod": "${vulnerable}"`)]).toEqual([app, vulnerable, false]);
    }
  }
});
