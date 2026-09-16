import { describe, expect, test } from "bun:test";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  nautiloActorId,
  nautiloUserId,
  resumeInitialDeviceClientCeremony,
  runInitialDeviceClientCeremony,
  type TranslationResult,
} from "../../src/index.ts";
import {
  InitialDeviceBootstrapService,
} from "../../src/server/index.ts";
import {
  MemoryDeviceLifecycleRepository,
  createMemoryClientProfileVault,
  createSyntheticInitialDeviceAuthorizer,
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

function deterministicCrypto(): LatticeCrypto {
  let next = 1;
  return new LatticeCrypto(
    {
      bytes: (length) => new Uint8Array(length).fill(next++),
    },
    { now: () => 10_000 },
  );
}

function presenter(
  _presentation: Parameters<
    typeof runInitialDeviceClientCeremony
  >[0]["presentRecoveryKit"] extends (
    value: infer Presentation,
  ) => unknown ? Presentation : never,
) {
  return {
    status: "confirmed" as const,
  };
}

function fixture(context: {
  readonly kind:
    | "preparation"
    | "greenfield_initial_owner"
    | "pending_encrypted_invite";
  readonly authorityId: string;
}) {
  const crypto = deterministicCrypto();
  const repository = new MemoryDeviceLifecycleRepository();
  const service = new InitialDeviceBootstrapService({
    crypto,
    repository,
    authorize: createSyntheticInitialDeviceAuthorizer({
      expectedUserId: USER_ID,
      expectedHumanActorId: ACTOR_ID,
      expectedInstallationLineageDigest: LINEAGE,
      authorizationDigest: new Uint8Array(32).fill(0x41),
      allowedContext: context,
    }),
    authorizeReceiptLookup: () => true,
  });
  return {
    crypto,
    repository,
    service,
    vault: createMemoryClientProfileVault(),
    context,
  };
}

const PROFILE_COORDINATES = {
  serverScope: "https://crypto.example.test",
  userId: USER_ID,
  humanActorId: ACTOR_ID,
  profileId: "profile_alice_browser",
  deviceId: "device_alice_browser",
  installationLineageDigest: "31".repeat(32),
} as const;

describe("initial-device client ceremony", () => {
  for (const context of [
    { kind: "preparation", authorityId: "prep_1" },
    {
      kind: "greenfield_initial_owner",
      authorityId: "installation_1",
    },
    {
      kind: "pending_encrypted_invite",
      authorityId: "invite_1",
    },
  ] as const) {
    test(`activates server custody and the local vault through ${context.kind}`, async () => {
      const setup = fixture(context);
      const receipt = await runInitialDeviceClientCeremony({
        crypto: setup.crypto,
        vault: setup.vault,
        bootstrap: setup.service,
        serverScope: PROFILE_COORDINATES.serverScope,
        profileId: PROFILE_COORDINATES.profileId,
        userId: USER_ID,
        humanActorId: ACTOR_ID,
        deviceId: PROFILE_COORDINATES.deviceId,
        clientKind: "browser",
        installationLineageDigest: LINEAGE,
        context,
        idempotencyKey: `bootstrap_${context.kind}`,
        recoverySources: [],
        presentRecoveryKit: presenter,
      });

      expect(receipt.status).toBe("active");
      expect(setup.repository.publicSnapshot()).toMatchObject({
        custodyState: "active",
        recoveryGeneration: 1,
        activeDeviceCount: 1,
      });
      expect(await setup.vault.listPublicProfiles()).toMatchObject([{
        lifecycle: "active",
        coordinates: PROFILE_COORDINATES,
      }]);
      await setup.vault.withOpenProfile(PROFILE_COORDINATES, (bytes) => {
        const decoded = new TextDecoder().decode(bytes);
        expect(decoded).toContain("nautilo/client-device-profile/v1");
        expect(decoded).not.toContain("signingPrivateKey");
        expect(decoded).not.toContain("encryptionPrivateKey");
        expect(decoded).not.toContain("0101010101010101");
        expect(decoded).not.toContain("mnemonic");
        expect(decoded).not.toContain("recovery");
      });
    });
  }

  test("retains a staged profile when completion commits but its response is lost", async () => {
    const setup = fixture({
      kind: "preparation",
      authorityId: "prep_ambiguous",
    });
    let completionCalls = 0;

    await runInitialDeviceClientCeremony({
      crypto: setup.crypto,
      vault: setup.vault,
      bootstrap: {
        begin: (request) => setup.service.begin(request),
        complete: async (completion) => {
          completionCalls += 1;
          await setup.service.complete(completion);
          throw new Error("simulated connection loss");
        },
        resolveReceipt: (query) => setup.service.resolveReceipt(query),
      },
      serverScope: PROFILE_COORDINATES.serverScope,
      profileId: PROFILE_COORDINATES.profileId,
      userId: USER_ID,
      humanActorId: ACTOR_ID,
      deviceId: PROFILE_COORDINATES.deviceId,
      clientKind: "browser",
      installationLineageDigest: LINEAGE,
      context: setup.context,
      idempotencyKey: "bootstrap_ambiguous",
      recoverySources: [],
      presentRecoveryKit: presenter,
    });

    expect(completionCalls).toBe(1);
    expect(setup.repository.publicSnapshot()).toMatchObject({
      custodyState: "active",
      activeDeviceCount: 1,
      recoveryGeneration: 1,
    });
    expect(await setup.vault.listPublicProfiles()).toMatchObject([{
      lifecycle: "active",
      coordinates: PROFILE_COORDINATES,
    }]);
  });

  test("resumes a committed bootstrap after process restart", async () => {
    const setup = fixture({
      kind: "preparation",
      authorityId: "prep_restart",
    });
    const bootstrap = {
      begin: (request: Parameters<typeof setup.service.begin>[0]) =>
        setup.service.begin(request),
      complete: async (
        completion: Parameters<typeof setup.service.complete>[0],
      ) => {
        await setup.service.complete(completion);
        throw new Error("simulated connection loss");
      },
      resolveReceipt: () =>
        Promise.reject(new Error("simulated offline client")),
    };

    expect(runInitialDeviceClientCeremony({
      crypto: setup.crypto,
      vault: setup.vault,
      bootstrap,
      serverScope: PROFILE_COORDINATES.serverScope,
      profileId: PROFILE_COORDINATES.profileId,
      userId: USER_ID,
      humanActorId: ACTOR_ID,
      deviceId: PROFILE_COORDINATES.deviceId,
      clientKind: "browser",
      installationLineageDigest: LINEAGE,
      context: setup.context,
      idempotencyKey: "bootstrap_restart",
      recoverySources: [],
      presentRecoveryKit: presenter,
    })).rejects.toMatchObject({ code: "completion_outcome_unknown" });

    expect(await setup.vault.listPublicProfiles()).toMatchObject([{
      lifecycle: "staged",
      coordinates: PROFILE_COORDINATES,
    }]);

    const receipt = await resumeInitialDeviceClientCeremony({
      vault: setup.vault,
      bootstrap: {
        ...bootstrap,
        resolveReceipt: (query) => setup.service.resolveReceipt(query),
      },
      coordinates: PROFILE_COORDINATES,
    });

    expect(receipt.status).toBe("active");
    expect(await setup.vault.listPublicProfiles()).toMatchObject([{
      lifecycle: "active",
      coordinates: PROFILE_COORDINATES,
    }]);
  });
});
