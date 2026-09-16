import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const warns: string[] = [];
mock.module("@nautilo/logger", () => ({
  warn: (message: string) => {
    warns.push(message);
  },
}));

import { DEFAULT_PORTS } from "../../src/instance-defaults";
import { resolvedInstanceChildEnv } from "../../src/instance-child-env";
import { __resetResolvedInstanceForTests, resolveInstance } from "../../src/resolve-instance";
import {
  __resetRetiredNeonProxyWarningsForTests,
  warnRetiredNeonProxyConfig,
} from "../../src/retired-neon-proxy";
import { collectClaimedPortsFromSiblingInstances } from "../../src/sibling-instance-ports";

function writeDefaultInstanceJson(home: string, extraDb: Record<string, unknown> = {}): void {
  mkdirSync(join(home, ".nautilo"), { recursive: true });
  writeFileSync(
    join(home, ".nautilo", "instance.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        instanceId: "",
        server: { host: "127.0.0.1", port: 3001, url: "http://localhost:3001" },
        workbench: { port: 3000, url: "http://localhost:3000" },
        db: {
          directConnection: "postgresql://postgres:postgres@localhost:5434/nautilo",
          postgresHostPort: 5434,
          ...extraDb,
        },
        logto: { dbPort: 5432, corePort: 3301, adminPort: 3302 },
        compose: { projectName: "nautilo" },
        hostname: {
          federated: "nautilo.local",
          mdns: "nautilo.local",
          tlsSan: "",
          caddyAuthHost: "auth.nautilo.local",
          caddyAuthAdminHost: "auth-admin.nautilo.local",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

describe("warnRetiredNeonProxyConfig (M215)", () => {
  beforeEach(() => {
    warns.length = 0;
    __resetRetiredNeonProxyWarningsForTests();
    __resetResolvedInstanceForTests();
  });

  afterEach(() => {
    __resetRetiredNeonProxyWarningsForTests();
    __resetResolvedInstanceForTests();
  });

  test("logs once per source", () => {
    warnRetiredNeonProxyConfig("NAUTILO_NEON_PROXY_PORT");
    warnRetiredNeonProxyConfig("NAUTILO_NEON_PROXY_PORT");
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("NAUTILO_NEON_PROXY_PORT");
    expect(warns[0]).toContain("ISSUE-M215");
  });

  test("strips legacy db.neonProxyPort from ResolvedInstance output", () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-m215-strip-"));
    try {
      writeDefaultInstanceJson(home, { neonProxyPort: 4445 });

      const inst = resolveInstance({ HOME: home } as NodeJS.ProcessEnv, { userHomeDir: home });
      expect("neonProxyPort" in inst.db).toBe(false);
      expect(inst.db.postgresHostPort).toBe(5434);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("warns once and resolves when NAUTILO_NEON_PROXY_PORT is malformed", () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-m215-malformed-"));
    try {
      writeDefaultInstanceJson(home);

      const inst = resolveInstance(
        { HOME: home, NAUTILO_NEON_PROXY_PORT: "not-a-number" } as NodeJS.ProcessEnv,
        { userHomeDir: home },
      );
      expect(inst.db.postgresHostPort).toBe(5434);
      expect(
        warns.filter((message) => message.includes("NAUTILO_NEON_PROXY_PORT")),
      ).toHaveLength(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("does not propagate NAUTILO_NEON_PROXY_PORT to child env", () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-m215-child-"));
    try {
      writeDefaultInstanceJson(home, { neonProxyPort: 4445 });

      const inst = resolveInstance(
        { HOME: home, NAUTILO_NEON_PROXY_PORT: "9999" } as NodeJS.ProcessEnv,
        { userHomeDir: home },
      );
      const child = resolvedInstanceChildEnv(inst, {
        HOME: home,
        NAUTILO_NEON_PROXY_PORT: "9999",
      });
      expect(child["NAUTILO_NEON_PROXY_PORT"]).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("does not claim sibling neonProxyPort in port allocation", () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-m215-sibling-"));
    try {
      const siblingRoot = join(home, ".nautilo-alpha");
      mkdirSync(siblingRoot, { recursive: true });
      const strideOneServer = DEFAULT_PORTS.server + 100;
      writeFileSync(
        join(siblingRoot, "instance.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            instanceId: "alpha",
            server: {
              host: "127.0.0.1",
              port: DEFAULT_PORTS.server,
              url: `http://localhost:${DEFAULT_PORTS.server}`,
            },
            workbench: {
              port: DEFAULT_PORTS.workbench,
              url: `http://localhost:${DEFAULT_PORTS.workbench}`,
            },
            db: {
              directConnection: `postgresql://postgres:postgres@localhost:${DEFAULT_PORTS.dbPostgres}/nautilo`,
              postgresHostPort: DEFAULT_PORTS.dbPostgres,
              neonProxyPort: strideOneServer,
            },
            logto: {
              dbPort: DEFAULT_PORTS.logtoDb,
              corePort: DEFAULT_PORTS.logtoCore,
              adminPort: DEFAULT_PORTS.logtoAdmin,
            },
            compose: { projectName: "nautilo-alpha" },
            hostname: {
              federated: "alpha.local",
              mdns: "alpha.local",
              tlsSan: "",
              caddyAuthHost: "auth.alpha.local",
              caddyAuthAdminHost: "auth-admin.alpha.local",
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      const taken = collectClaimedPortsFromSiblingInstances(
        home,
        join(home, ".nautilo-beta"),
      );
      expect(taken.has(strideOneServer)).toBe(false);

      __resetResolvedInstanceForTests();
      const beta = resolveInstance(
        { NAUTILO_INSTANCE_ID: "beta", HOME: home } as NodeJS.ProcessEnv,
        { userHomeDir: home, skipHostBindProbe: true },
      );
      expect(beta.server.port).toBe(strideOneServer);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
