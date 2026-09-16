import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  humanId,
} from "@nautilo/lattice-crypto";
import {
  deviceTransferInventoryDigestV2,
  deviceTransferInventoryRevisionV2,
} from "@nautilo/lattice-crypto/wire";
import type {
  ProtectedAdditionalDevicePlanV2,
} from "@nautilo/api-client/browser";

import {
  createClientDeviceProfileV4Candidate,
  destroyOpenedClientDeviceProfileV4,
  encodeClientDeviceProfileV4,
} from "../../src/client-vault/profile-v4.ts";
import { encodeClientDeviceProfileV1 } from
  "../../src/client-vault/profile-v2.ts";
import type {
  ClientProfileCoordinates,
} from "../../src/client-vault/types.ts";
import {
  createAdditionalDeviceApproverClient,
  createAdditionalDeviceTargetClient,
  createProfileVaultPendingAdditionalDeviceStateVault,
  deriveAdditionalDeviceClientIdentity,
  type AdditionalDeviceClientApiPort,
} from "../../src/device/additional-device-client.ts";
import type {
  AdditionalDeviceTransitionCampaignVault,
} from "../../src/device/additional-device-transition-journal.ts";
import {
  chunkOpaqueDeliveryArtifact,
  serializeOpaqueDeliveryArtifactChunk,
} from "../../src/delivery/opaque-artifact.ts";
import type {
  PreparedMutationJournalIndex,
} from "../../src/client/memory/prepared-mutation-journal.ts";
import { MemoryClientProfileVault } from
  "../../src/testing/client-profile-vault.ts";

const USER_ID = "10000000-0000-4000-8000-000000000301";
const HUMAN_ID = "20000000-0000-4000-8000-000000000301";
const SERVER_SCOPE = "https://m300.test";
const NOW = 10_000;

class MemoryCampaignVault implements AdditionalDeviceTransitionCampaignVault {
  readonly #records = new Map<string, Readonly<{
    index: PreparedMutationJournalIndex;
    body: Uint8Array;
  }>>();

  unlock() {
    return Promise.resolve({ status: "available" as const });
  }

  putSealed(input: Readonly<{
    index: PreparedMutationJournalIndex;
    canonicalBody: Uint8Array;
  }>) {
    const existing = this.#records.get(input.index.operationId);
    if (existing !== undefined) {
      return Promise.resolve(
        existing.index.authenticatedRequestDigestBase64url
            === input.index.authenticatedRequestDigestBase64url
          ? "exact_duplicate" as const
          : "collision" as const,
      );
    }
    this.#records.set(input.index.operationId, Object.freeze({
      index: Object.freeze({ ...input.index }),
      body: input.canonicalBody.slice(),
    }));
    return Promise.resolve("inserted" as const);
  }

  listIndexes() {
    return Promise.resolve(Object.freeze(
      [...this.#records.values()].map((record) => record.index),
    ));
  }

  async withOpenedBody<Result>(
    operationId: string,
    digest: string,
    use: (bytes: Uint8Array) => Promise<Result> | Result,
  ): Promise<Result> {
    const record = this.#records.get(operationId);
    if (
      record === undefined
      || record.index.authenticatedRequestDigestBase64url !== digest
    ) throw new Error("campaign unavailable");
    const owned = record.body.slice();
    try {
      return await use(owned);
    } finally {
      owned.fill(0);
    }
  }

  updateIndex(
    expected: PreparedMutationJournalIndex,
    replacement: PreparedMutationJournalIndex,
  ) {
    const current = this.#records.get(expected.operationId);
    if (current === undefined || JSON.stringify(current.index) !== JSON.stringify(expected)) {
      return Promise.resolve(false);
    }
    this.#records.set(expected.operationId, Object.freeze({
      index: Object.freeze({ ...replacement }),
      body: current.body,
    }));
    return Promise.resolve(true);
  }

  removeExact(operationId: string, digest: string) {
    const current = this.#records.get(operationId);
    if (
      current === undefined
      || current.index.authenticatedRequestDigestBase64url !== digest
    ) return Promise.resolve(false);
    this.#records.delete(operationId);
    current.body.fill(0);
    return Promise.resolve(true);
  }
}

function encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function seedApproverProfile(input: Readonly<{
  crypto: LatticeCrypto;
  coordinates: ClientProfileCoordinates;
  clientKind: "browser" | "electron";
}>): Promise<Readonly<{
  vault: MemoryClientProfileVault;
  signingPublicKey: Uint8Array;
}>> {
  const signing = input.crypto.generateSigningKeyPair();
  const encryption = await input.crypto.generateEncryptionKeyPair();
  const v1 = encodeClientDeviceProfileV1({
    deviceId: input.coordinates.deviceId,
    signingPublicKey: signing.publicKey,
    signingPrivateKey: signing.privateKey,
    encryptionPublicKey: encryption.publicKey,
    encryptionPrivateKey: encryption.privateKey,
  });
  const profile = await createClientDeviceProfileV4Candidate({
    crypto: input.crypto,
    currentProfileBytes: v1,
    expectedDeviceId: input.coordinates.deviceId,
    v1Migration: {
      trustedDeviceRevision: 1,
      trustedHostAuthorizationRevision: 1,
      deliveryHighWatermark: 0,
    },
  });
  const bytes = encodeClientDeviceProfileV4(profile);
  const vault = new MemoryClientProfileVault();
  await vault.unlock();
  await vault.stageProfile({
    coordinates: input.coordinates,
    stageId: "initial",
    generation: 1,
    profileBytes: bytes,
    publicState: {
      clientKind: input.clientKind,
      publicFingerprint: "ab".repeat(32),
    },
  });
  await vault.activateProfile(input.coordinates, "initial");
  const publicKey = signing.publicKey.slice();
  destroyOpenedClientDeviceProfileV4(profile);
  bytes.fill(0);
  v1.fill(0);
  signing.privateKey.fill(0);
  encryption.privateKey.fill(0);
  return Object.freeze({ vault, signingPublicKey: publicKey });
}

function emptyInventoryServer(input: Readonly<{
  crypto: LatticeCrypto;
  approverCoordinates: ClientProfileCoordinates;
  approverSigningPublicKey: Uint8Array;
  loseFirstSubmitResponse?: boolean;
  loseFirstActivationResponse?: boolean;
  rejectPlanRefreshAfterSubmit?: boolean;
  rejectActivationBeforeApproval?: boolean;
  personalAuthority?: ProtectedAdditionalDevicePlanV2["personalAuthority"];
  now?(): number;
}>) {
  let enrollment: Awaited<ReturnType<
    AdditionalDeviceClientApiPort["beginProtectedAdditionalDeviceV2"]
  >>["enrollment"] | undefined;
  let approvalBytes: Uint8Array | undefined;
  let approved = false;
  let submitted = false;
  let submitResponseLost = false;
  let activationResponseLost = false;
  let activationCommitted = false;
  let acknowledged = 0;
  let beginCount = 0;
  let deliveries: Array<{
    messageId: string;
    operationId: string;
    domainId: null;
    recipientSequence: number;
    kind: "device_transfer" | "public_state";
    formatVersion: 1;
    payloadHashBase64url: string;
    payloadBytesBase64url: string;
    createdAt: number;
    expiresAt: number;
  }> = [];
  const inventoryDigestBase64url = encode(deviceTransferInventoryDigestV2({
    humanId: humanId(HUMAN_ID),
    inventoryRevision: deviceTransferInventoryRevisionV2(1),
    inventory: [],
  }));
  const authorizationEvidenceDigestBase64url = encode(
    input.crypto.hash(new Uint8Array([1])),
  );
  const authorizationDigestBase64url = encode(
    input.crypto.hash(new Uint8Array([2])),
  );

  const plan = (
    progress?: "approval_required" | "transfer_ready" | "awaiting_target",
  ): ProtectedAdditionalDevicePlanV2 => {
    if (enrollment === undefined) throw new Error("enrollment absent");
    const approver = {
      deviceId: input.approverCoordinates.deviceId,
      signingPublicKeyBase64url: encode(input.approverSigningPublicKey),
    };
    const binding = new TextEncoder().encode(JSON.stringify({
      operationId: enrollment.operationId,
      targetDeviceId: enrollment.deviceId,
      inventoryRevision: enrollment.inventoryRevision,
      inventoryCount: enrollment.inventoryCount,
      inventoryDigestBase64url: enrollment.inventoryDigestBase64url,
      domainCount: 0,
      approver,
      personalAuthority: input.personalAuthority ?? null,
      start: 0,
      end: 0,
      domains: [],
    }));
    try {
      return {
        formatVersion: 2 as const,
        ...(progress === undefined ? {} : { progress }),
        enrollment,
        approver,
        personalAuthority: input.personalAuthority ?? null,
        domainCount: 0,
        page: {
          start: 0,
          end: 0,
          nextStart: null,
          pageDigestBase64url: encode(input.crypto.hash(binding)),
        },
        domains: [],
      };
    } finally {
      binding.fill(0);
    }
  };

  const api: AdditionalDeviceClientApiPort = {
    beginProtectedAdditionalDeviceV2(request) {
      beginCount += 1;
      if (submitted && input.rejectPlanRefreshAfterSubmit === true) {
        return Promise.reject(new Error("additional_device_inventory_stale"));
      }
      const issuedAt = input.now?.() ?? NOW;
      if (enrollment === undefined || enrollment.expiresAt <= issuedAt) {
        enrollment = Object.freeze({
        formatVersion: 1 as const,
        operationId: "operation-co-enrollment",
        challengeId: "challenge-co-enrollment",
        userId: USER_ID,
        humanActorId: HUMAN_ID,
        deviceId: request.deviceId,
        clientKind: request.clientKind,
        installationLineageDigestBase64url:
          request.installationLineageDigestBase64url,
        deviceGeneration: 1 as const,
        signingPublicKeyBase64url: request.signingPublicKeyBase64url,
        encryptionPublicKeyBase64url: request.encryptionPublicKeyBase64url,
        method: "device_approval" as const,
        idempotencyKey: request.idempotencyKey,
        authorizationEvidenceDigestBase64url,
        authorizationDigestBase64url,
        expectedCustodyRevision: 1,
        expectedRecoveryGeneration: 1,
        inventoryRevision: 1,
        inventoryCount: 0,
        inventoryDigestBase64url,
        deviceRevision: 0 as const,
        status: "pending" as const,
          issuedAt,
          expiresAt: issuedAt + 300_000,
        });
      }
      return Promise.resolve(plan());
    },
    loadProtectedAdditionalDevicePlanPageV2() {
      return Promise.resolve(plan());
    },
    listProtectedAdditionalDevicePendingV2() {
      return Promise.resolve({
        formatVersion: 2 as const,
        pending: enrollment === undefined || submitted
          ? []
          : [plan(approved ? "transfer_ready" : "approval_required")],
      });
    },
    publishProtectedAdditionalDeviceJoinPackagesV2(_operationId, request) {
      if (activationCommitted) {
        return Promise.reject(new Error("device already active"));
      }
      if (!approved || request.packages.length !== 0) {
        return Promise.reject(new Error("approval required"));
      }
      return Promise.resolve({ status: "duplicate" as const });
    },
    approveProtectedAdditionalDevice(operationId, request) {
      approvalBytes?.fill(0);
      approvalBytes = Uint8Array.from(
        Buffer.from(request.approvalBytesBase64url, "base64url"),
      );
      approved = true;
      return Promise.resolve({
        formatVersion: 1 as const,
        status: "admitted" as const,
        operationId,
        targetDeviceId: enrollment!.deviceId,
        completedDomains: 0,
        requiredDomains: 0,
      });
    },
    planProtectedAdditionalDeviceTransitionsV2(operationId) {
      return Promise.resolve({
        formatVersion: 2 as const,
        operationId,
        targetDeviceId: enrollment!.deviceId,
        domainCount: 0,
        page: {
          start: 0,
          end: 0,
          nextStart: null,
          pageDigestBase64url: "C".repeat(43),
        },
        domains: [],
      });
    },
    submitProtectedAdditionalDeviceTransitionsV2(operationId, request) {
      if (request.transitions.length !== 0 || approvalBytes === undefined) {
        return Promise.reject(new Error("transition campaign invalid"));
      }
      if (!submitted) {
        deliveries = chunkOpaqueDeliveryArtifact({
          crypto: input.crypto,
          kind: "device_transfer",
          operationId,
          recipientDeviceId: enrollment!.deviceId,
          artifactBytes: approvalBytes,
        }).map((chunk, index) => {
          const payloadBytes = serializeOpaqueDeliveryArtifactChunk(
            chunk,
            input.crypto,
          );
          return {
            messageId: `delivery-${index}`,
            operationId,
            domainId: null,
            recipientSequence: index + 1,
            kind: "device_transfer" as const,
            formatVersion: 1 as const,
            payloadHashBase64url: encode(input.crypto.hash(payloadBytes)),
            payloadBytesBase64url: encode(payloadBytes),
            createdAt: NOW,
            expiresAt: NOW + 300_000,
          };
        });
        submitted = true;
      }
      if (input.loseFirstSubmitResponse === true && !submitResponseLost) {
        submitResponseLost = true;
        return Promise.reject(new Error("simulated response loss"));
      }
      return Promise.resolve({
        formatVersion: 1 as const,
        status: "syncing" as const,
        operationId,
        targetDeviceId: enrollment!.deviceId,
        completedDomains: 0,
        requiredDomains: 0,
      });
    },
    loadProtectedAdditionalDeviceDeliveries(operationId) {
      if (!submitted) {
        const payloadBytes = new Uint8Array([1]);
        return Promise.resolve({
          formatVersion: 1 as const,
          operationId,
          deviceId: enrollment!.deviceId,
          highWatermark: 1,
          messages: [{
            messageId: "public-state-before-committer",
            operationId,
            domainId: null,
            recipientSequence: 1,
            kind: "public_state" as const,
            formatVersion: 1 as const,
            payloadHashBase64url: encode(input.crypto.hash(payloadBytes)),
            payloadBytesBase64url: encode(payloadBytes),
            createdAt: NOW,
            expiresAt: NOW + 300_000,
          }],
        });
      }
      return Promise.resolve({
        formatVersion: 1 as const,
        operationId,
        deviceId: enrollment!.deviceId,
        highWatermark: deliveries.at(-1)?.recipientSequence ?? 0,
        messages: deliveries,
      });
    },
    acknowledgeProtectedAdditionalDeviceDelivery() {
      acknowledged += 1;
      return Promise.resolve({ status: "acknowledged" as const });
    },
    activateProtectedAdditionalDevice(operationId) {
      const active = submitted && acknowledged === deliveries.length;
      if (!approved && input.rejectActivationBeforeApproval === true) {
        return Promise.reject(
          new Error("additional_device_activation_unavailable"),
        );
      }
      if (
        active
        && input.loseFirstActivationResponse === true
        && !activationResponseLost
      ) {
        activationCommitted = true;
        activationResponseLost = true;
        return Promise.reject(new Error("simulated activation response loss"));
      }
      activationCommitted ||= active;
      return Promise.resolve({
        formatVersion: 1 as const,
        status: active ? "active" as const : "syncing" as const,
        ...(!active ? { syncReason: "delivery_pending" as const } : {}),
        operationId,
        deviceId: enrollment!.deviceId,
        deviceRevision: active ? 1 : 0,
        custodyRevision: active ? 2 : 1,
      });
    },
  };
  return Object.freeze({
    api,
    getEnrollment: () => enrollment,
    getBeginCount: () => beginCount,
  });
}

async function proveDirection(input: Readonly<{
  approverKind: "browser" | "electron";
  targetKind: "browser" | "electron";
  loseFirstSubmitResponse?: boolean;
  loseFirstActivationResponse?: boolean;
  expireBeforeApproval?: boolean;
  rejectPlanRefreshAfterSubmit?: boolean;
  rejectActivationBeforeApproval?: boolean;
  personalAuthorityCatchUp?: boolean;
}>): Promise<void> {
  let currentNow = NOW;
  const crypto = new LatticeCrypto();
  const approverIdentity = deriveAdditionalDeviceClientIdentity({
    crypto,
    serverScope: SERVER_SCOPE,
    userId: USER_ID,
    humanActorId: HUMAN_ID,
    installationId: `installation-${input.approverKind}-approver`,
    clientKind: input.approverKind,
  });
  const targetIdentity = deriveAdditionalDeviceClientIdentity({
    crypto,
    serverScope: SERVER_SCOPE,
    userId: USER_ID,
    humanActorId: HUMAN_ID,
    installationId: `installation-${input.targetKind}-target`,
    clientKind: input.targetKind,
  });
  const approverProfile = await seedApproverProfile({
    crypto,
    coordinates: approverIdentity.coordinates,
    clientKind: input.approverKind,
  });
  const targetProfileVault = new MemoryClientProfileVault();
  await targetProfileVault.unlock();
  const server = emptyInventoryServer({
    crypto,
    approverCoordinates: approverIdentity.coordinates,
    approverSigningPublicKey: approverProfile.signingPublicKey,
    now: () => currentNow,
    ...(input.loseFirstSubmitResponse === undefined
      ? {}
      : { loseFirstSubmitResponse: input.loseFirstSubmitResponse }),
    ...(input.loseFirstActivationResponse === undefined
      ? {}
      : { loseFirstActivationResponse: input.loseFirstActivationResponse }),
    ...(input.rejectPlanRefreshAfterSubmit === undefined
      ? {}
      : { rejectPlanRefreshAfterSubmit: input.rejectPlanRefreshAfterSubmit }),
    ...(input.rejectActivationBeforeApproval === undefined
      ? {}
      : { rejectActivationBeforeApproval: input.rejectActivationBeforeApproval }),
    ...(input.personalAuthorityCatchUp === true ? {
      personalAuthority: {
        roomId: "00000000-0000-4000-8000-000000000083",
        namespaceId: "00000000-0000-4000-8000-000000000084",
      },
    } : {}),
  });
  const targetPendingVault = createProfileVaultPendingAdditionalDeviceStateVault({
    vault: targetProfileVault,
    coordinates: targetIdentity.coordinates,
    clientKind: input.targetKind,
    crypto,
  });
  const targetCampaignVault = new MemoryCampaignVault();
  const approverCampaignVault = new MemoryCampaignVault();
  let personalAuthorityAttempts = 0;
  const targetInput = {
    api: server.api,
    vault: targetPendingVault,
    profileVault: targetProfileVault,
    serverScope: SERVER_SCOPE,
    userId: USER_ID,
    humanActorId: HUMAN_ID,
    deviceId: targetIdentity.coordinates.deviceId,
    clientKind: input.targetKind,
    installationLineageDigest: targetIdentity.installationLineageDigest,
    idempotencyKey: targetIdentity.idempotencyKey,
    transitionCampaignVault: targetCampaignVault,
    ...(input.personalAuthorityCatchUp === true ? {
      personalAuthority: {
        ensure: (anchor: Readonly<{ roomId: string; namespaceId: string }>) => {
          expect(anchor).toEqual({
            roomId: "00000000-0000-4000-8000-000000000083",
            namespaceId: "00000000-0000-4000-8000-000000000084",
          });
          personalAuthorityAttempts += 1;
          return Promise.resolve(Object.freeze({
            status: personalAuthorityAttempts === 1
              ? "pending" as const
              : "ready" as const,
          }));
        },
      },
    } : {}),
    crypto,
    now: () => currentNow,
  } as const;
  const approverInput = {
    api: server.api,
    profileVault: approverProfile.vault,
    coordinates: approverIdentity.coordinates,
    transitionCampaignVault: approverCampaignVault,
    crypto,
    now: () => NOW,
  } as const;

  let target = createAdditionalDeviceTargetClient(targetInput);
  expect(await target.continue()).toMatchObject({
    status: "waiting_for_approval",
  });
  if (input.expireBeforeApproval === true) {
    currentNow += 300_001;
    target = createAdditionalDeviceTargetClient(targetInput);
    expect(await target.continue()).toMatchObject({
      status: "waiting_for_approval",
    });
    expect(server.getBeginCount()).toBe(2);
  }
  const operationId = server.getEnrollment()!.operationId;
  let approver = createAdditionalDeviceApproverClient(approverInput);
  const [candidate] = await approver.inspect();
  expect(candidate).toMatchObject({
    enrollment: {
      operationId,
      clientKind: input.targetKind,
    },
    progress: "approval_required",
  });
  expect(candidate?.verificationCode).toBeDefined();
  expect(await approver.approve(
    operationId,
    candidate!.verificationCode!,
  )).toMatchObject({
    status: "transition_ready",
    operationId,
  });

  // Approval admits the pending device, but the existing device has not yet
  // committed the Domain transition. A public-state delivery may already be
  // visible; the target must wait rather than treating that partial delivery
  // set as a corrupt device transfer.
  expect(await target.continue()).toMatchObject({
    status: "syncing",
    operationId,
    syncReason: "delivery_pending",
  });

  // Recreate both clients over the same durable vaults before either side
  // advances, proving that the approval journey does not depend on process
  // memory or on which platform initiated it.
  target = createAdditionalDeviceTargetClient(targetInput);
  approver = createAdditionalDeviceApproverClient(approverInput);
  expect(await target.inspectPending()).toMatchObject({
    status: "waiting_for_approval",
    operationId,
  });
  if (input.loseFirstSubmitResponse === true) {
    let lostResponse: unknown;
    try {
      await approver.advance(operationId);
    } catch (error) {
      lostResponse = error;
    }
    expect(lostResponse instanceof Error ? lostResponse.message : null)
      .toBe("simulated response loss");
    approver = createAdditionalDeviceApproverClient(approverInput);
    const resumed = (await approver.inspect()).find((entry) =>
      entry.enrollment.operationId === operationId
    );
    expect(resumed).toMatchObject({
      enrollment: { operationId },
      progress: "transfer_ready",
    });
  }
  await approver.advance(operationId);
  if (input.loseFirstActivationResponse === true) {
    expect(target.continue()).rejects.toThrow(
      "simulated activation response loss",
    );
    target = createAdditionalDeviceTargetClient(targetInput);
  }
  if (input.personalAuthorityCatchUp === true) {
    expect(await target.continue()).toMatchObject({
      status: "syncing",
      operationId,
      syncReason: "personal_authority_required",
    });
    expect(await target.inspectPending()).toMatchObject({
      status: "syncing",
      operationId,
      syncReason: "personal_authority_required",
    });
    target = createAdditionalDeviceTargetClient(targetInput);
  }
  expect(await target.continue()).toMatchObject({
    status: "active",
    operationId,
    deviceRevision: 1,
  });
  const targetProfiles = await targetProfileVault.listPublicProfiles();
  expect(targetProfiles).toHaveLength(1);
  expect(targetProfiles[0]).toMatchObject({
    lifecycle: "active",
    generation: 2,
    coordinates: { deviceId: targetIdentity.coordinates.deviceId },
  });
  const approverProfiles = await approverProfile.vault.listPublicProfiles();
  expect(approverProfiles).toHaveLength(1);
  expect(approverProfiles[0]).toMatchObject({
    lifecycle: "active",
    generation: 3,
    coordinates: { deviceId: approverIdentity.coordinates.deviceId },
  });
  expect(await target.inspectPending()).toBeNull();

  approverProfile.signingPublicKey.fill(0);
  approverIdentity.installationLineageDigest.fill(0);
  targetIdentity.installationLineageDigest.fill(0);
}

describe("Browser/Desktop additional-device co-enrollment", () => {
  test("Browser first connects Desktop through one restart-safe campaign", () =>
    proveDirection({ approverKind: "browser", targetKind: "electron" }));

  test("Desktop first connects Browser through the same protocol", () =>
    proveDirection({ approverKind: "electron", targetKind: "browser" }));

  test("Browser connects another Browser without a pair-specific protocol", () =>
    proveDirection({ approverKind: "browser", targetKind: "browser" }));

  test("Desktop connects another Desktop without a pair-specific protocol", () =>
    proveDirection({ approverKind: "electron", targetKind: "electron" }));

  test("resumes the exact sealed campaign after a committed response is lost", () =>
    proveDirection({
      approverKind: "browser",
      targetKind: "electron",
      loseFirstSubmitResponse: true,
    }));

  test("finishes local cleanup after the activation response is lost", () =>
    proveDirection({
      approverKind: "browser",
      targetKind: "electron",
      loseFirstActivationResponse: true,
    }));

  test("resumes from the frozen target plan after populated heads advance", () =>
    proveDirection({
      approverKind: "browser",
      targetKind: "electron",
      rejectPlanRefreshAfterSubmit: true,
    }));

  test("treats production's pre-approval activation rejection as pending", () =>
    proveDirection({
      approverKind: "electron",
      targetKind: "browser",
      rejectActivationBeforeApproval: true,
    }));

  test("refreshes an expired pristine empty-inventory comparison challenge", () =>
    proveDirection({
      approverKind: "browser",
      targetKind: "electron",
      expireBeforeApproval: true,
    }));

  test("keeps connection syncing until the personal Domain authority is cached", () =>
    proveDirection({
      approverKind: "browser",
      targetKind: "electron",
      personalAuthorityCatchUp: true,
    }));
});
