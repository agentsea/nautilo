import { describe, expect, mock, test } from "bun:test";
import type { FastifyRequest } from "fastify";

import {
  PRE_ADMISSION_ROUTE_INVENTORY,
  preAdmissionRouteKind,
  resolveCurrentDeviceAdmission,
} from "../../src/auth/device-admission-gate";
import type { DeviceAdmissionComposition } from
  "../../src/routes/device-admission";

function request(): FastifyRequest {
  return {
    sessionUserId: "user-1",
    sessionActorId: "human-1",
    accessTokenExpiresAt: 20_000,
    headers: { authorization: "Bearer credential" },
    log: { warn: mock(() => {}) },
  } as unknown as FastifyRequest;
}

function composition(
  status: Awaited<ReturnType<DeviceAdmissionComposition["status"]>>,
): DeviceAdmissionComposition {
  return {
    issueChallenge: mock(async () => null),
    admit: mock(async () => "invalid" as const),
    status: mock(async () => status),
    currentAuthorityForDelegation: mock(async () => null),
  };
}

describe("M303 central device-admission gate", () => {
  test("returns exact current device coordinates for an admitted credential", async () => {
    const admitted = await resolveCurrentDeviceAdmission({
      request: request(),
      composition: composition({
        status: "admitted",
        deviceId: "browser-1",
        deviceGeneration: 2,
        serverInstanceId: "server-1",
        lineageGeneration: 3,
        epoch: 4,
        securityRevision: 5,
        headDigest: new Uint8Array(32).fill(7),
        expiresAt: 19_000,
      }),
      now: 10_000,
    });
    expect(admitted).toMatchObject({
      deviceId: "browser-1",
      deviceGeneration: 2,
      lineageGeneration: 3,
      epoch: 4,
      securityRevision: 5,
      expiresAt: 19_000,
    });
    expect(admitted.headDigest).toEqual(new Uint8Array(32).fill(7));
  });

  test("fails closed with the repository's stable stale-device reason", async () => {
    expect(resolveCurrentDeviceAdmission({
      request: request(),
      composition: composition({
        status: "required",
        reason: "device_removed_or_stale",
      }),
      now: 10_000,
    })).rejects.toMatchObject({
      statusCode: 428,
      code: "device_removed_or_stale",
    });
  });

  test("keeps the pre-admission allowlist exact and template-based", () => {
    expect(PRE_ADMISSION_ROUTE_INVENTORY.length).toBeGreaterThan(20);
    expect(preAdmissionRouteKind("GET", "/api/setup/status")).toBe("identity");
    expect(preAdmissionRouteKind("GET", "/api/auth/whoami")).toBe("identity");
    expect(preAdmissionRouteKind(
      "POST",
      "/api/protected/devices/additional/:operationId/approve",
    )).toBe("device_setup");
    expect(preAdmissionRouteKind("GET", "/api/rooms")).toBeNull();
    expect(preAdmissionRouteKind("GET", "/api/encryption/coverage/me")).toBeNull();
    expect(preAdmissionRouteKind("GET", "/api/admin/users")).toBeNull();
    expect(preAdmissionRouteKind("POST", "/api/office/wopi-token")).toBeNull();
  });
});
