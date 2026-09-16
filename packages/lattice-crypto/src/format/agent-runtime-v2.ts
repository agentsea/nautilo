import { sha256 } from "@noble/hashes/sha2.js";
import type {
  AgentRuntimeDomainEnvelopeV1,
  AgentRuntimeGenerationV2,
} from "../agent-runtime/types.ts";
import { AGENT_RUNTIME_KEY_BYTES } from "../agent-runtime/types.ts";
import {
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
} from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import {
  CanonicalDecodingError,
  concatV2,
  decodeExact,
  encodeU32,
  encodeU64,
  frame,
  frameText,
  StrictDecoder,
} from "./v2-primitives.ts";

export const AGENT_RUNTIME_DOMAIN_ENVELOPE_DOMAIN =
  "nautilo/lattice-crypto/agent-runtime-domain-envelope/v1";
export const AGENT_RUNTIME_DOMAIN_ENVELOPE_FORMAT_VERSION = 1 as const;

const AGENT_RUNTIME_DOMAIN_ENVELOPE_PURPOSE =
  "agent-runtime-domain-envelope";
const AGENT_RUNTIME_GENERATION_PURPOSE = "agent-runtime-generation";
const MIN_AEAD_CIPHERTEXT_BYTES = 40;
const MAX_AGENT_RUNTIME_DOMAIN_ENVELOPE_WIRE_BYTES =
  V2_LIMITS.ciphertextBytes + 1024;

function assertExactFields(
  label: string,
  value: object,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  for (const field of Object.keys(value)) {
    if (!allowedSet.has(field)) {
      throw new TypeError(`${label} contains unknown field ${field}`);
    }
  }
}

function assertBytes(
  label: string,
  value: unknown,
  expectedLength: number,
): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== expectedLength) {
    throw new RangeError(`${label} must contain exactly ${expectedLength} bytes`);
  }
}

function readExactText(
  reader: StrictDecoder,
  expected: string,
  label: string,
): void {
  const actual = reader.readText(expected.length);
  if (actual !== expected) {
    throw new CanonicalDecodingError(`${label} is unsupported`);
  }
}

export function assertAgentRuntimeGeneration(
  runtime: AgentRuntimeGenerationV2,
): void {
  if (typeof runtime !== "object" || runtime === null) {
    throw new TypeError("Agent Runtime generation must be an object");
  }
  assertExactFields("Agent Runtime generation", runtime, [
    "agentId",
    "keyClass",
    "generation",
    "key",
  ]);
  agentId(runtime.agentId);
  if (runtime.keyClass !== "runtime") {
    throw new RangeError("Agent Runtime generation has the wrong key class");
  }
  agentRuntimeGeneration(runtime.generation);
  assertBytes("Agent Runtime key", runtime.key, AGENT_RUNTIME_KEY_BYTES);
}

export function encodeAgentRuntimeGeneration(
  runtime: AgentRuntimeGenerationV2,
): Uint8Array {
  assertAgentRuntimeGeneration(runtime);
  const framedKey = frame(runtime.key);
  try {
    return concatV2(
      frameText(AGENT_RUNTIME_DOMAIN_ENVELOPE_DOMAIN),
      frameText(AGENT_RUNTIME_GENERATION_PURPOSE),
      encodeU32(AGENT_RUNTIME_DOMAIN_ENVELOPE_FORMAT_VERSION),
      frameText(runtime.agentId),
      encodeU64(runtime.generation),
      framedKey,
    );
  } finally {
    framedKey.fill(0);
  }
}

export function decodeAgentRuntimeGeneration(
  bytes: Uint8Array,
): AgentRuntimeGenerationV2 {
  let decodedKey: Uint8Array | undefined;
  try {
    const runtime = decodeExact(bytes, (reader) => {
      readExactText(
        reader,
        AGENT_RUNTIME_DOMAIN_ENVELOPE_DOMAIN,
        "Agent Runtime generation domain",
      );
      readExactText(
        reader,
        AGENT_RUNTIME_GENERATION_PURPOSE,
        "Agent Runtime generation purpose",
      );
      reader.readVersion(AGENT_RUNTIME_DOMAIN_ENVELOPE_FORMAT_VERSION);
      const decodedAgentId = agentId(reader.readText(V2_LIMITS.idBytes));
      const decodedGeneration = agentRuntimeGeneration(reader.readU64());
      decodedKey = reader.readFrame(AGENT_RUNTIME_KEY_BYTES);
      const value: AgentRuntimeGenerationV2 = {
        agentId: decodedAgentId,
        keyClass: "runtime",
        generation: decodedGeneration,
        key: decodedKey,
      };
      assertAgentRuntimeGeneration(value);
      return value;
    });
    return Object.freeze({
      ...runtime,
      key: copyOwnedBytesV2(runtime.key),
    });
  } finally {
    if (decodedKey !== undefined) decodedKey.fill(0);
  }
}

export function assertAgentRuntimeDomainEnvelope(
  envelope: AgentRuntimeDomainEnvelopeV1,
): void {
  if (typeof envelope !== "object" || envelope === null) {
    throw new TypeError("Agent Runtime Domain envelope must be an object");
  }
  assertExactFields("Agent Runtime Domain envelope", envelope, [
    "formatVersion",
    "agentId",
    "domainId",
    "domainEpoch",
    "agentAuthorizationRevision",
    "runtimeGeneration",
    "ciphertext",
    "committerDeviceId",
    "signature",
  ]);
  if (
    envelope.formatVersion !== AGENT_RUNTIME_DOMAIN_ENVELOPE_FORMAT_VERSION
  ) {
    throw new RangeError("Agent Runtime Domain envelope version is unsupported");
  }
  agentId(envelope.agentId);
  cryptoDomainId(envelope.domainId);
  domainEpoch(envelope.domainEpoch);
  authorizationRevision(envelope.agentAuthorizationRevision);
  agentRuntimeGeneration(envelope.runtimeGeneration);
  cryptoDeviceId(envelope.committerDeviceId);
  if (
    !(envelope.ciphertext instanceof Uint8Array)
    || envelope.ciphertext.length < MIN_AEAD_CIPHERTEXT_BYTES
    || envelope.ciphertext.length > V2_LIMITS.ciphertextBytes
  ) {
    throw new RangeError(
      "Agent Runtime Domain envelope ciphertext has an invalid length",
    );
  }
  assertBytes(
    "Agent Runtime Domain envelope signature",
    envelope.signature,
    V2_LIMITS.signatureBytes,
  );
}

function envelopeMetadataBytes(
  envelope: AgentRuntimeDomainEnvelopeV1,
): Uint8Array {
  return concatV2(
    frameText(AGENT_RUNTIME_DOMAIN_ENVELOPE_DOMAIN),
    frameText(AGENT_RUNTIME_DOMAIN_ENVELOPE_PURPOSE),
    encodeU32(AGENT_RUNTIME_DOMAIN_ENVELOPE_FORMAT_VERSION),
    frameText(envelope.agentId),
    frameText(envelope.domainId),
    encodeU64(envelope.domainEpoch),
    encodeU64(envelope.agentAuthorizationRevision),
    encodeU64(envelope.runtimeGeneration),
    frameText(envelope.committerDeviceId),
  );
}

export function agentRuntimeDomainEnvelopeAad(
  envelope: AgentRuntimeDomainEnvelopeV1,
): Uint8Array {
  assertAgentRuntimeDomainEnvelope(envelope);
  return envelopeMetadataBytes(envelope);
}

export function agentRuntimeDomainEnvelopeSigningBytes(
  envelope: AgentRuntimeDomainEnvelopeV1,
): Uint8Array {
  assertAgentRuntimeDomainEnvelope(envelope);
  return concatV2(
    envelopeMetadataBytes(envelope),
    frame(sha256(envelope.ciphertext)),
  );
}

export function serializeAgentRuntimeDomainEnvelope(
  envelope: AgentRuntimeDomainEnvelopeV1,
): Uint8Array {
  assertAgentRuntimeDomainEnvelope(envelope);
  return concatV2(
    envelopeMetadataBytes(envelope),
    frame(envelope.ciphertext),
    frame(envelope.signature),
  );
}

export function parseAgentRuntimeDomainEnvelope(
  bytes: Uint8Array,
): AgentRuntimeDomainEnvelopeV1 {
  if (bytes.length > MAX_AGENT_RUNTIME_DOMAIN_ENVELOPE_WIRE_BYTES) {
    throw new CanonicalDecodingError(
      "Agent Runtime Domain envelope exceeds its wire limit",
    );
  }
  const envelope = decodeExact(bytes, (reader) => {
    readExactText(
      reader,
      AGENT_RUNTIME_DOMAIN_ENVELOPE_DOMAIN,
      "Agent Runtime Domain envelope domain",
    );
    readExactText(
      reader,
      AGENT_RUNTIME_DOMAIN_ENVELOPE_PURPOSE,
      "Agent Runtime Domain envelope purpose",
    );
    reader.readVersion(AGENT_RUNTIME_DOMAIN_ENVELOPE_FORMAT_VERSION);
    const value: AgentRuntimeDomainEnvelopeV1 = {
      formatVersion: AGENT_RUNTIME_DOMAIN_ENVELOPE_FORMAT_VERSION,
      agentId: agentId(reader.readText(V2_LIMITS.idBytes)),
      domainId: cryptoDomainId(reader.readText(V2_LIMITS.idBytes)),
      domainEpoch: domainEpoch(reader.readU64()),
      agentAuthorizationRevision: authorizationRevision(reader.readU64()),
      runtimeGeneration: agentRuntimeGeneration(reader.readU64()),
      committerDeviceId: cryptoDeviceId(
        reader.readText(V2_LIMITS.idBytes),
      ),
      ciphertext: reader.readFrame(V2_LIMITS.ciphertextBytes),
      signature: reader.readFrame(V2_LIMITS.signatureBytes),
    };
    assertAgentRuntimeDomainEnvelope(value);
    return value;
  });
  return Object.freeze({
    ...envelope,
    // StrictDecoder.readFrame already returns an owned copy.
    ciphertext: envelope.ciphertext,
    signature: envelope.signature,
  });
}
