import { describe, expect, test } from "bun:test";
import type { CliSessionV1Payload } from "@nautilo/api-client";
import {
  formatPersonalProviderCustodyDoctorResult,
  inspectPersonalProviderCustody,
  resolvePersonalProviderCustodyBearer,
  resolvePersonalProviderCustodyDoctorTarget,
} from "../../src/lib/doctor-personal-provider-custody.ts";
import type { ResolvedServer } from "../../src/lib/profile-aware-server.ts";

const KEY_ID = "0b5b31f9-108c-4b47-8c17-52750ecfa4c9";
const remote: ResolvedServer = { baseUrl: "https://nautilo.example", source: "profile" };

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function session(overrides: Partial<CliSessionV1Payload> = {}): CliSessionV1Payload {
  return {
    schemaVersion: 1,
    accessToken: "session-secret",
    expiresAt: Date.now() + 60_000,
    obtainedAt: Date.now(),
    instanceId: "instance-1",
    handle: "owner",
    displayName: "Owner",
    externalId: "owner-external-id",
    serverUrl: remote.baseUrl,
    tokenType: "Bearer",
    scopes: [],
    source: "password",
    targetBinding: { kind: "http-origin", value: remote.baseUrl },
    ...overrides,
  };
}

describe("personal provider custody doctor", () => {
  test("an active local Compose profile uses one exact container-loopback probe without a bearer", async () => {
    let resolveCalls = 0;
    let loadSessionCalls = 0;
    let probeUrl = "";
    let probeInit: RequestInit | undefined;
    const target = await resolvePersonalProviderCustodyDoctorTarget(undefined, {
      home: "/test-home",
      resolveServer: async (options) => {
        resolveCalls += 1;
        expect(options).toEqual({ serverFlag: undefined, home: "/test-home" });
        return { baseUrl: "http://127.0.0.1:7401", source: "profile" };
      },
      readActiveProfile: () => "qa-local",
      loadProfile: () => ({
        name: "qa-local",
        transport: "local",
        lifecycle: "compose",
        instance_id: "qa-local",
      }),
      resolveEndpoint: async () => ({ baseUrl: "http://127.0.0.1:7401" }),
      buildOperatorTransport: () => ({
        fetchFn: async (input, init) => {
          probeUrl = typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
          probeInit = init;
          return response({ status: "ready", recordsExist: true, keyId: KEY_ID });
        },
      }),
    });

    const bearer = await resolvePersonalProviderCustodyBearer(target.transport, {
      loadSession: async () => {
        loadSessionCalls += 1;
        return session();
      },
    });
    if (target.fetch === undefined) {
      throw new Error("local Compose target omitted its custody transport");
    }
    const result = await inspectPersonalProviderCustody(target.transport, bearer, {
      fetch: target.fetch,
    });

    expect(resolveCalls).toBe(1);
    expect(loadSessionCalls).toBe(0);
    expect(result).toEqual({ status: "ready", recordsExist: true, keyId: KEY_ID });
    expect(probeUrl).toBe("http://127.0.0.1:3001/api/health/personal-provider-custody");
    expect(probeInit?.method).toBe("GET");
    expect(new Headers(probeInit?.headers).has("authorization")).toBe(false);
  });

  test.each([
    ["explicit server", "flag" as const, "https://explicit.example", "https://explicit.example"],
    ["environment server", "env" as const, "https://env.example", undefined],
  ])("%s keeps the canonical public transport instead of borrowing local profile authority", async (
    _case,
    source,
    baseUrl,
    serverFlag,
  ) => {
    let profileReads = 0;
    let capturedServerFlag: string | undefined;
    const target = await resolvePersonalProviderCustodyDoctorTarget(serverFlag, {
      home: "/test-home",
      resolveServer: async (options) => {
        capturedServerFlag = options.serverFlag;
        return { baseUrl, source };
      },
      readActiveProfile: () => {
        profileReads += 1;
        return "qa-local";
      },
    });

    expect(capturedServerFlag).toBe(serverFlag);
    expect(target).toEqual({ transport: { baseUrl, source } });
    expect(profileReads).toBe(1);
  });

  test.each([
    ["remote Compose", { name: "remote", transport: "remote" as const, lifecycle: "compose" as const, ssh: { host: "remote.example", user: "root" } }],
    ["local external", { name: "external", transport: "local" as const, lifecycle: "external" as const }],
  ])("an active %s profile keeps its ordinary resolved transport", async (_case, profile) => {
    const original: ResolvedServer = {
      baseUrl: profile.transport === "remote" ? "https://remote.example" : "http://127.0.0.1:8123",
      source: "profile",
    };
    const target = await resolvePersonalProviderCustodyDoctorTarget(undefined, {
      home: "/test-home",
      resolveServer: async () => original,
      readActiveProfile: () => profile.name,
      loadProfile: () => profile,
      resolveEndpoint: async () => ({
        baseUrl: original.baseUrl,
        ...(original.unixSocketPath === undefined
          ? {}
          : { unixSocketPath: original.unixSocketPath }),
      }),
      buildOperatorTransport: () => {
        throw new Error("non-local-Compose profile must not get operator transport");
      },
    });
    expect(target).toEqual({ transport: original });
  });

  test("no selected profile keeps the ordinary default transport", async () => {
    let profileReads = 0;
    const target = await resolvePersonalProviderCustodyDoctorTarget(undefined, {
      home: "/test-home",
      resolveServer: async () => ({ baseUrl: "http://127.0.0.1:3001", source: "default" }),
      readActiveProfile: () => {
        profileReads += 1;
        return undefined;
      },
    });
    expect(target).toEqual({
      transport: { baseUrl: "http://127.0.0.1:3001", source: "default" },
    });
    expect(profileReads).toBe(1);
  });

  test("a missing local Compose operator transport fails closed", async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's matcher settles the async assertion.
    await expect(resolvePersonalProviderCustodyDoctorTarget(undefined, {
      home: "/test-home",
      resolveServer: async () => ({ baseUrl: "http://127.0.0.1:7401", source: "profile" }),
      readActiveProfile: () => "qa-local",
      loadProfile: () => ({
        name: "qa-local",
        transport: "local",
        lifecycle: "compose",
        instance_id: "qa-local",
      }),
      resolveEndpoint: async () => ({ baseUrl: "http://127.0.0.1:7401" }),
      buildOperatorTransport: () => ({}),
    })).rejects.toThrow(/transport is unavailable/);
  });

  test("refuses when the effective profile changes during canonical server resolution", async () => {
    const profileNames = ["qa-local", "other-local"];
    let operatorBuilds = 0;
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's matcher settles the async assertion.
    await expect(resolvePersonalProviderCustodyDoctorTarget(undefined, {
      home: "/test-home",
      resolveServer: async () => ({ baseUrl: "http://127.0.0.1:7401", source: "profile" }),
      readActiveProfile: () => profileNames.shift(),
      loadProfile: () => {
        throw new Error("drifted profile must not load");
      },
      buildOperatorTransport: () => {
        operatorBuilds += 1;
        return {};
      },
    })).rejects.toThrow(/Active profile changed/);
    expect(operatorBuilds).toBe(0);
  });

  test("refuses when the captured profile endpoint does not match the resolved target", async () => {
    let operatorBuilds = 0;
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's matcher settles the async assertion.
    await expect(resolvePersonalProviderCustodyDoctorTarget(undefined, {
      home: "/test-home",
      resolveServer: async () => ({ baseUrl: "http://127.0.0.1:7401", source: "profile" }),
      readActiveProfile: () => "qa-local",
      loadProfile: () => ({
        name: "qa-local",
        transport: "local",
        lifecycle: "compose",
        instance_id: "qa-local",
      }),
      resolveEndpoint: async () => ({ baseUrl: "http://127.0.0.1:8401" }),
      buildOperatorTransport: () => {
        operatorBuilds += 1;
        return {};
      },
    })).rejects.toThrow(/endpoint changed/);
    expect(operatorBuilds).toBe(0);
  });

  test("rechecks the captured profile immediately before constructing Docker transport", async () => {
    const profileNames = ["qa-local", "qa-local", "other-local"];
    let operatorBuilds = 0;
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's matcher settles the async assertion.
    await expect(resolvePersonalProviderCustodyDoctorTarget(undefined, {
      home: "/test-home",
      resolveServer: async () => ({ baseUrl: "http://127.0.0.1:7401", source: "profile" }),
      readActiveProfile: () => profileNames.shift(),
      loadProfile: () => ({
        name: "qa-local",
        transport: "local",
        lifecycle: "compose",
        instance_id: "qa-local",
      }),
      resolveEndpoint: async () => ({ baseUrl: "http://127.0.0.1:7401" }),
      buildOperatorTransport: () => {
        operatorBuilds += 1;
        return {};
      },
    })).rejects.toThrow(/Active profile changed/);
    expect(operatorBuilds).toBe(0);
  });

  test("reports ready with no records over the canonical transport options", async () => {
    let capturedPath = "";
    let capturedInit: RequestInit | undefined;
    const result = await inspectPersonalProviderCustody(remote, "session-secret", {
      fetch: async (_transport, path, init) => {
        capturedPath = path;
        capturedInit = init;
        return response({ status: "ready", recordsExist: false, keyId: KEY_ID });
      },
    });

    expect(result).toEqual({ status: "ready", recordsExist: false, keyId: KEY_ID });
    expect(capturedPath).toBe("/api/health/personal-provider-custody");
    expect(capturedInit?.redirect).toBe("manual");
    expect(new Headers(capturedInit?.headers).get("authorization")).toBe("Bearer session-secret");
    expect(formatPersonalProviderCustodyDoctorResult(result)).toContain(
      "Custody is ready; no personal provider credentials are stored.",
    );
  });

  test("keeps degraded re-enrollment distinct from ready", async () => {
    const result = await inspectPersonalProviderCustody(remote, undefined, {
      fetch: async () => response({
        status: "degraded",
        recordsExist: true,
        keyId: KEY_ID,
        code: "credential_reenrollment_required",
      }),
    });
    expect(result.status).toBe("degraded");
    expect(formatPersonalProviderCustodyDoctorResult(result).join("\n"))
      .toContain("Re-enroll the affected personal provider credentials");
  });

  test("reports a typed key mismatch without response content", async () => {
    const result = await inspectPersonalProviderCustody(remote, undefined, {
      fetch: async () => response({
        status: "unavailable",
        recordsExist: true,
        keyId: KEY_ID,
        code: "custody_key_mismatch",
      }),
    });
    expect(formatPersonalProviderCustodyDoctorResult(result)[0]).toBe(
      `doctor personal-provider-custody: status=unavailable records=present keyId=${KEY_ID} code=custody_key_mismatch`,
    );
  });

  test("denied, redirect, transport failure, and malformed bodies fail closed", async () => {
    const denied = await inspectPersonalProviderCustody(remote, undefined, {
      fetch: async () => response({ error: "secret denial detail" }, 403),
    });
    const redirected = await inspectPersonalProviderCustody(remote, undefined, {
      fetch: async () => new Response(null, {
        status: 302,
        headers: { location: "https://attacker.example/collect" },
      }),
    });
    const unavailable = await inspectPersonalProviderCustody(remote, undefined, {
      fetch: async () => { throw new Error("secret transport detail"); },
    });
    const malformed = await inspectPersonalProviderCustody(remote, undefined, {
      fetch: async () => response({
        status: "ready",
        recordsExist: false,
        keyId: "not-a-uuid",
        secret: "must-not-appear",
      }),
    });

    expect(denied).toEqual({ status: "denied" });
    expect(redirected).toEqual({ status: "redirect_rejected" });
    expect(unavailable).toEqual({ status: "unreachable" });
    expect(malformed).toEqual({ status: "invalid_response" });
    const output = [denied, redirected, unavailable, malformed]
      .flatMap(formatPersonalProviderCustodyDoctorResult)
      .join("\n");
    expect(output).not.toContain("secret");
    expect(output).not.toContain("attacker.example");
  });

  test("loads a bearer only after an exact remote target match", async () => {
    const bearer = await resolvePersonalProviderCustodyBearer(remote, {
      loadSession: async () => session(),
      resolveTargetBinding: async () => ({ kind: "http-origin", value: remote.baseUrl }),
    });
    expect(bearer).toBe("session-secret");

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's matcher settles the async assertion.
    await expect(resolvePersonalProviderCustodyBearer(remote, {
      loadSession: async () => session(),
      resolveTargetBinding: async () => ({ kind: "http-origin", value: "https://other.example" }),
    })).rejects.toThrow("different server target");
  });

  test("does not load a Human session for loopback or Unix-socket authority", async () => {
    let loads = 0;
    const loadSession = async () => {
      loads += 1;
      return session();
    };
    expect(await resolvePersonalProviderCustodyBearer({
      baseUrl: "http://127.0.0.1:3001",
      source: "default",
    }, { loadSession })).toBeUndefined();
    expect(await resolvePersonalProviderCustodyBearer({
      baseUrl: "http://[::1]:3001",
      source: "default",
    }, { loadSession })).toBeUndefined();
    expect(await resolvePersonalProviderCustodyBearer({
      baseUrl: "http://localhost",
      unixSocketPath: "/tmp/nautilo.sock",
      source: "profile",
    }, { loadSession })).toBeUndefined();
    expect(loads).toBe(0);
  });
});
