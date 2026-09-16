import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfigOverrides } from "../../src/config";
import { DEFAULT_PORTS } from "../../src/instance-defaults";
import {
  __resetResolvedInstanceForTests,
  resolveInstance,
  resolveInstanceUncached,
} from "../../src/resolve-instance";

describe("resolveInstance", () => {
  let userHomeDir: string;

  beforeEach(() => {
    __resetResolvedInstanceForTests();
    userHomeDir = mkdtempSync(join(tmpdir(), "nautilo-inst-"));
  });

  afterEach(() => {
    __resetResolvedInstanceForTests();
    setConfigOverrides({});
    rmSync(userHomeDir, { recursive: true, force: true });
  });

  test("creates instance.json with default literal bundle", () => {
    const env = { NAUTILO_INSTANCE_ID: "", HOME: userHomeDir } as NodeJS.ProcessEnv;
    const inst = resolveInstance(env, { userHomeDir });

    expect(inst.server.port).toBe(DEFAULT_PORTS.server);
    expect(inst.server.url).toBe("http://localhost:3001");
    expect(inst.workbench.port).toBe(DEFAULT_PORTS.workbench);
    expect(inst.db.postgresHostPort).toBe(DEFAULT_PORTS.dbPostgres);
    expect(inst.db.directConnection).toBe(
      "postgresql://postgres:postgres@localhost:5434/nautilo",
    );
    expect(inst.compose.containers.legacyPostgres).toBe("nautilo-postgres");
    expect(inst.compose.containers.logtoPostgres).toBe("nautilo-postgres-1");
    expect(inst.deploymentMode).toBe("local-self-host");

    const path = join(userHomeDir, ".nautilo", "instance.json");
    expect(existsSync(path)).toBe(true);
  });

  test("NAUTILO_HOME does not change resolved root", () => {
    const env = {
      NAUTILO_INSTANCE_ID: "",
      HOME: userHomeDir,
      NAUTILO_HOME: "/this/should/be/ignored",
    } as NodeJS.ProcessEnv;
    const inst = resolveInstance(env, { userHomeDir });
    expect(inst.server.port).toBe(DEFAULT_PORTS.server);
    const path = join(userHomeDir, ".nautilo", "instance.json");
    expect(existsSync(path)).toBe(true);
  });

  test("NAUTILO_SERVER_URL overrides server.url and port when parseable", () => {
    const env = {
      NAUTILO_INSTANCE_ID: "",
      HOME: userHomeDir,
      NAUTILO_SERVER_URL: "http://127.0.0.1:3999/",
    } as NodeJS.ProcessEnv;
    const inst = resolveInstance(env, { userHomeDir });
    expect(inst.server.url).toBe("http://127.0.0.1:3999");
    expect(inst.server.port).toBe(3999);
  });

  test("env NAUTILO_PORT overrides file and defaults", () => {
    const env = {
      NAUTILO_INSTANCE_ID: "",
      HOME: userHomeDir,
      NAUTILO_PORT: "3099",
    } as NodeJS.ProcessEnv;
    const inst = resolveInstance(env, { userHomeDir });
    expect(inst.server.port).toBe(3099);
    expect(inst.server.url).toBe("http://localhost:3099");
  });

  test("user config overlay applies between disk and env", () => {
    setConfigOverrides({
      nautilo_instance_network: { serverPort: 3088 },
    });
    const env = { NAUTILO_INSTANCE_ID: "", HOME: userHomeDir } as NodeJS.ProcessEnv;
    const inst = resolveInstance(env, { userHomeDir });
    expect(inst.server.port).toBe(3088);
  });

  test("malformed instance.json throws", () => {
    const root = join(userHomeDir, ".nautilo");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "instance.json"), "{ not json", "utf8");

    expect(() =>
      resolveInstance(
        { NAUTILO_INSTANCE_ID: "", HOME: userHomeDir } as NodeJS.ProcessEnv,
        { userHomeDir },
      ),
    ).toThrow(/Malformed instance.json/);
  });

  test("named instance creates ~/.nautilo-beta/instance.json", () => {
    const env = {
      NAUTILO_INSTANCE_ID: "beta",
      HOME: userHomeDir,
    } as NodeJS.ProcessEnv;
    const inst = resolveInstance(env, { userHomeDir });

    expect(inst.instanceId).toBe("beta");
    expect(inst.compose.projectName).toBe("nautilo-beta");
    expect(inst.compose.containers.legacyPostgres).toBe("nautilo-beta-postgres");
    expect(inst.compose.containers.logtoPostgres).toBe("nautilo-beta-postgres-1");
    expect(inst.hostname.federated).toBe("beta.local");
    expect(inst.hostname.mdns).toBe("beta.local");
    expect(inst.hostname.caddyAuthHost).toBe("auth.beta.local");
    expect(inst.hostname.caddyAuthAdminHost).toBe("auth-admin.beta.local");
    expect(inst.deploymentMode).toBe("dev-multi-instance");
    const path = join(userHomeDir, ".nautilo-beta", "instance.json");
    expect(existsSync(path)).toBe(true);
  });

  test("named instance created first reserves default ports", () => {
    const env = {
      NAUTILO_INSTANCE_ID: "beta",
      HOME: userHomeDir,
    } as NodeJS.ProcessEnv;
    const inst = resolveInstance(env, { userHomeDir });

    expect(inst.server.port).not.toBe(DEFAULT_PORTS.server);
    expect(inst.workbench.port).not.toBe(DEFAULT_PORTS.workbench);
    expect(inst.db.postgresHostPort).not.toBe(DEFAULT_PORTS.dbPostgres);
    expect(inst.logto.corePort).not.toBe(DEFAULT_PORTS.logtoCore);
  });

  test("instance.json instanceId must match selected id", () => {
    const env = {
      NAUTILO_INSTANCE_ID: "beta",
      HOME: userHomeDir,
    } as NodeJS.ProcessEnv;
    const first = resolveInstance(env, { userHomeDir });
    __resetResolvedInstanceForTests();
    const path = join(userHomeDir, ".nautilo-beta", "instance.json");
    const wrong = { ...first, instanceId: "gamma" };
    writeFileSync(path, `${JSON.stringify(wrong, null, 2)}\n`, "utf8");

    expect(() => resolveInstance(env, { userHomeDir })).toThrow(
      /instanceId "gamma" does not match selected instance "beta"/,
    );
  });

  test("invalid NAUTILO_INSTANCE_ID throws before touching disk", () => {
    expect(() =>
      resolveInstance(
        { NAUTILO_INSTANCE_ID: "BAD", HOME: userHomeDir } as NodeJS.ProcessEnv,
        { userHomeDir },
      ),
    ).toThrow(/NAUTILO_INSTANCE_ID/);
  });

  test("caches until reset", () => {
    const env = { NAUTILO_INSTANCE_ID: "", HOME: userHomeDir } as NodeJS.ProcessEnv;
    const a = resolveInstance(env, { userHomeDir });
    const b = resolveInstance(env, { userHomeDir });
    expect(a).toBe(b);
    __resetResolvedInstanceForTests();
    const c = resolveInstance(env, { userHomeDir });
    expect(c).not.toBe(a);
  });

  test("uncached resolution keeps independent source and target bundles", () => {
    const source = resolveInstanceUncached(
      { NAUTILO_INSTANCE_ID: "qa-source", HOME: userHomeDir },
      { userHomeDir, skipHostBindProbe: true },
    );
    const target = resolveInstanceUncached(
      { NAUTILO_INSTANCE_ID: "tau", HOME: userHomeDir },
      { userHomeDir, skipHostBindProbe: true },
    );
    expect(source.instanceId).toBe("qa-source");
    expect(target.instanceId).toBe("tau");
    expect(source.compose.projectName).not.toBe(target.compose.projectName);
    expect(source.server.port).not.toBe(target.server.port);
  });
});
