import { describe, expect, test } from "bun:test";

import {
  LatticeCrypto,
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  namespaceId,
  objectId,
  unixTimestamp,
} from "@nautilo/lattice-crypto";
import {
  backgroundWorkDescriptorDigestV1,
  encodeBackgroundWorkDescriptorV1,
  type BackgroundWorkDescriptorV1,
} from "@nautilo/lattice-crypto/wire";

import {
  BACKGROUND_AUTHORIZATION_DEVICE_CREDENTIAL_TTL_MS,
  fulfillAgentBackgroundAuthorizationRequest,
  fulfillProcessorBackgroundAuthorizationRequest,
  verifyCurrentBackgroundAuthorizationDeviceResponse,
  type AgentBackgroundAuthorizationDeviceAuthority,
  type BackgroundAuthorizationDeviceAuthority,
  type ExpectedAgentBackgroundAuthorizationResponse,
  type ExpectedProcessorBackgroundAuthorizationResponse,
} from "../../src/index.ts";

const NOW = 1_970_000_000_000;
const MAX_SEED = 12;

function cryptoFor(seed: number): LatticeCrypto {
  let state = seed >>> 0;
  return new LatticeCrypto(
    {
      bytes: (length) => {
        const output = new Uint8Array(length);
        for (let index = 0; index < length; index += 1) {
          state = (
            Math.imul(state, 1_664_525) + 1_013_904_223
          ) >>> 0;
          output[index] = state & 0xff;
        }
        return output;
      },
    },
    { now: () => NOW },
  );
}

function selectedSeeds(): readonly number[] {
  const raw =
    process.env["M241_BACKGROUND_RESPONSE_VERIFIER_PROPERTY_SEED"];
  if (raw === undefined) {
    return Array.from({ length: MAX_SEED }, (_, index) => index + 1);
  }
  const seed = Number(raw);
  if (!Number.isSafeInteger(seed) || seed < 1 || seed > MAX_SEED) {
    throw new RangeError("invalid response verifier property seed");
  }
  return [seed];
}

function replayCommand(seed: number): string {
  return "M241_BACKGROUND_RESPONSE_VERIFIER_PROPERTY_SEED="
    + `${seed} bun test --timeout 60000 tests/property/`
    + "background-authorization-response-verifier.property.test.ts";
}

async function agentFixture(seed: number) {
  const crypto = cryptoFor(80_000 + seed);
  const recipient = await crypto.generateEncryptionKeyPair();
  recipient.privateKey.fill(0);
  const signer = crypto.generateSigningKeyPair();
  const outputId = objectId(`agent-output-${seed}`);
  const descriptor: BackgroundWorkDescriptorV1 = {
    formatVersion: 1,
    requestId: `agent-request-${seed}`,
    recipientGeneration: seed,
    workKind: "task.execute",
    workId: `task-${seed}`,
    namespaceId: namespaceId(`namespace-${seed}`),
    domainId: cryptoDomainId(`domain-${seed}`),
    subject: {
      kind: "agent",
      agentId: agentId(`agent-${seed}`),
      runtimeGeneration: agentRuntimeGeneration(seed + 1),
      authorizationRevision: authorizationRevision(seed + 2),
    },
    purpose: "task.execute",
    operations: ["decrypt", "encrypt"],
    source: {
      kind: "synthetic_payload",
      generation: seed + 3,
      fingerprint: new Uint8Array(32).fill(seed),
    },
    inputObjectIds: [objectId(`agent-input-${seed}`)],
    outputObjectIds: [outputId],
    outputObjectMetadata: [{
      objectId: outputId,
      objectType: "task.output",
      createdAt: unixTimestamp(NOW),
    }],
    maximumInputObjectCount: 1,
    maximumOutputObjectCount: 1,
    maximumPlaintextBytes: 64 * 1_024,
    maximumCiphertextBytes: 96 * 1_024,
    expectedDomainEpoch: domainEpoch(seed + 4),
    expectedNamespaceAccessRevision: accessRevision(seed + 5),
    expectedPolicyRevision: authorizationRevision(seed + 2),
    recipientKeyId: `agent-recipient-${seed}`,
    recipientPublicKey: recipient.publicKey,
    issuedAt: NOW,
    notBefore: NOW,
    expiresAt: NOW + BACKGROUND_AUTHORIZATION_DEVICE_CREDENTIAL_TTL_MS,
    idempotencyId: `agent-attempt-${seed}`,
  };
  if (descriptor.subject.kind !== "agent") {
    throw new Error("Agent fixture subject drift");
  }
  const authority: AgentBackgroundAuthorizationDeviceAuthority = {
    humanId: humanId(`human-${seed}`),
    humanState: "active",
    deviceId: cryptoDeviceId(`device-${seed}`),
    deviceHumanId: humanId(`human-${seed}`),
    deviceState: "active",
    deviceAuthorizationRevision: authorizationRevision(seed + 6),
    deviceSigningPublicKey: signer.publicKey,
    deviceSigningPrivateKey: signer.privateKey,
    namespaceId: descriptor.namespaceId,
    namespaceState: "active",
    membershipHumanId: humanId(`human-${seed}`),
    membershipState: "active",
    namespaceParticipants: [humanId(`human-${seed}`)],
    namespaceAccessRevision: descriptor.expectedNamespaceAccessRevision,
    policyRevision: descriptor.expectedPolicyRevision,
    domainId: descriptor.domainId,
    domainState: "active",
    domainEpoch: descriptor.expectedDomainEpoch,
    agentId: descriptor.subject.agentId,
    agentState: "active",
    runtimeGeneration: descriptor.subject.runtimeGeneration,
    agentAuthorizationRevision:
      descriptor.subject.authorizationRevision,
    aiRoot: new Uint8Array(32).fill(0xa1),
  };
  const descriptorBytes = encodeBackgroundWorkDescriptorV1(descriptor);
  const descriptorHash = backgroundWorkDescriptorDigestV1(
    crypto,
    descriptor,
  );
  const fulfillment = await fulfillAgentBackgroundAuthorizationRequest({
    crypto,
    request: { formatVersion: 1, descriptorBytes, descriptorHash },
    resolveCurrentAuthority: () => authority,
  });
  const expected: ExpectedAgentBackgroundAuthorizationResponse = {
    kind: "agent",
    requestId: descriptor.requestId,
    recipientGeneration: descriptor.recipientGeneration,
    descriptorHash,
    recipientKeyId: descriptor.recipientKeyId,
    recipientPublicKey: descriptor.recipientPublicKey,
  };
  return { authority, crypto, descriptor, expected, fulfillment };
}

async function processorFixture(seed: number) {
  const crypto = cryptoFor(90_000 + seed);
  const recipient = await crypto.generateEncryptionKeyPair();
  recipient.privateKey.fill(0);
  const signer = crypto.generateSigningKeyPair();
  const outputId = objectId(`journal-event-${seed}`);
  const descriptor: BackgroundWorkDescriptorV1 = {
    formatVersion: 1,
    requestId: `processor-request-${seed}`,
    recipientGeneration: seed,
    workKind: "stenographer.extraction",
    workId: `batch-${seed}`,
    namespaceId: namespaceId(`namespace-${seed}`),
    domainId: cryptoDomainId(`domain-${seed}`),
    subject: {
      kind: "processor",
      processorKind: "stenographer",
      processorVersion: 1,
      authorizationRevision: authorizationRevision(seed + 7),
    },
    purpose: "journal.extract",
    operations: ["decrypt", "encrypt"],
    source: {
      kind: "journal_range",
      startSequence: seed,
      endSequence: seed + 2,
      rebuildGeneration: 0,
      fingerprint: new Uint8Array(32).fill(seed + 1),
    },
    inputObjectIds: [objectId(`message-${seed}`)],
    outputObjectIds: [outputId],
    outputObjectMetadata: [{
      objectId: outputId,
      objectType: "room_event",
      createdAt: unixTimestamp(NOW),
    }],
    maximumInputObjectCount: 1,
    maximumOutputObjectCount: 1,
    maximumPlaintextBytes: 64 * 1_024,
    maximumCiphertextBytes: 96 * 1_024,
    expectedDomainEpoch: domainEpoch(seed + 4),
    expectedNamespaceAccessRevision: accessRevision(seed + 5),
    expectedPolicyRevision: authorizationRevision(seed + 6),
    recipientKeyId: `processor-recipient-${seed}`,
    recipientPublicKey: recipient.publicKey,
    issuedAt: NOW,
    notBefore: NOW,
    expiresAt: NOW + BACKGROUND_AUTHORIZATION_DEVICE_CREDENTIAL_TTL_MS,
    idempotencyId: `processor-attempt-${seed}`,
  };
  const authority: BackgroundAuthorizationDeviceAuthority = {
    humanId: humanId(`human-${seed}`),
    humanState: "active",
    deviceId: cryptoDeviceId(`device-${seed}`),
    deviceHumanId: humanId(`human-${seed}`),
    deviceState: "active",
    deviceAuthorizationRevision: authorizationRevision(seed + 8),
    deviceSigningPublicKey: signer.publicKey,
    deviceSigningPrivateKey: signer.privateKey,
    namespaceId: descriptor.namespaceId,
    namespaceState: "active",
    membershipHumanId: humanId(`human-${seed}`),
    membershipState: "active",
    namespaceAccessRevision: descriptor.expectedNamespaceAccessRevision,
    policyRevision: descriptor.expectedPolicyRevision,
    domainId: descriptor.domainId,
    domainState: "active",
    domainEpoch: descriptor.expectedDomainEpoch,
    processorKind: "stenographer",
    processorVersion: 1,
    processorState: "active",
    processorAuthorizationRevision: authorizationRevision(seed + 7),
    aiRoot: new Uint8Array(32).fill(0xb1),
  };
  const descriptorBytes = encodeBackgroundWorkDescriptorV1(descriptor);
  const descriptorHash = backgroundWorkDescriptorDigestV1(
    crypto,
    descriptor,
  );
  const fulfillment =
    await fulfillProcessorBackgroundAuthorizationRequest({
      crypto,
      request: { formatVersion: 1, descriptorBytes, descriptorHash },
      resolveCurrentAuthority: () => authority,
    });
  const expected: ExpectedProcessorBackgroundAuthorizationResponse = {
    kind: "processor",
    requestId: descriptor.requestId,
    recipientGeneration: descriptor.recipientGeneration,
    descriptorHash,
    recipientKeyId: descriptor.recipientKeyId,
    recipientPublicKey: descriptor.recipientPublicKey,
  };
  return { authority, crypto, descriptor, expected, fulfillment };
}

function changedBytes(bytes: Uint8Array): Uint8Array {
  const changed = Uint8Array.from(bytes);
  changed[0] = changed[0]! ^ 1;
  return changed;
}

async function expectRejection(
  operation: Promise<unknown>,
  label: string,
): Promise<void> {
  let rejected = false;
  try {
    await operation;
  } catch {
    rejected = true;
  }
  expect(rejected, label).toBe(true);
}

describe("family-neutral background response verifier properties", () => {
  test("rejects every substituted durable request coordinate in both families", async () => {
    for (const seed of selectedSeeds()) {
      try {
        const agent = await agentFixture(seed);
        const processor = await processorFixture(seed);
        const otherRecipient = await agent.crypto.generateEncryptionKeyPair();
        otherRecipient.privateKey.fill(0);

        const expectedSubstitutions = [
          {
            ...agent.expected,
            requestId: `other-request-${seed}`,
          },
          {
            ...agent.expected,
            recipientGeneration:
              agent.expected.recipientGeneration + 1,
          },
          {
            ...agent.expected,
            descriptorHash: changedBytes(agent.expected.descriptorHash),
          },
          {
            ...agent.expected,
            recipientKeyId: `other-recipient-${seed}`,
          },
          {
            ...agent.expected,
            recipientPublicKey: otherRecipient.publicKey,
          },
        ] satisfies readonly ExpectedAgentBackgroundAuthorizationResponse[];

        for (const expected of expectedSubstitutions) {
          await expectRejection(
            verifyCurrentBackgroundAuthorizationDeviceResponse({
              crypto: agent.crypto,
              expected,
              responseBytes: agent.fulfillment.responseBytes,
              now: NOW,
              resolveCurrentIssuingDevicePublicKey: () =>
                agent.authority.deviceSigningPublicKey,
            }),
            "Agent durable-coordinate substitution",
          );
        }

        const processorSubstitutions = [
          {
            ...processor.expected,
            requestId: `other-processor-request-${seed}`,
          },
          {
            ...processor.expected,
            recipientGeneration:
              processor.expected.recipientGeneration + 1,
          },
          {
            ...processor.expected,
            descriptorHash:
              changedBytes(processor.expected.descriptorHash),
          },
          {
            ...processor.expected,
            recipientKeyId: `other-processor-recipient-${seed}`,
          },
          {
            ...processor.expected,
            recipientPublicKey: otherRecipient.publicKey,
          },
        ] satisfies readonly ExpectedProcessorBackgroundAuthorizationResponse[];
        for (const expected of processorSubstitutions) {
          await expectRejection(
            verifyCurrentBackgroundAuthorizationDeviceResponse({
              crypto: processor.crypto,
              expected,
              responseBytes: processor.fulfillment.responseBytes,
              signerAuthorizationBytes:
                processor.fulfillment.signerAuthorizationBytes,
              now: NOW,
              resolveCurrentIssuingDevicePublicKey: () =>
                processor.authority.deviceSigningPublicKey,
            }),
            "processor durable-coordinate substitution",
          );
        }
      } catch (error) {
        throw new Error(
          `Response verifier property failed at seed ${seed}; replay: `
            + replayCommand(seed),
          { cause: error },
        );
      }
    }
  });

  test("rejects processor/Agent family substitution in both directions", async () => {
    for (const seed of selectedSeeds()) {
      const agent = await agentFixture(seed);
      const processor = await processorFixture(seed);

      await expectRejection(
        verifyCurrentBackgroundAuthorizationDeviceResponse({
          crypto: agent.crypto,
          expected: {
            ...processor.expected,
            kind: "processor",
          },
          responseBytes: agent.fulfillment.responseBytes,
          signerAuthorizationBytes:
            processor.fulfillment.signerAuthorizationBytes,
          now: NOW,
          resolveCurrentIssuingDevicePublicKey: () =>
            agent.authority.deviceSigningPublicKey,
        }),
        "Agent response under processor dispatch",
      );

      await expectRejection(
        verifyCurrentBackgroundAuthorizationDeviceResponse({
          crypto: processor.crypto,
          expected: { ...agent.expected, kind: "agent" },
          responseBytes: processor.fulfillment.responseBytes,
          now: NOW,
          resolveCurrentIssuingDevicePublicKey: () =>
            processor.authority.deviceSigningPublicKey,
        }),
        "processor response under Agent dispatch",
      );
    }
  });
});
