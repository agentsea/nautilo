/**
 * NautiloClient integration tests — exercise VmScanClient + scan-helper
 * against live VMs. Requires NAUTILO_SMOKE_INTEGRATION=1.
 */

import { describe, test, expect } from "bun:test";
import { VmScanClient } from "../../src/nautilo-client.ts";
import { LimaDriver } from "../../src/lima-driver.ts";
import { TartDriver } from "../../src/tart-driver.ts";

const INTEGRATION = process.env["NAUTILO_SMOKE_INTEGRATION"] === "1";
const describeIntegration = INTEGRATION ? describe : describe.skip;

describeIntegration("VmScanClient — Lima (Linux)", () => {
  const client = new VmScanClient(new LimaDriver());

  test("blocks 'rm -rf /' at standard level", async () => {
    const r = await client.securityScan({
      layer: "command",
      level: "standard",
      input: "rm -rf /",
    });
    expect(r.blocked).toBe(true);
    expect(r.reason?.toLowerCase()).toContain("critical");
    expect(r.matchedPatterns?.length ?? 0).toBeGreaterThan(0);
  }, 15_000);

  test("allows safe command", async () => {
    const r = await client.securityScan({
      layer: "command",
      level: "standard",
      input: "echo hello world",
    });
    expect(r.blocked).toBe(false);
  }, 15_000);

  test("yolo level bypasses scanner", async () => {
    const r = await client.securityScan({
      layer: "command",
      level: "yolo",
      input: "sudo apt install evil",
    });
    expect(r.blocked).toBe(false);
  }, 15_000);

  test("blocks /etc/passwd read", async () => {
    const r = await client.securityScan({
      layer: "path",
      level: "standard",
      input: "/etc/passwd",
    });
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain("/etc");
  }, 15_000);

  test("blocks ~/.ssh/id_rsa read", async () => {
    const r = await client.securityScan({
      layer: "path",
      level: "standard",
      input: "~/.ssh/id_rsa",
    });
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain(".ssh");
  }, 15_000);

  test("detects invisible Unicode in content", async () => {
    const r = await client.securityScan({
      layer: "content",
      level: "standard",
      input: "hello\u200bworld",
      source: "test_source",
    });
    expect(r.blocked).toBe(true);
    expect(r.matchedThreats?.length ?? 0).toBeGreaterThan(0);
  }, 15_000);

  test("handles command with embedded single-quotes", async () => {
    // Shell quoting edge case — this payload previously broke in
    // implementations that single-quoted the command for bash.
    const r = await client.securityScan({
      layer: "command",
      level: "standard",
      input: "echo 'hello there'",
    });
    expect(r.blocked).toBe(false);
  }, 15_000);
});

describeIntegration("VmScanClient — Tart (macOS)", () => {
  const client = new VmScanClient(new TartDriver());

  test("blocks 'rm -rf /' at standard level", async () => {
    const r = await client.securityScan({
      layer: "command",
      level: "standard",
      input: "rm -rf /",
    });
    expect(r.blocked).toBe(true);
  }, 15_000);

  test("allows safe command", async () => {
    const r = await client.securityScan({
      layer: "command",
      level: "standard",
      input: "echo hello",
    });
    expect(r.blocked).toBe(false);
  }, 15_000);

  test("blocks /etc/hosts write", async () => {
    const r = await client.securityScan({
      layer: "path",
      level: "standard",
      input: "/etc/hosts",
    });
    expect(r.blocked).toBe(true);
  }, 15_000);
});
