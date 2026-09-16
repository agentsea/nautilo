/**
 * Factory helpers — build drivers + clients + expectations from CLI flags.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LimaDriver,
  TartDriver,
  VmScanClient,
  VmToolInvocationClient,
  Expectations,
  type VmDriver,
  type NautiloClient,
  type Platform,
  type ToolInvocationClient,
} from "@nautilo/smoke-runner";

/** Repo root (two dirs up from bin/nautilo-smoke/src/lib). */
export function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..", "..");
}

function defaultExpectationsPath(): string {
  return join(repoRoot(), "scripts", "security-test-env", "expected-outcomes.json");
}

export async function loadExpectations(path?: string): Promise<Expectations> {
  return Expectations.load(path ?? defaultExpectationsPath());
}

/**
 * Read the in-VM smoke token (provisioned at /etc/nautilo/smoke-token
 * by setup-linux.sh / setup-macos.sh). Returns null if the file is
 * missing or empty.
 *
 * Tool-invocation runs call this lazily after snapshot restore and
 * service start. Reading it while the VM is stopped makes valid Phase F
 * rows look unsupported, so buildPlatformEntry must not use this as a
 * construction-time capability probe.
 */
async function readSmokeToken(driver: VmDriver): Promise<string | null> {
  try {
    const r = await driver.execShell("cat /etc/nautilo/smoke-token 2>/dev/null", {
      timeoutMs: 5_000,
    });
    if (r.exitCode !== 0) return null;
    const token = r.stdout.trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * Ensure both `nautilo-test.service` (the test-mode server) AND
 * `nautilo-relay.service` (the headless relay, D060 Sprint 2 G2)
 * are running inside the VM. Called before the tool-invocation
 * matrix runs — baseline snapshots capture both services as
 * stopped so per-test restores return to cold state + the Runner
 * starts them fresh for each test (avoids in-memory state
 * accumulation across restores).
 *
 * Wrapped in the `beforeToolInvocation` closure returned by
 * `buildPlatformEntry`, which is what the Runner consumes — not
 * exported directly so callers don't have to understand the
 * per-test start/stop contract separately from the factory.
 */
export async function startInVmTestService(driver: VmDriver): Promise<void> {
  // Branch on platform: the service-start command differs per OS.
  //   - Linux (Lima): `sudo systemctl start nautilo-test.service`
  //     — idempotent; re-running when active is a no-op. Same for
  //     the relay service on G2.
  //   - macOS (Tart): restart the server LaunchDaemon; restart the
  //     Relay LaunchAgent in the existing admin GUI session so its
  //     normal login-keychain credential remains accessible.
  //
  // Both paths return non-zero on config errors (missing unit file
  // / plist, missing EnvironmentFile=, plist syntax error), so an
  // explicit exit-code check surfaces misconfiguration as the
  // real tool error rather than a 30s health-gate timeout.
  //
  // The health-gate poll afterwards is OS-agnostic: same curl with
  // bearer-token shape on both platforms (token at /etc/nautilo/
  // smoke-token, server on 127.0.0.1:3001).
  //
  // Relay start runs on BOTH platforms after the server health-gate
  // (systemd on Linux, user LaunchAgent on macOS). The probe differs
  // — see the relay block below.
  const serverStartCmd =
    driver.platform === "macos"
      ? "sudo -n launchctl unload /Library/LaunchDaemons/com.nautilo.test-server.plist 2>/dev/null || true; " +
        "sudo -n launchctl load -w /Library/LaunchDaemons/com.nautilo.test-server.plist 2>&1"
      : "sudo -n systemctl start nautilo-test.service 2>&1";
  const serverLabel =
    driver.platform === "macos"
      ? "com.nautilo.test-server"
      : "nautilo-test.service";

  const serverStart = await driver.execShell(serverStartCmd, {
    timeoutMs: 15_000,
  });
  if (serverStart.exitCode !== 0) {
    throw new Error(
      `startInVmTestService: service-start for '${serverLabel}' exited ${serverStart.exitCode} on ${driver.platform}: ${serverStart.stdout.trim() || serverStart.stderr.trim() || "(no output)"}`,
    );
  }

  // Health-gate the server: 30s max, 1s interval.
  const deadline = Date.now() + 30_000;
  let serverHealthy = false;
  while (Date.now() < deadline) {
    const r = await driver.execShell(
      "curl --silent --fail --max-time 2 -H \"Authorization: Bearer $(cat /etc/nautilo/smoke-token)\" http://127.0.0.1:3001/api/test/ping >/dev/null 2>&1",
      { timeoutMs: 5_000 },
    );
    if (r.exitCode === 0) {
      serverHealthy = true;
      break;
    }
    await new Promise((r2) => setTimeout(r2, 1_000));
  }
  if (!serverHealthy) {
    throw new Error(
      `startInVmTestService: '${serverLabel}' never became healthy within 30s on ${driver.platform}`,
    );
  }

  // D060 Sprint 2 G2 — start the headless relay AFTER the server is
  // healthy. The relay\u0027s WS client waits for the server, but
  // starting in the right order surfaces config errors faster.
  //
  // Linux:  systemctl start nautilo-relay.service + journalctl gate.
  // macOS: require the admin GUI session and restart only its Relay
  //         LaunchAgent. Dropping a daemon's UID does not give it the
  //         user's login-keychain session. Restart an existing definition
  //         directly; bootstrap only if login has not loaded it yet.
  //         A concurrent bootstrap is accepted only after exact path/program
  //         proof. launchctl print is diagnostic text, so unfamiliar formatting
  //         deliberately fails closed with the original bootstrap error.
  const relayStartCmd =
    driver.platform === "macos"
      ? 'set -eu; test "$(id -un)" = admin; relay_uid="$(id -u)"; ' +
        'relay_domain="gui/$relay_uid"; relay_service="$relay_domain/com.nautilo.relay"; ' +
        'relay_plist="$HOME/Library/LaunchAgents/com.nautilo.relay.plist"; ' +
        'test -f "$relay_plist"; launchctl print "$relay_domain" >/dev/null; ' +
        'if ! launchctl print "$relay_service" >/dev/null 2>&1; then ' +
        'if launchctl bootstrap "$relay_domain" "$relay_plist" >/dev/null; then :; ' +
        'else relay_bootstrap_status=$?; ' +
        'relay_definition="$(launchctl print "$relay_service" 2>/dev/null)" || exit "$relay_bootstrap_status"; ' +
        'printf "%s\\n" "$relay_definition" | sed "s/^[[:space:]]*//" | grep -Fxq -- "path = $relay_plist" || exit "$relay_bootstrap_status"; ' +
        'printf "%s\\n" "$relay_definition" | sed "s/^[[:space:]]*//" | grep -Fxq -- "program = /etc/nautilo/start-smoke-relay.sh" || exit "$relay_bootstrap_status"; fi; fi; ' +
        'launchctl kickstart -kp "$relay_service"'
      : "sudo -n systemctl start nautilo-relay.service 2>&1";
  const relayLabel =
    driver.platform === "macos" ? "com.nautilo.relay" : "nautilo-relay.service";

  const relayStart = await driver.execShell(relayStartCmd, {
    timeoutMs: 15_000,
  });
  if (relayStart.exitCode !== 0) {
    throw new Error(
      `startInVmTestService: relay-start for '${relayLabel}' exited ${relayStart.exitCode} on ${driver.platform}: ${relayStart.stdout.trim() || relayStart.stderr.trim() || "(no output)"}`,
    );
  }
  const relayPid = relayStart.stdout.trim();
  if (driver.platform === "macos" && (!/^[1-9][0-9]*$/.test(relayPid) || !Number.isSafeInteger(Number(relayPid)))) {
    throw new Error("startInVmTestService: macOS Relay kickstart did not return a valid process PID");
  }
  // Health-gate the relay registration. bin/nautilo-relay logs
  // "Connected as <relayId>" via @nautilo/logger on successful WS
  // handshake. We poll different sources per platform: systemd
  // journal on Linux; relay stdout/stderr logs on macOS. The macOS
  // wrapper clears its own logs and writes its PID before exec, so the
  // returned kickstart PID must match before a connection line counts.
  // Linux gets a
  // tight 15s loopback budget. macOS launchd + Tart restore can take
  // longer to flush logs, so it gets the same 60s budget as setup-macos.
  //
  // macOS probe doesn\u0027t need sudo: setup-macos.sh chowns the log
  // file admin:staff 0644 before bootstrap, and the LaunchAgent runs
  // as admin so launchd appends without changing
  // ownership. Linux probe uses sudo because journalctl -u requires
  // either root OR adm-group membership, which the default lima user
  // is NOT in.
  const relayProbeCmd =
    driver.platform === "macos"
      ? `grep -Fqx 'smoke-relay-pid=${relayPid}' /var/log/nautilo-relay.log 2>/dev/null && ` +
        "grep -q 'Connected as ' /var/log/nautilo-relay.log /var/log/nautilo-relay.err 2>/dev/null"
      : "sudo -n journalctl -u nautilo-relay --no-pager -n 50 2>/dev/null | grep -q 'Connected as '";

  const relayTimeoutMs = driver.platform === "macos" ? 60_000 : 15_000;
  const relayDeadline = Date.now() + relayTimeoutMs;
  let relayConnected = false;
  while (Date.now() < relayDeadline) {
    const r = await driver.execShell(relayProbeCmd, { timeoutMs: 5_000 });
    if (r.exitCode === 0) {
      relayConnected = true;
      break;
    }
    await new Promise((r2) => setTimeout(r2, 500));
  }
  if (!relayConnected) {
    throw new Error(
      `startInVmTestService: '${relayLabel}' never registered with server within ${relayTimeoutMs / 1000}s on ${driver.platform}`,
    );
  }
}

export function buildPlatformEntry(platform: Platform): {
  driver: VmDriver;
  client: NautiloClient;
  toolInvocationClient?: ToolInvocationClient;
  beforeToolInvocation?: () => Promise<void>;
} {
  const driver: VmDriver = platform === "linux" ? new LimaDriver() : new TartDriver();
  const client: NautiloClient = new VmScanClient(driver);

  // D063 Phase 6 / D103 Phase F — construct a tool-invocation client
  // unconditionally, but read its token lazily after the Runner has
  // restored the baseline and started the in-VM test-mode service.
  // Otherwise a stopped-but-provisioned VM appears to lack
  // tool-invocation support.
  const toolInvocationClient: ToolInvocationClient = {
    async toolInvoke(req) {
      const token = await readSmokeToken(driver);
      if (token === null) {
        throw new Error(
          "tool-invocation token missing: expected /etc/nautilo/smoke-token inside the running VM",
        );
      }
      return new VmToolInvocationClient(driver, { token }).toolInvoke(req);
    },
  };
  // Runner hooks this up before every layer="tool-invocation" test
  // dispatch. Per-test start (rather than once-at-boot) because the
  // snapshot-restore between tests rolls back to a service-stopped
  // baseline — avoids in-memory state accumulation across runs.
  const beforeToolInvocation = () => startInVmTestService(driver);
  return { driver, client, toolInvocationClient, beforeToolInvocation };
}
