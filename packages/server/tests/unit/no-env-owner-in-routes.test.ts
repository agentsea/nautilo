/**
 * M075 NFR-A2 / M077 Bundle 1 / D120 A1.P1 — routes must not read
 * deployment owner ids from `process.env["NAUTILO_OWNER_ID"]` or
 * `NAUTILO_OWNER_ACTOR_ID` (use `request.sessionUserId`,
 * `request.memoryEnvelope`, injected deps, or the
 * `getBootstrapOwnerId()` cache from `@nautilo/trust`).
 *
 * D120 A1.P1 retired the previous `webfinger.ts` allowlist: that route
 * now reads the bootstrap-state-cache instead of process.env, so the
 * sweep below is total — every routes/**\/*.ts must be env-clean.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ENV_OWNER_ID = String.raw`process.env["NAUTILO_OWNER_ID"]`;
const ENV_OWNER_ACTOR = String.raw`process.env["NAUTILO_OWNER_ACTOR_ID"]`;

function stripLineAndBlockComments(source: string): string {
  let s = source.replace(/\/\*[\s\S]*?\*\//g, "");
  s = s
    .split("\n")
    .map((line) => line.replace(/\/\/[^\n]*/, ""))
    .join("\n");
  return s;
}

function* walkRouteTsFiles(dir: string): Generator<string> {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      yield* walkRouteTsFiles(p);
    } else if (ent.isFile() && ent.name.endsWith(".ts")) {
      yield p;
    }
  }
}

describe("NFR-A2 — no env-owner reads in routes", () => {
  test("packages/server/src/routes/**/*.ts (minus allowlist) omit NAUTILO_OWNER_* env reads", () => {
    const routesRoot = join(import.meta.dirname, "../../src/routes");
    expect(statSync(routesRoot).isDirectory()).toBe(true);

    for (const abs of walkRouteTsFiles(routesRoot)) {
      const raw = readFileSync(abs, "utf8");
      const stripped = stripLineAndBlockComments(raw);
      expect(stripped).not.toContain(ENV_OWNER_ID);
      expect(stripped).not.toContain(ENV_OWNER_ACTOR);
    }
  });
});
