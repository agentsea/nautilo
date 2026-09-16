import { describe, expect, test } from "bun:test";

import {
  createAgentBackgroundGrantResponseV1,
  verifyCurrentAgentBackgroundGrantResponseV1,
  type AgentBackgroundGrantIssuerContextV1,
} from "../../src/background/agent-background-grant-response-v1.ts";
import {
  encodeBackgroundWorkDescriptorV1,
  type BackgroundWorkDescriptorV1,
} from "../../src/background/work-descriptor-v1.ts";
import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import { serializeGrantV2 } from "../../src/format/grant-v2.ts";
import { mintGrantV2 } from "../../src/grant/authorization.ts";
import {
  createBackgroundAuthorizationResponseFixtureV1,
} from "../helpers/background-authorization-response-v1-fixture.ts";
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
  unixTimestamp,
} from "../../src/v2-types/ids.ts";

const NOW = 1_960_000_000_000;
const MAX_SEED = 8;

interface FixtureOptions {
  readonly requestId?: string;
  readonly recipientGeneration?: number;
  readonly recipientKeyId?: string;
  readonly recipientKeySeed?: number;
  readonly operations?: readonly ("decrypt" | "encrypt")[];
  readonly agentId?: string;
  readonly runtimeGeneration?: number;
  readonly authorizationRevision?: number;
  readonly namespaceId?: string;
  readonly domainId?: string;
  readonly domainEpoch?: number;
  readonly namespaceAccessRevision?: number;
  readonly policyRevision?: number;
  readonly issuingHumanId?: string;
  readonly issuingDeviceId?: string;
  readonly issuingDeviceAuthorizationRevision?: number;
  readonly issuerKeySeed?: number;
  readonly issuedAt?: number;
  readonly notBefore?: number;
  readonly expiresAt?: number;
  readonly sourceGeneration?: number;
  readonly sourceFingerprintByte?: number;
  readonly outputObjectId?: string;
  readonly outputObjectType?: string;
}

async function fixture(seed: number, options: FixtureOptions = {}) {
  const crypto = new LatticeCrypto(seededRng(41_000 + seed));
  const issuerCrypto = new LatticeCrypto(
    seededRng(options.issuerKeySeed ?? 42_000 + seed),
  );
  const recipientCrypto = new LatticeCrypto(
    seededRng(options.recipientKeySeed ?? 43_000 + seed),
  );
  const issuer = issuerCrypto.generateSigningKeyPair();
  const recipient = await recipientCrypto.generateEncryptionKeyPair();
  const authorization = authorizationRevision(
    options.authorizationRevision ?? 13 + seed,
  );
  const operations = options.operations ?? ["decrypt", "encrypt"];
  const canDecrypt = operations.includes("decrypt");
  const canEncrypt = operations.includes("encrypt");
  const outputId = objectId(
    options.outputObjectId ?? `task-output-${seed}`,
  );
  const issuedAt = options.issuedAt ?? NOW + seed * 1_000;
  const notBefore = options.notBefore ?? issuedAt + 10;
  const expiresAt = options.expiresAt ?? issuedAt + 5 * 60_000;
  const issuerHuman = humanId(
    options.issuingHumanId ?? `human-alice-${seed}`,
  );
  const descriptor: BackgroundWorkDescriptorV1 = {
    formatVersion: 1,
    requestId: options.requestId ?? `agent-request-${seed}`,
    recipientGeneration: options.recipientGeneration ?? seed,
    workKind: "task.execute",
    workId: `task-run-${seed}`,
    namespaceId: namespaceId(
      options.namespaceId ?? `namespace-${seed}`,
    ),
    domainId: cryptoDomainId(options.domainId ?? `domain-${seed}`),
    subject: {
      kind: "agent",
      agentId: agentId(options.agentId ?? `agent-${seed}`),
      runtimeGeneration: agentRuntimeGeneration(
        options.runtimeGeneration ?? seed + 2,
      ),
      authorizationRevision: authorization,
    },
    purpose: "task.execute",
    operations,
    source: {
      kind: "synthetic_payload",
      generation: options.sourceGeneration ?? seed + 3,
      fingerprint: new Uint8Array(32).fill(
        options.sourceFingerprintByte ?? seed,
      ),
    },
    inputObjectIds: canDecrypt ? [objectId(`task-input-${seed}`)] : [],
    outputObjectIds: canEncrypt ? [outputId] : [],
    outputObjectMetadata: canEncrypt
      ? [{
          objectId: outputId,
          objectType: options.outputObjectType ?? "task.output",
          createdAt: unixTimestamp(issuedAt),
        }]
      : [],
    maximumInputObjectCount: canDecrypt ? 1 : 0,
    maximumOutputObjectCount: canEncrypt ? 1 : 0,
    maximumPlaintextBytes: 64 * 1_024,
    maximumCiphertextBytes: 96 * 1_024,
    expectedDomainEpoch: domainEpoch(
      options.domainEpoch ?? seed + 4,
    ),
    expectedNamespaceAccessRevision: accessRevision(
      options.namespaceAccessRevision ?? seed + 5,
    ),
    expectedPolicyRevision: authorizationRevision(
      options.policyRevision ?? authorization,
    ),
    recipientKeyId:
      options.recipientKeyId ?? `recipient-key-${seed}`,
    recipientPublicKey: recipient.publicKey,
    issuedAt,
    notBefore,
    expiresAt,
    idempotencyId: `task-attempt-${seed}`,
  };
  const grant = await mintGrantV2(crypto, {
    id: grantId(`agent-grant-${seed}`),
    issuingDeviceId: cryptoDeviceId(
      options.issuingDeviceId ?? `device-${seed}`,
    ),
    issuingHumanId: issuerHuman,
    issuingDeviceSigningPrivateKey: issuer.privateKey,
    recipientAgentId: descriptor.subject.kind === "agent"
      ? descriptor.subject.agentId
      : agentId("unreachable"),
    recipientKeyId: descriptor.recipientKeyId,
    recipientEncryptionPublicKey: descriptor.recipientPublicKey,
    scope: [issuerHuman],
    operations: descriptor.operations,
    issuedAt: descriptor.issuedAt,
    expiresAt: descriptor.expiresAt,
    coveredDomains: [{
      domainId: descriptor.domainId,
      domainEpoch: descriptor.expectedDomainEpoch,
      agentAuthorizationRevision: authorization,
      aiRoot: new Uint8Array(32).fill(0x51),
    }],
    singleUse: true,
  });
  const descriptorBytes = encodeBackgroundWorkDescriptorV1(descriptor);
  const grantBytes = serializeGrantV2(grant);
  const created = createAgentBackgroundGrantResponseV1(crypto, {
    workDescriptorBytes: descriptorBytes,
    grantBytes,
    issuingHumanId: issuerHuman,
    issuingDeviceAuthorizationRevision: authorizationRevision(
      options.issuingDeviceAuthorizationRevision ?? seed + 6,
    ),
    issuingDeviceSigningPublicKey: issuer.publicKey,
    issuingDeviceSigningPrivateKey: issuer.privateKey,
  });
  recipient.privateKey.fill(0);
  return { created, crypto, descriptor, issuer };
}

function contextFingerprint(
  context: AgentBackgroundGrantIssuerContextV1,
): string {
  const hex = (bytes: Uint8Array) =>
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return JSON.stringify({
    requestId: context.requestId,
    recipientGeneration: context.recipientGeneration,
    recipientKeyId: context.recipientKeyId,
    recipientPublicKey: hex(context.recipientPublicKey),
    workDescriptorHash: hex(context.workDescriptorHash),
    grantId: context.grantId,
    grantHash: hex(context.grantHash),
    grantScope: context.grantScope,
    operations: context.operations,
    agentId: context.agentId,
    runtimeGeneration: context.runtimeGeneration,
    agentAuthorizationRevision: context.agentAuthorizationRevision,
    namespaceId: context.namespaceId,
    domainId: context.domainId,
    domainEpoch: context.domainEpoch,
    namespaceAccessRevision: context.namespaceAccessRevision,
    policyRevision: context.policyRevision,
    issuingHumanId: context.issuingHumanId,
    issuingDeviceId: context.issuingDeviceId,
    issuingDeviceAuthorizationRevision:
      context.issuingDeviceAuthorizationRevision,
    issuerSigningPublicKeyHash: hex(context.issuerSigningPublicKeyHash),
    issuedAt: context.issuedAt,
    notBefore: context.notBefore,
    expiresAt: context.expiresAt,
  });
}

function replayCommand(seed: number): string {
  return "M241_AGENT_BACKGROUND_RESPONSE_PROPERTY_SEED="
    + `${seed} bun test --timeout 60000 tests/property/`
    + "agent-background-grant-response-v1.property.test.ts";
}

function selectedSeeds(): readonly number[] {
  if (
    process.env["LATTICE_MUTATION_SCOPE_ONLY"]
      === "background-grant-response"
    || process.env["LATTICE_MUTATION_HOSTED_SCOPE"]
      === "background-grant-response"
  ) {
    return [1];
  }
  const raw = process.env["M241_AGENT_BACKGROUND_RESPONSE_PROPERTY_SEED"];
  if (raw === undefined) {
    return Array.from({ length: MAX_SEED }, (_, index) => index + 1);
  }
  const seed = Number(raw);
  if (!Number.isSafeInteger(seed) || seed < 1 || seed > MAX_SEED) {
    throw new RangeError("invalid Agent response property seed");
  }
  return [seed];
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

describe("AgentBackgroundGrantResponseV1 adversarial properties", () => {
  test("every exact authority-coordinate substitution fails closed", async () => {
    for (const seed of selectedSeeds()) {
      try {
        const baseline = await fixture(seed);
        let currentContext: AgentBackgroundGrantIssuerContextV1 | undefined;
        await verifyCurrentAgentBackgroundGrantResponseV1(
          baseline.crypto,
          {
            responseBytes: baseline.created.bytes,
            now: baseline.descriptor.notBefore,
            resolveCurrentIssuingDevicePublicKey: (context) => {
              currentContext = structuredClone(context);
              return baseline.issuer.publicKey;
            },
          },
        );
        if (currentContext === undefined) {
          throw new Error("baseline issuer context was not observed");
        }
        const expectedContext = contextFingerprint(currentContext);
        const substitutions: readonly [
          string,
          FixtureOptions,
        ][] = [
          ["request", { requestId: `other-request-${seed}` }],
          ["generation", { recipientGeneration: seed + 100 }],
          ["recipient id", { recipientKeyId: `other-key-${seed}` }],
          ["recipient key", { recipientKeySeed: 50_000 + seed }],
          ["operations", { operations: ["decrypt"] }],
          ["Agent id", { agentId: `other-agent-${seed}` }],
          ["Runtime generation", { runtimeGeneration: seed + 100 }],
          [
            "Agent authorization/policy revision",
            {
              authorizationRevision: seed + 100,
              policyRevision: seed + 100,
            },
          ],
          ["Namespace", { namespaceId: `other-namespace-${seed}` }],
          ["Domain", { domainId: `other-domain-${seed}` }],
          ["Domain epoch", { domainEpoch: seed + 100 }],
          [
            "Namespace access revision",
            { namespaceAccessRevision: seed + 100 },
          ],
          ["issuing Human", { issuingHumanId: `human-other-${seed}` }],
          ["issuing device", { issuingDeviceId: `device-other-${seed}` }],
          [
            "issuing device revision",
            { issuingDeviceAuthorizationRevision: seed + 100 },
          ],
          ["issuer key", { issuerKeySeed: 60_000 + seed }],
          ["issued-at", { issuedAt: NOW + seed * 1_000 + 1 }],
          [
            "not-before",
            { notBefore: NOW + seed * 1_000 + 11 },
          ],
          [
            "expiry",
            { expiresAt: NOW + seed * 1_000 + 5 * 60_000 + 1 },
          ],
          ["source generation", { sourceGeneration: seed + 100 }],
          [
            "source fingerprint",
            { sourceFingerprintByte: seed + 1 },
          ],
          ["output identity", { outputObjectId: `other-output-${seed}` }],
          ["output metadata", { outputObjectType: "task.output.other" }],
        ];
        for (const [label, options] of substitutions) {
          const substituted = await fixture(seed, options);
          await expectRejection(
            verifyCurrentAgentBackgroundGrantResponseV1(
              substituted.crypto,
              {
                responseBytes: substituted.created.bytes,
                now: substituted.descriptor.notBefore,
                resolveCurrentIssuingDevicePublicKey: (context) =>
                  contextFingerprint(context) === expectedContext
                    ? baseline.issuer.publicKey
                    : null,
              },
            ),
            label,
          );
        }
      } catch (error) {
        throw new Error(
          `Agent response property failed at seed ${seed}; replay: `
            + replayCommand(seed),
          { cause: error },
        );
      }
    }
  });

  test("rejects operation order changes and the processor response family", async () => {
    for (const seed of selectedSeeds()) {
      await expectRejection(
        fixture(seed, { operations: ["encrypt", "decrypt"] }),
        "operation order substitution",
      );
      await expectRejection(
        fixture(seed, { policyRevision: seed + 500 }),
        "policy revision substitution",
      );

      const processor =
        await createBackgroundAuthorizationResponseFixtureV1(
          70_000 + seed,
        );
      const agent = await fixture(seed);
      await expectRejection(
        verifyCurrentAgentBackgroundGrantResponseV1(agent.crypto, {
          responseBytes: processor.response.bytes,
          now: agent.descriptor.notBefore,
          resolveCurrentIssuingDevicePublicKey: () =>
            processor.issuer.publicKey,
        }),
        "processor response family substitution",
      );
    }
  });
});
