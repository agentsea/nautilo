import { describe, expect, test } from "bun:test";
import { LatticeCrypto } from "@nautilo/lattice-crypto";

import {
  createLocalInitialDeviceReadinessClient,
  type LocalInitialDeviceReadinessClientInput,
} from
  "../../src/device/local-initial-device-readiness-client.ts";
import {
  authenticateClientDeviceProfileV4,
  destroyOpenedClientDeviceProfileV4,
} from "../../src/client-vault/profile-v4.ts";
import type {
  PendingInitialDeviceBootstrap,
  PendingInitialDeviceBootstrapVault,
} from "../../src/device/restart-safe-initial-device-client-ceremony.ts";
import { InitialDeviceBootstrapService } from
  "../../src/server/device/initial-bootstrap-service.ts";
import { humanMembershipTargetDomainSubmissionDigest } from
  "../../src/delivery/human-membership-target-domain.ts";
import type { InitialHumanDomainApiClientPort } from
  "../../src/device/initial-readiness-api-client.ts";
import { InitialDeviceEnrollmentRequiredError } from
  "../../src/device/initial-readiness-api-client.ts";
import { deriveAdditionalDeviceClientIdentity } from
  "../../src/device/additional-device-client.ts";
import {
  nautiloActorId,
  nautiloUserId,
} from "../../src/identity/product-ids.ts";
import {
  MemoryClientProfileVault,
  MemoryDeviceLifecycleRepository,
  createSyntheticInitialDeviceAuthorizer,
} from "../../src/testing/index.ts";

const USER_ID = "00000000-0000-4000-8000-000000000091";
const HUMAN_ID = "00000000-0000-4000-8000-000000000092";
const DOMAIN_ID = "domain_local_readiness";
const OPERATION_ID = "operation_local_readiness";

class PendingVault implements PendingInitialDeviceBootstrapVault {
  value: PendingInitialDeviceBootstrap | null = null;
  load(key: string) {
    return Promise.resolve(this.value?.idempotencyKey === key
      ? structuredClone(this.value) : null);
  }
  create(value: PendingInitialDeviceBootstrap) {
    if (this.value !== null) return Promise.resolve("collision" as const);
    this.value = structuredClone(value);
    return Promise.resolve("inserted" as const);
  }
  compareAndSwap(input: Readonly<{
    expected: PendingInitialDeviceBootstrap;
    replacement: PendingInitialDeviceBootstrap;
  }>) {
    if (this.value?.revision !== input.expected.revision) {
      return Promise.resolve(false);
    }
    this.value = structuredClone(input.replacement);
    return Promise.resolve(true);
  }
  removeExact(value: PendingInitialDeviceBootstrap) {
    if (this.value?.revision !== value.revision) return Promise.resolve(false);
    this.value = null;
    return Promise.resolve(true);
  }
}

function fixture() {
  let fill = 1;
  const crypto = new LatticeCrypto({
    bytes: (length) => new Uint8Array(length).fill(fill++),
  }, { now: () => 10_000 });
  const user = nautiloUserId(USER_ID);
  const human = nautiloActorId(HUMAN_ID);
  if (!user.ok || !human.ok) throw new Error("fixture identity invalid");
  const identity = deriveAdditionalDeviceClientIdentity({
    crypto,
    serverScope: "https://nautilo.test",
    userId: USER_ID,
    humanActorId: HUMAN_ID,
    installationId: "installation-1",
    clientKind: "browser",
  });
  const pending = new PendingVault();
  const profileVault = new MemoryClientProfileVault();
  const service = new InitialDeviceBootstrapService({
    crypto,
    repository: new MemoryDeviceLifecycleRepository(),
    authorize: createSyntheticInitialDeviceAuthorizer({
      expectedUserId: user.value,
      expectedHumanActorId: human.value,
      expectedInstallationLineageDigest: identity.installationLineageDigest,
      authorizationDigest: new Uint8Array(32).fill(0x41),
      allowedContext: {
        kind: "preparation",
        authorityId: identity.idempotencyKey.replace(
          "additional-device:",
          "initial-device:",
        ),
      },
    }),
    authorizeReceiptLookup: () => true,
  });
  let activationCalls = 0;
  let loseNextActivationResponse = false;
  let serverIdentityMissing = false;
  let activeDomain: Readonly<{
    humanId: string;
    deviceId: string;
    domainId: string;
    providerId: string;
    epoch: number;
    stateHash: Uint8Array;
  }> | null = null;
  let domainUnavailable: "existing_domain_requires_delivery" | null = null;
  const initialHumanDomain: InitialHumanDomainApiClientPort = Object.freeze({
    plan: () => serverIdentityMissing
      ? Promise.resolve(Object.freeze({
        status: "unavailable" as const,
        reason: "stale_identity" as const,
      }))
      : activeDomain !== null
      ? Promise.resolve(Object.freeze({
        status: "active" as const,
        ...activeDomain,
        stateHash: activeDomain.stateHash.slice(),
        trustedDeviceRevision: 1,
        trustedHostAuthorizationRevision: 1,
        deliveryHighWatermark: 0,
      }))
      : domainUnavailable === null
      ? Promise.resolve(Object.freeze({
      status: "planned" as const,
      operationId: OPERATION_ID,
      humanId: HUMAN_ID,
      deviceId: identity.coordinates.deviceId,
      domainId: DOMAIN_ID,
      currentDomainHead: null,
      activeDeviceIds: Object.freeze([identity.coordinates.deviceId]),
      trustedDeviceRevision: 1,
      trustedHostAuthorizationRevision: 1,
      deliveryHighWatermark: 0,
      }))
      : Promise.resolve(Object.freeze({
        status: "unavailable" as const,
        reason: domainUnavailable,
      })),
    activate(
      submission: Parameters<InitialHumanDomainApiClientPort["activate"]>[0],
    ) {
      activationCalls += 1;
      if (loseNextActivationResponse) {
        loseNextActivationResponse = false;
        return Promise.reject(new Error("response lost after domain commit"));
      }
      activeDomain = Object.freeze({
        humanId: submission.committerHumanId,
        deviceId: submission.committerDeviceId,
        domainId: submission.targetDomainId,
        providerId: submission.initialProviderHead.providerId,
        epoch: 0,
        stateHash: submission.initialProviderHead.stateHash.slice(),
      });
      return Promise.resolve(Object.freeze({
        formatVersion: 1 as const,
        status: "active" as const,
        operationId: submission.operationId,
        humanId: submission.committerHumanId,
        deviceId: submission.committerDeviceId,
        domainId: submission.targetDomainId,
        providerId: submission.initialProviderHead.providerId,
        epoch: 0 as const,
        stateHash: submission.initialProviderHead.stateHash.slice(),
        rosterHash: crypto.hash(submission.initialRosterBytes),
        submissionDigest: humanMembershipTargetDomainSubmissionDigest({
          crypto,
          submission,
        }),
        committedAt: 10_000,
      }));
    },
  });
  return {
    pending,
    profileVault,
    initialHumanDomain,
    activationCalls: () => activationCalls,
    loseNextActivationResponse: () => {
      loseNextActivationResponse = true;
    },
    deferToExistingDomain: () => {
      domainUnavailable = "existing_domain_requires_delivery";
    },
    loseServerIdentity: () => {
      serverIdentityMissing = true;
      activeDomain?.stateHash.fill(0);
      activeDomain = null;
    },
    divergeServerDomain: () => {
      if (activeDomain === null) throw new Error("active Domain is unavailable");
      activeDomain = Object.freeze({
        ...activeDomain,
        epoch: activeDomain.epoch + 1,
        stateHash: new Uint8Array(32).fill(0x77),
      });
    },
    create: (
      additionalDeviceApprover?:
        LocalInitialDeviceReadinessClientInput["additionalDeviceApprover"],
      additionalDeviceTarget?:
        LocalInitialDeviceReadinessClientInput["additionalDeviceTarget"],
      humanDeviceMembership?:
        LocalInitialDeviceReadinessClientInput["humanDeviceMembership"],
    ) => createLocalInitialDeviceReadinessClient({
      crypto,
      profileVault,
      pendingVault: pending,
      bootstrap: service,
      initialHumanDomain,
      serverScope: "https://nautilo.test",
      userId: USER_ID,
      humanActorId: HUMAN_ID,
      installationId: "installation-1",
      clientKind: "browser",
      ...(additionalDeviceApprover === undefined
        ? {} : { additionalDeviceApprover }),
      ...(additionalDeviceTarget === undefined
        ? {} : { additionalDeviceTarget }),
      ...(humanDeviceMembership === undefined
        ? {} : { humanDeviceMembership }),
    }),
  };
}

describe("local initial-device readiness client", () => {
  test("resolves admission custody without requesting protected personal authority", async () => {
    const setup = fixture();
    expect(await setup.create().deviceAdmissionDeviceId!()).toBeNull();
    await setup.create().setup(() => ({ status: "confirmed" as const }));
    const coordinates = (await setup.profileVault.listPublicProfiles())[0]!
      .coordinates;
    const client = setup.create(undefined, undefined, {
      ensure: () => { throw new Error("personal authority requires admission"); },
    });
    await setup.profileVault.lock();
    expect(await client.deviceAdmissionDeviceId!()).toBe(coordinates.deviceId);
    expect(await client.inspect().catch((error: unknown) => error))
      .toEqual(new Error("personal authority requires admission"));
  });

  test("unlocks a fresh vault facade before approving or advancing another device", async () => {
    const setup = fixture();
    const first = setup.create();
    await first.setup(() => {
      return {
        status: "confirmed" as const,
      };
    });
    const coordinates = (await setup.profileVault.listPublicProfiles())[0]!
      .coordinates;
    const calls: string[] = [];
    const approver = {
      inspect: () => Promise.resolve([]),
      approve: async () => {
        await setup.profileVault.withOpenProfile(coordinates, () => undefined);
        calls.push("approve");
        return { status: "waiting_for_target" as const };
      },
      advance: async () => {
        await setup.profileVault.withOpenProfile(coordinates, () => undefined);
        calls.push("advance");
      },
    };
    const client = setup.create(approver);

    await setup.profileVault.lock();
    await client.approveAdditionalDevice!("operation", "ABCDEF-012345-6789AB");
    await setup.profileVault.lock();
    await client.advanceAdditionalDevice!("operation");

    expect(calls).toEqual(["approve", "advance"]);
  });

  test("does not report active until the Human-device MLS group is current", async () => {
    const setup = fixture();
    let ready = false;
    const client = setup.create(undefined, undefined, {
      ensure: () => Promise.resolve(ready
        ? Object.freeze({ status: "ready" as const })
        : Object.freeze({ status: "syncing" as const })),
    });
    const result = await client.setup(() => {
      return {
        status: "confirmed" as const,
      };
    });
    expect(result).toMatchObject({
      status: "additional_device_required",
      enrollmentStatus: "syncing",
    });
    ready = true;
    expect(await client.inspect()).toMatchObject({
      status: "active",
      encryptionSetup: "v2_personal_authority_ready",
    });
  });

  test("shows the recovery phrase once and activates an exact local profile", async () => {
    const setup = fixture();
    const client = setup.create();
    expect((await client.inspect()).status).toBe("setup_required");
    let presentations = 0;
    const active = await client.setup((presentation) => {
      presentations += 1;
      expect(presentation.revealMnemonic().split(" ")).toHaveLength(24);
      return {
        status: "confirmed",
      };
    });
    expect(active.status).toBe("active");
    expect(active).toMatchObject({
      encryptionSetup: "v2_personal_authority_ready",
    });
    const publicProfile = (await setup.profileVault.listPublicProfiles()).find(
      (profile) => profile.lifecycle === "active",
    );
    expect(publicProfile?.generation).toBe(2);
    await setup.profileVault.withOpenProfile(
      publicProfile!.coordinates,
      async (profileBytes) => {
        const profile = await authenticateClientDeviceProfileV4({
          crypto: new LatticeCrypto(),
          profileBytes,
          expectedDeviceId: publicProfile!.coordinates.deviceId,
        });
        expect(profile.formatVersion).toBe(4);
        destroyOpenedClientDeviceProfileV4(profile);
      },
    );
    expect(presentations).toBe(1);
    expect(await setup.create().inspect()).toMatchObject({
      status: "active",
      encryptionSetup: "v2_personal_authority_ready",
    });
  });

  test("keeps an accepted transfer visible while the target has not activated", async () => {
    const setup = fixture();
    const first = setup.create();
    await first.setup(() => {
      return {
        status: "confirmed",
      };
    });
    const client = setup.create({
      inspect: () => Promise.resolve(Object.freeze([Object.freeze({
        enrollment: Object.freeze({
          operationId: "device-add-awaiting-target",
          deviceId: "crypto:electron:target",
          clientKind: "electron" as const,
        }),
        verificationCode: "ABCDEF-012345-6789AB",
        progress: "awaiting_target" as const,
      })])),
      approve: () => Promise.reject(new Error("must not approve")),
      advance: () => Promise.reject(new Error("must not advance")),
    });
    expect(await client.inspect()).toMatchObject({
      status: "active",
      encryptionSetup: "v2_personal_authority_ready",
      pendingAdditionalDevices: [{
        operationId: "device-add-awaiting-target",
        progress: "awaiting_target",
      }],
    });
  });

  test("keeps a sealed transition campaign visible after its server commit", async () => {
    const setup = fixture();
    const first = setup.create();
    await first.setup(() => {
      return {
        status: "confirmed",
      };
    });
    const client = setup.create({
      inspect: () => Promise.resolve(Object.freeze([Object.freeze({
        enrollment: Object.freeze({
          operationId: "device-add-committed",
          deviceId: "crypto:electron:target",
          clientKind: "electron" as const,
        }),
        verificationCode: "ABCDEF-012345-6789AB",
        progress: "transfer_ready" as const,
      })])),
      approve: () => Promise.reject(new Error("must not approve")),
      advance: () => Promise.reject(new Error("must not advance")),
    });
    expect(await client.inspect()).toMatchObject({
      status: "active",
      encryptionSetup: "v2_personal_authority_ready",
      pendingAdditionalDevices: [{
        operationId: "device-add-committed",
        progress: "transfer_ready",
      }],
    });
  });

  test("keeps Grant synchronization actionable across a local custody conflict", async () => {
    const setup = fixture();
    await setup.create().setup(() => {
      return {
        status: "confirmed",
      };
    });
    const client = setup.create({
      inspect: () => Promise.resolve(Object.freeze([Object.freeze({
        enrollment: Object.freeze({
          operationId: "device-add-transfer",
          deviceId: "crypto:browser:target",
          clientKind: "browser" as const,
        }),
        verificationCode: "ABCDEF-012345-6789AB",
        progress: "transfer_ready" as const,
      })])),
      approve: () => Promise.reject(new Error("must not approve")),
      advance: () => Promise.reject(new Error("must not advance")),
    });
    expect(await client.inspect()).toMatchObject({
      status: "active",
      encryptionSetup: "v2_personal_authority_ready",
      pendingAdditionalDevices: [{
        operationId: "device-add-transfer",
        progress: "transfer_ready",
      }],
    });
  });

  test("surfaces device approvals while personal authority is still catching up", async () => {
    const setup = fixture();
    await setup.create().setup(() => {
      return {
        status: "confirmed",
      };
    });
    const client = setup.create({
      inspect: () => Promise.resolve(Object.freeze([Object.freeze({
        enrollment: Object.freeze({
          operationId: "device-add-during-authority-catch-up",
          deviceId: "crypto:browser:target",
          clientKind: "browser" as const,
        }),
        verificationCode: "ABCDEF-012345-6789AB",
        progress: "approval_required" as const,
      })])),
      approve: () => Promise.reject(new Error("must not approve")),
      advance: () => Promise.reject(new Error("must not advance")),
    }, undefined, {
      ensure: () => Promise.resolve({
        status: "syncing" as const,
        syncReason: "personal_authority_required" as const,
      }),
    });

    expect(await client.inspect()).toMatchObject({
      status: "active",
      encryptionSetup: "device_active",
      pendingAdditionalDevices: [{
        operationId: "device-add-during-authority-catch-up",
        progress: "approval_required",
      }],
    });
  });

  test("keeps a locally activated target gated until Grant sync finishes", async () => {
    const setup = fixture();
    await setup.create().setup(() => {
      return {
        status: "confirmed",
      };
    });
    const client = setup.create(undefined, {
      hasPending: () => Promise.resolve(true),
      inspectPending: () => Promise.resolve({
        status: "syncing" as const,
        operationId: "device-add-syncing",
        verificationCode: "ABCDEF-012345-6789AB",
        syncReason: "current_domain_sync_required" as const,
      }),
      continue: () => Promise.resolve({
        status: "syncing" as const,
        operationId: "device-add-syncing",
        verificationCode: "ABCDEF-012345-6789AB",
        syncReason: "current_domain_sync_required" as const,
      }),
    });
    expect(await client.inspect()).toMatchObject({
      status: "additional_device_required",
      enrollmentStatus: "syncing",
      operationId: "device-add-syncing",
      verificationCode: "ABCDEF-012345-6789AB",
      syncReason: "current_domain_sync_required",
    });
  });

  test("resumes a confirmed pending ceremony without revealing a new phrase", async () => {
    const setup = fixture();
    const first = setup.create();
    const firstResult = await first.setup(() => {
      // Persist the confirmed credential, then simulate a crash before begin.
      queueMicrotask(() => undefined);
      return {
        status: "confirmed",
      };
    });
    expect(firstResult).toMatchObject({ status: "active" });

    // Recreate a pending-only fixture to exercise the user-visible continuation.
    const interrupted = fixture();
    const broken = createLocalInitialDeviceReadinessClient({
      profileVault: interrupted.profileVault,
      pendingVault: interrupted.pending,
      bootstrap: {
        begin: () => Promise.reject(new Error("offline")),
        complete: () => Promise.reject(new Error("offline")),
        resolveReceipt: () => Promise.resolve(null),
      },
      initialHumanDomain: interrupted.initialHumanDomain,
      serverScope: "https://nautilo.test",
      userId: USER_ID,
      humanActorId: HUMAN_ID,
      installationId: "installation-1",
      clientKind: "browser",
    });
    let failure: unknown;
    try {
      await broken.setup(() => {
        return {
          status: "confirmed",
        };
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("offline");
    expect((await interrupted.create().inspect()).status).toBe("setup_pending");
    let represented = false;
    expect((await interrupted.create().setup(() => {
      represented = true;
      return { status: "cancelled" };
    })).status).toBe("active");
    expect(represented).toBe(false);
  });

  test("fails closed before custody for invalid product identity", async () => {
    const setup = fixture();
    const client = createLocalInitialDeviceReadinessClient({
      profileVault: setup.profileVault,
      pendingVault: setup.pending,
      bootstrap: setup.create() as never,
      initialHumanDomain: setup.initialHumanDomain,
      serverScope: "https://nautilo.test",
      userId: "not-a-user",
      humanActorId: HUMAN_ID,
      installationId: "installation-1",
      clientKind: "browser",
    });
    expect(await client.inspect()).toEqual({
      status: "unavailable",
      reason: "identity_invalid",
    });
  });

  test("does not start the legacy MLS Human-Domain ceremony after device setup", async () => {
    const setup = fixture();
    let presentations = 0;
    expect(await setup.create().setup(() => {
      presentations += 1;
      return {
        status: "confirmed",
      };
    })).toMatchObject({
      status: "active",
      encryptionSetup: "v2_personal_authority_ready",
    });
    expect(presentations).toBe(1);
    expect(setup.activationCalls()).toBe(0);
  });

  test("cancellation leaves setup required without durable credentials", async () => {
    const setup = fixture();
    expect(await setup.create().setup(() => ({ status: "cancelled" })))
      .toMatchObject({ status: "setup_required" });
    expect(setup.pending.value).toBeNull();
    expect((await setup.profileVault.listPublicProfiles()).length).toBe(0);
  });

  test("discards a rejected first-device kit when the Human needs additional-device enrollment", async () => {
    const setup = fixture();
    const client = createLocalInitialDeviceReadinessClient({
      profileVault: setup.profileVault,
      pendingVault: setup.pending,
      bootstrap: {
        begin: () => Promise.reject(new InitialDeviceEnrollmentRequiredError()),
        complete: () => Promise.reject(new Error("must not complete")),
        resolveReceipt: () => Promise.resolve(null),
      },
      initialHumanDomain: setup.initialHumanDomain,
      serverScope: "https://nautilo.test",
      userId: USER_ID,
      humanActorId: HUMAN_ID,
      installationId: "installation-1",
      clientKind: "browser",
    });
    const result = await client.setup(() => {
      return {
        status: "confirmed",
      };
    });
    expect(result).toMatchObject({ status: "additional_device_required" });
    expect(setup.pending.value).toBeNull();
    expect(await setup.profileVault.listPublicProfiles()).toEqual([]);
  });

  test("detects an existing Human Domain before presenting a second recovery kit", async () => {
    const setup = fixture();
    setup.deferToExistingDomain();
    let targetCalls = 0;
    let unlockCalls = 0;
    const unlock = setup.profileVault.unlock.bind(setup.profileVault);
    Object.defineProperty(setup.profileVault, "unlock", {
      value: () => {
        unlockCalls += 1;
        return unlock();
      },
    });
    const client = createLocalInitialDeviceReadinessClient({
      profileVault: setup.profileVault,
      pendingVault: setup.pending,
      bootstrap: setup.create() as never,
      initialHumanDomain: setup.initialHumanDomain,
      serverScope: "https://nautilo.test",
      userId: USER_ID,
      humanActorId: HUMAN_ID,
      installationId: "installation-2",
      clientKind: "electron",
      additionalDeviceTarget: {
        hasPending: () => Promise.resolve(false),
        continue: () => {
          targetCalls += 1;
          return Promise.resolve({
            status: "waiting_for_approval" as const,
            operationId: "device-add-2",
            verificationCode: "ABCDEF-012345-6789AB",
          });
        },
      },
    });
    expect(await client.inspect()).toMatchObject({
      status: "additional_device_required",
      enrollmentStatus: "required",
    });
    expect(targetCalls).toBe(0);
    expect(await client.continueAdditionalDevice?.()).toMatchObject({
      status: "additional_device_required",
      enrollmentStatus: "waiting_for_approval",
      operationId: "device-add-2",
      verificationCode: "ABCDEF-012345-6789AB",
    });
    expect(targetCalls).toBe(1);
    expect(unlockCalls).toBe(2);
  });

  test("routes an existing Human-device group directly to device connection", async () => {
    const setup = fixture();
    setup.deferToExistingDomain();
    let targetCalls = 0;
    const target = {
      hasPending: () => Promise.resolve(false),
      continue: () => {
        targetCalls += 1;
        return Promise.resolve({
          status: "waiting_for_approval" as const,
          operationId: "human-device-add-2",
          verificationCode: "ABCDEF-012345-6789AB",
        });
      },
    };
    const membership = {
      requiresAdditionalDevice: () => Promise.resolve(true),
      ensure: () => Promise.resolve({ status: "additional_required" as const }),
    };
    const client = createLocalInitialDeviceReadinessClient({
      profileVault: setup.profileVault,
      pendingVault: setup.pending,
      bootstrap: {
        begin: () => Promise.reject(new InitialDeviceEnrollmentRequiredError()),
        complete: () => Promise.reject(new Error("must not complete")),
        resolveReceipt: () => Promise.resolve(null),
      },
      initialHumanDomain: setup.initialHumanDomain,
      serverScope: "https://nautilo.test",
      userId: USER_ID,
      humanActorId: HUMAN_ID,
      installationId: "installation-1",
      clientKind: "browser",
      humanDeviceMembership: membership,
      additionalDeviceTarget: target,
    });

    expect(await client.inspect()).toMatchObject({
      status: "additional_device_required",
      enrollmentStatus: "required",
    });
    expect(targetCalls).toBe(0);
    let presentations = 0;
    const result = await client.setup(() => {
      presentations += 1;
      return {
        status: "confirmed" as const,
      };
    });
    expect(result).toMatchObject({
      status: "additional_device_required",
      enrollmentStatus: "waiting_for_approval",
      operationId: "human-device-add-2",
    });
    expect(presentations).toBe(1);
    expect(targetCalls).toBe(1);
    const active = (await setup.profileVault.listPublicProfiles()).find(
      (profile) => profile.lifecycle === "active",
    );
    await setup.profileVault.withOpenProfile(
      active!.coordinates,
      async (profileBytes) => {
        const profile = await authenticateClientDeviceProfileV4({
          crypto: new LatticeCrypto(),
          profileBytes,
          expectedDeviceId: active!.coordinates.deviceId,
        });
        destroyOpenedClientDeviceProfileV4(profile);
      },
    );
  });

  test("treats an existing V1 Domain as non-blocking transitional state", async () => {
    const setup = fixture();
    setup.deferToExistingDomain();
    const result = await setup.create().setup(() => {
      return {
        status: "confirmed",
      };
    });
    expect(result).toMatchObject({
      status: "active",
      encryptionSetup: "v2_personal_authority_ready",
    });
    expect(setup.activationCalls()).toBe(0);
  });

  test("requires explicit local reset when a rebuilt server no longer has the device", async () => {
    const setup = fixture();
    await setup.create().setup(() => {
      return {
        status: "confirmed",
      };
    });
    setup.loseServerIdentity();
    const client = setup.create();
    expect(await client.inspect()).toMatchObject({
      status: "reset_required",
      reason: "server_identity_missing",
    });
    expect(await client.resetLocalSetup()).toMatchObject({
      status: "setup_required",
    });
    expect(await setup.profileVault.listPublicProfiles()).toEqual([]);
  });

  test("requires reset before polling approvals when a device-only profile is stale", async () => {
    const setup = fixture();
    setup.deferToExistingDomain();
    await setup.create().setup(() => {
      return {
        status: "confirmed",
      };
    });
    setup.loseServerIdentity();
    let approverCalls = 0;
    const client = setup.create({
      inspect: () => {
        approverCalls += 1;
        return Promise.resolve([]);
      },
      approve: () => Promise.reject(new Error("must not approve")),
      advance: () => Promise.reject(new Error("must not advance")),
    });
    expect(await client.inspect()).toMatchObject({
      status: "reset_required",
      reason: "server_identity_missing",
    });
    expect(approverCalls).toBe(0);
  });
});
