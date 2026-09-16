import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_COMPOSE_PROJECT_NAME,
  DEFAULT_HOSTNAMES,
  DEFAULT_PORTS,
  DEFAULT_SERVER_HOST,
  DERIVED_INSTANCE_HOST_PORT_BASES,
  INSTANCE_PORT_BUNDLE_STRIDE,
  INSTANCE_JSON_SCHEMA_VERSION,
  defaultDirectDbConnection,
  defaultServerUrl,
  defaultWorkbenchUrl,
} from "../../src/instance-defaults";
import { __resetResolvedInstanceForTests, resolveInstance } from "../../src/resolve-instance";
import {
  instanceAllocationLockPath,
  withInstanceAllocationLockSync,
} from "../../src/instance-allocation-lock";
import {
  collectClaimedPortsFromSiblingInstances,
  discoverNautiloLayoutRoots,
  MAX_PORT_BUNDLE_STRIDE,
  pickFirstNonCollidingPortBundle,
} from "../../src/sibling-instance-ports";

function minimalSchemaInstanceJson(instanceId: string, strideIndex: number) {
  const o = strideIndex * INSTANCE_PORT_BUNDLE_STRIDE;
  const w = DEFAULT_PORTS.workbench + o;
  const s = DEFAULT_PORTS.server + o;
  const db = DEFAULT_PORTS.dbPostgres + o;
  const ltd = DEFAULT_PORTS.logtoDb + o;
  const ltc = DEFAULT_PORTS.logtoCore + o;
  const lta = DEFAULT_PORTS.logtoAdmin + o;
  const projectName =
    instanceId.trim() === "" ? DEFAULT_COMPOSE_PROJECT_NAME : `nautilo-${instanceId.trim()}`;
  return {
    schemaVersion: INSTANCE_JSON_SCHEMA_VERSION,
    instanceId,
    server: {
      host: DEFAULT_SERVER_HOST,
      port: s,
      url: defaultServerUrl(s),
    },
    workbench: {
      port: w,
      url: defaultWorkbenchUrl(w),
    },
    db: {
      directConnection: defaultDirectDbConnection(db),
      postgresHostPort: db,
    },
    logto: {
      dbPort: ltd,
      corePort: ltc,
      adminPort: lta,
    },
    compose: { projectName },
    hostname: { ...DEFAULT_HOSTNAMES },
  };
}

function resolveInChild(
  userHomeDir: string,
  instanceId: string,
  readyPath?: string,
  contendedPath?: string,
): Promise<ReturnType<typeof minimalSchemaInstanceJson>> {
  const script = `
    import { writeFileSync } from "node:fs";
    import { resolveInstanceUncached } from "./src/resolve-instance.ts";
    if (process.argv[3]) writeFileSync(process.argv[3], "ready");
    const resolved = resolveInstanceUncached(
      { HOME: process.argv[1], NAUTILO_INSTANCE_ID: process.argv[2] },
      {
        userHomeDir: process.argv[1], skipHostBindProbe: true, skipUserConfigOverlay: true,
        allocationLock: process.argv[4]
          ? { contended: () => writeFileSync(process.argv[4], "contended") }
          : {},
      },
    );
    process.stdout.write(JSON.stringify(resolved));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script, userHomeDir, instanceId, readyPath ?? "", contendedPath ?? ""], {
      cwd: join(import.meta.dir, "../.."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `child resolver exited ${code ?? 1}`));
        return;
      }
      resolve(JSON.parse(stdout) as ReturnType<typeof minimalSchemaInstanceJson>);
    });
  });
}

function waitForFiles(paths: readonly string[], timeoutMs: number = 5_000): void {
  const deadline = Date.now() + timeoutMs;
  while (!paths.every((path) => existsSync(path))) {
    if (Date.now() >= deadline) throw new Error(`child readiness timeout: ${paths.join(", ")}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

describe("named instance port scan (M071 Phase 2A)", () => {
  let userHomeDir: string;

  beforeEach(() => {
    __resetResolvedInstanceForTests();
    userHomeDir = mkdtempSync(join(tmpdir(), "nautilo-portscan-"));
  });

  afterEach(() => {
    __resetResolvedInstanceForTests();
    rmSync(userHomeDir, { recursive: true, force: true });
  });

  test("discoverNautiloLayoutRoots includes .nautilo and valid .nautilo-<id>", () => {
    mkdirSync(join(userHomeDir, ".nautilo"), { recursive: true });
    mkdirSync(join(userHomeDir, ".nautilo-alpha"), { recursive: true });
    mkdirSync(join(userHomeDir, ".nautilo-BAD"), { recursive: true });
    mkdirSync(join(userHomeDir, ".nautilo-"), { recursive: true });
    const roots = discoverNautiloLayoutRoots(userHomeDir);
    expect(roots).toContain(join(userHomeDir, ".nautilo"));
    expect(roots).toContain(join(userHomeDir, ".nautilo-alpha"));
    expect(roots).not.toContain(join(userHomeDir, ".nautilo-BAD"));
  });

  test("pickFirstNonCollidingPortBundle shifts when defaults are taken", () => {
    const taken = new Set<number>([
      DEFAULT_PORTS.workbench,
      DEFAULT_PORTS.server,
      DEFAULT_PORTS.dbPostgres,
      DEFAULT_PORTS.logtoDb,
      DEFAULT_PORTS.logtoCore,
      DEFAULT_PORTS.logtoAdmin,
    ]);
    const b = pickFirstNonCollidingPortBundle(taken, { skipHostBindProbe: true });
    expect(b.server).toBe(DEFAULT_PORTS.server + 100);
    expect(b.workbench).toBe(DEFAULT_PORTS.workbench + 100);
  });

  test("new named instance avoids ports claimed by an existing sibling", () => {
    const envAlpha = {
      NAUTILO_INSTANCE_ID: "alpha",
      HOME: userHomeDir,
    } as NodeJS.ProcessEnv;
    resolveInstance(envAlpha, { userHomeDir, skipHostBindProbe: true });
    __resetResolvedInstanceForTests();

    const envGamma = {
      NAUTILO_INSTANCE_ID: "gamma",
      HOME: userHomeDir,
    } as NodeJS.ProcessEnv;
    const gamma = resolveInstance(envGamma, { userHomeDir, skipHostBindProbe: true });

    expect(gamma.server.port).toBe(DEFAULT_PORTS.server + 200);
    expect(gamma.compose.projectName).toBe("nautilo-gamma");
    expect(gamma.hostname.federated).toBe("gamma.local");
    expect(existsSync(join(userHomeDir, ".nautilo-gamma", "instance.json"))).toBe(true);
  });

  test("unions one injected port inventory under the lock before publication", () => {
    let calls = 0;
    let observedLock = false;
    const gamma = resolveInstance(
      { NAUTILO_INSTANCE_ID: "gamma", HOME: userHomeDir } as NodeJS.ProcessEnv,
      {
        userHomeDir,
        skipHostBindProbe: true,
        additionalClaimedPorts: () => {
          calls++;
          observedLock = existsSync(instanceAllocationLockPath(userHomeDir));
          return new Set([DEFAULT_PORTS.dbPostgres + 100]);
        },
      },
    );
    expect(calls).toBe(1);
    expect(observedLock).toBe(true);
    expect(gamma.db.postgresHostPort).toBe(DEFAULT_PORTS.dbPostgres + 200);
    expect(existsSync(join(userHomeDir, ".nautilo-gamma", "instance.json"))).toBe(true);
  });

  test("two concurrent processes publish disjoint named-instance bundles", async () => {
    const alphaReady = join(userHomeDir, "alpha.ready");
    const betaReady = join(userHomeDir, "beta.ready");
    const alphaContended = join(userHomeDir, "alpha.contended");
    const betaContended = join(userHomeDir, "beta.contended");
    let children: readonly [
      Promise<ReturnType<typeof minimalSchemaInstanceJson>>,
      Promise<ReturnType<typeof minimalSchemaInstanceJson>>,
    ] | undefined;
    withInstanceAllocationLockSync(userHomeDir, () => {
      children = [
        resolveInChild(userHomeDir, "concurrent-alpha", alphaReady, alphaContended),
        resolveInChild(userHomeDir, "concurrent-beta", betaReady, betaContended),
      ];
      waitForFiles([alphaReady, betaReady]);
      waitForFiles([alphaContended, betaContended]);
      expect(existsSync(join(userHomeDir, ".nautilo-concurrent-alpha"))).toBe(false);
      expect(existsSync(join(userHomeDir, ".nautilo-concurrent-beta"))).toBe(false);
    }, { token: () => "parent-held-allocation" });
    if (children === undefined) throw new Error("children were not started");
    const [alpha, beta] = await Promise.all(children);
    const ports = (instance: typeof alpha): number[] => [
      instance.server.port,
      instance.workbench.port,
      instance.db.postgresHostPort,
      instance.logto.dbPort,
      instance.logto.corePort,
      instance.logto.adminPort,
    ];
    expect(new Set([...ports(alpha), ...ports(beta)]).size).toBe(12);
    expect(alpha.compose.projectName).not.toBe(beta.compose.projectName);
    expect(alpha.instanceId).not.toBe(beta.instanceId);
    expect(existsSync(instanceAllocationLockPath(userHomeDir))).toBe(false);
    expect(JSON.parse(readFileSync(
      join(userHomeDir, ".nautilo-concurrent-alpha", "instance.json"),
      "utf8",
    ))).toEqual(alpha);
    expect(JSON.parse(readFileSync(
      join(userHomeDir, ".nautilo-concurrent-beta", "instance.json"),
      "utf8",
    ))).toEqual(beta);
  });

  test("allocation lock is owner-only and fails closed on a stale owner", () => {
    const lockPath = instanceAllocationLockPath(userHomeDir);
    mkdirSync(lockPath, { mode: 0o700 });
    writeFileSync(join(lockPath, "dead-owner-token.json"), `${JSON.stringify({
      pid: 999_999_999,
      token: "dead-owner-token",
      createdAt: new Date(0).toISOString(),
    })}\n`, { mode: 0o600 });
    expect(statSync(lockPath).mode & 0o077).toBe(0);
    expect(() => withInstanceAllocationLockSync(userHomeDir, () => undefined, {
      timeoutMs: 0,
    })).toThrow("Timed out waiting");
    expect(existsSync(lockPath)).toBe(true);

    rmSync(lockPath, { recursive: true });
    mkdirSync(lockPath, { mode: 0o700 });
    writeFileSync(join(lockPath, "live-owner-token.json"), `${JSON.stringify({
      pid: process.pid,
      token: "live-owner-token",
      createdAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });
    chmodSync(lockPath, 0o755);
    expect(() => withInstanceAllocationLockSync(userHomeDir, () => undefined, {
      timeoutMs: 0,
    })).toThrow("not owner-only");
  });

  test("allocation release never removes a replacement owner's unique claim", () => {
    const lockPath = instanceAllocationLockPath(userHomeDir);
    const originalToken = "original-owner-token";
    const replacementToken = "replacement-owner-token";
    withInstanceAllocationLockSync(userHomeDir, () => {
      unlinkSync(join(lockPath, `${originalToken}.json`));
      writeFileSync(join(lockPath, `${replacementToken}.json`), `${JSON.stringify({
        pid: process.pid,
        token: replacementToken,
        createdAt: new Date().toISOString(),
      })}\n`, { mode: 0o600 });
    }, { token: () => originalToken });
    expect(existsSync(join(lockPath, `${replacementToken}.json`))).toBe(true);
  });

  test("a throwing acquired callback still releases its unique claim", () => {
    const lockPath = instanceAllocationLockPath(userHomeDir);
    expect(() => withInstanceAllocationLockSync(userHomeDir, () => undefined, {
      token: () => "throwing-callback-token",
      acquired: () => { throw new Error("callback failed"); },
    })).toThrow("callback failed");
    expect(existsSync(lockPath)).toBe(false);
  });

  test("allocation lock rejects directory and claim symlinks", () => {
    const lockPath = instanceAllocationLockPath(userHomeDir);
    const elsewhere = join(userHomeDir, "elsewhere-lock");
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, lockPath);
    expect(() => withInstanceAllocationLockSync(userHomeDir, () => undefined, { timeoutMs: 0 }))
      .toThrow("not owner-only");
    unlinkSync(lockPath);
    mkdirSync(lockPath, { mode: 0o700 });
    const externalClaim = join(userHomeDir, "external-claim.json");
    writeFileSync(externalClaim, "{}", { mode: 0o600 });
    symlinkSync(externalClaim, join(lockPath, "linked-claim-token.json"));
    expect(() => withInstanceAllocationLockSync(userHomeDir, () => undefined, { timeoutMs: 0 }))
      .toThrow("claim is invalid");
  });

  test("new named instance avoids ports claimed by default ~/.nautilo sibling", () => {
    resolveInstance(
      { NAUTILO_INSTANCE_ID: "", HOME: userHomeDir } as NodeJS.ProcessEnv,
      { userHomeDir, skipHostBindProbe: true },
    );
    __resetResolvedInstanceForTests();
    const gamma = resolveInstance(
      { NAUTILO_INSTANCE_ID: "gamma", HOME: userHomeDir } as NodeJS.ProcessEnv,
      { userHomeDir, skipHostBindProbe: true },
    );
    expect(gamma.server.port).toBe(DEFAULT_PORTS.server + 100);
    expect(gamma.hostname.federated).toBe("gamma.local");
  });

  test("named init shifts when another sibling already claimed the first free stride (2A.3)", () => {
    const blockRoot = join(userHomeDir, ".nautilo-block");
    mkdirSync(blockRoot, { recursive: true });
    writeFileSync(
      join(blockRoot, "instance.json"),
      `${JSON.stringify(minimalSchemaInstanceJson("block", 1), null, 2)}\n`,
      "utf8",
    );

    const env = {
      NAUTILO_INSTANCE_ID: "zeta",
      HOME: userHomeDir,
    } as NodeJS.ProcessEnv;
    const z = resolveInstance(env, { userHomeDir, skipHostBindProbe: true });
    expect(z.workbench.port).toBe(DEFAULT_PORTS.workbench + 200);
    expect(z.server.port).toBe(DEFAULT_PORTS.server + 200);
    expect(z.hostname.federated).toBe("zeta.local");
  });

  test("malformed sibling instance.json is ignored for collision set", () => {
    const badRoot = join(userHomeDir, ".nautilo-delta");
    mkdirSync(badRoot, { recursive: true });
    writeFileSync(join(badRoot, "instance.json"), "{ not json", "utf8");

    const taken = collectClaimedPortsFromSiblingInstances(
      userHomeDir,
      join(userHomeDir, ".nautilo-gamma"),
    );
    expect(taken.size).toBe(0);
  });

  test("synthetic ~/.nautilo-test-alpha and ~/.nautilo-test-beta fixtures join sibling scan (2A.5)", () => {
    const alphaRoot = join(userHomeDir, ".nautilo-test-alpha");
    const betaRoot = join(userHomeDir, ".nautilo-test-beta");
    mkdirSync(alphaRoot, { recursive: true });
    mkdirSync(betaRoot, { recursive: true });
    writeFileSync(
      join(alphaRoot, "instance.json"),
      `${JSON.stringify(minimalSchemaInstanceJson("test-alpha", 0), null, 2)}\n`,
      "utf8",
    );
    writeFileSync(
      join(betaRoot, "instance.json"),
      `${JSON.stringify(minimalSchemaInstanceJson("test-beta", 1), null, 2)}\n`,
      "utf8",
    );
    const roots = discoverNautiloLayoutRoots(userHomeDir);
    expect(roots).toContain(alphaRoot);
    expect(roots).toContain(betaRoot);
    __resetResolvedInstanceForTests();
    const omega = resolveInstance(
      { NAUTILO_INSTANCE_ID: "omega", HOME: userHomeDir } as NodeJS.ProcessEnv,
      { userHomeDir, skipHostBindProbe: true },
    );
    expect(omega.server.port).toBe(DEFAULT_PORTS.server + 200);
    expect(omega.hostname.federated).toBe("omega.local");
  });

  test("allocation selects stride 50 when every former candidate is blocked", () => {
    const taken = new Set<number>();
    for (let k = 0; k < 50; k++) {
      taken.add(DEFAULT_PORTS.workbench + k * INSTANCE_PORT_BUNDLE_STRIDE);
    }
    const bundle = pickFirstNonCollidingPortBundle(taken, { skipHostBindProbe: true });
    expect(bundle.workbench).toBe(DEFAULT_PORTS.workbench + 50 * INSTANCE_PORT_BUNDLE_STRIDE);
    expect(bundle.server).toBe(DEFAULT_PORTS.server + 50 * INSTANCE_PORT_BUNDLE_STRIDE);
  });

  test("real resolver publishes beyond stride 49 after scanning 50 sibling reservations", () => {
    for (let strideIndex = 0; strideIndex < 50; strideIndex++) {
      const instanceId = `fixture-${strideIndex}`;
      const root = join(userHomeDir, `.nautilo-${instanceId}`);
      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(root, "instance.json"),
        `${JSON.stringify(minimalSchemaInstanceJson(instanceId, strideIndex), null, 2)}\n`,
        "utf8",
      );
    }

    const targetPath = join(userHomeDir, ".nautilo-beyond-former-ceiling", "instance.json");
    expect(existsSync(targetPath)).toBe(false);

    const resolved = resolveInstance(
      {
        NAUTILO_INSTANCE_ID: "beyond-former-ceiling",
        HOME: userHomeDir,
      } as NodeJS.ProcessEnv,
      { userHomeDir, skipHostBindProbe: true, skipUserConfigOverlay: true },
    );

    const selectedStride =
      (resolved.workbench.port - DEFAULT_PORTS.workbench) / INSTANCE_PORT_BUNDLE_STRIDE;
    expect(Number.isInteger(selectedStride)).toBe(true);
    expect(selectedStride).toBeGreaterThan(49);
    expect(resolved.server.port).toBe(
      DEFAULT_PORTS.server + selectedStride * INSTANCE_PORT_BUNDLE_STRIDE,
    );
    expect(resolved.compose.projectName).toBe("nautilo-beyond-former-ceiling");
    expect(JSON.parse(readFileSync(targetPath, "utf8"))).toEqual(resolved);
  });

  test("allocation accepts the final topology-valid stride and excludes the next", () => {
    const taken = new Set<number>();
    for (let k = 0; k < MAX_PORT_BUNDLE_STRIDE; k++) {
      taken.add(DEFAULT_PORTS.workbench + k * INSTANCE_PORT_BUNDLE_STRIDE);
    }

    const finalBundle = pickFirstNonCollidingPortBundle(taken, { skipHostBindProbe: true });
    expect(finalBundle.server).toBe(
      DEFAULT_PORTS.server + MAX_PORT_BUNDLE_STRIDE * INSTANCE_PORT_BUNDLE_STRIDE,
    );
    expect(
      DERIVED_INSTANCE_HOST_PORT_BASES.collabora +
        MAX_PORT_BUNDLE_STRIDE * INSTANCE_PORT_BUNDLE_STRIDE,
    ).toBeLessThanOrEqual(65535);
    expect(
      DERIVED_INSTANCE_HOST_PORT_BASES.collabora +
        (MAX_PORT_BUNDLE_STRIDE + 1) * INSTANCE_PORT_BUNDLE_STRIDE,
    ).toBeGreaterThan(65535);

    taken.add(finalBundle.workbench);
    expect(() => pickFirstNonCollidingPortBundle(taken, { skipHostBindProbe: true })).toThrow(
      /complete derived candidate space/,
    );
  });

  test("complete candidate-space exhaustion leaves the target reservation unpublished", () => {
    const taken = new Set<number>();
    for (let k = 0; k <= MAX_PORT_BUNDLE_STRIDE; k++) {
      taken.add(DEFAULT_PORTS.workbench + k * INSTANCE_PORT_BUNDLE_STRIDE);
    }
    const targetPath = join(userHomeDir, ".nautilo-exhausted", "instance.json");

    let allocationError: unknown;
    try {
      resolveInstance(
        { NAUTILO_INSTANCE_ID: "exhausted", HOME: userHomeDir } as NodeJS.ProcessEnv,
        {
          userHomeDir,
          skipHostBindProbe: true,
          additionalClaimedPorts: () => taken,
        },
      );
    } catch (error) {
      allocationError = error;
    }

    expect(allocationError).toBeInstanceOf(Error);
    expect((allocationError as Error).message).toContain("complete derived candidate space");
    expect((allocationError as Error).message).not.toContain("NAUTILO_PORT");
    expect(existsSync(targetPath)).toBe(false);
  });
});
