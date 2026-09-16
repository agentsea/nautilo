import { describe, expect, test } from "bun:test";

import {
  createAgentBackgroundGrantResponseV2,
  verifyCurrentAgentBackgroundGrantResponseV2,
} from "../../src/background/agent-background-grant-response-v2.ts";
import {
  BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V2,
  backgroundWorkDescriptorDigestV2,
  decodeBackgroundAgentWorkDescriptorV2,
  encodeBackgroundWorkDescriptorV2,
  type BackgroundAgentWorkDescriptorV2,
} from "../../src/background/work-descriptor-v2.ts";
import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import { serializeGrantV2 } from "../../src/format/grant-v2.ts";
import { mintGrantV2 } from "../../src/grant/authorization.ts";
import {
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  grantId,
  humanId,
  namespaceId,
  objectId,
} from "../../src/v2-types/ids.ts";

const MAX_SEED = 24;
const NOW = 1_970_000_000_000;

async function fixture(seed: number) {
  const crypto = new LatticeCrypto(seededRng(52_000 + seed));
  const issuer = crypto.generateSigningKeyPair();
  const recipient = await crypto.generateEncryptionKeyPair();
  const domainCount = 1 + (seed % 8);
  const domainRequirements = Array.from(
    { length: domainCount },
    (_, index) => ({
      domainId: cryptoDomainId(
        `domain-${seed}-${index.toString().padStart(3, "0")}`,
      ),
      expectedEpoch: domainEpoch(seed + index + 1),
      expectedAgentAuthorizationRevision: authorizationRevision(
        seed * 10 + index + 1,
      ),
    }),
  );
  const namespaceRequirements = domainRequirements.map(
    (domain, index) => ({
      namespaceId: namespaceId(
        `namespace-${seed}-${index.toString().padStart(3, "0")}`,
      ),
      domainId: domain.domainId,
      operations: ["decrypt"] as const,
      expectedAccessRevision: accessRevision(seed * 20 + index + 1),
      expectedPolicyRevision: authorizationRevision(
        seed * 30 + index + 1,
      ),
    }),
  );
  const issuedAt = NOW + seed * 1_000;
  const descriptor: BackgroundAgentWorkDescriptorV2 = {
    formatVersion: BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V2,
    requestId: `background-request-${seed}`,
    recipientGeneration: seed,
    workKind: "task.execute",
    workId: `task-run-${seed}`,
    anchorNamespaceId: namespaceRequirements[0]!.namespaceId,
    anchorDomainId: domainRequirements[0]!.domainId,
    subject: {
      kind: "agent",
      agentId: agentId(`agent-${seed}`),
      runtimeGeneration: agentRuntimeGeneration(seed + 1),
      authorizationRevision: authorizationRevision(seed + 2),
    },
    purpose: "task.execute",
    operations: ["decrypt"],
    source: {
      kind: "synthetic_payload",
      generation: seed,
      fingerprint: new Uint8Array(32).fill(seed),
    },
    grantScope: [humanId(`human-${seed}-a`), humanId(`human-${seed}-b`)],
    inputBindings: namespaceRequirements.map((namespace, index) => ({
      objectId: objectId(
        `input-${seed}-${index.toString().padStart(3, "0")}`,
      ),
      namespaceId: namespace.namespaceId,
    })),
    outputSlots: [],
    namespaceRequirements,
    domainRequirements,
    maximumInputObjectCount: domainCount,
    maximumOutputObjectCount: 0,
    maximumPlaintextBytes: 1_024 + seed,
    maximumCiphertextBytes: 2_048 + seed,
    recipientKeyId: `recipient-${seed}`,
    recipientPublicKey: recipient.publicKey,
    issuedAt,
    notBefore: issuedAt + 1,
    expiresAt: issuedAt + 60_000,
    idempotencyId: `task-run-${seed}-attempt-1`,
  };
  const grant = await mintGrantV2(crypto, {
    id: grantId(`grant-${seed}`),
    issuingDeviceId: cryptoDeviceId(`device-${seed}`),
    issuingHumanId: descriptor.grantScope[0]!,
    issuingDeviceSigningPrivateKey: issuer.privateKey,
    recipientAgentId: descriptor.subject.agentId,
    recipientKeyId: descriptor.recipientKeyId,
    recipientEncryptionPublicKey: descriptor.recipientPublicKey,
    scope: descriptor.grantScope,
    operations: descriptor.operations,
    issuedAt: descriptor.issuedAt,
    expiresAt: descriptor.expiresAt,
    coveredDomains: domainRequirements.map((domain, index) => ({
      domainId: domain.domainId,
      domainEpoch: domain.expectedEpoch,
      agentAuthorizationRevision:
        domain.expectedAgentAuthorizationRevision,
      aiRoot: new Uint8Array(32).fill(seed + index),
    })),
    singleUse: true,
  });
  return { crypto, descriptor, grant, issuer };
}

function replay(seed: number): string {
  return `M244_AGENT_V2_PROPERTY_SEED=${seed} bun test --timeout 60000 `
    + "tests/property/background-agent-v2.property.test.ts";
}

function selectedSeeds(): readonly number[] {
  const raw = process.env["M244_AGENT_V2_PROPERTY_SEED"];
  if (raw === undefined) {
    return Array.from({ length: MAX_SEED }, (_, index) => index + 1);
  }
  const seed = Number(raw);
  if (!Number.isSafeInteger(seed) || seed < 1 || seed > MAX_SEED) {
    throw new RangeError(
      `M244_AGENT_V2_PROPERTY_SEED must be 1-${MAX_SEED}`,
    );
  }
  return [seed];
}

describe("Agent multi-Domain background v2 recorded-seed properties", () => {
  test("round-trips zero-based Message inputs across recorded inventories", async () => {
    for (const seed of selectedSeeds()) {
      const state = await fixture(seed);
      const descriptor: BackgroundAgentWorkDescriptorV2 = {
        ...state.descriptor,
        workKind: "memory.review",
        purpose: "memory.review",
        source: {
          kind: "protected_memory_work",
          sourceVersion: 1,
          productAuthority: { mode: "namespace" },
          inputRevisions: state.descriptor.inputBindings.map(
            (binding, index) => index === 0
              ? {
                productKind: "message" as const,
                productId: `product-${seed}-${index}`,
                productRevision: 0,
                objectId: binding.objectId,
              }
              : {
                productKind: "memory" as const,
                productId: `product-${seed}-${index}`,
                productRevision: seed + index,
                cryptoAccessRevision: seed + index + 100,
                accessKind: "namespace" as const,
                objectId: binding.objectId,
              },
          ),
          outputRevisions: [],
          tierMutations: [],
        },
      };
      const encoded = encodeBackgroundWorkDescriptorV2(descriptor);
      expect(decodeBackgroundAgentWorkDescriptorV2(encoded)).toEqual(descriptor);
    }
  });

  test("round-trips exact descriptors and responses for varied Domain sets", async () => {
    for (const seed of selectedSeeds()) {
      try {
        const state = await fixture(seed);
        const descriptorBytes = encodeBackgroundWorkDescriptorV2(
          state.descriptor,
        );
        const decoded = decodeBackgroundAgentWorkDescriptorV2(descriptorBytes);
        expect(decoded).toEqual(state.descriptor);
        expect(backgroundWorkDescriptorDigestV2(state.crypto, decoded))
          .toEqual(state.crypto.hash(descriptorBytes));

        const created = createAgentBackgroundGrantResponseV2(state.crypto, {
          workDescriptorBytes: descriptorBytes,
          grantBytes: serializeGrantV2(state.grant),
          issuingHumanId: state.descriptor.grantScope[0]!,
          issuingDeviceAuthorizationRevision: authorizationRevision(seed + 9),
          issuingDeviceSigningPublicKey: state.issuer.publicKey,
          issuingDeviceSigningPrivateKey: state.issuer.privateKey,
        });
        const verified = await verifyCurrentAgentBackgroundGrantResponseV2(
          state.crypto,
          {
            responseBytes: created.bytes,
            now: state.descriptor.notBefore,
            resolveCurrentIssuingDevicePublicKey: (context) => {
              expect(context.domainRequirements)
                .toEqual(state.descriptor.domainRequirements);
              expect(context.namespaceRequirements)
                .toEqual(state.descriptor.namespaceRequirements);
              return state.issuer.publicKey;
            },
          },
        );
        expect(verified.workDescriptor).toEqual(state.descriptor);
        expect(verified.grant.coveredDomains)
          .toEqual(state.grant.coveredDomains);
        if (state.descriptor.domainRequirements.length > 1) {
          expect(() => encodeBackgroundWorkDescriptorV2({
            ...state.descriptor,
            domainRequirements: [
              ...state.descriptor.domainRequirements,
            ].reverse(),
          })).toThrow();
        }
      } catch (error) {
        throw new Error(
          `Agent background v2 property failed at seed ${seed}; replay: ${replay(seed)}`,
          { cause: error },
        );
      }
    }
  });
});
