import { expect, test } from "bun:test";
import { ApiError, type NautiloApiClient } from "@nautilo/api-client/browser";

import {
  createInitialDeviceBootstrapApiClientPort,
  createInitialHumanDomainApiClientPort,
  InitialDeviceEnrollmentRequiredError,
} from
  "../../src/device/initial-readiness-api-client.ts";
import { nautiloActorId, nautiloUserId } from
  "../../src/identity/product-ids.ts";

const USER_ID = nautiloUserId("00000000-0000-4000-8000-000000000001");
const ACTOR_ID = nautiloActorId("00000000-0000-4000-8000-000000000002");
if (!USER_ID.ok || !ACTOR_ID.ok) throw new Error("invalid fixture identities");

test("initial-device API adapter never disguises a TUI as browser custody", async () => {
  let calls = 0;
  const port = createInitialDeviceBootstrapApiClientPort({
    beginProtectedInitialDeviceBootstrap: () => {
      calls += 1;
      return Promise.reject(new Error("must not call"));
    },
  } as unknown as NautiloApiClient);
  let failure: unknown;
  try {
    await port.begin({
      userId: USER_ID.value,
      humanActorId: ACTOR_ID.value,
      deviceId: "device:tui",
      clientKind: "tui",
      installationLineageDigest: new Uint8Array(32),
      signingPublicKey: new Uint8Array(32),
      encryptionPublicKey: new Uint8Array(65),
      recoveryKeyId: "recovery:1",
      recoveryPublicKey: new Uint8Array(65),
      context: { kind: "preparation", authorityId: "preparation:1" },
      idempotencyKey: "bootstrap:1",
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(TypeError);
  expect((failure as Error).message).toContain(
    "TUI crypto device bootstrap is unsupported",
  );
  expect(calls).toBe(0);
});

test("initial-device API adapter distinguishes an existing Human device from a retryable bootstrap failure", async () => {
  const port = createInitialDeviceBootstrapApiClientPort({
    beginProtectedInitialDeviceBootstrap: () =>
      Promise.reject(new ApiError(409, "already_initialized")),
  } as unknown as NautiloApiClient);
  let failure: unknown;
  try {
    await port.begin({
      userId: USER_ID.value,
      humanActorId: ACTOR_ID.value,
      deviceId: "crypto:electron:installation-1",
      clientKind: "electron",
      installationLineageDigest: new Uint8Array(32),
      signingPublicKey: new Uint8Array(32),
      encryptionPublicKey: new Uint8Array(65),
      recoveryKeyId: "recovery:desktop",
      recoveryPublicKey: new Uint8Array(65),
      context: { kind: "preparation", authorityId: "preparation:desktop" },
      idempotencyKey: "bootstrap:desktop",
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(InitialDeviceEnrollmentRequiredError);
});

test("initial Human Domain adapter preserves exact server-authored plan facts", async () => {
  let received: unknown;
  const port = createInitialHumanDomainApiClientPort({
    planProtectedInitialHumanDomain: (input: unknown) => {
      received = input;
      return Promise.resolve({
        formatVersion: 1 as const,
        status: "planned" as const,
        operationId: "initial-domain:operation",
        humanId: ACTOR_ID.value,
        deviceId: "crypto:browser:installation-1",
        domainId: "initial-domain:domain",
        currentDomainHead: null,
        activeDeviceIds: ["crypto:browser:installation-1"],
        trustedDeviceRevision: 1,
        trustedHostAuthorizationRevision: 2,
        deliveryHighWatermark: 3,
      });
    },
  } as unknown as NautiloApiClient);
  expect(await port.plan("crypto:browser:installation-1")).toEqual({
    status: "planned",
    operationId: "initial-domain:operation",
    humanId: ACTOR_ID.value,
    deviceId: "crypto:browser:installation-1",
    domainId: "initial-domain:domain",
    currentDomainHead: null,
    activeDeviceIds: ["crypto:browser:installation-1"],
    trustedDeviceRevision: 1,
    trustedHostAuthorizationRevision: 2,
    deliveryHighWatermark: 3,
  });
  expect(received).toEqual({
    requestVersion: 1,
    deviceId: "crypto:browser:installation-1",
  });
});

test("initial Human Domain adapter preserves migration facts for an active legacy Domain", async () => {
  const port = createInitialHumanDomainApiClientPort({
    planProtectedInitialHumanDomain: () => Promise.resolve({
      formatVersion: 1 as const,
      status: "active" as const,
      humanId: ACTOR_ID.value,
      deviceId: "crypto:browser:installation-1",
      domainId: "legacy-domain:1",
      providerId: "legacy-provider:1",
      epoch: 4,
      stateHashBase64url: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
      trustedDeviceRevision: 3,
      trustedHostAuthorizationRevision: 3,
      deliveryHighWatermark: 19,
    }),
  } as unknown as NautiloApiClient);
  expect(await port.plan("crypto:browser:installation-1")).toMatchObject({
    status: "active",
    trustedDeviceRevision: 3,
    trustedHostAuthorizationRevision: 3,
    deliveryHighWatermark: 19,
  });
});
