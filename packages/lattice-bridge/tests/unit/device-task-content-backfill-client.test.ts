import { describe, expect, test } from "bun:test";
import type {
  TaskContentBackfillClaim,
  TaskContentBackfillPublicationPlan,
  TaskContentBackfillPublishRequest,
  TaskContentBackfillSourceResponse,
} from "@nautilo/api-client/browser";
import {
  LatticeCrypto,
  verifyHumanExistingTaskRepresentationPublicationRequest,
} from "@nautilo/lattice-crypto";

import {
  encodeClientDeviceProfileV2,
  type OpenedClientDeviceProfileV2,
} from "../../src/client-vault/profile-v2.ts";
import {
  createClientDeviceProfileV3Candidate,
  destroyOpenedClientDeviceProfileV3,
  encodeClientDeviceProfileV3,
} from "../../src/client-vault/profile-v3.ts";
import {
  createClientDeviceProfileV4Candidate,
  destroyOpenedClientDeviceProfileV4,
  encodeClientDeviceProfileV4,
} from "../../src/client-vault/profile-v4.ts";
import type { ClientProfileCoordinates } from
  "../../src/client-vault/types.ts";
import type { NamespaceAuthorityClient } from
  "../../src/client/message/namespace-authority-client.ts";
import {
  createDeviceTaskContentBackfillClient,
  type DeviceTaskContentBackfillApiPort,
} from "../../src/client/task/device-task-content-backfill-client.ts";
import {
  deriveTaskHistoricalContentCryptoObjectIdV1,
} from "../../src/task/task-historical-content-identity.ts";
import { encodeTaskDefinitionContentV2, encodeTaskRunResultPayloadV1 } from
  "../../src/task/task-payload-v1.ts";
import { MemoryClientProfileVault } from
  "../../src/testing/client-profile-vault.ts";
import {
  bindEncryptionDataOperationOwner,
} from "../../src/transition/encryption-data-operation-owner.ts";

const NOW = 1_800_000_000_000;
const TASK_ID = "10000000-0000-4000-8000-000000000001";
const RUN_ID = "10000000-0000-4000-8000-000000000002";
const CLAIM_ID = "10000000-0000-4000-8000-000000000003";
const USER_ID = "10000000-0000-4000-8000-000000000004";
const HUMAN_ID = "10000000-0000-4000-8000-000000000005";
const ROOM_ID = "10000000-0000-4000-8000-000000000006";
const NAMESPACE_ID = "10000000-0000-4000-8000-000000000007";
const DEVICE_ID = "device.1";
const BINDING_HASH = new Uint8Array(32).fill(0x19);
const NAMESPACE_KEY = new Uint8Array(32).fill(0x48);
const PLAN_DOMAIN = "nautilo/task-content-backfill-publication-plan/v1\n";

function seededRng(seed: number): (length: number) => Uint8Array {
  let state = seed >>> 0;
  return (length) => Uint8Array.from({ length }, () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state & 0xff;
  });
}

function base64url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64url(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "base64url"));
}

function owner(
  mode: "plaintext_only" | "shadow_encryption" | "encrypted_only",
) {
  return bindEncryptionDataOperationOwner({
    policy: {
      resolve: () => Promise.resolve({
        policy: {
          mode,
          shadowBehavior: mode === "shadow_encryption" ? "fallback" : "strict",
        },
        revalidationToken: 1,
      }),
      revalidate: () => Promise.resolve(),
    },
  });
}

function namespaceAuthority(
  ensure: NamespaceAuthorityClient["ensure"] = () =>
    Promise.resolve({ status: "ready" }),
): NamespaceAuthorityClient {
  return {
    ensure,
    synchronizeRecipients: () => Promise.resolve({ status: "ready" }),
    withOpenedAiGenerations: () => {
      throw new Error("Unexpected opened Agent grant");
    },
  };
}

function api(
  overrides: Partial<DeviceTaskContentBackfillApiPort>,
): DeviceTaskContentBackfillApiPort {
  const unexpected = (): never => { throw new Error("Unexpected Task repair API call"); };
  return {
    discoverTaskContentBackfill: unexpected,
    claimTaskContentBackfill: unexpected,
    readTaskContentBackfillSource: unexpected,
    publishTaskContentBackfill: unexpected,
    recoverTaskContentBackfill: unexpected,
    releaseTaskContentBackfill: unexpected,
    acknowledgeTaskContentBackfill: unexpected,
    ...overrides,
  };
}

async function setup() {
  const crypto = new LatticeCrypto({ bytes: seededRng(42) }, { now: () => NOW });
  const signing = crypto.generateSigningKeyPair();
  const encryption = await crypto.generateEncryptionKeyPair();
  const coordinates: ClientProfileCoordinates = Object.freeze({
    serverScope: "https://nautilo.test",
    userId: USER_ID,
    humanActorId: HUMAN_ID,
    profileId: "profile:device.1",
    deviceId: DEVICE_ID,
    installationLineageDigest: "48".repeat(32),
  });
  const profile: OpenedClientDeviceProfileV2 = Object.freeze({
    formatVersion: 2,
    deviceId: DEVICE_ID,
    signingPublicKey: signing.publicKey,
    signingPrivateKey: signing.privateKey,
    encryptionPublicKey: encryption.publicKey,
    encryptionPrivateKey: encryption.privateKey,
    trustedDeviceRevision: 7,
    trustedHostAuthorizationRevision: 11,
    deliveryHighWatermark: 4,
    keyringDeliveries: Object.freeze([Object.freeze({
      deliverySequence: 4,
      operationId: "delivery:4",
      namespaceId: NAMESPACE_ID,
      keyClass: "ai" as const,
      domainId: "domain:1",
      domainEpoch: 3,
      accessRevision: 9,
      bindingHash: BINDING_HASH,
      currentGeneration: 2,
      generations: Object.freeze([
        Object.freeze({ generation: 2, key: NAMESPACE_KEY }),
      ]),
    })]),
  });
  const v2Bytes = encodeClientDeviceProfileV2(profile);
  const v3 = await createClientDeviceProfileV3Candidate({
    crypto,
    currentProfileBytes: v2Bytes,
    expectedDeviceId: DEVICE_ID,
  });
  const v3Bytes = encodeClientDeviceProfileV3(v3);
  const v4 = await createClientDeviceProfileV4Candidate({
    crypto,
    currentProfileBytes: v3Bytes,
    expectedDeviceId: DEVICE_ID,
  });
  const profileBytes = encodeClientDeviceProfileV4(v4);
  destroyOpenedClientDeviceProfileV4(v4);
  destroyOpenedClientDeviceProfileV3(v3);
  v2Bytes.fill(0);
  v3Bytes.fill(0);
  const vault = new MemoryClientProfileVault();
  await vault.unlock();
  await vault.stageProfile({
    coordinates,
    stageId: "stage:1",
    generation: 1,
    profileBytes,
    publicState: {
      clientKind: "browser",
      publicFingerprint: "84".repeat(32),
    },
  });
  await vault.activateProfile(coordinates, "stage:1");
  profileBytes.fill(0);

  const payloadBytes = encodeTaskRunResultPayloadV1({
    formatVersion: 1,
    resultText: "historical result",
    lastError: null,
  });
  const sourceDigest = new Uint8Array(32).fill(0x31);
  const sourcePayloadHash = crypto.hash(payloadBytes);
  const coordinate = Object.freeze({
    kind: "run_result" as const,
    taskId: TASK_ID,
    taskRunId: RUN_ID,
    contentRevision: 1 as const,
  });
  const objectId = deriveTaskHistoricalContentCryptoObjectIdV1({
    coordinate,
    sourceDigest,
    namespaceId: NAMESPACE_ID,
  });
  const unsignedPlan = Object.freeze({
    planVersion: 1 as const,
    claimId: CLAIM_ID,
    operationId: `task-historical-publish:${objectId.split(":").at(-1)!}`,
    coordinate,
    objectId,
    namespaceId: NAMESPACE_ID,
    domainId: "domain:1",
    requesterHumanId: HUMAN_ID,
    deviceId: DEVICE_ID,
    hostAuthorizationRevision: 11,
    expectedAccessRevision: 9,
    expectedPolicyRevision: 3,
    keyGeneration: 2,
    bindingHashBase64url: base64url(BINDING_HASH),
    sourceDigestBase64url: base64url(sourceDigest),
    sourcePayloadHashBase64url: base64url(sourcePayloadHash),
    operationalFieldsDigestBase64url: base64url(new Uint8Array(32).fill(0x52)),
  });
  const plan: TaskContentBackfillPublicationPlan = Object.freeze({
    ...unsignedPlan,
    planDigestBase64url: base64url(crypto.hash(new TextEncoder().encode(
      PLAN_DOMAIN + JSON.stringify(unsignedPlan),
    ))),
    expiresAt: NOW + 50_000,
  });
  const claim: TaskContentBackfillClaim = Object.freeze({
    claimId: CLAIM_ID,
    humanActorId: HUMAN_ID,
    requesterUserId: USER_ID,
    deviceId: DEVICE_ID,
    policyRevision: 3,
    expiresAt: NOW + 60_000,
    candidate: Object.freeze({
      kind: "result",
      taskId: TASK_ID,
      taskRunId: RUN_ID,
      sourceUpdatedAt: NOW - 5_000,
      sourceStartedAt: NOW - 4_000,
      sourceCompletedAt: NOW - 1_000,
      sourceRevision: 0,
      sourceStatus: "completed",
    }),
  });
  const source: TaskContentBackfillSourceResponse = Object.freeze({
    status: "source",
    sourceRoomId: ROOM_ID,
    plan,
    payloadBytesBase64url: base64url(payloadBytes),
  });
  payloadBytes.fill(0);
  sourceDigest.fill(0);
  sourcePayloadHash.fill(0);
  return { crypto, signing, coordinates, vault, claim, source };
}

function definitionFixture(fixture: Awaited<ReturnType<typeof setup>>) {
  const payloadBytes = encodeTaskDefinitionContentV2({
    formatVersion: 2,
    prompt: "historical prompt",
    expectedOutput: null,
    protectedMetadata: {},
    retainedHistoricalError: "provider unavailable",
  });
  const sourceDigest = new Uint8Array(32).fill(0x61);
  const sourcePayloadHash = fixture.crypto.hash(payloadBytes);
  const coordinate = Object.freeze({
    kind: "definition" as const,
    taskId: TASK_ID,
    contentRevision: 1 as const,
  });
  const objectId = deriveTaskHistoricalContentCryptoObjectIdV1({
    coordinate, sourceDigest, namespaceId: NAMESPACE_ID,
  });
  const unsignedPlan = Object.freeze({
    ...fixture.source.plan,
    coordinate,
    objectId,
    operationId: `task-historical-publish:${objectId.split(":").at(-1)!}`,
    sourceDigestBase64url: base64url(sourceDigest),
    sourcePayloadHashBase64url: base64url(sourcePayloadHash),
  });
  const { planDigestBase64url: _oldDigest, expiresAt, ...planCoordinates } = unsignedPlan;
  const plan: TaskContentBackfillPublicationPlan = Object.freeze({
    ...planCoordinates,
    planDigestBase64url: base64url(fixture.crypto.hash(new TextEncoder().encode(
      PLAN_DOMAIN + JSON.stringify(planCoordinates),
    ))),
    expiresAt,
  });
  const claim: TaskContentBackfillClaim = Object.freeze({
    ...fixture.claim,
    candidate: Object.freeze({
      kind: "definition" as const,
      taskId: TASK_ID,
      sourceCreatedAt: NOW - 10_000,
      sourceUpdatedAt: NOW - 5_000,
      sourceRevision: 0 as const,
      sourceStatus: "paused" as const,
    }),
  });
  const source: TaskContentBackfillSourceResponse = Object.freeze({
    status: "source" as const,
    sourceRoomId: ROOM_ID,
    plan,
    payloadBytesBase64url: base64url(payloadBytes),
  });
  payloadBytes.fill(0);
  sourceDigest.fill(0);
  return { claim, source, sourcePayloadHash };
}

function createClient(
  fixture: Awaited<ReturnType<typeof setup>>,
  apiPort: DeviceTaskContentBackfillApiPort,
  namespace = namespaceAuthority(),
  mode: "plaintext_only" | "shadow_encryption" | "encrypted_only" =
    "shadow_encryption",
) {
  return createDeviceTaskContentBackfillClient({
    owner: owner(mode),
    api: apiPort,
    namespaceAuthority: namespace,
    vault: fixture.vault,
    coordinates: fixture.coordinates,
    crypto: fixture.crypto,
    resolveDeviceAdmissionStatus: () => Promise.resolve({
      responseVersion: 1,
      required: true,
      status: "admitted",
      deviceId: DEVICE_ID,
      deviceGeneration: 1,
      expiresAt: NOW + 60_000,
    }),
    now: () => NOW,
  });
}

describe("device Task content backfill client", () => {
  test("keeps Plain and Full inactive before discovery or vault custody", async () => {
    const fixture = await setup();
    for (const mode of ["plaintext_only", "encrypted_only"] as const) {
      let calls = 0;
      const result = await createClient(fixture, api({
        discoverTaskContentBackfill: () => {
          calls += 1;
          throw new Error("inactive mode must not discover");
        },
      }), namespaceAuthority(), mode).runBatch({ signal: new AbortController().signal });
      expect(result).toEqual({ state: "waiting", resumeAt: null });
      expect(calls).toBe(0);
    }
  });

  test("recovers and acknowledges a durable mapping before reading source", async () => {
    const fixture = await setup();
    const calls: string[] = [];
    const result = await createClient(fixture, api({
      discoverTaskContentBackfill: () => Promise.resolve({
        status: "ready",
        value: { status: "claimed", claim: fixture.claim },
      }),
      recoverTaskContentBackfill: () => {
        calls.push("recover");
        return Promise.resolve({ status: "mapped" });
      },
      acknowledgeTaskContentBackfill: ({ outcome }) => {
        calls.push(`ack:${outcome}`);
        return Promise.resolve({ status: "ready", value: "acknowledged" });
      },
    })).runBatch({ signal: new AbortController().signal });
    expect(result).toEqual({ state: "more", resumeAt: NOW });
    expect(calls).toEqual(["recover", "ack:mapped"]);
  });

  test("claims the exact structural candidate before any source request", async () => {
    const fixture = await setup();
    const calls: string[] = [];
    const result = await createClient(fixture, api({
      discoverTaskContentBackfill: () => Promise.resolve({
        status: "ready",
        value: {
          status: "candidate",
          candidate: fixture.claim.candidate,
          policyRevision: fixture.claim.policyRevision,
        },
      }),
      claimTaskContentBackfill: (request) => {
        calls.push("claim");
        expect(request).toEqual({
          candidate: fixture.claim.candidate,
          policyRevision: fixture.claim.policyRevision,
        });
        return Promise.resolve({
          status: "ready",
          value: { status: "claimed", claim: fixture.claim },
        });
      },
      recoverTaskContentBackfill: () => {
        calls.push("recover");
        return Promise.resolve({ status: "mapped" });
      },
      acknowledgeTaskContentBackfill: () => {
        calls.push("acknowledge");
        return Promise.resolve({ status: "ready", value: "acknowledged" });
      },
    })).runBatch({ signal: new AbortController().signal });

    expect(result).toEqual({ state: "more", resumeAt: NOW });
    expect(calls).toEqual(["claim", "recover", "acknowledge"]);
  });

  test("encrypts and signs canonical source only inside current device custody", async () => {
    const fixture = await setup();
    await fixture.vault.lock();
    const unlock = fixture.vault.unlock.bind(fixture.vault);
    let unlocks = 0;
    fixture.vault.unlock = () => {
      unlocks += 1;
      return unlock();
    };
    const calls: string[] = [];
    let upload: TaskContentBackfillPublishRequest | undefined;
    let recoveries = 0;
    const result = await createClient(fixture, api({
      discoverTaskContentBackfill: () => Promise.resolve({
        status: "ready",
        value: { status: "claimed", claim: fixture.claim },
      }),
      recoverTaskContentBackfill: () => {
        recoveries += 1;
        calls.push(`recover:${recoveries}`);
        return Promise.resolve({ status: recoveries === 1 ? "pending" : "mapped" });
      },
      readTaskContentBackfillSource: () => {
        calls.push("source");
        return Promise.resolve(fixture.source);
      },
      publishTaskContentBackfill: (value) => {
        calls.push("publish");
        upload = value;
        return Promise.resolve({ status: "published" });
      },
      acknowledgeTaskContentBackfill: ({ outcome }) => {
        calls.push(`ack:${outcome}`);
        return Promise.resolve({ status: "ready", value: "acknowledged" });
      },
    })).runBatch({ signal: new AbortController().signal });

    expect(calls).toEqual([
      "recover:1", "source", "publish", "recover:2", "ack:mapped",
    ]);
    expect(unlocks).toBe(1);
    expect(result).toEqual({ state: "more", resumeAt: NOW });
    expect(upload).toBeDefined();
    const requestBytes = decodeBase64url(upload!.requestBytesBase64url);
    const request = await verifyHumanExistingTaskRepresentationPublicationRequest(
      fixture.crypto,
      {
        requestBytes,
        now: NOW,
        resolveCurrentAuthority: (current) => Promise.resolve(
          current.claimId === CLAIM_ID ? fixture.signing.publicKey.slice() : null,
        ),
      },
    );
    expect(request).toMatchObject({
      purpose: "task.existing_representation_publish",
      kind: "run_result",
      entityId: RUN_ID,
      taskId: TASK_ID,
      claimId: CLAIM_ID,
      namespaceId: NAMESPACE_ID,
      expectedPolicyRevision: 3,
      keyGeneration: 2,
    });
    expect(upload!.payloadBytesBase64url).not.toContain("historical result");
    requestBytes.fill(0);
  });

  test("publishes canonical V2 historical definition content without reducing it to V1", async () => {
    const fixture = await setup();
    const definition = definitionFixture(fixture);
    let upload: TaskContentBackfillPublishRequest | undefined;
    let recoveries = 0;
    const result = await createClient(fixture, api({
      discoverTaskContentBackfill: () => Promise.resolve({
        status: "ready", value: { status: "claimed", claim: definition.claim },
      }),
      recoverTaskContentBackfill: () => Promise.resolve({
        status: ++recoveries === 1 ? "pending" : "mapped",
      }),
      readTaskContentBackfillSource: () => Promise.resolve(definition.source),
      publishTaskContentBackfill: (value) => {
        upload = value;
        return Promise.resolve({ status: "published" });
      },
      acknowledgeTaskContentBackfill: () => Promise.resolve({
        status: "ready", value: "acknowledged",
      }),
    })).runBatch({ signal: new AbortController().signal });
    expect(result).toEqual({ state: "more", resumeAt: NOW });
    expect(upload).toBeDefined();
    const requestBytes = decodeBase64url(upload!.requestBytesBase64url);
    const request = await verifyHumanExistingTaskRepresentationPublicationRequest(
      fixture.crypto,
      { requestBytes, now: NOW, resolveCurrentAuthority: () =>
        Promise.resolve(fixture.signing.publicKey.slice()) },
    );
    expect(request).toMatchObject({
      kind: "definition",
      entityId: TASK_ID,
      taskId: TASK_ID,
      sourcePayloadHash: definition.sourcePayloadHash,
    });
    requestBytes.fill(0);
    definition.sourcePayloadHash.fill(0);
  });

  test("releases a temporary Namespace-authority failure without permanent acknowledgement", async () => {
    const fixture = await setup();
    const outcomes: string[] = [];
    const result = await createClient(fixture, api({
      discoverTaskContentBackfill: () => Promise.resolve({
        status: "ready",
        value: { status: "claimed", claim: fixture.claim },
      }),
      recoverTaskContentBackfill: () => Promise.resolve({ status: "pending" }),
      readTaskContentBackfillSource: () => Promise.resolve(fixture.source),
      releaseTaskContentBackfill: ({ advance }) => {
        outcomes.push(`release:${advance}`);
        return Promise.resolve({ status: "ready", value: true });
      },
      acknowledgeTaskContentBackfill: ({ outcome }) => {
        outcomes.push(`ack:${outcome}`);
        return Promise.resolve({ status: "ready", value: "acknowledged" });
      },
    }), namespaceAuthority(() => Promise.resolve({
      status: "unavailable",
      reason: "key delivery pending",
    }))).runBatch({ signal: new AbortController().signal });

    expect(result).toEqual({ state: "waiting", resumeAt: fixture.claim.expiresAt });
    expect(outcomes).toEqual(["release:false"]);
  });

  test("defers when populated profile storage is lost without attempting unlock", async () => {
    const fixture = await setup();
    let unlocks = 0;
    fixture.vault.availability = () => Promise.resolve({ status: "storage_lost" });
    fixture.vault.unlock = () => {
      unlocks += 1;
      return Promise.resolve({ status: "available" });
    };
    const outcomes: string[] = [];
    const result = await createClient(fixture, api({
      discoverTaskContentBackfill: () => Promise.resolve({
        status: "ready",
        value: { status: "claimed", claim: fixture.claim },
      }),
      recoverTaskContentBackfill: () => Promise.resolve({ status: "pending" }),
      readTaskContentBackfillSource: () => Promise.resolve(fixture.source),
      releaseTaskContentBackfill: ({ advance }) => {
        outcomes.push(`release:${advance}`);
        return Promise.resolve({ status: "ready", value: true });
      },
    })).runBatch({ signal: new AbortController().signal });

    expect(result).toEqual({ state: "waiting", resumeAt: fixture.claim.expiresAt });
    expect(unlocks).toBe(0);
    expect(outcomes).toEqual(["release:false"]);
  });

  test("rejects noncanonical source bytes as integrity without publishing", async () => {
    const fixture = await setup();
    if (fixture.source.status !== "source") throw new Error("Expected source fixture");
    const outcomes: string[] = [];
    const result = await createClient(fixture, api({
      discoverTaskContentBackfill: () => Promise.resolve({
        status: "ready",
        value: { status: "claimed", claim: fixture.claim },
      }),
      recoverTaskContentBackfill: () => Promise.resolve({ status: "pending" }),
      readTaskContentBackfillSource: () => Promise.resolve({
        ...fixture.source,
        payloadBytesBase64url: base64url(new TextEncoder().encode("{}")),
      }),
      publishTaskContentBackfill: () => {
        outcomes.push("publish");
        return Promise.resolve({ status: "published" });
      },
      acknowledgeTaskContentBackfill: ({ outcome }) => {
        outcomes.push(`ack:${outcome}`);
        return Promise.resolve({ status: "ready", value: "acknowledged" });
      },
    })).runBatch({ signal: new AbortController().signal });

    expect(result).toEqual({ state: "more", resumeAt: NOW });
    expect(outcomes).toEqual(["ack:integrity"]);
  });
});
