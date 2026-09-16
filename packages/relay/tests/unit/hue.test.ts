import { describe, expect, test } from "bun:test";
import {
  createOpenHueHandler,
  isOpenHueAction,
  OPENHUE_ACTIONS,
  openHueArgv,
  type OpenHueDispatchResult,
  type OpenHueExecResult,
  type OpenHueExecutor,
} from "../../src/hue";

type Call = {
  binary: string;
  argv: readonly string[];
  options: { env: NodeJS.ProcessEnv; timeoutMs: number };
};

function recordingExecutor(results: OpenHueExecResult[] = []): { executor: OpenHueExecutor; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    executor: {
      async execute(binary, argv, options) {
        calls.push({ binary, argv, options });
        return results.shift() ?? { stdout: "", stderr: "", exitCode: 0 };
      },
    },
  };
}

function errorCode(result: OpenHueDispatchResult): string {
  expect(result.status).toBe("error");
  if (result.status !== "error") throw new Error("Expected an OpenHue error result.");
  return result.errorCode;
}

describe("OpenHue 0.24 argv allowlist", () => {
  test("defines the complete fixed action schema", () => {
    expect(OPENHUE_ACTIONS).toEqual([
      "discover", "setup", "list_lights", "list_rooms", "list_scenes",
      "set_light", "set_room", "activate_scene",
    ]);
    expect(isOpenHueAction("set_light")).toBe(true);
    expect(isOpenHueAction("shell")).toBe(false);
  });

  test("maps discovery and bounded setup", () => {
    expect(openHueArgv({ action: "discover" })).toEqual({ ok: true, action: "discover", argv: ["discover"] });
    expect(openHueArgv({ action: "setup", bridge: "192.168.1.2", devicetype: "nautilo" })).toEqual({
      ok: true, action: "setup", argv: ["setup", "--bridge", "192.168.1.2", "--devicetype", "nautilo"],
    });
  });

  test("maps every JSON list action and optional room filter", () => {
    expect(openHueArgv({ action: "list_lights", room: "Kitchen" })).toEqual({
      ok: true, action: "list_lights", argv: ["get", "light", "--room", "Kitchen", "--json"],
    });
    expect(openHueArgv({ action: "list_rooms" })).toEqual({
      ok: true, action: "list_rooms", argv: ["get", "room", "--json"],
    });
    expect(openHueArgv({ action: "list_scenes", room: "Office" })).toEqual({
      ok: true, action: "list_scenes", argv: ["get", "scene", "--room", "Office", "--json"],
    });
  });

  test("maps light and room state only to documented OpenHue flags", () => {
    expect(openHueArgv({
      action: "set_light", name: "Desk Lamp", on: true, brightness: 50,
      temperature: 300, rgb: [160, 177, 194], transitionTime: "2s",
    })).toEqual({
      ok: true, action: "set_light",
      argv: ["set", "light", "Desk Lamp", "--on", "--brightness", "50", "--temperature", "300", "--rgb", "#A0B1C2", "--transition-time", "2s"],
    });
    expect(openHueArgv({ action: "set_room", name: "Studio", on: false })).toEqual({
      ok: true, action: "set_room", argv: ["set", "room", "Studio", "--off"],
    });
  });

  test("maps scene activation with optional room and dynamic action", () => {
    expect(openHueArgv({ action: "activate_scene", name: "Relax", room: "Bedroom", dynamic: true })).toEqual({
      ok: true, action: "activate_scene", argv: ["set", "scene", "Relax", "--room", "Bedroom", "--action", "dynamic"],
    });
    expect(openHueArgv({ action: "activate_scene", name: "Relax", dynamic: false })).toEqual({
      ok: true, action: "activate_scene", argv: ["set", "scene", "Relax"],
    });
  });

  test("converts the Genie numeric transition duration to OpenHue milliseconds", () => {
    for (const action of ["set_light", "set_room"] as const) {
      expect(openHueArgv({ action, name: "Desk", on: true, transitionTime: 500 })).toEqual({
        ok: true, action, argv: ["set", action === "set_light" ? "light" : "room", "Desk", "--on", "--transition-time", "500ms"],
      });
      for (const transitionTime of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(openHueArgv({ action, name: "Desk", on: true, transitionTime }).ok).toBe(false);
      }
    }
  });

  test("rejects unknown actions, malformed required fields, and invalid state", () => {
    for (const args of [
      { action: "run", command: "openhue set light x --on" },
      { action: "set_light", on: true },
      { action: "set_room", name: "Studio" },
      { action: "set_light", name: "Desk", brightness: 20 },
      { action: "set_room", name: "Studio", on: false, rgb: "#abcdef" },
      { action: "set_light", name: "Desk", on: true, brightness: 101 },
      { action: "set_light", name: "Desk", on: true, temperature: 152 },
      { action: "set_light", name: "Desk", on: true, rgb: "red" },
      { action: "set_light", name: "Desk", on: true, rgb: [255, 0] },
      { action: "set_light", name: "Desk", on: true, rgb: [255, 0, 256] },
      { action: "set_light", name: "Desk", on: true, rgb: [255, 0, 0.5] },
      { action: "set_light", name: "Desk", on: true, rgb: [255, "0", 0] },
      { action: "activate_scene", name: "Relax", dynamic: "yes" },
      { action: "setup", bridge: "" },
    ]) {
      expect(openHueArgv(args).ok).toBe(false);
    }
  });

  test("never forwards caller-supplied argv or command strings", () => {
    const result = openHueArgv({
      action: "set_light", name: "Desk; rm -rf /", on: true,
      argv: ["discover"], command: "openhue discover",
    });
    expect(result).toEqual({
      ok: true, action: "set_light", argv: ["set", "light", "Desk; rm -rf /", "--on"],
    });
  });
});

describe("createOpenHueHandler", () => {
  test("sets the Nautilo config home by default without overwriting a caller override", async () => {
    const first = recordingExecutor([{ stdout: "found", stderr: "", exitCode: 0 }]);
    const handler = createOpenHueHandler({ platform: "linux",
      executor: first.executor, binaryPath: "/tools/openhue", homeDir: "/Users/alice", env: { HOME: "/Users/alice" },
    });
    expect(await handler({ action: "discover" })).toEqual({ status: "ok", result: { stdout: "found", stderr: "" } });
    expect(first.calls[0]).toMatchObject({
      binary: "/tools/openhue", argv: ["discover"],
      options: { env: { HOME: "/Users/alice", XDG_CONFIG_HOME: "/Users/alice/.nautilo" } },
    });
    expect(first.calls[0]!.options.timeoutMs).toBeGreaterThan(0);
    expect(first.calls[0]!.options.timeoutMs).toBeLessThanOrEqual(15_000);

    const second = recordingExecutor();
    const override = createOpenHueHandler({ platform: "linux",
      executor: second.executor, env: { XDG_CONFIG_HOME: "/custom/config" }, homeDir: "/Users/alice",
    });
    await override({ action: "discover" });
    expect(second.calls[0]?.options.env["XDG_CONFIG_HOME"]).toBe("/custom/config");
  });

  test("uses a bounded pairing timeout for setup", async () => {
    const fake = recordingExecutor();
    const handler = createOpenHueHandler({ platform: "linux", executor: fake.executor, setupTimeoutMs: 999_999 });
    await handler({ action: "setup" });
    expect(fake.calls[0]!.options.timeoutMs).toBeGreaterThan(0);
    expect(fake.calls[0]!.options.timeoutMs).toBeLessThanOrEqual(120_000);
  });

  test("accepts successful pairing output that includes the button prompt", async () => {
    const fake = recordingExecutor([{
      stdout:
        "[OK] Bridge IP is '192.168.68.50'\n[..] Please push the button on your Hue Bridge\n" +
        "[OK] Successfully paired openhue with your Hue Bridge!\n" +
        "[OK] Configuration saved in file /Users/test/.nautilo/openhue/config.yaml",
      stderr: "",
      exitCode: 0,
    }]);
    const handler = createOpenHueHandler({ platform: "linux", executor: fake.executor });
    const result = await handler({ action: "setup", bridge: "192.168.68.50" });
    expect(result.status).toBe("ok");
  });

  test("normalizes JSON list objects and arrays", async () => {
    const fake = recordingExecutor([
      { stdout: "{\"name\":\"Desk\"}", stderr: "", exitCode: 0 },
      { stdout: "[{\"name\":\"Kitchen\"}]", stderr: "", exitCode: 0 },
    ]);
    const handler = createOpenHueHandler({ platform: "linux", executor: fake.executor });
    expect(await handler({ action: "list_lights" })).toEqual({ status: "ok", result: [{ name: "Desk" }] });
    expect(await handler({ action: "list_rooms" })).toEqual({ status: "ok", result: [{ name: "Kitchen" }] });
  });

  test("reports invalid request and invalid JSON response categories", async () => {
    const fake = recordingExecutor([{ stdout: "not json", stderr: "", exitCode: 0 }]);
    const handler = createOpenHueHandler({ platform: "linux", executor: fake.executor });
    expect(errorCode(await handler({ action: "raw", argv: ["discover"] }))).toBe("hue_invalid_request");
    expect(errorCode(await handler({ action: "list_lights" }))).toBe("hue_invalid_response");
  });

  test("classifies expected OpenHue output failures even when exit code is zero", async () => {
    const fake = recordingExecutor([
      { stdout: "", stderr: "Error: too many attempts to discover the bridge via URL", exitCode: 1 },
      { stdout: "", stderr: "configuration not found", exitCode: 0 },
      { stdout: "[KO] Unable to discover your Hue Bridge", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "no light(s) found for [Desk]", exitCode: 0 },
      { stdout: "", stderr: "failed to set light Desk", exitCode: 0 },
    ]);
    const handler = createOpenHueHandler({ platform: "linux", executor: fake.executor });
    const discoveryFailure = await handler({ action: "discover" });
    expect(errorCode(discoveryFailure)).toBe("hue_bridge_discovery_failed");
    if (discoveryFailure.status === "error") {
      expect(discoveryFailure.error).toContain("Could not discover a Hue Bridge from this Mac");
      expect(discoveryFailure.error).not.toContain("too many attempts");
    }
    expect(errorCode(await handler({ action: "discover" }))).toBe("hue_not_configured");
    expect(errorCode(await handler({ action: "discover" }))).toBe("hue_bridge_not_found");
    expect(errorCode(await handler({ action: "set_light", name: "Desk", on: true }))).toBe("hue_not_found");
    expect(errorCode(await handler({ action: "set_light", name: "Desk", on: true }))).toBe("hue_command_failed");
  });

  test("classifies non-zero exits, executor errors, and setup timeouts", async () => {
    const failed = recordingExecutor([{ stdout: "", stderr: "permission denied", exitCode: 1 }]);
    expect(errorCode(await createOpenHueHandler({ platform: "linux", executor: failed.executor })({ action: "discover" }))).toBe("hue_command_failed");

    const timeout: OpenHueExecutor = {
      async execute() { throw new Error("execution timed out after 120000ms"); },
    };
    expect(errorCode(await createOpenHueHandler({ platform: "linux", executor: timeout })({ action: "setup" }))).toBe("hue_setup_timeout");
  });
});
