import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type {
  ProcessorCredentialClaim,
} from "@nautilo/lattice-crypto";

import {
  attachBackgroundAuthorizationRecipient,
  claimBackgroundAuthorizationRequest,
  completeBackgroundAuthorizationRequest,
  createBackgroundAuthorizationRequest,
  markBackgroundAuthorizationGrantReady,
  markBackgroundAuthorizationPublicationReconciliation,
  markBackgroundAuthorizationRunning,
} from "../../src/protected-execution/background-authorization/lifecycle";
import {
  BackgroundAuthorizationProcessorCredentialClaimPort,
  ProcessorCredentialClaimError,
} from "../../src/protected-execution/background-authorization/processor-credential-claim-port";
import {
  InMemoryBackgroundAuthorizationRepository,
  type BackgroundAuthorizationRecord,
  type BackgroundAuthorizationRepository,
} from "../../src/protected-execution/background-authorization/repository";

const START = 1_700_000_000_000;
const CLAIMED_AT = START + 4;
const CLAIM_ID = "claim_request_1";
const CREDENTIAL_ID = "credential_device_alice";
const IDEMPOTENCY_ID = "idempotency_request_1";
const DESCRIPTOR_BYTES = new Uint8Array([1, 2, 3]);
const CREDENTIAL_BYTES = new TextEncoder().encode("credential:device_alice");

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function grantReadyRecord(): BackgroundAuthorizationRecord {
  const requested = createBackgroundAuthorizationRequest({
    requestId: "request_1",
    workId: "work_request_1",
    namespaceId: "namespace_room_1",
    credentialSubject: {
      kind: "processor",
      processorKind: "stenographer",
      processorVersion: 1,
      authorizationRevision: 7,
    },
    now: START,
  });
  const awaitingDevice = attachBackgroundAuthorizationRecipient(requested, {
    descriptorDigest: digest(DESCRIPTOR_BYTES),
    recipientKeyId: "recipient_request_1",
    recipientPublicKey:
      Buffer.from(new Uint8Array(65).fill(0x42)).toString("base64url"),
    expiresAt: START + 300_000,
    now: START + 1,
  });
  const grantReady = markBackgroundAuthorizationGrantReady(awaitingDevice, {
    kind: "processor",
    requestId: awaitingDevice.requestId,
    descriptorDigest: awaitingDevice.descriptorDigest!,
    recipientKeyId: awaitingDevice.recipient!.recipientKeyId,
    recipientPublicKey: awaitingDevice.recipient!.recipientPublicKey,
    expiresAt: awaitingDevice.recipient!.expiresAt,
    responseDigest: digest(new TextEncoder().encode("response")),
    credentialDigest: digest(CREDENTIAL_BYTES),
    issuingHumanId: "human_alice",
    issuingDeviceId: "device_alice",
    recipientGeneration: awaitingDevice.recipientGeneration,
    now: START + 2,
  });
  return {
    snapshot: grantReady,
    workIdentityHash: new Uint8Array(32).fill(0x21),
    idempotencyKey: IDEMPOTENCY_ID,
    workKind: "stenographer.extraction",
    purpose: "journal.extract",
    domainId: "domain_alice_bob",
    processorAuthorizationRevision: 7,
    expectedDomainEpoch: 9,
    expectedNamespaceAccessRevision: 4,
    expectedPolicyRevision: 3,
    descriptorBytes: DESCRIPTOR_BYTES,
    acceptedMaterial: {
      responseBytes: new TextEncoder().encode("response"),
      credentialId: CREDENTIAL_ID,
      issuingDeviceAuthorizationRevision: 11,
      issuerSigningPublicKeyHash: new Uint8Array(32).fill(0x33),
      authorizationExpiresAt: START + 300_000,
    },
    finishedAt: null,
  };
}

function claimedRecord(): BackgroundAuthorizationRecord {
  const record = grantReadyRecord();
  return {
    ...record,
    snapshot: claimBackgroundAuthorizationRequest(
      record.snapshot,
      CLAIM_ID,
      START + 3,
      START + 60_000,
    ),
  };
}

function exactClaim(
  signal = new AbortController().signal,
): ProcessorCredentialClaim {
  return {
    credentialId: CREDENTIAL_ID,
    credentialHash: bytes(digest(CREDENTIAL_BYTES)),
    workDescriptorHash: bytes(digest(DESCRIPTOR_BYTES)),
    requestId: "request_1",
    claimId: CLAIM_ID,
    recipientGeneration: 0,
    idempotencyId: IDEMPOTENCY_ID,
    claimedAt: CLAIMED_AT,
    signal,
  };
}

async function stored(
  repository: BackgroundAuthorizationRepository,
): Promise<BackgroundAuthorizationRecord> {
  const value = await repository.get("request_1");
  if (value === null) throw new Error("missing test record");
  return value;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected promise to reject");
}

async function seeded(): Promise<Readonly<{
  repository: InMemoryBackgroundAuthorizationRepository;
  port: BackgroundAuthorizationProcessorCredentialClaimPort;
}>> {
  const repository = new InMemoryBackgroundAuthorizationRepository();
  await repository.create(claimedRecord());
  return {
    repository,
    port: new BackgroundAuthorizationProcessorCredentialClaimPort(repository),
  };
}

describe("BackgroundAuthorizationProcessorCredentialClaimPort", () => {
  test("atomically binds the exact durable claim and advances claimed to running", async () => {
    const { repository, port } = await seeded();

    expect(await port.claimExactCredential(exactClaim())).toBe("claimed");
    expect((await stored(repository)).snapshot.state).toBe("running");
  });

  test("returns already_claimed only for an exact replay while claim identity is retained", async () => {
    const { repository, port } = await seeded();
    expect(await port.claimExactCredential(exactClaim())).toBe("claimed");
    expect(await port.claimExactCredential(exactClaim())).toBe(
      "already_claimed",
    );

    const running = await stored(repository);
    const reconciling = {
      ...running,
      snapshot: markBackgroundAuthorizationPublicationReconciliation(
        running.snapshot,
        CLAIMED_AT + 1,
      ),
    };
    expect((await repository.compareAndSwap({
      expectedRequestRevision: running.snapshot.requestRevision,
      next: reconciling,
    })).status).toBe("updated");
    expect(await rejection(port.claimExactCredential(exactClaim())))
      .toMatchObject({ reason: "claim_identity_unavailable" });

    const current = await stored(repository);
    const completed = {
      ...current,
      snapshot: completeBackgroundAuthorizationRequest(
        current.snapshot,
        CLAIMED_AT + 2,
      ),
      finishedAt: CLAIMED_AT + 2,
    };
    expect((await repository.compareAndSwap({
      expectedRequestRevision: current.snapshot.requestRevision,
      next: completed,
    })).status).toBe("updated");
    expect(await rejection(port.claimExactCredential(exactClaim())))
      .toMatchObject({ reason: "claim_identity_unavailable" });
  });

  test.each([
    ["credential id", { credentialId: "credential_substituted" }],
    ["credential hash", { credentialHash: new Uint8Array(32).fill(0xaa) }],
    ["descriptor hash", {
      workDescriptorHash: new Uint8Array(32).fill(0xbb),
    }],
    ["claim id", { claimId: "claim_substituted" }],
    ["generation", { recipientGeneration: 1 }],
    ["idempotency", { idempotencyId: "idempotency_substituted" }],
  ] as const)("fails closed on %s substitution", async (_label, change) => {
    const { repository, port } = await seeded();

    expect(await rejection(port.claimExactCredential({
      ...exactClaim(),
      ...change,
    }))).toBeInstanceOf(ProcessorCredentialClaimError);
    expect((await stored(repository)).snapshot.state).toBe("claimed");
  });

  test("never labels a substituted running-state claim as an exact replay", async () => {
    const { port } = await seeded();
    expect(await port.claimExactCredential(exactClaim())).toBe("claimed");

    expect(await rejection(port.claimExactCredential({
      ...exactClaim(),
      claimId: "claim_substituted",
    }))).toMatchObject({ reason: "claim_mismatch" });
  });

  test("fails closed for missing and pre-claim lifecycle records", async () => {
    const repository = new InMemoryBackgroundAuthorizationRepository();
    const port =
      new BackgroundAuthorizationProcessorCredentialClaimPort(repository);

    expect(await rejection(port.claimExactCredential(exactClaim())))
      .toMatchObject({ reason: "missing" });
    await repository.create(grantReadyRecord());
    expect(await rejection(port.claimExactCredential(exactClaim())))
      .toMatchObject({ reason: "claim_identity_unavailable" });
  });

  test.each([
    ["recipient", (record: BackgroundAuthorizationRecord) => ({
      ...record,
      snapshot: {
        ...record.snapshot,
        recipient: {
          ...record.snapshot.recipient!,
          expiresAt: CLAIMED_AT,
        },
      },
    })],
    ["claim", (record: BackgroundAuthorizationRecord) => ({
      ...record,
      snapshot: {
        ...record.snapshot,
        claimExpiresAt: CLAIMED_AT,
      },
    })],
    ["authorization", (record: BackgroundAuthorizationRecord) => ({
      ...record,
      acceptedMaterial: {
        ...record.acceptedMaterial!,
        authorizationExpiresAt: CLAIMED_AT,
      },
    })],
  ] as const)("fails closed when %s expires at the claim boundary", async (
    _label,
    expire,
  ) => {
    const repository = new InMemoryBackgroundAuthorizationRepository();
    await repository.create(expire(claimedRecord()));
    const port =
      new BackgroundAuthorizationProcessorCredentialClaimPort(repository);

    expect(await rejection(port.claimExactCredential(exactClaim())))
      .toBeInstanceOf(ProcessorCredentialClaimError);
    expect((await stored(repository)).snapshot.state).toBe("claimed");
  });

  test("an abort before storage leaves the durable claim unconsumed", async () => {
    const { repository, port } = await seeded();
    const controller = new AbortController();
    controller.abort(new Error("cancel before claim"));

    expect(await rejection(
      port.claimExactCredential(exactClaim(controller.signal)),
    )).toEqual(new Error("cancel before claim"));
    expect((await stored(repository)).snapshot.state).toBe("claimed");
  });

  test("an abort after lookup cannot enter the CAS boundary", async () => {
    const backing = new InMemoryBackgroundAuthorizationRepository();
    await backing.create(claimedRecord());
    const controller = new AbortController();
    let casCalls = 0;
    const repository: BackgroundAuthorizationRepository = {
      create: (record) => backing.create(record),
      get: async (requestId) => {
        const record = await backing.get(requestId);
        controller.abort(new Error("cancel after lookup"));
        return record;
      },
      acceptVerifiedResponse: (input) => backing.acceptVerifiedResponse(input),
      listEligible: (input) => backing.listEligible(input),
      listAwaitingDevicePage: (input) =>
        backing.listAwaitingDevicePage(input),
      pruneTerminal: (input) => backing.pruneTerminal(input),
      compareAndSwap: (input) => {
        casCalls += 1;
        return backing.compareAndSwap(input);
      },
    };
    const port =
      new BackgroundAuthorizationProcessorCredentialClaimPort(repository);

    expect(await rejection(
      port.claimExactCredential(exactClaim(controller.signal)),
    )).toEqual(new Error("cancel after lookup"));
    expect(casCalls).toBe(0);
    expect((await stored(backing)).snapshot.state).toBe("claimed");
  });

  test("an abort during CAS may burn the claim but never returns authority", async () => {
    const backing = new InMemoryBackgroundAuthorizationRepository();
    await backing.create(claimedRecord());
    const controller = new AbortController();
    const repository: BackgroundAuthorizationRepository = {
      create: (record) => backing.create(record),
      get: (requestId) => backing.get(requestId),
      acceptVerifiedResponse: (input) => backing.acceptVerifiedResponse(input),
      listEligible: (input) => backing.listEligible(input),
      listAwaitingDevicePage: (input) =>
        backing.listAwaitingDevicePage(input),
      pruneTerminal: (input) => backing.pruneTerminal(input),
      compareAndSwap: async (input) => {
        const result = await backing.compareAndSwap(input);
        controller.abort(new Error("cancel after commit"));
        return result;
      },
    };
    const port =
      new BackgroundAuthorizationProcessorCredentialClaimPort(repository);

    expect(await rejection(
      port.claimExactCredential(exactClaim(controller.signal)),
    )).toEqual(new Error("cancel after commit"));
    expect((await stored(backing)).snapshot.state).toBe("running");
    expect(await port.claimExactCredential(exactClaim()))
      .toBe("already_claimed");
  });

  test("losing a concurrent CAS returns already_claimed only for an exact durable winner", async () => {
    const backing = new InMemoryBackgroundAuthorizationRepository();
    await backing.create(claimedRecord());
    const repository: BackgroundAuthorizationRepository = {
      create: (record) => backing.create(record),
      get: (requestId) => backing.get(requestId),
      acceptVerifiedResponse: (input) => backing.acceptVerifiedResponse(input),
      listEligible: (input) => backing.listEligible(input),
      listAwaitingDevicePage: (input) =>
        backing.listAwaitingDevicePage(input),
      pruneTerminal: (input) => backing.pruneTerminal(input),
      compareAndSwap: async (input) => {
        const current = await stored(backing);
        const winner = {
          ...current,
          snapshot: markBackgroundAuthorizationRunning(
            current.snapshot,
            CLAIMED_AT,
          ),
        };
        await backing.compareAndSwap({
          expectedRequestRevision: current.snapshot.requestRevision,
          next: winner,
        });
        return {
          status: "stale",
          current: await backing.get(input.next.snapshot.requestId),
        };
      },
    };
    const port =
      new BackgroundAuthorizationProcessorCredentialClaimPort(repository);

    expect(await port.claimExactCredential(exactClaim()))
      .toBe("already_claimed");
  });
});
