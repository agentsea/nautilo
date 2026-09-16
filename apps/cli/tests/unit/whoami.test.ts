import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCliSession } from "@nautilo/api-client";
import { whoamiModule } from "../../src/commands/whoami.ts";
import { setActiveProfileResolver } from "../../src/lib/cli-session.ts";

describe("nautilo whoami", () => {
  let dir: string;
  let savedHome: string | undefined;
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    process.exitCode = undefined;
    globalThis.fetch = originalFetch;
    dir = mkdtempSync(join(tmpdir(), "nautilo-whoami-"));
    process.env["NAUTILO_HOME_OVERRIDE"] = dir;
    savedHome = process.env["HOME"];
    process.env["HOME"] = dir;
    setActiveProfileResolver(null);
    mock.restore();
  });
  afterEach(() => {
    process.exitCode = undefined;
    globalThis.fetch = originalFetch;
    setActiveProfileResolver(null);
    delete process.env["NAUTILO_HOME_OVERRIDE"];
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    rmSync(dir, { recursive: true, force: true });
    mock.restore();
  });

  test("exit 2 without session", async () => {
    await (whoamiModule.handler as (args: unknown) => Promise<void>)({
      format: "human",
      server: undefined,
    });
    expect(process.exitCode).toBe(2);
  });

  test("--format json omits secrets", async () => {
    await saveCliSession({
      schemaVersion: 1 as const,
      instanceId: "inst",
      serverUrl: "http://127.0.0.1:7777",
      handle: "alice",
      displayName: "Alice",
      externalId: "sub-x",
      accessToken: "SECRET_ACCESS",
      refreshToken: "SECRET_REFRESH",
      tokenType: "Bearer" as const,
      expiresAt: Date.now() + 3600_000,
      scopes: [],
      source: "password",
      obtainedAt: Date.now(),
    });

    const fetchMock = mock(async () =>
      new Response(
        JSON.stringify({
          sessionUserId: "u1",
          sessionActorId: "a1",
          userIdentity: "@alice@local",
          handle: "alice",
          displayName: "Alice",
          externalId: "sub-x",
          instanceId: "inst",
          mustChangePassword: false,
          groups: [{ id: "g1", type: "owners", label: "Owners", roleSlug: "owner" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    let out = "";
    const w = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string | Uint8Array) => {
      out += typeof s === "string" ? s : Buffer.from(s).toString();
      return true;
    };
    try {
      await (whoamiModule.handler as (args: unknown) => Promise<void>)({
        format: "json",
        server: "http://127.0.0.1:7777",
      });
    } finally {
      process.stdout.write = w;
    }
    expect(process.exitCode).toBe(0);
    const j = JSON.parse(out) as Record<string, unknown>;
    expect(j["schema"]).toBe("nautilo.server-admin.v1");
    expect(j["ok"]).toBe(true);
    const data = j["data"] as Record<string, unknown>;
    expect(data["handle"]).toBe("alice");
    expect(data["mustChangePassword"]).toBe(false);
    expect(out).not.toContain("SECRET_ACCESS");
    expect(out).not.toContain("SECRET_REFRESH");
  });

  test("--profile uses named session file", async () => {
    const profiles = join(dir, ".nautilo", "profiles");
    mkdirSync(profiles, { recursive: true, mode: 0o700 });
    writeFileSync(join(profiles, ".active"), "gamma\n", { mode: 0o600 });
    writeFileSync(
      join(profiles, "gamma.toml"),
      'name = "gamma"\ntransport = "local"\nlifecycle = "external"\n',
      { mode: 0o600 },
    );
    await saveCliSession(
      {
        schemaVersion: 1,
        instanceId: "inst",
        serverUrl: "http://127.0.0.1:7777",
        handle: "gamma",
        displayName: "Gamma",
        actorRole: "member",
        externalId: "sub-g",
        accessToken: "tok-g",
        tokenType: "Bearer",
        expiresAt: Date.now() + 3600_000,
        scopes: [],
        source: "device",
        obtainedAt: Date.now(),
      },
      { profile: "gamma" },
    );

    const fetchMock = mock(async () =>
      new Response(
        JSON.stringify({
          sessionUserId: "u1",
          sessionActorId: "a1",
          userIdentity: "@gamma@local",
          handle: "gamma",
          displayName: "Gamma",
          externalId: "sub-g",
          instanceId: "inst",
          mustChangePassword: false,
          groups: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    let out = "";
    const w = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string | Uint8Array) => {
      out += typeof s === "string" ? s : Buffer.from(s).toString();
      return true;
    };
    try {
      await (whoamiModule.handler as (args: unknown) => Promise<void>)({
        format: "human",
        server: "http://127.0.0.1:7777",
      });
    } finally {
      process.stdout.write = w;
    }
    expect(process.exitCode).toBe(0);
    expect(out).toContain("gamma");
    expect(out).toContain("highestRole:");
  });

  test("--all lists sessions from tmp NAUTILO_HOME_OVERRIDE", async () => {
    const sessionPayload = {
      schemaVersion: 1 as const,
      instanceId: "inst",
      serverUrl: "http://127.0.0.1:7777",
      handle: "bob",
      displayName: "Bob",
      actorRole: "member" as const,
      externalId: "sub-b",
      accessToken: "t",
      tokenType: "Bearer" as const,
      expiresAt: Date.now() + 3600_000,
      scopes: [],
      source: "device" as const,
      obtainedAt: Date.now(),
    };
    await saveCliSession(sessionPayload, { profile: "zulu" });
    await saveCliSession({ ...sessionPayload, handle: "anna" }, { profile: "alpha" });
    let out = "";
    const w = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string | Uint8Array) => {
      out += typeof s === "string" ? s : Buffer.from(s).toString();
      return true;
    };
    try {
      await (whoamiModule.handler as (args: unknown) => Promise<void>)({
        format: "human",
        all: true,
        server: undefined,
      });
    } finally {
      process.stdout.write = w;
    }
    expect(process.exitCode).toBe(0);
    expect(out.indexOf("alpha")).toBeLessThan(out.indexOf("zulu"));
    expect(out).toContain("anna");
    expect(out).toContain("(role: member)");
  });

  test("--all is local-only and JSON never serializes cached bearer material", async () => {
    await saveCliSession({
      schemaVersion: 1,
      instanceId: "inst",
      serverUrl: "http://127.0.0.1:7777",
      handle: "local",
      displayName: "Local",
      externalId: "sub-local",
      accessToken: "LOCAL_ACCESS_SECRET",
      refreshToken: "LOCAL_REFRESH_SECRET",
      tokenType: "Bearer",
      expiresAt: Date.now() + 3600_000,
      scopes: [],
      source: "device",
      obtainedAt: Date.now(),
    }, { profile: "local" });
    globalThis.fetch = mock(async () => {
      throw new Error("whoami --all made a network request");
    }) as unknown as typeof fetch;
    let out = "";
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (value: string | Uint8Array) => {
      out += typeof value === "string" ? value : Buffer.from(value).toString();
      return true;
    };
    try {
      await (whoamiModule.handler as (args: unknown) => Promise<void>)({ format: "json", all: true });
    } finally {
      process.stdout.write = write;
    }
    expect(process.exitCode).toBe(0);
    expect(out).toContain("nautilo.server-admin.v1");
    expect(out).toContain("local");
    expect(out).not.toContain("LOCAL_ACCESS_SECRET");
    expect(out).not.toContain("LOCAL_REFRESH_SECRET");
  });

  test("--all falls back to the owned legacy session when sessions/ is absent", async () => {
    await saveCliSession({
      schemaVersion: 1, instanceId: "legacy", serverUrl: "http://127.0.0.1:7777",
      handle: "legacy-user", displayName: "Legacy", externalId: "legacy-sub", accessToken: "LEGACY_SECRET",
      tokenType: "Bearer", expiresAt: Date.now() + 3600_000, scopes: [], source: "device", obtainedAt: Date.now(),
    });
    let out = "";
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (value: string | Uint8Array) => {
      out += typeof value === "string" ? value : Buffer.from(value).toString();
      return true;
    };
    try {
      await (whoamiModule.handler as (args: unknown) => Promise<void>)({ format: "json", all: true });
    } finally {
      process.stdout.write = write;
    }
    expect(process.exitCode).toBe(0);
    expect(out).toContain("(default)");
    expect(out).toContain("legacy-user");
    expect(out).not.toContain("LEGACY_SECRET");
  });

  test("verified identity fields remain fresh nulls rather than cached values", async () => {
    await saveCliSession({
      schemaVersion: 1, instanceId: "inst", serverUrl: "http://127.0.0.1:7777",
      handle: "cached-handle", displayName: "Cached", externalId: "cached-sub", accessToken: "ACCESS_SECRET",
      tokenType: "Bearer", expiresAt: Date.now() + 3600_000, scopes: [], source: "device", obtainedAt: Date.now(),
    });
    globalThis.fetch = mock(async () => new Response(JSON.stringify({
      sessionUserId: "u", sessionActorId: "a", userIdentity: "@u@local",
      handle: null, displayName: null, externalId: null, instanceId: "inst",
      mustChangePassword: false, groups: [], capabilities: [], highestRole: null,
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
    let out = "";
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (value: string | Uint8Array) => {
      out += typeof value === "string" ? value : Buffer.from(value).toString();
      return true;
    };
    try {
      await (whoamiModule.handler as (args: unknown) => Promise<void>)({ format: "json", server: "http://127.0.0.1:7777" });
    } finally {
      process.stdout.write = write;
    }
    const data = (JSON.parse(out) as { data: Record<string, unknown> }).data;
    expect(data["handle"]).toBeNull();
    expect(data["displayName"]).toBeNull();
    expect(data["externalId"]).toBeNull();
    expect(out).not.toContain("cached-handle");
  });

  test("identity failures use fixed redacted JSON errors", async () => {
    await saveCliSession({
      schemaVersion: 1, instanceId: "inst", serverUrl: "http://127.0.0.1:7777",
      handle: "alice", displayName: "Alice", externalId: "sub", accessToken: "ACCESS_SECRET",
      tokenType: "Bearer", expiresAt: Date.now() + 3600_000, scopes: [], source: "device", obtainedAt: Date.now(),
    });
    globalThis.fetch = mock(async () => new Response(
      "token=ACCESS_SECRET url=https://u:p@example.test header=Bearer nope\nError: stack",
      { status: 500 },
    )) as unknown as typeof fetch;
    let out = "";
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (value: string | Uint8Array) => {
      out += typeof value === "string" ? value : Buffer.from(value).toString();
      return true;
    };
    try {
      await (whoamiModule.handler as (args: unknown) => Promise<void>)({ format: "json", server: "http://127.0.0.1:7777" });
    } finally {
      process.stdout.write = write;
    }
    expect(process.exitCode).toBe(2);
    expect(out).toContain('"code":"transport_unreachable"');
    expect(out).not.toContain("ACCESS_SECRET");
    expect(out).not.toContain("example.test");
  });
});
