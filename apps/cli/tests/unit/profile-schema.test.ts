import { describe, test, expect, spyOn } from "bun:test";
import { loadProfileFromObject } from "../../src/lib/profile-schema.ts";

describe("profile-schema (M113)", () => {
  test("legacy local Compose profiles migrate to durable retention", () => {
    const profile = loadProfileFromObject({ name: "legacy", transport: "local", lifecycle: "compose", instance_id: "legacy" }, "legacy");
    expect(profile.transport === "local" ? profile.retention : undefined).toBe("durable");
  });

  test("explicit disposable retention round-trips only for local Compose", () => {
    const profile = loadProfileFromObject({ name: "scratch", transport: "local", lifecycle: "compose", instance_id: "scratch", retention: "disposable" }, "scratch");
    expect(profile.transport === "local" ? profile.retention : undefined).toBe("disposable");
    expect(() => loadProfileFromObject({ name: "external", transport: "local", lifecycle: "external", retention: "durable" }, "external")).toThrow(/retention is only meaningful/);
  });
  test("legacy from_source is dropped on load while local compose identity round-trips", () => {
    const p = loadProfileFromObject(
      {
        name: "x",
        transport: "local",
        lifecycle: "compose",
        instance_id: "beta",
        from_source: true,
      },
      "x",
    );
    expect(p.transport).toBe("local");
    expect(p.lifecycle).toBe("compose");
    if (p.transport === "local") {
      expect(p.instance_id).toBe("beta");
      // D420: artifact strategy is invocation-scoped, never persisted.
      expect("from_source" in p).toBe(false);
    }
  });

  test("transport=local accepts password_recovery driver", () => {
    const p = loadProfileFromObject(
      {
        name: "x",
        transport: "local",
        lifecycle: "compose",
        password_recovery: "logto_native",
      },
      "x",
    );
    expect(p.transport).toBe("local");
    if (p.transport === "local") {
      expect(p.password_recovery).toBe("logto_native");
    }
  });

  test("invalid password_recovery rejects", () => {
    expect(() =>
      loadProfileFromObject(
        {
          name: "x",
          transport: "local",
          lifecycle: "compose",
          password_recovery: "wat",
        },
        "x",
      ),
    ).toThrow(/password_recovery/);
  });

  test("transport=local lifecycle=external drops legacy from_source (no longer a schema field)", () => {
    // D420 removed from_source from the profile schema; the migration strips
    // it so existing external profiles keep loading without a strategy error.
    const p = loadProfileFromObject(
      { name: "x", transport: "local", lifecycle: "external", from_source: true, host: "127.0.0.1", port: 3001 },
      "x",
    );
    expect(p.transport).toBe("local");
    expect(p.lifecycle).toBe("external");
    expect("from_source" in p).toBe(false);
  });

  test("transport=local lifecycle=external instance_id=beta rejects", () => {
    expect(() =>
      loadProfileFromObject(
        { name: "x", transport: "local", lifecycle: "external", instance_id: "beta" },
        "x",
      ),
    ).toThrow(/instance_id is only meaningful when lifecycle=compose/);
  });

  test("modern local Compose profiles normalize obsolete endpoint authority with a warning", () => {
    for (const endpoint of [{ host: "127.0.0.1" }, { port: 4310 }]) {
      const writes: string[] = [];
      const stderr = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });
      try {
        const profile = loadProfileFromObject(
          { name: "x", transport: "local", lifecycle: "compose", ...endpoint },
          "x",
        );
        expect("host" in profile).toBeFalse();
        expect("port" in profile).toBeFalse();
      } finally {
        stderr.mockRestore();
      }
      expect(writes.join("")).toContain("contained obsolete host/port");
      expect(writes.join("")).toContain("canonical collision-safe bundle");
    }
  });

  test("legacy target=local endpoint fields stay parseable but lose obsolete authority", () => {
    const profile = loadProfileFromObject(
      { name: "legacy", target: "local", host: "127.0.0.1", port: 4310 },
      "legacy",
    );
    expect(profile).toMatchObject({ transport: "local", lifecycle: "compose" });
    expect("host" in profile).toBeFalse();
    expect("port" in profile).toBeFalse();
  });

  test("transport=local with domain rejects (strict)", () => {
    expect(() =>
      loadProfileFromObject(
        { name: "x", transport: "local", lifecycle: "compose", domain: "x.example" },
        "x",
      ),
    ).toThrow();
  });

  test("transport=remote lifecycle=compose with ssh parses", () => {
    const p = loadProfileFromObject(
      {
        name: "x",
        transport: "remote",
        lifecycle: "compose",
        ssh: { host: "203.0.113.7", user: "root" },
        instance_id: "prod",
        from_source: true,
        image_ref: "ghcr.io/agentsea/nautilo-runtime-v2@sha256:74c76a08d65399d83f752cae76caa2bb4b0a4218e57f74ece87ac8a5a1c06ec1",
      },
      "x",
    );
    expect(p.transport).toBe("remote");
    expect(p.lifecycle).toBe("compose");
    if (p.transport === "remote") {
      expect(p.ssh?.host).toBe("203.0.113.7");
      expect(p.instance_id).toBe("prod");
      // D420: artifact strategy is invocation-scoped, never persisted.
      expect("from_source" in p).toBe(false);
      expect("image_ref" in p).toBe(false);
    }
  });

  test("remote compose ssh accepts an optional dedicated known_hosts file", () => {
    const p = loadProfileFromObject(
      {
        name: "x",
        transport: "remote",
        lifecycle: "compose",
        ssh: {
          host: "203.0.113.7",
          user: "root",
          known_hosts_file: "~/.nautilo/known_hosts/prod",
        },
      },
      "x",
    );
    expect(p.transport).toBe("remote");
    if (p.transport === "remote") {
      expect(p.ssh?.known_hosts_file).toBe("~/.nautilo/known_hosts/prod");
    }
  });

  test("remote compose ssh rejects an empty dedicated known_hosts file", () => {
    expect(() =>
      loadProfileFromObject(
        {
          name: "x",
          transport: "remote",
          lifecycle: "compose",
          ssh: { host: "203.0.113.7", user: "root", known_hosts_file: "" },
        },
        "x",
      ),
    ).toThrow(/known_hosts_file/);
  });

  test("transport=remote lifecycle=compose without ssh rejects", () => {
    expect(() =>
      loadProfileFromObject(
        { name: "x", transport: "remote", lifecycle: "compose", instance_id: "prod" },
        "x",
      ),
    ).toThrow(/ssh block is required/);
  });

  test("transport=remote lifecycle=external with ssh rejects", () => {
    expect(() =>
      loadProfileFromObject(
        {
          name: "x",
          transport: "remote",
          lifecycle: "external",
          domain: "x.example",
          ssh: { host: "203.0.113.7", user: "root" },
        },
        "x",
      ),
    ).toThrow(/ssh block only meaningful/);
  });

  test("transport=remote lifecycle=compose with base_url parses", () => {
    const p = loadProfileFromObject(
      {
        name: "x",
        transport: "remote",
        lifecycle: "compose",
        ssh: { host: "203.0.113.7", user: "root" },
        base_url: "http://1.2.3.4:4001",
      },
      "x",
    );
    expect(p.transport).toBe("remote");
    if (p.transport === "remote") {
      expect(p.base_url).toBe("http://1.2.3.4:4001");
    }
  });

  test("transport=remote lifecycle=external without domain rejects", () => {
    expect(() =>
      loadProfileFromObject({ name: "x", transport: "remote", lifecycle: "external" }, "x"),
    ).toThrow(/domain is required/);
  });

  test("transport=remote lifecycle=external with domain parses (legacy)", () => {
    const p = loadProfileFromObject(
      { name: "x", transport: "remote", lifecycle: "external", domain: "x.example" },
      "x",
    );
    expect(p.transport).toBe("remote");
    expect(p.lifecycle).toBe("external");
    if (p.transport === "remote") expect(p.domain).toBe("x.example");
  });

  test("instance_id=UPPERCASE rejects", () => {
    expect(() =>
      loadProfileFromObject(
        {
          name: "x",
          transport: "local",
          lifecycle: "compose",
          instance_id: "UPPERCASE",
        },
        "x",
      ),
    ).toThrow();
  });

  test("legacy mutable tag is dropped rather than becoming deployment authority", () => {
    const p = loadProfileFromObject(
      { name: "x", transport: "local", lifecycle: "compose", tag: "main" },
      "x",
    );
    expect("tag" in p).toBe(false);
  });

  test("legacy image references are discarded instead of retaining profile authority", () => {
    for (const imageRef of [
      "ghcr.io/agentsea/nautilo-runtime-v2@sha256:74c76a08d65399d83f752cae76caa2bb4b0a4218e57f74ece87ac8a5a1c06ec1",
      "ghcr.io/agentsea/nautilo-runtime-v2:main",
      "ghcr.io/agentsea/nautilo-server@sha256:74c76a08d65399d83f752cae76caa2bb4b0a4218e57f74ece87ac8a5a1c06ec1",
    ]) {
      const profile = loadProfileFromObject(
        { name: "x", transport: "local", lifecycle: "compose", image_ref: imageRef },
        "x",
      );
      expect("image_ref" in profile).toBe(false);
    }
  });

  test("instance_id follows the canonical 32-character contract", () => {
    expect(loadProfileFromObject({ name: "x", transport: "local", lifecycle: "compose", instance_id: `a${"-".repeat(30)}z` }, "x").instance_id).toHaveLength(32);
    expect(() => loadProfileFromObject({ name: "x", transport: "local", lifecycle: "compose", instance_id: `a${"-".repeat(31)}z` }, "x")).toThrow();
  });

  test('legacy {target: "local"} migrates and parses', () => {
    const p = loadProfileFromObject({ name: "x", target: "local" }, "x");
    expect(p.transport).toBe("local");
    expect(p.lifecycle).toBe("compose");
  });

  test('legacy {target: "docker-compose", domain: "x.example"} migrates and parses', () => {
    const p = loadProfileFromObject(
      { name: "x", target: "docker-compose", domain: "x.example" },
      "x",
    );
    expect(p.transport).toBe("remote");
    expect(p.lifecycle).toBe("external");
    if (p.transport === "remote") expect(p.domain).toBe("x.example");
  });

  test('legacy {target: "gcp-cloud-run"} without domain rejects', () => {
    expect(() => loadProfileFromObject({ name: "x", target: "gcp-cloud-run" }, "x")).toThrow();
  });

  test("missing name falls back to filename without warning", () => {
    const spy = spyOn(process.stderr, "write").mockImplementation(() => true);
    const p = loadProfileFromObject({ transport: "local", lifecycle: "compose" }, "fallback");
    expect(p.name).toBe("fallback");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test("name mismatch warns and uses filename", () => {
    const spy = spyOn(process.stderr, "write").mockImplementation(() => true);
    const p = loadProfileFromObject(
      { name: "foo", transport: "local", lifecycle: "compose" },
      "bar",
    );
    expect(p.name).toBe("bar");
    expect(spy).toHaveBeenCalled();
    const written = spy.mock.calls.map((c) => String(c[0])).join("");
    expect(written).toContain("[profile] warning: name field 'foo' differs from filename 'bar'");
    spy.mockRestore();
  });

  test("legacy docker-compose drops compose_dir on migration", () => {
    const p = loadProfileFromObject(
      {
        name: "x",
        target: "docker-compose",
        domain: "x.example",
        compose_dir: "/tmp/x",
      },
      "x",
    );
    expect(p.transport).toBe("remote");
    expect(p.lifecycle).toBe("external");
    if (p.transport === "remote") {
      expect(p.domain).toBe("x.example");
      expect("compose_dir" in p).toBe(false);
    }
  });

  test("transport=remote + lifecycle=compose + https=letsencrypt + domain + acme_email parses", () => {
    const p = loadProfileFromObject(
      {
        name: "x",
        transport: "remote",
        lifecycle: "compose",
        ssh: { host: "203.0.113.7", user: "root" },
        domain: "alpha.example.com",
        https: "letsencrypt",
        acme_email: "ops@example.com",
      },
      "x",
    );
    expect(p.transport).toBe("remote");
    if (p.transport === "remote") {
      expect(p.https).toBe("letsencrypt");
      expect(p.domain).toBe("alpha.example.com");
      expect(p.acme_email).toBe("ops@example.com");
    }
  });

  test("transport=remote + https=letsencrypt without domain rejects", () => {
    expect(() =>
      loadProfileFromObject(
        {
          name: "x",
          transport: "remote",
          lifecycle: "compose",
          ssh: { host: "203.0.113.7", user: "root" },
          https: "letsencrypt",
        },
        "x",
      ),
    ).toThrow(/https=letsencrypt requires a domain/);
  });

  test("transport=local + https=letsencrypt rejects", () => {
    expect(() =>
      loadProfileFromObject(
        {
          name: "x",
          transport: "local",
          lifecycle: "compose",
          https: "letsencrypt",
        },
        "x",
      ),
    ).toThrow();
  });

  test("https=off is the default (parses without https field)", () => {
    const result = loadProfileFromObject(
      { name: "x", transport: "local", lifecycle: "compose" },
      "x",
    );
    if (result.transport === "local") {
      expect(result.https === undefined || result.https === "off").toBe(true);
    }
  });
});
