import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetResolvedInstanceForTests, resolveInstance } from "@nautilo/config";

/**
 * Contract: `bin/nautilo-server` passes `inst.hostname.mdns` into
 * `startMdns({ hostname })`. This test locks the resolver field that feeds it.
 */
describe("mDNS hostname (instance bundle)", () => {
  let userHomeDir: string;

  beforeEach(() => {
    __resetResolvedInstanceForTests();
    userHomeDir = mkdtempSync(join(tmpdir(), "nautilo-mdns-"));
  });

  afterEach(() => {
    __resetResolvedInstanceForTests();
    rmSync(userHomeDir, { recursive: true, force: true });
  });

  test("defaults mdns host to nautilo.local", () => {
    const env = { HOME: userHomeDir, NAUTILO_INSTANCE_ID: "" } as NodeJS.ProcessEnv;
    const inst = resolveInstance(env, { userHomeDir });
    expect(inst.hostname.mdns).toBe("nautilo.local");
  });

  test("NAUTILO_MDNS_HOSTNAME overrides mdns host", () => {
    const env = {
      HOME: userHomeDir,
      NAUTILO_INSTANCE_ID: "",
      NAUTILO_MDNS_HOSTNAME: "mybox.local",
    } as NodeJS.ProcessEnv;
    const inst = resolveInstance(env, { userHomeDir });
    expect(inst.hostname.mdns).toBe("mybox.local");
  });
});
