import { describe, expect, test } from "bun:test";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  MAX_ACTIVE_CRYPTO_DEVICES_PER_HUMAN,
  MAX_PENDING_CRYPTO_DEVICES_PER_HUMAN,
  nautiloActorId,
  nautiloUserId,
  type BeginAdditionalDeviceEnrollment,
  type TranslationResult,
} from "../../src/index.ts";
import {
  AdditionalDeviceEnrollmentService,
} from "../../src/server/index.ts";
import {
  MemoryAdditionalDeviceEnrollmentRepository,
  createSyntheticAdditionalDeviceAuthorizer,
} from "../../src/testing/index.ts";

function valueOf<T>(result: TranslationResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const USER_ID = valueOf(
  nautiloUserId("00000000-0000-4000-8000-00000000000a"),
);
const ACTOR_ID = valueOf(
  nautiloActorId("00000000-0000-4000-8000-00000000000b"),
);
const LINEAGE = new Uint8Array(32).fill(0x31);
const AUTHORIZATION = new Uint8Array(32).fill(0x41);
const INVENTORY = new Uint8Array(32).fill(0x51);

function deterministicCrypto(now = 10_000): LatticeCrypto {
  let counter = 1;
  return new LatticeCrypto(
    {
      bytes(length) {
        return new Uint8Array(length).fill(counter++);
      },
    },
    { now: () => now },
  );
}

async function fixture(input: {
  readonly activeDeviceCount?: number;
  readonly pendingDeviceCount?: number;
  readonly authorizedCustodyRevision?: number;
  readonly storedCustodyRevision?: number;
  readonly enforceLegacyFleetBounds?: boolean;
} = {}) {
  const crypto = deterministicCrypto();
  const signing = crypto.generateSigningKeyPair();
  const encryption = await crypto.generateEncryptionKeyPair();
  const activeDeviceCount = input.activeDeviceCount ?? 1;
  const pendingDeviceCount = input.pendingDeviceCount ?? 0;
  const storedCustodyRevision = input.storedCustodyRevision ?? 4;
  const repository = new MemoryAdditionalDeviceEnrollmentRepository({
    custodyRevision: storedCustodyRevision,
    recoveryGeneration: 2,
    activeDeviceIds: Array.from(
      { length: activeDeviceCount },
      (_, index) => `active_device_${index}`,
    ),
    pendingDeviceIds: Array.from(
      { length: pendingDeviceCount },
      (_, index) => `pending_device_${index}`,
    ),
    ...(input.enforceLegacyFleetBounds === undefined ? {} : {
      enforceLegacyFleetBounds: input.enforceLegacyFleetBounds,
    }),
  });
  const service = new AdditionalDeviceEnrollmentService({
    crypto,
    repository,
    authorize: createSyntheticAdditionalDeviceAuthorizer({
      expectedUserId: USER_ID,
      expectedHumanActorId: ACTOR_ID,
      expectedInstallationLineageDigest: LINEAGE,
      authorizationEvidenceDigest: AUTHORIZATION,
      expectedCustodyRevision:
        input.authorizedCustodyRevision ?? storedCustodyRevision,
      expectedRecoveryGeneration: 2,
      inventoryRevision: 8,
      inventoryCount: 2,
      inventoryDigest: INVENTORY,
      activeDeviceCount,
      pendingDeviceCount,
    }),
    ...(input.enforceLegacyFleetBounds === undefined ? {} : {
      enforceLegacyFleetBounds: input.enforceLegacyFleetBounds,
    }),
  });
  const request: BeginAdditionalDeviceEnrollment = {
    userId: USER_ID,
    humanActorId: ACTOR_ID,
    deviceId: "device_alice_additional",
    clientKind: "electron",
    installationLineageDigest: LINEAGE,
    deviceGeneration: 1,
    signingPublicKey: signing.publicKey,
    encryptionPublicKey: encryption.publicKey,
    method: "device_approval",
    idempotencyKey: "additional_device_1",
  };
  return { crypto, repository, service, request };
}

describe("additional-device enrollment", () => {
  for (const method of ["device_approval", "recovery"] as const) {
    test(`${method} creates a pending device without authorizing it`, async () => {
      const setup = await fixture();
      const enrollment = await setup.service.begin({
        ...setup.request,
        method,
        idempotencyKey: `additional_${method}`,
      });

      expect(enrollment).toMatchObject({
        method,
        status: "pending",
        deviceRevision: 0,
        expectedCustodyRevision: 4,
        expectedRecoveryGeneration: 2,
        inventoryRevision: 8,
        inventoryCount: 2,
      });
      expect(setup.repository.publicSnapshot()).toEqual({
        activeDeviceCount: 1,
        pendingDeviceCount: 1,
        pendingDeviceIds: ["device_alice_additional"],
      });
    });
  }

  test("replays the same reservation but rejects changed idempotent input", async () => {
    const setup = await fixture();
    const first = await setup.service.begin(setup.request);
    const replay = await setup.service.begin(setup.request);
    expect(replay.operationId).toBe(first.operationId);
    expect(replay.challengeId).toBe(first.challengeId);
    expect(setup.repository.publicSnapshot().pendingDeviceCount).toBe(1);

    expect(setup.service.begin({
      ...setup.request,
      method: "recovery",
    })).rejects.toMatchObject({ code: "conflicting_idempotency" });
  });

  test("fails closed when the authorized custody revision is stale", async () => {
    const setup = await fixture({
      authorizedCustodyRevision: 3,
      storedCustodyRevision: 4,
    });
    expect(setup.service.begin(setup.request)).rejects.toMatchObject({
      code: "stale_state",
    });
    expect(setup.repository.publicSnapshot().pendingDeviceCount).toBe(0);
  });

  test("enforces exact active and pending device bounds", async () => {
    const active = await fixture({
      activeDeviceCount: MAX_ACTIVE_CRYPTO_DEVICES_PER_HUMAN,
    });
    expect(active.service.begin(active.request)).rejects.toMatchObject({
      code: "device_limit_reached",
    });
    expect(active.repository.publicSnapshot().pendingDeviceCount).toBe(0);

    const pending = await fixture({
      pendingDeviceCount: MAX_PENDING_CRYPTO_DEVICES_PER_HUMAN,
    });
    expect(pending.service.begin(pending.request)).rejects.toMatchObject({
      code: "pending_limit_reached",
    });
    expect(pending.repository.publicSnapshot().pendingDeviceCount).toBe(
      MAX_PENDING_CRYPTO_DEVICES_PER_HUMAN,
    );
  });

  test("lets the Human-device MLS path exceed legacy fleet-count ceilings", async () => {
    const setup = await fixture({
      activeDeviceCount: MAX_ACTIVE_CRYPTO_DEVICES_PER_HUMAN + 1,
      pendingDeviceCount: MAX_PENDING_CRYPTO_DEVICES_PER_HUMAN + 1,
      enforceLegacyFleetBounds: false,
    });
    expect(await setup.service.begin(setup.request)).toMatchObject({
      status: "pending",
    });
  });

  test("validates public keys before any durable state is created", async () => {
    const setup = await fixture();
    expect(setup.service.begin({
      ...setup.request,
      signingPublicKey: new Uint8Array(31),
    })).rejects.toThrow("signing key must be exactly 32 bytes");
    expect(setup.repository.publicSnapshot().pendingDeviceCount).toBe(0);
  });
});
