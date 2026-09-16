import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A fresh child owns its HOME and module globals. No DB connection variables,
// real instance configuration, test-token files, or existing app state enter it.
// Fastify inject exercises the real app without starting a network listener.
describe("DB-less app composition", () => {
  test("real app serves authenticated ping and retains production failure by default", async () => {
    const fixtureHome = await mkdtemp(join(tmpdir(), "nautilo-db-less-app-"));
    const appPath = join(import.meta.dir, "../../src/app.ts");
    const child = Bun.spawn([process.execPath, "--eval", `
      import { createApp } from ${JSON.stringify(appPath)};
      const results = {};
      for (const [name, overrides] of [
        ["production", { NODE_ENV: "production" }],
        ["missingTestMode", { NAUTILO_TEST_MODE: "" }],
        ["missingTestModeOnly", { NAUTILO_TEST_MODE_ONLY: "" }],
      ]) {
        const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
        Object.assign(process.env, overrides);
        try { await createApp({ silent: true, testModeOnly: true }); results[name] = "accepted"; }
        catch (error) { results[name] = error.message; }
        Object.assign(process.env, previous);
      }
      const app = await createApp({ silent: true, testModeOnly: true });
      try {
        results.ping = (await app.inject({ method: "GET", url: "/api/test/ping",
          headers: { authorization: "Bearer " + process.env.NAUTILO_TEST_TOKEN } })).statusCode;
        results.missingToken = (await app.inject({ method: "GET", url: "/api/test/ping" })).statusCode;
        results.wrongToken = (await app.inject({ method: "GET", url: "/api/test/ping",
          headers: { authorization: "Bearer wrong-token" } })).statusCode;
        results.health = (await app.inject({ method: "GET", url: "/health" })).statusCode;
        results.productionRoute = app.hasRoute({ method: "POST", url: "/api/live-shadow/domain-key/source/pending" });
        results.relayRoute = app.hasRoute({ method: "GET", url: "/relay" });

      } finally { await app.close(); }
      try { await createApp({ silent: true }); results.ordinary = "accepted"; }
      catch (error) { results.ordinary = error.name; }
      process.stdout.write("DB_LESS_PROOF=" + JSON.stringify(results) + "\\n");
      process.exit(0);
    `], {
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: fixtureHome,
        TMPDIR: fixtureHome,
        NODE_ENV: "test",
        NAUTILO_INSTANCE_ID: "test-cruft",
        NAUTILO_TEST_MODE: "1",
        NAUTILO_TEST_MODE_ONLY: "1",
        NAUTILO_TEST_TOKEN: "isolated-fixture-token-0123456789",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const watchdog = setTimeout(() => child.kill(), 30_000);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      if (exitCode !== 0) throw new Error(`App fixture exited ${exitCode}: ${stderr}`);
      const proof = JSON.parse(stdout.split("DB_LESS_PROOF=")[1]!.trim()) as Record<string, unknown>;
      expect(proof).toEqual({
        production: "DB-less app composition requires the development test-mode-only harness",
        missingTestMode: "DB-less app composition requires the development test-mode-only harness",
        missingTestModeOnly: "DB-less app composition requires the development test-mode-only harness",
        ping: 200,
        missingToken: 404,
        wrongToken: 404,
        health: 200,
        productionRoute: false,
        relayRoute: true,
        ordinary: "CryptoDatabaseConnectionUnavailableError",
      });
    } finally {
      clearTimeout(watchdog);
      if (child.exitCode === null) { child.kill(); await child.exited; }
      await rm(fixtureHome, { recursive: true, force: true });
    }
  }, 35_000);
});
