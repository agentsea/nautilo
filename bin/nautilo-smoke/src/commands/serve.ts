/**
 * `serve` command — boot the HTTP API over the configured Runner.
 *
 * Usage:
 *   nautilo-smoke serve [--host=127.0.0.1] [--port=7788] [--rotate-token]
 *
 * On startup:
 *   - Reads or creates ~/.nautilo/smoke-token (or uses NAUTILO_SMOKE_TOKEN
 *     env override). `--rotate-token` forces a new token.
 *   - Prints host + port + a MASKED token so the operator knows what's
 *     running without leaking credentials to screenshots / tmux scrollback.
 *     The full token is read from the file by consumers (curl, MCP, CI).
 *   - Runs until SIGINT / SIGTERM.
 */

import {
  createSmokeServer,
  getOrCreateToken,
  rotateToken,
  maskToken,
  registerShutdownHandlers,
  type NamedDriver,
  type RunnerConfig,
} from "@nautilo/smoke-runner";
import { getString, type ParsedArgs } from "../lib/args.ts";
import { buildPlatformEntry, loadExpectations } from "../lib/factory.ts";
import type { Platform } from "@nautilo/smoke-runner";

export async function serveCommand(args: ParsedArgs): Promise<number> {
  const host = getString(args, "host", "127.0.0.1");
  const portStr = getString(args, "port", "7788");
  const port = Number.parseInt(portStr, 10);
  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    console.error(`nautilo-smoke serve: invalid --port=${portStr}`);
    return 64;
  }
  const rotate = args.flags["rotate-token"] === true || args.flags["rotate-token"] === "";
  const keepVms = args.flags["keep-vms"] === true || args.flags["keep-vms"] === "";

  // Token: rotate → fresh new value written to disk; else reuse/create
  // the existing one. Tests that want an ephemeral token set the
  // `NAUTILO_SMOKE_TOKEN` env var — `getOrCreateToken()` honors that
  // without touching disk.
  const token = rotate ? rotateToken() : getOrCreateToken();

  const expectations = await loadExpectations();

  // Configure the server with whatever platforms are reachable.
  // Unlike `run`, serve doesn't require both — a dev with only Lima
  // installed can still expose the Linux surface via HTTP.
  const configuredPlatforms: Platform[] = [];
  const namedDrivers: NamedDriver[] = [];
  const platformsMut: { -readonly [K in keyof RunnerConfig["platforms"]]: RunnerConfig["platforms"][K] } = {};
  for (const p of ["linux", "macos"] as const) {
    try {
      const entry = buildPlatformEntry(p);
      platformsMut[p] = entry;
      configuredPlatforms.push(p);
      namedDrivers.push({ name: `${p} VM`, driver: entry.driver });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[nautilo-smoke serve] ${p} not available: ${msg.split("\n")[0]}`);
    }
  }
  const platforms: RunnerConfig["platforms"] = platformsMut;

  if (configuredPlatforms.length === 0) {
    console.error("nautilo-smoke serve: no VM platform could be configured — aborting.");
    return 1;
  }

  const runnerConfig: RunnerConfig = {
    expectations,
    platforms,
  };

  console.log(`[nautilo-smoke serve] starting on http://${host}:${port}`);
  console.log(`[nautilo-smoke serve] token: ${maskToken(token)}`);
  console.log(`[nautilo-smoke serve] platforms: ${configuredPlatforms.join(", ")}`);
  console.log(`[nautilo-smoke serve] consumers read the token from ~/.nautilo/smoke-token or $NAUTILO_SMOKE_TOKEN`);
  if (keepVms) {
    console.log(`[nautilo-smoke serve] --keep-vms set; VMs will stay running after shutdown`);
  }

  const server = await createSmokeServer({
    runnerConfig,
    token,
    host,
    port,
    log: (line) => console.log(line),
  });

  // `registerShutdownHandlers` drives its own `process.exit(0)` once
  // the HTTP server drains and the drivers stop. This promise never
  // resolves — the process just goes away cleanly. If the shutdown
  // helper's beforeExit throws, it exits with code 1 instead.
  registerShutdownHandlers({
    drivers: namedDrivers,
    keepVms,
    beforeExit: async () => {
      console.log(`[nautilo-smoke serve] closing HTTP server…`);
      await server.close();
      console.log(`[nautilo-smoke serve] HTTP server closed`);
    },
  });

  return new Promise<number>(() => { /* runs forever; shutdown helper exits */ });
}
