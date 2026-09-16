import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { loadProfile } from "../../src/lib/profile-schema.ts";

const cliDist = join(import.meta.dirname, "..", "..", "dist", "index.js");

function spawnCli(
  args: string[],
  extraEnv?: Record<string, string>,
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [cliDist, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("nautilo profile (D120 A5.4 / M113)", () => {
  beforeAll(() => {
    if (!existsSync(cliDist)) {
      throw new Error(`missing ${cliDist}; run bun run build in apps/cli first`);
    }
  });

  test("profile list (empty home profiles dir)", () => {
    const home = join(tmpdir(), `nprof-empty-${Date.now()}`);
    mkdirSync(join(home, ".nautilo", "profiles"), { recursive: true, mode: 0o700 });
    const r = spawnCli(["profile", "list", "--home", home]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("profile list: (none)\n");
  });

  test(
    "profile add / profile use / profile list / profile current / profile remove",
    () => {
    const home = join(tmpdir(), `nprof-flow-${Date.now()}`);
    let r = spawnCli([
      "profile",
      "add",
      "demo",
      "--transport",
      "local",
      "--lifecycle",
      "compose",
      "--yes",
      "--home",
      home,
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("profile add: created 'demo' and set as active.");

    r = spawnCli(["profile", "list", "--home", home]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split("\n").sort().join("\n")).toBe("demo");

    r = spawnCli(["profile", "use", "demo", "--home", home]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("profile use: active profile is 'demo'");
    const active = readFileSync(join(home, ".nautilo", "profiles", ".active"), "utf8").trim();
    expect(active).toBe("demo");

    writeFileSync(
      join(home, ".nautilo", "instance.json"),
      JSON.stringify({ server: { port: 3201 } }),
      { mode: 0o600 },
    );

    r = spawnCli(["profile", "current", "--home", home]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("profile current: name=demo");
    expect(r.stdout).toContain("transport=local lifecycle=compose");
    expect(r.stdout).toContain("baseUrl=http://127.0.0.1:3201");

    r = spawnCli(["profile", "remove", "demo", "--home", home]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("durable deletion authority");
    r = spawnCli(["profile", "remove", "demo", "--yes", "--home", home]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("profile remove: removed 'demo'");
  },
    30_000,
  );

  test(
    "legacy target=local TOML migrates on use and current",
    () => {
      const home = join(tmpdir(), `nprof-legacy-${Date.now()}`);
      const profilesDir = join(home, ".nautilo", "profiles");
      mkdirSync(profilesDir, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(profilesDir, "demo2.toml"),
        'name = "demo2"\ntarget = "local"\nport = 3202\n',
        { mode: 0o644 },
      );

      let r = spawnCli(["profile", "use", "demo2", "--home", home]);
      expect(r.status).toBe(0);

      writeFileSync(join(profilesDir, ".active"), "demo2\n", { mode: 0o600 });
      writeFileSync(
        join(home, ".nautilo", "instance.json"),
        JSON.stringify({ server: { port: 3202 } }),
        { mode: 0o600 },
      );
      r = spawnCli(["profile", "current", "--home", home]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("transport=local lifecycle=compose");
      expect(r.stdout).toContain("baseUrl=http://127.0.0.1:3202");
    },
    30_000,
  );

  test("profile add demo3 --transport local --yes defaults lifecycle=compose", () => {
    const home = join(tmpdir(), `nprof-demo3-${Date.now()}`);
    const r = spawnCli(["profile", "add", "demo3", "--transport", "local", "--yes", "--home", home]);
    expect(r.status).toBe(0);
    const toml = readFileSync(join(home, ".nautilo", "profiles", "demo3.toml"), "utf8");
    expect(toml).toContain('transport = "local"');
    expect(toml).toContain('lifecycle = "compose"');
    expect(toml).toContain('retention = "durable"');
  });

  test("profile add and remove preserve explicit disposable retention", () => {
    const home = join(tmpdir(), `nprof-disposable-${Date.now()}`);
    let r = spawnCli(["profile", "add", "scratch", "--transport", "local", "--retention", "disposable", "--yes", "--home", home]);
    expect(r.status).toBe(0);
    expect(readFileSync(join(home, ".nautilo", "profiles", "scratch.toml"), "utf8")).toContain('retention = "disposable"');
    r = spawnCli(["profile", "remove", "scratch", "--home", home]);
    expect(r.status).toBe(0);
  });

  test("profile add no longer exposes or accepts runtime image authority", () => {
    const help = spawnCli(["profile", "add", "--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).not.toMatch(/\n\s+--image\s/);

    const home = join(tmpdir(), `nprof-image-rejected-${Date.now()}`);
    const result = spawnCli([
      "profile",
      "add",
      "demo-image",
      "--transport",
      "local",
      "--yes",
      "--image",
      `ghcr.io/agentsea/nautilo-runtime-v2@sha256:${"7".repeat(64)}`,
      "--home",
      home,
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--image is no longer supported");
    expect(result.stderr).toContain("deploy --image <digest>");
  });

  test("profile add remote without domain exits 2", () => {
    const home = join(tmpdir(), `nprof-remote-bad-${Date.now()}`);
    const r = spawnCli(["profile", "add", "x", "--transport", "remote", "--yes", "--home", home]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Invalid profile:/);
    expect(r.stderr).toMatch(/domain/i);
  });

  test("profile add remote with domain forces lifecycle=external", () => {
    const home = join(tmpdir(), `nprof-remote-ok-${Date.now()}`);
    const r = spawnCli([
      "profile",
      "add",
      "y",
      "--transport",
      "remote",
      "--domain",
      "x.example",
      "--yes",
      "--home",
      home,
    ]);
    expect(r.status).toBe(0);
    const toml = readFileSync(join(home, ".nautilo", "profiles", "y.toml"), "utf8");
    expect(toml).toContain('lifecycle = "external"');
  });

  test("profile add z without flags on non-TTY stdin exits 2", () => {
    const home = join(tmpdir(), `nprof-nontty-${Date.now()}`);
    const r = spawnCli(["profile", "add", "z", "--home", home]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Refusing to run interactive wizard on non-TTY stdin.");
  });

  test("profile add --yes sets active profile by default", () => {
    const home = join(tmpdir(), `nprof-active-default-${Date.now()}`);
    const r = spawnCli([
      "profile",
      "add",
      "active-demo",
      "--transport",
      "local",
      "--lifecycle",
      "compose",
      "--yes",
      "--home",
      home,
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("profile add: created 'active-demo' and set as active.");
    const active = readFileSync(join(home, ".nautilo", "profiles", ".active"), "utf8").trim();
    expect(active).toBe("active-demo");
  });

  test("profile add --use=false does not set active profile", () => {
    const home = join(tmpdir(), `nprof-no-active-${Date.now()}`);
    const r = spawnCli([
      "profile",
      "add",
      "no-active",
      "--transport",
      "local",
      "--lifecycle",
      "compose",
      "--yes",
      "--no-use",
      "--home",
      home,
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("set as active");
    expect(existsSync(join(home, ".nautilo", "profiles", ".active"))).toBe(false);
  });
});

describe("nautilo profile add remote compose (M115 phase 7)", () => {
  beforeAll(() => {
    if (!existsSync(cliDist)) {
      throw new Error(`missing ${cliDist}; run bun run build in apps/cli first`);
    }
  });

  test("remote+compose happy path (--yes)", () => {
    const home = join(tmpdir(), `nprof-remote-compose-${Date.now()}`);
    const r = spawnCli([
      "profile",
      "add",
      "do-droplet-1",
      "--transport",
      "remote",
      "--lifecycle",
      "compose",
      "--ssh-host",
      "1.2.3.4",
      "--ssh-user",
      "root",
      "--ssh-known-hosts-file",
      "~/.nautilo/known_hosts/do-droplet-1",
      "--remote-path",
      "/opt/nautilo",
      "--instance-id",
      "prod",
      "--yes",
      "--home",
      home,
    ]);
    expect(r.status).toBe(0);
    const p = loadProfile("do-droplet-1", home);
    expect(p.transport).toBe("remote");
    expect(p.lifecycle).toBe("compose");
    if (p.transport === "remote" && p.lifecycle === "compose") {
      expect(p.ssh?.host).toBe("1.2.3.4");
      expect(p.ssh?.user).toBe("root");
      expect(p.ssh?.known_hosts_file).toBe("~/.nautilo/known_hosts/do-droplet-1");
      expect(p.remote_path).toBe("/opt/nautilo");
      expect(p.instance_id).toBe("prod");
      expect("image_ref" in p).toBe(false);
      expect(p.domain).toBeUndefined();
    }
    expect(r.stderr).toContain("remote-droplet-setup.md");
    expect(r.stderr).toContain(
      "Remote Compose day-two commands use SSH; no local bootstrap token is required.",
    );
    expect(r.stderr).not.toContain("write the bootstrap token");
  });

  test("profile current describes remote compose without a bootstrap token", () => {
    const home = join(tmpdir(), `nprof-remote-current-${Date.now()}`);
    let r = spawnCli([
      "profile",
      "add",
      "alpha",
      "--transport",
      "remote",
      "--lifecycle",
      "compose",
      "--ssh-host",
      "192.0.2.10",
      "--ssh-user",
      "root",
      "--instance-id",
      "alpha",
      "--domain",
      "alpha.example.test",
      "--https",
      "letsencrypt",
      "--acme-email",
      "deployment-operator@example.test",
      "--yes",
      "--home",
      home,
    ]);
    expect(r.status).toBe(0);
    expect(existsSync(join(home, ".nautilo", "bootstrap-tokens", "alpha"))).toBe(false);

    r = spawnCli(["profile", "current", "--home", home]);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("profile current: name=alpha");
    expect(r.stdout).toContain("transport=remote lifecycle=compose");
    expect(r.stdout).toContain("instance_id=alpha");
    expect(r.stdout).toContain("baseUrl=https://alpha.example.test");
    expect(r.stdout).toContain(
      "bootstrapToken=absent (not required for day-two SSH lifecycle commands)",
    );
    expect(r.stdout).not.toContain("bearer=");
  });

  test("remote+compose missing --ssh-host exits 2", () => {
    const home = join(tmpdir(), `nprof-remote-no-host-${Date.now()}`);
    const r = spawnCli([
      "profile",
      "add",
      "bad",
      "--transport",
      "remote",
      "--lifecycle",
      "compose",
      "--ssh-user",
      "root",
      "--yes",
      "--home",
      home,
    ]);
    expect(r.status).toBe(2);
    expect(r.stderr.toLowerCase()).toMatch(/ssh/);
    expect(r.stderr.toLowerCase()).toMatch(/required/);
  });

  test("remote+compose with --domain succeeds with warning (M117)", () => {
    const home = join(tmpdir(), `nprof-remote-domain-${Date.now()}`);
    const r = spawnCli([
      "profile",
      "add",
      "bad",
      "--transport",
      "remote",
      "--lifecycle",
      "compose",
      "--ssh-host",
      "1.2.3.4",
      "--ssh-user",
      "root",
      "--domain",
      "x.example",
      "--yes",
      "--home",
      home,
    ]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain(
      "[profile add] warning: --domain set but --https=off; the domain will not be served encrypted.",
    );
  });

  test("remote+external with --ssh-host exits 2", () => {
    const home = join(tmpdir(), `nprof-remote-ext-ssh-${Date.now()}`);
    const r = spawnCli([
      "profile",
      "add",
      "bad",
      "--transport",
      "remote",
      "--lifecycle",
      "external",
      "--domain",
      "x.example",
      "--ssh-host",
      "1.2.3.4",
      "--yes",
      "--home",
      home,
    ]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(
      "--ssh-* / --remote-path / --base-url are only meaningful when lifecycle=compose.",
    );
  });

  test("remote+external legacy happy path with --domain", () => {
    const home = join(tmpdir(), `nprof-remote-ext-ok-${Date.now()}`);
    const r = spawnCli([
      "profile",
      "add",
      "legacy",
      "--transport",
      "remote",
      "--domain",
      "x.example",
      "--yes",
      "--home",
      home,
    ]);
    expect(r.status).toBe(0);
    const p = loadProfile("legacy", home);
    expect(p.transport).toBe("remote");
    expect(p.lifecycle).toBe("external");
    if (p.transport === "remote" && p.lifecycle === "external") {
      expect(p.domain).toBe("x.example");
    }
  });

  test("local+compose with --ssh-host exits 2", () => {
    const home = join(tmpdir(), `nprof-local-ssh-${Date.now()}`);
    const r = spawnCli([
      "profile",
      "add",
      "bad",
      "--transport",
      "local",
      "--lifecycle",
      "compose",
      "--ssh-host",
      "1.2.3.4",
      "--yes",
      "--home",
      home,
    ]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(
      "--ssh-host / --ssh-user / --ssh-identity-file / --ssh-known-hosts-file / --ssh-port / --remote-path / --base-url require --transport=remote.",
    );
  });

  test("remote+compose --lifecycle=compose does not emit legacy external-only message", () => {
    const home = join(tmpdir(), `nprof-remote-no-legacy-msg-${Date.now()}`);
    const r = spawnCli([
      "profile",
      "add",
      "ok",
      "--transport",
      "remote",
      "--lifecycle",
      "compose",
      "--ssh-host",
      "1.2.3.4",
      "--ssh-user",
      "root",
      "--yes",
      "--home",
      home,
    ]);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("Remote profiles are always external lifecycle.");
  });
});
