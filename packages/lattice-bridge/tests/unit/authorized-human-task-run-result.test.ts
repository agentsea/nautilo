import { expect, test } from "bun:test";
import type {
  NautiloApiClient,
  ProtectedTaskRunResultReadEnvelopeV1,
} from "@nautilo/api-client/browser";

import { createAuthorizedHumanTaskRunResultReaderV1 } from
  "../../src/client/task/authorized-human-task-run-result.ts";
import { deriveTaskContentCryptoObjectIdV1 } from
  "../../src/task/task-content-repository.ts";
import { deriveTaskHistoricalContentCryptoObjectIdV1 } from
  "../../src/task/task-historical-content-identity.ts";
import { encodeTaskRunResultPayloadV1 } from
  "../../src/task/task-payload-v1.ts";
import { ClassifiedDataOperationError } from
  "../../src/transition/encryption-data-operation-owner.ts";

const TASK_ID = "10000000-0000-4000-8000-000000000123";
const RUN_ID = "20000000-0000-4000-8000-000000000123";
const AGENT_ID = "30000000-0000-4000-8000-000000000123";
const NAMESPACE_ID = "40000000-0000-4000-8000-000000000123";
const OBJECT_ID = deriveTaskContentCryptoObjectIdV1({
  kind: "run_result", taskId: TASK_ID, taskRunId: RUN_ID, contentRevision: 1,
});
const CANCELLED_OBJECT_ID = deriveTaskContentCryptoObjectIdV1({
  kind: "run_result", taskId: TASK_ID, taskRunId: RUN_ID, contentRevision: 2,
});
const request = { taskId: TASK_ID, taskRunId: RUN_ID, agentId: AGENT_ID };

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function api(response: ProtectedTaskRunResultReadEnvelopeV1): Pick<
  NautiloApiClient,
  "getProtectedTaskRunResultEnvelopeV1"
> {
  return {
    getProtectedTaskRunResultEnvelopeV1: () => Promise.resolve(response),
  };
}

function ready(resultRevision: 1 | 2 = 1): Extract<ProtectedTaskRunResultReadEnvelopeV1,
  { status: "ready" }> {
  return {
    readVersion: 1,
    status: "ready",
    taskId: TASK_ID,
    taskRunId: RUN_ID,
    objectId: resultRevision === 1 ? OBJECT_ID : CANCELLED_OBJECT_ID,
    resultRevision,
    cryptoAccessRevision: 0,
    namespaceId: NAMESPACE_ID,
    readAuthority: {
      sourceRoomId: TASK_ID,
      namespaceId: NAMESPACE_ID,
      currentGeneration: 0,
      retainedGenerations: [{
        generation: 0,
        accessRevision: 0,
        headDigestBase64url: base64url(new Uint8Array(32).fill(1)),
        publicationDigestBase64url: base64url(new Uint8Array(32).fill(2)),
        publicationSetDigestBase64url: base64url(new Uint8Array(32).fill(3)),
        audienceFingerprintBase64url: base64url(new Uint8Array(32).fill(4)),
      }],
    },
    encryptedPayloadBytesBase64url: base64url(new Uint8Array(130_000).fill(7)),
    accessManifestBytesBase64url: base64url(new Uint8Array([8])),
    accessManifestProofBytesBase64url: [],
    namespaceEnvelopeBytesBase64url: base64url(new Uint8Array([9])),
    signerEvidence: [{
      kind: "agent_runtime_publication",
      evidenceBytesBase64url: base64url(new Uint8Array([10])),
    }],
  };
}

test("exact protected result read decodes large ciphertext and wipes it after device open", async () => {
  const ciphertextViews: Uint8Array[] = [];
  const opened = encodeTaskRunResultPayloadV1({
    formatVersion: 1,
    resultText: "confidential result",
    lastError: null,
  });
  const reader = createAuthorizedHumanTaskRunResultReaderV1({
    api: api(ready()),
    device: {
      openExact: ({ envelope }) => {
        ciphertextViews.push(envelope.encryptedPayloadBytes);
        ciphertextViews.push(envelope.accessManifestBytes);
        ciphertextViews.push(envelope.namespaceEnvelopeBytes);
        expect(envelope.encryptedPayloadBytes.length).toBe(130_000);
        return Promise.resolve(opened);
      },
    },
  });
  expect(await reader.read(request)).toEqual({
    status: "ready",
    payload: {
      formatVersion: 1,
      resultText: "confidential result",
      lastError: null,
    },
  });
  expect(opened.every((byte) => byte === 0)).toBe(true);
  expect(ciphertextViews.every((bytes) =>
    bytes.every((byte) => byte === 0))).toBe(true);
});

for (const signerEvidence of [
  [{
    kind: "foreground_agent_accepted_execution" as const,
    planBytesBase64url: base64url(new Uint8Array([11, 12])),
    planDigestBase64url: base64url(new Uint8Array(32).fill(13)),
  }],
  [{
    kind: "task_runtime_signer_certificate" as const,
    evidenceBytesBase64url: base64url(new Uint8Array([14, 15])),
  }],
]) {
test(`${signerEvidence[0]!.kind} proof reaches only the authentic device boundary`, async () => {
  const foreground = {
    ...ready(),
    signerEvidence,
  };
  let received: Extract<ProtectedTaskRunResultReadEnvelopeV1,
    { status: "ready" }>["signerEvidence"] | undefined;
  const reader = createAuthorizedHumanTaskRunResultReaderV1({
    api: api(foreground),
    device: {
      openExact: ({ envelope }) => {
        received = envelope.signerEvidence;
        return Promise.resolve(encodeTaskRunResultPayloadV1({
          formatVersion: 1,
          resultText: "foreground result",
          lastError: null,
        }));
      },
    },
  });
  expect(await reader.read(request)).toMatchObject({
    status: "ready",
    payload: { resultText: "foreground result" },
  });
  expect(received).toEqual(foreground.signerEvidence);
  const mixed = createAuthorizedHumanTaskRunResultReaderV1({
    api: api({ ...foreground,
      signerEvidence: [...signerEvidence, ...ready().signerEvidence] }),
    device: { openExact: () => { throw new Error("mixed proof opened"); } },
  });
  await Promise.resolve(expect(mixed.read(request)).rejects.toThrow(
    "Protected Task result access evidence is invalid",
  ));
});
}

test("dynamic result access history reaches the authentic device boundary", async () => {
  const response = {
    ...ready(),
    cryptoAccessRevision: 2,
    accessManifestProofBytesBase64url: [
      base64url(new Uint8Array([21])),
      base64url(new Uint8Array([22])),
    ],
    signerEvidence: [
      ...ready().signerEvidence,
      {
        kind: "human_device" as const,
        subjectHumanId: TASK_ID,
        committerDeviceId: "device:rewrap",
        hostAuthorizationRevision: 4,
        signingPublicKeyBase64url: base64url(new Uint8Array(32).fill(23)),
      },
    ],
  };
  let receivedRevision = -1;
  const reader = createAuthorizedHumanTaskRunResultReaderV1({
    api: api(response),
    device: {
      openExact: ({ envelope }) => {
        receivedRevision = envelope.cryptoAccessRevision;
        expect(envelope.accessManifestProofBytes).toHaveLength(2);
        return Promise.resolve(encodeTaskRunResultPayloadV1({
          formatVersion: 1,
          resultText: "rewrapped result",
          lastError: null,
        }));
      },
    },
  });
  expect(await reader.read(request)).toMatchObject({
    status: "ready", payload: { resultText: "rewrapped result" },
  });
  expect(receivedRevision).toBe(2);
});

test("waiting result remains explicit and never enters the device", async () => {
  const reader = createAuthorizedHumanTaskRunResultReaderV1({
    api: api({
      readVersion: 1, status: "waiting", taskId: TASK_ID,
      taskRunId: RUN_ID, objectId: OBJECT_ID, resultRevision: 1,
      cryptoAccessRevision: 0, reason: "result_not_mapped",
    }),
    device: { openExact: () => { throw new Error("device opened"); } },
  });
  expect(await reader.read(request)).toEqual({
    status: "waiting", reason: "result_not_mapped",
  });
});

test("revision-2 cancelled history uses its exact object coordinate", async () => {
  let openedRevision = 0;
  const opened = encodeTaskRunResultPayloadV1({
    formatVersion: 1,
    resultText: "cancelled result",
    lastError: null,
  });
  const reader = createAuthorizedHumanTaskRunResultReaderV1({
    api: api(ready(2)),
    device: {
      openExact: ({ envelope }) => {
        openedRevision = envelope.resultRevision;
        expect(envelope.objectId).toBe(CANCELLED_OBJECT_ID);
        return Promise.resolve(opened);
      },
    },
  });

  expect(await reader.read(request)).toMatchObject({
    status: "ready",
    payload: { resultText: "cancelled result" },
  });
  expect(openedRevision).toBe(2);
});

test("revision-2 response with the revision-1 object is refused before device open", async () => {
  let opens = 0;
  const reader = createAuthorizedHumanTaskRunResultReaderV1({
    api: api({ ...ready(2), objectId: OBJECT_ID }),
    device: {
      openExact: () => {
        opens += 1;
        throw new Error("device opened");
      },
    },
  });

  await reader.read(request).then(
    () => { throw new Error("revision-1 result object was accepted"); },
    (error: unknown) => {
      expect(error).toBeInstanceOf(ClassifiedDataOperationError);
    },
  );
  expect(opens).toBe(0);
});

test("historical result binds its source-derived object and Human signer metadata", async () => {
  const sourceDigest = new Uint8Array(32).fill(0x42);
  const historicalRepair = {
    version: 2 as const,
    claimId: "50000000-0000-4000-8000-000000000123",
    publisherDeviceId: "historical-device.1",
    signedRequestDigest: "11".repeat(32),
    sourceDigest: Buffer.from(sourceDigest).toString("hex"),
    sourcePayloadHash: "22".repeat(32),
    sourceRevision: 0 as const,
    genesisManifestHash: "33".repeat(32),
  };
  const objectId = deriveTaskHistoricalContentCryptoObjectIdV1({
    coordinate: {
      kind: "run_result", taskId: TASK_ID, taskRunId: RUN_ID,
      contentRevision: 1,
    },
    namespaceId: NAMESPACE_ID,
    sourceDigest,
  });
  const response = {
    ...ready(),
    objectId,
    historicalRepair,
    signerEvidence: [{
      kind: "human_device" as const,
      subjectHumanId: TASK_ID,
      committerDeviceId: historicalRepair.publisherDeviceId,
      hostAuthorizationRevision: 4,
      signingPublicKeyBase64url: base64url(new Uint8Array(32).fill(9)),
    }],
  };
  let opens = 0;
  const reader = createAuthorizedHumanTaskRunResultReaderV1({
    api: api(response),
    device: {
      openExact: ({ envelope }) => {
        opens += 1;
        expect(envelope.historicalRepair).toEqual(historicalRepair);
        expect(envelope.objectId).toBe(objectId);
        return Promise.resolve(encodeTaskRunResultPayloadV1({
          formatVersion: 1, resultText: "historical", lastError: null,
        }));
      },
    },
  });
  expect(await reader.read(request)).toMatchObject({
    status: "ready", payload: { resultText: "historical" },
  });
  expect(opens).toBe(1);

  for (const changed of [
    { objectId: OBJECT_ID },
    { historicalRepair: { ...historicalRepair, sourceDigest: "44".repeat(32) } },
    { signerEvidence: ready().signerEvidence },
  ]) {
    const rejected = createAuthorizedHumanTaskRunResultReaderV1({
      api: api({ ...response, ...changed }),
      device: { openExact: () => {
        throw new Error("historical substitution reached device");
      } },
    });
    await rejected.read(request).then(
      () => { throw new Error("historical substitution was accepted"); },
      error => expect(error).toBeInstanceOf(ClassifiedDataOperationError),
    );
  }
});

test("substituted result coordinate and noncanonical ciphertext fail before device open", async () => {
  let opens = 0;
  const device = { openExact: () => {
    opens += 1;
    throw new Error("device opened");
  } };
  const swapped = { ...ready(), taskRunId: "20000000-0000-4000-8000-000000000124" };
  const invalid = {
    ...ready(), encryptedPayloadBytesBase64url: "Zg=",
  };
  for (const response of [swapped, invalid]) {
    const reader = createAuthorizedHumanTaskRunResultReaderV1({
      api: api(response), device,
    });
    await reader.read(request).then(
      () => { throw new Error("substituted result was accepted"); },
      (error: unknown) => {
        expect(error).toBeInstanceOf(ClassifiedDataOperationError);
      },
    );
  }
  expect(opens).toBe(0);
});
