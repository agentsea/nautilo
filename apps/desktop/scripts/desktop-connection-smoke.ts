#!/usr/bin/env bun
/**
 * Controlled Electron cold-boot acceptance harness.
 *
 * This is intentionally an operator-run smoke, not a unit test.  It launches
 * only an explicit source-built (`--unpackaged`) or `package:dev` artifact,
 * binds its deterministic fixture to loopback, and gives every run a private
 * user-data directory, profile, CDP port, and Family-C boot-state root.
 * It never reads, writes, or launches the installed Nautilo application.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  evaluateInTarget,
  fetchCdpTargets,
  resolveAppExecutable,
  type CDPTarget,
} from "./smoke-packaged";
import { computeUserDataDirName } from "../electron/user-data-dir-name";

type Artifact =
  | { kind: "unpackaged"; input: string; executable: string; mainJs: string }
  | { kind: "packaged"; input: string; executable: string; mainJs?: never };

type FixtureResponse = {
  status?: number;
  delayMs?: number;
  json?: unknown;
  text?: string;
};

type FixtureEndpoint = "root" | "ready" | "health" | "setup" | "profile";

const FIXTURE_PATHS: Record<FixtureEndpoint, string> = {
  root: "/",
  ready: "/health/ready",
  health: "/health",
  setup: "/api/setup/status",
  profile: "/api/profile/status",
};

class ControlledFixture {
  readonly marker = `desktop-smoke-marker-${crypto.randomUUID()}`;
  readonly identity = `desktop-smoke-identity-${crypto.randomUUID()}`;
  private readonly plans = new Map<FixtureEndpoint, FixtureResponse[]>();
  private readonly started = new Map<FixtureEndpoint, number>();
  private readonly completed = new Map<FixtureEndpoint, number>();
  private readonly server: ReturnType<typeof Bun.serve>;

  constructor() {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => this.handle(request),
    });
  }

  get origin(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  calls(endpoint: FixtureEndpoint): number {
    return this.started.get(endpoint) ?? 0;
  }

  completedCalls(endpoint: FixtureEndpoint): number {
    return this.completed.get(endpoint) ?? 0;
  }

  set(endpoint: FixtureEndpoint, responses: readonly FixtureResponse[]): void {
    this.plans.set(endpoint, [...responses]);
    this.started.set(endpoint, 0);
    this.completed.set(endpoint, 0);
  }

  stop(): void {
    this.server.stop(true);
  }

  private async handle(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    const endpoint = (Object.keys(FIXTURE_PATHS) as FixtureEndpoint[]).find(
      (key) => FIXTURE_PATHS[key] === pathname,
    );
    if (!endpoint) return new Response("not found", { status: 404 });
    const count = this.calls(endpoint);
    this.started.set(endpoint, count + 1);
    const plan = this.plans.get(endpoint) ?? [];
    const response = plan[Math.min(count, Math.max(0, plan.length - 1))] ??
      this.defaultResponse(endpoint);
    if (response.delayMs) await sleep(response.delayMs);
    this.completed.set(endpoint, this.completedCalls(endpoint) + 1);
    if (response.text !== undefined) {
      return new Response(response.text, { status: response.status ?? 200 });
    }
    return Response.json(response.json ?? {}, { status: response.status ?? 200 });
  }

  private defaultResponse(endpoint: FixtureEndpoint): FixtureResponse {
    switch (endpoint) {
      case "root":
        return {
          text: `<!doctype html><title>${this.marker}</title><main data-desktop-smoke-marker="${this.marker}">${this.marker}</main>`,
        };
      case "ready":
        return { json: { status: "ready", marker: this.marker } };
      case "health":
        return {
          json: {
            status: "ready",
            serverIdentity: this.identity,
            marker: this.marker,
          },
        };
      case "setup":
        return {
          json: {
            instanceId: "desktop-smoke-fixture",
            serverUrl: this.origin,
            deploymentMode: "local-self-host",
            setupState: "ready",
            claimRequired: false,
            recommendedSetupSurface: { kind: "cli", url: null },
          },
        };
      case "profile":
        return { json: { hasCompletedOnboarding: true } };
    }
  }
}

type Run = {
  fixture: ControlledFixture;
  userDataParent: string;
  requestedUserDataDir: string;
  actualUserDataDir: string;
  operatorRoot: string;
  profile: string;
  cdpPort: number;
  child: ChildProcess;
  stdout: string;
  stderr: string;
  stop: () => Promise<void>;
};

export const COLD_BOOT_DELAYED_HEALTH_HOLD_MS = 5_500;

export function coldBootInitialPageTargetTimeoutMs(
  artifactKind: Artifact["kind"],
): number {
  return artifactKind === "packaged" ? 30_000 : 12_000;
}

export async function reacquireDesktopSmokePage<
  Target extends Pick<CDPTarget, "type" | "url" | "webSocketDebuggerUrl">,
>(input: Readonly<{
  expectedUrl: string;
  expectedText: string;
  timeoutMs: number;
  listTargets(): Promise<readonly Target[]>;
  evaluate(target: Target): Promise<string>;
  pause(): Promise<void>;
  now(): number;
}>): Promise<Readonly<{ target: Target; text: string }> | null> {
  const deadline = input.now() + input.timeoutMs;
  while (input.now() < deadline) {
    try {
      const target = (await input.listTargets()).find(
        (candidate) => candidate.type === "page" && candidate.url === input.expectedUrl,
      );
      if (target) {
        const text = await input.evaluate(target);
        if (text.includes(input.expectedText)) return { target, text };
      }
    } catch {
      // Navigation can close the prior websocket between listing and evaluate.
    }
    await input.pause();
  }
  return null;
}

export function coldBootDiagnosticDurationIsClose(
  line: string,
  expectedMs: number,
  toleranceMs: number,
): boolean {
  const raw = /durationMs=(\d+)/.exec(line)?.[1];
  return raw !== undefined && Math.abs(Number(raw) - expectedMs) <= toleranceMs;
}

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveP, rejectP) => {
    server.once("error", rejectP);
    server.listen(0, "127.0.0.1", () => resolveP());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no loopback port");
  await new Promise<void>((resolveP) => server.close(() => resolveP()));
  return address.port;
}

function parseArtifact(argv: string[]): Artifact {
  const unpackaged = argv.indexOf("--unpackaged");
  const packaged = argv.indexOf("--packaged");
  if ((unpackaged >= 0) === (packaged >= 0)) {
    throw new Error("choose exactly one: --unpackaged <dist/main.js> or --packaged <Nautilo.app>");
  }
  const index = unpackaged >= 0 ? unpackaged : packaged;
  const input = argv[index + 1];
  if (!input || input.startsWith("--")) throw new Error("artifact path is required");
  if (unpackaged >= 0) {
    const mainJs = resolve(input);
    return {
      kind: "unpackaged",
      input: mainJs,
      executable: resolveAppExecutable(mainJs, true),
      mainJs,
    };
  }
  return {
    kind: "packaged",
    input: resolve(input),
    executable: resolveAppExecutable(input),
  };
}

async function startRun(
  artifact: Artifact,
  fixture: ControlledFixture,
  beforeLaunch?: (operatorRoot: string) => void,
): Promise<Run> {
  const userDataParent = mkdtempSync(join(tmpdir(), "nautilo-desktop-smoke-user-data-"));
  const requestedUserDataDir = join(userDataParent, "chromium-user-data");
  const operatorRoot = mkdtempSync(join(tmpdir(), "nautilo-desktop-smoke-"));
  chmodSync(operatorRoot, 0o700);
  beforeLaunch?.(operatorRoot);
  const cdpPort = await unusedLoopbackPort();
  const profile = `desktop-smoke-${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const instanceId = "test-cruft";
  // `main.ts` rebases Electron's `--user-data-dir` parent to the canonical
  // instance/profile tuple. Use the shared helper rather than copying it.
  const actualUserDataDir = join(
    userDataParent,
    computeUserDataDirName({
      appName: "Nautilo",
      instanceId,
      isDefaultInstance: false,
      profile,
    }),
  );
  const args = [
    ...(artifact.mainJs ? [artifact.mainJs] : []),
    `--user-data-dir=${requestedUserDataDir}`,
    `--remote-debugging-port=${cdpPort}`,
  ];
  const env = { ...process.env };
  delete env["NAUTILO_FORCE_FIRST_RUN"];
  const child = spawn(artifact.executable, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...env,
      NAUTILO_CONNECT_SERVER_URL: fixture.origin,
      NAUTILO_INSTANCE_ID: instanceId,
      NAUTILO_PROFILE: profile,
      NAUTILO_SMOKE_HIDDEN: "1",
      NAUTILO_DESKTOP_SMOKE_OPERATOR_ROOT: operatorRoot,
    },
  });
  const run: Run = {
    fixture,
    userDataParent,
    requestedUserDataDir,
    actualUserDataDir,
    operatorRoot,
    profile,
    cdpPort,
    child,
    stdout: "",
    stderr: "",
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await Promise.race([
          new Promise<void>((resolveP) => child.once("exit", () => resolveP())),
          sleep(5_000),
        ]);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await new Promise<void>((resolveP) => child.once("exit", () => resolveP()));
        }
      }
      rmSync(userDataParent, { recursive: true, force: true });
      rmSync(operatorRoot, { recursive: true, force: true });
      assert(!existsSync(userDataParent), "private userData parent was not removed");
      assert(!existsSync(operatorRoot), "private operator root was not removed");
    },
  };
  child.stdout?.on("data", (data: Buffer) => { run.stdout += data.toString("utf8"); });
  child.stderr?.on("data", (data: Buffer) => { run.stderr += data.toString("utf8"); });
  return run;
}

async function findTarget(run: Run, predicate: (target: CDPTarget) => boolean, timeoutMs = 12_000): Promise<CDPTarget> {
  const deadline = Date.now() + timeoutMs;
  let last: CDPTarget[] = [];
  while (Date.now() < deadline) {
    try {
      last = (await fetchCdpTargets(run.cdpPort, 500)).filter((target) => target.type === "page");
      const found = last.find(predicate);
      if (found) return found;
    } catch {
      // Electron or its renderer may still be starting.
    }
    await sleep(100);
  }
  throw new Error(
    `CDP target timeout; childExit=${String(run.child.exitCode)} ` +
    `childSignal=${String(run.child.signalCode)}; pageTargets=${last.length}; ` +
    `sanitized evidence:\n${boundedDesktopSmokeFailureEvidence(run)}`,
  );
}

async function waitForPage(
  run: Run,
  expectedUrl: string,
  expected: string,
  timeoutMs = 1_500,
): Promise<Readonly<{ target: CDPTarget; text: string }>> {
  const found = await reacquireDesktopSmokePage({
    expectedUrl,
    expectedText: expected,
    timeoutMs,
    listTargets: async () => (await fetchCdpTargets(run.cdpPort, 500)),
    evaluate: async (target) => String(await evaluateInTarget(
      target.webSocketDebuggerUrl,
      "document.body?.innerText ?? ''",
    )),
    pause: () => sleep(50),
    now: Date.now,
  });
  if (found) return found;
  throw new Error(
    `CDP page timeout; childExit=${String(run.child.exitCode)} ` +
    `childSignal=${String(run.child.signalCode)}; sanitized evidence:\n${boundedDesktopSmokeFailureEvidence(run)}`,
  );
}

async function invokeColdBoot(target: CDPTarget, method: "retry" | "useThisServerAnyway"): Promise<void> {
  await evaluateInTarget(
    target.webSocketDebuggerUrl,
    `window.nautiloDesktop.coldBoot.${method}()`,
    true,
  );
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function seededRecentServer(fixture: ControlledFixture, fingerprint: string): string {
  return JSON.stringify({
    v: 2,
    servers: [{ url: fixture.origin, lastUsedAt: new Date().toISOString(), fingerprint }],
  });
}

export function coldBootDiagnosticIsSanitized(
  line: string,
  sensitiveValues: readonly string[],
): boolean {
  return sensitiveValues.every((value) => !value || !line.includes(value));
}

function coldBootDiagnostics(run: Run): string[] {
  const logCandidates = [join(run.actualUserDataDir, "logs", "main.log")].filter(existsSync);
  assert(
    logCandidates.length === 1,
    `derived tuple userData log was not created; sanitized evidence:\n${boundedDesktopSmokeFailureEvidence(run)}`,
  );
  const output = [run.stdout, run.stderr, ...logCandidates.map((file) => readFileSync(file, "utf8"))].join("\n");
  const diagnostics = output.split("\n").filter((line) => line.includes("[cold-boot]"));
  assert(diagnostics.length > 0, "no Cold-boot diagnostics were observed");
  return diagnostics;
}

/**
 * Child stdio and arbitrary page text can contain server responses, URLs, or
 * credentials. Timeout reporting therefore exposes only byte counts plus the
 * deliberately content-free Cold-boot diagnostic lines emitted by main.ts.
 */
function boundedDesktopSmokeFailureEvidence(run: Run): string {
  const logPath = join(run.actualUserDataDir, "logs", "main.log");
  const fileOutput = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  const diagnostics = fileOutput
    .split("\n")
    .filter((line) => line.includes("[cold-boot]"))
    .join("\n")
    .slice(-4_000);
  return [
    `stdoutBytes=${Buffer.byteLength(run.stdout)} stderrBytes=${Buffer.byteLength(run.stderr)} tupleLogBytes=${Buffer.byteLength(fileOutput)}`,
    diagnostics ? `coldBootDiagnostics:\n${diagnostics}` : "coldBootDiagnostics=<none>",
  ].join("\n");
}

function assertSanitizedColdBootDiagnostics(run: Run): void {
  const diagnostics = coldBootDiagnostics(run);
  for (const line of diagnostics) {
    assert(
      coldBootDiagnosticIsSanitized(line, [
        run.fixture.origin,
        run.fixture.identity,
        run.fixture.marker,
        "expected-smoke-fingerprint",
      ]),
      "Cold-boot diagnostic leaked fixture content",
    );
  }
}

function assertColdBootCategory(run: Run, category: string): string {
  const line = coldBootDiagnostics(run).find((entry) => entry.includes(`category=${category}`));
  assert(line, `missing Cold-boot category=${category}`);
  return line;
}

function assertNoColdBootCategory(run: Run, category: string): void {
  assert(
    !coldBootDiagnostics(run).some((entry) => entry.includes(`category=${category}`)),
    `unexpected Cold-boot category=${category}`,
  );
}

function provenance(run: Run, artifact: Artifact): string {
  return `pid=${run.child.pid ?? "unknown"} executable=${artifact.executable} mainJs=${artifact.mainJs ?? "none"} fixture=${run.fixture.origin} cdpPort=${run.cdpPort} profile=${run.profile} requestedUserData=${run.requestedUserDataDir} actualUserData=${run.actualUserDataDir} operatorRoot=${run.operatorRoot}`;
}

async function delayedHealthyCase(artifact: Artifact): Promise<string> {
  const fixture = new ControlledFixture();
  const delayMs = COLD_BOOT_DELAYED_HEALTH_HOLD_MS;
  fixture.set("health", [{ delayMs, json: { status: "ready", serverIdentity: fixture.identity, marker: fixture.marker } }]);
  const run = await startRun(artifact, fixture);
  try {
    const bootstrap = await findTarget(
      run,
      (target) => target.url.endsWith("/bootstrap.html"),
      coldBootInitialPageTargetTimeoutMs(artifact.kind),
    );
    await waitForPage(run, bootstrap.url, "Starting Nautilo");
    assert(run.fixture.completedCalls("health") === 0, "healthy delay completed before local bootstrap painted");
    const workbench = await waitForPage(run, `${fixture.origin}/`, fixture.marker, 15_000);
    assertSanitizedColdBootDiagnostics(run);
    const verified = assertColdBootCategory(run, "verified");
    assert(
      coldBootDiagnosticDurationIsClose(verified, delayMs, 1_000),
      `Cold-boot verified duration was not within 1000ms of ${delayMs}ms`,
    );
    return `delayed healthy: bootstrap before /health completion; final=${workbench.target.url}; ${provenance(run, artifact)}`;
  } finally {
    await run.stop();
    fixture.stop();
  }
}

async function unavailableRetryCase(artifact: Artifact): Promise<string> {
  const fixture = new ControlledFixture();
  fixture.set("health", [
    { status: 503, json: { status: "unavailable" } },
    { json: { status: "ready", serverIdentity: fixture.identity, marker: fixture.marker } },
  ]);
  const run = await startRun(artifact, fixture);
  try {
    const recovery = await findTarget(
      run,
      (target) => target.url.includes("cold-boot-picker.html"),
      coldBootInitialPageTargetTimeoutMs(artifact.kind),
    );
    const currentRecovery = await waitForPage(run, recovery.url, "Can't reach server right now");
    assert(run.child.exitCode === null, "desktop exited during unavailable recovery");
    await invokeColdBoot(currentRecovery.target, "retry");
    const workbench = await waitForPage(run, `${fixture.origin}/`, fixture.marker, 15_000);
    assert(run.fixture.calls("health") >= 2, "Retry did not perform a second main-owned observation");
    assertSanitizedColdBootDiagnostics(run);
    assertColdBootCategory(run, "status");
    assertColdBootCategory(run, "retry-requested");
    assertColdBootCategory(run, "verified");
    return `unavailable retry: process alive; healthCalls=${fixture.calls("health")}; final=${workbench.target.url}; ${provenance(run, artifact)}`;
  } finally {
    await run.stop();
    fixture.stop();
  }
}

async function wrongServerCase(artifact: Artifact): Promise<string> {
  const fixture = new ControlledFixture();
  const run = await startRun(artifact, fixture, (operatorRoot) => {
    writeFileSync(
      join(operatorRoot, "recent-servers.json"),
      seededRecentServer(fixture, "expected-smoke-fingerprint"),
      "utf8",
    );
  });
  try {
    const recovery = await findTarget(
      run,
      (target) => target.url.includes("cold-boot-picker.html"),
      coldBootInitialPageTargetTimeoutMs(artifact.kind),
    );
    const currentRecovery = await waitForPage(
      run,
      recovery.url,
      "This address now answers as a different Nautilo",
    );
    assert(run.fixture.calls("root") === 0, "wrong identity navigated to the fixture root");
    assert(!currentRecovery.target.url.startsWith(fixture.origin), "wrong identity released remote navigation");
    assertSanitizedColdBootDiagnostics(run);
    assertColdBootCategory(run, "mismatch");
    assertNoColdBootCategory(run, "navigation-released");
    return `wrong server: local recovery retained; rootCalls=${fixture.calls("root")}; ${provenance(run, artifact)}`;
  } finally {
    await run.stop();
    fixture.stop();
  }
}

async function main(): Promise<void> {
  const artifact = parseArtifact(process.argv.slice(2));
  // Keep this explicit rather than silently doing a live run when imported by
  // a unit test or a packaging command.
  const reports = [
    await delayedHealthyCase(artifact),
    await unavailableRetryCase(artifact),
    await wrongServerCase(artifact),
  ];
  process.stdout.write(`[desktop-smoke] artifact=${artifact.kind} input=${artifact.input}\n`);
  for (const report of reports) process.stdout.write(`[desktop-smoke] PASS ${report}\n`);
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`[desktop-smoke] FAIL ${(error as Error).stack ?? error}\n`);
    process.exit(1);
  });
}
