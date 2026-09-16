import { describe, expect, test } from "bun:test";
import { LatticeCrypto } from "@nautilo/lattice-crypto";

import { nautiloActorId, nautiloUserId, type TranslationResult } from
  "../../src/identity/product-ids.ts";
import type { ClientProfileVault } from "../../src/client-vault/types.ts";
import {
  prepareRestartSafeInitialDeviceClientCeremony,
  resumeRestartSafeInitialDeviceClientCeremony,
  type PendingInitialDeviceBootstrap,
  type PendingInitialDeviceBootstrapVault,
} from "../../src/device/restart-safe-initial-device-client-ceremony.ts";
import { InitialDeviceBootstrapService } from
  "../../src/server/device/initial-bootstrap-service.ts";
import {
  MemoryDeviceLifecycleRepository,
  createMemoryClientProfileVault,
  createSyntheticInitialDeviceAuthorizer,
} from "../../src/testing/index.ts";

function valueOf<T>(result: TranslationResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const USER = valueOf(nautiloUserId("00000000-0000-4000-8000-000000000071"));
const HUMAN = valueOf(nautiloActorId("00000000-0000-4000-8000-000000000072"));
const LINEAGE = new Uint8Array(32).fill(0x37);

class MemoryPendingVault implements PendingInitialDeviceBootstrapVault {
  value: PendingInitialDeviceBootstrap | null = null;
  readonly loaded: PendingInitialDeviceBootstrap[] = [];
  load(key: string) {
    const result = this.value?.idempotencyKey === key
      ? structuredClone(this.value) : null;
    if (result !== null) this.loaded.push(result);
    return Promise.resolve(result);
  }
  create(value: PendingInitialDeviceBootstrap) {
    if (this.value === null) {
      this.value = structuredClone(value);
      return Promise.resolve("inserted" as const);
    }
    return Promise.resolve(this.value.idempotencyKey === value.idempotencyKey
      ? "exact_duplicate" as const : "collision" as const);
  }
  compareAndSwap(input: Readonly<{
    expected: PendingInitialDeviceBootstrap;
    replacement: PendingInitialDeviceBootstrap;
  }>) {
    if (this.value?.idempotencyKey !== input.expected.idempotencyKey
      || this.value.revision !== input.expected.revision) return Promise.resolve(false);
    this.value = structuredClone(input.replacement);
    return Promise.resolve(true);
  }
  removeExact(value: PendingInitialDeviceBootstrap) {
    if (this.value?.idempotencyKey !== value.idempotencyKey
      || this.value.revision !== value.revision) return Promise.resolve(false);
    this.value = null;
    return Promise.resolve(true);
  }
}

function isWiped(bytes: Uint8Array | null): boolean {
  return bytes === null || bytes.every((byte) => byte === 0);
}

function expectSecretsWiped(value: PendingInitialDeviceBootstrap): void {
  expect(isWiped(value.profileBytes)).toBe(true);
  expect(isWiped(value.recoveryArchiveBytes)).toBe(true);
  expect(isWiped(value.deviceProof)).toBe(true);
  expect(isWiped(value.publicFingerprint)).toBe(true);
  expect(isWiped(value.request.signingPublicKey)).toBe(true);
  expect(isWiped(value.request.encryptionPublicKey)).toBe(true);
  expect(isWiped(value.request.recoveryPublicKey)).toBe(true);
  if (value.challenge !== null) {
    expect(isWiped(value.challenge.signingPublicKey)).toBe(true);
    expect(isWiped(value.challenge.encryptionPublicKey)).toBe(true);
    expect(isWiped(value.challenge.recoveryPublicKey)).toBe(true);
    expect(isWiped(value.challenge.authorizationDigest)).toBe(true);
  }
}

async function rejectionOf(operation: Promise<unknown>): Promise<Error> {
  let observed: unknown;
  try {
    await operation;
  } catch (error) {
    observed = error;
  }
  expect(observed).toBeInstanceOf(Error);
  return observed as Error;
}

function fixture(idempotencyKey: string) {
  let byte = 1;
  const crypto = new LatticeCrypto({
    bytes: (length) => new Uint8Array(length).fill(byte++),
  }, { now: () => 10_000 });
  const repository = new MemoryDeviceLifecycleRepository();
  const context = { kind: "preparation" as const, authorityId: idempotencyKey };
  const service = new InitialDeviceBootstrapService({
    crypto,
    repository,
    authorize: createSyntheticInitialDeviceAuthorizer({
      expectedUserId: USER,
      expectedHumanActorId: HUMAN,
      expectedInstallationLineageDigest: LINEAGE,
      authorizationDigest: new Uint8Array(32).fill(0x41),
      allowedContext: context,
    }),
    authorizeReceiptLookup: () => true,
  });
  const vault = createMemoryClientProfileVault();
  const pending = new MemoryPendingVault();
  const coordinates = {
    serverScope: "https://nautilo.test",
    userId: USER,
    humanActorId: HUMAN,
    profileId: "profile:browser",
    deviceId: "device:browser",
    installationLineageDigest: "37".repeat(32),
  };
  const presentRecoveryKit = (_presentation: Parameters<
    typeof prepareRestartSafeInitialDeviceClientCeremony
  >[0]["presentRecoveryKit"] extends (value: infer Value) => unknown
    ? Value : never) => {
    return {
      status: "confirmed" as const,
    };
  };
  return { crypto, service, vault, pending, coordinates, presentRecoveryKit };
}

async function prepare(setup: ReturnType<typeof fixture>, idempotencyKey: string) {
  return prepareRestartSafeInitialDeviceClientCeremony({
    crypto: setup.crypto,
    vault: setup.vault,
    pending: setup.pending,
    serverScope: setup.coordinates.serverScope,
    profileId: setup.coordinates.profileId,
    userId: USER,
    humanActorId: HUMAN,
    deviceId: setup.coordinates.deviceId,
    clientKind: "browser",
    installationLineageDigest: LINEAGE,
    idempotencyKey,
    recoverySources: [],
    presentRecoveryKit: setup.presentRecoveryKit,
  });
}

describe("restart-safe initial-device ceremony", () => {
  test("retains the server-authored preparation authority across durable resume", async () => {
    const key = "bootstrap:server-authority";
    const setup = fixture("initial-device:server-user");
    await prepare(setup, key);
    const bootstrap = {
      begin: (request: Parameters<typeof setup.service.begin>[0]) =>
        setup.service.begin(Object.freeze({
          ...request,
          context: Object.freeze({
            kind: "preparation" as const,
            authorityId: "initial-device:server-user",
          }),
        })),
      complete: setup.service.complete.bind(setup.service),
      resolveReceipt: setup.service.resolveReceipt.bind(setup.service),
    };
    const receipt = await resumeRestartSafeInitialDeviceClientCeremony({
      crypto: setup.crypto,
      vault: setup.vault,
      pending: setup.pending,
      bootstrap,
      idempotencyKey: key,
    });
    expect(receipt.status).toBe("active");
    expect(setup.pending.value).toBeNull();
  });

  test("persists exact keys and recovery archive before begin, then resumes", async () => {
    const key = "bootstrap:pre-begin";
    const setup = fixture(key);
    expect((await prepare(setup, key)).status).toBe("prepared");
    expect(setup.pending.value).toMatchObject({ revision: 1, challenge: null });
    expect((await prepare(setup, key)).status).toBe("resumed");
    expectSecretsWiped(setup.pending.loaded.at(-1)!);
    const receipt = await resumeRestartSafeInitialDeviceClientCeremony({
      crypto: setup.crypto,
      vault: setup.vault,
      pending: setup.pending,
      bootstrap: setup.service,
      idempotencyKey: key,
    });
    expect(receipt.status).toBe("active");
    expect(setup.pending.value).toBeNull();
    expectSecretsWiped(setup.pending.loaded.at(-1)!);
  });

  test("replays exact completion after crash before server complete", async () => {
    const key = "bootstrap:pre-complete";
    const setup = fixture(key);
    await prepare(setup, key);
    expect((await rejectionOf(resumeRestartSafeInitialDeviceClientCeremony({
      crypto: setup.crypto,
      vault: setup.vault,
      pending: setup.pending,
      bootstrap: {
        begin: (request) => setup.service.begin(request),
        complete: () => Promise.reject(new Error("crash before complete")),
        resolveReceipt: () => Promise.resolve(null),
      },
      idempotencyKey: key,
    }))).message).toContain("outcome is unknown");
    expectSecretsWiped(setup.pending.loaded.at(-1)!);
    expect(setup.pending.value).toMatchObject({ revision: 2 });
    expect(await resumeRestartSafeInitialDeviceClientCeremony({
      crypto: setup.crypto,
      vault: setup.vault,
      pending: setup.pending,
      bootstrap: setup.service,
      idempotencyKey: key,
    })).toMatchObject({ status: "active" });
  });

  test("recovers response loss and activation loss without regenerating", async () => {
    const key = "bootstrap:activation-loss";
    const setup = fixture(key);
    await prepare(setup, key);
    let activationCalls = 0;
    const vault: ClientProfileVault = {
      availability: () => setup.vault.availability(),
      unlock: () => setup.vault.unlock(),
      lock: () => setup.vault.lock(),
      stageProfile: (input) => setup.vault.stageProfile(input),
      async activateProfile(...args) {
        activationCalls += 1;
        if (activationCalls === 1) throw new Error("activation response lost");
        return setup.vault.activateProfile(...args);
      },
      abortStagedProfile: (...args) => setup.vault.abortStagedProfile(...args),
      recoverInterruptedActivation: (...args) =>
        setup.vault.recoverInterruptedActivation(...args),
      withOpenProfile: (coordinates, operation) =>
        setup.vault.withOpenProfile(coordinates, operation),
      withOpenStagedProfile: (coordinates, stageId, operation) =>
        setup.vault.withOpenStagedProfile!(coordinates, stageId, operation),
      listPublicProfiles: () => setup.vault.listPublicProfiles(),
      rotateWrappingMaterial: () => setup.vault.rotateWrappingMaterial(),
      forgetProfile: (coordinates) => setup.vault.forgetProfile(coordinates),
    };
    expect((await rejectionOf(resumeRestartSafeInitialDeviceClientCeremony({
      crypto: setup.crypto,
      vault,
      pending: setup.pending,
      bootstrap: {
        begin: (request) => setup.service.begin(request),
        complete: async (completion) => {
          await setup.service.complete(completion);
          throw new Error("completion response lost");
        },
        resolveReceipt: (query) => setup.service.resolveReceipt(query),
      },
      idempotencyKey: key,
    }))).message).toContain("activation response lost");
    expect(await resumeRestartSafeInitialDeviceClientCeremony({
      crypto: setup.crypto,
      vault,
      pending: setup.pending,
      bootstrap: setup.service,
      idempotencyKey: key,
    })).toMatchObject({ status: "active" });
    expect(activationCalls).toBe(2);
  });
});
