/**
 * M071 Phase 2C — `delete-instance` (mocked docker + rm; no real home mutation).
 */
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteInstance } from "../../src/commands/delete-instance";
import { persistDurableProfileAuthority, persistLocalProfileRetention, protectInstance } from "../../src/commands/protect-instance";

const validInstanceJson = (instanceId: string) =>
  JSON.stringify({
    schemaVersion: 1,
    instanceId,
    server: { host: "127.0.0.1", port: 3001, url: "http://127.0.0.1:3001" },
    workbench: { port: 5173, url: "http://127.0.0.1:5173" },
    db: {
      directConnection: "postgresql://x",
      postgresHostPort: 5434,
    },
    logto: { dbPort: 5432, corePort: 3301, adminPort: 3302 },
    compose: { projectName: `nautilo-${instanceId}` },
    hostname: {
      federated: "x.local",
      mdns: "x.local",
      tlsSan: "x.local",
      caddyAuthHost: "a.local",
      caddyAuthAdminHost: "aa.local",
    },
  });

describe("delete-instance", () => {
  test("protect-instance marks an existing named instance and delete-instance preserves it", async () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-protect-instance-"));
    try {
      const root = join(home, ".nautilo-capture-baseline");
      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(root, "instance.json"),
        `${validInstanceJson("capture-baseline")}\n`,
        "utf8",
      );
      expect(protectInstance({ id: "capture-baseline", userHomeDir: home })).toBe(0);
      expect(protectInstance({ id: "capture-baseline", userHomeDir: home })).toBe(0);
      expect(readFileSync(join(root, ".protected-instance"), "utf8")).toBe(
        "protected-by=operator\n",
      );
      expect(readFileSync(join(home, ".nautilo", "profiles", "capture-baseline.toml"), "utf8"))
        .toContain('retention = "durable"');

      // Instance-local state may be replaced by restore/recreation. Persisted
      // profile authority must continue refusing deletion without the marker.
      rmSync(root, { recursive: true, force: true });
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "instance.json"), `${validInstanceJson("capture-baseline")}\n`, "utf8");

      let mutated = false;
      const code = await deleteInstance(
        { id: "capture-baseline", yes: true, userHomeDir: home },
        {
          runDockerCompose: async () => {
            mutated = true;
            return 0;
          },
          removeInstanceRoot: () => {
            mutated = true;
          },
          killPortListeners: () => {
            mutated = true;
            return { killed: [] };
          },
        },
      );
      expect(code).toBe(1);
      expect(mutated).toBe(false);
      expect(existsSync(root)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("protect-instance refuses an unproven or mismatched instance root", () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-protect-instance-refuse-"));
    try {
      const root = join(home, ".nautilo-capture-baseline");
      mkdirSync(root, { recursive: true });
      expect(protectInstance({ id: "capture-baseline", userHomeDir: home })).toBe(1);
      expect(existsSync(join(root, ".protected-instance"))).toBe(false);

      writeFileSync(
        join(root, "instance.json"),
        `${validInstanceJson("different-instance")}\n`,
        "utf8",
      );
      expect(protectInstance({ id: "capture-baseline", userHomeDir: home })).toBe(1);
      expect(existsSync(join(root, ".protected-instance"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("profile retention writer refuses linked authority roots and profile files", () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-protect-linked-"));
    try {
      const outside = join(home, "outside");
      mkdirSync(outside);
      mkdirSync(join(home, ".nautilo"));
      symlinkSync(outside, join(home, ".nautilo", "profiles"));
      expect(() => persistDurableProfileAuthority(home, "kept")).toThrow("linked profiles authority root");
      rmSync(join(home, ".nautilo", "profiles"));
      mkdirSync(join(home, ".nautilo", "profiles"));
      const target = join(outside, "kept.toml");
      writeFileSync(target, 'transport = "local"\nlifecycle = "compose"\ninstance_id = "kept"\n');
      symlinkSync(target, join(home, ".nautilo", "profiles", "kept.toml"));
      expect(() => persistDurableProfileAuthority(home, "kept")).toThrow("non-regular profile");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("disposable persistence never downgrades legacy or durable profile authority", () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-protect-no-downgrade-"));
    try {
      const profiles = join(home, ".nautilo", "profiles");
      mkdirSync(profiles, { recursive: true });
      const path = join(profiles, "kept.toml");
      const legacy = 'transport = "local"\nlifecycle = "compose"\ninstance_id = "kept"\n';
      writeFileSync(path, legacy);
      expect(() => persistLocalProfileRetention(home, "kept", "disposable")).toThrow("refusing to downgrade");
      expect(readFileSync(path, "utf8")).toBe(legacy);
      persistDurableProfileAuthority(home, "kept");
      const durable = readFileSync(path, "utf8");
      expect(durable).toContain('retention = "durable"');
      expect(() => persistLocalProfileRetention(home, "kept", "disposable")).toThrow("refusing to downgrade");
      expect(readFileSync(path, "utf8")).toBe(durable);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses without --yes", async () => {
    const code = await deleteInstance({ id: "beta", yes: false });
    expect(code).toBe(1);
  });

  test("refuses default (empty) id", async () => {
    const code = await deleteInstance({ id: "", yes: true });
    expect(code).toBe(1);
  });

  test("refuses invalid id", async () => {
    const code = await deleteInstance({ id: "BAD", yes: true });
    expect(code).toBe(1);
  });

  test("refuses any named fixture carrying the protected-instance marker", async () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-del-marked-"));
    try {
      const root = join(home, ".nautilo-capture-baseline");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "instance.json"), `${validInstanceJson("capture-baseline")}\n`, "utf8");
      writeFileSync(join(root, ".protected-instance"), "purpose=publication\n", "utf8");
      let mutated = false;
      const code = await deleteInstance(
        { id: "capture-baseline", yes: true, userHomeDir: home },
        {
          runDockerCompose: async () => {
            mutated = true;
            return 0;
          },
          removeInstanceRoot: () => {
            mutated = true;
          },
          killPortListeners: () => {
            mutated = true;
            return { killed: [] };
          },
        },
      );
      expect(code).toBe(1);
      expect(mutated).toBe(false);
      expect(existsSync(root)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("missing instance dir without a local profile is unknown and preserved", async () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-del-orphan-"));
    try {
      const runs: string[][] = [];
      const code = await deleteInstance(
        { id: "ghost", yes: true, userHomeDir: home },
        {
          runDockerCompose: async (args) => {
            runs.push(args);
            return 0;
          },
        },
      );
      expect(code).toBe(1);
      expect(runs).toHaveLength(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("kills zombie host processes on instance.json server/workbench ports", async () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-del-zombie-"));
    try {
      const root = join(home, ".nautilo-eta");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "instance.json"), `${validInstanceJson("eta")}\n`, "utf8");

      const calls: number[] = [];
      const code = await deleteInstance(
        { id: "eta", yes: true, userHomeDir: home },
        {
          runDockerCompose: async () => 0,
          removeInstanceRoot: (r) => {
            rmSync(r, { recursive: true, force: true });
          },
          killPortListeners: (port) => {
            calls.push(port);
            return { killed: [42_000 + port] };
          },
        },
      );
      expect(code).toBe(0);
      // server.port=3001, workbench.port=5173 from validInstanceJson
      expect(calls).toEqual([3001, 5173]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("local profile proves exact orphan teardown while missing JSON skips port-kill", async () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-del-nokill-"));
    try {
      const profiles = join(home, ".nautilo", "profiles");
      mkdirSync(profiles, { recursive: true });
      writeFileSync(
        join(profiles, "nokill.toml"),
        'transport = "local"\nlifecycle = "compose"\ninstance_id = "nokill"\nretention = "disposable"\n',
      );
      let killCalled = false;
      const code = await deleteInstance(
        { id: "nokill", yes: true, userHomeDir: home },
        {
          runDockerCompose: async () => 0,
          killPortListeners: () => {
            killCalled = true;
            return { killed: [] };
          },
        },
      );
      expect(code).toBe(0);
      expect(killCalled).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("legacy local profile without retention fails safe across a missing instance root", async () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-del-legacy-durable-"));
    try {
      const profiles = join(home, ".nautilo", "profiles");
      mkdirSync(profiles, { recursive: true });
      writeFileSync(join(profiles, "kept.toml"), 'transport = "local"\nlifecycle = "compose"\ninstance_id = "kept"\n');
      let mutated = false;
      const code = await deleteInstance({ id: "kept", yes: true, userHomeDir: home }, {
        runDockerCompose: async () => { mutated = true; return 0; },
        removeInstanceRoot: () => { mutated = true; },
      });
      expect(code).toBe(1);
      expect(mutated).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("runs compose down twice then removes dir (mocked)", async () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-del-"));
    try {
      const root = join(home, ".nautilo-zeta");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "instance.json"), `${validInstanceJson("zeta")}\n`, "utf8");
      const boot = join(root, ".bootstrap");
      mkdirSync(boot, { recursive: true, mode: 0o700 });
      writeFileSync(join(boot, "admin-pin"), "123456", { mode: 0o600 });
      writeFileSync(join(boot, ".used"), "2020-01-01T00:00:00.000Z", { mode: 0o600 });

      const runs: string[][] = [];
      const code = await deleteInstance(
        { id: "zeta", yes: true, userHomeDir: home },
        {
          runDockerCompose: async (args) => {
            runs.push(args);
            return 0;
          },
          removeInstanceRoot: (r) => {
            rmSync(r, { recursive: true, force: true });
          },
        },
      );
      expect(code).toBe(0);
      expect(runs).toHaveLength(2);
      expect(runs[0]!.join(" ")).toContain("--profile auth down -v");
      expect(runs[1]!.join(" ")).toContain("down -v");
      expect(existsSync(root)).toBe(false);
      expect(existsSync(boot)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses a remote-profile projection before port, compose, or filesystem mutation", async () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-del-remote-"));
    try {
      const root = join(home, ".nautilo-alpha");
      const profiles = join(home, ".nautilo", "profiles");
      mkdirSync(root, { recursive: true });
      mkdirSync(profiles, { recursive: true });
      writeFileSync(join(root, "instance.json"), `${validInstanceJson("alpha")}\n`, "utf8");
      writeFileSync(
        join(profiles, "alpha.toml"),
        'transport = "remote"\nlifecycle = "compose"\ninstance_id = "alpha"\ndomain = "alpha.example.test"\n',
      );
      let mutated = false;
      const code = await deleteInstance(
        { id: "alpha", yes: true, userHomeDir: home },
        {
          runDockerCompose: async () => {
            mutated = true;
            return 0;
          },
          removeInstanceRoot: () => {
            mutated = true;
          },
          killPortListeners: () => {
            mutated = true;
            return { killed: [] };
          },
        },
      );
      expect(code).toBe(1);
      expect(mutated).toBe(false);
      expect(existsSync(root)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("named ID literally called default remains exactly deletable when proven local", async () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-del-named-default-"));
    try {
      const root = join(home, ".nautilo-default");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "instance.json"), `${validInstanceJson("default")}\n`, "utf8");
      let removed = "";
      const code = await deleteInstance(
        { id: "default", yes: true, userHomeDir: home },
        {
          runDockerCompose: async () => 0,
          removeInstanceRoot: (path) => {
            removed = path;
          },
        },
      );
      expect(code).toBe(0);
      expect(removed).toBe(root);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
