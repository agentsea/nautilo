import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { __resetResolvedInstanceForTests } from "@nautilo/config";
import {
  detectDevStackPortCollisions,
  devStackCmd as runDevStackCmd,
  preflightCanonicalDefaultTarget,
  resolveElectronServerUrl,
  resolveElectronPackageDir,
  resolveInstanceIdForDevStack,
} from "../../src/commands/dev-stack";
import { NAUTILO_REPO_ROOT } from "../../src/lib/compose-infra";
import { inspectSheetsReadiness, type SheetsReadiness } from "../../src/lib/sheets-readiness";

type DevStackOptions = NonNullable<Parameters<typeof runDevStackCmd>[1]>;
let isolatedWorkbenchDist: string | undefined;

function devStackCmd(args: string[], opts: DevStackOptions = {}): Promise<number> {
  return runDevStackCmd(args, {
    ...(isolatedWorkbenchDist ? { workbenchDist: isolatedWorkbenchDist } : {}),
    sheetsReadiness: async () => ({
      ready: true,
      reason: "current",
      detail: "isolated unit-test default",
    }),
    ...opts,
  });
}

function minimalInstanceJson(
  instanceId: string,
  serverPort: number,
  opts: { host?: string; url?: string } = {},
): string {
  const host = opts.host ?? "127.0.0.1";
  const url = opts.url ?? `http://127.0.0.1:${serverPort}`;
  return `${JSON.stringify({
    schemaVersion: 1,
    instanceId,
    server: { host, port: serverPort, url },
    workbench: { port: serverPort + 1, url: `http://127.0.0.1:${serverPort + 1}` },
    db: {
      directConnection: "postgresql://x",
      postgresHostPort: 5434,
    },
    logto: { dbPort: 5432, corePort: 3301, adminPort: 3302 },
    compose: { projectName: `nautilo-${instanceId}` },
    hostname: {
      federated: "n.local",
      mdns: "n.local",
      tlsSan: "n.local",
      caddyAuthHost: "a.local",
      caddyAuthAdminHost: "aa.local",
    },
  })}\n`;
}

test("resolveElectronServerUrl preserves the descriptor's canonical loopback alias", () => {
  expect(resolveElectronServerUrl({
    instanceId: "clone",
    server: { host: "127.0.0.1", port: 13101, url: "http://localhost:13101" },
  } as Parameters<typeof resolveElectronServerUrl>[0])).toBe("http://localhost:13101");
});

function emptyReadable(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

type FakeSubprocess = {
  pid: number;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
};

function fakeSubprocess(exitCode: number, pid: number): FakeSubprocess {
  return {
    pid,
    stdout: emptyReadable(),
    stderr: emptyReadable(),
    exited: Promise.resolve(exitCode),
  };
}

/** M206 — stub desktop OfficeCLI preflight so --electron tests stay offline. */
function desktopOfficeCliPreflightOk(): (repoRoot: string) => boolean {
  return () => true;
}

/** Stack 173 — stub desktop OpenHue preflight so --electron tests stay offline. */
function desktopOpenHuePreflightOk(): (repoRoot: string) => boolean {
  return () => true;
}

function isElectronLaunch(cmd: readonly string[]): boolean {
  return cmd.includes("dev:launch") && cmd.includes("run");
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

describe("resolveInstanceIdForDevStack", () => {
  test("opts.instance wins over argv, env, and worktree", () => {
    expect(
      resolveInstanceIdForDevStack(
        ["--instance", "from-argv"],
        { NAUTILO_INSTANCE_ID: "from-env" },
        "/tmp/nautilo-stack-zz",
        { instance: "from-opts" },
      ),
    ).toBe("from-opts");
  });

  test("--instance argv wins over env and worktree", () => {
    expect(
      resolveInstanceIdForDevStack(
        ["--instance", "from-argv"],
        { NAUTILO_INSTANCE_ID: "from-env" },
        "/tmp/nautilo-stack-zz",
      ),
    ).toBe("from-argv");
  });

  test("NAUTILO_INSTANCE_ID wins over worktree basename", () => {
    expect(
      resolveInstanceIdForDevStack([], { NAUTILO_INSTANCE_ID: "from-env" }, "/tmp/nautilo-stack-zz"),
    ).toBe("from-env");
  });

  test("worktree strips nautilo- prefix", () => {
    expect(resolveInstanceIdForDevStack([], {}, "/Users/me/nautilo-stack-14-workbench-resilience")).toBe(
      "stack-14-workbench-resilience",
    );
  });

  test("bare nautilo checkout maps to default instance id", () => {
    expect(resolveInstanceIdForDevStack([], {}, "/repos/nautilo")).toBe("");
  });

  test("final fallback basename when no nautilo- prefix", () => {
    expect(resolveInstanceIdForDevStack([], {}, "/repos/my-weird-folder")).toBe("my-weird-folder");
  });

  // Default-instance alias: lets a non-canonical worktree attach to the
  // canonical (default) instance (id = "") without the cd-to-nautilo dance.
  // Without this alias, the basename rule has no escape hatch.
  test("--instance default normalizes to canonical default (empty string)", () => {
    expect(
      resolveInstanceIdForDevStack(
        ["--instance", "default"],
        {},
        "/Users/me/nautilo-stack-15-friendly-errors",
      ),
    ).toBe("");
  });

  test("--instance (default) (with parens) also normalizes", () => {
    expect(
      resolveInstanceIdForDevStack(
        ["--instance", "(default)"],
        {},
        "/Users/me/nautilo-stack-15-friendly-errors",
      ),
    ).toBe("");
  });

  test("--instance DEFAULT is case-insensitive", () => {
    expect(
      resolveInstanceIdForDevStack(
        ["--instance", "DEFAULT"],
        {},
        "/Users/me/nautilo-stack-15-friendly-errors",
      ),
    ).toBe("");
  });

  test("NAUTILO_INSTANCE_ID=default normalizes to canonical default", () => {
    expect(
      resolveInstanceIdForDevStack(
        [],
        { NAUTILO_INSTANCE_ID: "default" },
        "/Users/me/nautilo-stack-15-friendly-errors",
      ),
    ).toBe("");
  });

  test("opts.instance='default' normalizes to canonical default", () => {
    expect(
      resolveInstanceIdForDevStack(
        [],
        { NAUTILO_INSTANCE_ID: "from-env" },
        "/Users/me/nautilo-stack-15-friendly-errors",
        { instance: "default" },
      ),
    ).toBe("");
  });

  test("default alias still respects the precedence order", () => {
    // argv `default` overrides env `from-env`; both override basename
    expect(
      resolveInstanceIdForDevStack(
        ["--instance", "default"],
        { NAUTILO_INSTANCE_ID: "from-env" },
        "/Users/me/nautilo-stack-15-friendly-errors",
      ),
    ).toBe("");
  });

  test("whitespace-only --instance falls through (not treated as default)", () => {
    expect(
      resolveInstanceIdForDevStack(
        ["--instance", "   "],
        {},
        "/Users/me/nautilo-stack-zz",
      ),
    ).toBe("stack-zz");
  });
});

function writeFakeElectronPackageAt(electronPackageDir: string): void {
  const relPath = join("Electron.app", "Contents", "MacOS", "Electron");
  const binDir = join(electronPackageDir, "dist", "Electron.app", "Contents", "MacOS");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(electronPackageDir, "install.js"), "// fake electron installer\n", "utf8");
  writeFileSync(join(electronPackageDir, "path.txt"), relPath, "utf8");
  writeFileSync(join(binDir, "Electron"), "fake electron binary", "utf8");
}

describe("resolveElectronPackageDir", () => {
  test("returns a path ending in node_modules/electron", () => {
    const dir = resolveElectronPackageDir();
    expect(typeof dir).toBe("string");
    expect(dir.endsWith("node_modules/electron")).toBe(true);
  });
});

describe("ensureElectronInstallReady", () => {
  let tmpHome: string;
  let savedHome: string | undefined;
  let savedInstance: string | undefined;

  beforeEach(() => {
    __resetResolvedInstanceForTests();
    tmpHome = mkdtempSync(join(tmpdir(), "nautilo-ds-electron-"));
    savedHome = process.env["HOME"];
    process.env["HOME"] = tmpHome;
    savedInstance = process.env["NAUTILO_INSTANCE_ID"];
    process.env["NAUTILO_INSTANCE_ID"] = "dsprof";
    const instDir = join(tmpHome, ".nautilo-dsprof");
    mkdirSync(instDir, { recursive: true });
    writeFileSync(join(instDir, "instance.json"), minimalInstanceJson("dsprof", 55333), "utf8");
  });

  afterEach(() => {
    __resetResolvedInstanceForTests();
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    if (savedInstance === undefined) delete process.env["NAUTILO_INSTANCE_ID"];
    else process.env["NAUTILO_INSTANCE_ID"] = savedInstance;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function electronSpawnMock(): ReturnType<typeof mock> {
    return mock((cmd: string[]) => {
      if (cmd.includes("server-start")) {
        return fakeSubprocess(0, 9001) as ReturnType<typeof Bun.spawn>;
      }
      if (isElectronLaunch(cmd)) {
        return fakeSubprocess(0, 9002) as ReturnType<typeof Bun.spawn>;
      }
      return fakeSubprocess(0, 0) as ReturnType<typeof Bun.spawn>;
    });
  }

  const fetchOk = (async () => ({
    status: 200,
    text: async () => JSON.stringify({ status: "ok" }),
  })) as unknown as typeof fetch;

  test("accepts nested apps/desktop/node_modules/electron layout when path.txt + binary exist", async () => {
    const electronPackageDir = join(tmpHome, "apps", "desktop", "node_modules", "electron");
    mkdirSync(electronPackageDir, { recursive: true });
    writeFakeElectronPackageAt(electronPackageDir);

    const spawnMock = electronSpawnMock();
    const code = await devStackCmd(["--electron"], {
      noInfra: true,
      noBuild: true,
      fetch: fetchOk,
      spawn: spawnMock as unknown as typeof Bun.spawn,
      electronPackageDir,
      desktopOfficeCliPreflight: desktopOfficeCliPreflightOk(),
      desktopOpenHuePreflight: desktopOpenHuePreflightOk(),
    });

    expect(code).toBe(0);
    const electronSpawn = (spawnMock.mock.calls as Array<[string[]]>).find((c) => isElectronLaunch(c[0]));
    expect(electronSpawn).toBeDefined();
  });

  test("returns false when install is incomplete and install.js is missing", async () => {
    const electronPackageDir = mkdtempSync(join(tmpHome, "electron-broken-"));
    mkdirSync(electronPackageDir, { recursive: true });

    const errLines: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => {
      errLines.push(args.map(String).join(" "));
      origErr(...args);
    };

    try {
      const spawnMock = electronSpawnMock();
      const code = await devStackCmd(["--electron"], {
        noInfra: true,
        noBuild: true,
        fetch: fetchOk,
        spawn: spawnMock as unknown as typeof Bun.spawn,
        electronPackageDir,
        desktopOfficeCliPreflight: desktopOfficeCliPreflightOk(),
        desktopOpenHuePreflight: desktopOpenHuePreflightOk(),
      });

      expect(code).toBe(1);
      const electronSpawn = (spawnMock.mock.calls as Array<[string[]]>).find((c) => isElectronLaunch(c[0]));
      expect(electronSpawn).toBeUndefined();
      expect(errLines.join("\n")).toContain("install is incomplete");
      expect(errLines.join("\n")).toContain("missing path.txt");
    } finally {
      console.error = origErr;
    }
  });
});

describe("detectDevStackPortCollisions", () => {
  let layout: string;

  beforeEach(() => {
    layout = mkdtempSync(join(tmpdir(), "nautilo-ds-coll-"));
  });

  afterEach(() => {
    rmSync(layout, { recursive: true, force: true });
  });

  test("self probe: same port running from different cwd → conflict", async () => {
    const instDir = join(layout, ".nautilo-self");
    mkdirSync(instDir, { recursive: true });
    writeFileSync(join(instDir, "instance.json"), minimalInstanceJson("self", 44111), "utf8");
    const fakePid = process.pid;
    const conflicts = await detectDevStackPortCollisions(
      instDir,
      44111,
      "/tmp/wt-a",
      layout,
      "self",
      {
        budgetMsPerInstance: 5000,
        testPortListenerPid: () => fakePid,
        spawnStdout: async (cmd) => {
          if (cmd[0] === "ps") return "01:05:00";
          if (cmd[0] === "lsof" && cmd.includes("-d") && cmd.includes(String(fakePid))) {
            return `bun  ${fakePid}  cwd    /tmp/wt-b\n`;
          }
          return null;
        },
      },
    );
    expect(conflicts.length).toBeGreaterThanOrEqual(1);
    expect(conflicts.some((c) => c.conflictingCwd.includes("/tmp/wt-b"))).toBe(true);
  });
});

describe("inspectSheetsReadiness", () => {
  const requiredFiles = [
    "browser.js",
    "browser.cjs",
    "node.js",
    "node.cjs",
    "src/index.d.ts",
    "src/node.d.ts",
  ];
  let fixtureRoot: string;
  let engineDir: string;
  let recipePath: string;

  function digest(value: string | Buffer): string {
    return createHash("sha256").update(value).digest("hex");
  }

  function writeCurrentFixture(): void {
    engineDir = join(fixtureRoot, "engine");
    recipePath = join(fixtureRoot, "artifacts.mjs");
    mkdirSync(engineDir, { recursive: true });
    writeFileSync(recipePath, "export const recipe = 'current';\n", "utf8");
    const files: Record<string, string> = {};
    for (const relativePath of requiredFiles) {
      const content = `generated:${relativePath}\n`;
      mkdirSync(dirname(join(engineDir, relativePath)), { recursive: true });
      writeFileSync(join(engineDir, relativePath), content, "utf8");
      files[relativePath] = digest(content);
    }
    writeFileSync(join(engineDir, "provenance.json"), JSON.stringify({
      sourceSha256: "source-current",
      recipeSha256: digest(readFileSync(recipePath)),
      files,
    }), "utf8");
  }

  function inspect(): Promise<SheetsReadiness> {
    return inspectSheetsReadiness({
      repoRoot: fixtureRoot,
      engineDir,
      recipePath,
      fingerprint: async () => "source-current",
    });
  }

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "nautilo-sheets-readiness-"));
    writeCurrentFixture();
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  test("accepts a complete engine whose source, recipe, and file hashes are current", async () => {
    expect(await inspect()).toEqual({
      ready: true,
      reason: "current",
      detail: "Sheets engine provenance is current",
    });
  });

  test("reports a missing generated engine", async () => {
    rmSync(join(engineDir, "provenance.json"));
    expect((await inspect()).reason).toBe("missing-provenance");
  });

  test("reports source fingerprint drift", async () => {
    const result = await inspectSheetsReadiness({
      repoRoot: fixtureRoot,
      engineDir,
      recipePath,
      fingerprint: async () => "source-changed",
    });
    expect(result.reason).toBe("stale-source");
  });

  test("reports artifact recipe drift", async () => {
    writeFileSync(recipePath, "export const recipe = 'changed';\n", "utf8");
    expect((await inspect()).reason).toBe("stale-recipe");
  });

  test("reports an incomplete generated engine", async () => {
    rmSync(join(engineDir, "node.cjs"));
    expect((await inspect()).reason).toBe("incomplete-artifact");
  });

  test("reports a generated engine file that does not match provenance", async () => {
    writeFileSync(join(engineDir, "browser.js"), "locally changed\n", "utf8");
    expect((await inspect()).reason).toBe("corrupt-artifact");
  });
});

describe("devStackCmd", () => {
  const originalKill = process.kill.bind(process);
  let workbenchIndexPath: string;
  const mobileWebIndexPath = join(NAUTILO_REPO_ROOT, "apps", "mobile", "dist", "index.html");
  let tmpHome: string;
  let savedHome: string | undefined;
  let savedInstance: string | undefined;
  let savedMobileWebDist: string | undefined;
  let killSpy: ReturnType<typeof mock>;
  let workbenchIndexBefore: { bytes: Buffer; mode: number } | null = null;
  let mobileWebIndexBefore: { bytes: Buffer; mode: number } | null = null;

  function restoreWorkbenchIndex(): void {
    if (workbenchIndexBefore === null) {
      rmSync(workbenchIndexPath, { force: true });
      return;
    }
    mkdirSync(join(NAUTILO_REPO_ROOT, "apps", "workbench", "dist"), { recursive: true });
    writeFileSync(workbenchIndexPath, workbenchIndexBefore.bytes);
    chmodSync(workbenchIndexPath, workbenchIndexBefore.mode);
  }

  function restoreMobileWebIndex(): void {
    if (mobileWebIndexBefore === null) {
      rmSync(mobileWebIndexPath, { force: true });
      return;
    }
    mkdirSync(join(NAUTILO_REPO_ROOT, "apps", "mobile", "dist"), { recursive: true });
    writeFileSync(mobileWebIndexPath, mobileWebIndexBefore.bytes);
    chmodSync(mobileWebIndexPath, mobileWebIndexBefore.mode);
  }

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "nautilo-ds-cmd-"));
    isolatedWorkbenchDist = join(tmpHome, "workbench-dist");
    workbenchIndexPath = join(isolatedWorkbenchDist, "index.html");
    workbenchIndexBefore = existsSync(workbenchIndexPath)
      ? {
          bytes: readFileSync(workbenchIndexPath),
          mode: statSync(workbenchIndexPath).mode & 0o777,
      }
      : null;
    mobileWebIndexBefore = existsSync(mobileWebIndexPath)
      ? {
          bytes: readFileSync(mobileWebIndexPath),
          mode: statSync(mobileWebIndexPath).mode & 0o777,
        }
      : null;
    __resetResolvedInstanceForTests();
    savedHome = process.env["HOME"];
    process.env["HOME"] = tmpHome;
    savedInstance = process.env["NAUTILO_INSTANCE_ID"];
    savedMobileWebDist = process.env["NAUTILO_MOBILE_WEB_DIST"];
    process.env["NAUTILO_INSTANCE_ID"] = "dsprof";
    const instDir = join(tmpHome, ".nautilo-dsprof");
    mkdirSync(instDir, { recursive: true });
    writeFileSync(join(instDir, "instance.json"), minimalInstanceJson("dsprof", 55333), "utf8");
    killSpy = mock((_pid: number, _sig?: NodeJS.Signals) => {
      /* no-op: never signal the real OS from this unit test */
    });
    process.kill = killSpy as unknown as typeof process.kill;
  });

  afterEach(() => {
    process.kill = originalKill;
    __resetResolvedInstanceForTests();
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    if (savedInstance === undefined) delete process.env["NAUTILO_INSTANCE_ID"];
    else process.env["NAUTILO_INSTANCE_ID"] = savedInstance;
    if (savedMobileWebDist === undefined) delete process.env["NAUTILO_MOBILE_WEB_DIST"];
    else process.env["NAUTILO_MOBILE_WEB_DIST"] = savedMobileWebDist;
    restoreWorkbenchIndex();
    restoreMobileWebIndex();
    isolatedWorkbenchDist = undefined;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function writeInstalledElectronPackage(): string {
    const electronPackageDir = mkdtempSync(join(tmpHome, "electron-installed-"));
    const relPath = join("Electron.app", "Contents", "MacOS", "Electron");
    const binDir = join(electronPackageDir, "dist", "Electron.app", "Contents", "MacOS");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(electronPackageDir, "install.js"), "// fake electron installer\n", "utf8");
    writeFileSync(join(electronPackageDir, "path.txt"), relPath, "utf8");
    writeFileSync(join(binDir, "Electron"), "fake electron binary", "utf8");
    return electronPackageDir;
  }

  function writeCloneTarget(target: string, serverPort: number): string {
    const targetRoot = join(tmpHome, `.nautilo-${target}`);
    mkdirSync(targetRoot, { recursive: true });
    writeFileSync(join(targetRoot, "instance.json"), minimalInstanceJson(target, serverPort), "utf8");
    __resetResolvedInstanceForTests();
    return targetRoot;
  }

  function writeFreshWorkbenchDist(): void {
    const dist = isolatedWorkbenchDist;
    if (!dist) throw new Error("isolated Workbench dist is unavailable");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "clone-default test dist", "utf8");
  }

  function writeMobileWebDist(): void {
    mkdirSync(join(NAUTILO_REPO_ROOT, "apps", "mobile", "dist"), { recursive: true });
    writeFileSync(mobileWebIndexPath, "mobile web test dist", "utf8");
  }

  test("restores the exact pre-test workbench index inside the isolated fixture dist", () => {
    writeFreshWorkbenchDist();
    restoreWorkbenchIndex();
    if (workbenchIndexBefore === null) {
      expect(existsSync(workbenchIndexPath)).toBe(false);
    } else {
      expect(Buffer.compare(readFileSync(workbenchIndexPath), workbenchIndexBefore.bytes)).toBe(0);
      expect(statSync(workbenchIndexPath).mode & 0o777).toBe(workbenchIndexBefore.mode);
    }
  });

  test("prepares a stale Sheets engine, revalidates it, then continues", async () => {
    rmSync(workbenchIndexPath, { force: true });
    const readiness = mock()
      .mockResolvedValueOnce({
        ready: false,
        reason: "stale-source",
        detail: "source changed",
      } satisfies SheetsReadiness)
      .mockResolvedValueOnce({
        ready: true,
        reason: "current",
        detail: "current",
      } satisfies SheetsReadiness);
    const order: string[] = [];
    const spawnMock = mock((cmd: string[]) => {
      if (cmd.includes("sheets:prepare")) {
        order.push("sheets");
        return fakeSubprocess(0, 6801) as ReturnType<typeof Bun.spawn>;
      }
      if (cmd.includes("--filter=@nautilo/workbench")) {
        order.push("workbench");
        return fakeSubprocess(44, 6802) as ReturnType<typeof Bun.spawn>;
      }
      if (cmd.includes("server-start")) order.push("server-start");
      return fakeSubprocess(0, 6803) as ReturnType<typeof Bun.spawn>;
    });

    const code = await devStackCmd([], {
      noInfra: true,
      sheetsReadiness: readiness,
      spawn: spawnMock as unknown as typeof Bun.spawn,
    });

    expect(code).toBe(44);
    expect(readiness).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["sheets", "workbench"]);
  });

  test("Sheets preparation failure exits before server-start", async () => {
    let serverStarts = 0;
    const spawnMock = mock((cmd: string[]) => {
      if (cmd.includes("sheets:prepare")) return fakeSubprocess(45, 6811) as ReturnType<typeof Bun.spawn>;
      if (cmd.includes("server-start")) serverStarts++;
      return fakeSubprocess(0, 6812) as ReturnType<typeof Bun.spawn>;
    });
    const code = await devStackCmd([], {
      noInfra: true,
      sheetsReadiness: async () => ({
        ready: false,
        reason: "missing-provenance",
        detail: "missing provenance",
      }),
      spawn: spawnMock as unknown as typeof Bun.spawn,
    });

    expect(code).toBe(45);
    expect(serverStarts).toBe(0);
  });

  test("successful Sheets preparation that remains invalid exits before server-start", async () => {
    const readiness = mock(async () => ({
      ready: false,
      reason: "incomplete-artifact" as const,
      detail: "node.cjs is missing",
    }));
    let serverStarts = 0;
    const spawnMock = mock((cmd: string[]) => {
      if (cmd.includes("sheets:prepare")) return fakeSubprocess(0, 6821) as ReturnType<typeof Bun.spawn>;
      if (cmd.includes("server-start")) serverStarts++;
      return fakeSubprocess(0, 6822) as ReturnType<typeof Bun.spawn>;
    });
    const code = await devStackCmd([], {
      noInfra: true,
      sheetsReadiness: readiness,
      spawn: spawnMock as unknown as typeof Bun.spawn,
    });

    expect(code).toBe(1);
    expect(readiness).toHaveBeenCalledTimes(2);
    expect(serverStarts).toBe(0);
  });

  test("--no-build rejects a stale Sheets engine with remediation before spawning server-start", async () => {
    const calls: string[][] = [];
    const infraStart = mock(async () => 0);
    const spawnMock = mock((cmd: string[]) => {
      calls.push(cmd);
      return fakeSubprocess(0, 6831) as ReturnType<typeof Bun.spawn>;
    });
    const errLines: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errLines.push(args.map(String).join(" "));
    try {
      const code = await devStackCmd(["--no-build"], {
        infraStart,
        sheetsReadiness: async () => ({
          ready: false,
          reason: "stale-recipe",
          detail: "recipe changed",
        }),
        spawn: spawnMock as unknown as typeof Bun.spawn,
      });
      expect(code).toBe(1);
      expect(calls).toHaveLength(0);
      expect(infraStart).not.toHaveBeenCalled();
      expect(errLines.join("\n")).toContain("bun run sheets:prepare");
    } finally {
      console.error = originalError;
    }
  });

  test("--no-build reuses a current Sheets engine without running preparation", async () => {
    rmSync(mobileWebIndexPath, { force: true });
    const calls: string[][] = [];
    const spawnMock = mock((cmd: string[]) => {
      calls.push(cmd);
      return fakeSubprocess(0, 6841) as ReturnType<typeof Bun.spawn>;
    });
    const code = await devStackCmd(["--no-build", "--mobile-web"], {
      noInfra: true,
      spawn: spawnMock as unknown as typeof Bun.spawn,
    });

    expect(code).toBe(1);
    expect(calls.some((cmd) => cmd.includes("sheets:prepare"))).toBe(false);
    expect(calls.some((cmd) => cmd.includes("server-start"))).toBe(false);
  });

  test("clone-default rejects incompatible flags before preflight or seed capture", async () => {
    const preflight = mock(async () => 0);
    const provision = mock(async () => 0);
    const code = await devStackCmd(["--clone-default", "--no-infra"], {
      cloneDefaultPreflight: preflight,
      cloneDefaultProvision: provision,
    });
    expect(code).toBe(2);
    expect(preflight).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
  });

  test("clone-default preflights before capture and provision failure starts no second infra", async () => {
    const preflight = mock(async () => 1);
    const provision = mock(async () => 0);
    const infra = mock(async () => 0);
    const code = await devStackCmd(["--clone-default", "--instance", "clone-target"], {
      cloneDefaultPreflight: preflight,
      cloneDefaultProvision: provision,
      infraStart: infra,
    });
    expect(code).toBe(1);
    expect(preflight).toHaveBeenCalledWith("clone-target");
    expect(provision).not.toHaveBeenCalled();
    expect(infra).not.toHaveBeenCalled();
  });

  test("clone-default provision owns Office once before the ordinary server/Electron tail", async () => {
    const target = "clone-target";
    const targetRoot = join(tmpHome, `.nautilo-${target}`);
    mkdirSync(targetRoot, { recursive: true });
    writeFileSync(join(targetRoot, "instance.json"), minimalInstanceJson(target, 56333), "utf8");
    __resetResolvedInstanceForTests();
    const provision = mock(async () => 0);
    const infra = mock(async () => { throw new Error("infra-start must not run after provision"); });
    const spawnMock = mock((cmd: string[]) => {
      if (cmd.includes("--filter=@nautilo/workbench") && cmd.includes("build")) {
        const dist = isolatedWorkbenchDist;
        if (!dist) throw new Error("isolated Workbench dist is unavailable");
        mkdirSync(dist, { recursive: true });
        writeFileSync(join(dist, "index.html"), "clone-default test dist", "utf8");
        return fakeSubprocess(0, 8150) as ReturnType<typeof Bun.spawn>;
      }
      if (cmd.includes("server-start")) return fakeSubprocess(0, 8151) as ReturnType<typeof Bun.spawn>;
      if (isElectronLaunch(cmd)) return fakeSubprocess(0, 8152) as ReturnType<typeof Bun.spawn>;
      return fakeSubprocess(0, 0) as ReturnType<typeof Bun.spawn>;
    });
    const fetchOk = (async () => ({ status: 200, text: async () => JSON.stringify({ status: "ok" }) })) as unknown as typeof fetch;
    const code = await devStackCmd(["--clone-default", "--instance", target, "--office", "--electron"], {
      cloneDefaultPreflight: async () => 0,
      cloneDefaultProvision: provision,
      infraStart: infra,
      fetch: fetchOk,
      spawn: spawnMock as unknown as typeof Bun.spawn,
      electronPackageDir: writeInstalledElectronPackage(),
      desktopOfficeCliPreflight: desktopOfficeCliPreflightOk(),
      desktopOpenHuePreflight: desktopOpenHuePreflightOk(),
    });
    expect(code).toBe(0);
    expect(provision).toHaveBeenCalledWith(target, { office: true, asJson: false });
    expect(infra).not.toHaveBeenCalled();
    expect((spawnMock.mock.calls as Array<[string[]]>).some((call) => call[0].includes("server-start"))).toBe(true);
    expect((spawnMock.mock.calls as Array<[string[]]>).some((call) => isElectronLaunch(call[0]))).toBe(true);
  });

  test("clone-default --json emits one final document with seed metadata and no human lines", async () => {
    const target = "clone-json";
    writeCloneTarget(target, 56383);
    const seed = {
      formatVersion: 1 as const,
      authority: "canonical-default" as const,
      freshness: "reused" as const,
      capturedAt: "2026-08-03T10:00:00.000Z",
      sourceLineage: {
        appliedMigrationCount: 27,
        lastAppliedIndex: 26,
        sha256: "a".repeat(64),
      },
      artifactBytes: 1_234_567,
      artifactCount: 4,
      seedGeneration: "generation-json-test",
    };
    const spawnMock = mock((cmd: string[]) => {
      if (cmd.includes("--filter=@nautilo/workbench") && cmd.includes("build")) {
        writeFreshWorkbenchDist();
        return fakeSubprocess(0, 8155) as ReturnType<typeof Bun.spawn>;
      }
      if (cmd.includes("server-start")) return fakeSubprocess(0, 8156) as ReturnType<typeof Bun.spawn>;
      if (isElectronLaunch(cmd)) return fakeSubprocess(0, 8157) as ReturnType<typeof Bun.spawn>;
      return fakeSubprocess(0, 0) as ReturnType<typeof Bun.spawn>;
    });
    const fetchOk = (async () => ({
      status: 200,
      text: async () => JSON.stringify({ status: "ok" }),
    })) as unknown as typeof fetch;
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));

    try {
      expect(await devStackCmd(["--clone-default", "--instance", target, "--electron", "--json"], {
        cloneDefaultPreflight: async () => 0,
        cloneDefaultProvision: async () => ({ code: 0, seed }),
        fetch: fetchOk,
        spawn: spawnMock as unknown as typeof Bun.spawn,
        runtimeAcceptance: async (log) => { log("[acceptance] local runtime acceptance passed"); return 0; },
        electronPackageDir: writeInstalledElectronPackage(),
        desktopOfficeCliPreflight: desktopOfficeCliPreflightOk(),
        desktopOpenHuePreflight: desktopOpenHuePreflightOk(),
      })).toBe(0);
    } finally {
      console.log = originalLog;
    }

    expect(lines).toHaveLength(1);
    const report = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(report["instance"]).toBe(target);
    expect(report["cloneDefault"]).toEqual(seed);
    expect(lines[0]).not.toContain("[clone-default]");
    expect(lines[0]).not.toContain("[dev-stack]");
  });

  test("clone-default server-only reaches the ordinary ready state and remains resident", async () => {
    const target = "clone-server-only";
    const targetRoot = writeCloneTarget(target, 56433);
    writeFreshWorkbenchDist();
    const provision = mock(async () => 0);
    const infra = mock(async () => { throw new Error("infra-start must not run after provision"); });
    const spawnMock = mock((cmd: string[]) => {
      if (cmd.includes("server-start")) {
        writeFileSync(join(targetRoot, "server.pid"), "8161\n", "utf8");
        return fakeSubprocess(0, 8160) as ReturnType<typeof Bun.spawn>;
      }
      if (isElectronLaunch(cmd)) throw new Error("server-only clone must not launch Electron");
      return fakeSubprocess(0, 0) as ReturnType<typeof Bun.spawn>;
    });
    const fetchOk = (async () => ({
      status: 200,
      text: async () => JSON.stringify({ status: "ok" }),
    })) as unknown as typeof fetch;
    let reportReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => { reportReady = resolve; });
    const originalLog = console.log;
    const originalExit = process.exit;
    const exitSpy = mock((_code?: number) => undefined as never);
    console.log = (...args: unknown[]) => {
      if (args.map(String).join(" ").includes("[dev-stack] ready")) reportReady?.();
    };
    process.exit = exitSpy as typeof process.exit;

    try {
      void devStackCmd(["--clone-default", "--instance", target], {
        cloneDefaultPreflight: async () => 0,
        cloneDefaultProvision: provision,
        infraStart: infra,
        fetch: fetchOk,
        spawn: spawnMock as unknown as typeof Bun.spawn,
        runtimeAcceptance: async () => 0,
      });
      await ready;
      expect(provision).toHaveBeenCalledTimes(1);
      expect(infra).not.toHaveBeenCalled();
      expect((spawnMock.mock.calls as Array<[string[]]>).some((call) => call[0].includes("server-start"))).toBe(true);
      expect((spawnMock.mock.calls as Array<[string[]]>).some((call) => isElectronLaunch(call[0]))).toBe(false);
      process.emit("SIGTERM");
      expect(exitSpy).toHaveBeenCalledWith(130);
      expect(killSpy.mock.calls.some((call) => call[0] === 8161)).toBe(true);
    } finally {
      console.log = originalLog;
      process.exit = originalExit;
    }
  });

  test("clone-default build failure propagates before server or Electron launch", async () => {
    const target = "clone-build-failure";
    writeCloneTarget(target, 56533);
    const provision = mock(async () => 0);
    const spawnMock = mock((cmd: string[]) => {
      if (cmd.includes("--filter=@nautilo/workbench") && cmd.includes("build")) {
        return fakeSubprocess(41, 8170) as ReturnType<typeof Bun.spawn>;
      }
      if (cmd.includes("server-start") || isElectronLaunch(cmd)) {
        throw new Error("build failure must stop the clone tail");
      }
      return fakeSubprocess(0, 0) as ReturnType<typeof Bun.spawn>;
    });

    expect(await devStackCmd(["--clone-default", "--instance", target, "--electron"], {
      cloneDefaultPreflight: async () => 0,
      cloneDefaultProvision: provision,
      spawn: spawnMock as unknown as typeof Bun.spawn,
    })).toBe(41);
    expect(provision).toHaveBeenCalledTimes(1);
    expect((spawnMock.mock.calls as Array<[string[]]>).some((call) => call[0].includes("server-start"))).toBe(false);
    expect((spawnMock.mock.calls as Array<[string[]]>).some((call) => isElectronLaunch(call[0]))).toBe(false);
  });

  test("clone-default server-start failure propagates without Electron", async () => {
    const target = "clone-server-failure";
    writeCloneTarget(target, 56633);
    writeFreshWorkbenchDist();
    const spawnMock = mock((cmd: string[]) => {
      if (cmd.includes("server-start")) return fakeSubprocess(42, 8180) as ReturnType<typeof Bun.spawn>;
      if (isElectronLaunch(cmd)) throw new Error("Electron must not launch after server failure");
      return fakeSubprocess(0, 0) as ReturnType<typeof Bun.spawn>;
    });

    expect(await devStackCmd(["--clone-default", "--instance", target, "--electron"], {
      cloneDefaultPreflight: async () => 0,
      cloneDefaultProvision: async () => 0,
      spawn: spawnMock as unknown as typeof Bun.spawn,
      electronPackageDir: writeInstalledElectronPackage(),
    })).toBe(42);
    expect((spawnMock.mock.calls as Array<[string[]]>).some((call) => isElectronLaunch(call[0]))).toBe(false);
  });

  test("headless --no-infra still runs server-start and propagates provisioning failure", async () => {
    const target = "browser-start-failure";
    writeCloneTarget(target, 56643);
    writeFreshWorkbenchDist();
    const infra = mock(async () => 0);
    const spawnMock = mock((cmd: string[]) => {
      if (cmd.includes("server-start")) return fakeSubprocess(1, 8181) as ReturnType<typeof Bun.spawn>;
      throw new Error("headless warm startup should only invoke server-start");
    });
    expect(await devStackCmd(["--instance", target, "--no-infra"], {
      infraStart: infra, spawn: spawnMock as unknown as typeof Bun.spawn,
    })).toBe(1);
    expect(infra).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const command = (spawnMock.mock.calls as Array<[string[]]>)[0]![0];
    expect(command.slice(2)).toEqual(["server-start", "--require-workbench-dist", "--instance", target]);
  });

  test("clone-default runtime acceptance failure tears down the target server and skips Electron", async () => {
    const target = "clone-acceptance-failure";
    const targetRoot = writeCloneTarget(target, 56733);
    writeFreshWorkbenchDist();
    const spawnMock = mock((cmd: string[]) => {
      if (cmd.includes("server-start")) {
        writeFileSync(join(targetRoot, "server.pid"), "8191\n", "utf8");
        return fakeSubprocess(0, 8190) as ReturnType<typeof Bun.spawn>;
      }
      if (isElectronLaunch(cmd)) throw new Error("Electron must not launch after acceptance failure");
      return fakeSubprocess(0, 0) as ReturnType<typeof Bun.spawn>;
    });
    const fetchOk = (async () => ({
      status: 200,
      text: async () => JSON.stringify({ status: "ok" }),
    })) as unknown as typeof fetch;

    expect(await devStackCmd(["--clone-default", "--instance", target, "--electron"], {
      cloneDefaultPreflight: async () => 0,
      cloneDefaultProvision: async () => 0,
      fetch: fetchOk,
      spawn: spawnMock as unknown as typeof Bun.spawn,
      runtimeAcceptance: async () => 43,
      electronPackageDir: writeInstalledElectronPackage(),
    })).toBe(43);
    expect((spawnMock.mock.calls as Array<[string[]]>).some((call) => isElectronLaunch(call[0]))).toBe(false);
    expect(killSpy.mock.calls.some((call) => call[0] === 8191)).toBe(true);
  });

  test("clone-default Electron child exit tears down only its server lifecycle", async () => {
    const target = "clone-electron-exit";
    const targetRoot = writeCloneTarget(target, 56833);
    writeFreshWorkbenchDist();
    const infra = mock(async () => { throw new Error("infra-start must not run after provision"); });
    const spawnMock = mock((cmd: string[]) => {
      if (cmd.includes("server-start")) {
        writeFileSync(join(targetRoot, "server.pid"), "8201\n", "utf8");
        return fakeSubprocess(0, 8200) as ReturnType<typeof Bun.spawn>;
      }
      if (isElectronLaunch(cmd)) return fakeSubprocess(29, 8202) as ReturnType<typeof Bun.spawn>;
      return fakeSubprocess(0, 0) as ReturnType<typeof Bun.spawn>;
    });
    const fetchOk = (async () => ({
      status: 200,
      text: async () => JSON.stringify({ status: "ok" }),
    })) as unknown as typeof fetch;

    expect(await devStackCmd(["--clone-default", "--instance", target, "--electron"], {
      cloneDefaultPreflight: async () => 0,
      cloneDefaultProvision: async () => 0,
      infraStart: infra,
      fetch: fetchOk,
      spawn: spawnMock as unknown as typeof Bun.spawn,
      runtimeAcceptance: async () => 0,
      electronPackageDir: writeInstalledElectronPackage(),
      desktopOfficeCliPreflight: desktopOfficeCliPreflightOk(),
      desktopOpenHuePreflight: desktopOpenHuePreflightOk(),
    })).toBe(29);
    expect(infra).not.toHaveBeenCalled();
    expect(killSpy.mock.calls.some((call) => call[0] === 8201)).toBe(true);
    expect(killSpy.mock.calls.some((call) => call[0] === 8202)).toBe(true);
  });

  test("/health timeout never SIGTERMs an adopted server pid from file", async () => {
    const instDir = join(tmpHome, ".nautilo-dsprof");
    writeFileSync(join(instDir, "server.pid"), "919191\n", "utf8");

    const spawnMock = mock((cmd: string[]) => {
      if (cmd.includes("server-start")) {
        return fakeSubprocess(0, 1001) as ReturnType<typeof Bun.spawn>;
      }
      return fakeSubprocess(0, 0) as ReturnType<typeof Bun.spawn>;
    });

    const fetchImpl = (async () => {
      throw new Error("unreachable");
    }) as unknown as typeof fetch;

    const code = await devStackCmd([], {
      noInfra: true,
      noBuild: true,
      healthTimeoutMs: 350,
      fetch: fetchImpl,
      spawn: spawnMock as unknown as typeof Bun.spawn,
    });

    expect(code).toBe(1);
    expect(spawnMock).toHaveBeenCalled();
    const sigTerms = killSpy.mock.calls.filter((c) => c[1] === "SIGTERM" || c[1] === undefined);
    expect(sigTerms.some((c) => c[0] === 919191)).toBe(false);
  });

  test("D475: authoritative acceptance failure refuses ready state and Electron", async () => {
    const instDir = join(tmpHome, ".nautilo-dsprof");
    writeFileSync(join(instDir, "server.pid"), "929292\n", "utf8");
    const spawnMock = mock((cmd: string[]) => {
      if (cmd.includes("server-start")) {
        return fakeSubprocess(0, 1101) as ReturnType<typeof Bun.spawn>;
      }
      return fakeSubprocess(0, 1102) as ReturnType<typeof Bun.spawn>;
    });
    const fetchOk = (async () => ({
      status: 200,
      text: async () => JSON.stringify({ status: "ok" }),
    })) as unknown as typeof fetch;
    const acceptance = mock(async () => 17);

    const code = await devStackCmd(["--electron"], {
      noInfra: true,
      noBuild: true,
      fetch: fetchOk,
      spawn: spawnMock as unknown as typeof Bun.spawn,
      runtimeAcceptance: acceptance,
      electronPackageDir: writeInstalledElectronPackage(),
      desktopOfficeCliPreflight: desktopOfficeCliPreflightOk(),
      desktopOpenHuePreflight: desktopOpenHuePreflightOk(),
    });

    expect(code).toBe(17);
    expect(acceptance).toHaveBeenCalledTimes(1);
    const electronSpawn = (spawnMock.mock.calls as Array<[string[]]>).find(
      (call) => isElectronLaunch(call[0]),
    );
    expect(electronSpawn).toBeUndefined();
    const sigTerms = killSpy.mock.calls.filter((c) => c[1] === "SIGTERM" || c[1] === undefined);
    expect(sigTerms.some((call) => call[0] === 929292)).toBe(false);
  });

  test("an immediate nonzero Electron exit fails before dev-stack reports ready", async () => {
    const errLines: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errLines.push(args.map(String).join(" "));
    const spawnMock = mock((cmd: string[]) => {
      if (cmd.includes("server-start")) {
        return fakeSubprocess(0, 1211) as ReturnType<typeof Bun.spawn>;
      }
      if (isElectronLaunch(cmd)) {
        return fakeSubprocess(23, 1212) as ReturnType<typeof Bun.spawn>;
      }
      return fakeSubprocess(0, 0) as ReturnType<typeof Bun.spawn>;
    });
    const fetchOk = (async () => ({
      status: 200,
      text: async () => JSON.stringify({ status: "ok" }),
    })) as unknown as typeof fetch;

    try {
      const code = await devStackCmd(["--electron"], {
        noInfra: true,
        noBuild: true,
        fetch: fetchOk,
        spawn: spawnMock as unknown as typeof Bun.spawn,
        electronPackageDir: writeInstalledElectronPackage(),
        desktopOfficeCliPreflight: desktopOfficeCliPreflightOk(),
        desktopOpenHuePreflight: desktopOpenHuePreflightOk(),
      });

      expect(code).toBe(23);
      expect(errLines.join("\n")).toContain("Electron exited before it became ready (exit 23)");
    } finally {
      console.error = originalError;
    }
  });

  test("REGRESSION D202: dev-stack propagates default opt-in to infra-start", async () => {
    const infraOpts: unknown[] = [];
    const infraStartMock = mock(async (options) => {
      infraOpts.push(options);
      return 7;
    });
    const spawnMock = mock(() => {
      throw new Error("dev-stack should stop after infra-start failure");
    });

    const code = await devStackCmd(["--i-know-what-i-am-doing"], {
      noBuild: true,
      infraStart: infraStartMock,
      spawn: spawnMock as unknown as typeof Bun.spawn,
    });

    expect(code).toBe(7);
    expect(infraStartMock).toHaveBeenCalledTimes(1);
    expect(infraOpts).toEqual([{ iKnowWhatIAmDoing: true }]);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("electron exits → orchestrator tears down only the daemon this stack launched (no infra)", async () => {
    const instDir = join(tmpHome, ".nautilo-dsprof");

    let spawnN = 0;
    const spawnMock = mock((cmd: string[]) => {
      if (cmd.includes("server-start")) {
        spawnN++;
        writeFileSync(join(instDir, "server.pid"), "828282\n", "utf8");
        return fakeSubprocess(0, 2000 + spawnN) as ReturnType<typeof Bun.spawn>;
      }
      if (isElectronLaunch(cmd)) {
        return fakeSubprocess(0, 3000) as ReturnType<typeof Bun.spawn>;
      }
      return fakeSubprocess(0, 0) as ReturnType<typeof Bun.spawn>;
    });

    const fetchOk = (async () => ({
      status: 200,
      text: async () => JSON.stringify({ status: "ok" }),
    })) as unknown as typeof fetch;

    const code = await devStackCmd(["--electron"], {
      noInfra: true,
      noBuild: true,
      fetch: fetchOk,
      spawn: spawnMock as unknown as typeof Bun.spawn,
      electronPackageDir: writeInstalledElectronPackage(),
      desktopOfficeCliPreflight: desktopOfficeCliPreflightOk(),
      desktopOpenHuePreflight: desktopOpenHuePreflightOk(),
    });

    expect(code).toBe(0);
    const sigTerms = killSpy.mock.calls.filter((c) => c[1] === "SIGTERM" || c[1] === undefined);
    expect(sigTerms.some((c) => c[0] === 828282)).toBe(true);
    expect(sigTerms.some((c) => c[0] === 3000)).toBe(true);
  });

  test("concurrent dev-stack lease holder is treated as an adopter and its daemon is never signaled", async () => {
    const instDir = join(tmpHome, ".nautilo-dsprof");
    // Simulate the first stack having acquired the instance-local launch
    // lease between this stack's preflight and server-start invocation.
    writeFileSync(
      join(instDir, "dev-stack-server-owner.json"),
      `${JSON.stringify({ token: "first-stack", instanceId: "dsprof", ownerPid: 840099, daemonPid: 840001 })}\n`,
      "utf8",
    );
    const spawnMock = mock((cmd: string[]) => {
      if (cmd.includes("server-start")) {
        writeFileSync(join(instDir, "server.pid"), "840001\n", "utf8");
        return fakeSubprocess(0, 840010) as ReturnType<typeof Bun.spawn>;
      }
      if (isElectronLaunch(cmd)) return fakeSubprocess(0, 840011) as ReturnType<typeof Bun.spawn>;
      return fakeSubprocess(0, 0) as ReturnType<typeof Bun.spawn>;
    });
    const fetchOk = (async () => ({
      status: 200,
      text: async () => JSON.stringify({ status: "ok" }),
    })) as unknown as typeof fetch;

    expect(
      await devStackCmd(["--electron"], {
        noInfra: true,
        noBuild: true,
        fetch: fetchOk,
        spawn: spawnMock as unknown as typeof Bun.spawn,
        electronPackageDir: writeInstalledElectronPackage(),
        desktopOfficeCliPreflight: desktopOfficeCliPreflightOk(),
        desktopOpenHuePreflight: desktopOpenHuePreflightOk(),
      }),
    ).toBe(0);

    const sigTerms = killSpy.mock.calls.filter((c) => c[1] === "SIGTERM" || c[1] === undefined);
    expect(sigTerms.some((c) => c[0] === 840001)).toBe(false);
    expect(existsSync(join(instDir, "dev-stack-server-owner.json"))).toBe(true);
  });

  test("reclaims a stale lease only after both its owner and daemon are dead", async () => {
    const instDir = join(tmpHome, ".nautilo-dsprof");
    const ownershipPath = join(instDir, "dev-stack-server-owner.json");
    writeFileSync(
      ownershipPath,
      `${JSON.stringify({ token: "crashed-stack", instanceId: "dsprof", ownerPid: 860001, daemonPid: 860002 })}\n`,
      "utf8",
    );
    killSpy.mockImplementation((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0 && (pid === 860001 || pid === 860002)) {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      }
    });
    const spawnMock = mock((cmd: string[]) => {
      if (cmd.includes("server-start")) {
        writeFileSync(join(instDir, "server.pid"), "860003\n", "utf8");
        return fakeSubprocess(0, 860010) as ReturnType<typeof Bun.spawn>;
      }
      if (isElectronLaunch(cmd)) return fakeSubprocess(0, 860011) as ReturnType<typeof Bun.spawn>;
      return fakeSubprocess(0, 0) as ReturnType<typeof Bun.spawn>;
    });
    const fetchOk = (async () => ({
      status: 200,
      text: async () => JSON.stringify({ status: "ok" }),
    })) as unknown as typeof fetch;

    expect(
      await devStackCmd(["--electron"], {
        noInfra: true,
        noBuild: true,
        fetch: fetchOk,
        spawn: spawnMock as unknown as typeof Bun.spawn,
        electronPackageDir: writeInstalledElectronPackage(),
        desktopOfficeCliPreflight: desktopOfficeCliPreflightOk(),
        desktopOpenHuePreflight: desktopOpenHuePreflightOk(),
      }),
    ).toBe(0);

    const sigTerms = killSpy.mock.calls.filter((c) => c[1] === "SIGTERM" || c[1] === undefined);
    expect(sigTerms.some((c) => c[0] === 860003)).toBe(true);
    expect(existsSync(ownershipPath)).toBe(false);
  });

  test("never reclaims a crashed owner's lease while its recorded daemon is still live", async () => {
    const instDir = join(tmpHome, ".nautilo-dsprof");
    const ownershipPath = join(instDir, "dev-stack-server-owner.json");
    writeFileSync(
      ownershipPath,
      `${JSON.stringify({ token: "crashed-stack", instanceId: "dsprof", ownerPid: 870001, daemonPid: 870002 })}\n`,
      "utf8",
    );
    killSpy.mockImplementation((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0 && pid === 870001) {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      }
    });
    const spawnMock = mock((cmd: string[]) => {
      if (cmd.includes("server-start")) {
        // No pre-start PID file forces the recovery predicate to inspect the
        // recorded daemon itself.  Its liveness must prevent lease transfer.
        writeFileSync(join(instDir, "server.pid"), "870002\n", "utf8");
        return fakeSubprocess(0, 870010) as ReturnType<typeof Bun.spawn>;
      }
      if (isElectronLaunch(cmd)) return fakeSubprocess(0, 870011) as ReturnType<typeof Bun.spawn>;
      return fakeSubprocess(0, 0) as ReturnType<typeof Bun.spawn>;
    });
    const fetchOk = (async () => ({
      status: 200,
      text: async () => JSON.stringify({ status: "ok" }),
    })) as unknown as typeof fetch;

    expect(
      await devStackCmd(["--electron"], {
        noInfra: true,
        noBuild: true,
        fetch: fetchOk,
        spawn: spawnMock as unknown as typeof Bun.spawn,
        electronPackageDir: writeInstalledElectronPackage(),
        desktopOfficeCliPreflight: desktopOfficeCliPreflightOk(),
        desktopOpenHuePreflight: desktopOpenHuePreflightOk(),
      }),
    ).toBe(0);

    const sigTerms = killSpy.mock.calls.filter((c) => c[1] === "SIGTERM" || c[1] === undefined);
    expect(sigTerms.some((c) => c[0] === 870002)).toBe(false);
    expect(existsSync(ownershipPath)).toBe(true);
  });

  test("replacement server.pid is never mistaken for the daemon this stack launched", async () => {
    const instDir = join(tmpHome, ".nautilo-dsprof");
    let resolveElectronExit: (code: number) => void = () => undefined;
    const electronExit = new Promise<number>((resolve) => {
      resolveElectronExit = resolve;
    });
    const spawnMock = mock((cmd: string[]) => {
      if (cmd.includes("server-start")) {
        writeFileSync(join(instDir, "server.pid"), "850001\n", "utf8");
        return fakeSubprocess(0, 850010) as ReturnType<typeof Bun.spawn>;
      }
      if (isElectronLaunch(cmd)) {
        setTimeout(() => {
          // A later server-start/restart has replaced the instance PID while
          // this Electron window was open.
          writeFileSync(join(instDir, "server.pid"), "850002\n", "utf8");
          resolveElectronExit(0);
        }, 0);
        return {
          pid: 850011,
          stdout: emptyReadable(),
          stderr: emptyReadable(),
          exited: electronExit,
        } as ReturnType<typeof Bun.spawn>;
      }
      return fakeSubprocess(0, 0) as ReturnType<typeof Bun.spawn>;
    });
    const fetchOk = (async () => ({
      status: 200,
      text: async () => JSON.stringify({ status: "ok" }),
    })) as unknown as typeof fetch;

    expect(
      await devStackCmd(["--electron"], {
        noInfra: true,
        noBuild: true,
        fetch: fetchOk,
        spawn: spawnMock as unknown as typeof Bun.spawn,
        electronPackageDir: writeInstalledElectronPackage(),
        desktopOfficeCliPreflight: desktopOfficeCliPreflightOk(),
        desktopOpenHuePreflight: desktopOpenHuePreflightOk(),
      }),
    ).toBe(0);

    const sigTerms = killSpy.mock.calls.filter((c) => c[1] === "SIGTERM" || c[1] === undefined);
    expect(sigTerms.some((c) => c[0] === 850001 || c[0] === 850002)).toBe(false);
  });

  test("REGRESSION D321: repairs partial Electron install before desktop spawn", async () => {
    const instDir = join(tmpHome, ".nautilo-dsprof");
    writeFileSync(join(instDir, "server.pid"), "838383\n", "utf8");
    const electronPackageDir = join(tmpHome, "electron-pkg");
    const electronInstallScript = join(electronPackageDir, "install.js");
    mkdirSync(electronPackageDir, { recursive: true });
    writeFileSync(electronInstallScript, "// fake electron installer\n", "utf8");
    const staleDistFile = join(electronPackageDir, "dist", "LICENSES.chromium.html");
    mkdirSync(join(electronPackageDir, "dist"), { recursive: true });
    writeFileSync(staleDistFile, "partial extraction", "utf8");

    const spawnCalls: string[][] = [];
    const spawnMock = mock((cmd: string[]) => {
      spawnCalls.push(cmd);
      if (cmd.includes("server-start")) {
        return fakeSubprocess(0, 4000) as ReturnType<typeof Bun.spawn>;
      }
      if (cmd[0] === "node" && cmd[1] === electronInstallScript) {
        // Electron's install.js can return success after a partial extract.
        return fakeSubprocess(0, 4001) as ReturnType<typeof Bun.spawn>;
      }
      if (cmd[0] === "node" && cmd[1] === "-e") {
        expect(existsSync(staleDistFile)).toBe(false);
        const relPath = join("Electron.app", "Contents", "MacOS", "Electron");
        const binDir = join(electronPackageDir, "dist", "Electron.app", "Contents", "MacOS");
        mkdirSync(binDir, { recursive: true });
        writeFileSync(join(electronPackageDir, "path.txt"), relPath, "utf8");
        writeFileSync(join(binDir, "Electron"), "fake electron binary", "utf8");
        return fakeSubprocess(0, 4002) as ReturnType<typeof Bun.spawn>;
      }
      if (isElectronLaunch(cmd)) {
        return fakeSubprocess(0, 4003) as ReturnType<typeof Bun.spawn>;
      }
      return fakeSubprocess(0, 0) as ReturnType<typeof Bun.spawn>;
    });
    const fetchOk = (async () => ({
      status: 200,
      text: async () => JSON.stringify({ status: "ok" }),
    })) as unknown as typeof fetch;

    const code = await devStackCmd(["--electron"], {
      noInfra: true,
      noBuild: true,
      fetch: fetchOk,
      spawn: spawnMock as unknown as typeof Bun.spawn,
      electronPackageDir,
      desktopOfficeCliPreflight: desktopOfficeCliPreflightOk(),
      desktopOpenHuePreflight: desktopOpenHuePreflightOk(),
    });

    expect(code).toBe(0);
    const installIndex = spawnCalls.findIndex((cmd) => cmd[0] === "node" && cmd[1] === electronInstallScript);
    const repairIndex = spawnCalls.findIndex((cmd) => cmd[0] === "node" && cmd[1] === "-e");
    const desktopIndex = spawnCalls.findIndex((cmd) => isElectronLaunch(cmd));
    expect(installIndex).toBeGreaterThan(-1);
    expect(repairIndex).toBeGreaterThan(installIndex);
    expect(desktopIndex).toBeGreaterThan(repairIndex);
  });

  test("REGRESSION D153 post-smoke: server-start spawn env MUST include NAUTILO_WORKBENCH_DIST (pre-spawn, not post-spawn)", async () => {
    // The pre-fix bug: dev-stack set NAUTILO_WORKBENCH_DIST AFTER spawning
    // server-start, so the server booted without it and `fastify-static`
    // never mounted `/`. Live smoke surfaced `GET /` returning the JSON
    // 404, which Phase 2.2's bootstrap dutifully redirected the renderer
    // to. Every unit test passed because none of them inspected the env
    // passed to the spawned server. This test pins that env passthrough.
    const instDir = join(tmpHome, ".nautilo-dsprof");
    writeFileSync(join(instDir, "server.pid"), "555555\n", "utf8");

    // Clear pre-existing NAUTILO_WORKBENCH_DIST so we can detect that
    // dev-stack itself sets it (not that we inherited a stale value).
    const savedDist = process.env["NAUTILO_WORKBENCH_DIST"];
    const savedHost = process.env["NAUTILO_HOST"];
    const savedProfile = process.env["NAUTILO_PROFILE"];
    delete process.env["NAUTILO_WORKBENCH_DIST"];
    delete process.env["NAUTILO_HOST"];
    delete process.env["NAUTILO_PROFILE"];

    type SpawnCall = [readonly string[], { env?: Record<string, string | undefined> } | undefined];
    const spawnCalls: SpawnCall[] = [];
    const spawnMock = mock((cmd: string[], opts?: { env?: Record<string, string | undefined> }) => {
      spawnCalls.push([cmd, opts] as SpawnCall);
      if (cmd.includes("server-start")) {
        return fakeSubprocess(0, 5001) as ReturnType<typeof Bun.spawn>;
      }
      if (isElectronLaunch(cmd)) {
        return fakeSubprocess(0, 5002) as ReturnType<typeof Bun.spawn>;
      }
      return fakeSubprocess(0, 0) as ReturnType<typeof Bun.spawn>;
    });
    const fetchOk = (async () => ({
      status: 200,
      text: async () => JSON.stringify({ status: "ok" }),
    })) as unknown as typeof fetch;

    try {
      // --electron so devStackCmd returns when the fake Electron child
      // exits (server-only mode blocks waiting for SIGTERM).
      const code = await devStackCmd(["--electron"], {
        noInfra: true,
        noBuild: true,
        fetch: fetchOk,
        spawn: spawnMock as unknown as typeof Bun.spawn,
        electronPackageDir: writeInstalledElectronPackage(),
        desktopOfficeCliPreflight: desktopOfficeCliPreflightOk(),
        desktopOpenHuePreflight: desktopOpenHuePreflightOk(),
      });
      expect(code).toBe(0);

      const serverStartCalls = spawnCalls.filter((c) => c[0].includes("server-start"));
      expect(serverStartCalls.length).toBeGreaterThanOrEqual(1);
      expect(serverStartCalls[0]?.[0]).toContain("--require-workbench-dist");
      // LOAD-BEARING — would fail under the pre-fix shape:
      const env = serverStartCalls[0]?.[1]?.env ?? {};
      expect(env["NAUTILO_WORKBENCH_DIST"]).toBeDefined();
      expect(env["NAUTILO_WORKBENCH_DIST"]!.length).toBeGreaterThan(0);
      expect(env["NAUTILO_WORKBENCH_DIST"]).toBe(isolatedWorkbenchDist);
      const desktopPrepare = spawnCalls.find((call) => call[0].includes("dev:prepare"));
      const desktopLaunch = spawnCalls.find((call) => isElectronLaunch(call[0]));
      for (const desktopCall of [desktopPrepare, desktopLaunch]) {
        expect(desktopCall?.[1]?.env?.["NAUTILO_HOST"]).toBe("127.0.0.1");
        expect(desktopCall?.[1]?.env?.["NAUTILO_PROFILE"]).toBe("");
      }
    } finally {
      if (savedDist === undefined) delete process.env["NAUTILO_WORKBENCH_DIST"];
      else process.env["NAUTILO_WORKBENCH_DIST"] = savedDist;
      if (savedHost === undefined) delete process.env["NAUTILO_HOST"];
      else process.env["NAUTILO_HOST"] = savedHost;
      if (savedProfile === undefined) delete process.env["NAUTILO_PROFILE"];
      else process.env["NAUTILO_PROFILE"] = savedProfile;
    }
  });

  test("default wildcard-host instance does not invent an HTTPS Electron URL", async () => {
    const instDir = join(tmpHome, ".nautilo-dsprof");
    const savedHost = process.env["NAUTILO_HOST"];
    delete process.env["NAUTILO_HOST"];
    writeFileSync(
      join(instDir, "instance.json"),
      minimalInstanceJson("dsprof", 55333, {
        host: "0.0.0.0",
        url: "http://localhost:55333",
      }),
      "utf8",
    );
    __resetResolvedInstanceForTests();
    writeFileSync(join(instDir, "server.pid"), "666666\n", "utf8");

    type SpawnCall = [readonly string[], { env?: Record<string, string | undefined> } | undefined];
    const spawnCalls: SpawnCall[] = [];
    const spawnMock = mock((cmd: string[], opts?: { env?: Record<string, string | undefined> }) => {
      spawnCalls.push([cmd, opts] as SpawnCall);
      if (cmd.includes("server-start")) {
        return fakeSubprocess(0, 6001) as ReturnType<typeof Bun.spawn>;
      }
      if (isElectronLaunch(cmd)) {
        return fakeSubprocess(0, 6002) as ReturnType<typeof Bun.spawn>;
      }
      return fakeSubprocess(0, 0) as ReturnType<typeof Bun.spawn>;
    });
    const fetchOk = (async () => ({
      status: 200,
      text: async () => JSON.stringify({ status: "ok" }),
    })) as unknown as typeof fetch;

    try {
      const code = await devStackCmd(["--electron"], {
        noInfra: true,
        noBuild: true,
        fetch: fetchOk,
        spawn: spawnMock as unknown as typeof Bun.spawn,
        electronPackageDir: writeInstalledElectronPackage(),
        desktopOfficeCliPreflight: desktopOfficeCliPreflightOk(),
        desktopOpenHuePreflight: desktopOpenHuePreflightOk(),
      });

      expect(code).toBe(0);
      const electronCall = spawnCalls.find((c) => isElectronLaunch(c[0]));
      expect(electronCall?.[1]?.env?.["NAUTILO_CONNECT_SERVER_URL"]).toStartWith("http://");
      expect(electronCall?.[1]?.env?.["NAUTILO_CONNECT_SERVER_URL"]).not.toStartWith("https://");
    } finally {
      if (savedHost === undefined) delete process.env["NAUTILO_HOST"];
      else process.env["NAUTILO_HOST"] = savedHost;
    }
  });

  test("D170: workbench build exit 0 without dist/index.html → exit 1 + diagnostics (no server-start)", async () => {
    const indexPath = join(NAUTILO_REPO_ROOT, "apps/workbench/dist/index.html");
    const backupPath = `${indexPath}.d170-unit-test-bak`;
    const hadIndex = existsSync(indexPath);
    if (hadIndex) {
      renameSync(indexPath, backupPath);
    }

    const errLines: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => {
      errLines.push(args.map(String).join(" "));
      origErr(...args);
    };

    let serverStartCalls = 0;
    const spawnMock = mock((cmd: string[]) => {
      if (cmd.includes("--filter=@nautilo/workbench") && cmd.includes("build")) {
        return fakeSubprocess(0, 7001) as ReturnType<typeof Bun.spawn>;
      }
      if (cmd.includes("server-start")) {
        serverStartCalls++;
        return fakeSubprocess(0, 7002) as ReturnType<typeof Bun.spawn>;
      }
      return fakeSubprocess(0, 0) as ReturnType<typeof Bun.spawn>;
    });

    try {
      const code = await devStackCmd([], {
        noInfra: true,
        spawn: spawnMock as unknown as typeof Bun.spawn,
      });
      expect(code).toBe(1);
      expect(serverStartCalls).toBe(0);
      const stderrBlob = errLines.join("\n");
      expect(stderrBlob).toContain("apps/workbench/dist/index.html");
      expect(stderrBlob).toContain("not found");
      expect(stderrBlob).toContain("bunx turbo run build --filter=@nautilo/workbench");
    } finally {
      console.error = origErr;
      if (hadIndex && existsSync(backupPath)) {
        renameSync(backupPath, indexPath);
      }
    }
  });

  test("--mobile-web exports before server-start and passes only the canonical dist", async () => {
    rmSync(workbenchIndexPath, { force: true });
    rmSync(mobileWebIndexPath, { force: true });
    const order: string[] = [];
    let serverEnv: Record<string, string | undefined> | undefined;
    const spawnMock = mock((cmd: string[], opts?: { env?: Record<string, string | undefined> }) => {
      if (cmd.includes("--filter=@nautilo/workbench") && cmd.includes("build")) {
        order.push("workbench");
        writeFreshWorkbenchDist();
        return fakeSubprocess(0, 7101) as ReturnType<typeof Bun.spawn>;
      }
      if (cmd.includes("mobile:web:export")) {
        order.push("mobile-web");
        writeMobileWebDist();
        return fakeSubprocess(0, 7102) as ReturnType<typeof Bun.spawn>;
      }
      if (cmd.includes("server-start")) {
        order.push("server-start");
        serverEnv = opts?.env;
        return fakeSubprocess(0, 7103) as ReturnType<typeof Bun.spawn>;
      }
      if (isElectronLaunch(cmd)) return fakeSubprocess(0, 7104) as ReturnType<typeof Bun.spawn>;
      return fakeSubprocess(0, 0) as ReturnType<typeof Bun.spawn>;
    });
    const fetchOk = (async () => ({
      status: 200,
      text: async () => JSON.stringify({ status: "ok" }),
    })) as unknown as typeof fetch;

    const code = await devStackCmd(["--mobile-web", "--electron"], {
      noInfra: true,
      fetch: fetchOk,
      spawn: spawnMock as unknown as typeof Bun.spawn,
      electronPackageDir: writeInstalledElectronPackage(),
      desktopOfficeCliPreflight: desktopOfficeCliPreflightOk(),
      desktopOpenHuePreflight: desktopOpenHuePreflightOk(),
    });

    expect(code).toBe(0);
    expect(order.indexOf("mobile-web")).toBeLessThan(order.indexOf("server-start"));
    expect(serverEnv?.["NAUTILO_MOBILE_WEB_DIST"]).toBe(
      join(NAUTILO_REPO_ROOT, "apps", "mobile", "dist"),
    );
  });

  test("--mobile-web export failure starts no server", async () => {
    rmSync(mobileWebIndexPath, { force: true });
    writeFreshWorkbenchDist();
    let serverStarts = 0;
    const spawnMock = mock((cmd: string[]) => {
      if (cmd.includes("mobile:web:export")) return fakeSubprocess(42, 7111) as ReturnType<typeof Bun.spawn>;
      if (cmd.includes("server-start")) {
        serverStarts++;
        return fakeSubprocess(0, 7112) as ReturnType<typeof Bun.spawn>;
      }
      return fakeSubprocess(0, 0) as ReturnType<typeof Bun.spawn>;
    });

    const code = await devStackCmd(["--mobile-web"], {
      noInfra: true,
      spawn: spawnMock as unknown as typeof Bun.spawn,
    });

    expect(code).toBe(42);
    expect(serverStarts).toBe(0);
  });

  test("--mobile-web --no-build requires an existing canonical index", async () => {
    rmSync(mobileWebIndexPath, { force: true });
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
    let serverStarts = 0;
    const spawnMock = mock((cmd: string[]) => {
      if (cmd.includes("server-start")) serverStarts++;
      return fakeSubprocess(0, 7121) as ReturnType<typeof Bun.spawn>;
    });

    try {
      const code = await devStackCmd(["--mobile-web", "--no-build"], {
        noInfra: true,
        spawn: spawnMock as unknown as typeof Bun.spawn,
      });
      expect(code).toBe(1);
      expect(serverStarts).toBe(0);
      expect(errors.join("\n")).toContain("bun run mobile:web:export");
    } finally {
      console.error = originalError;
    }
  });

  test("without --mobile-web preserves an advanced manual Mobile dist without exporting", async () => {
    writeFreshWorkbenchDist();
    process.env["NAUTILO_MOBILE_WEB_DIST"] = "/advanced/mobile-web";
    let serverEnv: Record<string, string | undefined> | undefined;
    const spawnMock = mock((cmd: string[], opts?: { env?: Record<string, string | undefined> }) => {
      if (cmd.includes("mobile:web:export")) throw new Error("Mobile export must stay opt-in");
      if (cmd.includes("server-start")) {
        serverEnv = opts?.env;
        return fakeSubprocess(0, 7131) as ReturnType<typeof Bun.spawn>;
      }
      if (isElectronLaunch(cmd)) return fakeSubprocess(0, 7132) as ReturnType<typeof Bun.spawn>;
      return fakeSubprocess(0, 0) as ReturnType<typeof Bun.spawn>;
    });
    const fetchOk = (async () => ({
      status: 200,
      text: async () => JSON.stringify({ status: "ok" }),
    })) as unknown as typeof fetch;

    const code = await devStackCmd(["--no-build", "--electron"], {
      noInfra: true,
      fetch: fetchOk,
      spawn: spawnMock as unknown as typeof Bun.spawn,
      electronPackageDir: writeInstalledElectronPackage(),
      desktopOfficeCliPreflight: desktopOfficeCliPreflightOk(),
      desktopOpenHuePreflight: desktopOpenHuePreflightOk(),
    });

    expect(code).toBe(0);
    expect(serverEnv?.["NAUTILO_MOBILE_WEB_DIST"]).toBe("/advanced/mobile-web");
  });

  test("an adopted server returning Mobile 503 fails truthfully without a kill", async () => {
    writeFreshWorkbenchDist();
    writeMobileWebDist();
    writeFileSync(
      join(tmpHome, ".nautilo-dsprof", "dev-stack-server-owner.json"),
      `${JSON.stringify({ token: "existing", instanceId: "dsprof", ownerPid: process.pid, daemonPid: null })}\n`,
      "utf8",
    );
    const originalError = console.error;
    const errors: string[] = [];
    let mobileSignal: AbortSignal | null = null;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const address = requestUrl(url);
      if (address.endsWith("/mobile/")) {
        mobileSignal = init?.signal instanceof AbortSignal ? init.signal : null;
        return { status: 503, text: async () => "unavailable" };
      }
      return { status: 200, text: async () => JSON.stringify({ status: "ok" }) };
    }) as unknown as typeof fetch;
    const spawnMock = mock((cmd: string[]) => {
      if (cmd.includes("server-start")) return fakeSubprocess(0, 7141) as ReturnType<typeof Bun.spawn>;
      return fakeSubprocess(0, 0) as ReturnType<typeof Bun.spawn>;
    });

    try {
      const code = await devStackCmd(["--mobile-web", "--no-build"], {
        noInfra: true,
        returnWhenReady: true,
        fetch: fetchImpl,
        spawn: spawnMock as unknown as typeof Bun.spawn,
      });
      expect(code).toBe(1);
      expect(errors.join("\n")).toContain("returned 503 for /mobile/");
      expect(errors.join("\n")).toContain("Fix or rebuild Mobile Web");
      expect(mobileSignal).toBeInstanceOf(AbortSignal);
      expect((killSpy.mock.calls as Array<[number, NodeJS.Signals | undefined]>)
        .some(([, signal]) => signal === "SIGTERM" || signal === "SIGKILL")).toBe(false);
    } finally {
      console.error = originalError;
    }
  });

  test("a newly started --mobile-web --no-build server returning 503 fails before ready", async () => {
    writeFreshWorkbenchDist();
    writeMobileWebDist();
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
    const fetchImpl = (async (url: string | URL | Request) => {
      const address = requestUrl(url);
      if (address.endsWith("/mobile/")) return { status: 503, text: async () => "unavailable" };
      return { status: 200, text: async () => JSON.stringify({ status: "ok" }) };
    }) as unknown as typeof fetch;
    const spawnMock = mock((cmd: string[]) => {
      if (cmd.includes("server-start")) return fakeSubprocess(0, 7151) as ReturnType<typeof Bun.spawn>;
      return fakeSubprocess(0, 0) as ReturnType<typeof Bun.spawn>;
    });

    try {
      const code = await devStackCmd(["--mobile-web", "--no-build"], {
        noInfra: true,
        returnWhenReady: true,
        fetch: fetchImpl,
        spawn: spawnMock as unknown as typeof Bun.spawn,
      });
      expect(code).toBe(1);
      expect(errors.join("\n")).toContain("returned 503 for /mobile/");
    } finally {
      console.error = originalError;
    }
  });

  test("server-only dev-stack does not run desktop vendor preflights", async () => {
    const officeCliPreflightMock = mock((_repoRoot: string) => true);
    const openHuePreflightMock = mock((_repoRoot: string) => true);
    const spawnMock = mock((cmd: string[]) => {
      if (cmd.includes("server-start")) {
        return fakeSubprocess(0, 7071) as ReturnType<typeof Bun.spawn>;
      }
      return fakeSubprocess(0, 0) as ReturnType<typeof Bun.spawn>;
    });
    const fetchImpl = (async () => {
      throw new Error("unreachable");
    }) as unknown as typeof fetch;

    const code = await devStackCmd([], {
      noInfra: true,
      noBuild: true,
      healthTimeoutMs: 350,
      fetch: fetchImpl,
      spawn: spawnMock as unknown as typeof Bun.spawn,
      desktopOfficeCliPreflight: officeCliPreflightMock,
      desktopOpenHuePreflight: openHuePreflightMock,
    });

    expect(code).toBe(1);
    expect(officeCliPreflightMock).not.toHaveBeenCalled();
    expect(openHuePreflightMock).not.toHaveBeenCalled();
  });

  test("--electron prepares Desktop before server-start, then runs desktop gates before Electron launch", async () => {
    const instDir = join(tmpHome, ".nautilo-dsprof");
    writeFileSync(join(instDir, "server.pid"), "717171\n", "utf8");
    const order: string[] = [];

    const officeCliPreflightMock = mock((_repoRoot: string) => {
      order.push("desktop-officecli-preflight");
      return true;
    });
    const openHuePreflightMock = mock((_repoRoot: string) => {
      order.push("desktop-openhue-preflight");
      return true;
    });
    const spawnMock = mock((cmd: string[]) => {
      if (cmd.includes("dev:prepare")) {
        order.push("desktop-prepare");
        return fakeSubprocess(0, 7170) as ReturnType<typeof Bun.spawn>;
      }
      if (cmd.includes("server-start")) {
        order.push("server-start");
        return fakeSubprocess(0, 7171) as ReturnType<typeof Bun.spawn>;
      }
      if (isElectronLaunch(cmd)) {
        order.push("electron-dev");
        return fakeSubprocess(0, 7172) as ReturnType<typeof Bun.spawn>;
      }
      return fakeSubprocess(0, 0) as ReturnType<typeof Bun.spawn>;
    });
    const fetchOk = (async () => ({
      status: 200,
      text: async () => JSON.stringify({ status: "ok" }),
    })) as unknown as typeof fetch;

    const code = await devStackCmd(["--electron"], {
      noInfra: true,
      noBuild: true,
      fetch: fetchOk,
      spawn: spawnMock as unknown as typeof Bun.spawn,
      electronPackageDir: writeInstalledElectronPackage(),
      desktopOfficeCliPreflight: officeCliPreflightMock,
      desktopOpenHuePreflight: openHuePreflightMock,
    });

    expect(code).toBe(0);
    expect(officeCliPreflightMock).toHaveBeenCalledTimes(1);
    expect(openHuePreflightMock).toHaveBeenCalledTimes(1);
    expect(order.indexOf("desktop-prepare")).toBeLessThan(order.indexOf("server-start"));
    expect(order.indexOf("server-start")).toBeLessThan(order.indexOf("desktop-officecli-preflight"));
    expect(order.indexOf("desktop-officecli-preflight")).toBeLessThan(order.indexOf("desktop-openhue-preflight"));
    expect(order.indexOf("desktop-openhue-preflight")).toBeLessThan(order.indexOf("electron-dev"));
  });

  test("Desktop preparation failure exits before server-start or Electron launch", async () => {
    const errLines: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errLines.push(args.map(String).join(" "));
    const spawnMock = mock((cmd: string[]) => {
      if (cmd.includes("dev:prepare")) return fakeSubprocess(43, 7220) as ReturnType<typeof Bun.spawn>;
      if (cmd.includes("server-start")) throw new Error("server-start must not run after Desktop preparation failure");
      if (isElectronLaunch(cmd)) {
        throw new Error("Electron must not launch after Desktop preparation failure");
      }
      return fakeSubprocess(0, 0) as ReturnType<typeof Bun.spawn>;
    });
    const fetchOk = (async () => ({
      status: 200,
      text: async () => JSON.stringify({ status: "ok" }),
    })) as unknown as typeof fetch;

    try {
      const code = await devStackCmd(["--electron"], {
        noInfra: true,
        noBuild: true,
        fetch: fetchOk,
        spawn: spawnMock as unknown as typeof Bun.spawn,
      });

      expect(code).toBe(43);
      expect(errLines.join("\n")).toContain("fix the reported dev:prepare failure");
      expect((spawnMock.mock.calls as Array<[string[]]>).some((call) => call[0].includes("server-start"))).toBe(false);
      expect((spawnMock.mock.calls as Array<[string[]]>).some((call) => isElectronLaunch(call[0]))).toBe(false);
    } finally {
      console.error = originalError;
    }
  });

  test("a later nonzero Electron exit propagates after the ready path", async () => {
    let resolveElectronExit: (exitCode: number) => void = () => undefined;
    const laterExit = new Promise<number>((resolve) => {
      resolveElectronExit = resolve;
    });
    const spawnMock = mock((cmd: string[]) => {
      if (cmd.includes("server-start")) return fakeSubprocess(0, 7231) as ReturnType<typeof Bun.spawn>;
      if (isElectronLaunch(cmd)) {
        setTimeout(() => resolveElectronExit(29), 0);
        return {
          pid: 7232,
          stdout: emptyReadable(),
          stderr: emptyReadable(),
          exited: laterExit,
        } as ReturnType<typeof Bun.spawn>;
      }
      return fakeSubprocess(0, 0) as ReturnType<typeof Bun.spawn>;
    });
    const fetchOk = (async () => ({
      status: 200,
      text: async () => JSON.stringify({ status: "ok" }),
    })) as unknown as typeof fetch;

    expect(
      await devStackCmd(["--electron"], {
        noInfra: true,
        noBuild: true,
        fetch: fetchOk,
        spawn: spawnMock as unknown as typeof Bun.spawn,
        electronPackageDir: writeInstalledElectronPackage(),
        desktopOfficeCliPreflight: desktopOfficeCliPreflightOk(),
        desktopOpenHuePreflight: desktopOpenHuePreflightOk(),
      }),
    ).toBe(29);
  });

  test("M206: desktop OfficeCLI preflight failure exits 1 without spawning Electron", async () => {
    const instDir = join(tmpHome, ".nautilo-dsprof");
    writeFileSync(join(instDir, "server.pid"), "727272\n", "utf8");

    const preflightMock = mock((_repoRoot: string) => false);
    const spawnMock = mock((cmd: string[]) => {
      if (cmd.includes("server-start")) {
        return fakeSubprocess(0, 7271) as ReturnType<typeof Bun.spawn>;
      }
      if (isElectronLaunch(cmd)) {
        throw new Error("Electron must not spawn when desktop OfficeCLI preflight fails");
      }
      return fakeSubprocess(0, 0) as ReturnType<typeof Bun.spawn>;
    });
    const fetchOk = (async () => ({
      status: 200,
      text: async () => JSON.stringify({ status: "ok" }),
    })) as unknown as typeof fetch;

    const code = await devStackCmd(["--electron"], {
      noInfra: true,
      noBuild: true,
      fetch: fetchOk,
      spawn: spawnMock as unknown as typeof Bun.spawn,
      electronPackageDir: writeInstalledElectronPackage(),
      desktopOfficeCliPreflight: preflightMock,
      desktopOpenHuePreflight: desktopOpenHuePreflightOk(),
    });

    expect(code).toBe(1);
    expect(preflightMock).toHaveBeenCalledTimes(1);
    const electronSpawn = (spawnMock.mock.calls as Array<[string[]]>).find(
      (c) => isElectronLaunch(c[0]),
    );
    expect(electronSpawn).toBeUndefined();
    const sigTerms = killSpy.mock.calls.filter((c) => c[1] === "SIGTERM" || c[1] === undefined);
    expect(sigTerms.some((c) => c[0] === 727272)).toBe(false);
  });

  test("OpenHue preflight failure exits 1 without spawning Electron", async () => {
    const instDir = join(tmpHome, ".nautilo-dsprof");
    writeFileSync(join(instDir, "server.pid"), "737373\n", "utf8");
    const openHuePreflightMock = mock((_repoRoot: string) => false);
    const spawnMock = mock((cmd: string[]) => {
      if (cmd.includes("server-start")) {
        return fakeSubprocess(0, 7371) as ReturnType<typeof Bun.spawn>;
      }
      if (isElectronLaunch(cmd)) {
        throw new Error("Electron must not spawn when desktop OpenHue preflight fails");
      }
      return fakeSubprocess(0, 0) as ReturnType<typeof Bun.spawn>;
    });
    const fetchOk = (async () => ({
      status: 200,
      text: async () => JSON.stringify({ status: "ok" }),
    })) as unknown as typeof fetch;

    const code = await devStackCmd(["--electron"], {
      noInfra: true,
      noBuild: true,
      fetch: fetchOk,
      spawn: spawnMock as unknown as typeof Bun.spawn,
      electronPackageDir: writeInstalledElectronPackage(),
      desktopOfficeCliPreflight: desktopOfficeCliPreflightOk(),
      desktopOpenHuePreflight: openHuePreflightMock,
    });

    expect(code).toBe(1);
    expect(openHuePreflightMock).toHaveBeenCalledTimes(1);
    const electronSpawn = (spawnMock.mock.calls as Array<[string[]]>).find(
      (c) => isElectronLaunch(c[0]),
    );
    expect(electronSpawn).toBeUndefined();
    const sigTerms = killSpy.mock.calls.filter((c) => c[1] === "SIGTERM" || c[1] === undefined);
    expect(sigTerms.some((c) => c[0] === 737373)).toBe(false);
  });

  test("clone-default target preflight is read-only and gives reuse/delete guidance", async () => {
    const targetId = "preflight-target";
    const targetRoot = join(tmpHome, `.nautilo-${targetId}`);
    expect(preflightCanonicalDefaultTarget({ targetId, home: tmpHome }, {
      inspectTargetState: () => ({ root: false, containers: [], networks: [], volumes: [] }),
    })).toBe(0);
    expect(existsSync(targetRoot)).toBe(false);
    let error: unknown;
    try {
      preflightCanonicalDefaultTarget({ targetId, home: tmpHome }, {
        inspectTargetState: () => ({ root: true, containers: [], networks: [], volumes: [] }),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(`dev-stack --instance ${targetId}`);
    expect((error as Error).message).toContain(`dev:delete-instance ${targetId}`);
  });
});
