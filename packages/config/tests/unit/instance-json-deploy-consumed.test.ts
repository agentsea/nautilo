import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveComposeContainerBundle } from "../../src/compose-container-names";
import { INSTANCE_JSON_SCHEMA_VERSION } from "../../src/instance-defaults";
import { InstanceJsonSchema, type InstanceJson } from "../../src/resolve-instance-schema";
import {
  markDeployConfigConsumed,
  readDeployConfigConsumedAt,
} from "../../src/resolve-instance";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  tmpDirs.length = 0;
});

function freshHome(): string {
  const d = mkdtempSync(join(tmpdir(), "nautilo-m091-ij-"));
  tmpDirs.push(d);
  return d;
}

function minimalInstance(overrides: Partial<InstanceJson> = {}): InstanceJson {
  const projectName = "nautilo-m091-test";
  return InstanceJsonSchema.parse({
    schemaVersion: INSTANCE_JSON_SCHEMA_VERSION,
    instanceId: "",
    server: { host: "localhost", port: 3001, url: "http://localhost:3001" },
    workbench: { port: 3002, url: "http://localhost:3002" },
    db: {
      directConnection: "postgresql://postgres:postgres@localhost:5434/nautilo",
      postgresHostPort: 5434,
    },
    logto: { dbPort: 5435, corePort: 3003, adminPort: 3004 },
    compose: {
      projectName,
      containers: deriveComposeContainerBundle(projectName),
    },
    hostname: {
      federated: "nautilo.local",
      mdns: "nautilo.local",
      tlsSan: "nautilo.local",
      caddyAuthHost: "auth.nautilo.local",
      caddyAuthAdminHost: "auth-admin.nautilo.local",
    },
    deploymentMode: "local-self-host",
    ...overrides,
  });
}

describe("instance.json deployConfigConsumedAt (M091 Phase 3)", () => {
  test("schema accepts instance.json without deployConfigConsumedAt", () => {
    const data = minimalInstance();
    expect(data.deployConfigConsumedAt).toBeUndefined();
  });

  test("schema accepts a valid ISO datetime", () => {
    const data = minimalInstance({
      deployConfigConsumedAt: "2026-05-13T12:00:00.000Z",
    });
    expect(data.deployConfigConsumedAt).toBe("2026-05-13T12:00:00.000Z");
  });

  test("schema rejects a non-ISO deployConfigConsumedAt", () => {
    expect(() =>
      InstanceJsonSchema.parse({
        ...minimalInstance(),
        deployConfigConsumedAt: "yesterday",
      }),
    ).toThrow();
  });

  test("markDeployConfigConsumed stamps a fresh instance.json", () => {
    const home = freshHome();
    const root = join(home, ".nautilo");
    mkdirSync(root, { recursive: true });
    const path = join(root, "instance.json");
    writeFileSync(path, `${JSON.stringify(minimalInstance())}\n`, "utf8");

    const t0 = new Date("2026-01-02T03:04:05.006Z");
    markDeployConfigConsumed(root, { now: t0 });

    const raw = JSON.parse(readFileSync(path, "utf8")) as { deployConfigConsumedAt?: string };
    expect(raw.deployConfigConsumedAt).toBe(t0.toISOString());
  });

  test("markDeployConfigConsumed is idempotent (first stamp wins)", () => {
    const home = freshHome();
    const root = join(home, ".nautilo");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "instance.json"), `${JSON.stringify(minimalInstance())}\n`, "utf8");

    const first = new Date("2026-01-01T00:00:00.000Z");
    const second = new Date("2027-12-31T23:59:59.999Z");
    markDeployConfigConsumed(root, { now: first });
    markDeployConfigConsumed(root, { now: second });

    expect(readDeployConfigConsumedAt(root)).toBe(first.toISOString());
  });

  test("readDeployConfigConsumedAt returns null when absent or file missing", () => {
    const home = freshHome();
    const root = join(home, ".nautilo");
    expect(readDeployConfigConsumedAt(root)).toBe(null);

    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "instance.json"), `${JSON.stringify(minimalInstance())}\n`, "utf8");
    expect(readDeployConfigConsumedAt(root)).toBe(null);
  });

  test("readDeployConfigConsumedAt returns the stamp when present", () => {
    const home = freshHome();
    const root = join(home, ".nautilo");
    mkdirSync(root, { recursive: true });
    const iso = "2026-03-03T15:30:00.000Z";
    writeFileSync(
      join(root, "instance.json"),
      `${JSON.stringify(minimalInstance({ deployConfigConsumedAt: iso }))}\n`,
      "utf8",
    );
    expect(readDeployConfigConsumedAt(root)).toBe(iso);
  });
});
