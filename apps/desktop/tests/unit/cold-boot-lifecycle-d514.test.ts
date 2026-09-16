import { afterEach, describe, expect, test } from "bun:test";
import { ColdBootObservationAuthority } from "../../electron/cold-boot-observation";
import { runColdBootLaunchGate } from "../../electron/cold-boot-lifecycle";
import { D514ControlledServer } from "../helpers/d514-controlled-server";

const servers: D514ControlledServer[] = [];

afterEach(() => {
  while (servers.length > 0) servers.pop()?.stop();
});

function server(): D514ControlledServer {
  const controlled = new D514ControlledServer();
  servers.push(controlled);
  return controlled;
}

function health(identity = "expected") {
  return { status: "ok", serverIdentity: identity, logtoEndpoint: "https://auth.example.test" };
}

function authority(base: string): ColdBootObservationAuthority {
  return new ColdBootObservationAuthority({
    fetch: (input, init) => fetch(input, init),
    expectedFingerprint: () => "expected",
    fingerprintFromHealthBody: (body) =>
      typeof body.serverIdentity === "string" ? body.serverIdentity : null,
    timeoutMs: 5_000,
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for lifecycle phase");
    await Bun.sleep(1);
  }
}

describe("D514 executable local-shell boot lifecycle", () => {
  test("fixture controls health/setup/profile independently, including headers, shape, identity, and transient sequence", async () => {
    const controlled = server();
    const root = await fetch(`${controlled.url}/`);
    expect(root.headers.get("x-d514-marker")).toBe(controlled.marker);
    expect(await root.text()).toContain(controlled.marker);
    const ready = await fetch(`${controlled.url}/health/ready`);
    expect((await ready.json() as { status: string }).status).toBe("ready");
    controlled.set("health", [
      { status: 503, headers: { "x-d514": "transient" }, text: "warming" },
      { delayMs: 5, headers: { "x-d514": "identity" }, json: health("server-b") },
    ]);
    controlled.set("setup", [{ status: 202, headers: { "x-d514": "setup" }, json: { setupState: "ready" } }]);
    controlled.set("profile", [{ headers: { "x-d514": "profile" }, text: "not-json" }]);

    const first = await fetch(`${controlled.url}/health`);
    expect(first.status).toBe(503);
    expect(first.headers.get("x-d514")).toBe("transient");
    const second = await fetch(`${controlled.url}/health`);
    expect(second.headers.get("x-d514")).toBe("identity");
    expect((await second.json() as { serverIdentity: string }).serverIdentity).toBe("server-b");
    const setup = await fetch(`${controlled.url}/api/setup/status`);
    expect(setup.status).toBe(202);
    expect(setup.headers.get("x-d514")).toBe("setup");
    const profile = await fetch(`${controlled.url}/api/profile/status`);
    expect(await profile.text()).toBe("not-json");
    expect(controlled.calls("health")).toBe(2);
    expect(controlled.calls("setup")).toBe(1);
    expect(controlled.calls("profile")).toBe(1);
  });

  test("local shell load is initiated before delayed health; setup/auth/profile and remote release wait for recovery continuation", async () => {
    const controlled = server();
    controlled.set("health", [
      { status: 503, text: "temporarily unavailable" },
      { delayMs: 30, json: health() },
    ]);
    controlled.set("setup", [{ delayMs: 20, json: { setupState: "ready" } }]);
    controlled.set("profile", [{ delayMs: 10, json: { profile: "ready" } }]);
    const observed = authority(controlled.url);
    const events: string[] = [];
    let resolveContinuation: (() => void) | null = null;
    let current = observed.snapshot();

    const gate = runColdBootLaunchGate({
      createLocalShell: () => {
        events.push("local-create", "local-load");
      },
      observe: async () => {
        current = await observed.observe(controlled.url);
        return current;
      },
      isLive: (value) => value.kind === "live",
      projectRecovery: () => {
        events.push("recovery-load");
      },
      waitForRecoveryContinuation: () => new Promise<void>((resolve) => {
        resolveContinuation = resolve;
      }),
      currentObservation: () => current,
      setLifecycle: (state) => events.push(`state:${state}`),
    });

    await waitFor(() => events.includes("recovery-load"));
    expect(events).toEqual([
      "state:observing",
      "local-create",
      "local-load",
      "state:paused",
      "recovery-load",
    ]);
    expect(events).not.toContain("remote-release");

    current = await observed.observe(controlled.url);
    resolveContinuation?.();
    const live = await gate;
    expect(live.kind).toBe("live");
    events.push("setup-start");
    await fetch(`${controlled.url}/api/setup/status`);
    events.push("auth-start");
    // Auth discovery consumes the live main-owned health body. It is not a
    // second reachability probe.
    await Bun.sleep(15);
    events.push("profile-start");
    await fetch(`${controlled.url}/api/profile/status`);
    events.push("remote-release");

    expect(events).toEqual([
      "state:observing",
      "local-create",
      "local-load",
      "state:paused",
      "recovery-load",
      "state:resuming",
      "setup-start",
      "auth-start",
      "profile-start",
      "remote-release",
    ]);
    expect(controlled.calls("health")).toBe(2);
  });
});
