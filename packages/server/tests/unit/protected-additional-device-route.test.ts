import { describe, expect, test } from "bun:test";
import Fastify from "fastify";
import { readFileSync } from "node:fs";

import {
  createProductionAdditionalDeviceComposition,
  resolveAdditionalDevicePersonalAuthorityAnchor,
} from "../../src/routes/protected-additional-device-composition";
import {
  protectedAdditionalDeviceRoutes,
  type ProtectedAdditionalDeviceComposition,
} from "../../src/routes/protected-additional-device";

function unreachable(): never {
  throw new Error("additional-device composition must not be called");
}

function inertComposition(): ProtectedAdditionalDeviceComposition {
  return Object.freeze({
    begin: unreachable,
    pending: unreachable,
    publishJoinPackages: unreachable,
    approve: unreachable,
    transitionPlan: unreachable,
    submitTransitions: unreachable,
    deliveries: unreachable,
    acknowledge: unreachable,
    activate: unreachable,
    beginV2: unreachable,
    planPageV2: unreachable,
    pendingV2: unreachable,
    publishJoinPackagesV2: unreachable,
    transitionPlanV2: unreachable,
    submitTransitionsV2: unreachable,
  });
}

test("keeps the retired provider/inventory routes out of the production app", () => {
  const appSource = readFileSync(
    new URL("../../src/app.ts", import.meta.url),
    "utf8",
  );
  expect(appSource).not.toContain("protectedAdditionalDeviceRoutes");
  expect(appSource).not.toContain("createProductionAdditionalDeviceComposition");
  expect(appSource).toContain("humanDeviceMembershipRoutes(");
});

describe("protected additional-device routes", () => {
  test("selects one personal Room anchor without enumerating account history", async () => {
    const statements: string[] = [];
    const anchor = await resolveAdditionalDevicePersonalAuthorityAnchor({
      query: (statement: string, parameters: readonly unknown[]) => {
        statements.push(statement);
        expect(parameters).toEqual([
          "agent",
          '{"00000000-0000-4000-8000-000000000002"}',
          '{"00000000-0000-4000-8000-000000000002"}',
          1,
        ]);
        return Promise.resolve([{
          id: "00000000-0000-4000-8000-000000000003",
          namespace_id: "00000000-0000-4000-8000-000000000004",
        }]);
      },
    } as never, "00000000-0000-4000-8000-000000000002");
    expect(anchor).toEqual({
      roomId: "00000000-0000-4000-8000-000000000003",
      namespaceId: "00000000-0000-4000-8000-000000000004",
    });
    expect(statements[0]).toContain("limit $4");
    expect(statements[0]).toContain("domain_key_heads");
    expect(statements[0]).toContain('"rooms"."parent_room_id" is null');
    expect(statements[0]).toContain('"rooms"."archived_at" is null');
    expect(statements[0]).toContain('"actors"."kind" = $1');
    expect(statements[0]).not.toContain("namespace_domain_key_heads");
  });

  test("omits the personal anchor before a V2 one-Human Domain exists", async () => {
    expect(await resolveAdditionalDevicePersonalAuthorityAnchor({
      query: () => Promise.resolve([]),
    } as never, "00000000-0000-4000-8000-000000000002")).toBeNull();
  });

  test("registers the complete production lifecycle without eagerly opening crypto DB", async () => {
    const app = Fastify();
    protectedAdditionalDeviceRoutes(
      app,
      createProductionAdditionalDeviceComposition(),
    );
    const routes = app.printRoutes();
    expect(routes).toContain("additional/");
    expect(routes).toContain("begin (POST)");
    expect(routes).toContain("pending (POST)");
    expect(routes).toContain("join-packages (POST)");
    expect(routes).toContain("transition");
    expect(routes).toContain("-plan (POST)");
    expect(routes).toContain("deliveries (POST)");
    expect(routes).toContain("tivate (POST)");
    // M280 Part 3 deliberately does not make Wave 21's device recovery,
    // revocation, health, or last-device protection look production-ready.
    expect(routes).not.toContain("recover");
    expect(routes).not.toContain("revoke");
    expect(routes).not.toContain("health");
    await app.close();
  });

  test("rejects anonymous and malformed operations before composition", async () => {
    const app = Fastify();
    app.addHook("preHandler", (request, _reply, done) => {
      request.sessionUserId = request.headers.authorization === "Bearer ok"
        ? "00000000-0000-4000-8000-000000000001" : null;
      request.sessionActorId = request.sessionUserId === null
        ? null : "00000000-0000-4000-8000-000000000002";
      request.policyContext = request.sessionUserId === null ? null
        : { actorRole: "member" } as typeof request.policyContext;
      done();
    });
    protectedAdditionalDeviceRoutes(app, inertComposition());
    expect((await app.inject({
      method: "POST",
      url: "/api/protected/devices/additional/pending",
      payload: { requestVersion: 1, approverDeviceId: "crypto:browser:one" },
    })).statusCode).toBe(401);
    expect((await app.inject({
      method: "POST",
      url: "/api/protected/devices/additional/%20/activate",
      headers: { authorization: "Bearer ok" },
      payload: { requestVersion: 1, deviceId: "crypto:electron:two" },
    })).statusCode).toBe(400);
    await app.close();
  });

  test("accepts one complete V2 transition campaign without client leases", async () => {
    const app = Fastify();
    app.addHook("preHandler", (request, _reply, done) => {
      request.sessionUserId = "00000000-0000-4000-8000-000000000001";
      request.sessionActorId = "00000000-0000-4000-8000-000000000002";
      request.policyContext = { actorRole: "member" } as typeof request.policyContext;
      done();
    });
    let transitionCount = -1;
    const composition: ProtectedAdditionalDeviceComposition = Object.freeze({
      ...inertComposition(),
      submitTransitionsV2: ({ operationId, request }: Parameters<
        ProtectedAdditionalDeviceComposition["submitTransitionsV2"]
      >[0]) => {
        expect(operationId).toBe("operation-complete");
        transitionCount = request.transitions.length;
        return Promise.resolve({
          formatVersion: 1 as const,
          status: "syncing" as const,
          operationId,
          targetDeviceId: "device-target",
          completedDomains: transitionCount,
          requiredDomains: transitionCount,
        });
      },
    });
    protectedAdditionalDeviceRoutes(app, composition);
    const transitions = Array.from({ length: 13 }, (_, index) => ({
      domainId: `domain-${String(index).padStart(2, "0")}`,
      providerSubmissionBytesBase64url: "AQ",
      namespaceSubmissionBytesBase64url: "Ag",
    }));
    const response = await app.inject({
      method: "POST",
      url: "/api/protected/devices/additional/operation-complete/transitions",
      payload: {
        requestVersion: 2,
        approverDeviceId: "device-approver",
        inventoryRevision: 1,
        inventoryCount: 13,
        inventoryDigestBase64url: "A".repeat(43),
        domainCount: 13,
        transitions,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(transitionCount).toBe(13);
    expect(JSON.parse(response.body)).toMatchObject({
      completedDomains: 13,
      requiredDomains: 13,
    });
    await app.close();
  });

  test("preserves the canonical 257-Domain capacity outcome", async () => {
    const app = Fastify();
    app.addHook("preHandler", (request, _reply, done) => {
      request.sessionUserId = "00000000-0000-4000-8000-000000000001";
      request.sessionActorId = "00000000-0000-4000-8000-000000000002";
      request.policyContext = { actorRole: "member" } as typeof request.policyContext;
      done();
    });
    protectedAdditionalDeviceRoutes(app, Object.freeze({
      ...inertComposition(),
      beginV2: () => Promise.reject(
        new Error("additional_device_domain_capacity_exceeded"),
      ),
    }));
    const response = await app.inject({
      method: "POST",
      url: "/api/protected/devices/additional/begin",
      payload: {
        requestVersion: 2,
        deviceId: "device-target",
        clientKind: "electron",
        installationLineageDigestBase64url: "A".repeat(43),
        deviceGeneration: 1,
        signingPublicKeyBase64url: "A".repeat(43),
        encryptionPublicKeyBase64url: "A".repeat(87),
        idempotencyKey: "additional-device-capacity",
        pageStart: 0,
      },
    });
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toEqual({
      error: "additional_device_domain_capacity_exceeded",
    });
    await app.close();
  });
});
