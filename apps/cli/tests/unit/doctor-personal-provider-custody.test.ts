import { describe, expect, test } from "bun:test";
import type { CliSessionV1Payload } from "@nautilo/api-client";
import {
  formatPersonalProviderCustodyDoctorResult,
  inspectPersonalProviderCustody,
  resolvePersonalProviderCustodyBearer,
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
