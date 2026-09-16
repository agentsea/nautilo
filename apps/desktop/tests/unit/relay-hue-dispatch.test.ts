/**
 * The provider runtime imports Electron-only modules, so Bun cannot import it in a
 * standalone unit run when Electron's binary is absent. Match the existing
 * relay-binary-resolution test convention for binary helpers, while exercising
 * the extracted fixed dispatch adapter directly. The remaining source reads
 * cover unexported packaged-binary resolution and its capability projection;
 * the Hue operation behavior itself is import-tested below.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createWorkspaceGuard } from "@nautilo/relay";
import { createHueDispatchHandler } from "../../electron/relay-dispatch/local-applications.ts";

const providerRuntimeSource = readFileSync(
  join(import.meta.dir, "../../electron/relay-provider-runtime.ts"),
  "utf8",
);

describe("Electron OpenHue dispatch", () => {
  test("resolves explicit, bundled, flexible vendored, tools-bin, then PATH binaries", () => {
    const resolver = providerRuntimeSource.slice(
      providerRuntimeSource.indexOf("function resolveOpenHueBin"),
      providerRuntimeSource.indexOf("async function canRunOpenHue"),
    );
    expect(resolver).toContain('process.env["NAUTILO_OPENHUE_BIN"]');
    expect(resolver.indexOf('process.env["NAUTILO_OPENHUE_BIN"]')).toBeLessThan(
      resolver.indexOf('bundledToolPath("openhue")'),
    );
    expect(resolver).toContain('devVendoredToolPath("openhue")');
    expect(resolver).toContain('path.join(resolveToolsBin(), "openhue")');
    expect(resolver).toContain("fsSync.existsSync(appManaged)");
    expect(resolver).toMatch(/devVendoredToolPath\("openhue"\)\s*\?\?\s*\(fsSync\.existsSync/);
  });

  test("dev vendor resolution supports both arch-specific and universal flat artifacts", () => {
    const resolver = providerRuntimeSource.slice(
      providerRuntimeSource.indexOf("function devVendoredToolPath"),
      providerRuntimeSource.indexOf("function bundledBunPath"),
    );
    expect(resolver).toContain("path.join(__dirname, \"..\", \"vendor\", root, process.arch, name)");
    expect(resolver).toContain("path.join(__dirname, \"..\", \"vendor\", root, name)");
  });

  test("probes local `openhue version` before advertising both Hue capabilities", () => {
    const capabilities = providerRuntimeSource.slice(
      providerRuntimeSource.indexOf("async function canRunOpenHue"),
      providerRuntimeSource.indexOf("async function browserRuntimeCapabilities"),
    );
    expect(capabilities).toContain('execFileAsync(bin, ["version"]');
    expect(capabilities).toContain("timeout: OPENHUE_PROBE_TIMEOUT_MS");
    expect(capabilities).toContain("if (!(await probe(bin)))");
    expect(capabilities).toContain("return { canDiscoverHue: true, canControlHue: true }");
  });

  test("executor uses execFile argv and returns stdout, stderr, and exit code", () => {
    const executor = providerRuntimeSource.slice(
      providerRuntimeSource.indexOf("const openHueExecutor"),
      providerRuntimeSource.indexOf("async function openHueRuntimeCapabilities"),
    );
    expect(executor).toContain("execFileAsync(binary, [...argv]");
    expect(executor).toContain("return { stdout, stderr, exitCode: 0 }");
    expect(executor).toContain("stdout: failure.stdout ??");
    expect(executor).toContain("stderr: failure.stderr ?? failure.message ??");
    expect(executor).toContain('typeof failure.code === "number" ? failure.code : 1');
  });

  test("routes hue_lights through the fixed Hue adapter", async () => {
    const executions: Array<{ binary: string; argv: readonly string[]; timeoutMs: number }> = [];
    const handler = createHueDispatchHandler({
      resolveBinary: () => "/managed/openhue",
      executor: {
        execute: async (binary, argv, options) => {
          executions.push({ binary, argv, timeoutMs: options.timeoutMs });
          return { stdout: '[{"id":"light-1"}]', stderr: "", exitCode: 0 };
        },
      },
    });

    expect(await handler({
      request: {
        correlationId: "hue-fixed-lane",
        toolName: "hue_lights",
        args: { action: "list_lights" },
        impact: "read-only",
        approvalObtained: false,
      },
      signal: undefined,
      guard: createWorkspaceGuard({ workspaceRoot: "/tmp" }),
    })).toEqual({
      handled: true,
      result: {
        status: "ok",
        result: [{ id: "light-1" }],
      },
    });
    expect(executions).toMatchObject([{
      binary: "/managed/openhue",
      argv: ["get", "light", "--json"],
    }]);
    expect(executions).toHaveLength(1);
    expect(executions[0]!.timeoutMs).toBeGreaterThan(0);
    expect(executions[0]!.timeoutMs).toBeLessThanOrEqual(15_000);
  });

  test("exposes Hue test hooks alongside existing relay binary hooks", () => {
    const hooks = providerRuntimeSource.slice(
      providerRuntimeSource.indexOf("export const relayBinaryResolutionForTests"),
    );
    expect(hooks).toContain("resolveOpenHueBin");
    expect(hooks).toContain("canRunOpenHue");
    expect(hooks).toContain("openHueRuntimeCapabilities");
    expect(hooks).toContain("openHueExecutor");
  });
});
