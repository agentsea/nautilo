import { describe, expect, spyOn, test } from "bun:test";
import { discoverMacHueBridges, parseHueDnsSdZone } from "../../src/hue-discovery";
import { createOpenHueHandler, type OpenHueExecutor } from "../../src/hue";

const zone = String.raw`
_hue._tcp PTR Studio\032Bridge._hue._tcp
Studio\032Bridge._hue._tcp SRV 0 0 443 bridge-a.local. ; target
Studio\032Bridge._hue._tcp TXT "bridgeid=001788fffe123456" "modelid=BSB003"
`;
const candidate = { bridge: "bridge-a.local", bridgeId: "001788FFFE123456" };
const observed = { stdout: zone, stderr: "", exitCode: 1 }; // continuous browse terminated at deadline

describe("Hue local rediscovery", () => {
  test("keeps complete Hue records, deduplicates announcements, and ignores unrelated or incomplete data", () => {
    expect(parseHueDnsSdZone(zone + zone + "\nEpson._ipp._tcp SRV 0 0 443 printer.local.\n")).toEqual([candidate]);
    expect(parseHueDnsSdZone('Other._hue._tcp SRV 0 0 443 host.local.\n')).toEqual([]);
    expect(parseHueDnsSdZone(zone.replace("bridge-a.local.", "https://remote.example/"))).toEqual([]);
  });

  test("uses fixed native argv and the remaining caller deadline; skips non-macOS", async () => {
    const calls: unknown[] = [];
    const executor: OpenHueExecutor = { execute: async (...args) => { calls.push(args); return observed; } };
    expect(await discoverMacHueBridges({ executor, env: {}, timeoutMs: 125, platform: "darwin" })).toEqual([candidate]);
    expect(calls).toEqual([["/usr/bin/dns-sd", ["-Z", "_hue._tcp", "local."], { env: {}, timeoutMs: 125 }]]);
    expect(await discoverMacHueBridges({ executor, env: {}, timeoutMs: 125, platform: "linux" })).toEqual([]);
    expect(await discoverMacHueBridges({ executor, env: {}, timeoutMs: 0, platform: "darwin" })).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test("finds a bridge through the OS resolver even when OpenHue's multicast resolver would find nothing", async () => {
    const handler = createOpenHueHandler({ platform: "darwin", executor: {
      execute: async (binary) => {
        expect(binary).toBe("/usr/bin/dns-sd");
        return observed;
      },
    } });
    expect(await handler({ action: "discover" })).toMatchObject({
      status: "ok", result: { bridges: [candidate], discoveryComplete: false },
    });
  });

  test("allows a longer observation window without extending the caller deadline or disabling process timeout", async () => {
    const timeouts: number[] = [];
    const executor: OpenHueExecutor = { execute: async (_binary, _argv, options) => {
      timeouts.push(options.timeoutMs); return observed;
    } };
    await discoverMacHueBridges({ executor, env: {}, timeoutMs: 6_000, browseWindowMs: 5_000, platform: "darwin" });
    await discoverMacHueBridges({ executor, env: {}, timeoutMs: 125, browseWindowMs: 5_000, platform: "darwin" });
    for (const browseWindowMs of [0, -1, Number.NaN]) {
      expect(await discoverMacHueBridges({ executor, env: {}, timeoutMs: 125, browseWindowMs, platform: "darwin" })).toEqual([]);
    }
    expect(timeouts).toEqual([5_000, 125]);
  });

  test("does not launch a lighting or pairing process when discovery exhausts the action deadline", async () => {
    const clock = spyOn(Date, "now").mockReturnValue(0);
    const calls: string[] = [];
    try {
      const handler = createOpenHueHandler({ platform: "darwin", setupTimeoutMs: 100, executor: {
        execute: async (binary) => {
          calls.push(binary);
          clock.mockReturnValue(100);
          return observed;
        },
      } });
      expect(await handler({ action: "setup" })).toMatchObject({ status: "error", errorCode: "hue_discovery_timeout" });
      expect(calls).toEqual(["/usr/bin/dns-sd"]);
    } finally { clock.mockRestore(); }
  });

  test("retains OpenHue discovery if native discovery is unavailable", async () => {
    const handler = createOpenHueHandler({ platform: "darwin", executor: {
      execute: async (binary) => {
        if (binary === "/usr/bin/dns-sd") throw new Error("native resolver unavailable");
        return { stdout: "192.0.2.10", stderr: "", exitCode: 0 };
      },
    } });
    expect(await handler({ action: "discover" })).toMatchObject({ status: "ok", result: { stdout: "192.0.2.10" } });
  });

  test("setup discovers a stable hostname before invoking the existing physical pairing flow", async () => {
    const calls: string[][] = [];
    const handler = createOpenHueHandler({ platform: "darwin", executor: {
      execute: async (binary, argv) => {
        if (binary === "/usr/bin/dns-sd") return observed;
        calls.push([...argv]);
        return { stdout: "Successfully paired", stderr: "", exitCode: 0 };
      },
    } });
    expect((await handler({ action: "setup", devicetype: "nautilo" })).status).toBe("ok");
    expect(calls).toEqual([["setup", "--devicetype", "nautilo", "--bridge", "bridge-a.local"]]);
  });

  test("explicit bridge selection does not rediscover or substitute another bridge", async () => {
    const handler = createOpenHueHandler({ platform: "darwin", executor: {
      execute: async (binary, argv) => {
        expect(binary).toBe("openhue");
        expect(argv).toEqual(["setup", "--bridge", "chosen.local"]);
        return { stdout: "Successfully paired", stderr: "", exitCode: 0 };
      },
    } });
    expect((await handler({ action: "setup", bridge: "chosen.local" })).status).toBe("ok");
  });

  test("multiple bridges require selection and never start pairing", async () => {
    const second = zone.replaceAll("Studio", "Kitchen").replaceAll("bridge-a", "bridge-b").replaceAll("001788fffe123456", "001788fffe654321");
    const handler = createOpenHueHandler({ platform: "darwin", executor: {
      execute: async (binary) => {
        expect(binary).toBe("/usr/bin/dns-sd");
        return { ...observed, stdout: zone + second };
      },
    } });
    expect(await handler({ action: "setup" })).toMatchObject({ status: "error", errorCode: "hue_bridge_selection_required" });
  });

  test("a stale address returning 404 yields fresh recovery candidates without replaying a mutation or moving credentials", async () => {
    const calls: string[] = [];
    const handler = createOpenHueHandler({ platform: "darwin", executor: {
      execute: async (binary, argv) => {
        calls.push(binary);
        if (binary === "/usr/bin/dns-sd") return observed;
        expect(argv[0]).toBe("set");
        return { stdout: "", stderr: "Error: openhue api error: 404", exitCode: 1 };
      },
    } });
    const result = await handler({ action: "set_light", name: "Desk", on: true });
    expect(result).toMatchObject({ status: "error", errorCode: "hue_bridge_unavailable" });
    if (result.status === "error") {
      expect(result.error).toContain("bridge-a.local");
      expect(result.error).toContain("list_lights to verify");
      expect(result.error).toContain("No lighting command was retried");
    }
    expect(calls).toEqual(["openhue", "/usr/bin/dns-sd"]);
  });
});
