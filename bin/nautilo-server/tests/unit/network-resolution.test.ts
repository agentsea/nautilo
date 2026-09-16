/**
 * M071 — network bind / hostname wiring must flow through `resolveInstance()`
 * (env merged in @nautilo/config), not duplicated literals in the server entry.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_INDEX = resolve(THIS_DIR, "../../src/index.ts");

describe("nautilo-server network resolution (M071)", () => {
  const source = readFileSync(SERVER_INDEX, "utf-8");

  test("reads listen bundle from resolveInstance()", () => {
    expect(source).toContain("resolveInstance()");
    expect(source).toContain("inst.server.host");
    expect(source).toContain("inst.server.port");
  });

  test("TLS identity and mDNS use split hostname fields from instance", () => {
    expect(source).toContain("inst.hostname.federated");
    expect(source).toContain("inst.hostname.mdns");
  });

  test("named instances get unique default mDNS service names", () => {
    expect(source).toContain("function defaultMdnsServiceName(instanceId: string)");
    expect(source).toContain("`Nautilo ${id}`");
    expect(source).toContain("defaultMdnsServiceName(inst.instanceId)");
  });

  test("still uses findAvailablePort as last-resort bind safety", () => {
    expect(source).toContain("findAvailablePort(");
  });

  test("does not duplicate legacy NAUTILO_HOST default literal", () => {
    expect(source).not.toMatch(
      /process\.env\["NAUTILO_HOST"\]\s*\?\?\s*["']127\.0\.0\.1["']/,
    );
  });

  test("posture sidecar path uses resolveNautiloRootDir (same root as instance)", () => {
    expect(source).toContain('join(resolveNautiloRootDir(), "posture.json")');
  });
});
