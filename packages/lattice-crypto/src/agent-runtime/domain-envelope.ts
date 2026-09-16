import type { LatticeCrypto } from "../crypto/index.ts";
import {
  agentRuntimeDomainEnvelopeAad,
  agentRuntimeDomainEnvelopeSigningBytes,
  assertAgentRuntimeDomainEnvelope,
  assertAgentRuntimeGeneration,
  decodeAgentRuntimeGeneration,
  encodeAgentRuntimeGeneration,
} from "../format/agent-runtime-v2.ts";
import type {
  AgentRuntimeDomainCommitterContextV1,
  AgentRuntimeDomainEnvelopeV1,
  AgentRuntimeDomainExpectedContextV1,
  AgentRuntimeDomainTargetV1,
  AgentRuntimeGenerationV2,
  CurrentAgentRuntimeCommitterAuthorizationV1,
  HistoricalAgentRuntimeCommitterResolverV1,
} from "./types.ts";
import { AGENT_RUNTIME_KEY_BYTES } from "./types.ts";
import {
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  type AgentId,
  type AgentRuntimeGeneration,
} from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import { utf8V2 } from "../format/v2-primitives.ts";

function assertBytes(
  label: string,
  value: unknown,
  expectedLength: number,
): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== expectedLength) {
    throw new RangeError(`${label} must contain exactly ${expectedLength} bytes`);
  }
}

function freezeRuntime(
  runtime: AgentRuntimeGenerationV2,
): AgentRuntimeGenerationV2 {
  return Object.freeze({
    ...runtime,
    key: copyOwnedBytesV2(runtime.key),
  });
}

function committerContext(
  envelope: AgentRuntimeDomainEnvelopeV1,
): AgentRuntimeDomainCommitterContextV1 {
  return Object.freeze({
    purpose: "agent-runtime-domain-envelope",
    agentId: envelope.agentId,
    domainId: envelope.domainId,
    domainEpoch: envelope.domainEpoch,
    agentAuthorizationRevision: envelope.agentAuthorizationRevision,
    runtimeGeneration: envelope.runtimeGeneration,
    committerDeviceId: envelope.committerDeviceId,
  });
}

function comparePortableIds(left: string, right: string): number {
  const leftBytes = utf8V2(left);
  const rightBytes = utf8V2(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < sharedLength; index++) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function assertDomainTarget(target: AgentRuntimeDomainTargetV1): void {
  if (typeof target !== "object" || target === null) {
    throw new TypeError("Agent Runtime Domain target must be an object");
  }
  cryptoDomainId(target.domainId);
  domainEpoch(target.domainEpoch);
  authorizationRevision(target.agentAuthorizationRevision);
}

export function createAgentRuntimeGeneration(input: {
  readonly crypto: LatticeCrypto;
  readonly agentId: AgentId;
  readonly generation: AgentRuntimeGeneration;
}): AgentRuntimeGenerationV2 {
  const targetAgentId = agentId(input.agentId);
  const generation = agentRuntimeGeneration(input.generation);
  const key = input.crypto.randomBytes(AGENT_RUNTIME_KEY_BYTES);
  try {
    assertBytes("Random Agent Runtime key", key, AGENT_RUNTIME_KEY_BYTES);
    return freezeRuntime({
      agentId: targetAgentId,
      keyClass: "runtime",
      generation,
      key,
    });
  } finally {
    if (key instanceof Uint8Array) key.fill(0);
  }
}

export function deduplicateAgentRuntimeDomains(
  candidates: readonly AgentRuntimeDomainTargetV1[],
): readonly AgentRuntimeDomainTargetV1[] {
  if (!Array.isArray(candidates as unknown)) {
    throw new TypeError("Agent Runtime Domain candidates must be an array");
  }
  const byDomain = new Map<string, AgentRuntimeDomainTargetV1>();
  for (const candidate of candidates) {
    assertDomainTarget(candidate);
    const existing = byDomain.get(candidate.domainId);
    if (existing !== undefined) {
      if (
        existing.domainEpoch !== candidate.domainEpoch
        || existing.agentAuthorizationRevision
          !== candidate.agentAuthorizationRevision
      ) {
        throw new RangeError(
          `Agent Runtime Domain ${candidate.domainId} has conflicting context`,
        );
      }
      continue;
    }
    if (byDomain.size >= V2_LIMITS.agentGrantDomains) {
      throw new RangeError(
        `Agent Runtime Domain targets exceed the ${V2_LIMITS.agentGrantDomains} envelope limit`,
      );
    }
    byDomain.set(
      candidate.domainId,
      Object.freeze({
        domainId: candidate.domainId,
        domainEpoch: candidate.domainEpoch,
        agentAuthorizationRevision: candidate.agentAuthorizationRevision,
      }),
    );
  }
  return Object.freeze(
    [...byDomain.values()].sort((left, right) =>
      comparePortableIds(left.domainId, right.domainId)
    ),
  );
}

export interface SealAgentRuntimeToDomainInputV1 {
  readonly crypto: LatticeCrypto;
  readonly domainRoot: Uint8Array;
  readonly runtime: AgentRuntimeGenerationV2;
  readonly context: {
    readonly domainId: AgentRuntimeDomainEnvelopeV1["domainId"];
    readonly domainEpoch: AgentRuntimeDomainEnvelopeV1["domainEpoch"];
    readonly agentAuthorizationRevision:
      AgentRuntimeDomainEnvelopeV1["agentAuthorizationRevision"];
    readonly committerDeviceId:
      AgentRuntimeDomainEnvelopeV1["committerDeviceId"];
  };
  readonly committerSigningPrivateKey: Uint8Array;
  readonly currentCommitterAuthorized:
    CurrentAgentRuntimeCommitterAuthorizationV1;
}

export function sealAgentRuntimeToDomain(
  input: SealAgentRuntimeToDomainInputV1,
): AgentRuntimeDomainEnvelopeV1 {
  assertAgentRuntimeGeneration(input.runtime);
  assertBytes("AI Domain root", input.domainRoot, AGENT_RUNTIME_KEY_BYTES);
  assertBytes(
    "Committer signing private key",
    input.committerSigningPrivateKey,
    V2_LIMITS.signingPrivateKeyBytes,
  );
  const unsigned: AgentRuntimeDomainEnvelopeV1 = {
    formatVersion: 1,
    agentId: input.runtime.agentId,
    domainId: cryptoDomainId(input.context.domainId),
    domainEpoch: domainEpoch(input.context.domainEpoch),
    agentAuthorizationRevision: authorizationRevision(
      input.context.agentAuthorizationRevision,
    ),
    runtimeGeneration: input.runtime.generation,
    committerDeviceId: cryptoDeviceId(input.context.committerDeviceId),
    ciphertext: new Uint8Array(40),
    signature: new Uint8Array(V2_LIMITS.signatureBytes),
  };
  if (!input.currentCommitterAuthorized(committerContext(unsigned))) {
    throw new Error(
      "Agent Runtime Domain envelope committer is not authorized and unrevoked",
    );
  }
  const plaintext = encodeAgentRuntimeGeneration(input.runtime);
  let ciphertext: Uint8Array;
  try {
    ciphertext = input.crypto.aeadSeal(
      input.domainRoot,
      plaintext,
      agentRuntimeDomainEnvelopeAad(unsigned),
    );
  } finally {
    plaintext.fill(0);
  }
  const withCiphertext: AgentRuntimeDomainEnvelopeV1 = {
    ...unsigned,
    ciphertext,
  };
  const signature = input.crypto.sign(
    input.committerSigningPrivateKey,
    agentRuntimeDomainEnvelopeSigningBytes(withCiphertext),
  );
  const envelope: AgentRuntimeDomainEnvelopeV1 = {
    ...withCiphertext,
    ciphertext: copyOwnedBytesV2(ciphertext),
    signature: copyOwnedBytesV2(signature),
  };
  assertAgentRuntimeDomainEnvelope(envelope);
  return Object.freeze(envelope);
}

function assertExpectedContext(
  expected: AgentRuntimeDomainExpectedContextV1,
): void {
  if (typeof expected !== "object" || expected === null) {
    throw new TypeError("Expected Agent Runtime Domain context must be an object");
  }
  agentId(expected.agentId);
  cryptoDomainId(expected.domainId);
  domainEpoch(expected.domainEpoch);
  authorizationRevision(expected.agentAuthorizationRevision);
  agentRuntimeGeneration(expected.runtimeGeneration);
  cryptoDeviceId(expected.committerDeviceId);
}

function envelopeMatchesExpected(
  envelope: AgentRuntimeDomainEnvelopeV1,
  expected: AgentRuntimeDomainExpectedContextV1,
): boolean {
  return envelope.agentId === expected.agentId
    && envelope.domainId === expected.domainId
    && envelope.domainEpoch === expected.domainEpoch
    && envelope.agentAuthorizationRevision
      === expected.agentAuthorizationRevision
    && envelope.runtimeGeneration === expected.runtimeGeneration
    && envelope.committerDeviceId === expected.committerDeviceId;
}

export interface OpenAgentRuntimeFromDomainInputV1 {
  readonly crypto: LatticeCrypto;
  readonly domainRoot: Uint8Array;
  readonly envelope: AgentRuntimeDomainEnvelopeV1;
  readonly expected: AgentRuntimeDomainExpectedContextV1;
  readonly resolveHistoricalCommitter:
    HistoricalAgentRuntimeCommitterResolverV1;
}

export function openAgentRuntimeFromDomain(
  input: OpenAgentRuntimeFromDomainInputV1,
): AgentRuntimeGenerationV2 {
  assertBytes("AI Domain root", input.domainRoot, AGENT_RUNTIME_KEY_BYTES);
  assertAgentRuntimeDomainEnvelope(input.envelope);
  assertExpectedContext(input.expected);
  if (!envelopeMatchesExpected(input.envelope, input.expected)) {
    throw new Error(
      "Agent Runtime Domain envelope does not match the expected current context",
    );
  }
  const publicKey = input.resolveHistoricalCommitter(
    committerContext(input.envelope),
  );
  if (publicKey === null) {
    throw new Error(
      "Agent Runtime Domain envelope committer is absent from the authenticated historical roster",
    );
  }
  assertBytes(
    "Historical committer signing public key",
    publicKey,
    V2_LIMITS.signingPublicKeyBytes,
  );
  if (
    !input.crypto.verify(
      publicKey,
      agentRuntimeDomainEnvelopeSigningBytes(input.envelope),
      input.envelope.signature,
    )
  ) {
    throw new Error("Agent Runtime Domain envelope signature is invalid");
  }
  const plaintext = input.crypto.aeadOpen(
    input.domainRoot,
    input.envelope.ciphertext,
    agentRuntimeDomainEnvelopeAad(input.envelope),
  );
  if (plaintext === null) {
    throw new Error("Agent Runtime Domain envelope failed to decrypt");
  }
  let runtime: AgentRuntimeGenerationV2 | null = null;
  try {
    runtime = decodeAgentRuntimeGeneration(plaintext);
    if (
      runtime.agentId !== input.envelope.agentId
      || runtime.generation !== input.envelope.runtimeGeneration
    ) {
      throw new Error(
        "Agent Runtime Domain envelope inner and outer metadata do not match",
      );
    }
    return freezeRuntime(runtime);
  } finally {
    runtime?.key.fill(0);
    plaintext.fill(0);
  }
}
