import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import {
  assertRestoreIdentityCompatible,
  buildReadConnectedInstanceIdentityScript,
  parseConnectedInstanceIdentity,
  readRestoreInstanceIdentityFromDump,
} from "../../src/restore-instance-identity.ts";

const tmpDirs: string[] = [];

function writeDump(lines: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "restore-identity-"));
  tmpDirs.push(root);
  const path = join(root, "nautilo.sql.gz");
  writeFileSync(path, gzipSync([...lines, ""].join("\n")));
  return path;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reads the modern authority tuple using the COPY header's column order", async () => {
  const path = writeDump([
    "COPY public.nautilo_instance_identity (server_binding_generation, id, server_instance_id, instance_id, created_at) FROM stdin;",
    "4\tself\t123e4567-e89b-42d3-a456-426614174000\tprod\t2026-05-19 12:00:00+00",
    String.raw`\.`,
  ]);

  const identity = await readRestoreInstanceIdentityFromDump(path);
  expect(identity).toEqual({
    instanceId: "prod",
    serverInstanceId: "123e4567-e89b-42d3-a456-426614174000",
    serverBindingGeneration: 4,
  });
});

test("distinguishes a pre-D458 identity row from a modern authority tuple", async () => {
  const path = writeDump([
    "COPY public.nautilo_instance_identity (id, instance_id, created_at) FROM stdin;",
    "self\tlegacy\t2026-05-19 12:00:00+00",
    String.raw`\.`,
  ]);

  const identity = await readRestoreInstanceIdentityFromDump(path);
  expect(identity).toEqual({
    instanceId: "legacy",
  });
});

test("connected identity probe preserves the empty default deployment label", () => {
  expect(
    parseConnectedInstanceIdentity(
      '{"id":"self","instance_id":"","server_instance_id":"123e4567-e89b-42d3-a456-426614174000","server_binding_generation":1}\n',
    ),
  ).toEqual({
    instanceId: "",
    serverInstanceId: "123e4567-e89b-42d3-a456-426614174000",
    serverBindingGeneration: 1,
  });
});

test("target compatibility accepts exact continuity and refuses authority transfer", () => {
  const bundle = {
    instanceId: "prod",
    serverInstanceId: "123e4567-e89b-42d3-a456-426614174000",
    serverBindingGeneration: 2,
  };
  expect(() =>
    assertRestoreIdentityCompatible({
      bundle,
      target: { ...bundle },
      manifestInstanceId: "prod",
      targetInstanceId: "prod",
    }),
  ).not.toThrow();

  expect(() =>
    assertRestoreIdentityCompatible({
      bundle,
      target: {
        ...bundle,
        serverInstanceId: "987e6543-e21b-42d3-a456-426614174999",
      },
      manifestInstanceId: "prod",
      targetInstanceId: "prod",
    }),
  ).toThrow(/different logical server identity/);
});

test("connected identity probe is read-only", () => {
  const script = buildReadConnectedInstanceIdentityScript("psql");
  expect(script).toContain("to_jsonb(identity_row)");
  expect(script).not.toMatch(/\b(?:DELETE|INSERT|UPDATE|DROP|ALTER)\b/);
});
