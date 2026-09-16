import { expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  profilesRootDir,
  resolveTransport,
  type Profile,
} from "../../src/lib/api-client.ts";
import { writeBootstrapToken } from "../../src/lib/bootstrap-tokens.ts";
import { loadProfile } from "../../src/lib/profile-schema.ts";
import {
  resolveServerForCommand,
  setCliProfileFlagOverride,
} from "../../src/lib/profile-aware-server.ts";

let tmpHome: string;

beforeEach(() => {
  tmpHome = join(tmpdir(), `nautilo-resolve-tr-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, ".nautilo", "profiles"), { recursive: true, mode: 0o700 });
});

afterEach(() => {
  setCliProfileFlagOverride(undefined);
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

test("external + socket file → localhost + unix path", async () => {
  mkdirSync(join(tmpHome, ".nautilo"), { recursive: true, mode: 0o700 });
  const sock = join(tmpHome, ".nautilo", "server.sock");
  writeFileSync(sock, "");
  const p: Profile = { name: "l", transport: "local", lifecycle: "external" };
  const t = await resolveTransport(p, tmpHome);
  expect(t.baseUrl).toBe("http://localhost");
  expect(t.unixSocketPath).toBe(sock);
  expect(t.bearer).toBeUndefined();
});

test("external without socket → 127.0.0.1 with default port", async () => {
  const p: Profile = { name: "l", transport: "local", lifecycle: "external" };
  const t = await resolveTransport(p, tmpHome);
  expect(t).toEqual({ baseUrl: "http://127.0.0.1:3201" });
});

test("external with explicit port", async () => {
  const p: Profile = { name: "l", transport: "local", lifecycle: "external", port: 4000 };
  const t = await resolveTransport(p, tmpHome);
  expect(t.baseUrl).toBe("http://127.0.0.1:4000");
});

test("M092 compose: reads server URL from ~/.nautilo${suffix}/instance.json", async () => {
  // Default instance: instance.json at ~/.nautilo/instance.json
  mkdirSync(join(tmpHome, ".nautilo"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(tmpHome, ".nautilo", "instance.json"),
    JSON.stringify({ server: { url: "http://localhost:3001", port: 3001 } }),
  );
  const def: Profile = {
    name: "local-default",
    transport: "local",
    lifecycle: "compose",
  };
  expect(await resolveTransport(def, tmpHome)).toEqual({
    baseUrl: "http://localhost:3001",
  });

  // Named instance: instance.json at ~/.nautilo-alpha/instance.json
  mkdirSync(join(tmpHome, ".nautilo-alpha"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(tmpHome, ".nautilo-alpha", "instance.json"),
    JSON.stringify({ server: { url: "http://localhost:3701", port: 3701 } }),
  );
  const alpha: Profile = {
    name: "alpha",
    transport: "local",
    lifecycle: "compose",
    instance_id: "alpha",
  };
  expect(await resolveTransport(alpha, tmpHome)).toEqual({
    baseUrl: "http://localhost:3701",
  });
});

test("M092 compose: falls back to port-only when instance.json lacks server.url", async () => {
  mkdirSync(join(tmpHome, ".nautilo-beta"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(tmpHome, ".nautilo-beta", "instance.json"),
    JSON.stringify({ server: { port: 3801 } }),
  );
  const p: Profile = {
    name: "beta",
    transport: "local",
    lifecycle: "compose",
    instance_id: "beta",
  };
  expect(await resolveTransport(p, tmpHome)).toEqual({
    baseUrl: "http://127.0.0.1:3801",
  });
});

test("modern persisted local Compose endpoint fields are ignored and the canonical instance URL wins", async () => {
  const profileDir = profilesRootDir(tmpHome);
  mkdirSync(join(tmpHome, ".nautilo-alpha"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(tmpHome, ".nautilo-alpha", "instance.json"),
    JSON.stringify({ server: { url: "http://127.0.0.1:4810", port: 4810 } }),
  );
  writeFileSync(
    join(profileDir, "alpha.toml"),
    'name = "alpha"\ntransport = "local"\nlifecycle = "compose"\ninstance_id = "alpha"\nport = 5999\n',
    { mode: 0o600 },
  );
  const profile = loadProfile("alpha", tmpHome);
  expect("port" in profile).toBeFalse();
  expect(await resolveTransport(profile, tmpHome)).toEqual({ baseUrl: "http://127.0.0.1:4810" });
});

test("M092 compose: never probes the unix socket (containerized server does not expose one)", async () => {
  // Even with a stray ~/.nautilo/server.sock present, compose lifecycle
  // must NOT route through it — the deploy-stack server is in docker.
  mkdirSync(join(tmpHome, ".nautilo"), { recursive: true, mode: 0o700 });
  writeFileSync(join(tmpHome, ".nautilo", "server.sock"), "");
  writeFileSync(
    join(tmpHome, ".nautilo", "instance.json"),
    JSON.stringify({ server: { port: 3001 } }),
  );
  const p: Profile = {
    name: "local-default",
    transport: "local",
    lifecycle: "compose",
  };
  const t = await resolveTransport(p, tmpHome);
  expect(t.unixSocketPath).toBeUndefined();
  expect(t.baseUrl).toBe("http://127.0.0.1:3001");
});

test("M092 compose: missing instance.json + no profile.port throws actionable error", async () => {
  const p: Profile = {
    name: "ghost",
    transport: "local",
    lifecycle: "compose",
    instance_id: "ghost",
  };
  let caught: unknown;
  try {
    await resolveTransport(p, tmpHome);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toMatch(/no instance\.json/);
  expect((caught as Error).message).toMatch(/nautilo deploy --profile ghost/);
});

test("remote reads NAUTILO_BOOTSTRAP_TOKEN from ~/.nautilo/bootstrap-tokens/<name>", async () => {
  writeBootstrapToken("demo", "abc123", { home: tmpHome });
  const p: Profile = {
    name: "demo",
    transport: "remote",
    lifecycle: "external",
    domain: "demo.example.com",
  };
  const t = await resolveTransport(p, tmpHome);
  expect(t).toEqual({
    baseUrl: "https://demo.example.com",
    bearer: "abc123",
  });
  const legacy = join(profilesRootDir(tmpHome), "demo.env");
  expect(existsSync(legacy)).toBe(false);
});

test("remote does NOT lazily migrate a legacy profile .env at runtime (Phase 6 retirement)", async () => {
  const legacyPath = join(profilesRootDir(tmpHome), "demo.env");
  writeFileSync(legacyPath, "NAUTILO_BOOTSTRAP_TOKEN=legacyTok\nOTHER=x\n", { mode: 0o600 });
  const p: Profile = {
    name: "demo",
    transport: "remote",
    lifecycle: "external",
    domain: "demo.example.com",
  };
  let caught: unknown;
  try {
    await resolveTransport(p, tmpHome);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(existsSync(legacyPath)).toBe(true);
  expect((caught as Error).message).toMatch(/bootstrap-tokens\/demo/);
  expect((caught as Error).message).toMatch(/nautilo doctor migrate-config/);
});

test("remote without token (no legacy file either) throws message naming the new location only", async () => {
  const p: Profile = {
    name: "x",
    transport: "remote",
    lifecycle: "external",
    domain: "x.example.com",
  };
  let caught: unknown;
  try {
    await resolveTransport(p, tmpHome);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toMatch(/bootstrap-tokens\/x/);
  expect((caught as Error).message).not.toMatch(/doctor migrate-config/);
});

test("remote without domain throws", async () => {
  writeBootstrapToken("x", "secret", { home: tmpHome });
  const p: Profile = { name: "x", transport: "remote", lifecycle: "external" };
  let caught: unknown;
  try {
    await resolveTransport(p, tmpHome);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toMatch(/missing domain/);
});

test("M115 remote+compose with base_url + bootstrap token", async () => {
  writeBootstrapToken("droplet", "tok123", { home: tmpHome });
  const p: Profile = {
    name: "droplet",
    transport: "remote",
    lifecycle: "compose",
    ssh: { host: "203.0.113.7", user: "root" },
    base_url: "http://203.0.113.7:4001",
  };
  const t = await resolveTransport(p, tmpHome);
  expect(t).toEqual({
    baseUrl: "http://203.0.113.7:4001",
    bearer: "tok123",
  });
});

test("M115 remote+compose without base_url uses ssh.host + instance.json server.port (not server.url)", async () => {
  writeBootstrapToken("droplet", "tok123", { home: tmpHome });
  mkdirSync(join(tmpHome, ".nautilo-prod"), { recursive: true, mode: 0o700 });
  // instance.json's `server.url` is operator-local (`http://localhost:...`)
  // because resolveInstance() runs on the operator's mac. For remote
  // profiles we must derive the public URL from ssh.host + server.port.
  writeFileSync(
    join(tmpHome, ".nautilo-prod", "instance.json"),
    JSON.stringify({ server: { url: "http://localhost:4001", port: 4001 } }),
  );
  const p: Profile = {
    name: "droplet",
    transport: "remote",
    lifecycle: "compose",
    ssh: { host: "203.0.113.7", user: "root" },
    instance_id: "prod",
  };
  const t = await resolveTransport(p, tmpHome);
  expect(t).toEqual({
    baseUrl: "http://203.0.113.7:4001",
    bearer: "tok123",
  });
});

test("M115 remote+compose missing bootstrap token throws", async () => {
  const p: Profile = {
    name: "droplet",
    transport: "remote",
    lifecycle: "compose",
    ssh: { host: "203.0.113.7", user: "root" },
    base_url: "http://203.0.113.7:4001",
  };
  let caught: unknown;
  try {
    await resolveTransport(p, tmpHome);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toMatch(/bootstrap-tokens\/droplet/);
});

test("D249 remote+compose letsencrypt+domain uses https://<domain> (not instance.json localhost)", async () => {
  writeBootstrapToken("upgrade-fixture", "tok-le", { home: tmpHome });
  mkdirSync(join(tmpHome, ".nautilo-dev"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(tmpHome, ".nautilo-dev", "instance.json"),
    JSON.stringify({ server: { url: "http://localhost:4001", port: 4001 } }),
  );
  const p: Profile = {
    name: "upgrade-fixture",
    transport: "remote",
    lifecycle: "compose",
    https: "letsencrypt",
    domain: "upgrade.example.test",
    ssh: { host: "203.0.113.99", user: "root" },
    instance_id: "dev",
  };
  const t = await resolveTransport(p, tmpHome);
  expect(t).toEqual({
    baseUrl: "https://upgrade.example.test",
    bearer: "tok-le",
  });
});

test("D249 explicit --profile wins over .active for resolveServerForCommand", async () => {
  writeBootstrapToken("requested", "tok-req", { home: tmpHome });
  writeBootstrapToken("active-local", "tok-active", { home: tmpHome });
  mkdirSync(join(tmpHome, ".nautilo-prod"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(tmpHome, ".nautilo-prod", "instance.json"),
    JSON.stringify({ server: { port: 4001 } }),
  );
  writeFileSync(
    join(profilesRootDir(tmpHome), "requested.toml"),
    [
      'name = "requested"',
      'transport = "remote"',
      'lifecycle = "compose"',
      'https = "letsencrypt"',
      'domain = "prod.example.com"',
      'instance_id = "prod"',
      '[ssh]',
      'host = "203.0.113.7"',
      'user = "root"',
    ].join("\n"),
    { mode: 0o644 },
  );
  writeFileSync(
    join(profilesRootDir(tmpHome), "active-local.toml"),
    [
      'name = "active-local"',
      'transport = "local"',
      'lifecycle = "compose"',
      'port = 5999',
    ].join("\n"),
    { mode: 0o644 },
  );
  writeFileSync(join(profilesRootDir(tmpHome), ".active"), "active-local\n", {
    mode: 0o600,
  });

  setCliProfileFlagOverride("requested");
  const result = await resolveServerForCommand({ home: tmpHome });
  expect(result.source).toBe("profile");
  expect(result.baseUrl).toBe("https://prod.example.com");
  expect(result.bearer).toBe("tok-req");
});

test("M115 remote+compose without base_url or instance.json throws actionable error", async () => {
  writeBootstrapToken("droplet", "tok123", { home: tmpHome });
  const p: Profile = {
    name: "droplet",
    transport: "remote",
    lifecycle: "compose",
    ssh: { host: "203.0.113.7", user: "root" },
    instance_id: "prod",
  };
  let caught: unknown;
  try {
    await resolveTransport(p, tmpHome);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toMatch(/no base_url in profile/);
  expect((caught as Error).message).toMatch(/no instance\.json/);
  expect((caught as Error).message).toMatch(/nautilo deploy --profile droplet/);
});
