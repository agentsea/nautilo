/**
 * M071 Phase 2C — `list-instances` helpers (no Docker).
 * Lives with `@nautilo/instance-discovery` implementation.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalInstanceIdFromRoot,
  displayInstanceIdFromRoot,
  formatLocalInstancesTable,
  listLocalInstances,
} from "../../src/node.ts";

describe("listLocalInstances", () => {
  let home: string | undefined;

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test("displayId + canonical id from root paths", () => {
    expect(displayInstanceIdFromRoot("/Users/x/.nautilo")).toBe("(default)");
    expect(canonicalInstanceIdFromRoot("/Users/x/.nautilo")).toBe("");
    expect(displayInstanceIdFromRoot("/Users/x/.nautilo-beta")).toBe("beta");
    expect(canonicalInstanceIdFromRoot("/Users/x/.nautilo-beta")).toBe("beta");
  });

  test("default + named rows, health probe mocked", async () => {
    home = mkdtempSync(join(tmpdir(), "nautilo-li-"));
    const defRoot = join(home, ".nautilo");
    const betaRoot = join(home, ".nautilo-beta");
    mkdirSync(defRoot, { recursive: true });
    mkdirSync(betaRoot, { recursive: true });

    const valid = (instanceId: string, serverPort: number) =>
      JSON.stringify({
        schemaVersion: 1,
        instanceId,
        server: { host: "127.0.0.1", port: serverPort, url: `http://127.0.0.1:${serverPort}` },
        workbench: { port: serverPort + 1, url: `http://127.0.0.1:${serverPort + 1}` },
        db: {
          directConnection: "postgresql://x",
          neonProxyPort: 4445,
          postgresHostPort: 5434,
        },
        logto: { dbPort: 5432, corePort: 3301, adminPort: 3302 },
        compose: { projectName: instanceId === "" ? "nautilo" : `nautilo-${instanceId}` },
        hostname: {
          federated: "n.local",
          mdns: "n.local",
          tlsSan: "n.local",
          caddyAuthHost: "a.local",
          caddyAuthAdminHost: "aa.local",
        },
      });

    writeFileSync(join(defRoot, "instance.json"), `${valid("", 3001)}\n`, "utf8");
    writeFileSync(join(betaRoot, "instance.json"), `${valid("beta", 3101)}\n`, "utf8");
    const badRoot = join(home, ".nautilo-badjson");
    mkdirSync(badRoot, { recursive: true });
    writeFileSync(join(badRoot, "instance.json"), "{ not-json", "utf8");

    const rows = await listLocalInstances(home, {
      probeHealth: async (url) => url.includes(":3001/"),
    });

    const byId = new Map(rows.map((r) => [r.instanceId, r]));
    expect(byId.get("")?.state).toBe("running");
    expect(byId.get("beta")?.state).toBe("idle");
    expect(byId.get("badjson")?.state).toBe("invalid-json");

    const table = formatLocalInstancesTable(rows);
    expect(table).toContain("(default)");
    expect(table).toContain("nautilo-beta");
  });

  test("omits Nautilo internal support directories", async () => {
    home = mkdtempSync(join(tmpdir(), "nautilo-li-support-"));
    for (const name of [
      ".nautilo-backups",
      ".nautilo-clone-seeds",
      ".nautilo-dev",
      ".nautilo-local-secrets",
    ]) {
      mkdirSync(join(home, name), { recursive: true });
    }
    mkdirSync(join(home, ".nautilo-real"), { recursive: true });

    const rows = await listLocalInstances(home, { probeHealth: async () => false });
    expect(rows.map((row) => row.instanceId)).toEqual(["real"]);
  });

  test("recognizes tunnel support by its matching launchd file without hiding damaged instances", async () => {
    home = mkdtempSync(join(tmpdir(), "nautilo-li-support-shape-"));
    for (const id of ["support", "missing", "mismatch", "directory", "invalid"]) {
      const root = join(home, `.nautilo-${id}-tunnel`);
      mkdirSync(root, { recursive: true });
      if (id === "directory") mkdirSync(join(root, `ai.nautilo.${id}-tunnel.plist`));
      if (id === "support" || id === "invalid") writeFileSync(join(root, `ai.nautilo.${id}-tunnel.plist`), "fixture");
      if (id === "mismatch") writeFileSync(join(root, "ai.nautilo.other-tunnel.plist"), "fixture");
      if (id === "invalid") writeFileSync(join(root, "instance.json"), "{broken");
    }
    const rows = await listLocalInstances(home, { probeHealth: async () => false });
    expect(rows.map(({ instanceId, state }) => ({ instanceId, state }))).toEqual([
      { instanceId: "directory-tunnel", state: "no-instance-json" },
      { instanceId: "invalid-tunnel", state: "invalid-json" },
      { instanceId: "mismatch-tunnel", state: "no-instance-json" },
      { instanceId: "missing-tunnel", state: "no-instance-json" },
    ]);
  });

  test("keeps a configured tunnel-suffixed instance diagnosable", async () => {
    home = mkdtempSync(join(tmpdir(), "nautilo-li-tunnel-"));
    const root = join(home, ".nautilo-alpha-tunnel");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "ai.nautilo.alpha-tunnel.plist"), "fixture");
    writeFileSync(
      join(root, "instance.json"),
      JSON.stringify({
        schemaVersion: 1,
        instanceId: "alpha-tunnel",
        server: { host: "127.0.0.1", port: 3001, url: "http://127.0.0.1:3001" },
        workbench: { port: 3000, url: "http://127.0.0.1:3000" },
        db: { directConnection: "postgresql://x", postgresHostPort: 5434 },
        logto: { dbPort: 5432, corePort: 3301, adminPort: 3302 },
        compose: { projectName: "nautilo-alpha-tunnel" },
        hostname: {
          federated: "alpha.example.test",
          mdns: "alpha.local",
          tlsSan: "alpha.local",
          caddyAuthHost: "auth.alpha.local",
          caddyAuthAdminHost: "auth-admin.alpha.local",
        },
      }),
      "utf8",
    );

    const rows = await listLocalInstances(home, { probeHealth: async () => false });
    expect(rows).toMatchObject([{ instanceId: "alpha-tunnel", state: "idle" }]);
  });

  test("contradictory instance.json ID is invalid rather than local evidence", async () => {
    home = mkdtempSync(join(tmpdir(), "nautilo-li-conflict-"));
    const root = join(home, ".nautilo-alpha");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "instance.json"),
      JSON.stringify({
        schemaVersion: 1,
        instanceId: "beta",
        server: { host: "127.0.0.1", port: 3001, url: "http://127.0.0.1:3001" },
        workbench: { port: 3000, url: "http://127.0.0.1:3000" },
        db: { directConnection: "postgresql://x", postgresHostPort: 5434 },
        logto: { dbPort: 5432, corePort: 3301, adminPort: 3302 },
        compose: { projectName: "nautilo-beta" },
        hostname: {
          federated: "n.local",
          mdns: "n.local",
          tlsSan: "n.local",
          caddyAuthHost: "a.local",
          caddyAuthAdminHost: "aa.local",
        },
      }),
    );
    const rows = await listLocalInstances(home, { probeHealth: async () => true });
    expect(rows[0]?.state).toBe("invalid-json");
    expect(rows[0]?.detail).toContain("contradicts root instance ID");
  });
});
